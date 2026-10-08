#!/usr/bin/env node

// The Mail installer and manager (`bunx @sj00c/mail <command>`): installs,
// updates, migrates and manages the app. The package carries the built UI,
// the server and the platform autostart scripts; the workspace (an OS app-data
// folder, see defaultWorkspace) carries .env, the OAuth token and the
// installed package. Users never need to know its path.

import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { copyFile, cp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, platform as osPlatform, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@sj00c/mail";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_NAME = "mail-local-workspace";
const LAUNCHD_LABEL = "com.mail.local";
const READY_TIMEOUT_MS = 60_000;
const IS_WINDOWS = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// Keep this template independent from any repository-local credentials. The
// packaged CLI must never copy developer secrets into a user workspace.
const SAFE_ENV_TEMPLATE = `# Google OAuth client credentials
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# The redirect URI port must match PORT and your Google Cloud configuration.
OAUTH_REDIRECT=http://localhost:8787/auth/callback
PORT=8787
# HOST=127.0.0.1
`;

function cliError(message) {
  return new Error(`[mail] ${message}`);
}

// Commands users type; no Node.js or npm needed once Bun is installed.
const COMMAND = `bunx ${PACKAGE_NAME}`;

function logDirectory() {
  if (IS_WINDOWS) {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "MailLocal",
    );
  }
  if (IS_MAC) return join(homedir(), "Library", "Logs", "MailLocal");
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "mail-local",
  );
}

// Windows keeps app, settings and logs together in %LOCALAPPDATA%\MailLocal.
// Elsewhere a hidden home folder avoids spaces ("Application Support") in the
// paths the launchd scripts pass around.
function defaultWorkspace() {
  return IS_WINDOWS ? logDirectory() : join(homedir(), ".mail-local");
}

// Earlier releases installed into ~/sj-mail; setup moves it.
const LEGACY_WORKSPACE = join(homedir(), "sj-mail");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function ownManifest() {
  try {
    return await readJson(join(PACKAGE_ROOT, "package.json"));
  } catch {
    throw cliError("The packaged application has a missing or invalid package.json.");
  }
}

function samePath(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return IS_WINDOWS ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// ---------------------------------------------------------------------------
// Console + file logging. Every line the user sees during setup is also
// written, timestamped and without terminal escapes, to setup.log.

const ESCAPES = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const CONTROLS = /[\x00-\x08\x0B-\x1F\x7F]/g;
const COLORS = { RUN: 36, OK: 32, WARN: 33, FAIL: 31, INFO: 90 };

function createLogger(file) {
  const clock = Date.now();
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  let stage = null;
  let stageStarted = clock;
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  const seconds = (since) => ((Date.now() - since) / 1000).toFixed(1);
  const write = (level, message) => {
    const clean = String(message).replace(ESCAPES, "").replace(CONTROLS, "");
    if (file) {
      appendFileSync(
        file,
        `[${new Date().toISOString()}] [+${seconds(clock)}s] [${level}] ${clean}\n`,
      );
    }
    return clean;
  };
  const show = (level, message) => {
    const clean = write(level, message);
    const tag = level.padEnd(5);
    const line = color && COLORS[level]
      ? `  \x1B[${COLORS[level]}m${tag}\x1B[0m ${clean}`
      : `  ${tag} ${clean}`;
    (level === "FAIL" ? console.error : console.log)(line);
  };
  const closeStage = (level) => {
    if (stage) show(level, `${stage} (${seconds(stageStarted)}s)`);
    stage = null;
  };
  return {
    file,
    info: (message) => show("INFO", message),
    ok: (message) => show("OK", message),
    warn: (message) => show("WARN", message),
    fail: (message) => show("FAIL", message),
    // Child output is nested under the current stage on screen.
    child: (line) => {
      const clean = write("OUT", line);
      if (clean.trim()) console.log(`        ${clean}`);
    },
    detail: (message) => write("DETAIL", message),
    stage(name) {
      closeStage("OK");
      stage = name;
      stageStarted = Date.now();
      show("RUN", name);
    },
    failStage: () => closeStage("FAIL"),
    done(message) {
      closeStage("OK");
      show("OK", `${message} (${seconds(clock)}s)`);
    },
    get current() {
      return stage;
    },
  };
}

function runLogged(log, command, args, options = {}) {
  log.detail(`$ ${command} ${args.join(" ")}`);
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const pump = (stream) => {
      const decoder = new TextDecoder();
      let pending = "";
      stream.on("data", (chunk) => {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) log.child(line.replace(/\r$/, ""));
      });
      stream.on("end", () => {
        pending += decoder.decode();
        if (pending) log.child(pending.replace(/\r$/, ""));
      });
    };
    pump(child.stdout);
    pump(child.stderr);
    child.once("error", (error) =>
      fail(cliError(`Could not launch ${command}: ${error.message}`)),
    );
    child.once("close", (code, signal) => {
      log.detail(`exit ${code ?? signal}`);
      done(code ?? 1);
    });
  });
}

