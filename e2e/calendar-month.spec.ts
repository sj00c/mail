import { expect } from "@playwright/test";
import type { CalEventDetail } from "../web/src/api.ts";
import {
  calendarMutationCalls,
  installAppMocks,
  openMailbox,
  primaryCalendar,
  TEST_ORIGIN,
  test,
} from "./fixtures/app.ts";

const primaryEvent = {
  id: "primary-event",
  summary: "기본 캘린더 일정",
  start: "2026-04-10T09:00:00",
  end: "2026-04-10T10:00:00",
  allDay: false,
  location: "",
  htmlLink: "",
  calendarId: primaryCalendar.id,
  calendarSummary: primaryCalendar.summary,
  color: null,
};

const primaryEventDetail = {
  ...primaryEvent,
  description: "상세 설명",
  attendees: [],
  organizer: "owner@example.com",
  reminderDefault: true,
  reminderMinutes: null,
  hangoutLink: "",
} satisfies CalEventDetail;

function shiftDateKey(key: string, days: number) {
  const [year, month, day] = key.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

async function openCalendar(page: Parameters<typeof installAppMocks>[0]) {
  await openMailbox(page);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  await expect(region).toBeVisible();
  await expect(region.locator(".month-cell")).toHaveCount(91);
}

test("month recycler exposes a fixed continuous week window", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-01T12:00:00") });
  await installAppMocks(page);
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: [] }));
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  await expect(region.locator(".month-week")).toHaveCount(13);
  await expect(region.locator(".month-cell")).toHaveCount(91);
  await expect(region).toHaveAttribute("aria-busy", /true|false/);
  await region.focus();
  await expect(region).toBeFocused();
  const initialScrollTop = await region.evaluate((element) => element.scrollTop);
  await region.press("PageDown");
  await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialScrollTop);
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const dates = await region.locator(".month-cell").evaluateAll((cells) =>
    cells.map((cell) => cell.getAttribute("data-date")));
  expect(new Set(dates).size).toBe(91);
  const ordinals = dates.map((key) => {
    const [year, month, day] = key!.split("-").map(Number);
    return Date.UTC(year, month - 1, day) / 86_400_000;
  });
  expect(ordinals.every((value, index) => index === 0 || value === ordinals[index - 1] + 1)).toBeTruthy();

  const calendar = page.locator(".month-continuous");
  const initialWindow = await calendar.getAttribute("data-window-start");
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(calendar).not.toHaveAttribute("data-window-start", initialWindow!);
  await expect(region.locator(".month-week")).toHaveCount(13);
  await expect(region.locator(".month-cell")).toHaveCount(91);
});

test("upward recycler preserves an exact retained row and offset", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-01T12:00:00") });
  await installAppMocks(page);
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: [] }));
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  const calendar = page.locator(".month-continuous");
  await region.dispatchEvent("wheel", { deltaY: 1000 });
  const initialWindow = (await calendar.getAttribute("data-window-start"))!;
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(calendar).toHaveAttribute("data-window-start", shiftDateKey(initialWindow, 21));

  const retained = region.locator(".month-week").nth(9);
  const retainedKey = (await retained.getAttribute("data-week-start"))!;
  const retainedHandle = await retained.elementHandle();
  const oldTop = await retained.evaluate((row) => {
    const region = row.closest(".month-virtual-scroll")!;
    (region as HTMLElement).scrollTop = 0;
    region.dispatchEvent(new Event("scroll"));
    return row.getBoundingClientRect().top - region.getBoundingClientRect().top;
  });
  await expect(calendar).toHaveAttribute("data-window-start", initialWindow);
  const retainedAfter = region.locator(`.month-week[data-week-start="${retainedKey}"]`);
  await expect(retainedAfter).toHaveCount(1);
  expect(await retainedAfter.evaluate((element, prior) => element === prior, retainedHandle)).toBeTruthy();
  const newTop = await retainedAfter.evaluate((row) => {
    const region = row.closest(".month-virtual-scroll")!;
    return row.getBoundingClientRect().top - region.getBoundingClientRect().top;
  });
  expect(Math.abs(newTop - oldTop)).toBeLessThanOrEqual(1);
});

test("continuous creation exposes one tab stop", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-01T12:00:00") });
  await installAppMocks(page);
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: [] }));
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  await expect(region.locator(".month-create-hitarea[tabindex='0']")).toHaveCount(1);
  await expect(region.locator(".month-create-hitarea[tabindex='-1']")).toHaveCount(90);
});

test("new overlapping range is authoritative when an event disappears", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  let requests = 0;
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => {
    requests += 1;
    return route.fulfill({ json: requests === 1 ? [primaryEvent] : [] });
  });
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  const calendar = page.locator(".month-continuous");
  const initialWindow = (await calendar.getAttribute("data-window-start"))!;
  await expect(page.locator('.month-cell[data-date="2026-04-10"] .month-ev')).toHaveCount(1);
  await region.dispatchEvent("wheel", { deltaY: 1000 });
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(calendar).toHaveAttribute("data-window-start", shiftDateKey(initialWindow, 21));
  await expect(calendar).toHaveAttribute("data-request-state", "idle");
  await expect(page.locator('.month-cell[data-date="2026-04-10"] .month-ev')).toHaveCount(0);
});

test("burst scroll events schedule only one recycler shift", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: [] }));
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  const calendar = page.locator(".month-continuous");
  const initialWindow = (await calendar.getAttribute("data-window-start"))!;
  await region.dispatchEvent("wheel", { deltaY: 1000 });
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    for (let index = 0; index < 20; index += 1) element.dispatchEvent(new Event("scroll"));
  });
  await expect(calendar).toHaveAttribute("data-window-start", shiftDateKey(initialWindow, 21));
  await expect(region.locator(".month-week")).toHaveCount(13);
  await expect(region.locator(".month-cell")).toHaveCount(91);
});

test("read-only empty calendar remains keyboard-scrollable", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await page.route(`${TEST_ORIGIN}/api/calendar/calendars`, (route) =>
    route.fulfill({
      json: [{ ...primaryCalendar, primary: false, accessRole: "reader" }],
    }));
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: [] }));
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  await expect(region.locator(".month-create-hitarea")).toHaveCount(0);
  await region.focus();
  const before = await region.evaluate((element) => element.scrollTop);
  await region.press("PageDown");
  await expect.poll(() => region.evaluate((element) => element.scrollTop)).not.toBe(before);
  await expect(region).toBeFocused();
});

