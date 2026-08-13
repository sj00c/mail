// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Calendar } from "../api.ts";

const { calendars } = vi.hoisted(() => ({ calendars: vi.fn() }));
vi.mock("../api.ts", () => ({
  api: { calendars },
  AuthError: class AuthError extends Error {},
}));
vi.mock("../lib/calendarPresentation.ts", async () => {
  const actual = await vi.importActual<typeof import("../lib/calendarPresentation.ts")>("../lib/calendarPresentation.ts");
  return actual;
});

import { useCalendarCatalog } from "./useCalendarCatalog.ts";

const calendar = (id: string, primary = false, selected = true): Calendar => ({
  id,
  summary: id,
  primary,
  selected,
  backgroundColor: "#123456",
  accessRole: "owner",
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  calendars.mockReset();
  localStorage.clear();
  history.replaceState({}, "", "/");
});

describe("useCalendarCatalog", () => {
  it("serves mail-to-event-first and concurrent callers from one primary-first request", async () => {
    const request = deferred<Calendar[]>();
    calendars.mockReturnValue(request.promise);
    const { result } = renderHook(() =>
      useCalendarCatalog({ initialHiddenIds: [], onAuthError: vi.fn() }),
    );
    let first!: Promise<Calendar[]>;
    let second!: Promise<Calendar[]>;
    act(() => {
      first = result.current.ensure();
      second = result.current.ensure();
    });
    expect(calendars).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve([calendar("other"), calendar("primary", true)]));
    await expect(first).resolves.toHaveLength(2);
    await expect(second).resolves.toHaveLength(2);
    expect(result.current.calendars.map((item) => item.id)).toEqual(["primary", "other"]);
  });

  it("retries after failure and initializes only explicitly URL-hidden calendars once", async () => {
    calendars
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([calendar("primary", true), calendar("not-selected", false, false), calendar("url")]);
    const { result } = renderHook(() =>
      useCalendarCatalog({ initialHiddenIds: ["url"], onAuthError: vi.fn() }),
    );
    await act(async () => expect(result.current.ensure()).rejects.toThrow("offline"));
    expect(result.current.error).toBe("offline");
    await act(async () => result.current.ensure());
    expect(result.current.hiddenCals).toEqual(new Set(["url"]));
    act(() => result.current.toggleCal("primary"));
    await act(async () => result.current.ensure());
    expect(calendars).toHaveBeenCalledTimes(2);
    expect(result.current.hiddenCals.has("primary")).toBe(true);
  });
  it("keeps a selected-false unique primary visible unless the browser explicitly hides it", async () => {
    calendars.mockResolvedValueOnce([calendar("other"), calendar("primary", true, false)]);
    const visible = renderHook(() =>
      useCalendarCatalog({ initialHiddenIds: [], onAuthError: vi.fn() }),
    );
    await act(async () => visible.result.current.ensure());
    expect(visible.result.current.hiddenCals.has("primary")).toBe(false);
    visible.unmount();

    calendars.mockResolvedValueOnce([calendar("primary", true, false)]);
    const hidden = renderHook(() =>
      useCalendarCatalog({ initialHiddenIds: ["primary"], onAuthError: vi.fn() }),
    );
    await act(async () => hidden.result.current.ensure());
    expect(hidden.result.current.hiddenCals.has("primary")).toBe(true);
  });
  it("persists explicit visibility choices across hook remounts", async () => {
    calendars.mockResolvedValue([calendar("primary", true), calendar("other")]);
    const first = renderHook(() =>
      useCalendarCatalog({ initialHiddenIds: [], onAuthError: vi.fn() }),
    );
    await act(async () => first.result.current.ensure());
    act(() => first.result.current.toggleCal("primary"));
    expect(localStorage.getItem("mail.calendar.hidden.v1")).toBe('["primary"]');
    first.unmount();

    const second = renderHook(() =>
      useCalendarCatalog({ initialHiddenIds: [], onAuthError: vi.fn() }),
    );
    await act(async () => second.result.current.ensure());
    expect(second.result.current.hiddenCals.has("primary")).toBe(true);
    act(() => second.result.current.toggleCal("primary"));
    expect(localStorage.getItem("mail.calendar.hidden.v1")).toBe("[]");
  });

  it("suppresses primary presentation for zero or multiple primary records", async () => {
    calendars.mockResolvedValueOnce([calendar("first"), calendar("second")]);
    const zero = renderHook(() =>
      useCalendarCatalog({ initialHiddenIds: [], onAuthError: vi.fn() }),
    );
    await act(async () => zero.result.current.ensure());
    expect(zero.result.current.calendars.map((item) => item.id)).toEqual(["first", "second"]);
    expect(zero.result.current.calendars.some((item) => item.primary)).toBe(false);
    expect(zero.result.current.primaryAnomaly).toBe("missing");
    zero.unmount();

    calendars.mockResolvedValueOnce([
      calendar("first-primary", true),
      calendar("normal"),
      calendar("second-primary", true),
    ]);
    const multiple = renderHook(() =>
      useCalendarCatalog({ initialHiddenIds: [], onAuthError: vi.fn() }),
    );
    await act(async () => multiple.result.current.ensure());
    expect(multiple.result.current.calendars.map((item) => item.id)).toEqual([
      "first-primary",
      "normal",
      "second-primary",
    ]);
    expect(multiple.result.current.calendars.some((item) => item.primary)).toBe(false);
    expect(multiple.result.current.primaryColorOverride).toBeNull();
    expect(multiple.result.current.primaryAnomaly).toBe("multiple");
    act(() => multiple.result.current.setPrimaryColor("first-primary", "#445566"));
    expect(multiple.result.current.primaryColorOverride).toBeNull();
  });

  it("keeps local color overrides scoped when the unique primary ID changes", async () => {
    localStorage.setItem("mail.primary-calendar-color.v1.primary-a", "#112233");
    localStorage.setItem("mail.primary-calendar-color.v1.primary-b", "#334455");
    calendars.mockResolvedValueOnce([calendar("primary-a", true)]);
    const first = renderHook(() =>
      useCalendarCatalog({ initialHiddenIds: [], onAuthError: vi.fn() }),
    );
    await act(async () => first.result.current.ensure());
    expect(first.result.current.primaryColorOverride).toBe("#112233");
    first.unmount();

    calendars.mockResolvedValueOnce([calendar("primary-b", true)]);
    const second = renderHook(() =>
      useCalendarCatalog({ initialHiddenIds: [], onAuthError: vi.fn() }),
    );
    await act(async () => second.result.current.ensure());
    expect(second.result.current.primaryColorOverride).toBe("#334455");

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    act(() => second.result.current.setPrimaryColor("primary-b", "#445566"));
    expect(second.result.current.primaryColorOverride).toBe("#445566");
    setItem.mockRestore();
  });
});
