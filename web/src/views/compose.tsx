// 작성창: 서식 에디터, 수신자 칩 입력, 발송/임시저장, 인용 조립, data:→cid 변환.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  AuthError,
  HttpError,
  parseAddr,
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
import { loadContactsOnce } from "../lib/contacts.ts";
import {
  getDefaultFont,
  getSignatureBlockHtml,
  getUndoSec,
} from "../lib/settings.ts";
import { DialogGrip, DialogTools, useResizableDialog } from "../ui/dialog.tsx";
import { AlertIcon, AttachmentIcon } from "../ui/icons.tsx";
import { RichEditor } from "../ui/richEditor.tsx";
import { RecipientField } from "../ui/recipientField.tsx";

// 서명/붙여넣기로 본문에 박힌 data:image base64 → cid 인라인 첨부. 이메일
// 클라이언트는 data: URI 이미지를 막으므로, 발송 직전 multipart/related cid로
// 옮겨야 모든 수신함에서 보인다. 반환 html은 src가 cid:로 치환된 것.
let inlineCidSeq = 0;

export function dataUrisToCid(html: string): {
  html: string;
  inline: ComposeAttachment[];
} {
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
    // Preserve the flat thread and original author formatting. App theme CSS
    // stays outside this HTML; sanitize before insertion into the editor.
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
    aliases.find((s) => s.isDefault) ??
    aliases.find((s) => s.isPrimary) ??
    aliases[0];
  // 드래프트 이어쓰기 시 원래 별칭(init.from) 복원, 아니면 기본 별칭.
  const initFromEmail = init?.from
    ? parseAddr(init.from).email.toLowerCase()
    : "";
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
  const chosenAlias =
    aliases.find((s) => s.email === fromEmail) ?? defaultAlias();
  const fromHeader = chosenAlias
    ? chosenAlias.displayName
      ? `"${chosenAlias.displayName.replace(/"/g, "")}" <${chosenAlias.email}>`
      : chosenAlias.email
    : undefined;
  // 인라인 이미지(cid:) 미리보기 매핑 (마운트 1회). 전달/드래프트 인라인 첨부를
  // blob URL로 만들어 에디터에 보여주고, 발송 직전 cid:로 되돌린다.
  const editorRef = useRef<HTMLDivElement>(null);
  const cidMaps = useRef<{
    cidToUrl: Map<string, string>;
    urlToCid: Map<string, string>;
  }>({
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
    () => () =>
      cidMaps.current.urlToCid.forEach((_, url) => URL.revokeObjectURL(url)),
    [],
  );

  const initialHtml = useMemo(() => {
    // 드래프트 이어쓰기: 저장된 HTML. Gmail-web 드래프트엔 위험 마크업이 있을 수
    // 있으므로 에디터(메인 문서)에 넣기 전 위생 처리한다.
    let html: string;
    if (init?.draftId || init?.bodyHtml) {
      html = init?.bodyHtml
        ? sanitizeMailHtml(init.bodyHtml)
        : "<div><br></div>";
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
      for (const node of Array.from(tmp.childNodes))
        ed.insertBefore(node, anchor);
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
        ? drive.map(({ filename, mimeType, data }) => ({
            filename,
            mimeType,
            data,
          }))
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
                보내는 주소:{" "}
                {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
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
        <RecipientField
          label="참조"
          value={cc}
          onChange={setCc}
          suggestions={contacts}
        />
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
                  <AttachmentIcon />
                  {f.filename} ({Math.round(f.size / 1024)}KB)
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
          <div className="muted settings-label">
            <AlertIcon />
            {formErr}
          </div>
        )}
        <div className="modal-foot">
          <label className="btn">
            <AttachmentIcon />
            파일 첨부
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
