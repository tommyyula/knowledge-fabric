import { apiJson } from "@/lib/api-client";

interface ApiData<T> {
  data: T;
}

export type VideoSopLanguage = "zh" | "en" | "ja";
export type VideoSopStatus =
  | "queued"
  | "analyzing_video"
  | "generating_sop"
  | "saving_resource"
  | "completed"
  | "failed"
  | "canceled";

export interface VideoSopCapabilities {
  enabled: boolean;
  maxVideos: number;
  maxFileBytes: number;
  languages: VideoSopLanguage[];
}

export interface VideoSopJob {
  id: string;
  status: VideoSopStatus;
  videoNames: string[];
  videoCount: number;
  totalBytes: number;
  ticketId?: string;
  detectedTicketId?: string;
  language: VideoSopLanguage;
  folderId?: string;
  resourceId?: string;
  error?: { code: string; message: string };
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
}

export async function getVideoSopCapabilities(): Promise<VideoSopCapabilities> {
  return (await apiJson<ApiData<VideoSopCapabilities>>("/api/v1/video-sop/capabilities")).data;
}

export async function createVideoSopJob(input: {
  videos: File[];
  ticketId?: string;
  language: VideoSopLanguage;
  folderId?: string;
}): Promise<VideoSopJob> {
  const form = new FormData();
  input.videos.forEach((video) => form.append("videos", video, video.name));
  if (input.ticketId?.trim()) form.append("ticketId", input.ticketId.trim());
  form.append("language", input.language);
  if (input.folderId) form.append("folderId", input.folderId);
  return (
    await apiJson<ApiData<VideoSopJob>>("/api/v1/video-sop/jobs", {
      method: "POST",
      body: form,
    })
  ).data;
}

export async function listVideoSopJobs(): Promise<VideoSopJob[]> {
  return (
    await apiJson<ApiData<{ jobs: VideoSopJob[] }>>("/api/v1/video-sop/jobs")
  ).data.jobs;
}

export async function removeVideoSopJob(jobId: string): Promise<void> {
  await apiJson<void>(`/api/v1/video-sop/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}
