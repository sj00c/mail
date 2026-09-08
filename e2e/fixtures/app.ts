import {
  expect,
  test as base,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
  type TestInfo,
  type WebSocketRoute,
} from "@playwright/test";
import type { Label, MailProfile } from "../../web/src/api.ts";

export const TEST_ORIGIN = "http://127.0.0.1:4173";

type SafeEvidence = {
  method: string;
  origin: string;
  resourceType: string;
  reason: string;
};

type ViolationLedger = {
  externalAttempts: SafeEvidence[];
  unexpectedSockets: SafeEvidence[];
  missingMocks: SafeEvidence[];
  rejectedRedirects: SafeEvidence[];
  observedRequests: Set<Request>;
  recordedExternalRequests: Set<Request>;
  recordedMissingRequests: Set<Request>;
  recordedRedirectRequests: Set<Request>;
  blockedCount: number;
};

const ledgers = new WeakMap<BrowserContext, ViolationLedger>();

function newLedger(): ViolationLedger {
  return {
    externalAttempts: [],
    unexpectedSockets: [],
    missingMocks: [],
    rejectedRedirects: [],
    observedRequests: new Set(),
    recordedExternalRequests: new Set(),
    recordedMissingRequests: new Set(),
    recordedRedirectRequests: new Set(),
    blockedCount: 0,
  };
}

function parseRequestUrl(request: Request): URL | undefined {
  try {
    return new URL(request.url());
  } catch {
    return undefined;
  }
}

function safeOrigin(url: URL | undefined): string {
  if (!url) return "invalid";
  return url.origin === "null" ? "opaque" : url.origin;
}

function requestEvidence(
  request: Request,
  reason: string,
  origin = safeOrigin(parseRequestUrl(request)),
): SafeEvidence {
  let method = "unknown";
  let resourceType = "unknown";
  try {
    method = request.method();
  } catch {
    // Request metadata can disappear while a context is closing.
  }
  try {
    resourceType = request.resourceType();
  } catch {
    // Request metadata can disappear while a context is closing.
  }
  return { method, origin, resourceType, reason };
}

function socketEvidence(url: string, reason: string): SafeEvidence {
  let origin = "invalid";
  try {
    origin = safeOrigin(new URL(url));
  } catch {
    // Keep malformed socket URLs out of the report.
  }
  return { method: "WS", origin, resourceType: "websocket", reason };
}

function recordExternalAttempt(
  ledger: ViolationLedger,
  request: Request,
  reason: string,
  origin?: string,
) {
  if (ledger.recordedExternalRequests.has(request)) return;
  ledger.recordedExternalRequests.add(request);
  ledger.externalAttempts.push(requestEvidence(request, reason, origin));
}

function recordMissingMock(
  ledger: ViolationLedger,
  request: Request,
  reason: string,
) {
  if (ledger.recordedMissingRequests.has(request)) return;
  ledger.recordedMissingRequests.add(request);
  ledger.missingMocks.push(requestEvidence(request, reason));
}

function recordRejectedRedirect(
  ledger: ViolationLedger,
  request: Request,
  reason: string,
) {
  if (ledger.recordedRedirectRequests.has(request)) return;
  ledger.recordedRedirectRequests.add(request);
  ledger.rejectedRedirects.push(requestEvidence(request, reason));
}

async function abortBlocked(route: Route, ledger: ViolationLedger) {
  ledger.blockedCount += 1;
  await route.abort("blockedbyclient");
}

function isApiOrAuthPath(pathname: string) {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/")
  );
}

