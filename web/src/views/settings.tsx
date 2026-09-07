import { useEffect, useMemo, useRef, useState } from "react";
import { api, AuthError } from "../api.ts";
import { fileToBase64 } from "../lib/attachments.ts";
import { htmlToText, sanitizeMailHtml, textToHtml } from "../lib/mailHtml.ts";
import {
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
  UNDO_KEY,
} from "../lib/settings.ts";
import { useTheme } from "../hooks/useTheme.ts";
import { THEME_OPTIONS, type ThemePref } from "../lib/theme.ts";
import { DialogGrip, DialogTools, useResizableDialog } from "../ui/dialog.tsx";
import { RichEditor } from "./compose.tsx";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const sigEditorRef = useRef<HTMLDivElement>(null);
  const dlg = useResizableDialog("settings", 520, 380);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = requestAnimationFrame(() => dlg.ref.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      previous?.focus();
    };
  }, [dlg.ref]);
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
        document.execCommand(
          "insertImage",
          false,
          `data:${im.mimeType};base64,${im.data}`,
        );
      }
    });
  };
  const initialFont = useMemo(getDefaultFont, []);
  const [fontFamily, setFontFamily] = useState(initialFont.family);
  const [fontSize, setFontSize] = useState(initialFont.size);
  const [undoSec, setUndoSec] = useState(String(getUndoSec()));
  // 테마는 고르는 즉시 적용·저장된다 — 결과를 눈으로 보며 고르는 설정이라 저장 버튼을 기다리지 않는다.
  const { pref: themePref, setPref: setThemePref } = useTheme();

  const importFromGmail = async () => {
    setImportMsg(null);
    try {
      const { html } = await api.signature();
      if (!html) {
        setImportMsg("Gmail에 저장된 서명이 없습니다.");
        return;
      }
      if (sigEditorRef.current)
        sigEditorRef.current.innerHTML = sanitizeMailHtml(html);
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]), select:not([disabled]), input:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
            ),
          );
          if (controls.length === 0) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="modal-head">
          <strong id="settings-title">설정</strong>
          <DialogTools maximized={dlg.maximized} onToggleMax={dlg.toggleMax} />
          <button className="clear" aria-label="설정 닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="muted settings-label">
          서명 — 글꼴·크기·색·이미지까지. 발송 시 본문 끝에 자동 추가 (비우면
          사용 안 함)
        </div>
        <div className="signature-editor">
          <RichEditor
            editorRef={sigEditorRef}
            initialHtml={initialSig}
            onFiles={insertImages}
            rich
            placeholder={
              "예) 홍길동 드림 · 010-0000-0000 · 로고 이미지 삽입 가능"
            }
          />
        </div>
        {importMsg && <div className="muted settings-label">{importMsg}</div>}
        <div className="muted settings-label">
          기본 글꼴 — 새로 쓰는 메일 본문에 적용 (수신자에게도 이 글꼴로
          보입니다)
        </div>
        <div className="settings-row">
          <select
            className="ev-input"
            aria-label="기본 글꼴"
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
            aria-label="기본 글자 크기"
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
          테마 — 고르면 바로 적용됩니다
        </div>
        <div className="settings-row">
          <select
            className="ev-input"
            aria-label="테마"
            value={themePref}
            onChange={(e) => setThemePref(e.target.value as ThemePref)}
          >
            {THEME_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
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
            aria-label="보내기 취소 시간"
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
