// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageFull } from "../api.ts";

const { threadMock, downloadAttachmentMock } = vi.hoisted(() => ({
  threadMock: vi.fn(),
  downloadAttachmentMock: vi.fn(),
}));

vi.mock("../api.ts", async () => {
  const actual = await vi.importActual<typeof import("../api.ts")>("../api.ts");
  return {
    ...actual,
    api: {
      ...actual.api,
      thread: threadMock,
      modify: vi.fn(),
      attachmentUrl: vi.fn(() => "/attachment"),
      attachmentToDrive: vi.fn(),
    },
  };
});

vi.mock("../lib/attachments.ts", async () => {
  const actual = await vi.importActual<typeof import("../lib/attachments.ts")>(
    "../lib/attachments.ts",
  );
  return {
    ...actual,
    downloadAttachment: downloadAttachmentMock,
    saveAttachment: vi.fn(),
  };
});

import { buildQuotedHtml, type ComposeInit } from "./compose.tsx";
import { Reader } from "./reader.tsx";

const makeMessage = (
  id: string,
  overrides: Partial<MessageFull> = {},
): MessageFull => ({
  id,
  threadId: "thread-1",
  from: `${id} Sender <${id}@example.com>`,
  to: "recipient@example.com",
  cc: "",
  bcc: "",
  replyTo: "",
  references: "",
  rfc822MsgId: `<${id}@example.com>`,
  inReplyTo: "",
  subject: "Thread subject",
  snippet: `${id} direct`,
  date: id === "old" ? "2026-01-01T00:00:00.000Z" : "2026-01-02T00:00:00.000Z",
  unread: false,
  labelIds: ["INBOX"],
  hasAttachments: false,
  bodyHtml: `<p>${id} direct</p>`,
  bodyText: null,
  attachments: [],
  ...overrides,
});

const renderReader = (
  onReply: (init: ComposeInit) => void,
  id = "new",
  ownAddresses: string[] = [],
) => {
  const guard = async (task: () => Promise<void>): Promise<void> => {
    try {
      await task();
    } catch {
      // The application guard renders action errors outside the reader.
    }
  };
  render(
    <Reader
      id={id}
      threadId="thread-1"
      ownAddresses={ownAddresses}
      inTrash={false}
      guard={guard}
      onPatched={vi.fn()}
      onRemoved={vi.fn()}
      onReply={onReply}
      onCreateEvent={vi.fn()}
      onClose={vi.fn()}
    />,
  );
};

beforeEach(() => {
  threadMock.mockReset();
  downloadAttachmentMock.mockReset();
  downloadAttachmentMock.mockImplementation(
    async (_messageId: string, a: MessageFull["attachments"][number]) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      contentId: a.contentId,
      data: "YmluYXJ5",
    }),
  );
});

afterEach(() => cleanup());

