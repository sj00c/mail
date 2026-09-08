import { describe, expect, it } from "vitest";
import { finiteOr } from "./params.ts";

describe("finite query parameters", () => {
  it.each([undefined, ""])("preserves an omitted query for %s", (value) => {
    expect(finiteOr(value, "days")).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ["0", 0],
    ["-2.5", -2.5],
    ["1e3", 1000],
    [" ", 0],
  ] as const)("preserves finite numeric conversion of %s", (raw, value) => {
    expect(finiteOr(raw, "days")).toEqual({ ok: true, value });
  });

  it.each(["NaN", "Infinity", "-Infinity", "not-a-number"])(
    "rejects %s before domain use",
    (value) => {
      expect(finiteOr(value, "days")).toEqual({
        ok: false,
        error: "days must be a number",
      });
    },
  );
});