// ---------------------------------------------------------------------------
// Bun runtime. The server always runs on Bun, so the CLI resolves an absolute
// Bun executable once and hands it to the autostart scripts.

function parseVersion(text) {
  const match = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function atLeast(found, required) {
  for (let i = 0; i < 3; i++) {
    if (found[i] !== required[i]) return found[i] > required[i];
  }
  return true;
}

async function requiredBunVersion() {
  const manifest = await ownManifest();
  const pinned = parseVersion(String(manifest.packageManager ?? ""));
  if (!pinned) throw cliError("package.json has no pinned bun@x.y.z packageManager.");
  return pinned;
}

function bunHome() {
  return process.env.BUN_INSTALL || join(homedir(), ".bun");
}

/** Find a Bun that satisfies packageManager: { bun } or { bun: null, tooOld }. */
async function probeBun() {
  const required = await requiredBunVersion();
  const candidates = process.versions.bun ? [process.execPath] : [];
  candidates.push("bun", join(bunHome(), "bin", IS_WINDOWS ? "bun.exe" : "bun"));
  let tooOld = null;
  for (const candidate of candidates) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(
        candidate,
        ["-e", "console.log(Bun.version + '\\n' + process.execPath)"],
        { windowsHide: true, maxBuffer: 1024 * 1024 },
      ));
    } catch {
      continue;
    }
    const [versionLine, path] = String(stdout).trim().split(/\r?\n/);
    const found = parseVersion(versionLine);
    if (!found || !path) continue;
    if (!atLeast(found, required)) {
      tooOld ??= `${found.join(".")} at ${path}`;
      continue;
    }
    return { bun: { path: resolve(path), version: found.join(".") }, required };
  }
  return { bun: null, tooOld, required };
}

async function findBun() {
  const { bun, tooOld, required } = await probeBun();
  if (bun) return bun;
  throw cliError(
    (tooOld
      ? `Bun >= ${required.join(".")} is required (found ${tooOld}).`
      : "Bun is required but was not found.") +
      ` Run the installer from the README (or: ${COMMAND}@latest setup).`,
  );
}

// setup installs the pinned Bun with the official installer when it is
// missing or too old, so users only need Node.js/npm.
async function ensureBun(log) {
  const probe = await probeBun();
  if (probe.bun) return probe.bun;
  const version = probe.required.join(".");
  log.info(
    probe.tooOld
      ? `Bun ${probe.tooOld} is too old; installing Bun ${version} (official installer).`
      : `Bun not found; installing Bun ${version} (official installer).`,
  );
  const code = IS_WINDOWS
    ? await runLogged(log, windowsPowerShell(), [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        // Windows PowerShell 5.1 may otherwise negotiate obsolete TLS.
        `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((Invoke-RestMethod https://bun.sh/install.ps1))) -Version ${version}`,
      ])
    : await runLogged(log, "/bin/bash", [
        "-c",
        `set -o pipefail; curl -fsSL https://bun.sh/install | bash -s "bun-v${version}"`,
      ]);
  if (code !== 0) {
    throw cliError(`Bun installation failed (exit ${code}). Check the internet connection to bun.sh and retry.`);
  }
  const after = await probeBun();
  if (!after.bun) throw cliError(`Bun ${version} was installed but could not be run from ${join(bunHome(), "bin")}.`);
  return after.bun;
}

// ---------------------------------------------------------------------------
// .env handling.

function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return values;
}

const PLACEHOLDER = /^(your-|여기에_)|PLACEHOLDER/;

function isUnset(value) {
  return !value?.trim() || PLACEHOLDER.test(value.trim());
}

// Mirrors deploy/install.ps1 so setup and doctor explain every problem before
// any platform script runs. Values are never printed.
function envProblems(values) {
  const id = values.GOOGLE_CLIENT_ID ?? "";
  const secret = values.GOOGLE_CLIENT_SECRET ?? "";
  const problems = [];
  if (isUnset(id)) {
    problems.push("GOOGLE_CLIENT_ID is not set: enter the Client ID of your Google OAuth client.");
  } else if (!id.trim().endsWith(".apps.googleusercontent.com")) {
    problems.push("GOOGLE_CLIENT_ID must end with .apps.googleusercontent.com.");
  }
  if (isUnset(secret)) {
    problems.push("GOOGLE_CLIENT_SECRET is not set: enter the Client Secret of the same OAuth client.");
  }
  if (/[\s"']/.test(id) || /[\s"']/.test(secret)) {
    problems.push("Remove quotes and spaces around the Client ID and Client Secret.");
  }
  const portText = values.PORT || "8787";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1024 || port > 65535) {
    problems.push("PORT must be a number from 1024 to 65535.");
  } else if (values.OAUTH_REDIRECT && values.OAUTH_REDIRECT !== `http://localhost:${port}/auth/callback`) {
    problems.push(`OAUTH_REDIRECT must be http://localhost:${port}/auth/callback to match PORT.`);
  }
  return problems;
}