test("failed uncovered range retries in place", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  let attempts = 0;
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({ status: 503, json: { error: "temporary calendar failure" } });
    }
    await retryGate;
    return route.fulfill({ json: [primaryEvent] });
  });
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  await expect(region).toHaveAttribute("aria-busy", "false");
  await expect(region.locator('.month-cell[data-date="2026-04-10"]')).toHaveAttribute(
    "data-coverage",
    "unavailable",
  );
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(region).toHaveAttribute("aria-busy", "true");
  releaseRetry();
  await expect(page.getByText(primaryEvent.summary)).toBeVisible();
  await expect(region.locator('.month-cell[data-date="2026-04-10"]')).toHaveAttribute(
    "data-coverage",
    "covered",
  );
});

test("late aborted range cannot overwrite the current request", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  let requests = 0;
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const currentEvent = { ...primaryEvent, id: "current-range", summary: "현재 범위 일정" };
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, async (route) => {
    requests += 1;
    if (requests === 1) {
      await oldGate;
      try {
        return await route.fulfill({ status: 401, json: { error: "stale authentication failure" } });
      } catch {
        return;
      }
    }
    return route.fulfill({ json: [currentEvent] });
  });
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  const calendar = page.locator(".month-continuous");
  const initialWindow = (await calendar.getAttribute("data-window-start"))!;
  await region.dispatchEvent("wheel", { deltaY: 1000 });
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(calendar).toHaveAttribute("data-window-start", shiftDateKey(initialWindow, 21));
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByText(currentEvent.summary)).toBeVisible();
  const currentGeneration = await calendar.getAttribute("data-request-generation");
  const currentCacheSize = await calendar.getAttribute("data-cache-size");
  releaseOld();
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText(currentEvent.summary)).toBeVisible();
  await expect(calendar).toHaveAttribute("data-request-generation", currentGeneration!);
  await expect(calendar).toHaveAttribute("data-cache-size", currentCacheSize!);
  await expect(calendar).toHaveAttribute("data-request-state", "idle");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByText("test@example.com")).toBeVisible();
});

test("responsive week pitch preserves the visible anchor", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: [] }));
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  await region.dispatchEvent("wheel", { deltaY: 120 });
  await region.evaluate((element) => {
    element.scrollTop += 160;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const anchor = await region.evaluate((element) => {
    const regionRect = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>(".month-week")]
      .find((candidate) => candidate.getBoundingClientRect().top >= regionRect.top)!;
    return {
      key: row.dataset.weekStart!,
      top: row.getBoundingClientRect().top - regionRect.top,
      pitch: row.getBoundingClientRect().height,
    };
  });
  const generationBefore = Number(
    await page.locator(".month-continuous").getAttribute("data-adjustment-generation"),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => region.evaluate((element, key) => {
    const row = element.querySelector<HTMLElement>(`.month-week[data-week-start="${key}"]`);
    return row?.getBoundingClientRect().height ?? 0;
  }, anchor.key)).not.toBe(anchor.pitch);
  await expect.poll(() => region.evaluate((element, expected) => {
    const row = element.querySelector<HTMLElement>(`.month-week[data-week-start="${expected.key}"]`)!;
    return Math.abs(
      row.getBoundingClientRect().top - element.getBoundingClientRect().top - expected.top,
    );
  }, anchor)).toBeLessThanOrEqual(1);
  await expect(page.locator(".month-continuous")).toHaveAttribute(
    "data-adjustment-generation",
    String(generationBefore + 1),
  );
});

test("event capacity republishes after a same-capacity width change", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await openCalendar(page);
  const calendar = page.locator(".month-continuous");
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  await expect(calendar).toHaveAttribute("data-event-capacity-measured", "true");
  const initial = await region.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
    capacity: Number(element.closest(".month-continuous")!.getAttribute("data-event-row-capacity")),
  }));

  await page.evaluate(({ width, height }) => {
    const region = document.querySelector<HTMLElement>(".month-virtual-scroll")!;
    region.style.flex = "none";
    region.style.width = `${width - 2}px`;
    region.style.height = `${height}px`;
    document.querySelector<HTMLButtonElement>('button[aria-label="다음 달"]')!.click();
  }, initial);
  await expect.poll(() => region.evaluate((element) => element.clientWidth))
    .not.toBe(initial.width);
  await expect(calendar).toHaveAttribute("data-event-capacity-measured", "true");
  await expect(calendar).toHaveAttribute("data-event-row-capacity", String(initial.capacity));
});

test("calendar requests stay 19 weeks and cache stays bounded", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  const ranges: Array<{ from: string; to: string }> = [];
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => {
    const url = new URL(route.request().url());
    ranges.push({ from: url.searchParams.get("from")!, to: url.searchParams.get("to")! });
    return route.fulfill({ json: [] });
  });
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  const calendar = page.locator(".month-continuous");
  await region.dispatchEvent("wheel", { deltaY: 1000 });
  let expectedWindow = (await calendar.getAttribute("data-window-start"))!;
  for (let index = 0; index < 30; index += 1) {
    expectedWindow = shiftDateKey(expectedWindow, 21);
    await region.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(calendar).toHaveAttribute("data-window-start", expectedWindow);
    await expect(calendar).toHaveAttribute("data-request-state", "idle");
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  const requestsBeforePromotion = ranges.length;
  expectedWindow = shiftDateKey(expectedWindow, -21);
  await region.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(calendar).toHaveAttribute("data-window-start", expectedWindow);
  await expect(calendar).toHaveAttribute("data-request-state", "idle");
  expect(ranges.length).toBe(requestsBeforePromotion);
  const promotedRange = (await calendar.getAttribute("data-loaded-range"))!;
  await expect.poll(async () =>
    (await calendar.getAttribute("data-cache-order"))?.endsWith(promotedRange) ?? false).toBeTruthy();
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  for (let index = 1; index < 30; index += 1) {
    expectedWindow = shiftDateKey(expectedWindow, -21);
    await region.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(calendar).toHaveAttribute("data-window-start", expectedWindow);
    await expect(calendar).toHaveAttribute("data-request-state", "idle");
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  expect(ranges.length).toBeGreaterThanOrEqual(31);
  for (const range of ranges) {
    const days = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(133, 0);
  }
  const initialRange = ranges[0];
  expect(ranges.filter((range) =>
    range.from === initialRange.from && range.to === initialRange.to).length).toBeGreaterThanOrEqual(2);
  expect(Number(await calendar.getAttribute("data-cache-size"))).toBeLessThanOrEqual(8);
  const currentRange = (await calendar.getAttribute("data-loaded-range"))!;
  await expect.poll(async () =>
    (await calendar.getAttribute("data-cache-order"))?.endsWith(currentRange) ?? false).toBeTruthy();
  await expect(region.locator(".month-cell")).toHaveCount(91);
});

