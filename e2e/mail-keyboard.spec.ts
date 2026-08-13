import { expect, test } from "@playwright/test";
import { installAppMocks, openMailbox } from "./fixtures/app.ts";

const message = {
  id: "message-1",
  threadId: "thread-1",
  from: "Sender <sender@example.com>",
  to: "test@example.com",
  subject: "Archive policy message",
  snippet: "Keyboard archive regression",
  date: "2026-08-05T08:00:00.000Z",
  unread: false,
  labelIds: ["INBOX", "STARRED"],
  hasAttachments: false,
  cc: "",
  bcc: "",
  replyTo: "",
  references: "",
  rfc822MsgId: "<message-1@example.com>",
  inReplyTo: "",
  bodyHtml: null,
  bodyText: "Keyboard archive regression",
  attachments: [],
};

test("archive shortcut removes inbox rows but retains navigated label results", async ({ page }) => {
  const calls = await installAppMocks(page, { messages: [message] });
  await openMailbox(page);
  const row = page.locator(".msg-row").filter({ hasText: message.subject });

  await expect(row).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press("e");
  await expect(row).toHaveCount(0);

  await page.getByRole("button", { name: /별표/ }).click();
  await expect(row).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press("e");
  await expect(row).toBeVisible();

  expect(calls.filter(({ method, path }) => method === "POST" && path.endsWith("/modify"))).toHaveLength(2);
});
