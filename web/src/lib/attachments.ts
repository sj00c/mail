// 첨부 인코딩/다운로드 유틸과 MIME/Drive 분할 정책.
import { api, AuthError } from "../api.ts";

/** Download via fetch + blob link: plain <a> navigation replaces the SPA with
 *  a raw JSON error page when the attachment request fails. */
export async function saveAttachment(
  messageId: string,
  a: { id: string; filename: string },
): Promise<void> {
  const res = await fetch(api.attachmentUrl(messageId, a.id, a.filename));
  if (res.status === 401) throw new AuthError("NOT_AUTHENTICATED");
  if (!res.ok) {
    throw new Error(`첨부 다운로드 실패 (${a.filename}): HTTP ${res.status}`);
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = a.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export type ComposeAttachment = {
  filename: string;
  mimeType: string;
  data: string;
  size: number;
  contentId?: string; // inline (cid:) image — re-related on forward
};

export function fileToBase64(file: File): Promise<{
  filename: string;
  mimeType: string;
  data: string;
  size: number;
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const data = result.slice(result.indexOf(",") + 1);
      resolve({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        data,
        size: file.size,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Split attachments so the MIME message stays under Gmail's ~35MB cap. Inline
// (cid) images are referenced by the body and can't move — they always ride in
// MIME and are charged against the budget first. Remaining file attachments
// fill what's left of the budget (raw bytes); whatever overflows is sent as a
// Drive link instead, exactly like Gmail web does past 25MB.
export function partitionAttachments(files: ComposeAttachment[], budget: number) {
  const mime: ComposeAttachment[] = [];
  const drive: ComposeAttachment[] = [];
  let used = files
    .filter((f) => f.contentId)
    .reduce((s, f) => s + f.size, 0);
  for (const f of files) {
    if (f.contentId) {
      mime.push(f); // inline, already counted in `used`
    } else if (used + f.size <= budget) {
      mime.push(f);
      used += f.size;
    } else {
      drive.push(f);
    }
  }
  return { mime, drive };
}

/** Base64 (no data: prefix) of an already-downloaded blob (전달 첨부 재사용). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---- 작성창 인라인 이미지(cid:) 미리보기 ----
// 에디터는 메인 문서라 cid:를 해석하지 못한다. 전달/드래프트의 인라인 이미지는
// 메모리 base64로 들고 있으므로, 표시용 blob URL로 바꿔 보여주고 발송 직전 다시
// cid:로 되돌려 multipart/related 재연결이 깨지지 않게 한다.
export function base64ToObjectUrl(b64: string, mime: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime || "application/octet-stream" }));
}

export function resolveCidSrc(html: string, cidToUrl: Map<string, string>): string {
  if (cidToUrl.size === 0) return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("img[src]").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      if (!/^cid:/i.test(src)) return;
      let cid = src.slice(4);
      try {
        cid = decodeURIComponent(cid);
      } catch {
        /* malformed escape */
      }
      const url = cidToUrl.get(cid.replace(/^<|>$/g, ""));
      if (url) img.setAttribute("src", url);
    });
    return doc.body?.innerHTML ?? html;
  } catch {
    return html;
  }
}

export function restoreCidSrc(html: string, urlToCid: Map<string, string>): string {
  let out = html;
  for (const [url, cid] of urlToCid) out = out.split(url).join(`cid:${cid}`);
  return out;
}

/** Re-download an attachment for forward/draft-resume. Throws on HTTP errors
 *  instead of silently base64-encoding an error JSON body as the attachment. */
export async function downloadAttachment(
  messageId: string,
  a: { id: string; filename: string; mimeType: string; size: number; contentId?: string },
): Promise<ComposeAttachment> {
  const res = await fetch(api.attachmentUrl(messageId, a.id, a.filename));
  if (res.status === 401) throw new AuthError("NOT_AUTHENTICATED");
  if (!res.ok) {
    throw new Error(`첨부 다운로드 실패 (${a.filename}): HTTP ${res.status}`);
  }
  return {
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    contentId: a.contentId, // preserve cid so forwarded inline images re-link
    data: await blobToBase64(await res.blob()),
  };
}
