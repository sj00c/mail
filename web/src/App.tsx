import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  api,
  AuthError,
  HttpError,
  parseAddr,
  splitAddrList,
  type AccountSettings,
  type Label,
  type CalEvent,
  type Calendar,
  type CalEventDetail,
  type EventInput,
  type MessageFull,
  type MessageSummary,
  type SendAsInfo,
  type Contact,
  type DriveFile,
  type DriveQuota,
  type DriveBreadcrumb,
} from "./api.ts";

const SYSTEM_ORDER = ["INBOX", "STARRED", "SENT", "DRAFT", "SPAM", "TRASH"];

// 안정된 빈 배열 — 선택이 없을 때 checkedIds가 매번 새 []를 반환하지 않도록.
const EMPTY_IDS: string[] = [];

// 상단바 아이콘: 이모지 대신 인라인 SVG (외부 에셋 없이 선형 아이콘)
function SvgIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const IconPen = () => (
  <SvgIcon>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </SvgIcon>
);

const IconSend = () => (
  <SvgIcon>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </SvgIcon>
);

const IconSliders = () => (
  <SvgIcon>
    <line x1="4" y1="21" x2="4" y2="14" />
    <line x1="4" y1="10" x2="4" y2="3" />
    <line x1="12" y1="21" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12" y2="3" />
    <line x1="20" y1="21" x2="20" y2="16" />
    <line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="17" y1="16" x2="23" y2="16" />
  </SvgIcon>
);

