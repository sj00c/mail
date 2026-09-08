import { Hono } from "hono";
import { compress } from "hono/compress";
import { join, relative } from "node:path";
import {
  consumeOAuthState,
  getAuthUrl,
  handleCallback,
  isAuthed,
  logout,
} from "./auth.ts";
import { apiErrorStatus, publicApiError } from "./apiErrors.ts";
import { clearCalendarCache } from "./calendar.ts";
import { clearContactsCache, listContacts } from "./contacts.ts";
import { createMailRoutes } from "./routes/mail.ts";
import { createCalendarRoutes } from "./routes/calendar.ts";
import { createDriveRoutes } from "./routes/drive.ts";

// ---- helpers ----
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isLoopbackAuthority(authority: string): boolean {
  return (
    /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(authority) ||
    /^\[::1\](?::\d+)?$/i.test(authority)
  );
}

function requestAuthority(url: string): string | undefined {
  return /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1];
}

function isLoopbackRequest(
  url: string,
  hostHeader: string | undefined,
): boolean {
  const authority = requestAuthority(url);
  return Boolean(
    authority &&
      isLoopbackAuthority(authority) &&
      (hostHeader === undefined || isLoopbackAuthority(hostHeader)),
  );
}

function normalizedOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function allowsOrigin(
  requestUrl: string,
  origin: string,
  frontendOrigin: string | undefined,
): boolean {
  const normalized = normalizedOrigin(origin);
  if (!normalized) return false;
  return (
    normalized === normalizedOrigin(requestUrl) || normalized === frontendOrigin
  );
}

function protectsOrigin(path: string): boolean {
  return path === "/auth/logout" || path === "/api" || path.startsWith("/api/");
}

export function createApp(appUrl: string): Hono {
  const app = new Hono();
  const frontendOrigin = normalizedOrigin(appUrl);
  // Binding Bun to loopback does not stop a hostile Host header or a
  // cross-site browser from reaching this unauthenticated local server.
  app.use("*", async (c, next) => {
    if (!isLoopbackRequest(c.req.url, c.req.header("host"))) {
      return c.json({ error: "FORBIDDEN" }, 403);
    }
    const path = c.req.path;
    const secFetchSite = c.req.header("sec-fetch-site")?.trim().toLowerCase();
    if (
      (path === "/api" || path.startsWith("/api/")) &&
      secFetchSite === "cross-site"
    ) {
      return c.json({ error: "FORBIDDEN" }, 403);
    }
    const origin = c.req.header("origin");
    if (
      protectsOrigin(path) &&
      origin !== undefined &&
      !allowsOrigin(c.req.url, origin, frontendOrigin)
    ) {
      return c.json({ error: "FORBIDDEN" }, 403);
    }
    await next();
  });
  app.use(compress());

  // ---- auth routes ----
  app.get("/auth/status", async (c) => {
    return c.json({ authed: await isAuthed() });
  });

  app.get("/auth/login", (c) => {
    return c.redirect(getAuthUrl());
  });

  app.get("/auth/callback", async (c) => {
    const code = c.req.query("code");
    const err = c.req.query("error");
    // Query params are attacker-controllable (any page can navigate here) —
    // never interpolate them into HTML unescaped, and only accept codes from
    // flows this server started (state check → no login CSRF).
    if (err) return c.html(`<h2>OAuth error: ${escapeHtml(err)}</h2>`);
    if (!consumeOAuthState(c.req.query("state"))) {
      return c.html(
        "<h2>잘못된 OAuth 요청입니다 (state 불일치). 다시 로그인하세요.</h2>",
        403,
      );
    }
    if (!code) return c.html("<h2>Missing ?code in callback</h2>");
    try {
      await handleCallback(code);
      // Bounce back to the SPA (Vite :5173 in dev, self at "/" in prod).
      return c.redirect(appUrl);
    } catch (e) {
      console.error("[auth/callback]", e);
      return c.html(
        "<h2>Google 로그인을 완료하지 못했습니다. 앱으로 돌아가 다시 시도하세요.</h2>",
        500,
      );
    }
  });

  app.post("/auth/logout", async (c) => {
    await logout();
    clearCalendarCache(); // cached calendar list is account-scoped
    clearContactsCache();
    return c.json({ ok: true });
  });

  // ---- api routes ----
  const api = new Hono();

  api.route("/", createMailRoutes());

  // 받는사람 자동완성용 — 주소록 + 자주 주고받은 주소 (이메일 기준 병합).
  api.get("/contacts", async (c) => c.json(await listContacts()));

  api.route("/", createCalendarRoutes());

  api.route("/", createDriveRoutes());

  // Translate auth errors to 401 for all /api routes (sub-app handles its own errors).
  api.onError((e, c) => {
    const status = apiErrorStatus(e);
    console.error("[api]", e);
    return c.json({ error: publicApiError(e) }, status);
  });
  app.route("/api", api);
  // Unknown API paths must 404 as JSON — falling through to the SPA fallback
  // returns index.html with HTTP 200, which the client then fails to JSON-parse
  // (version-skew bugs masquerade as data corruption).
  app.all("/api/*", (c) => c.json({ error: "NOT_FOUND" }, 404));

  return app;
}

// ---- static (production: serve built SPA) ----
export async function mountProductionStatic(
  app: Hono,
  dist: string,
): Promise<void> {
  // Content-hashed assets are immutable — cache hard. But only when a real
  // asset was served: a missing hashed file falls through to the index.html
  // SPA fallback (text/html, 200), and caching THAT as immutable would pin a
  // wrong response under a .js/.css URL across deploys (version skew).
  const { serveStatic } = await import("hono/bun");
  app.use("/assets/*", async (c, next) => {
    await next();
    const ct = c.res.headers.get("Content-Type") ?? "";
    if (!ct.includes("text/html")) {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    }
  });
  // serveStatic resolves against cwd while the enable-gate checked the
  // absolute path — anchor both to the project dir so starting the server
  // from elsewhere still serves the SPA.
  const distRel = relative(process.cwd(), dist) || ".";
  app.use("/*", serveStatic({ root: distRel }));
  app.get("/*", serveStatic({ path: join(distRel, "index.html") }));
}
