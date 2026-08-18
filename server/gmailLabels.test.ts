import { describe, expect, it } from "vitest";
import { listLabelsWithTransport } from "./gmail.ts";

describe("listLabelsWithTransport", () => {
  it("bounds unread-count requests to five concurrent calls and preserves order", async () => {
    const labels = Array.from({ length: 12 }, (_, index) => ({
      id: `label-${index}`,
      name: `Label ${index}`,
      type: "user",
    }));
    let active = 0;
    let peak = 0;
    const result = await listLabelsWithTransport(labels, async (id) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return Number(id.slice("label-".length));
    });

    expect(peak).toBeLessThanOrEqual(5);
    expect(result.map((label) => label.id)).toEqual(labels.map((label) => label.id));
    expect(result.map((label) => label.unread)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it("ignores only missing labels and propagates quota failures", async () => {
    await expect(listLabelsWithTransport(
      [{ id: "gone", name: "Gone", type: "user" }],
      async () => {
        throw Object.assign(new Error("gone"), { status: 404 });
      },
    )).resolves.toEqual([{ id: "gone", name: "Gone", type: "user", unread: 0 }]);

    await expect(listLabelsWithTransport(
      [{ id: "limited", name: "Limited", type: "user" }],
      async () => {
        throw Object.assign(new Error("limited"), { status: 429 });
      },
    )).rejects.toMatchObject({ status: 429 });
  });
});