test("modal interaction locks the recycler window", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  const events = Array.from({ length: 8 }, (_, index) => ({
    ...primaryEvent,
    id: `locked-${index}`,
    summary: `잠금 일정 ${index + 1}`,
  }));
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: events }));
  await page.route(`${TEST_ORIGIN}/api/calendar/event?*`, (route) => {
    expect(new URL(route.request().url()).searchParams.get("eventId")).toBe(events[0]!.id);
    return route.fulfill({ json: { ...primaryEventDetail, ...events[0] } });
  });
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  const calendar = page.locator(".month-continuous");
  const assertLocked = async () => {
    const windowStart = await calendar.getAttribute("data-window-start");
    const scrollTop = await region.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, 2_000);
    await expect(calendar).toHaveAttribute("data-window-start", windowStart!);
    expect(await region.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  };
  const trigger = page.locator('.month-cell[data-date="2026-04-10"] .month-ev').first();
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "일정" })).toBeVisible();
  await assertLocked();
  await page.getByRole("dialog", { name: "일정" }).getByRole("button", { name: "닫기" }).click();
  await expect(trigger).toBeFocused();

  const more = page.locator('.month-cell[data-date="2026-04-10"] .month-more');
  await more.click();
  const dayDialog = page.getByRole("dialog", { name: /일정$/ });
  await expect(dayDialog).toBeVisible();
  await assertLocked();
  await dayDialog.getByRole("button", { name: "닫기" }).click();
  await expect(more).toBeFocused();

  await page.getByRole("button", { name: "새 일정" }).click();
  const editor = page.getByRole("dialog", { name: "새 일정" });
  await expect(editor).toBeVisible();
  await assertLocked();
  await editor.getByRole("button", { name: "취소" }).click();
});

test("recycler parks removed focus and preserves retained focus identity", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  let removedDate = "";
  let retainedDate = "";
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => {
    const from = new URL(route.request().url()).searchParams.get("from")!;
    const fetchStart = from.slice(0, 10);
    removedDate ||= shiftDateKey(fetchStart, 22);
    retainedDate ||= shiftDateKey(fetchStart, 85);
    return route.fulfill({
      json: [
        { ...primaryEvent, id: "removed-focus", summary: "제거될 포커스", start: `${removedDate}T09:00:00`, end: `${removedDate}T10:00:00` },
        { ...primaryEvent, id: "retained-focus", summary: "유지될 포커스", start: `${retainedDate}T09:00:00`, end: `${retainedDate}T10:00:00` },
      ],
    });
  });
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  const calendar = page.locator(".month-continuous");
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  let expectedWindow = (await calendar.getAttribute("data-window-start"))!;
  const removed = page.locator(`.month-cell[data-date="${removedDate}"] .month-ev`);
  await removed.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
  await expect(removed).toBeFocused();
  await region.dispatchEvent("wheel", { deltaY: 1000 });
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expectedWindow = shiftDateKey(expectedWindow, 21);
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(calendar).toHaveAttribute("data-window-start", expectedWindow);
  await expect(region).toBeFocused();

  const retained = page.locator(`.month-cell[data-date="${retainedDate}"] .month-ev`);
  await retained.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
  await expect(retained).toBeFocused();
  const retainedHandle = await retained.elementHandle();
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expectedWindow = shiftDateKey(expectedWindow, 21);
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(calendar).toHaveAttribute("data-window-start", expectedWindow);
  await expect(retained).toBeFocused();
  expect(await retained.evaluate((element, prior) => element === prior, retainedHandle)).toBeTruthy();
});

test.describe("DST-observing calendar context", () => {
  test.use({ timezoneId: "America/New_York" });

  for (const [name, date] of [
    ["spring", "2026-03-08T12:00:00"],
    ["fall", "2026-11-01T12:00:00"],
  ] as const) {
    test(`date keys remain consecutive across ${name} DST`, async ({ page }) => {
      await page.clock.install({ time: new Date(date) });
      await installAppMocks(page);
      await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: [] }));
      await openCalendar(page);
      const keys = await page.locator(".month-cell").evaluateAll((cells) =>
        cells.map((cell) => cell.getAttribute("data-date")!));
      const ordinals = keys.map((key) => {
        const [year, month, day] = key.split("-").map(Number);
        return Date.UTC(year, month - 1, day) / 86_400_000;
      });
      expect(ordinals.every((value, index) =>
        index === 0 || value === ordinals[index - 1] + 1)).toBeTruthy();
      const region = page.getByRole("region", { name: "연속 월간 캘린더" });
      const calendar = page.locator(".month-continuous");
      const initialWindow = (await calendar.getAttribute("data-window-start"))!;
      await region.dispatchEvent("wheel", { deltaY: 1000 });
      await region.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect(calendar).toHaveAttribute("data-window-start", shiftDateKey(initialWindow, 21));
      const recycledKeys = await page.locator(".month-cell").evaluateAll((cells) =>
        cells.map((cell) => cell.getAttribute("data-date")!));
      const recycledOrdinals = recycledKeys.map((key) => {
        const [year, month, day] = key.split("-").map(Number);
        return Date.UTC(year, month - 1, day) / 86_400_000;
      });
      expect(recycledOrdinals.every((value, index) =>
        index === 0 || value === recycledOrdinals[index - 1] + 1)).toBeTruthy();
    });
  }
});

