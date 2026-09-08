// 메일 HTML 파이프라인: 위생 처리(sanitize), 뷰어용 준비(prepareEmailHtml),
// 인용/전달 체인 접기, 본문에서 직접 작성분만 추출, 평문 linkify.
import type { MessageFull } from "../api.ts";

export function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

/** Subject prefixes, case-insensitively ("RE:" must not become "Re: RE:"). */
export function reSubject(s: string): string {
  return /^\s*re:/i.test(s) ? s : `Re: ${s}`;
}

export function fwdSubject(s: string): string {
  return /^\s*(fwd?|forward):/i.test(s) ? s : `Fwd: ${s}`;
}

/**
 * Keep only this message's own contribution, without reply history already
 * represented by the other cards in the conversation. If stripping would
 * remove everything (a mail whose real content is itself a forward), retain
 * the original so no actual message content is lost.
 */
export function directMessageHtml(m: MessageFull): string {
  const original = m.bodyHtml || textToHtml(m.bodyText || m.snippet || "");
  try {
    const doc = new DOMParser().parseFromString(original, "text/html");
    for (const root of [...doc.querySelectorAll(QUOTE_ROOT_SEL)]) {
      const prev = root.previousElementSibling;
      const prevText = (prev?.textContent ?? "").trim();
      if (
        prev &&
        /(?:wrote:|작성:|보낸 사람:|from:)\s*$/i.test(prevText) &&
        prevText.length < 500
      ) {
        prev.remove();
      }
      root.remove();
    }

    // Some clients use a literal separator instead of a quote container.
    for (const block of [...doc.body.querySelectorAll("div,p,pre")]) {
      const text = (block.textContent ?? "").trim();
      if (
        /^(?:-{2,}\s*)?(?:original message|forwarded message|원본 메시지|전달된 메시지)(?:\s*-{2,})?$/i.test(
          text,
        )
      ) {
        let node: ChildNode | null = block;
        while (node) {
          const next: ChildNode | null = node.nextSibling;
          node.remove();
          node = next;
        }
        break;
      }
    }

    const direct = doc.body.innerHTML.trim();
    const meaningful =
      (doc.body.textContent ?? "").replace(/\s+/g, "").length > 0;
    return meaningful || /<img\b/i.test(direct) ? direct : original;
  } catch {
    return original;
  }
}

type ForwardBodyFingerprint = {
  text: string;
  links: string;
  structure: string;
  presentation: string;
  hasMedia: boolean;
};