// Release builds can bundle the publisher's Google OAuth client (a desktop
// client: Google does not treat its secret as confidential). Setup writes it
// into .env, so the server still reads every key from .env and users only
// sign in. scripts/embed-oauth-client.mjs creates the file at pack time.
async function bundledClient(app) {
  const client = await readJson(join(app, "dist", "oauth-client.json")).catch(() => null);
  return client?.clientId && client?.clientSecret ? client : null;
}

function withClient(text, client) {
  let out = text;
  for (const [key, value] of [["GOOGLE_CLIENT_ID", client.clientId], ["GOOGLE_CLIENT_SECRET", client.clientSecret]]) {
    const line = new RegExp(`^${key}=.*$`, "m");
    out = line.test(out) ? out.replace(line, `${key}=${value}`) : `${out.trimEnd()}\n${key}=${value}\n`;
  }
  return out;
}

// Reads one line from the terminal; hidden input echoes "*". Raw mode keeps
// the secret off the screen and out of every log. Ctrl+C aborts.
function promptValue(question, { hidden = false } = {}) {
  const stdin = process.stdin;
  process.stdout.write(question);
  return new Promise((done) => {
    let value = "";
    const finish = (result) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      done(result);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(value.trim());
        if (ch === "\u0003") {
          finish(null);
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        process.stdout.write(hidden ? "*" : ch);
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

// Asks for the Google OAuth Client ID and Secret until both are valid and
// writes them to .env. Enter keeps the current value.
async function askCredentials(envPath) {
  console.log("  Paste your Google OAuth Client ID and Client Secret (Enter keeps the current value).");
  for (;;) {
    const text = await readFile(envPath, "utf8");
    const current = parseEnv(text);
    const clientId = (await promptValue("  Client ID: ")) || current.GOOGLE_CLIENT_ID?.trim() || "";
    const clientSecret = (await promptValue("  Client Secret: ", { hidden: true })) || current.GOOGLE_CLIENT_SECRET?.trim() || "";
    const problems = envProblems({ ...current, GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret })
      .filter((problem) => /CLIENT|Client/.test(problem));
    if (problems.length === 0) {
      await writeFile(envPath, withClient(text, { clientId, clientSecret }));
      return;
    }
    for (const problem of problems) console.log(`  ! ${problem}`);
  }
}

async function envPort(workspace) {
  let values = {};
  try {
    values = parseEnv(await readFile(join(workspace, ".env"), "utf8"));
  } catch {
    // Missing .env falls back to the server default.
  }
  return Number(values.PORT || 8787);
}

// ---------------------------------------------------------------------------
// Workspace.

function isWorkspaceManifest(manifest) {
  return Boolean(
    manifest &&
      manifest.private === true &&
      (manifest.name === WORKSPACE_NAME ||
        typeof manifest.dependencies?.[PACKAGE_NAME] === "string"),
  );
}

async function isWorkspace(dir) {
  try {
    return isWorkspaceManifest(await readJson(join(dir, "package.json")));
  } catch {
    return false;
  }
}

async function resolveWorkspace(dir) {
  if (dir) return resolve(process.cwd(), dir);
  if (await isWorkspace(process.cwd())) return resolve(process.cwd());
  return defaultWorkspace();
}

// Management commands keep working on a ~/sj-mail install until the next
// setup moves it; setup itself always targets the default workspace.
async function resolveManagedWorkspace(dir) {
  const workspace = await resolveWorkspace(dir);
  if (dir || (await isFile(join(installedRoot(workspace), "package.json")))) return workspace;
  if (await isFile(join(installedRoot(LEGACY_WORKSPACE), "package.json"))) return LEGACY_WORKSPACE;
  return workspace;
}

function installedRoot(workspace) {
  return join(workspace, "node_modules", "@sj00c", "mail");
}

async function requireInstalledRoot(workspace) {
  const root = installedRoot(workspace);
  if (!(await isFile(join(root, "package.json")))) {
    throw cliError(`Mail is not installed. Run the installer from the README (or: ${COMMAND}@latest setup).`);
  }
  return root;
}

async function writeWorkspaceManifest(workspace, spec) {
  const path = join(workspace, "package.json");
  let manifest = { name: WORKSPACE_NAME, private: true };
  try {
    const existing = await readJson(path);
    if (!isWorkspaceManifest(existing)) {
      throw cliError(`${path} belongs to another project; refusing to overwrite it.`);
    }
    manifest = existing;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error.message?.startsWith("[mail]")
        ? error
        : cliError(`${path} is not valid JSON; refusing to overwrite it.`);
    }
  }
  manifest.name = WORKSPACE_NAME;
  manifest.private = true;
  manifest.dependencies = { [PACKAGE_NAME]: spec };
  // Commands run through bunx, so the workspace needs no npm scripts.
  delete manifest.scripts;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Previous installations: the registered autostart entry (Windows task or
// macOS LaunchAgent) points at a deploy/run script. Its app root is either a
// source/ZIP checkout or @sj00c/mail inside another workspace.

function windowsPowerShell() {
  return join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function powershellFile(script, args) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    ...args,
  ];
}

async function registeredRunPath() {
  if (IS_WINDOWS) {
    const readiness = join(PACKAGE_ROOT, "deploy", "windows-readiness.ps1").replaceAll("'", "''");
    const { stdout } = await execFileAsync(
      windowsPowerShell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); . '${readiness}'; $p = Get-MailTaskRunPath; if ($p) { Write-Output $p }`,
      ],
      { windowsHide: true, encoding: "utf8" },
    );
    const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.at(-1) ?? null;
  }
  if (IS_MAC) {
    const plist = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    if (!(await isFile(plist))) return null;
    try {
      const { stdout } = await execFileAsync("/usr/bin/plutil", [
        "-extract",
        "ProgramArguments.0",
        "raw",
        "-o",
        "-",
        plist,
      ]);
      return String(stdout).trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Locate the user data of an app root: { workspace?, env, data } or null. */
async function dataOfRoot(root) {
  const parent = dirname(root);
  if (basename(parent) === "@sj00c" && basename(dirname(parent)) === "node_modules") {
    const workspace = dirname(dirname(parent));
    return { workspace, env: join(workspace, ".env"), data: join(workspace, ".data") };
  }
  if (
    (await isFile(join(root, "server", "index.ts"))) &&
    (await isDirectory(join(root, "deploy")))
  ) {
    return { env: join(root, ".env"), data: join(root, "server", ".data") };
  }
  return null;
}

async function dataOfFolder(folder) {
  const dir = resolve(process.cwd(), folder);
  if (await isFile(join(installedRoot(dir), "package.json"))) {
    return { workspace: dir, env: join(dir, ".env"), data: join(dir, ".data") };
  }
  const found = await dataOfRoot(dir);
  if (!found) {
    throw cliError(
      `${dir} is neither a Mail workspace nor a Mail source/ZIP folder.`,
    );
  }
  return found;
}

async function migrate(log, source, workspace) {
  const env = join(workspace, ".env");
  if (await isFile(source.env)) {
    let current = null;
    try {
      current = await readFile(env, "utf8");
    } catch {
      // No workspace .env yet.
    }
    if (current === null || current === SAFE_ENV_TEMPLATE) {
      await copyFile(source.env, env);
      if (!IS_WINDOWS) chmodSync(env, 0o600);
      log.info(`Copied .env from ${source.env}`);
    } else if (current !== (await readFile(source.env, "utf8"))) {
      log.warn(`Kept the existing ${env}; ${source.env} differs and was not copied.`);
    }
  } else {
    log.warn(`No .env found at ${source.env}.`);
  }
  if (await isDirectory(source.data)) {
    // Never replace data the workspace already has (e.g. a newer token).
    await cp(source.data, join(workspace, ".data"), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    log.info(`Copied sign-in data from ${source.data}`);
  }
}

// ---------------------------------------------------------------------------
// Commands.

async function setup(options) {
  const workspace = await resolveWorkspace(options.dir);
  const log = createLogger(join(logDirectory(), "setup.log"));
  const version = (await ownManifest()).version;
  console.log(`\n  MAIL SETUP ${version}`);
  console.log("  ----------------------------------------------");
  log.info(`Workspace: ${workspace}`);
  log.info(`Setup log: ${log.file}`);
  log.detail(`OS: ${osPlatform()} ${release()} ${process.arch}; runtime: ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`}`);
  try {
    log.stage("[1/5] Workspace and runtime");
    if (await isFile(workspace)) throw cliError(`${workspace} is a file, not a folder.`);
    await mkdir(workspace, { recursive: true });
    const bun = await ensureBun(log);
    log.info(`Bun ${bun.version}: ${bun.path}`);

    log.stage("[2/5] Previous installation");
    let source = null;
    let replaceRunPath = null;
    const runPath = await registeredRunPath();
    if (runPath) {
      log.info(`Registered autostart: ${runPath}`);
      const root = dirname(dirname(runPath));
      const found = await dataOfRoot(root);
      if (found?.workspace && samePath(found.workspace, workspace)) {
        log.info("Updating this workspace in place.");
      } else if (found) {
        source = found;
        replaceRunPath = runPath;
      } else if (!(await isDirectory(root))) {
        // The folder was moved or deleted: the entry is stale but still ours.
        log.warn(`${root} no longer exists; its autostart entry will be replaced.`);
        replaceRunPath = runPath;
      } else {
        throw cliError(
          `Autostart points to ${root}, which is not a Mail installation. Remove that entry before running setup.`,
        );
      }
    }
    if (options.from) source = await dataOfFolder(options.from);
    if (source && !(source.workspace && samePath(source.workspace, workspace))) {
      log.info(`Migrating settings from ${source.workspace ?? dirname(source.env)}`);
      await migrate(log, source, workspace);
      log.info("The previous folder is left untouched; delete it after confirming the new install works.");
    } else if (!runPath) {
      log.info("None found.");
    }

    log.stage("[3/5] Package");
    const spec = process.env.SJ_MAIL_PACKAGE_SPEC || version;
    await writeWorkspaceManifest(workspace, spec);
    log.info(`Installing ${PACKAGE_NAME}@${spec}`);
    const code = await runLogged(log, bun.path, ["install", "--no-summary"], { cwd: workspace });
    if (code !== 0) throw cliError(`bun install failed (exit ${code}).`);
    const app = installedRoot(workspace);
    const installed = await readJson(join(app, "package.json")).catch(() => null);
    if (!installed || (!process.env.SJ_MAIL_PACKAGE_SPEC && installed.version !== version)) {
      throw cliError(`Expected ${PACKAGE_NAME}@${version} in ${app}; the install is incomplete.`);
    }
    for (const required of ["dist/index.html", "server/index.ts", "cli/mail.mjs"]) {
      if (!(await isFile(join(app, required)))) {
        throw cliError(`Installed package is missing ${required}. Rerun setup.`);
      }
    }
    log.info(`Installed ${PACKAGE_NAME}@${installed.version}`);

    log.stage("[4/5] Configuration");
    const envPath = join(workspace, ".env");
    if (!(await isFile(envPath))) {
      await writeFile(envPath, SAFE_ENV_TEMPLATE, { flag: "wx" });
      if (!IS_WINDOWS) chmodSync(envPath, 0o600);
      log.info(`Created ${envPath}`);
    }
    const client = await bundledClient(app);
    const envText = await readFile(envPath, "utf8");
    const current = parseEnv(envText);
    // Fill only keys the user has not set; their own client always wins.
    if (client && isUnset(current.GOOGLE_CLIENT_ID) && isUnset(current.GOOGLE_CLIENT_SECRET)) {
      await writeFile(envPath, withClient(envText, client));
      log.info("Using the app's built-in Google sign-in client.");
    }
    let problems = envProblems(parseEnv(await readFile(envPath, "utf8")));
    // A person at a terminal is asked right here; scripts and agents (no
    // TTY) get the two-step flow: run the config command, then setup again.
    if (problems.length > 0 && process.stdin.isTTY && process.stdout.isTTY) {
      await askCredentials(envPath);
      log.info("Saved the Google Client ID and Secret.");
      problems = envProblems(parseEnv(await readFile(envPath, "utf8")));
    }
    if (problems.length > 0) {
      for (const problem of problems) log.warn(problem);
      log.done("Installed; Google credentials are still needed");
      log.info(`1. In a terminal window, enter them: ${COMMAND} config`);
      log.info("2. Run the same installer command again.");
      return;
    }
    log.info(".env has Google credentials.");

    log.stage("[5/5] Automatic startup");
    if (options.autostart === false) {
      log.done("Installed without automatic startup");
      log.info(`Start in the foreground with: ${COMMAND} run`);
      return;
    }
    let installCode;
    if (IS_WINDOWS) {
      const args = ["-Workspace", workspace, "-BunPath", bun.path];
      if (replaceRunPath) args.push("-ReplaceRunPath", replaceRunPath);
      installCode = await runLogged(
        log,
        windowsPowerShell(),
        powershellFile(join(app, "deploy", "install.ps1"), args),
        { cwd: workspace },
      );
    } else if (IS_MAC) {
      installCode = await runLogged(
        log,
        "/bin/bash",
        [join(app, "deploy", "install.sh"), workspace, bun.path],
        { cwd: workspace },
      );
    } else {
      log.done("Installed; automatic startup is available on Windows and macOS only");
      log.info(`Start in the foreground with: ${COMMAND} run`);
      return;
    }
    if (installCode !== 0) throw cliError(`Automatic startup failed (exit ${installCode}).`);
    log.done("Setup complete");
    log.info(`Manage from any terminal: ${COMMAND} status | restart | stop | start | doctor | config | uninstall`);
    console.log("");
    log.info(`Checking the installation (${COMMAND} doctor shows this again):`);
    const failures = await reportDiagnosis(log, await diagnose(workspace));
    if (failures > 0) log.warn(`Installed, but ${failures} problem(s) above still need attention.`);
  } catch (error) {
    const stage = log.current;
    log.failStage();
    log.fail(error instanceof Error ? error.message : String(error));
    if (stage) log.fail(`Setup stopped at ${stage}.`);
    log.info(`Setup log: ${log.file}`);
    if (IS_WINDOWS) log.info(`Autostart log: ${join(logDirectory(), "install.log")}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Diagnosis: one pass over everything that differs between machines, shared
// by `doctor` and the end of setup. Secrets are never printed.

function serverLogPath() {
  if (IS_WINDOWS) return join(logDirectory(), "mail.local.log");
  if (IS_MAC) return join(homedir(), "Library", "Logs", "mail.local.log");
  return null;
}

/** Registered automatic startup: { supported, present, runPath, enabled, paused, lastEvent }. */
async function autostartState() {
  if (IS_WINDOWS) {
    const readiness = join(PACKAGE_ROOT, "deploy", "windows-readiness.ps1").replaceAll("'", "''");
    const log = serverLogPath().replaceAll("'", "''");
    const { stdout } = await execFileAsync(
      windowsPowerShell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); . '${readiness}'; $t = Get-MailTask; if ($null -eq $t) { '{"present":false}' } else { [pscustomobject]@{ present = $true; runPath = (Get-MailRunPathFromTask $t); enabled = (Get-MailTaskEnabled $t); paused = (Test-MailPaused); lastEvent = (Get-MailLastEvent '${log}') } | ConvertTo-Json -Compress }`,
      ],
      { windowsHide: true, encoding: "utf8" },
    );
    return { supported: true, ...JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1)) };
  }
  if (IS_MAC) {
    const runPath = await registeredRunPath();
    if (!runPath) return { supported: true, present: false };
    // bootout (the stop command) unloads the agent until the next login.
    const loaded = await execFileAsync("launchctl", ["print", `gui/${process.getuid()}/${LAUNCHD_LABEL}`]).then(
      () => true,
      () => false,
    );
    return { supported: true, present: true, runPath, enabled: true, paused: !loaded };
  }
  return { supported: false };
}

function portInUse(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => done(false));
  });
}