test("primary calendar is first/default, remains hideable, and local color controls do not mutate the API", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-01T12:00:00") });
  const calls = await installAppMocks(page);
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: [primaryEvent] }));
  await page.route(`${TEST_ORIGIN}/api/calendar/calendars`, (route) =>
    route.fulfill({
      json: [
        primaryCalendar,
        {
          id: "writer",
          summary: "공유 캘린더",
          primary: false,
          color: "#1a73e8",
          selected: true,
          accessRole: "writer",
        },
      ],
    }),
  );
  await openCalendar(page);
  const primaryCheckbox = page.locator(`#calendar-${primaryCalendar.id}`);

  await expect(primaryCheckbox).toBeChecked();
  await primaryCheckbox.uncheck();
  await expect(page.getByText(primaryEvent.summary)).toHaveCount(0);
  await expect(page.locator(".month-ev")).toHaveCount(0);
  await openCalendar(page);
  await expect(primaryCheckbox).not.toBeChecked();
  await expect(page.getByText(primaryEvent.summary)).toHaveCount(0);
  await primaryCheckbox.check();
  await expect(page.getByText(primaryEvent.summary)).toBeVisible();

  const picker = page.locator('input[type="color"][aria-label="기본 캘린더 색상"]');
  await expect(picker).toHaveValue("#d93025");
  await picker.fill("#00897b");
  await expect(picker).toHaveValue("#00897b");
  await page.getByRole("button", { name: /색상.*초기화/ }).click();
  await expect(picker).toHaveValue("#d93025");
  for (const control of [
    page.locator(".cal-check").first(),
    picker.locator(".."),
    page.getByRole("button", { name: /색상.*초기화/ }),
  ]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  await page.getByRole("button", { name: /새 일정/ }).click();
  const calendarSelect = page.getByRole("combobox", { name: "캘린더", exact: true });
  await expect(calendarSelect).toHaveValue(primaryCalendar.id);
  await expect(calendarSelect.locator("option").first()).toHaveAttribute("value", primaryCalendar.id);
  expect(calendarMutationCalls(calls)).toEqual([]);
});
test("day numbers create events while event chips open details", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) =>
    route.fulfill({ json: [primaryEvent] }),
  );
  await page.route(`${TEST_ORIGIN}/api/calendar/event?*`, (route) => {
    expect(new URL(route.request().url()).searchParams.get("eventId")).toBe(primaryEvent.id);
    return route.fulfill({ json: primaryEventDetail });
  });
  await openCalendar(page);

  const emptyDay = page.locator('.month-cell[data-date="2026-04-06"]');
  await emptyDay.locator(".month-create-hitarea").click();

  const editor = page.getByRole("dialog", { name: "새 일정" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("시작 날짜")).toHaveValue("2026-04-06");
  await editor.getByRole("button", { name: "취소" }).click();
  await expect(editor).toHaveCount(0);

  const eventDay = page.locator('.month-cell[data-date="2026-04-10"]');
  await eventDay.locator(".month-ev").click();
  await expect(page.getByRole("dialog", { name: "일정" })).toBeVisible();
});

for (const [name, date] of [
  ["february", "2026-02-12T12:00:00"],
  ["april", "2026-04-12T12:00:00"],
  ["may", "2026-05-12T12:00:00"],
] as const) {
  test(`${name} keeps the bounded continuous window`, async ({ page }) => {
    await page.clock.install({ time: new Date(date) });
    await installAppMocks(page);
    await openCalendar(page);
    const grid = page.getByRole("region", { name: "연속 월간 캘린더" });
    await expect(grid.locator(".month-week")).toHaveCount(13);
    await expect(grid.locator(".month-cell")).toHaveCount(91);
    await expect(grid).toHaveCSS("overflow-y", /auto|scroll/);
    const cellSizes = await grid.locator(".month-cell").evaluateAll((elements) =>
      elements.map((element) => {
        const { width, height } = element.getBoundingClientRect();
        return { width, height };
      }),
    );
    const widths = cellSizes.map(({ width }) => width);
    const heights = cellSizes.map(({ height }) => height);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  });
}

for (const [name, date] of [
  ["four", "2026-02-10"],
  ["five", "2026-04-10"],
  ["six", "2026-05-10"],
] as const) {
  test(`${name}-week months use dynamic cells and expose overflow in a day list`, async ({ page }) => {
    await page.clock.install({ time: new Date(`${date}T12:00:00`) });
    await installAppMocks(page);
    const events = Array.from({ length: 10 }, (_, index) => ({
      ...primaryEvent,
      id: `event-${index}`,
      summary: `일정 ${index + 1}`,
      start: `${date}T09:00:00`,
      end: `${date}T10:00:00`,
    }));
    await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: events }));
    await openCalendar(page);

    const day = page.locator(`.month-cell[data-date="${date}"]`);
    await expect(day).toHaveCount(1);
    const calendar = page.locator(".month-continuous");
    await expect(calendar).toHaveAttribute("data-event-capacity-measured", "true");
    const capacity = Number(await calendar.getAttribute("data-event-row-capacity"));
    expect(capacity).toBeGreaterThanOrEqual(1);
    const visibleCount = Math.max(0, capacity - 1);
    await expect(day.locator(".month-ev")).toHaveCount(visibleCount);
    const more = day.locator(".month-more");
    await expect(more).toHaveText(`+${events.length - visibleCount}개 더보기`);
    await expect(more).toBeVisible();
    const containment = await day.evaluate((cell) => {
      const cellRect = cell.getBoundingClientRect();
      const moreRect = cell.querySelector(".month-more")!.getBoundingClientRect();
      return {
        inside:
          moreRect.top >= cellRect.top - 1 &&
          moreRect.left >= cellRect.left - 1 &&
          moreRect.right <= cellRect.right + 1 &&
          moreRect.bottom <= cellRect.bottom + 1,
        height: moreRect.height,
      };
    });
    expect(containment.inside).toBeTruthy();
    expect(containment.height).toBeGreaterThanOrEqual(24);
    const cellHeight = await day.evaluate((cell) => cell.getBoundingClientRect().height);
    expect(cellHeight).toBeGreaterThanOrEqual(90);
    const styling = await day.locator(".month-ev").first().evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      timeFontSize: Number.parseFloat(
        getComputedStyle(element.querySelector<HTMLElement>(".month-ev-time")!).fontSize,
      ),
      borderColor: getComputedStyle(element).borderLeftColor,
    }));
    expect(styling.height).toBe(24);
    expect(styling.fontSize).toBeLessThanOrEqual(10.5);
    expect(styling.timeFontSize).toBeLessThanOrEqual(9.5);
    expect(styling.borderColor).toBe("rgb(217, 48, 37)");
    await expect(day.locator(".month-ev").first()).toHaveAccessibleName(
      new RegExp(primaryCalendar.summary),
    );
    await more.click();
    const dayDialog = page.getByRole("dialog", { name: /일정$/ });
    await expect(dayDialog.locator(".cal-event")).toHaveCount(events.length);
    await dayDialog.getByRole("button", { name: "닫기" }).click();
    await expect(page.getByRole("button", { name: "이전 달" })).toBeVisible();
    await expect(page.getByRole("button", { name: "다음 달" })).toBeVisible();
  });

}

