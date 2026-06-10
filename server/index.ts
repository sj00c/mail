import { Hono } from "hono";
import { compress } from "hono/compress";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  consumeOAuthState,
  getAuthUrl,
  handleCallback,
  isAuthed,
  logout,
} from "./auth.ts";
import {
  createDraft,
  deleteDraft,
  findDraftByMessageId,
  getAccountSettings,
  getAttachment,
  getGmailSignature,
  updateDraft,
  getThread,
  getProfile,
  listLabels,
  listMessages,
  modifyMessage,
  sendMessage,
  trashMessage,
} from "./gmail.ts";
import {
  clearCalendarCache,
  createEvent,
  deleteEvent,
  getEvent,
  listCalendars,
  listEvents,
  searchEvents,
  updateEvent,
} from "./calendar.ts";

const PORT = Number(process.env.PORT ?? 8787);

// Production (NODE_ENV=production, via `bun run start`) serves the built SPA
// itself and OAuth bounces to "/". Dev serves the SPA on Vite :5173.
const IS_PROD = process.env.NODE_ENV === "production";
const DIST = join(import.meta.dir, "..", "dist");
const SERVE_STATIC = IS_PROD && existsSync(DIST);
const APP_URL =
  process.env.APP_URL ?? (SERVE_STATIC ? "/" : "http://localhost:5173/");

const app = new Hono();
app.use(compress());

// ---- helpers ----
function needAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === "NOT_AUTHENTICATED") return true;
  // Revoked/expired refresh token: Google answers invalid_grant forever.
  // Treat as logged-out (401) so the UI returns to the login screen instead
  // of looping on opaque 500s.
  const data = (err as { response?: { data?: { error?: string } } }).response?.data;
  return err.message.includes("invalid_grant") || data?.error === "invalid_grant";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function httpStatusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [e?.status, e?.code, e?.response?.status]) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return undefined;
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
  // Query params are attacker-controllable (any page can navigate here) —
  // never interpolate them into HTML unescaped, and only accept codes from
  // flows this server started (state check → no login CSRF).
  if (err) return c.html(`<h2>OAuth error: ${escapeHtml(err)}</h2>`);
  if (!consumeOAuthState(c.req.query("state"))) {
    return c.html("<h2>잘못된 OAuth 요청입니다 (state 불일치). 다시 로그인하세요.</h2>", 403);
  }
  if (!code) return c.html("<h2>Missing ?code in callback</h2>");
  try {
    await handleCallback(code);
    // Bounce back to the SPA (Vite :5173 in dev, self at "/" in prod).
    return c.redirect(APP_URL);
  } catch (e) {
    return c.html(
      `<h2>Token exchange failed</h2><pre>${escapeHtml((e as Error).message)}</pre>`,
    );
  }
});

app.post("/auth/logout", async (c) => {
  await logout();
  clearCalendarCache(); // cached calendar list is account-scoped
  return c.json({ ok: true });
});

// ---- api routes ----
const api = new Hono();

api.get("/profile", async (c) => c.json(await getProfile()));

api.get("/labels", async (c) => c.json(await listLabels()));

// Query params come from the URL — validate before they become RangeErrors
// deep inside Date/Google API calls (NaN days previously exploded as a 500).
function finiteOr(
  raw: string | undefined,
  name: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === "") return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: `${name} must be a number` };
  return { ok: true, value: n };
}

api.get("/calendar/events", async (c) => {
  const days = finiteOr(c.req.query("days"), "days");
  if (!days.ok) return c.json({ error: days.error }, 400);
  const timeMin = c.req.query("from") || undefined;
  const timeMax = c.req.query("to") || undefined;
  if (!!timeMin !== !!timeMax)
    return c.json({ error: "from and to must be provided together" }, 400);
  if (timeMin && Number.isNaN(Date.parse(timeMin)))
    return c.json({ error: "from is not a valid date" }, 400);
  if (timeMax && Number.isNaN(Date.parse(timeMax)))
    return c.json({ error: "to is not a valid date" }, 400);
  return c.json(await listEvents({ days: days.value, timeMin, timeMax }));
});

api.get("/calendar/calendars", async (c) => c.json(await listCalendars()));

api.get("/calendar/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ error: "q required" }, 400);
  return c.json(await searchEvents(q));
});

