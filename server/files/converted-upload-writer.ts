import path from "node:path";
import { markitdownConverter, type MarkitdownConversionResult } from "./markitdown-converter";
import {
  recordSourceFile,
  saveOriginalSourceFile,
  writeExtractionReport,
  type ExtractionLossRisk,
  type ExtractionMediaEvidence,
  type OriginalSourceFile,
  type SourceExtractionReport,
  type SourceFileConverter,
  type SourceFileConversionStatus,
} from "./source-file-store";
import { writeFile } from "../ontologies/workspace";
import { isSystemMetadataUploadPath } from "../uploads/system-files";

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".csv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs", ".sql", ".css", ".scss", ".log"]);
const MARKITDOWN_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".msg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip"]);

export interface ConvertedUploadInput {
  name: string;
  data: Buffer;
  fallbackText?: string;
  contentType?: string;
}

export interface ConvertedUploadFile {
  path: string;
  name: string;
  size: number;
  converted: boolean;
  converter: SourceFileConverter;
  sourceName?: string;
  originalPath: string;
  originalName: string;
  conversionStatus: SourceFileConversionStatus;
  conversionError?: string;
  extractionReportPath?: string;
  lossRisk?: ExtractionLossRisk;
  extractionWarnings?: string[];
}

function safeUploadName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._\- ()]/gu, "_").trim();
  if (!base || base === "." || base === "..") return `upload-${Date.now()}.txt`;
  return base.length > 180 ? `${base.slice(0, 120)}-${Date.now()}${path.extname(base).slice(0, 20)}` : base;
}

function safeUploadPath(name: string): string {
  return name
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map(safeUploadName)
    .join("/");
}

function markdownOutputName(name: string): string {
  const ext = path.extname(name);
  if (!ext || ext.toLowerCase() === ".md" || ext.toLowerCase() === ".markdown") return name;
  return `${name.slice(0, -ext.length)}.md`;
}

function conversionStatusFor(originalName: string, converted: MarkitdownConversionResult, forcedFailure: boolean): SourceFileConversionStatus {
  if (forcedFailure) return "failed";
  if (converted.converter === "markitdown") return "converted";
  const originalExt = path.extname(originalName).toLowerCase();
  if (!converted.converted && originalExt && !TEXT_EXTENSIONS.has(originalExt)) return "failed";
  return converted.converted ? "converted" : "not_required";
}

function conversionFailureMarkdown(input: { name: string; original: OriginalSourceFile; error: string }): string {
  return [
    `# ${path.basename(input.name)}`,
    "",
    `Source file: \`${input.original.originalPath}\``,
    "",
    "Markdown conversion failed. This file is a placeholder so the upload remains visible in `raw/`.",
    "",
    "To inspect the original source, call `knowledge_get_source_file` or `knowledge_list_source_files`, then use Claude's `Read` tool on the `originalPath`.",
    "",
    "## Conversion error",
    "",
    "```text",
    input.error.slice(0, 2000),
    "```",
  ].join("\n");
}

function sourceExtension(name: string): string {
  const [withoutFragment] = name.split("#");
  return path.extname(withoutFragment).toLowerCase();
}

function countImageOcrBlocks(markdown: string): number {
  return (markdown.match(/\*\[Image OCR\]/g) ?? []).length;
}

function emfWmfMediaFromMarkdown(markdown: string): ExtractionMediaEvidence[] {
  return Array.from(markdown.matchAll(/^### (.+?\.(?:emf|wmf))$/gim)).map((match) => ({
    path: match[1]?.trim() ?? "embedded-vector-media",
    type: path.extname(match[1] ?? "").replace(/^\./, "").toLowerCase() || "emf/wmf",
    handling: "utf16_strings_extracted",
    textExtracted: true,
    layoutRecovered: false,
    warnings: ["EMF/WMF text was extracted from embedded strings; visual layout was not recovered."],
  }));
}

