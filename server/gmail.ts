import { gmail as gmailApi, type gmail_v1 } from "@googleapis/gmail";
import { getAuthedClient } from "./auth.ts";

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
  rfc822MsgId: string; // RFC 2822 Message-ID header (for In-Reply-To/References)
  references: string; // original References header (for RFC 5322 chain accumulation)
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: { id: string; filename: string; mimeType: string; size: number }[];
};

function header(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
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
    snippet: m.snippet ?? "",
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

type ExtractAcc = {
  html: string | null;
  text: string | null;
  attachments: MessageFull["attachments"];
};

function walkParts(part: gmail_v1.Schema$MessagePart | undefined, acc: ExtractAcc) {
  if (!part) return;
  const mime = part.mimeType ?? "";
  if (part.filename && part.body?.attachmentId) {
    acc.attachments.push({
      id: part.body.attachmentId,
      filename: part.filename,
      mimeType: mime,
      size: part.body.size ?? 0,
    });
    return;
  }
  if (mime === "text/html" && acc.html === null) {
    acc.html = decodeBody(part.body?.data);
  } else if (mime === "text/plain" && acc.text === null) {
    acc.text = decodeBody(part.body?.data);
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
      const full = await g.users.messages.get({
        userId: "me",
        id: ref.id!,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date", "Content-Type"],
      });
      return toSummary(full.data);
    }),
  );
  return {
    messages,
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
    rfc822MsgId: header(m.payload?.headers, "Message-ID"),
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

function encodeHeaderWord(s: string): string {
  // RFC 2047 encode non-ASCII header values (subject, display names).
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
}

export type OutAttachment = {
  filename: string;
  mimeType: string;
  data: string; // base64 (no data: prefix)
};

function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

export type MailInput = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string; // plain text
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: OutAttachment[];
  bodyHtml?: string; // optional HTML alternative (서식 있는 서명 등)
};

function buildRaw(input: MailInput): string {
  const headers = [
    `To: ${input.to}`,
    input.cc ? `Cc: ${input.cc}` : "",
    input.bcc ? `Bcc: ${input.bcc}` : "",
    `Subject: ${encodeHeaderWord(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : "",
    input.references ? `References: ${input.references}` : "",
    "MIME-Version: 1.0",
  ].filter((l) => l !== "");

  const boundary = (tag: string) =>
    `${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const b64Part = (contentType: string, data: string) => [
    `Content-Type: ${contentType}`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(data, "utf-8").toString("base64")),
  ];

  // Body: text/plain, or multipart/alternative(text, html) when HTML exists.
  let bodyLines = b64Part('text/plain; charset="UTF-8"', input.body);
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
  }

  const atts = input.attachments ?? [];
  let mime: string;
  if (atts.length === 0) {
    mime = [...headers, ...bodyLines].join("\r\n");
  } else {
    const mixed = boundary("b");
    const parts: string[] = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${mixed}"`,
      "",
      `--${mixed}`,
      ...bodyLines,
    ];
    for (const a of atts) {
      // RFC 2047 encoded-word inside quoted filename/name params — universally
      // understood by Gmail/Outlook. The previous filename*=UTF-8'' form leaked
      // RFC 5987-illegal chars (parens) unencoded, which garbled the name.
      const fname = encodeHeaderWord(a.filename.replace(/[\r\n"]/g, "_"));
      parts.push(
        `--${mixed}`,
        `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${fname}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${fname}"`,
        "",
        wrap76(a.data),
      );
    }
    parts.push(`--${mixed}--`);
    mime = parts.join("\r\n");
  }
  return Buffer.from(mime, "utf-8").toString("base64url");
}

export async function sendMessage(
  input: MailInput,
): Promise<{ id: string; threadId: string }> {
  const g = await api();
  const res = await g.users.messages.send({
    userId: "me",
    requestBody: { raw: buildRaw(input), threadId: input.threadId },
  });
  return { id: res.data.id!, threadId: res.data.threadId! };
}

export async function createDraft(input: MailInput): Promise<{ id: string }> {
  const g = await api();
  const res = await g.users.drafts.create({
    userId: "me",
    requestBody: {
      message: { raw: buildRaw(input), threadId: input.threadId },
    },
  });
  return { id: res.data.id ?? "" };
}

/** Resolve the draft id that wraps a given message id (DRAFT label rows). */
export async function findDraftByMessageId(
  messageId: string,
): Promise<{ draftId: string } | null> {
  const g = await api();
  const res = await g.users.drafts.list({
    userId: "me",
    maxResults: 100,
    fields: "drafts(id,message/id)",
  });
  const d = (res.data.drafts ?? []).find((x) => x.message?.id === messageId);
  return d?.id ? { draftId: d.id } : null;
}

/** Overwrite an existing draft in place (재저장 — keeps a single draft). */
export async function updateDraft(
  draftId: string,
  input: MailInput,
): Promise<{ id: string }> {
  const g = await api();
  const res = await g.users.drafts.update({
    userId: "me",
    id: draftId,
    requestBody: {
      message: { raw: buildRaw(input), threadId: input.threadId },
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
