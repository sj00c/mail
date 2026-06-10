import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  AuthError,
  HttpError,
  parseAddr,
  splitAddrList,
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
  // A failed status check is "server unreachable", not "logged out" —
  // rendering Login would point a logged-in user at a dead OAuth link.
  const [bootErr, setBootErr] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setBootErr(false);
    api
      .authStatus()
      .then((s) => setAuthed(s.authed))
      .catch(() => setBootErr(true));
  }, [retry]);

  if (bootErr) {
    return (
      <div className="center login">
        <h1>📬 Mail</h1>
        <p>서버에 연결할 수 없습니다.</p>
        <button className="btn primary" onClick={() => setRetry((r) => r + 1)}>
          다시 시도
        </button>
      </div>
    );
  }
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
  // ?q= deep link: 검색 결과 페이지를 URL로 바로 열 수 있다.
  const initialQuery = (() => {
    try {
      return new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
    } catch {
      return "";
    }
  })();
  const [query, setQuery] = useState(initialQuery);
  const [searchInput, setSearchInput] = useState(initialQuery);
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const messagesRef = useRef<MessageSummary[]>([]);
  messagesRef.current = messages; // stable lookup for row-click routing
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<{ id: string; threadId: string } | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const composeOpenRef = useRef(composeOpen);
  composeOpenRef.current = composeOpen;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composeInit, setComposeInit] = useState<ComposeInit | undefined>();
  // Remount key: a new init must never re-skin a mounted editor mid-edit
  // (overlapping draft opens would save A's content under B's draftId).
  const [composeKey, setComposeKey] = useState(0);
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
      // Signature is account-scoped: when a different account logs in on
      // this browser, the previous owner's signature must not ride along
      // on outgoing mail. Same-account re-login keeps it.
      try {
        const prev = localStorage.getItem(ACCOUNT_KEY);
        if (prev && prev !== p.email) {
          localStorage.removeItem(SIGNATURE_KEY);
          localStorage.removeItem(SIGNATURE_HTML_KEY);
        }
        localStorage.setItem(ACCOUNT_KEY, p.email);
        // OAuth만으로 설정이 딸려오지는 않으므로 서명은 여기서 끌어온다:
        // 계정당 1회, 로컬 서명이 비어 있을 때만 — 사용자가 설정에서 직접
        // 쓰거나 지운 서명을 자동 동기화가 덮어쓰면 안 된다.
        if (localStorage.getItem(SIGNATURE_SYNC_KEY) !== p.email) {
          if (!localStorage.getItem(SIGNATURE_KEY)) {
            try {
              const { html } = await api.signature();
              if (html) {
                localStorage.setItem(SIGNATURE_HTML_KEY, html);
                localStorage.setItem(SIGNATURE_KEY, htmlToText(html));
              }
            } catch {
              // non-fatal: 설정의 수동 가져오기 버튼이 그대로 남아 있다
            }
          }
          localStorage.setItem(SIGNATURE_SYNC_KEY, p.email);
        }
      } catch {
        // private mode etc.
      }
    });
  }, [guard]);

  // A file dropped outside a drop zone must not navigate the tab away
  // (which silently destroys an open compose).
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  // Load the calendar list the first time the calendar view opens — or the
  // first search (검색 결과의 일정 카드가 수정 권한 판단에 필요).
  useEffect(() => {
    if ((view !== "calendar" && !query) || calendars.length > 0) return;
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
  }, [view, query, calendars.length, onLogout]);

  const toggleCal = useCallback((id: string) => {
    setHiddenCals((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // In-flight openDraft invalidation — see openDraft below.
  const openDraftSeq = useRef(0);

  // Every compose entry point goes through here: bumping the key remounts
  // the editor so a late-arriving init can never re-skin a mid-edit editor.
  const openCompose = useCallback((init?: ComposeInit) => {
    // Any compose open also invalidates pending openDraft flows — a slow
    // draft fetch resolving later must not remount (and wipe) this editor.
    openDraftSeq.current++;
    setComposeInit(init);
    setComposeKey((k) => k + 1);
    setComposeOpen(true);
  }, []);

  // Draft rows open the editor (이어쓰기), everything else opens the reader.
  // openDraft is a multi-await flow — only the latest click may open.
  const openDraft = useCallback(
    (id: string, threadId: string) => {
      const seq = ++openDraftSeq.current;
      return guard(async () => {
        const msgs = await api.thread(threadId);
        // drafts.update rotates the underlying message id, so a stale list row
        // may carry an old id — fall back to the thread's DRAFT message.
        const full =
          msgs.find((x) => x.id === id) ??
          [...msgs].reverse().find((x) => x.labelIds.includes("DRAFT"));
        if (!full) throw new Error("드래프트를 불러오지 못했습니다.");
        // 404 → the draft wrapper is gone (sent elsewhere): edit as new mail.
        // Any other failure must propagate — silently treating a transient
        // error as "new mail" would duplicate the draft on send.
        const found = await api.draftByMessage(full.id).catch((e) => {
          if (e instanceof HttpError && e.status === 404) return null;
          throw e;
        });
        const attachments = await Promise.all(
          full.attachments
            .filter((a) => !a.contentId) // inline images belong to the HTML body
            .map((a) => downloadAttachment(full.id, a)),
        );
        if (seq !== openDraftSeq.current) return; // superseded by a later click
        openCompose({
          draftId: found?.draftId,
          to: full.to,
          cc: full.cc || undefined,
          bcc: full.bcc || undefined, // Gmail-web drafts may carry Bcc
          subject: full.subject,
          // our drafts are text/plain (lossless); Gmail-web HTML drafts fall
          // back to clean text extraction
          body: full.bodyText ?? quoteText(full),
          // a resumed reply draft must keep its threading headers
          inReplyTo: full.inReplyTo || undefined,
          references: full.references || undefined,
          richWarning: !full.bodyText && !!full.bodyHtml,
          threadId: full.threadId,
          attachments,
        });
      });
    },
    [guard, openCompose],
  );

  const onSelectMsg = useCallback(
    (id: string, threadId: string) => {
      const row = messagesRef.current.find((m) => m.id === id);
      if (row?.labelIds.includes("DRAFT")) void openDraft(id, threadId);
      else setSelected({ id, threadId });
    },
    [openDraft],
  );

  // ---- new-mail polling: desktop notification + inbox refresh ----
  const lastSeenIds = useRef<string[] | null>(null);
  const newestSeenDate = useRef("");
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, []);

  // Mirror list params into refs so load() can stay referentially stable:
  // a stale load closure captured by an effect or in-flight callback would
  // otherwise fetch the previous label/query and overwrite the list.
  const labelRef = useRef(activeLabel);
  labelRef.current = activeLabel;
  const queryRef = useRef(query);
  queryRef.current = query;
  const nextTokenRef = useRef(nextToken);
  nextTokenRef.current = nextToken;

  // Monotonic sequence guard: label switches / polling / 더 보기 responses can
  // land out of order — only the latest request may write list state.
  const loadSeq = useRef(0);
  const load = useCallback(
    (reset: boolean) => {
      const seq = ++loadSeq.current;
      void guard(async () => {
        setLoading(true);
        try {
          try {
            const res = await api.messages({
              label: queryRef.current ? undefined : labelRef.current,
              q: queryRef.current || undefined,
              pageToken: reset ? undefined : nextTokenRef.current,
            });
            if (seq !== loadSeq.current) return; // superseded — discard
            setMessages((prev) => (reset ? res.messages : [...prev, ...res.messages]));
            setNextToken(res.nextPageToken);
          } catch (e) {
            // A superseded request's failure is as irrelevant as its result —
            // don't raise an error banner over a correctly loaded newer list.
            if (seq !== loadSeq.current && !(e instanceof AuthError)) return;
            throw e;
          }
        } finally {
          if (seq === loadSeq.current) setLoading(false);
        }
      });
    },
    [guard],
  );

  // Targeted list updates: full reloads reset pagination ("더 보기" pages
  // vanish), so star/read changes patch the row and removals filter it.
  const patchMessage = useCallback((id: string, patch: Partial<MessageSummary>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);
  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // Selection requested by a notification click — the label-change effect
  // below would otherwise wipe it (it resets selection on label switch).
  const pendingSelect = useRef<{
    label: string;
    sel: { id: string; threadId: string };
    at: number;
  } | null>(null);

  useEffect(() => {
    const p = pendingSelect.current;
    pendingSelect.current = null;
    if (p && p.label === activeLabel && Date.now() - p.at < 5_000) {
      setSelected(p.sel);
    } else {
      setSelected(null);
    }
    // A failed first-page fetch must not leave the previous label's rows (and
    // its cross-query nextToken behind 더 보기) rendered under the new label.
    setMessages([]);
    setNextToken(undefined);
    load(true);
  }, [activeLabel, query, load]);

  const refreshLabels = useCallback(
    () => guard(async () => setLabels(await api.labels())),
    [guard],
  );

  // Poll INBOX (60s, visible tab only): notify on new unread mail and keep
  // the list/labels fresh. Polling is the right call here — Gmail push
  // (Pub/Sub watch) needs a public webhook this 보안망-local app can't have.
  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await api.messages({ label: "INBOX", maxResults: 5 });
        const top = res.messages[0];
        if (!top) return;
        const seenIds = lastSeenIds.current;
        if (seenIds && top.id !== seenIds[0]) {
          // Set difference, not top-id walk: deleting/archiving the top mail
          // must not make old mail look "new" (false notifications).
          const fresh = res.messages.filter((m) => !seenIds.includes(m.id));
          // Date gate on top: old mail scrolling back into the 5-item window
          // (after deletions above it) is not "new" either.
          const freshNew = fresh.filter((m) => m.date > newestSeenDate.current);
          if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            for (const m of freshNew.filter((x) => x.unread).slice(0, 3)) {
              const n = new Notification(parseAddr(m.from).name, {
                body: m.subject || m.snippet,
                tag: m.id,
              });
              n.onclick = () => {
                window.focus();
                setView("mail");
                pendingSelect.current = {
                  label: "INBOX",
                  sel: { id: m.id, threadId: m.threadId },
                  at: Date.now(),
                };
                setActiveLabel("INBOX");
                setSelected({ id: m.id, threadId: m.threadId });
                n.close();
              };
            }
          }
          if (fresh.length > 0) {
            void refreshLabels();
            // Refresh even while the calendar view hides the list — otherwise
            // the seen-ids update below consumes the new-mail signal and the
            // inbox stays stale after switching back.
            if (activeLabel === "INBOX" && !query) load(true);
          }
        }
        lastSeenIds.current = res.messages.map((m) => m.id);
        for (const m of res.messages) {
          if (m.date > newestSeenDate.current) newestSeenDate.current = m.date;
        }
      } catch (e) {
        // Dead session: return to login instead of silently never polling
        // again — but never while the compose editor holds typed text (the
        // unmount would destroy it; user-initiated actions surface the
        // session error inside the editor instead).
        if (e instanceof AuthError && !composeOpenRef.current) onLogout();
        // other transient polling failures: next tick retries
      }
    };
    void tick();
    const iv = setInterval(tick, 60_000);
    return () => clearInterval(iv);
  }, [activeLabel, query, load, refreshLabels, onLogout]);

  const systemLabels = labels
    .filter((l) => l.type === "system" && SYSTEM_ORDER.includes(l.id))
    .sort((a, b) => SYSTEM_ORDER.indexOf(a.id) - SYSTEM_ORDER.indexOf(b.id));
  const userLabels = labels
    .filter((l) => l.type === "user")
    .sort((a, b) => a.name.localeCompare(b.name));

  // Shared between the normal reader pane and the search slide-over.
  const readerEl = selected ? (
    <Reader
      id={selected.id}
      threadId={selected.threadId}
      me={email}
      guard={guard}
      onPatched={(id, patch) => {
        // Un-starring while viewing 별표 removes the row — patching in
        // place would leave a non-starred mail in the list.
        if (
          !query &&
          activeLabel === "STARRED" &&
          patch.labelIds &&
          !patch.labelIds.includes("STARRED")
        ) {
          removeMessage(id);
        } else {
          patchMessage(id, patch);
        }
        void refreshLabels();
      }}
      onRemoved={(id, scope) => {
        // Archive only removes the row from the inbox view; 스팸 moves
        // disappear from every normal view; 삭제 disappears everywhere
        // EXCEPT the 휴지통 view (trash keeps it there).
        const keep =
          scope === "inbox"
            ? query || activeLabel !== "INBOX"
            : scope === "trash"
              ? !query && activeLabel === "TRASH"
              : false;
        if (!keep) removeMessage(id);
        void refreshLabels();
      }}
      onReply={openCompose}
      onClose={() => setSelected(null)}
    />
  ) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">📬 Mail</div>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            // Results render in the mail view — searching from the calendar
            // must switch over or the search appears to do nothing.
            setView("mail");
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
          <button className="btn primary" onClick={() => openCompose(undefined)}>
            ✏️ 새 메일
          </button>
          <span className="email">{email}</span>
          <button
            className="btn"
            title="설정 (서명)"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
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
        ) : query ? (
          <SearchResults
            query={query}
            messages={messages}
            loading={loading}
            hasMore={!!nextToken}
            onMore={() => load(false)}
            onSelect={onSelectMsg}
            selectedId={selected?.id}
            calendars={calendars}
            onLogout={onLogout}
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
                  active={selected?.id === m.id}
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
              {readerEl ?? <div className="empty">메일을 선택하세요.</div>}
            </section>
          </>
        )}
      </div>

      {view === "mail" && query && readerEl && (
        <SlideOver onClose={() => setSelected(null)}>{readerEl}</SlideOver>
      )}

      {composeOpen && (
        <Compose
          key={composeKey}
          init={composeInit}
          onClose={() => {
            setComposeOpen(false);
            setComposeInit(undefined); // drop retained attachments (up to 25MB)
          }}
          onSaved={() => {
            setComposeOpen(false);
            setComposeInit(undefined);
            load(true); // draft save rotates message ids — refresh the list
            void refreshLabels();
          }}
          onSent={() => {
            setComposeOpen(false);
            setComposeInit(undefined);
            load(true);
            void refreshLabels();
          }}
        />
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

// ---- local settings (서명) ----
// Text signature rides in the text/plain part; an HTML signature (imported
// from Gmail — readable with gmail.modify, no extra scope) is sent verbatim
// as a text/html alternative so images/styles survive.
const SIGNATURE_KEY = "mail.signature";
const SIGNATURE_HTML_KEY = "mail.signature.html";
const ACCOUNT_KEY = "mail.account"; // last logged-in account (settings scope)
const SIGNATURE_SYNC_KEY = "mail.signature.synced"; // auto-import done for this account

function getSignature(): string {
  try {
    return localStorage.getItem(SIGNATURE_KEY) ?? "";
  } catch {
    return "";
  }
}

function getSignatureHtml(): string {
  try {
    return localStorage.getItem(SIGNATURE_HTML_KEY) ?? "";
  } catch {
    return "";
  }
}

function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [sig, setSig] = useState(getSignature());
  const [sigHtml, setSigHtml] = useState(getSignatureHtml());
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const importedTextRef = useRef<string | null>(null);

  const importFromGmail = async () => {
    setImportMsg(null);
    try {
      const { html } = await api.signature();
      if (!html) {
        setImportMsg("Gmail에 저장된 서명이 없습니다.");
        return;
      }
      const text = htmlToText(html);
      importedTextRef.current = text;
      setSig(text);
      setSigHtml(html);
      setImportMsg("가져왔습니다 — 이미지·서식은 발송 시 원본 그대로 포함됩니다.");
    } catch (e) {
      if (e instanceof AuthError) {
        setImportMsg("로그인이 만료되었습니다. 새로고침 후 다시 로그인하세요.");
      } else {
        setImportMsg(`가져오기 실패: ${(e as Error).message}`);
      }
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>설정</strong>
          <button className="clear" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="muted settings-label">
          서명 — 발송 시 본문 끝에 자동 추가 (비워두면 사용 안 함)
        </div>
        <textarea
          className="signature-input"
          placeholder={"예)\n홍길동 드림\n010-0000-0000"}
          value={sig}
          onChange={(e) => setSig(e.target.value)}
        />
        {sigHtml && (
          <>
            <div className="muted settings-label">
              서식 서명 미리보기 (Gmail 원본 — 발송 시 이 모습 그대로)
            </div>
            <div
              className="signature-preview"
              // own signature from the user's Gmail settings — trusted content
              dangerouslySetInnerHTML={{ __html: sigHtml }}
            />
          </>
        )}
        {importMsg && <div className="muted settings-label">{importMsg}</div>}
        <div className="modal-foot">
          <button className="btn" onClick={() => void importFromGmail()}>
            Gmail 서명 가져오기
          </button>
          <span className="modal-spacer" />
          <button
            className="btn primary"
            onClick={() => {
              try {
                localStorage.setItem(SIGNATURE_KEY, sig);
                // Manual edits after import diverge from the HTML original —
                // text becomes the single source of truth again.
                const keepHtml =
                  sigHtml && sig.trim() === (importedTextRef.current ?? htmlToText(sigHtml)).trim();
                if (keepHtml) localStorage.setItem(SIGNATURE_HTML_KEY, sigHtml);
                else localStorage.removeItem(SIGNATURE_HTML_KEY);
              } catch {
                // private mode etc: nothing to persist to
              }
              onClose();
            }}
          >
            저장
          </button>
        </div>
      </div>
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
  onSelect: (id: string, threadId: string) => void;
}) {
  const from = parseAddr(m.from).name;
  const label = listDateLabel(m.date);
  return (
    <button
      className={`msg-row ${active ? "active" : ""} ${m.unread ? "unread" : ""}`}
      onClick={() => onSelect(m.id, m.threadId)}
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
  threadId,
  me,
  guard,
  onPatched,
  onRemoved,
  onReply,
  onClose,
}: {
  id: string;
  threadId: string;
  me: string;
  guard: (fn: () => Promise<void>) => Promise<void>;
  onPatched: (id: string, patch: Partial<MessageSummary>) => void;
  onRemoved: (id: string, scope: "inbox" | "trash" | "all") => void;
  onReply: (init: ComposeInit) => void;
  onClose: () => void;
}) {
  const [msg, setMsg] = useState<MessageFull | null>(null);
  const [thread, setThread] = useState<MessageFull[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    // Cancellation guard: without it, a slow thread fetch for a previously
    // clicked message lands after a newer selection rendered, replacing the
    // view while the action buttons still target the new `id` — 삭제/보관
    // would silently operate on a different mail than the one displayed.
    let cancelled = false;
    setMsg(null);
    setThread(null);
    setLoadErr(null);
    void (async () => {
      try {
        // One round-trip: the thread already contains the opened message
        // (previously message + thread were fetched, duplicating the payload).
        const msgs = await api.thread(threadId);
        if (cancelled) return;
        const m = msgs.find((x) => x.id === id);
        if (!m) {
          // Deleted between list render and open, or id/thread mismatch.
          setLoadErr("메시지를 찾을 수 없습니다. 목록을 새로고침하세요.");
          return;
        }
        setMsg(m);
        setThread(msgs);
        if (m.unread) {
          try {
            await api.modify(m.id, { remove: ["UNREAD"] });
            // List state belongs to Mailbox — reflect the (already applied)
            // server change even when this Reader was superseded meanwhile.
            onPatched(m.id, { unread: false });
            if (cancelled) return;
            setMsg((prev) => (prev ? { ...prev, unread: false } : prev));
          } catch (e) {
            if (!cancelled && e instanceof AuthError) {
              void guard(() => Promise.reject(e)); // route to logout
            }
            // mark-read failure is non-fatal — the mail stays unread
          }
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof AuthError) {
          void guard(() => Promise.reject(e)); // route to logout
          return;
        }
        // Render the failure instead of spinning on "불러오는 중…" forever.
        setLoadErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, threadId]);

  if (loadErr) return <div className="empty">⚠️ {loadErr}</div>;
  if (!msg) return <div className="empty">불러오는 중…</div>;

  return (
    <div className="reader-inner">
      <div className="reader-head">
        <h2>{msg.subject || "(제목 없음)"}</h2>
        <div className="reader-actions">
          <button className="btn" onClick={() => onReply(buildReplyInit(msg, me, false))}>
            ↩ 답장
          </button>
          <button className="btn" onClick={() => onReply(buildReplyInit(msg, me, true))}>
            ↩↩ 전체답장
          </button>
          <button
            className="btn"
            onClick={() =>
              guard(async () => {
                // Forward: original attachments ride along (re-download →
                // base64). Inline cid: image parts stay out — they belong to
                // the original HTML body, not the attachment list.
                const attachments = await Promise.all(
                  msg.attachments
                    .filter((a) => !a.contentId)
                    .map((a) => downloadAttachment(msg.id, a)),
                );
                onReply({
                  subject: fwdSubject(msg.subject),
                  quote: quoteText(msg),
                  quoteFrom: msg.from,
                  attachments,
                });
              })
            }
          >
            ↪ 전달
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
                // Functional update: an overlapping action (읽음 toggle) must
                // not be reverted by spreading this click's stale snapshot.
                setMsg((prev) =>
                  prev
                    ? {
                        ...prev,
                        labelIds: starred
                          ? prev.labelIds.filter((l) => l !== "STARRED")
                          : [...prev.labelIds, "STARRED"],
                      }
                    : prev,
                );
                onPatched(id, {
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
                const wasUnread = msg.unread;
                await api.modify(id, {
                  add: wasUnread ? [] : ["UNREAD"],
                  remove: wasUnread ? ["UNREAD"] : [],
                });
                setMsg((prev) => (prev ? { ...prev, unread: !wasUnread } : prev));
                onPatched(id, { unread: !wasUnread });
              })
            }
          >
            {msg.unread ? "✉️ 읽음" : "📩 안읽음"}
          </button>
          <button
            className="btn"
            onClick={() =>
              guard(async () => {
                await api.modify(id, { remove: ["INBOX"] });
                onRemoved(id, "inbox");
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
                onRemoved(id, "all");
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
                onRemoved(id, "trash");
                onClose();
              })
            }
          >
            🗑 삭제
          </button>
        </div>
      </div>
      {(thread ?? [msg]).map((tm) => (
        <ThreadMessage key={tm.id} m={tm} guard={guard} />
      ))}
    </div>
  );
}

/** Subject prefixes, case-insensitively ("RE:" must not become "Re: RE:"). */
function reSubject(s: string): string {
  return /^\s*re:/i.test(s) ? s : `Re: ${s}`;
}
function fwdSubject(s: string): string {
  return /^\s*(fwd?|forward):/i.test(s) ? s : `Fwd: ${s}`;
}

// Reply / reply-all targets:
// - own sent mail → continue with the original recipients, not yourself
// - otherwise honor Reply-To over From
// - reply-all: everyone else (minus me and the To target), comma-safe split
function buildReplyInit(msg: MessageFull, me: string, all: boolean): ComposeInit {
  const meL = me.toLowerCase();
  const fromMe = parseAddr(msg.from).email.toLowerCase() === meL;
  const to = (fromMe ? msg.to : msg.replyTo || msg.from).trim();
  let cc: string | undefined;
  if (all) {
    const toEmails = new Set(
      splitAddrList(to).map((t) => parseAddr(t).email.toLowerCase()),
    );
    const seen = new Set<string>();
    const rest = [...splitAddrList(msg.to), ...splitAddrList(msg.cc || "")].filter(
      (tok) => {
        const e = parseAddr(tok).email.toLowerCase();
        if (!e || e === meL || toEmails.has(e) || seen.has(e)) return false;
        seen.add(e);
        return true;
      },
    );
    cc = rest.join(", ") || undefined;
  }
  return {
    to,
    cc,
    subject: reSubject(msg.subject),
    threadId: msg.threadId,
    inReplyTo: msg.rfc822MsgId || undefined,
    references: replyReferences(msg),
    quote: quoteText(msg),
    quoteFrom: msg.from,
  };
}

/** Download via fetch + blob link: plain <a> navigation replaces the SPA with
 *  a raw JSON error page when the attachment request fails. */
async function saveAttachment(
  messageId: string,
  a: { id: string; filename: string },
): Promise<void> {
  const res = await fetch(api.attachmentUrl(messageId, a.id, a.filename));
  if (res.status === 401) throw new AuthError("NOT_AUTHENTICATED");
  if (!res.ok) {
    throw new Error(`첨부 다운로드 실패 (${a.filename}): HTTP ${res.status}`);
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = a.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const ThreadMessage = memo(function ThreadMessage({
  m,
  guard,
}: {
  m: MessageFull;
  guard: (fn: () => Promise<void>) => Promise<void>;
}) {
  // Inline (cid:) image parts → attachment URLs for the HTML body.
  const cidUrls = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of m.attachments) {
      if (a.contentId) map.set(a.contentId, api.attachmentUrl(m.id, a.id, a.filename));
    }
    return map;
  }, [m]);
  return (
    <div className="thread-msg">
      <div className="reader-meta">
        <strong>{parseAddr(m.from).name}</strong>{" "}
        <span className="muted">&lt;{parseAddr(m.from).email}&gt;</span>
        <div className="muted">받는사람: {m.to}</div>
        {m.cc && <div className="muted">참조: {m.cc}</div>}
        <div className="muted">{new Date(m.date).toLocaleString("ko-KR")}</div>
      </div>
      {m.attachments.some((a) => !a.contentId) && (
        <div className="attachments">
          {m.attachments
            .filter((a) => !a.contentId) // inline images render in the body
            .map((a) => (
              <a
                key={a.id}
                className="chip"
                href={api.attachmentUrl(m.id, a.id, a.filename)}
                onClick={(e) => {
                  e.preventDefault();
                  void guard(() => saveAttachment(m.id, a));
                }}
              >
                📎 {a.filename} ({Math.round(a.size / 1024)}KB)
              </a>
            ))}
        </div>
      )}
      <div className="reader-body">
        {m.bodyHtml ? (
          <HtmlBody html={m.bodyHtml} id={m.id} cidUrls={cidUrls} />
        ) : (
          <TextBody text={m.bodyText || m.snippet} />
        )}
      </div>
    </div>
  );
});

// ---- plain-text linkify ----
// URLs / email addresses in plain-text bodies become real links (no innerHTML).
const LINK_RE =
  /\bhttps?:\/\/[^\s<>"]+|\bwww\.[^\s<>"]+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;

type LinkPart = { text: string; href?: string };

// Trailing punctuation is almost never part of the URL, but a ")" that closes
// a "(" inside the URL (wiki-style) is.
const TRAIL_PUNCT = new Set([...".,;:!?]}>'\""]);

function trimTrailing(match: string): string {
  // Index-based scan, single final slice: O(n) even for pathological
  // ")…).,;:" tails (regex-replace per round would copy the string each time).
  let opens = 0;
  let closes = 0;
  for (const ch of match) {
    if (ch === "(") opens++;
    else if (ch === ")") closes++;
  }
  let end = match.length;
  for (;;) {
    const prev = end;
    while (end > 0 && TRAIL_PUNCT.has(match[end - 1])) end--;
    while (end > 0 && match[end - 1] === ")" && opens < closes) {
      end--;
      closes--;
    }
    if (end === prev) return match.slice(0, end);
  }
}

function linkifyParts(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const raw = trimTrailing(m[0]);
    // Decide the scheme from the untrimmed match so degenerate leftovers
    // ("www" after trimming "www.,") never become bogus mailto:/https: links.
    const href = raw.includes("://")
      ? raw
      : m[0].startsWith("www.") && raw.length > 4
        ? `https://${raw}`
        : !m[0].startsWith("www.") && raw.includes("@")
          ? `mailto:${raw}`
          : null;
    if (!href) continue; // leave the match as plain text
    const start = m.index;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: raw, href });
    last = start + raw.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

function TextBody({ text }: { text: string }) {
  const parts = useMemo(() => linkifyParts(text), [text]);
  return (
    <pre className="text-body">
      {parts.map((p, i) =>
        p.href ? (
          <a
            key={i}
            href={p.href}
            {...(p.href.startsWith("mailto:")
              ? {}
              : { target: "_blank", rel: "noopener noreferrer" })}
          >
            {p.text}
          </a>
        ) : (
          p.text
        ),
      )}
    </pre>
  );
}

// Renders email HTML in a sandboxed iframe and auto-sizes it to its content.
// allow-same-origin (WITHOUT allow-scripts) keeps email JS disabled while letting
// the parent measure the document height; allow-popups makes links open in a new tab.
function HtmlBody({
  html,
  id,
  cidUrls,
}: {
  html: string;
  id: string;
  cidUrls?: Map<string, string>;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  // DOMParser full-parse is not free on big newsletters — don't redo it when
  // unrelated parent state (star toggle etc.) re-renders this component.
  const srcDoc = useMemo(() => prepareEmailHtml(html, undefined, cidUrls), [html, cidUrls]);

  const resize = useCallback(() => {
    const f = ref.current;
    const doc = f?.contentDocument;
    if (!f || !doc) return;
    const h = Math.max(
      doc.body?.scrollHeight ?? 0,
      doc.documentElement?.scrollHeight ?? 0,
    );
    if (h) f.style.height = `${h + 8}px`;
  }, []);

  const onLoad = useCallback(() => {
    resize();
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll("img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", resize, { once: true });
    });
    setTimeout(resize, 400);
    setTimeout(resize, 1200);
    // Handle only mailto/# clicks here. http(s) links are left to the
    // browser's NATIVE anchor navigation (prepareEmailHtml guarantees
    // target=_blank + rel on every anchor): real link clicks are exempt from
    // popup blocking, whereas window.open() from this handler is silently
    // blocked by managed/strict-policy browsers (corporate Chrome).
    doc.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (/^mailto:/i.test(href)) {
        e.preventDefault();
        window.location.href = href;
      } else if (href.startsWith("#")) {
        // In-document anchor (newsletter TOC etc.): scroll within the
        // auto-sized frame — the browser scrolls the parent page to match.
        e.preventDefault();
        let name = href.slice(1);
        try {
          name = decodeURIComponent(name);
        } catch {
          // malformed % escape ("#50%-off"): fall back to the raw fragment
        }
        if (!name) return;
        const el =
          doc.getElementById(name) ??
          doc.querySelector(`a[name="${CSS.escape(name)}"]`);
        // Instant scroll: smooth scrollIntoView does not reliably propagate
        // from the same-origin iframe to the parent scroller in Chromium.
        el?.scrollIntoView({ block: "start" });
      }
    });
  }, [resize]);

  return (
    <iframe
      ref={ref}
      title={`message-${id}`}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      className="html-frame"
      onLoad={onLoad}
    />
  );
}

