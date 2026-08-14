import { Hono } from "hono";
import { createMessageListApi } from "./index.ts";
import { describe, expect, it } from "vitest";
import { GmailBatchPartError } from "./gmailBatch.ts";
import { apiErrorStatus, needAuthError, publicApiError } from "./apiErrors.ts";

describe("API error classification", () => {
  it("classifies final embedded 401 as authentication failure", () => {
    const error = new GmailBatchPartError(401, 0);
    expect(needAuthError(error)).toBe(true);
    expect(apiErrorStatus(error)).toBe(401);
  });

  it("classifies embedded insufficient-scope 403 as authentication failure", () => {
    const error = new GmailBatchPartError(403, 0, "insufficient_scope");
    expect(needAuthError(error)).toBe(true);
    expect(apiErrorStatus(error)).toBe(401);
  });

  it.each([403, 429, 500])("keeps unrelated embedded %i failures non-auth", (status) => {
    const error = new GmailBatchPartError(status, 0);
    expect(needAuthError(error)).toBe(false);
    expect(apiErrorStatus(error)).toBe(500);
  });

  it("classifies an invalid_grant refresh failure as authentication failure", () => {
    const error = Object.assign(new Error("refresh failed"), {
      response: { data: { error: "invalid_grant" } },
    });
    expect(needAuthError(error)).toBe(true);
    expect(apiErrorStatus(error)).toBe(401);
  });

  it("redacts unknown server errors from API clients", () => {
    expect(publicApiError(new Error("private upstream detail"))).toBe("INTERNAL_SERVER_ERROR");
  });
});
describe("/api/messages", () => {
  function appFor(
    listMessages: Parameters<typeof createMessageListApi>[0],
  ): Hono {
    return new Hono().route("/api/messages", createMessageListApi(listMessages));
  }

  it("returns the list output from the actual Hono route", async () => {
    const listMessages = async (opts: {
      q?: string;
      labelIds?: string[];
      pageToken?: string;
      maxResults?: number;
    }) => {
      expect(opts).toEqual({
        q: "from:sender",
        labelIds: ["INBOX"],
        pageToken: "next",
        maxResults: 10,
      });
      return {
        messages: [
          {
            id: "m1",
            threadId: "t1",
            from: "sender@example.com",
            to: "test@example.com",
            subject: "Subject",
            snippet: "Snippet",
            date: "2026-08-05T08:00:00.000Z",
            unread: false,
            labelIds: ["INBOX"],
            hasAttachments: false,
          },
        ],
        resultSizeEstimate: 1,
      };
    };

    const response = await appFor(listMessages).request(
      "http://test/api/messages?q=from%3Asender&label=INBOX&pageToken=next&maxResults=10",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [
        {
          id: "m1",
          threadId: "t1",
          from: "sender@example.com",
          to: "test@example.com",
          subject: "Subject",
          snippet: "Snippet",
          date: "2026-08-05T08:00:00.000Z",
          unread: false,
          labelIds: ["INBOX"],
          hasAttachments: false,
        },
      ],
      resultSizeEstimate: 1,
    });
  });

  it.each(["0", "-1", "1.5", "501"])("rejects invalid maxResults=%s", async (maxResults) => {
    let called = false;
    const response = await appFor(async () => {
      called = true;
      throw new Error("must not run");
    }).request(`http://test/api/messages?maxResults=${maxResults}`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "maxResults must be an integer from 1 to 500",
    });
    expect(called).toBe(false);
  });

  it("maps authentication failures to NOT_AUTHENTICATED", async () => {
    const response = await appFor(async () => {
      throw new GmailBatchPartError(401, 0, "unauthenticated");
    }).request("http://test/api/messages");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "NOT_AUTHENTICATED" });
  });

  it("keeps non-auth failures as server errors", async () => {
    const response = await appFor(async () => {
      throw new GmailBatchPartError(429, 0, "rate limited");
    }).request("http://test/api/messages");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "GMAIL_BATCH_PART_429_REQUEST_FAILED",
    });
  });
});
