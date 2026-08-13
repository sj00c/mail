import { useCallback, useRef, useState } from "react";
import { api, AuthError, type Calendar } from "../api.ts";
import {
  readPrimaryColorOverride,
  sortCalendarsPrimaryFirst,
  writePrimaryColorOverride,
} from "../lib/calendarPresentation.ts";

export type PrimaryMetadataAnomaly = "missing" | "multiple" | null;

export function primaryMetadataAnomaly(
  calendars: readonly Calendar[],
): PrimaryMetadataAnomaly {
  const count = calendars.filter((calendar) => calendar.primary).length;
  return count === 0 ? "missing" : count > 1 ? "multiple" : null;
}

function normalizePrimary(calendars: readonly Calendar[]) {
  const primaries = calendars.filter((calendar) => calendar.primary);
  if (primaries.length !== 1) {
    return calendars.map((calendar) => (calendar.primary ? { ...calendar, primary: false } : calendar));
  }
  return sortCalendarsPrimaryFirst(calendars);
}
function uniquePrimary(calendars: readonly Calendar[]) {
  const primaries = calendars.filter((calendar) => calendar.primary);
  return primaries.length === 1 ? primaries[0] : null;
}

export const HIDDEN_CALENDARS_KEY = "mail.calendar.hidden.v1";

function readHiddenCalendars(initialHiddenIds: readonly string[]) {
  const hidden = new Set(initialHiddenIds);
  try {
    const stored = JSON.parse(localStorage.getItem(HIDDEN_CALENDARS_KEY) ?? "[]");
    if (Array.isArray(stored)) {
      for (const id of stored) {
        if (typeof id === "string" && id) hidden.add(id);
      }
    }
  } catch {
    // Browser storage is optional; the in-memory visibility state still works.
  }
  return hidden;
}

function writeHiddenCalendars(hidden: ReadonlySet<string>) {
  try {
    localStorage.setItem(HIDDEN_CALENDARS_KEY, JSON.stringify([...hidden].sort()));
  } catch {
    // Browser storage is optional; the in-memory visibility state still works.
  }
}

type Options = { initialHiddenIds: readonly string[]; onAuthError: () => void };

export function useCalendarCatalog({ initialHiddenIds, onAuthError }: Options) {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [hiddenCals, setHiddenCals] = useState<Set<string>>(() =>
    readHiddenCalendars(initialHiddenIds),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [primaryColorOverride, setPrimaryColorOverride] = useState<string | null>(null);
  const [primaryAnomaly, setPrimaryAnomaly] = useState<PrimaryMetadataAnomaly>(null);
  const initialized = useRef(false);
  const inFlight = useRef<Promise<Calendar[]> | null>(null);
  const initialHidden = useRef([...readHiddenCalendars(initialHiddenIds)]);
  const authError = useRef(onAuthError);
  authError.current = onAuthError;

  const ensure = useCallback(() => {
    if (calendars.length) return Promise.resolve(calendars);
    if (inFlight.current) return inFlight.current;
    setLoading(true);
    setError(null);
    const request = api
      .calendars()
      .then((received) => {
        setPrimaryAnomaly(primaryMetadataAnomaly(received));
        const sorted = normalizePrimary(received);
        setCalendars(sorted);
        if (!initialized.current) {
          initialized.current = true;
          setHiddenCals(new Set(initialHidden.current));
        }
        const primary = uniquePrimary(sorted);
        setPrimaryColorOverride(primary ? readPrimaryColorOverride(primary.id) : null);
        return sorted;
      })
      .catch((caught: unknown) => {
        if (caught instanceof AuthError) authError.current();
        else setError((caught as Error).message);
        throw caught;
      })
      .finally(() => {
        setLoading(false);
        inFlight.current = null;
      });
    inFlight.current = request;
    return request;
  }, [calendars]);

  const toggleCal = useCallback((id: string) => {
    setHiddenCals((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeHiddenCalendars(next);
      return next;
    });
  }, []);
  const setPrimaryColor = useCallback((primaryId: string, color: string | null) => {
    if (uniquePrimary(calendars)?.id !== primaryId) return;
    writePrimaryColorOverride(primaryId, color);
    setPrimaryColorOverride(color);
  }, [calendars]);

  return {
    calendars,
    hiddenCals,
    loading,
    error,
    primaryColorOverride,
    primaryAnomaly,
    ensure,
    toggleCal,
    setPrimaryColor,
  };
}
