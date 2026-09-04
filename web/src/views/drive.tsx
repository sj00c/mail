// 드라이브 화면: 폴더 탐색/검색/업로드/이름변경/휴지통 + 검색 카드.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  AuthError,
  type DriveBreadcrumb,
  type DriveFile,
  type DriveQuota,
} from "../api.ts";
import { blobToBase64 } from "../lib/attachments.ts";
import { formatBytes, highlightText } from "../lib/format.tsx";
import { DriveIcon, FileIcon, FolderIcon, TrashIcon } from "../ui/icons.tsx";
import { EmptyArt } from "../ui/illustrations.tsx";

export function DriveCard({ f, terms }: { f: DriveFile; terms: string[] }) {
  return (
    <a
      className="scard drive-card"
      href={f.webViewLink ?? "#"}
      target="_blank"
      rel="noreferrer"
      title={f.name}
    >
      <span className="avatar drive-card-icon">{f.isFolder ? <FolderIcon /> : <FileIcon />}</span>
      <span className="scard-main">
        <span className="scard-top">
          <span className="scard-from">{highlightText(f.name, terms)}</span>
          <span className="scard-date">
            {f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ""}
          </span>
        </span>
        <span className="scard-sub">
          {f.isFolder ? "폴더" : formatBytes(f.size)}
          {f.shared ? " · 공유됨" : ""}
        </span>
      </span>
    </a>
  );
}

export function DriveView({ onLogout }: { onLogout: () => void }) {
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [folderId, setFolderId] = useState("root");
  const [crumbs, setCrumbs] = useState<DriveBreadcrumb[]>([]);
  const [quota, setQuota] = useState<DriveQuota | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => setRefreshKey((k) => k + 1), []);

  // List (or search) + breadcrumb whenever the folder/query/refresh changes.
  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setErr(null);
    const params = query ? { q: query } : { folderId };
    api
      .driveFiles(params)
      .then((res) => {
        if (!cancelled) setFiles(res.files);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) onLogout();
        else setErr((e as Error).message);
      });
    // Breadcrumb only matters when browsing (not searching).
    if (!query && folderId !== "root") {
      api
        .driveBreadcrumb(folderId)
        .then((c) => !cancelled && setCrumbs(c))
        .catch(() => !cancelled && setCrumbs([]));
    } else {
      setCrumbs([]);
    }
    return () => {
      cancelled = true;
    };
  }, [folderId, query, refreshKey, onLogout]);

  // Storage quota — load once (and after uploads/trash via refreshKey).
  useEffect(() => {
    let cancelled = false;
    api
      .driveQuota()
      .then((q) => !cancelled && setQuota(q))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const openFolder = (id: string) => {
    setQuery("");
    setSearchInput("");
    setFolderId(id);
  };

  const onUpload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      for (const f of Array.from(list)) {
        const data = await blobToBase64(f);
        await api.driveUpload({
          name: f.name,
          mimeType: f.type || "application/octet-stream",
          data,
          parentId: query ? undefined : folderId,
        });
      }
      reload();
    } catch (e) {
      if (e instanceof AuthError) onLogout();
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const newFolder = async () => {
    const name = window.prompt("새 폴더 이름")?.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.driveCreateFolder(name, folderId === "root" ? undefined : folderId);
      reload();
    } catch (e) {
      if (e instanceof AuthError) onLogout();
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (f: DriveFile) => {
    const name = window.prompt("새 이름", f.name)?.trim();
    if (!name || name === f.name) return;
    setBusy(true);
    try {
      await api.driveRename(f.id, name);
      reload();
    } catch (e) {
      if (e instanceof AuthError) onLogout();
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const trash = async (f: DriveFile) => {
    if (!window.confirm(`"${f.name}"을(를) 휴지통으로 이동할까요?`)) return;
    setBusy(true);
    try {
      await api.driveTrash(f.id);
      reload();
    } catch (e) {
      if (e instanceof AuthError) onLogout();
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const usedPct =
    quota && quota.limit ? Math.min(100, (quota.usage / quota.limit) * 100) : null;

  return (
    <section className="drive">
      <div className="drive-head">
        <div className="drive-crumbs">
          <button className="crumb" onClick={() => openFolder("root")}>
            <DriveIcon />내 드라이브
          </button>
          {crumbs.map((c) => (
            <span key={c.id}>
              <span className="crumb-sep">›</span>
              <button className="crumb" onClick={() => openFolder(c.id)}>
                {c.name}
              </button>
            </span>
          ))}
          {query && <span className="crumb-sep">› 검색: "{query}"</span>}
        </div>
        <div className="drive-actions">
          <form
            className="drive-search"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(searchInput.trim());
            }}
          >
            <input
              type="search"
              placeholder="드라이브 검색"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </form>
          <button className="btn" disabled={busy || !!query} onClick={newFolder}>
            + 폴더
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            업로드
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => onUpload(e.target.files)}
          />
        </div>
      </div>

      {quota && (
        <div className="drive-quota">
          <div className="drive-quota-bar">
            <div
              className="drive-quota-fill"
              style={{ width: usedPct != null ? `${usedPct}%` : "0%" }}
            />
          </div>
          <span className="drive-quota-text">
            {formatBytes(quota.usage)}
            {quota.limit ? ` / ${formatBytes(quota.limit)} 사용` : " 사용 (무제한)"}
          </span>
        </div>
      )}

      {err && <div className="drive-error">{err}</div>}

      <div className="drive-list">
        {files === null ? (
          <div className="empty">불러오는 중…</div>
        ) : files.length === 0 ? (
          <div className="empty">
            <EmptyArt kind="folder" />
            {query ? "검색 결과가 없습니다." : "이 폴더가 비어 있습니다."}
          </div>
        ) : (
          files.map((f) => (
            <div
              key={f.id}
              className={`drive-row${f.isFolder ? " folder" : ""}`}
              onDoubleClick={() => f.isFolder && openFolder(f.id)}
            >
              <span className="drive-icon">{f.isFolder ? <FolderIcon /> : <FileIcon />}</span>
              {f.isFolder ? (
                <button
                  className="drive-name"
                  title={f.name}
                  onClick={() => openFolder(f.id)}
                >
                  {f.name}
                  {f.shared && <span className="drive-badge">공유됨</span>}
                </button>
              ) : (
                // 파일 이름 클릭 = 바로 다운로드 (서버가 Content-Disposition: attachment).
                <a
                  className="drive-name"
                  title={`${f.name} — 클릭하면 다운로드`}
                  href={api.driveDownloadUrl(f.id)}
                  download={f.name}
                >
                  {f.name}
                  {f.shared && <span className="drive-badge">공유됨</span>}
                </a>
              )}
              <span className="drive-size">{f.isFolder ? "" : formatBytes(f.size)}</span>
              <span className="drive-date">
                {f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ""}
              </span>
              <span className="drive-row-actions">
                <button className="drive-act" title="이름 변경" onClick={() => rename(f)}>
                  ✎
                </button>
                <button className="drive-act" title="휴지통" onClick={() => trash(f)}>
                  <TrashIcon />
                </button>
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
