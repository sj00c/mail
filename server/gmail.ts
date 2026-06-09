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
    hasAttachments: hasAttachment(m.payload),
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
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      return toSummary(full.data);
    }),
  );
  return {
    messages,
    nextPageToken: list.data.nextPageToken ?? undefined,
  };
}

export async function getMessage(id: string): Promise<MessageFull> {
  const g = await api();
  const res = await g.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
  const m = res.data;
  const summary = toSummary(m);
  const acc: ExtractAcc = { html: null, text: null, attachments: [] };
  walkParts(m.payload, acc);
  return {
    ...summary,
    cc: header(m.payload?.headers, "Cc"),
    bodyHtml: acc.html,
    bodyText: acc.text,
    attachments: acc.attachments,
  };
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

export async function listLabels(): Promise<
  { id: string; name: string; type: string; unread: number }[]
> {
  const g = await api();
  const res = await g.users.labels.list({ userId: "me" });
  const labels = res.data.labels ?? [];
  // Fetch unread counts only for the common system + user labels lazily.
  const detailed = await Promise.all(
    labels.map(async (l) => {
      try {
        const d = await g.users.labels.get({ userId: "me", id: l.id! });
        return {
          id: l.id!,
          name: l.name!,
          type: l.type ?? "user",
          unread: d.data.messagesUnread ?? 0,
        };
      } catch {
        return { id: l.id!, name: l.name!, type: l.type ?? "user", unread: 0 };
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

export async function sendMessage(input: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string; // plain text
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: OutAttachment[];
}): Promise<{ id: string; threadId: string }> {
  const g = await api();
  const headers = [
    `To: ${input.to}`,
    input.cc ? `Cc: ${input.cc}` : "",
    input.bcc ? `Bcc: ${input.bcc}` : "",
    `Subject: ${encodeHeaderWord(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : "",
    input.references ? `References: ${input.references}` : "",
    "MIME-Version: 1.0",
  ].filter((l) => l !== "");

  const atts = input.attachments ?? [];
  const bodyB64 = wrap76(Buffer.from(input.body, "utf-8").toString("base64"));
  let mime: string;
  if (atts.length === 0) {
    mime = [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      bodyB64,
    ].join("\r\n");
  } else {
    const boundary = `b_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2)}`;
    const parts: string[] = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      bodyB64,
    ];
    for (const a of atts) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${a.mimeType || "application/octet-stream"}`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
        "",
        wrap76(a.data),
      );
    }
    parts.push(`--${boundary}--`);
    mime = parts.join("\r\n");
  }
  const raw = Buffer.from(mime, "utf-8").toString("base64url");
  const res = await g.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: input.threadId },
  });
  return { id: res.data.id!, threadId: res.data.threadId! };
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
