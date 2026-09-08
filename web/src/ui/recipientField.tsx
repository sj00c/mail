import { useMemo, useRef, useState } from "react";
import { parseAddr, splitAddrList, type Contact } from "../api.ts";

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
export function RecipientField({
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
          (s.email.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q)),
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

  const setItems = (next: string[]) =>
    onChange(next.filter(Boolean).join(", "));
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
