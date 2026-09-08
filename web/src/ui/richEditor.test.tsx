import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichEditor } from "./richEditor.tsx";

afterEach(() => cleanup());

describe("RichEditor", () => {
  it("retains contentEditable input when its parent rerenders", () => {
    const editorRef = createRef<HTMLDivElement>();
    const onFiles = vi.fn();
    const view = render(
      <RichEditor
        editorRef={editorRef}
        initialHtml="<p>initial</p>"
        onFiles={onFiles}
      />,
    );

    const editor = editorRef.current;
    expect(editor).not.toBeNull();
    editor!.innerHTML = "<p>typed</p>";
    fireEvent.input(editor!);

    view.rerender(
      <RichEditor
        editorRef={editorRef}
        initialHtml="<p>parent update</p>"
        onFiles={onFiles}
      />,
    );

    expect(editorRef.current?.innerHTML).toBe("<p>typed</p>");
  });

  it("keeps toolbar commands on the existing execCommand contract", () => {
    const execCommand = vi.fn(() => true);
    const previous = document.execCommand;
    const hadOwnProperty = Object.prototype.hasOwnProperty.call(
      document,
      "execCommand",
    );
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: execCommand,
    });

    try {
      const editorRef = createRef<HTMLDivElement>();
      render(
        <RichEditor editorRef={editorRef} initialHtml="" onFiles={vi.fn()} />,
      );

      fireEvent.click(screen.getByTitle("굵게"));

      expect(execCommand).toHaveBeenNthCalledWith(
        1,
        "styleWithCSS",
        false,
        "true",
      );
      expect(execCommand).toHaveBeenNthCalledWith(2, "bold", false, undefined);
    } finally {
      if (hadOwnProperty) {
        Object.defineProperty(document, "execCommand", {
          configurable: true,
          writable: true,
          value: previous,
        });
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  });

  it("forwards pasted image files but leaves text paste to the browser", () => {
    const editorRef = createRef<HTMLDivElement>();
    const onFiles = vi.fn();
    render(
      <RichEditor editorRef={editorRef} initialHtml="" onFiles={onFiles} />,
    );

    const image = new File(["image"], "pasted.png", { type: "image/png" });
    fireEvent.paste(editorRef.current!, {
      clipboardData: { files: [image] },
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles).toHaveBeenCalledWith([image]);

    fireEvent.paste(editorRef.current!, {
      clipboardData: { files: [] },
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
  });
});