async function fetchJson(url, timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const GOOGLE_APIS = [
  ["gmail", "Gmail", true],
  ["calendar", "Google Calendar", true],
  ["drive", "Google Drive", true],
  ["contacts", "Contacts (optional, recipient suggestions)", false],
];

/** Checks as [{ level: "ok" | "warn" | "fail" | "info", text }]. */
async function diagnose(workspace) {
  const checks = [];
  const add = (level, text) => checks.push({ level, text });
  add("info", `${osPlatform()} ${release()} ${process.arch}; workspace ${workspace}`);

  const { bun, tooOld, required } = await probeBun();
  if (bun) add("ok", `Bun ${bun.version}: ${bun.path}`);
  else add("fail", `${tooOld ? `Bun ${tooOld} is older than ${required.join(".")}` : "Bun was not found"}. Run setup again.`);

  const app = installedRoot(workspace);
  const installed = await readJson(join(app, "package.json")).catch(() => null);
  if (!installed) {
    add("fail", `No app is installed in ${workspace}. Run setup.`);
    return checks;
  }
  if (await isFile(join(app, "dist", "index.html"))) add("ok", `${PACKAGE_NAME} ${installed.version}`);
  else add("fail", `${PACKAGE_NAME} ${installed.version} is incomplete. Run setup again.`);

  const envPath = join(workspace, ".env");
  let values = null;
  try {
    values = parseEnv(await readFile(envPath, "utf8"));
  } catch {
    add("fail", `${envPath} is missing. Run setup.`);
  }
  if (values) {
    const problems = envProblems(values);
    for (const problem of problems) {
      add("fail", /Client/i.test(problem) ? `${problem} Fix: ${COMMAND} config` : `${problem} (${envPath})`);
    }
    if (problems.length === 0) {
      const client = await bundledClient(app);
      const builtIn = client?.clientId === values.GOOGLE_CLIENT_ID?.trim();
      add("ok", `Google client settings in ${envPath} (${builtIn ? "built-in client" : "your own client"}; values not shown)`);
    }
  }
  const port = Number(values?.PORT || 8787);

  let auto = { supported: false };
  try {
    auto = await autostartState();
  } catch (error) {
    add("warn", `Could not read the automatic startup entry: ${error.message}`);
  }
  if (auto.supported) {
    const own = await realpath(join(app, "deploy", IS_WINDOWS ? "run.ps1" : "run.sh")).catch(() => "");
    const registered = auto.runPath ? await realpath(auto.runPath).catch(() => auto.runPath) : "";
    const root = registered ? dirname(dirname(registered)) : "";
    if (!auto.present) add("warn", "Automatic startup is not registered. Run setup to register it.");
    else if (!samePath(registered, own)) {
      if (await isDirectory(root)) add("warn", `Automatic startup runs another installation (${root}). Run setup here to take it over.`);
      else add("fail", `Automatic startup points to ${root}, which no longer exists. Run setup to repair it.`);
    } else if (auto.paused) add("warn", `Stopped until the next sign-in. Resume now with: ${COMMAND} start`);
    else if (auto.enabled === false) add("warn", `Automatic startup is disabled. Turn it back on with: ${COMMAND} start`);
    else add("ok", "Automatic startup: at sign-in, relaunched if the server exits");
  } else if (!IS_WINDOWS && !IS_MAC) {
    add("info", `Automatic startup is available on Windows and macOS; here, start with: ${COMMAND} run`);
  }

  const ready = await serverReady(port);
  if (ready) add("ok", `Server responding at http://localhost:${port}`);
  else if (await portInUse(port)) {
    add("fail", `Port ${port} is used by another program. Close it, or change PORT and OAUTH_REDIRECT in .env and the redirect URI in Google Cloud.`);
  } else {
    add("fail", `Server is not running at http://localhost:${port}.${auto.lastEvent ? ` Last event: ${auto.lastEvent}.` : ""}${serverLogPath() ? ` Log: ${serverLogPath()}` : ""}`);
  }

  if (ready) {
    const status = await fetchJson(`http://127.0.0.1:${port}/auth/status`, 5000);
    if (!status?.authed) {
      add("warn", `Not signed in to Google yet: open http://localhost:${port} and connect your account.`);
    } else {
      const apis = await fetchJson(`http://127.0.0.1:${port}/api/diagnostics`, 30_000);
      if (!apis) add("fail", `Could not check Google API access. Run setup to update the app, then ${COMMAND} doctor again.`);
      else {
        const hints = {
          disabled: "enable this API in the same Google Cloud project",
          client: `Google rejected the Client ID/Secret in .env; copy both from the same OAuth client (regenerate the secret if unsure), then ${COMMAND} restart`,
          auth: `sign in again at http://localhost:${port}`,
          error: "request failed",
        };
        for (const [key, label, requiredApi] of GOOGLE_APIS) {
          const check = apis[key];
          if (check?.ok) {
            add("ok", `${label}: available`);
            continue;
          }
          add(requiredApi ? "fail" : "warn", `${label}: ${hints[check?.reason] ?? hints.error}. ${check?.message ?? ""}`.trim());
        }
      }
    }
  }

  add("info", `Logs: ${join(logDirectory(), "setup.log")}${serverLogPath() ? `, ${serverLogPath()}` : ""}`);
  return checks;
}

async function reportDiagnosis(log, checks) {
  for (const { level, text } of checks) log[level](text);
  return checks.filter((check) => check.level === "fail").length;
}

async function doctor(options) {
  const workspace = await resolveManagedWorkspace(options.dir);
  console.log(`\n  MAIL DOCTOR ${(await ownManifest()).version}`);
  console.log("  ----------------------------------------------");
  const failures = await reportDiagnosis(createLogger(null), await diagnose(workspace));
  if (failures > 0) process.exitCode = 1;
}

async function config(options) {
  const workspace = await resolveManagedWorkspace(options.dir);
  const envPath = join(workspace, ".env");
  if (!(await isFile(envPath))) {
    throw cliError(`Mail is not installed. Run the installer from the README (or: ${COMMAND}@latest setup).`);
  }
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw cliError(`Run this in a terminal window: ${COMMAND} config`);
  }
  await askCredentials(envPath);
  console.log("  Saved. Other settings (PORT) live in:", envPath);
  // Restart only an automatic startup this installation owns; a server run
  // by hand (or another installation) is left alone.
  const app = installedRoot(workspace);
  const auto = await autostartState().catch(() => ({}));
  const own = await realpath(join(app, "deploy", IS_WINDOWS ? "run.ps1" : "run.sh")).catch(() => "");
  const registered = auto.runPath ? await realpath(auto.runPath).catch(() => auto.runPath) : "";
  if (!own || !auto.present || !samePath(registered, own)) {
    console.log("  Restart Mail to apply the change.");
    return;
  }
  await control("restart", options);
}

