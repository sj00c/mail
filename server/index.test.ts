import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const app = { fetch: vi.fn() };
  return {
    app,
    createApp: vi.fn(() => app),
    mountProductionStatic: vi.fn(async () => {}),
    existsSync: vi.fn(() => true),
  };
});

vi.mock("./app.ts", () => ({
  createApp: runtime.createApp,
  mountProductionStatic: runtime.mountProductionStatic,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: { ...actual, existsSync: runtime.existsSync },
    existsSync: runtime.existsSync,
  };
});

const originalAppUrl = process.env.APP_URL;

async function loadIndex() {
  return import("./index.ts");
}

describe("server runtime adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
    vi.stubEnv("PORT", "8787");
    vi.stubEnv("HOST", "127.0.0.1");
    vi.stubEnv("NODE_ENV", "development");
    runtime.createApp.mockReset().mockReturnValue(runtime.app);
    runtime.mountProductionStatic.mockReset().mockResolvedValue(undefined);
    runtime.existsSync.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps development on the Vite callback URL and does not mount static files", async () => {
    const { default: adapter } = await loadIndex();

    expect(runtime.createApp).toHaveBeenCalledWith("http://localhost:5173/");
    expect(runtime.existsSync).not.toHaveBeenCalled();
    expect(runtime.mountProductionStatic).not.toHaveBeenCalled();
    expect(adapter).toEqual({
      port: 8787,
      hostname: "127.0.0.1",
      fetch: runtime.app.fetch,
    });
  });

  it("mounts production static files after checking dist/index.html", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const { default: adapter } = await loadIndex();

    expect(runtime.existsSync).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]dist[\\/]index\.html$/),
    );
    expect(runtime.createApp).toHaveBeenCalledWith("/");
    expect(runtime.mountProductionStatic).toHaveBeenCalledWith(
      runtime.app,
      expect.stringMatching(/[\\/]dist$/),
    );
    expect(adapter.port).toBe(8787);
    expect(adapter.hostname).toBe("127.0.0.1");
    expect(adapter.fetch).toBe(runtime.app.fetch);
  });

  it("preserves an explicit APP_URL in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://mail.example.test/");

    await loadIndex();

    expect(runtime.createApp).toHaveBeenCalledWith(
      "https://mail.example.test/",
    );
  });

  it("fails fast when production has no built index.html", async () => {
    vi.stubEnv("NODE_ENV", "production");
    runtime.existsSync.mockReturnValue(false);

    await expect(loadIndex()).rejects.toThrow(
      /Production build missing: .*dist[\\/]index\.html.*bun run build.*reinstall/i,
    );
    expect(runtime.createApp).not.toHaveBeenCalled();
    expect(runtime.mountProductionStatic).not.toHaveBeenCalled();
  });

  it.each(["", "1", "1023", "65536", "1.5", "1e3", "8787x", "-1"])(
    "rejects invalid PORT=%s",
    async (port) => {
      vi.stubEnv("PORT", port);

      await expect(loadIndex()).rejects.toThrow(/Invalid PORT/);
      expect(runtime.createApp).not.toHaveBeenCalled();
    },
  );

  it.each(["1024", "65535"])("accepts PORT=%s", async (port) => {
    vi.stubEnv("PORT", port);

    const { default: adapter } = await loadIndex();

    expect(adapter.port).toBe(Number(port));
  });

  it.each(["", "0.0.0.0", "192.168.1.20", "::", "mail.local"])(
    "rejects non-loopback HOST=%s",
    async (host) => {
      vi.stubEnv("HOST", host);

      await expect(loadIndex()).rejects.toThrow(/Invalid HOST/);
      expect(runtime.createApp).not.toHaveBeenCalled();
    },
  );

  it.each(["127.0.0.1", "localhost", "::1"])(
    "accepts loopback HOST=%s",
    async (host) => {
      vi.stubEnv("HOST", host);

      const { default: adapter } = await loadIndex();

      expect(adapter.hostname).toBe(host);
    },
  );

  it("formats the IPv6 loopback address as a valid URL in startup logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("HOST", "::1");

    await loadIndex();

    expect(log).toHaveBeenCalledWith("[server] http://[::1]:8787");
    log.mockRestore();
  });
});
