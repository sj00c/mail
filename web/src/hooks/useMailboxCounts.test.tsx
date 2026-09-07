import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Label } from "../api.ts";
import { useMailboxCounts } from "./useMailboxCounts.ts";

vi.mock("../api.ts", () => ({ api: { labels: vi.fn(), profile: vi.fn() } }));
const labels = (total: number): Label[] => [{ id: "INBOX", name: "Inbox", type: "system", unread: 2, total }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.profile).mockResolvedValue({ email: "test@example.com", historyId: "1", messagesTotal: 100 });
});

describe("useMailboxCounts", () => {
  it("coalesces a mutation burst and discards the pre-mutation response", async () => {
    const first = deferred<Label[]>();
    const second = deferred<Label[]>();
    vi.mocked(api.labels).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useMailboxCounts());
    let request!: Promise<void>;
    act(() => {
      request = result.current.refresh(false);
      expect(result.current.refresh(false)).toBe(request);
      expect(result.current.refresh(false)).toBe(request);
    });
    expect(api.labels).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(labels(10)); await first.promise; });
    expect(result.current.labels).toEqual([]);
    expect(api.labels).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(labels(12)); await request; });
    expect(result.current.labels).toEqual(labels(12));
    expect(api.profile).not.toHaveBeenCalled();
  });

  it("refreshes account total after local mutations without scanning message IDs", async () => {
    vi.mocked(api.labels).mockResolvedValue(labels(8));
    const { result } = renderHook(() => useMailboxCounts());
    await act(async () => { await result.current.refresh(); });
    expect(result.current.messagesTotal).toBe(100);
    expect(api.profile).toHaveBeenCalledTimes(1);
    act(() => { result.current.applyProfile({ email: "test@example.com", historyId: "2", messagesTotal: 101 }); });
    expect(result.current.messagesTotal).toBe(101);
  });

  it("keeps the last successful counts and allows retry after failure", async () => {
    vi.mocked(api.labels).mockResolvedValueOnce(labels(8)).mockRejectedValueOnce(new Error("quota")).mockResolvedValueOnce(labels(9));
    const { result } = renderHook(() => useMailboxCounts());
    await act(async () => { await result.current.refresh(false); });
    await act(async () => { await expect(result.current.refresh(false)).rejects.toThrow("quota"); });
    expect(result.current.labels).toEqual(labels(8));
    await act(async () => { await result.current.refresh(false); });
    expect(result.current.labels).toEqual(labels(9));
  });

  it("does not let an in-flight count refresh overwrite a newer poll profile", async () => {
    const previous = deferred<Label[]>();
    vi.mocked(api.labels).mockReturnValueOnce(previous.promise).mockResolvedValueOnce(labels(9));
    vi.mocked(api.profile)
      .mockResolvedValueOnce({ email: "test@example.com", historyId: "1", messagesTotal: 100 })
      .mockResolvedValueOnce({ email: "test@example.com", historyId: "2", messagesTotal: 101 });
    const { result } = renderHook(() => useMailboxCounts());
    let pending!: Promise<void>;
    act(() => { pending = result.current.refresh(); });
    act(() => { result.current.applyProfile({ email: "test@example.com", historyId: "2", messagesTotal: 101 }); });
    await act(async () => { previous.resolve(labels(8)); await pending; });
    expect(result.current.messagesTotal).toBe(101);
    expect(result.current.labels).toEqual(labels(9));
  });

  it("does not publish an old account response into a new mount", async () => {
    const previous = deferred<Label[]>();
    vi.mocked(api.labels).mockReturnValueOnce(previous.promise).mockResolvedValueOnce(labels(3));
    const old = renderHook(() => useMailboxCounts());
    let pending!: Promise<void>;
    act(() => { pending = old.result.current.refresh(false); });
    old.unmount();
    const current = renderHook(() => useMailboxCounts());
    await act(async () => { await current.result.current.refresh(false); });
    await act(async () => { previous.resolve(labels(999)); await pending; });
    expect(current.result.current.labels).toEqual(labels(3));
  });
});