test("month and list views hand off and preserve the same date context", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await openCalendar(page);

  await page.getByRole("button", { name: "다음 달" }).click();
  await expect(page.locator(".cal-monthnav strong")).toHaveText("2026년 5월");

  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(page.locator(".cal-range strong")).toContainText("5월 1일");

  await page.getByRole("button", { name: "월", exact: true }).click();
  await expect(page.locator(".cal-monthnav strong")).toHaveText("2026년 5월");
});

test("initial previous next and today hand off immediately to agenda", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await openCalendar(page);
  const assertAgenda = async (text: string) => {
    await page.getByRole("button", { name: "목록", exact: true }).click();
    await expect(page.locator(".cal-range strong")).toContainText(text);
    await page.getByRole("button", { name: "월", exact: true }).click();
  };

  await assertAgenda("4월 12일");
  await page.getByRole("button", { name: "다음 달" }).click();
  await assertAgenda("5월 1일");
  await page.getByRole("button", { name: "이전 달" }).click();
  await assertAgenda("4월 1일");
  await page.getByRole("button", { name: "오늘" }).click();
  await assertAgenda("4월 12일");
});

test("programmatic month and today navigation settles on target geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await openCalendar(page);
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  const alignmentError = async (target: string, mode: "start" | "center") =>
    region.evaluate((element, { target, mode }) => {
      const date = new Date(`${target}T00:00:00`);
      const start = new Date(date);
      start.setDate(date.getDate() - date.getDay());
      const key = [
        start.getFullYear(),
        String(start.getMonth() + 1).padStart(2, "0"),
        String(start.getDate()).padStart(2, "0"),
      ].join("-");
      const row = element.querySelector<HTMLElement>(`.month-week[data-week-start="${key}"]`)!;
      const regionRect = element.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return mode === "center"
        ? Math.abs(rowRect.top + rowRect.height / 2 - (regionRect.top + regionRect.height / 2))
        : Math.abs(rowRect.top - regionRect.top);
    }, { target, mode });

  await page.getByRole("button", { name: "다음 달" }).click();
  await expect(page.locator(".cal-monthnav strong")).toHaveText("2026년 5월");
  await expect(page.locator(".month-continuous")).toHaveAttribute("data-navigation-phase", "settled");
  await expect.poll(() => alignmentError("2026-05-01", "start")).toBeLessThanOrEqual(1);
  await expect(page.locator('.month-cell[data-date="2026-05-01"]')).toHaveClass(/selected/);

  await page.getByRole("button", { name: "이전 달" }).click();
  await expect(page.locator(".cal-monthnav strong")).toHaveText("2026년 4월");
  await expect(page.locator(".month-continuous")).toHaveAttribute("data-navigation-phase", "settled");
  await expect.poll(() => alignmentError("2026-04-01", "start")).toBeLessThanOrEqual(1);
  await expect(page.locator('.month-cell[data-date="2026-04-01"]')).toHaveClass(/selected/);

  await page.getByRole("button", { name: "오늘" }).click();
  await expect(page.locator(".month-continuous")).toHaveAttribute("data-navigation-phase", "settled");
  await expect.poll(() => alignmentError("2026-04-12", "center")).toBeLessThanOrEqual(1);
  await expect(page.locator('.month-cell[data-date="2026-04-12"]')).toHaveClass(/selected/);
  const todayWeekTop = await page.locator('.month-cell[data-date="2026-04-12"]').evaluate((cell) => {
    const row = cell.closest(".month-week")!;
    const region = cell.closest(".month-virtual-scroll")!;
    return row.getBoundingClientRect().top - region.getBoundingClientRect().top;
  });
  const generationBeforeResize = Number(
    await page.locator(".month-continuous").getAttribute("data-adjustment-generation"),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".month-continuous")).toHaveAttribute(
    "data-adjustment-generation",
    String(generationBeforeResize + 1),
  );
  await expect.poll(() =>
    page.locator('.month-cell[data-date="2026-04-12"]').evaluate((cell, oldTop) => {
      const row = cell.closest(".month-week")!;
      const region = cell.closest(".month-virtual-scroll")!;
      return Math.abs(row.getBoundingClientRect().top - region.getBoundingClientRect().top - oldTop);
    }, todayWeekTop)).toBeLessThanOrEqual(1);
});

