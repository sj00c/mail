import { expect } from "@playwright/test";
import { test, installAppMocks, openMailbox } from "./fixtures/app.ts";

// Browser zoom (⌘+ / ⌘−) changes the CSS viewport: a 1440px window at 125%
// lays out as 1152 CSS px. The navigation sidebar and the message list must
// resize together — same scale factor, constant ratio — at every zoom step.
const SCREEN = 1440;
const ZOOMS = [0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5];

test("sidebar and message list scale in lockstep across browser zoom", async ({
  page,
}) => {
  await installAppMocks(page);
  const samples: { zoom: number; nav: number; list: number }[] = [];
  for (const zoom of ZOOMS) {
    await page.setViewportSize({
      width: Math.round(SCREEN / zoom),
      height: Math.round(900 / zoom),
    });
    if (!samples.length) await openMailbox(page);
    const nav = (await page.locator(".sidebar").boundingBox())!.width;
    const list = (await page.locator(".list").boundingBox())!.width;
    samples.push({ zoom, nav, list });
  }
  const ratios = samples.map((s) => s.list / s.nav);
  for (const ratio of ratios)
    expect(Math.abs(ratio - ratios[0])).toBeLessThan(0.01);
  // On-screen size is CSS px × zoom. Both panels must move the same way and by
  // the same factor at each step — never one frozen while the other changes.
  for (let i = 1; i < samples.length; i++) {
    const [a, b] = [samples[i - 1], samples[i]];
    const navFactor = (b.nav * b.zoom) / (a.nav * a.zoom);
    const listFactor = (b.list * b.zoom) / (a.list * a.zoom);
    expect(Math.abs(navFactor - listFactor)).toBeLessThan(0.01);
  }
  // At normal widths the panels are plain px, so zooming enlarges/shrinks them
  // on screen exactly like every other element.
  const at = (z: number) => samples.find((s) => s.zoom === z)!;
  expect(at(0.8).nav).toBeCloseTo(at(1).nav, 0);
  expect(at(0.9).nav).toBeCloseTo(at(1).nav, 0);
  expect(at(1.1).nav * 1.1).toBeGreaterThan(at(1).nav);

  // Drive shares the same sidebar track, so switching views never jumps.
  const mailNav = samples.at(-1)!.nav;
  await page.getByRole("button", { name: "드라이브", exact: true }).click();
  await expect(page.locator(".drive")).toBeVisible();
  expect((await page.locator(".sidebar").boundingBox())!.width).toBeCloseTo(
    mailNav,
    0,
  );
});
