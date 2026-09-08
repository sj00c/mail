#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUN_EXECUTABLE = "bun";
const MIN_BUN_VERSION = [1, 3, 14];
const PACKAGE_NAME = "@sj00c/mail";

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

async function packageVersion() {
  let raw;
  try {
    raw = await readFile(join(PACKAGE_ROOT, "package.json"), "utf8");
  } catch {
    throw cliError("The packaged application is missing package.json.");
  }
  try {
    const metadata = JSON.parse(raw);
    if (typeof metadata.version !== "string" || metadata.version.length === 0) {
      throw new Error("invalid version");
    }
    return metadata.version;
  } catch {
    throw cliError("The packaged application has an invalid package.json.");
  }
}

function initializedManifest(metadata) {
  return Boolean(
    metadata &&
      metadata.private === true &&
      typeof metadata.dependencies?.[PACKAGE_NAME] === "string" &&
      typeof metadata.scripts?.start === "string" &&
      metadata.scripts.start === "sj-mail start",
  );
}

async function regularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Create a file without ever replacing an existing file. A write failure
 * removes only the file opened by this call, leaving retries possible.
 */
async function createExclusive(path, content) {
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(content, "utf8");
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // Preserve the original write error.
    }
    // Do not leave a file that this failed attempt only partially created.
    try {
      await unlink(path);
    } catch {
      // The original error is the useful failure; a later retry can repair it.
    }
    throw error;
  }
  await handle.close();
  return true;
}

async function initWorkspace(directory) {
  const workspace = resolve(process.cwd(), directory ?? ".");
  await mkdir(workspace, { recursive: true });

  const version = await packageVersion();
  const packageJson = `${JSON.stringify(
    {
      name: "sj-mail-workspace",
      private: true,
      dependencies: {
        [PACKAGE_NAME]: `>=${version}`,
      },
      scripts: {
        start: "sj-mail start",
      },
    },
    null,
    2,
  )}\n`;

  const packagePath = join(workspace, "package.json");
  const packageCreated = await createExclusive(packagePath, packageJson);
  if (!packageCreated) {
    let existing;
    try {
      existing = JSON.parse(await readFile(packagePath, "utf8"));
    } catch {
      throw cliError(
        `Existing ${packagePath} is not a valid sj-mail workspace; refusing to overwrite it.`,
      );
    }
    if (!initializedManifest(existing)) {
      throw cliError(
        `Existing ${packagePath} is not an sj-mail workspace; refusing to overwrite it.`,
      );
    }
  }
  const envPath = join(workspace, ".env");
  const envCreated = await createExclusive(envPath, SAFE_ENV_TEMPLATE);
  if (!envCreated && !(await regularFile(envPath))) {
    throw cliError(
      `Existing ${envPath} is not a regular file; refusing to overwrite it.`,
    );
  }

  console.log(`sj-mail workspace: ${workspace}`);
  console.log(
    packageCreated
      ? "Created package.json."
      : "Kept existing package.json (not overwritten).",
  );
  console.log(
    envCreated
      ? "Created .env template."
      : "Kept existing .env (not overwritten).",
  );
  console.log(
    "Next: edit .env, run npm install, then run npm run start.",
  );
}

async function verifyBun() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(BUN_EXECUTABLE, ["--version"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    throw cliError(
      "Bun is required to start the server but was not found. " +
        "Install Bun from https://bun.sh/docs/installation, ensure bun is on PATH, and run npm run start again.",
    );
  }
  const match = String(stdout).trim().match(/(\d+)\.(\d+)\.(\d+)/);
  const found = match ? match.slice(1, 4).map(Number) : null;
  const supported =
    found &&
    found[0] >= MIN_BUN_VERSION[0] &&
    (found[0] > MIN_BUN_VERSION[0] ||
      found[1] >= MIN_BUN_VERSION[1]) &&
    (found[0] > MIN_BUN_VERSION[0] ||
      found[1] > MIN_BUN_VERSION[1] ||
      found[2] >= MIN_BUN_VERSION[2]);
  if (!supported) {
    throw cliError(
      `Bun >= ${MIN_BUN_VERSION.join(".")} is required (found ${
        match ? match[0] : "an unknown version"
      }). Upgrade Bun from https://bun.sh/docs/installation and run npm run start again.`,
    );
  }
}

function runBun(cwd, envPath, serverEntry, environment) {
  const child = spawn(
    BUN_EXECUTABLE,
    [
      "--use-system-ca",
      `--env-file=${envPath}`,
      serverEntry,
    ],
    {
      cwd,
      env: environment,
      shell: false,
      stdio: "inherit",
      windowsHide: false,
    },
  );

  return new Promise((done, fail) => {
    let settled = false;
    const forwardedSignals = ["SIGINT", "SIGTERM"];
    const signalHandlers = new Map();
    const forward = (signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between the check and kill.
      }
    };
    for (const signal of forwardedSignals) {
      const handler = () => forward(signal);
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
    };
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        fail(error);
      } else {
        done({ code, signal });
      }
    };

    child.once("error", (error) => {
      finish(null, null, cliError(`Unable to launch Bun: ${error.message}`));
    });
    child.once("close", (code, signal) => finish(code, signal));
  });
}

async function startServer() {
  const cwd = resolve(process.cwd());
  await verifyBun();

  const envPath = join(cwd, ".env");
  if (!(await regularFile(envPath))) {
    throw cliError(
      `No .env file was found in ${cwd}. Run "sj-mail init" and fill in its safe template first.`,
    );
  }

  const distIndex = join(PACKAGE_ROOT, "dist", "index.html");
  if (!(await regularFile(distIndex))) {
    throw cliError(
      `Packaged production UI is missing (${distIndex}). Reinstall @sj00c/mail before starting.`,
    );
  }

  const serverEntry = join(PACKAGE_ROOT, "server", "index.ts");
  if (!(await regularFile(serverEntry))) {
    throw cliError(
      `Packaged server entry is missing (${serverEntry}). Reinstall @sj00c/mail before starting.`,
    );
  }

  const environment = {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    MAIL_DATA_DIR: join(cwd, ".data"),
  };
  const result = await runBun(cwd, envPath, serverEntry, environment);
  if (result.code !== null) {
    process.exitCode = result.code;
  } else if (result.signal) {
    // A signal received by the Bun child is represented as a null exit code.
    // Preserve the conventional Unix status where one exists.
    const signalNumber = { SIGINT: 2, SIGTERM: 15 }[result.signal];
    process.exitCode = signalNumber ? 128 + signalNumber : 1;
  } else {
    process.exitCode = 1;
  }
}

function usage() {
  console.error(
    "Usage: sj-mail init [directory]\n       sj-mail start",
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "init") {
    if (args.length > 1) {
      throw cliError("sj-mail init accepts at most one directory.");
    }
    await initWorkspace(args[0]);
    return;
  }
  if (command === "start" && args.length === 0) {
    await startServer();
    return;
  }
  usage();
  throw cliError(
    command
      ? `Unknown command or arguments: ${command}.`
      : "A command is required.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "[sj-mail] Command failed.");
  process.exitCode = 1;
});
