import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  api,
  AuthError,
  HttpError,
  type AccountSettings,
  type Calendar,
  type EventInput,
  type Label,
  type MessageFull,
} from "./api.ts";
import { downloadAttachment, fileToBase64 } from "./lib/attachments.ts";
import { avatarColor, DATETIME_FMT } from "./lib/format.tsx";
import { htmlToText, sanitizeMailHtml, textToHtml } from "./lib/mailHtml.ts";
import {
  ACCOUNT_KEY,
  FONT_FAMILIES,
  FONT_FAMILY_KEY,
  FONT_SIZE_KEY,
  FONT_SIZES,
  getDefaultFont,
  getSignature,
  getSignatureHtml,
  getUndoSec,
  SIGNATURE_HTML_KEY,
  SIGNATURE_KEY,
  SIGNATURE_SYNC_KEY,
  UNDO_KEY,
} from "./lib/settings.ts";
import {
  DialogGrip,
  DialogTools,
  MoreSentinel,
  SlideOver,
  TriCheck,
  useResizableDialog,
} from "./ui/dialog.tsx";
import { Compose, RichEditor, type ComposeInit } from "./views/compose.tsx";
import { MessageRow, Reader } from "./views/reader.tsx";
import { useInboxPoll } from "./hooks/useInboxPoll.ts";
import { useCalendarCatalog } from "./hooks/useCalendarCatalog.ts";
import { shouldRemoveArchivedMessage, useMailList } from "./hooks/useMailList.ts";
import { useOutbox } from "./hooks/useOutbox.ts";
import { PRIMARY_CALENDAR_DEFAULT_COLOR, getCalendarDisplayColor } from "./lib/calendarPresentation.ts";

const SYSTEM_ORDER = ["INBOX", "STARRED", "SENT", "DRAFT", "SPAM", "TRASH"];
let calendarModule: Promise<typeof import("./views/calendar.tsx")> | undefined;
const loadCalendarModule = () => (calendarModule ??= import("./views/calendar.tsx"));
const CalendarView = lazy(async () => ({ default: (await loadCalendarModule()).CalendarView }));
const EventEditModal = lazy(async () => ({ default: (await loadCalendarModule()).EventEditModal }));
const DriveView = lazy(async () => ({ default: (await import("./views/drive.tsx")).DriveView }));
const SearchResults = lazy(async () => ({ default: (await import("./views/search.tsx")).SearchResults }));

type DeferredViewBoundaryProps = {
  children: ReactNode;
  resetKey: string;
  fallback?: ReactNode;
};

export class DeferredViewBoundary extends Component<
  DeferredViewBoundaryProps,
  { failed: boolean; errorKind: string | null }
