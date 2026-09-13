import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants as fsConstants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import type { Request, Response } from "express";
import { Router } from "express";
import { requireAdminContext } from "../auth/requireTenantContext";
import { env } from "../env";
import { asyncRoute } from "../http";
import {
  MAX_UPLOAD_FILE_BYTES,
  UploadValidationError,
} from "../uploads/multipart";

type EntryType = "directory" | "file" | "symlink" | "other";
type PreviewType = "text" | "image" | "pdf" | null;

interface ResolvedTarget {
  absolutePath: string;
  relativePath: string;
  stats: Stats;
}

interface StagedUpload {
  relativePath: string;
  temporaryPath: string;
}

const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".env",
  ".go",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".py",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const IMAGE_EXTENSIONS = new Set([
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);
const MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export const adminDataRouter = Router();

function requestError(
  status: number,
  message: string,
): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function requestedPath(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string")
    throw requestError(400, "path must be a string");
  const raw = value.trim();
  if (!raw) return "";
  if (
    raw.includes("\0") ||
    path.isAbsolute(raw) ||
    /^[A-Za-z]:[\\/]/.test(raw)
  ) {
    throw requestError(400, "Absolute paths are not allowed");
  }
  const parts = raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.includes(".."))
    throw requestError(400, "Parent paths are not allowed");
  return parts.join("/");
}

function uploadPath(value: string): string {
  const normalized = requestedPath(value);
  if (!normalized) throw requestError(400, "Uploaded files must have a name");
  return normalized;
}

function isWithinRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function realPathOrError(
  value: string,
  missingMessage: string,
): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw requestError(404, missingMessage);
    throw error;
  }
}

async function resolveTarget(value: unknown): Promise<ResolvedTarget> {
  const relativePath = requestedPath(value);
  const root = await realPathOrError(
    path.resolve(env.dataRoot),
    "Data root not found",
  );
  const candidate = path.resolve(root, relativePath);
  if (!isWithinRoot(root, candidate))
    throw requestError(400, "Path escapes data root");
  const absolutePath = await realPathOrError(
    candidate,
    "File or directory not found",
  );
  if (!isWithinRoot(root, absolutePath))
    throw requestError(400, "Path escapes data root");
  return { absolutePath, relativePath, stats: await fs.stat(absolutePath) };
}

async function resolveDeletionTarget(value: unknown): Promise<ResolvedTarget> {
  const relativePath = requestedPath(value);
  if (!relativePath) throw requestError(400, "The data root cannot be deleted");
  const root = await realPathOrError(
    path.resolve(env.dataRoot),
    "Data root not found",
  );
  const absolutePath = path.resolve(root, relativePath);
  if (!isWithinRoot(root, absolutePath))
    throw requestError(400, "Path escapes data root");
  let stats: Stats;
  try {
    stats = await fs.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw requestError(404, "File or directory not found");
    throw error;
  }
  if (stats.isSymbolicLink())
    throw requestError(400, "Symbolic links cannot be deleted");
  if (!stats.isFile() && !stats.isDirectory())
    throw requestError(400, "Only files and directories can be deleted");
  return { absolutePath, relativePath, stats };
}

