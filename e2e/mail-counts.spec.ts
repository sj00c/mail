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

function expectLabelGeometry(bounds: Awaited<ReturnType<typeof labelGeometry>>) {
  expect(bounds.rowScroll).toBeLessThanOrEqual(bounds.rowWidth);
  expect(bounds.nameScroll).toBeLessThanOrEqual(bounds.nameWidth);
  expect(bounds.nameLeft).toBeGreaterThanOrEqual(bounds.rowLeft);
  expect(bounds.countsRight).toBeLessThanOrEqual(bounds.rowRight);
  expect(
    bounds.countsLeft >= bounds.nameRight + 8 ||
      bounds.countsTop >= bounds.nameBottom + 2 ||
      bounds.nameTop >= bounds.countsBottom + 2,
  ).toBe(true);
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

test("sidebar distinguishes account-wide, folder total and unread message counts", async ({ page }) => {
  const calls = await installAppMocks(page, {
    profile: { email: "test@example.com", historyId: "10", messagesTotal: 12345 },
    labels: [
      { id: "INBOX", name: "INBOX", type: "system", total: 1234, unread: 56 },
      { id: "DRAFT", name: "DRAFT", type: "system", total: 7, unread: 0 },
      { id: "TRASH", name: "TRASH", type: "system", total: 9, unread: 2 },
      { id: "work", name: "업무", type: "user", total: 24, unread: 3 },
    ],
  });
  await openMailbox(page);
  await expect(page.getByText("계정 메시지 12,345개")).toBeVisible();
  await expect(page.getByText("Google 제공 계정 기준", { exact: true })).toBeVisible();
  const inbox = page.locator(".label-row").filter({ hasText: "받은편지함" });
  await expect(inbox).toContainText("전체 1,234");
  await expect(inbox).toContainText("안 읽음 56");
  const draft = page.locator(".label-row").filter({ hasText: "임시보관함" });
  await expect(draft).toContainText("전체 7");
  await expect(draft).not.toContainText("안 읽음");
  const work = page.locator(".label-row").filter({ hasText: "업무" });
  await expect(work).toContainText("전체 24");
  await expect(work).toContainText("안 읽음 3");
  // Totals come from Gmail counters, not a mailbox-wide page traversal.
  expect(calls.filter((call) => call.path === "/api/messages")).toHaveLength(1);
  const bounds = await labelGeometry(inbox);
  expectLabelGeometry(bounds);
});

test("sidebar keeps inbox labels readable with a reserved scrollbar at 1024px", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await installAppMocks(page, {
    labels: [
      {
        id: "INBOX",
        name: "INBOX",
        type: "system",
        total: 2201,
        unread: 1,
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
  await expect(inbox).toContainText("전체 2,201");
  await expect(inbox).toContainText("안 읽음 1");
  const bounds = await labelGeometry(inbox);
  expectLabelGeometry(bounds);
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
  await expect(inbox).toContainText("전체 123,456,789");
  await expect(inbox).toContainText("안 읽음 98,765,432");
  const bounds = await labelGeometry(inbox);
  expectLabelGeometry(bounds);
});
