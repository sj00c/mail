// 캘린더 화면 전체: 월/목록 뷰, 일정 상세·수정 모달, 24시간제 시각 입력,
// SWR 캐시(calCache).
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  api,
  AuthError,
  parseAddr,
  splitAddrList,
  type CalEvent,
  type CalEventDetail,
  type Calendar,
  type Contact,
  type EventInput,
} from "../api.ts";
import {
  addDays,
  addMonths,
  atLocal,
  compactTime,
  dateKey,
  dayDiff,
  durationLabel,
  endOfWeek,
  evTimeLabel,
  formatDayHeader,
  formatEventWhen,
  hm,
  occupiedDayKeys,
  pad2,
  startOfWeek,
  weekdayLabel,
} from "../lib/format.tsx";
import { prepareEmailHtml } from "../lib/mailHtml.ts";
import {
  DialogGrip,
  DialogTools,
  MoreSentinel,
  useResizableDialog,
} from "../ui/dialog.tsx";
import { loadContactsOnce, RecipientField } from "./compose.tsx";

export function CalendarView({
  onLogout,
  hiddenCals,
  calendars,
}: {
  onLogout: () => void;
  hiddenCals: Set<string>;
  calendars: Calendar[];
}) {
  const [mode, setMode] = useState<"month" | "agenda">("month");
  const [detailEv, setDetailEv] = useState<CalEvent | null>(null);
  const [dayModal, setDayModal] = useState<{
    key: string;
    events: CalEvent[];
  } | null>(null);
  const [editor, setEditor] = useState<{
    initial: Partial<EventInput>;
    eventId?: string;
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const writable = calendars.filter(
    (c) => c.accessRole === "owner" || c.accessRole === "writer",
  );

  const openEvent = useCallback((e: CalEvent) => setDetailEv(e), []);
  const openDay = useCallback(
    (key: string, events: CalEvent[]) => setDayModal({ key, events }),
    [],
  );
  // 날짜 칸 클릭 → 그 날짜의 시간 일정(09:00–10:00)으로 새 일정 모달.
  // 종일이 기본이면 시간 입력이 아예 안 보여 "시간 설정이 안 된다"로 읽힌다 —
  // 시간 일정을 기본으로 열고, 종일은 체크박스로 전환.
  const createOnDay = useCallback(
    (dayKey: string) =>
      setEditor({
        initial: {
          allDay: false,
          start: `${dayKey}T09:00`,
          end: `${dayKey}T10:00`,
        },
      }),
    [],
  );
  const reload = useCallback(() => {
    calCache.clear();
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="calendar">
      <div className="cal-head">
        <h2>📅 캘린더</h2>
        <div className="cal-modes">
          {writable.length > 0 && (
            <button
              className="btn primary"
              onClick={() => setEditor({ initial: {} })}
            >
              ✏️ 새 일정
            </button>
          )}
          <button
            className={`btn ${mode === "month" ? "primary" : ""}`}
            onClick={() => setMode("month")}
          >
            월
          </button>
          <button
            className={`btn ${mode === "agenda" ? "primary" : ""}`}
            onClick={() => setMode("agenda")}
          >
            목록
          </button>
        </div>
      </div>
      {mode === "month" ? (
        <MonthGrid
          onLogout={onLogout}
          hiddenCals={hiddenCals}
          onEvent={openEvent}
          onDay={openDay}
          onCreate={writable.length > 0 ? createOnDay : undefined}
          refreshKey={refreshKey}
        />
      ) : (
        <AgendaList
          onLogout={onLogout}
          hiddenCals={hiddenCals}
          onEvent={openEvent}
          refreshKey={refreshKey}
        />
      )}
      {dayModal && (
        <DayEventsModal
          dayKey={dayModal.key}
          events={dayModal.events}
          onEvent={(e) => {
            setDayModal(null);
            setDetailEv(e);
          }}
          onClose={() => setDayModal(null)}
        />
      )}
      {detailEv && (
        <EventDetailModal
          ev={detailEv}
          onLogout={onLogout}
          canEdit={writable.some((c) => c.id === detailEv.calendarId)}
          onEdit={(d) => {
            setEditor({
              initial: {
                calendarId: d.calendarId,
                summary: d.summary,
                start: d.start,
                end: d.end,
                allDay: d.allDay,
                location: d.location,
                description: d.description,
                attendees: d.attendees.map((a) => a.email).filter(Boolean),
                reminder: d.reminderDefault ? "default" : (d.reminderMinutes ?? "none"),
              },
              eventId: d.id,
            });
            setDetailEv(null);
          }}
          onChanged={() => {
            setDetailEv(null);
            reload();
          }}
          onClose={() => setDetailEv(null)}
        />
      )}
      {editor && (
        <EventEditModal
          calendars={writable}
          initial={editor.initial}
          eventId={editor.eventId}
          onLogout={onLogout}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

export type CalRange = { days?: number; from?: string; to?: string };

// Module-level stale-while-revalidate cache so flipping between months
// (or mail<->calendar) is instant and avoids redundant API fan-out.
export const calCache = new Map<string, { events: CalEvent[]; ts: number }>();

export const CAL_FRESH_MS = 30_000;

export const rangeKey = (r: CalRange) => `${r.days ?? ""}|${r.from ?? ""}|${r.to ?? ""}`;

export function useCalendarEvents(
  range: CalRange,
  deps: unknown[],
  onLogout: () => void,
) {
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const key = rangeKey(range);
    let cancelled = false;
    const cached = calCache.get(key);
    setEvents(cached?.events ?? null);
    setErr(null);

    const refresh = () => {
      api
        .calendarEvents(range)
        .then((evs) => {
          if (cancelled) return;
          calCache.set(key, { events: evs, ts: Date.now() });
          setEvents(evs);
          setErr(null);
        })
        .catch((e) => {
          if (cancelled) return;
          if (e instanceof AuthError) onLogout();
          else if (!calCache.has(key)) setErr((e as Error).message);
        });
    };

    // Use cache if fresh; otherwise revalidate immediately.
    if (!cached || Date.now() - cached.ts > CAL_FRESH_MS) refresh();

    const iv = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);
    const onFocus = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { events, err };
}

export function CalReauth({ err }: { err: string }) {
  return (
    <div className="empty">
      <p>캘린더를 불러오지 못했습니다.</p>
      <p className="muted">{err}</p>
      <a className="btn primary" href="/auth/login">
        캘린더 권한 다시 허용하기
      </a>
    </div>
  );
}

export function MonthGrid({
  onLogout,
  hiddenCals,
  onEvent,
  onDay,
  onCreate,
  refreshKey,
}: {
  onLogout: () => void;
  hiddenCals: Set<string>;
  onEvent: (e: CalEvent) => void;
  onDay: (key: string, events: CalEvent[]) => void;
  onCreate?: (dayKey: string) => void; // 날짜 칸 클릭 → 그 날짜로 새 일정 (쓰기 가능 시)
  refreshKey: number;
}) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const start = startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  const end = endOfWeek(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0));
  const { events, err } = useCalendarEvents(
    {
      from: start.toISOString(),
      to: new Date(end.getTime() + 86_400_000).toISOString(),
    },
    [cursor.getTime(), refreshKey, onLogout],
    onLogout,
  );

  const startMs = start.getTime();
  const endMs = end.getTime();
  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events ?? []) {
      if (hiddenCals.has(e.calendarId)) continue;
      // Multi-day events occupy every day they span, not just the start day.
      for (const key of occupiedDayKeys(e)) {
        const bucket = map.get(key);
        if (bucket) bucket.push(e);
        else map.set(key, [e]);
      }
    }
    return map;
  }, [events, hiddenCals]);

  const cells = useMemo(() => {
    const out: Date[] = [];
    for (const d = new Date(startMs); d.getTime() <= endMs; d.setDate(d.getDate() + 1)) {
      out.push(new Date(d));
    }
    return out;
  }, [startMs, endMs]);
  const todayKey = dateKey(new Date());
  // 휠/트랙패드 스크롤로 이전·다음 달 이동. 트랙패드 관성 델타가 한 번에
  // 여러 달을 넘기지 않게 누적 임계값 + 쿨다운으로 한 틱당 한 달만 이동.
  const wheelAcc = useRef(0);
  const wheelLockUntil = useRef(0);
  const onWheel = (e: ReactWheelEvent) => {
    const now = Date.now();
    if (now < wheelLockUntil.current) {
      wheelAcc.current = 0;
      return;
    }
    wheelAcc.current += e.deltaY;
    if (Math.abs(wheelAcc.current) < 100) return;
    const dir = wheelAcc.current > 0 ? 1 : -1;
    wheelAcc.current = 0;
    wheelLockUntil.current = now + 450;
    setCursor((c) => addMonths(c, dir));
  };

  return (
    <>
      <div className="cal-monthnav">
        <button className="btn" onClick={() => setCursor(addMonths(cursor, -1))}>
          ‹
        </button>
        <strong>
          {cursor.toLocaleDateString("ko-KR", { year: "numeric", month: "long" })}
        </strong>
        <button className="btn" onClick={() => setCursor(addMonths(cursor, 1))}>
          ›
        </button>
        <button
          className="btn"
          onClick={() => {
            const d = new Date();
            setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
          }}
        >
          오늘
        </button>
      </div>
      {err ? (
        <CalReauth err={err} />
      ) : !events ? (
        <div className="empty">불러오는 중…</div>
      ) : (
        <div className="month-grid" onWheel={onWheel}>
          {["일", "월", "화", "수", "목", "금", "토"].map((w, i) => (
            <div
              key={w}
              className={`month-dow${i === 0 ? " sun" : i === 6 ? " sat" : ""}`}
            >
              {w}
            </div>
          ))}
          {cells.map((d) => {
            const key = dateKey(d);
            const evs = byDay.get(key) ?? [];
            const other = d.getMonth() !== cursor.getMonth();
            const dow = d.getDay();
            return (
              <div
                key={key}
                className={`month-cell${other ? " other" : ""}${key === todayKey ? " today" : ""}${onCreate ? " creatable" : ""}${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}`}
                // 빈 영역(또는 날짜 숫자) 클릭 → 그 날짜로 새 일정. 이벤트 칩/
                // 더보기 버튼은 stopPropagation으로 이 핸들러를 막는다.
                onClick={onCreate ? () => onCreate(key) : undefined}
                title={onCreate ? "클릭하여 이 날짜에 일정 추가" : undefined}
              >
                <div className="month-cellhead">
                  <div className="month-daynum">{d.getDate()}</div>
                  {evs.length > 0 && (
                    // 칸이 좁아 칩을 다 못 보여줘도 "몇 건인지"는 항상 보이게.
                    <span className="month-count" title={`${evs.length}개 일정`}>
                      {evs.length}
                    </span>
                  )}
                </div>
                {evs.slice(0, 3).map((e) => (
                  <button
                    // Same event can sit on two visible calendars — id alone duplicates keys.
                    key={`${e.calendarId}|${e.id}|${e.start}`}
                    type="button"
                    className="month-ev"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onEvent(e);
                    }}
                    title={`${evTimeLabel(e, key)} ${e.summary}`}
                    // 캘린더 색의 파스텔 칩 — 점 하나보다 캘린더 정체성이 잘 읽힌다
                    style={{
                      background: `color-mix(in srgb, ${e.color ?? "#1a73e8"} 14%, white)`,
                    }}
                  >
                    <span
                      className="month-ev-dot"
                      style={{ background: e.color ?? "#1a73e8" }}
                    />
                    {!e.allDay && (
                      <span className="month-ev-time">{compactTime(evTimeLabel(e, key))}</span>
                    )}
                    <span className="month-ev-t">{e.summary}</span>
                  </button>
                ))}
                {evs.length > 3 && (
                  <button
                    type="button"
                    className="month-more"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onDay(key, evs);
                    }}
                  >
                    +{evs.length - 3}개 더보기
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export function AgendaList({
  onLogout,
  hiddenCals,
  onEvent,
  refreshKey,
}: {
  onLogout: () => void;
  hiddenCals: Set<string>;
  onEvent: (e: CalEvent) => void;
  refreshKey: number;
}) {
  const [days, setDays] = useState(30);
  const { events, err } = useCalendarEvents(
    { days },
    [days, refreshKey, onLogout],
    onLogout,
  );

  const groups = useMemo(() => {
    // Visible window: today .. today+days. Ongoing multi-day events span
    // days before now (and the server may return events past the boundary) —
    // those day groups don't belong in an N일 agenda.
    const todayKey = dateKey(new Date());
    const endKey = addDays(todayKey, days);
    const index = new Map<string, CalEvent[]>();
    for (const e of events ?? []) {
      if (hiddenCals.has(e.calendarId)) continue;
      // Multi-day events occupy every day they span, not just the start day.
      for (const key of occupiedDayKeys(e)) {
        if (key < todayKey || key >= endKey) continue;
        let bucket = index.get(key);
        if (!bucket) {
          bucket = [];
          index.set(key, bucket);
        }
        bucket.push(e);
      }
    }
    return [...index.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [events, hiddenCals, days]);

  return (
    <>
      <div className="cal-range">
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            className={`btn ${days === d ? "primary" : ""}`}
            onClick={() => setDays(d)}
          >
            {d}일
          </button>
        ))}
      </div>
      <div className="agenda-scroll">
      {err ? (
        <CalReauth err={err} />
      ) : !events ? (
        <div className="empty">불러오는 중…</div>
      ) : groups.length === 0 ? (
        // groups, not events: with every visible calendar hidden the list
        // must say "없습니다", not render blank.
        <div className="empty">예정된 일정이 없습니다.</div>
      ) : (
        groups.map(([key, evs]) => (
          <div key={key} className="cal-day">
            <div className="cal-date">{formatDayHeader(key)}</div>
            {evs.map((e) => (
              <button
                key={`${e.calendarId}|${e.id}|${e.start}`}
                type="button"
                className="cal-event"
                onClick={() => onEvent(e)}
              >
                <span
                  className="cal-dot"
                  style={{ background: e.color ?? "#1a73e8" }}
                />
                <span className="cal-time">{evTimeLabel(e, key)}</span>
                <span className="cal-title">{e.summary}</span>
                {e.location && <span className="cal-loc">📍 {e.location}</span>}
                <span className="cal-cal">{e.calendarSummary}</span>
              </button>
            ))}
          </div>
        ))
      )}
      {events && !err && days < 365 && (
        // 바닥에 닿으면 조회 범위를 자동 확장 (7→30→90→365일).
        <MoreSentinel
          onMore={() => setDays((d) => (d < 30 ? 30 : d < 90 ? 90 : 365))}
        />
      )}
      </div>
    </>
  );
}

export function DayEventsModal({
  dayKey,
  events,
  onEvent,
  onClose,
}: {
  dayKey: string;
  events: CalEvent[];
  onEvent: (e: CalEvent) => void;
  onClose: () => void;
}) {
  const dlg = useResizableDialog("day-events", 380, 300);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="dialog"
        ref={dlg.ref}
        style={dlg.style}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <strong>{formatDayHeader(dayKey)}</strong>
          <DialogTools maximized={dlg.maximized} onToggleMax={dlg.toggleMax} />
          <button className="clear" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="day-list">
          {events.map((e) => (
            <button
              key={`${e.calendarId}|${e.id}|${e.start}`}
              type="button"
              className="cal-event"
              onClick={() => onEvent(e)}
            >
              <span
                className="cal-dot"
                style={{ background: e.color ?? "#1a73e8" }}
              />
              <span className="cal-time">{evTimeLabel(e, dayKey)}</span>
              <span className="cal-title">{e.summary}</span>
              {e.location && <span className="cal-loc">📍 {e.location}</span>}
              <span className="cal-cal">{e.calendarSummary}</span>
            </button>
          ))}
        </div>
        <DialogGrip onPointerDown={dlg.onGripDown} onReset={dlg.reset} />
      </div>
    </div>
  );
}

export function EventDetailModal({
  ev,
  onLogout,
  canEdit,
  onEdit,
  onChanged,
  onClose,
}: {
  ev: CalEvent;
  onLogout: () => void;
  canEdit: boolean;
  onEdit: (d: CalEventDetail) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<CalEventDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setErr(null);
    api
      .calendarEvent(ev.calendarId, ev.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) onLogout();
        else setErr(`상세를 불러오지 못했습니다: ${(e as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [ev.calendarId, ev.id, onLogout]);

  const d = detail;
  const dlg = useResizableDialog("event-detail", 400, 320);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="dialog"
        ref={dlg.ref}
        style={dlg.style}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <strong>일정</strong>
          <DialogTools maximized={dlg.maximized} onToggleMax={dlg.toggleMax} />
          <button className="clear" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="ev-detail">
          <h3 className="ev-title">
            <span
              className="ev-dot"
              style={{ background: ev.color ?? "#1a73e8" }}
            />
            {ev.summary}
          </h3>
          <div className="ev-row">🕒 {formatEventWhen(ev)}</div>
          {ev.calendarSummary && (
            <div className="ev-row muted">🗂 {ev.calendarSummary}</div>
          )}
          {(d?.location || ev.location) && (
            <div className="ev-row">📍 {d?.location || ev.location}</div>
          )}
          {d?.hangoutLink && (
            <div className="ev-row">
              🎥{" "}
              <a href={d.hangoutLink} target="_blank" rel="noreferrer">
                화상회의 참여
              </a>
            </div>
          )}
          {d?.organizer && <div className="ev-row muted">주최: {d.organizer}</div>}
          {d && d.attendees.length > 0 && (
            <div className="ev-row">
              👥 참석자 {d.attendees.length}명
              <div className="ev-attendees">
                {d.attendees.map((a) => (
                  <span key={a.email} className="ev-att">
                    {a.name || a.email}
                  </span>
                ))}
              </div>
            </div>
          )}
          {!d && !err && <div className="ev-row muted">불러오는 중…</div>}
          {err && <div className="ev-row muted">⚠️ {err}</div>}
          {d?.description && (
            <iframe
              title="event-description"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              className="ev-desc"
              srcDoc={
                prepareEmailHtml(
                  d.description,
                  "font-family:-apple-system,sans-serif;font-size:13px;color:#202124;margin:0;white-space:pre-wrap;word-break:break-word",
                ).html
              }
            />
          )}
        </div>
        <div className="modal-foot">
          {canEdit && d && (
            <>
              <button className="btn" onClick={() => onEdit(d)}>
                ✏️ 수정
              </button>
              <button
                className="btn danger"
                disabled={deleting}
                onClick={async () => {
                  if (!confirm("이 일정을 삭제할까요?")) return;
                  setDeleting(true);
                  try {
                    await api.deleteEvent(ev.calendarId, ev.id);
                    onChanged();
                  } catch (e) {
                    // A delete failure is not a "detail load" failure — and a
                    // dead session goes back to login, not an opaque message.
                    if (e instanceof AuthError) {
                      onLogout();
                      return;
                    }
                    setErr(`삭제 실패: ${(e as Error).message}`);
                    setDeleting(false);
                  }
                }}
              >
                🗑 삭제
              </button>
            </>
          )}
          <span className="modal-spacer" />
          <a className="btn" href={ev.htmlLink} target="_blank" rel="noreferrer">
            Google 캘린더에서 열기
          </a>
        </div>
        <DialogGrip onPointerDown={dlg.onGripDown} onReset={dlg.reset} />
      </div>
    </div>
  );
}

export const DUR_PRESETS = [30, 60, 90, 120];

export const SPAN_PRESETS = [1, 2, 3, 7];

export const REMINDER_OPTS: [string, string][] = [
  ["default", "캘린더 기본"],
  ["none", "없음"],
  ["0", "시작 시"],
  ["10", "10분 전"],
  ["30", "30분 전"],
  ["60", "1시간 전"],
  ["1440", "1일 전"],
];

export const DEFAULT_DUR_MS = 3_600_000;

// 30분 격자 — 시각 입력의 드롭다운 후보.
export const TIME_OPTIONS = Array.from(
  { length: 48 },
  (_, i) => `${pad2(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`,
);

export const TIME_LIST_ID = "ev-time-options";

// "9"→09:00, "930"·"9:3"→09:30, "1530"·"15시30분"→15:30. 못 읽으면 null.
export function parseTime(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, "");
  if (!s) return null;
  let h: number;
  let m: number;
  const sep = /^(\d{1,2})[:시.](\d{1,2})?분?$/.exec(s);
  const digits = /^(\d{1,4})$/.exec(s);
  if (sep) {
    h = Number(sep[1]);
    // "9:3"은 9시 3분보다 9시 30분을 노린 입력이다 (한 자리 = 십의 자리).
    m = sep[2] ? Number(sep[2].length === 1 ? `${sep[2]}0` : sep[2]) : 0;
  } else if (digits) {
    const d = digits[1];
    h = d.length <= 2 ? Number(d) : Number(d.slice(0, -2));
    m = d.length <= 2 ? 0 : Number(d.slice(-2));
  } else {
    return null;
  }
  if (h > 23 || m > 59) return null;
  return `${pad2(h)}:${pad2(m)}`;
}

// 네이티브 <input type="time">은 Chrome이 브라우저 로캘로만 그린다 — lang 속성으로도
// 못 바꿔서 ko에서는 "오후 03:00"이 강제된다. 24시간제를 쓰려고 직접 만든 입력.
export function TimeField({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  // 프리셋·시작 이동으로 바깥 값이 바뀌면 따라간다 (타이핑 중에는 방해하지 않는다).
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = (raw: string) => {
    const next = parseTime(raw);
    // 못 읽는 입력은 마지막 정상값으로 되돌린다 — 빈 칸으로 저장이 막히지 않게.
    setDraft(next ?? value);
    if (next && next !== value) onChange(next);
  };
  const step = (delta: number) => {
    const base = parseTime(draft) ?? value;
    const [h, m] = base.split(":").map(Number);
    const t = (((h * 60 + m + delta) % 1440) + 1440) % 1440;
    const next = `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
    setDraft(next);
    onChange(next);
  };

  return (
    <input
      className="ev-input ev-time"
      type="text"
      inputMode="numeric"
      list={TIME_LIST_ID}
      aria-label={label}
      placeholder="HH:MM"
      title="24시간제 · ↑↓ 5분 · Shift+↑↓ 1시간"
      value={draft}
      onFocus={(e) => {
        setEditing(true);
        e.target.select();
      }}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        // 드롭다운 선택·완전한 타이핑은 blur를 기다리지 않고 바로 반영한다.
        if (/^\d{2}:\d{2}$/.test(v)) commit(v);
      }}
      onBlur={(e) => {
        setEditing(false);
        commit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          step((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 60 : 5));
        } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
          // ⌘↵(저장)은 그대로 위로 흘리고, 맨 Enter는 값 확정만.
          e.preventDefault();
          commit(e.currentTarget.value);
        }
      }}
    />
  );
}

export function EventEditModal({
  calendars,
  initial,
  eventId,
  onLogout,
  onClose,
  onSaved,
}: {
  calendars: Calendar[];
  initial: Partial<EventInput>;
  eventId?: string;
  onLogout: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  // 날짜와 시각을 따로 잡는다 — datetime-local 한 덩어리는 클릭/타이핑이 길고,
  // 종일로 토글할 때마다 시각을 잃어버린다.
  const init = useMemo(() => {
    if (initial.start) {
      if (initial.allDay) {
        const sd = initial.start.slice(0, 10);
        // Google 종일 종료는 exclusive — 화면에는 마지막 날(inclusive)을 쓴다.
        const ed = initial.end ? addDays(initial.end.slice(0, 10), -1) : sd;
        return {
          allDay: true,
          sDate: sd,
          sTime: "09:00",
          eDate: ed < sd ? sd : ed,
          eTime: "10:00",
        };
      }
      const s = new Date(initial.start);
      const e = new Date(initial.end || initial.start);
      return {
        allDay: false,
        sDate: dateKey(s),
        sTime: hm(s),
        eDate: dateKey(e),
        eTime: hm(e),
      };
    }
    const s = new Date();
    s.setMinutes(0, 0, 0);
    s.setHours(s.getHours() + 1);
    const e = new Date(s.getTime() + DEFAULT_DUR_MS);
    return { allDay: false, sDate: dateKey(s), sTime: hm(s), eDate: dateKey(e), eTime: hm(e) };
    // 모달이 열린 순간으로 고정 — 리렌더마다 "지금"이 흘러가면 안 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const initReminder =
    initial.reminder === undefined || initial.reminder === "default"
      ? "default"
      : initial.reminder === "none"
        ? "none"
        : String(initial.reminder);

  // Read-only(reader/freeBusyReader) calendars 403 on insert — never offer them.
  const writable = calendars.filter(
    (c) => c.accessRole === "owner" || c.accessRole === "writer",
  );
  const [calendarId, setCalendarId] = useState(
    initial.calendarId ||
      writable.find((c) => c.primary)?.id ||
      writable[0]?.id ||
      "",
  );
  const [summary, setSummary] = useState(initial.summary ?? "");
  const [allDay, setAllDay] = useState(init.allDay);
  const [sDate, setSDate] = useState(init.sDate);
  const [sTime, setSTime] = useState(init.sTime);
  const [eDate, setEDate] = useState(init.eDate);
  const [eTime, setETime] = useState(init.eTime);
  const [location, setLocation] = useState(initial.location ?? "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [attendees, setAttendees] = useState((initial.attendees ?? []).join(", "));
  const [reminder, setReminder] = useState<string>(initReminder);
  const [meet, setMeet] = useState(false);
  // 제목·시간만 있으면 끝나는 게 대부분 — 나머지는 접어 두고 필요할 때 편다.
  // 이미 값이 들어온 경우(메일에서 만들기·수정)는 감추면 안 된다.
  const [details, setDetails] = useState(
    !!(
      eventId ||
      initial.location ||
      initial.description ||
      initial.attendees?.length ||
      initReminder !== "default"
    ),
  );
  // 참석자 자동완성 — 작성창과 같은 연락처 캐시를 공유한다.
  const [contacts, setContacts] = useState<Contact[]>([]);
  useEffect(() => {
    let live = true;
    void loadContactsOnce().then((cs) => {
      if (live && cs.length) setContacts(cs);
    });
    return () => {
      live = false;
    };
  }, []);

  const startAt = atLocal(sDate, sTime);
  const endAt = atLocal(eDate, eTime);
  const durMin =
    isNaN(+startAt) || isNaN(+endAt)
      ? 0
      : Math.round((endAt.getTime() - startAt.getTime()) / 60_000);
  const spanDays = sDate && eDate ? dayDiff(sDate, eDate) + 1 : 0;

  // 시작을 옮기면 길이를 유지한 채 종료도 따라간다 — 매번 종료를 다시 찍던
  // 왕복이 사라지고, "종료가 시작보다 빠름" 에러도 안 난다.
  const moveStart = (nextDate: string, nextTime: string) => {
    setSDate(nextDate);
    setSTime(nextTime);
    if (!nextDate) return;
    if (allDay) {
      setEDate(addDays(nextDate, Math.max(0, spanDays - 1)));
      return;
    }
    const ns = atLocal(nextDate, nextTime);
    if (!nextTime || isNaN(+ns)) return;
    const ne = new Date(ns.getTime() + (durMin > 0 ? durMin * 60_000 : DEFAULT_DUR_MS));
    setEDate(dateKey(ne));
    setETime(hm(ne));
  };
  const setDuration = (mins: number) => {
    if (isNaN(+startAt)) return;
    const ne = new Date(startAt.getTime() + mins * 60_000);
    setEDate(dateKey(ne));
    setETime(hm(ne));
  };
  // 종료를 시작보다 이른 시각으로 잡으면 "자정 넘김"이 의도다 — 에러를 띄우는
  // 대신 종료일을 하루 민다. 이미 여러 날짜에 걸친 일정은 건드리지 않는다.
  const setEndTime = (v: string) => {
    setETime(v);
    if (eDate === sDate && !(atLocal(sDate, v) > startAt)) setEDate(addDays(sDate, 1));
  };
  const setSpan = (days: number) => setEDate(addDays(sDate, days - 1));
  const setAllDayMode = (v: boolean) => {
    if (v === allDay) return;
    if (v) {
      // 자정에 끝나는 일정은 그 다음 날을 점유하지 않는다 — 하루 덜 잡는다.
      if (eTime === "00:00" && eDate > sDate) setEDate(addDays(eDate, -1));
    } else if (!(atLocal(eDate, eTime) > startAt)) {
      // 종일 동안 시각이 뒤집혔으면 시작+1시간으로 복구한다.
      const ne = new Date(startAt.getTime() + DEFAULT_DUR_MS);
      setEDate(dateKey(ne));
      setETime(hm(ne));
    }
    setAllDay(v);
  };

  // 저장 버튼을 누른 뒤가 아니라 입력하는 동안 바로 알려준다.
  const rangeErr = (() => {
    if (!sDate || !eDate || (!allDay && (!sTime || !eTime))) return "시작/종료를 입력하세요.";
    if (allDay) return eDate < sDate ? "종료일이 시작일보다 빠릅니다." : null;
    if (isNaN(+startAt) || isNaN(+endAt)) return "일시 형식이 올바르지 않습니다.";
    return endAt <= startAt ? "종료가 시작보다 빠릅니다." : null;
  })();
  // Existing events may legitimately be untitled (raw summary "")
  // — requiring a title here would make them uneditable.
  const canSave = !busy && !rangeErr && (!!eventId || !!summary.trim());

  const dirty =
    summary !== (initial.summary ?? "") ||
    location !== (initial.location ?? "") ||
    description !== (initial.description ?? "") ||
    attendees !== (initial.attendees ?? []).join(", ") ||
    reminder !== initReminder ||
    meet ||
    allDay !== init.allDay ||
    sDate !== init.sDate ||
    eDate !== init.eDate ||
    (!allDay && (sTime !== init.sTime || eTime !== init.eTime));
  // 바깥 클릭 한 번에 작성 중이던 일정이 날아가지 않게.
  const tryClose = () => {
    if (!dirty || confirm("작성 중인 내용을 버릴까요?")) onClose();
  };

  const save = async () => {
    if (!calendarId) return setErr("쓸 수 있는 캘린더가 없습니다.");
    if (rangeErr) return setErr(rangeErr);
    setBusy(true);
    setErr(null);
    try {
      const attToks = splitAddrList(attendees);
      const badTok = attToks.find((t) => !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(parseAddr(t).email));
      if (badTok) {
        setBusy(false);
        setDetails(true);
        return setErr(`참석자 주소가 올바르지 않습니다: ${badTok}`);
      }
      const body: EventInput = {
        calendarId,
        summary,
        allDay,
        location,
        description,
        start: allDay ? sDate : startAt.toISOString(),
        // 종일 종료는 exclusive — 화면의 마지막 날 +1일을 보낸다.
        end: allDay ? addDays(eDate, 1) : endAt.toISOString(),
        attendees: attToks.map((t) => parseAddr(t).email),
        reminder:
          reminder === "default" ? "default" : reminder === "none" ? "none" : Number(reminder),
        createMeet: meet || undefined,
      };
      if (eventId) await api.updateEvent(eventId, body);
      else await api.createEvent(body);
      onSaved();
    } catch (e) {
      // Dead session → login screen, not a raw NOT_AUTHENTICATED string.
      if (e instanceof AuthError) {
        onLogout();
        return;
      }
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const today = dateKey(new Date());
  const dayShortcuts: [string, string][] = [
    ["오늘", today],
    ["내일", addDays(today, 1)],
    ["다음 주", addDays(today, 7)],
  ];
  const calColor = writable.find((c) => c.id === calendarId)?.backgroundColor;
  const dlg = useResizableDialog("event-edit", 460, 380);

  return (
    <div className="modal-backdrop" onClick={tryClose}>
      <div
        className="dialog ev-dialog"
        ref={dlg.ref}
        style={dlg.style}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // 참석자 자동완성이 Escape를 이미 먹었으면(preventDefault) 모달은 열어 둔다.
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.stopPropagation();
            tryClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) {
            e.preventDefault();
            void save();
          }
        }}
      >
        <div className="modal-head">
          <strong>{eventId ? "일정 수정" : "새 일정"}</strong>
          <DialogTools maximized={dlg.maximized} onToggleMax={dlg.toggleMax} />
          <button className="clear" onClick={tryClose}>
            ✕
          </button>
        </div>
        <div className="ev-form">
          <input
            className="ev-title-input"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            placeholder="제목 추가"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
          <div className="ev-section">
            <div className="ev-when-head">
              <div className="ev-seg">
                <button
                  type="button"
                  className={allDay ? "" : "on"}
                  onClick={() => setAllDayMode(false)}
                >
                  시간 지정
                </button>
                <button
                  type="button"
                  className={allDay ? "on" : ""}
                  onClick={() => setAllDayMode(true)}
                >
                  종일
                </button>
              </div>
              <div className="ev-chips">
                {dayShortcuts.map(([label, day]) => (
                  <button
                    key={label}
                    type="button"
                    className={`ev-chip${sDate === day ? " on" : ""}`}
                    onClick={() => moveStart(day, sTime)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="ev-when-row">
              <span className="ev-when-lbl">시작</span>
              <input
                className="ev-input ev-date"
                type="date"
                value={sDate}
                onChange={(e) => moveStart(e.target.value, sTime)}
              />
              {!allDay && (
                <TimeField
                  label="시작 시각"
                  value={sTime}
                  onChange={(v) => moveStart(sDate, v)}
                />
              )}
              <span className="ev-when-note">{weekdayLabel(sDate)}</span>
            </div>
            <div className="ev-when-row">
              <span className="ev-when-lbl">종료</span>
              <input
                className="ev-input ev-date"
                type="date"
                min={sDate}
                value={eDate}
                onChange={(e) => setEDate(e.target.value)}
              />
              {!allDay && (
                <TimeField label="종료 시각" value={eTime} onChange={setEndTime} />
              )}
              <span className="ev-when-note">
                {rangeErr ? "" : allDay ? `${spanDays}일` : durationLabel(durMin)}
              </span>
            </div>
            <div className="ev-chips">
              {allDay
                ? SPAN_PRESETS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`ev-chip${spanDays === n ? " on" : ""}`}
                      onClick={() => setSpan(n)}
                    >
                      {n === 7 ? "1주" : `${n}일`}
                    </button>
                  ))
                : DUR_PRESETS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`ev-chip${durMin === m ? " on" : ""}`}
                      onClick={() => setDuration(m)}
                    >
                      {durationLabel(m)}
                    </button>
                  ))}
            </div>
            {/* 시작/종료 시각 입력이 함께 쓰는 30분 격자 드롭다운 */}
            <datalist id={TIME_LIST_ID}>
              {TIME_OPTIONS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            {rangeErr && <div className="ev-err">⚠️ {rangeErr}</div>}
          </div>
          {writable.length > 1 && (
            <div className="ev-cal-row">
              <span
                className="ev-dot"
                style={{ background: calColor ?? "var(--muted)" }}
                aria-hidden
              />
              <select
                className="ev-input"
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
                // Moving an event between calendars needs events.move — patch
                // against a different calendarId just 404s. Lock it when editing.
                disabled={!!eventId}
                title={eventId ? "일정의 캘린더는 변경할 수 없습니다" : undefined}
              >
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.summary}
                  </option>
                ))}
              </select>
            </div>
          )}
          {details ? (
            <>
              <input
                className="ev-input"
                placeholder="📍 장소 (선택)"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
              <RecipientField
                label="참석자"
                value={attendees}
                onChange={setAttendees}
                suggestions={contacts}
              />
              <div className="ev-opt-row">
                <select
                  className="ev-input"
                  title="알림 (팝업)"
                  value={reminder}
                  onChange={(e) => setReminder(e.target.value)}
                >
                  {REMINDER_OPTS.map(([v, label]) => (
                    <option key={v} value={v}>
                      🔔 {label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`ev-chip${meet ? " on" : ""}`}
                  aria-pressed={meet}
                  title="저장 시 Google Meet 화상회의 링크가 생성됩니다"
                  onClick={() => setMeet(!meet)}
                >
                  📹 Meet {meet ? "추가됨" : "추가"}
                </button>
              </div>
              <textarea
                className="ev-input"
                placeholder="설명 (선택)"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </>
          ) : (
            <button type="button" className="ev-more" onClick={() => setDetails(true)}>
              ＋ 장소 · 참석자 · 알림 · 설명
            </button>
          )}
          {err && <div className="ev-err">⚠️ {err}</div>}
        </div>
        <div className="modal-foot">
          <span className="ev-kbd-hint">⌘↵ 저장 · Esc 닫기</span>
          <span className="modal-spacer" />
          <button className="btn" onClick={tryClose}>
            취소
          </button>
          <button className="btn primary" disabled={!canSave} onClick={save}>
            {busy ? "저장 중…" : "저장"}
          </button>
        </div>
        <DialogGrip onPointerDown={dlg.onGripDown} onReset={dlg.reset} />
      </div>
    </div>
  );
}
