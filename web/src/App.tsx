import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  AuthError,
  parseAddr,
  type Label,
  type CalEvent,
  type Calendar,
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
          <CalendarView onLogout={onLogout} hiddenCals={hiddenCals} />
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

  useEffect(() => {
    setMsg(null);
    void guard(async () => {
      const m = await api.message(id);
      setMsg(m);
      if (m.unread) {
        await api.modify(id, { remove: ["UNREAD"] });
        onChanged();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!msg) return <div className="empty">불러오는 중…</div>;

  const fromName = parseAddr(msg.from).name;
  return (
    <div className="reader-inner">
      <div className="reader-head">
        <h2>{msg.subject || "(제목 없음)"}</h2>
        <div className="reader-meta">
          <strong>{fromName}</strong>{" "}
          <span className="muted">&lt;{parseAddr(msg.from).email}&gt;</span>
          <div className="muted">받는사람: {msg.to}</div>
          {msg.cc && <div className="muted">참조: {msg.cc}</div>}
          <div className="muted">
            {new Date(msg.date).toLocaleString("ko-KR")}
          </div>
        </div>
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
        {msg.attachments.length > 0 && (
          <div className="attachments">
            {msg.attachments.map((a) => (
              <a
                key={a.id}
                className="chip"
                href={api.attachmentUrl(id, a.id, a.filename)}
              >
                📎 {a.filename} ({Math.round(a.size / 1024)}KB)
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="reader-body">
        {msg.bodyHtml ? (
          <iframe
            title="message"
            sandbox=""
            srcDoc={msg.bodyHtml}
            className="html-frame"
          />
        ) : (
          <pre className="text-body">{msg.bodyText || msg.snippet}</pre>
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
}: {
  onLogout: () => void;
  hiddenCals: Set<string>;
}) {
  const [mode, setMode] = useState<"month" | "agenda">("month");
  return (
    <div className="calendar">
      <div className="cal-head">
        <h2>📅 캘린더</h2>
        <div className="cal-modes">
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
        <MonthGrid onLogout={onLogout} hiddenCals={hiddenCals} />
      ) : (
        <AgendaList onLogout={onLogout} hiddenCals={hiddenCals} />
      )}
    </div>
  );
}

function useCalendarEvents(
  range: { days?: number; from?: string; to?: string },
  deps: unknown[],
  onLogout: () => void,
) {
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetchEvents = (silent: boolean) => {
      if (!silent) setEvents(null);
      api
        .calendarEvents(range)
        .then((evs) => {
          if (cancelled) return;
          setEvents(evs);
          setErr(null);
        })
        .catch((e) => {
          if (cancelled) return;
          if (e instanceof AuthError) onLogout();
          else if (!silent) setErr((e as Error).message);
        });
    };
    fetchEvents(false);
    // Auto-refresh every 60s while the tab is visible, and whenever it regains focus.
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") fetchEvents(true);
    }, 60_000);
    const onFocus = () => {
      if (document.visibilityState === "visible") fetchEvents(true);
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
}: {
  onLogout: () => void;
  hiddenCals: Set<string>;
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
    [cursor.getTime(), onLogout],
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
                {evs.slice(0, 4).map((e) => (
                  <a
                    key={e.id + e.start}
                    className="month-ev"
                    href={e.htmlLink}
                    target="_blank"
                    rel="noreferrer"
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
                  </a>
                ))}
                {evs.length > 4 && (
                  <div className="month-more">+{evs.length - 4}</div>
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
}: {
  onLogout: () => void;
  hiddenCals: Set<string>;
}) {
  const [days, setDays] = useState(30);
  const { events, err } = useCalendarEvents({ days }, [days, onLogout], onLogout);

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
              <a
                key={e.id + e.start}
                className="cal-event"
                href={e.htmlLink}
                target="_blank"
                rel="noreferrer"
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
              </a>
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
