// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCollapse } from "./useAutoCollapse.ts";

const QUERY = "(max-width: 900px)";
const KEY = "test.panel.open";
let matches = false;
const listeners = new Set<() => void>();
const setNarrow = (value: boolean) => {
  matches = value;
  for (const listener of listeners) listener();
};
const original = Object.getOwnPropertyDescriptor(window, "matchMedia");

beforeEach(() => {
  matches = false;
  listeners.clear();
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }),
  });
});
afterEach(() => {
  if (original) Object.defineProperty(window, "matchMedia", original);
  else Reflect.deleteProperty(window, "matchMedia");
});

it("follows zoom by default and lets a manual toggle hold only until zoom crosses the breakpoint", () => {
  const { result } = renderHook(() => useAutoCollapse(QUERY, KEY));
  expect(result.current[0]).toBe(true);

  act(() => setNarrow(true)); // zoom in
  expect(result.current[0]).toBe(false);

  act(() => result.current[1]()); // user opens it while zoomed in
  expect(result.current[0]).toBe(true);

  act(() => setNarrow(false)); // zoom out: still open (auto value)
  act(() => result.current[1]()); // user closes it at normal zoom
  expect(result.current[0]).toBe(false);

  act(() => setNarrow(true)); // zoom in: the wide-zoom choice no longer applies
  expect(result.current[0]).toBe(false);
  act(() => setNarrow(false)); // back to normal zoom: the choice made there returns
  expect(result.current[0]).toBe(false);
});

it("restores the last choice after a reload and ignores unreadable stored values", () => {
  const first = renderHook(() => useAutoCollapse(QUERY, KEY));
  act(() => first.result.current[1]());
  first.unmount();
  expect(renderHook(() => useAutoCollapse(QUERY, KEY)).result.current[0]).toBe(false);

  localStorage.setItem(KEY, "0");
  expect(renderHook(() => useAutoCollapse(QUERY, KEY)).result.current[0]).toBe(true);
});
