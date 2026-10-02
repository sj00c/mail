import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageFull } from "../api.ts";

const { thread, listeners } = vi.hoisted(() => ({
  thread: vi.fn(),
  listeners: [] as ((m: unknown) => void)[],
}));
vi.mock("../api.ts", () => ({
  api: { thread },
  onMailMutation: (l: (m: unknown) => void) => listeners.push(l),
}));

import {
  dropCachedThreads,
  dropThreadsContaining,
  loadThread,
  patchCachedMessage,
  peekThread,
  prefetchThread,
} from "./threadCache.ts";

const msg = (id: string, labelIds = ["INBOX", "UNREAD"]): MessageFull =>
  ({ id, threadId: "t", labelIds, unread: labelIds.includes("UNREAD") }) as MessageFull;

beforeEach(() => {
  thread.mockReset();
  dropCachedThreads();
});
afterEach(() => vi.useRealTimers());

describe("threadCache", () => {
  it("reuses one request for prefetch and open while fresh, then refetches", async () => {
    vi.useFakeTimers();
    thread.mockResolvedValue([msg("a")]);
    prefetchThread("t");
    const first = await loadThread("t");
    expect(thread).toHaveBeenCalledTimes(1);
    expect(peekThread("t")).toBe(first);

    vi.advanceTimersByTime(61_000);
    await loadThread("t");
    expect(thread).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    thread.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([msg("a")]);
    await expect(loadThread("t")).rejects.toThrow("offline");
    expect(peekThread("t")).toBeUndefined();
    await expect(loadThread("t")).resolves.toHaveLength(1);
    expect(thread).toHaveBeenCalledTimes(2);
  });

  it("mirrors confirmed label changes without refetching", async () => {
    thread.mockResolvedValue([msg("a"), msg("b", ["INBOX"])]);
    await loadThread("t");
    patchCachedMessage("a", { remove: ["UNREAD"], add: ["STARRED"] });
    const cached = await loadThread("t");
    expect(thread).toHaveBeenCalledTimes(1);
    expect(cached[0]).toMatchObject({ unread: false, labelIds: ["INBOX", "STARRED"] });
    expect(cached[1]).toMatchObject({ unread: false, labelIds: ["INBOX"] });
    expect(peekThread("t")).toBe(cached);
  });

  it("applies confirmed mutations published by the API layer", async () => {
    thread.mockResolvedValue([msg("a")]);
    await loadThread("t");
    listeners.forEach((l) => l({ kind: "labels", ids: ["a"], remove: ["UNREAD"] }));
    expect(peekThread("t")![0].unread).toBe(false);
    listeners.forEach((l) => l({ kind: "unknown" }));
    expect(peekThread("t")).toBeUndefined();
  });

  it("drops threads whose membership may have changed", async () => {
    thread.mockResolvedValue([msg("a")]);
    await loadThread("t");
    await loadThread("u");
    dropThreadsContaining(["a"]);
    expect(peekThread("t")).toBeUndefined();
    expect(peekThread("u")).toBeUndefined();
    await loadThread("t");
    expect(thread).toHaveBeenCalledTimes(3);
  });
});
