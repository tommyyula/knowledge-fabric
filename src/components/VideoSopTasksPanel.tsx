import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, Clapperboard, Sparkles, X } from "lucide-react";
import {
  listVideoSopJobs,
  removeVideoSopJob,
  type VideoSopJob,
  type VideoSopStatus,
} from "@/services/api/video-sop";

interface VideoSopTasksPanelProps {
  folderId?: string;
  refreshKey: number;
  t: (key: string, params?: Record<string, string>) => string;
  onResourceCreated: () => void;
}

const activeStatuses = new Set<VideoSopStatus>([
  "queued",
  "analyzing_video",
  "generating_sop",
  "saving_resource",
]);

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function elapsedLabel(job: VideoSopJob, now: number): string {
  const start = Date.parse(job.startedAt || job.createdAt);
  const end = job.completedAt ? Date.parse(job.completedAt) : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function VideoSopTasksPanel({
  folderId,
  refreshKey,
  t,
  onResourceCreated,
}: VideoSopTasksPanelProps) {
  const [jobs, setJobs] = useState<VideoSopJob[]>([]);
  const [now, setNow] = useState(Date.now());
  const [actionError, setActionError] = useState<string | null>(null);
  const completedSeen = useRef(new Set<string>());
  const completionTimers = useRef<number[]>([]);

  const refresh = useCallback(async () => {
    try {
      const next = await listVideoSopJobs();
      setJobs(next);
      setActionError(null);
      next.forEach((job) => {
        if (job.status !== "completed" || completedSeen.current.has(job.id)) return;
        completedSeen.current.add(job.id);
        onResourceCreated();
        const timer = window.setTimeout(() => {
          void removeVideoSopJob(job.id)
            .catch(() => undefined)
            .finally(() => setJobs((current) => current.filter((item) => item.id !== job.id)));
        }, 1500);
        completionTimers.current.push(timer);
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [onResourceCreated]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    const hasActive = jobs.some((job) => activeStatuses.has(job.status));
    if (!hasActive) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [jobs, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => completionTimers.current.forEach((timer) => window.clearTimeout(timer)),
    [],
  );

  const visible = jobs.filter(
    (job) => (job.folderId ?? undefined) === (folderId ?? undefined),
  );
  if (!visible.length && !actionError) return null;

  const remove = async (job: VideoSopJob) => {
    try {
      await removeVideoSopJob(job.id);
      setJobs((current) => current.filter((item) => item.id !== job.id));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="video-sop-tasks" aria-label={t("videoSop.tasksTitle")}>
      <div className="video-sop-tasks-heading">
        <div>
          <Sparkles size={17} aria-hidden="true" />
          <strong>{t("videoSop.tasksTitle")}</strong>
        </div>
        <span>{t("videoSop.tasksHint")}</span>
      </div>
      {actionError ? <p className="video-sop-task-error" role="alert">{actionError}</p> : null}
      <div className="video-sop-task-list">
        {visible.map((job) => {
          const failed = job.status === "failed";
          const completed = job.status === "completed";
          return (
            <article className={`video-sop-task ${job.status}`} key={job.id}>
              <span className="video-sop-task-icon" aria-hidden="true">
                {failed ? <CircleAlert size={20} /> : <Clapperboard size={20} />}
              </span>
              <div className="video-sop-task-main">
                <div className="video-sop-task-title">
                  <strong>{t("videoSop.taskName")}</strong>
                  <span>{job.videoCount} · {formatBytes(job.totalBytes)}</span>
                </div>
                <p>{failed ? job.error?.message || t("videoSop.statusFailed") : t(`videoSop.status.${job.status}`)}</p>
                <div className="video-sop-task-files" title={job.videoNames.join(", ")}>{job.videoNames.join(" · ")}</div>
              </div>
              <div className="video-sop-task-meta">
                <span>{job.ticketId || job.detectedTicketId || t("videoSop.ticketAuto")}</span>
                <span>{elapsedLabel(job, now)}</span>
              </div>
              {activeStatuses.has(job.status) ? <span className="video-sop-task-spinner" aria-hidden="true" /> : null}
              {completed ? <span className="video-sop-task-complete" aria-hidden="true">✓</span> : null}
              {failed || activeStatuses.has(job.status) ? (
                <button type="button" className="video-sop-task-remove" onClick={() => void remove(job)} aria-label={failed ? t("videoSop.dismiss") : t("videoSop.cancel")}>
                  <X size={16} />
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
