import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// REDIRECT는 모듈 로드 시점에 env를 읽으므로 케이스마다 새로 import한다.
const saved: Record<string, string | undefined> = {};
const KEYS = ["OAUTH_REDIRECT", "PORT"];

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
