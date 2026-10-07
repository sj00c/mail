import { beforeEach, describe, expect, it, vi } from "vitest";

const { gmail, calendar, drive, people, getAuthedClient } = vi.hoisted(() => ({
  gmail: vi.fn(),
  calendar: vi.fn(),
  drive: vi.fn(),
  people: vi.fn(),
  getAuthedClient: vi.fn(),
}));

vi.mock("@googleapis/gmail", () => ({ gmail }));
vi.mock("@googleapis/calendar", () => ({ calendar }));
vi.mock("@googleapis/drive", () => ({ drive }));
vi.mock("@googleapis/people", () => ({ people }));
vi.mock("./auth.ts", () => ({ getAuthedClient }));

import { clearContactsCache, listContacts } from "./contacts.ts";
import { checkGoogleApis } from "./diagnostics.ts";

function googleError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const disabled = googleError(
  403,
  "People API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=123 then retry.",
);

describe("Google API diagnosis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearContactsCache();
    getAuthedClient.mockResolvedValue({ token: "test" });
    gmail.mockReturnValue({ users: { getProfile: vi.fn(async () => ({ data: {} })) } });
    calendar.mockReturnValue({ calendarList: { list: vi.fn(async () => ({ data: {} })) } });
    drive.mockReturnValue({ about: { get: vi.fn(async () => ({ data: {} })) } });
  });

  it("reports each API independently and classifies the failure", async () => {
    people.mockReturnValue({ people: { connections: { list: vi.fn(async () => Promise.reject(disabled)) } } });
    calendar.mockReturnValue({
      calendarList: { list: vi.fn(async () => Promise.reject(googleError(401, "invalid_grant"))) },
    });
    drive.mockReturnValue({
      about: { get: vi.fn(async () => Promise.reject(googleError(401, "invalid_client"))) },
    });

    const checks = await checkGoogleApis();

    expect(checks.gmail).toEqual({ ok: true });
    expect(checks.calendar).toMatchObject({ ok: false, reason: "auth", status: 401 });
    expect(checks.drive).toMatchObject({ ok: false, reason: "client", status: 401 });
    expect(checks.contacts).toMatchObject({ ok: false, reason: "disabled", status: 403 });
    expect(checks.contacts.ok === false && checks.contacts.message).toContain("people.googleapis.com");
  });

  it("turns contact suggestions off without repeating calls when the People API is disabled", async () => {
    const list = vi.fn(async () => Promise.reject(disabled));
    people.mockReturnValue({ people: { connections: { list } }, otherContacts: { list: vi.fn() } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(listContacts()).resolves.toEqual([]);
    await expect(listContacts()).resolves.toEqual([]);

    expect(list).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("still fails contacts for errors other than a disabled API", async () => {
    people.mockReturnValue({
      people: { connections: { list: vi.fn(async () => Promise.reject(googleError(500, "backend error"))) } },
      otherContacts: { list: vi.fn() },
    });

    await expect(listContacts()).rejects.toThrow("backend error");
  });
});
