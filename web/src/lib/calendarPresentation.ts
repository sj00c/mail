export const PRIMARY_CALENDAR_DEFAULT_COLOR = "#d93025";

type CalendarPresentation = {
  id: string;
  primary: boolean;
  backgroundColor: string | null;
};

const PRIMARY_COLOR_KEY_PREFIX = "mail.primary-calendar-color.v1.";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function isDisplayColor(color: unknown): color is string {
  return typeof color === "string" && HEX_COLOR.test(color);
}

function primaryColorKey(primaryId: string) {
  return `${PRIMARY_COLOR_KEY_PREFIX}${encodeURIComponent(primaryId)}`;
}

export function getCalendarDisplayColor(
  calendar: CalendarPresentation,
  override?: string | null,
) {
  if (calendar.primary) {
    return isDisplayColor(override) ? override : PRIMARY_CALENDAR_DEFAULT_COLOR;
  }
  return isDisplayColor(calendar.backgroundColor) ? calendar.backgroundColor : "#1a73e8";
}

export function sortCalendarsPrimaryFirst<T extends { primary: boolean }>(calendars: readonly T[]) {
  return [...calendars.filter((calendar) => calendar.primary), ...calendars.filter((calendar) => !calendar.primary)];
}

export function readPrimaryColorOverride(primaryId: string) {
  if (!primaryId || typeof window === "undefined") return null;
  try {
    const color = window.localStorage.getItem(primaryColorKey(primaryId));
    return isDisplayColor(color) ? color : null;
  } catch {
    return null;
  }
}

export function writePrimaryColorOverride(primaryId: string, color: string | null) {
  if (!primaryId || typeof window === "undefined") return false;
  if (color !== null && !isDisplayColor(color)) return false;
  try {
    const key = primaryColorKey(primaryId);
    if (color === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, color);
    return true;
  } catch {
    return false;
  }
}
