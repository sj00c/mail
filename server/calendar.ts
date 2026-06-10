import { calendar as calendarApi, type calendar_v3 } from "@googleapis/calendar";
import { getAuthedClient } from "./auth.ts";

async function api(): Promise<calendar_v3.Calendar> {
  const auth = await getAuthedClient();
  return calendarApi({ version: "v3", auth });
}

// calendarList barely changes but was re-fetched on every 60s event refresh.
// Cache it briefly; listCalendars() (calendar view entry) refreshes it.
const CAL_LIST_TTL_MS = 5 * 60_000;
const CAL_LIST_FIELDS =
  "items(id,summary,summaryOverride,primary,backgroundColor,selected,accessRole)";
let calListCache: {
  items: calendar_v3.Schema$CalendarListEntry[];
  at: number;
} | null = null;

async function cachedCalendarList(
  cal: calendar_v3.Calendar,
): Promise<calendar_v3.Schema$CalendarListEntry[]> {
  if (calListCache && Date.now() - calListCache.at < CAL_LIST_TTL_MS) {
    return calListCache.items;
  }
  const list = await cal.calendarList.list({
    maxResults: 250,
    fields: CAL_LIST_FIELDS,
  });
  const items = (list.data.items ?? []).filter((c) => c.id);
  calListCache = { items, at: Date.now() };
  return items;
}

/** Drop cached calendar metadata (call on logout — it is account-scoped). */
export function clearCalendarCache(): void {
  calListCache = null;
}

export type CalEvent = {
  id: string;
  summary: string;
  start: string; // ISO datetime, or YYYY-MM-DD for all-day
  end: string;
  allDay: boolean;
  location: string;
  htmlLink: string;
  calendarId: string;
  calendarSummary: string;
  color: string | null; // calendar's backgroundColor (hex)
};

export type CalEventDetail = CalEvent & {
  description: string;
  organizer: string;
  hangoutLink: string;
  attendees: { name: string; email: string; status: string }[];
};

/** Full detail for a single event (lazy-loaded on click). */
export async function getEvent(
  calendarId: string,
  eventId: string,
): Promise<CalEventDetail> {
  const cal = await api();
  const res = await cal.events.get({ calendarId, eventId });
  const e = res.data;
  return {
    id: e.id ?? "",
    summary: e.summary?.trim() || "(제목 없음)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    allDay: !e.start?.dateTime,
    location: e.location ?? "",
    htmlLink: e.htmlLink ?? "",
    calendarId,
    calendarSummary: "",
    color: null,
    description: e.description ?? "",
    organizer: e.organizer?.displayName || e.organizer?.email || "",
    hangoutLink: e.hangoutLink ?? "",
    attendees: (e.attendees ?? []).map((a) => ({
      name: a.displayName ?? "",
      email: a.email ?? "",
      status: a.responseStatus ?? "",
    })),
  };
}

export type EventInput = {
  calendarId: string;
  summary: string;
  start: string; // ISO datetime, or YYYY-MM-DD for all-day
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
};

function toEventBody(i: EventInput): calendar_v3.Schema$Event {
  return {
    summary: i.summary || "(제목 없음)",
    location: i.location || undefined,
    description: i.description || undefined,
    start: i.allDay
      ? { date: i.start.slice(0, 10) }
      : { dateTime: new Date(i.start).toISOString() },
    end: i.allDay
      ? { date: i.end.slice(0, 10) }
      : { dateTime: new Date(i.end).toISOString() },
  };
}

export async function createEvent(i: EventInput): Promise<{ id: string }> {
  const cal = await api();
  const res = await cal.events.insert({
    calendarId: i.calendarId,
    requestBody: toEventBody(i),
  });
  return { id: res.data.id ?? "" };
}

export async function updateEvent(
  eventId: string,
  i: EventInput,
): Promise<void> {
  const cal = await api();
  await cal.events.patch({
    calendarId: i.calendarId,
    eventId,
    requestBody: toEventBody(i),
  });
}

export async function deleteEvent(
  calendarId: string,
  eventId: string,
): Promise<void> {
  const cal = await api();
  await cal.events.delete({ calendarId, eventId });
}

/**
 * Upcoming events across all of the user's selected calendars,
 * from now to now + `days`, expanded (recurring -> single instances), sorted by start.
 */
export async function listEvents(
  opts: { days?: number; timeMin?: string; timeMax?: string } = {},
): Promise<CalEvent[]> {
  const cal = await api();
  let timeMin: string;
  let timeMax: string;
  if (opts.timeMin && opts.timeMax) {
    timeMin = new Date(opts.timeMin).toISOString();
    timeMax = new Date(opts.timeMax).toISOString();
  } else {
    const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
    const now = new Date();
    timeMin = now.toISOString();
    timeMax = new Date(now.getTime() + days * 86_400_000).toISOString();
  }

  const calendars = await cachedCalendarList(cal);

  const perCalendar = await Promise.all(
    calendars.map(async (c) => {
      try {
        const res = await cal.events.list({
          calendarId: c.id!,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 250,
          fields:
            "items(id,summary,location,htmlLink,status,start,end),nextPageToken",
        });
        const out: CalEvent[] = [];
        for (const e of res.data.items ?? []) {
          if (e.status === "cancelled") continue;
          const startDt = e.start?.dateTime ?? e.start?.date ?? "";
          if (!startDt) continue;
          out.push({
            id: e.id ?? "",
            summary: e.summary?.trim() || "(제목 없음)",
            start: startDt,
            end: e.end?.dateTime ?? e.end?.date ?? "",
            allDay: !e.start?.dateTime,
            location: e.location ?? "",
            htmlLink: e.htmlLink ?? "",
            calendarId: c.id ?? "",
            calendarSummary: c.summaryOverride || c.summary || c.id || "",
            color: c.backgroundColor ?? null,
          });
        }
        return out;
      } catch (err) {
        // One bad calendar shouldn't sink the whole view.
        console.error(`[calendar] ${c.id} failed:`, (err as Error).message);
        return [] as CalEvent[];
      }
    }),
  );

  return perCalendar.flat().sort((a, b) => a.start.localeCompare(b.start));
}
export type CalendarMeta = {
  id: string;
  summary: string;
  primary: boolean;
  backgroundColor: string | null;
  selected: boolean; // shown by default (Google "표시" toggle)
  accessRole: string; // owner | writer | reader | freeBusyReader
};

/** All calendars in the user's list (subscribed + own). */
export async function listCalendars(): Promise<CalendarMeta[]> {
  const cal = await api();
  calListCache = null; // explicit calendar-view entry: serve fresh data
  const items = await cachedCalendarList(cal);
  return items.map((c) => ({
    id: c.id!,
    summary: c.summaryOverride || c.summary || c.id!,
    primary: !!c.primary,
    backgroundColor: c.backgroundColor ?? null,
    selected: c.selected !== false,
    accessRole: c.accessRole ?? "",
  }));
}
