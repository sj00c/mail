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
  reminderDefault: boolean; // true → 캘린더 기본 알림 사용
  reminderMinutes: number | null; // useDefault=false일 때 첫 popup 알림 (없으면 null)
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
    // Raw, no placeholder: this feeds the edit form — substituting
    // "(제목 없음)" here gets the literal placeholder saved as the title.
    summary: e.summary?.trim() ?? "",
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
    reminderDefault: e.reminders?.useDefault !== false,
    reminderMinutes:
      e.reminders?.useDefault === false
        ? (e.reminders.overrides?.find((o) => o.method === "popup")?.minutes ??
          e.reminders.overrides?.[0]?.minutes ??
          null)
        : null,
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
  attendees?: string[]; // 참석자 이메일 — 지정 시 초대 메일 발송(sendUpdates)
  reminder?: "default" | "none" | number; // popup 알림 (분 전); 생략 = 변경 없음
  createMeet?: boolean; // true → Google Meet 회의 링크 생성
};

function toEventBody(i: EventInput): calendar_v3.Schema$Event {
  const body: calendar_v3.Schema$Event = {
    summary: i.summary,
    // null, not undefined: events.patch ignores absent fields, so clearing
    // 장소/설명 in the edit form must send an explicit null to erase them.
    location: i.location || null,
    description: i.description || null,
    // Same for date/dateTime: converting 종일 ↔ 시간 일정 must null the other
    // representation or patch 400s with "cannot have both date and dateTime".
    start: i.allDay
      ? { date: i.start.slice(0, 10), dateTime: null }
      : { dateTime: new Date(i.start).toISOString(), date: null },
    end: i.allDay
      ? { date: i.end.slice(0, 10), dateTime: null }
      : { dateTime: new Date(i.end).toISOString(), date: null },
  };
  // undefined → attendees 필드 자체를 안 보냄(patch: 기존 유지). 배열이면 그대로
  // 교체 — 편집 폼은 항상 전체 목록을 보내므로 삭제도 이 경로로 반영된다.
  if (i.attendees !== undefined) {
    body.attendees = i.attendees.map((email) => ({ email }));
  }
  if (i.reminder !== undefined) {
    body.reminders =
      i.reminder === "default"
        ? { useDefault: true, overrides: [] }
        : {
            useDefault: false,
            overrides:
              i.reminder === "none"
                ? []
                : [{ method: "popup", minutes: i.reminder }],
          };
  }
  return body;
}

export async function createEvent(i: EventInput): Promise<{ id: string }> {
  const cal = await api();
  const res = await cal.events.insert({
    calendarId: i.calendarId,
    // conferenceDataVersion=1 없이는 conferenceData가 조용히 무시된다.
    conferenceDataVersion: i.createMeet ? 1 : undefined,
    // 참석자가 있으면 Google이 초대 메일을 보내게 한다 (Gmail 웹과 동일).
    sendUpdates: i.attendees?.length ? "all" : undefined,
    requestBody: {
      ...toEventBody(i),
      conferenceData: i.createMeet
        ? {
            createRequest: {
              requestId: crypto.randomUUID(),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          }
        : undefined,
    },
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
    conferenceDataVersion: i.createMeet ? 1 : undefined,
    sendUpdates: i.attendees?.length ? "all" : undefined,
    requestBody: {
      ...toEventBody(i),
      // 수정 시엔 명시 요청(createMeet)일 때만 회의를 새로 만든다 —
      // 기존 회의 링크는 건드리지 않는다.
      conferenceData: i.createMeet
        ? {
            createRequest: {
              requestId: crypto.randomUUID(),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          }
        : undefined,
    },
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
  opts: { days?: number; timeMin?: string; timeMax?: string; q?: string } = {},
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
    // "N일" = today..today+N-1, each day in full. Midnight-anchored timeMax —
    // "+N*24h from now" cut the final day off mid-afternoon, and the agenda's
    // client-side window filter uses the same today+N exclusive bound.
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + days);
    timeMax = end.toISOString();
  }

  const calendars = await cachedCalendarList(cal);

  const perCalendar = await Promise.all(
    calendars.map(async (c) => {
      try {
        const out: CalEvent[] = [];
        let pageToken: string | undefined;
        // Busy calendars exceed 250 expanded instances per month — follow
        // nextPageToken (bounded) instead of silently truncating the view.
        for (let page = 0; page < 4; page++) {
          const res = await cal.events.list({
            calendarId: c.id!,
            timeMin,
            timeMax,
            q: opts.q,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 250,
            pageToken,
            fields:
              "items(id,summary,location,htmlLink,status,start,end),nextPageToken",
          });
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
          pageToken = res.data.nextPageToken ?? undefined;
          if (!pageToken) break;
        }
        return out;
      } catch (err) {
        // One bad calendar shouldn't sink the whole view.
        console.error(`[calendar] ${c.id} failed:`, (err as Error).message);
        return [] as CalEvent[];
      }
    }),
  );

  // Numeric sort: raw ISO strings from different calendars carry different
  // UTC offsets, and lexicographic comparison orders those wrongly.
  const startMs = (e: CalEvent): number =>
    e.allDay ? new Date(`${e.start}T00:00:00`).getTime() : new Date(e.start).getTime();
  return perCalendar
    .flat()
    .sort((a, b) => startMs(a) - startMs(b) || a.start.localeCompare(b.start));
}
/** Text search across all calendars (통합 검색의 일정 컬럼).
 *  Window: 6 months back .. 12 months ahead — search is about finding a
 *  specific event, recent past included. */
export async function searchEvents(q: string): Promise<CalEvent[]> {
  const now = Date.now();
  return listEvents({
    q,
    timeMin: new Date(now - 180 * 86_400_000).toISOString(),
    timeMax: new Date(now + 365 * 86_400_000).toISOString(),
  });
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
