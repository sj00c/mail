import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const source = dirname(fileURLToPath(import.meta.url));
let fixture: string | undefined;
let child: ChildProcess | undefined;
let exited: Promise<number | null> | undefined;
let output = "";

async function availablePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((done, fail) => {
    reservation.once("error", fail);
    reservation.listen(0, "127.0.0.1", done);
  });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done, fail) =>
    reservation.close((error) => (error ? fail(error) : done())),
  );
  return port;
}

async function start(withBuild: boolean) {
  fixture = await mkdtemp(join(tmpdir(), "mail-production-"));
  await mkdir(join(fixture, "server"));
  // Copy source only: never copy .env, OAuth tokens, or the user's build.
  for (const file of await readdir(source)) {
    if (file.endsWith(".ts") && !file.endsWith(".test.ts")) {
      await copyFile(join(source, file), join(fixture, "server", file));
    }
  }
  await symlink(
    resolve(source, "../node_modules"),
    join(fixture, "node_modules"),
    "junction",
  );
  if (withBuild) {
    await mkdir(join(fixture, "dist/assets"), { recursive: true });
    await writeFile(
      join(fixture, "dist/index.html"),
      "<!doctype html><title>Isolated Mail build</title>",
    );
    await writeFile(
      join(fixture, "dist/assets/app-fixture.js"),
      "console.log('fixture');",
    );
  }
  const port = await availablePort();
  const env = {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture-not-a-real-secret",
    OAUTH_REDIRECT: `http://localhost:${port}/auth/callback`,
  };
  delete (env as Record<string, string | undefined>).APP_URL;
  output = "";
  child = spawn("bun", ["--no-env-file", "server/index.ts"], {
    cwd: fixture,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  exited = new Promise((done) => {
    child!.once("exit", done);
    child!.once("error", (error) => {
      output += error.message;
      done(null);
    });
  });
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    const force = setTimeout(() => child?.kill("SIGKILL"), 2_000);
    try {
      await exited;
    } finally {
      clearTimeout(force);
    }
  }
  child = undefined;
  if (fixture) await rm(fixture, { recursive: true, force: true });
  fixture = undefined;
});

it("runs the real production adapter without credentials or user data", async () => {
  const base = await start(true);
  let ready = false;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && child?.exitCode === null) {
    let response: Response | undefined;
    try {
      response = await fetch(`${base}/auth/status`, {
        signal: AbortSignal.timeout(300),
      });
    } catch {
      /* A fresh process may not have bound its socket yet. */
    }
    if (response?.ok) {
      expect(await response.json()).toEqual({ authed: false });
      ready = true;
      break;
    }
    await delay(50);
  }
  expect(ready, output).toBe(true);
  const page = await fetch(`${base}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Isolated Mail build");
  const missingApi = await fetch(`${base}/api/not-a-route`);
  expect(missingApi.status).toBe(404);
  expect(await missingApi.json()).toEqual({ error: "NOT_FOUND" });
  const foreignBrowser = await fetch(`${base}/api/not-a-route`, {
    method: "POST",
    headers: { Origin: "https://foreign.example" },
  });
  expect(foreignBrowser.status).toBe(403);
  // Fetch can normalize forbidden headers; send the actual hostile Host on the wire.
  const reboundStatus = await new Promise<number | undefined>((done, fail) => {
    const request = httpRequest(`${base}/api/not-a-route`, {
      headers: { Host: "foreign.example" },
    }, (response) => {
      response.resume();
      done(response.statusCode);
    });
    request.once("error", fail);
    request.setTimeout(2_000, () => request.destroy(new Error("Host check timed out")));
    request.end();
  });
  expect(reboundStatus).toBe(403);
  const asset = await fetch(`${base}/assets/app-fixture.js`);
  expect(asset.headers.get("cache-control")).toContain("immutable");
  const missingAsset = await fetch(`${base}/assets/not-built.js`);
  expect(missingAsset.headers.get("cache-control") ?? "").not.toContain(
    "immutable",
  );
}, 15_000);

it("exits unsuccessfully instead of serving development mode when the build is missing", async () => {
  await start(false);
  const code = await Promise.race([
    exited!,
    delay(8_000, "still-running", { ref: false }),
  ]);
  expect(code, output).not.toBe("still-running");
  expect(code, output).not.toBeNull();
  expect(code, output).not.toBe(0);
  expect(output).toMatch(/build|dist\/index\.html|빌드/i);
}, 15_000);
