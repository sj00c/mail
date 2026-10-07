import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { TriCheck } from "./dialog.tsx";

type MailAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  run: () => void;
  danger?: boolean;
  /** 아이콘만으로 뜻이 분명한 작업(휴지통)은 툴바에서 아이콘으로 보인다. */
  iconOnly?: boolean;
};

export function MailSelectionToolbar({
  checked,
  count,
  summary,
  busy,
  actions,
  onToggleAll,
  onClear,
}: {
  checked: boolean;
  count: number;
  summary: string;
  busy: boolean;
  actions: MailAction[];
  onToggleAll: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState<"actions" | "help" | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const actionTrigger = useRef<HTMLButtonElement>(null);
  const helpTrigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = open === "help" ? helpTrigger : actionTrigger;
  const close = () => {
    trigger.current?.focus();
    setOpen(null);
  };

  // 빠른 작업(아이콘이 있는 작업)은 툴바에 공간이 허락하는 만큼 바로 노출하고,
  // 넘치는 작업과 문장형 작업(예: 모든 메일 선택)만 ⋯ 메뉴로 보낸다. 아이콘만
  // 쓰는 작업(휴지통)은 폭이 작아 먼저 자리를 받고, 글자 버튼은 앞에서부터 채운다.
  const quick = actions.filter((action) => action.icon);
  const textActions = actions.filter((action) => !action.icon);
  const signature = quick
    .map((action) => `${action.id}:${action.label}:${!!action.iconOnly}`)
    .join("\n");
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());

  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const gap = 2;
    const children = Array.from(ruler.current!.children) as HTMLElement[];
    const more = children[children.length - 1].offsetWidth + gap;
    const items = quick.map((action, i) => ({
      action,
      width: children[i].offsetWidth + gap,
    }));
    const priority = [
      ...items.filter((item) => item.action.iconOnly),
      ...items.filter((item) => !item.action.iconOnly),
    ];
    // 열 너비는 내용과 무관한 minmax(0, 1fr)이라 버튼 개수가 바뀌어도
    // 측정값이 흔들리지 않는다.
    const measure = () => {
      const room = el.clientWidth + gap;
      const all = items.reduce((sum, item) => sum + item.width, 0);
      if (!textActions.length && all <= room) {
        setShown(new Set(quick.map((action) => action.id)));
        return;
      }
      let used = more;
      const next = new Set<string>();
      for (const item of priority) {
        if (used + item.width > room) break;
        used += item.width;
        next.add(item.action.id);
      }
      setShown(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // signature가 quick의 측정 관련 내용을 모두 담는다.
  }, [signature, textActions.length]);

  const inline = quick.filter((action) => shown.has(action.id));
  const overflow = [
    ...textActions,
    ...quick.filter((action) => !shown.has(action.id)),
  ];

  useEffect(() => {
    if (open === "actions" && (!count || busy || !overflow.length))
      setOpen(null);
  }, [open, count, busy, overflow.length]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current!.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 16);
    setPosition({
      left: Math.max(
        8,
        Math.min(anchor.right - width, window.innerWidth - width - 8),
      ),
      top: anchor.bottom + 8,
    });
    const first = panel.current?.querySelector<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    (first ?? panel.current)?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !actionTrigger.current?.contains(event.target as Node) &&
        !helpTrigger.current?.contains(event.target as Node)
      )
        setOpen(null);
    };
    const dismiss = () => setOpen(null);
    const onScroll = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return (
    <div className="bulk-bar" aria-label="메일 선택 도구">
      <TriCheck
        checked={checked}
        indeterminate={count > 0 && !checked}
        disabled={busy}
        onChange={onToggleAll}
        ariaLabel="전체 선택"
      />
      <span
        className={count ? "bulk-count" : "bulk-hint"}
        title={summary}
        aria-live="polite"
      >
        {count ? summary : "전체 선택"}
      </span>
      <div ref={strip} className="bulk-actions">
        {count > 0 &&
          inline.map((action) => (
            <button
              key={action.id}
              type="button"
              className={[
                "bulk-action",
                action.danger && "danger",
                action.iconOnly && "icon",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label={action.iconOnly ? action.label : undefined}
              title={action.iconOnly ? action.label : undefined}
              disabled={busy}
              onClick={action.run}
            >
              {action.iconOnly ? action.icon : action.label}
            </button>
          ))}
        {(count === 0 || overflow.length > 0) && (
          <button
            type="button"
            ref={actionTrigger}
            className="bulk-menu-trigger"
            aria-label="선택한 메일 작업"
            aria-haspopup="menu"
            aria-expanded={open === "actions"}
            disabled={!count || busy}
            title="선택한 메일 작업"
            onClick={() => setOpen(open === "actions" ? null : "actions")}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setOpen("actions");
              }
            }}
          >
            ⋯
          </button>
        )}
      </div>
      <div ref={ruler} className="bulk-ruler" aria-hidden="true">
        {quick.map((action) => (
          <span
            key={action.id}
            className={action.iconOnly ? "bulk-action icon" : "bulk-action"}
          >
            {action.iconOnly ? action.icon : action.label}
          </span>
        ))}
        <span className="bulk-menu-trigger">⋯</span>
      </div>
      <button
        type="button"
        className="bulk-clear"
        aria-label="선택 해제"
        disabled={!count || busy}
        onClick={onClear}
        title="선택 해제"
      >
        ×
      </button>
      <button
        type="button"
        ref={helpTrigger}
        className="kbd-help-btn"
        aria-label="키보드 단축키"
        title="키보드 단축키"
        aria-expanded={open === "help"}
        onClick={() => setOpen(open === "help" ? null : "help")}
      >
        ?
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            className="bulk-menu"
            tabIndex={-1}
            role={open === "actions" ? "menu" : "dialog"}
            aria-label={
              open === "actions" ? "선택한 메일 작업" : "키보드 단축키"
            }
            style={{
              left: position.left,
              top: position.top,
              maxHeight: `calc(100dvh - ${position.top + 8}px)`,
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                if (event.shiftKey || open === "help") trigger.current?.focus();
                else helpTrigger.current?.focus();
                setOpen(null);
                return;
              }
              const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
              if (!keys.includes(event.key) || open !== "actions") return;
              event.preventDefault();
              const items = Array.from(
                panel.current!.querySelectorAll<HTMLButtonElement>(
                  'button[role="menuitem"]:not(:disabled)',
                ),
              );
              if (!items.length) return;
              const index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length;
              items[next].focus();
            }}
          >
            {open === "actions" ? (
              <>
                <div className="bulk-menu-caption">{summary}</div>
                {overflow.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    role="menuitem"
                    className={action.danger ? "danger" : undefined}
                    disabled={busy}
                    onClick={() => {
                      close();
                      action.run();
                    }}
                  >
                    {action.icon}
                    <span>{action.label}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <div className="bulk-menu-caption">키보드 단축키</div>
                <div className="kbd-grid">
                  <span>
                    <kbd>j</kbd> / <kbd>k</kbd> 다음 / 이전 메일
                  </span>
                  <span>
                    <kbd>e</kbd> 보관
                  </span>
                  <span>
                    <kbd>#</kbd> 휴지통
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
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
