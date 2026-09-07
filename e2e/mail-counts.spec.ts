import { expect, test } from "@playwright/test";
import { installAppMocks, openMailbox } from "./fixtures/app.ts";

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
  const bounds = await inbox.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
});
