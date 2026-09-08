import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact } from "../api.ts";

const { fetchContacts } = vi.hoisted(() => ({ fetchContacts: vi.fn() }));
vi.mock("../api.ts", () => ({ api: { contacts: fetchContacts } }));

beforeEach(() => {
  fetchContacts.mockReset();
  vi.resetModules();
});

describe("shared contact loading", () => {
  it("coalesces concurrent consumers and reuses the settled result", async () => {
    let resolve!: (contacts: Contact[]) => void;
    fetchContacts.mockReturnValue(
      new Promise<Contact[]>((done) => {
        resolve = done;
      }),
    );
    const { loadContactsOnce } = await import("./contacts.ts");
    const compose = loadContactsOnce();
    const calendar = loadContactsOnce();
    expect(compose).toBe(calendar);
    expect(fetchContacts).toHaveBeenCalledTimes(1);
    const contacts = [{ name: "합성 연락처", email: "fixture@example.com" }];
    resolve(contacts);
    expect(await compose).toEqual(contacts);
    expect(await loadContactsOnce()).toEqual(contacts);
    expect(fetchContacts).toHaveBeenCalledTimes(1);
  });

  it("shares a failed attempt but retries on the next consumer", async () => {
    fetchContacts.mockRejectedValueOnce(
      new Error("temporary contacts failure"),
    );
    const { loadContactsOnce } = await import("./contacts.ts");
    const first = loadContactsOnce();
    const simultaneous = loadContactsOnce();
    expect(first).toBe(simultaneous);
    expect(await first).toEqual([]);
    expect(await simultaneous).toEqual([]);
    const contacts = [{ name: "Recovered", email: "recovered@example.com" }];
    fetchContacts.mockResolvedValueOnce(contacts);
    expect(await loadContactsOnce()).toEqual(contacts);
    expect(fetchContacts).toHaveBeenCalledTimes(2);
  });

  it("caches a successful empty address book rather than treating it as failure", async () => {
    fetchContacts.mockResolvedValue([]);
    const { loadContactsOnce } = await import("./contacts.ts");
    expect(await loadContactsOnce()).toEqual([]);
    expect(await loadContactsOnce()).toEqual([]);
    expect(fetchContacts).toHaveBeenCalledTimes(1);
  });
});