const FORWARD_BLOCK_TAGS = new Set([
  "DIV",
  "P",
  "SECTION",
  "LI",
  "TR",
  "TABLE",
  "BLOCKQUOTE",
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

const FORWARD_STRUCTURAL_TAGS = new Set([
  "BLOCKQUOTE",
  "PRE",
  "CODE",
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "TR",
  "TD",
  "TH",
  "UL",
  "OL",
  "LI",
  "DL",
  "DT",
  "DD",
  "HR",
  "FIGURE",
  "FIGCAPTION",
  "DETAILS",
  "SUMMARY",
  "STRONG",
  "B",
  "EM",
  "I",
  "U",
  "S",
  "DEL",
  "INS",
  "MARK",
  "SMALL",
  "SUB",
  "SUP",
  "FONT",
]);

const FORWARD_MEDIA_SEL = "img,video,audio,source,object,embed,svg,canvas";

const FORWARD_BODY_ATTRS = ["dir", "lang"] as const;

const FORWARD_STYLE_ATTRS = [
  "style",
  "color",
  "bgcolor",
  "face",
  "size",
  "class",
  "id",
] as const;

const FORWARD_ROOT_STYLE_ATTRS = [
  "style",
  "color",
  "bgcolor",
  "face",
  "size",
  "dir",
  "lang",
] as const;

function normalizeForwardText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function forwardReadableText(root: Node): string {
  let out = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    const block = FORWARD_BLOCK_TAGS.has(el.tagName);
    if (block && out && !out.endsWith("\n")) out += "\n";
    for (const child of [...el.childNodes]) walk(child);
    if (block && out && !out.endsWith("\n")) out += "\n";
  };
  walk(root);
  return normalizeForwardText(out);
}

function stripForwardAttribution(root: Element | DocumentFragment): void {
  if (root instanceof Element && root.matches(".gmail_attr")) {
    root.remove();
    return;
  }
  root.querySelectorAll(".gmail_attr").forEach((node) => node.remove());
}

function forwardFingerprint(
  root: Element | DocumentFragment,
): ForwardBodyFingerprint {
  const clone = root.cloneNode(true) as Element | DocumentFragment;
  stripForwardAttribution(clone);
  clone.querySelectorAll("style").forEach((node) => node.remove());
  const elements = [...clone.querySelectorAll("*")];
  const links = elements
    .filter((el) => el.tagName === "A")
    .map(
      (el) =>
        `${el.getAttribute("href")?.trim() ?? ""}\u0000${forwardReadableText(el)}`,
    )
    .join("\u0001");
  const structure = elements
    .filter((el) => FORWARD_STRUCTURAL_TAGS.has(el.tagName))
    .map((el) => el.tagName)
    .join("/");
  const presentation = elements
    .map((el) => {
      const attrs = FORWARD_STYLE_ATTRS.map((name) => {
        const value = el.getAttribute(name);
        return value === null ? "" : `${name}=${value}`;
      })
        .filter(Boolean)
        .join("|");
      return `${el.tagName}[${attrs}]`;
    })
    .join("/");
  const rootPresentation =
    clone instanceof Element
      ? FORWARD_ROOT_STYLE_ATTRS.map((name) => {
          const value = clone.getAttribute(name);
          return value === null ? "" : `${name}=${value}`;
        })
          .filter(Boolean)
          .join("|")
      : "";
  return {
    text: forwardReadableText(clone),
    links,
    structure,
    presentation: `${rootPresentation}::${presentation}`,
    // CIDs are scoped to a message, so equal names do not prove equal media.
    hasMedia: elements.some((el) => el.matches(FORWARD_MEDIA_SEL)),
  };
}

function forwardHtmlFingerprint(html: string): ForwardBodyFingerprint {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return forwardFingerprint(doc.body);
}

function forwardBodyFragment(doc: Document): string {
  // A full mail document's head is not part of the forwarded message. In
  // particular, do not carry global CSS into the host editor/application.
  doc.querySelectorAll("style").forEach((node) => node.remove());
  const body = doc.body;
  const content = body.innerHTML.trim();
  const bodyStyle = body.getAttribute("style");
  const hasBodyStyle = !!bodyStyle?.trim();
  const bodyAttrs = FORWARD_BODY_ATTRS.filter((name) =>
    body.hasAttribute(name),
  );
  const bgcolor = body.getAttribute("bgcolor");
  const text = body.getAttribute("text");
  const hasInlineBackground =
    !!body.style.getPropertyValue("background-color").trim() ||
    !!body.style.getPropertyValue("background").trim();
  const hasInlineColor = !!body.style.getPropertyValue("color").trim();
  if (
    !hasBodyStyle &&
    bodyAttrs.length === 0 &&
    (!bgcolor || hasInlineBackground) &&
    (!text || hasInlineColor)
  ) {
    return content;
  }

  // <body> attributes do not survive when the mail is inserted as a
  // fragment. Re-home only the presentation attributes on a neutral wrapper;
  // downstream sanitization still owns URL/style safety.
  const wrapper = doc.createElement("div");
  if (bodyStyle) wrapper.setAttribute("style", bodyStyle);
  for (const name of bodyAttrs) {
    const value = body.getAttribute(name);
    if (value !== null) wrapper.setAttribute(name, value);
  }
  if (bgcolor && !hasInlineBackground) wrapper.style.backgroundColor = bgcolor;
  if (text && !hasInlineColor) wrapper.style.color = text;
  wrapper.innerHTML = content;
  return wrapper.outerHTML;
}

function sameForwardBody(
  a: ForwardBodyFingerprint,
  b: ForwardBodyFingerprint,
): boolean {
  if (
    a.text !== b.text ||
    a.links !== b.links ||
    a.structure !== b.structure ||
    a.presentation !== b.presentation
  ) {
    return false;
  }
  // Keep rich media unless a separate, message-level proof is available. In
  // particular, matching cid names alone are not proof that images match.
  return !a.hasMedia && !b.hasMedia;
}

function forwardSourceHtml(m: MessageFull): string {
  return m.bodyHtml || textToHtml(m.bodyText || "");
}

function isForwardAttribution(el: Element): boolean {
  if (el.matches(".gmail_attr")) return true;
  const text = normalizeForwardText(el.textContent ?? "");
  return /^(?:on\b.+\bwrote|.+님이\s*작성|(?:from|sent|보낸\s*사람|발신자)\s*:.*)\s*[:：]?$/i.test(
    text,
  );
}

function removeForwardAttribution(root: Element): void {
  let prev = root.previousSibling;
  while (prev?.nodeType === Node.TEXT_NODE && !prev.textContent?.trim()) {
    prev = prev.previousSibling;
  }
  if (
    prev?.nodeType === Node.ELEMENT_NODE &&
    isForwardAttribution(prev as Element)
  ) {
    prev.remove();
  }
}

/**
 * Keep a forward's quoted history unless the complete quoted subtree is
 * represented by a strictly earlier message in the supplied oldest-first
 * thread. Forwarded mail
 * often contains history from outside the current conversation, so unlike
 * directMessageHtml this deliberately does not remove generic quote roots or
 * literal "Original Message" tails without exact thread evidence.
 *
 * The oldest-first ordering is part of this proof: a message cannot justify
 * removing content from an earlier message, which prevents mutual pruning of
 * two quote-only messages. A source absent from the array is left intact.
 */
export function forwardMessageHtml(
  message: MessageFull,
  thread: readonly MessageFull[],
): string {
  const original = forwardSourceHtml(message);
  if (!original) return original;
  try {
    const doc = new DOMParser().parseFromString(original, "text/html");
    const candidates = [...doc.querySelectorAll(QUOTE_ROOT_SEL)];
    if (candidates.length === 0) return forwardBodyFragment(doc);

    const sourceIndex = thread.findIndex((other) => other.id === message.id);
    if (sourceIndex < 0) return forwardBodyFragment(doc);
    const represented = thread
      .slice(0, sourceIndex)
      .map((other) => forwardHtmlFingerprint(forwardSourceHtml(other)));
    if (represented.length === 0) return forwardBodyFragment(doc);

    const matched = candidates.filter((root) => {
      const candidate = forwardFingerprint(root);
      return represented.some((other) => sameForwardBody(candidate, other));
    });
    const removals = matched.filter(
      (root) =>
        !matched.some(
          (ancestor) => ancestor !== root && ancestor.contains(root),
        ),
    );
    if (removals.length === 0) return forwardBodyFragment(doc);

    for (const root of removals) {
      removeForwardAttribution(root);
      root.remove();
    }
    return forwardBodyFragment(doc);
  } catch (cause) {
    // A text alternative can be shorter than the HTML. Never silently replace
    // the original with partial text when preparing the complete thread fails.
    throw new Error("전달할 원문을 준비하지 못했습니다.", { cause });
  }
}

export function rewriteCidRefs(
  html: string,
  cidMap: Map<string, string>,
): string {
  if (cidMap.size === 0) return html;
  return html.replace(/cid:([^"' >)]+)/gi, (whole, raw: string) => {
    let cid = raw;
    try {
      cid = decodeURIComponent(raw);
    } catch {
      // malformed escape — use the raw CID
    }
    const next = cidMap.get(cid.replace(/^<|>$/g, ""));
    return next ? `cid:${next}` : whole;
  });
}

// ---- plain-text linkify ----
// URLs / email addresses in plain-text bodies become real links (no innerHTML).
export const LINK_RE =
  /\bhttps?:\/\/[^\s<>"]+|\bwww\.[^\s<>"]+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;

export type LinkPart = { text: string; href?: string };

// Trailing punctuation is almost never part of the URL, but a ")" that closes
// a "(" inside the URL (wiki-style) is.
export const TRAIL_PUNCT = new Set([...".,;:!?]}>'\""]);

export function trimTrailing(match: string): string {
  // Index-based scan, single final slice: O(n) even for pathological
  // ")…).,;:" tails (regex-replace per round would copy the string each time).
  let opens = 0;
  let closes = 0;
  for (const ch of match) {
    if (ch === "(") opens++;
    else if (ch === ")") closes++;
  }
  let end = match.length;
  for (;;) {
    const prev = end;
    while (end > 0 && TRAIL_PUNCT.has(match[end - 1])) end--;
    while (end > 0 && match[end - 1] === ")" && opens < closes) {
      end--;
      closes--;
    }
    if (end === prev) return match.slice(0, end);
  }
}

export function linkifyParts(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const raw = trimTrailing(m[0]);
    // Decide the scheme from the untrimmed match so degenerate leftovers
    // ("www" after trimming "www.,") never become bogus mailto:/https: links.
    const href = raw.includes("://")
      ? raw
      : m[0].startsWith("www.") && raw.length > 4
        ? `https://${raw}`
        : !m[0].startsWith("www.") && raw.includes("@")
          ? `mailto:${raw}`
          : null;
    if (!href) continue; // leave the match as plain text
    const start = m.index;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: raw, href });
    last = start + raw.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// 메일 본문 HTML 위생 처리. 두 곳에서 쓴다:
//  (1) 받은 메일/드래프트 HTML이 에디터(contentEditable, 메인 문서)에 innerHTML로
//      들어가기 "전" — <img onerror>·<svg onload> 류 인라인 핸들러가 마운트 즉시
//      실행되는 XSS를 막는다 (받은 메일 보기는 무스크립트 iframe이라 안전하지만
//      에디터는 그렇지 않다).
//  (2) 발송 직전 — 수신자/SENT 함을 위한 방어.
export const URL_ATTRS = new Set([
  "href",
  "src",
  "xlink:href",
  "formaction",
  "action",
  "background",
  "poster",
]);

export const DANGER_SCHEME = /^(javascript|vbscript|data):/i;

// strip control/space chars so "java\nscript:" can't slip past the scheme test
export const CTRL_WS = /[\u0000-\u0020]/g;

export function sanitizeMailHtml(
  html: string,
  opts?: { dropCidImages?: boolean },
): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc
      .querySelectorAll(
        "script,style,meta,link,title,base,iframe,object,embed,form",
      )
      .forEach((n) => n.remove());
    if (opts?.dropCidImages) {
      // 답장 인용엔 인라인 이미지를 재첨부하지 않으므로 cid: 참조 이미지를 제거 —
      // 안 그러면 수신자에게 깨진 이미지로 보인다.
      doc.querySelectorAll("img[src]").forEach((img) => {
        if (/^cid:/i.test(img.getAttribute("src") ?? "")) img.remove();
      });
    }
    doc.querySelectorAll("*").forEach((el) => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const val = attr.value.replace(CTRL_WS, "");
        if (name.startsWith("on")) {
          el.removeAttribute(attr.name);
        } else if (
          name === "style" &&
          /expression\(|url\(\s*['"]?\s*(javascript|vbscript):/i.test(
            attr.value,
          )
        ) {
          el.removeAttribute(attr.name);
        } else if (URL_ATTRS.has(name) && DANGER_SCHEME.test(val)) {
          if (!/^data:image\//i.test(val)) el.removeAttribute(attr.name); // data:image만 허용
        }
      }
    });
    return doc.body?.innerHTML ?? "";
  } catch {
    return "";
  }
}