export async function installNetworkBoundary(
  context: BrowserContext,
): Promise<{ finalize(testInfo: TestInfo): Promise<void> }> {
  if (ledgers.has(context)) {
    throw new Error("Network boundary is already installed for this context");
  }
  const ledger = newLedger();
  ledgers.set(context, ledger);

  context.on("request", (request) => {
    if (ledger.observedRequests.has(request)) return;
    ledger.observedRequests.add(request);
    const url = parseRequestUrl(request);
    if (!url) return recordExternalAttempt(ledger, request, "malformed-url");
    if (url.username || url.password) {
      return recordExternalAttempt(ledger, request, "userinfo-url");
    }
    if (url.origin !== TEST_ORIGIN) {
      return recordExternalAttempt(ledger, request, "foreign-origin");
    }
  });

  await context.routeWebSocket("**/*", async (websocket: WebSocketRoute) => {
    ledger.unexpectedSockets.push(socketEvidence(websocket.url(), "websocket"));
    ledger.blockedCount += 1;
    await websocket.close({ code: 1008, reason: "blocked by test boundary" });
  });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = parseRequestUrl(request);
    if (!url) {
      recordExternalAttempt(ledger, request, "malformed-url");
      return abortBlocked(route, ledger);
    }
    if (url.username || url.password) {
      recordExternalAttempt(ledger, request, "userinfo-url");
      return abortBlocked(route, ledger);
    }
    if (url.origin !== TEST_ORIGIN) {
      recordExternalAttempt(ledger, request, "foreign-origin");
      return abortBlocked(route, ledger);
    }
    if (isApiOrAuthPath(url.pathname)) {
      recordMissingMock(ledger, request, "unmatched-api-or-auth");
      return abortBlocked(route, ledger);
    }
    if (request.method() !== "GET" && request.method() !== "HEAD") {
      recordMissingMock(ledger, request, "unmocked-static-method");
      return abortBlocked(route, ledger);
    }

    const response = await route.fetch({ maxRedirects: 0 });
    if (response.status() >= 300 && response.status() < 400) {
      recordRejectedRedirect(ledger, request, "static-redirect");
      const location = response.headers().location;
      if (location) {
        try {
          const target = new URL(location, url);
          if (
            target.username ||
            target.password ||
            target.origin !== TEST_ORIGIN
          ) {
            recordExternalAttempt(
              ledger,
              request,
              "external-redirect",
              target.origin,
            );
          }
        } catch {
          // The redirect itself is already recorded and rejected.
        }
      }
      return abortBlocked(route, ledger);
    }
    await route.fulfill({ response });
  });

  let finalized = false;
  return {
    finalize: async (testInfo: TestInfo) => {
      if (finalized) return;
      finalized = true;

      let closeError: unknown;
      try {
        await context.close();
      } catch (error) {
        closeError = error;
      }

      const report = {
        externalAttemptCount: ledger.externalAttempts.length,
        unexpectedSocketCount: ledger.unexpectedSockets.length,
        missingMockCount: ledger.missingMocks.length,
        rejectedRedirectCount: ledger.rejectedRedirects.length,
        blockedCount: ledger.blockedCount,
        externalAttempts: ledger.externalAttempts,
        unexpectedSockets: ledger.unexpectedSockets,
        missingMocks: ledger.missingMocks,
        rejectedRedirects: ledger.rejectedRedirects,
      };
      let attachError: unknown;
      try {
        await testInfo.attach("network-boundary", {
          body: JSON.stringify(report),
          contentType: "application/json",
        });
      } catch (error) {
        attachError = error;
      }

      const assertionErrors: unknown[] = [];
      for (const [name, violations] of [
        ["externalAttempts", ledger.externalAttempts],
        ["unexpectedSockets", ledger.unexpectedSockets],
        ["missingMocks", ledger.missingMocks],
        ["rejectedRedirects", ledger.rejectedRedirects],
      ] as const) {
        try {
          expect(violations, `${name} must remain empty`).toEqual([]);
        } catch (error) {
          assertionErrors.push(error);
        }
      }
      if (closeError) assertionErrors.unshift(closeError);
      if (attachError) assertionErrors.push(attachError);
      if (assertionErrors.length) throw assertionErrors[0];
    },
  };
}

type NetworkBoundaryFixtures = {
  networkBoundary: void;
};

export const test = base.extend<NetworkBoundaryFixtures>({
  networkBoundary: [
    async ({ context }, use, testInfo) => {
      const boundary = await installNetworkBoundary(context);
      try {
        await use();
      } finally {
        await boundary.finalize(testInfo);
      }
    },
    { auto: true },
  ],
});

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
    labels?: Label[];
    profile?: MailProfile;
    messages?: unknown[];
  } = {},
) {
  const ledger = ledgers.get(page.context());
  if (!ledger) throw new Error("Install the network boundary before app mocks");
  const calls: { method: string; path: string; body?: unknown }[] = [];
  await page.route(`${TEST_ORIGIN}/auth/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push({ method: route.request().method(), path });
    if (path === "/auth/status")
      return route.fulfill({ json: { authed: true } });
    if (path === "/auth/logout") return route.fulfill({ json: { ok: true } });
    recordMissingMock(ledger, route.request(), "unexpected-auth-request");
    return route.fulfill({
      status: 404,
      json: { error: "unexpected auth request" },
    });
  });
  await page.route(`${TEST_ORIGIN}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body =
      request.method() === "GET" ? undefined : request.postDataJSON();
    calls.push({ method: request.method(), path: url.pathname, body });
    const json = (body: unknown) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (url.pathname === "/api/profile")
      return json(
        options.profile ?? {
          email: "test@example.com",
          historyId: "1",
          messagesTotal: (options.messages ?? []).length,
        },
      );
    if (url.pathname === "/api/labels") {
      return json(
        options.labels ?? [
          {
            id: "INBOX",
            name: "받은편지함",
            type: "system",
            unread: 0,
            total: 0,
          },
          {
            id: "STARRED",
            name: "별표편지함",
            type: "system",
            unread: 0,
            total: 0,
          },
        ],
      );
    }
    if (url.pathname === "/api/settings/account")
      return json({
        sendAs: [],
        vacation: { enabled: false, subject: "", endTime: null },
      });
    if (url.pathname === "/api/signature") return json({ html: "" });
    if (url.pathname === "/api/messages")
      return json({
        messages: options.messages ?? [],
        resultSizeEstimate: (options.messages ?? []).length,
      });
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
    if (url.pathname === "/api/calendar/calendars")
      return json([primaryCalendar, secondaryCalendar]);
    if (url.pathname === "/api/calendar/events") return json([]);
    if (url.pathname === "/api/calendar/search") return json([]);
    if (url.pathname === "/api/contacts") return json([]);
    if (url.pathname.startsWith("/api/drive"))
      return json(
        url.pathname === "/api/drive/files"
          ? { files: [], breadcrumbs: [] }
          : {},
      );
    recordMissingMock(ledger, request, "unexpected-api-request");
    return route.fulfill({
      status: 404,
      json: { error: `unexpected mocked API request: ${url.pathname}` },
    });
  });
  return calls;
}

export async function openMailbox(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "메일", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("받은편지함")).toBeVisible();
}

export function calendarMutationCalls(
  calls: { method: string; path: string }[],
) {
  return calls.filter(
    ({ method, path }) => method !== "GET" && path.startsWith("/api/calendar"),
  );
}