type ComposeAttachment = {
  filename: string;
  mimeType: string;
  data: string;
  size: number;
};

type ComposeInit = {
  to?: string;
  cc?: string;
  subject?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string; // accumulated RFC 5322 chain (원본 References + Message-ID)
  bcc?: string;
  quote?: string;
  quoteFrom?: string;
  attachments?: ComposeAttachment[];
  body?: string; // verbatim initial body (드래프트 이어쓰기)
  draftId?: string; // editing this Gmail draft: update on save, delete on send
  richWarning?: boolean; // Gmail-web HTML draft resumed as plain text
};

function Compose({
  init,
  onClose,
  onSaved,
  onSent,
}: {
  init?: ComposeInit;
  onClose: () => void;
  onSaved: () => void;
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
  const [bcc, setBcc] = useState(init?.bcc ?? "");
  const [subject, setSubject] = useState(init?.subject ?? "");
  const [body, setBody] = useState(init?.body ?? quoted);
  const [sending, setSending] = useState(false);
  // Errors render inside the modal — the global banner sits behind the
  // backdrop and is unreachable while the editor is open. An AuthError keeps
  // the editor (and the typed text) alive instead of unmounting to Login.
  const [formErr, setFormErr] = useState<string | null>(null);
  // In-flight FileReader work: sending now would silently drop the files.
  const [reading, setReading] = useState(0);
  const [files, setFiles] = useState<ComposeAttachment[]>(
    init?.attachments ?? [],
  );
  // The draft being edited can vanish mid-edit (sent/deleted in Gmail web) —
  // after the create-fallback, later saves must target the new draft.
  const [draftId, setDraftId] = useState(init?.draftId);

  const run = (fn: () => Promise<void>) => {
    setFormErr(null);
    void fn().catch((e) => {
      if (e instanceof AuthError) {
        setFormErr(
          "로그인이 만료되었습니다. 작성한 내용을 복사해 둔 뒤 새로고침하여 다시 로그인하세요.",
        );
      } else {
        setFormErr((e as Error).message);
      }
    });
  };

  // One funnel for every attach path (버튼/드래그앤드롭/붙여넣기) — managed
  // Chrome can block the file-selection dialog outright, so DnD/paste must
  // work too; run() surfaces FileReader failures instead of silent drops.
  const MAX_ATTACH_BYTES = 25 * 1024 * 1024; // Gmail 발송 한도 (실측 확인)
  // Synchronous check-and-reserve — two overlapping drops must not both pass
  // the limit check against the same stale `files` state.
  const totalSize = useRef(
    (init?.attachments ?? []).reduce((s, f) => s + f.size, 0),
  );
  const addFiles = (picked: File[]) => {
    if (picked.length === 0) return;
    setReading((r) => r + 1);
    run(async () => {
      try {
        const read = await Promise.all(picked.map(fileToBase64));
        const added = read.reduce((s, f) => s + f.size, 0);
        if (totalSize.current + added > MAX_ATTACH_BYTES) {
          throw new Error(
            `첨부 합계가 25MB를 초과합니다 (${Math.round((totalSize.current + added) / 1024 / 1024)}MB). Gmail 발송 한도를 넘으면 반송됩니다.`,
          );
        }
        totalSize.current += added;
        setFiles((p) => [...p, ...read]);
      } finally {
        setReading((r) => r - 1);
      }
    });
  };
  const removeFile = (i: number) => {
    setFiles((p) => {
      const f = p[i];
      if (f) totalSize.current -= f.size;
      return p.filter((_, j) => j !== i);
    });
  };

  const assertSendableSize = () => {
    // Forwarded attachments arrive via init and bypass addFiles — enforce
    // the limit at the exit too, or oversized forwards bounce at Gmail.
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > MAX_ATTACH_BYTES) {
      throw new Error(
        `첨부 합계가 25MB를 초과합니다 (${Math.round(total / 1024 / 1024)}MB). 일부 첨부를 제거하세요.`,
      );
    }
  };

  const send = () =>
    run(async () => {
      setSending(true);
      try {
        assertSendableSize();
        // 서명은 발송 시점에 합성: 텍스트 본문 + (서식 서명이 있으면) HTML
        // alternative — 이미지/스타일이 원본 그대로 나간다.
        const sigText = getSignature();
        const sigHtml = getSignatureHtml();
        // Resumed drafts may already carry the signature — never append twice.
        const hasSig =
          !!sigText && body.replace(/\s+$/, "").endsWith(sigText.trim());
        const appendSig = !!sigText && !hasSig;
        await api.send({
          to,
          cc: cc || undefined,
          bcc: bcc || undefined,
          subject,
          body: appendSig ? `${body}\n\n--\n${sigText}` : body,
          bodyHtml:
            appendSig && sigHtml
              ? `${textToHtml(body)}<br><br>--<br>${sigHtml}`
              : undefined,
          threadId: init?.threadId,
          inReplyTo: init?.inReplyTo,
          references: init?.references ?? init?.inReplyTo,
          attachments: files.length
            ? files.map(({ filename, mimeType, data }) => ({
                filename,
                mimeType,
                data,
              }))
            : undefined,
        });
        if (draftId) {
          // Post-send cleanup only — a failed draft delete must never make a
          // SENT mail look failed (re-click would double-send).
          await api.deleteDraft(draftId).catch(() => {});
        }
        onSent();
      } finally {
        setSending(false);
      }
    });

  const saveDraft = () =>
    run(async () => {
      setSending(true);
      try {
        assertSendableSize();
        const payload = {
          to,
          cc: cc || undefined,
          bcc: bcc || undefined,
          subject,
          body,
          threadId: init?.threadId,
          inReplyTo: init?.inReplyTo,
          references: init?.references ?? init?.inReplyTo,
          attachments: files.length
            ? files.map(({ filename, mimeType, data }) => ({
                filename,
                mimeType,
                data,
              }))
            : undefined,
        };
        if (draftId) {
          try {
            await api.updateDraft(draftId, payload);
          } catch (e) {
            // Draft sent/deleted elsewhere while editing: save as a new
            // draft instead of failing every 임시저장 until the editor closes.
            if (e instanceof HttpError && e.status === 404) {
              const created = await api.saveDraft(payload);
              setDraftId(created.id);
            } else {
              throw e;
            }
          }
        } else {
          const created = await api.saveDraft(payload);
          setDraftId(created.id);
        }
        onSaved();
      } finally {
        setSending(false);
      }
    });

  return (
    // While a send/save is in flight the editor must not be dismissible —
    // closing mid-send loses the message on failure and invites double-sends.
    <div className="modal-backdrop" onClick={sending ? undefined : onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <div className="modal-head">
          <strong>
            {init?.draftId
              ? "임시보관 메일"
              : init?.inReplyTo
                ? "답장"
                : init?.attachments?.length || init?.quote
                  ? "전달"
                  : "새 메일"}
          </strong>
          <button className="clear" onClick={onClose} disabled={sending}>
            ✕
          </button>
        </div>
        {init?.richWarning && (
          <div className="muted settings-label">
            ⚠️ 서식 있는 임시보관 메일입니다 — 저장/발송 시 텍스트로 변환됩니다.
          </div>
        )}
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
          placeholder="숨은참조 (선택)"
          value={bcc}
          onChange={(e) => setBcc(e.target.value)}
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
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault(); // file paste (스크린샷 등) → attach
              addFiles(pasted);
            }
          }}
        />
        {files.length > 0 && (
          <div className="compose-atts">
            {files.map((f, i) => (
              <span key={`${f.filename}-${i}`} className="chip">
                📎 {f.filename} ({Math.round(f.size / 1024)}KB)
                <button
                  type="button"
                  className="chip-x"
                  onClick={() => removeFile(i)}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        {formErr && (
          <div className="muted settings-label">⚠️ {formErr}</div>
        )}
        <div className="modal-foot">
          <label className="btn">
            📎 파일 첨부
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = "";
                addFiles(picked);
              }}
            />
          </label>
          <span className="muted attach-hint">
            끌어다 놓기 · 붙여넣기로도 첨부됩니다
            {getSignature() && " · ✍ 서명 자동 추가"}
          </span>
          <span className="modal-spacer" />
          <button
            className="btn"
            disabled={sending || reading > 0}
            onClick={saveDraft}
          >
            임시저장
          </button>
          <button
            className="btn primary"
            disabled={sending || reading > 0 || !to.trim()}
            onClick={send}
          >
            {sending ? "보내는 중…" : reading > 0 ? "첨부 읽는 중…" : "보내기"}
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

/** Base64 (no data: prefix) of an already-downloaded blob (전달 첨부 재사용). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** RFC 5322: replies accumulate References = original References + its Message-ID. */
function replyReferences(m: MessageFull): string | undefined {
  return [m.references, m.rfc822MsgId].filter(Boolean).join(" ") || undefined;
}

/** Re-download an attachment for forward/draft-resume. Throws on HTTP errors
 *  instead of silently base64-encoding an error JSON body as the attachment. */
async function downloadAttachment(
  messageId: string,
  a: { id: string; filename: string; mimeType: string; size: number },
): Promise<ComposeAttachment> {
  const res = await fetch(api.attachmentUrl(messageId, a.id, a.filename));
  if (res.status === 401) throw new AuthError("NOT_AUTHENTICATED");
  if (!res.ok) {
    throw new Error(`첨부 다운로드 실패 (${a.filename}): HTTP ${res.status}`);
  }
  return {
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    data: await blobToBase64(await res.blob()),
  };
}

// ---- 통합 검색 결과 (일정 카드 | 메일 카드, 양옆 배치) ----

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bare words from the query — Gmail operators (from:, has:…) don't highlight. */
function searchTerms(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.trim().replace(/^"+|"+$/g, ""))
    .filter((t) => t.length > 0 && !t.includes(":") && t !== "OR" && t !== "AND");
}

function highlightText(text: string, terms: string[]): ReactNode {
  if (!text || terms.length === 0) return text;
  const re = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(re);
  if (parts.length === 1) return text;
  // With a single capture group, odd indices are the matches.
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p));
}

