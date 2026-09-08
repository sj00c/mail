import { expect, type Page } from "@playwright/test";
import {
  installAppMocks,
  installNetworkBoundary,
  openMailbox,
  TEST_ORIGIN,
  test,
} from "./fixtures/app.ts";

function productionChunks(page: Page) {
  const urls: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/\/assets\/[^/]+\.js(?:\?|$)/.test(url)) urls.push(url);
  });
  return urls;
}

function requestCount(urls: string[], url: string) {
  return urls.filter((candidate) => candidate === url).length;
}

async function newlyLoadedChunks(
  chunks: string[],
  action: () => Promise<void>,
) {
  const before = chunks.length;
  await action();
  await expect.poll(() => chunks.length > before).toBeTruthy();
  return [...new Set(chunks.slice(before))];
}

async function openCalendar(page: Page) {
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(page.locator(".calendar")).toBeVisible();
}

test("production mail boot excludes lazy feature chunks until their first use", async ({
  page,
}) => {
  const chunks = productionChunks(page);
  await installAppMocks(page);
  await openMailbox(page);
  const initialChunks = new Set(chunks);

  const calendarChunks = await newlyLoadedChunks(chunks, () =>
    openCalendar(page),
  );
  await page.getByRole("button", { name: "메일", exact: true }).click();
  const driveChunks = await newlyLoadedChunks(chunks, async () => {
    await page.getByRole("button", { name: "드라이브", exact: true }).click();
    await expect(page.locator(".drive")).toBeVisible();
  });
  await page.getByPlaceholder("Search").fill("invoice");
  const searchChunks = await newlyLoadedChunks(chunks, async () => {
    await page.getByPlaceholder("Search").press("Enter");
    await expect(page.locator(".search-page")).toBeVisible();
  });

  for (const featureChunks of [calendarChunks, driveChunks, searchChunks]) {
    expect(featureChunks).not.toHaveLength(0);
    for (const url of featureChunks) expect(initialChunks).not.toContain(url);
  }
});

test("production calendar chunk loads once and stays cached when returning to mail", async ({
  page,
}) => {
  const chunks = productionChunks(page);
  await installAppMocks(page);
  await openMailbox(page);
  const calendarChunks = await newlyLoadedChunks(chunks, () =>
    openCalendar(page),
  );

  const calendarRequestCounts = new Map(
    calendarChunks.map((url) => [url, requestCount(chunks, url)]),
  );

  await page.getByRole("button", { name: "메일", exact: true }).click();
  await openCalendar(page);
  for (const [url, count] of calendarRequestCounts)
    expect(requestCount(chunks, url)).toBe(count);
});

test("blocking the discovered production calendar chunk preserves the shell and recovery UI", async ({
  browser,
}, testInfo) => {
  const probeContext = await browser.newContext({
    baseURL: TEST_ORIGIN,
    serviceWorkers: "block",
  });
  const probeBoundary = await installNetworkBoundary(probeContext);
  let calendarChunks: string[] = [];
  try {
    const probe = await probeContext.newPage();
    const probeChunks = productionChunks(probe);
    await installAppMocks(probe);
    await openMailbox(probe);
    calendarChunks = await newlyLoadedChunks(probeChunks, () =>
      openCalendar(probe),
    );
  } finally {
    await probeBoundary.finalize(testInfo);
  }

  const context = await browser.newContext({
    baseURL: TEST_ORIGIN,
    serviceWorkers: "block",
  });
  const boundary = await installNetworkBoundary(context);
  try {
    const page = await context.newPage();
    await installAppMocks(page);
    for (const url of calendarChunks) {
      const parsed = new URL(url);
      if (
        parsed.origin !== TEST_ORIGIN ||
        !parsed.pathname.startsWith("/assets/")
      ) {
        throw new Error(
          "Discovered calendar chunk escaped the local assets origin",
        );
      }
      await page.route(url, (route) => route.abort());
    }
    await openMailbox(page);
    await page.getByRole("button", { name: "캘린더", exact: true }).click();

    await expect(page.locator("#app-sidebar")).toBeVisible();
    await expect(page.locator("header")).toBeVisible();
    await expect(page.getByText("화면을 불러오지 못했습니다.")).toBeVisible();
    await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
  } finally {
    await boundary.finalize(testInfo);
  }
});
