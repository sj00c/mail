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
  rfc822MsgId: string; // RFC 2822 Message-ID header (for In-Reply-To/References)
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: { id: string; filename: string; mimeType: string; size: number }[];
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
};

export type EventInput = {
  calendarId: string;
  summary: string;
  start: string; // ISO datetime, or YYYY-MM-DD for all-day
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
};

export type Calendar = {
  id: string;
  summary: string;
  primary: boolean;
  backgroundColor: string | null;
  selected: boolean;
  accessRole: string;
};

export class AuthError extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 401) throw new AuthError("NOT_AUTHENTICATED");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  authStatus: () => req<{ authed: boolean }>("/auth/status"),
  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  profile: () => req<{ email: string }>("/api/profile"),
  labels: () => req<Label[]>("/api/labels"),
  calendarEvents: (opts: { days?: number; from?: string; to?: string } = {}) => {
    const u = new URLSearchParams();
    if (opts.days) u.set("days", String(opts.days));
    if (opts.from) u.set("from", opts.from);
    if (opts.to) u.set("to", opts.to);
    return req<CalEvent[]>(`/api/calendar/events?${u.toString()}`);
  },
  calendars: () => req<Calendar[]>("/api/calendar/calendars"),
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
  send: (body: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    body: string;
    bodyHtml?: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: { filename: string; mimeType: string; data: string }[];
  }) =>
    req<{ id: string; threadId: string }>("/api/send", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  saveDraft: (body: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    body: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: { filename: string; mimeType: string; data: string }[];
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
      subject: string;
      body: string;
      threadId?: string;
      attachments?: { filename: string; mimeType: string; data: string }[];
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
  attachmentUrl: (id: string, aid: string, filename: string) =>
    `/api/messages/${id}/attachments/${aid}?filename=${encodeURIComponent(filename)}`,
};

// Parse "Name <email@x>" → { name, email }
export function parseAddr(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2], email: m[2].trim() };
  return { name: raw.trim(), email: raw.trim() };
}