// launchd has one com.mail.local per user. Never stop or remove an entry
// that another installation (a ZIP/git folder or another workspace) owns.
async function assertOwnsLaunchAgent(app) {
  const runPath = await registeredRunPath();
  const own = await realpath(join(app, "deploy", "run.sh"));
  if (runPath && !samePath(await realpath(runPath).catch(() => runPath), own)) {
    throw cliError(
      `Automatic startup belongs to ${dirname(dirname(runPath))}. Run setup here to take it over, or manage it from that folder.`,
    );
  }
}

async function uninstall(options) {
  const workspace = await resolveManagedWorkspace(options.dir);
  const app = await requireInstalledRoot(workspace);
  if (IS_MAC) await assertOwnsLaunchAgent(app);
  const code = IS_WINDOWS
    ? await inherit(windowsPowerShell(), powershellFile(join(app, "deploy", "uninstall.ps1"), []))
    : IS_MAC
      ? await inherit("/bin/bash", [join(app, "deploy", "uninstall.sh")])
      : 0;
  if (code !== 0) throw cliError(`Uninstall failed (exit ${code}).`);
  console.log(
    `Automatic startup removed. Your settings and sign-in remain in ${workspace}; delete that folder to remove everything.`,
  );
}

function inherit(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", (error) => fail(cliError(`Could not launch ${command}: ${error.message}`)));
    child.once("close", (code) => done(code ?? 1));
  });
}

