import { expect } from "@playwright/test";
import { test, installAppMocks, openMailbox } from "./fixtures/app.ts";

// 메일 열기(목록 클릭·검색 카드·좁은 화면)는 전부 중앙 팝업 리더로 뜬다.
const baseMessage = {
  to: "test@example.com",
  unread: false,
  cc: "",
  bcc: "",
  replyTo: "",
  references: "",
  inReplyTo: "",
  bodyHtml: null,
  hasAttachments: false,
  attachments: [] as unknown[],
};

const message1 = {
  ...baseMessage,
  id: "message-1",
  threadId: "thread-1",
  from: "GDG Event Platform <noreply@gdg.community.dev>",
  subject: "[TICKET CONFIRMATION] You're ready for GDG AI for Science",
  snippet: "Google Developer Groups",
  date: "2026-08-19T00:46:00.000Z",
  labelIds: ["INBOX"],
  rfc822MsgId: "<message-1@example.com>",
  bodyText: "Ticket confirmed.",
  hasAttachments: true,
  attachments: [
    {
      id: "att-1",
      filename:
        "google-gdg-ai-for-science-korea-presents-gdg-ai-for-science-korea-x-yonsei-university-ai-university-center-co-hosted-workshop-unlocking-ai-for-scientific-breakthroughs.ics",
      mimeType: "text/calendar",
      size: 1024,
    },
  ],
};

const message2 = {
  ...baseMessage,
  id: "message-2",
  threadId: "thread-2",
  from: "Second Sender <second@example.com>",
  subject: "Second unrelated message",
  snippet: "Second snippet",
  date: "2026-08-18T00:00:00.000Z",
  labelIds: ["INBOX"],
  rfc822MsgId: "<message-2@example.com>",
  bodyText: "Second body.",
};

const longRecipientMessage = {
  ...baseMessage,
  id: "message-long-recipient",
  threadId: "thread-long-recipient",
  from: "Sender <sender@example.com>",
  to: [
    "A Recipient Name That Is Deliberately Long For Responsive Header Coverage <recipient-with-an-extremely-long-address-local-part-that-must-wrap@example.com>",
    "Another Recipient With A Long Display Name <another-recipient-with-a-long-address@example.com>",
    ...Array.from(
      { length: 150 },
      (_, index) => `Recipient ${index} <recipient-${index}@example.com>`,
    ),
    "My Primary Account <test@example.com>",
  ].join(", "),
  subject: "Long recipient header",
  snippet: "Long recipient header",
  date: "2026-08-17T00:00:00.000Z",
  labelIds: ["INBOX"],
  rfc822MsgId: "<message-long-recipient@example.com>",
  bodyText: "Long recipient body.",
};

// popin 애니메이션(180ms) 동안 좌표가 움직인다 — boundingBox를 재기 전에
// 애니메이션이 끝난 걸 보장한다.
async function settle(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => {
    const el = document.querySelector(".reader-popup");
    return !!el && el.getAnimations().every((a) => a.playState === "finished");
  });
}

async function openSearchReader(page: import("@playwright/test").Page) {
  await page.getByPlaceholder("Search").fill("GDG");
  await page.getByPlaceholder("Search").press("Enter");
  await page.locator(".mail-card").filter({ hasText: "TICKET CONFIRMATION" }).click();
  await expect(page.locator(".reader-popup")).toBeVisible();
  await settle(page);
}

