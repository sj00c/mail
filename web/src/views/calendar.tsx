// 캘린더 화면 전체: 월/목록 뷰, 일정 상세·수정 모달, 24시간제 시각 입력,
// SWR 캐시(calCache).
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
  getCalendarDisplayColor,
  readPrimaryColorOverride,
} from "../lib/calendarPresentation.ts";
import { loadContactsOnce } from "../lib/contacts.ts";
import {
  DialogGrip,
  DialogTools,
  MoreSentinel,
  useResizableDialog,
} from "../ui/dialog.tsx";
import {
  AlertIcon,
  CalendarIcon,
  ClockIcon,
  EditIcon,
  LocationIcon,
  TrashIcon,
} from "../ui/icons.tsx";
import { RecipientField } from "../ui/recipientField.tsx";
function uniquePrimaryId(calendars: readonly Calendar[]) {
  const primaries = calendars.filter((calendar) => calendar.primary);
  return primaries.length === 1 ? primaries[0].id : null;
}
function handleDialogKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  onClose: () => void,
) {
  if (event.key === "Escape" && !event.defaultPrevented) {
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.offsetParent !== null);
  if (controls.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = document.activeElement;
  const activeIsControl = active instanceof HTMLElement && controls.includes(active);
  if (event.shiftKey && (active === first || !activeIsControl)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !activeIsControl)) {
    event.preventDefault();
    first.focus();
  }
}

export function getEventDisplayColor(
  event: CalEvent,
  calendars: readonly Calendar[],
  primaryColorOverride?: string | null,
) {
  const calendar = calendars.find((candidate) => candidate.id === event.calendarId);
  if (!calendar) return event.color ?? "#1a73e8";
  const isPrimary = calendar.id === uniquePrimaryId(calendars);
  const override = isPrimary
    ? primaryColorOverride === undefined
      ? readPrimaryColorOverride(calendar.id)
      : primaryColorOverride
    : undefined;
  return getCalendarDisplayColor({ ...calendar, primary: isPrimary }, override);
}


