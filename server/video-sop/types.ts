export const VIDEO_SOP_LANGUAGES = ["zh", "en", "ja"] as const;

export type VideoSopLanguage = (typeof VIDEO_SOP_LANGUAGES)[number];

export type VideoSopStatus =
  | "queued"
  | "analyzing_video"
  | "generating_sop"
  | "saving_resource"
  | "completed"
  | "failed"
  | "canceled";

export interface VideoSopVideo {
  name: string;
  size: number;
  screen: number;
}

export interface VideoSopJobError {
  code: string;
  message: string;
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
  error?: VideoSopJobError;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
}

export interface VideoSopJobRecord extends VideoSopJob {
  tenantId: string;
  ownerId: string;
  videos: VideoSopVideo[];
  expiresAt: string;
}

export const ACTIVE_VIDEO_SOP_STATUSES = new Set<VideoSopStatus>([
  "queued",
  "analyzing_video",
  "generating_sop",
  "saving_resource",
]);

export function publicVideoSopJob(record: VideoSopJobRecord): VideoSopJob {
  return {
    id: record.id,
    status: record.status,
    videoNames: record.videoNames,
    videoCount: record.videoCount,
    totalBytes: record.totalBytes,
    ...(record.ticketId ? { ticketId: record.ticketId } : {}),
    ...(record.detectedTicketId
      ? { detectedTicketId: record.detectedTicketId }
      : {}),
    language: record.language,
    ...(record.folderId ? { folderId: record.folderId } : {}),
    ...(record.resourceId ? { resourceId: record.resourceId } : {}),
    ...(record.error ? { error: record.error } : {}),
    createdAt: record.createdAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    updatedAt: record.updatedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
  };
}