async function parseUploads(req: Request): Promise<{
  uploads: StagedUpload[];
  cleanup: () => Promise<void>;
}> {
  const contentType = req.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().includes("multipart/form-data")
  )
    throw requestError(415, "multipart/form-data is required");

  const declaredLength = Number(req.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_UPLOAD_FILE_BYTES + 1024 * 1024
  ) {
    throw new UploadValidationError(
      "The upload exceeds the 500 MB limit.",
      413,
    );
  }

  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "knowledge-fabric-admin-upload-"),
  );
  const cleanup = () =>
    fs.rm(temporaryDirectory, { recursive: true, force: true });

  try {
    const uploads = await new Promise<StagedUpload[]>((resolve, reject) => {
      const staged: StagedUpload[] = [];
      const fileWrites: Promise<void>[] = [];
      let totalBytes = 0;
      let settled = false;
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      let parser: ReturnType<typeof Busboy>;
      try {
        parser = Busboy({
          headers: req.headers,
          preservePath: true,
          limits: { fileSize: MAX_UPLOAD_FILE_BYTES, files: 1_000, fields: 10 },
        });
      } catch (error) {
        rejectOnce(error);
        return;
      }

      parser.on("file", (_field, file, info) => {
        let relativePath: string;
        try {
          relativePath = uploadPath(info.filename);
        } catch (error) {
          file.resume();
          rejectOnce(error);
          return;
        }
        const temporaryPath = path.join(temporaryDirectory, randomUUID());
        let fileExceededLimit = false;
        file.on("data", (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
        });
        file.on("limit", () => {
          fileExceededLimit = true;
        });
        fileWrites.push(
          pipeline(file, createWriteStream(temporaryPath)).then(() => {
            if (fileExceededLimit || file.truncated) {
              throw new UploadValidationError(
                "A file exceeds the 500 MB upload limit.",
                413,
              );
            }
            staged.push({ relativePath, temporaryPath });
          }),
        );
      });
      parser.on("filesLimit", () =>
        rejectOnce(new UploadValidationError("Too many files in one upload.")),
      );
      parser.on("error", rejectOnce);
      parser.on("finish", () => {
        void Promise.all(fileWrites)
          .then(() => {
            if (settled) return;
            if (!staged.length)
              throw new UploadValidationError("At least one file is required.");
            if (totalBytes > MAX_UPLOAD_FILE_BYTES) {
              throw new UploadValidationError(
                "The upload exceeds the 500 MB limit.",
                413,
              );
            }
            settled = true;
            resolve(staged);
          })
          .catch(rejectOnce);
      });
      req.pipe(parser);
    });
    return { uploads, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function ensureUploadParent(
  root: string,
  destinationPath: string,
): Promise<void> {
  const relativeParent = path.relative(root, path.dirname(destinationPath));
  let currentPath = root;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    try {
      const stats = await fs.lstat(currentPath);
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw requestError(
          409,
          "An upload folder conflicts with an existing file",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(currentPath);
    }
  }
}

async function saveUploads(
  targetDirectory: string,
  uploads: StagedUpload[],
): Promise<void> {
  const destinationPaths = uploads.map(({ relativePath }) =>
    path.resolve(targetDirectory, relativePath),
  );
  const seen = new Set<string>();
  for (const destinationPath of destinationPaths) {
    if (!isWithinRoot(targetDirectory, destinationPath))
      throw requestError(400, "Upload path escapes the selected directory");
    const key = destinationPath.toLocaleLowerCase();
    if (seen.has(key))
      throw requestError(409, "The upload contains duplicate file names");
    seen.add(key);
    try {
      await fs.lstat(destinationPath);
      throw requestError(409, "A file with the same name already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const writtenPaths: string[] = [];
  try {
    for (let index = 0; index < uploads.length; index += 1) {
      const destinationPath = destinationPaths[index];
      await ensureUploadParent(targetDirectory, destinationPath);
      await fs.copyFile(
        uploads[index].temporaryPath,
        destinationPath,
        fsConstants.COPYFILE_EXCL,
      );
      writtenPaths.push(destinationPath);
    }
  } catch (error) {
    await Promise.all(
      writtenPaths.map((writtenPath) => fs.rm(writtenPath, { force: true })),
    );
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw requestError(409, "A file with the same name already exists");
    throw error;
  }
}

function entryType(stats: Stats): EntryType {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

function previewType(name: string, type: EntryType): PreviewType {
  if (type !== "file") return null;
  const extension = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(extension) || !extension) return "text";
  return null;
}

function contentType(name: string): string {
  const extension = path.extname(name).toLowerCase();
  if (MIME_TYPES[extension]) return MIME_TYPES[extension];
  if (extension === ".md" || extension === ".mdx")
    return "text/markdown; charset=utf-8";
  if (TEXT_EXTENSIONS.has(extension) || !extension)
    return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function downloadName(value: string): string {
  return value.replace(/["\r\n]/g, "_") || "data";
}

function contentDisposition(
  kind: "inline" | "attachment",
  name: string,
): string {
  const safeName = downloadName(name);
  const asciiName = safeName.replace(/[^\x20-\x7E]/g, "_");
  return `${kind}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function sendAbsoluteFile(res: Response, absolutePath: string): void {
  res.sendFile(absolutePath, (error) => {
    if (!error) return;
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res
      .status(
        (error as NodeJS.ErrnoException & { statusCode?: number }).statusCode ||
          500,
      )
      .json({ error: error.message });
  });
}

adminDataRouter.get(
  "/entries",
  asyncRoute(async (req, res) => {
    await requireAdminContext(req);
    const target = await resolveTarget(req.query.path);
    if (!target.stats.isDirectory())
      throw requestError(400, "Path is not a directory");

    const names = await fs.readdir(target.absolutePath);
    const entries = (
      await Promise.all(
        names.map(async (name) => {
          try {
            const stats = await fs.lstat(path.join(target.absolutePath, name));
            const type = entryType(stats);
            return {
              name,
              path: path.posix.join(target.relativePath, name),
              type,
              size: type === "file" ? stats.size : null,
              modifiedAt: stats.mtime.toISOString(),
              previewType: previewType(name, type),
            };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        }),
      )
    ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    entries.sort((left, right) => {
      const leftDirectory = left.type === "directory" ? 0 : 1;
      const rightDirectory = right.type === "directory" ? 0 : 1;
      return (
        leftDirectory - rightDirectory || left.name.localeCompare(right.name)
      );
    });

    res.json({
      data: { root: env.dataRoot, path: target.relativePath, entries },
    });
  }),
);

adminDataRouter.post(
  "/uploads",
  asyncRoute(async (req, res) => {
    await requireAdminContext(req);
    const target = await resolveTarget(req.query.path);
    if (!target.stats.isDirectory())
      throw requestError(400, "Path is not a directory");

    const { uploads, cleanup } = await parseUploads(req);
    try {
      await saveUploads(target.absolutePath, uploads);
      res.status(201).json({ data: { uploaded: uploads.length } });
    } finally {
      await cleanup();
    }
  }),
);

adminDataRouter.delete(
  "/entries",
  asyncRoute(async (req, res) => {
    await requireAdminContext(req);
    const target = await resolveDeletionTarget(req.body?.path);
    await fs.rm(target.absolutePath, {
      recursive: target.stats.isDirectory(),
      force: false,
      maxRetries: 2,
    });
    res.status(204).end();
  }),
);

adminDataRouter.get(
  "/preview",
  asyncRoute(async (req, res) => {
    await requireAdminContext(req);
    const target = await resolveTarget(req.query.path);
    if (!target.stats.isFile()) throw requestError(400, "Path is not a file");
    if (target.stats.size > MAX_TEXT_PREVIEW_BYTES)
      throw requestError(413, "File is too large to preview");

    const data = await fs.readFile(target.absolutePath);
    if (data.subarray(0, Math.min(data.length, 4096)).includes(0)) {
      throw requestError(415, "Binary file preview is not supported");
    }
    res.json({
      data: {
        path: target.relativePath,
        content: data.toString("utf8").replace(/^\uFEFF/, ""),
        contentType: contentType(target.absolutePath),
      },
    });
  }),
);

adminDataRouter.get(
  "/content",
  asyncRoute(async (req, res) => {
    await requireAdminContext(req);
    const target = await resolveTarget(req.query.path);
    if (!target.stats.isFile()) throw requestError(400, "Path is not a file");
    res.header("Content-Type", contentType(target.absolutePath));
    res.header(
      "Content-Disposition",
      contentDisposition("inline", path.basename(target.absolutePath)),
    );
    res.header("X-Content-Type-Options", "nosniff");
    sendAbsoluteFile(res, target.absolutePath);
  }),
);

adminDataRouter.get(
  "/download",
  asyncRoute(async (req, res) => {
    await requireAdminContext(req);
    const target = await resolveTarget(req.query.path);
    const baseName = path.basename(target.absolutePath);

    if (target.stats.isFile()) {
      res.header("Content-Type", "application/octet-stream");
      res.header(
        "Content-Disposition",
        contentDisposition("attachment", baseName),
      );
      sendAbsoluteFile(res, target.absolutePath);
      return;
    }
    if (!target.stats.isDirectory())
      throw requestError(400, "Path cannot be downloaded");

    res.header("Content-Type", "application/gzip");
    res.header(
      "Content-Disposition",
      contentDisposition("attachment", `${baseName}.tar.gz`),
    );
    const archive = spawn(
      "tar",
      [
        "-czf",
        "-",
        "-C",
        path.dirname(target.absolutePath),
        "--",
        path.basename(target.absolutePath),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    archive.stderr.setEncoding("utf8");
    archive.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    req.on("aborted", () => archive.kill());
    archive.stdout.pipe(res);

    try {
      await new Promise<void>((resolve, reject) => {
        archive.once("error", reject);
        archive.once("close", (code) => {
          if (code === 0 || req.aborted) resolve();
          else
            reject(
              new Error(
                stderr.trim() || `tar exited with code ${code ?? "unknown"}`,
              ),
            );
        });
      });
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error as Error);
        return;
      }
      throw error;
    }
  }),
);
