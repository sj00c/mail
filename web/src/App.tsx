import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  AuthError,
  parseAddr,
  type Label,
  type CalEvent,
  type Calendar,
  type CalEventDetail,
  type EventInput,
  type MessageFull,
  type MessageSummary,
} from "./api.ts";

const SYSTEM_ORDER = ["INBOX", "STARRED", "SENT", "DRAFT", "SPAM", "TRASH"];

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .authStatus()
      .then((s) => setAuthed(s.authed))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) return <div className="center">로딩 중…</div>;
  if (!authed) return <Login />;
  return <Mailbox onLogout={() => setAuthed(false)} />;
}

function Login() {
  return (
    <div className="center login">
      <h1>📬 Mail</h1>
      <p>Gmail 계정을 연결하세요.</p>
      <a className="btn primary" href="/auth/login">
        Gmail 연결하기
      </a>
    </div>
  );
}

function Mailbox({ onLogout }: { onLogout: () => void }) {
  const [email, setEmail] = useState("");
  const [labels, setLabels] = useState<Label[]>([]);
  const [activeLabel, setActiveLabel] = useState("INBOX");
  const [view, setView] = useState<"mail" | "calendar">("mail");
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInit, setComposeInit] = useState<ComposeInit | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [hiddenCals, setHiddenCals] = useState<Set<string>>(new Set());
  const [calLoading, setCalLoading] = useState(false);
  const [calErr, setCalErr] = useState<string | null>(null);

  const guard = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        if (e instanceof AuthError) onLogout();
        else setError((e as Error).message);
      }
    },
    [onLogout],
  );

  useEffect(() => {
    void guard(async () => {
      const [p, ls] = await Promise.all([api.profile(), api.labels()]);
      setEmail(p.email);
      setLabels(ls);
    });
  }, [guard]);

  // Load the calendar list the first time the calendar view opens.
  useEffect(() => {
    if (view !== "calendar" || calendars.length > 0) return;
    let cancelled = false;
    setCalLoading(true);
    setCalErr(null);
    api
      .calendars()
      .then((cs) => {
        if (cancelled) return;
        setCalendars(cs);
        setHiddenCals(new Set(cs.filter((c) => !c.selected).map((c) => c.id)));
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) onLogout();
        else setCalErr((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setCalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, calendars.length, onLogout]);

  const toggleCal = useCallback((id: string) => {
    setHiddenCals((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const onSelectMsg = useCallback((id: string) => setSelected(id), []);

  const load = useCallback(
    (reset: boolean) => {
      void guard(async () => {
        setLoading(true);
        const res = await api.messages({
          label: query ? undefined : activeLabel,
          q: query || undefined,
          pageToken: reset ? undefined : nextToken,
        });
        setMessages((prev) => (reset ? res.messages : [...prev, ...res.messages]));
        setNextToken(res.nextPageToken);
        setLoading(false);
      });
    },
    [guard, activeLabel, query, nextToken],
  );

  useEffect(() => {
    setSelected(null);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLabel, query]);

  const refreshLabels = () =>
    guard(async () => setLabels(await api.labels()));

  const systemLabels = labels
    .filter((l) => l.type === "system" && SYSTEM_ORDER.includes(l.id))
    .sort((a, b) => SYSTEM_ORDER.indexOf(a.id) - SYSTEM_ORDER.indexOf(b.id));
  const userLabels = labels
    .filter((l) => l.type === "user")
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">📬 Mail</div>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(searchInput.trim());
          }}
        >
          <input
            placeholder="검색 (Gmail 문법: from:, subject:, has:attachment …)"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="clear"
              onClick={() => {
                setSearchInput("");
                setQuery("");
              }}
            >
              ✕
            </button>
          )}
        </form>
        <div className="account">
          <button
            className="btn primary"
            onClick={() => {
              setComposeInit(undefined);
              setComposeOpen(true);
            }}
          >
            ✏️ 새 메일
          </button>
          <span className="email">{email}</span>
          <button
            className="btn"
            onClick={() =>
              guard(async () => {
                await api.logout();
                onLogout();
              })
            }
          >
            로그아웃
          </button>
        </div>
      </header>

      {error && (
        <div className="error" onClick={() => setError(null)}>
          ⚠️ {error} (클릭하여 닫기)
        </div>
      )}

      <div className="body">
        <nav className="sidebar">
          <button
            className={`nav-section ${view === "calendar" ? "active" : ""}`}
            onClick={() => setView("calendar")}
          >
            <span className="chev">{view === "calendar" ? "▾" : "▸"}</span>
            <span>📅 캘린더</span>
          </button>
          {view === "calendar" && (
            <div className="nav-sub">
              {calLoading && <div className="nav-note">불러오는 중…</div>}
              {calErr && <div className="nav-note">{calErr}</div>}
              <CalendarChecklist
                title="내 캘린더"
                items={calendars.filter(
                  (c) => c.primary || c.accessRole === "owner",
                )}
                hidden={hiddenCals}
                onToggle={toggleCal}
              />
              <CalendarChecklist
                title="다른 캘린더"
                items={calendars.filter(
                  (c) => !(c.primary || c.accessRole === "owner"),
                )}
                hidden={hiddenCals}
                onToggle={toggleCal}
              />
            </div>
          )}

          <button
            className={`nav-section ${view === "mail" ? "active" : ""}`}
            onClick={() => {
              setView("mail");
              setQuery("");
              setSearchInput("");
            }}
          >
            <span className="chev">{view === "mail" ? "▾" : "▸"}</span>
            <span>📬 메일</span>
          </button>
          {view === "mail" && (
            <div className="nav-sub">
              {systemLabels.map((l) => (
                <LabelRow
                  key={l.id}
                  label={l}
                  active={!query && activeLabel === l.id}
                  onClick={() => {
                    setQuery("");
                    setSearchInput("");
                    setActiveLabel(l.id);
                  }}
                />
              ))}
              {userLabels.length > 0 && <div className="sidebar-sep">라벨</div>}
              {userLabels.map((l) => (
                <LabelRow
                  key={l.id}
                  label={l}
                  active={!query && activeLabel === l.id}
                  onClick={() => {
                    setQuery("");
                    setSearchInput("");
                    setActiveLabel(l.id);
                  }}
                />
              ))}
            </div>
          )}
        </nav>

        {view === "calendar" ? (
          <CalendarView
            onLogout={onLogout}
            hiddenCals={hiddenCals}
            calendars={calendars}
          />
        ) : (
          <>
            <section className="list">
              {messages.length === 0 && !loading && (
                <div className="empty">메일이 없습니다.</div>
              )}
              {messages.map((m) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  active={selected === m.id}
                  onSelect={onSelectMsg}
                />
              ))}
              {loading && <div className="empty">불러오는 중…</div>}
              {nextToken && !loading && (
                <button className="btn more" onClick={() => load(false)}>
                  더 보기
                </button>
              )}
            </section>

            <section className="reader">
              {selected ? (
                <Reader
                  id={selected}
                  guard={guard}
                  onChanged={() => {
                    load(true);
                    refreshLabels();
                  }}
                  onReply={(init) => {
                    setComposeInit(init);
                    setComposeOpen(true);
                  }}
                  onClose={() => setSelected(null)}
                />
              ) : (
                <div className="empty">메일을 선택하세요.</div>
              )}
            </section>
          </>
        )}
      </div>

      {composeOpen && (
        <Compose
          init={composeInit}
          guard={guard}
          onClose={() => setComposeOpen(false)}
          onSent={() => {
            setComposeOpen(false);
            load(true);
          }}
        />
      )}
    </div>
  );
}

