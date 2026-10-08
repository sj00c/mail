#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const PACKAGE_NAME = "@sj00c/mail";
const COMMAND_TIMEOUT_MS = 120_000;
const SERVER_TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 64 * 1024;

const fakeClientId = "fixture.apps.googleusercontent.com";
const fakeClientSecret = "fixture-not-a-real-secret";
const fakeRefreshToken = "fixture-refresh-token";
const sensitiveValues = [
  fakeClientId,
  fakeClientSecret,
  fakeRefreshToken,
];

function redact(value) {
  let safe = String(value);
  for (const secret of sensitiveValues) {
    safe = safe.split(secret).join("[REDACTED]");
  }
  return safe;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke assertion failed: ${message}`);
}

function terminateTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    // Terminate the tree before killing npm loses ownership of its children.
    const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error) throw result.error;
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function runProcess(command, args, options = {}) {
  let child;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: options.windowsHide ?? true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      child: undefined,
      done: Promise.resolve({
        code: null,
        signal: null,
        error,
        output: "",
      }),
      get output() {
        return "";
      },
    };
  }

  let output = "";
  let timedOut = false;
  let timeoutId;
  let forceKillId;
  const append = (chunk) => {
    output += String(chunk);
    if (output.length > MAX_OUTPUT) {
      output = output.slice(-MAX_OUTPUT);
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const done = new Promise((resolveResult) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(forceKillId);
      resolveResult({ ...value, output, timedOut });
    };
    child.once("error", (error) =>
      finish({ code: null, signal: null, error }),
    );
    child.once("close", (code, signal) => finish({ code, signal }));
  });
  const record = {
    child,
    done,
    get output() {
      return output;
    },
  };
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      try {
        terminateTree(child);
      } catch {
        // The process may have exited before the timeout fired.
      }
      forceKillId = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          terminateTree(child, "SIGKILL");
        } catch {
          // The process may have exited while the timeout elapsed.
        }
      }, 5_000);
    }, timeoutMs);
  }
  return record;
}

async function runChecked(label, command, args, options = {}) {
  console.log(`[smoke] ${label}`);
  const record = runProcess(command, args, options);
  const result = await record.done;
  if (result.error) {
    throw new Error(`${label} could not start: ${redact(result.error.message)}`);
  }
  if (result.timedOut || result.code !== 0) {
    const details = redact(result.output).trim();
    throw new Error(
      `${label} ${result.timedOut ? "timed out" : `failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`}`}.` +
        (details ? `\n${details}` : ""),
    );
  }
  return result;
}

let npmInvocationPromise;
async function npmInvocation() {
  if (!npmInvocationPromise) {
    npmInvocationPromise = (async () => {
      if (process.platform !== "win32") {
        return { command: "npm", prefix: [] };
      }
      const candidates = [
        process.env.npm_execpath,
        join(
          dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      ].filter(Boolean);
      for (const candidate of candidates) {
        const path = resolve(candidate);
        if (await isFile(path)) {
          return { command: process.execPath, prefix: [path] };
        }
      }
      throw new Error(
        "npm was not found. Install Node.js with npm and rerun package smoke.",
      );
    })();
  }
  return npmInvocationPromise;
}

async function runNpm(label, args, options = {}) {
  const npm = await npmInvocation();
  return runChecked(label, npm.command, [...npm.prefix, ...args], options);
}

async function freePort() {
  const reservation = createServer();
  await new Promise((done, fail) => {
    reservation.once("error", fail);
    reservation.listen(0, "127.0.0.1", done);
  });
  const address = reservation.address();
  assert(address && typeof address === "object", "OS did not provide a free port");
  const port = address.port;
  await new Promise((done, fail) => {
    reservation.close((error) => (error ? fail(error) : done()));
  });
  return port;
}

async function npmInstall(cwd, tarball) {
  return runNpm(
    "npm install",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--no-save",
      tarball,
    ],
    {
      cwd,
      env: {
        ...process.env,
        npm_config_ignore_scripts: "true",
      },
    },
  );
}