// Deterministic sender avatar color (Google 팔레트 계열, 외부 에셋 없음).
const AVATAR_COLORS = [
  "#7986cb",
  "#33b679",
  "#8e24aa",
  "#e67c73",
  "#f4b400",
  "#039be5",
  "#3f51b5",
  "#0b8043",
  "#616161",
  "#d81b60",
];

function avatarColor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function listDateLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

function SlideOver({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="slideover-backdrop" onClick={onClose}>
      <div className="slideover" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function MailCard({
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
  const addr = parseAddr(m.from);
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
          <span className="scard-date">{listDateLabel(m.date)}</span>
        </span>
        <span className="scard-title">
          {highlightText(m.subject || "(제목 없음)", terms)}
          {m.hasAttachments && <span className="paperclip"> 📎</span>}
        </span>
        {m.snippet && (
          <span className="scard-sub">{highlightText(m.snippet, terms)}</span>
        )}
      </span>
    </button>
  );
}

function EventCard({
  e,
  terms,
  past,
  onClick,
}: {
  e: CalEvent;
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
      <span className="ev-datebox" style={{ borderTopColor: e.color ?? "#1a73e8" }}>
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
          🕒 {when}
          {e.location ? <> · 📍 {highlightText(e.location, terms)}</> : null}
        </span>
        <span className="scard-tagrow">
          <span className="cal-dot" style={{ background: e.color ?? "#1a73e8" }} />
          <span className="scard-tag">{e.calendarSummary}</span>
        </span>
      </span>
    </button>
  );
}

function SearchResults({
  query,
  messages,
  loading,
  hasMore,
  onMore,
  onSelect,
  selectedId,
  calendars,
  onLogout,
}: {
  query: string;
  messages: MessageSummary[];
  loading: boolean;
  hasMore: boolean;
  onMore: () => void;
  onSelect: (id: string, threadId: string) => void;
  selectedId?: string;
  calendars: Calendar[];
  onLogout: () => void;
}) {
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [evErr, setEvErr] = useState<string | null>(null);
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

  const terms = useMemo(() => searchTerms(query), [query]);

  // 다가오는 일정 먼저(오름차순), 지난 일정은 구분선 아래 최근순.
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
    const evs = events ?? [];
    return {
      upcoming: evs.filter((e) => !isPast(e)),
      past: evs.filter(isPast).reverse(),
    };
  }, [events]);

  const writable = calendars.filter(
    (c) => c.accessRole === "owner" || c.accessRole === "writer",
  );

  return (
    <div className="search-page">
      <div className="search-head">
        <h2>“{query}”</h2>
        <span className="muted">
          일정 {events ? `${events.length}건` : "…"} · 메일 {messages.length}
          {hasMore ? "+" : ""}건
        </span>
      </div>
      <div className="search-cols">
        <section className="search-col">
          <div className="search-col-head">📅 일정</div>
          {evErr ? (
            <div className="scard-empty">⚠️ {evErr}</div>
          ) : !events ? (
            <>
              <div className="skel" />
              <div className="skel" />
            </>
          ) : events.length === 0 ? (
            <div className="scard-empty">일치하는 일정이 없습니다.</div>
          ) : (
            <>
              {upcoming.map((e) => (
                <EventCard
                  key={`${e.calendarId}|${e.id}|${e.start}`}
                  e={e}
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
                  terms={terms}
                  past
                  onClick={() => setDetailEv(e)}
                />
              ))}
            </>
          )}
        </section>
        <section className="search-col">
          <div className="search-col-head">✉️ 메일</div>
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
            <button className="btn more" onClick={onMore}>
              더 보기
            </button>
          )}
        </section>
      </div>
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
            calCache.clear(); // calendar view caches must see the change too
            setRefreshKey((k) => k + 1);
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
            calCache.clear();
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
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
                    // Same event can sit on two visible calendars — id alone duplicates keys.
                    key={`${e.calendarId}|${e.id}|${e.start}`}
                    type="button"
                    className="month-ev"
                    onClick={() => onEvent(e)}
                    title={`${evTimeLabel(e, key)} ${e.summary}`}
                  >
                    <span
                      className="month-ev-dot"
                      style={{ background: e.color ?? "#1a73e8" }}
                    />
                    <span className="month-ev-t">
                      {e.allDay ? "" : `${evTimeLabel(e, key)} `}
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

