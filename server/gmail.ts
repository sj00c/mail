import { gmail as gmailApi, type gmail_v1 } from "@googleapis/gmail";
import { getAuthedClient } from "./auth.ts";
import { uploadAndShare } from "./drive.ts";

async function api(): Promise<gmail_v1.Gmail> {
  const auth = await getAuthedClient();
  return gmailApi({ version: "v1", auth });
}

export type MessageSummary = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string; // ISO
  unread: boolean;
  labelIds: string[];
  hasAttachments: boolean;
};

export type MessageFull = MessageSummary & {
  cc: string;
  bcc: string; // drafts may carry Bcc — must survive a draft-resume roundtrip
  replyTo: string; // Reply-To header — replies must honor it over From
  rfc822MsgId: string; // RFC 2822 Message-ID header (for In-Reply-To/References)
  inReplyTo: string; // draft resume must preserve reply threading headers
  references: string; // original References header (for RFC 5322 chain accumulation)
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    contentId?: string; // inline (cid:) image parts
  }[];
};

function header(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

// Gmail snippets arrive HTML-escaped ("&amp;#39;", "&amp;amp;") — decode for display.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1]?.toLowerCase() === "x"
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

function toSummary(m: gmail_v1.Schema$Message): MessageSummary {
  const headers = m.payload?.headers;
  const internal = m.internalDate ? Number(m.internalDate) : Date.now();
  const labelIds = m.labelIds ?? [];
  return {
    id: m.id!,
    threadId: m.threadId!,
    from: header(headers, "From"),
    to: header(headers, "To"),
    subject: header(headers, "Subject"),
    snippet: decodeEntities(m.snippet ?? ""),
    date: new Date(internal).toISOString(),
    unread: labelIds.includes("UNREAD"),
    labelIds,
    // format=metadata has no payload parts — fall back to the Content-Type
    // header (multipart/mixed ⇒ attachments) so the list 📎 indicator works.
    hasAttachments:
      hasAttachment(m.payload) ||
      /multipart\/mixed/i.test(header(headers, "Content-Type")),
  };
}

function hasAttachment(part?: gmail_v1.Schema$MessagePart): boolean {
  if (!part) return false;
  if (part.filename && part.body?.attachmentId) return true;
  return (part.parts ?? []).some(hasAttachment);
}

function decodeBody(data?: string | null): string {
  if (!data) return "";
  // Gmail uses base64url.
  return Buffer.from(data, "base64url").toString("utf-8");
}

function errStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [e?.status, e?.code, e?.response?.status]) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return undefined;
}

type ExtractAcc = {
  html: string | null;
  text: string | null;
  attachments: MessageFull["attachments"];
};

function walkParts(part: gmail_v1.Schema$MessagePart | undefined, acc: ExtractAcc) {
  if (!part) return;
  const mime = part.mimeType ?? "";
  if (part.body?.attachmentId) {
    // Filename-less parts are real too (inline cid: images, some calendar
    // invites) — dropping them made them undownloadable and broke cid: refs.
    const contentId = header(part.headers, "Content-ID").replace(/^<|>$/g, "");
    acc.attachments.push({
      id: part.body.attachmentId,
      filename:
        part.filename || `attachment.${(mime.split("/")[1] ?? "bin").slice(0, 10)}`,
      mimeType: mime,
      size: part.body.size ?? 0,
      contentId: contentId || undefined,
    });
    return;
  }
  // Concatenate, don't keep-first: multipart/mixed bodies interleave text
  // segments around attachments and keeping only the first truncates them.
  if (mime === "text/html") {
    const html = decodeBody(part.body?.data);
    if (html) acc.html = acc.html === null ? html : acc.html + html;
  } else if (mime === "text/plain") {
    const text = decodeBody(part.body?.data);
    if (text) acc.text = acc.text === null ? text : `${acc.text}\n${text}`;
  }
  for (const child of part.parts ?? []) walkParts(child, acc);
}

