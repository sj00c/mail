// 팝업 공통 부품: 크기 조절/최대화 훅과 손잡이, 리더 팝업,
// 3상태 체크박스, 무한 스크롤 센티널.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

// ── 팝업 크기 ─────────────────────────────────────────────────────────────
// 기본값은 화면 크기에 따라 크게 열리고(CSS clamp), 사용자가 오른쪽 아래
// 모서리를 끌면 그 크기를 팝업 종류별로 기억한다. 헤더의 ⤢ 는 화면 꽉 채우기.
export type DialogSize = { w: number; h: number };

export const DIALOG_SIZE_KEY = "mail.dialog.size";

export function readDialogSizes(): Record<string, DialogSize> {
  try {
    const raw = JSON.parse(localStorage.getItem(DIALOG_SIZE_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, DialogSize>) : {};
  } catch {
    return {};
  }
}

export function useResizableDialog(key: string, minW: number, minH: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<DialogSize | null>(() => readDialogSizes()[key] ?? null);
  const [maximized, setMaximized] = useState(false);

  const persist = useCallback(
    (next: DialogSize | null) => {
      try {
        const all = readDialogSizes();
        if (next) all[key] = next;
        else delete all[key];
        localStorage.setItem(DIALOG_SIZE_KEY, JSON.stringify(all));
      } catch {
        // private mode: 이번 세션에만 적용
      }
    },
    [key],
  );

  // 모니터가 바뀌어 저장값이 화면보다 커도 밖으로 튀어나가지 않게 조인다.
  const clampSize = useCallback(
    (s: DialogSize): DialogSize => ({
      w: Math.max(minW, Math.min(s.w, window.innerWidth - 24)),
      h: Math.max(minH, Math.min(s.h, window.innerHeight - 24)),
    }),
    [minH, minW],
  );

  const onGripDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const el = ref.current;
      if (!el || e.button !== 0) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const w0 = rect.width;
      const h0 = rect.height;
      let last = { w: w0, h: h0 };
      const move = (ev: globalThis.PointerEvent) => {
        // 팝업은 화면 정중앙 고정이라, 커서를 그대로 따라오게 하려면
        // 커서 이동량의 두 배만큼 커져야 한다(양쪽으로 반씩 자란다).
        last = clampSize({ w: w0 + (ev.clientX - x0) * 2, h: h0 + (ev.clientY - y0) * 2 });
        setSize(last);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        persist(last);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      setMaximized(false);
    },
    [clampSize, persist],
  );

  // 창을 줄이거나 모니터를 바꿔도 저장된 크기가 화면 밖으로 나가지 않게.
  useEffect(() => {
    const fit = () =>
      setSize((s) => {
        if (!s) return s;
        const c = clampSize(s);
        return c.w === s.w && c.h === s.h ? s : c;
      });
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [clampSize]);

  const reset = useCallback(() => {
    setSize(null);
    setMaximized(false);
    persist(null);
  }, [persist]);

  const style: CSSProperties = maximized
    ? { width: "calc(100vw - 24px)", height: "calc(100vh - 24px)", maxWidth: "none", maxHeight: "none" }
    : size
      ? { width: size.w, height: size.h, maxWidth: "none", maxHeight: "none" }
      : {};

  return {
    ref,
    style,
    maximized,
    toggleMax: useCallback(() => setMaximized((v) => !v), []),
    reset,
    onGripDown,
  };
}

/** 헤더의 최대화 토글 + 오른쪽 아래 크기조절 손잡이 (모든 팝업 공통). */
export function DialogTools({
  maximized,
  onToggleMax,
}: {
  maximized: boolean;
  onToggleMax: () => void;
}) {
  return (
    <button
      type="button"
      className="clear dlg-max"
      title={maximized ? "이전 크기로" : "화면 꽉 채우기"}
      aria-label={maximized ? "이전 크기로" : "화면 꽉 채우기"}
      onClick={onToggleMax}
    >
      {maximized ? "⤡" : "⤢"}
    </button>
  );
}

export function DialogGrip({
  onPointerDown,
  onReset,
}: {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onReset: () => void;
}) {
  return (
    <span
      className="dlg-grip"
      title="끌어서 크기 조절 · 더블클릭하면 기본 크기"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    />
  );
}

// 체크박스 + "일부만 선택"(indeterminate) 상태 — indeterminate는 속성으로만
// 설정 가능해 ref로 동기화한다.
export function TriCheck({
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

// ── 리더 팝업 ─────────────────────────────────────────────────────────────
// 메일을 열면 화면 중앙 팝업으로 띄운다. ⤢ 로 화면 가득 전환할 수 있고 그
// 상태는 localStorage에 남는다. 목록 단축키(j/k/e/#)는 팝업이 떠 있는 동안에도
// 살아 있어야 하므로 .modal-backdrop 클래스를 쓰지 않는다 — 전역 키 핸들러가
// .modal-backdrop을 보면 목록 단축키를 쉰다.
//
// 자체 Escape 리스너는 두지 않는다(전역 핸들러가 Esc/u 닫기를 맡는다).
// 예전 슬라이드오버는 자체 리스너 때문에 일정 모달이 열린 채 Esc를 누르면
// 모달과 리더가 동시에 닫혔다 — 전역 핸들러는 .modal-backdrop에서 쉬므로
// 그 버그가 사라진다. 대신 입력란에 포커스가 있는 동안에는 Esc도 u도 팝업을
// 닫지 않는다(타이핑 중인 문자를 가로채면 안 된다) — 배경 클릭으로 닫는다.
// 모두 의도된 동작이니 리스너를 되살리지 말 것.
export const READER_FULLSCREEN_KEY = "mail.reader.fullscreen";

export function ReaderPopup({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const [fullscreen, setFullscreen] = useState(() => {
    try {
      return localStorage.getItem(READER_FULLSCREEN_KEY) === "1";
    } catch {
      return false; // private mode
    }
  });
  const panelRef = useRef<HTMLDivElement>(null);

  // 슬라이드오버 시절의 폭 저장값은 더 이상 안 쓴다 — 한 번만 지운다.
  useEffect(() => {
    try {
      localStorage.removeItem("mail.slideover.width");
    } catch {
      // private mode
    }
  }, []);

  // 배경 클릭 등으로 포커스가 흩어져도 Esc가 바로 먹도록 패널에 포커스.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const toggleFullscreen = () => {
    setFullscreen((v) => {
      const next = !v;
      try {
        if (next) localStorage.setItem(READER_FULLSCREEN_KEY, "1");
        else localStorage.removeItem(READER_FULLSCREEN_KEY);
      } catch {
        // private mode: 이번 세션에만 적용
      }
      return next;
    });
  };

  return (
    <div className="reader-popup-backdrop" onClick={onClose}>
      {/* 배경 단축키가 살아 있는 팝업이라 aria-modal은 사실이 아니게 되므로 쓰지 않는다. */}
      <div
        ref={panelRef}
        className={`reader-popup${fullscreen ? " fullscreen" : ""}`}
        role="dialog"
        aria-label="메일 읽기"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="clear reader-popup-max"
          title={fullscreen ? "기본 크기로" : "화면 가득 보기"}
          aria-label={fullscreen ? "기본 크기로" : "화면 가득 보기"}
          onClick={toggleFullscreen}
        >
          {fullscreen ? "⤡" : "⤢"}
        </button>
        <div className="reader-popup-scroll">{children}</div>
      </div>
    </div>
  );
}

// 목록 바닥 근처에 들어오면 onMore를 호출하는 무한 스크롤 센티널.
// "더 보기" 버튼은 폴백/접근성용으로 그대로 두고 그 위에 붙는다.
export function MoreSentinel({ onMore }: { onMore: () => void }) {
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
