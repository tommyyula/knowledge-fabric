import { createResource, deleteResource, listResourceLibrary } from "../resource-library/repository";
import { videoSopConfig } from "./config";
import { videoSopErrorDetails } from "./errors";
import { cleanupVideoSopJobFiles } from "./files";
import { renderVideoSopMarkdown } from "./markdown";
import { analyzeVideoSopOperations, generateVideoSopResult } from "./model";
import {
  deleteVideoSopJob,
  getVideoSopJob,
  markInterruptedVideoSopJobs,
  updateVideoSopJob,
} from "./store";
import type { VideoSopJobRecord } from "./types";

interface QueueEntry {
  tenantId: string;
  ownerId: string;
  jobId: string;
}

const queue: QueueEntry[] = [];
const queuedIds = new Set<string>();
const activeControllers = new Map<string, AbortController>();

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function timestamp(date: Date): string {
  return `${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function ticketFilenamePart(value: string | null | undefined): string {
  return (value || "auto")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 60) || "auto";
}

async function uniqueOutputName(job: VideoSopJobRecord, detectedTicketId?: string): Promise<string> {
  const stem = `ai_sop_${ticketFilenamePart(job.ticketId || detectedTicketId)}_${timestamp(new Date(job.createdAt))}`;
  const library = await listResourceLibrary(job.tenantId, job.ownerId);
  const used = new Set(
    library.resources
      .filter((resource) => (resource.folder ?? null) === (job.folderId ?? null))
      .map((resource) => resource.name.toLocaleLowerCase()),
  );
  let name = `${stem}.md`;
  let suffix = 2;
  while (used.has(name.toLocaleLowerCase())) {
    name = `${stem}_${suffix}.md`;
    suffix += 1;
  }
  return name;
}

async function execute(entry: QueueEntry, controller: AbortController): Promise<void> {
  const job = await getVideoSopJob(entry.tenantId, entry.ownerId, entry.jobId);
  if (!job) return;
  const startedAt = new Date().toISOString();
  const jobStartedAt = Date.now();
  let phase = "analyzing_video";

  console.info("[DEBUG-video-sop-model]", JSON.stringify({
    event: "job_started",
    jobId: job.id,
    videoCount: job.videoCount,
    totalBytes: job.totalBytes,
    visionModel: videoSopConfig.visionModel,
    sopModel: videoSopConfig.sopModel,
  }));

  try {
    await updateVideoSopJob(job.tenantId, job.ownerId, job.id, {
      status: "analyzing_video",
      startedAt,
      error: undefined,
    });
    const operations = await analyzeVideoSopOperations(job, controller.signal);
    phase = "generating_sop";
    await updateVideoSopJob(job.tenantId, job.ownerId, job.id, {
      status: "generating_sop",
    });
    const result = await generateVideoSopResult(job, operations, controller.signal);
    phase = "saving_resource";
    await updateVideoSopJob(job.tenantId, job.ownerId, job.id, {
      status: "saving_resource",
      detectedTicketId: result.ticketId ?? undefined,
    });

    const generatedAt = new Date();
    const name = await uniqueOutputName(job, result.ticketId ?? undefined);
    const markdown = renderVideoSopMarkdown(job, result, generatedAt);
    const resource = await createResource(job.tenantId, job.ownerId, {
      name,
      data: Buffer.from(markdown, "utf8"),
      folder: job.folderId,
      contentType: "text/markdown; charset=utf-8",
      description: `AI-generated SOP from ${job.videoCount} video${job.videoCount === 1 ? "" : "s"}`,
    });
    try {
      const completedAt = generatedAt.toISOString();
      await updateVideoSopJob(job.tenantId, job.ownerId, job.id, {
        status: "completed",
        resourceId: resource.id,
        detectedTicketId: result.ticketId ?? undefined,
        completedAt,
        expiresAt: new Date(generatedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      });
      console.info("[DEBUG-video-sop-model]", JSON.stringify({
        event: "job_completed",
        jobId: job.id,
        resourceId: resource.id,
        elapsedMs: Date.now() - jobStartedAt,
      }));
    } catch (error) {
      await deleteResource(job.tenantId, job.ownerId, resource.id).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      console.warn("[DEBUG-video-sop-model]", JSON.stringify({
        event: "job_canceled",
        jobId: job.id,
        phase,
        elapsedMs: Date.now() - jobStartedAt,
      }));
      await deleteVideoSopJob(job.tenantId, job.ownerId, job.id).catch(() => undefined);
      return;
    }
    const completedAt = new Date().toISOString();
    const details = videoSopErrorDetails(error);
    console.error("[DEBUG-video-sop-model]", JSON.stringify({
      event: "job_failed",
      jobId: job.id,
      phase,
      code: details.code,
      message: details.message,
      elapsedMs: Date.now() - jobStartedAt,
    }));
    await updateVideoSopJob(job.tenantId, job.ownerId, job.id, {
      status: "failed",
      error: details,
      completedAt,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  } finally {
    await cleanupVideoSopJobFiles(job.tenantId, job.ownerId, job.id).catch((error) => {
      console.warn("[video-sop] failed to clean temporary videos", {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

function pumpQueue(): void {
  while (activeControllers.size < videoSopConfig.maxConcurrentJobs && queue.length) {
    const entry = queue.shift();
    if (!entry) break;
    queuedIds.delete(entry.jobId);
    const controller = new AbortController();
    activeControllers.set(entry.jobId, controller);
    void execute(entry, controller).finally(() => {
      activeControllers.delete(entry.jobId);
      pumpQueue();
    });
  }
}

export function enqueueVideoSopJob(record: VideoSopJobRecord): void {
  if (queuedIds.has(record.id) || activeControllers.has(record.id)) return;
  queue.push({ tenantId: record.tenantId, ownerId: record.ownerId, jobId: record.id });
  queuedIds.add(record.id);
  pumpQueue();
}

export async function cancelOrDismissVideoSopJob(record: VideoSopJobRecord): Promise<void> {
  const controller = activeControllers.get(record.id);
  if (controller) controller.abort();
  const queuedIndex = queue.findIndex((entry) => entry.jobId === record.id);
  if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
  queuedIds.delete(record.id);
  await deleteVideoSopJob(record.tenantId, record.ownerId, record.id);
  await cleanupVideoSopJobFiles(record.tenantId, record.ownerId, record.id);
}

export async function initializeVideoSopJobs(): Promise<void> {
  const interrupted = await markInterruptedVideoSopJobs();
  await Promise.all(
    interrupted.map((job) =>
      cleanupVideoSopJobFiles(job.tenantId, job.ownerId, job.id).catch(() => undefined),
    ),
  );
}
