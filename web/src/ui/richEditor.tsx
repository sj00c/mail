import { useEffect, useRef, type ReactNode } from "react";
import { fileToBase64 } from "../lib/attachments.ts";
import { FONT_FAMILIES } from "../lib/settings.ts";

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
    const url = window.prompt(
      "링크 URL:",
      sel && /^https?:/i.test(sel) ? sel : "https://",
    );
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
        document.execCommand(
          "insertImage",
          false,
          `data:${im.mimeType};base64,${im.data}`,
        );
      }
      saveSel();
    });
  };
  // 버튼이 selection을 빼앗지 않게 mousedown 기본동작 차단 후 click에서 실행
  const tool = (label: ReactNode, action: () => void, title: string) => (
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