api.get("/calendar/event", async (c) => {
  const calendarId = c.req.query("calendarId");
  const eventId = c.req.query("eventId");
  if (!calendarId || !eventId)
    return c.json({ error: "calendarId, eventId required" }, 400);
  return c.json(await getEvent(calendarId, eventId));
});

api.post("/calendar/events", async (c) => {
  const body = await c.req.json();
  return c.json(await createEvent(body));
});

api.put("/calendar/events/:id", async (c) => {
  const body = await c.req.json();
  await updateEvent(c.req.param("id"), body);
  return c.json({ ok: true });
});

api.post("/calendar/events/:id/delete", async (c) => {
  const calendarId = c.req.query("calendarId");
  if (!calendarId) return c.json({ error: "calendarId required" }, 400);
  await deleteEvent(calendarId, c.req.param("id"));
  return c.json({ ok: true });
});

api.get("/messages", async (c) => {
  const q = c.req.query("q") || undefined;
  const label = c.req.query("label") || undefined;
  const pageToken = c.req.query("pageToken") || undefined;
  const max = finiteOr(c.req.query("maxResults"), "maxResults");
  if (!max.ok) return c.json({ error: max.error }, 400);
  const maxResults = max.value;
  const res = await listMessages({
    q,
    labelIds: label ? [label] : undefined,
    pageToken,
    maxResults,
  });
  return c.json(res);
});

api.get("/threads/:id", async (c) => c.json(await getThread(c.req.param("id"))));

api.get("/messages/:id/attachments/:aid", async (c) => {
  const buf = await getAttachment(c.req.param("id"), c.req.param("aid"));
  const filename = c.req.query("filename") || "attachment";
  // Header-safe ASCII fallback + RFC 5987 encoded full name (Korean filenames etc.).
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
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

api.post("/draft", async (c) => {
  const body = await c.req.json();
  return c.json(await createDraft(body));
});

api.get("/drafts/by-message/:id", async (c) => {
  const found = await findDraftByMessageId(c.req.param("id"));
  if (!found) return c.json({ error: "DRAFT_NOT_FOUND" }, 404);
  return c.json(found);
});

api.put("/drafts/:id", async (c) => {
  const body = await c.req.json();
  try {
    return c.json(await updateDraft(c.req.param("id"), body));
  } catch (e) {
    // Draft deleted/sent elsewhere (Gmail web) while our editor was open —
    // give the client a typed 404 so it can fall back to creating a new draft.
    if (httpStatusOf(e) === 404) return c.json({ error: "DRAFT_NOT_FOUND" }, 404);
    throw e;
  }
});

api.post("/drafts/:id/delete", async (c) => {
  await deleteDraft(c.req.param("id"));
  return c.json({ ok: true });
});

api.get("/signature", async (c) => c.json(await getGmailSignature()));

api.get("/settings/account", async (c) => c.json(await getAccountSettings()));

// Translate auth errors to 401 for all /api routes (sub-app handles its own errors).
api.onError((e, c) => {
  if (needAuthError(e)) return c.json({ error: "NOT_AUTHENTICATED" }, 401);
  console.error("[api]", e);
  return c.json({ error: (e as Error).message }, 500);
});
app.route("/api", api);
// Unknown API paths must 404 as JSON — falling through to the SPA fallback
// returns index.html with HTTP 200, which the client then fails to JSON-parse
// (version-skew bugs masquerade as data corruption).
app.all("/api/*", (c) => c.json({ error: "NOT_FOUND" }, 404));

// ---- static (production: serve built SPA) ----
if (SERVE_STATIC) {
  // Content-hashed assets are immutable — cache hard. But only when a real
  // asset was served: a missing hashed file falls through to the index.html
  // SPA fallback (text/html, 200), and caching THAT as immutable would pin a
  // wrong response under a .js/.css URL across deploys (version skew).
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
  const distRel = relative(process.cwd(), DIST) || ".";
  app.use("/*", serveStatic({ root: distRel }));
  app.get("/*", serveStatic({ path: join(distRel, "index.html") }));
}

// Personal mail server with no request auth: never listen on 0.0.0.0 —
// anyone on the LAN could read/send mail. Opt in explicitly via HOST.
const HOSTNAME = process.env.HOST ?? "127.0.0.1";
console.log(`[server] http://${HOSTNAME === "0.0.0.0" ? "localhost" : HOSTNAME}:${PORT}`);
export default { port: PORT, hostname: HOSTNAME, fetch: app.fetch };
