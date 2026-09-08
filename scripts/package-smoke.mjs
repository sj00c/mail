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

async function expectCliFailure(
  label,
  cliPath,
  cwd,
  args,
  expectedMessage,
  env = process.env,
) {
  const record = runProcess(process.execPath, [cliPath, ...args], {
    cwd,
    env,
  });
  const result = await record.done;
  assert(result.code !== 0, `${label} unexpectedly succeeded`);
  assert(
    new RegExp(expectedMessage, "i").test(redact(result.output)),
    `${label} did not explain the failure`,
  );
  return result;
}

async function exerciseFailureBranches(root, packageRoot, cliPath) {
  const noEnvWorkspace = join(root, "missing-env");
  await mkdir(noEnvWorkspace);
  await expectCliFailure(
    "missing .env",
    cliPath,
    noEnvWorkspace,
    ["start"],
    "no \\.env",
  );

  const missingBuildWorkspace = join(root, "missing-build");
  await mkdir(missingBuildWorkspace);
  await writeFile(
    join(missingBuildWorkspace, ".env"),
    "PORT=8787\n",
  );
  const packagedIndex = join(packageRoot, "dist", "index.html");
  const backupIndex = `${packagedIndex}.smoke-backup`;
  await rename(packagedIndex, backupIndex);
  try {
    await expectCliFailure(
      "missing packaged build",
      cliPath,
      missingBuildWorkspace,
      ["start"],
      "production UI is missing",
    );
  } finally {
    await rename(backupIndex, packagedIndex);
  }

  const noBunWorkspace = join(root, "missing-bun");
  const noBunPath = join(root, "no-bun-on-path");
  await mkdir(noBunWorkspace);
  await mkdir(noBunPath);
  await writeFile(join(noBunWorkspace, ".env"), "PORT=8787\n");
  const noBunEnvironment = { ...process.env, PATH: noBunPath };
  await expectCliFailure(
    "missing Bun",
    cliPath,
    noBunWorkspace,
    ["start"],
    "Bun is required",
    noBunEnvironment,
  );

  const unrelatedWorkspace = join(root, "unrelated");
  await mkdir(unrelatedWorkspace);
  const unrelatedPackage = JSON.stringify(
    {
      name: "unrelated-workspace",
      private: true,
      scripts: { start: "other-command" },
    },
    null,
    2,
  ) + "\n";
  const unrelatedEnv = "SMOKE_UNRELATED_CONFIG=keep-me\n";
  await writeFile(join(unrelatedWorkspace, "package.json"), unrelatedPackage);
  await writeFile(join(unrelatedWorkspace, ".env"), unrelatedEnv);
  await expectCliFailure(
    "unrelated package protection",
    cliPath,
    unrelatedWorkspace,
    ["init"],
    "refusing to overwrite",
  );
  assert(
    (await readFile(join(unrelatedWorkspace, "package.json"), "utf8")) ===
      unrelatedPackage,
    "init changed an unrelated package.json",
  );
  assert(
    (await readFile(join(unrelatedWorkspace, ".env"), "utf8")) === unrelatedEnv,
    "init changed an unrelated .env",
  );
}

