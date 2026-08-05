// localStorage 설정 접근자 (서명·기본 글꼴·보내기 취소·계정 키).
import { textToHtml } from "./mailHtml.ts";

// ---- local settings (서명) ----
// Text signature rides in the text/plain part; an HTML signature (imported
// from Gmail — readable with gmail.modify, no extra scope) is sent verbatim
// as a text/html alternative so images/styles survive.
export const SIGNATURE_KEY = "mail.signature";

export const SIGNATURE_HTML_KEY = "mail.signature.html";

export const ACCOUNT_KEY = "mail.account"; // last logged-in account (settings scope)

export const SIGNATURE_SYNC_KEY = "mail.signature.synced"; // auto-import done for this account

export function getSignature(): string {
  try {
    return localStorage.getItem(SIGNATURE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function getSignatureHtml(): string {
  try {
    return localStorage.getItem(SIGNATURE_HTML_KEY) ?? "";
  } catch {
    return "";
  }
}

// 서명 블록 HTML (`<div class="mail-signature">…`). HTML 서명이 있으면 그대로,
// 없으면 평문 서명을 줄바꿈 보존해 감싼다. 인라인 이미지(data: URI)는 발송 시
// dataUrisToCid가 cid 첨부로 변환한다.
export function getSignatureBlockHtml(): string {
  const sigHtml = getSignatureHtml();
  const sigText = getSignature();
  const sig = sigHtml || (sigText ? textToHtml(sigText) : "");
  return sig ? `<div class="mail-signature">--<br>${sig}</div>` : "";
}

// ---- 기본 글꼴 / 보내기 취소 설정 ----
// 글꼴은 수신자 클라이언트에 그대로 전달되므로 web-safe(윈도·맥 공통 설치)
// 스택만 노출한다 — 웹폰트는 메일에서 렌더 보장이 없다.
export const FONT_FAMILY_KEY = "mail.font.family";

export const FONT_SIZE_KEY = "mail.font.size";

export const UNDO_KEY = "mail.undo.sec";

export const FONT_FAMILIES = [
  { label: "글꼴: 기본", css: "" },
  { label: "고딕 (맑은 고딕)", css: "'Malgun Gothic','Apple SD Gothic Neo',sans-serif" },
  { label: "명조 (바탕)", css: "Batang,AppleMyungjo,'Nanum Myeongjo',serif" },
  { label: "Arial", css: "Arial,Helvetica,sans-serif" },
  { label: "Georgia", css: "Georgia,'Times New Roman',serif" },
  { label: "Verdana", css: "Verdana,Geneva,sans-serif" },
  { label: "고정폭 (Courier)", css: "'Courier New',Courier,monospace" },
] as const;

export const FONT_SIZES = [
  { label: "크기: 기본", css: "" },
  { label: "작게 (12px)", css: "12px" },
  { label: "보통 (14px)", css: "14px" },
  { label: "크게 (16px)", css: "16px" },
  { label: "아주 크게 (18px)", css: "18px" },
] as const;

export function getDefaultFont(): { family: string; size: string } {
  try {
    return {
      family: localStorage.getItem(FONT_FAMILY_KEY) ?? "",
      size: localStorage.getItem(FONT_SIZE_KEY) ?? "",
    };
  } catch {
    return { family: "", size: "" };
  }
}

export function getUndoSec(): number {
  try {
    const v = Number(localStorage.getItem(UNDO_KEY) ?? "5");
    return Number.isFinite(v) && v >= 0 ? Math.min(v, 30) : 5;
  } catch {
    return 5;
  }
}