export function CalendarView({
  onLogout,
  hiddenCals,
  calendars,
  primaryColorOverride,
}: {
  onLogout: () => void;
  hiddenCals: Set<string>;
  calendars: Calendar[];
  primaryColorOverride?: string | null;
}) {
  const [mode, setMode] = useState<"month" | "agenda">("month");
  const [detailEv, setDetailEv] = useState<CalEvent | null>(null);
  const [dayModal, setDayModal] = useState<{ key: string; events: CalEvent[] } | null>(null);
  const [editor, setEditor] = useState<{
    initial: Partial<EventInput>;
    eventId?: string;
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dateAnchor, setDateAnchor] = useState(() => dateKey(new Date()));

  const writable = calendars.filter(
    (c) => c.accessRole === "owner" || c.accessRole === "writer",
  );

  const openEvent = useCallback((e: CalEvent) => setDetailEv(e), []);
  const openDay = useCallback((key: string, events: CalEvent[]) => {
    setDateAnchor(key);
    setDayModal({ key, events });
  }, []);
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
    <div className={`calendar${mode === "month" ? " month-continuous-mode" : ""}`}>
      <header className="cal-head">
        <div className="cal-titleblock">
          <span className="cal-kicker">일정 관리</span>
          <h2>캘린더</h2>
          <p>한 달의 흐름과 예정된 일정을 한눈에 확인하세요.</p>
        </div>
        <div className="cal-actions">
          <div className="cal-modes" aria-label="캘린더 보기">
            <button
              className={mode === "month" ? "active" : ""}
              aria-pressed={mode === "month"}
              onClick={() => setMode("month")}
            >
              월
            </button>
            <button
              className={mode === "agenda" ? "active" : ""}
              aria-pressed={mode === "agenda"}
              onClick={() => setMode("agenda")}
            >
              목록
            </button>
          </div>
          {writable.length > 0 && (
            <button
              className="btn primary cal-create"
              onClick={() => setEditor({ initial: {} })}
            >
              <span aria-hidden="true">＋</span>
              새 일정
            </button>
          )}
        </div>
      </header>
      {mode === "month" ? (
        <MonthGrid
          onLogout={onLogout}
          hiddenCals={hiddenCals}
          onEvent={openEvent}
          onDay={openDay}
          onCreate={writable.length > 0 ? createOnDay : undefined}
          calendars={calendars}
          primaryColorOverride={primaryColorOverride}
          refreshKey={refreshKey}
          dateAnchor={dateAnchor}
          onDateAnchorChange={setDateAnchor}
          interactionLocked={Boolean(dayModal || detailEv || editor)}
        />
      ) : (
        <AgendaList
          onLogout={onLogout}
          hiddenCals={hiddenCals}
          onEvent={openEvent}
          refreshKey={refreshKey}
          calendars={calendars}
          primaryColorOverride={primaryColorOverride}
          dateAnchor={dateAnchor}
          onDateAnchorChange={setDateAnchor}
        />
      )}
      {dayModal && (
        <DayEventsModal
          dayKey={dayModal.key}
          events={dayModal.events}
          calendars={calendars}
          primaryColorOverride={primaryColorOverride}
          onEvent={(event) => {
            setDayModal(null);
            setDetailEv(event);
          }}
          onClose={() => setDayModal(null)}
        />
      )}
      {detailEv && (
        <EventDetailModal
          ev={detailEv}
          calendars={calendars}
          primaryColorOverride={primaryColorOverride}
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
          calendars={calendars}
          primaryColorOverride={primaryColorOverride}
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
export const CAL_CACHE_MAX_ENTRIES = 8;
const VIRTUAL_WEEK_COUNT = 13;
const RECYCLE_WEEK_COUNT = 3;
const EDGE_THRESHOLD_WEEKS = 2;
const PREFETCH_WEEK_COUNT = 3;

export const rangeKey = (r: CalRange) => `${r.days ?? ""}|${r.from ?? ""}|${r.to ?? ""}`;

function readCalCache(key: string) {
  const entry = calCache.get(key);
  if (!entry) return undefined;
  calCache.delete(key);
  calCache.set(key, entry);
  return entry;
}

function writeCalCache(key: string, entry: { events: CalEvent[]; ts: number }) {
  calCache.delete(key);
  calCache.set(key, entry);
  while (calCache.size > CAL_CACHE_MAX_ENTRIES) calCache.delete(calCache.keys().next().value!);
}

type CalendarRangeSnapshot = { range: Required<Pick<CalRange, "from" | "to">>; events: CalEvent[] };
type CalendarRequestState =
  | { status: "idle" }
  | { status: "loading"; generation: number; rangeKey: string }
  | { status: "failed"; generation: number; rangeKey: string; message: string };
type DateCoverage = "covered" | "loading" | "unavailable";
type CapacityMeasurement = {
  element: HTMLDivElement;
  value: number;
  windowStart: string;
  layout: string;
};

export function useCalendarEvents(
  range: CalRange,
  deps: unknown[],
  onLogout: () => void,
  options: { retainPrevious?: boolean } = {},
) {
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadedSnapshot, setLoadedSnapshot] = useState<CalendarRangeSnapshot | null>(null);
  const [priorSnapshot, setPriorSnapshot] = useState<CalendarRangeSnapshot | null>(null);
  const [requestState, setRequestState] = useState<CalendarRequestState>({ status: "idle" });
  const [retryNonce, setRetryNonce] = useState(0);
  const forceRefreshRef = useRef(false);
  const ownedControllerRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  useEffect(() => {
    const key = rangeKey(range);
    const snapshotRange = range.from && range.to ? { from: range.from, to: range.to } : null;
    let active = true;
    const cached = readCalCache(key);
    const forceRefresh = forceRefreshRef.current;
    forceRefreshRef.current = false;
    setEvents(cached?.events ?? null);
    setErr(null);
    if (cached && snapshotRange) {
      setLoadedSnapshot({ range: snapshotRange, events: cached.events });
      setRequestState({ status: "idle" });
    }

    const refresh = () => {
      ownedControllerRef.current?.abort();
      const controller = new AbortController();
      ownedControllerRef.current = controller;
      const generation = ++requestGenerationRef.current;
      setRequestState({ status: "loading", generation, rangeKey: key });
      api
        .calendarEvents(range, controller.signal)
        .then((evs) => {
          if (!active || ownedControllerRef.current !== controller || generation !== requestGenerationRef.current) return;
          writeCalCache(key, { events: evs, ts: Date.now() });
          setEvents(evs);
          if (snapshotRange) {
            setLoadedSnapshot((current) => {
              if (options.retainPrevious && current && rangeKey(current.range) !== key) setPriorSnapshot(current);
              else setPriorSnapshot(null);
              return { range: snapshotRange, events: evs };
            });
          }
          setErr(null);
          setRequestState({ status: "idle" });
          ownedControllerRef.current = null;
        })
        .catch((e) => {
          if (!active || ownedControllerRef.current !== controller || generation !== requestGenerationRef.current) return;
          if ((e as Error).name === "AbortError") return;
          if (e instanceof AuthError) {
            ownedControllerRef.current = null;
            setRequestState({ status: "idle" });
            onLogout();
          }
          else {
            const message = (e as Error).message;
            setErr(message);
            setRequestState({ status: "failed", generation, rangeKey: key, message });
            ownedControllerRef.current = null;
          }
        });
    };

    // Use cache if fresh; otherwise revalidate immediately.
    if (forceRefresh || !cached || Date.now() - cached.ts > CAL_FRESH_MS) refresh();

    const iv = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);
    const onFocus = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      ownedControllerRef.current?.abort();
      ownedControllerRef.current = null;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, retryNonce]);
  return { events, err, loadedSnapshot, priorSnapshot, requestState, requestGeneration: requestGenerationRef.current,
    retry: () => {
      forceRefreshRef.current = true;
      setRetryNonce((value) => value + 1);
    } };
}

export function CalReauth({ err }: { err: string }) {
  return (
    <div className="empty">
      <p>캘린더를 불러오지 못했습니다.</p>
      <p className="muted">{err}</p>
      <button className="btn primary" onClick={() => window.location.reload()}>
        다시 불러오기
      </button>
    </div>
  );
}

export function MonthGrid({
  onLogout,
  hiddenCals,
  calendars,
  primaryColorOverride,
  onEvent,
  onDay,
  onCreate,
  refreshKey,
  dateAnchor,
  onDateAnchorChange,
  interactionLocked,
}: {
  onLogout: () => void;
  hiddenCals: Set<string>;
  calendars: Calendar[];
  primaryColorOverride?: string | null;
  onEvent: (e: CalEvent) => void;
  onDay: (dayKey: string, events: CalEvent[]) => void;
  onCreate?: (dayKey: string) => void;
  refreshKey: number;
  dateAnchor: string;
  onDateAnchorChange: (dayKey: string) => void;
  interactionLocked: boolean;
}) {
  const [windowStartKey, setWindowStartKey] = useState(() =>
    dateKey(startOfWeek(new Date(`${addDays(dateAnchor, -42)}T00:00:00`))));
  const [visibleMonth, setVisibleMonth] = useState(() => new Date(`${dateAnchor}T00:00:00`));
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [capacity, setCapacity] = useState(1);
  const [measured, setMeasured] = useState(false);
  const [capacityMeasurement, setCapacityMeasurement] = useState<CapacityMeasurement | null>(null);
  const [alignmentGutter, setAlignmentGutter] = useState(0);
  const [navigationToken, setNavigationToken] = useState(0);
  const [navigationPhase, setNavigationPhase] = useState<"idle" | "rebase" | "align" | "settling" | "settled">("idle");
  const [adjustmentGeneration, setAdjustmentGeneration] = useState(0);
  const adjustmentRef = useRef<{
    generation: number;
    kind: "recycle" | "resize";
    key: string;
    top: number;
    pitch: number;
  } | null>(null);
  const adjustmentGenerationRef = useRef(0);
  const adjustmentRafRef = useRef<number | null>(null);
  const correctingScrollRef = useRef(false);
  const correctionTargetRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const stableAnchorRef = useRef<{ key: string; top: number; pitch: number } | null>(null);
  const navigationRef = useRef<{
    token: number;
    target: string;
    mode: "center" | "start";
    phase: "rebase" | "align" | "settling" | "settled";
  } | null>(null);
  const navigationFrameRef = useRef<number | null>(null);
  const navigationGenerationRef = useRef(0);
  const capacityRef = useRef<CapacityMeasurement | null>(null);
  const programmaticRef = useRef(true);
  const markCorrectingScroll = useCallback(() => {
    correctingScrollRef.current = true;
    correctionTargetRef.current = null;
  }, []);
  const weeks = useMemo(() => Array.from({ length: VIRTUAL_WEEK_COUNT }, (_, i) =>
    addDays(windowStartKey, i * 7)), [windowStartKey]);
  const fetchRange = useMemo(() => ({
    from: new Date(`${addDays(windowStartKey, -PREFETCH_WEEK_COUNT * 7)}T00:00:00`).toISOString(),
    to: new Date(`${addDays(windowStartKey, (VIRTUAL_WEEK_COUNT + PREFETCH_WEEK_COUNT) * 7)}T00:00:00`).toISOString(),
  }), [windowStartKey]);
  const { events, err, loadedSnapshot, priorSnapshot, requestState, requestGeneration, retry } = useCalendarEvents(
    fetchRange, [fetchRange.from, fetchRange.to, refreshKey, onLogout], onLogout, { retainPrevious: true });
  const eventsBySnapshot = useMemo(() => {
    const indexSnapshot = (snapshotEvents: readonly CalEvent[]) => {
      const map = new Map<string, CalEvent[]>();
      const unique = new Map<string, CalEvent>();
      for (const event of snapshotEvents) unique.set(`${event.calendarId}|${event.id}`, event);
      for (const event of unique.values()) {
        if (hiddenCals.has(event.calendarId)) continue;
        for (const key of occupiedDayKeys(event)) {
          const bucket = map.get(key);
          if (bucket) bucket.push(event);
          else map.set(key, [event]);
        }
      }
      return map;
    };
    return {
      loaded: indexSnapshot(loadedSnapshot?.events ?? []),
      prior: indexSnapshot(priorSnapshot?.events ?? []),
      fallback: indexSnapshot(events ?? []),
    };
  }, [events, hiddenCals, loadedSnapshot, priorSnapshot]);
  const snapshotCovers = useCallback((snapshot: CalendarRangeSnapshot | null, key: string) =>
    Boolean(snapshot &&
      key >= dateKey(new Date(snapshot.range.from)) &&
      key < dateKey(new Date(snapshot.range.to))), []);
  const eventsForDay = useCallback((key: string) => {
    if (snapshotCovers(loadedSnapshot, key)) return eventsBySnapshot.loaded.get(key) ?? [];
    if (snapshotCovers(priorSnapshot, key)) return eventsBySnapshot.prior.get(key) ?? [];
    return eventsBySnapshot.fallback.get(key) ?? [];
  }, [eventsBySnapshot, loadedSnapshot, priorSnapshot, snapshotCovers]);
  /*
   * A newer exact-range snapshot is authoritative for every date it covers:
   * absence there means deletion, not permission to resurrect a prior event.
   */
  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const week of weeks) {
      for (let index = 0; index < 7; index += 1) {
        const key = addDays(week, index);
        const dayEvents = eventsForDay(key);
        if (dayEvents.length > 0) map.set(key, dayEvents);
      }
    }
    return map;
  }, [eventsForDay, weeks]);
  const todayKey = dateKey(new Date());
  const coverage = useCallback((key: string): DateCoverage => {
    if (snapshotCovers(loadedSnapshot, key) || snapshotCovers(priorSnapshot, key)) return "covered";
    const inRequestedRange = key >= dateKey(new Date(fetchRange.from)) &&
      key < dateKey(new Date(fetchRange.to));
    const ownsCurrentRange = requestState.status !== "idle" &&
      requestState.rangeKey === rangeKey(fetchRange);
    return requestState.status === "failed" && ownsCurrentRange && inRequestedRange
      ? "unavailable"
      : "loading";
  }, [fetchRange, loadedSnapshot, priorSnapshot, requestState, snapshotCovers]);
  const setRegion = useCallback((element: HTMLDivElement | null) => setScrollElement(element), []);
  const measure = useCallback((element: HTMLDivElement) => {
    if (interactionLocked) return;
    const cell = element.querySelector<HTMLElement>(".month-cell");
    const head = element.querySelector<HTMLElement>(".month-cellhead");
    if (!cell || !head) return;
    const style = getComputedStyle(cell);
    const rowHeight = Number.parseFloat(style.getPropertyValue("--month-event-row-height")) || 24;
    const available = cell.clientHeight - Number.parseFloat(style.paddingTop) -
      Number.parseFloat(style.paddingBottom) - head.offsetHeight;
    const value = Math.max(1, Math.floor(available / (rowHeight + (Number.parseFloat(style.gap) || 0))));
    const week = element.querySelector<HTMLElement>(".month-week");
    setAlignmentGutter(Math.max(0, element.clientHeight - (week?.offsetHeight ?? 0)));
    const measurement = {
      element,
      value,
      windowStart: windowStartKey,
      layout: `${element.clientWidth}|${element.clientHeight}|${week?.offsetHeight ?? 0}|${rowHeight}`,
    };
    capacityRef.current = measurement;
    setCapacityMeasurement((current) =>
      current &&
      current.element === measurement.element &&
      current.value === measurement.value &&
      current.windowStart === measurement.windowStart &&
      current.layout === measurement.layout
        ? current
        : measurement);
    setCapacity(value);
    setMeasured(true);
  }, [interactionLocked, windowStartKey]);
  useLayoutEffect(() => {
    if (!scrollElement) return;
    measure(scrollElement);
    const observer = new ResizeObserver(() => {
      if (interactionLocked) return;
      const row = scrollElement.querySelector<HTMLElement>(".month-week");
      const stable = stableAnchorRef.current;
      if (row && stable && row.offsetHeight !== stable.pitch && !adjustmentRef.current) {
        const generation = ++adjustmentGenerationRef.current;
        setAdjustmentGeneration(generation);
        adjustmentRef.current = { ...stable, generation, kind: "resize" };
        if (adjustmentRafRef.current !== null) cancelAnimationFrame(adjustmentRafRef.current);
        adjustmentRafRef.current = requestAnimationFrame(() => {
          adjustmentRafRef.current = null;
          const pending = adjustmentRef.current;
          if (!pending || pending.generation !== generation || pending.kind !== "resize") return;
          const retained = scrollElement.querySelector<HTMLElement>(`[data-week-start="${stable.key}"]`);
          if (retained) {
            markCorrectingScroll();
            scrollElement.scrollTop += retained.getBoundingClientRect().top -
              scrollElement.getBoundingClientRect().top - stable.top;
            correctionTargetRef.current = scrollElement.scrollTop;
          }
          adjustmentRef.current = null;
          if (retained) {
            stableAnchorRef.current = {
              key: stable.key,
              top: retained.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top,
              pitch: retained.offsetHeight,
            };
          }
        });
      }
      measure(scrollElement);
    });
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [scrollElement, measure, windowStartKey, interactionLocked, markCorrectingScroll]);
  useLayoutEffect(() => {
    const pending = adjustmentRef.current;
    if (!pending || pending.kind !== "recycle" || !scrollElement) return;
    const row = scrollElement.querySelector<HTMLElement>(`[data-week-start="${pending.key}"]`);
    if (row) {
      markCorrectingScroll();
      scrollElement.scrollTop += row.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top - pending.top;
      correctionTargetRef.current = scrollElement.scrollTop;
    }
    if (adjustmentRef.current?.generation === pending.generation) adjustmentRef.current = null;
    if (row) {
      stableAnchorRef.current = {
        key: pending.key,
        top: row.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top,
        pitch: row.offsetHeight,
      };
    }
  }, [markCorrectingScroll, scrollElement, windowStartKey]);
  const align = useCallback((target: string, mode: "center" | "start") => {
    const week = dateKey(startOfWeek(new Date(`${target}T00:00:00`)));
    const row = scrollElement?.querySelector<HTMLElement>(`[data-week-start="${week}"]`);
    if (!row || !scrollElement) return;
    const regionRect = scrollElement.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const delta = mode === "center"
      ? rowRect.top + rowRect.height / 2 - (regionRect.top + regionRect.height / 2)
      : rowRect.top - regionRect.top;
    scrollElement.scrollTop += delta;
  }, [scrollElement]);
  const navigate = useCallback((target: string, mode: "center" | "start") => {
    programmaticRef.current = true;
    const token = ++navigationGenerationRef.current;
    const week = dateKey(startOfWeek(new Date(`${target}T00:00:00`)));
    const needsRebase = !weeks.includes(week);
    const desiredWindowStart = addDays(week, -42);
    navigationRef.current = {
      token,
      target,
      mode,
      phase: needsRebase ? "rebase" : "align",
    };
    setNavigationPhase(needsRebase ? "rebase" : "align");
    setNavigationToken(token);
    setVisibleMonth(new Date(`${target}T00:00:00`));
    onDateAnchorChange(target);
    if (needsRebase) {
      setMeasured(false);
      setWindowStartKey(desiredWindowStart);
    }
  }, [onDateAnchorChange, weeks]);
  useLayoutEffect(() => {
    const navigation = navigationRef.current;
    if (navigation) {
      if (navigationFrameRef.current !== null) cancelAnimationFrame(navigationFrameRef.current);
      const token = navigation.token;
      navigation.phase = "align";
      setNavigationPhase("align");
      navigationFrameRef.current = requestAnimationFrame(() => {
        if (navigationRef.current?.token !== token) return;
        align(navigation.target, navigation.mode);
        navigation.phase = "settling";
        setNavigationPhase("settling");
        let stableFrames = 0;
        let previous = scrollElement?.scrollTop ?? 0;
        const settle = () => {
          navigationFrameRef.current = requestAnimationFrame(() => {
            const current = navigationRef.current;
            if (!current || current.token !== token || !scrollElement) return;
            const next = scrollElement.scrollTop;
            const targetWeek = dateKey(startOfWeek(new Date(`${current.target}T00:00:00`)));
            const targetRow = scrollElement.querySelector<HTMLElement>(
              `[data-week-start="${targetWeek}"]`,
            );
            const regionRect = scrollElement.getBoundingClientRect();
            const rowRect = targetRow?.getBoundingClientRect();
            const alignmentError = rowRect
              ? current.mode === "center"
                ? Math.abs(rowRect.top + rowRect.height / 2 - (regionRect.top + regionRect.height / 2))
                : Math.abs(rowRect.top - regionRect.top)
              : Number.POSITIVE_INFINITY;
            stableFrames = Math.abs(next - previous) <= 1 && alignmentError <= 1
              ? stableFrames + 1
              : 0;
            previous = next;
            if (stableFrames >= 2) {
              current.phase = "settled";
              setNavigationPhase("settled");
              if (targetRow) {
                stableAnchorRef.current = {
                  key: targetWeek,
                  top: targetRow.getBoundingClientRect().top - regionRect.top,
                  pitch: targetRow.offsetHeight,
                };
              }
              navigationFrameRef.current = null;
              return;
            }
            settle();
          });
        };
        settle();
      });
    } else if (programmaticRef.current) align(dateAnchor, "center");
    return () => {
      if (navigationFrameRef.current !== null) {
        cancelAnimationFrame(navigationFrameRef.current);
        navigationFrameRef.current = null;
      }
    };
  }, [align, dateAnchor, navigationToken, scrollElement, windowStartKey]);
  const releaseProgrammaticNavigation = useCallback(() => {
    programmaticRef.current = false;
    navigationRef.current = null;
    correctingScrollRef.current = false;
    correctionTargetRef.current = null;
    setNavigationPhase("idle");
    if (navigationFrameRef.current !== null) {
      cancelAnimationFrame(navigationFrameRef.current);
      navigationFrameRef.current = null;
    }
  }, []);
  const onScroll = useCallback(() => {
    if (!scrollElement) return;
    if (correctingScrollRef.current) {
      const target = correctionTargetRef.current;
      if (target === null || Math.abs(scrollElement.scrollTop - target) <= 1) return;
      correctingScrollRef.current = false;
      correctionTargetRef.current = null;
    }
    if (interactionLocked ||
      adjustmentRef.current || navigationRef.current || scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (interactionLocked || adjustmentRef.current || navigationRef.current) return;
      const rows = [...scrollElement.querySelectorAll<HTMLElement>(".month-week")];
      const rect = scrollElement.getBoundingClientRect();
      const firstVisible = rows.find((row) => row.getBoundingClientRect().bottom > rect.top);
      if (!firstVisible) return;
      const stableRow = rows.find((row) => {
        const box = row.getBoundingClientRect();
        return box.top >= rect.top && box.bottom <= rect.bottom;
      }) ?? firstVisible;
      stableAnchorRef.current = {
        key: stableRow.dataset.weekStart!,
        top: stableRow.getBoundingClientRect().top - rect.top,
        pitch: stableRow.offsetHeight,
      };
      if (!programmaticRef.current) {
        const visibleCells = [...scrollElement.querySelectorAll<HTMLElement>(".month-cell")]
          .filter((cell) => {
            const box = cell.getBoundingClientRect();
            return box.bottom > rect.top && box.top < rect.bottom;
          });
        const viewportCenter = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
        const anchorCell = visibleCells.reduce<HTMLElement | null>((best, cell) => {
          if (!best) return cell;
          const cellBox = cell.getBoundingClientRect();
          const bestBox = best.getBoundingClientRect();
          const cellDistance =
            Math.abs(cellBox.left + cellBox.width / 2 - viewportCenter.x) +
            Math.abs(cellBox.top + cellBox.height / 2 - viewportCenter.y);
          const bestDistance =
            Math.abs(bestBox.left + bestBox.width / 2 - viewportCenter.x) +
            Math.abs(bestBox.top + bestBox.height / 2 - viewportCenter.y);
          return cellDistance < bestDistance ? cell : best;
        }, null);
        const centerMonth = anchorCell?.dataset.date?.slice(0, 7);
        const monthAreas = new Map<string, number>();
        for (const cell of visibleCells) {
          const box = cell.getBoundingClientRect();
          const month = cell.dataset.date!.slice(0, 7);
          const height = Math.max(0, Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top));
          monthAreas.set(month, (monthAreas.get(month) ?? 0) + height * box.width);
        }
        const dominantMonth = [...monthAreas].sort((left, right) => {
          const areaDifference = right[1] - left[1];
          if (Math.abs(areaDifference) > 0.5) return areaDifference;
          if (left[0] === centerMonth) return -1;
          if (right[0] === centerMonth) return 1;
          return left[0].localeCompare(right[0]);
        })[0]?.[0];
        if (dominantMonth) setVisibleMonth(new Date(`${dominantMonth}-01T00:00:00`));
        if (anchorCell?.dataset.date) onDateAnchorChange(anchorCell.dataset.date);
      }
      const rowHeight = rows[0].getBoundingClientRect().height;
      const edgeThreshold = rowHeight * EDGE_THRESHOLD_WEEKS;
      const firstRect = rows[0].getBoundingClientRect();
      const lastRect = rows[rows.length - 1].getBoundingClientRect();
      const direction = firstRect.top >= rect.top - edgeThreshold
        ? -1
        : lastRect.bottom <= rect.bottom + edgeThreshold
          ? 1
          : 0;
      if (!direction || programmaticRef.current) return;
      const retained = rows[
        direction > 0
          ? RECYCLE_WEEK_COUNT
          : VIRTUAL_WEEK_COUNT - RECYCLE_WEEK_COUNT - 1
      ];
      const retainedRect = retained.getBoundingClientRect();
      const adjustmentGeneration = ++adjustmentGenerationRef.current;
      setAdjustmentGeneration(adjustmentGeneration);
      adjustmentRef.current = {
        generation: adjustmentGeneration,
        kind: "recycle",
        key: retained.dataset.weekStart!,
        top: retainedRect.top - rect.top,
        pitch: retained.offsetHeight,
      };
      const removed = rows.slice(direction > 0 ? 0 : VIRTUAL_WEEK_COUNT - RECYCLE_WEEK_COUNT,
        direction > 0 ? RECYCLE_WEEK_COUNT : VIRTUAL_WEEK_COUNT);
      if (removed.some((row) => row.contains(document.activeElement))) scrollElement.focus();
      setMeasured(false);
      const cachedCapacity = capacityRef.current;
      const currentWeek = rows[0];
      const currentCell = scrollElement.querySelector<HTMLElement>(".month-cell");
      const currentRowHeight = currentCell
        ? Number.parseFloat(getComputedStyle(currentCell).getPropertyValue("--month-event-row-height")) || 24
        : 24;
      const currentLayout = `${scrollElement.clientWidth}|${scrollElement.clientHeight}|${currentWeek?.offsetHeight ?? 0}|${currentRowHeight}`;
      if (cachedCapacity?.element === scrollElement && cachedCapacity.layout === currentLayout) {
        setCapacity(cachedCapacity.value);
      }
      setWindowStartKey((current) => addDays(current, direction * RECYCLE_WEEK_COUNT * 7));
    });
  }, [interactionLocked, onDateAnchorChange, scrollElement]);
  useEffect(() => () => {
    if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    if (adjustmentRafRef.current !== null) cancelAnimationFrame(adjustmentRafRef.current);
    if (navigationFrameRef.current !== null) cancelAnimationFrame(navigationFrameRef.current);
  }, []);
  useLayoutEffect(() => {
    if (!interactionLocked) return;
    navigationRef.current = null;
    setNavigationPhase("idle");
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    if (navigationFrameRef.current !== null) {
      cancelAnimationFrame(navigationFrameRef.current);
      navigationFrameRef.current = null;
    }
    if (adjustmentRafRef.current !== null) {
      cancelAnimationFrame(adjustmentRafRef.current);
      adjustmentRafRef.current = null;
    }
    correctingScrollRef.current = false;
    correctionTargetRef.current = null;
    adjustmentRef.current = null;
  }, [interactionLocked]);
  const hasVisibleCoverage = weeks.some((week) =>
    Array.from({ length: 7 }, (_, index) => coverage(addDays(week, index))).includes("covered"));
  const currentCell = scrollElement?.querySelector<HTMLElement>(".month-cell") ?? null;
  const currentWeek = scrollElement?.querySelector<HTMLElement>(".month-week") ?? null;
  const currentRowHeight = currentCell
    ? Number.parseFloat(getComputedStyle(currentCell).getPropertyValue("--month-event-row-height")) || 24
    : 0;
  const currentLayout = scrollElement
    ? `${scrollElement.clientWidth}|${scrollElement.clientHeight}|${currentWeek?.offsetHeight ?? 0}|${currentRowHeight}`
    : "";
  const capacityReady = Boolean(
    measured &&
    capacityMeasurement?.element === scrollElement &&
    capacityMeasurement?.windowStart === windowStartKey &&
    capacityMeasurement?.layout === currentLayout,
  );
  const capacitySource = capacityReady
    ? "measured"
    : capacityMeasurement?.element === scrollElement && capacityMeasurement?.layout === currentLayout
      ? "carried"
      : "fallback";
  const renderCapacity = capacitySource === "fallback" ? 1 : capacity;

  return (
    <section className={`month-continuous${interactionLocked ? " month-interaction-locked" : ""}`}
      data-window-start={windowStartKey}
      data-week-count={VIRTUAL_WEEK_COUNT}
      data-cache-size={calCache.size}
      data-cache-order={[...calCache.keys()].join(",")}
      data-request-state={requestState.status}
      data-request-generation={requestGeneration}
      data-navigation-phase={navigationPhase}
      data-adjustment-generation={adjustmentGeneration}
      data-loaded-range={loadedSnapshot ? rangeKey(loadedSnapshot.range) : ""}
      data-prior-range={priorSnapshot ? rangeKey(priorSnapshot.range) : ""}
      data-event-row-capacity={renderCapacity}
      data-event-capacity-measured={capacityReady}
      data-event-capacity-source={capacitySource}>
      <div className="cal-monthnav" aria-label="월 탐색">
        <div className="cal-monthnav-group">
          <button
            className="btn cal-navbtn"
            aria-label="이전 달"
            onClick={() => {
              const month = addMonths(visibleMonth, -1);
              navigate(dateKey(new Date(month.getFullYear(), month.getMonth(), 1)), "start");
            }}
          >
            ‹
          </button>
          <button
            className="btn cal-navbtn"
            aria-label="다음 달"
            onClick={() => {
              const month = addMonths(visibleMonth, 1);
              navigate(dateKey(new Date(month.getFullYear(), month.getMonth(), 1)), "start");
            }}
          >
            ›
          </button>
        </div>
        <strong aria-live="polite">
          {visibleMonth.toLocaleDateString("ko-KR", { year: "numeric", month: "long" })}
        </strong>
        <button
          className="btn cal-today"
          onClick={() => {
            navigate(todayKey, "center");
          }}
        >
          오늘
        </button>
      </div>
      {err && (
        <div className="cal-refresh-warning" role="status">
          {hasVisibleCoverage
            ? "최신 일정을 가져오지 못해 저장된 일정을 표시합니다. "
            : "일정을 불러오지 못했습니다. "}
          {err}
          <button type="button" onClick={retry}>다시 시도</button>
        </div>
      )}
      <div className="month-dow-row">
        {["일", "월", "화", "수", "목", "금", "토"].map((w, i) => (
          <div key={w} className={`month-dow${i === 0 ? " sun" : i === 6 ? " sat" : ""}`}>{w}</div>
        ))}
      </div>
      <div
          ref={setRegion}
          className="month-virtual-scroll"
          role="region"
          aria-label="연속 월간 캘린더"
          tabIndex={0}
          aria-busy={requestState.status === "loading"}
          onScroll={onScroll}
          onWheel={releaseProgrammaticNavigation}
          onTouchStart={releaseProgrammaticNavigation}
          onPointerDown={(event) => {
            if (event.currentTarget === event.target) releaseProgrammaticNavigation();
          }}
          onKeyDown={(event) => {
            if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
              releaseProgrammaticNavigation();
            }
          }}
        >
        <div className="month-week-list">
          {weeks.map((weekStart) => (
            <div className="month-week" key={weekStart} data-week-start={weekStart}>
              {Array.from({ length: 7 }, (_, index) => {
                const key = addDays(weekStart, index);
                const d = new Date(`${key}T00:00:00`);
            const evs = byDay.get(key) ?? [];
            const other = d.getMonth() !== visibleMonth.getMonth();
            const dow = d.getDay();
            const state = coverage(key);
            const visibleEvents = evs.length > renderCapacity
              ? evs.slice(0, Math.max(0, renderCapacity - 1))
              : evs;
            return (
              <div
                key={key}
                data-date={key}
                data-coverage={state}
                className={`month-cell${other ? " other" : ""}${key === todayKey ? " today" : ""}${key === dateAnchor ? " selected" : ""}${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}${state === "unavailable" ? " unavailable" : ""}`}
              >
                {onCreate && <button
                  type="button"
                  className="month-create-hitarea"
                  tabIndex={key === dateAnchor ? 0 : -1}
                  aria-label={`${d.toLocaleDateString("ko-KR")}에 일정 추가`}
                  onClick={() => {
                    onDateAnchorChange(key);
                    onCreate(key);
                  }}
                  onKeyDown={(event) => {
                    const move = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 :
                      event.key === "ArrowUp" ? -7 : event.key === "ArrowDown" ? 7 : 0;
                    if (!move) return;
                    event.preventDefault();
                    const target = addDays(key, move);
                    if (!weeks.some((week) => target >= week && target <= addDays(week, 6))) return;
                    onDateAnchorChange(target);
                    requestAnimationFrame(() =>
                      scrollElement?.querySelector<HTMLElement>(`.month-cell[data-date="${target}"] .month-create-hitarea`)?.focus());
                  }}
                />}
                <div className="month-cellhead">
                  <span
                    className="month-daynum"
                    aria-current={key === todayKey ? "date" : undefined}
                  >
                    {d.getDate()}
                  </span>
                  {evs.length > 0 && (
                    <span className="month-count" title={`${evs.length}개 일정`}>
                      {evs.length}
                    </span>
                  )}
                </div>
                {state === "loading" && evs.length === 0 ? <span className="month-loading" aria-hidden="true" /> : visibleEvents.map((e) => {
                  const displayColor = getEventDisplayColor(
                    e,
                    calendars,
                    primaryColorOverride,
                  );
                  const timeLabel = evTimeLabel(e, key);
                  return (
                    <button
                      key={`${e.calendarId}|${e.id}|${e.start}`}
                      type="button"
                      className="month-ev"
                      onClick={() => onEvent(e)}
                      title={`${timeLabel} ${e.summary} · ${e.calendarSummary}`}
                      aria-label={`${timeLabel}, ${e.summary}, ${e.calendarSummary}`}
                      style={{
                        // 셀 바탕(--panel)에 섮는다 — 다크에서는 어두운 틴트가 된다
                        background: `color-mix(in srgb, ${displayColor} 22%, var(--panel))`,
                        borderLeft: `4px solid ${displayColor}`,
                      }}
                    >
                      {!e.allDay && (
                        <span className="month-ev-time">{compactTime(timeLabel)}</span>
                      )}
                      <span className="month-ev-t">{e.summary}</span>
                    </button>
                  );
                })}
                {evs.length > renderCapacity && (
                  <button
                    type="button"
                    className="month-more"
                    aria-label={`${formatDayHeader(key)} 일정 ${evs.length - visibleEvents.length}개 더보기`}
                    onClick={() => onDay(key, evs)}
                  >
                    +{evs.length - visibleEvents.length}개 더보기
                  </button>
                )}
              </div>
            );
              })}
            </div>
          ))}
        </div>
        <div className="month-alignment-gutter" aria-hidden="true" style={{ height: alignmentGutter }} />
      </div>
    </section>
  );
}