/** RFC 5322: replies accumulate References = original References + its Message-ID. */
export function replyReferences(m: MessageFull): string | undefined {
  return [m.references, m.rfc822MsgId].filter(Boolean).join(" ") || undefined;
}

// HTML → readable plain text: entities decoded, <br>/block tags become line
// breaks. Used for reply quotes and Gmail signature import.
export function htmlToText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("style,script").forEach((n) => n.remove());
    doc.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
    doc.body
      ?.querySelectorAll(
        "p,div,section,li,tr,h1,h2,h3,h4,h5,h6,blockquote,table",
      )
      .forEach((n) => n.append("\n"));
    const text = doc.body?.textContent ?? "";
    return text
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return "";
  }
}

// ---- 인용/전달 체인 단계 분해 (뷰어 전용) ----
// "전달→전달→전달"로 열 번 옮겨다닌 메일은 지금까지 한 덩어리 벽으로 열렸다.
// 클라이언트별 인용 컨테이너를 <details>로 감싸 단계마다 접고, 각 단계의
// 보낸사람·날짜·제목을 뽑아 라벨로 붙인다 — 어느 시점의 메일인지 보고 하나씩
// 들어갈 수 있다. 기본은 전부 접힘(지금 이 메일이 쓴 내용만 먼저 보인다).
// iframe은 무스크립트라 네이티브 <details> 토글을 그대로 쓴다 (높이는 부모가
// toggle 이벤트로 재계산, 단계 이동은 부모가 same-origin으로 open을 켠다).
export const QUOTE_ROOT_SEL =
  'div.gmail_quote, blockquote[type="cite"], div.yahoo_quoted, div[id^="divRplyFwdMsg"], div.mail-fwd, div.mail-quote';