const IconLogout = () => (
  <SvgIcon>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </SvgIcon>
);

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
        <h1>Mail</h1>
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
      <h1>Mail</h1>
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
  // ?view=calendar / ?q=검색어 deep link: 화면을 URL로 바로 열 수 있다.
  const initialQuery = (() => {
    try {
      return new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
    } catch {
      return "";
    }
  })();
  const [view, setView] = useState<"mail" | "calendar" | "drive">(() => {
    try {
      // q가 있으면 검색이 우선 — 검색 결과는 mail 뷰에서만 렌더된다.
      if (initialQuery) return "mail";
      const v = new URLSearchParams(window.location.search).get("view");
      return v === "calendar" || v === "drive" ? v : "mail";
    } catch {
      return "mail";
    }
  });
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
  // Gmail 계정 설정(별칭/답장주소/휴가응답) — 로그인 시 자동으로 딸려온다.
  const [acctSettings, setAcctSettings] = useState<AccountSettings | null>(null);
  const [hiddenCals, setHiddenCals] = useState<Set<string>>(new Set());
  // 목록 체크박스로 고른 메일 id (일괄 처리용). shift-범위선택용 마지막 인덱스.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastCheckedIdx = useRef<number | null>(null);
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

  // 백그라운드 갱신(캘린더 60s/포커스, 검색 일정)이 세션 만료를 만나도 작성창이
  // 열려 있으면 로그아웃을 보류한다 — 언마운트가 작성 중인 메일을 날리기 때문.
  // 사용자가 직접 보내기/저장할 때 모달 안에서 만료가 표면화된다.
  const bgLogout = useCallback(() => {
    if (!composeOpenRef.current) onLogout();
  }, [onLogout]);

  useEffect(() => {
    // Account settings ride along with login — non-fatal if unavailable.
    api.accountSettings().then(setAcctSettings).catch(() => {});
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

  // ?hide=calId1,calId2 deep link — 특정 캘린더를 숨긴 화면을 URL로 공유/오픈.
  const urlHiddenCals = useRef<string[]>(
    (() => {
      try {
        const v = new URLSearchParams(window.location.search).get("hide");
        return v ? v.split(",").filter(Boolean) : [];
      } catch {
        return [];
      }
    })(),
  );

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
        setHiddenCals(
          new Set([
            ...cs.filter((c) => !c.selected).map((c) => c.id),
            ...urlHiddenCals.current,
          ]),
        );
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) bgLogout();
        else setCalErr((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setCalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, query, calendars.length, bgLogout]);

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
        // Re-download ALL attachments incl. inline (cid:) images, preserving
        // contentId — otherwise the resumed draft's bodyHtml keeps cid: refs
        // with no matching parts and inline images break on re-send.
        const attachments = await Promise.all(
          full.attachments.map((a) => downloadAttachment(full.id, a)),
        );
        if (seq !== openDraftSeq.current) return; // superseded by a later click
        openCompose({
          draftId: found?.draftId,
          to: full.to,
          cc: full.cc || undefined,
          bcc: full.bcc || undefined, // Gmail-web drafts may carry Bcc
          subject: full.subject,
          from: full.from || undefined, // 원래 보내는 주소(별칭) 복원
          // 저장된 HTML을 그대로 이어쓴다 (서식 보존). 평문뿐인 드래프트는
          // textToHtml로 감싸 동일한 에디터에 올린다.
          bodyHtml: full.bodyHtml ?? textToHtml(full.bodyText ?? ""),
          // a resumed reply draft must keep its threading headers
          inReplyTo: full.inReplyTo || undefined,
          references: full.references || undefined,
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
            setMessages((prev) => {
              if (reset) return res.messages;
              // 페이지네이션 도중 새 메일이 상단에 끼면 경계 항목이 다음 페이지에
              // 다시 와 id가 중복될 수 있다 — append 시 중복 제거(React key 충돌 방지).
              const seen = new Set(prev.map((m) => m.id));
              return [...prev, ...res.messages.filter((m) => !seen.has(m.id))];
            });
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

  // ---- 목록 체크박스 선택 + 일괄 처리 ----
  // 체크박스 토글. shift-클릭이면 직전 클릭 행과의 사이를 한꺼번에 켜고/끈다.
  const onToggleCheck = useCallback((id: string, shiftKey: boolean) => {
    const list = messagesRef.current;
    const idx = list.findIndex((m) => m.id === id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastCheckedIdx.current != null && idx >= 0) {
        const [a, b] = [lastCheckedIdx.current, idx].sort((x, y) => x - y);
        const turnOn = !prev.has(id); // 클릭 행의 '다음 상태'를 범위 전체에 적용
        for (let i = a; i <= b; i++) {
          if (turnOn) next.add(list[i].id);
          else next.delete(list[i].id);
        }
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    if (idx >= 0) lastCheckedIdx.current = idx;
  }, []);

  // 선택된 행 중 실제로 현재 목록에 남아 있는 id만 (폴링으로 사라진 것 방어).
  // 선택이 없는 평상시(대부분)엔 목록 전체 스캔을 건너뛰고 안정된 빈 배열을
  // 돌려준다 — 매 렌더 새 배열을 만들면 하위 useMemo가 전부 무효화된다.
  const checkedIds = useMemo(
    () =>
      selectedIds.size === 0
        ? EMPTY_IDS
        : messages.filter((m) => selectedIds.has(m.id)).map((m) => m.id),
    [messages, selectedIds],
  );
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    lastCheckedIdx.current = null;
  }, []);

  const patchMany = useCallback(
    (ids: Set<string>, patch: Partial<MessageSummary>) => {
      setMessages((prev) =>
        prev.map((m) => (ids.has(m.id) ? { ...m, ...patch } : m)),
      );
    },
    [],
  );
  const removeMany = useCallback((ids: Set<string>) => {
    setMessages((prev) => prev.filter((m) => !ids.has(m.id)));
  }, []);
  // 선택 행들의 단일 라벨을 더하거나 빼 labelIds를 갱신 (별표 등).
  const toggleLabelMany = useCallback(
    (ids: Set<string>, label: string, add: boolean) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (!ids.has(m.id)) return m;
          const has = m.labelIds.includes(label);
          if (add && !has) return { ...m, labelIds: [...m.labelIds, label] };
          if (!add && has)
            return { ...m, labelIds: m.labelIds.filter((l) => l !== label) };
          return m;
        }),
      );
    },
    [],
  );

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
    setSelectedIds(new Set()); // 라벨/검색 전환 시 선택 해제
    lastCheckedIdx.current = null;
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
            // 새 메일을 목록 "맨 앞에 병합"한다 — load(true) 전체 리로드는
            // '더 보기'로 불러온 페이지·스크롤을 날린다. INBOX·검색없음일 때만.
            if (activeLabel === "INBOX" && !query) {
              setMessages((prev) => {
                const have = new Set(prev.map((m) => m.id));
                const add = res.messages.filter((m) => !have.has(m.id));
                if (add.length === 0) return prev;
                return [...add, ...prev];
              });
            }
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

  // ---- 일괄 처리 액션 (목록 체크박스 선택분 대상) ----
  const inTrashView = !query && activeLabel === "TRASH";
  const isInboxView = !query && activeLabel === "INBOX";
  const isStarredView = !query && activeLabel === "STARRED";
  const checkedSet = useMemo(() => new Set(checkedIds), [checkedIds]);
  // 선택분이 모두 별표 상태면 버튼은 '해제'로 동작 (Gmail식 토글).
  const allStarred = useMemo(
    () =>
      checkedIds.length > 0 &&
      messages.every((m) => !checkedSet.has(m.id) || m.labelIds.includes("STARRED")),
    [messages, checkedSet, checkedIds],
  );
  const allChecked = messages.length > 0 && checkedIds.length === messages.length;

  const runBulk = (fn: (ids: string[], set: Set<string>) => Promise<void>) =>
    guard(async () => {
      const ids = checkedIds;
      if (ids.length === 0) return;
      await fn(ids, new Set(ids));
      clearSelection();
      void refreshLabels();
    });
  const bulkRead = (read: boolean) =>
    runBulk(async (ids, set) => {
      await api.batchModify(ids, read ? { remove: ["UNREAD"] } : { add: ["UNREAD"] });
      patchMany(set, { unread: !read });
    });
  const bulkStar = () =>
    runBulk(async (ids, set) => {
      const add = !allStarred;
      await api.batchModify(ids, add ? { add: ["STARRED"] } : { remove: ["STARRED"] });
      // 별표 뷰에서 해제하면 그 행은 목록에서 빠진다.
      if (!add && isStarredView) removeMany(set);
      else toggleLabelMany(set, "STARRED", add);
    });
  const bulkArchive = () =>
    runBulk(async (ids, set) => {
      await api.batchModify(ids, { remove: ["INBOX"] });
      removeMany(set);
    });
  const bulkTrash = () =>
    runBulk(async (ids, set) => {
      await api.batchTrash(ids);
      removeMany(set);
    });
  const bulkRestore = () =>
    runBulk(async (ids, set) => {
      await api.batchModify(ids, { add: ["INBOX"], remove: ["TRASH"] });
      removeMany(set);
    });
  const toggleAll = () => {
    if (allChecked) clearSelection();
    else {
      setSelectedIds(new Set(messages.map((m) => m.id)));
      lastCheckedIdx.current = null;
    }
  };

  // ---- 보내기 취소 (undo send) ----
  // 발송을 N초(설정) 지연 큐에 넣고 토스트로 실행취소/즉시발송을 제공한다.
  // 실제 api.send는 타이머 만료(또는 지금 보내기) 시에만 나간다.
  const outboxTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const [outbox, setOutbox] = useState<
    { key: number; payload: SendPayload; draftId?: string }[]
  >([]);
  const removeOutbox = useCallback((key: number) => {
    const t = outboxTimers.current.get(key);
    if (t) clearTimeout(t);
    outboxTimers.current.delete(key);
    setOutbox((prev) => prev.filter((o) => o.key !== key));
  }, []);
  const flushOutbox = useCallback(
    (key: number, payload: SendPayload, draftId?: string) => {
      removeOutbox(key);
      void guard(async () => {
        await api.send(payload);
        // 발송 성공 후에만 원본 드래프트 정리 (실패 시 드래프트가 복구 수단).
        if (draftId) await api.deleteDraft(draftId).catch(() => {});
        load(true);
        void refreshLabels();
      });
    },
    [guard, load, refreshLabels, removeOutbox],
  );
  const queueSend = useCallback(
    (payload: SendPayload, draftId?: string) => {
      const key = Date.now() + Math.random();
      outboxTimers.current.set(
        key,
        setTimeout(() => flushOutbox(key, payload, draftId), getUndoSec() * 1000),
      );
      setOutbox((prev) => [...prev, { key, payload, draftId }]);
    },
    [flushOutbox],
  );
  const cancelSend = useCallback(
    (key: number) => {
      const o = outbox.find((x) => x.key === key);
      removeOutbox(key);
      if (!o) return;
      const p = o.payload;
      // 작성창을 발송 직전 상태 그대로 복원한다 (첨부 포함).
      openCompose({
        to: p.to,
        cc: p.cc,
        bcc: p.bcc,
        subject: p.subject,
        from: p.from,
        threadId: p.threadId,
        inReplyTo: p.inReplyTo,
        references: p.references,
        draftId: o.draftId,
        bodyHtml: p.bodyHtml ?? textToHtml(p.body),
        attachments: [...(p.attachments ?? []), ...(p.driveAttachments ?? [])].map(
          (a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            data: a.data,
            contentId: (a as { contentId?: string }).contentId,
            size: Math.floor((a.data.length * 3) / 4),
          }),
        ),
      });
    },
    [outbox, openCompose, removeOutbox],
  );

  // ---- 메일 → 일정 만들기 ----
  const [evEditor, setEvEditor] = useState<{ initial: Partial<EventInput> } | null>(
    null,
  );
  const createEventFromMail = useCallback(
    (m: MessageFull) => {
      void guard(async () => {
        // 캘린더 뷰를 아직 안 열었으면 목록이 비어 있다 — 여기서 채운다.
        if (calendars.length === 0) setCalendars(await api.calendars());
        setEvEditor({
          initial: {
            summary: m.subject || "(제목 없음)",
            description: `메일에서 만든 일정\n보낸사람: ${m.from}\n받은날짜: ${new Date(m.date).toLocaleString("ko-KR")}\n\n${m.snippet}`,
          },
        });
      });
    },
    [guard, calendars.length],
  );

  // Shared between the normal reader pane and the search slide-over.
  const readerEl = selected ? (
    <Reader
      id={selected.id}
      threadId={selected.threadId}
      onCreateEvent={createEventFromMail}
      me={email}
      inTrash={!query && activeLabel === "TRASH"}
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
        <div className="brand">
          <span className="brand-mark">
            <IconSend />
          </span>
          Mail
        </div>
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
            placeholder="Search"
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
        <span className="topbar-spacer" />
        <button
          className="btn primary compose-btn"
          onClick={() => openCompose(undefined)}
        >
          <IconPen />새 메일
        </button>
        <div className="account">
          {email && (
            <span
              className="avatar xs"
              style={{ background: avatarColor(email.toLowerCase()) }}
              title={email}
            >
              {email.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="email">{email}</span>
          <button
            className="icon-btn"
            title="설정 (서명)"
            onClick={() => setSettingsOpen(true)}
          >
            <IconSliders />
          </button>
          <button
            className="icon-btn"
            title="로그아웃"
            onClick={() =>
              guard(async () => {
                await api.logout();
                onLogout();
              })
            }
          >
            <IconLogout />
          </button>
        </div>
      </header>

      {error && (
        <div className="error" onClick={() => setError(null)}>
          ⚠️ {error} (클릭하여 닫기)
        </div>
      )}

      {acctSettings?.vacation.enabled && (
        <div className="vacation-note">
          🏖 Gmail 휴가 자동응답이 켜져 있습니다
          {acctSettings.vacation.subject && ` — “${acctSettings.vacation.subject}”`}
          {acctSettings.vacation.endTime &&
            ` (${new Date(acctSettings.vacation.endTime).toLocaleDateString("ko-KR", { month: "long", day: "numeric" })}까지)`}
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

          <button
            className={`nav-section ${view === "drive" ? "active" : ""}`}
            onClick={() => {
              setView("drive");
              setQuery("");
              setSearchInput("");
            }}
          >
            <span className="chev">{view === "drive" ? "▾" : "▸"}</span>
            <span>🗂 드라이브</span>
          </button>
        </nav>

        {view === "drive" ? (
          <DriveView onLogout={bgLogout} />
        ) : view === "calendar" ? (
          <CalendarView
            onLogout={bgLogout}
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
            hiddenCals={hiddenCals}
            onLogout={bgLogout}
          />
        ) : (
          <>
            <section className="list">
              {messages.length > 0 && (
                <div className="bulk-bar">
                  <TriCheck
                    checked={allChecked}
                    indeterminate={checkedIds.length > 0}
                    onChange={toggleAll}
                    ariaLabel="전체 선택"
                  />
                  {checkedIds.length > 0 ? (
                    <>
                      <span className="bulk-count">{checkedIds.length}개 선택</span>
                      <span className="bulk-actions">
                        {inTrashView ? (
                          <button className="btn sm" onClick={bulkRestore}>
                            ♻️ 복원
                          </button>
                        ) : (
                          <>
                            <button className="btn sm" onClick={() => bulkRead(true)}>
                              ✉️ 읽음
                            </button>
                            <button className="btn sm" onClick={() => bulkRead(false)}>
                              📩 안읽음
                            </button>
                            <button className="btn sm" onClick={bulkStar}>
                              {allStarred ? "★ 별표 해제" : "☆ 별표"}
                            </button>
                            {isInboxView && (
                              <button className="btn sm" onClick={bulkArchive}>
                                📥 보관
                              </button>
                            )}
                            <button className="btn sm danger" onClick={bulkTrash}>
                              🗑 삭제
                            </button>
                          </>
                        )}
                      </span>
                      <button
                        className="bulk-clear"
                        onClick={clearSelection}
                        aria-label="선택 해제"
                      >
                        ✕
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="bulk-hint"
                      onClick={toggleAll}
                    >
                      전체 선택
                    </button>
                  )}
                </div>
              )}
              {messages.length === 0 && !loading && (
                <div className="empty">메일이 없습니다.</div>
              )}
              {messages.map((m) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  active={selected?.id === m.id}
                  checked={selectedIds.has(m.id)}
                  onSelect={onSelectMsg}
                  onToggleCheck={onToggleCheck}
                />
              ))}
              {loading && <div className="empty">불러오는 중…</div>}
              {nextToken && !loading && (
                <>
                  {/* 스크롤이 바닥 근처에 오면 자동으로 다음 페이지 로드 */}
                  <MoreSentinel onMore={() => load(false)} />
                  <button className="btn more" onClick={() => load(false)}>
                    더 보기
                  </button>
                </>
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
          sendAs={acctSettings?.sendAs}
          onQueue={queueSend}
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

      {evEditor && (
        <EventEditModal
          calendars={calendars.filter(
            (c) => c.accessRole === "owner" || c.accessRole === "writer",
          )}
          initial={evEditor.initial}
          onLogout={bgLogout}
          onClose={() => setEvEditor(null)}
          onSaved={() => setEvEditor(null)}
        />
      )}

      {outbox.length > 0 && (
        <div className="undo-wrap">
          {outbox.map((o) => (
            <div key={o.key} className="undo-toast">
              <span>메일을 곧 보냅니다…</span>
              <button
                className="undo-btn"
                onClick={() => flushOutbox(o.key, o.payload, o.draftId)}
              >
                지금 보내기
              </button>
              <button className="undo-btn primary" onClick={() => cancelSend(o.key)}>
                실행취소
              </button>
            </div>
          ))}
        </div>
      )}
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

// 서명 블록 HTML (`<div class="mail-signature">…`). HTML 서명이 있으면 그대로,
// 없으면 평문 서명을 줄바꿈 보존해 감싼다. 인라인 이미지(data: URI)는 발송 시
// dataUrisToCid가 cid 첨부로 변환한다.
function getSignatureBlockHtml(): string {
  const sigHtml = getSignatureHtml();
  const sigText = getSignature();
  const sig = sigHtml || (sigText ? textToHtml(sigText) : "");
  return sig ? `<div class="mail-signature">--<br>${sig}</div>` : "";
}

// 서명/붙여넣기로 본문에 박힌 data:image base64 → cid 인라인 첨부. 이메일
// 클라이언트는 data: URI 이미지를 막으므로, 발송 직전 multipart/related cid로
// 옮겨야 모든 수신함에서 보인다. 반환 html은 src가 cid:로 치환된 것.
let inlineCidSeq = 0;
function dataUrisToCid(html: string): { html: string; inline: ComposeAttachment[] } {
  if (!/data:image\//i.test(html)) return { html, inline: [] };
  const inline: ComposeAttachment[] = [];
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(src);
      if (!m) return;
      const mimeType = m[1].toLowerCase();
      const data = m[2].replace(/\s/g, "");
      const cid = `inline-${Date.now().toString(36)}-${inlineCidSeq++}@mail.local`;
      const ext = (mimeType.split("/")[1] || "png").split("+")[0];
      inline.push({
        filename: `image-${inlineCidSeq}.${ext}`,
        mimeType,
        data,
        size: Math.floor((data.length * 3) / 4),
        contentId: cid,
      });
      img.setAttribute("src", `cid:${cid}`);
    });
    return { html: doc.body?.innerHTML ?? html, inline };
  } catch {
    return { html, inline: [] };
  }
}

// ---- 기본 글꼴 / 보내기 취소 설정 ----
// 글꼴은 수신자 클라이언트에 그대로 전달되므로 web-safe(윈도·맥 공통 설치)
// 스택만 노출한다 — 웹폰트는 메일에서 렌더 보장이 없다.
const FONT_FAMILY_KEY = "mail.font.family";
const FONT_SIZE_KEY = "mail.font.size";
const UNDO_KEY = "mail.undo.sec";
const FONT_FAMILIES = [
  { label: "글꼴: 기본", css: "" },
  { label: "고딕 (맑은 고딕)", css: "'Malgun Gothic','Apple SD Gothic Neo',sans-serif" },
  { label: "명조 (바탕)", css: "Batang,AppleMyungjo,'Nanum Myeongjo',serif" },
  { label: "Arial", css: "Arial,Helvetica,sans-serif" },
  { label: "Georgia", css: "Georgia,'Times New Roman',serif" },
  { label: "Verdana", css: "Verdana,Geneva,sans-serif" },
  { label: "고정폭 (Courier)", css: "'Courier New',Courier,monospace" },
] as const;
const FONT_SIZES = [
  { label: "크기: 기본", css: "" },
  { label: "작게 (12px)", css: "12px" },
  { label: "보통 (14px)", css: "14px" },
  { label: "크게 (16px)", css: "16px" },
  { label: "아주 크게 (18px)", css: "18px" },
] as const;

function getDefaultFont(): { family: string; size: string } {
  try {
    return {
      family: localStorage.getItem(FONT_FAMILY_KEY) ?? "",
      size: localStorage.getItem(FONT_SIZE_KEY) ?? "",
    };
  } catch {
    return { family: "", size: "" };
  }
}

function getUndoSec(): number {
  try {
    const v = Number(localStorage.getItem(UNDO_KEY) ?? "5");
    return Number.isFinite(v) && v >= 0 ? Math.min(v, 30) : 5;
  } catch {
    return 5;
  }
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const sigEditorRef = useRef<HTMLDivElement>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  // 저장된 HTML 서명(없으면 평문을 HTML로). 에디터는 uncontrolled라 1회만 읽는다.
  const initialSig = useMemo(() => {
    const html = getSignatureHtml();
    const text = getSignature();
    return html || (text ? textToHtml(text) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 붙여넣기/드롭한 이미지는 서명 본문에 인라인으로 박는다 (data: URI → 발송 시 cid).
  const insertImages = (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    void Promise.all(imgs.map(fileToBase64)).then((list) => {
      sigEditorRef.current?.focus();
      for (const im of list) {
        document.execCommand("insertImage", false, `data:${im.mimeType};base64,${im.data}`);
      }
    });
  };
  const initialFont = useMemo(getDefaultFont, []);
  const [fontFamily, setFontFamily] = useState(initialFont.family);
  const [fontSize, setFontSize] = useState(initialFont.size);
  const [undoSec, setUndoSec] = useState(String(getUndoSec()));

  const importFromGmail = async () => {
    setImportMsg(null);
    try {
      const { html } = await api.signature();
      if (!html) {
        setImportMsg("Gmail에 저장된 서명이 없습니다.");
        return;
      }
      if (sigEditorRef.current) sigEditorRef.current.innerHTML = sanitizeMailHtml(html);
      setImportMsg("가져왔습니다 — 자유롭게 편집한 뒤 저장하세요.");
    } catch (e) {
      if (e instanceof AuthError) {
        setImportMsg("로그인이 만료되었습니다. 새로고침 후 다시 로그인하세요.");
      } else {
        setImportMsg(`가져오기 실패: ${(e as Error).message}`);
      }
    }
  };

  const save = () => {
    try {
      const html = sanitizeMailHtml(sigEditorRef.current?.innerHTML ?? "");
      const text = htmlToText(html).trim();
      // 이미지만 있는 서명은 text가 비므로 <img> 유무도 함께 본다.
      if (text !== "" || /<img\b/i.test(html)) {
        localStorage.setItem(SIGNATURE_HTML_KEY, html);
        localStorage.setItem(SIGNATURE_KEY, text);
      } else {
        localStorage.removeItem(SIGNATURE_HTML_KEY);
        localStorage.removeItem(SIGNATURE_KEY);
      }
      if (fontFamily) localStorage.setItem(FONT_FAMILY_KEY, fontFamily);
      else localStorage.removeItem(FONT_FAMILY_KEY);
      if (fontSize) localStorage.setItem(FONT_SIZE_KEY, fontSize);
      else localStorage.removeItem(FONT_SIZE_KEY);
      localStorage.setItem(UNDO_KEY, undoSec);
    } catch {
      // private mode 등: 저장 대상 없음
    }
    onClose();
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
          서명 — 글꼴·크기·색·이미지까지. 발송 시 본문 끝에 자동 추가 (비우면 사용 안 함)
        </div>
        <div className="signature-editor">
          <RichEditor
            editorRef={sigEditorRef}
            initialHtml={initialSig}
            onFiles={insertImages}
            rich
            placeholder={"예) 홍길동 드림 · 010-0000-0000 · 로고 이미지 삽입 가능"}
          />
        </div>
        {importMsg && <div className="muted settings-label">{importMsg}</div>}
        <div className="muted settings-label">
          기본 글꼴 — 새로 쓰는 메일 본문에 적용 (수신자에게도 이 글꼴로 보입니다)
        </div>
        <div className="settings-row">
          <select
            className="ev-input"
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value)}
          >
            {FONT_FAMILIES.map((f) => (
              <option key={f.label} value={f.css}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            className="ev-input"
            value={fontSize}
            onChange={(e) => setFontSize(e.target.value)}
          >
            {FONT_SIZES.map((s) => (
              <option key={s.label} value={s.css}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="muted settings-label">
          보내기 취소 — 발송을 잠시 붙잡아 두고 실행취소 버튼을 제공
        </div>
        <div className="settings-row">
          <select
            className="ev-input"
            value={undoSec}
            onChange={(e) => setUndoSec(e.target.value)}
          >
            <option value="0">사용 안 함 (즉시 발송)</option>
            <option value="5">5초</option>
            <option value="10">10초</option>
            <option value="20">20초</option>
          </select>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => void importFromGmail()}>
            Gmail 서명 가져오기
          </button>
          <span className="modal-spacer" />
          <button className="btn primary" onClick={save}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

const LABEL_ICONS: Record<string, string> = {
  INBOX: "📥",
  STARRED: "⭐",
  SENT: "📤",
  DRAFT: "📝",
  SPAM: "🚫",
  TRASH: "🗑",
};

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
      <span className="label-name">
        <span className="label-ic">{LABEL_ICONS[label.id] ?? "🏷️"}</span>
        {name}
      </span>
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

// 목록/카드에 표시할 상대방: 보낸함·임시보관함(내가 보낸 것)은 받는사람을,
// 그 외에는 보낸사람을 보여준다. 수신자가 여럿이면 "이름 외 N명".
function listParty(m: MessageSummary): { name: string; email: string } {
  const outgoing = m.labelIds.includes("SENT") || m.labelIds.includes("DRAFT");
  const raw = outgoing ? m.to : m.from;
  const toks = splitAddrList(raw);
  if (toks.length === 0) return { name: outgoing ? "(받는사람 없음)" : "(보낸사람 없음)", email: "" };
  const first = parseAddr(toks[0]);
  const name =
    toks.length > 1 ? `${first.name} 외 ${toks.length - 1}명` : first.name;
  return { name, email: first.email };
}

// 체크박스 + "일부만 선택"(indeterminate) 상태 — indeterminate는 속성으로만
// 설정 가능해 ref로 동기화한다.
function TriCheck({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={ariaLabel}
    />
  );
}

const MessageRow = memo(function MessageRow({
  m,
  active,
  checked,
  onSelect,
  onToggleCheck,
}: {
  m: MessageSummary;
  active: boolean;
  checked: boolean;
  onSelect: (id: string, threadId: string) => void;
  onToggleCheck: (id: string, shiftKey: boolean) => void;
}) {
  const addr = listParty(m);
  const label = listDateLabel(m.date);
  // 행 자체는 button을 못 쓴다 — 안에 체크박스(인터랙티브)가 들어가 nesting
  // 위반이 되므로 div + role/tabIndex로 동일한 키보드 동작을 준다.
  return (
    <div
      className={`msg-row ${active ? "active" : ""} ${m.unread ? "unread" : ""} ${
        checked ? "checked" : ""
      }`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(m.id, m.threadId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(m.id, m.threadId);
        }
      }}
    >
      {/* 항상 보이는 전용 선택 칸. 클릭은 이 셀이 받고(행 높이만큼 넓은 영역),
          체크박스는 시각 표시만(pointer-events:none) 한다. */}
      <span
        className="msg-check-cell"
        role="checkbox"
        aria-checked={checked}
        aria-label={`${addr.name || addr.email} 선택`}
        onClick={(e) => {
          e.stopPropagation(); // 행 클릭(리더 열기)으로 번지지 않게
          onToggleCheck(m.id, e.shiftKey);
        }}
      >
        <input type="checkbox" className="msg-check" checked={checked} tabIndex={-1} readOnly />
      </span>
      <span
        className="avatar sm"
        style={{ background: avatarColor(addr.email.toLowerCase()) }}
      >
        {(addr.name || "?").trim().charAt(0).toUpperCase()}
      </span>
      <span className="msg-main">
        <span className="msg-top">
          <span className="msg-from">{addr.name}</span>
          <span className="msg-date">{label}</span>
        </span>
        <span className="msg-subject">
          {m.subject || "(제목 없음)"}
          {m.hasAttachments && <span className="paperclip"> 📎</span>}
        </span>
        <span className="msg-snippet">{m.snippet}</span>
      </span>
    </div>
  );
});

function Reader({
  id,
  threadId,
  me,
  inTrash,
  guard,
  onPatched,
  onRemoved,
  onReply,
  onCreateEvent,
  onClose,
}: {
  id: string;
  threadId: string;
  me: string;
  inTrash: boolean;
  guard: (fn: () => Promise<void>) => Promise<void>;
  onPatched: (id: string, patch: Partial<MessageSummary>) => void;
  onRemoved: (id: string, scope: "inbox" | "trash" | "all") => void;
  onReply: (init: ComposeInit) => void;
  onCreateEvent: (m: MessageFull) => void;
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
                // Forward carries everything: file attachments AND inline cid:
                // images (re-related on send) so the original renders intact.
                const attachments = await Promise.all(
                  msg.attachments.map((a) => downloadAttachment(msg.id, a)),
                );
                onReply({
                  subject: fwdSubject(msg.subject),
                  forward: true,
                  quoteHtml: msg.bodyHtml || textToHtml(msg.bodyText || msg.snippet || ""),
                  quoteFrom: msg.from,
                  quoteDate: msg.date,
                  quoteTo: msg.to,
                  quoteSubject: msg.subject,
                  attachments,
                });
              })
            }
          >
            ↪ 전달
          </button>
          <button
            className="btn"
            title="이 메일 내용으로 캘린더 일정 만들기"
            onClick={() => onCreateEvent(msg)}
          >
            📅 일정
          </button>
          {thread && thread.length > 1 && (
            <button
              className="btn"
              title="이 대화의 모든 메시지를 시간순으로 묶어 전달"
              onClick={() =>
                guard(async () => {
                  // 첨부는 스레드 전체에서 수집. cid가 겹치면(드물지만 메시지가
                  // 다르면 가능) 먼저 온 것을 유지 — 본문 cid: 참조를 메시지별로
                  // 다시 쓰지 않는 한 구분할 방법이 없다.
                  const all = await Promise.all(
                    thread.flatMap((tm) =>
                      tm.attachments.map((a) => downloadAttachment(tm.id, a)),
                    ),
                  );
                  const seenCid = new Set<string>();
                  const attachments = all.filter((a) => {
                    if (!a.contentId) return true;
                    if (seenCid.has(a.contentId)) return false;
                    seenCid.add(a.contentId);
                    return true;
                  });
                  onReply({
                    subject: fwdSubject(msg.subject),
                    forward: true,
                    quoteHtml: threadQuoteHtml(thread),
                    quoteSubject: msg.subject,
                    attachments,
                  });
                })
              }
            >
              ↪↪ 전체 전달
            </button>
          )}
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
          {inTrash ? (
            // 휴지통: trash/보관/스팸은 모두 no-op이므로 '복원'만 노출.
            <button
              className="btn"
              onClick={() =>
                guard(async () => {
                  await api.modify(id, { add: ["INBOX"], remove: ["TRASH"] });
                  onRemoved(id, "all");
                  onClose();
                })
              }
            >
              ♻️ 받은편지함으로 복원
            </button>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
      {(thread ?? [msg]).map((tm) => (
        <ThreadMessage
          key={tm.id}
          m={tm}
          guard={guard}
          onComposeTo={(email) => onReply({ to: email })}
        />
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

// 전체 전달: 스레드의 모든 메시지를 시간순으로, 메시지별 보낸사람/날짜 헤더를
// 붙여 하나의 인용 HTML로 조립한다. sanitize는 buildQuotedHtml(forward)이
// 전체에 대해 한 번 수행하므로 여기서는 조립만 한다.
function threadQuoteHtml(msgs: MessageFull[]): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return msgs
    .map((m) => {
      const addr = parseAddr(m.from);
      const when = new Date(m.date).toLocaleString("ko-KR");
      const body = m.bodyHtml || textToHtml(m.bodyText || m.snippet || "");
      return (
        `<div style="margin:0 0 20px">` +
        `<div style="font-size:12.5px;line-height:1.7;color:#5f6368;` +
        `border-bottom:1px solid #e3e7ee;padding-bottom:6px;margin-bottom:10px">` +
        `<b>${esc(addr.name)}</b> &lt;${esc(addr.email)}&gt; · ${esc(when)}<br>` +
        `받는사람: ${esc(m.to)}${m.cc ? `<br>참조: ${esc(m.cc)}` : ""}</div>` +
        `${body}</div>`
      );
    })
    .join("");
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
    // 원본 HTML 보존 — 없으면 평문을 HTML로 감싸 인용
    quoteHtml: msg.bodyHtml || textToHtml(msg.bodyText || msg.snippet || ""),
    quoteFrom: msg.from,
    quoteDate: msg.date,
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
  onComposeTo,
}: {
  m: MessageFull;
  guard: (fn: () => Promise<void>) => Promise<void>;
  onComposeTo: (email: string) => void;
}) {
  // Inline (cid:) image parts → attachment URLs for the HTML body.
  const cidUrls = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of m.attachments) {
      if (a.contentId) map.set(a.contentId, api.attachmentUrl(m.id, a.id, a.filename));
    }
    return map;
  }, [m]);
  // 첨부 → Drive 저장 진행/결과 표시 (메시지 단위).
  const [driveMsg, setDriveMsg] = useState<string | null>(null);
  const saveToDrive = (a: {
    id: string;
    filename: string;
    mimeType: string;
  }) => {
    setDriveMsg(`Drive에 저장 중: ${a.filename}…`);
    void guard(async () => {
      try {
        await api.attachmentToDrive(m.id, a.id, a.filename, a.mimeType);
        setDriveMsg(`✅ Drive에 저장됨: ${a.filename}`);
      } catch (e) {
        setDriveMsg(null); // 에러는 guard 배너로 — 낙관 문구는 지운다
        throw e;
      }
    });
  };
  return (
    <div className="thread-msg">
      <div className="reader-meta">
        <strong>{parseAddr(m.from).name}</strong>{" "}
        <button
          type="button"
          className="addr-link muted"
          title="이 주소로 새 메일"
          onClick={() => onComposeTo(parseAddr(m.from).email)}
        >
          &lt;{parseAddr(m.from).email}&gt;
        </button>
        <div className="muted">받는사람: {m.to}</div>
        {m.cc && <div className="muted">참조: {m.cc}</div>}
        <div className="muted">{new Date(m.date).toLocaleString("ko-KR")}</div>
      </div>
      {m.attachments.some((a) => !a.contentId) && (
        <div className="attachments">
          {m.attachments
            .filter((a) => !a.contentId) // inline images render in the body
            .map((a) => (
              <span key={a.id} className="chip">
                <a
                  className="chip-link"
                  href={api.attachmentUrl(m.id, a.id, a.filename)}
                  onClick={(e) => {
                    e.preventDefault();
                    void guard(() => saveAttachment(m.id, a));
                  }}
                >
                  📎 {a.filename} ({Math.round(a.size / 1024)}KB)
                </a>
                <button
                  type="button"
                  className="chip-x"
                  title="내 Drive에 저장"
                  onClick={() => saveToDrive(a)}
                >
                  ☁️
                </button>
              </span>
            ))}
          {driveMsg && <div className="muted att-drive-msg">{driveMsg}</div>}
        </div>
      )}
      <div className="reader-body">
        {m.bodyHtml ? (
          <HtmlBody html={m.bodyHtml} id={m.id} cidUrls={cidUrls} onComposeTo={onComposeTo} />
        ) : (
          <TextBody text={m.bodyText || m.snippet} onComposeTo={onComposeTo} />
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

function TextBody({
  text,
  onComposeTo,
}: {
  text: string;
  onComposeTo: (email: string) => void;
}) {
  const parts = useMemo(() => linkifyParts(text), [text]);
  return (
    <pre className="text-body">
      {parts.map((p, i) =>
        p.href ? (
          p.href.startsWith("mailto:") ? (
            // 본문 이메일 주소 → 시스템 메일앱(iCloud 등)이 아니라 이 앱의 작성창
            <a
              key={i}
              href={p.href}
              onClick={(e) => {
                e.preventDefault();
                onComposeTo(p.href!.slice("mailto:".length));
              }}
            >
              {p.text}
            </a>
          ) : (
            <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
              {p.text}
            </a>
          )
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
  onComposeTo,
}: {
  html: string;
  id: string;
  cidUrls?: Map<string, string>;
  onComposeTo: (email: string) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  // 부모가 onLoad에서 iframe 문서에 click 리스너를 단다 — 최신 콜백을 ref로
  // 잡아 stale 클로저를 피한다.
  const composeRef = useRef(onComposeTo);
  composeRef.current = onComposeTo;
  // DOMParser full-parse is not free on big newsletters — don't redo it when
  // unrelated parent state (star toggle etc.) re-renders this component.
  const srcDoc = useMemo(() => prepareEmailHtml(html, undefined, cidUrls), [html, cidUrls]);

  const resize = useCallback(() => {
    const f = ref.current;
    const doc = f?.contentDocument;
    if (!f || !doc) return;
    // scrollHeight는 현재 뷰포트(=iframe 높이)보다 작아지지 않아 인용 접기로
    // 본문이 줄어도 높이가 따라 줄지 않는다 — 측정 전에 리셋한다. 두 스타일
    // 쓰기와 측정이 같은 태스크 안이라 중간 페인트(깜빡임)는 없다.
    const prev = f.style.height;
    f.style.height = "8px";
    const h = Math.max(
      doc.body?.scrollHeight ?? 0,
      doc.documentElement?.scrollHeight ?? 0,
    );
    f.style.height = h ? `${h + 8}px` : prev;
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
    // 인용 접기(<details>) 토글 시 본문 높이가 바뀐다 — toggle은 버블링하지
    // 않으므로 캡처 단계에서 받아 재계산.
    doc.addEventListener("toggle", resize, true);
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
        // 시스템 메일앱(iCloud 등) 대신 이 앱의 작성창을 연다.
        e.preventDefault();
        let addr = href.slice(href.indexOf(":") + 1).split("?")[0];
        try {
          addr = decodeURIComponent(addr);
        } catch {
          // 잘못된 % 이스케이프(스팸 등): 원본 그대로 사용
        }
        composeRef.current(addr);
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
  contentId?: string; // inline (cid:) image — re-related on forward
};

type ComposeInit = {
  to?: string;
  cc?: string;
  subject?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string; // accumulated RFC 5322 chain (원본 References + Message-ID)
  bcc?: string;
  // 답장/전달 인용 — 원본 HTML을 보존해 blockquote로 싣는다 (평문으로 펼치지 않음)
  quoteHtml?: string;
  quoteFrom?: string;
  quoteDate?: string;
  quoteTo?: string;
  quoteSubject?: string;
  forward?: boolean; // 전달이면 인용을 "전달된 메일" 헤더 형식으로
  from?: string; // 드래프트 이어쓰기 시 원래 보내는 주소(별칭) 복원용
  attachments?: ComposeAttachment[];
  bodyHtml?: string; // 드래프트 이어쓰기 — 저장된 HTML 그대로
  draftId?: string; // editing this Gmail draft: update on save, delete on send
};

// api.send가 받는 발송 페이로드 — 보내기 취소 큐가 그대로 들고 있는다.
type SendPayload = Parameters<typeof api.send>[0];

// 답장/전달 시 에디터에 까는 인용 HTML. 원본 HTML을 그대로 blockquote에 넣어
// 서식·인라인 이미지(cid:)를 보존한다.
function buildQuotedHtml(init?: ComposeInit): string {
  if (!init?.quoteHtml) return "";
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const when = init.quoteDate
    ? new Date(init.quoteDate).toLocaleString("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  // 위생 처리 필수 — 받은 메일의 원본 HTML이 에디터(메인 문서)에 innerHTML로
  // 들어가므로 <img onerror> 류가 마운트 즉시 실행되는 걸 막는다. 전달은 인라인
  // 이미지를 재첨부하므로 cid: 유지, 답장은 재첨부 안 하므로 cid: 이미지 제거.
  if (init.forward) {
    const safe = sanitizeMailHtml(init.quoteHtml);
    const rows = [
      ["보낸사람", init.quoteFrom],
      ["날짜", when],
      ["제목", init.quoteSubject],
      ["받는사람", init.quoteTo],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${esc(String(v))}`)
      .join("<br>");
    // 전달 블록: 상단 구분선 + "전달된 메일" 라벨, 메타와 본문을 왼쪽 강조선으로
    // 들여써 원문과 명확히 구분 (인라인 스타일 — 수신자 클라이언트에도 적용).
    return (
      `<br><div class="mail-fwd" style="margin-top:14px;border-top:1px solid #e3e7ee;padding-top:12px">` +
      `<div style="font-size:12px;font-weight:600;letter-spacing:.3px;color:#8a93a3;text-transform:uppercase;margin-bottom:10px">전달된 메일</div>` +
      `<div style="border-left:3px solid #c8d0dd;padding-left:14px">` +
      `<div style="font-size:12.5px;line-height:1.7;color:#5f6368;margin-bottom:10px">${rows}</div>` +
      `${safe}</div></div>`
    );
  }
  const safe = sanitizeMailHtml(init.quoteHtml, { dropCidImages: true });
  const attr = `${when ? when + ", " : ""}${esc(init.quoteFrom ?? "")} 님이 작성:`;
  return (
    `<br><div class="mail-quote">` +
    `<div style="font-size:12.5px;color:#8a93a3;margin-bottom:6px">${attr}</div>` +
    `<blockquote style="margin:0;border-left:3px solid #c8d0dd;padding-left:14px;color:#3c4453">` +
    `${safe}</blockquote></div>`
  );
}

// 메일 본문 HTML 위생 처리. 두 곳에서 쓴다:
//  (1) 받은 메일/드래프트 HTML이 에디터(contentEditable, 메인 문서)에 innerHTML로
//      들어가기 "전" — <img onerror>·<svg onload> 류 인라인 핸들러가 마운트 즉시
//      실행되는 XSS를 막는다 (받은 메일 보기는 무스크립트 iframe이라 안전하지만
//      에디터는 그렇지 않다).
//  (2) 발송 직전 — 수신자/SENT 함을 위한 방어.
const URL_ATTRS = new Set([
  "href",
  "src",
  "xlink:href",
  "formaction",
  "action",
  "background",
  "poster",
]);
const DANGER_SCHEME = /^(javascript|vbscript|data):/i;
// strip control/space chars so "java\nscript:" can't slip past the scheme test
const CTRL_WS = /[\u0000-\u0020]/g;

function sanitizeMailHtml(html: string, opts?: { dropCidImages?: boolean }): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc
      .querySelectorAll("script,style,meta,link,title,base,iframe,object,embed,form")
      .forEach((n) => n.remove());
    if (opts?.dropCidImages) {
      // 답장 인용엔 인라인 이미지를 재첨부하지 않으므로 cid: 참조 이미지를 제거 —
      // 안 그러면 수신자에게 깨진 이미지로 보인다.
      doc.querySelectorAll("img[src]").forEach((img) => {
        if (/^cid:/i.test(img.getAttribute("src") ?? "")) img.remove();
      });
    }
    doc.querySelectorAll("*").forEach((el) => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const val = attr.value.replace(CTRL_WS, "");
        if (name.startsWith("on")) {
          el.removeAttribute(attr.name);
        } else if (
          name === "style" &&
          /expression\(|url\(\s*['"]?\s*(javascript|vbscript):/i.test(attr.value)
        ) {
          el.removeAttribute(attr.name);
        } else if (URL_ATTRS.has(name) && DANGER_SCHEME.test(val)) {
          if (!/^data:image\//i.test(val)) el.removeAttribute(attr.name); // data:image만 허용
        }
      }
    });
    return doc.body?.innerHTML ?? "";
  } catch {
    return "";
  }
}

// 서식 작성 에디터 — contentEditable + 툴바. 외부 라이브러리 없이
// document.execCommand로 굵게/기울임/밑줄/목록/링크를 처리한다. 본문은
// 부모가 editorRef.current.innerHTML로 읽어 발송한다 (uncontrolled).
function RichEditor({
  editorRef,
  initialHtml,
  onFiles,
  rich,
  placeholder,
  bodyStyle,
}: {
  editorRef: React.RefObject<HTMLDivElement>;
  initialHtml: string;
  onFiles: (files: File[]) => void;
  rich?: boolean; // 폰트·크기·색상·이미지 삽입 툴 노출
  placeholder?: string;
  bodyStyle?: React.CSSProperties; // 기본 글꼴 미리보기 (발송 HTML과 시각 일치)
}) {
  const imgInputRef = useRef<HTMLInputElement>(null);
  // contentEditable은 select/color/파일다이얼로그로 포커스를 뺏기면 caret을 잃는다.
  // 에디터를 누를/칠 때마다 range를 저장해 두고, 서식 적용 직전 복원한다.
  const savedRange = useRef<Range | null>(null);

  // 마운트 시 1회만 주입 — contentEditable은 uncontrolled로 둔다.
  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = initialHtml;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSel = () => {
    const sel = window.getSelection?.();
    if (
      sel &&
      sel.rangeCount > 0 &&
      editorRef.current &&
      editorRef.current.contains(sel.anchorNode)
    ) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
    }
  };
  const restoreSel = () => {
    const sel = window.getSelection?.();
    if (sel && savedRange.current) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
  };

  const cmd = (command: string, value?: string) => {
    editorRef.current?.focus();
    try {
      // 폰트/크기/색을 <font> 대신 인라인 style로 — 이메일 클라이언트 호환이 낫다.
      document.execCommand("styleWithCSS", false, "true");
    } catch {
      /* 미지원 브라우저는 레거시 태그로 폴백 */
    }
    document.execCommand(command, false, value);
  };
  // 저장된 selection 복원 후 적용 (font/size/color/image 공용)
  const applyWithSel = (command: string, value: string) => {
    restoreSel();
    cmd(command, value);
  };
  const makeLink = () => {
    const sel = window.getSelection?.()?.toString();
    const url = window.prompt("링크 URL:", sel && /^https?:/i.test(sel) ? sel : "https://");
    if (url) cmd("createLink", url);
  };
  // 본문 인라인 이미지 — data: URI로 삽입하고, 발송 시 dataUrisToCid가 cid 첨부로 옮긴다.
  const insertInlineImages = (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    void Promise.all(imgs.map(fileToBase64)).then((list) => {
      restoreSel();
      editorRef.current?.focus();
      for (const im of list) {
        document.execCommand("insertImage", false, `data:${im.mimeType};base64,${im.data}`);
      }
      saveSel();
    });
  };
  // 버튼이 selection을 빼앗지 않게 mousedown 기본동작 차단 후 click에서 실행
  const tool = (
    label: ReactNode,
    action: () => void,
    title: string,
  ) => (
    <button
      type="button"
      className="rich-tool"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
    >
      {label}
    </button>
  );


  return (
    <div className="rich-compose">
      <div className="rich-toolbar">
        <select
          className="rich-select"
          title="글꼴 (선택 영역 또는 이후 입력에 적용)"
          value=""
          onMouseDown={saveSel}
          onChange={(e) => {
            if (e.target.value) applyWithSel("fontName", e.target.value);
          }}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.label} value={f.css} disabled={!f.css}>
              {f.label.replace("글꼴: 기본", "글꼴")}
            </option>
          ))}
        </select>
        <select
          className="rich-select"
          title="글자 크기 (선택 영역 또는 이후 입력에 적용)"
          value=""
          onMouseDown={saveSel}
          onChange={(e) => {
            if (e.target.value) applyWithSel("fontSize", e.target.value);
          }}
        >
          <option value="" disabled>
            크기
          </option>
          <option value="1">작게</option>
          <option value="3">보통</option>
          <option value="5">크게</option>
          <option value="7">아주 크게</option>
        </select>
        <span className="rich-sep" />
        {tool(<b>B</b>, () => cmd("bold"), "굵게")}
        {tool(<i>I</i>, () => cmd("italic"), "기울임")}
        {tool(<u>U</u>, () => cmd("underline"), "밑줄")}
        {rich && (
          <>
            <span className="rich-sep" />
            <input
              type="color"
              className="rich-color"
              title="글자 색"
              defaultValue="#202124"
              onMouseDown={saveSel}
              onChange={(e) => applyWithSel("foreColor", e.target.value)}
            />
          </>
        )}
        <span className="rich-sep" />
        {tool("• 목록", () => cmd("insertUnorderedList"), "글머리 목록")}
        {tool("1. 목록", () => cmd("insertOrderedList"), "번호 목록")}
        <span className="rich-sep" />
        {tool("🔗", makeLink, "링크")}
        {rich &&
          tool(
            "🖼",
            () => {
              saveSel();
              imgInputRef.current?.click();
            },
            "이미지 삽입",
          )}
        {tool("✕서식", () => cmd("removeFormat"), "서식 지우기")}
        {rich && (
          <input
            ref={imgInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = "";
              insertInlineImages(picked);
            }}
          />
        )}
      </div>
      <div
        ref={editorRef}
        className="rich-body"
        style={bodyStyle}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder ?? "내용을 입력하세요"}
        onMouseUp={saveSel}
        onKeyUp={saveSel}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files);
          if (pasted.length) {
            e.preventDefault(); // 파일/스크린샷 붙여넣기 → 첨부
            onFiles(pasted);
          }
          // 그 외(텍스트/HTML)는 브라우저 기본 붙여넣기에 맡긴다
        }}
      />
    </div>
  );
}

// "Name <email>" 또는 "email" 토큰이 유효한 주소를 담고 있나 (대략적).
function tokenHasEmail(tok: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(parseAddr(tok).email);
}

// 수신자 칩 입력. value는 콤마 구분 문자열(send/draft가 그대로 읽음)이고,
// 확정된 토큰은 칩으로, 입력 중인 것은 인풋에 둔다.
//  · 확정: 콤마/세미콜론/엔터/탭, 그리고 "완성된 단독 이메일 뒤 공백"
//    (표시명에는 공백이 있을 수 있어 "이름 <메일>" 입력은 공백으로 끊지 않음)
//  · 칩 본문 클릭 또는 빈 인풋에서 백스페이스 → 그 칩을 인풋으로 되돌려 수정
//  · ✕ → 삭제
//  · blur 시 입력 중이던 텍스트도 확정 → 보내기 직전 누락 방지
function RecipientField({
  label,
  value,
  onChange,
  autoFocus,
  suggestions,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  suggestions?: Contact[];
}) {
  const [draft, setDraft] = useState("");
  // 자동완성: 드롭다운에서 ↑↓로 고른 항목. -1 = 선택 없음(Enter는 입력값 확정).
  const [hi, setHi] = useState(-1);
  // Escape로 닫은 상태 — 다음 입력 변경까지 드롭다운을 띄우지 않는다.
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const items = splitAddrList(value);

  // 이미 칩으로 추가된 주소는 제안에서 뺀다.
  const matches = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (dismissed || !q || !suggestions?.length) return [];
    const used = new Set(items.map((t) => parseAddr(t).email.toLowerCase()));
    return suggestions
      .filter(
        (s) =>
          !used.has(s.email.toLowerCase()) &&
          (s.email.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)),
      )
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, suggestions, value, dismissed]);

  const pick = (s: Contact) => {
    addTokens([s.name ? `${s.name} <${s.email}>` : s.email]);
    setDraft("");
    setHi(-1);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const setItems = (next: string[]) => onChange(next.filter(Boolean).join(", "));
  const addTokens = (toks: string[]) => {
    const clean = toks.map((t) => t.trim()).filter(Boolean);
    if (clean.length) setItems([...items, ...clean]);
  };
  const removeAt = (i: number) => setItems(items.filter((_, j) => j !== i));
  // 칩을 인풋으로 되돌려 수정. 입력 중이던 draft가 있으면 먼저 칩으로 확정.
  const editAt = (i: number) => {
    const tok = items[i];
    const rest = items.filter((_, j) => j !== i);
    setItems(draft.trim() ? [...rest, draft.trim()] : rest);
    setDraft(tok);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <label className="recip-field">
      <span className="recip-label">{label}</span>
      <span className="recip-box">
        {items.map((tok, i) => {
          const a = parseAddr(tok);
          const hasName = !!a.name && a.name !== a.email;
          return (
            <span
              key={`${tok}-${i}`}
              className={`recip-chip${tokenHasEmail(tok) ? "" : " invalid"}`}
              title={`${tok} (클릭하여 수정)`}
              onClick={() => editAt(i)}
            >
              {/* 이메일은 항상 표시 — 이름만 보이면 누구에게 가는지 확인 불가 */}
              {hasName && <span className="recip-chip-name">{a.name}</span>}
              <span className="recip-chip-mail">{a.email}</span>
              <button
                type="button"
                className="recip-x"
                onClick={(e) => {
                  e.stopPropagation(); // 칩 수정과 구분
                  removeAt(i);
                }}
              >
                ✕
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          className="recip-input"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          value={draft}
          placeholder={items.length === 0 ? `${label} 추가` : ""}
          onChange={(e) => {
            const v = e.target.value;
            setHi(-1); // 입력이 바뀌면 드롭다운 선택은 초기화
            setDismissed(false);
            if (/[,;]/.test(v)) {
              // 구분자 기준으로 끊어 앞부분은 확정, 마지막 조각만 draft로
              const parts = v.split(/[,;]+/);
              const last = parts.pop() ?? "";
              addTokens(parts);
              setDraft(last);
            } else if (/\s$/.test(v)) {
              // 완성된 "단독 이메일" 뒤 공백 → 자동 칩 (표시명 입력은 제외)
              const t = v.trim();
              if (t && !t.includes("<") && tokenHasEmail(t)) {
                addTokens([t]);
                setDraft("");
              } else {
                setDraft(v);
              }
            } else {
              setDraft(v);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && matches.length) {
              e.preventDefault();
              setHi((h) => (h + 1) % matches.length);
            } else if (e.key === "ArrowUp" && matches.length) {
              e.preventDefault();
              setHi((h) => (h <= 0 ? matches.length - 1 : h - 1));
            } else if (e.key === "Escape" && matches.length) {
              e.preventDefault();
              setHi(-1);
              setDismissed(true); // 드롭다운만 닫는다 (입력값은 유지)
            } else if (e.key === "Enter" || e.key === "Tab") {
              if (hi >= 0 && matches[hi]) {
                e.preventDefault();
                pick(matches[hi]);
              } else if (draft.trim()) {
                e.preventDefault();
                addTokens([draft]);
                setDraft("");
              }
            } else if (e.key === "Backspace" && !draft && items.length) {
              // 통째 삭제 대신 마지막 칩을 인풋으로 되돌려 수정
              e.preventDefault();
              editAt(items.length - 1);
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (/[,;\n]/.test(text)) {
              e.preventDefault();
              addTokens(splitAddrList(text.replace(/\n/g, ",")));
            }
          }}
          // 입력 중이던 주소도 확정 — 안 하면 보내기 시 누락된다.
          onBlur={() => {
            if (draft.trim()) {
              addTokens([draft]);
              setDraft("");
            }
            setHi(-1);
          }}
        />
        {matches.length > 0 && (
          <ul className="recip-suggest" role="listbox">
            {matches.map((s, i) => (
              <li
                key={s.email}
                role="option"
                aria-selected={i === hi}
                className={i === hi ? "active" : ""}
                // mousedown: click이면 blur가 먼저 와서 draft가 칩으로 확정돼
                // 버린다 — 포커스를 안 뺏고 바로 선택.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setHi(i)}
              >
                {s.name && <span className="recip-sug-name">{s.name}</span>}
                <span className="recip-sug-mail">{s.email}</span>
              </li>
            ))}
          </ul>
        )}
      </span>
    </label>
  );
}

// 연락처는 작성창 첫 오픈 때 한 번만 가져와 모듈 캐시. 실패는 조용히 빈 목록 —
// contacts 스코프가 없는 구 토큰에서 자동완성 하나 때문에 로그인으로 보내지
// 않는다 (재시도는 다음 작성창 오픈 때).
let contactsPromise: Promise<Contact[]> | null = null;
function loadContactsOnce(): Promise<Contact[]> {
  contactsPromise ??= api.contacts().catch(() => {
    contactsPromise = null;
    return [];
  });
  return contactsPromise;
}

function Compose({
  init,
  sendAs,
  onClose,
  onSaved,
  onSent,
  onQueue,
}: {
  init?: ComposeInit;
  sendAs?: SendAsInfo[];
  onClose: () => void;
  onSaved: () => void;
  onSent: () => void;
  // 보내기 취소 큐 — 있으면(그리고 대기시간>0) 발송을 부모 큐에 위임한다.
  onQueue?: (payload: SendPayload, draftId?: string) => void;
}) {
  // 기본 글꼴 (설정) — 에디터 표시와 발송 HTML 래퍼에 동일하게 적용.
  const defaultFont = useMemo(getDefaultFont, []);
  // 보내는 주소: 검증된 별칭이 둘 이상일 때만 선택 UI가 뜬다. Gmail은
  // 미검증 별칭의 From을 기본 주소로 강제 재작성하므로 verified만 노출.
  const aliases = (sendAs ?? []).filter((s) => s.verified);
  const defaultAlias = () =>
    aliases.find((s) => s.isDefault) ?? aliases.find((s) => s.isPrimary) ?? aliases[0];
  // 드래프트 이어쓰기 시 원래 별칭(init.from) 복원, 아니면 기본 별칭.
  const initFromEmail = init?.from ? parseAddr(init.from).email.toLowerCase() : "";
  const [fromEmail, setFromEmail] = useState(
    () =>
      aliases.find((s) => s.email.toLowerCase() === initFromEmail)?.email ??
      defaultAlias()?.email ??
      "",
  );
  // 별칭 목록이 비어 있다가(설정 비동기 로드) 나중에 채워지면 보내는 주소를
  // 기본값으로 동기화 — 표시값과 실제 발송 From의 불일치를 막는다.
  useEffect(() => {
    if (aliases.length && !aliases.some((s) => s.email === fromEmail)) {
      setFromEmail(
        aliases.find((s) => s.email.toLowerCase() === initFromEmail)?.email ??
          defaultAlias()?.email ??
          "",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendAs]);
  // 받는사람 자동완성용 연락처 (실패 시 빈 목록 — 기능만 조용히 꺼진다).
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

  // chosenAlias가 아직 비어 있어도(레이스) 기본 별칭으로 폴백해 표시값과 일치.
  const chosenAlias = aliases.find((s) => s.email === fromEmail) ?? defaultAlias();
  const fromHeader = chosenAlias
    ? chosenAlias.displayName
      ? `"${chosenAlias.displayName.replace(/"/g, "")}" <${chosenAlias.email}>`
      : chosenAlias.email
    : undefined;
  // 인라인 이미지(cid:) 미리보기 매핑 (마운트 1회). 전달/드래프트 인라인 첨부를
  // blob URL로 만들어 에디터에 보여주고, 발송 직전 cid:로 되돌린다.
  const editorRef = useRef<HTMLDivElement>(null);
  const cidMaps = useRef<{ cidToUrl: Map<string, string>; urlToCid: Map<string, string> }>({
    cidToUrl: new Map(),
    urlToCid: new Map(),
  });
  useMemo(() => {
    const cidToUrl = new Map<string, string>();
    const urlToCid = new Map<string, string>();
    for (const a of init?.attachments ?? []) {
      if (!a.contentId) continue;
      try {
        const url = base64ToObjectUrl(a.data, a.mimeType);
        cidToUrl.set(a.contentId, url);
        urlToCid.set(url, a.contentId);
      } catch {
        /* bad base64 — leave cid as-is (broken preview, still sends) */
      }
    }
    cidMaps.current = { cidToUrl, urlToCid };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(
    () => () => cidMaps.current.urlToCid.forEach((_, url) => URL.revokeObjectURL(url)),
    [],
  );

  const initialHtml = useMemo(() => {
    // 드래프트 이어쓰기: 저장된 HTML. Gmail-web 드래프트엔 위험 마크업이 있을 수
    // 있으므로 에디터(메인 문서)에 넣기 전 위생 처리한다.
    let html: string;
    if (init?.draftId || init?.bodyHtml) {
      html = init?.bodyHtml ? sanitizeMailHtml(init.bodyHtml) : "<div><br></div>";
    } else {
      // 새 메일 / 답장 / 전달: 입력칸 + 서명 + 인용
      const sigBlock = getSignatureBlockHtml();
      const sig = sigBlock ? `<br>${sigBlock}` : "";
      html = `<div><br></div>${sig}${buildQuotedHtml(init)}`;
    }
    // cid: → blob URL (에디터에서 인라인 이미지가 보이도록)
    return resolveCidSrc(html, cidMaps.current.cidToUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [to, setTo] = useState(init?.to ?? "");
  const [cc, setCc] = useState(init?.cc ?? "");
  const [bcc, setBcc] = useState(init?.bcc ?? "");
  const [subject, setSubject] = useState(init?.subject ?? "");
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

  // 서명은 새 메일/답장/전달에만 자동 주입된다(드래프트 이어쓰기는 제외).
  // 작성 중 한 번에 빼거나 다시 넣을 수 있게 토글한다.
  const hasSig = !init?.draftId && !init?.bodyHtml && !!getSignatureBlockHtml();
  const [sigOn, setSigOn] = useState(hasSig);
  const toggleSignature = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const existing = ed.querySelector(".mail-signature");
    if (existing) {
      const prev = existing.previousSibling;
      if (prev && prev.nodeName === "BR") prev.remove();
      existing.remove();
      setSigOn(false);
    } else {
      const block = getSignatureBlockHtml();
      if (!block) return;
      const tmp = document.createElement("div");
      tmp.innerHTML = `<br>${block}`;
      // 입력칸(첫 자식) 바로 뒤, 인용보다 앞에 되돌린다.
      const anchor = ed.firstChild ? ed.firstChild.nextSibling : null;
      for (const node of Array.from(tmp.childNodes)) ed.insertBefore(node, anchor);
      setSigOn(true);
    }
  };

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
        // 25MB 초과분은 발송 시 자동으로 Drive 링크로 전환되므로 막지 않는다.
        // 다만 브라우저가 base64를 메모리에 들고 POST하므로 과도한 총량은 차단.
        const HARD_CAP = 200 * 1024 * 1024;
        if (totalSize.current + added > HARD_CAP) {
          throw new Error(
            `첨부 합계가 200MB를 초과합니다 (${Math.round((totalSize.current + added) / 1024 / 1024)}MB). 아주 큰 파일은 드라이브 탭에서 직접 업로드해 링크를 공유하세요.`,
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
    // 임시저장 경로: Drive 분할이 없으므로(중복 업로드 방지) MIME 한도를 그대로
    // 강제한다. Forwarded attachments arrive via init and bypass addFiles —
    // enforce the limit at the exit too, or oversized forwards bounce at Gmail.
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > MAX_ATTACH_BYTES) {
      throw new Error(
        `첨부 합계가 25MB를 초과합니다 (${Math.round(total / 1024 / 1024)}MB). 임시저장은 25MB까지만 가능합니다 (발송은 초과분을 자동으로 드라이브 링크로 보냅니다).`,
      );
    }
  };

  // 발송 경로: MIME 한도 초과 일반 첨부는 Drive로 빠지므로 막지 않는다. 단
  // 인라인(cid) 이미지는 Drive로 옮길 수 없으니 그것만으로 한도를 넘으면 차단.
  const assertInlineFits = () => {
    const inlineTotal = files
      .filter((f) => f.contentId)
      .reduce((s, f) => s + f.size, 0);
    if (inlineTotal > MAX_ATTACH_BYTES) {
      throw new Error(
        `본문 인라인 이미지 합계가 25MB를 초과합니다 (${Math.round(inlineTotal / 1024 / 1024)}MB). 일부 이미지를 제거하세요.`,
      );
    }
  };

  // 에디터 HTML(위생 처리) + 그로부터 파생한 text/plain 대체본 + 첨부 페이로드.
  // 서명·인용은 에디터 콘텐츠에 이미 들어 있으므로 발송 시 따로 덧붙이지 않는다.
  //
  // mode="send": MIME 한도(25MB)를 넘는 일반 첨부는 Drive로 올려 본문 링크로
  // 전환한다(Gmail 웹과 동일). 인라인(cid) 이미지는 본문이 참조하므로 항상 MIME.
  // mode="draft": Drive는 발송 때만 — 임시저장 시 매번 업로드하면 중복 파일이
  // 쌓이므로 분할하지 않고 전부 MIME로 둔다(한도 초과는 assertSendableSize가 차단).
  const composedPayload = (mode: "send" | "draft" = "send") => {
    // blob URL(미리보기) → cid: 복원 → 위생 처리 → multipart/related 재연결 유지
    const restored = restoreCidSrc(
      editorRef.current?.innerHTML ?? "",
      cidMaps.current.urlToCid,
    );
    let html = sanitizeMailHtml(restored);
    // 기본 글꼴: 본문 전체를 인라인 스타일 래퍼로 감싼다 (수신자에게도 적용).
    // 드래프트 재저장 시 중복 래핑 방지 — 이미 래퍼로 시작하면 건너뛴다.
    if (
      (defaultFont.family || defaultFont.size) &&
      !/^<div class="mail-font-wrap"/.test(html.trim())
    ) {
      const style =
        (defaultFont.family ? `font-family:${defaultFont.family};` : "") +
        (defaultFont.size ? `font-size:${defaultFont.size};` : "");
      html = `<div class="mail-font-wrap" style="${style}">${html}</div>`;
    }
    // 서명·붙여넣기로 박힌 data:image → cid 인라인 첨부 (이메일은 data: 이미지를 막음)
    const { html: cidHtml, inline: sigInline } = dataUrisToCid(html);
    html = sanitizeMailHtml(cidHtml);
    const allFiles = sigInline.length ? [...files, ...sigInline] : files;
    const { mime, drive } =
      mode === "send"
        ? partitionAttachments(allFiles, MAX_ATTACH_BYTES)
        : { mime: allFiles, drive: [] as typeof files };
    return {
      to,
      cc: cc || undefined,
      bcc: bcc || undefined,
      // 별칭이 하나뿐이면 Gmail 기본값에 맡긴다 (보내는 이름 자동 적용)
      from: aliases.length > 1 ? fromHeader : undefined,
      replyTo: chosenAlias?.replyTo || undefined,
      subject,
      body: htmlToText(html), // text/plain 대체본
      bodyHtml: html,
      threadId: init?.threadId,
      inReplyTo: init?.inReplyTo,
      references: init?.references ?? init?.inReplyTo,
      attachments: mime.length
        ? mime.map(({ filename, mimeType, data, contentId }) => ({
            filename,
            mimeType,
            data,
            contentId,
          }))
        : undefined,
      driveAttachments: drive.length
        ? drive.map(({ filename, mimeType, data }) => ({ filename, mimeType, data }))
        : undefined,
    };
  };

  const send = () =>
    run(async () => {
      assertInlineFits();
      const payload = composedPayload("send");
      if (onQueue && getUndoSec() > 0) {
        // 지연 발송 큐로 위임 — 드래프트 정리도 실제 발송 시점에 한다.
        onQueue(payload, draftId);
        onSent();
        return;
      }
      setSending(true);
      try {
        await api.send(payload);
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
        const payload = composedPayload("draft");
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
                : init?.forward
                  ? "전달"
                  : "새 메일"}
          </strong>
          <button className="clear" onClick={onClose} disabled={sending}>
            ✕
          </button>
        </div>
        {aliases.length > 1 && (
          <select
            className="from-select"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            title="보내는 주소 (Gmail 별칭)"
          >
            {aliases.map((a) => (
              <option key={a.email} value={a.email}>
                보내는 주소: {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
              </option>
            ))}
          </select>
        )}
        <RecipientField
          label="받는사람"
          value={to}
          onChange={setTo}
          autoFocus
          suggestions={contacts}
        />
        <RecipientField label="참조" value={cc} onChange={setCc} suggestions={contacts} />
        <RecipientField
          label="숨은참조"
          value={bcc}
          onChange={setBcc}
          suggestions={contacts}
        />
        <input
          placeholder="제목"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <RichEditor
          editorRef={editorRef}
          initialHtml={initialHtml}
          onFiles={addFiles}
          rich
          bodyStyle={{
            fontFamily: defaultFont.family || undefined,
            fontSize: defaultFont.size || undefined,
          }}
        />
        {files.some((f) => !f.contentId) && (
          <div className="compose-atts">
            {files.map((f, i) =>
              // 인라인 이미지(cid:)는 본문에 박혀 있으므로 칩으로 안 보인다.
              f.contentId ? null : (
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
              ),
            )}
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
          </span>
          {hasSig && (
            <button
              type="button"
              className={`btn sig-toggle${sigOn ? " on" : ""}`}
              title={sigOn ? "이 메일에서 서명 빼기" : "서명 다시 넣기"}
              onClick={toggleSignature}
            >
              {sigOn ? "✍ 서명 포함" : "✍ 서명 없음"}
            </button>
          )}
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

// Split attachments so the MIME message stays under Gmail's ~35MB cap. Inline
// (cid) images are referenced by the body and can't move — they always ride in
// MIME and are charged against the budget first. Remaining file attachments
// fill what's left of the budget (raw bytes); whatever overflows is sent as a
// Drive link instead, exactly like Gmail web does past 25MB.
function partitionAttachments(files: ComposeAttachment[], budget: number) {
  const mime: ComposeAttachment[] = [];
  const drive: ComposeAttachment[] = [];
  let used = files
    .filter((f) => f.contentId)
    .reduce((s, f) => s + f.size, 0);
  for (const f of files) {
    if (f.contentId) {
      mime.push(f); // inline, already counted in `used`
    } else if (used + f.size <= budget) {
      mime.push(f);
      used += f.size;
    } else {
      drive.push(f);
    }
  }
  return { mime, drive };
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

// ---- 작성창 인라인 이미지(cid:) 미리보기 ----
// 에디터는 메인 문서라 cid:를 해석하지 못한다. 전달/드래프트의 인라인 이미지는
// 메모리 base64로 들고 있으므로, 표시용 blob URL로 바꿔 보여주고 발송 직전 다시
// cid:로 되돌려 multipart/related 재연결이 깨지지 않게 한다.
function base64ToObjectUrl(b64: string, mime: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime || "application/octet-stream" }));
}

function resolveCidSrc(html: string, cidToUrl: Map<string, string>): string {
  if (cidToUrl.size === 0) return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("img[src]").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      if (!/^cid:/i.test(src)) return;
      let cid = src.slice(4);
      try {
        cid = decodeURIComponent(cid);
      } catch {
        /* malformed escape */
      }
      const url = cidToUrl.get(cid.replace(/^<|>$/g, ""));
      if (url) img.setAttribute("src", url);
    });
    return doc.body?.innerHTML ?? html;
  } catch {
    return html;
  }
}

function restoreCidSrc(html: string, urlToCid: Map<string, string>): string {
  let out = html;
  for (const [url, cid] of urlToCid) out = out.split(url).join(`cid:${cid}`);
  return out;
}

/** Re-download an attachment for forward/draft-resume. Throws on HTTP errors
 *  instead of silently base64-encoding an error JSON body as the attachment. */
async function downloadAttachment(
  messageId: string,
  a: { id: string; filename: string; mimeType: string; size: number; contentId?: string },
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
    contentId: a.contentId, // preserve cid so forwarded inline images re-link
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

// 발신자→색은 결정적이고 같은 주소가 목록에 반복 등장하므로 해시를 캐시한다.
const avatarColorCache = new Map<string, string>();
function avatarColor(key: string): string {
  const cached = avatarColorCache.get(key);
  if (cached) return cached;
  let h = 0;
  for (const ch of key) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length];
  avatarColorCache.set(key, color);
  return color;
}

// Intl 포매터는 생성 비용이 크다 — toLocale*는 호출마다 새로 만든다. 목록의
// 모든 행이 listDateLabel을 부르므로 포매터를 한 번 만들어 재사용한다.
const TIME_FMT = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" });
const MONTHDAY_FMT = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" });
function listDateLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? TIME_FMT.format(date)
    : MONTHDAY_FMT.format(date);
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

function DriveCard({ f, terms }: { f: DriveFile; terms: string[] }) {
  return (
    <a
      className="scard drive-card"
      href={f.webViewLink ?? "#"}
      target="_blank"
      rel="noreferrer"
      title={f.name}
    >
      <span className="avatar drive-card-icon">{f.isFolder ? "📁" : "📄"}</span>
      <span className="scard-main">
        <span className="scard-top">
          <span className="scard-from">{highlightText(f.name, terms)}</span>
          <span className="scard-date">
            {f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ""}
          </span>
        </span>
        <span className="scard-sub">
          {f.isFolder ? "폴더" : formatBytes(f.size)}
          {f.shared ? " · 공유됨" : ""}
        </span>
      </span>
    </a>
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

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + " KB";
  return n + " B";
}
function DriveView({ onLogout }: { onLogout: () => void }) {
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [folderId, setFolderId] = useState("root");
  const [crumbs, setCrumbs] = useState<DriveBreadcrumb[]>([]);
  const [quota, setQuota] = useState<DriveQuota | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => setRefreshKey((k) => k + 1), []);

  // List (or search) + breadcrumb whenever the folder/query/refresh changes.
  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setErr(null);
    const params = query ? { q: query } : { folderId };
    api
      .driveFiles(params)
      .then((res) => {
        if (!cancelled) setFiles(res.files);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) onLogout();
        else setErr((e as Error).message);
      });
    // Breadcrumb only matters when browsing (not searching).
    if (!query && folderId !== "root") {
      api
        .driveBreadcrumb(folderId)
        .then((c) => !cancelled && setCrumbs(c))
        .catch(() => !cancelled && setCrumbs([]));
    } else {
      setCrumbs([]);
    }
    return () => {
      cancelled = true;
    };
  }, [folderId, query, refreshKey, onLogout]);

  // Storage quota — load once (and after uploads/trash via refreshKey).
  useEffect(() => {
    let cancelled = false;
    api
      .driveQuota()
      .then((q) => !cancelled && setQuota(q))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const openFolder = (id: string) => {
    setQuery("");
    setSearchInput("");
    setFolderId(id);
  };

  const onUpload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      for (const f of Array.from(list)) {
        const data = await blobToBase64(f);
        await api.driveUpload({
          name: f.name,
          mimeType: f.type || "application/octet-stream",
          data,
          parentId: query ? undefined : folderId,
        });
      }
      reload();
    } catch (e) {
      if (e instanceof AuthError) onLogout();
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const newFolder = async () => {
    const name = window.prompt("새 폴더 이름")?.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.driveCreateFolder(name, folderId === "root" ? undefined : folderId);
      reload();
    } catch (e) {
      if (e instanceof AuthError) onLogout();
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (f: DriveFile) => {
    const name = window.prompt("새 이름", f.name)?.trim();
    if (!name || name === f.name) return;
    setBusy(true);
    try {
      await api.driveRename(f.id, name);
      reload();
    } catch (e) {
      if (e instanceof AuthError) onLogout();
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const trash = async (f: DriveFile) => {
    if (!window.confirm(`"${f.name}"을(를) 휴지통으로 이동할까요?`)) return;
    setBusy(true);
    try {
      await api.driveTrash(f.id);
      reload();
    } catch (e) {
      if (e instanceof AuthError) onLogout();
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const usedPct =
    quota && quota.limit ? Math.min(100, (quota.usage / quota.limit) * 100) : null;

  return (
    <section className="drive">
      <div className="drive-head">
        <div className="drive-crumbs">
          <button className="crumb" onClick={() => openFolder("root")}>
            🗂 내 드라이브
          </button>
          {crumbs.map((c) => (
            <span key={c.id}>
              <span className="crumb-sep">›</span>
              <button className="crumb" onClick={() => openFolder(c.id)}>
                {c.name}
              </button>
            </span>
          ))}
          {query && <span className="crumb-sep">› 검색: "{query}"</span>}
        </div>
        <div className="drive-actions">
          <form
            className="drive-search"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(searchInput.trim());
            }}
          >
            <input
              type="search"
              placeholder="드라이브 검색"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </form>
          <button className="btn" disabled={busy || !!query} onClick={newFolder}>
            + 폴더
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            업로드
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => onUpload(e.target.files)}
          />
        </div>
      </div>

      {quota && (
        <div className="drive-quota">
          <div className="drive-quota-bar">
            <div
              className="drive-quota-fill"
              style={{ width: usedPct != null ? `${usedPct}%` : "0%" }}
            />
          </div>
          <span className="drive-quota-text">
            {formatBytes(quota.usage)}
            {quota.limit ? ` / ${formatBytes(quota.limit)} 사용` : " 사용 (무제한)"}
          </span>
        </div>
      )}

      {err && <div className="drive-error">{err}</div>}

      <div className="drive-list">
        {files === null ? (
          <div className="empty">불러오는 중…</div>
        ) : files.length === 0 ? (
          <div className="empty">
            {query ? "검색 결과가 없습니다." : "이 폴더가 비어 있습니다."}
          </div>
        ) : (
          files.map((f) => (
            <div
              key={f.id}
              className={`drive-row${f.isFolder ? " folder" : ""}`}
              onDoubleClick={() => f.isFolder && openFolder(f.id)}
            >
              <span className="drive-icon">{f.isFolder ? "📁" : "📄"}</span>
              {f.isFolder ? (
                <button
                  className="drive-name"
                  title={f.name}
                  onClick={() => openFolder(f.id)}
                >
                  {f.name}
                  {f.shared && <span className="drive-badge">공유됨</span>}
                </button>
              ) : (
                // 파일 이름 클릭 = 바로 다운로드 (서버가 Content-Disposition: attachment).
                <a
                  className="drive-name"
                  title={`${f.name} — 클릭하면 다운로드`}
                  href={api.driveDownloadUrl(f.id)}
                  download={f.name}
                >
                  {f.name}
                  {f.shared && <span className="drive-badge">공유됨</span>}
                </a>
              )}
              <span className="drive-size">{f.isFolder ? "" : formatBytes(f.size)}</span>
              <span className="drive-date">
                {f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ""}
              </span>
              <span className="drive-row-actions">
                <button className="drive-act" title="이름 변경" onClick={() => rename(f)}>
                  ✎
                </button>
                <button className="drive-act" title="휴지통" onClick={() => trash(f)}>
                  🗑
                </button>
              </span>
            </div>
          ))
        )}
      </div>
    </section>
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
  hiddenCals,
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
  hiddenCals: Set<string>;
  onLogout: () => void;
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
          <div className="search-col-head">📅 일정</div>
          {evErr ? (
            <div className="scard-empty">⚠️ {evErr}</div>
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
            <>
              <MoreSentinel onMore={onMore} />
              <button className="btn more" onClick={onMore}>
                더 보기
              </button>
            </>
          )}
        </section>
        <section className="search-col">
          <div className="search-col-head">🗂 드라이브</div>
          {fileErr ? (
            <div className="scard-empty">⚠️ {fileErr}</div>
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
                className={`month-cell${other ? " other" : ""}${key === todayKey ? " today" : ""}${onCreate ? " creatable" : ""}`}
                // 빈 영역(또는 날짜 숫자) 클릭 → 그 날짜로 새 일정. 이벤트 칩/
                // 더보기 버튼은 stopPropagation으로 이 핸들러를 막는다.
                onClick={onCreate ? () => onCreate(key) : undefined}
                title={onCreate ? "클릭하여 이 날짜에 일정 추가" : undefined}
              >
                <div className="month-daynum">{d.getDate()}</div>
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

// ---- 인용/전달 체인 접기 (뷰어 전용) ----
// "전달→전달→전달"로 쌓인 본문은 한 덩어리 벽이 된다. 클라이언트별 인용 컨테이너를
// <details>로 감싸 단계마다 접고 펼 수 있게 한다 — 전달 본문(그 메일의 알맹이)은
// 펼친 채 라벨만 붙이고, 답장 히스토리(스레드 뷰에 이미 위로 보이는 중복)는 접는다.
// iframe은 무스크립트라 네이티브 <details> 토글을 그대로 쓴다 (높이는 부모가
// toggle 이벤트로 재계산).
const QUOTE_ROOT_SEL =
  'div.gmail_quote, blockquote[type="cite"], div.yahoo_quoted, div[id^="divRplyFwdMsg"], div.mail-fwd, div.mail-quote';
const FWD_MARK = /forwarded message|전달된 메일|begin forwarded|original message|원본 메일/i;

function foldQuoteChains(doc: Document): void {
  const roots = [...doc.querySelectorAll(QUOTE_ROOT_SEL)];
  let folded = 0;
  for (const el of roots) {
    // Apple Mail 전달은 "Begin forwarded message:" 마커가 blockquote 밖 앞줄에
    // 있다 — 컨테이너 머리말과 직전 형제 텍스트를 함께 본다.
    const head = (el.textContent ?? "").slice(0, 400);
    const prev = (el.previousElementSibling?.textContent ?? "").slice(-200);
    const isFwd =
      el.matches(".mail-fwd") || FWD_MARK.test(head) || FWD_MARK.test(prev);
    const text = (el.textContent ?? "").trim();
    // 한두 줄짜리 인용까지 접으면 클릭만 늘어난다.
    if (!isFwd && text.length < 150) continue;
    const details = doc.createElement("details");
    details.className = "quote-fold";
    if (isFwd) details.setAttribute("open", "");
    const summary = doc.createElement("summary");
    summary.textContent = isFwd ? "전달된 메일" : "⋯ 이전 대화 내용";
    el.replaceWith(details);
    details.append(summary, el);
    folded++;
  }
  if (!folded) return;
  const st = doc.createElement("style");
  st.textContent =
    `details.quote-fold{margin:10px 0}` +
    `details.quote-fold>summary{list-style:none;cursor:pointer;user-select:none;` +
    `display:inline-block;font:600 12px/1 -apple-system,system-ui,sans-serif;` +
    `letter-spacing:.2px;color:#5f6368;background:#f1f3f6;border:1px solid #e3e7ee;` +
    `border-radius:999px;padding:5px 12px}` +
    `details.quote-fold>summary::-webkit-details-marker{display:none}` +
    `details.quote-fold>summary::before{content:"▸ ";color:#8a93a3}` +
    `details.quote-fold[open]>summary::before{content:"▾ "}` +
    `details.quote-fold[open]>summary{margin-bottom:8px}` +
    // 펼쳤을 때 단계 경계가 보이도록 접힌 블록에 왼쪽 가이드라인을 깐다
    // (인라인 스타일이 이미 있는 gmail_quote 등은 자기 스타일이 우선).
    `details.quote-fold>:not(summary){border-left:3px solid #e3e7ee;padding-left:12px}`;
  doc.head.append(st);
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
    foldQuoteChains(doc);
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
  const [attendees, setAttendees] = useState((initial.attendees ?? []).join(", "));
  const [reminder, setReminder] = useState<string>(
    initial.reminder === undefined || initial.reminder === "default"
      ? "default"
      : initial.reminder === "none"
        ? "none"
        : String(initial.reminder),
  );
  const [meet, setMeet] = useState(false);
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
      const attToks = splitAddrList(attendees);
      const badTok = attToks.find((t) => !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(parseAddr(t).email));
      if (badTok) {
        setBusy(false);
        return setErr(`참석자 주소가 올바르지 않습니다: ${badTok}`);
      }
      const body: EventInput = {
        calendarId,
        summary,
        allDay,
        location,
        description,
        start: allDay ? start : new Date(start).toISOString(),
        end: allDay ? addDays(end, 1) : new Date(end).toISOString(),
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
          <RecipientField
            label="참석자"
            value={attendees}
            onChange={setAttendees}
            suggestions={contacts}
          />
          <div className="ev-times">
            <select
              className="ev-input"
              title="알림 (팝업)"
              value={reminder}
              onChange={(e) => setReminder(e.target.value)}
            >
              <option value="default">알림: 캘린더 기본</option>
              <option value="none">알림 없음</option>
              <option value="0">일정 시작 시</option>
              <option value="10">10분 전</option>
              <option value="30">30분 전</option>
              <option value="60">1시간 전</option>
              <option value="1440">1일 전</option>
            </select>
            <label
              className="ev-allday"
              title="저장 시 Google Meet 화상회의 링크가 생성됩니다"
            >
              <input
                type="checkbox"
                checked={meet}
                onChange={(e) => setMeet(e.target.checked)}
              />
              Meet 추가
            </label>
          </div>
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

// 목록 바닥 근처에 들어오면 onMore를 호출하는 무한 스크롤 센티널.
// "더 보기" 버튼은 폴백/접근성용으로 그대로 두고 그 위에 붙는다.
function MoreSentinel({ onMore }: { onMore: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // root를 실제 스크롤 컨테이너(.list / .agenda-scroll …)로 잡는다 —
    // viewport root는 조상 overflow 클리핑 때문에 rootMargin 선로딩이 죽는다.
    let root: Element | null = null;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowY)) {
        root = p;
        break;
      }
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) onMoreRef.current();
      },
      // 바닥 도달 직전에 미리 로드해 체감 끊김을 없앤다.
      { root, rootMargin: "300px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} aria-hidden />;
}
