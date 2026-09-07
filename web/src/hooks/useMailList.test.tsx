// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageSummary } from "../api.ts";

const { messages } = vi.hoisted(() => ({ messages: vi.fn() }));
vi.mock("../api.ts", () => ({
  api: { messages },
  AuthError: class AuthError extends Error {},
}));

import { shouldRemoveArchivedMessage, useMailList } from "./useMailList.ts";

const message = (id: string): MessageSummary => ({
  id,
  threadId: `thread-${id}`,
  from: "sender@example.com",
  to: "recipient@example.com",
  subject: id,
  snippet: id,
  date: "2026-01-01T00:00:00.000Z",
  unread: true,
  labelIds: ["INBOX"],
  hasAttachments: false,
});
const response = (items: MessageSummary[], nextPageToken?: string) => ({
  messages: items,
  nextPageToken,
  resultSizeEstimate: items.length,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => messages.mockReset());

describe("useMailList", () => {
  it("keeps only the newest response and suppresses a stale non-auth failure", async () => {
    const first = deferred<ReturnType<typeof response>>();
    const second = deferred<ReturnType<typeof response>>();
    messages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const guard = vi.fn((task: () => Promise<void>) => void task());
    const { result } = renderHook(() => useMailList("INBOX", "", guard));

    act(() => {
      result.current.load(true);
      result.current.load(true);
    });
    await act(async () => second.resolve(response([message("new")])));
    await act(async () => first.reject(new Error("obsolete")));

    expect(result.current.messages.map((item) => item.id)).toEqual(["new"]);
    expect(result.current.loading).toBe(false);
  });

  it("clears transition state, dedupes appended page boundaries, and retains stable getters", async () => {
    messages
      .mockResolvedValueOnce(response([message("one"), message("two")], "page-2"))
      .mockResolvedValueOnce(response([message("two"), message("three")]));
    const guard = (task: () => Promise<void>) => void task();
    const { result, rerender } = renderHook(
      ({ label, query }) => useMailList(label, query, guard),
      { initialProps: { label: "INBOX", query: "" } },
    );
    const getMessages = result.current.getMessages;
    const getNextToken = result.current.getNextToken;
    const getActiveLabel = result.current.getActiveLabel;
    const getQuery = result.current.getQuery;

    await act(async () => result.current.load(true));
    await act(async () => result.current.load(false));
    expect(result.current.messages.map((item) => item.id)).toEqual(["one", "two", "three"]);
    expect(messages.mock.calls[1][0]).toMatchObject({ pageToken: "page-2" });

    rerender({ label: "STARRED", query: "needle" });
    expect(result.current.getMessages).toBe(getMessages);
    expect(result.current.getNextToken).toBe(getNextToken);
    expect(result.current.getActiveLabel()).toBe("STARRED");
    expect(result.current.getQuery()).toBe("needle");
    expect(result.current.getActiveLabel).toBe(getActiveLabel);
    expect(result.current.getQuery).toBe(getQuery);
    expect(shouldRemoveArchivedMessage(result.current.getActiveLabel(), result.current.getQuery())).toBe(false);
    expect(shouldRemoveArchivedMessage("INBOX", "")).toBe(true);
    act(() => result.current.reset());
    expect(result.current.messages).toEqual([]);
    expect(result.current.nextToken).toBeUndefined();
  });

  it("coalesces synchronous duplicate appends by page token", async () => {
    const append = deferred<ReturnType<typeof response>>();
    messages
      .mockResolvedValueOnce(response([message("one")], "page-2"))
      .mockReturnValueOnce(append.promise);
    const guard = (task: () => Promise<void>) => void task();
    const { result } = renderHook(() => useMailList("INBOX", "", guard));

    await act(async () => result.current.load(true));
    act(() => {
      result.current.load(false);
      result.current.load(false);
    });
    expect(messages).toHaveBeenCalledTimes(2);

    await act(async () => append.resolve(response([message("two")])));
    expect(result.current.messages.map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("allows an append page to retry after an error", async () => {
    messages
      .mockResolvedValueOnce(response([message("one")], "page-2"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response([message("two")]));
    const guard = (task: () => Promise<void>) => void task().catch(() => {});
    const { result } = renderHook(() => useMailList("INBOX", "", guard));

    await act(async () => result.current.load(true));
    await act(async () => result.current.load(false));
    expect(messages).toHaveBeenCalledTimes(2);
    await act(async () => result.current.load(false));
    expect(messages).toHaveBeenCalledTimes(3);
    expect(result.current.messages.map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("lets a reset replace an in-flight append and discards its stale response", async () => {
    const append = deferred<ReturnType<typeof response>>();
    const reset = deferred<ReturnType<typeof response>>();
    messages
      .mockResolvedValueOnce(response([message("one")], "page-2"))
      .mockReturnValueOnce(append.promise)
      .mockReturnValueOnce(reset.promise);
    const guard = (task: () => Promise<void>) => void task();
    const { result } = renderHook(() => useMailList("INBOX", "", guard));

    await act(async () => result.current.load(true));
    act(() => {
      result.current.load(false);
      result.current.load(true);
    });
    expect(messages).toHaveBeenCalledTimes(3);
    expect(messages.mock.calls[1][0]).toMatchObject({ pageToken: "page-2" });
    expect(messages.mock.calls[2][0]).toMatchObject({ pageToken: undefined });

    await act(async () => reset.resolve(response([message("replacement")])));
    await act(async () => append.resolve(response([message("stale")])));
    expect(result.current.messages.map((item) => item.id)).toEqual(["replacement"]);
  });

  it("does not let an append supersede a pending reset", async () => {
    const reset = deferred<ReturnType<typeof response>>();
    messages
      .mockResolvedValueOnce(response([message("one")], "old-page-2"))
      .mockReturnValueOnce(reset.promise)
      .mockResolvedValueOnce(response([message("next")]));
    const guard = (task: () => Promise<void>) => void task();
    const { result } = renderHook(() => useMailList("INBOX", "", guard));

    await act(async () => result.current.load(true));
    act(() => {
      result.current.load(true);
      result.current.load(false);
    });
    expect(messages).toHaveBeenCalledTimes(2);
    expect(messages.mock.calls[1][0]).toMatchObject({ pageToken: undefined });

    await act(async () => reset.resolve(response([message("replacement")], "new-page-2")));
    expect(result.current.messages.map((item) => item.id)).toEqual(["replacement"]);

    await act(async () => result.current.load(false));
    expect(messages).toHaveBeenCalledTimes(3);
    expect(messages.mock.calls[2][0]).toMatchObject({ pageToken: "new-page-2" });
    expect(result.current.messages.map((item) => item.id)).toEqual(["replacement", "next"]);
  });
});