async function settleLayout(page: import("@playwright/test").Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

async function mailColumns(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const width = (selector: string) =>
      document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
        .width ?? 0;
    return {
      sidebar: width(".body:not(.calendar-mode) .sidebar"),
      list: width(".body:not(.calendar-mode) .list"),
      reader: width(".body:not(.calendar-mode) .reader"),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
}

test("attachment chip icons stay icon-sized inside the chip link", async ({ page }) => {
  await installAppMocks(page, { messages: [message1, message2] });
  await openMailbox(page);
  await openSearchReader(page);

  // .chip > svg 자식 선택자는 .chip-link 안의 아이콘에 닿지 않아, 첨부 아이콘이
  // SVG 기본 크기(300x150)로 부풀어 패널을 통째로 잡아먹던 버그.
  const clip = page.locator(".attachments .chip .chip-link svg");
  const drive = page.locator(".attachments .chip .chip-x svg");
  await expect(clip).toBeVisible();

  for (const icon of [clip, drive]) {
    const box = await icon.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(20);
    expect(box!.height).toBeLessThanOrEqual(20);
  }

  // 칩 전체도 한 줄짜리 높이여야 한다(아이콘이 부풀면 여기부터 무너진다).
  const chipBox = await page.locator(".attachments .chip").boundingBox();
  expect(chipBox!.height).toBeLessThanOrEqual(80);
});

test("popup opens centered at the contract size and clears the legacy width key", async ({ page }) => {
  await installAppMocks(page, { messages: [message1, message2] });
  await openMailbox(page);
  // 슬라이드오버 시절 폭 저장값은 첫 팝업 마운트 때 지워져야 한다.
  await page.evaluate(() => localStorage.setItem("mail.slideover.width", "700"));
  await openSearchReader(page);

  const viewport = page.viewportSize()!;
  const box = (await page.locator(".reader-popup").boundingBox())!;
  const expectedW = Math.min(860, viewport.width * 0.92);
  const expectedH = Math.min(viewport.height * 0.9, 1100);
  expect(Math.abs(box.width - expectedW)).toBeLessThanOrEqual(4);
  expect(Math.abs(box.height - expectedH)).toBeLessThanOrEqual(4);
  // 수평 중앙 정렬.
  expect(Math.abs(box.x - (viewport.width - box.width) / 2)).toBeLessThanOrEqual(4);

  expect(await page.evaluate(() => localStorage.getItem("mail.slideover.width"))).toBeNull();
});

test("fullscreen toggle fills the viewport and persists across reopen", async ({ page }) => {
  await installAppMocks(page, { messages: [message1, message2] });
  await openMailbox(page);
  await openSearchReader(page);

  const panel = page.locator(".reader-popup");
  const viewport = page.viewportSize()!;

  await page.getByRole("button", { name: "화면 가득 보기" }).click();
  const maxed = (await panel.boundingBox())!;
  expect(maxed.width).toBeGreaterThanOrEqual(viewport.width - 40);
  expect(maxed.height).toBeGreaterThanOrEqual(viewport.height - 40);
  expect(await page.evaluate(() => localStorage.getItem("mail.reader.fullscreen"))).toBe("1");

  // 닫았다 다시 열어도 화면 가득 상태가 유지된다.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await page.locator(".mail-card").filter({ hasText: "TICKET CONFIRMATION" }).click();
  await expect(panel).toBeVisible();
  await settle(page); // popin 스케일 애니메이션 중에 재면 폭이 2%쯤 작게 나온다
  const reopened = (await panel.boundingBox())!;
  expect(reopened.width).toBeGreaterThanOrEqual(viewport.width - 40);

  // 기본 크기로 돌리면 저장 키가 사라지고 크기도 돌아온다.
  await page.getByRole("button", { name: "기본 크기로" }).click();
  const restored = (await panel.boundingBox())!;
  expect(restored.width).toBeLessThanOrEqual(Math.min(860, viewport.width * 0.92) + 4);
  expect(await page.evaluate(() => localStorage.getItem("mail.reader.fullscreen"))).toBeNull();
});

test("Esc, backdrop click, and u each close in one step with results intact", async ({ page }) => {
  await installAppMocks(page, { messages: [message1, message2] });
  await openMailbox(page);
  await openSearchReader(page);
  const panel = page.locator(".reader-popup");
  const cards = page.locator(".mail-card");

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(cards).toHaveCount(2);
  await expect(page.getByPlaceholder("Search")).toHaveValue("GDG");

  await cards.filter({ hasText: "TICKET CONFIRMATION" }).click();
  await expect(panel).toBeVisible();
  await page.locator(".reader-popup-backdrop").click({ position: { x: 8, y: 8 } });
  await expect(panel).toHaveCount(0);
  await expect(cards).toHaveCount(2);

  await cards.filter({ hasText: "TICKET CONFIRMATION" }).click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("u");
  await expect(panel).toHaveCount(0);
  await expect(cards).toHaveCount(2);
  await expect(page.getByPlaceholder("Search")).toHaveValue("GDG");
});

test("j/k move between results while the popup stays open", async ({ page }) => {
  await installAppMocks(page, { messages: [message1, message2] });
  await openMailbox(page);
  await openSearchReader(page);
  const panel = page.locator(".reader-popup");
  await expect(panel).toContainText("TICKET CONFIRMATION");

  await page.keyboard.press("j");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Second unrelated message");

  await page.keyboard.press("k");
  await expect(panel).toContainText("TICKET CONFIRMATION");
});

test("wide-mode list click reads in the pane and e archives without a popup", async ({ page }) => {
  const calls = await installAppMocks(page, { messages: [message1, message2] });
  await openMailbox(page);
  // 빈 상태 안내 문구는 제거됐다 — 선택 전에는 패널이 비어 있다.
  await expect(page.locator(".reader")).not.toContainText("메일을 선택하세요");
  const rows = page.locator(".msg-row");
  await rows.filter({ hasText: "TICKET CONFIRMATION" }).click();
  // 넓은 화면 목록 클릭은 팝업이 아니라 오른쪽 패널로 읽는다.
  await expect(page.locator(".reader")).toContainText("TICKET CONFIRMATION");
  await expect(page.locator(".reader-popup")).toHaveCount(0);

  await page.keyboard.press("e");
  await expect(rows.filter({ hasText: "TICKET CONFIRMATION" })).toHaveCount(0);
  await expect(page.locator(".reader-popup")).toHaveCount(0);
  expect(
    calls.filter(({ method, path }) => method === "POST" && path.endsWith("/modify")),
  ).toHaveLength(1);
});

test("e in search results closes the popup but keeps the row listed", async ({ page }) => {
  await installAppMocks(page, { messages: [message1, message2] });
  await openMailbox(page);
  await openSearchReader(page);
  const panel = page.locator(".reader-popup");
  const cards = page.locator(".mail-card");

  await page.keyboard.press("e");
  // 검색 중 보관은 행을 지우지 않고, 리더는 원래 동작대로 닫힌다.
  await expect(panel).toHaveCount(0);
  await expect(cards).toHaveCount(2);
});

test("# trashes and removes the row from the pane view", async ({ page }) => {
  const calls = await installAppMocks(page, { messages: [message1, message2] });
  await openMailbox(page);
  const rows = page.locator(".msg-row");
  await rows.filter({ hasText: "TICKET CONFIRMATION" }).click();
  await expect(page.locator(".reader")).toContainText("TICKET CONFIRMATION");

  await page.keyboard.press("#");
  await expect(rows.filter({ hasText: "TICKET CONFIRMATION" })).toHaveCount(0);
  expect(
    calls.filter(({ method, path }) => method === "POST" && path.endsWith("/trash")),
  ).toHaveLength(1);
});

test("narrow viewport uses the same popup and restores the full-width list", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await installAppMocks(page, { messages: [message1, message2] });
  // ≤700px에서는 사이드바가 기본으로 접혀 openMailbox의 '메일' 탭 단언이
  // 닿지 않는다 — 목록 행이 뜨는 것으로 로드를 확인한다.
  await page.goto("/");
  const rows = page.locator(".msg-row");
  await expect(rows.first()).toBeVisible();
  await rows.filter({ hasText: "TICKET CONFIRMATION" }).click();
  const panel = page.locator(".reader-popup");
  await expect(panel).toBeVisible();
  await settle(page);

  const box = (await panel.boundingBox())!;
  expect(Math.abs(box.width - 700 * 0.92)).toBeLessThanOrEqual(4);

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(rows.first()).toBeVisible();
});

test("modal surfaces stack above the popup and their backdrop clicks stay theirs", async ({ page }) => {
  await installAppMocks(page, { messages: [message1, message2] });
  await openMailbox(page);
  await openSearchReader(page);
  const panel = page.locator(".reader-popup");

  // c → 작성창(.modal-backdrop, z 200)이 팝업(z 150) 위에 뜬다.
  await page.keyboard.press("c");
  const modal = page.locator(".modal-backdrop");
  await expect(modal).toBeVisible();
  const zModal = await modal.evaluate((el) => Number(getComputedStyle(el).zIndex));
  const zPopup = await page
    .locator(".reader-popup-backdrop")
    .evaluate((el) => Number(getComputedStyle(el).zIndex));
  expect(zModal).toBeGreaterThan(zPopup);

  // 모서리 클릭은 위층(작성창 배경)에 먹혀 작성창만 닫힌다 —
  // 스택이 뒤집혀 있으면 이 클릭이 팝업을 닫아 버린다.
  await modal.click({ position: { x: 8, y: 8 } });
  await expect(modal).toHaveCount(0);
  await expect(panel).toBeVisible();
});

test("mail side panes yield width to the reader before the popup breakpoint", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installAppMocks(page, { messages: [message1, message2] });
  await openMailbox(page);

  const wide = await mailColumns(page);
  await page.setViewportSize({ width: 1200, height: 900 });
  await settleLayout(page);
  const medium = await mailColumns(page);
  await page.setViewportSize({ width: 1000, height: 900 });
  await settleLayout(page);
  const compact = await mailColumns(page);

  expect(medium.sidebar).toBeLessThan(wide.sidebar);
  expect(compact.sidebar).toBeLessThan(medium.sidebar);
  expect(medium.list).toBeLessThan(wide.list);
  expect(compact.list).toBeLessThan(medium.list);
  // At 1000px the reader still owns most of the usable row, rather than
  // forcing a horizontal page scroll before the <=900px popup mode.
  expect(compact.reader).toBeGreaterThan(compact.list);
  expect(compact.reader).toBeGreaterThanOrEqual(compact.viewportWidth * 0.5);
  expect(compact.documentWidth).toBeLessThanOrEqual(compact.viewportWidth + 1);
});