// Time label for an event on a given day: a multi-day timed event shows its
// start time only on its first day — repeating "09:00" on every spanned day
// reads as a daily 9 AM meeting.
function evTimeLabel(e: CalEvent, dayKey: string): string {
  if (e.allDay) return "종일";
  return localDayKey(e.start) === dayKey ? formatTime(e.start) : "계속";
}

// Every local day key an event spans. All-day ends are exclusive (Google);
// timed events ending exactly at midnight don't occupy that day.
// Runaway guard only — was 62, which made events longer than two months
// vanish from every month past start+62d (안식년 휴가 등).
const MAX_SPAN_DAYS = 400;

function occupiedDayKeys(e: CalEvent): string[] {
  const keys: string[] = [];
  if (e.allDay) {
    const endEx = e.end || e.start;
    for (
      let d = new Date(`${e.start.slice(0, 10)}T00:00:00`), i = 0;
      dateKey(d) < endEx.slice(0, 10) && i < MAX_SPAN_DAYS;
      d.setDate(d.getDate() + 1), i++
    ) {
      keys.push(dateKey(d));
    }
    if (keys.length === 0) keys.push(e.start.slice(0, 10));
    return keys;
  }
  const startKey = localDayKey(e.start);
  const endMs = e.end ? new Date(e.end).getTime() : NaN;
  const lastKey = Number.isFinite(endMs)
    ? dateKey(new Date(endMs - 1)) // minus 1ms: midnight end excludes that day
    : startKey;
  const d = new Date(`${startKey}T00:00:00`);
  for (let i = 0; i < MAX_SPAN_DAYS; i++) {
    const k = dateKey(d);
    keys.push(k);
    if (k >= lastKey) break;
    d.setDate(d.getDate() + 1);
  }
  return keys;
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
        else setErr(`상세를 불러오지 못했습니다: ${(e as Error).message}`);
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
          {err && <div className="ev-row muted">⚠️ {err}</div>}
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
      </div>
    </div>
  );
}

