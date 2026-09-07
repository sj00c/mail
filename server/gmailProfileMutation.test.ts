import { beforeEach, describe, expect, it, vi } from "vitest";

const { gmail, getAuthedClient } = vi.hoisted(() => ({
  gmail: vi.fn(),
  getAuthedClient: vi.fn(),
}));

vi.mock("@googleapis/gmail", () => ({ gmail }));
vi.mock("./auth.ts", () => ({ getAuthedClient }));

import {
  batchModifyMessages,
  getProfile,
  listLabels,
} from "./gmail.ts";

describe("Gmail profile, labels, and mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthedClient.mockResolvedValue({ token: "test" });
  });

  it("maps profile counts and history from one users.getProfile call", async () => {
    const getProfileRpc = vi.fn(async () => ({
      data: {
        emailAddress: "user@example.test",
        historyId: "history-42",
        messagesTotal: 123,
      },
    }));
    gmail.mockReturnValue({ users: { getProfile: getProfileRpc } });

    await expect(getProfile()).resolves.toEqual({
      email: "user@example.test",
      historyId: "history-42",
      messagesTotal: 123,
    });
    expect(getProfileRpc).toHaveBeenCalledTimes(1);
    expect(getProfileRpc).toHaveBeenCalledWith({ userId: "me" });
  });

  it("gets unread and total in one labels.get call per displayed label", async () => {
    const list = vi.fn(async () => ({
      data: {
        labels: [
          { id: "INBOX", name: "Inbox", type: "system" },
          { id: "work", name: "Work", type: "user" },
        ],
      },
    }));
    const get = vi.fn(async ({ id }: { id: string }) => ({
      data: id === "INBOX"
        ? { messagesUnread: 2, messagesTotal: 8 }
        : { messagesUnread: 5, messagesTotal: 17 },
    }));
    gmail.mockReturnValue({ users: { labels: { list, get } } });

    await expect(listLabels()).resolves.toEqual([
      { id: "INBOX", name: "Inbox", type: "system", unread: 2, total: 8 },
      { id: "work", name: "Work", type: "user", unread: 5, total: 17 },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith({
      userId: "me",
      id: "INBOX",
      fields: "messagesUnread,messagesTotal",
    });
    expect(get).toHaveBeenCalledWith({
      userId: "me",
      id: "work",
      fields: "messagesUnread,messagesTotal",
    });
  });

  it("uses messages.modify for one id and batchModify for multiple ids", async () => {
    const modify = vi.fn(async () => ({ data: {} }));
    const batchModify = vi.fn(async () => ({ data: {} }));
    gmail.mockReturnValue({ users: { messages: { modify, batchModify } } });

    await batchModifyMessages(["one"], { add: ["STARRED"], remove: ["UNREAD"] });
    expect(modify).toHaveBeenCalledTimes(1);
    expect(modify).toHaveBeenCalledWith({
      userId: "me",
      id: "one",
      requestBody: { addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] },
    });
    expect(batchModify).not.toHaveBeenCalled();

    await batchModifyMessages(["one", "two"], { add: ["STARRED"] });
    expect(batchModify).toHaveBeenCalledTimes(1);
    expect(batchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { ids: ["one", "two"], addLabelIds: ["STARRED"], removeLabelIds: undefined },
    });
  });
});
