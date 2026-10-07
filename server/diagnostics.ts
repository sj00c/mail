import { calendar as calendarApi } from "@googleapis/calendar";
import { drive as driveApi } from "@googleapis/drive";
import { gmail as gmailApi } from "@googleapis/gmail";
import { people as peopleApi } from "@googleapis/people";
import { httpStatusOf, isApiDisabled, needAuthError } from "./apiErrors.ts";
import { getAuthedClient } from "./auth.ts";

export type ApiCheck =
  | { ok: true }
  | { ok: false; reason: "disabled" | "client" | "auth" | "error"; status?: number; message: string };

export type GoogleApiChecks = Record<"gmail" | "calendar" | "drive" | "contacts", ApiCheck>;

const PROBE_TIMEOUT_MS = 10_000;

/**
 * One cheap read per Google API, run independently so one failing API (for
 * example People API not enabled) never hides the state of the others.
 * Used by `sj-mail doctor` and setup to explain what each account can use.
 */
export async function checkGoogleApis(): Promise<GoogleApiChecks> {
  const auth = await getAuthedClient();
  const options = { timeout: PROBE_TIMEOUT_MS };
  const probe = async (call: () => Promise<unknown>): Promise<ApiCheck> => {
    try {
      await call();
      return { ok: true };
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 300);
      // invalid_client: Google rejected the Client ID/Secret pair in .env;
      // signing in again cannot help, unlike an expired grant.
      const reason = isApiDisabled(err)
        ? "disabled"
        : /invalid_client|unauthorized_client/i.test(message)
          ? "client"
          : needAuthError(err)
            ? "auth"
            : "error";
      return { ok: false, reason, status: httpStatusOf(err), message };
    }
  };
  const [gmail, calendar, drive, contacts] = await Promise.all([
    probe(() => gmailApi({ version: "v1", auth }).users.getProfile({ userId: "me" }, options)),
    probe(() => calendarApi({ version: "v3", auth }).calendarList.list({ maxResults: 1 }, options)),
    probe(() => driveApi({ version: "v3", auth }).about.get({ fields: "user" }, options)),
    probe(() =>
      peopleApi({ version: "v1", auth }).people.connections.list(
        { resourceName: "people/me", personFields: "names", pageSize: 1 },
        options,
      ),
    ),
  ]);
  return { gmail, calendar, drive, contacts };
}
