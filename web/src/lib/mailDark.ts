// Presentation only: never rewrite stored mail, sent HTML, images, or link targets.
// Inline !important wins over sender styles (including inline !important/bgcolor).
// Restore the exact attributes instead of trying to reverse a color conversion.
export function applyMailDarkMode(doc: Document): () => void {
  const originals: Array<[HTMLElement | SVGElement, string | null]> = [];
  // Transparent images and currentColor SVG logos need their original backing,
  // otherwise a black logo disappears on the dark body. Never invert pixels.
  if (doc.defaultView) {
    const view = doc.defaultView;
    const media = Array.from(doc.querySelectorAll<HTMLElement | SVGElement>("img, svg, video, canvas"), (el) => {
      let background = "#ffffff";
      for (let parent: Element | null = el; parent; parent = parent.parentElement) {
        const color = view.getComputedStyle(parent).backgroundColor;
        if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
          background = color;
          break;
        }
      }
      return { el, background, color: view.getComputedStyle(el).color };
    });
    for (const { el, background, color } of media) {
      originals.push([el, el.getAttribute("style")]);
      el.style.setProperty("background-color", background, "important");
      if (el.tagName.toLowerCase() === "svg") el.style.setProperty("color", color, "important");
    }
  }
  for (const node of doc.querySelectorAll("html, body, body *")) {
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
    if (["IMG", "PICTURE", "VIDEO", "CANVAS", "SOURCE"].includes(node.tagName)) continue;
    const el = node as HTMLElement;
    originals.push([el, el.getAttribute("style")]);
    const root = el === doc.documentElement || el === doc.body;
    el.style.setProperty("background-color", root ? "#171b23" : "transparent", "important");
    el.style.setProperty("color", el.closest("a[href]") ? "#8ab4f8" : "#e6e9ef", "important");
    el.style.setProperty("border-color", "#353d4b", "important");
    el.style.setProperty("text-shadow", "none", "important");
    el.style.setProperty("-webkit-text-fill-color", "currentColor", "important");
    if (root) el.style.setProperty("color-scheme", "dark", "important");
  }
  return () => {
    for (const [el, style] of originals) {
      if (style === null) el.removeAttribute("style");
      else el.setAttribute("style", style);
    }
  };
}
