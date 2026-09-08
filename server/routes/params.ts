// Query params come from the URL — validate before they become RangeErrors
// deep inside Date/Google API calls (NaN days previously exploded as a 500).
export function finiteOr(
  raw: string | undefined,
  name: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === "") return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n))
    return { ok: false, error: `${name} must be a number` };
  return { ok: true, value: n };
}
