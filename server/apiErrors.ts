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
