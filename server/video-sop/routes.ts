import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireTenantContext } from "../auth/requireTenantContext";
import { asyncRoute } from "../http";
import { listResourceLibrary } from "../resource-library/repository";
import { videoSopConfig, videoSopEnabled } from "./config";
import { VideoSopError } from "./errors";
import { cleanupVideoSopJobFiles } from "./files";
import { parseVideoSopMultipart } from "./multipart";
import {
  cancelOrDismissVideoSopJob,
  enqueueVideoSopJob,
} from "./runner";
import {
  createVideoSopJob,
  getVideoSopJob,
  listVideoSopJobs,
} from "./store";
import {
  VIDEO_SOP_LANGUAGES,
  publicVideoSopJob,
  type VideoSopJobRecord,
} from "./types";

const uploadFieldsSchema = z.object({
  ticketId: z.string().trim().max(120).optional().transform((value) => value || undefined),
  language: z.enum(VIDEO_SOP_LANGUAGES),
  folderId: z.string().trim().max(180).optional().transform((value) => value || undefined),
});

export const videoSopRouter = Router();

videoSopRouter.get(
  "/capabilities",
  asyncRoute(async (req, res) => {
    await requireTenantContext(req);
    res.json({
      data: {
        enabled: videoSopEnabled(),
        maxVideos: videoSopConfig.maxVideos,
        maxFileBytes: videoSopConfig.maxFileBytes,
        languages: VIDEO_SOP_LANGUAGES,
      },
    });
  }),
);

videoSopRouter.post(
  "/jobs",
  asyncRoute(async (req, res) => {
    if (!videoSopEnabled()) {
      throw new VideoSopError(
        "VIDEO_SOP_NOT_CONFIGURED",
        "DASHSCOPE_API_KEY is not configured on the server.",
        503,
      );
    }
    const ctx = await requireTenantContext(req);
    const jobId = `vsj-${randomUUID()}`;
    try {
      const upload = await parseVideoSopMultipart(req, {
        tenantId: ctx.tenantId,
        ownerId: ctx.ownerId,
        jobId,
      });
      const fields = uploadFieldsSchema.parse(upload.fields);
      if (fields.folderId) {
        const library = await listResourceLibrary(ctx.tenantId, ctx.ownerId);
        if (!library.folders.some((folder) => folder.id === fields.folderId)) {
          throw new VideoSopError("FOLDER_NOT_FOUND", "The selected Resource Library folder no longer exists.", 404);
        }
      }

      const now = new Date();
      const record: VideoSopJobRecord = {
        id: jobId,
        tenantId: ctx.tenantId,
        ownerId: ctx.ownerId,
        status: "queued",
        videos: upload.videos,
        videoNames: upload.videos.map((video) => video.name),
        videoCount: upload.videos.length,
        totalBytes: upload.videos.reduce((total, video) => total + video.size, 0),
        ...(fields.ticketId ? { ticketId: fields.ticketId } : {}),
        language: fields.language,
        ...(fields.folderId ? { folderId: fields.folderId } : {}),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };
      await createVideoSopJob(record);
      enqueueVideoSopJob(record);
      res.status(202).json({ data: publicVideoSopJob(record) });
    } catch (error) {
      await cleanupVideoSopJobFiles(ctx.tenantId, ctx.ownerId, jobId).catch(() => undefined);
      throw error;
    }
  }),
);

videoSopRouter.get(
  "/jobs",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const jobs = await listVideoSopJobs(ctx.tenantId, ctx.ownerId);
    res.json({ data: { jobs: jobs.map(publicVideoSopJob) } });
  }),
);

videoSopRouter.get(
  "/jobs/:jobId",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const job = await getVideoSopJob(
      ctx.tenantId,
      ctx.ownerId,
      String(req.params.jobId),
    );
    if (!job) return void res.status(404).json({ error: "Video SOP task not found" });
    res.json({ data: publicVideoSopJob(job) });
  }),
);

videoSopRouter.delete(
  "/jobs/:jobId",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const job = await getVideoSopJob(
      ctx.tenantId,
      ctx.ownerId,
      String(req.params.jobId),
    );
    if (!job) return void res.status(404).json({ error: "Video SOP task not found" });
    await cancelOrDismissVideoSopJob(job);
    res.status(204).send();
  }),
);
