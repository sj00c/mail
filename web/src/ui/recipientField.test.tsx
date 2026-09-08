import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact } from "../api.ts";
import { RecipientField } from "./recipientField.tsx";

function RecipientHarness({
  initial = "",
  suggestions,
}: {
  initial?: string;
  suggestions?: Contact[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <RecipientField
        label="받는사람"
        value={value}
        onChange={setValue}
        suggestions={suggestions}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RecipientField", () => {
  it("commits delimiter and blur input, then allows chip editing", () => {
    render(<RecipientHarness />);
    const input = screen.getByRole("textbox");

    fireEvent.change(input, {
      target: { value: "one@example.com; two@example.com" },
    });
    expect(screen.getByTestId("value")).toHaveTextContent("one@example.com");
    expect(input).toHaveValue(" two@example.com");

    fireEvent.blur(input);
    expect(screen.getByTestId("value")).toHaveTextContent(
      "one@example.com, two@example.com",
    );
    expect(input).toHaveValue("");

    fireEvent.click(screen.getByTitle("one@example.com (클릭하여 수정)"));
    expect(screen.getByTestId("value")).toHaveTextContent("two@example.com");
    expect(input).toHaveValue("one@example.com");

    fireEvent.change(input, { target: { value: "edited@example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("value")).toHaveTextContent(
      "two@example.com, edited@example.com",
    );
    expect(input).toHaveValue("");
  });

  it("excludes used contacts and selects a suggestion by mouse", () => {
    const suggestions: Contact[] = [
      { name: "Alice", email: "alice@example.com" },
      { name: "Aaron", email: "aaron@example.com" },
      { name: "Cara", email: "cara@example.com" },
    ];
    render(
      <RecipientHarness
        initial="Alice <alice@example.com>"
        suggestions={suggestions}
      />,
    );
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "a" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.textContent)).not.toContain(
      "Alicealice@example.com",
    );

    fireEvent.mouseDown(options[0]);
    expect(screen.getByTestId("value")).toHaveTextContent(
      "Alice <alice@example.com>, Aaron <aaron@example.com>",
    );
    expect(input).toHaveValue("");
  });

  it("supports Escape dismissal and arrow/Enter suggestion keyboard semantics", () => {
    const suggestions: Contact[] = [
      { name: "Aaron", email: "aaron@example.com" },
      { name: "Cara", email: "cara@example.com" },
    ];
    render(<RecipientHarness suggestions={suggestions} />);
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(input).toHaveValue("a");

    fireEvent.change(input, { target: { value: "ar" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("value")).toHaveTextContent(
      "Aaron <aaron@example.com>",
    );
    expect(input).toHaveValue("");
  });
});
