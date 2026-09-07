// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { messages, profile } = vi.hoisted(() => ({ messages: vi.fn(), profile: vi.fn() }));
vi.mock("../api.ts", () => ({
  api: { messages, profile },
  AuthError: class AuthError extends Error {},
  parseAddr: (value: string) => ({ name: value }),
}));

import { AuthError, type MailProfile, type MessageSummary } from "../api.ts";

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

const mailboxProfile = (overrides: Partial<MailProfile> = {}): MailProfile => ({
  email: "owner@example.com",
  historyId: "history-1",
  messagesTotal: 1,
  ...overrides,
});

const options = (overrides = {}) => ({
  activeLabel: "INBOX",
  query: "",
  composeOpen: false,
  onLogout: vi.fn(),
  getCurrentMessages: () => [],
  onRefreshLabels: vi.fn(),
  onProfile: vi.fn(),
  onPrependInboxMessages: vi.fn(),
  onActivate: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  profile.mockReset().mockResolvedValue(mailboxProfile());
  messages.mockReset().mockResolvedValue({ messages: [inbox("one")] });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => vi.useRealTimers());

describe("useInboxPoll", () => {
  it("calls profile on every tick and skips unchanged inbox synchronization", async () => {
    const initial = options();
    const { rerender } = renderHook((props) => useInboxPoll(props), { initialProps: initial });
    await act(async () => {});
    expect(profile).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();

    rerender({ ...initial, activeLabel: "STARRED", query: "changed" });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(profile).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(profile).toHaveBeenCalledTimes(2);
    expect(messages).toHaveBeenCalledTimes(1);
  });

  it("refreshes labels and publishes the profile when the version changes without a new top id", async () => {
    const handlers = options({ getCurrentMessages: () => [inbox("one")] });
    profile
      .mockResolvedValueOnce(mailboxProfile({ historyId: "history-1" }))
      .mockResolvedValueOnce(mailboxProfile({ historyId: "history-2", messagesTotal: 2 }));
    renderHook((props) => useInboxPoll(props), { initialProps: handlers });

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(messages).toHaveBeenCalledTimes(2);
    expect(handlers.onRefreshLabels).toHaveBeenCalledTimes(1);
    expect(handlers.onProfile).toHaveBeenLastCalledWith(mailboxProfile({
      historyId: "history-2",
      messagesTotal: 2,
    }));
    expect(handlers.onPrependInboxMessages).not.toHaveBeenCalled();
  });

  it("retries profile and list failures on the next tick without committing a failed version", async () => {
    profile
      .mockRejectedValueOnce(new Error("profile offline"))
      .mockResolvedValue(mailboxProfile({ historyId: "history-3" }));
    messages
      .mockRejectedValueOnce(new Error("list offline"))
      .mockResolvedValue({ messages: [inbox("one")] });
    const handlers = options();
    renderHook((props) => useInboxPoll(props), { initialProps: handlers });

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(messages).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(messages).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(messages).toHaveBeenCalledTimes(2);
    expect(handlers.onProfile).toHaveBeenCalledTimes(1);
  });

  it("never treats a blank history id as an unchanged mailbox", async () => {
    profile.mockResolvedValue(mailboxProfile({ historyId: "" }));
    renderHook((props) => useInboxPoll(props), { initialProps: options() });

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(profile).toHaveBeenCalledTimes(2);
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it("resets the notification baseline when the account changes", async () => {
    const oldMessage = inbox("old");
    const newMessage = inbox("new");
    profile
      .mockResolvedValueOnce(mailboxProfile({ email: "old@example.com", historyId: "old-1" }))
      .mockResolvedValueOnce(mailboxProfile({ email: "new@example.com", historyId: "new-1" }));
    messages
      .mockResolvedValueOnce({ messages: [oldMessage] })
      .mockResolvedValueOnce({ messages: [newMessage] });
    const handlers = options({ getCurrentMessages: () => [oldMessage] });
    renderHook((props) => useInboxPoll(props), { initialProps: handlers });

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(handlers.onPrependInboxMessages).not.toHaveBeenCalled();
  });

  it("does not poll hidden documents and clears its interval on unmount", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const { unmount } = renderHook((props) => useInboxPoll(props), { initialProps: options() });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(profile).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();

    unmount();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(profile).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
  });

  it("defers auth-expiry logout while compose is open, then logs out on a later tick", async () => {
    profile.mockRejectedValue(new AuthError());
    const handlers = options({ composeOpen: true });
    const { rerender } = renderHook((props) => useInboxPoll(props), { initialProps: handlers });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(handlers.onLogout).not.toHaveBeenCalled();

    rerender({ ...handlers, composeOpen: false });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(handlers.onLogout).toHaveBeenCalledTimes(1);
  });

  it("does not recreate the interval on option changes", async () => {
    const initial = options();
    const { rerender } = renderHook((props) => useInboxPoll(props), { initialProps: initial });
    rerender({ ...initial, activeLabel: "STARRED", query: "changed" });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(messages).toHaveBeenCalledTimes(1);
  });
});
