import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import type { Request } from "express";
import { isSystemMetadataUploadPath } from "./system-files";

const DEFAULT_MAX_UPLOAD_FILE_BYTES = 500 * 1024 * 1024;

export const MAX_UPLOAD_FILE_BYTES = Number(process.env.ONTOLOGY_MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_FILE_BYTES);

export class UploadValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "UploadValidationError";
  }
}

export interface MultipartUpload {
  name: string;
  contentType?: string;
  path: string;
  size: number;
  fields: Record<string, string>;
  ignored?: true;
}

export function isMultipartRequest(req: Request): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().includes("multipart/form-data");
}

export function formatUploadSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export async function cleanupMultipartUpload(upload: Pick<MultipartUpload, "path"> | null | undefined): Promise<void> {
  if (!upload?.path) return;
  await fsp.rm(path.dirname(upload.path), { recursive: true, force: true }).catch(() => undefined);
}

export async function readMultipartUpload(upload: MultipartUpload): Promise<Buffer> {
  return fsp.readFile(upload.path);
}

export async function parseSingleMultipartUpload(req: Request): Promise<MultipartUpload> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    let fileCount = 0;
    let tempDir: string | null = null;
    let filePromise: Promise<MultipartUpload | null> | null = null;
    let settled = false;

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (tempDir) void fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      reject(error);
    };

    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_UPLOAD_FILE_BYTES,
          files: 1,
          fields: 20,
          fieldSize: 10_000,
        },
      });
    } catch (error) {
      rejectOnce(error);
      return;
    }

    parser.on("field", (name, value) => {
      fields[name] = value;
    });

    parser.on("file", (_fieldName, file, info) => {
      fileCount += 1;
      if (fileCount > 1) {
        file.resume();
        rejectOnce(new UploadValidationError("Only one file can be uploaded at a time."));
        return;
      }

      filePromise = (async () => {
        const filename = info.filename || "upload.bin";
        if (isSystemMetadataUploadPath(filename)) {
          await new Promise<void>((resolve, rejectStream) => {
            file.on("end", resolve);
            file.on("error", rejectStream);
            file.resume();
          });
          return {
            name: filename,
            ...(info.mimeType ? { contentType: info.mimeType } : {}),
            path: "",
            size: 0,
            fields: { ...fields },
            ignored: true as const,
          };
        }

        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "knowledge-fabric-upload-"));
        const tempPath = path.join(tempDir, randomUUID());
        let size = 0;
        let limited = false;

        file.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
        });
        file.on("limit", () => {
          limited = true;
        });

        await pipeline(file, fs.createWriteStream(tempPath));

        if (limited || file.truncated) {
          throw new UploadValidationError(`${filename} exceeds the ${formatUploadSize(MAX_UPLOAD_FILE_BYTES)} upload limit.`, 413);
        }
        if (size <= 0) throw new UploadValidationError("Uploaded file is empty.");

        return {
          name: filename,
          ...(info.mimeType ? { contentType: info.mimeType } : {}),
          path: tempPath,
          size,
          fields: { ...fields },
        };
      })().catch((error: unknown) => {
        rejectOnce(error);
        return null;
      });
    });

    parser.on("filesLimit", () => {
      rejectOnce(new UploadValidationError("Only one file can be uploaded at a time."));
    });
    parser.on("fieldsLimit", () => {
      rejectOnce(new UploadValidationError("Too many upload fields."));
    });
    parser.on("error", rejectOnce);
    parser.on("finish", () => {
      void (async () => {
        try {
          if (!filePromise) throw new UploadValidationError("file is required");
          const upload = await filePromise;
          if (!upload || settled) return;
          settled = true;
          resolve({ ...upload, fields: { ...fields } });
        } catch (error) {
          rejectOnce(error);
        }
      })();
    });

    req.pipe(parser);
  });
}
