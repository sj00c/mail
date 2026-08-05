// 날짜·시각·크기 포매터, 아바타 색, 검색어 하이라이트 등 순수 표시 유틸.
// Intl 포매터는 생성 비용이 커서 모듈 레벨에서 한 번 만들어 공유한다.
import type { ReactNode } from "react";
import type { CalEvent } from "../api.ts";

// ---- 통합 검색 결과 (일정 카드 | 메일 카드, 양옆 배치) ----

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bare words from the query — Gmail operators (from:, has:…) don't highlight. */
export function searchTerms(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.trim().replace(/^"+|"+$/g, ""))
    .filter((t) => t.length > 0 && !t.includes(":") && t !== "OR" && t !== "AND");
}

export function highlightText(text: string, terms: string[]): ReactNode {
  if (!text || terms.length === 0) return text;
  const re = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(re);
  if (parts.length === 1) return text;
  // With a single capture group, odd indices are the matches.
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p));
}

// Deterministic sender avatar color (Google 팔레트 계열, 외부 에셋 없음).
export const AVATAR_COLORS = [
  "#7986cb",
  "#33b679",
  "#8e24aa",
  "#e67c73",
  "#f4b400",
  "#039be5",
  "#3f51b5",
  "#0b8043",
  "#616161",
  "#d81b60",
];

// 발신자→색은 결정적이고 같은 주소가 목록에 반복 등장하므로 해시를 캐시한다.
export const avatarColorCache = new Map<string, string>();

export function avatarColor(key: string): string {
  const cached = avatarColorCache.get(key);
  if (cached) return cached;
  let h = 0;
  for (const ch of key) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length];
  avatarColorCache.set(key, color);
  return color;
}

// Intl 포매터는 생성 비용이 크다 — toLocale*는 호출마다 새로 만든다. 목록의
// 모든 행이 listDateLabel을 부르므로 포매터를 한 번 만들어 재사용한다.
// 시각은 앱 전체가 24시간제 — ko-KR 기본값이 "오후 3:00"이라 h23을 명시한다.
export const HM_FMT = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export const DATETIME_FMT = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export const QUOTE_FMT = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export const MONTHDAY_FMT = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" });

export function listDateLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? HM_FMT.format(date)
    : MONTHDAY_FMT.format(date);
}

export function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + " KB";
  return n + " B";
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function localDayKey(iso: string): string {
  return dateKey(new Date(iso));
}

// Time label for an event on a given day: a multi-day timed event shows its
// start time only on its first day — repeating "09:00" on every spanned day
// reads as a daily 9 AM meeting.
export function evTimeLabel(e: CalEvent, dayKey: string): string {
  if (e.allDay) return "종일";
  return localDayKey(e.start) === dayKey ? formatTime(e.start) : "계속";
}

// 월 칸은 폭이 좁다 — "09:00"의 앞자리 0을 떼서 제목에 한 글자라도 더 준다.
export function compactTime(label: string): string {
  return /^0\d:/.test(label) ? label.slice(1) : label;
}

// Every local day key an event spans. All-day ends are exclusive (Google);
// timed events ending exactly at midnight don't occupy that day.
// Runaway guard only — was 62, which made events longer than two months
// vanish from every month past start+62d (안식년 휴가 등).
export const MAX_SPAN_DAYS = 400;

export function occupiedDayKeys(e: CalEvent): string[] {
  const keys: string[] = [];
  if (e.allDay) {
    const endEx = e.end || e.start;
    for (
      let d = new Date(`${e.start.slice(0, 10)}T00:00:00`), i = 0;
      dateKey(d) < endEx.slice(0, 10) && i < MAX_SPAN_DAYS;
      d.setDate(d.getDate() + 1), i++
    ) {
      keys.push(dateKey(d));
    }
    if (keys.length === 0) keys.push(e.start.slice(0, 10));
    return keys;
  }
  const startKey = localDayKey(e.start);
  const endMs = e.end ? new Date(e.end).getTime() : NaN;
  const lastKey = Number.isFinite(endMs)
    ? dateKey(new Date(endMs - 1)) // minus 1ms: midnight end excludes that day
    : startKey;
  const d = new Date(`${startKey}T00:00:00`);
  for (let i = 0; i < MAX_SPAN_DAYS; i++) {
    const k = dateKey(d);
    keys.push(k);
    if (k >= lastKey) break;
    d.setDate(d.getDate() + 1);
  }
  return keys;
}

export function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setDate(x.getDate() - x.getDay());
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + (6 - x.getDay()));
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function formatTime(iso: string): string {
  return HM_FMT.format(new Date(iso));
}

export function formatDayHeader(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const isToday = date.toDateString() === today.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const base = date.toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
  if (isToday) return `오늘 · ${base}`;
  if (isTomorrow) return `내일 · ${base}`;
  return base;
}

export function formatEventWhen(e: CalEvent): string {
  if (e.allDay) {
    const s = new Date(`${e.start.slice(0, 10)}T00:00:00`);
    const startLabel = s.toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    });
    // Google all-day ends are exclusive — last occupied day is end-1.
    const lastDay = e.end ? addDays(e.end.slice(0, 10), -1) : e.start.slice(0, 10);
    if (lastDay > e.start.slice(0, 10)) {
      const en = new Date(`${lastDay}T00:00:00`);
      const endLabel = en.toLocaleDateString("ko-KR", {
        month: "long",
        day: "numeric",
        weekday: "short",
      });
      return `${startLabel} – ${endLabel} · 종일`;
    }
    return `${startLabel} · 종일`;
  }
  const s = new Date(e.start);
  const date = s.toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
  const st = HM_FMT.format(s);
  if (!e.end) return `${date} ${st}`;
  const en = new Date(e.end);
  const et = HM_FMT.format(en);
  if (s.toDateString() === en.toDateString()) return `${date} ${st} – ${et}`;
  const ed = en.toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
  return `${date} ${st} – ${ed} ${et}`;
}

export function addDays(ymdStr: string, n: number): string {
  const d = new Date(`${ymdStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

// 로컬 시각을 24시간제 "HH:MM"으로.
export function hm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 날짜/시각 문자열 → 로컬 Date. 빈 값(입력 중)이면 Invalid Date — 호출부가 검사한다.
export function atLocal(day: string, time: string): Date {
  return new Date(`${day}T${time || "00:00"}:00`);
}

// YYYY-MM-DD 사이의 일수. 로컬 자정 기준이라 DST가 껴도 ±1시간은 반올림이 흡수한다.
export function dayDiff(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) /
      86_400_000,
  );
}

export function durationLabel(mins: number): string {
  if (mins <= 0) return "";
  const parts: string[] = [];
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) parts.push(`${d}일`);
  if (h) parts.push(`${h}시간`);
  if (m) parts.push(`${m}분`);
  return parts.join(" ");
}

export const WEEKDAY_FMT = new Intl.DateTimeFormat("ko-KR", { weekday: "short" });

export function weekdayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return isNaN(+d) ? "" : WEEKDAY_FMT.format(d);
}
