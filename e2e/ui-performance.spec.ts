import { writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test, installAppMocks } from "./fixtures/app.ts";

// Lab measurements, not timing pass/fail thresholds. Run before and after with
// the same browser, viewport and synthetic data; never load private mail.
test("synthetic large mailbox interaction and recipient baseline", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const recipients = Array.from(
    { length: 400 },
    (_, i) => `Recipient ${i} <recipient-${i}@example.com>`,
  )
    .concat("My Account <test@example.com>")
    .join(", ");
  const messages = Array.from({ length: 500 }, (_, i) => ({
    id: `perf-${i}`,
    threadId: `perf-thread-${i}`,
    from: `Sender ${i} <sender-${i}@example.com>`,
    to: i === 0 ? recipients : "My Account <test@example.com>",
    cc: "",
    bcc: "",
    replyTo: "",
    references: "",
    inReplyTo: "",
    rfc822MsgId: `<perf-${i}@example.com>`,
    subject:
      i === 0 ? "Design review · Project Meridian" : `Project update ${i}`,
    snippet: "A focused workspace for messages, decisions and collaboration.",
    bodyText:
      "The next milestone is ready for review. Please confirm the final details before Friday.",
    bodyHtml: null,
    attachments: [],
    hasAttachments: false,
    date: "2026-09-30T09:00:00.000Z",
    unread: i % 3 === 0,
    labelIds: ["INBOX", ...(i % 3 === 0 ? ["UNREAD"] : [])],
  }));
  await installAppMocks(page, { messages });
  await page.goto("/");
  await expect(page.locator(".msg-row")).toHaveCount(500);
  await page.locator(".msg-row").first().click();
  await expect(
    page.getByText(
      "The next milestone is ready for review. Please confirm the final details before Friday.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("mail-light.png"),
    animations: "disabled",
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Performance.getMetrics");
  const metrics = await page.evaluate(async () => {
    const frame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const settle = async () => {
      await frame();
      await frame();
    };
    const rows = document.querySelectorAll<HTMLElement>(".msg-row");
    const check = rows[0].querySelector<HTMLElement>('[role="checkbox"]')!;
    const initialY = rows[1].getBoundingClientRect().y;
    const samples: number[] = [];
    const offsets: number[] = [];
    for (let i = 0; i < 12; i++) {
      const start = performance.now();
      check.click();
      await settle();
      samples.push(performance.now() - start);
      offsets.push(Math.abs(rows[1].getBoundingClientRect().y - initialY));
    }
    const list = document.querySelector<HTMLElement>(".list")!;
    const frames: number[] = [];
    let previous = performance.now();
    for (let i = 0; i < 60; i++) {
      list.scrollTop = ((list.scrollHeight - list.clientHeight) * i) / 59;
      await frame();
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
    }
    list.scrollTop = 0;
    const quantile = (values: number[], p: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return (
        Math.round(
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] *
            100,
        ) / 100
      );
    };
    return {
      workload: { messages: 500, recipients: 401, viewport: [1200, 900] },
      mountedRecipientAddresses:
        document.querySelectorAll(".recipient-address").length,
      domElements: document.querySelectorAll("*").length,
      selectionMaxRowShiftPx: Math.max(...offsets),
      selectionTwoFramesMedianMs: quantile(samples, 0.5),
      selectionTwoFramesP95Ms: quantile(samples, 0.95),
      scrollFrameMedianMs: quantile(frames, 0.5),
      scrollFrameP95Ms: quantile(frames, 0.95),
    };
  });
  const report = {
    ...metrics,
    jsHeapUsedBytes: heap.metrics.find((m) => m.name === "JSHeapUsedSize")
      ?.value,
    limitations:
      "Single Chromium synthetic lab sample. Two-frame timings include vsync; heap is a GC-assisted snapshot, not a leak proof or production benchmark.",
  };
  await writeFile(
    info.outputPath("metrics.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await page.getByRole("button", { name: "다크 모드로 전환" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: info.outputPath("mail-dark.png"),
    animations: "disabled",
  });
  expect(Number.isFinite(report.selectionTwoFramesP95Ms)).toBe(true);
  await cdp.detach();
});
