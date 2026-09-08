import { expect, type Page } from "@playwright/test";
import {
  test,
  TEST_ORIGIN,
  installAppMocks,
  openMailbox,
} from "./fixtures/app.ts";

// 라이트/다크 테마: 선호는 localStorage(mail.theme), 적용은 <html data-theme>.
const message = {
  id: "message-1",
  threadId: "thread-1",
  from: "Sender <sender@example.com>",
  to: "test@example.com",
  cc: "",
  bcc: "",
  replyTo: "",
  references: "",
  inReplyTo: "",
  subject: "Dark mode check",
  snippet: "Body",
  date: "2026-08-19T00:46:00.000Z",
  unread: false,
  labelIds: ["INBOX"],
  rfc822MsgId: "<message-1@example.com>",
  bodyText: null,
  // 배경이 없는 원문도 앱 테마와 무관하게 흰 종이 위에서 읽는다.
  bodyHtml: "<p>Hello from an html mail without any background.</p>",
  hasAttachments: false,
  attachments: [] as unknown[],
};

const htmlTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.theme);
const bg = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);

test("follows the OS scheme until the user picks one, then persists the pick across reloads", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installAppMocks(page, { messages: [message] });
  await openMailbox(page);
  expect(await htmlTheme(page)).toBe("dark");
  await expect(
    page.getByRole("button", { name: "라이트 모드로 전환" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "라이트 모드로 전환" }).click();
  expect(await htmlTheme(page)).toBe("light");
  expect(await page.evaluate(() => localStorage.getItem("mail.theme"))).toBe(
    "light",
  );
  // 명시적으로 고른 뒤에는 OS가 바뀌어도 따라가지 않는다.
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await htmlTheme(page)).toBe("light");

  // 새로고침: React가 뜨기 전 인라인 스크립트가 같은 값을 미리 박아 둔다.
  await page.reload();
  await page.waitForFunction(() => !!document.documentElement.dataset.theme);
  expect(await htmlTheme(page)).toBe("light");
  await expect(
    page.getByRole("button", { name: "다크 모드로 전환" }),
  ).toBeVisible();
});

