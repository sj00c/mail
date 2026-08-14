// 통합 검색 결과: 일정·메일·드라이브 3열 카드 + 상세/수정 모달 연결.
import { useEffect, useMemo, useState } from "react";
import {
  api,
  AuthError,
  type CalEvent,
  type Calendar,
  type DriveFile,
  type EventInput,
  type MessageSummary,
} from "../api.ts";
import {
  addDays,
  avatarColor,
  formatTime,
  highlightText,
  listDateLabel,
  searchTerms,
} from "../lib/format.tsx";
import { MoreSentinel } from "../ui/dialog.tsx";
import {
  AlertIcon,
  AttachmentIcon,
  CalendarIcon,
  ClockIcon,
  DriveIcon,
  MailIcon,
  LocationIcon,
} from "../ui/icons.tsx";
import {
  calCache,
  EventDetailModal,
  EventEditModal,
  getEventDisplayColor,
} from "./calendar.tsx";
import { DriveCard } from "./drive.tsx";
import { listParty } from "./reader.tsx";

export function MailCard({
  m,
  terms,
  active,
  onSelect,
}: {
  m: MessageSummary;
  terms: string[];
  active: boolean;
  onSelect: (id: string, threadId: string) => void;
}) {
  const addr = listParty(m);
  const initial = (addr.name || "?").trim().charAt(0).toUpperCase();
  return (
    <button
      type="button"
      className={`scard mail-card${m.unread ? " unread" : ""}${active ? " active" : ""}`}
      onClick={() => onSelect(m.id, m.threadId)}
    >
      <span className="avatar" style={{ background: avatarColor(addr.email.toLowerCase()) }}>
        {initial}
      </span>
      <span className="scard-main">
        <span className="scard-top">
          <span className="scard-from">{highlightText(addr.name, terms)}</span>
          <span
            className={`msg-read-state ${m.unread ? "unread" : "read"}`}
            title={m.unread ? "안읽은 메일" : "읽은 메일"}
          >
            <span className="msg-read-dot" />
            {m.unread ? "안읽음" : "읽음"}
          </span>
          <span className="scard-date">{listDateLabel(m.date)}</span>
        </span>
        <span className="scard-title">
          {highlightText(m.subject || "(제목 없음)", terms)}
          {m.hasAttachments && <span className="paperclip"><AttachmentIcon /></span>}
        </span>
        {m.snippet && (
          <span className="scard-sub">{highlightText(m.snippet, terms)}</span>
        )}
      </span>
    </button>
  );
}

export function EventCard({
  e,
  calendars,
  primaryColorOverride,
  terms,
  past,
  onClick,
}: {
  e: CalEvent;
  calendars: Calendar[];
  primaryColorOverride?: string | null;
  terms: string[];
  past?: boolean;
  onClick: () => void;
}) {
  const d = e.allDay ? new Date(`${e.start.slice(0, 10)}T00:00:00`) : new Date(e.start);
  const dow = d.toLocaleDateString("ko-KR", { weekday: "short" });
  let when: string;
  if (e.allDay) {
    const lastDay = e.end ? addDays(e.end.slice(0, 10), -1) : e.start.slice(0, 10);
    when =
      lastDay > e.start.slice(0, 10)
        ? `종일 · ${Number(lastDay.slice(5, 7))}월 ${Number(lastDay.slice(8, 10))}일까지`
        : "종일";
  } else {
    when = `${formatTime(e.start)}${e.end ? ` – ${formatTime(e.end)}` : ""}`;
  }
  return (
    <button
      type="button"
      className={`scard ev-card${past ? " past" : ""}`}
      onClick={onClick}
    >
      <span
        className="ev-datebox"
        style={{ borderTopColor: getEventDisplayColor(e, calendars, primaryColorOverride) }}
      >
        <span className="ev-db-month">
          {d.getFullYear() !== new Date().getFullYear()
            ? `${String(d.getFullYear()).slice(2)}년 ${d.getMonth() + 1}월`
            : `${d.getMonth() + 1}월`}
        </span>
        <span className="ev-db-day">{d.getDate()}</span>
        <span className="ev-db-dow">{dow}</span>
      </span>
      <span className="scard-main">
        <span className="scard-title">{highlightText(e.summary, terms)}</span>
        <span className="scard-sub">
          <ClockIcon />{when}
          {e.location ? <><span aria-hidden="true">·</span><LocationIcon />{highlightText(e.location, terms)}</> : null}
        </span>
        <span className="scard-tagrow">
          <span
            className="cal-dot"
            style={{ background: getEventDisplayColor(e, calendars, primaryColorOverride) }}
          />
          <span className="scard-tag">{e.calendarSummary}</span>
        </span>
      </span>
    </button>
  );
}