async function serverReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/auth/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    return typeof (await response.json()).authed === "boolean";
  } catch {
    return false;
  }
}

async function control(action, options) {
  const workspace = await resolveManagedWorkspace(options.dir);
  const app = await requireInstalledRoot(workspace);
  if (IS_WINDOWS) {
    const name = action[0].toUpperCase() + action.slice(1);
    const code = await inherit(
      windowsPowerShell(),
      powershellFile(join(app, "deploy", "windows-control.ps1"), [name, "-Workspace", workspace]),
    );
    if (code !== 0) process.exitCode = code;
    return;
  }
  if (!IS_MAC) throw cliError("Automatic startup is available on Windows and macOS only.");
  const plist = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (!(await isFile(plist))) {
    throw cliError(`Automatic startup is not installed. Run the installer from the README (or: ${COMMAND}@latest setup).`);
  }
  await assertOwnsLaunchAgent(app);
  const target = `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
  const port = await envPort(workspace);
  const loaded = () =>
    execFileAsync("launchctl", ["print", target]).then(() => true, () => false);
  if (action === "status") {
    const [isLoaded, ready] = [await loaded(), await serverReady(port)];
    console.log(`Mail: service=${isLoaded ? "loaded" : "stopped"}; health=${ready ? "ready" : "not responding"}; http://localhost:${port}`);
    if (!ready) process.exitCode = 1;
    return;
  }
  if (action === "stop" || action === "restart") {
    if (await loaded()) await execFileAsync("launchctl", ["bootout", target]);
    // bootout returns before launchd has released the label.
    for (let i = 0; i < 20 && (await loaded()); i++) {
      await new Promise((done) => setTimeout(done, 500));
    }
    if (await loaded()) throw cliError("launchd did not stop the service; retry shortly.");
    if (action === "stop") {
      console.log(`Mail stopped until the next login (or: ${COMMAND} start).`);
      return;
    }
  }
  if (!(await loaded())) {
    await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist]);
  }
  await execFileAsync("launchctl", ["kickstart", target]);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await serverReady(port)) {
      console.log(`Mail is ready: http://localhost:${port}`);
      return;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw cliError(`Server did not respond within ${READY_TIMEOUT_MS / 1000}s. Log: ${join(homedir(), "Library", "Logs", "mail.local.log")}`);
}

