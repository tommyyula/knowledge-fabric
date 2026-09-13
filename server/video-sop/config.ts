import path from "node:path";
import { env } from "../env";

const DEFAULT_MAX_VIDEOS = 4;
const DEFAULT_MAX_FILE_BYTES = 7 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_JOBS = 2;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const videoSopConfig = {
  apiKey: process.env.DASHSCOPE_API_KEY?.trim() ?? "",
  baseUrl: (
    process.env.DASHSCOPE_BASE_URL ??
    "https://dashscope-us.aliyuncs.com/compatible-mode/v1"
  ).replace(/\/$/, ""),
  visionModel: process.env.DASHSCOPE_VL_MODEL?.trim() || "qwen3.7-plus",
  sopModel: process.env.DASHSCOPE_SOP_MODEL?.trim() || "qwen3.7-plus",
  maxVideos: positiveInteger(process.env.VIDEO_SOP_MAX_VIDEOS, DEFAULT_MAX_VIDEOS),
  maxFileBytes: positiveInteger(
    process.env.VIDEO_SOP_MAX_FILE_BYTES,
    DEFAULT_MAX_FILE_BYTES,
  ),
  maxConcurrentJobs: positiveInteger(
    process.env.VIDEO_SOP_MAX_CONCURRENT_JOBS,
    DEFAULT_MAX_CONCURRENT_JOBS,
  ),
  analysisTimeoutMs: positiveInteger(
    process.env.VIDEO_SOP_ANALYSIS_TIMEOUT_MS,
    30 * 60 * 1000,
  ),
  sopTimeoutMs: positiveInteger(
    process.env.VIDEO_SOP_GENERATION_TIMEOUT_MS,
    10 * 60 * 1000,
  ),
  root: path.join(env.dataRoot, "video-sop"),
};

export function videoSopEnabled(): boolean {
  return Boolean(videoSopConfig.apiKey);
}
