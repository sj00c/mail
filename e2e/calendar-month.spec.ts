import { expect, test } from "@playwright/test";
import { calendarMutationCalls, installAppMocks, openMailbox, primaryCalendar } from "./fixtures/app";

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

async function openCalendar(page: Parameters<typeof installAppMocks>[0]) {
  await openMailbox(page);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(page.locator(".month-grid")).toBeVisible();
}

test("primary calendar is first/default, remains hideable, and local color controls do not mutate the API", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-04-01T12:00:00") });
  const calls = await installAppMocks(page);
  await page.route("**/api/calendar/events?*", (route) => route.fulfill({ json: [primaryEvent] }));
  await page.route("**/api/calendar/calendars", (route) =>
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
  await page.route("**/api/calendar/events?*", (route) =>
    route.fulfill({ json: [primaryEvent] }),
  );
  await openCalendar(page);

  const emptyDay = page.locator('.month-cell[data-date="2026-04-06"]');
  await emptyDay.locator(".month-daynum").click();

  const editor = page.getByRole("dialog", { name: "새 일정" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("시작 날짜")).toHaveValue("2026-04-06");
  await editor.getByRole("button", { name: "취소" }).click();
  await expect(editor).toHaveCount(0);

  const eventDay = page.locator('.month-cell[data-date="2026-04-10"]');
  await eventDay.locator(".month-ev").click();
  await expect(page.getByRole("dialog", { name: "일정" })).toBeVisible();
});

for (const [name, date, cells] of [
  ["four", "2026-02-12T12:00:00", 28],
  ["five", "2026-04-12T12:00:00", 35],
  ["six", "2026-05-12T12:00:00", 42],
] as const) {
  test(`${name}-week months fit the grid without internal scrolling`, async ({ page }) => {
    await page.clock.install({ time: new Date(date) });
    await installAppMocks(page);
    await openCalendar(page);
    const grid = page.locator(".month-grid");
    await expect(grid.locator(".month-cell")).toHaveCount(cells);
    await expect(grid).not.toHaveCSS("overflow-y", /auto|scroll/);
    expect(await grid.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBeTruthy();
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
    await page.route("**/api/calendar/events?*", (route) => route.fulfill({ json: events }));
    await openCalendar(page);

    const day = page.locator(".month-cell").filter({ hasText: "일정 1" });
    await expect(day).toHaveCount(1);
    await expect(day.locator(".month-ev")).toHaveCount(3);
    const more = day.locator(".month-more");
    await expect(more).toHaveText("+7개 더보기");
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

test("calendar shell remains usable and accessible at the 768px quality boundary", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await page.route("**/api/calendar/events?*", (route) =>
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
  await page.waitForTimeout(250);
  await expect(editor.getByLabel("일정 제목")).toBeVisible();
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
  await page.route("**/api/calendar/events?*", (route) => route.fulfill({ json: [primaryEvent] }));
  await page.route("**/api/calendar/event?*", (route) =>
    route.fulfill({
      json: {
        ...primaryEvent,
        description: "상세 설명",
        attendees: [],
        organizer: "owner@example.com",
        reminderDefault: true,
        reminderMinutes: null,
        hangoutLink: "",
      },
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
  await page.route("**/api/calendar/events?*", (route) => route.fulfill({ json: events }));
  await openCalendar(page);
  await page.getByRole("button", { name: "목록", exact: true }).click();

  await expect(page.locator(".cal-title")).toHaveText(["가 일정", "나 일정", "늦은 일정"]);
});
test("calendar interactions honor reduced-motion preferences", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-04-12T12:00:00") });
  await installAppMocks(page);
  await page.route("**/api/calendar/events?*", (route) => route.fulfill({ json: [primaryEvent] }));
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
  await page.route("**/api/calendar/events?*", (route) => {
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
  await page.route("**/api/calendar/events?*", (route) => route.fulfill({ json: events }));
  await openCalendar(page);

  const calendar = page.locator(".calendar");
  const monthLabel = calendar.locator(".cal-monthnav strong");
  await expect(monthLabel).toHaveText("2026년 5월");
  await expect(page.locator(".month-ev")).toHaveCount(3);
  await expect(page.locator(".month-more")).toHaveText("+5개 더보기");
  const bottomCell = page.locator('.month-cell[data-date="2026-06-05"]');
  const fixedHeight = await bottomCell.evaluate((element) => element.getBoundingClientRect().height);
  await page.locator(".month-grid").hover();
  await page.mouse.wheel(0, 1_000);
  expect(await bottomCell.evaluate((element) => element.getBoundingClientRect().height)).toBe(fixedHeight);
  await expect(monthLabel).toHaveText("2026년 5월");
});
