import { expect, type Page } from "@playwright/test";

export const primaryCalendar = {
  id: "primary",
  summary: "개인 캘린더",
  primary: true,
  backgroundColor: "#d93025",
  selected: true,
  accessRole: "owner",
};

export const secondaryCalendar = {
  id: "team",
  summary: "팀 일정",
  primary: false,
  backgroundColor: "#1a73e8",
  selected: true,
  accessRole: "reader",
};

export async function installAppMocks(
  page: Page,
  options: {
    labels?: { id: string; name: string; type: string; unread: number }[];
    messages?: unknown[];
  } = {},
) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  await page.route("**/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push({ method: route.request().method(), path });
    if (path === "/auth/status") return route.fulfill({ json: { authed: true } });
    if (path === "/auth/logout") return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 404, json: { error: "unexpected auth request" } });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === "GET" ? undefined : request.postDataJSON();
    calls.push({ method: request.method(), path: url.pathname, body });
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname === "/api/profile") return json({ email: "test@example.com" });
    if (url.pathname === "/api/labels") {
      return json(
        options.labels ?? [
          { id: "INBOX", name: "받은편지함", type: "system", unread: 0 },
          { id: "STARRED", name: "별표편지함", type: "system", unread: 0 },
        ],
      );
    }
    if (url.pathname === "/api/settings/account") return json({ sendAs: [], vacation: { enabled: false, subject: "", endTime: null } });
    if (url.pathname === "/api/signature") return json({ html: "" });
    if (url.pathname === "/api/messages") return json({ messages: options.messages ?? [], resultSizeEstimate: (options.messages ?? []).length });
    if (url.pathname.startsWith("/api/threads/")) {
      // 스레드 응답은 threadId로 거른다 — 전부 돌려주면 j/k 이동 스펙이
      // 잘못된 본문을 렌더해도 통과해 버린다.
      const threadId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      return json(
        (options.messages ?? []).filter(
          (m) => (m as { threadId?: string }).threadId === threadId,
        ),
      );
    }
    if (url.pathname.endsWith("/modify")) return json({ ok: true });
    if (url.pathname.endsWith("/trash")) return json({ ok: true });
    if (url.pathname === "/api/calendar/calendars") return json([primaryCalendar, secondaryCalendar]);
    if (url.pathname === "/api/calendar/events") return json([]);
    if (url.pathname === "/api/contacts") return json([]);
    if (url.pathname.startsWith("/api/drive")) return json(url.pathname === "/api/drive/files" ? { files: [], breadcrumbs: [] } : {});
    return route.fulfill({ status: 404, json: { error: `unexpected mocked API request: ${url.pathname}` } });
  });
  return calls;
}

export async function openMailbox(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "메일", exact: true })).toBeVisible();
  await expect(page.getByText("받은편지함")).toBeVisible();
}

export function calendarMutationCalls(calls: { method: string; path: string }[]) {
  return calls.filter(({ method, path }) => method !== "GET" && path.startsWith("/api/calendar"));
}
