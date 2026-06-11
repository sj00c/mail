import { drive as driveApi, type drive_v3 } from "@googleapis/drive";
import { Readable } from "node:stream";
import { getAuthedClient } from "./auth.ts";

async function api(): Promise<drive_v3.Drive> {
  const auth = await getAuthedClient();
  return driveApi({ version: "v3", auth });
}

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  size: number | null; // null for folders / native Google Docs
  modifiedTime: string;
  iconLink: string | null;
  webViewLink: string | null;
  starred: boolean;
  shared: boolean;
  owned: boolean;
};

// Single fields mask reused across list/search/get — keep responses small and
// the shape consistent so toFile() never reads an unrequested property.
const FILE_FIELDS =
  "id,name,mimeType,size,modifiedTime,iconLink,webViewLink,starred,shared,ownedByMe";
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

function toFile(f: drive_v3.Schema$File): DriveFile {
  const isFolder = f.mimeType === FOLDER_MIME;
  return {
    id: f.id!,
    name: f.name ?? "(이름 없음)",
    mimeType: f.mimeType ?? "application/octet-stream",
    isFolder,
    // Drive omits `size` for folders and native Docs/Sheets/Slides.
    size: f.size != null ? Number(f.size) : null,
    modifiedTime: f.modifiedTime ?? "",
    iconLink: f.iconLink ?? null,
    webViewLink: f.webViewLink ?? null,
    starred: f.starred ?? false,
    shared: f.shared ?? false,
    owned: f.ownedByMe ?? false,
  };
}

// A user-supplied folder id or search term must not break out of the Drive
// query grammar: single quotes terminate string literals in `q`.
function quote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Browse one folder (default: root). Folders first, then by name. */
export async function listFiles(opts: {
  folderId?: string;
  pageToken?: string;
}): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  const d = await api();
  const parent = opts.folderId || "root";
  const list = await d.files.list({
    q: `${quote(parent)} in parents and trashed = false`,
    pageToken: opts.pageToken,
    pageSize: 100,
    orderBy: "folder,name",
    fields: LIST_FIELDS,
    // Without this, files in Shared Drives silently vanish from listings.
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return {
    files: (list.data.files ?? []).filter((f) => f.id).map(toFile),
    nextPageToken: list.data.nextPageToken ?? undefined,
  };
}

/** Full-text + name search across (non-trashed) Drive. */
export async function searchFiles(
  query: string,
  pageToken?: string,
): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  const d = await api();
  const term = query.replace(/'/g, "\\'");
  const list = await d.files.list({
    q: `(name contains '${term}' or fullText contains '${term}') and trashed = false`,
    pageToken,
    pageSize: 100,
    // No orderBy: Drive rejects sorting on fullText queries ("Sorting is not
    // supported...") — results come back in descending relevance order.
    fields: LIST_FIELDS,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return {
    files: (list.data.files ?? []).filter((f) => f.id).map(toFile),
    nextPageToken: list.data.nextPageToken ?? undefined,
  };
}

export type Breadcrumb = { id: string; name: string };

/** Path from root → folder, for the breadcrumb bar. */
export async function getBreadcrumb(folderId: string): Promise<Breadcrumb[]> {
  if (!folderId || folderId === "root") return [];
  const d = await api();
  const crumbs: Breadcrumb[] = [];
  let id: string | undefined = folderId;
  // Walk parents up toward the My Drive root. Cap the climb so a
  // pathological/looping parent chain can't spin forever.
  for (let i = 0; i < 50 && id && id !== "root"; i++) {
    const f: drive_v3.Schema$File = (
      await d.files.get({
        fileId: id,
        fields: "id,name,parents",
        supportsAllDrives: true,
      })
    ).data;
    // The My Drive root has no parents — it's already represented by the fixed
    // "내 드라이브" button, so stop before adding it (avoids a duplicate crumb).
    if (!f.parents || f.parents.length === 0) break;
    crumbs.unshift({ id: f.id!, name: f.name ?? "" });
    id = f.parents[0];
  }
  return crumbs;
}

export type DriveQuota = {
  limit: number | null; // null = unlimited (some Workspace accounts)
  usage: number;
  usageInDrive: number;
};

export async function getQuota(): Promise<DriveQuota> {
  const d = await api();
  const about = await d.about.get({ fields: "storageQuota" });
  const q = about.data.storageQuota ?? {};
  return {
    limit: q.limit != null ? Number(q.limit) : null,
    usage: Number(q.usage ?? 0),
    usageInDrive: Number(q.usageInDrive ?? 0),
  };
}

// Native Google formats aren't downloadable as-is — export them to the
// closest Office equivalent (matches what Drive's "Download" does).
const EXPORT_MAP: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: ".docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: ".xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: ".pptx",
  },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: ".png" },
};

