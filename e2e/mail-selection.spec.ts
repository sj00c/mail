import { expect, type Page } from "@playwright/test";
import { test, installAppMocks, TEST_ORIGIN } from "./fixtures/app.ts";

const messages = Array.from({ length: 80 }, (_, i) => ({
  id: `select-${i}`,
  threadId: `thread-${i}`,
  from: `Sender ${i} <sender-${i}@example.com>`,
  to: "test@example.com",
  cc: "",
  bcc: "",
  replyTo: "",
  references: "",
  inReplyTo: "",
  rfc822MsgId: `<select-${i}@example.com>`,
  subject: `Selection message ${i}`,
  snippet: "Keep this message in the same position",
  date: "2026-09-30T09:00:00.000Z",
  unread: false,
  labelIds: ["INBOX"],
  bodyHtml: null,
  bodyText: `Body ${i}`,
  hasAttachments: false,
  attachments: [],
}));
const checks = (page: Page) => page.locator('.msg-row [role="checkbox"]');
const actions = (page: Page) =>
  page.getByRole("button", { name: "선택한 메일 작업", exact: true });
async function open(page: Page, extra = {}) {
  const calls = await installAppMocks(page, {
    messages,
    totalEstimate: 200,
    bulkCount: 173,
    ...extra,
  });
  await page.goto("/");
  await expect(page.locator(".msg-row")).toHaveCount(80);
  return calls;
}

for (const width of [1440, 1200, 1000, 700, 390]) {
  test(`selection never moves message hit targets at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const target = checks(page).nth(1);
    const before = (await target.boundingBox())!;
    const toolbar = page.locator(".bulk-bar");
    const height = (await toolbar.boundingBox())!.height;
    const stable = async () => {
      const box = (await target.boundingBox())!;
      expect(Math.abs(box.y - before.y)).toBeLessThanOrEqual(1);
      expect(
        Math.abs((await toolbar.boundingBox())!.height - height),
      ).toBeLessThanOrEqual(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width + 1);
    };
    await checks(page).first().click();
    await stable();
    await page.mouse.click(
      before.x + before.width / 2,
      before.y + before.height / 2,
    );
    await expect(target).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".msg-row.active")).toHaveCount(0);
    await page
      .getByRole("checkbox", { name: "전체 선택", exact: true })
      .check();
    await stable();
    await actions(page).click();
    await page
      .getByRole("menuitem", { name: "받은편지함의 모든 메일 선택" })
      .click();
    await expect(page.locator(".bulk-count")).toHaveText(
      "받은편지함 전체 선택",
    );
    await stable();
    await page.getByRole("button", { name: "선택 해제" }).click();
    await stable();
    await expect(actions(page)).toBeDisabled();
    // The same invariant must hold when the sticky toolbar is detached from
    // its normal-flow position and rows are scrolled well below the first page.
    await checks(page).nth(25).scrollIntoViewIfNeeded();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(checks(page).nth(25)).toBeInViewport();
    const scrolled = (await checks(page).nth(25).boundingBox())!;
    await page.mouse.click(
      scrolled.x + scrolled.width / 2,
      scrolled.y + scrolled.height / 2,
    );
    await expect(checks(page).nth(25)).toHaveAttribute("aria-checked", "true");
    expect(
      Math.abs((await checks(page).nth(25).boundingBox())!.y - scrolled.y),
    ).toBeLessThanOrEqual(1);
    await checks(page)
      .nth(27)
      .click({ modifiers: ["Shift"] });
    await expect(checks(page).nth(26)).toHaveAttribute("aria-checked", "true");
    await checks(page).nth(26).press("Space");
    await expect(checks(page).nth(26)).toHaveAttribute("aria-checked", "false");
  });
}

test("action menu contains keyboard focus and preserves loaded-message API scope", async ({
  page,
}) => {
  const calls = await open(page);
  await page.locator(".msg-row").first().click();
  await checks(page).first().click();
  await checks(page).nth(1).click();
  await actions(page).focus();
  await actions(page).press("ArrowDown");
  const menu = page.getByRole("menu", { name: "선택한 메일 작업" });
  await expect(menu).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "읽음", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("e");
  await page.keyboard.press("j");
  await expect(page.locator(".reader")).toContainText("Selection message 0");
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "휴지통" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(actions(page)).toBeFocused();
  await expect(page.locator(".reader")).toContainText("Selection message 0");
  await actions(page).click();
  await page.getByRole("menuitem", { name: "안읽음", exact: true }).click();
  await expect
    .poll(() => calls.find((c) => c.path.endsWith("batchModify"))?.body)
    .toEqual({
      ids: ["select-0", "select-1"],
      add: ["UNREAD"],
    });
  await expect(actions(page)).toBeDisabled();
});

test("all-results cancellation never executes and failure restores controls", async ({
  page,
}) => {
  const calls = await open(page, { bulkConfirmError: true });
  const selectAllResults = async () => {
    await page
      .getByRole("checkbox", { name: "전체 선택", exact: true })
      .check();
    await actions(page).click();
    await page
      .getByRole("menuitem", { name: "받은편지함의 모든 메일 선택" })
      .click();
  };
  await selectAllResults();
  const prepare = () => calls.filter((c) => c.path.endsWith("bulkAll/prepare"));
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("173");
    void dialog.dismiss();
  });
  await actions(page).click();
  await page.getByRole("menuitem", { name: "휴지통" }).click();
  await expect.poll(() => prepare().length).toBe(1);
  await expect(actions(page)).toBeEnabled();
  expect(calls.filter((c) => c.path.endsWith("bulkAll/confirm"))).toHaveLength(
    0,
  );
  expect(prepare()[0].body).toEqual({ label: "INBOX", action: "trash" });
  page.once("dialog", (dialog) => void dialog.accept());
  await actions(page).click();
  await page.getByRole("menuitem", { name: "읽음", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(actions(page)).toBeEnabled();
  expect(calls.find((c) => c.path.endsWith("bulkAll/confirm"))?.body).toEqual({
    operationId: "synthetic-operation",
  });
  await page.getByRole("button", { name: "선택 해제" }).click();
  await expect(actions(page)).toBeDisabled();
});

test("menu dismisses with Tab, outside click and scope changes", async ({
  page,
}) => {
  await open(page);
  await checks(page).first().click();
  await actions(page).click();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "키보드 단축키" }),
  ).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await actions(page).click();
  await page.locator(".brand").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await actions(page).click();
  await page.getByRole("button", { name: /^별표/ }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("all-results execution stays busy until confirmed response and sends frozen operation once", async ({
  page,
}) => {
  const calls = await open(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `${TEST_ORIGIN}/api/messages/bulkAll/confirm`,
    async (route) => {
      await pending;
      await route.fallback();
    },
  );
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await actions(page).click();
  await page
    .getByRole("menuitem", { name: "받은편지함의 모든 메일 선택" })
    .click();
  page.once("dialog", (dialog) => void dialog.accept());
  await actions(page).click();
  await page.getByRole("menuitem", { name: "읽음", exact: true }).click();
  try {
    await expect(actions(page)).toBeDisabled();
    await expect(
      page.getByRole("checkbox", { name: "전체 선택", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "선택 해제" }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole("alert")).toContainText(
    "173개 메일 읽음 처리 완료",
  );
  await expect(
    page.getByRole("checkbox", { name: "전체 선택", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".bulk-count")).toHaveCount(0);
  expect(calls.filter((c) => c.path.endsWith("bulkAll/confirm"))).toHaveLength(
    1,
  );
});