export function AgendaList({
  onLogout,
  hiddenCals,
  calendars,
  primaryColorOverride,
  onEvent,
  refreshKey,
  dateAnchor,
  onDateAnchorChange,
}: {
  onLogout: () => void;
  hiddenCals: Set<string>;
  calendars: Calendar[];
  primaryColorOverride?: string | null;
  onEvent: (e: CalEvent) => void;
  refreshKey: number;
  dateAnchor: string;
  onDateAnchorChange: (dayKey: string) => void;
}) {
  const [days, setDays] = useState(30);
  const anchorStart = useMemo(() => new Date(`${dateAnchor}T00:00:00`), [dateAnchor]);
  const anchorEnd = useMemo(
    () => new Date(`${addDays(dateAnchor, days)}T00:00:00`),
    [dateAnchor, days],
  );
  const { events, err } = useCalendarEvents(
    { from: anchorStart.toISOString(), to: anchorEnd.toISOString() },
    [dateAnchor, days, refreshKey, onLogout],
    onLogout,
  );

  const groups = useMemo(() => {
    const startKey = dateAnchor;
    const endKey = addDays(startKey, days);
    const index = new Map<string, CalEvent[]>();
    for (const e of events ?? []) {
      if (hiddenCals.has(e.calendarId)) continue;
      for (const key of occupiedDayKeys(e)) {
        if (key < startKey || key >= endKey) continue;
        let bucket = index.get(key);
        if (!bucket) {
          bucket = [];
          index.set(key, bucket);
        }
        bucket.push(e);
      }
    }
    for (const bucket of index.values()) {
      bucket.sort(
        (left, right) =>
          Number(right.allDay) - Number(left.allDay) ||
          Date.parse(left.start) - Date.parse(right.start) ||
          left.summary.localeCompare(right.summary, "ko"),
      );
    }
    return [...index.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [events, hiddenCals, days, dateAnchor]);

  return (
    <>
      <div className="cal-range">
        <div>
          <span className="cal-range-label">목록 범위</span>
          <strong>{formatDayHeader(dateAnchor)}부터</strong>
        </div>
        <div className="cal-range-options" aria-label="목록 기간">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              className={days === d ? "active" : ""}
              aria-pressed={days === d}
              onClick={() => setDays(d)}
            >
              {d}일
            </button>
          ))}
        </div>
      </div>
      <div className="agenda-scroll">
      {err && events && (
        <div className="cal-refresh-warning" role="status">
          최신 일정을 가져오지 못해 저장된 일정을 표시합니다. {err}
        </div>
      )}
      {err && !events ? (
        <CalReauth err={err} />
      ) : !events ? (
        <div className="empty">불러오는 중…</div>
      ) : groups.length === 0 ? (
        // groups, not events: with every visible calendar hidden the list
        // must say "없습니다", not render blank.
        <div className="empty">예정된 일정이 없습니다.</div>
      ) : (
        groups.map(([key, evs]) => (
          <section key={key} className="cal-day">
            <button
              type="button"
              className="cal-date"
              onClick={() => onDateAnchorChange(key)}
              aria-label={`${formatDayHeader(key)}을 월 보기 기준일로 선택`}
            >
              {formatDayHeader(key)}
            </button>
            {evs.map((e) => (
              <button
                key={`${e.calendarId}|${e.id}|${e.start}`}
                type="button"
                className="cal-event"
                onClick={() => {
                  onDateAnchorChange(key);
                  onEvent(e);
                }}
              >
                <span
                  className="cal-dot"
                  style={{ background: getEventDisplayColor(e, calendars, primaryColorOverride) }}
                />
                <span className="cal-time">{evTimeLabel(e, key)}</span>
                <span className="cal-title">{e.summary}</span>
                {e.location && <span className="cal-loc"><LocationIcon />{e.location}</span>}
                <span className="cal-cal">{e.calendarSummary}</span>
              </button>
            ))}
          </section>
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
  calendars,
  primaryColorOverride,
  onEvent,
  onClose,
}: {
  dayKey: string;
  events: CalEvent[];
  calendars: Calendar[];
  primaryColorOverride?: string | null;
  onEvent: (event: CalEvent) => void;
  onClose: () => void;
}) {
  const dlg = useResizableDialog("day-events", 460, 360);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => dlg.ref.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      previous?.focus();
    };
  }, [dlg.ref]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${formatDayHeader(dayKey)} 일정`}
        tabIndex={-1}
        ref={dlg.ref}
        style={dlg.style}
        onKeyDown={(event) => handleDialogKeyDown(event, onClose)}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <strong>{formatDayHeader(dayKey)}</strong>
            <span className="muted"> · {events.length}개 일정</span>
          </div>
          <DialogTools maximized={dlg.maximized} onToggleMax={dlg.toggleMax} />
          <button className="clear" aria-label="닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="day-list">
          {events.map((event) => (
            <button
              key={`${event.calendarId}|${event.id}|${event.start}`}
              type="button"
              className="cal-event"
              onClick={() => onEvent(event)}
            >
              <span
                className="cal-dot"
                style={{
                  background: getEventDisplayColor(
                    event,
                    calendars,
                    primaryColorOverride,
                  ),
                }}
              />
              <span className="cal-time">{evTimeLabel(event, dayKey)}</span>
              <span className="cal-title">{event.summary}</span>
              {event.location && <span className="cal-loc"><LocationIcon />{event.location}</span>}
              <span className="cal-cal">{event.calendarSummary}</span>
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
  calendars,
  primaryColorOverride,
  onLogout,
  canEdit,
  onEdit,
  onChanged,
  onClose,
}: {
  ev: CalEvent;
  calendars: Calendar[];
  primaryColorOverride?: string | null;
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
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => dlg.ref.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      previous?.focus();
    };
  }, [dlg.ref]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="dialog"
        ref={dlg.ref}
        style={dlg.style}
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-detail-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => handleDialogKeyDown(event, onClose)}
      >
        <div className="modal-head">
          <strong id="event-detail-title">일정</strong>
          <DialogTools maximized={dlg.maximized} onToggleMax={dlg.toggleMax} />
          <button className="clear" aria-label="일정 상세 닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="ev-detail">
          <h3 className="ev-title">
            <span
              className="ev-dot"
              style={{ background: getEventDisplayColor(ev, calendars, primaryColorOverride) }}
            />
            {ev.summary}
          </h3>
          <div className="ev-row"><ClockIcon />{formatEventWhen(ev)}</div>
          {ev.calendarSummary && (
            <div className="ev-row muted"><CalendarIcon />{ev.calendarSummary}</div>
          )}
          {(d?.location || ev.location) && (
            <div className="ev-row"><LocationIcon />{d?.location || ev.location}</div>
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
          {err && <div className="ev-row muted"><AlertIcon />{err}</div>}
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
                <EditIcon />수정
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
                <TrashIcon />삭제
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
  primaryColorOverride,
  initial,
  eventId,
  onLogout,
  onClose,
  onSaved,
}: {
  calendars: Calendar[];
  primaryColorOverride?: string | null;
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
  const primaryId = uniquePrimaryId(calendars);
  const writable = [...calendars.filter((c) => c.accessRole === "owner" || c.accessRole === "writer")].sort(
    (a, b) => Number(b.id === primaryId) - Number(a.id === primaryId),
  );
  const initialCalendarId =
    initial.calendarId ||
      writable.find((c) => c.id === primaryId)?.id ||
      writable[0]?.id ||
      "";
  const [calendarId, setCalendarId] = useState(initialCalendarId);
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
    calendarId !== initialCalendarId ||
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
  const selectedCalendar = writable.find((c) => c.id === calendarId);
  const calColor = selectedCalendar
    ? getCalendarDisplayColor(
        { ...selectedCalendar, primary: selectedCalendar.id === primaryId },
        selectedCalendar.id === primaryId
          ? primaryColorOverride === undefined
            ? readPrimaryColorOverride(selectedCalendar.id)
            : primaryColorOverride
          : undefined,
      )
    : "var(--muted)";
  const dlg = useResizableDialog("event-edit", 460, 380);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => dlg.ref.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      previous?.focus();
    };
  }, [dlg.ref]);

  return (
    <div className="modal-backdrop" onClick={tryClose}>
      <div
        className="dialog ev-dialog"
        ref={dlg.ref}
        style={dlg.style}
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-editor-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Tab") handleDialogKeyDown(e, tryClose);
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.stopPropagation();
            tryClose();
          }
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) {
            e.preventDefault();
            void save();
          }
        }}
      >
        <div className="modal-head">
          <strong id="event-editor-title">{eventId ? "일정 수정" : "새 일정"}</strong>
          <DialogTools maximized={dlg.maximized} onToggleMax={dlg.toggleMax} />
          <button className="clear" aria-label="일정 편집 닫기" onClick={tryClose}>
            ✕
          </button>
        </div>
        <div className="ev-form">
          <input
            className="ev-title-input"
            aria-label="일정 제목"
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
                aria-label="시작 날짜"
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
                aria-label="종료 날짜"
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
            {rangeErr && <div className="ev-err"><AlertIcon />{rangeErr}</div>}
          </div>
          {writable.length > 1 && (
            <div className="ev-cal-row">
              <span
                className="ev-dot"
                style={{ background: calColor }}
                aria-hidden
              />
              <select
                className="ev-input"
                aria-label="캘린더"
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
                aria-label="장소"
                placeholder="장소 (선택)"
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
                  aria-label="알림"
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
                aria-label="설명"
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
          {err && <div className="ev-err"><AlertIcon />{err}</div>}
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
