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
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const actionTrigger = useRef<HTMLButtonElement>(null);
  const helpTrigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = open === "help" ? helpTrigger : actionTrigger;
  const close = () => {
    trigger.current?.focus();
    setOpen(null);
  };

  useEffect(() => {
    if (open === "actions" && (!count || busy)) setOpen(null);
  }, [open, count, busy]);

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
                {actions.map((action) => (
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
