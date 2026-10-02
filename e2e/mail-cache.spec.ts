import { expect } from "@playwright/test";
import { test, installAppMocks, openMailbox } from "./fixtures/app.ts";

const mail = (id: string, labelIds: string[]) => ({
  id,
  threadId: `thread-${id}`,
  from: `Sender ${id} <${id}@example.com>`,
  to: "My Account <test@example.com>",
  cc: "",
  bcc: "",
  replyTo: "",
  references: "",
  inReplyTo: "",
  rfc822MsgId: `<${id}@example.com>`,
  subject: `Subject ${id}`,
  snippet: `Snippet ${id}`,
  bodyText: `Body of ${id}`,
  bodyHtml: null,
  attachments: [],
  hasAttachments: false,
  date: "2026-09-30T09:00:00.000Z",
  unread: false,
  labelIds,
});

test("reopening mail and returning to a label reuse loaded data", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const all = [mail("one", ["INBOX"]), mail("two", ["INBOX"]), mail("star", ["STARRED"])];
  const calls = await installAppMocks(page, { messages: all });
  // The shared mock returns every message for any list; serve per label here.
  let releaseInbox: (() => void) | undefined;
  await page.route("**/api/messages?*", async (route) => {
    const label = new URL(route.request().url()).searchParams.get("label");
    if (label === "INBOX" && releaseInbox)
      await new Promise<void>((resolve) => {
        const release = releaseInbox!;
        releaseInbox = () => {
          release();
          resolve();
        };
      });
    const messages = all.filter((m) => !label || m.labelIds.includes(label));
    await route.fulfill({ json: { messages, resultSizeEstimate: messages.length } });
  });
  await openMailbox(page);
  const threadCalls = (id: string) =>
    calls.filter((c) => c.path === `/api/threads/thread-${id}`).length;

  // Hovering prefetches; the click then renders from the same request.
  const rowOne = page.locator(".msg-row", { hasText: "Subject one" });
  await rowOne.hover();
  await expect.poll(() => threadCalls("one")).toBe(1);
  await rowOne.click();
  await expect(page.locator(".reader")).toContainText("Body of one");
  await page.locator(".msg-row", { hasText: "Subject two" }).click();
  await expect(page.locator(".reader")).toContainText("Body of two");
  await rowOne.click();
  await expect(page.locator(".reader")).toContainText("Body of one");
  expect(threadCalls("one")).toBe(1);

  // Leaving and returning to the inbox shows its rows before the refetch lands.
  await page.locator(".label-row", { hasText: "별표" }).click();
  await expect(page.locator(".msg-row", { hasText: "Subject star" })).toBeVisible();
  await expect(page.locator(".msg-row", { hasText: "Subject one" })).toHaveCount(0);
  // Hold the inbox refetch: its cached rows must already be on screen.
  releaseInbox = () => {};
  await page.locator(".label-row", { hasText: "받은편지함" }).click();
  await expect(page.locator(".msg-row", { hasText: "Subject one" })).toBeVisible();
  await expect(page.locator(".msg-row", { hasText: "Subject two" })).toBeVisible();
  await expect(page.locator(".msg-row", { hasText: "Subject star" })).toHaveCount(0);
  releaseInbox();
  await expect(page.locator(".msg-row")).toHaveCount(2);
});