export const FWD_MARK =
  /forwarded message|전달된 메일|begin forwarded|original message|원본 메일/i;

export const HDR_FROM =
  /(?:^|\n)[ \t>]*(?:from|보낸\s?사람|발신자)\s*:\s*(.+)/i;

export const HDR_DATE =
  /(?:^|\n)[ \t>]*(?:date|sent|보낸\s?날짜|날짜)\s*:\s*(.+)/i;

export const HDR_SUBJ = /(?:^|\n)[ \t>]*(?:subject|제목)\s*:\s*(.+)/i;

// "2026년 7월 20일 … 홍길동 <a@b> 님이 작성:" / "On …, X <a@b> wrote:"
export const ATTR_LINE = /([^\n]{0,200}?(?:님이\s*작성|wrote))\s*[:：]\s*$/i;

export type QuoteStage = {
  n: number; // 1부터 — 1이 가장 최근(바깥) 인용
  depth: number; // 중첩 깊이 (들여쓰기 단계)
  who: string;
  when: string;
  subject: string;
};

// textContent는 <br>·블록 경계를 죄다 붙여버려서 "…---From: 홍길동Date: …"이 된다
// — 인용 머리말 파싱이 통째로 실패하던 원인. 줄바꿈을 살려 앞부분만 뽑는다.
// 문자 예산을 채우면 즉시 멈추므로 큰 본문을 훑지 않는다.
export const BLOCK_TAGS = new Set([
  "DIV",
  "P",
  "TR",
  "LI",
  "TABLE",
  "BLOCKQUOTE",
  "H1",
  "H2",
  "H3",
  "H4",
  "PRE",
  "SECTION",
]);

