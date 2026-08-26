import { useSyncExternalStore } from "react";

// 레이아웃 분기용 미디어 쿼리 구독. useSyncExternalStore를 쓰면 첫 렌더부터
// 실제 값을 읽으므로, 좁은 창에서 3분할로 한 번 깜빡였다 접히는 일이 없다.
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false, // SSR/프리렌더 없음 — 넓은 화면 기준으로 시작
  );
}
