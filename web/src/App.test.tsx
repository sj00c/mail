import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  App,
  CalendarMetadataDiagnostic,
  DeferredViewBoundary,
  userFacingError,
} from "./App.tsx";

const {
  authStatusMock,
  accountSettingsMock,
  profileMock,
  signatureMock,
  labelsMock,
  messagesMock,
  readerProbe,
} = vi.hoisted(() => ({
  authStatusMock: vi.fn(),
  accountSettingsMock: vi.fn(),
  profileMock: vi.fn(),
  signatureMock: vi.fn(),
  labelsMock: vi.fn(),
  messagesMock: vi.fn(),
  readerProbe: {
    ownAddresses: undefined as readonly string[] | undefined,
  },
}));

vi.mock("./api.ts", async () => {
  const actual = await vi.importActual<typeof import("./api.ts")>("./api.ts");
  return {
    ...actual,
    api: {
      ...actual.api,
      authStatus: authStatusMock,
      accountSettings: accountSettingsMock,
      profile: profileMock,
      signature: signatureMock,
      labels: labelsMock,
      messages: messagesMock,
    },
  };
});

vi.mock("./views/reader.tsx", async () => {
  const actual = await vi.importActual<typeof import("./views/reader.tsx")>(
    "./views/reader.tsx",
  );
  return {
    ...actual,
    Reader: ({ ownAddresses }: { ownAddresses: string[] }) => {
      readerProbe.ownAddresses = ownAddresses;
      return <div data-testid="reader-probe" />;
    },
  };
});

function BrokenView(): never {
  throw new Error("chunk failed");
}

afterEach(() => {
  cleanup();
  readerProbe.ownAddresses = undefined;
});

describe("DeferredViewBoundary", () => {
  it("clears a failed route when its reset key changes", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <DeferredViewBoundary resetKey="calendar">
        <BrokenView />
      </DeferredViewBoundary>,
    );

    expect(screen.getByText("화면을 불러오지 못했습니다.")).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveTextContent("오류 유형: Error");
    expect(consoleError).toHaveBeenCalled();

    rerender(
      <DeferredViewBoundary resetKey="drive">
        <div>drive loaded</div>
      </DeferredViewBoundary>,
    );

    expect(screen.getByText("drive loaded")).toBeTruthy();
    consoleError.mockRestore();
  });

  it("renders a local recovery surface when supplied", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <DeferredViewBoundary resetKey="event-editor" fallback={<button>편집기 닫기</button>}>
        <BrokenView />
      </DeferredViewBoundary>,
    );

    expect(screen.getByRole("button", { name: "편집기 닫기" })).toBeTruthy();
    consoleError.mockRestore();
  });
});

describe("CalendarMetadataDiagnostic", () => {
  it("renders the same non-sensitive status for missing and multiple primaries", () => {
    const { rerender } = render(<CalendarMetadataDiagnostic anomaly="missing" />);
    const expected = "기본 캘린더 정보를 확인할 수 없어 일반 캘린더로 표시합니다.";
    expect(screen.getByRole("status").textContent).toBe(expected);

    rerender(<CalendarMetadataDiagnostic anomaly="multiple" />);
    expect(screen.getByRole("status").textContent).toBe(expected);

    rerender(<CalendarMetadataDiagnostic anomaly={null} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("userFacingError", () => {
  it("replaces internal Gmail batch codes with actionable Korean messages", () => {
    expect(userFacingError("GMAIL_BATCH_PART_429_REQUEST_FAILED")).not.toContain("GMAIL_BATCH");
    expect(userFacingError("GMAIL_BATCH_PART_429_REQUEST_FAILED")).toContain("잠시");
  });

  it("preserves unrelated messages", () => {
    expect(userFacingError("파일 업로드 실패")).toBe("파일 업로드 실패");
  });
});

describe("App mailbox reader identity props", () => {
  it("keeps Reader ownAddresses stable across checkbox selection changes", async () => {
    const accountSettings = {
      sendAs: [
        {
          email: "alias@example.com",
          displayName: "Alias",
          replyTo: "",
          isPrimary: false,
          isDefault: false,
          verified: true,
        },
      ],
      vacation: { enabled: false, subject: "", endTime: null },
    };
    const message = {
      id: "message-1",
      threadId: "thread-1",
      from: "Sender <sender@example.com>",
      to: "primary@example.com",
      subject: "Test subject",
      snippet: "Test snippet",
      date: "2026-01-01T00:00:00.000Z",
      unread: false,
      labelIds: ["INBOX"],
      hasAttachments: false,
    };
    authStatusMock.mockReset().mockResolvedValue({ authed: true });
    accountSettingsMock.mockReset().mockResolvedValue(accountSettings);
    profileMock
      .mockReset()
      .mockResolvedValue({
        email: "primary@example.com",
        historyId: "history-1",
        messagesTotal: 1,
      });
    signatureMock.mockReset().mockResolvedValue({ html: "" });
    labelsMock.mockReset().mockResolvedValue([
      { id: "INBOX", name: "INBOX", type: "system", unread: 0, total: 1 },
    ]);
    messagesMock.mockReset().mockResolvedValue({
      messages: [message],
      resultSizeEstimate: 1,
    });

    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "matchMedia",
    );
    const scrollDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
      }),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {},
    });

    try {
      render(<App />);
      await screen.findByText("Test subject");
      fireEvent.click(screen.getByText("Test subject"));
      await screen.findByTestId("reader-probe");
      await waitFor(() =>
        expect(readerProbe.ownAddresses).toEqual([
          "primary@example.com",
          "alias@example.com",
        ]),
      );
      const initialAddresses = readerProbe.ownAddresses;

      const checkbox = screen.getByRole("checkbox", {
        name: "Sender 선택",
      });
      fireEvent.click(checkbox);
      await waitFor(() =>
        expect(checkbox).toHaveAttribute("aria-checked", "true"),
      );
      expect(readerProbe.ownAddresses).toBe(initialAddresses);

      fireEvent.click(checkbox);
      await waitFor(() =>
        expect(checkbox).toHaveAttribute("aria-checked", "false"),
      );
      expect(readerProbe.ownAddresses).toBe(initialAddresses);
    } finally {
      if (matchMediaDescriptor) {
        Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
      } else {
        Reflect.deleteProperty(window, "matchMedia");
      }
      if (scrollDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          scrollDescriptor,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });
});