async function waitForReady(record, url) {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    if (
      !record.child ||
      record.child.exitCode !== null ||
      record.child.signalCode !== null
    ) {
      const result = await record.done;
      throw new Error(
        `Packaged server exited before becoming ready (code ${result.code}).\n${redact(result.output)}`,
      );
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(
    `Packaged server did not become ready: ${redact(lastError)}\n${redact(record.output)}`,
  );
}

async function stopProcess(record) {
  if (!record?.child) return;
  if (record.child.exitCode === null && record.child.signalCode === null) {
    terminateTree(record.child);
  }

  const exited = await Promise.race([
    record.done.then(() => true),
    delay(5_000, false),
  ]);
  if (exited) return;

  terminateTree(record.child, "SIGKILL");
  const killed = await Promise.race([record.done.then(() => true), delay(5_000, false)]);
  assert(killed, "owned smoke process tree did not terminate");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Every CLI call runs with an isolated home so setup never reads or replaces
// the runner's logs or default workspace. Automatic startup is not isolated
// by HOME; see assertNoRealAutostart.
function isolatedEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  if (process.platform === "win32") env.LOCALAPPDATA = join(home, "AppData", "Local");
  for (const key of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "OAUTH_REDIRECT",
    "PORT",
    "HOST",
    "MAIL_DATA_DIR",
    "NODE_ENV",
    "BUN_INSTALL",
  ]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

async function expectCliFailure(label, cliPath, cwd, args, expectedMessage, env) {
  const record = runProcess(process.execPath, [cliPath, ...args], { cwd, env });
  const result = await record.done;
  assert(result.code !== 0, `${label} unexpectedly succeeded`);
  assert(
    new RegExp(expectedMessage, "i").test(redact(result.output)),
    `${label} did not explain the failure:\n${redact(result.output)}`,
  );
  return result;
}

function runtimeEnv(port) {
  return [
    `GOOGLE_CLIENT_ID=${fakeClientId}`,
    `GOOGLE_CLIENT_SECRET=${fakeClientSecret}`,
    `OAUTH_REDIRECT=http://localhost:${port}/auth/callback`,
    `PORT=${port}`,
    "",
  ].join("\n");
}

const tokenContents = `${JSON.stringify({ refresh_token: fakeRefreshToken }, null, 2)}\n`;

// Task Scheduler and launchd entries belong to the OS user, not to HOME. With
// a real Mail entry present, setup would treat it as the previous install,
// copy its .env and sign-in into the fixture and take the entry over.
function assertNoRealAutostart() {
  const probe =
    process.platform === "win32"
      ? spawnSync("schtasks.exe", ["/Query", "/TN", "\\MailLocal"], { windowsHide: true, encoding: "utf8", timeout: 10_000 })
      : process.platform === "darwin"
        ? spawnSync("launchctl", ["print", `gui/${process.getuid()}/com.mail.local`], { encoding: "utf8", timeout: 10_000 })
        : null;
  if (probe?.error) throw probe.error;
  assert(
    probe === null || probe.status !== 0,
    "refusing to run on a machine with Mail automatic startup installed; setup would migrate its .env and sign-in and take it over. Run on CI or after `npm run uninstall`.",
  );
}

async function smoke(tarball) {
  assert(await isFile(tarball), `tarball does not exist: ${tarball}`);
  assertNoRealAutostart();

  const root = await mkdtemp(join(tmpdir(), "sj-mail-package-smoke-"));
  let server;
  try {
    const home = join(root, "home");
    const consumer = join(root, "consumer");
    await mkdir(home);
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ private: true }, null, 2) + "\n",
    );

    // The CLI under test comes from the packed artifact, never the checkout.
    await npmInstall(consumer, tarball);
    const cliPath = join(consumer, "node_modules", "@sj00c", "mail", "cli", "mail.mjs");
    assert(await isFile(cliPath), "packed CLI entry is missing");
    const env = isolatedEnv(home, { SJ_MAIL_PACKAGE_SPEC: `file:${tarball}` });
    const cli = (label, args, cwd = consumer) =>
      runChecked(label, process.execPath, [cliPath, ...args], { cwd, env });

    // 1. New install: workspace + package + .env. Without a bundled Google
    //    client it stops clearly for credentials; with one (release packages
    //    built with BUNDLED_GOOGLE_CLIENT_*) .env is filled for the user.
    //    --no-autostart: never touch the runner's automatic startup.
    const workspace = join(root, "workspace");
    const first = await cli("setup (new)", ["setup", "--dir", workspace, "--no-autostart"]);
    const manifest = await readJson(join(workspace, "package.json"));
    assert(manifest.private === true, "workspace package is not private");
    assert(manifest.dependencies?.[PACKAGE_NAME] === `file:${tarball}`, "workspace dependency is not the package spec");
    assert(manifest.scripts === undefined, "workspace still carries npm scripts (commands run through bunx)");
    const app = join(workspace, "node_modules", "@sj00c", "mail");
    for (const file of ["dist/index.html", "server/index.ts", "deploy/run.sh", "deploy/run.ps1", "deploy/install.ps1"]) {
      assert(await isFile(join(app, file)), `installed package is missing ${file}`);
    }
    const envPath = join(workspace, ".env");
    const createdEnv = await readFile(envPath, "utf8");
    if (await isFile(join(app, "dist", "oauth-client.json"))) {
      assert(/built-in Google sign-in client/.test(first.output), "setup did not use the bundled Google client");
      assert(!/your-client-id/.test(createdEnv), "setup left placeholders despite a bundled Google client");
    } else {
      assert(/credentials are still needed/i.test(first.output), "setup did not ask for credentials");
      assert(/your-client-id/.test(createdEnv), "setup did not create the .env template");
    }
    const setupLog = await readFile(
      process.platform === "win32"
        ? join(home, "AppData", "Local", "MailLocal", "setup.log")
        : process.platform === "darwin"
          ? join(home, "Library", "Logs", "MailLocal", "setup.log")
          : join(home, ".local", "state", "mail-local", "setup.log"),
      "utf8",
    );
    assert(/\[RUN\] \[3\/5\] Package/.test(setupLog) && /\[OUT\] /.test(setupLog), "setup.log misses stages or install output");

    // 2. Runtime: the foreground server reads the workspace .env and token.
    const port = await freePort();
    await writeFile(envPath, runtimeEnv(port));
    await mkdir(join(workspace, ".data"));
    await writeFile(join(workspace, ".data", "token.json"), tokenContents);
    server = runProcess(process.execPath, [cliPath, "run", "--dir", workspace], {
      cwd: consumer,
      // A conflicting shell PORT must not override the workspace .env.
      env: { ...env, PORT: "1" },
      windowsHide: false,
      timeoutMs: 0,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const status = await waitForReady(server, `${baseUrl}/auth/status`);
    assert((await status.json()).authed === true, "server did not read workspace .data/token.json");
    const html = await (await fetch(`${baseUrl}/`)).text();
    const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
    assert(assets.length > 0, "production root did not reference any assets");
    for (const asset of assets) {
      assert((await fetch(`${baseUrl}${asset}`)).status === 200, `asset failed to load: ${asset}`);
    }
    // Doctor checks the running install. The fixture client cannot reach
    // Google, so it must fail overall while never printing a credential.
    const diagnosis = await runProcess(process.execPath, [cliPath, "doctor", "--dir", workspace], { cwd: consumer, env }).done;
    const report = diagnosis.output;
    assert(diagnosis.code !== 0, "doctor passed although Google access cannot work with fixture credentials");
    assert(/OK\s+Google client settings/.test(report), `doctor did not accept the workspace .env:\n${redact(report)}`);
    assert(new RegExp(`OK\\s+Server responding at http://localhost:${port}`).test(report), `doctor did not see the server:\n${redact(report)}`);
    assert(!sensitiveValues.some((value) => report.includes(value)), "doctor printed a credential");
    await stopProcess(server);
    server = undefined;

    // 3. Update in place keeps settings and sign-in data.
    const envBefore = await readFile(envPath, "utf8");
    await cli("setup (update)", ["setup", "--dir", workspace, "--no-autostart"]);
    assert((await readFile(envPath, "utf8")) === envBefore, "update changed .env");
    assert(
      (await readFile(join(workspace, ".data", "token.json"), "utf8")) === tokenContents,
      "update changed .data/token.json",
    );

    // 4. Migration from a ZIP/source installation: .env and server/.data are
    //    copied, the old folder is left untouched.
    const legacy = join(root, "legacy mail-main");
    await mkdir(join(legacy, "deploy"), { recursive: true });
    await mkdir(join(legacy, "server", ".data"), { recursive: true });
    await writeFile(join(legacy, "server", "index.ts"), "");
    const legacyEnv = runtimeEnv(await freePort());
    await writeFile(join(legacy, ".env"), legacyEnv);
    await writeFile(join(legacy, "server", ".data", "token.json"), tokenContents);
    const migrated = join(root, "migrated");
    await cli("setup --from", ["setup", "--dir", migrated, "--from", legacy, "--no-autostart"]);
    assert((await readFile(join(migrated, ".env"), "utf8")) === legacyEnv, "migration did not copy .env");
    assert(
      (await readFile(join(migrated, ".data", "token.json"), "utf8")) === tokenContents,
      "migration did not copy sign-in data",
    );
    assert((await readFile(join(legacy, ".env"), "utf8")) === legacyEnv, "migration changed the old folder");

    // 5. Failures are explicit and leave unrelated files alone.
    const unrelated = join(root, "unrelated");
    await mkdir(unrelated);
    const unrelatedPackage = `${JSON.stringify({ name: "unrelated", scripts: { start: "x" } }, null, 2)}\n`;
    await writeFile(join(unrelated, "package.json"), unrelatedPackage);
    await expectCliFailure("unrelated package protection", cliPath, consumer, ["setup", "--dir", unrelated], "belongs to another project", env);
    assert((await readFile(join(unrelated, "package.json"), "utf8")) === unrelatedPackage, "setup changed an unrelated package.json");
    await expectCliFailure("unknown legacy folder", cliPath, consumer, ["setup", "--dir", migrated, "--from", unrelated], "neither a Mail workspace", env);
    await expectCliFailure("run before setup", cliPath, consumer, ["run", "--dir", join(root, "empty")], "Mail is not installed", env);
    const missingEnv = join(root, "missing-env");
    await cli("setup (missing .env fixture)", ["setup", "--dir", missingEnv, "--no-autostart"]);
    await rm(join(missingEnv, ".env"));
    await expectCliFailure("missing .env", cliPath, consumer, ["run", "--dir", missingEnv], "no \\.env", env);
    const index = join(app, "dist", "index.html");
    await rename(index, `${index}.smoke-backup`);
    try {
      await expectCliFailure("missing packaged build", cliPath, consumer, ["run", "--dir", workspace], "production UI is missing", env);
    } finally {
      await rename(`${index}.smoke-backup`, index);
    }
    const noBin = join(root, "no-bin");
    await mkdir(noBin);
    await expectCliFailure(
      "missing Bun",
      cliPath,
      consumer,
      ["run", "--dir", workspace],
      "Bun is required",
      { ...env, PATH: noBin, Path: noBin },
    );
    await expectCliFailure("unknown option", cliPath, consumer, ["setup", "--bogus"], "Unknown option", env);
  } finally {
    await stopProcess(server);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const [tarballArgument, ...extraArguments] = process.argv.slice(2);
if (!tarballArgument || extraArguments.length > 0) {
  console.error("Usage: node scripts/package-smoke.mjs <packed-tarball>");
  process.exitCode = 1;
} else {
  smoke(resolve(tarballArgument))
    .then(() => {
      console.log("Package smoke passed.");
    })
    .catch((error) => {
      console.error(
        redact(error instanceof Error ? error.stack ?? error.message : error),
      );
      process.exitCode = 1;
    });
}