export async function listMessages(opts: {
  q?: string;
  labelIds?: string[];
  pageToken?: string;
  maxResults?: number;
}): Promise<{ messages: MessageSummary[]; nextPageToken?: string }> {
  const g = await api();
  const list = await g.users.messages.list({
    userId: "me",
    q: opts.q,
    labelIds: opts.labelIds,
    pageToken: opts.pageToken,
    maxResults: opts.maxResults ?? 25,
  });
  const ids = list.data.messages ?? [];
  const messages = await Promise.all(
    ids.map(async (ref) => {
      // A message deleted between list and get (404) must not sink the
      // whole list response. Other failures (429 rate limit, 5xx) still
      // propagate — silently dropping rows would render a quietly
      // incomplete inbox with HTTP 200.
      try {
        const full = await g.users.messages.get({
          userId: "me",
          id: ref.id!,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date", "Content-Type"],
        });
        return toSummary(full.data);
      } catch (err) {
        if (errStatus(err) === 404) {
          console.error(`[gmail] message ${ref.id} vanished (404), skipping`);
          return null;
        }
        throw err;
      }
    }),
  );
  return {
    messages: messages.filter((m): m is MessageSummary => m !== null),
    nextPageToken: list.data.nextPageToken ?? undefined,
  };
}

function toFull(m: gmail_v1.Schema$Message): MessageFull {
  const summary = toSummary(m);
  const acc: ExtractAcc = { html: null, text: null, attachments: [] };
  walkParts(m.payload, acc);
  return {
    ...summary,
    cc: header(m.payload?.headers, "Cc"),
    bcc: header(m.payload?.headers, "Bcc"),
    replyTo: header(m.payload?.headers, "Reply-To"),
    rfc822MsgId: header(m.payload?.headers, "Message-ID"),
    inReplyTo: header(m.payload?.headers, "In-Reply-To"),
    references: header(m.payload?.headers, "References"),
    bodyHtml: acc.html,
    bodyText: acc.text,
    attachments: acc.attachments,
  };
}

/** All messages in a conversation thread, oldest first. */
export async function getThread(threadId: string): Promise<MessageFull[]> {
  const g = await api();
  const res = await g.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });
  return (res.data.messages ?? []).map(toFull);
}

export async function getAttachment(
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const g = await api();
  const res = await g.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  return Buffer.from(res.data.data ?? "", "base64url");
}

// Sidebar shows only these system labels (mirrors SYSTEM_ORDER in web/src/App.tsx)
// plus user labels — unread counts for anything else are never displayed, so
// skip their per-label `labels.get` round-trips (CATEGORY_*, CHAT, IMPORTANT, …).
const DISPLAYED_SYSTEM = new Set([
  "INBOX",
  "STARRED",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
]);

export async function listLabels(): Promise<
  { id: string; name: string; type: string; unread: number }[]
> {
  const g = await api();
  const res = await g.users.labels.list({ userId: "me" });
  const labels = res.data.labels ?? [];
  const detailed = await Promise.all(
    labels.map(async (l) => {
      const base = { id: l.id!, name: l.name!, type: l.type ?? "user", unread: 0 };
      if (base.type !== "user" && !DISPLAYED_SYSTEM.has(base.id)) return base;
      try {
        const d = await g.users.labels.get({
          userId: "me",
          id: l.id!,
          fields: "messagesUnread",
        });
        return { ...base, unread: d.data.messagesUnread ?? 0 };
      } catch {
        return base;
      }
    }),
  );
  return detailed;
}

function encodeHeaderWord(s: string, fold = true): string {
  // RFC 2047 encode non-ASCII header values (subject, display names).
  // Encoded words are capped at 75 chars, so long Korean subjects must be
  // split into multiple words joined by folding whitespace.
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  // fold=false: single (over-long) encoded word. Required inside quoted
  // name="/filename=" params — a CRLF+space fold inside a quoted-string is
  // NOT elided on decode and garbles the filename (the exact bug c2894fe
  // fixed). Gmail/Outlook decode the over-long word fine.
  if (!fold) {
    return `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
  }
  const words: string[] = [];
  let cur = "";
  for (const ch of s) {
    // 33 UTF-8 bytes → 44 base64 chars → 56-char encoded word (≤75).
    if (cur && Buffer.byteLength(cur + ch, "utf-8") > 33) {
      words.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) words.push(cur);
  return words
    .map((w) => `=?UTF-8?B?${Buffer.from(w, "utf-8").toString("base64")}?=`)
    .join("\r\n ");
}

/** Split an address list on top-level commas only (quoted display names and
 *  angle-bracket contents may legitimately contain commas). */
function splitAddrList(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of s) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === "<") inAngle = true;
    else if (!inQuotes && ch === ">") inAngle = false;
    if (ch === "," && !inQuotes && !inAngle) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

/** RFC 2047-encode non-ASCII display names in a To/Cc/Bcc list; raw 8-bit
 *  names are undefined behavior across receiving MTAs. */
function formatAddrList(raw: string): string {
  return splitAddrList(stripCrlf(raw))
    .map((tok) => {
      const m = tok.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
      if (!m) return tok;
      const name = m[1].trim();
      const email = m[2].trim();
      if (!name) return `<${email}>`;
      if (/^[\x00-\x7F]*$/.test(name)) {
        // Re-quote any name containing a char outside atext+space — an
        // unquoted ":" turns the address into RFC 5322 group syntax, "()"
        // into a comment, etc. (the capture group already excludes `"`).
        return /[^A-Za-z0-9 !#$%&'*+/=?^_`{|}~-]/.test(name)
          ? `"${name}" <${email}>`
          : `${name} <${email}>`;
      }
      return `${encodeHeaderWord(name)} <${email}>`;
    })
    .join(", ");
}

