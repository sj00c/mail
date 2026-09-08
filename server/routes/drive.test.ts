import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import * as drive from "../drive.ts";

vi.mock("../auth.ts");
vi.mock("../gmail.ts");
vi.mock("../calendar.ts");
vi.mock("../contacts.ts");
vi.mock("../drive.ts");

beforeEach(() => vi.resetAllMocks());
const request = (path: string, init?: RequestInit) =>
  createApp("/").request(`http://localhost/api/drive${path}`, init);
const file: drive.DriveFile = {
  id: "file-1",
  name: "보고서.txt",
  mimeType: "text/plain",
  isFolder: false,
  size: 3,
  modifiedTime: "2026-09-08T00:00:00.000Z",
  iconLink: null,
  webViewLink: null,
  starred: false,
  shared: false,
  owned: true,
};
const jsonBody = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("mounted Drive HTTP contracts", () => {
  it("selects folder browsing or trimmed search without losing pagination", async () => {
    vi.mocked(drive.listFiles).mockResolvedValue({
      files: [file],
      nextPageToken: "next",
    });
    vi.mocked(drive.searchFiles).mockResolvedValue({ files: [] });
    const browse = await request("/files?folderId=folder-1&pageToken=page-1");
    expect(browse.status).toBe(200);
    expect(await browse.json()).toEqual({
      files: [file],
      nextPageToken: "next",
    });
    expect(drive.listFiles).toHaveBeenCalledWith({
      folderId: "folder-1",
      pageToken: "page-1",
    });
    const search = await request("/files?q=%20report%20&pageToken=page-2");
    expect(search.status).toBe(200);
    expect(drive.searchFiles).toHaveBeenCalledWith("report", "page-2");
    expect(drive.listFiles).toHaveBeenCalledTimes(1);
  });

  it("does not fetch a breadcrumb without a folder ID", async () => {
    const response = await request("/breadcrumb");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(drive.getBreadcrumb).not.toHaveBeenCalled();
  });

  it("preserves download bytes, MIME type and encoded filename", async () => {
    vi.mocked(drive.downloadFile).mockResolvedValue({
      buffer: Buffer.from([0, 127, 255]),
      filename: file.name,
      mimeType: file.mimeType,
    });
    const response = await request("/files/file-1/download");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.headers.get("Content-Disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      0, 127, 255,
    ]);
    expect(drive.downloadFile).toHaveBeenCalledWith("file-1");
  });

  it("rejects missing upload data before Google and preserves valid upload fields", async () => {
    expect(
      (await request("/upload", jsonBody({ name: "report" }))).status,
    ).toBe(400);
    expect(drive.uploadFile).not.toHaveBeenCalled();
    vi.mocked(drive.uploadFile).mockResolvedValue(file);
    const response = await request(
      "/upload",
      jsonBody({
        name: " 보고서.txt ",
        data: "AQID",
        mimeType: "text/plain",
        parentId: "folder-1",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(file);
    expect(drive.uploadFile).toHaveBeenCalledWith({
      name: "보고서.txt",
      data: "AQID",
      mimeType: "text/plain",
      parentId: "folder-1",
    });
  });

  it("keeps folder creation, rename and trash method contracts", async () => {
    vi.mocked(drive.createFolder).mockResolvedValue({
      ...file,
      isFolder: true,
      size: null,
    });
    vi.mocked(drive.renameFile).mockResolvedValue(file);
    vi.mocked(drive.trashFile).mockResolvedValue(undefined);
    expect((await request("/folders", jsonBody({ name: " " }))).status).toBe(
      400,
    );
    expect(drive.createFolder).not.toHaveBeenCalled();
    expect(
      (
        await request(
          "/folders",
          jsonBody({ name: " Folder ", parentId: "parent-1" }),
        )
      ).status,
    ).toBe(200);
    expect(drive.createFolder).toHaveBeenCalledWith("Folder", "parent-1");
    expect(
      (await request("/files/file-1", jsonBody({ name: " Report " }, "PUT")))
        .status,
    ).toBe(200);
    expect(drive.renameFile).toHaveBeenCalledWith("file-1", "Report");
    const trashed = await request("/files/file-1/trash", { method: "POST" });
    expect(await trashed.json()).toEqual({ ok: true });
    expect(drive.trashFile).toHaveBeenCalledWith("file-1");
  });

  it("retains the common API error policy after route extraction", async () => {
    vi.mocked(drive.getQuota).mockRejectedValue(
      new Error("private Drive details"),
    );
    const response = await request("/quota");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "INTERNAL_SERVER_ERROR" });
  });
});
