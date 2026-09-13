import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Clapperboard,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";
import type { Locale } from "@/i18n";
import {
  createVideoSopJob,
  getVideoSopCapabilities,
  type VideoSopCapabilities,
  type VideoSopJob,
  type VideoSopLanguage,
} from "@/services/api/video-sop";

interface VideoSopCreatePanelProps {
  folderId?: string;
  folderName: string;
  locale: Locale;
  t: (key: string, params?: Record<string, string>) => string;
  onSubmitted: (job: VideoSopJob) => void;
}

const fallbackCapabilities: VideoSopCapabilities = {
  enabled: false,
  maxVideos: 4,
  maxFileBytes: 7 * 1024 * 1024,
  languages: ["zh", "en", "ja"],
};

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : raw;
  } catch {
    return raw;
  }
}

function fileIdentity(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

export default function VideoSopCreatePanel({
  folderId,
  folderName,
  locale,
  t,
  onSubmitted,
}: VideoSopCreatePanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [capabilities, setCapabilities] = useState<VideoSopCapabilities>(fallbackCapabilities);
  const [loadingCapabilities, setLoadingCapabilities] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [language, setLanguage] = useState<VideoSopLanguage>(locale);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoadingCapabilities(true);
    void getVideoSopCapabilities()
      .then((next) => {
        if (active) setCapabilities(next);
      })
      .catch((reason) => {
        if (active) setError(readableError(reason));
      })
      .finally(() => {
        if (active) setLoadingCapabilities(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const appendFiles = (selected: FileList | File[]) => {
    setError(null);
    const incoming = Array.from(selected);
    const invalidType = incoming.find((file) => !/\.mp4$/i.test(file.name));
    if (invalidType) {
      setError(t("videoSop.errorMp4Only", { name: invalidType.name }));
      return;
    }
    const oversized = incoming.find((file) => file.size > capabilities.maxFileBytes);
    if (oversized) {
      setError(
        t("videoSop.errorTooLarge", {
          name: oversized.name,
          limit: formatBytes(capabilities.maxFileBytes),
        }),
      );
      return;
    }
    setFiles((current) => {
      const known = new Set(current.map(fileIdentity));
      const unique = incoming.filter((file) => !known.has(fileIdentity(file)));
      if (current.length + unique.length > capabilities.maxVideos) {
        setError(
          t("videoSop.errorTooMany", { count: String(capabilities.maxVideos) }),
        );
        return current;
      }
      return [...current, ...unique];
    });
  };

  const moveFile = (index: number, direction: -1 | 1) => {
    setFiles((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    appendFiles(event.dataTransfer.files);
  };

  const submit = async () => {
    if (!files.length || submitting || !capabilities.enabled) return;
    setSubmitting(true);
    setError(null);
    try {
      const job = await createVideoSopJob({
        videos: files,
        language,
        folderId,
      });
      setFiles([]);
      onSubmitted(job);
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="video-sop-create-panel">
      <div className="video-sop-intro">
        <span className="video-sop-intro-icon" aria-hidden="true">
          <Sparkles size={20} />
        </span>
        <div>
          <h2>{t("videoSop.title")}</h2>
          <p>{t("videoSop.description")}</p>
        </div>
      </div>

      {!loadingCapabilities && !capabilities.enabled ? (
        <div className="video-sop-config-warning" role="alert">
          {t("videoSop.notConfigured")}
        </div>
      ) : null}

      <div
        className={`video-sop-dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <UploadCloud size={26} aria-hidden="true" />
        <strong>{t("videoSop.dropTitle")}</strong>
        <span>
          {t("videoSop.dropHint", {
            count: String(capabilities.maxVideos),
            size: formatBytes(capabilities.maxFileBytes),
          })}
        </span>
        <button
          type="button"
          className="resource-picker-dropzone-action"
          onClick={() => inputRef.current?.click()}
          disabled={submitting}
        >
          {t("videoSop.chooseVideos")}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,.mp4"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) appendFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {files.length ? (
        <div className="video-sop-file-list">
          {files.map((file, index) => (
            <div className="video-sop-file" key={fileIdentity(file)}>
              <span className="video-sop-screen-label">Screen {index}</span>
              <Clapperboard size={17} aria-hidden="true" />
              <span className="video-sop-file-name" title={file.name}>{file.name}</span>
              <span className="video-sop-file-size">{formatBytes(file.size)}</span>
              <button type="button" onClick={() => moveFile(index, -1)} disabled={index === 0 || submitting} aria-label={t("videoSop.moveUp")}>
                <ArrowUp size={15} />
              </button>
              <button type="button" onClick={() => moveFile(index, 1)} disabled={index === files.length - 1 || submitting} aria-label={t("videoSop.moveDown")}>
                <ArrowDown size={15} />
              </button>
              <button type="button" onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} disabled={submitting} aria-label={t("videoSop.removeVideo")}>
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="video-sop-form-grid">
        <label>
          <span>{t("videoSop.languageLabel")}</span>
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value as VideoSopLanguage)}
            disabled={submitting}
          >
            <option value="zh">{t("videoSop.languageZh")}</option>
            <option value="en">{t("videoSop.languageEn")}</option>
            <option value="ja">{t("videoSop.languageJa")}</option>
          </select>
        </label>
      </div>

      <div className="video-sop-destination">
        <span>{t("videoSop.destination")}</span>
        <strong>{folderName}</strong>
      </div>

      {error ? <p className="video-sop-error" role="alert">{error}</p> : null}

      <div className="video-sop-submit-row">
        <span>{t("videoSop.privacyHint")}</span>
        <button
          type="button"
          className="modal-btn modal-btn-primary video-sop-submit"
          onClick={() => void submit()}
          disabled={!files.length || submitting || !capabilities.enabled || loadingCapabilities}
        >
          <Sparkles size={16} aria-hidden="true" />
          {submitting ? t("videoSop.uploading") : t("videoSop.submit")}
        </button>
      </div>
    </div>
  );
}
