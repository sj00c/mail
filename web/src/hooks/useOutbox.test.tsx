// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDO_KEY } from "../lib/settings.ts";
import type { SendPayload } from "../views/compose.tsx";

const { send, deleteDraft } = vi.hoisted(() => ({ send: vi.fn(), deleteDraft: vi.fn() }));
vi.mock("../api.ts", () => ({ api: { send, deleteDraft } }));

import { useOutbox } from "./useOutbox.ts";

const payload: SendPayload = {
  to: "recipient@example.com",
  cc: "",
  bcc: "",
  subject: "subject",
  body: "body",
};
const handlers = () => ({ onSent: vi.fn(), onError: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  send.mockReset().mockResolvedValue(undefined);
  deleteDraft.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("useOutbox", () => {
  it.each([0, 5, 10, 20])("sends after the configured %is undo delay", async (seconds) => {
    localStorage.setItem(UNDO_KEY, String(seconds));
    const currentHandlers = handlers();
    const { result, unmount } = renderHook(() => useOutbox(currentHandlers));
    act(() => result.current.queueSend(payload));
    expect(send).not.toHaveBeenCalled();
    if (seconds > 0) {
      await act(async () => vi.advanceTimersByTimeAsync(seconds * 1000 - 1));
      expect(send).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(1));
    } else {
      await act(async () => vi.advanceTimersByTimeAsync(0));
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(currentHandlers.onSent).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("cancels or sends-now a queued item exactly once", async () => {
    localStorage.setItem(UNDO_KEY, "20");
    const { result, unmount } = renderHook(() => useOutbox(handlers()));
    act(() => result.current.queueSend(payload));
    const canceled = result.current.cancelSend(result.current.outbox[0].key);
    expect(canceled?.payload).toBe(payload);
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(send).not.toHaveBeenCalled();

    act(() => result.current.queueSend(payload));
    const key = result.current.outbox[0].key;
    act(() => {
      result.current.sendNow(key);
      result.current.sendNow(key);
    });
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(send).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("deletes a draft only after send succeeds and reports send failure without deletion", async () => {
    localStorage.setItem(UNDO_KEY, "20");
    let resolveSend!: () => void;
    send.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    const currentHandlers = handlers();
    const { result, unmount } = renderHook(() => useOutbox(currentHandlers));
    act(() => result.current.queueSend(payload, "draft-1"));
    act(() => result.current.sendNow(result.current.outbox[0].key));
    expect(deleteDraft).not.toHaveBeenCalled();
    await act(async () => resolveSend());
    expect(deleteDraft).toHaveBeenCalledWith("draft-1");
    expect(currentHandlers.onSent).toHaveBeenCalledTimes(1);

    send.mockRejectedValueOnce(new Error("send failed"));
    act(() => result.current.queueSend(payload, "draft-2"));
    act(() => result.current.sendNow(result.current.outbox[0].key));
    await act(async () => {});
    expect(deleteDraft).toHaveBeenCalledTimes(1);
    expect(currentHandlers.onError).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("keeps the captured send alive after unmount without writing through its removed subscriber", async () => {
    localStorage.setItem(UNDO_KEY, "5");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useOutbox(handlers()));
    act(() => result.current.queueSend(payload));
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(send).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
