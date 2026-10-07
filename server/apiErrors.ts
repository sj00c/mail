export function httpStatusOf(err: unknown): number | undefined {
  const error = err as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown; data?: { error?: string } };
  };
  for (const value of [error?.status, error?.code, error?.response?.status]) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

export function needAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === "NOT_AUTHENTICATED") return true;

  const data = (err as { response?: { data?: { error?: string } } }).response?.data;
  if (err.message.includes("invalid_grant") || data?.error === "invalid_grant") return true;

  const status = httpStatusOf(err);
  if (status === 401) return true;
  if (status === 403) {
    return (
      /insufficient/i.test(err.message) ||
      /unregistered callers/i.test(err.message) ||
      /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(err.message)
    );
  }
  return false;
}

export function apiErrorStatus(err: unknown): 401 | 500 {
  return needAuthError(err) ? 401 : 500;
}

/**
 * The Google Cloud project has not enabled this API. Optional features
 * (contacts) turn themselves off instead of failing every request.
 */
export function isApiDisabled(err: unknown): boolean {
  if (httpStatusOf(err) !== 403) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(message);
}

export function publicApiError(err: unknown): string {
  if (needAuthError(err)) return "NOT_AUTHENTICATED";
  if (err instanceof Error && /^GMAIL_BATCH_(?:PART_\d{3}_[A-Z_]+|MALFORMED_RESPONSE)$/.test(err.message))
    return err.message;
  return "INTERNAL_SERVER_ERROR";
}

/**
 * Log a failed API request. Upstream HTTP failures (Google quota, disabled
 * APIs, expired grants) recur on every poll and their error objects carry
 * the whole request and response, so they get one line each; anything else
 * is a local bug and keeps its stack.
 */
export function logApiError(scope: string, method: string, path: string, err: unknown): void {
  const status = httpStatusOf(err);
  if (status === undefined) {
    console.error(`[${scope}] ${method} ${path}`, err);
    return;
  }
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 300);
  console.error(`[${scope}] ${method} ${path} ${status}: ${message}`);
}