test("app theme changes without recoloring or reloading received mail", async ({
  page,
}) => {
  await installAppMocks(page, { messages: [message] });
  await openMailbox(page);
  const lightList = await bg(page, ".list");

  await page.getByRole("button", { name: "다크 모드로 전환" }).click();
  expect(await htmlTheme(page)).toBe("dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  // 전환 직후 400ms는 색이 크로스페이드 중이다 — 끝 값으로 수렴할 때까지 기다린다.
  await expect(page.locator(".list").first()).toHaveCSS(
    "background-color",
    "rgb(23, 27, 35)",
  );
  expect(await bg(page, ".list")).not.toBe(lightList);
  await expect(page.locator("html")).not.toHaveClass(/theme-fade/);

  await page.locator(".msg-row").first().click();
  const frame = page.locator(".html-frame");
  await expect(frame).toBeVisible();
  await expect(frame).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(frame).toHaveCSS("color-scheme", "light");
  const body = frame.contentFrame().locator("body");
  await expect(body).toHaveCSS("color", "rgb(0, 0, 0)");
  // Switching the app theme must not reload or mutate the source document.
  await body.evaluate((b) => b.setAttribute("data-document-marker", "same"));
  const original = await body.evaluate(
    (b) => b.ownerDocument.documentElement.outerHTML,
  );
  await page.getByRole("button", { name: "라이트 모드로 전환" }).click();
  expect(await htmlTheme(page)).toBe("light");
  await expect(body).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(
    page.getByRole("button", { name: "원본 색상으로 보기", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "다크 모드로 전환" }).click();
  expect(await htmlTheme(page)).toBe("dark");
  await expect(body).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(body).toHaveAttribute("data-document-marker", "same");
  expect(
    await body.evaluate((b) => b.ownerDocument.documentElement.outerHTML),
  ).toBe(original);
  await expect(
    page.getByRole("button", { name: "다크 본문으로 보기", exact: true }),
  ).toHaveCount(0);
});

test("newsletter source colors and expanded quotes survive app theme changes", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("mail.theme", "dark"));
  const image =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='8' height='8' fill='red'/%3E%3C/svg%3E";
  const bodyHtml = `<body style="background:white!important;color:black">
    <table bgcolor="#ffffff" style="background-color:white!important;width:100%"><tr>
    <td style="color:black!important"><p>Newsletter text</p>
    <a href="https://example.com"><span>Read more</span></a>
    <img src="${image}" alt="Original logo">
    <svg width="20" height="20"><path fill="currentColor" d="M0 0h20v20H0z"/></svg>
    <details><summary>History</summary><p>Older text</p></details>
    </td></tr></table></body>`;
  await installAppMocks(page, { messages: [{ ...message, bodyHtml }] });
  await openMailbox(page);
  await page.locator(".msg-row").first().click();
  const frame = page.locator(".html-frame");
  const mail = frame.contentFrame();
  await expect(mail.locator("table")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(mail.locator("p").first()).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(mail.locator("a span")).toHaveCSS("color", "rgb(0, 0, 238)");
  await expect(mail.locator("img")).toHaveAttribute("src", image);
  await expect(mail.locator("img")).toHaveCSS("filter", "none");
  await expect(mail.locator("path")).toHaveCSS("fill", "rgb(0, 0, 0)");
  await expect(mail.locator("svg")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await page.screenshot({
    path: test.info().outputPath("dark-newsletter.png"),
  });
  await mail.locator("summary").click();
  const original = await mail
    .locator("body")
    .evaluate((b) => b.ownerDocument.documentElement.outerHTML);
  await page.getByRole("button", { name: "라이트 모드로 전환" }).click();
  await expect(mail.locator("table")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(mail.locator("p").first()).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(mail.locator("details")).toHaveAttribute("open", "");
  await expect(frame).toHaveAttribute(
    "sandbox",
    "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
  );
  await page.getByRole("button", { name: "다크 모드로 전환" }).click();
  await expect(mail.locator("details")).toHaveAttribute("open", "");
  expect(
    await mail
      .locator("body")
      .evaluate((b) => b.ownerDocument.documentElement.outerHTML),
  ).toBe(original);
});

test("a sender's dark background is preserved even in the light app theme", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("mail.theme", "light"));
  await installAppMocks(page, {
    messages: [
      {
        ...message,
        bodyHtml:
          '<body style="background:#102030;color:#fff"><p>Sender-designed colors</p></body>',
      },
    ],
  });
  await openMailbox(page);
  await page.locator(".msg-row").first().click();
  const body = page.locator(".html-frame").contentFrame().locator("body");
  await expect(body).toHaveCSS("background-color", "rgb(16, 32, 48)");
  await expect(body).toHaveCSS("color", "rgb(255, 255, 255)");
  const original = await body.getAttribute("style");
  await page.getByRole("button", { name: "다크 모드로 전환" }).click();
  await expect(body).toHaveCSS("background-color", "rgb(16, 32, 48)");
  await expect(body).toHaveAttribute("style", original!);
});

test("today's month cell is unmistakable in dark mode", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-04T12:00:00") });
  await page.addInitScript(() => localStorage.setItem("mail.theme", "dark"));
  await installAppMocks(page);
  await openMailbox(page);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  const today = page.locator(".month-cell.today");
  await expect(today).toHaveCount(1);
  const styles = await today.evaluate((cell) => {
    const s = getComputedStyle(cell);
    const num = getComputedStyle(cell.querySelector(".month-daynum")!);
    return {
      bg: s.backgroundColor,
      ring: s.boxShadow,
      numBg: num.backgroundColor,
      numColor: num.color,
    };
  });
  // 셀 바탕이 패널과 다르고(강조 틴트), 테두리는 반투명이 아닌 실선 강조색이다.
  expect(styles.bg).toBe("rgb(28, 39, 64)");
  expect(styles.ring).toContain("rgb(126, 166, 244)");
  expect(styles.ring).not.toMatch(/rgba\(/);
  expect(styles.numBg).toBe("rgb(126, 166, 244)");
  expect(styles.numColor).toBe("rgb(12, 20, 36)");
});

test("settings modal exposes system/light/dark and applies immediately", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installAppMocks(page);
  await openMailbox(page);
  await page.getByRole("button", { name: "설정 (서명)" }).click();
  const select = page.getByRole("combobox", { name: "테마" });
  await expect(select).toHaveValue("system");

  await select.selectOption("light");
  expect(await htmlTheme(page)).toBe("light");
  expect(await page.evaluate(() => localStorage.getItem("mail.theme"))).toBe(
    "light",
  );

  await select.selectOption("system");
  expect(await htmlTheme(page)).toBe("dark");
  expect(
    await page.evaluate(() => localStorage.getItem("mail.theme")),
  ).toBeNull();

  // 시스템 따르기 상태에서는 OS 전환을 실시간으로 따라간다.
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => htmlTheme(page)).toBe("light");
});

