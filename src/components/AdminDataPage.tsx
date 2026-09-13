import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  ChevronRight,
  Download,
  Eye,
  File,
  FileText,
  Folder,
  FolderUp,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import ConfirmDialog from "@/components/ConfirmDialog";
import FilePreviewModal from "@/components/FilePreviewModal";
import { assertUploadBatchWithinLimit } from "@/lib/upload-limits";
import {
  deleteAdminData,
  downloadAdminData,
  getAdminDataContent,
  getAdminDataTextPreview,
  listAdminData,
  uploadAdminData,
  type AdminDataDirectory,
  type AdminDataEntry,
} from "@/services/api/admin-data";

interface AdminDataPageProps {
  t: (key: string, params?: Record<string, string>) => string;
}

interface PreviewState {
  entry: AdminDataEntry;
  content?: string;
  objectUrl?: string;
  loading: boolean;
  error?: string;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  try {
    const parsed = JSON.parse(error.message) as { error?: string };
    return parsed.error || error.message;
  } catch {
    return error.message;
  }
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function entryIcon(entry: AdminDataEntry) {
  if (entry.type === "directory") return <Folder size={18} />;
  if (entry.previewType === "text") return <FileText size={18} />;
  return <File size={18} />;
}

export default function AdminDataPage({ t }: AdminDataPageProps) {
  const [currentPath, setCurrentPath] = useState("");
  const [directory, setDirectory] = useState<AdminDataDirectory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AdminDataEntry | null>(
    null,
  );
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = folderInput.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    listAdminData(currentPath)
      .then((data) => {
        if (active) setDirectory(data);
      })
      .catch((requestError) => {
        if (active) setError(errorMessage(requestError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [currentPath, reloadToken]);

  useEffect(() => {
    const objectUrl = preview?.objectUrl;
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [preview?.objectUrl]);

  const breadcrumbs = useMemo(() => {
    const crumbs = [{ label: directory?.root || "/app/data", path: "" }];
    const parts = currentPath.split("/").filter(Boolean);
    let accumulated = "";
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      crumbs.push({ label: part, path: accumulated });
    }
    return crumbs;
  }, [currentPath, directory?.root]);

  const closePreview = useCallback(() => {
    previewRequest.current += 1;
    setPreview(null);
  }, []);

  const openPreview = useCallback(async (entry: AdminDataEntry) => {
    if (!entry.previewType) return;
    const requestId = previewRequest.current + 1;
    previewRequest.current = requestId;
    setPreview({ entry, loading: true });
    try {
      if (entry.previewType === "text") {
        const result = await getAdminDataTextPreview(entry.path);
        if (previewRequest.current === requestId)
          setPreview({ entry, content: result.content, loading: false });
        return;
      }
      const blob = await getAdminDataContent(entry.path);
      const objectUrl = URL.createObjectURL(blob);
      if (previewRequest.current === requestId)
        setPreview({ entry, objectUrl, loading: false });
      else URL.revokeObjectURL(objectUrl);
    } catch (requestError) {
      if (previewRequest.current === requestId)
        setPreview({
          entry,
          loading: false,
          error: errorMessage(requestError),
        });
    }
  }, []);

  const download = useCallback(async (entry: AdminDataEntry) => {
    setDownloadingPath(entry.path);
    setActionError(null);
    try {
      const fallbackName =
        entry.type === "directory" ? `${entry.name}.tar.gz` : entry.name;
      await downloadAdminData(entry.path, fallbackName);
    } catch (requestError) {
      setActionError(errorMessage(requestError));
    } finally {
      setDownloadingPath(null);
    }
  }, []);

  const upload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (!selectedFiles.length) return;

      setActionError(null);
      try {
        assertUploadBatchWithinLimit(selectedFiles);
        setUploading(true);
        await uploadAdminData(
          currentPath,
          selectedFiles.map((file) => ({
            file,
            relativePath: file.webkitRelativePath || file.name,
          })),
        );
        setReloadToken((value) => value + 1);
      } catch (requestError) {
        setActionError(errorMessage(requestError));
      } finally {
        setUploading(false);
      }
    },
    [currentPath],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || deletingPath) return;
    setDeletingPath(pendingDelete.path);
    setActionError(null);
    try {
      await deleteAdminData(pendingDelete.path);
      if (preview?.entry.path === pendingDelete.path) closePreview();
      setPendingDelete(null);
      setReloadToken((value) => value + 1);
    } catch (requestError) {
      setActionError(errorMessage(requestError));
    } finally {
      setDeletingPath(null);
    }
  }, [closePreview, deletingPath, pendingDelete, preview?.entry.path]);

