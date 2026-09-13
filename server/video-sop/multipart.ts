import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import type { Request } from "express";
import { videoSopConfig } from "./config";
import { VideoSopError } from "./errors";
import { videoSopJobDirectory, videoSopVideoPath } from "./files";
import type { VideoSopVideo } from "./types";

export interface VideoSopMultipartUpload {
  fields: Record<string, string>;
  videos: VideoSopVideo[];
}

function safeOriginalName(value: string): string {
  return path.basename(value.replace(/\\/g, "/")).replace(/[\r\n]/g, "_").slice(0, 180);
}

async function hasMp4Signature(filePath: string): Promise<boolean> {
  const file = await fsp.open(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return bytesRead >= 8 && header.subarray(4, 8).toString("ascii") === "ftyp";
  } finally {
    await file.close();
  }
}

export async function parseVideoSopMultipart(
  req: Request,
  input: { tenantId: string; ownerId: string; jobId: string },
): Promise<VideoSopMultipartUpload> {
  const contentType = req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new VideoSopError("MULTIPART_REQUIRED", "multipart/form-data is required.", 415);
  }

  const jobDirectory = videoSopJobDirectory(input.tenantId, input.ownerId, input.jobId);
  await fsp.mkdir(jobDirectory, { recursive: true, mode: 0o700 });

  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    const videos: VideoSopVideo[] = [];
    const writes: Promise<void>[] = [];
    let rejected = false;

    const rejectOnce = (error: unknown) => {
      if (rejected) return;
      rejected = true;
      reject(error);
    };

    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          fileSize: videoSopConfig.maxFileBytes,
          files: videoSopConfig.maxVideos,
          fields: 10,
          fieldSize: 10_000,
          parts: videoSopConfig.maxVideos + 10,
        },
      });
    } catch (error) {
      rejectOnce(error);
      return;
    }

    parser.on("field", (name, value) => {
      fields[name] = value;
    });

    parser.on("file", (fieldName, stream, info) => {
      if (fieldName !== "videos") {
        stream.resume();
        rejectOnce(new VideoSopError("INVALID_FILE_FIELD", "Only the videos file field is accepted."));
        return;
      }

      const screen = videos.length;
      const name = safeOriginalName(info.filename || `screen-${screen}.mp4`);
      if (!/\.mp4$/i.test(name) || (info.mimeType && info.mimeType !== "video/mp4" && info.mimeType !== "application/octet-stream")) {
        stream.resume();
        rejectOnce(new VideoSopError("INVALID_VIDEO_TYPE", `${name} must be an MP4 video.`));
        return;
      }

      const target = videoSopVideoPath(input.tenantId, input.ownerId, input.jobId, screen);
      const video: VideoSopVideo = { name, size: 0, screen };
      videos.push(video);
      let limited = false;
      stream.on("data", (chunk: Buffer) => {
        video.size += chunk.byteLength;
      });
      stream.on("limit", () => {
        limited = true;
      });

      writes.push(
        pipeline(stream, fs.createWriteStream(target, { mode: 0o600 })).then(async () => {
          if (limited || stream.truncated) {
            throw new VideoSopError(
              "VIDEO_TOO_LARGE",
              `${name} exceeds the ${Math.floor(videoSopConfig.maxFileBytes / 1024 / 1024)} MB limit.`,
              413,
            );
          }
          if (video.size <= 0) throw new VideoSopError("EMPTY_VIDEO", `${name} is empty.`);
          if (!(await hasMp4Signature(target))) {
            throw new VideoSopError("INVALID_MP4_SIGNATURE", `${name} is not a valid MP4 file.`);
          }
        }).catch(rejectOnce),
      );
    });

    parser.on("filesLimit", () => {
      rejectOnce(
        new VideoSopError(
          "TOO_MANY_VIDEOS",
          `A maximum of ${videoSopConfig.maxVideos} videos can be analyzed at once.`,
        ),
      );
    });
    parser.on("fieldsLimit", () => rejectOnce(new VideoSopError("TOO_MANY_FIELDS", "Too many upload fields.")));
    parser.on("partsLimit", () => rejectOnce(new VideoSopError("TOO_MANY_PARTS", "Too many multipart fields.")));
    parser.on("error", rejectOnce);
    parser.on("finish", () => {
      void (async () => {
        try {
          await Promise.all(writes);
          if (rejected) return;
          if (videos.length === 0) throw new VideoSopError("VIDEO_REQUIRED", "At least one MP4 video is required.");
          resolve({ fields, videos });
        } catch (error) {
          rejectOnce(error);
        }
      })();
    });

    req.pipe(parser);
  });
}
