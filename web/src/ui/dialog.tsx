// 팝업 공통 부품: 크기 조절/최대화 훅과 손잡이, 슬라이드오버,
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

export function SlideOver({
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
