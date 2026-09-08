import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// REDIRECT는 모듈 로드 시점에 env를 읽으므로 케이스마다 새로 import한다.
const saved: Record<string, string | undefined> = {};
const KEYS = ["OAUTH_REDIRECT", "PORT", "MAIL_DATA_DIR"];

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.stubEnv("GOOGLE_CLIENT_ID", "id.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function redirectUri() {
  vi.resetModules();
  const { getAuthUrl } = await import("./auth.ts");
  return new URL(getAuthUrl()).searchParams.get("redirect_uri");
}

describe("OAuth redirect URI", () => {
  it("defaults to port 8787", async () => {
    expect(await redirectUri()).toBe("http://localhost:8787/auth/callback");
  });

  it("follows PORT when OAUTH_REDIRECT is not set", async () => {
    process.env.PORT = "8788";
    expect(await redirectUri()).toBe("http://localhost:8788/auth/callback");
  });

  it("keeps an explicit OAUTH_REDIRECT verbatim", async () => {
    process.env.PORT = "8788";
    process.env.OAUTH_REDIRECT = "http://localhost:9000/auth/callback";
    expect(await redirectUri()).toBe("http://localhost:9000/auth/callback");
  });
});

describe("token storage", () => {
  it("uses MAIL_DATA_DIR for token persistence", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mail-auth-"));
    try {
      process.env.MAIL_DATA_DIR = dataDir;
      await writeFile(
        join(dataDir, "token.json"),
        JSON.stringify({ refresh_token: "fixture-refresh-token" }),
      );
      // Vitest runs in Node; exercise Bun's real file API in its own runtime.
      const moduleUrl = new URL("./auth.ts", import.meta.url).href;
      const { stdout } = await promisify(execFile)(
        "bun",
        [
          "--eval",
          `const { isAuthed, logout } = await import(${JSON.stringify(moduleUrl)});
           console.log(JSON.stringify({ authed: await isAuthed() }));
           await logout();`,
        ],
        { env: process.env, timeout: 10_000 },
      );
      expect(JSON.parse(stdout.trim())).toEqual({ authed: true });
      expect(await readFile(join(dataDir, "token.json"), "utf8")).toBe("{}");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
