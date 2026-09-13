import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type SourceFileConversionStatus = "converted" | "not_required" | "failed";
export type SourceFileConverter = "markitdown" | "text" | "pdftotext" | "vision" | "json";
export type ExtractionLossRisk = "low" | "medium" | "high";

export interface OriginalSourceFile {
  id: string;
  originalPath: string;
  originalName: string;
  size: number;
  sha256: string;
  contentType?: string;
  extension?: string;
  createdAt: string;
}

export interface SourceFileRecord extends OriginalSourceFile {
  markdownPath: string;
  sourceName?: string;
  converter?: SourceFileConverter;
  conversionStatus: SourceFileConversionStatus;
  conversionError?: string;
  extractionReportPath?: string;
  lossRisk?: ExtractionLossRisk;
  extractionWarnings?: string[];
}

export interface ExtractionMediaEvidence {
  path: string;
  type: string;
  handling: string;
  textExtracted: boolean;
  layoutRecovered: boolean;
  warnings?: string[];
}

export interface JsonExtractionSummary {
  parseStatus: "parsed" | "failed" | "skipped_too_large";
  topLevelType?: string;
  fullJsonTruncated: boolean;
  warnings: string[];
  error?: string;
}

export interface SourceExtractionReport {
  version: 1;
  generatedAt: string;
  markdownPath: string;
  originalPath: string;
  originalName: string;
  sourceName?: string;
  converter?: SourceFileConverter;
  conversionStatus: SourceFileConversionStatus;
  conversionError?: string;
  lossRisk: ExtractionLossRisk;
  warnings: string[];
  content: {
    markdownBytes: number;
    imageOcrBlocks: number;
    emfWmfFallbackBlocks: number;
  };
  vision?: {
    enabled: boolean;
    model?: string;
    processedImages: number;
    failedImages: number;
    skippedImages: number;
    images: Array<{
      location: string;
      filename?: string;
      mimeType?: string;
      bytes?: number;
      status: "processed" | "skipped" | "failed";
      error?: string;
    }>;
  };
  json?: JsonExtractionSummary;
  media: ExtractionMediaEvidence[];
}

const SOURCE_FILE_ROOT = ".runtime/source-files";
const SOURCE_FILE_MANIFEST = `${SOURCE_FILE_ROOT}/manifest.json`;

function safeSegment(value: string): string {
  const safe = path.basename(value.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._\- ()]/gu, "_").trim();
  return safe && safe !== "." && safe !== ".." ? safe.slice(0, 180) : "source-file.bin";
}

function normalizeRelative(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) throw new Error("Invalid source file path");
  return normalized;
}

function resolveWorkspaceFile(root: string, requested: string): string {
  const normalized = normalizeRelative(requested);
  const resolved = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error("Path escapes ontology workspace");
  }
  return resolved;
}

async function readManifest(root: string): Promise<SourceFileRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(resolveWorkspaceFile(root, SOURCE_FILE_MANIFEST), "utf-8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isSourceFileRecord) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeManifest(root: string, records: readonly SourceFileRecord[]): Promise<void> {
  const file = resolveWorkspaceFile(root, SOURCE_FILE_MANIFEST);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(records, null, 2)}\n`, "utf-8");
}

function isSourceFileRecord(value: unknown): value is SourceFileRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SourceFileRecord>;
  return typeof record.id === "string"
    && typeof record.markdownPath === "string"
    && typeof record.originalPath === "string"
    && typeof record.originalName === "string"
    && typeof record.size === "number"
    && typeof record.sha256 === "string"
    && typeof record.createdAt === "string"
    && (record.conversionStatus === "converted" || record.conversionStatus === "not_required" || record.conversionStatus === "failed");
}

export async function saveOriginalSourceFile(root: string, input: { name: string; data: Buffer; contentType?: string }): Promise<OriginalSourceFile> {
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const originalName = safeSegment(input.name);
  const originalPath = `${SOURCE_FILE_ROOT}/${id}/${originalName}`;
  const file = resolveWorkspaceFile(root, originalPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, input.data);
  return {
    id,
    originalPath,
    originalName,
    size: input.data.byteLength,
    sha256: createHash("sha256").update(input.data).digest("hex"),
    ...(input.contentType ? { contentType: input.contentType } : {}),
    ...(path.extname(originalName) ? { extension: path.extname(originalName).toLowerCase() } : {}),
    createdAt: new Date().toISOString(),
  };
}

export async function recordSourceFile(root: string, input: OriginalSourceFile & {
  markdownPath: string;
  sourceName?: string;
  converter?: SourceFileConverter;
  conversionStatus: SourceFileConversionStatus;
  conversionError?: string;
  extractionReportPath?: string;
  lossRisk?: ExtractionLossRisk;
  extractionWarnings?: string[];
}): Promise<SourceFileRecord> {
  const record: SourceFileRecord = {
    ...input,
    markdownPath: normalizeRelative(input.markdownPath),
    originalPath: normalizeRelative(input.originalPath),
    ...(input.extractionReportPath ? { extractionReportPath: normalizeRelative(input.extractionReportPath) } : {}),
  };
  const records = await readManifest(root);
  const next = [
    record,
    ...records.filter((item) => item.markdownPath !== record.markdownPath),
  ];
  await writeManifest(root, next);
  return record;
}

export async function writeExtractionReport(root: string, uploadId: string, markdownPath: string, report: SourceExtractionReport): Promise<string> {
  const hash = createHash("sha1").update(markdownPath).digest("hex").slice(0, 12);
  const reportPath = `${SOURCE_FILE_ROOT}/${safeSegment(uploadId)}/reports/${hash}.json`;
  const file = resolveWorkspaceFile(root, reportPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return reportPath;
}

export async function readExtractionReport(root: string, pathOrMarkdown: string): Promise<SourceExtractionReport | null> {
  const record = await getSourceFile(root, pathOrMarkdown);
  if (!record?.extractionReportPath) return null;
  const parsed = JSON.parse(await fs.readFile(resolveWorkspaceFile(root, record.extractionReportPath), "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as SourceExtractionReport;
}

export async function listSourceFiles(root: string, markdownPath?: string): Promise<SourceFileRecord[]> {
  const records = await readManifest(root);
  if (!markdownPath?.trim()) return records;
  const target = normalizeRelative(markdownPath);
  return records.filter((record) => record.markdownPath === target || record.originalPath === target);
}

export async function getSourceFile(root: string, pathOrMarkdown: string): Promise<SourceFileRecord | null> {
  return (await listSourceFiles(root, pathOrMarkdown))[0] ?? null;
}

export function sourceFileReadHint(record: Pick<SourceFileRecord, "originalPath" | "conversionStatus" | "extension" | "lossRisk">): string {
  if (record.conversionStatus === "failed") return `Use Read on ${record.originalPath}; the Markdown file is only a conversion-failure placeholder.`;
  if (record.lossRisk === "high") return `Use Read on ${record.originalPath}; extraction report marks this conversion as high loss risk.`;
  if (record.lossRisk === "medium") return `Read the Markdown and extraction report first; use Read on ${record.originalPath} when table layout or source fidelity matters.`;
  if (record.extension && [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(record.extension)) {
    return `Use Read on ${record.originalPath} when visual layout, images, tables, or PDF pages matter.`;
  }
  return `Prefer the Markdown file for normal ingest; use Read on ${record.originalPath} only when source fidelity is needed.`;
}
