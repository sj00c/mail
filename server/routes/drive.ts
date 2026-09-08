import { Hono } from "hono";
import {
  listFiles,
  searchFiles,
  getBreadcrumb,
  getQuota,
  downloadFile,
  createFolder,
  trashFile,
  renameFile,
  uploadFile,
} from "../drive.ts";

export function createDriveRoutes(): Hono {
  const drive = new Hono();

  drive.get("/drive/quota", async (c) => c.json(await getQuota()));

  drive.get("/drive/files", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const pageToken = c.req.query("pageToken") || undefined;
    if (q) return c.json(await searchFiles(q, pageToken));
    const folderId = c.req.query("folderId") || undefined;
    return c.json(await listFiles({ folderId, pageToken }));
  });

  drive.get("/drive/breadcrumb", async (c) => {
    const folderId = c.req.query("folderId");
    if (!folderId) return c.json([]);
    return c.json(await getBreadcrumb(folderId));
  });

  drive.get("/drive/files/:id/download", async (c) => {
    const { buffer, filename, mimeType } = await downloadFile(
      c.req.param("id"),
    );
    // Header-safe ASCII fallback + RFC 5987 encoded full name (Korean filenames etc.).
    const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(filename).replace(
      /['()*]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": mimeType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      },
    });
  });

  drive.post("/drive/folders", async (c) => {
    const { name, parentId } = await c.req.json<{
      name?: string;
      parentId?: string;
    }>();
    if (!name?.trim()) return c.json({ error: "name required" }, 400);
    return c.json(await createFolder(name.trim(), parentId));
  });

  drive.post("/drive/upload", async (c) => {
    const body = await c.req.json<{
      name?: string;
      mimeType?: string;
      data?: string;
      parentId?: string;
    }>();
    if (!body.name?.trim() || typeof body.data !== "string")
      return c.json({ error: "name and data required" }, 400);
    return c.json(
      await uploadFile({
        name: body.name.trim(),
        mimeType: body.mimeType ?? "application/octet-stream",
        data: body.data,
        parentId: body.parentId,
      }),
    );
  });

  drive.put("/drive/files/:id", async (c) => {
    const { name } = await c.req.json<{ name?: string }>();
    if (!name?.trim()) return c.json({ error: "name required" }, 400);
    return c.json(await renameFile(c.req.param("id"), name.trim()));
  });

  drive.post("/drive/files/:id/trash", async (c) => {
    await trashFile(c.req.param("id"));
    return c.json({ ok: true });
  });

  return drive;
}