function buildExtractionReport(input: {
  markdownPath: string;
  original: OriginalSourceFile;
  converted: MarkitdownConversionResult;
  conversionStatus: SourceFileConversionStatus;
  conversionError?: string;
}): SourceExtractionReport {
  const warnings: string[] = [];
  const sourceName = input.converted.sourceName ?? input.original.originalName;
  const ext = sourceExtension(sourceName || input.original.originalName);
  const imageOcrBlocks = countImageOcrBlocks(input.converted.markdown) + (input.converted.vision?.processedImages ?? 0);
  const media = emfWmfMediaFromMarkdown(input.converted.markdown);

  if (input.conversionStatus === "failed") {
    warnings.push("Markdown conversion failed; generated Markdown is a placeholder and original source must be used.");
  }
  if (ext && !TEXT_EXTENSIONS.has(ext) && !MARKITDOWN_EXTENSIONS.has(ext)) {
    warnings.push(`Unsupported source extension ${ext} was converted opportunistically; verify the original source before trusting Markdown.`);
  }
  if (media.length) {
    warnings.push("Embedded EMF/WMF media was handled by string extraction only; table/image layout was not recovered.");
  }
  if ([".xls", ".xlsx"].includes(ext)) {
    warnings.push("Spreadsheet values were extracted to Markdown; formulas, styles, hidden sheets, comments, and merged-cell layout may not be preserved.");
  }
  if ([".pdf"].includes(ext) && imageOcrBlocks === 0) {
    warnings.push("PDF conversion did not report image OCR blocks; scanned pages or visual layout may be incomplete.");
  }
  if (ext === ".pdf" && input.converted.converter === "pdftotext") {
    warnings.push("PDF text was extracted with pdftotext; tables, figures, images, and visual layout may require reviewing the original PDF.");
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext) && imageOcrBlocks === 0 && input.converted.converter === "markitdown") {
    warnings.push("Image conversion did not report OCR blocks; verify visual content against the original source when details matter.");
  }
  if (input.converted.vision?.processedImages) {
    warnings.push(`Vision extraction processed ${input.converted.vision.processedImages} image${input.converted.vision.processedImages === 1 ? "" : "s"}.`);
  }
  if (input.converted.vision?.failedImages || input.converted.vision?.skippedImages) {
    warnings.push(`Vision extraction did not process ${input.converted.vision.failedImages + input.converted.vision.skippedImages} image${input.converted.vision.failedImages + input.converted.vision.skippedImages === 1 ? "" : "s"}; review original source for missed visual content.`);
  }
  if (input.converted.json?.warnings.length) {
    warnings.push(...input.converted.json.warnings);
  }

  const lossRisk: ExtractionLossRisk = input.conversionStatus === "failed"
    ? "high"
    : warnings.length
      ? "medium"
      : "low";

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    markdownPath: input.markdownPath,
    originalPath: input.original.originalPath,
    originalName: input.original.originalName,
    ...(input.converted.sourceName ? { sourceName: input.converted.sourceName } : {}),
    converter: input.converted.converter,
    conversionStatus: input.conversionStatus,
    ...(input.conversionError ? { conversionError: input.conversionError } : {}),
    lossRisk,
    warnings,
    content: {
      markdownBytes: Buffer.byteLength(input.converted.markdown, "utf-8"),
      imageOcrBlocks,
      emfWmfFallbackBlocks: media.length,
    },
    ...(input.converted.vision ? {
      vision: {
        enabled: input.converted.vision.enabled,
        model: input.converted.vision.model,
        processedImages: input.converted.vision.processedImages,
        failedImages: input.converted.vision.failedImages,
        skippedImages: input.converted.vision.skippedImages,
        images: input.converted.vision.images.map((image) => ({
          location: image.location,
          ...(image.filename ? { filename: image.filename } : {}),
          ...(image.mimeType ? { mimeType: image.mimeType } : {}),
          ...(image.bytes !== undefined ? { bytes: image.bytes } : {}),
          status: image.status,
          ...(image.error ? { error: image.error } : {}),
        })),
      },
    } : {}),
    ...(input.converted.json ? { json: input.converted.json } : {}),
    media,
  };
}

export function safeConvertedUploadPath(name: string): string {
  return safeUploadPath(name) || safeUploadName(name);
}

export async function writeConvertedUploads(root: string, targetDir: string, input: ConvertedUploadInput): Promise<ConvertedUploadFile[]> {
  if (isSystemMetadataUploadPath(input.name)) return [];
  const original = await saveOriginalSourceFile(root, { name: input.name, data: input.data, contentType: input.contentType });
  let forcedFailure = false;
  let conversionError: string | undefined;
  let convertedFiles: MarkitdownConversionResult[];
  try {
    convertedFiles = await markitdownConverter.convertMany({ name: input.name, data: input.data, fallbackText: input.fallbackText, contentType: input.contentType });
  } catch (error) {
    forcedFailure = true;
    conversionError = error instanceof Error ? error.message : String(error);
    convertedFiles = [{
      markdown: conversionFailureMarkdown({ name: input.name, original, error: conversionError }),
      outputName: markdownOutputName(input.name),
      converted: false,
      converter: "text",
      sourceName: input.name,
    }];
  }

  const files: ConvertedUploadFile[] = [];
  for (const converted of convertedFiles) {
    const safeName = safeConvertedUploadPath(converted.outputName);
    if (isSystemMetadataUploadPath(safeName)) continue;
    const relativePath = path.posix.join(targetDir, safeName);
    await writeFile(root, relativePath, converted.markdown);
    const conversionStatus = conversionStatusFor(converted.sourceName ?? input.name, converted, forcedFailure);
    const fileConversionError = conversionError ?? (conversionStatus === "failed" ? "Markdown conversion failed or was unavailable; use originalPath for source fidelity." : undefined);
    const extractionReport = buildExtractionReport({ markdownPath: relativePath, original, converted, conversionStatus, conversionError: fileConversionError });
    const extractionReportPath = await writeExtractionReport(root, original.id, relativePath, extractionReport);
    const sourceRecord = await recordSourceFile(root, {
      ...original,
      markdownPath: relativePath,
      sourceName: converted.sourceName,
      converter: converted.converter,
      conversionStatus,
      ...(fileConversionError ? { conversionError: fileConversionError } : {}),
      extractionReportPath,
      lossRisk: extractionReport.lossRisk,
      extractionWarnings: extractionReport.warnings,
    });
    files.push({
      path: relativePath,
      name: path.posix.basename(safeName),
      size: Buffer.byteLength(converted.markdown, "utf-8"),
      converted: converted.converted,
      converter: converted.converter,
      sourceName: converted.sourceName,
      originalPath: sourceRecord.originalPath,
      originalName: sourceRecord.originalName,
      conversionStatus,
      conversionError: fileConversionError,
      extractionReportPath,
      lossRisk: extractionReport.lossRisk,
      extractionWarnings: extractionReport.warnings,
    });
  }
  return files;
}