export type DownloadResult = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
};

export async function downloadFile(fileId: string): Promise<DownloadResult> {
  const d = await api();
  const meta = (
    await d.files.get({
      fileId,
      fields: "name,mimeType",
      supportsAllDrives: true,
    })
  ).data;
  const name = meta.name ?? "download";
  const mime = meta.mimeType ?? "application/octet-stream";

  if (mime === FOLDER_MIME) {
    throw new Error("CANNOT_DOWNLOAD_FOLDER");
  }

  const exp = EXPORT_MAP[mime];
  if (exp) {
    const res = await d.files.export(
      { fileId, mimeType: exp.mime },
      { responseType: "arraybuffer" },
    );
    const filename = name.toLowerCase().endsWith(exp.ext) ? name : name + exp.ext;
    return { buffer: Buffer.from(res.data as ArrayBuffer), filename, mimeType: exp.mime };
  }

  const res = await d.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  return { buffer: Buffer.from(res.data as ArrayBuffer), filename: name, mimeType: mime };
}

export async function createFolder(
  name: string,
  parentId?: string,
): Promise<DriveFile> {
  const d = await api();
  const res = await d.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: parentId && parentId !== "root" ? [parentId] : undefined,
    },
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });
  return toFile(res.data);
}

/** Move to trash (recoverable) — never permanent delete. */
export async function trashFile(fileId: string): Promise<void> {
  const d = await api();
  await d.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
}

export async function renameFile(
  fileId: string,
  name: string,
): Promise<DriveFile> {
  const d = await api();
  const res = await d.files.update({
    fileId,
    requestBody: { name },
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });
  return toFile(res.data);
}

export type UploadInput = {
  name: string;
  mimeType: string;
  data: string; // base64 (no data: prefix)
  parentId?: string;
};

export async function uploadFile(input: UploadInput): Promise<DriveFile> {
  const d = await api();
  const res = await d.files.create({
    requestBody: {
      name: input.name,
      parents:
        input.parentId && input.parentId !== "root" ? [input.parentId] : undefined,
    },
    media: {
      mimeType: input.mimeType || "application/octet-stream",
      body: bufferToStream(Buffer.from(input.data, "base64")),
    },
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });
  return toFile(res.data);
}

export type SharedUpload = {
  id: string;
  name: string;
  size: number;
  link: string; // anyone-with-link view URL
};

/**
 * Upload a file and grant anyone-with-the-link read access, then return a
 * shareable URL. This is how oversize mail attachments get sent: Gmail's own
 * web client does exactly this (Drive link instead of a >25MB MIME part).
 */
export async function uploadAndShare(input: {
  name: string;
  mimeType: string;
  data: string;
}): Promise<SharedUpload> {
  const d = await api();
  const created = await d.files.create({
    requestBody: { name: input.name },
    media: {
      mimeType: input.mimeType || "application/octet-stream",
      body: bufferToStream(Buffer.from(input.data, "base64")),
    },
    fields: "id,name,size,webViewLink",
  });
  const id = created.data.id!;
  await d.permissions.create({
    fileId: id,
    requestBody: { role: "reader", type: "anyone" },
  });
  return {
    id,
    name: created.data.name ?? input.name,
    size: Number(created.data.size ?? 0),
    link: created.data.webViewLink ?? `https://drive.google.com/file/d/${id}/view`,
  };
}

// @googleapis media bodies want a Node Readable, not a Buffer.
function bufferToStream(buf: Buffer): Readable {
  return Readable.from(buf);
}