test("scroll ownership, title publication, rebase identity, and agenda handoff stay coherent", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await openCalendar(page);
  const calendar = page.locator(".month-continuous");
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  await expect(page.locator(".calendar")).toHaveCSS("overflow-y", "hidden");
  await expect(calendar).toHaveCSS("overflow", "hidden");
  await expect(region).toHaveCSS("overflow-y", /auto|scroll/);
  const ownershipGeometry = await page.locator(".body").evaluate((body) => {
    const region = body.querySelector<HTMLElement>(".month-virtual-scroll")!;
    const weeks = [...region.querySelectorAll<HTMLElement>(".month-week")];
    const cells = [...region.querySelectorAll<HTMLElement>(".month-cell")];
    return {
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyVerticalOverflow: body.scrollHeight - body.clientHeight,
      regionHorizontalOverflow: region.scrollWidth - region.clientWidth,
      weekWidthsFit: weeks.every((week) => week.getBoundingClientRect().width <= region.clientWidth + 1),
      weeksDoNotScrollVertically: weeks.every((week) => week.scrollHeight <= week.clientHeight + 1),
      cellsClipVertically: cells.every((cell) => cell.scrollHeight <= cell.clientHeight + 1),
      cellsDoNotScrollHorizontally: cells.every((cell) => cell.scrollWidth <= cell.clientWidth + 1),
    };
  });
  expect(ownershipGeometry.bodyOverflowY).not.toMatch(/auto|scroll/);
  expect(ownershipGeometry.bodyVerticalOverflow).toBeLessThanOrEqual(1);
  expect(ownershipGeometry.regionHorizontalOverflow).toBeLessThanOrEqual(1);
  expect(ownershipGeometry.weekWidthsFit).toBeTruthy();
  expect(ownershipGeometry.weeksDoNotScrollVertically).toBeTruthy();
  expect(ownershipGeometry.cellsClipVertically).toBeTruthy();
  expect(ownershipGeometry.cellsDoNotScrollHorizontally).toBeTruthy();
  expect(await region.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    await region.evaluate((element) => element.clientHeight),
  );

  const initialWindow = (await calendar.getAttribute("data-window-start"))!;
  const initialRange = (await calendar.getAttribute("data-loaded-range"))!;
  await page.getByRole("button", { name: "다음 달" }).click();
  await expect(calendar).toHaveAttribute("data-navigation-phase", "settled");
  await expect(calendar).toHaveAttribute("data-window-start", initialWindow);
  await expect(calendar).toHaveAttribute("data-loaded-range", initialRange);

  await page.getByRole("button", { name: "다음 달" }).click();
  await expect(calendar).toHaveAttribute("data-navigation-phase", "settled");
  const juneWeek = "2026-05-31";
  await expect(calendar).toHaveAttribute("data-window-start", shiftDateKey(juneWeek, -42));
  await expect(page.locator('.month-cell[data-date="2026-06-01"]')).toHaveClass(/selected/);

  const beforeUserWindow = (await calendar.getAttribute("data-window-start"))!;
  await region.dispatchEvent("pointerdown", { pointerType: "mouse" });
  await expect(calendar).toHaveAttribute("data-navigation-phase", "idle");
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(calendar).not.toHaveAttribute("data-window-start", beforeUserWindow);

  const viewportState = await region.evaluate((element) => {
    const regionRect = element.getBoundingClientRect();
    const visible = [...element.querySelectorAll<HTMLElement>(".month-cell")].filter((cell) => {
      const box = cell.getBoundingClientRect();
      return box.bottom > regionRect.top && box.top < regionRect.bottom;
    });
    const areas = new Map<string, number>();
    for (const cell of visible) {
      const box = cell.getBoundingClientRect();
      const month = cell.dataset.date!.slice(0, 7);
      const height = Math.max(0, Math.min(box.bottom, regionRect.bottom) - Math.max(box.top, regionRect.top));
      areas.set(month, (areas.get(month) ?? 0) + height * box.width);
    }
    const centerX = regionRect.left + regionRect.width / 2;
    const centerY = regionRect.top + regionRect.height / 2;
    const center = visible.reduce((best, cell) => {
      if (!best) return cell;
      const distance = (candidate: HTMLElement) => {
        const box = candidate.getBoundingClientRect();
        return Math.abs(box.left + box.width / 2 - centerX) +
          Math.abs(box.top + box.height / 2 - centerY);
      };
      return distance(cell) < distance(best) ? cell : best;
    }, null as HTMLElement | null)!;
    const centerMonth = center.dataset.date!.slice(0, 7);
    const dominant = [...areas].sort((left, right) => {
      const difference = right[1] - left[1];
      if (Math.abs(difference) > 0.5) return difference;
      if (left[0] === centerMonth) return -1;
      if (right[0] === centerMonth) return 1;
      return left[0].localeCompare(right[0]);
    })[0][0];
    return { centerDate: center.dataset.date!, dominant };
  });
  const [dominantYear, dominantMonth] = viewportState.dominant.split("-").map(Number);
  await expect(page.locator(".cal-monthnav strong")).toHaveText(`${dominantYear}년 ${dominantMonth}월`);
  const selected = page.locator(".month-cell.selected");
  await expect(selected).toHaveCount(1);
  const selectedDate = (await selected.getAttribute("data-date"))!;
  expect(selectedDate).not.toBe("2026-06-01");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(page.locator(".cal-range strong")).toContainText(
    `${Number(selectedDate.slice(5, 7))}월 ${Number(selectedDate.slice(8, 10))}일`,
  );
});

test("equal visible month areas publish the actual two-axis center date", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await openCalendar(page);
  for (const month of [5, 6, 7, 8, 9, 10, 11]) {
    await page.getByRole("button", { name: "다음 달" }).click();
    await expect(page.locator(".cal-monthnav strong")).toHaveText(`2026년 ${month}월`);
    await expect(page.locator(".month-continuous")).toHaveAttribute("data-navigation-phase", "settled");
  }
  const region = page.getByRole("region", { name: "연속 월간 캘린더" });
  await region.evaluate((element) => {
    const row = element.querySelector<HTMLElement>('.month-week[data-week-start="2026-10-25"]')!;
    element.style.flex = "none";
    element.style.height = `${row.getBoundingClientRect().height * 2}px`;
  });
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await region.dispatchEvent("pointerdown", { pointerType: "mouse" });
  const tie = await region.evaluate((element) => {
    const row = element.querySelector<HTMLElement>('.month-week[data-week-start="2026-10-25"]')!;
    element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top;
    element.dispatchEvent(new Event("scroll"));
    const regionRect = element.getBoundingClientRect();
    const visible = [...element.querySelectorAll<HTMLElement>(".month-cell")].filter((cell) => {
      const box = cell.getBoundingClientRect();
      return box.bottom > regionRect.top && box.top < regionRect.bottom;
    });
    const areas = new Map<string, number>();
    for (const cell of visible) {
      const box = cell.getBoundingClientRect();
      const month = cell.dataset.date!.slice(0, 7);
      const height = Math.max(0, Math.min(box.bottom, regionRect.bottom) - Math.max(box.top, regionRect.top));
      areas.set(month, (areas.get(month) ?? 0) + height * box.width);
    }
    const centerX = regionRect.left + regionRect.width / 2;
    const centerY = regionRect.top + regionRect.height / 2;
    const center = visible.reduce((best, cell) => {
      if (!best) return cell;
      const distance = (candidate: HTMLElement) => {
        const box = candidate.getBoundingClientRect();
        return Math.abs(box.left + box.width / 2 - centerX) +
          Math.abs(box.top + box.height / 2 - centerY);
      };
      return distance(cell) < distance(best) ? cell : best;
    }, null as HTMLElement | null)!;
    return {
      october: areas.get("2026-10") ?? 0,
      november: areas.get("2026-11") ?? 0,
      centerDate: center.dataset.date!,
      tolerance: element.clientWidth * 2,
    };
  });
  expect(Math.abs(tie.october - tie.november)).toBeLessThanOrEqual(tie.tolerance);
  await expect(page.locator(`.month-cell[data-date="${tie.centerDate}"]`)).toHaveClass(/selected/);
  await expect(page.locator(".cal-monthnav strong")).toHaveText(
    tie.centerDate.startsWith("2026-10") ? "2026년 10월" : "2026년 11월",
  );
});

