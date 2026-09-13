import fs from "node:fs/promises";
import path from "node:path";
import { videoSopConfig } from "./config";

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "unknown";
}

export function videoSopJobDirectory(
  tenantId: string,
  ownerId: string,
  jobId: string,
): string {
  return path.join(
    videoSopConfig.root,
    "jobs",
    safeSegment(tenantId),
    safeSegment(ownerId),
    safeSegment(jobId),
  );
}

export function videoSopVideoPath(
  tenantId: string,
  ownerId: string,
  jobId: string,
  screen: number,
): string {
  return path.join(videoSopJobDirectory(tenantId, ownerId, jobId), `${screen}.mp4`);
}

export async function cleanupVideoSopJobFiles(
  tenantId: string,
  ownerId: string,
  jobId: string,
): Promise<void> {
  await fs.rm(videoSopJobDirectory(tenantId, ownerId, jobId), {
    recursive: true,
    force: true,
  });
}