// Raw CR/LF in a header value would terminate the header early (or smuggle
// new ones). Inputs are sanitized at the seam regardless of origin.
function stripCrlf(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

/** Fold a space-separated id list (References) so no line exceeds ~78 chars. */
function foldIdList(ids: string): string {
  const parts = stripCrlf(ids).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const id of parts) {
    if (cur && cur.length + 1 + id.length > 76) {
      lines.push(cur);
      cur = id;
    } else {
      cur = cur ? `${cur} ${id}` : id;
    }
  }
  if (cur) lines.push(cur);
  return lines.join("\r\n ");
}

export type OutAttachment = {
  filename: string;
  mimeType: string;
  data: string; // base64 (no data: prefix)
  contentId?: string; // set → inline image referenced by cid: in bodyHtml
};

function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

export type MailInput = {
  to: string;
  cc?: string;
  bcc?: string;
  from?: string; // send-as alias ("Name <alias@x>"); Gmail rewrites unauthorized ones
  replyTo?: string; // account default Reply-To (sendAs.replyToAddress)
  subject: string;
  body: string; // plain text
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: OutAttachment[];
  bodyHtml?: string; // optional HTML alternative (서식 있는 서명 등)
  // Oversize files that can't ride in the MIME body (Gmail caps the whole
  // message at ~35MB). At send time these are uploaded to Drive, shared
  // anyone-with-link, and rendered as link rows appended to the body — exactly
  // what the Gmail web client does past 25MB.
  driveAttachments?: { filename: string; mimeType: string; data: string }[];
};

