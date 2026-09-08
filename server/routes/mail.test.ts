import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import * as gmail from "../gmail.ts";
import * as calendar from "../calendar.ts";
import * as drive from "../drive.ts";

vi.mock("../auth.ts");
vi.mock("../gmail.ts");
vi.mock("../calendar.ts");
vi.mock("../contacts.ts");
vi.mock("../drive.ts");

beforeEach(() => vi.resetAllMocks());
const request = (path: string, init?: RequestInit) =>
  createApp("/").request(`http://localhost/api${path}`, init);
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("mounted mail HTTP contracts", () => {
  it("mounts profile and list at their original API paths", async () => {
    const profile = {
      email: "fixture@example.com",
      historyId: "7",
      messagesTotal: 9,
    };
    vi.mocked(gmail.getProfile).mockResolvedValue(profile);
    vi.mocked(gmail.listMessages).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });
    const response = await request("/profile");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(profile);
    const list = await request("/messages?maxResults=1&label=INBOX");
    expect(list.status).toBe(200);
    expect(gmail.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 1, labelIds: ["INBOX"] }),
    );
  });

  it("rejects invalid list bounds through the mounted app without calling Google", async () => {
    const response = await request("/messages?maxResults=501");
    expect(response.status).toBe(400);
    expect(gmail.listMessages).not.toHaveBeenCalled();
  });

  it.each(["/profile", "/calendar/events", "/drive/files"])(
    "guards %s before domain dispatch",
    async (path) => {
      const response = await request(path, {
        headers: { Origin: "https://foreign.invalid" },
      });
      expect(response.status).toBe(403);
      expect(gmail.getProfile).not.toHaveBeenCalled();
      expect(calendar.listEvents).not.toHaveBeenCalled();
      expect(drive.listFiles).not.toHaveBeenCalled();
    },
  );

  it("preserves attachment bytes and header-safe Korean filenames", async () => {
    vi.mocked(gmail.getAttachment).mockResolvedValue(
      Buffer.from([0, 128, 255]),
    );
    const filename = '한글 "파일".bin';
    const response = await request(
      `/messages/m-1/attachments/a-1?filename=${encodeURIComponent(filename)}`,
    );
    expect(response.status).toBe(200);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      0, 128, 255,
    ]);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("Content-Disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    expect(response.headers.get("Content-Disposition")).not.toMatch(/[\r\n]/);
    expect(gmail.getAttachment).toHaveBeenCalledWith("m-1", "a-1");
  });

  it("keeps attachment-to-Drive orchestration in the mail path", async () => {
    vi.mocked(gmail.getAttachment).mockResolvedValue(
      Buffer.from("fixture bytes"),
    );
    const uploaded: drive.DriveFile = {
      id: "drive-file",
      name: "note.txt",
      mimeType: "text/plain",
      size: 13,
      isFolder: false,
      modifiedTime: "2026-09-08T00:00:00.000Z",
      iconLink: null,
      webViewLink: null,
      starred: false,
      shared: false,
      owned: true,
    };
    vi.mocked(drive.uploadFile).mockResolvedValue(uploaded);
    const response = await request(
      "/messages/m-1/attachments/a-1/drive",
      post({ filename: "note.txt", mimeType: "text/plain" }),
    );
    expect(response.status).toBe(200);
    expect(drive.uploadFile).toHaveBeenCalledWith({
      name: "note.txt",
      mimeType: "text/plain",
      data: Buffer.from("fixture bytes").toString("base64"),
    });
    expect(await response.json()).toEqual(uploaded);
  });

  it("preserves the typed missing-draft response on lookup and update", async () => {
    vi.mocked(gmail.findDraftByMessageId).mockResolvedValue(null);
    const lookup = await request("/drafts/by-message/m-1");
    expect(lookup.status).toBe(404);
    expect(await lookup.json()).toEqual({ error: "DRAFT_NOT_FOUND" });
    vi.mocked(gmail.updateDraft).mockRejectedValue(
      Object.assign(new Error("upstream missing"), {
        response: { status: 404 },
      }),
    );
    const update = await request("/drafts/d-1", {
      ...post({ subject: "Preserved" }),
      method: "PUT",
    });
    expect(update.status).toBe(404);
    expect(await update.json()).toEqual({ error: "DRAFT_NOT_FOUND" });
  });

  it.each([
    ["NOT_AUTHENTICATED", 401, "NOT_AUTHENTICATED"],
    ["private upstream information", 500, "INTERNAL_SERVER_ERROR"],
  ] as const)(
    "preserves common error mapping for %s",
    async (message, status, publicMessage) => {
      vi.mocked(gmail.getProfile).mockRejectedValue(new Error(message));
      const response = await request("/profile");
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: publicMessage });
    },
  );

  it("keeps unknown API routes as JSON 404 rather than SPA HTML", async () => {
    const response = await request("/unknown-cleanup-contract");
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });
});
