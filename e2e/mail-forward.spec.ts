import { expect, test } from "@playwright/test";
import { installAppMocks, openMailbox } from "./fixtures/app.ts";

const older = {
  id: "forward-old",
  threadId: "forward-thread",
  from: "Older Sender <older@example.com>",
  to: "test@example.com",
  subject: "전달 순서 확인",
  snippet: "OLDER-CONTRIBUTION",
  date: "2026-08-18T00:00:00.000Z",
  labelIds: ["INBOX"],
  unread: false,
  cc: "",
  bcc: "",
  replyTo: "",
  references: "",
  inReplyTo: "",
  rfc822MsgId: "<older@example.com>",
  bodyHtml: "<p>OLDER-CONTRIBUTION</p>",
  bodyText: "OLDER-CONTRIBUTION",
  hasAttachments: false,
  attachments: [],
};
const newer = {
  ...older,
  id: "forward-new",
  from: "Newer Sender <newer@example.com>",
  date: "2026-08-19T00:00:00.000Z",
  rfc822MsgId: "<newer@example.com>",
  bodyHtml: '<p>NEWER-CONTRIBUTION</p><div class="gmail_quote"><p>OLDER-CONTRIBUTION</p></div>',
  bodyText: "NEWER-CONTRIBUTION",
};

test("one Forward action quotes the complete thread newest first without repeated history", async ({ page }) => {
  await installAppMocks(page, { messages: [older, newer] });
  await openMailbox(page);
  await page.getByPlaceholder("Search").fill("전달 순서 확인");
  await page.getByPlaceholder("Search").press("Enter");
  await page.locator(".mail-card").first().click();
  const reader = page.locator(".reader-popup");
  await expect(reader).toBeVisible();
  const forward = reader.getByRole("button", { name: /전달/ });
  await expect(forward).toHaveCount(1);
  await expect(forward).toBeEnabled();
  await forward.click();

  const quotation = page.locator('[contenteditable="true"] .mail-fwd-thread');
  await expect(quotation).toBeVisible();
  const cards = quotation.locator("section");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("NEWER-CONTRIBUTION");
  await expect(cards.nth(1)).toContainText("OLDER-CONTRIBUTION");
  const text = await quotation.innerText();
  expect(text.match(/OLDER-CONTRIBUTION/g)).toHaveLength(1);
  expect(text.match(/NEWER-CONTRIBUTION/g)).toHaveLength(1);
  for (const card of await cards.all()) {
    const style = await card.evaluate((element) => {
      const css = getComputedStyle(element);
      return { margin: parseFloat(css.marginLeft), border: parseFloat(css.borderLeftWidth) };
    });
    expect(style.margin).toBeGreaterThan(0);
    expect(style.border).toBeGreaterThan(0);
  }
});