function buildMime(input: MailInput): string {
  const headers = [
    input.from ? `From: ${formatAddrList(input.from)}` : "",
    `To: ${formatAddrList(input.to)}`,
    input.cc ? `Cc: ${formatAddrList(input.cc)}` : "",
    input.bcc ? `Bcc: ${formatAddrList(input.bcc)}` : "",
    input.replyTo ? `Reply-To: ${formatAddrList(input.replyTo)}` : "",
    `Subject: ${encodeHeaderWord(stripCrlf(input.subject))}`,
    input.inReplyTo ? `In-Reply-To: ${stripCrlf(input.inReplyTo)}` : "",
    input.references ? `References: ${foldIdList(input.references)}` : "",
    "MIME-Version: 1.0",
  ].filter((l) => l !== "");

  let boundarySeq = 0;
  const boundary = (tag: string) =>
    `${tag}_${Date.now().toString(36)}_${(boundarySeq++).toString(36)}_${Math.random().toString(36).slice(2)}`;
  const b64Part = (contentType: string, data: string) => [
    `Content-Type: ${contentType}`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(data, "utf-8").toString("base64")),
  ];

  // Proper nesting, built inside-out:
  //   multipart/alternative (text + html)
  //     └ wrapped in multipart/related when there are inline (cid) images
  //       └ wrapped in multipart/mixed when there are file attachments
  // Each layer is only added when it has more than one child.

  // 1. body — text/plain alone, or multipart/alternative(text, html).
  let bodyLines: string[];
  if (input.bodyHtml) {
    const alt = boundary("alt");
    bodyLines = [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      `--${alt}`,
      ...b64Part('text/plain; charset="UTF-8"', input.body),
      `--${alt}`,
      ...b64Part('text/html; charset="UTF-8"', input.bodyHtml),
      `--${alt}--`,
    ];
  } else {
    bodyLines = b64Part('text/plain; charset="UTF-8"', input.body);
  }

  const all = input.attachments ?? [];
  const inline = all.filter((a) => a.contentId);
  const files = all.filter((a) => !a.contentId);

  const attachPart = (a: OutAttachment, disposition: "attachment" | "inline") => {
    const fname = encodeHeaderWord(a.filename.replace(/[\r\n"\\]/g, "_"), false);
    const lines = [
      `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${fname}"`,
      "Content-Transfer-Encoding: base64",
    ];
    if (disposition === "inline" && a.contentId) {
      lines.push(`Content-ID: <${a.contentId.replace(/[\r\n<>]/g, "")}>`);
      lines.push(`Content-Disposition: inline; filename="${fname}"`);
    } else {
      lines.push(`Content-Disposition: attachment; filename="${fname}"`);
    }
    lines.push("", wrap76(a.data));
    return lines;
  };

  // 2. wrap body + inline images in multipart/related (only if any inline).
  if (inline.length > 0) {
    const rel = boundary("rel");
    const relLines = [
      `Content-Type: multipart/related; boundary="${rel}"`,
      "",
      `--${rel}`,
      ...bodyLines,
    ];
    for (const a of inline) relLines.push(`--${rel}`, ...attachPart(a, "inline"));
    relLines.push(`--${rel}--`);
    bodyLines = relLines;
  }

  // 3. wrap in multipart/mixed (only if any file attachments).
  if (files.length === 0) {
    return [...headers, ...bodyLines].join("\r\n");
  }
  const mixed = boundary("mix");
  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    ...bodyLines,
  ];
  for (const a of files) parts.push(`--${mixed}`, ...attachPart(a, "attachment"));
  parts.push(`--${mixed}--`);
  return parts.join("\r\n");
}

// Above this, the message goes through the /upload media endpoint: the plain
// JSON endpoint rejects bodies past ~10MB, which silently broke sends with
// large attachments (base64-encoded 25MB file ≈ 34MB raw message).
const MEDIA_UPLOAD_THRESHOLD = 4 * 1024 * 1024;

function asRaw(mime: string): string {
  return Buffer.from(mime, "utf-8").toString("base64url");
}

function humanSize(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + " KB";
  return n + " B";
}

/**
 * Upload any `driveAttachments` to Drive (anyone-with-link), then fold the
 * resulting links into the message body. Returns a MailInput with
 * `driveAttachments` cleared so buildMime never tries to MIME-embed them.
 * No-op (returns input as-is) when there are none.
 */
async function resolveDriveLinks(input: MailInput): Promise<MailInput> {
  const big = input.driveAttachments ?? [];
  if (big.length === 0) return input;

  const shared = await Promise.all(
    big.map((a) =>
      uploadAndShare({ name: a.filename, mimeType: a.mimeType, data: a.data }),
    ),
  );

  const textLines = [
    "",
    "── Google Drive 첨부 ──",
    ...shared.map((s) => `• ${s.name} (${humanSize(s.size)})\n  ${s.link}`),
  ];
  const body = input.body + "\n" + textLines.join("\n");

  let bodyHtml = input.bodyHtml;
  if (bodyHtml !== undefined) {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const rows = shared
      .map(
        (s) =>
          `<div style="margin:4px 0"><a href="${esc(s.link)}" style="text-decoration:none">📎 ${esc(s.name)}</a> <span style="color:#5f6368">(${humanSize(s.size)})</span></div>`,
      )
      .join("");
    bodyHtml +=
      `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e0e0e0">` +
      `<div style="color:#5f6368;font-size:12px;margin-bottom:6px">Google Drive 첨부</div>${rows}</div>`;
  }

  return { ...input, body, bodyHtml, driveAttachments: undefined };
}

export async function sendMessage(
  input: MailInput,
): Promise<{ id: string; threadId: string }> {
  const g = await api();
  const resolved = await resolveDriveLinks(input);
  const mime = buildMime(resolved);
  const res =
    Buffer.byteLength(mime, "utf-8") > MEDIA_UPLOAD_THRESHOLD
      ? await g.users.messages.send({
          userId: "me",
          requestBody: { threadId: input.threadId },
          media: { mimeType: "message/rfc822", body: mime },
        })
      : await g.users.messages.send({
          userId: "me",
          requestBody: { raw: asRaw(mime), threadId: input.threadId },
        });
  return { id: res.data.id!, threadId: res.data.threadId! };
}

export async function createDraft(input: MailInput): Promise<{ id: string }> {
  const g = await api();
  const mime = buildMime(input);
  const res =
    Buffer.byteLength(mime, "utf-8") > MEDIA_UPLOAD_THRESHOLD
      ? await g.users.drafts.create({
          userId: "me",
          requestBody: { message: { threadId: input.threadId } },
          media: { mimeType: "message/rfc822", body: mime },
        })
      : await g.users.drafts.create({
          userId: "me",
          requestBody: {
            message: { raw: asRaw(mime), threadId: input.threadId },
          },
        });
  return { id: res.data.id ?? "" };
}

/** Resolve the draft id that wraps a given message id (DRAFT label rows). */
export async function findDraftByMessageId(
  messageId: string,
): Promise<{ draftId: string } | null> {
  const g = await api();
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await g.users.drafts.list({
      userId: "me",
      maxResults: 100,
      pageToken,
      fields: "drafts(id,message/id),nextPageToken",
    });
    const d = (res.data.drafts ?? []).find((x) => x.message?.id === messageId);
    if (d?.id) return { draftId: d.id };
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return null;
}

/** Overwrite an existing draft in place (재저장 — keeps a single draft). */
export async function updateDraft(
  draftId: string,
  input: MailInput,
): Promise<{ id: string }> {
  const g = await api();
  const mime = buildMime(input);
  const res =
    Buffer.byteLength(mime, "utf-8") > MEDIA_UPLOAD_THRESHOLD
      ? await g.users.drafts.update({
          userId: "me",
          id: draftId,
          requestBody: { message: { threadId: input.threadId } },
          media: { mimeType: "message/rfc822", body: mime },
        })
      : await g.users.drafts.update({
          userId: "me",
          id: draftId,
          requestBody: {
            message: { raw: asRaw(mime), threadId: input.threadId },
          },
        });
  return { id: res.data.id ?? "" };
}

export async function deleteDraft(draftId: string): Promise<void> {
  const g = await api();
  await g.users.drafts.delete({ userId: "me", id: draftId });
}

/** Primary send-as signature (HTML) — readable with gmail.modify, no extra scope. */
export async function getGmailSignature(): Promise<{ html: string }> {
  const g = await api();
  const res = await g.users.settings.sendAs.list({
    userId: "me",
    fields: "sendAs(isPrimary,signature)",
  });
  const primary = (res.data.sendAs ?? []).find((s) => s.isPrimary);
  return { html: primary?.signature ?? "" };
}

export type SendAsInfo = {
  email: string;
  displayName: string;
  replyTo: string; // account-level default Reply-To for this alias
  isPrimary: boolean;
  isDefault: boolean;
  verified: boolean; // unverified aliases get rewritten to primary by Gmail
};

export type AccountSettings = {
  sendAs: SendAsInfo[];
  vacation: { enabled: boolean; subject: string; endTime: string | null };
};

/** Account settings that should "ride along" with login — send-as aliases
 *  (표시명/답장주소 포함) and vacation-responder state. All readable with
 *  gmail.modify; writing them would need gmail.settings.* scopes. */
export async function getAccountSettings(): Promise<AccountSettings> {
  const g = await api();
  const [sa, vac] = await Promise.all([
    g.users.settings.sendAs.list({
      userId: "me",
      fields:
        "sendAs(sendAsEmail,displayName,replyToAddress,isPrimary,isDefault,verificationStatus)",
    }),
    g.users.settings.getVacation({ userId: "me" }),
  ]);
  return {
    sendAs: (sa.data.sendAs ?? [])
      .filter((s) => s.sendAsEmail)
      .map((s) => ({
        email: s.sendAsEmail!,
        displayName: s.displayName ?? "",
        replyTo: s.replyToAddress ?? "",
        isPrimary: !!s.isPrimary,
        isDefault: !!s.isDefault,
        // primary has no verificationStatus; treat anything not "pending" as usable
        verified: s.verificationStatus !== "pending",
      })),
    vacation: {
      enabled: !!vac.data.enableAutoReply,
      subject: vac.data.responseSubject ?? "",
      endTime: vac.data.endTime
        ? new Date(Number(vac.data.endTime)).toISOString()
        : null,
    },
  };
}

export async function modifyMessage(
  id: string,
  changes: { add?: string[]; remove?: string[] },
): Promise<void> {
  const g = await api();
  await g.users.messages.modify({
    userId: "me",
    id,
    requestBody: {
      addLabelIds: changes.add,
      removeLabelIds: changes.remove,
    },
  });
}

export async function trashMessage(id: string): Promise<void> {
  const g = await api();
  await g.users.messages.trash({ userId: "me", id });
}

export async function getProfile(): Promise<{ email: string }> {
  const g = await api();
  const res = await g.users.getProfile({ userId: "me" });
  return { email: res.data.emailAddress ?? "" };
}
