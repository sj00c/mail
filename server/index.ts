import { Hono } from "hono";
import { compress } from "hono/compress";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  consumeOAuthState,
  getAuthUrl,
  handleCallback,
  isAuthed,
  logout,
} from "./auth.ts";
import { apiErrorStatus, httpStatusOf, publicApiError } from "./apiErrors.ts";
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
  batchModifyMessages,
  batchTrashMessages,
  prepareBulkAllMessages,
  confirmBulkAllMessages,
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
import { clearContactsCache, listContacts } from "./contacts.ts";
import {
  listFiles,
  searchFiles,
  getBreadcrumb,
  getQuota,
  downloadFile,
  createFolder,
  trashFile,
  renameFile,
  uploadFile,
} from "./drive.ts";

const PORT = Number(process.env.PORT ?? 8787);

// Production (NODE_ENV=production, via `bun run start`) serves the built SPA
// itself and OAuth bounces to "/". Dev serves the SPA on Vite :5173.
const IS_PROD = process.env.NODE_ENV === "production";
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const SERVE_STATIC = IS_PROD && existsSync(DIST);
const APP_URL =
  process.env.APP_URL ?? (SERVE_STATIC ? "/" : "http://localhost:5173/");

const app = new Hono();
app.use(compress());

// ---- helpers ----
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    console.error("[auth/callback]", e);
    return c.html("<h2>Google 로그인을 완료하지 못했습니다. 앱으로 돌아가 다시 시도하세요.</h2>", 500);
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

api.get("/profile", async (c) => c.json(await getProfile()));

api.get("/labels", async (c) => c.json(await listLabels()));

// 받는사람 자동완성용 — 주소록 + 자주 주고받은 주소 (이메일 기준 병합).
api.get("/contacts", async (c) => c.json(await listContacts()));

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
export function createMessageListApi(
  listMessagesImpl: typeof listMessages = listMessages,
): Hono {
  const messages = new Hono();

  messages.get("/", async (c) => {
    const q = c.req.query("q") || undefined;
    const label = c.req.query("label") || undefined;
    const pageToken = c.req.query("pageToken") || undefined;
    const max = finiteOr(c.req.query("maxResults"), "maxResults");
    if (!max.ok) return c.json({ error: max.error }, 400);
    if (max.value !== undefined &&
      (!Number.isInteger(max.value) || max.value < 1 || max.value > 500)) {
      return c.json({ error: "maxResults must be an integer from 1 to 500" }, 400);
    }
    return c.json(await listMessagesImpl({
      q,
      labelIds: label ? [label] : undefined,
      pageToken,
      maxResults: max.value,
    }));
  });
  messages.onError((e, c) => {
    const status = apiErrorStatus(e);
    console.error("[api/messages]", e);
    return c.json({ error: publicApiError(e) }, status);
  });

  return messages;
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

api.route("/messages", createMessageListApi());

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
// 첨부파일을 내 Drive에 저장 (Gmail → Drive, 브라우저 왕복 없이 서버에서 직행).
api.post("/messages/:id/attachments/:aid/drive", async (c) => {
  const { filename, mimeType } = (await c.req.json()) as {
    filename?: string;
    mimeType?: string;
  };
  if (!filename) return c.json({ error: "filename required" }, 400);
  const buf = await getAttachment(c.req.param("id"), c.req.param("aid"));
  const file = await uploadFile({
    name: filename,
    mimeType: mimeType || "application/octet-stream",
    data: buf.toString("base64"),
  });
  return c.json(file);
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

// 일괄 처리(목록 체크박스 선택). ids는 클라이언트가 보낸 메시지 id 배열.
api.post("/messages/batchModify", async (c) => {
  const body = await c.req.json<{
    ids?: string[];
    add?: string[];
    remove?: string[];
  }>();
  await batchModifyMessages(body.ids ?? [], { add: body.add, remove: body.remove });
  return c.json({ ok: true });
});

api.post("/messages/batchTrash", async (c) => {
  const body = await c.req.json<{ ids?: string[] }>();
  await batchTrashMessages(body.ids ?? []);
  return c.json({ ok: true });
});

api.post("/messages/bulkAll/prepare", async (c) => {
  const body = await c.req.json<{
    q?: string;
    label?: string;
    action?: "read" | "unread" | "trash";
  }>();
  if (!body.action || !["read", "unread", "trash"].includes(body.action)) {
    return c.json({ error: "action must be read, unread, or trash" }, 400);
  }
  return c.json(
    await prepareBulkAllMessages({
      q: body.q?.trim() || undefined,
      labelIds: body.label ? [body.label] : undefined,
      action: body.action,
    }),
  );
});

api.post("/messages/bulkAll/confirm", async (c) => {
  const body = await c.req.json<{ operationId?: string }>();
  if (!body.operationId) return c.json({ error: "operationId required" }, 400);
  return c.json(await confirmBulkAllMessages(body.operationId));
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

// ---- drive routes ----
api.get("/drive/quota", async (c) => c.json(await getQuota()));

api.get("/drive/files", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const pageToken = c.req.query("pageToken") || undefined;
  if (q) return c.json(await searchFiles(q, pageToken));
  const folderId = c.req.query("folderId") || undefined;
  return c.json(await listFiles({ folderId, pageToken }));
});

api.get("/drive/breadcrumb", async (c) => {
  const folderId = c.req.query("folderId");
  if (!folderId) return c.json([]);
  return c.json(await getBreadcrumb(folderId));
});

api.get("/drive/files/:id/download", async (c) => {
  const { buffer, filename, mimeType } = await downloadFile(c.req.param("id"));
  // Header-safe ASCII fallback + RFC 5987 encoded full name (Korean filenames etc.).
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    },
  });
});

api.post("/drive/folders", async (c) => {
  const { name, parentId } = await c.req.json<{ name?: string; parentId?: string }>();
  if (!name?.trim()) return c.json({ error: "name required" }, 400);
  return c.json(await createFolder(name.trim(), parentId));
});

api.post("/drive/upload", async (c) => {
  const body = await c.req.json<{
    name?: string;
    mimeType?: string;
    data?: string;
    parentId?: string;
  }>();
  if (!body.name?.trim() || typeof body.data !== "string")
    return c.json({ error: "name and data required" }, 400);
  return c.json(
    await uploadFile({
      name: body.name.trim(),
      mimeType: body.mimeType ?? "application/octet-stream",
      data: body.data,
      parentId: body.parentId,
    }),
  );
});

api.put("/drive/files/:id", async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) return c.json({ error: "name required" }, 400);
  return c.json(await renameFile(c.req.param("id"), name.trim()));
});

api.post("/drive/files/:id/trash", async (c) => {
  await trashFile(c.req.param("id"));
  return c.json({ ok: true });
});

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

// ---- static (production: serve built SPA) ----
if (SERVE_STATIC) {
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
  const distRel = relative(process.cwd(), DIST) || ".";
  app.use("/*", serveStatic({ root: distRel }));
  app.get("/*", serveStatic({ path: join(distRel, "index.html") }));
}

// Personal mail server with no request auth: never listen on 0.0.0.0 —
// anyone on the LAN could read/send mail. Opt in explicitly via HOST.
const HOSTNAME = process.env.HOST ?? "127.0.0.1";
console.log(`[server] http://${HOSTNAME === "0.0.0.0" ? "localhost" : HOSTNAME}:${PORT}`);
export default { port: PORT, hostname: HOSTNAME, fetch: app.fetch };