function formatEventWhen(e: CalEvent): string {
  if (e.allDay) {
    const s = new Date(`${e.start.slice(0, 10)}T00:00:00`);
    const startLabel = s.toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    });
    // Google all-day ends are exclusive — last occupied day is end-1.
    const lastDay = e.end ? addDays(e.end.slice(0, 10), -1) : e.start.slice(0, 10);
    if (lastDay > e.start.slice(0, 10)) {
      const en = new Date(`${lastDay}T00:00:00`);
      const endLabel = en.toLocaleDateString("ko-KR", {
        month: "long",
        day: "numeric",
        weekday: "short",
      });
      return `${startLabel} – ${endLabel} · 종일`;
    }
    return `${startLabel} · 종일`;
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

// HTML → readable plain text: entities decoded, <br>/block tags become line
// breaks. Used for reply quotes and Gmail signature import.
function htmlToText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("style,script").forEach((n) => n.remove());
    doc.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
    doc.body
      ?.querySelectorAll("p,div,li,tr,h1,h2,h3,h4,h5,h6,blockquote,table")
      .forEach((n) => n.append("\n"));
    const text = doc.body?.textContent ?? "";
    return text
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return "";
  }
}

// Reply-quote text. Prefer extracting from the HTML part: some senders
// (Dooray 등) leak raw entities ("&nbsp;") and tag-mashed text into their
// text/plain part, and HTML-only mails have no text part at all.
function quoteText(m: MessageFull): string {
  if (m.bodyHtml) {
    const cleaned = htmlToText(m.bodyHtml);
    if (cleaned) return cleaned;
  }
  return m.bodyText ?? "";
}

