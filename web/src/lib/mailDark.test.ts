import { afterEach, describe, expect, it } from "vitest";
import { applyMailDarkMode } from "./mailDark.ts";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  document.body.innerHTML = "";
});

describe("dark mail presentation", () => {
  it("overrides nested white tables and important text colors without touching content or links", () => {
    document.body.innerHTML = `<table bgcolor="#fff" style="background:#fff!important"><tbody><tr><td style="color:black!important"><a href="https://example.com"><span>Read mail</span></a><p>No inline style</p></td></tr></tbody></table>`;
    const original = document.documentElement.outerHTML;
    restore = applyMailDarkMode(document);
    const cell = document.querySelector("td")!;
    expect(cell.style.color).toBe("rgb(230, 233, 239)");
    expect(cell.style.getPropertyPriority("color")).toBe("important");
    expect(document.querySelector("table")!.style.backgroundColor).toBe("transparent");
    expect(document.querySelector("span")!.style.color).toBe("rgb(138, 180, 248)");
    expect(document.querySelector("a")!.getAttribute("href")).toBe("https://example.com");
    expect(document.querySelector("p")!.textContent).toBe("No inline style");
    restore();
    restore = undefined;
    expect(document.documentElement.outerHTML).toBe(original);
  });

  it("preserves images, background image URLs, SVG fill and layout", () => {
    document.body.innerHTML = `<div style="padding:20px;display:none;background-image:url(https://example.com/logo.png)"><img src="cid:logo" style="width:80px;filter:none"><svg style="color:rgb(12,34,56)"><path fill="currentColor" d="M0 0h10v10z"/></svg></div>`;
    const original = document.documentElement.outerHTML;
    const image = document.querySelector("img")!;
    const source = image.getAttribute("src");
    const path = document.querySelector("path")!.outerHTML;
    restore = applyMailDarkMode(document);
    expect(image.getAttribute("src")).toBe(source);
    expect(image.style.width).toBe("80px");
    expect(image.style.filter).toBe("none");
    expect(image.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(document.querySelector("path")!.outerHTML).toBe(path);
    expect(document.querySelector("svg")!.style.color).toBe("rgb(12, 34, 56)");
    const container = document.querySelector("div")!;
    expect(container.style.backgroundImage).toContain("https://example.com/logo.png");
    expect(container.style.padding).toBe("20px");
    expect(container.style.display).toBe("none");
    restore();
    restore = undefined;
    expect(document.documentElement.outerHTML).toBe(original);
  });
});
