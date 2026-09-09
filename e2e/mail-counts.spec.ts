import { expect } from "@playwright/test";
import { test, installAppMocks, openMailbox } from "./fixtures/app.ts";

async function labelGeometry(
  label: import("@playwright/test").Locator,
) {
  return label.evaluate((element) => {
    const name = element.querySelector<HTMLElement>(".label-name");
    const counts = element.querySelector<HTMLElement>(".label-counts");
    if (!name || !counts) throw new Error("label geometry hooks are missing");
    const row = element.getBoundingClientRect();
    const nameBox = name.getBoundingClientRect();
    const countsBox = counts.getBoundingClientRect();
    return {
      rowLeft: row.left,
      rowRight: row.right,
      nameLeft: nameBox.left,
      nameRight: nameBox.right,
      nameTop: nameBox.top,
      nameBottom: nameBox.bottom,
      nameWidth: name.clientWidth,
      nameScroll: name.scrollWidth,
      countsLeft: countsBox.left,
      countsRight: countsBox.right,
      countsTop: countsBox.top,
      countsBottom: countsBox.bottom,
      rowWidth: element.clientWidth,
      rowScroll: element.scrollWidth,
    };
  });
}

function expectLabelGeometry(
  bounds: Awaited<ReturnType<typeof labelGeometry>>,
  options: { nameMustFit?: boolean } = {},
) {
  expect(bounds.rowScroll).toBeLessThanOrEqual(bounds.rowWidth);
  if (options.nameMustFit !== false) {
    expect(bounds.nameScroll).toBeLessThanOrEqual(bounds.nameWidth);
  }
  expect(bounds.nameLeft).toBeGreaterThanOrEqual(bounds.rowLeft);
  expect(bounds.countsRight).toBeLessThanOrEqual(bounds.rowRight);
  expect(bounds.countsLeft).toBeGreaterThanOrEqual(bounds.nameRight);
  expect(Math.abs(bounds.nameTop - bounds.countsTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.nameBottom - bounds.countsBottom)).toBeLessThanOrEqual(1);
}

async function reserveClassicSidebarScrollbar(
  page: import("@playwright/test").Page,
) {
  await page.addStyleTag({
    content: `
      .sidebar-inner {
        overflow-y: scroll !important;
        scrollbar-gutter: stable !important;
        scrollbar-width: auto !important;
      }
      .sidebar-inner::-webkit-scrollbar {
        width: 16px !important;
      }
    `,
  });
}

function labelDetails(
  name: string,
  total: number | undefined,
  unread: number | undefined,
) {
  const totalText =
    total === undefined
      ? "제공되지 않음"
      : `${total.toLocaleString("ko-KR")}개`;
  const unreadText =
    unread === undefined
      ? "제공되지 않음"
      : `${unread.toLocaleString("ko-KR")}개`;
  return `${name} — 전체 메시지 수: ${totalText}, 안 읽은 메시지 수: ${unreadText}`;
}

function compactCount(count: number) {
  return new Intl.NumberFormat("ko-KR", { notation: "compact" }).format(count);
}