async function runForeground(options) {
  const workspace = await resolveManagedWorkspace(options.dir);
  const app = await requireInstalledRoot(workspace);
  const envPath = join(workspace, ".env");
  if (!(await isFile(envPath))) {
    throw cliError(`No .env file was found in ${workspace}. Run setup first.`);
  }
  if (!(await isFile(join(app, "dist", "index.html")))) {
    throw cliError(`Packaged production UI is missing in ${app}. Rerun setup.`);
  }
  const bun = await findBun();
  // The workspace .env is the source of truth, as it is for the autostart
  // service: inherited shell variables would otherwise override it in Bun.
  const environment = { ...process.env };
  for (const key of Object.keys(parseEnv(await readFile(envPath, "utf8")))) {
    delete environment[key];
  }
  const child = spawn(
    bun.path,
    ["--use-system-ca", `--env-file=${envPath}`, join(app, "server", "index.ts")],
    {
      cwd: workspace,
      env: {
        ...environment,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        MAIL_DATA_DIR: join(workspace, ".data"),
      },
      shell: false,
      stdio: "inherit",
      windowsHide: false,
    },
  );
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  const [code, signal] = await new Promise((done, fail) => {
    child.once("error", (error) => fail(cliError(`Unable to launch Bun: ${error.message}`)));
    child.once("close", (exitCode, exitSignal) => done([exitCode, exitSignal]));
  });
  process.removeListener("SIGINT", forward);
  process.removeListener("SIGTERM", forward);
  process.exitCode = code ?? ({ SIGINT: 130, SIGTERM: 143 }[signal] ?? 1);
}