export function headLines(root: Node, budget = 600): string {
  let out = "";
  const walk = (node: Node): boolean => {
    if (out.length >= budget) return true;
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      return out.length >= budget;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const el = node as Element;
    if (el.tagName === "BR") {
      out += "\n";
      return false;
    }
    const block = BLOCK_TAGS.has(el.tagName);
    if (block && out && !out.endsWith("\n")) out += "\n";
    for (const child of [...el.childNodes]) {
      if (walk(child)) return true;
    }
    if (block && out && !out.endsWith("\n")) out += "\n";
    return out.length >= budget;
  };
  walk(root);
  return out.slice(0, budget);
}

export function tidyLine(s: string, max = 80): string {
  const t = s.split("\n")[0].replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// 인용 머리말에서 보낸사람/날짜/제목을 건진다. 헤더 형식(전달)이 없으면
// 답장 인용의 "…님이 작성:" 한 줄을 그대로 라벨로 쓴다.
export function stageMeta(
  head: string,
  prev: string,
): { who: string; when: string; subject: string } {
  const grab = (re: RegExp) => {
    const m = re.exec(head);
    return m ? tidyLine(m[1]) : "";
  };
  const who = grab(HDR_FROM);
  const when = grab(HDR_DATE);
  const subject = grab(HDR_SUBJ);
  if (who || when || subject) return { who, when, subject };
  const attr =
    ATTR_LINE.exec(prev.trim()) ?? ATTR_LINE.exec(head.slice(0, 300).trim());
  return { who: attr ? tidyLine(attr[1]) : "", when: "", subject: "" };
}

export const QUOTE_FOLD_CSS =
  `details.qf{margin:12px 0;padding-left:12px;border-left:3px solid #d7dfea;` +
  `border-radius:0 10px 10px 0;background:linear-gradient(90deg,rgba(238,242,248,.7),rgba(238,242,248,0) 160px)}` +
  `details.qf[data-depth="1"]{border-left-color:#c3cee0}` +
  `details.qf[data-depth="2"]{border-left-color:#aebdd6}` +
  `details.qf[data-depth="3"]{border-left-color:#9aaccc}` +
  `details.qf[data-depth="4"]{border-left-color:#889cc2}` +
  `details.qf[data-depth="5"]{border-left-color:#7a8fb8}` +
  `details.qf>summary{list-style:none;cursor:pointer;user-select:none;display:flex;` +
  `align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px 8px 4px;` +
  `font:600 12.5px/1.4 -apple-system,"Apple SD Gothic Neo",system-ui,sans-serif;color:#3c4453}` +
  `details.qf>summary:hover{color:#1b1f27}` +
  `details.qf>summary::-webkit-details-marker{display:none}` +
  `details.qf>summary::before{content:"▶";font-size:9px;color:#98a2b3}` +
  `details.qf[open]>summary::before{content:"▼"}` +
  `details.qf[open]>summary{border-bottom:1px dashed #e3e7ee;margin-bottom:10px}` +
  `.qf-n{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;` +
  `padding:0 7px;border-radius:999px;background:#e7edf9;color:#2160d8;font-size:11px;font-weight:700}` +
  `.qf-who{color:#1b1f27}` +
  `.qf-when{color:#8a93a3;font-weight:500}` +
  `.qf-sub{color:#5f6368;font-weight:500;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;

export function foldQuoteChains(doc: Document): QuoteStage[] {
  const roots = [...doc.querySelectorAll(QUOTE_ROOT_SEL)];
  if (roots.length === 0) return [];
  // 이 메일이 직접 쓴 분량 — 인용을 다 접었을 때 볼 게 남는지 판단한다.
  const ownBody = doc.body.cloneNode(true) as HTMLElement;
  ownBody.querySelectorAll(QUOTE_ROOT_SEL).forEach((n) => n.remove());
  const ownLen = (ownBody.textContent ?? "").replace(/\s+/g, "").length;

  // 감싸기 전에 깊이를 재 둔다 — 래핑이 끝난 뒤엔 조상 구조가 바뀐다.
  const depths = new Map<Element, number>();
  for (const el of roots) {
    let d = 0;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.matches(QUOTE_ROOT_SEL)) d++;
    }
    depths.set(el, d);
  }

  const stages: QuoteStage[] = [];
  for (const el of roots) {
    const head = headLines(el, 600);
    const prevEl = el.previousElementSibling;
    const prev = prevEl ? headLines(prevEl, 300).slice(-300) : "";
    // Apple Mail 전달은 "Begin forwarded message:" 마커가 blockquote 밖 앞줄에 있다.
    const isFwd =
      el.matches(".mail-fwd") || FWD_MARK.test(head) || FWD_MARK.test(prev);
    // 한두 줄짜리 인용까지 접으면 클릭만 늘어난다.
    if (!isFwd && (el.textContent ?? "").trim().length < 80) continue;

    const n = stages.length + 1;
    const depth = depths.get(el) ?? 0;
    const meta = stageMeta(head, prev);
    stages.push({ n, depth, ...meta });

    const details = doc.createElement("details");
    details.className = "qf";
    details.id = `qstage-${n}`;
    details.dataset.depth = String(Math.min(depth, 5));
    // 알맹이가 전달 한 통뿐인 메일(스스로 쓴 말이 없음)은 첫 단계를 펴 둔다.
    // 한마디라도 직접 썼으면 접어 둔 채 시작한다 — 그게 이 화면의 요점.
    if (n === 1 && ownLen < 12) details.setAttribute("open", "");

    const summary = doc.createElement("summary");
    const badge = doc.createElement("span");
    badge.className = "qf-n";
    badge.textContent = String(n);
    const who = doc.createElement("span");
    who.className = "qf-who";
    who.textContent = meta.who || (isFwd ? "전달된 메일" : "이전 대화");
    summary.append(badge, who);
    for (const [cls, text] of [
      ["qf-when", meta.when],
      ["qf-sub", meta.subject],
    ] as const) {
      if (!text) continue;
      const span = doc.createElement("span");
      span.className = cls;
      span.textContent = text;
      summary.append(span);
    }
    el.replaceWith(details);
    details.append(summary, el);
  }
  if (stages.length === 0) return stages;
  const st = doc.createElement("style");
  st.textContent = QUOTE_FOLD_CSS;
  doc.head.append(st);
  return stages;
}

// Rendered email/description HTML lives in a sandboxed iframe (no scripts).
// Rewrite every link to open in a new top-level tab and drop the referrer,
// so links actually work (instead of navigating inside the sandboxed frame -> 403).
export function prepareEmailHtml(
  html: string,
  bodyStyle?: string,
  cidUrls?: Map<string, string>,
): { html: string; stages: QuoteStage[] } {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Hostile <meta http-equiv="refresh"> would replace the rendered body
    // with an arbitrary remote page — scripts are sandboxed off, but meta
    // refresh is plain markup and works inside the frame.
    doc.querySelectorAll("meta").forEach((mt) => {
      if (
        (mt.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh"
      ) {
        mt.remove();
      }
    });
    // Resolve inline images: cid: refs point at MIME parts of this message.
    if (cidUrls && cidUrls.size > 0) {
      doc.querySelectorAll("img[src]").forEach((img) => {
        const src = img.getAttribute("src") ?? "";
        if (!/^cid:/i.test(src)) return;
        let cid = src.slice(4);
        try {
          cid = decodeURIComponent(cid);
        } catch {
          // malformed escape — match the raw value
        }
        const url = cidUrls.get(cid.replace(/^<|>$/g, ""));
        if (url) img.setAttribute("src", url);
      });
    }
    let base = doc.querySelector("base");
    if (!base) {
      base = doc.createElement("base");
      doc.head.prepend(base);
    }
    // The mail's own <base href> would re-anchor all relative URLs (and a
    // crafted one re-targets every link) — ours only sets target.
    base.removeAttribute("href");
    base.setAttribute("target", "_blank");
    const meta = doc.createElement("meta");
    meta.setAttribute("name", "referrer");
    meta.setAttribute("content", "no-referrer");
    doc.head.prepend(meta);
    doc.querySelectorAll("a[href]").forEach((a) => {
      const href = (a.getAttribute("href") ?? "").trim();
      // HTML URL parsing strips ASCII control chars, so "java\nscript:" still
      // parses as javascript: — strip them before the scheme test too.
      if (
        /^(javascript|data|vbscript):/i.test(
          href.replace(/[\u0000-\u0020]/g, ""),
        )
      ) {
        // Hostile scheme: keep the text, kill the link (target=_blank would
        // otherwise spawn a blank tab on click).
        a.removeAttribute("href");
        return;
      }
      if (href.startsWith("#")) {
        // Pure fragment links must stay inside the frame, not fight <base target>.
        a.setAttribute("target", "_self");
        return;
      }
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });
    const stages = foldQuoteChains(doc);
    if (bodyStyle) {
      const prev = doc.body.getAttribute("style") ?? "";
      doc.body.setAttribute("style", `${bodyStyle};${prev}`);
    }
    return { html: `<!doctype html>${doc.documentElement.outerHTML}`, stages };
  } catch {
    return { html: `<base target="_blank">${html}`, stages: [] };
  }
}
