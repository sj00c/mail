import { beforeEach, describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "@googleapis/gmail";

const { gmail, getAuthedClient } = vi.hoisted(() => ({
  gmail: vi.fn(),
  getAuthedClient: vi.fn(),
}));

vi.mock("@googleapis/gmail", () => ({ gmail }));
vi.mock("./auth.ts", () => ({ getAuthedClient }));

import { getThread } from "./gmail.ts";

function encoded(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function message(
  id: string,
  internalDate: string,
  parts: gmail_v1.Schema$MessagePart[],
): gmail_v1.Schema$Message {
  return {
    id,
    threadId: "thread-1",
    internalDate,
    payload: { mimeType: "multipart/mixed", parts },
  };
}

describe("Gmail thread hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthedClient.mockResolvedValue({ token: "test" });
  });

  it("hydrates external text bodies, preserves files/CIDs, and sorts oldest first", async () => {
    const threadsGet = vi.fn(async () => ({
      data: {
        messages: [
          message("new", "2000", [
            { mimeType: "text/html", body: { attachmentId: "body-new" } },
          ]),
          message("old", "1000", [
            { mimeType: "text/plain", body: { attachmentId: "body-old" } },
            {
              mimeType: "text/html",
              filename: "saved.html",
              headers: [{ name: "Content-Disposition", value: "attachment" }],
              body: { attachmentId: "file-html" },
              parts: [
                {
                  mimeType: "text/plain",
                  body: { attachmentId: "nested-body" },
                },
              ],
            },
            {
              mimeType: "text/plain",
              filename: "saved.txt",
              body: { attachmentId: "file-txt" },
            },
            {
              mimeType: "image/png",
              headers: [{ name: "Content-ID", value: "<logo>" }],
              body: { attachmentId: "cid-logo" },
            },
          ]),
        ],
      },
    }));
    const attachmentsGet = vi.fn(async ({ id }: { id: string }) => ({
      data: {
        data: {
          "body-old": encoded("old body"),
          "body-new": encoded("<p>new body</p>"),
        }[id],
      },
    }));
    gmail.mockReturnValue({
      users: {
        threads: { get: threadsGet },
        messages: { attachments: { get: attachmentsGet } },
      },
    });

    const result = await getThread("thread-1");

    expect(result.map((item) => item.id)).toEqual(["old", "new"]);
    expect(result[0].bodyText).toBe("old body");
    expect(result[1].bodyHtml).toBe("<p>new body</p>");
    expect(result[0].attachments).toEqual([
      {
        id: "file-html",
        filename: "saved.html",
        mimeType: "text/html",
        size: 0,
      },
      {
        id: "file-txt",
        filename: "saved.txt",
        mimeType: "text/plain",
        size: 0,
      },
      {
        id: "cid-logo",
        filename: "attachment.png",
        mimeType: "image/png",
        size: 0,
        contentId: "logo",
      },
    ]);
    expect(attachmentsGet).toHaveBeenCalledTimes(2);
    expect(attachmentsGet).toHaveBeenCalledWith({
      userId: "me",
      messageId: "old",
      id: "body-old",
    });
    expect(attachmentsGet).toHaveBeenCalledWith({
      userId: "me",
      messageId: "new",
      id: "body-new",
    });
  });

  it("does not call attachments.get for ordinary inlined bodies", async () => {
    const threadsGet = vi.fn(async () => ({
      data: {
        messages: [
          message("inline", "1000", [
            {
              mimeType: "text/plain",
              body: { data: encoded("already here") },
            },
          ]),
        ],
      },
    }));
    const attachmentsGet = vi.fn();
    gmail.mockReturnValue({
      users: {
        threads: { get: threadsGet },
        messages: { attachments: { get: attachmentsGet } },
      },
    });

    await expect(getThread("thread-1")).resolves.toMatchObject([
      { id: "inline", bodyText: "already here" },
    ]);
    expect(attachmentsGet).not.toHaveBeenCalled();
  });

  it("rejects when an external body has no data", async () => {
    const threadsGet = vi.fn(async () => ({
      data: {
        messages: [
          message("missing", "1000", [
            { mimeType: "text/plain", body: { attachmentId: "body-missing" } },
          ]),
        ],
      },
    }));
    const attachmentsGet = vi.fn(async () => ({ data: {} }));
    gmail.mockReturnValue({
      users: {
        threads: { get: threadsGet },
        messages: { attachments: { get: attachmentsGet } },
      },
    });

    await expect(getThread("thread-1")).rejects.toThrow("returned no data");
  });

  it("rejects an empty external body when Gmail reports non-zero source size", async () => {
    const threadsGet = vi.fn(async () => ({
      data: {
        messages: [
          message("incomplete", "1000", [
            {
              mimeType: "text/plain",
              body: { attachmentId: "body-incomplete", size: 4 },
            },
          ]),
        ],
      },
    }));
    const attachmentsGet = vi.fn(async () => ({ data: { data: "" } }));
    gmail.mockReturnValue({
      users: {
        threads: { get: threadsGet },
        messages: { attachments: { get: attachmentsGet } },
      },
    });

    await expect(getThread("thread-1")).rejects.toThrow("incomplete data");
  });

  it("accepts an empty external body when Gmail reports zero source size", async () => {
    const threadsGet = vi.fn(async () => ({
      data: {
        messages: [
          message("empty", "1000", [
            {
              mimeType: "text/plain",
              body: { attachmentId: "body-empty", size: 0 },
            },
          ]),
        ],
      },
    }));
    const attachmentsGet = vi.fn(async () => ({ data: { data: "" } }));
    gmail.mockReturnValue({
      users: {
        threads: { get: threadsGet },
        messages: { attachments: { get: attachmentsGet } },
      },
    });

    await expect(getThread("thread-1")).resolves.toMatchObject([
      { id: "empty", bodyText: null, bodyHtml: null },
    ]);
  });

  it("propagates external body fetch failures instead of returning a partial thread", async () => {
    const threadsGet = vi.fn(async () => ({
      data: {
        messages: [
          message("failed", "1000", [
            { mimeType: "text/html", body: { attachmentId: "body-failed" } },
          ]),
        ],
      },
    }));
    const failure = new Error("network down");
    const attachmentsGet = vi.fn(async () => {
      throw failure;
    });
    gmail.mockReturnValue({
      users: {
        threads: { get: threadsGet },
        messages: { attachments: { get: attachmentsGet } },
      },
    });

    await expect(getThread("thread-1")).rejects.toBe(failure);
  });

  it("stops queueing new body fetches after a worker fails", async () => {
    const parts = Array.from({ length: 12 }, (_, index) => ({
      mimeType: "text/plain",
      body: { attachmentId: `body-${index}` },
    }));
    const threadsGet = vi.fn(async () => ({
      data: { messages: [message("many", "1000", parts)] },
    }));
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = new Error("first body failed");
    const attachmentsGet = vi.fn(async ({ id }: { id: string }) => {
      if (id === "body-0") throw failure;
      await inFlight;
      return { data: { data: encoded(id) } };
    });
    gmail.mockReturnValue({
      users: {
        threads: { get: threadsGet },
        messages: { attachments: { get: attachmentsGet } },
      },
    });

    const result = getThread("thread-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attachmentsGet).toHaveBeenCalledTimes(5);
    release();
    await expect(result).rejects.toBe(failure);
    expect(attachmentsGet).toHaveBeenCalledTimes(5);
  });

  it("limits concurrent external body fetches", async () => {
    const parts = Array.from({ length: 12 }, (_, index) => ({
      mimeType: "text/plain",
      body: { attachmentId: `body-${index}` },
    }));
    const threadsGet = vi.fn(async () => ({
      data: { messages: [message("many", "1000", parts)] },
    }));
    let active = 0;
    let maximum = 0;
    const attachmentsGet = vi.fn(async ({ id }: { id: string }) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { data: { data: encoded(id) } };
    });
    gmail.mockReturnValue({
      users: {
        threads: { get: threadsGet },
        messages: { attachments: { get: attachmentsGet } },
      },
    });

    await getThread("thread-1");

    expect(attachmentsGet).toHaveBeenCalledTimes(12);
    expect(maximum).toBeLessThanOrEqual(5);
  });
});
