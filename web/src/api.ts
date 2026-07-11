export type MessageSummary = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  labelIds: string[];
  hasAttachments: boolean;
};

export type MessageFull = MessageSummary & {
  cc: string;
  bcc: string;
  replyTo: string; // Reply-To header — replies must honor it over From
  references: string; // original References header (RFC 5322 chain)
  rfc822MsgId: string; // RFC 2822 Message-ID header (for In-Reply-To/References)
  inReplyTo: string; // preserved across draft resume
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

export type Label = { id: string; name: string; type: string; unread: number };

export type CalEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  htmlLink: string;
  calendarId: string;
  calendarSummary: string;
  color: string | null;
};

export type CalEventDetail = CalEvent & {
  description: string;
  organizer: string;
  hangoutLink: string;
  attendees: { name: string; email: string; status: string }[];
  reminderDefault: boolean;
  reminderMinutes: number | null;
};

export type EventInput = {
  calendarId: string;
  summary: string;
  start: string; // ISO datetime, or YYYY-MM-DD for all-day
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees?: string[]; // 참석자 이메일 — 지정 시 초대 메일 발송
  reminder?: "default" | "none" | number; // popup 알림 (분 전)
  createMeet?: boolean; // Google Meet 회의 링크 생성
};

export type Calendar = {
  id: string;
  summary: string;
  primary: boolean;
  backgroundColor: string | null;
  selected: boolean;
  accessRole: string;
};

export type SendAsInfo = {
  email: string;
  displayName: string;
  replyTo: string;
  isPrimary: boolean;
  isDefault: boolean;
  verified: boolean;
};

export type AccountSettings = {
  sendAs: SendAsInfo[];
  vacation: { enabled: boolean; subject: string; endTime: string | null };
};

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  size: number | null;
  modifiedTime: string;
  iconLink: string | null;
  webViewLink: string | null;
  starred: boolean;
  shared: boolean;
  owned: boolean;
};

export type DriveQuota = {
  limit: number | null;
  usage: number;
  usageInDrive: number;
};

export type DriveBreadcrumb = { id: string; name: string };

