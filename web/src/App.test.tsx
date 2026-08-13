import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CalendarMetadataDiagnostic, DeferredViewBoundary } from "./App.tsx";

function BrokenView(): never {
  throw new Error("chunk failed");
}

afterEach(() => cleanup());

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
