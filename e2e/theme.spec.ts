import { expect, test, type Page } from "@playwright/test";
import { installAppMocks, openMailbox } from "./fixtures/app.ts";

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
  // 배경을 지정하지 않은 메일 — 다크에서도 종이 위에 검은 글자로 읽혀야 한다.
  bodyHtml: "<p>Hello from an html mail without any background.</p>",
  hasAttachments: false,
  attachments: [] as unknown[],
};

const htmlTheme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const bg = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);

test("follows the OS scheme until the user picks one, then persists the pick across reloads", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installAppMocks(page, { messages: [message] });
  await openMailbox(page);
  expect(await htmlTheme(page)).toBe("dark");
  await expect(page.getByRole("button", { name: "라이트 모드로 전환" })).toBeVisible();

  await page.getByRole("button", { name: "라이트 모드로 전환" }).click();
  expect(await htmlTheme(page)).toBe("light");
  expect(await page.evaluate(() => localStorage.getItem("mail.theme"))).toBe("light");
  // 명시적으로 고른 뒤에는 OS가 바뀌어도 따라가지 않는다.
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await htmlTheme(page)).toBe("light");

  // 새로고침: React가 뜨기 전 인라인 스크립트가 같은 값을 미리 박아 둔다.
  await page.reload();
  await page.waitForFunction(() => !!document.documentElement.dataset.theme);
  expect(await htmlTheme(page)).toBe("light");
  await expect(page.getByRole("button", { name: "다크 모드로 전환" })).toBeVisible();
});

test("dark theme repaints the shell but keeps mail bodies on paper", async ({ page }) => {
  await installAppMocks(page, { messages: [message] });
  await openMailbox(page);
  const lightList = await bg(page, ".list");

  await page.getByRole("button", { name: "다크 모드로 전환" }).click();
  expect(await htmlTheme(page)).toBe("dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  const darkList = await bg(page, ".list");
  expect(darkList).not.toBe(lightList);
  expect(darkList).toBe("rgb(23, 27, 35)");

  await page.locator(".msg-row").first().click();
  const frame = page.locator(".html-frame");
  await expect(frame).toBeVisible();
  await expect(frame).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(frame).toHaveCSS("color-scheme", "light");
  const bodyColor = await frame.contentFrame().locator("body").evaluate((b) => getComputedStyle(b).color);
  expect(bodyColor).toBe("rgb(0, 0, 0)");
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
    return { bg: s.backgroundColor, ring: s.boxShadow, numBg: num.backgroundColor, numColor: num.color };
  });
  // 셀 바탕이 패널과 다르고(강조 틴트), 테두리는 반투명이 아닌 실선 강조색이다.
  expect(styles.bg).toBe("rgb(28, 39, 64)");
  expect(styles.ring).toContain("rgb(126, 166, 244)");
  expect(styles.ring).not.toMatch(/rgba\(/);
  expect(styles.numBg).toBe("rgb(126, 166, 244)");
  expect(styles.numColor).toBe("rgb(12, 20, 36)");
});

test("settings modal exposes system/light/dark and applies immediately", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installAppMocks(page);
  await openMailbox(page);
  await page.getByRole("button", { name: "설정 (서명)" }).click();
  const select = page.getByRole("combobox", { name: "테마" });
  await expect(select).toHaveValue("system");

  await select.selectOption("light");
  expect(await htmlTheme(page)).toBe("light");
  expect(await page.evaluate(() => localStorage.getItem("mail.theme"))).toBe("light");

  await select.selectOption("system");
  expect(await htmlTheme(page)).toBe("dark");
  expect(await page.evaluate(() => localStorage.getItem("mail.theme"))).toBeNull();

  // 시스템 따르기 상태에서는 OS 전환을 실시간으로 따라간다.
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => htmlTheme(page)).toBe("light");
});