export class AuthError extends Error {}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 401) throw new AuthError("NOT_AUTHENTICATED");
  if (!res.ok) {
    const text = await res.text();
    // Server errors arrive as {"error": "..."} — surface the message, not
    // the raw JSON envelope.
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed?.error === "string") message = parsed.error;
    } catch {
      // not JSON (proxy error page etc.) — keep the raw text
    }
    throw new HttpError(message || `HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export type Contact = { name: string; email: string };

export const api = {
  authStatus: () => req<{ authed: boolean }>("/auth/status"),
  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  profile: () => req<{ email: string }>("/api/profile"),
  labels: () => req<Label[]>("/api/labels"),
  contacts: () => req<Contact[]>("/api/contacts"),
  calendarEvents: (opts: { days?: number; from?: string; to?: string } = {}) => {
    const u = new URLSearchParams();
    if (opts.days) u.set("days", String(opts.days));
    if (opts.from) u.set("from", opts.from);
    if (opts.to) u.set("to", opts.to);
    return req<CalEvent[]>(`/api/calendar/events?${u.toString()}`);
  },
  calendars: () => req<Calendar[]>("/api/calendar/calendars"),
  calendarSearch: (q: string) =>
    req<CalEvent[]>(`/api/calendar/search?q=${encodeURIComponent(q)}`),
  calendarEvent: (calendarId: string, eventId: string) =>
    req<CalEventDetail>(
      `/api/calendar/event?calendarId=${encodeURIComponent(calendarId)}&eventId=${encodeURIComponent(eventId)}`,
    ),
  createEvent: (body: EventInput) =>
    req<{ id: string }>("/api/calendar/events", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateEvent: (eventId: string, body: EventInput) =>
    req<{ ok: boolean }>(`/api/calendar/events/${encodeURIComponent(eventId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteEvent: (calendarId: string, eventId: string) =>
    req<{ ok: boolean }>(
      `/api/calendar/events/${encodeURIComponent(eventId)}/delete?calendarId=${encodeURIComponent(calendarId)}`,
      { method: "POST" },
    ),
  messages: (params: {
    q?: string;
    label?: string;
    pageToken?: string;
    maxResults?: number;
  }) => {
    const u = new URLSearchParams();
    if (params.q) u.set("q", params.q);
    if (params.label) u.set("label", params.label);
    if (params.pageToken) u.set("pageToken", params.pageToken);
    if (params.maxResults) u.set("maxResults", String(params.maxResults));
    return req<{ messages: MessageSummary[]; nextPageToken?: string }>(
      `/api/messages?${u.toString()}`,
    );
  },
  thread: (id: string) => req<MessageFull[]>(`/api/threads/${id}`),
  modify: (id: string, body: { add?: string[]; remove?: string[] }) =>
    req<{ ok: boolean }>(`/api/messages/${id}/modify`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  trash: (id: string) =>
    req<{ ok: boolean }>(`/api/messages/${id}/trash`, { method: "POST" }),
  batchModify: (ids: string[], body: { add?: string[]; remove?: string[] }) =>
    req<{ ok: boolean }>("/api/messages/batchModify", {
      method: "POST",
      body: JSON.stringify({ ids, ...body }),
    }),
  batchTrash: (ids: string[]) =>
    req<{ ok: boolean }>("/api/messages/batchTrash", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  send: (body: {
    to: string;
    cc?: string;
    bcc?: string;
    from?: string;
    replyTo?: string;
    subject: string;
    body: string;
    bodyHtml?: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: { filename: string; mimeType: string; data: string; contentId?: string }[];
    driveAttachments?: { filename: string; mimeType: string; data: string }[];
  }) =>
    req<{ id: string; threadId: string }>("/api/send", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  saveDraft: (body: {
    to: string;
    cc?: string;
    bcc?: string;
    from?: string;
    replyTo?: string;
    subject: string;
    body: string;
    bodyHtml?: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: { filename: string; mimeType: string; data: string; contentId?: string }[];
  }) =>
    req<{ id: string }>("/api/draft", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  draftByMessage: (messageId: string) =>
    req<{ draftId: string }>(`/api/drafts/by-message/${messageId}`),
  updateDraft: (
    draftId: string,
    body: {
      to: string;
      cc?: string;
      bcc?: string;
      from?: string;
      replyTo?: string;
      subject: string;
      body: string;
      bodyHtml?: string;
      threadId?: string;
      inReplyTo?: string;
      references?: string;
      attachments?: { filename: string; mimeType: string; data: string; contentId?: string }[];
    },
  ) =>
    req<{ id: string }>(`/api/drafts/${encodeURIComponent(draftId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteDraft: (draftId: string) =>
    req<{ ok: boolean }>(`/api/drafts/${encodeURIComponent(draftId)}/delete`, {
      method: "POST",
    }),
  signature: () => req<{ html: string }>("/api/signature"),
  accountSettings: () => req<AccountSettings>("/api/settings/account"),
  attachmentUrl: (id: string, aid: string, filename: string) =>
    `/api/messages/${id}/attachments/${aid}?filename=${encodeURIComponent(filename)}`,
  attachmentToDrive: (id: string, aid: string, filename: string, mimeType: string) =>
    req<DriveFile>(`/api/messages/${id}/attachments/${aid}/drive`, {
      method: "POST",
      body: JSON.stringify({ filename, mimeType }),
    }),
  // ---- drive ----
  driveQuota: () => req<DriveQuota>("/api/drive/quota"),
  driveFiles: (params: { folderId?: string; q?: string; pageToken?: string } = {}) => {
    const u = new URLSearchParams();
    if (params.q) u.set("q", params.q);
    else if (params.folderId) u.set("folderId", params.folderId);
    if (params.pageToken) u.set("pageToken", params.pageToken);
    return req<{ files: DriveFile[]; nextPageToken?: string }>(
      `/api/drive/files?${u.toString()}`,
    );
  },
  driveBreadcrumb: (folderId: string) =>
    req<DriveBreadcrumb[]>(
      `/api/drive/breadcrumb?folderId=${encodeURIComponent(folderId)}`,
    ),
  driveDownloadUrl: (id: string) => `/api/drive/files/${encodeURIComponent(id)}/download`,
  driveCreateFolder: (name: string, parentId?: string) =>
    req<DriveFile>("/api/drive/folders", {
      method: "POST",
      body: JSON.stringify({ name, parentId }),
    }),
  driveUpload: (body: {
    name: string;
    mimeType: string;
    data: string;
    parentId?: string;
  }) =>
    req<DriveFile>("/api/drive/upload", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  driveRename: (id: string, name: string) =>
    req<DriveFile>(`/api/drive/files/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),
  driveTrash: (id: string) =>
    req<{ ok: boolean }>(`/api/drive/files/${encodeURIComponent(id)}/trash`, {
      method: "POST",
    }),
};

// Parse "Name <email@x>" → { name, email }
export function parseAddr(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2], email: m[2].trim() };
  return { name: raw.trim(), email: raw.trim() };
}

// Split an address list on top-level commas only: '"Lee, Gildong" <a@b.c>'
// is one address, not two.
export function splitAddrList(s: string): string[] {
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
