// 라이트/다크 테마. 선호(system|light|dark)는 localStorage에, 실제 적용 결과는
// <html data-theme="light|dark">에 둔다 — CSS는 data-theme만 보면 된다.
// index.html의 인라인 스크립트가 첫 페인트 전에 같은 규칙으로 먼저 한 번
// 적용해 두므로 새로고침 때 밝은 화면이 번쩍이지 않는다.
export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_KEY = "mail.theme";

export const THEME_OPTIONS: ReadonlyArray<{ value: ThemePref; label: string }> = [
  { value: "system", label: "시스템 설정 따르기" },
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
];

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: ThemePref, systemDark = systemPrefersDark()): Theme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

export type ThemeState = { pref: ThemePref; theme: Theme };

// useSyncExternalStore용 스냅샷 — 값이 같으면 같은 객체를 돌려줘야 재렌더가
// 무한 반복되지 않는다.
let cached: ThemeState | null = null;
export function getThemeState(): ThemeState {
  const pref = getThemePref();
  const theme = resolveTheme(pref);
  if (!cached || cached.pref !== pref || cached.theme !== theme) cached = { pref, theme };
  return cached;
}

export function applyTheme(): Theme {
  const { theme } = getThemeState();
  document.documentElement.dataset.theme = theme;
  return theme;
}

const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // private mode 등: 이 세션에서만 적용된다
  }
  applyTheme();
  notify();
}

// OS 테마 전환과 다른 탭에서의 변경도 따라간다.
export function subscribeTheme(onChange: () => void): () => void {
  listeners.add(onChange);
  const onExternal = () => {
    applyTheme();
    onChange();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === THEME_KEY) onExternal();
  };
  let mql: MediaQueryList | null = null;
  try {
    mql = window.matchMedia(DARK_QUERY);
    mql.addEventListener("change", onExternal);
  } catch {
    mql = null;
  }
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    mql?.removeEventListener("change", onExternal);
    window.removeEventListener("storage", onStorage);
  };
}