test("shared editor preserves formatting, inline images and signature across theme changes", async ({
  page,
}, testInfo) => {
  await installAppMocks(page);
  await openMailbox(page);
  await page.getByRole("button", { name: "설정 (서명)" }).click();
  const settings = page.getByRole("dialog", { name: "설정", exact: true });
  const editor = settings.locator(".rich-body");
  await editor.fill("Alpha Beta");
  await editor.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild!, 6);
    range.setEnd(element.firstChild!, 10);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await settings.getByTitle("굵게", { exact: true }).click();
  await expect(
    editor.locator("span[style*='font-weight'], b, strong"),
  ).toHaveText("Beta");
  await settings
    .getByTitle("글자 크기 (선택 영역 또는 이후 입력에 적용)")
    .dispatchEvent("mousedown");
  await settings
    .getByTitle("글자 크기 (선택 영역 또는 이후 입력에 적용)")
    .selectOption("5");
  await expect(editor).toHaveText("Alpha Beta");
  await editor.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.setAttribute("data-editor-proof", "same-document");
  });
  await settings.locator("input[type=file]").setInputFiles({
    name: "signature.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmioAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(editor.locator("img")).toHaveCount(1);
  await expect
    .poll(() =>
      editor
        .locator("img")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(1);
  const html = await editor.innerHTML();
  await settings
    .getByRole("combobox", { name: "테마", exact: true })
    .selectOption("dark");
  await expect(editor).toHaveAttribute("data-editor-proof", "same-document");
  expect(await editor.innerHTML()).toBe(html);
  await settings.getByRole("button", { name: "저장", exact: true }).click();
  await page.getByRole("button", { name: "새 메일", exact: true }).click();
  const signature = page.locator(".rich-body .mail-signature");
  await expect(signature).toHaveText("--Alpha Beta");
  await expect(signature.locator("img")).toHaveCount(1);
  await expect(
    signature.locator("span[style*='font-weight'], b, strong"),
  ).toHaveText("Beta");
  await page.screenshot({
    path: testInfo.outputPath("shared-editor-signature.png"),
  });
});

test("compose and calendar share contact cache and recipient keyboard behavior", async ({
  page,
}, testInfo) => {
  await installAppMocks(page);
  let contactRequests = 0;
  await page.route(`${TEST_ORIGIN}/api/contacts`, (route) => {
    contactRequests += 1;
    return route.fulfill({
      json: [{ name: "합성 연락처", email: "fixture@example.com" }],
    });
  });
  await openMailbox(page);
  await page.getByRole("button", { name: "새 메일", exact: true }).click();
  const recipient = page.getByPlaceholder("받는사람 추가");
  await recipient.fill("fixture");
  await expect(page.getByRole("listbox").getByRole("option")).toContainText(
    "fixture@example.com",
  );
  await recipient.press("ArrowDown");
  await recipient.press("Enter");
  await expect(page.locator(".recip-chip")).toContainText(
    "fixture@example.com",
  );
  expect(contactRequests).toBe(1);
  await page.locator(".modal-head .clear:not(.dlg-max)").click();
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await page.getByRole("button", { name: "새 일정", exact: true }).click();
  const event = page.getByRole("dialog", { name: "새 일정", exact: true });
  await event
    .getByRole("button", { name: /장소 · 참석자 · 알림 · 설명/ })
    .click();
  const attendee = event.getByPlaceholder("참석자 추가");
  await attendee.fill("fixture");
  await expect(event.getByRole("listbox").getByRole("option")).toContainText(
    "fixture@example.com",
  );
  await attendee.press("ArrowDown");
  await attendee.press("Enter");
  await expect(event.locator(".recip-chip")).toContainText(
    "fixture@example.com",
  );
  expect(contactRequests).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("shared-recipient-calendar.png"),
  });
  page.once("dialog", (dialog) => dialog.accept());
  await event.getByRole("button", { name: "취소", exact: true }).click();
  await expect(event).toHaveCount(0);
});