  return (
    <section className="admin-data-page">
      <header className="admin-data-header">
        <div>
          <h1>{t("adminData.title")}</h1>
          <p>{t("adminData.subtitle")}</p>
        </div>
        <div className="admin-data-header-actions">
          <input
            ref={fileInput}
            className="admin-data-file-input"
            type="file"
            multiple
            onChange={(event) => void upload(event)}
          />
          <input
            ref={folderInput}
            className="admin-data-file-input"
            type="file"
            multiple
            onChange={(event) => void upload(event)}
          />
          <button
            className="admin-data-upload"
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
          >
            <Upload size={15} />
            <span>{t("adminData.uploadFile")}</span>
          </button>
          <button
            className="admin-data-upload"
            type="button"
            onClick={() => folderInput.current?.click()}
            disabled={uploading}
          >
            <FolderUp size={15} />
            <span>{t("adminData.uploadFolder")}</span>
          </button>
          <button
            className="admin-data-refresh"
            type="button"
            onClick={() => setReloadToken((value) => value + 1)}
            disabled={loading || uploading}
          >
            <RefreshCw size={15} className={loading ? "spinning" : ""} />
            <span>{t("adminData.refresh")}</span>
          </button>
        </div>
      </header>

      <nav className="admin-data-breadcrumbs" aria-label={t("adminData.path")}>
        {breadcrumbs.map((crumb, index) => (
          <span key={crumb.path || "root"}>
            {index > 0 && <ChevronRight size={14} />}
            <button type="button" onClick={() => setCurrentPath(crumb.path)}>
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

      {actionError && (
        <div className="admin-data-notice" role="alert">
          {actionError}
        </div>
      )}
      {error ? (
        <div className="admin-data-state" role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => setReloadToken((value) => value + 1)}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : loading && !directory ? (
        <div className="admin-data-state">{t("adminData.loading")}</div>
      ) : (
        <div className="admin-data-table-wrap app-scrollbar">
          <table className="admin-data-table">
            <thead>
              <tr>
                <th>{t("adminData.name")}</th>
                <th>{t("adminData.type")}</th>
                <th>{t("adminData.size")}</th>
                <th>{t("adminData.modified")}</th>
                <th>{t("adminData.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {directory?.entries.map((entry) => (
                <tr key={entry.path}>
                  <td>
                    <button
                      className={`admin-data-name ${entry.type === "directory" ? "is-directory" : ""}`}
                      type="button"
                      onClick={() =>
                        entry.type === "directory"
                          ? setCurrentPath(entry.path)
                          : void openPreview(entry)
                      }
                      disabled={
                        entry.type !== "directory" && !entry.previewType
                      }
                    >
                      <span className="admin-data-entry-icon">
                        {entryIcon(entry)}
                      </span>
                      <span title={entry.name}>{entry.name}</span>
                    </button>
                  </td>
                  <td>{t(`adminData.type.${entry.type}`)}</td>
                  <td>{formatSize(entry.size)}</td>
                  <td>{new Date(entry.modifiedAt).toLocaleString()}</td>
                  <td>
                    <div className="admin-data-actions">
                      {entry.previewType && (
                        <button
                          type="button"
                          title={t("adminData.preview")}
                          onClick={() => void openPreview(entry)}
                        >
                          <Eye size={15} />
                        </button>
                      )}
                      <button
                        type="button"
                        title={t("adminData.download")}
                        onClick={() => void download(entry)}
                        disabled={downloadingPath === entry.path}
                      >
                        <Download size={15} />
                      </button>
                      <button
                        className="admin-data-delete"
                        type="button"
                        title={t("adminData.delete")}
                        onClick={() => setPendingDelete(entry)}
                        disabled={deletingPath === entry.path}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && directory?.entries.length === 0 && (
            <div className="admin-data-state">{t("adminData.empty")}</div>
          )}
          {loading && directory && (
            <div className="admin-data-loading-overlay">
              {t("adminData.loading")}
            </div>
          )}
        </div>
      )}

      {preview?.entry.previewType === "text" && (
        <FilePreviewModal
          path={preview.entry.path}
          content={preview.content}
          loading={preview.loading}
          error={preview.error}
          onClose={closePreview}
          t={t}
        />
      )}
      {preview && preview.entry.previewType !== "text" && (
        <div
          className="file-preview-backdrop"
          role="presentation"
          onClick={closePreview}
        >
          <div
            className="admin-data-preview-modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="admin-data-preview-header">
              <span title={preview.entry.path}>{preview.entry.name}</span>
              <button
                type="button"
                onClick={closePreview}
                aria-label={t("filePreview.close")}
              >
                &times;
              </button>
            </div>
            <div className="admin-data-preview-body">
              {preview.loading && (
                <div className="admin-data-state">
                  {t("adminData.loadingPreview")}
                </div>
              )}
              {preview.error && (
                <div className="admin-data-state admin-data-preview-error">
                  {preview.error}
                </div>
              )}
              {preview.objectUrl && preview.entry.previewType === "image" && (
                <img src={preview.objectUrl} alt={preview.entry.name} />
              )}
              {preview.objectUrl && preview.entry.previewType === "pdf" && (
                <iframe src={preview.objectUrl} title={preview.entry.name} />
              )}
            </div>
          </div>
        </div>
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={t("adminData.deleteTitle")}
          body={t(
            pendingDelete.type === "directory"
              ? "adminData.deleteDirectoryBody"
              : "adminData.deleteFileBody",
          )}
          objectName={pendingDelete.name}
          cancelLabel={t("common.cancel")}
          confirmLabel={
            deletingPath === pendingDelete.path
              ? t("adminData.deleting")
              : t("adminData.delete")
          }
          onCancel={() => !deletingPath && setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </section>
  );
}
