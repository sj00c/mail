// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  getThemePref,
  getThemeState,
  resolveTheme,
  setThemePref,
  subscribeTheme,
  THEME_KEY,
} from "./theme.ts";

type MediaListener = (e: MediaQueryListEvent) => void;

function installMatchMedia(dark: boolean) {
  const listeners = new Set<MediaListener>();
  const mql = {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: "change", l: MediaListener) => listeners.add(l),
    removeEventListener: (_: "change", l: MediaListener) => listeners.delete(l),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => mql),
  });
  return {
    flip(next: boolean) {
      mql.matches = next;
      for (const l of listeners) l({ matches: next } as MediaQueryListEvent);
    },
    listeners,
  };
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  localStorage.clear();
});

describe("resolveTheme", () => {
  it("follows the OS only when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("getThemePref", () => {
  it("treats unknown stored values as system", () => {
    localStorage.setItem(THEME_KEY, "sepia");
    expect(getThemePref()).toBe("system");
    localStorage.setItem(THEME_KEY, "dark");
    expect(getThemePref()).toBe("dark");
  });
});

describe("setThemePref / applyTheme", () => {
  it("persists an explicit choice and stamps <html data-theme>", () => {
    installMatchMedia(false);
    setThemePref("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(getThemeState()).toEqual({ pref: "dark", theme: "dark" });
  });

  it("clears storage for system and resolves against the OS", () => {
    installMatchMedia(true);
    localStorage.setItem(THEME_KEY, "light");
    setThemePref("system");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("applyTheme resolves the stored preference without touching storage", () => {
    installMatchMedia(false);
    localStorage.setItem(THEME_KEY, "dark");
    expect(applyTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("returns a stable snapshot object while nothing changed", () => {
    installMatchMedia(false);
    const a = getThemeState();
    expect(getThemeState()).toBe(a);
    setThemePref("dark");
    expect(getThemeState()).not.toBe(a);
  });
});

describe("subscribeTheme", () => {
  it("re-applies and notifies on OS changes while on system, and unsubscribes cleanly", () => {
    const media = installMatchMedia(false);
    const onChange = vi.fn();
    const off = subscribeTheme(onChange);
    expect(applyTheme()).toBe("light");

    media.flip(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.theme).toBe("dark");

    off();
    expect(media.listeners.size).toBe(0);
    media.flip(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores OS changes when an explicit theme is set", () => {
    const media = installMatchMedia(false);
    setThemePref("light");
    const onChange = vi.fn();
    const off = subscribeTheme(onChange);
    media.flip(true);
    expect(document.documentElement.dataset.theme).toBe("light");
    off();
  });

  it("follows the key changed from another tab", () => {
    installMatchMedia(false);
    const onChange = vi.fn();
    const off = subscribeTheme(onChange);
    localStorage.setItem(THEME_KEY, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "dark" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.theme).toBe("dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "mail.signature" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    off();
  });

  it("notifies subscribers when setThemePref is called", () => {
    installMatchMedia(false);
    const onChange = vi.fn();
    const off = subscribeTheme(onChange);
    setThemePref("dark");
    expect(onChange).toHaveBeenCalledTimes(1);
    off();
    setThemePref("light");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
