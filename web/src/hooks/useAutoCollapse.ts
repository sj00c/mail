import { useCallback, useState } from "react";
import { useMediaQuery } from "./useMediaQuery.ts";

type Choice = { autoCollapsed: boolean; open: boolean };

function readChoice(storageKey: string): Choice | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Choice).autoCollapsed === "boolean" &&
      typeof (parsed as Choice).open === "boolean"
    ) {
      return parsed as Choice;
    }
  } catch {
    // 손상된 값·private mode: 자동 값으로 시작
  }
  return null;
}

// 접었다 펴는 패널. 기본값은 화면 폭을 따른다 — 창을 줄이거나 브라우저 줌인으로
// CSS 폭이 collapseQuery에 걸리면 접히고, 벗어나면 다시 펴진다. 사용자가 직접
// 누른 값은 그때의 자동 상태(접힘/펼침 구간)에서만 유효해서, 줌이 구간 경계를
// 넘으면 다시 자동 값이 이긴다. 선택은 localStorage에 남아 새로고침 뒤에도 같다.
export function useAutoCollapse(collapseQuery: string, storageKey: string) {
  const autoCollapsed = useMediaQuery(collapseQuery);
  const [choice, setChoice] = useState(() => readChoice(storageKey));
  const open = choice?.autoCollapsed === autoCollapsed ? choice.open : !autoCollapsed;
  const toggle = useCallback(() => {
    const next = { autoCollapsed, open: !open };
    setChoice(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // private mode: 이번 세션에만 적용
    }
  }, [autoCollapsed, open, storageKey]);
  return [open, toggle] as const;
}