test("calendar shell remains usable and accessible at the 768px quality boundary", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) =>
    route.fulfill({
      json: Array.from({ length: 10 }, (_, index) => ({
        ...primaryEvent,
        id: `responsive-${index}`,
        start: "2026-04-13T09:00:00",
        end: "2026-04-13T10:00:00",
        summary: `반응형 일정 ${index + 1}`,
      })),
    }),
  );
  await openCalendar(page);

  const viewportFits = await page.locator(".body").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  );
  expect(viewportFits).toBeTruthy();
  await expect(page.getByRole("button", { name: "새 일정" })).toBeVisible();
  await expect(page.getByRole("button", { name: "월", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "목록", exact: true })).toBeVisible();
  await expect(page.locator(".month-ev")).toHaveCount(3);
  await expect(page.locator(".month-more")).toHaveText("+7개 더보기");
  await expect(page.locator(".month-ev-time").first()).toBeVisible();
  await expect(page.locator(".month-ev").first()).toHaveAccessibleName(
    new RegExp(primaryCalendar.summary),
  );

  for (const control of [
    page.getByRole("button", { name: /사이드바 (접기|펼치기)/ }),
    page.getByRole("button", { name: "이전 달" }),
    page.getByRole("button", { name: "다음 달" }),
    page.getByRole("button", { name: "오늘" }),
    page.getByRole("button", { name: "월", exact: true }),
    page.getByRole("button", { name: "목록", exact: true }),
  ]) {
    const size = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }
  const compactEvent = await page.locator(".month-ev").first().evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    timeFontSize: Number.parseFloat(
      getComputedStyle(element.querySelector<HTMLElement>(".month-ev-time")!).fontSize,
    ),
  }));
  expect(compactEvent.height).toBeLessThanOrEqual(28);
  expect(compactEvent.timeFontSize).toBeLessThanOrEqual(9.5);

  const createSize = await page.getByRole("button", { name: "새 일정" }).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(createSize.width).toBeGreaterThanOrEqual(44);
  expect(createSize.height).toBeGreaterThanOrEqual(44);

  await page.locator(".month-ev").first().focus();
  await expect(page.locator(".month-ev").first()).toBeFocused();
  const outlineWidth = await page.locator(".month-ev").first().evaluate(
    (element) => getComputedStyle(element).outlineWidth,
  );
  expect(outlineWidth).not.toBe("0px");
  await page.getByRole("button", { name: "새 일정" }).click();
  const editor = page.getByRole("dialog", { name: "새 일정" });
  await expect(editor.getByLabel("일정 제목")).toBeVisible();
  await expect.poll(() => editor.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
  for (const label of ["일정 제목", "시작 날짜", "종료 날짜"]) {
    const control = editor.getByLabel(label);
    await expect(control).toBeVisible();
    const height = await control.evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(44);
  }
  await editor.getByRole("button", { name: /장소.*알림.*설명/ }).click();
  for (const label of ["장소", "알림", "설명"]) {
    const control = editor.getByLabel(label);
    await expect(control).toBeVisible();
    const height = await control.evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(44);
  }
  for (const control of await editor.locator(".modal-head button, .modal-foot button").all()) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  page.once("dialog", (dialog) => dialog.accept());
  await editor.getByRole("button", { name: "취소" }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole("button", { name: "목록", exact: true }).click();
  const agendaDate = page.locator(".cal-date").first();
  await expect(agendaDate).toBeVisible();
  await expect
    .poll(() =>
      agendaDate
        .evaluate((element) => element.getBoundingClientRect().height)
        .catch(() => 0),
    )
    .toBeGreaterThanOrEqual(44);
});

test("event detail modal traps focus, closes with Escape, and restores the event trigger", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: [primaryEvent] }));
  await page.route(`${TEST_ORIGIN}/api/calendar/event?*`, (route) =>
    route.fulfill({
      json: primaryEventDetail,
    }),
  );
  await openCalendar(page);

  const trigger = page.getByRole("button", { name: /기본 캘린더 일정/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "일정" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const lastFocusableIsActive = await dialog.evaluate((element) => {
    const focusable = [...element.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((candidate) => candidate.offsetParent !== null);
    return document.activeElement === focusable.at(-1);
  });
  expect(lastFocusableIsActive).toBeTruthy();

  await page.keyboard.press("Tab");
  const firstFocusableIsActive = await dialog.evaluate((element) => {
    const focusable = [...element.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((candidate) => candidate.offsetParent !== null);
    return document.activeElement === focusable[0];
  });
  expect(firstFocusableIsActive).toBeTruthy();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("agenda groups events in deterministic chronological order", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  const events = [
    {
      ...primaryEvent,
      id: "late",
      summary: "늦은 일정",
      start: "2026-04-13T15:00:00",
      end: "2026-04-13T16:00:00",
    },
    {
      ...primaryEvent,
      id: "early-b",
      summary: "가 일정",
      start: "2026-04-13T09:00:00",
      end: "2026-04-13T10:00:00",
    },
    {
      ...primaryEvent,
      id: "early-a",
      summary: "나 일정",
      start: "2026-04-13T09:00:00",
      end: "2026-04-13T10:00:00",
    },
  ];
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: events }));
  await openCalendar(page);
  await page.getByRole("button", { name: "목록", exact: true }).click();

  await expect(page.locator(".cal-title")).toHaveText(["가 일정", "나 일정", "늦은 일정"]);
});
test("calendar interactions honor reduced-motion preferences", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: [primaryEvent] }));
  await openCalendar(page);

  const motion = await page.locator(".month-ev").evaluate((element) => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, transitionDuration: style.transitionDuration };
  });
  expect(motion.animationName).toBe("none");
  expect(motion.transitionDuration).toBe("0s");
});

