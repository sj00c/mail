// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { messages } = vi.hoisted(() => ({ messages: vi.fn() }));
vi.mock("../api.ts", () => ({
  api: { messages },
  AuthError: class AuthError extends Error {},
  parseAddr: (value: string) => ({ name: value }),
}));

import { AuthError, type MessageSummary } from "../api.ts";

import { useInboxPoll } from "./useInboxPoll.ts";

const inbox = (id: string): MessageSummary => ({
  id,
  threadId: `thread-${id}`,
  from: "Sender",
  to: "recipient@example.com",
  subject: id,
  snippet: id,
  date: "2026-01-01T00:00:00.000Z",
  unread: true,
  labelIds: ["INBOX"],
  hasAttachments: false,
});

const options = (overrides = {}) => ({
  activeLabel: "INBOX",
  query: "",
  composeOpen: false,
  onLogout: vi.fn(),
  onRefreshLabels: vi.fn(),
  onPrependInboxMessages: vi.fn(),
  onActivate: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  messages.mockReset().mockResolvedValue({ messages: [inbox("one")] });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => vi.useRealTimers());

describe("useInboxPoll", () => {
  it("does one immediate poll and one 60-second interval without recreation on option changes", async () => {
    const initial = options();
    const { rerender } = renderHook((props) => useInboxPoll(props), { initialProps: initial });
    await act(async () => {});
    expect(messages).toHaveBeenCalledTimes(1);

    rerender({ ...initial, activeLabel: "STARRED", query: "changed" });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it("gates hidden documents and clears its interval on unmount", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const { unmount } = renderHook((props) => useInboxPoll(props), { initialProps: options() });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(messages).not.toHaveBeenCalled();

    unmount();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(messages).not.toHaveBeenCalled();
  });

  it("defers auth-expiry logout while compose is open, then logs out on a later tick", async () => {
    messages.mockRejectedValue(new AuthError());
    const handlers = options({ composeOpen: true });
    const { rerender } = renderHook((props) => useInboxPoll(props), { initialProps: handlers });
    await act(async () => {});
    expect(handlers.onLogout).not.toHaveBeenCalled();

    rerender({ ...handlers, composeOpen: false });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(handlers.onLogout).toHaveBeenCalledTimes(1);
  });
});