function LabelRow({
  label,
  active,
  onClick,
}: {
  label: Label;
  active: boolean;
  onClick: () => void;
}) {
  const name =
    { INBOX: "받은편지함", STARRED: "별표", SENT: "보낸편지함", DRAFT: "임시보관함", SPAM: "스팸", TRASH: "휴지통" }[
      label.id
    ] ?? label.name;
  return (
    <button className={`label-row ${active ? "active" : ""}`} onClick={onClick}>
      <span>{name}</span>
      {label.unread > 0 && <span className="badge">{label.unread}</span>}
    </button>
  );
}

function CalendarChecklist({
  title,
  items,
  hidden,
  onToggle,
}: {
  title: string;
  items: Calendar[];
  hidden: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <div className="sidebar-sep">{title}</div>
      {items.map((c) => {
        const color = c.backgroundColor ?? "#1a73e8";
        const on = !hidden.has(c.id);
        return (
          <label key={c.id} className="cal-check" title={c.summary}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => onToggle(c.id)}
              style={{ accentColor: color }}
            />
            <span className="cal-check-name">{c.summary}</span>
          </label>
        );
      })}
    </>
  );
}

const MessageRow = memo(function MessageRow({
  m,
  active,
  onSelect,
}: {
  m: MessageSummary;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const from = parseAddr(m.from).name;
  const date = new Date(m.date);
  const now = new Date();
  const label =
    date.toDateString() === now.toDateString()
      ? date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
  return (
    <button
      className={`msg-row ${active ? "active" : ""} ${m.unread ? "unread" : ""}`}
      onClick={() => onSelect(m.id)}
    >
      <div className="msg-top">
        <span className="msg-from">{from}</span>
        <span className="msg-date">{label}</span>
      </div>
      <div className="msg-subject">
        {m.subject || "(제목 없음)"}
        {m.hasAttachments && <span className="paperclip"> 📎</span>}
      </div>
      <div className="msg-snippet">{m.snippet}</div>
    </button>
  );
});

function Reader({
  id,
  guard,
  onChanged,
  onReply,
  onClose,
}: {
  id: string;
  guard: (fn: () => Promise<void>) => Promise<void>;
  onChanged: () => void;
  onReply: (init: ComposeInit) => void;
  onClose: () => void;
}) {
  const [msg, setMsg] = useState<MessageFull | null>(null);
  const [thread, setThread] = useState<MessageFull[] | null>(null);

  useEffect(() => {
    setMsg(null);
    setThread(null);
    void guard(async () => {
      const m = await api.message(id);
      setMsg(m);
      if (m.unread) {
        await api.modify(id, { remove: ["UNREAD"] });
        onChanged();
      }
      setThread(await api.thread(m.threadId));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!msg) return <div className="empty">불러오는 중…</div>;

  return (
    <div className="reader-inner">
      <div className="reader-head">
        <h2>{msg.subject || "(제목 없음)"}</h2>
        <div className="reader-actions">
          <button
            className="btn"
            onClick={() =>
              onReply({
                to: parseAddr(msg.from).email,
                subject: msg.subject.startsWith("Re:")
                  ? msg.subject
                  : `Re: ${msg.subject}`,
                threadId: msg.threadId,
                inReplyTo: msg.id,
                quote: msg.bodyText ?? "",
                quoteFrom: msg.from,
              })
            }
          >
            ↩ 답장
          </button>
          <button
            className="btn"
            onClick={() =>
              guard(async () => {
                const starred = msg.labelIds.includes("STARRED");
                await api.modify(id, {
                  add: starred ? [] : ["STARRED"],
                  remove: starred ? ["STARRED"] : [],
                });
                onChanged();
                setMsg({
                  ...msg,
                  labelIds: starred
                    ? msg.labelIds.filter((l) => l !== "STARRED")
                    : [...msg.labelIds, "STARRED"],
                });
              })
            }
          >
            {msg.labelIds.includes("STARRED") ? "★ 별표 해제" : "☆ 별표"}
          </button>
          <button
            className="btn"
            onClick={() =>
              guard(async () => {
                await api.modify(id, {
                  add: msg.unread ? [] : ["UNREAD"],
                  remove: msg.unread ? ["UNREAD"] : [],
                });
                onChanged();
                setMsg({ ...msg, unread: !msg.unread });
              })
            }
          >
            {msg.unread ? "읽음" : "안읽음"}
          </button>
          <button
            className="btn"
            onClick={() =>
              guard(async () => {
                await api.modify(id, { remove: ["INBOX"] });
                onChanged();
                onClose();
              })
            }
          >
            📥 보관
          </button>
          <button
            className="btn"
            onClick={() =>
              guard(async () => {
                const isSpam = msg.labelIds.includes("SPAM");
                await api.modify(id, {
                  add: isSpam ? ["INBOX"] : ["SPAM"],
                  remove: isSpam ? ["SPAM"] : ["INBOX"],
                });
                onChanged();
                onClose();
              })
            }
          >
            {msg.labelIds.includes("SPAM") ? "✅ 스팸 아님" : "🚫 스팸"}
          </button>
          <button
            className="btn danger"
            onClick={() =>
              guard(async () => {
                await api.trash(id);
                onChanged();
                onClose();
              })
            }
          >
            🗑 삭제
          </button>
        </div>
      </div>
      {(thread ?? [msg]).map((tm) => (
        <ThreadMessage key={tm.id} m={tm} />
      ))}
    </div>
  );
}

function ThreadMessage({ m }: { m: MessageFull }) {
  return (
    <div className="thread-msg">
      <div className="reader-meta">
        <strong>{parseAddr(m.from).name}</strong>{" "}
        <span className="muted">&lt;{parseAddr(m.from).email}&gt;</span>
        <div className="muted">받는사람: {m.to}</div>
        {m.cc && <div className="muted">참조: {m.cc}</div>}
        <div className="muted">{new Date(m.date).toLocaleString("ko-KR")}</div>
      </div>
      {m.attachments.length > 0 && (
        <div className="attachments">
          {m.attachments.map((a) => (
            <a
              key={a.id}
              className="chip"
              href={api.attachmentUrl(m.id, a.id, a.filename)}
            >
              📎 {a.filename} ({Math.round(a.size / 1024)}KB)
            </a>
          ))}
        </div>
      )}
      <div className="reader-body">
        {m.bodyHtml ? (
          <iframe
            title={`message-${m.id}`}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={prepareEmailHtml(m.bodyHtml)}
            className="html-frame"
          />
        ) : (
          <pre className="text-body">{m.bodyText || m.snippet}</pre>
        )}
      </div>
    </div>
  );
}

type ComposeInit = {
  to?: string;
  cc?: string;
  subject?: string;
  threadId?: string;
  inReplyTo?: string;
  quote?: string;
  quoteFrom?: string;
};

function Compose({
  init,
  guard,
  onClose,
  onSent,
}: {
  init?: ComposeInit;
  guard: (fn: () => Promise<void>) => Promise<void>;
  onClose: () => void;
  onSent: () => void;
}) {
  const quoted = init?.quote
    ? `\n\n\n--- ${init.quoteFrom ?? ""} 작성 ---\n` +
      init.quote
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")
    : "";
  const [to, setTo] = useState(init?.to ?? "");
  const [cc, setCc] = useState(init?.cc ?? "");
  const [subject, setSubject] = useState(init?.subject ?? "");
  const [body, setBody] = useState(quoted);
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<
    { filename: string; mimeType: string; data: string; size: number }[]
  >([]);

  const send = () =>
    guard(async () => {
      setSending(true);
      try {
        await api.send({
          to,
          cc: cc || undefined,
          subject,
          body,
          threadId: init?.threadId,
          inReplyTo: init?.inReplyTo,
          references: init?.inReplyTo,
          attachments: files.length
            ? files.map(({ filename, mimeType, data }) => ({
                filename,
                mimeType,
                data,
              }))
            : undefined,
        });
        onSent();
      } finally {
        setSending(false);
      }
    });

  const saveDraft = () =>
    guard(async () => {
      setSending(true);
      try {
        await api.saveDraft({
          to,
          cc: cc || undefined,
          subject,
          body,
          threadId: init?.threadId,
          inReplyTo: init?.inReplyTo,
          references: init?.inReplyTo,
          attachments: files.length
            ? files.map(({ filename, mimeType, data }) => ({
                filename,
                mimeType,
                data,
              }))
            : undefined,
        });
        onClose();
      } finally {
        setSending(false);
      }
    });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>새 메일</strong>
          <button className="clear" onClick={onClose}>
            ✕
          </button>
        </div>
        <input
          placeholder="받는사람"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <input
          placeholder="참조 (선택)"
          value={cc}
          onChange={(e) => setCc(e.target.value)}
        />
        <input
          placeholder="제목"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <textarea
          placeholder="내용"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {files.length > 0 && (
          <div className="compose-atts">
            {files.map((f, i) => (
              <span key={`${f.filename}-${i}`} className="chip">
                📎 {f.filename} ({Math.round(f.size / 1024)}KB)
                <button
                  type="button"
                  className="chip-x"
                  onClick={() =>
                    setFiles((p) => p.filter((_, j) => j !== i))
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="modal-foot">
          <label className="btn">
            📎 파일 첨부
            <input
              type="file"
              multiple
              hidden
              onChange={async (e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = "";
                const read = await Promise.all(picked.map(fileToBase64));
                setFiles((p) => [...p, ...read]);
              }}
            />
          </label>
          <span className="modal-spacer" />
          <button
            className="btn"
            disabled={sending}
            onClick={saveDraft}
          >
            임시저장
          </button>
          <button
            className="btn primary"
            disabled={sending || !to}
            onClick={send}
          >
            {sending ? "보내는 중…" : "보내기"}
          </button>
        </div>
      </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<{
  filename: string;
  mimeType: string;
  data: string;
  size: number;
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const data = result.slice(result.indexOf(",") + 1);
      resolve({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        data,
        size: file.size,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function CalendarView({
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

type CalRange = { days?: number; from?: string; to?: string };

// Module-level stale-while-revalidate cache so flipping between months
// (or mail<->calendar) is instant and avoids redundant API fan-out.
const calCache = new Map<string, { events: CalEvent[]; ts: number }>();
const CAL_FRESH_MS = 30_000;
const rangeKey = (r: CalRange) => `${r.days ?? ""}|${r.from ?? ""}|${r.to ?? ""}`;

function useCalendarEvents(
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

function CalReauth({ err }: { err: string }) {
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

function MonthGrid({
  onLogout,
  hiddenCals,
  onEvent,
  onDay,
  refreshKey,
}: {
  onLogout: () => void;
  hiddenCals: Set<string>;
  onEvent: (e: CalEvent) => void;
  onDay: (key: string, events: CalEvent[]) => void;
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
      const key = e.allDay ? e.start.slice(0, 10) : localDayKey(e.start);
      const bucket = map.get(key);
      if (bucket) bucket.push(e);
      else map.set(key, [e]);
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
        <div className="month-grid">
          {["일", "월", "화", "수", "목", "금", "토"].map((w) => (
            <div key={w} className="month-dow">
              {w}
            </div>
          ))}
          {cells.map((d) => {
            const key = dateKey(d);
            const evs = byDay.get(key) ?? [];
            const other = d.getMonth() !== cursor.getMonth();
            return (
              <div
                key={key}
                className={`month-cell${other ? " other" : ""}${key === todayKey ? " today" : ""}`}
              >
                <div className="month-daynum">{d.getDate()}</div>
                {evs.slice(0, 3).map((e) => (
                  <button
                    key={e.id + e.start}
                    type="button"
                    className="month-ev"
                    onClick={() => onEvent(e)}
                    title={`${e.allDay ? "종일" : formatTime(e.start)} ${e.summary}`}
                  >
                    <span
                      className="month-ev-dot"
                      style={{ background: e.color ?? "#1a73e8" }}
                    />
                    <span className="month-ev-t">
                      {e.allDay ? "" : `${formatTime(e.start)} `}
                      {e.summary}
                    </span>
                  </button>
                ))}
                {evs.length > 3 && (
                  <button
                    type="button"
                    className="month-more"
                    onClick={() => onDay(key, evs)}
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

function AgendaList({
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
    const out: [string, CalEvent[]][] = [];
    const index = new Map<string, CalEvent[]>();
    for (const e of events ?? []) {
      if (hiddenCals.has(e.calendarId)) continue;
      const key = e.allDay ? e.start.slice(0, 10) : localDayKey(e.start);
      let bucket = index.get(key);
      if (!bucket) {
        bucket = [];
        index.set(key, bucket);
        out.push([key, bucket]);
      }
      bucket.push(e);
    }
    return out;
  }, [events, hiddenCals]);

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
      ) : events.length === 0 ? (
        <div className="empty">예정된 일정이 없습니다.</div>
      ) : (
        groups.map(([key, evs]) => (
          <div key={key} className="cal-day">
            <div className="cal-date">{formatDayHeader(key)}</div>
            {evs.map((e) => (
              <button
                key={e.id + e.start}
                type="button"
                className="cal-event"
                onClick={() => onEvent(e)}
              >
                <span
                  className="cal-dot"
                  style={{ background: e.color ?? "#1a73e8" }}
                />
                <span className="cal-time">
                  {e.allDay ? "종일" : formatTime(e.start)}
                </span>
                <span className="cal-title">{e.summary}</span>
                {e.location && <span className="cal-loc">📍 {e.location}</span>}
                <span className="cal-cal">{e.calendarSummary}</span>
              </button>
            ))}
          </div>
        ))
      )}
      </div>
    </>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localDayKey(iso: string): string {
  return dateKey(new Date(iso));
}

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setDate(x.getDate() - x.getDay());
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + (6 - x.getDay()));
  x.setHours(0, 0, 0, 0);
  return x;
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDayHeader(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const isToday = date.toDateString() === today.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const base = date.toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
  if (isToday) return `오늘 · ${base}`;
  if (isTomorrow) return `내일 · ${base}`;
  return base;
}

function DayEventsModal({
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
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{formatDayHeader(dayKey)}</strong>
          <button className="clear" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="day-list">
          {events.map((e) => (
            <button
              key={e.id + e.start}
              type="button"
              className="cal-event"
              onClick={() => onEvent(e)}
            >
              <span
                className="cal-dot"
                style={{ background: e.color ?? "#1a73e8" }}
              />
              <span className="cal-time">
                {e.allDay ? "종일" : formatTime(e.start)}
              </span>
              <span className="cal-title">{e.summary}</span>
              {e.location && <span className="cal-loc">📍 {e.location}</span>}
              <span className="cal-cal">{e.calendarSummary}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function EventDetailModal({
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
        else setErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [ev.calendarId, ev.id, onLogout]);

  const d = detail;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>일정</strong>
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
          {err && (
            <div className="ev-row muted">상세를 불러오지 못했습니다: {err}</div>
          )}
          {d?.description && (
            <iframe
              title="event-description"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              className="ev-desc"
              srcDoc={prepareEmailHtml(
                d.description,
                "font-family:-apple-system,sans-serif;font-size:13px;color:#202124;margin:0;white-space:pre-wrap;word-break:break-word",
              )}
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
                    setErr((e as Error).message);
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
      </div>
    </div>
  );
}

function formatEventWhen(e: CalEvent): string {
  if (e.allDay) {
    const s = new Date(`${e.start}T00:00:00`);
    return `${s.toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    })} · 종일`;
  }
  const s = new Date(e.start);
  const date = s.toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
  const st = s.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  if (!e.end) return `${date} ${st}`;
  const en = new Date(e.end);
  const et = en.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  if (s.toDateString() === en.toDateString()) return `${date} ${st} – ${et}`;
  const ed = en.toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
  return `${date} ${st} – ${ed} ${et}`;
}

// Rendered email/description HTML lives in a sandboxed iframe (no scripts).
// Rewrite every link to open in a new top-level tab and drop the referrer,
// so links actually work (instead of navigating inside the sandboxed frame -> 403).
function prepareEmailHtml(html: string, bodyStyle?: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    let base = doc.querySelector("base");
    if (!base) {
      base = doc.createElement("base");
      doc.head.prepend(base);
    }
    base.setAttribute("target", "_blank");
    const meta = doc.createElement("meta");
    meta.setAttribute("name", "referrer");
    meta.setAttribute("content", "no-referrer");
    doc.head.prepend(meta);
    doc.querySelectorAll("a[href]").forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });
    if (bodyStyle) {
      const prev = doc.body.getAttribute("style") ?? "";
      doc.body.setAttribute("style", `${bodyStyle};${prev}`);
    }
    return `<!doctype html>${doc.documentElement.outerHTML}`;
  } catch {
    return `<base target="_blank">${html}`;
  }
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function ymdhm(d: Date): string {
  return `${ymd(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function addDays(ymdStr: string, n: number): string {
  const d = new Date(`${ymdStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function EventEditModal({
  calendars,
  initial,
  eventId,
  onClose,
  onSaved,
}: {
  calendars: Calendar[];
  initial: Partial<EventInput>;
  eventId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const init = (() => {
    if (initial.start) {
      if (initial.allDay) {
        const s = initial.start.slice(0, 10);
        const e = initial.end ? addDays(initial.end.slice(0, 10), -1) : s;
        return { allDay: true, start: s, end: e < s ? s : e };
      }
      return {
        allDay: false,
        start: ymdhm(new Date(initial.start)),
        end: ymdhm(new Date(initial.end || initial.start)),
      };
    }
    const n = new Date();
    n.setMinutes(0, 0, 0);
    n.setHours(n.getHours() + 1);
    return {
      allDay: false,
      start: ymdhm(n),
      end: ymdhm(new Date(n.getTime() + 3_600_000)),
    };
  })();

  const [calendarId, setCalendarId] = useState(
    initial.calendarId ||
      calendars.find((c) => c.primary)?.id ||
      calendars[0]?.id ||
      "",
  );
  const [summary, setSummary] = useState(initial.summary ?? "");
  const [allDay, setAllDay] = useState(init.allDay);
  const [start, setStart] = useState(init.start);
  const [end, setEnd] = useState(init.end);
  const [location, setLocation] = useState(initial.location ?? "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleAllDay = (v: boolean) => {
    if (v === allDay) return;
    if (v) {
      setStart(start.slice(0, 10));
      setEnd(end.slice(0, 10));
    } else {
      setStart(`${start.slice(0, 10)}T09:00`);
      setEnd(`${end.slice(0, 10)}T10:00`);
    }
    setAllDay(v);
  };

  const save = async () => {
    if (!calendarId) return setErr("쓸 수 있는 캘린더가 없습니다.");
    setBusy(true);
    setErr(null);
    try {
      const body: EventInput = {
        calendarId,
        summary,
        allDay,
        location,
        description,
        start: allDay ? start : new Date(start).toISOString(),
        end: allDay ? addDays(end, 1) : new Date(end).toISOString(),
      };
      if (eventId) await api.updateEvent(eventId, body);
      else await api.createEvent(body);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{eventId ? "일정 수정" : "새 일정"}</strong>
          <button className="clear" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="ev-form">
          <input
            className="ev-input"
            placeholder="제목"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
          <label className="ev-allday">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => toggleAllDay(e.target.checked)}
            />
            종일
          </label>
          <div className="ev-times">
            <input
              className="ev-input"
              type={allDay ? "date" : "datetime-local"}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <span>→</span>
            <input
              className="ev-input"
              type={allDay ? "date" : "datetime-local"}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
          {calendars.length > 1 && (
            <select
              className="ev-input"
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
            >
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.summary}
                </option>
              ))}
            </select>
          )}
          <input
            className="ev-input"
            placeholder="장소 (선택)"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
          <textarea
            className="ev-input"
            placeholder="설명 (선택)"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {err && <div className="ev-row muted">⚠️ {err}</div>}
        </div>
        <div className="modal-foot">
          <span className="modal-spacer" />
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button
            className="btn primary"
            disabled={busy || !summary.trim()}
            onClick={save}
          >
            {busy ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