const USAGE = `Usage: ${COMMAND} <command> [--dir <workspace>]

  setup [--from <old folder>] [--no-autostart]
        Install or update, migrate a previous installation (ZIP/git or an
        older ~/sj-mail), and register automatic startup.
  status | start | stop | restart
        Manage the automatically started server.
  uninstall
        Remove automatic startup. Settings and sign-in are kept.
  run   Run the server in this terminal (Ctrl+C to stop).
  config
        Enter or change the Google Client ID and Secret, then restart.
  doctor
        Check Bun, the installed app, .env, automatic startup, the server
        and Google API access, with a fix for each problem.`;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const allowed = {
    setup: ["--dir", "--from", "--no-autostart"],
    uninstall: ["--dir"],
    status: ["--dir"],
    start: ["--dir"],
    stop: ["--dir"],
    restart: ["--dir"],
    run: ["--dir"],
    doctor: ["--dir"],
    config: ["--dir"],
  }[command];
  if (!allowed) return { command: null, options };
  for (let i = 0; i < rest.length; i++) {
    const [flag, inline] = rest[i].split(/=(.*)/s, 2);
    if (!allowed.includes(flag)) throw cliError(`Unknown option for ${command}: ${rest[i]}`);
    if (flag === "--no-autostart") {
      options.autostart = false;
      continue;
    }
    const value = inline ?? rest[++i];
    if (!value) throw cliError(`${flag} needs a folder.`);
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "setup") return setup(options);
  if (command === "uninstall") return uninstall(options);
  if (command === "run") return runForeground(options);
  if (command === "doctor") return doctor(options);
  if (command === "config") return config(options);
  if (["status", "start", "stop", "restart"].includes(command)) {
    return control(command, options);
  }
  console.error(USAGE);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "[mail] Command failed.");
  process.exitCode = 1;
});
