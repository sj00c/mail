import { expect } from "@playwright/test";
import { test, installAppMocks, openMailbox } from "./fixtures/app.ts";

for (const theme of ["light", "dark"] as const) {
  test(`coherent ${theme} shell, compose, settings, calendar and Drive`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await installAppMocks(page, {
      messages: [
        {
          id: "design",
          threadId: "design-thread",
          from: "Studio Meridian <studio@example.com>",
          to: "My Account <test@example.com>",
          cc: "",
          bcc: "",
          replyTo: "",
          references: "",
          inReplyTo: "",
          subject: "A clearer workspace for your day",
          snippet: "Design review and next steps",
          date: "2026-09-30T09:00:00.000Z",
          unread: true,
          labelIds: ["INBOX", "UNREAD"],
          bodyHtml: null,
          bodyText:
            "Review the details, share your thoughts, and keep the conversation moving.",
          rfc822MsgId: "<design@example.com>",
          hasAttachments: false,
          attachments: [],
        },
      ],
    });
    await openMailbox(page);
    await page.locator(".msg-row").click();
    await expect(page.locator(".reader")).toContainText("Review the details");
    const capture = async (name: string) => {
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(1441);
      await page.screenshot({
        path: info.outputPath(`${name}-${theme}.png`),
        animations: "disabled",
      });
    };
    await capture("mail");
    await page.getByRole("button", { name: "새 메일", exact: true }).click();
    await expect(page.locator(".modal")).toBeVisible();
    await capture("compose");
    await page.locator(".modal-backdrop").click({ position: { x: 4, y: 4 } });
    await page.getByTitle("설정 (서명)").click();
    await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible();
    await capture("settings");
    await page.getByRole("button", { name: "설정 닫기" }).click();
    await page.getByRole("button", { name: "캘린더", exact: true }).click();
    await expect(page.locator(".calendar")).toBeVisible();
    await capture("calendar");
    await page.getByRole("button", { name: "드라이브", exact: true }).click();
    await expect(page.locator(".drive")).toBeVisible();
    await capture("drive");
  });
}
