import { expect } from "@playwright/test";
import {
  installAppMocks,
  openMailbox,
  TEST_ORIGIN,
  test,
} from "./fixtures/app.ts";

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
  bodyHtml:
    '<p>NEWER-CONTRIBUTION</p><div class="gmail_quote"><p>OLDER-CONTRIBUTION</p></div>',
  bodyText: "NEWER-CONTRIBUTION",
};

test("reader retains source document CSS and external quoted history inside its sandbox", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mail.theme", "light"));
  await installAppMocks(page, { messages: [{
    ...older,
    bodyHtml: '<!doctype html><html><head><style>.qa-source{background:#123;color:#fff;padding:12px}</style></head><body><div class="qa-source">SOURCE DOCUMENT STYLE</div><p>Intro</p><div class="gmail_quote"><p>EXTERNAL READER HISTORY</p></div></body></html>',
  }] });
  await openMailbox(page);
  await page.locator(".msg-row").first().click();
  const frame = page.locator(".html-frame").contentFrame();
  await expect(frame.locator(".qa-source")).toHaveCSS("background-color", "rgb(17, 34, 51)");
  await expect(frame.locator(".qa-source")).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(frame.locator(".gmail_quote")).toContainText("EXTERNAL READER HISTORY");
});

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
  const cards = quotation.locator(":scope > .mail-fwd-message");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("NEWER-CONTRIBUTION");
  await expect(cards.nth(1)).toContainText("OLDER-CONTRIBUTION");
  const text = await quotation.innerText();
  expect(text.match(/OLDER-CONTRIBUTION/g)).toHaveLength(1);
  expect(text.match(/NEWER-CONTRIBUTION/g)).toHaveLength(1);
  for (const card of await cards.all()) {
    const style = await card.evaluate((element) => {
      const css = getComputedStyle(element);
      return {
        margin: parseFloat(css.marginLeft),
        border: parseFloat(css.borderLeftWidth),
      };
    });
    expect(style.margin).toBeGreaterThan(0);
    expect(style.border).toBeGreaterThan(0);
  }
});

for (const theme of ["light", "dark"] as const) {
  test(`forwarding in ${theme} preserves external history and portable send HTML`, async ({
    page,
  }, testInfo) => {
    const image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmioAAAAASUVORK5CYII=";
    const message = {
      ...newer,
      bodyHtml:
        "<p>NEWER-CONTRIBUTION</p>" +
        '<div class="gmail_quote"><p>EXTERNAL-HISTORY-NOT-IN-THREAD</p>' +
        '<a href="https://example.com/unique-source">Original source</a></div>' +
        '<div class="authored-panel" style="background:#123;color:#fff;padding:8px">AUTHOR-FORMATTING</div>' +
        '<img src="cid:source-image" width="24" height="24" alt="Synthetic attachment" onerror="window.unsafeForward=true">',
      hasAttachments: true,
      attachments: [
        {
          id: "image-part",
          filename: "source.png",
          mimeType: "image/png",
          size: Buffer.from(image, "base64").length,
          contentId: "source-image",
        },
      ],
    };
    await page.addInitScript((value) => {
      localStorage.setItem("mail.theme", value);
      localStorage.setItem("mail.undo.sec", "0");
    }, theme);
    await installAppMocks(page, { messages: [older, message] });
    await page.route(`${TEST_ORIGIN}/api/messages/*/attachments/*`, (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(image, "base64"),
      }),
    );
    let submitted:
      | {
          bodyHtml: string;
          body: string;
          attachments: { data: string; contentId: string }[];
        }
      | undefined;
    await page.route(`${TEST_ORIGIN}/api/send`, async (route) => {
      submitted = route.request().postDataJSON();
      await route.fulfill({
        json: { id: "sent-forward", threadId: "sent-thread" },
      });
    });
    await openMailbox(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByPlaceholder("Search").fill("전달 순서 확인");
    await page.getByPlaceholder("Search").press("Enter");
    await page.locator(".mail-card").first().click();
    await page
      .locator(".reader-popup")
      .getByRole("button", { name: /전달/ })
      .click();

    const quotation = page.locator('[contenteditable="true"] .mail-fwd-thread');
    await expect(quotation).toContainText("EXTERNAL-HISTORY-NOT-IN-THREAD");
    await expect(
      quotation.locator('img[alt="Synthetic attachment"]'),
    ).toHaveJSProperty("naturalWidth", 1);
    const contrast = await quotation.evaluate((element) => {
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return (
          channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
        );
      };
      const editor = getComputedStyle(
        element.closest('[contenteditable="true"]')!,
      );
      const bg = luminance(editor.backgroundColor);
      return [".mail-fwd-header", 'a[href="https://example.com/unique-source"]'].map(selector => {
        const fg = luminance(getComputedStyle(element.querySelector(selector)!).color);
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
    });
    for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({
      path: testInfo.outputPath(`forward-compose-${theme}.png`),
    });
    await page.getByPlaceholder("받는사람 추가").fill("recipient@example.com");
    await page.getByPlaceholder("받는사람 추가").press("Enter");
    await page.getByRole("button", { name: "보내기", exact: true }).click();
    await expect
      .poll(() => submitted?.bodyHtml)
      .toContain("EXTERNAL-HISTORY-NOT-IN-THREAD");
    const payload = submitted!;
    expect(payload.body).toContain("EXTERNAL-HISTORY-NOT-IN-THREAD");
    expect(payload.bodyHtml.indexOf("NEWER-CONTRIBUTION")).toBeLessThan(
      payload.bodyHtml.indexOf("OLDER-CONTRIBUTION"),
    );
    expect(payload.bodyHtml).not.toMatch(
      /blob:|onerror=|window\.unsafeForward/,
    );
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]!.data).toBe(image);
    expect(payload.bodyHtml).toContain(
      `cid:${payload.attachments[0]!.contentId}`,
    );
    const styles = await page.evaluate((html) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const wrappers = [
        ...doc.querySelectorAll<HTMLElement>(
          ".mail-fwd-message,.mail-fwd-header,.mail-fwd-summary",
        ),
      ];
      return {
        neutral: wrappers.every(
          (node) =>
            !node.style.color &&
            !node.style.backgroundColor &&
            !node.style.borderRadius,
        ),
        authored:
          doc.querySelector<HTMLElement>(".authored-panel")!.style.color,
        href: doc
          .querySelector('a[href="https://example.com/unique-source"]')
          ?.getAttribute("href"),
      };
    }, payload.bodyHtml);
    expect(styles.neutral).toBe(true);
    expect(styles.authored).toBe("rgb(255, 255, 255)");
    expect(styles.href).toBe("https://example.com/unique-source");
  });
}
