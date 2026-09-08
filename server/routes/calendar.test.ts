import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import * as calendar from "../calendar.ts";

vi.mock("../auth.ts");
vi.mock("../gmail.ts");
vi.mock("../calendar.ts");
vi.mock("../contacts.ts");
vi.mock("../drive.ts");

beforeEach(() => vi.resetAllMocks());
const request = (path: string, init?: RequestInit) =>
  createApp("/").request(`http://localhost/api/calendar${path}`, init);
const input = {
  calendarId: "primary",
  summary: "합성 일정",
  start: "2026-09-08T09:00:00+09:00",
  end: "2026-09-08T10:00:00+09:00",
  allDay: false,
  attendees: ["fixture@example.com"],
  createMeet: true,
};
const body = (method: string) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
});

describe("mounted calendar HTTP contracts", () => {
  it("passes a bounded date range to the existing service", async () => {
    vi.mocked(calendar.listEvents).mockResolvedValue([]);
    const from = "2026-09-01T00:00:00.000Z";
    const to = "2026-10-01T00:00:00.000Z";
    const response = await request(
      `/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&days=30`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(calendar.listEvents).toHaveBeenCalledWith({
      days: 30,
      timeMin: from,
      timeMax: to,
    });
  });

  it.each([
    ["days=Infinity", "days must be a number"],
    ["from=2026-09-01", "from and to must be provided together"],
    ["from=bad&to=2026-10-01", "from is not a valid date"],
    ["from=2026-09-01&to=bad", "to is not a valid date"],
  ])("rejects invalid range %s before the service", async (query, error) => {
    const response = await request(`/events?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(calendar.listEvents).not.toHaveBeenCalled();
  });

  it("trims search but rejects an empty query", async () => {
    vi.mocked(calendar.searchEvents).mockResolvedValue([]);
    expect((await request("/search?q=%20%20")).status).toBe(400);
    expect(calendar.searchEvents).not.toHaveBeenCalled();
    expect((await request("/search?q=%20meeting%20")).status).toBe(200);
    expect(calendar.searchEvents).toHaveBeenCalledWith("meeting");
  });

  it("keeps detail and deletion ID validation", async () => {
    expect((await request("/event?calendarId=primary")).status).toBe(400);
    expect(calendar.getEvent).not.toHaveBeenCalled();
    expect(
      (await request("/events/e-1/delete", { method: "POST" })).status,
    ).toBe(400);
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    vi.mocked(calendar.deleteEvent).mockResolvedValue(undefined);
    const response = await request("/events/e-1/delete?calendarId=primary", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calendar.deleteEvent).toHaveBeenCalledWith("primary", "e-1");
  });

  it("preserves create and update payloads including attendees and Meet intent", async () => {
    vi.mocked(calendar.createEvent).mockResolvedValue({ id: "e-1" });
    vi.mocked(calendar.updateEvent).mockResolvedValue(undefined);
    const created = await request("/events", body("POST"));
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: "e-1" });
    expect(calendar.createEvent).toHaveBeenCalledWith(input);
    const updated = await request("/events/e-1", body("PUT"));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ ok: true });
    expect(calendar.updateEvent).toHaveBeenCalledWith("e-1", input);
  });
});
