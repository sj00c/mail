// 작성창: 서식 에디터, 수신자 칩 입력, 발송/임시저장, 인용 조립, data:→cid 변환.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api,
  AuthError,
  HttpError,
  parseAddr,
  splitAddrList,
  type Contact,
  type SendAsInfo,
} from "../api.ts";
import {
  base64ToObjectUrl,
  fileToBase64,
  partitionAttachments,
  resolveCidSrc,
  restoreCidSrc,
  type ComposeAttachment,
} from "../lib/attachments.ts";
import { QUOTE_FMT } from "../lib/format.tsx";
import { htmlToText, sanitizeMailHtml } from "../lib/mailHtml.ts";
import {
  FONT_FAMILIES,
  getDefaultFont,
  getSignatureBlockHtml,
  getUndoSec,
} from "../lib/settings.ts";
import { DialogGrip, DialogTools, useResizableDialog } from "../ui/dialog.tsx";
import { AlertIcon, AttachmentIcon } from "../ui/icons.tsx";

// 서명/붙여넣기로 본문에 박힌 data:image base64 → cid 인라인 첨부. 이메일
// 클라이언트는 data: URI 이미지를 막으므로, 발송 직전 multipart/related cid로
// 옮겨야 모든 수신함에서 보인다. 반환 html은 src가 cid:로 치환된 것.
let inlineCidSeq = 0;

export function dataUrisToCid(html: string): { html: string; inline: ComposeAttachment[] } {
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

export type ComposeInit = {
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
  forward?: boolean; // 전달이면 카드화된 전체 대화 인용
  from?: string; // 드래프트 이어쓰기 시 원래 보내는 주소(별칭) 복원용
  attachments?: ComposeAttachment[];
  bodyHtml?: string; // 드래프트 이어쓰기 — 저장된 HTML 그대로
  draftId?: string; // editing this Gmail draft: update on save, delete on send
};

// api.send가 받는 발송 페이로드 — 보내기 취소 큐가 그대로 들고 있는다.
export type SendPayload = Parameters<typeof api.send>[0];

// 답장/전달 시 에디터에 까는 인용 HTML. 원본 HTML을 그대로 blockquote에 넣어
// 서식·인라인 이미지(cid:)를 보존한다.
export function buildQuotedHtml(init?: ComposeInit): string {
  if (!init?.quoteHtml) return "";
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // 위생 처리 필수 — 받은 메일의 원본 HTML이 에디터(메인 문서)에 innerHTML로
  // 들어가므로 <img onerror> 류가 마운트 즉시 실행되는 걸 막는다. 전달은 인라인
  // 이미지를 재첨부하므로 cid: 유지, 답장은 재첨부 안 하므로 cid: 이미지 제거.
  if (init.forward) {
    // Reader already builds one independently sanitized-at-insertion boundary
    // per message. Keep that flat card structure intact; adding another
    // per-message wrapper here would compound indentation on every forward.
    return `<br>${sanitizeMailHtml(init.quoteHtml)}`;
  }
  const when = init.quoteDate ? QUOTE_FMT.format(new Date(init.quoteDate)) : "";
  const safe = sanitizeMailHtml(init.quoteHtml, { dropCidImages: true });
  const attr = `${when ? when + ", " : ""}${esc(init.quoteFrom ?? "")} 님이 작성:`;
  return (
    `<br><div class="mail-quote">` +
    `<div style="font-size:12.5px;color:#8a93a3;margin-bottom:6px">${attr}</div>` +
    `<blockquote style="margin:0;border-left:3px solid #c8d0dd;padding-left:14px;color:#3c4453">` +
    `${safe}</blockquote></div>`
  );
}

// 서식 작성 에디터 — contentEditable + 툴바. 외부 라이브러리 없이
// document.execCommand로 굵게/기울임/밑줄/목록/링크를 처리한다. 본문은
// 부모가 editorRef.current.innerHTML로 읽어 발송한다 (uncontrolled).
export function RichEditor({
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
export function tokenHasEmail(tok: string): boolean {
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

export function loadContactsOnce(): Promise<Contact[]> {
  contactsPromise ??= api.contacts().catch(() => {
    contactsPromise = null;
    return [];
  });
  return contactsPromise;
}

export function Compose({
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
  const dlg = useResizableDialog("compose", 560, 420);
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
        ref={dlg.ref}
        style={dlg.style}
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
          <DialogTools maximized={dlg.maximized} onToggleMax={dlg.toggleMax} />
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
                  <AttachmentIcon />{f.filename} ({Math.round(f.size / 1024)}KB)
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
          <div className="muted settings-label"><AlertIcon />{formErr}</div>
        )}
        <div className="modal-foot">
          <label className="btn">
            <AttachmentIcon />파일 첨부
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
        <DialogGrip onPointerDown={dlg.onGripDown} onReset={dlg.reset} />
      </div>
    </div>
  );
}
