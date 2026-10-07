#!/usr/bin/env node

// sj-mail: the only supported way to install, update, migrate and manage the
// app. The npm package carries the built UI, the server and the platform
// autostart scripts; a workspace folder (default ~/sj-mail) carries the user's
// .env, OAuth token and the installed package.

import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { copyFile, cp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@sj00c/mail";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_NAME = "sj-mail-workspace";
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
  return new Error(`[sj-mail] ${message}`);
}

function logDirectory() {
  if (IS_WINDOWS) {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "MailLocal",
    );
  }
  if (IS_MAC) return join(homedir(), "Library", "Logs", "sj-mail");
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "sj-mail",
  );
}

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

// The official installers (https://bun.sh/docs/installation), latest version.
const BUN_INSTALL_HINT = IS_WINDOWS
  ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
  : "curl -fsSL https://bun.sh/install | bash";

async function findBun() {
  const required = await requiredBunVersion();
  const candidates = process.versions.bun ? [process.execPath] : [];
  candidates.push(
    "bun",
    join(
      process.env.BUN_INSTALL || join(homedir(), ".bun"),
      "bin",
      IS_WINDOWS ? "bun.exe" : "bun",
    ),
  );
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
    return { path: resolve(path), version: found.join(".") };
  }
  throw cliError(
    (tooOld
      ? `Bun >= ${required.join(".")} is required (found ${tooOld}).`
      : "Bun is required but was not found.") +
      ` Install it with: ${BUN_INSTALL_HINT} — then open a new terminal and rerun this command.`,
  );
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

function needsCredentials(values) {
  const placeholder = /^(your-|여기에_)|PLACEHOLDER/;
  return [values.GOOGLE_CLIENT_ID, values.GOOGLE_CLIENT_SECRET].some(
    (value) => !value || !value.trim() || placeholder.test(value),
  );
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
  return join(homedir(), "sj-mail");
}

function installedRoot(workspace) {
  return join(workspace, "node_modules", "@sj00c", "mail");
}

async function requireInstalledRoot(workspace) {
  const root = installedRoot(workspace);
  if (!(await isFile(join(root, "package.json")))) {
    throw cliError(
      `No installed app was found in ${workspace}. Run: bunx ${PACKAGE_NAME}@latest setup`,
    );
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
      throw error.message?.startsWith("[sj-mail]")
        ? error
        : cliError(`${path} is not valid JSON; refusing to overwrite it.`);
    }
  }
  manifest.name = WORKSPACE_NAME;
  manifest.private = true;
  manifest.dependencies = { [PACKAGE_NAME]: spec };
  manifest.scripts = {
    status: "sj-mail status",
    start: "sj-mail start",
    stop: "sj-mail stop",
    restart: "sj-mail restart",
    serve: "sj-mail run",
    uninstall: "sj-mail uninstall",
  };
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
      `${dir} is neither an sj-mail workspace nor a Mail source/ZIP folder.`,
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
  console.log(`\n  SJ-MAIL SETUP ${version}`);
  console.log("  ----------------------------------------------");
  log.info(`Workspace: ${workspace}`);
  log.info(`Setup log: ${log.file}`);
  log.detail(`OS: ${osPlatform()} ${release()} ${process.arch}; runtime: ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`}`);
  try {
    log.stage("[1/5] Workspace and runtime");
    if (await isFile(workspace)) throw cliError(`${workspace} is a file, not a folder.`);
    await mkdir(workspace, { recursive: true });
    const bun = await findBun();
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
    if (needsCredentials(parseEnv(await readFile(envPath, "utf8")))) {
      log.done("Installed; Google credentials are still needed");
      log.info(`1. Put your Google Client ID and Secret into ${envPath}`);
      log.info(
        `   ${IS_WINDOWS ? `notepad "${envPath}"` : IS_MAC ? `open -e "${envPath}"` : `\${EDITOR:-nano} "${envPath}"`}`,
      );
      log.info("2. Run the same setup command again.");
      return;
    }
    log.info(".env has Google credentials.");

    log.stage("[5/5] Automatic startup");
    if (options.autostart === false) {
      log.done("Installed without automatic startup");
      log.info(`Start in the foreground with: cd "${workspace}" && bun run serve`);
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
      log.info(`Start in the foreground with: cd "${workspace}" && bun run serve`);
      return;
    }
    if (installCode !== 0) throw cliError(`Automatic startup failed (exit ${installCode}).`);
    log.done("Setup complete");
    log.info(`Manage: cd "${workspace}" then bun run status | restart | stop | start | uninstall`);
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
  const workspace = await resolveWorkspace(options.dir);
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
  const workspace = await resolveWorkspace(options.dir);
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
    throw cliError(`Automatic startup is not installed. Run: bunx ${PACKAGE_NAME}@latest setup`);
  }
  await assertOwnsLaunchAgent(app);
  const target = `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
  const port = await envPort(workspace);
  const loaded = () =>
    execFileAsync("launchctl", ["print", target]).then(() => true, () => false);
  if (action === "status") {
    const [isLoaded, ready] = [await loaded(), await serverReady(port)];
    console.log(`sj-mail: service=${isLoaded ? "loaded" : "stopped"}; health=${ready ? "ready" : "not responding"}; http://localhost:${port}`);
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
      console.log("sj-mail stopped until next login (or `bun run start`).");
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
      console.log(`sj-mail is ready: http://localhost:${port}`);
      return;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw cliError(`Server did not respond within ${READY_TIMEOUT_MS / 1000}s. Log: ${join(homedir(), "Library", "Logs", "mail.local.log")}`);
}

async function runForeground(options) {
  const workspace = await resolveWorkspace(options.dir);
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

const USAGE = `Usage: sj-mail <command> [--dir <workspace>]

  setup [--from <old folder>] [--no-autostart]
        Install or update into the workspace (default ~/sj-mail), migrate a
        previous ZIP/source installation, and register automatic startup.
  status | start | stop | restart
        Manage the automatically started server.
  uninstall
        Remove automatic startup. Settings and sign-in are kept.
  run   Run the server in this terminal (Ctrl+C to stop).`;

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
  if (["status", "start", "stop", "restart"].includes(command)) {
    return control(command, options);
  }
  console.error(USAGE);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "[sj-mail] Command failed.");
  process.exitCode = 1;
});