test("long recipient headers stay bounded and mark the own address", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await installAppMocks(page, {
    profile: {
      email: "test@example.com",
      historyId: "1",
      messagesTotal: 1,
    },
    messages: [longRecipientMessage],
  });
  await openMailbox(page);
  await page.locator(".msg-row").click();
  await expect(page.locator(".reader")).toContainText("Long recipient header");
  const toSummary = page.locator(
    '.recipient-summary[data-recipient-kind="받는사람"]',
  );
  await expect(toSummary).toBeVisible();
  await expect(toSummary.locator(".recipient-toggle")).toBeVisible();
  await expect(page.getByText("Long recipient body.", { exact: true })).toBeInViewport();
  await expect(toSummary.locator(".recipient-self")).toBeVisible();

  expect(
    await toSummary.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("recipient-summary.png"),
    animations: "disabled",
  });

  await toSummary.locator(".recipient-toggle").click();
  const details = page.getByRole("region", {
    name: "받는사람 전체 주소",
  });
  await expect(details).toBeVisible();
  expect(await details.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect((await details.boundingBox())!.height).toBeLessThanOrEqual(280);
  await expect(page.getByText("Long recipient body.", { exact: true })).toBeInViewport();
  expect(
    await details.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  expect(
    (await details.boundingBox())!.width,
  ).toBeLessThanOrEqual((await page.locator(".reader").boundingBox())!.width);
  await expect(toSummary.locator(".recipient-self")).toBeVisible();
  await expect(toSummary.locator(".recipient-self-label")).toContainText("나");
  await expect(details.locator(".recipient-self-label")).toContainText("나");
  await test.info().attach("long-recipient-header", {
    body: await page.screenshot({
      path: test.info().outputPath("recipient-details.png"),
      fullPage: false,
      animations: "disabled",
    }),
    contentType: "image/png",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width + 1,
  );
  await toSummary.locator(".recipient-toggle").click();
  await expect(details).toBeHidden();
  await expect(page.getByText("Long recipient body.", { exact: true })).toBeInViewport();
});