> {
  state = { failed: false, errorKind: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { failed: true, errorKind: error.name || "Error" };
  }

  componentDidUpdate(previous: DeferredViewBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false, errorKind: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Deferred view failed to load", error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        this.props.fallback ?? (
          <div className="center" role="alert">
            <p>화면을 불러오지 못했습니다.</p>
            {this.state.errorKind && <p className="muted">오류 유형: {this.state.errorKind}</p>}
            <button className="btn" onClick={() => window.location.reload()}>
              다시 시도
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}

function DeferredView({
  children,
  resetKey,
  fallback,
}: {
  children: ReactNode;
  resetKey: string;
  fallback?: ReactNode;
}) {
  return (
    <DeferredViewBoundary resetKey={resetKey} fallback={fallback}>
      <Suspense fallback={<div className="center">불러오는 중…</div>}>{children}</Suspense>
    </DeferredViewBoundary>
  );
}
export function CalendarMetadataDiagnostic({
  anomaly,
}: {
  anomaly: "missing" | "multiple" | null;
}) {
  if (!anomaly) return null;
  return (
    <div className="nav-note" role="status">
      기본 캘린더 정보를 확인할 수 없어 일반 캘린더로 표시합니다.
    </div>
  );
}

const SYSTEM_LABEL_NAMES: Record<string, string> = {
  ALL: "전체메일",
  INBOX: "받은편지함",
  STARRED: "별표",
  SENT: "보낸편지함",
  DRAFT: "임시보관함",
  SPAM: "스팸",
  TRASH: "휴지통",
};

// 안정된 빈 배열 — 선택이 없을 때 checkedIds가 매번 새 []를 반환하지 않도록.
const EMPTY_IDS: string[] = [];

// 사이드바 접힘 상태 (localStorage): "0"이면 접힌 채로 뜬다.
const NAV_OPEN_KEY = "mail.nav.open";

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

const IconSidebar = () => (
  <SvgIcon>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9.5 4v16" />
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
  // Gmail 계정 설정(별칭/답장주소/휴가응답) — 로그인 시 자동으로 딸려온다.
  const [acctSettings, setAcctSettings] = useState<AccountSettings | null>(null);
  // 목록 체크박스로 고른 메일 id (일괄 처리용). shift-범위선택용 마지막 인덱스.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastCheckedIdx = useRef<number | null>(null);
  const [allResultsSelected, setAllResultsSelected] = useState(false);
  const [bulkAllBusy, setBulkAllBusy] = useState(false);
  // 사이드바 접기/펼치기 — 목록·읽기 영역을 넓게 쓰고 싶을 때. 선택은 남는다.
  const [navOpen, setNavOpen] = useState(() => {
    try {
      return localStorage.getItem(NAV_OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleNav = useCallback(() => {
    setNavOpen((v) => {
      try {
        localStorage.setItem(NAV_OPEN_KEY, v ? "0" : "1");
      } catch {
        // private mode: 이번 세션에만 적용
      }
      return !v;
    });
  }, []);

  // ⌘\ / Ctrl+\ 로도 접었다 편다. 작성 중인 본문에 문자가 들어가지 않도록
  // 수식 키가 눌린 조합만 가로챈다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "\\" || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      toggleNav();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleNav]);

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
  const {
    messages,
    nextToken,
    totalEstimate,
    loading,
    getMessages,
    getNextToken,
    getActiveLabel,
    getQuery,
    load,
    reset: resetMailList,
    patchMessage,
    removeMessage,
    patchMany,
    removeMany,
    toggleLabelMany,
    prependInboxMessages,
  } = useMailList(activeLabel, query, guard);

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

  const initialHiddenCalendarIds = useMemo(() => {
    try {
      const value = new URLSearchParams(window.location.search).get("hide");
      return value ? value.split(",").filter(Boolean) : [];
    } catch {
      return [];
    }
  }, []);
  const {
    calendars,
    hiddenCals,
    loading: calLoading,
    error: calErr,
    primaryColorOverride,
    primaryAnomaly,
    ensure: ensureCalendars,
    toggleCal,
    setPrimaryColor,
  } = useCalendarCatalog({
    initialHiddenIds: initialHiddenCalendarIds,
    onAuthError: bgLogout,
  });
  const primaryCalendar = useMemo(() => calendars.find((calendar) => calendar.primary), [calendars]);
  useEffect(() => {
    if (view === "calendar" || query) void ensureCalendars().catch(() => {});
  }, [view, query, ensureCalendars]);
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
      const row = getMessages().find((m) => m.id === id);
      if (row?.labelIds.includes("DRAFT")) void openDraft(id, threadId);
      else setSelected({ id, threadId });
    },
    [openDraft],
  );


  // ---- 목록 체크박스 선택 + 일괄 처리 ----
  // 체크박스 토글. shift-클릭이면 직전 클릭 행과의 사이를 한꺼번에 켜고/끈다.
  const onToggleCheck = useCallback((id: string, shiftKey: boolean) => {
    setAllResultsSelected(false);
    const list = getMessages();
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
    setAllResultsSelected(false);
    lastCheckedIdx.current = null;
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
    resetMailList();
    setSelectedIds(new Set()); // 라벨/검색 전환 시 선택 해제
    setAllResultsSelected(false);
    lastCheckedIdx.current = null;
    load(true);
  }, [activeLabel, query, load]);

  const refreshLabels = useCallback(
    () => guard(async () => setLabels(await api.labels())),
    [guard],
  );

  useInboxPoll({
    activeLabel,
    query,
    composeOpen,
    onLogout: bgLogout,
    onRefreshLabels: refreshLabels,
    onPrependInboxMessages: prependInboxMessages,
    onActivate: (message) => {
      setView("mail");
      pendingSelect.current = {
        label: "INBOX",
        sel: { id: message.id, threadId: message.threadId },
        at: Date.now(),
      };
      setActiveLabel("INBOX");
      setSelected({ id: message.id, threadId: message.threadId });
    },
  });

  const systemLabels = labels
    .filter((l) => l.type === "system" && SYSTEM_ORDER.includes(l.id))
    .sort((a, b) => SYSTEM_ORDER.indexOf(a.id) - SYSTEM_ORDER.indexOf(b.id));
  const userLabels = labels
    .filter((l) => l.type === "user")
    .sort((a, b) => a.name.localeCompare(b.name));

  // ---- 일괄 처리 액션 (현재 페이지 또는 현재 보기 전체) ----
  const inTrashView = !query && activeLabel === "TRASH";
  const isInboxView = !query && activeLabel === "INBOX";
  const isStarredView = !query && activeLabel === "STARRED";
  const checkedSet = useMemo(() => new Set(checkedIds), [checkedIds]);
  const allStarred = useMemo(
    () =>
      checkedIds.length > 0 &&
      messages.every((m) => !checkedSet.has(m.id) || m.labelIds.includes("STARRED")),
    [messages, checkedSet, checkedIds],
  );
  const allChecked = messages.length > 0 && checkedIds.length === messages.length;
  const activeLabelName =
    SYSTEM_LABEL_NAMES[activeLabel] ||
    labels.find((l) => l.id === activeLabel)?.name ||
    activeLabel;
  const bulkScope = query ? `“${query}” 검색 결과` : activeLabelName;

  const runBulk = (fn: (ids: string[], set: Set<string>) => Promise<void>) =>
    guard(async () => {
      const ids = checkedIds;
      if (ids.length === 0) return;
      await fn(ids, new Set(ids));
      clearSelection();
      void refreshLabels();
    });

  const runBulkAll = (action: "read" | "unread" | "trash") =>
    guard(async () => {
      const verb =
        action === "read"
          ? "읽음 처리"
          : action === "unread"
            ? "안읽음 처리"
            : "휴지통으로 이동";
      setBulkAllBusy(true);
      try {
        // Phase 1 freezes the exact ID set; the count shown in the destructive
        // confirmation is exact (resultSizeEstimate above is only approximate).
        const prepared = await api.prepareBulkAll({
          q: query || undefined,
          label:
            query || activeLabel === "ALL" ? undefined : activeLabel,
          action,
        });
        const prompt =
          action === "trash"
            ? `${bulkScope}의 모든 메일 ${prepared.count.toLocaleString()}개를 휴지통으로 이동합니다.\n새로 도착하는 메일은 포함되지 않습니다. 계속할까요?`
            : `${bulkScope}의 모든 메일 ${prepared.count.toLocaleString()}개를 ${verb}할까요?`;
        if (!confirm(prompt)) return;

        const res = await api.confirmBulkAll(prepared.operationId);
        const failed = res.failed ? ` · 실패 ${res.failed.toLocaleString()}개` : "";
        setError(
          `${bulkScope}: ${res.succeeded.toLocaleString()}개 메일 ${verb} 완료${failed}`,
        );
        setAllResultsSelected(false);
        clearSelection();
        load(true);
        void refreshLabels();
      } finally {
        setBulkAllBusy(false);
      }
    });

  const bulkRead = (read: boolean) => {
    if (allResultsSelected) {
      runBulkAll(read ? "read" : "unread");
      return;
    }
    runBulk(async (ids, set) => {
      await api.batchModify(ids, read ? { remove: ["UNREAD"] } : { add: ["UNREAD"] });
      patchMany(set, { unread: !read });
    });
  };
  const bulkStar = () =>
    runBulk(async (ids, set) => {
      const add = !allStarred;
      await api.batchModify(ids, add ? { add: ["STARRED"] } : { remove: ["STARRED"] });
      if (!add && isStarredView) removeMany(set);
      else toggleLabelMany(set, "STARRED", add);
    });
  const bulkArchive = () =>
    runBulk(async (ids, set) => {
      await api.batchModify(ids, { remove: ["INBOX"] });
      removeMany(set);
    });
  const bulkTrash = () => {
    if (allResultsSelected) {
      runBulkAll("trash");
      return;
    }
    runBulk(async (ids, set) => {
      await api.batchTrash(ids);
      removeMany(set);
    });
  };
  const bulkRestore = () =>
    runBulk(async (ids, set) => {
      await api.batchModify(ids, { add: ["INBOX"], remove: ["TRASH"] });
      removeMany(set);
    });
  const toggleAll = () => {
    setAllResultsSelected(false);
    if (allChecked) clearSelection();
    else {
      setSelectedIds(new Set(messages.map((m) => m.id)));
      lastCheckedIdx.current = null;
    }
  };

  const { outbox, queueSend, cancelSend: cancelQueuedSend, sendNow } = useOutbox({
    onSent: () => {
      load(true);
      refreshLabels();
    },
    onError: (error) => {
      if (error instanceof AuthError) onLogout();
      else setError((error as Error).message);
    },
  });
  const cancelSend = useCallback(
    (key: number) => {
      const item = cancelQueuedSend(key);
      if (!item) return;
      const payload = item.payload;
      openCompose({
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        subject: payload.subject,
        from: payload.from,
        threadId: payload.threadId,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        draftId: item.draftId,
        bodyHtml: payload.bodyHtml ?? textToHtml(payload.body),
        attachments: [...(payload.attachments ?? []), ...(payload.driveAttachments ?? [])].map(
          (attachment) => ({
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            data: attachment.data,
            contentId: (attachment as { contentId?: string }).contentId,
            size: Math.floor((attachment.data.length * 3) / 4),
          }),
        ),
      });
    },
    [cancelQueuedSend, openCompose],
  );

  // ---- 메일 → 일정 만들기 ----
  const [evEditor, setEvEditor] = useState<{ initial: Partial<EventInput> } | null>(
    null,
  );
  const createEventFromMail = useCallback(
    (m: MessageFull) => {
      void guard(async () => {
        await ensureCalendars();
        setEvEditor({
          initial: {
            summary: m.subject || "(제목 없음)",
            description: `메일에서 만든 일정\n보낸사람: ${m.from}\n받은날짜: ${DATETIME_FMT.format(new Date(m.date))}\n\n${m.snippet}`,
          },
        });
      });
    },
    [guard, ensureCalendars],
  );

  // ---- 키보드 단축키 (Gmail식) ----
  // j/k 이전·다음 메일, e 보관, # 휴지통, c 새 메일, / 검색, u·Esc 목록으로.
  // 입력 중(입력칸·contentEditable)이거나 모달이 떠 있으면 아무것도 안 한다 —
  // 본문에 "j"를 치는데 메일이 넘어가면 안 된다.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const viewRef = useRef(view);
  viewRef.current = view;
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (viewRef.current !== "mail") return;
      if (isTyping(e.target)) return;
      // 모달(작성창/설정/일정)이 열려 있으면 목록 단축키는 쉰다.
      if (document.querySelector(".modal-backdrop")) return;
      const list = getMessages();
      const cur = selectedRef.current;
      const curMsg = cur ? list.find((m) => m.id === cur.id) : undefined;
      switch (e.key) {
        case "j":
        case "k": {
          e.preventDefault();
          const dir = e.key === "j" ? 1 : -1;
          const idx = cur ? list.findIndex((m) => m.id === cur.id) : -1;
          for (let i = idx + dir; i >= 0 && i < list.length; i += dir) {
            // 드래프트 행은 건너뛴다 — 선택이 곧 편집기 오픈이라 순회를 끊는다.
            if (list[i].labelIds.includes("DRAFT")) continue;
            setSelected({ id: list[i].id, threadId: list[i].threadId });
            return;
          }
          // 마지막 행에서 j: 다음 페이지를 이어서 불러온다 (무한 스크롤과 동일).
          if (dir === 1 && getNextToken() && !loadingRef.current) load(false);
          return;
        }
        case "e": {
          // 보관 — Reader의 보관 버튼과 동일한 스코프(받은편지함에서만 행 제거).
          if (!curMsg || curMsg.labelIds.includes("DRAFT") || curMsg.labelIds.includes("TRASH"))
            return;
          e.preventDefault();
          void guard(async () => {
            await api.modify(curMsg.id, { remove: ["INBOX"] });
            if (shouldRemoveArchivedMessage(getActiveLabel(), getQuery())) removeMessage(curMsg.id);
            setSelected(null);
            void refreshLabels();
          });
          return;
        }
        case "#": {
          // 휴지통 (복구 가능). 휴지통 안에서는 영구삭제가 되므로 아무것도 안 한다.
          if (!curMsg || curMsg.labelIds.includes("DRAFT") || curMsg.labelIds.includes("TRASH"))
            return;
          e.preventDefault();
          void guard(async () => {
            await api.trash(curMsg.id);
            removeMessage(curMsg.id);
            setSelected(null);
            void refreshLabels();
          });
          return;
        }
        case "c":
          e.preventDefault();
          openCompose(undefined);
          return;
        case "/":
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        case "u":
        case "Escape":
          if (cur) {
            e.preventDefault();
            setSelected(null);
          }
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [getActiveLabel, getMessages, getNextToken, getQuery, guard, load, openCompose, refreshLabels, removeMessage]);

  // j/k로 옮긴 선택이 화면 밖이면 목록을 따라 스크롤한다 (클릭 선택엔 no-op).
  useEffect(() => {
    if (!selected) return;
    document
      .querySelector(".msg-row.active, .mail-card.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Shared between the normal reader pane and the search slide-over.
  const readerEl = selected ? (
    <Reader
      id={selected.id}
      threadId={selected.threadId}
      onCreateEvent={createEventFromMail}
      ownAddresses={[
        email,
        ...(acctSettings?.sendAs ?? []).map((s) => s.email),
      ]}
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
        <button
          className="icon-btn nav-toggle"
          title={`사이드바 ${navOpen ? "접기" : "펼치기"} (⌘\\)`}
          aria-label={`사이드바 ${navOpen ? "접기" : "펼치기"}`}
          aria-expanded={navOpen}
          aria-controls="app-sidebar"
          onClick={toggleNav}
        >
          <IconSidebar />
        </button>
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
            ref={searchRef}
            placeholder="Search"
            title="바로가기: /"
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

      <div className={`body ${navOpen ? "" : "nav-collapsed"} ${view === "calendar" ? "calendar-mode" : ""}`}>
        <nav className="sidebar" id="app-sidebar" aria-hidden={!navOpen}>
          <div className="sidebar-inner">
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
                <CalendarMetadataDiagnostic anomaly={primaryAnomaly} />
                <CalendarChecklist
                  title="내 캘린더"
                  items={calendars.filter((c) => c.primary || c.accessRole === "owner")}
                  hidden={hiddenCals}
                  onToggle={toggleCal}
                  primaryColorOverride={primaryColorOverride}
                  onPrimaryColorChange={(color) => {
                    if (primaryCalendar) setPrimaryColor(primaryCalendar.id, color);
                  }}
                />
                <CalendarChecklist
                  title="다른 캘린더"
                  items={calendars.filter((c) => !(c.primary || c.accessRole === "owner"))}
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
                <LabelRow
                  label={{ id: "ALL", name: "전체메일", type: "system", unread: 0 }}
                  active={!query && activeLabel === "ALL"}
                  onClick={() => {
                    setQuery("");
                    setSearchInput("");
                    setActiveLabel("ALL");
                  }}
                />
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
          </div>
        </nav>

        {view === "drive" ? (
          <DeferredView resetKey="drive">
            <DriveView onLogout={bgLogout} />
          </DeferredView>
        ) : view === "calendar" ? (
          <DeferredView resetKey="calendar">
            <CalendarView
              onLogout={bgLogout}
              hiddenCals={hiddenCals}
              calendars={calendars}
              primaryColorOverride={primaryColorOverride}
            />
          </DeferredView>
        ) : query ? (
          <DeferredView resetKey={`search:${query}`}>
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
              primaryColorOverride={primaryColorOverride}
              onLogout={bgLogout}
            />
          </DeferredView>
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
                      <span className="bulk-count">
                        {allResultsSelected
                          ? `${bulkScope} 전체 선택`
                          : `${checkedIds.length}개 선택`}
                      </span>
                      {!allResultsSelected &&
                        allChecked &&
                        !inTrashView &&
                        (nextToken || totalEstimate > messages.length) && (
                          <button
                            type="button"
                            className="bulk-all-link"
                            onClick={() => setAllResultsSelected(true)}
                          >
                            {bulkScope}의 모든 메일 선택
                          </button>
                        )}
                      <span className="bulk-actions">
                        {inTrashView ? (
                          <button className="btn sm" onClick={bulkRestore}>
                            ♻️ 복원
                          </button>
                        ) : (
                          <>
                            <button
                              className="btn sm"
                              disabled={bulkAllBusy}
                              onClick={() => bulkRead(true)}
                            >
                              ✉️ 읽음
                            </button>
                            <button
                              className="btn sm"
                              disabled={bulkAllBusy}
                              onClick={() => bulkRead(false)}
                            >
                              📩 안읽음
                            </button>
                            {!allResultsSelected && (
                              <>
                                <button className="btn sm" onClick={bulkStar}>
                                  {allStarred ? "★ 별표 해제" : "☆ 별표"}
                                </button>
                                {isInboxView && (
                                  <button className="btn sm" onClick={bulkArchive}>
                                    📥 보관
                                  </button>
                                )}
                              </>
                            )}
                            <button
                              className="btn sm danger"
                              disabled={bulkAllBusy}
                              onClick={bulkTrash}
                            >
                              🗑 휴지통
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
              {readerEl ?? (
                <div className="empty">
                  <div>메일을 선택하세요.</div>
                  <div className="kbd-hints">
                    <span>
                      <kbd>j</kbd>/<kbd>k</kbd> 이전·다음
                    </span>
                    <span>
                      <kbd>e</kbd> 보관
                    </span>
                    <span>
                      <kbd>#</kbd> 삭제
                    </span>
                    <span>
                      <kbd>c</kbd> 새 메일
                    </span>
                    <span>
                      <kbd>/</kbd> 검색
                    </span>
                    <span>
                      <kbd>u</kbd> 목록으로
                    </span>
                  </div>
                </div>
              )}
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
        <DeferredView
          resetKey="event-editor"
          fallback={
            <div className="modal-backdrop">
              <div className="modal center" role="alert">
                <p>일정 편집기를 불러오지 못했습니다.</p>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setEvEditor(null)}>
                    닫기
                  </button>
                  <button className="btn primary" onClick={() => window.location.reload()}>
                    다시 불러오기
                  </button>
                </div>
              </div>
            </div>
          }
        >
          <EventEditModal
            calendars={calendars.filter(
              (calendar) => calendar.accessRole === "owner" || calendar.accessRole === "writer",
            )}
            primaryColorOverride={primaryColorOverride}
            initial={evEditor.initial}
            onLogout={bgLogout}
            onClose={() => setEvEditor(null)}
            onSaved={() => setEvEditor(null)}
          />
        </DeferredView>
      )}

      {outbox.length > 0 && (
        <div className="undo-wrap">
          {outbox.map((o) => (
            <div key={o.key} className="undo-toast">
              <span>메일을 곧 보냅니다…</span>
              <button
                className="undo-btn"
                onClick={() => sendNow(o.key)}
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

function SettingsModal({ onClose }: { onClose: () => void }) {
  const sigEditorRef = useRef<HTMLDivElement>(null);
  const dlg = useResizableDialog("settings", 520, 380);
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
      <div
        className="modal"
        ref={dlg.ref}
        style={dlg.style}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <strong>설정</strong>
          <DialogTools maximized={dlg.maximized} onToggleMax={dlg.toggleMax} />
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
        <DialogGrip onPointerDown={dlg.onGripDown} onReset={dlg.reset} />
      </div>
    </div>
  );
}

const LABEL_ICONS: Record<string, string> = {
  ALL: "📨",
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
  const name = SYSTEM_LABEL_NAMES[label.id] ?? label.name;
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
  primaryColorOverride,
  onPrimaryColorChange,
}: {
  title: string;
  items: Calendar[];
  hidden: Set<string>;
  onToggle: (id: string) => void;
  primaryColorOverride?: string | null;
  onPrimaryColorChange?: (color: string | null) => void;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <div className="sidebar-sep">{title}</div>
      {items.map((calendar) => {
        const primary = calendar.primary === true;
        const color = getCalendarDisplayColor(
          calendar,
          primary ? primaryColorOverride : undefined,
        );
        const visible = !hidden.has(calendar.id);
        return (
          <div key={calendar.id} className={`cal-check-wrap${primary ? " primary" : ""}`}>
            <label className="cal-check" title={calendar.summary}>
              <input
                id={`calendar-${calendar.id}`}
                type="checkbox"
                checked={visible}
                onChange={() => onToggle(calendar.id)}
                style={{ accentColor: color }}
              />
              <span className="cal-check-dot" style={{ background: color }} aria-hidden="true" />
              <span className="cal-check-name">
                <span>{calendar.summary}</span>
                {primary && <span className="cal-primary-badge">기본</span>}
              </span>
            </label>
            {primary && onPrimaryColorChange && (
              <div className="cal-color-tools">
                <label>
                  <span>기본 캘린더 색상</span>
                  <input
                    type="color"
                    aria-label="기본 캘린더 색상"
                    value={color || PRIMARY_CALENDAR_DEFAULT_COLOR}
                    onChange={(event) => onPrimaryColorChange(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="clear cal-color-reset"
                  aria-label="색상 초기화"
                  title="색상 초기화"
                  onClick={() => onPrimaryColorChange(null)}
                >
                  ↺
                </button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
