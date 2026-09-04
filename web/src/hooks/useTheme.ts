import { useSyncExternalStore } from "react";
import {
  getThemeState,
  setThemePref,
  subscribeTheme,
  type Theme,
  type ThemePref,
} from "../lib/theme.ts";

export function useTheme(): { pref: ThemePref; theme: Theme; setPref: (pref: ThemePref) => void } {
  const { pref, theme } = useSyncExternalStore(subscribeTheme, getThemeState);
  return { pref, theme, setPref: setThemePref };
}