test("sidebar distinguishes account-wide, folder total and unread message counts", async ({ page }) => {
  const calls = await installAppMocks(page, {
    profile: { email: "test@example.com", historyId: "10", messagesTotal: 12345 },
    labels: [
      { id: "INBOX", name: "INBOX", type: "system", total: 1234, unread: 56 },
      { id: "DRAFT", name: "DRAFT", type: "system", total: 7, unread: 0 },
      { id: "STARRED", name: "STARRED", type: "system", total: 0, unread: 0 },
      { id: "TRASH", name: "TRASH", type: "system", total: 9, unread: 2 },
      { id: "work", name: "업무", type: "user", total: 24, unread: 3 },
    ],
  });
  await openMailbox(page);
  await expect(page.getByText("계정 메시지 12,345개")).toBeVisible();
  await expect(page.getByText("Google 제공 계정 기준", { exact: true })).toBeVisible();
  const inbox = page.locator(".label-row").filter({ hasText: "받은편지함" });
  await expect(inbox.locator(".label-counts")).toHaveText("56");
  await expect(inbox.locator(".label-counts")).toHaveClass(/badge/);
  await expect(inbox).toHaveAttribute(
    "title",
    labelDetails("받은편지함", 1234, 56),
  );
  await expect(inbox).toHaveAttribute(
    "aria-label",
    labelDetails("받은편지함", 1234, 56),
  );
  await expect(inbox.locator(".label-counts")).toHaveAttribute(
    "title",
    "안 읽은 메시지 수: 56개",
  );
  const draft = page.locator(".label-row").filter({ hasText: "임시보관함" });
  await expect(draft.locator(".label-counts")).toHaveText("7");
  await expect(draft.locator(".label-counts")).not.toHaveClass(/badge/);
  await expect(draft).toHaveAttribute(
    "title",
    labelDetails("임시보관함", 7, 0),
  );
  await expect(draft.locator(".label-counts")).toHaveAttribute(
    "title",
    "전체 메시지 수: 7개",
  );
  const starred = page.locator(".label-row").filter({ hasText: "별표" });
  await expect(starred.locator(".label-counts")).toHaveText("0");
  await expect(starred.locator(".label-counts")).not.toHaveClass(/badge/);
  await expect(starred.locator(".label-counts")).toHaveAttribute(
    "title",
    "전체 메시지 수: 0개",
  );
  const work = page.locator(".label-row").filter({ hasText: "업무" });
  await expect(work.locator(".label-counts")).toHaveText("3");
  await expect(work.locator(".label-counts")).toHaveClass(/badge/);
  await expect(work).toHaveAttribute(
    "aria-label",
    labelDetails("업무", 24, 3),
  );
  const allMail = page.locator(".label-row").filter({ hasText: "전체메일" });
  await expect(allMail.locator(".label-counts")).toHaveCount(0);
  await expect(allMail).toHaveAttribute(
    "aria-label",
    labelDetails("전체메일", undefined, undefined),
  );
  // Totals come from Gmail counters, not a mailbox-wide page traversal.
  expect(calls.filter((call) => call.path === "/api/messages")).toHaveLength(1);
  const bounds = await labelGeometry(inbox);
  expectLabelGeometry(bounds);
});

test("sidebar keeps inbox labels readable with a reserved scrollbar at 1024px", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  const longCustomName = "프로젝트 알림과 고객지원 장기 보관함";
  await installAppMocks(page, {
    labels: [
      {
        id: "INBOX",
        name: "INBOX",
        type: "system",
        total: 2201,
        unread: 1,
      },
      {
        id: "long-custom",
        name: longCustomName,
        type: "user",
        total: 0,
        unread: 0,
      },
    ],
  });
  await openMailbox(page);
  await reserveClassicSidebarScrollbar(page);

  const tabs = await page.locator(".workspace-tab").evaluateAll((elements) =>
    elements.map((element) => {
      const label = element.lastElementChild!;
      const range = document.createRange();
      range.selectNodeContents(label);
      const box = element.getBoundingClientRect();
      const text = label.getBoundingClientRect();
      return {
        lines: range.getClientRects().length,
        contained: text.left >= box.left && text.right <= box.right,
      };
    }),
  );
  for (const tab of tabs) {
    expect(tab.lines).toBe(1);
    expect(tab.contained).toBe(true);
  }

  const inbox = page.locator(".label-row").filter({ hasText: "받은편지함" });
  await expect(inbox.locator(".label-counts")).toHaveText("1");
  await expect(inbox.locator(".label-counts")).toHaveClass(/badge/);
  await expect(inbox).toHaveAttribute(
    "title",
    labelDetails("받은편지함", 2201, 1),
  );
  const bounds = await labelGeometry(inbox);
  expectLabelGeometry(bounds);
  const custom = page.locator(".label-row").filter({ hasText: longCustomName });
  await expect(custom.locator(".label-counts")).toHaveText("0");
  expectLabelGeometry(await labelGeometry(custom), { nameMustFit: false });
});

test("sidebar keeps large counters from shrinking the label name", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await installAppMocks(page, {
    labels: [
      {
        id: "INBOX",
        name: "INBOX",
        type: "system",
        total: 123456789,
        unread: 98765432,
      },
    ],
  });
  await openMailbox(page);
  await reserveClassicSidebarScrollbar(page);

  const inbox = page.locator(".label-row").filter({ hasText: "받은편지함" });
  await expect(inbox.locator(".label-counts")).toHaveText(
    compactCount(98765432),
  );
  await expect(inbox.locator(".label-counts")).toHaveClass(/badge/);
  await expect(inbox).toHaveAttribute(
    "title",
    labelDetails("받은편지함", 123456789, 98765432),
  );
  await expect(inbox).toHaveAttribute(
    "aria-label",
    labelDetails("받은편지함", 123456789, 98765432),
  );
  const bounds = await labelGeometry(inbox);
  expectLabelGeometry(bounds);
});
