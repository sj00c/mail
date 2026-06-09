import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getAuthUrl,
  handleCallback,
  isAuthed,
  logout,
} from "./auth.ts";
import {
  getAttachment,
  getMessage,
  getProfile,
  listLabels,
  listMessages,
  modifyMessage,
  sendMessage,
  trashMessage,
} from "./gmail.ts";
import { listCalendars, listEvents } from "./calendar.ts";

const PORT = Number(process.env.PORT ?? 8787);

// Production (NODE_ENV=production, via `bun run start`) serves the built SPA
// itself and OAuth bounces to "/". Dev serves the SPA on Vite :5173.
const IS_PROD = process.env.NODE_ENV === "production";
const DIST = join(import.meta.dir, "..", "dist");
const SERVE_STATIC = IS_PROD && existsSync(DIST);
const APP_URL =
  process.env.APP_URL ?? (SERVE_STATIC ? "/" : "http://localhost:5173/");

const app = new Hono();

// ---- helpers ----
function needAuthError(err: unknown): boolean {
  return err instanceof Error && err.message === "NOT_AUTHENTICATED";
}

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
  if (err) return c.html(`<h2>OAuth error: ${err}</h2>`);
  if (!code) return c.html("<h2>Missing ?code in callback</h2>");
  try {
    await handleCallback(code);
    // Bounce back to the SPA (Vite :5173 in dev, self at "/" in prod).
    return c.redirect(APP_URL);
  } catch (e) {
    return c.html(
      `<h2>Token exchange failed</h2><pre>${(e as Error).message}</pre>`,
    );
  }
});

app.post("/auth/logout", async (c) => {
  await logout();
  return c.json({ ok: true });
});

// ---- api routes ----
const api = new Hono();

api.get("/profile", async (c) => c.json(await getProfile()));

api.get("/labels", async (c) => c.json(await listLabels()));

api.get("/calendar/events", async (c) => {
  const days = c.req.query("days") ? Number(c.req.query("days")) : undefined;
  const timeMin = c.req.query("from") || undefined;
  const timeMax = c.req.query("to") || undefined;
  return c.json(await listEvents({ days, timeMin, timeMax }));
});

api.get("/calendar/calendars", async (c) => c.json(await listCalendars()));

api.get("/messages", async (c) => {
  const q = c.req.query("q") || undefined;
  const label = c.req.query("label") || undefined;
  const pageToken = c.req.query("pageToken") || undefined;
  const maxResults = c.req.query("maxResults")
    ? Number(c.req.query("maxResults"))
    : undefined;
  const res = await listMessages({
    q,
    labelIds: label ? [label] : undefined,
    pageToken,
    maxResults,
  });
  return c.json(res);
});

api.get("/messages/:id", async (c) => c.json(await getMessage(c.req.param("id"))));

api.get("/messages/:id/attachments/:aid", async (c) => {
  const buf = await getAttachment(c.req.param("id"), c.req.param("aid"));
  const filename = c.req.query("filename") || "attachment";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

api.post("/messages/:id/modify", async (c) => {
  const body = await c.req.json<{ add?: string[]; remove?: string[] }>();
  await modifyMessage(c.req.param("id"), body);
  return c.json({ ok: true });
});

api.post("/messages/:id/trash", async (c) => {
  await trashMessage(c.req.param("id"));
  return c.json({ ok: true });
});

api.post("/send", async (c) => {
  const body = await c.req.json();
  const res = await sendMessage(body);
  return c.json(res);
});

// Translate auth errors to 401 for all /api routes (sub-app handles its own errors).
api.onError((e, c) => {
  if (needAuthError(e)) return c.json({ error: "NOT_AUTHENTICATED" }, 401);
  console.error("[api]", e);
  return c.json({ error: (e as Error).message }, 500);
});
app.route("/api", api);

// ---- static (production: serve built SPA) ----
if (SERVE_STATIC) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("/*", serveStatic({ path: "./dist/index.html" }));
}

console.log(`[server] http://localhost:${PORT}`);
export default { port: PORT, fetch: app.fetch };
