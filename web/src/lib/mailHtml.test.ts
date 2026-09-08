import { describe, expect, it, vi } from "vitest";
import type { MessageFull } from "../api.ts";
import { forwardMessageHtml } from "./mailHtml.ts";

function message(
  id: string,
  bodyHtml: string | null,
  bodyText = "",
  extra: Partial<MessageFull> = {},
): MessageFull {
  return {
    id,
    threadId: "thread",
    from: `${id}@example.com`,
    to: "me@example.com",
    subject: "Subject",
    snippet: "snippet must not be used",
    date: "2026-08-19T00:00:00.000Z",
    unread: false,
    labelIds: ["INBOX"],
    hasAttachments: false,
    cc: "",
    bcc: "",
    replyTo: "",
    references: "",
    rfc822MsgId: `<${id}@example.com>`,
    inReplyTo: "",
    bodyHtml,
    bodyText,
    attachments: [],
    ...extra,
  };
}

describe("forwardMessageHtml", () => {
  it("fails rather than substituting a shorter text alternative after a parser error", () => {
    const source = message("source", "<p>COMPLETE HTML HISTORY</p>", "SHORT TEXT");
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString").mockImplementation(() => {
      throw new Error("parser unavailable");
    });
    try {
      expect(() => forwardMessageHtml(source, [source])).toThrow("전달할 원문");
    } finally {
      parser.mockRestore();
    }
  });

  it("removes a complete duplicate quote represented by another thread message", () => {
    const older = message("older", "<p>OLDER</p>", "OLDER");
    const newer = message(
      "newer",
      '<p>NEWER</p><div class="gmail_quote"><p>OLDER</p></div>',
      "NEWER",
    );

    const html = forwardMessageHtml(newer, [older, newer]);

    expect(html).toContain("NEWER");
    expect(html).not.toContain("OLDER");
    expect(html).not.toContain("gmail_quote");
  });

  it("retains an external forwarded quote alongside the current intro", () => {
    const source = message(
      "source",
      '<p>Intro</p><div class="mail-fwd"><p>EXTERNAL HISTORY</p></div>',
    );
    const threadMessage = message("thread-message", "<p>THREAD MESSAGE</p>");

    const html = forwardMessageHtml(source, [threadMessage, source]);

    expect(html).toContain("Intro");
    expect(html).toContain("EXTERNAL HISTORY");
    expect(html).toContain("mail-fwd");
  });

  it("retains nested unknown quote content", () => {
    const source = message(
      "source",
      '<p>Intro</p><div class="gmail_quote"><blockquote type="cite"><p>EXTERNAL HISTORY</p></blockquote></div>',
    );
    const threadMessage = message("thread-message", "<p>THREAD MESSAGE</p>");

    const html = forwardMessageHtml(source, [threadMessage, source]);

    expect(html).toContain("EXTERNAL HISTORY");
    expect(html).toContain("blockquote");
  });

  it("does not remove a partially overlapping quote", () => {
    const older = message("older", "<p>KNOWN PART</p>");
    const newer = message(
      "newer",
      '<p>Intro</p><div class="gmail_quote"><p>KNOWN PART</p><p>UNKNOWN PART</p></div>',
    );

    const html = forwardMessageHtml(newer, [older, newer]);

    expect(html).toContain("KNOWN PART");
    expect(html).toContain("UNKNOWN PART");
    expect(html).toContain("gmail_quote");
  });

  it("keeps a quote with a unique link", () => {
    const older = message("older", "<p>Shared text</p>");
    const newer = message(
      "newer",
      '<p>Intro</p><div class="gmail_quote"><p><a href="https://unique.example/">Shared text</a></p></div>',
    );

    const html = forwardMessageHtml(newer, [older, newer]);

    expect(html).toContain("https://unique.example/");
  });

  it("keeps media even when the CID text is the same", () => {
    const older = message("older", "<p>Shared text</p>");
    const newer = message(
      "newer",
      '<p>Intro</p><div class="gmail_quote"><p>Shared text<img src="cid:shared"></p></div>',
    );

    const html = forwardMessageHtml(newer, [older, newer]);

    expect(html).toContain('src="cid:shared"');
  });

  it("preserves a single-message forwarded envelope", () => {
    const only = message(
      "only",
      '<p>Intro</p><div class="mail-fwd"><p>FORWARDED ENVELOPE</p></div>',
    );

    const html = forwardMessageHtml(only, [only]);

    expect(html).toContain("FORWARDED ENVELOPE");
    expect(html).toContain("mail-fwd");
  });

  it("does not fall back to the snippet when no body is loaded", () => {
    const source = message("source", null, "");

    expect(forwardMessageHtml(source, [source])).toBe("");
  });

  it("removes an adjacent attribution only with the proven duplicate", () => {
    const older = message("older", "<p>OLDER</p>");
    const newer = message(
      "newer",
      '<p>NEWER</p><div class="gmail_attr">On Monday, Older wrote:</div><div class="gmail_quote"><p>OLDER</p></div>',
    );
    const external = message(
      "external",
      '<p>NEWER</p><div class="gmail_attr">On Monday, Someone wrote:</div><div class="gmail_quote"><p>EXTERNAL</p></div>',
    );

    expect(forwardMessageHtml(newer, [older, newer])).not.toContain(
      "Older wrote",
    );
    expect(forwardMessageHtml(external, [older, external])).toContain(
      "Someone wrote",
    );
  });

  it("does not mutate the source message", () => {
    const older = message("older", "<p>OLDER</p>");
    const newer = message(
      "newer",
      '<p>NEWER</p><div class="gmail_quote"><p>OLDER</p></div>',
    );
    const original = newer.bodyHtml;

    forwardMessageHtml(newer, [older, newer]);

    expect(newer.bodyHtml).toBe(original);
  });

  it("keeps full-document body presentation on a fragment wrapper without global style", () => {
    const bodyHtml =
      "<!doctype html><html><head><style>body{color:red}</style></head>" +
      '<body style="font-size:14px" dir="rtl" lang="ar" bgcolor="#123" text="#fff">' +
      "<p>FULL DOCUMENT BODY</p></body></html>";
    const source = message("source", bodyHtml);

    const html = forwardMessageHtml(source, [source]);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const wrapper = doc.body.firstElementChild as HTMLElement;

    expect(html.toLowerCase()).not.toContain("<html");
    expect(html.toLowerCase()).not.toContain("<body");
    expect(html.toLowerCase()).not.toContain("<style");
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.style.fontSize).toBe("14px");
    expect(getComputedStyle(wrapper).backgroundColor).toBe("rgb(17, 34, 51)");
    expect(getComputedStyle(wrapper).color).toBe("rgb(255, 255, 255)");
    expect(wrapper.getAttribute("dir")).toBe("rtl");
    expect(wrapper.getAttribute("lang")).toBe("ar");
    expect(wrapper.getAttribute("bgcolor")).toBeNull();
    expect(wrapper.getAttribute("text")).toBeNull();
    expect(wrapper.textContent).toContain("FULL DOCUMENT BODY");
    expect(source.bodyHtml).toBe(bodyHtml);
  });

  it("does not let legacy body colors override corresponding inline CSS", () => {
    const source = message(
      "source",
      '<html><body style="background-color:#abc;color:#456" bgcolor="#123" text="#fff"><p>INLINE COLORS</p></body></html>',
    );

    const html = forwardMessageHtml(source, [source]);
    const wrapper = new DOMParser().parseFromString(html, "text/html").body
      .firstElementChild as HTMLElement;

    expect(getComputedStyle(wrapper).backgroundColor).toBe(
      "rgb(170, 187, 204)",
    );
    expect(getComputedStyle(wrapper).color).toBe("rgb(68, 85, 102)");
  });

  it("does not deduplicate text when a quote has distinct styling or emphasis", () => {
    const older = message("older", "<p>SAME TEXT</p>");
    const styled = message(
      "styled",
      '<p>Intro</p><div class="gmail_quote"><p style="background:#ff0"><strong>SAME TEXT</strong></p></div>',
    );

    const html = forwardMessageHtml(styled, [older, styled]);

    expect(html).toContain("gmail_quote");
    expect(html).toContain("SAME TEXT");
    expect(html).toContain("<strong>");
  });

  it("does not mutually prune quote-only messages", () => {
    const oldest = message(
      "oldest",
      '<div class="gmail_quote"><p>QUOTE-ONLY BODY</p></div>',
    );
    const newer = message(
      "newer",
      '<div class="gmail_quote"><p>QUOTE-ONLY BODY</p></div>',
    );
    const thread = [oldest, newer] as const;

    const combined =
      forwardMessageHtml(oldest, thread) + forwardMessageHtml(newer, thread);

    expect(combined).toContain("QUOTE-ONLY BODY");
    // Ambiguous wrapper differences may retain repetition; the original must
    // remain independently of how later messages are deduplicated.
    expect(forwardMessageHtml(oldest, thread)).toContain("QUOTE-ONLY BODY");
  });

  it("never removes an earlier quote based on a later matching plain body", () => {
    const older = message("older", '<div class="gmail_quote"><p>ORIGINAL</p></div>');
    const newer = message("newer", "<p>ORIGINAL</p>");
    expect(forwardMessageHtml(older, [older, newer])).toContain("ORIGINAL");
  });
});
