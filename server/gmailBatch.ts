export const GMAIL_BATCH_MAX_PARTS = 50;

export type GmailBatchPart = {
  index: number;
  status: number;
  body?: unknown;
  reason?: string;
};

/** A deliberately redacted error for an embedded Gmail batch response. */
export class GmailBatchPartError extends Error {
  readonly status: number;
  readonly batchIndex: number;
  readonly reason: string;
  readonly retryable: boolean;

  constructor(status: number, batchIndex: number, reason = "request_failed") {
    const safeReason = [
      "insufficient_scope",
      "user_rate_limit",
      "project_rate_limit",
      "backend_error",
    ].includes(reason)
      ? reason
      : "request_failed";
    super(`GMAIL_BATCH_PART_${status}_${safeReason.toUpperCase()}`);
    this.name = "GmailBatchPartError";
    this.status = status;
    this.batchIndex = batchIndex;
    this.reason = safeReason;
    this.retryable =
      status === 401 ||
      status === 429 ||
      status >= 500 ||
      safeReason === "user_rate_limit" ||
      safeReason === "project_rate_limit" ||
      safeReason === "backend_error";
  }
}

export class GmailBatchParseError extends Error {
  constructor() {
    super("GMAIL_BATCH_MALFORMED_RESPONSE");
    this.name = "GmailBatchParseError";
  }
}

export function makeBatchBoundary(): string {
  return `mail_batch_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function buildMessageMetadataBatch(ids: string[], boundary: string): string {
  return ids
    .map((id, index) => {
      const query = new URLSearchParams({ format: "metadata" });
      for (const header of ["From", "To", "Subject", "Date", "Content-Type"])
        query.append("metadataHeaders", header);
      return [
        `--${boundary}`,
        "Content-Type: application/http",
        `Content-ID: <mail-item-${index}>`,
        "",
        `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?${query.toString()} HTTP/1.1`,
        "Accept: application/json",
        "",
        "",
      ].join("\r\n");
    })
    .concat(`--${boundary}--\r\n`)
    .join("");
}

function headerValue(headers: string, name: string): string | undefined {
  for (const line of headers.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === name.toLowerCase())
      return line.slice(colon + 1).trim();
  }
  return undefined;
}

function responseBoundary(contentType: string | undefined): string {
  const match = contentType?.match(/multipart\/mixed\s*;[\s\S]*?boundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s\r\n]+))/i);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new GmailBatchParseError();
  return boundary;
}

function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const lines = body.split(/\r?\n/);
  const parts: string[] = [];
  let current: string[] | undefined;
  let closed = false;
  for (const line of lines) {
    if (line === marker || line === `${marker}--`) {
      if (current !== undefined) parts.push(current.join("\r\n"));
      if (line === `${marker}--`) {
        closed = true;
        current = undefined;
        break;
      }
      current = [];
    } else if (current !== undefined) {
      current.push(line);
    }
  }
  if (!closed || parts.length === 0) throw new GmailBatchParseError();
  return parts;
}

function parseReason(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: { status?: unknown; errors?: { reason?: unknown }[] } }).error;
  const reasons = error?.errors?.map((item) => item.reason) ?? [];
  if (reasons.includes("insufficientPermissions"))
    return "insufficient_scope";
  if (reasons.includes("userRateLimitExceeded") || error?.status === "RESOURCE_EXHAUSTED")
    return "user_rate_limit";
  if (reasons.includes("rateLimitExceeded") || reasons.includes("quotaExceeded"))
    return "project_rate_limit";
  if (reasons.includes("backendError")) return "backend_error";
  return undefined;
}

/** Parse Gmail's multipart envelope, mapping strictly by its response Content-ID. */
export function parseMessageMetadataBatch(
  contentType: string | undefined,
  body: string,
  expectedParts: number,
): GmailBatchPart[] {
  const parts = splitMultipart(body, responseBoundary(contentType));
  if (parts.length !== expectedParts) throw new GmailBatchParseError();
  const result = new Map<number, GmailBatchPart>();
  for (const part of parts) {
    const separator = part.search(/\r?\n\r?\n/);
    if (separator < 0) throw new GmailBatchParseError();
    const envelope = part.slice(0, separator);
    const embedded = part.slice(separator).replace(/^\r?\n\r?\n/, "");
    const id = headerValue(envelope, "Content-ID");
    const idMatch = id?.match(/^<response-mail-item-(\d+)>$/);
    if (!idMatch) throw new GmailBatchParseError();
    const index = Number(idMatch[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index >= expectedParts || result.has(index))
      throw new GmailBatchParseError();
    const statusMatch = embedded.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|\r?$)/m);
    if (!statusMatch) throw new GmailBatchParseError();
    const status = Number(statusMatch[1]);
    const httpEnd = embedded.search(/\r?\n\r?\n/);
    if (httpEnd < 0) throw new GmailBatchParseError();
    const json = embedded.slice(httpEnd).replace(/^\r?\n\r?\n/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new GmailBatchParseError();
    }
    if (!parsed || typeof parsed !== "object") throw new GmailBatchParseError();
    result.set(index, { index, status, body: parsed, reason: parseReason(parsed) });
  }
  if (result.size !== expectedParts) throw new GmailBatchParseError();
  return Array.from({ length: expectedParts }, (_, index) => result.get(index)!);
}