test("cached events remain visible while refresh failures are diagnosed", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  let requestCount = 0;
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => {
    requestCount += 1;
    return requestCount === 1
      ? route.fulfill({ json: [primaryEvent] })
      : route.fulfill({ status: 503, json: { error: "calendar temporarily unavailable" } });
  });
  await openCalendar(page);
  await expect(page.getByText(primaryEvent.summary)).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("status")).toContainText("저장된 일정을 표시합니다");
  await expect(page.getByText(primaryEvent.summary)).toBeVisible();
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect.poll(() => requestCount).toBe(3);
  await expect(page.getByRole("status")).toContainText("저장된 일정을 표시합니다");
});

test("exact-fit capacity and keyboard controls keep creation, event, and more isolated", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  let eventCount = 0;
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) =>
    route.fulfill({
      json: Array.from({ length: eventCount }, (_, index) => ({
        ...primaryEvent,
        id: `capacity-${index}`,
        summary: `용량 일정 ${index + 1}`,
      })),
    }));
  await page.route(`${TEST_ORIGIN}/api/calendar/event?*`, (route) => {
    expect(new URL(route.request().url()).searchParams.get("eventId")).toBe("capacity-0");
    return route.fulfill({ json: { ...primaryEventDetail, id: "capacity-0", summary: "용량 일정 1" } });
  });
  await openCalendar(page);
  const calendar = page.locator(".month-continuous");
  await expect(calendar).toHaveAttribute("data-event-capacity-measured", "true");
  const capacity = Number(await calendar.getAttribute("data-event-row-capacity"));
  const day = page.locator('.month-cell[data-date="2026-04-10"]');
  const independentCapacity = await day.evaluate((cell) => {
    const style = getComputedStyle(cell);
    const header = cell.querySelector<HTMLElement>(".month-cellhead")!;
    const rowHeight = Number.parseFloat(style.getPropertyValue("--month-event-row-height"));
    const gap = Number.parseFloat(style.gap) || 0;
    const available = cell.clientHeight - Number.parseFloat(style.paddingTop) -
      Number.parseFloat(style.paddingBottom) - header.offsetHeight;
    const value = Math.max(1, Math.floor(available / (rowHeight + gap)));
    return {
      value,
      residual: available - value * (rowHeight + gap),
      nextRow: rowHeight + gap,
    };
  });
  expect(capacity).toBe(independentCapacity.value);
  expect(independentCapacity.residual).toBeLessThan(independentCapacity.nextRow);

  eventCount = capacity;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(day.locator(".month-ev")).toHaveCount(capacity);
  await expect(day.locator(".month-more")).toHaveCount(0);
  const exactResidual = await day.evaluate((cell) => {
    const last = cell.querySelector<HTMLElement>(".month-ev:last-of-type")!;
    return cell.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
  });
  expect(exactResidual).toBeGreaterThanOrEqual(0);

  eventCount = capacity + 2;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(day.locator(".month-ev")).toHaveCount(Math.max(0, capacity - 1));
  await expect(day.locator(".month-more")).toHaveText("+3개 더보기");
  const moreResidual = await day.evaluate((cell) => {
    const more = cell.querySelector<HTMLElement>(".month-more")!;
    return {
      bottom: cell.getBoundingClientRect().bottom - more.getBoundingClientRect().bottom,
      height: more.getBoundingClientRect().height,
    };
  });
  expect(moreResidual.bottom).toBeGreaterThanOrEqual(0);
  expect(moreResidual.height).toBeGreaterThanOrEqual(24);

  const event = day.locator(".month-ev").first();
  await event.focus();
  await event.press("Enter");
  await expect(page.getByRole("dialog", { name: "일정" })).toBeVisible();
  await page.getByRole("dialog", { name: "일정" }).getByRole("button", { name: "닫기" }).click();

  const more = day.locator(".month-more");
  await more.focus();
  await more.press("Space");
  await expect(page.getByRole("dialog", { name: /일정$/ })).toBeVisible();
  await page.getByRole("dialog", { name: /일정$/ }).getByRole("button", { name: "닫기" }).click();

  const create = page.locator('.month-cell[data-date="2026-04-12"] .month-create-hitarea');
  await create.focus();
  await create.press("Space");
  await expect(page.getByRole("dialog", { name: "새 일정" })).toBeVisible();
  await expect(page.getByLabel("시작 날짜")).toHaveValue("2026-04-12");
  await page.getByRole("dialog", { name: "새 일정" }).getByRole("button", { name: "취소" }).click();
  await create.focus();
  await create.press("Enter");
  await expect(page.getByRole("dialog", { name: "새 일정" })).toBeVisible();
  await expect(page.getByLabel("시작 날짜")).toHaveValue("2026-04-12");
  await page.getByRole("dialog", { name: "새 일정" }).getByRole("button", { name: "취소" }).click();
});

test("dense bottom-row events do not resize the fixed month grid", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-05-12T12:00:00") });
  await installAppMocks(page);
  const events = Array.from({ length: 8 }, (_, index) => ({
    ...primaryEvent,
    id: `bottom-${index}`,
    summary: `하단 일정 ${index + 1}`,
    start: "2026-06-05T09:00:00",
    end: "2026-06-05T10:00:00",
  }));
  await page.route(`${TEST_ORIGIN}/api/calendar/events?*`, (route) => route.fulfill({ json: events }));
  await openCalendar(page);

  const calendar = page.locator(".calendar");
  const monthLabel = calendar.locator(".cal-monthnav strong");
  await expect(monthLabel).toHaveText("2026년 5월");
  const continuous = page.locator(".month-continuous");
  await expect(continuous).toHaveAttribute("data-event-capacity-measured", "true");
  const capacity = Number(await continuous.getAttribute("data-event-row-capacity"));
  const visibleCount = Math.max(0, capacity - 1);
  await expect(page.locator(".month-ev")).toHaveCount(visibleCount);
  await expect(page.locator(".month-more")).toHaveText(`+${events.length - visibleCount}개 더보기`);
  const bottomCell = page.locator('.month-cell[data-date="2026-06-05"]');
  const fixedHeight = await bottomCell.evaluate((element) => element.getBoundingClientRect().height);
  await page.getByRole("region", { name: "연속 월간 캘린더" }).hover();
  await page.mouse.wheel(0, 120);
  expect(await bottomCell.evaluate((element) => element.getBoundingClientRect().height)).toBe(fixedHeight);
  await expect(page.getByRole("region", { name: "연속 월간 캘린더" }).locator(".month-week")).toHaveCount(13);
});