// Rendered email/description HTML lives in a sandboxed iframe (no scripts).
// Rewrite every link to open in a new top-level tab and drop the referrer,
// so links actually work (instead of navigating inside the sandboxed frame -> 403).
function prepareEmailHtml(
  html: string,
  bodyStyle?: string,
  cidUrls?: Map<string, string>,
): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Hostile <meta http-equiv="refresh"> would replace the rendered body
    // with an arbitrary remote page — scripts are sandboxed off, but meta
    // refresh is plain markup and works inside the frame.
    doc.querySelectorAll("meta").forEach((mt) => {
      if ((mt.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh") {
        mt.remove();
      }
    });
    // Resolve inline images: cid: refs point at MIME parts of this message.
    if (cidUrls && cidUrls.size > 0) {
      doc.querySelectorAll("img[src]").forEach((img) => {
        const src = img.getAttribute("src") ?? "";
        if (!/^cid:/i.test(src)) return;
        let cid = src.slice(4);
        try {
          cid = decodeURIComponent(cid);
        } catch {
          // malformed escape — match the raw value
        }
        const url = cidUrls.get(cid.replace(/^<|>$/g, ""));
        if (url) img.setAttribute("src", url);
      });
    }
    let base = doc.querySelector("base");
    if (!base) {
      base = doc.createElement("base");
      doc.head.prepend(base);
    }
    // The mail's own <base href> would re-anchor all relative URLs (and a
    // crafted one re-targets every link) — ours only sets target.
    base.removeAttribute("href");
    base.setAttribute("target", "_blank");
    const meta = doc.createElement("meta");
    meta.setAttribute("name", "referrer");
    meta.setAttribute("content", "no-referrer");
    doc.head.prepend(meta);
    doc.querySelectorAll("a[href]").forEach((a) => {
      const href = (a.getAttribute("href") ?? "").trim();
      // HTML URL parsing strips ASCII control chars, so "java\nscript:" still
      // parses as javascript: — strip them before the scheme test too.
      if (/^(javascript|data|vbscript):/i.test(href.replace(/[\u0000-\u0020]/g, ""))) {
        // Hostile scheme: keep the text, kill the link (target=_blank would
        // otherwise spawn a blank tab on click).
        a.removeAttribute("href");
        return;
      }
      if (href.startsWith("#")) {
        // Pure fragment links must stay inside the frame, not fight <base target>.
        a.setAttribute("target", "_self");
        return;
      }
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
    if (!start || !end) return setErr("시작/종료 일시를 입력하세요.");
    if (allDay ? end < start : new Date(end) <= new Date(start)) {
      return setErr("종료가 시작보다 빠릅니다.");
    }
    if (!allDay && (isNaN(+new Date(start)) || isNaN(+new Date(end)))) {
      return setErr("일시 형식이 올바르지 않습니다.");
    }
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
      // Dead session → login screen, not a raw NOT_AUTHENTICATED string.
      if (e instanceof AuthError) {
        onLogout();
        return;
      }
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
          {writable.length > 1 && (
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
            // Existing events may legitimately be untitled (raw summary "")
            // — requiring a title here would make them uneditable.
            disabled={busy || (!eventId && !summary.trim())}
            onClick={save}
          >
            {busy ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