async function smoke(tarball) {
  assert(await isFile(tarball), `tarball does not exist: ${tarball}`);

  const root = await mkdtemp(join(tmpdir(), "sj-mail-package-smoke-"));
  let server;
  try {
    const consumer = join(root, "consumer");
    const workspace = join(root, "workspace");
    await mkdir(consumer);
    await mkdir(workspace);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ private: true }, null, 2) + "\n",
    );

    // Install once into a disposable consumer so all subsequent checks use
    // files from the packed artifact, never the source checkout.
    await npmInstall(consumer, tarball);
    const packageRoot = join(consumer, "node_modules", "@sj00c", "mail");
    const installedManifestPath = join(packageRoot, "package.json");
    const cliPath = join(packageRoot, "cli", "mail.mjs");
    assert(await isFile(installedManifestPath), "packed package was not installed");
    assert(await isFile(cliPath), "packed CLI entry is missing");
    assert(
      await isFile(join(packageRoot, "dist", "index.html")),
      "packed production dist/index.html is missing",
    );
    const installedManifest = await readJson(installedManifestPath);
    assert(
      typeof installedManifest.version === "string" &&
        installedManifest.version.length > 0,
      "packed package has no version",
    );

    await exerciseFailureBranches(root, packageRoot, cliPath);

    // init is deliberately run before installing workspace dependencies.
    await runChecked(
      "sj-mail init",
      process.execPath,
      [cliPath, "init", workspace],
      { cwd: consumer },
    );
    const workspacePackagePath = join(workspace, "package.json");
    const workspaceEnvPath = join(workspace, ".env");
    assert(await isFile(workspacePackagePath), "init did not create package.json");
    assert(await isFile(workspaceEnvPath), "init did not create .env");
    assert(
      (await stat(join(workspace, "node_modules")).catch(() => null)) === null,
      "init installed dependencies unexpectedly",
    );

    const generatedPackage = await readJson(workspacePackagePath);
    const expectedRange = `>=${installedManifest.version}`;
    assert(generatedPackage.private === true, "workspace package is not private");
    assert(
      generatedPackage.scripts?.start === "sj-mail start",
      "workspace start script is not sj-mail start",
    );
    assert(
      generatedPackage.dependencies?.[PACKAGE_NAME] === expectedRange,
      `workspace dependency range is not ${expectedRange}`,
    );

    // Existing configuration is never replaced by a repeated init.
    const preservedPackage = `${JSON.stringify(
      { ...generatedPackage, "x-smoke-config": "preserved" },
      null,
      2,
    )}\n`;
    const preservedEnv =
      (await readFile(workspaceEnvPath, "utf8")) +
      "SMOKE_CUSTOM_CONFIG=preserved\n";
    await writeFile(workspacePackagePath, preservedPackage);
    await writeFile(workspaceEnvPath, preservedEnv);
    await runChecked(
      "repeated sj-mail init",
      process.execPath,
      [cliPath, "init", workspace],
      { cwd: consumer },
    );
    assert(
      (await readFile(workspacePackagePath, "utf8")) === preservedPackage,
      "repeated init replaced package configuration",
    );
    assert(
      (await readFile(workspaceEnvPath, "utf8")) === preservedEnv,
      "repeated init replaced .env configuration",
    );

    const port = await freePort();
    const runtimeEnv = [
      `GOOGLE_CLIENT_ID=${fakeClientId}`,
      `GOOGLE_CLIENT_SECRET=${fakeClientSecret}`,
      `OAUTH_REDIRECT=http://localhost:${port}/auth/callback`,
      `PORT=${port}`,
      "SMOKE_CUSTOM_CONFIG=preserved",
      "",
    ].join("\n");
    await writeFile(workspaceEnvPath, runtimeEnv);
    const dataDir = join(workspace, ".data");
    const tokenPath = join(dataDir, "token.json");
    const tokenContents = JSON.stringify(
      { refresh_token: fakeRefreshToken },
      null,
      2,
    ) + "\n";
    await mkdir(dataDir);
    await writeFile(tokenPath, tokenContents);

    // npm install is intentionally repeated with the tarball and no-save:
    // package.json/.env remain user configuration while node_modules changes.
    await npmInstall(workspace, tarball);
    assert(
      (await readFile(workspacePackagePath, "utf8")) === preservedPackage,
      "workspace package configuration changed during install",
    );
    assert(
      (await readFile(workspaceEnvPath, "utf8")) === runtimeEnv,
      "workspace .env changed during install",
    );

    const childEnvironment = { ...process.env };
    for (const key of [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "OAUTH_REDIRECT",
      "PORT",
      "HOST",
      "MAIL_DATA_DIR",
      "NODE_ENV",
    ]) {
      delete childEnvironment[key];
    }
    const npm = await npmInvocation();
    server = runProcess(
      npm.command,
      [...npm.prefix, "run", "start"],
      {
        cwd: workspace,
        env: childEnvironment,
        windowsHide: false,
        timeoutMs: 0,
      },
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    const statusResponse = await waitForReady(
      server,
      `${baseUrl}/auth/status`,
    );
    assert(statusResponse.status === 200, "auth status did not return HTTP 200");
    assert(
      (await statusResponse.json()).authed === true,
      "auth status did not read workspace .data/token.json",
    );

    const rootResponse = await fetch(`${baseUrl}/`);
    assert(rootResponse.status === 200, "production root did not return HTTP 200");
    const html = await rootResponse.text();
    const assets = [
      ...new Set(
        [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
          (match) => match[1],
        ),
      ),
    ];
    assert(assets.length > 0, "production root did not reference any assets");
    for (const asset of assets) {
      const response = await fetch(`${baseUrl}${asset}`);
      assert(response.status === 200, `asset failed to load: ${asset}`);
    }

    // Reinstall after the server has used its token. User data lives beside
    // the workspace, not in node_modules, so an update must not remove it.
    await stopProcess(server);
    server = undefined;
    await npmInstall(workspace, tarball);
    assert(
      (await readFile(workspacePackagePath, "utf8")) === preservedPackage,
      "workspace package configuration changed during reinstall",
    );
    assert(
      (await readFile(workspaceEnvPath, "utf8")) === runtimeEnv,
      "workspace .env changed during reinstall",
    );
    assert(
      (await readFile(tokenPath, "utf8")) === tokenContents,
      "workspace .data/token.json did not survive reinstall",
    );
    assert(
      !tokenPath.includes(`${join("node_modules", "")}`),
      "workspace token path unexpectedly points inside node_modules",
    );
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