describe("Reader forwarding", () => {
  it("forwards every message newest-first with flat boundaries and namespaced CIDs", async () => {
    const old = makeMessage("old", {
      bodyHtml: '<p>old direct</p><img src="cid:shared">',
      attachments: [
        {
          id: "old-image",
          filename: "old.png",
          mimeType: "image/png",
          size: 12,
          contentId: "shared",
        },
      ],
    });
    const newest = makeMessage("new", {
      bodyHtml: '<p>new direct</p><img src="cid:shared">',
      attachments: [
        {
          id: "new-image",
          filename: "new.png",
          mimeType: "image/png",
          size: 24,
          contentId: "shared",
        },
      ],
    });
    threadMock.mockResolvedValue([old, newest]);
    const onReply = vi.fn();
    renderReader(onReply);

    await screen.findByRole("button", { name: "↪ 전달" });
    expect(screen.getAllByRole("button", { name: "↪ 전달" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "↪↪ 전체 전달" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "↪ 전달" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));

    const init = onReply.mock.calls[0][0] as {
      subject?: string;
      forward?: boolean;
      quoteHtml?: string;
      attachments?: { contentId?: string }[];
    };
    const quote = init.quoteHtml ?? "";
    expect(init.forward).toBe(true);
    expect(init.subject).toBe("Fwd: Thread subject");
    expect(quote.indexOf("new direct")).toBeLessThan(
      quote.indexOf("old direct"),
    );
    expect((quote.match(/new direct/g) ?? []).length).toBe(1);
    expect((quote.match(/old direct/g) ?? []).length).toBe(1);
    expect((quote.match(/class="mail-fwd-message"/g) ?? []).length).toBe(2);
    expect(quote).toContain("margin:16px 0 24px 12px");
    expect(quote).toContain("border-left:2px solid");
    expect(quote).toContain("Forwarded message");
    expect(quote).not.toMatch(/background:|border-radius:|;color:/);

    expect(
      downloadAttachmentMock.mock.calls.map(([messageId]) => messageId),
    ).toEqual(["new", "old"]);
    expect(init.attachments).toHaveLength(2);
    const cids = init.attachments?.map((a) => a.contentId ?? "") ?? [];
    expect(new Set(cids).size).toBe(2);
    for (const cid of cids) expect(quote).toContain(`cid:${cid}`);
  });

  it("uses the same whole-thread path for a one-message conversation", async () => {
    threadMock.mockResolvedValue([makeMessage("only", { subject: "Solo" })]);
    const onReply = vi.fn();
    renderReader(onReply, "only");

    await screen.findByRole("button", { name: "↪ 전달" });
    expect(screen.getAllByRole("button", { name: "↪ 전달" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "↪↪ 전체 전달" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "↪ 전달" }));
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));

    const init = onReply.mock.calls[0][0] as {
      quoteHtml?: string;
      forward?: boolean;
    };
    expect(init.forward).toBe(true);
    expect(init.quoteHtml).toContain("전달된 대화 · 1개 메일");
    expect(
      (init.quoteHtml?.match(/class="mail-fwd-message"/g) ?? []).length,
    ).toBe(1);
  });

  it("does not expose forwarding while the thread is loading or after it fails", async () => {
    let rejectThread!: (error: Error) => void;
    threadMock.mockReturnValue(
      new Promise<MessageFull[]>((_resolve, reject) => {
        rejectThread = reject;
      }),
    );
    const onReply = vi.fn();
    renderReader(onReply);

    expect(screen.getByText("불러오는 중…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "↪ 전달" })).toBeNull();
    await act(async () => rejectThread(new Error("thread unavailable")));
    expect(await screen.findByText("thread unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "↪ 전달" })).toBeNull();
    expect(onReply).not.toHaveBeenCalled();
  });

  it("does not create a partial forward when an attachment download fails", async () => {
    threadMock.mockResolvedValue([
      makeMessage("old", {
        attachments: [
          {
            id: "broken",
            filename: "broken.pdf",
            mimeType: "application/pdf",
            size: 1,
          },
        ],
      }),
      makeMessage("new"),
    ]);
    downloadAttachmentMock.mockRejectedValue(
      new Error("attachment unavailable"),
    );
    const onReply = vi.fn();
    renderReader(onReply);

    await screen.findByRole("button", { name: "↪ 전달" });
    fireEvent.click(screen.getByRole("button", { name: "↪ 전달" }));
    await waitFor(() => expect(downloadAttachmentMock).toHaveBeenCalled());
    expect(onReply).not.toHaveBeenCalled();
  });
});

describe("forward quote sanitization", () => {
  it("sanitizes active content while retaining forward CIDs and drops CIDs for replies", () => {
    const hostile =
      '<script>alert(1)</script><img src="cid:keep" onerror="alert(1)"><a href="javascript:alert(1)">bad</a>';
    const forwarded = buildQuotedHtml({ forward: true, quoteHtml: hostile });
    expect(forwarded).not.toContain("<script");
    expect(forwarded).not.toContain("onerror");
    expect(forwarded).not.toContain("javascript:");
    expect(forwarded).toContain('src="cid:keep"');

    const replied = buildQuotedHtml({ quoteHtml: hostile });
    expect(replied).not.toContain("cid:keep");
  });
});

describe("recipient headers", () => {
  it("keeps hundreds of recipients compact, exposes the late self address, and expands To/Cc independently", async () => {
    const to = [
      "First Recipient <first@example.com>",
      "Second Recipient <second@example.com>",
      ...Array.from(
        { length: 197 },
        (_unused, index) =>
          `Recipient ${index} <recipient-${index}@example.com>`,
      ),
      "Alias Person <AlIaS@Example.com>",
    ].join(", ");
    const cc = [
      "Copy One <copy-one@example.com>",
      "Copy Two <copy-two@example.com>",
      "Copy Three <copy-three@example.com>",
    ].join(", ");
    threadMock.mockResolvedValue([
      makeMessage("new", {
        from: "Primary Person <PRIMARY@Example.com>",
        to,
        cc,
        bodyHtml: null,
        bodyText: "body stays visible",
      }),
    ]);
    renderReader(vi.fn(), "new", ["primary@example.com", "alias@example.com"]);

    expect(await screen.findByText("body stays visible")).toBeInTheDocument();
    const toSummary = document.querySelector(
      '[data-recipient-kind="받는사람"]',
    ) as HTMLElement;
    const ccSummary = document.querySelector(
      '[data-recipient-kind="참조"]',
    ) as HTMLElement;
    expect(toSummary).toHaveTextContent("First Recipient");
    expect(toSummary).toHaveTextContent("Second Recipient");
    expect(toSummary).toHaveTextContent("Alias Person");
    expect(toSummary).toHaveTextContent("외 197명");
    expect(ccSummary).toHaveTextContent("외 1명");
    expect(
      (
        document.querySelector(
          '[aria-label="받는사람 전체 주소"]',
        ) as HTMLElement
      ).hidden,
    ).toBe(true);

    expect(
      document.querySelectorAll(".recipient-details .recipient-address"),
    ).toHaveLength(0);
    fireEvent.click(
      toSummary.querySelector(".recipient-toggle") as HTMLButtonElement,
    );
    expect(screen.getByText("body stays visible")).toBeInTheDocument();
    const toDetails = screen.getByRole("region", {
      name: "받는사람 전체 주소",
    });
    expect(toDetails).toHaveTextContent("Alias Person <AlIaS@Example.com>");
    const toRows = Array.from(
      toDetails.querySelectorAll(".recipient-address"),
    ).map((address) => address.textContent);
    expect(toRows[0]).toBe("First Recipient <first@example.com>");
    expect(toRows.at(-1)).toBe("Alias Person <AlIaS@Example.com>");
    expect(
      (
        ccSummary.querySelector(".recipient-toggle") as HTMLButtonElement
      ).getAttribute("aria-expanded"),
    ).toBe("false");

    fireEvent.click(
      ccSummary.querySelector(".recipient-toggle") as HTMLButtonElement,
    );
    expect(
      screen.getByRole("region", { name: "참조 전체 주소" }),
    ).toHaveTextContent("Copy Three <copy-three@example.com>");
    fireEvent.click(
      toSummary.querySelector(".recipient-toggle") as HTMLButtonElement,
    );
    expect(toDetails.querySelectorAll(".recipient-address")).toHaveLength(0);
    expect(screen.getByText("body stays visible")).toBeInTheDocument();
  });

  it("highlights primary and send-as identities by exact case-insensitive email only", async () => {
    threadMock.mockResolvedValue([
      makeMessage("new", {
        from: "Primary Person <PRIMARY@Example.com>",
        to: [
          "Same Name <other@example.com>",
          "Alias Person <ALIAS@Example.com>",
        ].join(", "),
        cc: "Same Name <different@example.com>",
        bodyHtml: null,
        bodyText: "identity body",
      }),
    ]);
    renderReader(vi.fn(), "new", ["primary@example.com", "alias@example.com"]);

    expect(await screen.findByText("identity body")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Primary Person <PRIMARY@Example.com> (나)",
      }),
    ).toBeInTheDocument();
    const alias = screen.getByRole("button", {
      name: "Alias Person <ALIAS@Example.com> (나)",
    });
    expect(alias).toBeInTheDocument();
    expect(alias.closest(".recipient-self")).not.toBeNull();
    expect(
      screen
        .getByRole("button", {
          name: "Same Name <other@example.com>",
        })
        .closest(".recipient-self"),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", {
          name: "Same Name <different@example.com>",
        })
        .closest(".recipient-self"),
    ).toBeNull();
    expect(screen.getAllByText("나").length).toBe(2);
  });
});

describe("thread folding", () => {
  it("allows a single message to fold independently from recipient details", async () => {
    threadMock.mockResolvedValue([
      makeMessage("only", {
        to: [
          "First <first@example.com>",
          "Second <second@example.com>",
          "Third <third@example.com>",
        ].join(", "),
        bodyHtml: null,
        bodyText: "single body",
      }),
    ]);
    renderReader(vi.fn(), "only");

    expect(await screen.findByText("single body")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("이 메일 접기"));
    expect(screen.queryByText("single body")).toBeNull();
    const peek = screen.getByRole("button", { name: /only direct/ });
    fireEvent.click(peek);
    expect(screen.getByText("single body")).toBeInTheDocument();

    const toSummary = document.querySelector(
      '[data-recipient-kind="받는사람"]',
    ) as HTMLElement;
    fireEvent.click(
      toSummary.querySelector(".recipient-toggle") as HTMLButtonElement,
    );
    expect(screen.getByText("single body")).toBeInTheDocument();
  });
});
