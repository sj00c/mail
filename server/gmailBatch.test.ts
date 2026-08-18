import { describe, expect, it } from "vitest";
import {
  buildMessageMetadataBatch,
  GmailBatchParseError,
  parseMessageMetadataBatch,
} from "./gmailBatch.ts";

const boundary = "batch_fixture";

function response(parts: Array<{ index: number; status: number; body?: unknown }>) {
  return parts
    .map(({ index, status, body }) => [
      `--${boundary}`,
      "Content-Type: application/http",
      `Content-ID: <response-mail-item-${index}>`,
      "",
      `HTTP/1.1 ${status} Status`,
      "Content-Type: application/json",
      "",
      JSON.stringify(body ?? {}),
    ].join("\r\n"))
    .concat(`--${boundary}--`)
    .join("\r\n");
}

describe("Gmail multipart metadata batches", () => {
  it("uses CRLF, encoded ids, and stable request Content-IDs", () => {
    const body = buildMessageMetadataBatch(["a/b", "two"], boundary);
    expect(body).toContain("Content-ID: <mail-item-0>\r\n");
    expect(body).toContain("GET /gmail/v1/users/me/messages/a%2Fb?");
    expect(body).toContain("metadataHeaders=Content-Type");
    expect(body).toMatch(/\r\n--batch_fixture--\r\n$/);
  });

  it("maps actual Gmail response Content-IDs instead of response order", () => {
    const parsed = parseMessageMetadataBatch(
      `multipart/mixed; boundary="${boundary}"`,
      response([
        { index: 1, status: 200, body: { id: "second" } },
        { index: 0, status: 200, body: { id: "first" } },
      ]),
      2,
    );
    expect(parsed.map((part) => (part.body as { id: string }).id)).toEqual(["first", "second"]);
  });

  it("retains only safe quota classifications for diagnosis", () => {
    const parsed = parseMessageMetadataBatch(
      `multipart/mixed; boundary=${boundary}`,
      response([{
        index: 0,
        status: 429,
        body: {
          error: {
            status: "RESOURCE_EXHAUSTED",
            errors: [{ reason: "userRateLimitExceeded" }],
          },
        },
      }]),
      1,
    );
    expect(parsed[0].reason).toBe("user_rate_limit");
  });

  it("rejects malformed, missing, duplicate, and unknown response parts without exposing payloads", () => {
    const malformed = response([{ index: 0, status: 200, body: { snippet: "secret" } }]);
    expect(() => parseMessageMetadataBatch(`multipart/mixed; boundary=${boundary}`, malformed, 2)).toThrow(GmailBatchParseError);
    expect(() => parseMessageMetadataBatch(`multipart/mixed; boundary=${boundary}`, malformed.replace("Content-ID: <response-mail-item-0>", "Content-ID:"), 1)).toThrow(GmailBatchParseError);
    expect(() => parseMessageMetadataBatch(`multipart/mixed; boundary=${boundary}`, malformed.replace("response-mail-item-0", "response-mail-item-4"), 1)).toThrow(GmailBatchParseError);
    expect(() => parseMessageMetadataBatch(`multipart/mixed; boundary=${boundary}`, response([
      { index: 0, status: 200 }, { index: 0, status: 200 },
    ]), 2)).toThrow(GmailBatchParseError);
  });
});