export function SearchResults({
  query,
  messages,
  loading,
  hasMore,
  onMore,
  onSelect,
  selectedId,
  calendars,
  hiddenCals,
  onLogout,
  primaryColorOverride,
}: {
  query: string;
  messages: MessageSummary[];
  loading: boolean;
  hasMore: boolean;
  onMore: () => void;
  onSelect: (id: string, threadId: string) => void;
  selectedId?: string;
  calendars: Calendar[];
  hiddenCals: Set<string>;
  onLogout: () => void;
  primaryColorOverride?: string | null;
}) {
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [evErr, setEvErr] = useState<string | null>(null);
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [detailEv, setDetailEv] = useState<CalEvent | null>(null);
  const [editor, setEditor] = useState<{
    initial: Partial<EventInput>;
    eventId?: string;
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setEvErr(null);
    api
      .calendarSearch(query)
      .then((evs) => {
        if (!cancelled) setEvents(evs);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) onLogout();
        else setEvErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [query, refreshKey, onLogout]);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setFileErr(null);
    api
      .driveFiles({ q: query })
      .then((res) => {
        if (!cancelled) setFiles(res.files);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) onLogout();
        else setFileErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [query, refreshKey, onLogout]);

  const terms = useMemo(() => searchTerms(query), [query]);

  // 다가오는 일정 먼저(오름차순), 지난 일정은 구분선 아래 최근순.
  // 숨긴 캘린더는 월/목록 뷰와 동일하게 제외 (검색에서 다시 새어나오지 않게).
  const { upcoming, past } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isPast = (e: CalEvent) => {
      const ref = e.end || e.start;
      const t = e.allDay
        ? new Date(`${ref.slice(0, 10)}T00:00:00`).getTime()
        : new Date(ref).getTime();
      return e.end ? t <= today.getTime() : t < today.getTime();
    };
    const evs = (events ?? []).filter((e) => !hiddenCals.has(e.calendarId));
    return {
      upcoming: evs.filter((e) => !isPast(e)),
      past: evs.filter(isPast).reverse(),
    };
  }, [events, hiddenCals]);
  const visibleCount = upcoming.length + past.length;

  const writable = calendars.filter(
    (c) => c.accessRole === "owner" || c.accessRole === "writer",
  );

  return (
    <div className="search-page">
      <div className="search-head">
        <h2>“{query}”</h2>
        <span className="muted">
          일정 {events ? `${visibleCount}건` : "…"} · 메일 {messages.length}
          {hasMore ? "+" : ""}건 · 드라이브 {files ? `${files.length}건` : "…"}
        </span>
      </div>
      <div className="search-cols">
        <section className="search-col">
          <div className="search-col-head"><CalendarIcon />일정</div>
          {evErr ? (
            <div className="scard-empty"><AlertIcon />{evErr}</div>
          ) : !events ? (
            <>
              <div className="skel" />
              <div className="skel" />
            </>
          ) : visibleCount === 0 ? (
            <div className="scard-empty">일치하는 일정이 없습니다.</div>
          ) : (
            <>
              {upcoming.map((e) => (
                <EventCard
                  key={`${e.calendarId}|${e.id}|${e.start}`}
                  e={e}
                  calendars={calendars}
                  primaryColorOverride={primaryColorOverride}
                  terms={terms}
                  onClick={() => setDetailEv(e)}
                />
              ))}
              {past.length > 0 && (
                <div className="search-divider">지난 일정</div>
              )}
              {past.map((e) => (
                <EventCard
                  key={`${e.calendarId}|${e.id}|${e.start}`}
                  e={e}
                  calendars={calendars}
                  primaryColorOverride={primaryColorOverride}
                  terms={terms}
                  past
                  onClick={() => setDetailEv(e)}
                />
              ))}
            </>
          )}
        </section>
        <section className="search-col">
          <div className="search-col-head"><MailIcon />메일</div>
          {messages.length === 0 && !loading ? (
            <div className="scard-empty">일치하는 메일이 없습니다.</div>
          ) : (
            messages.map((m) => (
              <MailCard
                key={m.id}
                m={m}
                terms={terms}
                active={selectedId === m.id}
                onSelect={onSelect}
              />
            ))
          )}
          {loading && (
            <>
              <div className="skel" />
              <div className="skel" />
            </>
          )}
          {hasMore && !loading && (
            <>
              <MoreSentinel onMore={onMore} />
              <button className="btn more" onClick={onMore}>
                더 보기
              </button>
            </>
          )}
        </section>
        <section className="search-col">
          <div className="search-col-head"><DriveIcon />드라이브</div>
          {fileErr ? (
            <div className="scard-empty"><AlertIcon />{fileErr}</div>
          ) : !files ? (
            <>
              <div className="skel" />
              <div className="skel" />
            </>
          ) : files.length === 0 ? (
            <div className="scard-empty">일치하는 파일이 없습니다.</div>
          ) : (
            files.map((f) => <DriveCard key={f.id} f={f} terms={terms} />)
          )}
        </section>
      </div>
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
            calCache.clear(); // calendar view caches must see the change too
            setRefreshKey((k) => k + 1);
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
            calCache.clear();
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
