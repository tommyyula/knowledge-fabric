import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_AZURE_OPENAI_BASE_URL = "https://admin-mb0gbyil-eastus2.cognitiveservices.azure.com/openai/v1";
const DEFAULT_AZURE_OPENAI_CHAT_COMPLETIONS_URL = `${DEFAULT_AZURE_OPENAI_BASE_URL}/chat/completions`;
const DEFAULT_OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const VISION_IMAGE_COMPRESSION_THRESHOLD_BYTES = 5 * 1024 * 1024;
const VISION_IMAGE_COMPRESSION_MAX_EDGE = 3000;
const VISION_IMAGE_COMPRESSION_QUALITIES = [88, 85, 82] as const;
const DEFAULT_DOCUMENT_CONVERSION_TIMEOUT_MS = 240_000;
const DEFAULT_PDF_MAX_PAGES = 500;
const DEFAULT_PDF_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_PRESENTATION_MAX_SLIDES = 60;
const DEFAULT_PRESENTATION_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_WORD_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_VISION_MAX_NORMALIZED_IMAGE_BYTES_PER_DOCUMENT = 120 * 1024 * 1024;
const DEFAULT_JSON_PARSE_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_JSON_FULL_MARKDOWN_MAX_CHARS = 1_000_000;
const DEFAULT_JSON_RAW_PREVIEW_MAX_CHARS = 200_000;
const VISION_TIMEOUT_RETRY_COUNT = 1;

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".sql",
  ".css",
  ".scss",
  ".log",
]);

const MARKITDOWN_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".msg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

const STANDALONE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VISION_OFFICE_EXTENSIONS = new Set([".docx", ".pptx", ".xlsx"]);

const GLOBAL_LLM_ENV_KEYS = [
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_CHAT_COMPLETIONS_URL",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_MODEL",
  "ONTOLOGY_PROXY_MODEL",
  "STEWARD_PROXY_MODEL",
] as const;

export interface MarkitdownConversionInput {
  name: string;
  data: Buffer;
  fallbackText?: string;
  contentType?: string;
}

export interface JsonExtractionSummary {
  parseStatus: "parsed" | "failed" | "skipped_too_large";
  topLevelType?: string;
  fullJsonTruncated: boolean;
  warnings: string[];
  error?: string;
}

export interface MarkitdownConversionResult {
  markdown: string;
  outputName: string;
  converted: boolean;
  converter: "markitdown" | "text" | "pdftotext" | "vision" | "json";
  sourceName?: string;
  vision?: VisionExtractionSummary;
  json?: JsonExtractionSummary;
}

export interface VisionExtractionImageResult {
  location: string;
  filename?: string;
  mimeType?: string;
  bytes?: number;
  anchor?: VisionAnchor;
  status: "processed" | "skipped" | "failed";
  markdown?: string;
  error?: string;
}

export interface VisionExtractionSummary {
  enabled: boolean;
  model?: string;
  processedImages: number;
  failedImages: number;
  skippedImages: number;
  images: VisionExtractionImageResult[];
}

interface VisionImageCandidate {
  location: string;
  filename?: string;
  mimeType: string;
  data: Buffer;
  anchor?: VisionAnchor;
  contextText?: string;
  width?: number;
  height?: number;
}

export type VisionAnchor =
  | { kind: "pdf-page"; page: number; region?: string; replacePageText?: boolean; textHints?: string[] }
  | { kind: "ppt-slide"; slide: number }
  | { kind: "docx-paragraph"; paragraphText?: string; beforeText?: string; afterText?: string }
  | { kind: "xlsx-sheet"; sheetName?: string; cell?: string; row?: number; col?: number }
  | { kind: "document" };

function markdownOutputName(name: string): string {
  const ext = path.extname(name);
  if (!ext || ext.toLowerCase() === ".md" || ext.toLowerCase() === ".markdown") return name;
  return `${name.slice(0, -ext.length)}.md`;
}

function isMarkdown(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

function isZip(name: string): boolean {
  return path.extname(name).toLowerCase() === ".zip";
}

function isExcel(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext === ".xls" || ext === ".xlsx";
}

function isPdf(name: string): boolean {
  return path.extname(name).toLowerCase() === ".pdf";
}

function isPresentation(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext === ".ppt" || ext === ".pptx";
}

function isWordDocument(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext === ".doc" || ext === ".docx";
}

function isStandaloneImage(name: string): boolean {
  return STANDALONE_IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function isVisionOfficeDocument(name: string): boolean {
  return VISION_OFFICE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function safeZipFolderName(name: string): string {
  const ext = path.extname(name);
  const base = (ext ? name.slice(0, -ext.length) : name).replace(/\\/g, "/").split("/").pop() ?? "archive";
  const safe = base.replace(/[^\p{L}\p{N}_.\- ()]/gu, "_").trim();
  return safe || `archive-${Date.now()}`;
}

function safeSheetFileName(name: string): string {
  const safe = name.replace(/[^\p{L}\p{N}._\- ()]/gu, "_").trim();
  return safe || "sheet";
}

function excelSheetOutputName(workbookName: string, sheetName: string, sheetCount: number): string {
  const normalized = workbookName.replace(/\\/g, "/");
  const ext = path.posix.extname(normalized);
  const workbookPath = ext ? normalized.slice(0, -ext.length) : normalized;
  const workbookDir = path.posix.dirname(workbookPath);
  const workbookStem = path.posix.basename(workbookPath);
  const outputFile = sheetCount <= 1
    ? `${workbookStem}.md`
    : `${workbookStem}_${safeSheetFileName(sheetName)}.md`;
  return workbookDir === "." ? outputFile : path.posix.join(workbookDir, outputFile);
}

function decodeAsText(buffer: Buffer): string {
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function isTextLike(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function contentTypeMediaType(contentType?: string): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function isJsonContentType(contentType?: string): boolean {
  const mediaType = contentTypeMediaType(contentType);
  return mediaType === "application/json" || mediaType === "text/json" || mediaType.endsWith("+json");
}

function isJsonInput(name: string, contentType?: string): boolean {
  const ext = path.extname(name.split("#")[0] ?? name).toLowerCase();
  return ext === ".json" || isJsonContentType(contentType);
}

function isSupportedArchiveEntry(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || MARKITDOWN_EXTENSIONS.has(ext);
}

function markitdownPythonEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const explicitlyConfiguredLlm = Boolean(
    env.MARKITDOWN_LLM_MODEL ||
    env.MARKITDOWN_LLM_API_KEY ||
    env.MARKITDOWN_LLM_BASE_URL ||
    env.MARKITDOWN_ALLOW_GLOBAL_LLM_ENV === "true"
  );
  if (!explicitlyConfiguredLlm) {
    for (const key of GLOBAL_LLM_ENV_KEYS) delete env[key];
  }
  return env;
}

function markitdownPythonCommand(configured?: string): string {
  if (configured) return configured;
  if (process.env.MARKITDOWN_PYTHON) return process.env.MARKITDOWN_PYTHON;
  const localPython = path.resolve(process.cwd(), ".venv-markitdown/bin/python");
  return existsSync(localPython) ? localPython : "python3";
}

function errorText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

function chatCompletionsUrlFromBaseUrl(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (isResponsesUrl(trimmed) || isChatCompletionsUrl(trimmed)) return trimmed;
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function isResponsesUrl(value: string): boolean {
  return /\/responses(?:[/?#]|$)/.test(value);
}

function isChatCompletionsUrl(value: string): boolean {
  return /\/chat\/completions(?:[/?#]|$)/.test(value);
}

function isFullOpenAiApiUrl(value?: string): boolean {
  return Boolean(value?.trim() && (isResponsesUrl(value.trim()) || isChatCompletionsUrl(value.trim())));
}

function azureV1BaseUrlFromEndpoint(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/openai/v1") ? trimmed : `${trimmed}/openai/v1`;
}

function formatPythonFailure(error: unknown): string {
  const record = error && typeof error === "object" ? error as { stderr?: unknown; stdout?: unknown; code?: unknown; signal?: unknown; message?: unknown } : {};
  const stderr = errorText(record.stderr).trim();
  const stdout = errorText(record.stdout).trim();
  const status = [
    record.code !== undefined ? `exit code: ${String(record.code)}` : "",
    record.signal !== undefined ? `signal: ${String(record.signal)}` : "",
  ].filter(Boolean).join(", ");
  const detail = [
    status,
    stderr ? `stderr:\n${stderr}` : "",
    stdout ? `stdout:\n${stdout}` : "",
  ].filter(Boolean).join("\n\n");
  if (detail) return detail;
  return error instanceof Error ? error.message : String(error);
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envDurationMs(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return Math.round(value * multiplier);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value % (1024 * 1024) === 0 ? 0 : 1)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)}KB`;
  return `${value}B`;
}

function documentConversionTimeoutMs(): number {
  return envDurationMs("DOCUMENT_CONVERSION_TIMEOUT")
    ?? envNumber("DOCUMENT_CONVERSION_TIMEOUT_MS", envNumber("MARKITDOWN_TIMEOUT_MS", DEFAULT_DOCUMENT_CONVERSION_TIMEOUT_MS));
}

function jsonValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, Math.max(0, maxChars))}\n\n... truncated ${value.length - maxChars} characters ...`,
    truncated: true,
  };
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "undefined";
}

function truncatedJson(value: unknown, maxChars: number): { json: string; truncated: boolean } {
  const result = truncateText(stringifyJson(value), maxChars);
  return { json: result.text, truncated: result.truncated };
}

function markdownCodeFence(language: string, value: string): string {
  const longestFence = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}${language}\n${value.replace(/\s+$/u, "")}\n${fence}`;
}

export class MarkitdownConverter {
  constructor(private readonly options: { pythonCommand?: string; timeoutMs?: number } = {}) {}

  async convertMany(input: MarkitdownConversionInput): Promise<MarkitdownConversionResult[]> {
    await this.assertDocumentWithinLimits(input.name, input.data);

    if (isExcel(input.name)) {
      try {
        const seen = new Map<string, number>();
        return await Promise.all((await this.convertExcelSheets(input.name, input.data)).map(async (converted) => this.enrichWithVision(input.name, input.data, {
          ...converted,
          outputName: this.uniqueOutputName(converted.outputName, seen),
        })));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("No module named")) throw error;
      }
    }

    if (!isZip(input.name)) return [await this.convert(input)];

    const entries = await this.extractZipEntries(input.name, input.data);
    const supportedEntries = entries.filter((entry) => isSupportedArchiveEntry(entry.name));
    if (!supportedEntries.length) throw new Error(`Zip archive ${input.name} does not contain supported files`);

    const archiveFolder = safeZipFolderName(input.name);
    const seen = new Map<string, number>();
    const results: MarkitdownConversionResult[] = [];
    try {
      const failures: string[] = [];
      for (const entry of supportedEntries) {
        try {
          const convertedEntries = await this.convertMany({ name: entry.name, data: entry.data });
          for (const converted of convertedEntries) {
            const alreadyUnderArchive = converted.outputName === archiveFolder || converted.outputName.startsWith(`${archiveFolder}/`);
            const outputName = this.uniqueOutputName(alreadyUnderArchive ? converted.outputName : path.posix.join(archiveFolder, converted.outputName), seen);
            const sourceName = entry.name === archiveFolder || entry.name.startsWith(`${archiveFolder}/`) ? entry.name : path.posix.join(archiveFolder, entry.name);
            results.push({
              ...converted,
              outputName,
              sourceName: converted.sourceName
                ? converted.sourceName === archiveFolder || converted.sourceName.startsWith(`${archiveFolder}/`)
                  ? converted.sourceName
                  : path.posix.join(archiveFolder, converted.sourceName)
                : sourceName,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${entry.name}: ${message}`);
        }
      }
      if (!results.length) throw new Error(`Zip archive ${input.name} could not be converted: ${failures.slice(0, 3).join("; ")}`);
      return results;
    } finally {
      await fs.rm(entries[0]?.tempRoot ?? "", { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async convert(input: MarkitdownConversionInput): Promise<MarkitdownConversionResult> {
    if (isJsonInput(input.name, input.contentType)) return this.convertJson(input);

    const fallback = input.fallbackText ?? (isTextLike(input.name) ? decodeAsText(input.data) : "");

    if (!this.shouldRunMarkitdown(input.name)) {
      return { markdown: fallback, outputName: input.name, converted: false, converter: "text" };
    }

    if (isStandaloneImage(input.name)) {
      const visionOnly = await this.tryConvertWithVisionOnly(input.name, input.data);
      if (visionOnly) return visionOnly;
    }

    if (this.shouldRunPdfTextFirst(input.name)) {
      const pdfText = await this.tryConvertPdfWithPdftotext(input.name, input.data);
      if (pdfText) {
        return await this.enrichWithVision(input.name, input.data, { markdown: pdfText, outputName: markdownOutputName(input.name), converted: true, converter: "pdftotext" });
      }
    }

    try {
      const markdown = await this.convertWithPython(input.name, input.data);
      return await this.enrichWithVision(input.name, input.data, { markdown, outputName: markdownOutputName(input.name), converted: true, converter: "markitdown" });
    } catch (error) {
      if (isPdf(input.name)) {
        const visionOnly = await this.tryConvertWithVisionOnly(input.name, input.data);
        if (visionOnly) return visionOnly;
      }
      if (fallback) {
        return {
          markdown: fallback,
          outputName: isMarkdown(input.name) ? input.name : markdownOutputName(input.name),
          converted: !isMarkdown(input.name),
          converter: "text",
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No module named 'markitdown'") || message.includes('No module named "markitdown"')) {
        return {
          markdown: [
            `# ${path.basename(input.name)}`,
            "",
            `Source file: \`${input.name}\``,
            "",
            "This file was uploaded, but Markdown conversion is unavailable because the server Python environment is missing `markitdown`.",
          ].join("\n"),
          outputName: markdownOutputName(input.name),
          converted: false,
          converter: "text",
        };
      }
      throw new Error(`MarkItDown conversion failed for ${input.name}: ${message}`);
    }
  }

  private convertJson(input: MarkitdownConversionInput): MarkitdownConversionResult {
    const sourceText = input.fallbackText ?? decodeAsText(input.data);
    const outputName = markdownOutputName(input.name);
    const parseMaxBytes = envNumber("JSON_CONVERSION_PARSE_MAX_BYTES", DEFAULT_JSON_PARSE_MAX_BYTES);

    if (input.data.byteLength > parseMaxBytes) {
      const rawPreview = truncateText(sourceText, envNumber("JSON_CONVERSION_RAW_PREVIEW_MAX_CHARS", DEFAULT_JSON_RAW_PREVIEW_MAX_CHARS));
      const warning = `JSON file is ${formatBytes(input.data.byteLength)}, exceeding the ${formatBytes(parseMaxBytes)} parse limit; pretty formatting was skipped.`;
      const summary: JsonExtractionSummary = {
        parseStatus: "skipped_too_large",
        fullJsonTruncated: rawPreview.truncated,
        warnings: [warning],
      };
      return {
        markdown: markdownCodeFence("json", rawPreview.text),
        outputName,
        converted: true,
        converter: "json",
        json: summary,
      };
    }

    try {
      const parsed = JSON.parse(sourceText) as unknown;
      const fullJson = truncatedJson(parsed, envNumber("JSON_CONVERSION_FULL_MARKDOWN_MAX_CHARS", DEFAULT_JSON_FULL_MARKDOWN_MAX_CHARS));
      const summary: JsonExtractionSummary = {
        parseStatus: "parsed",
        topLevelType: jsonValueType(parsed),
        fullJsonTruncated: fullJson.truncated,
        warnings: [],
      };
      if (fullJson.truncated) {
        summary.warnings.push("Full pretty JSON was truncated in Markdown; use the original source file for complete fidelity.");
      }
      return {
        markdown: markdownCodeFence("json", fullJson.json),
        outputName,
        converted: true,
        converter: "json",
        json: summary,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const rawPreview = truncateText(sourceText, envNumber("JSON_CONVERSION_RAW_PREVIEW_MAX_CHARS", DEFAULT_JSON_RAW_PREVIEW_MAX_CHARS));
      const summary: JsonExtractionSummary = {
        parseStatus: "failed",
        fullJsonTruncated: rawPreview.truncated,
        warnings: ["JSON parsing failed; Markdown contains raw text preview only."],
        error: errorMessage,
      };
      return {
        markdown: markdownCodeFence("text", rawPreview.text),
        outputName,
        converted: true,
        converter: "json",
        json: summary,
      };
    }
  }

  private shouldRunMarkitdown(name: string): boolean {
    if (process.env.MARKITDOWN_ENABLED === "false") return false;
    if (isMarkdown(name)) return false;
    return true;
  }

  private shouldRunPdfTextFirst(name: string): boolean {
    return isPdf(name) && process.env.MARKITDOWN_PDF_TEXT_FIRST !== "false";
  }

  private async tryConvertPdfWithPdftotext(name: string, data: Buffer): Promise<string | null> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-pdftotext-"));
    const inputPath = path.join(tmpDir, path.basename(name));
    await fs.writeFile(inputPath, data);
    try {
      const command = process.env.MARKITDOWN_PDF_TEXT_COMMAND || "pdftotext";
      const minChars = Number(process.env.MARKITDOWN_PDF_TEXT_MIN_CHARS ?? 80);
      const { stdout } = await execFileAsync(command, ["-layout", inputPath, "-"], {
        timeout: Number(process.env.MARKITDOWN_PDF_TEXT_TIMEOUT_MS ?? 30_000),
        maxBuffer: Number(process.env.MARKITDOWN_PDF_TEXT_MAX_BUFFER_BYTES ?? 50 * 1024 * 1024),
      });
      const markdown = stdout.trim();
      return markdown.length >= minChars ? markdown : null;
    } catch {
      return null;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private visionConfig(): { enabled: boolean; provider: "azure" | "openai"; model?: string; apiKey?: string; url?: string; timeoutMs: number; maxImageBytes: number; maxTokens: number; minEmbeddedImageBytes: number; concurrency: number; maxNormalizedImageBytes: number } {
    const enabled = process.env.VISION_EXTRACTION_ENABLED !== "false";
    const provider = (process.env.VISION_EXTRACTION_PROVIDER
      ?? process.env.ONTOLOGY_PROXY_PROVIDER
      ?? process.env.STEWARD_PROXY_PROVIDER
      ?? (process.env.AZURE_OPENAI_API_KEY ? "azure" : "openai")) === "openai" ? "openai" : "azure";
    const model = process.env.VISION_EXTRACTION_MODEL
      ?? (provider === "openai" ? process.env.OPENAI_MODEL : process.env.AZURE_OPENAI_MODEL)
      ?? process.env.ONTOLOGY_PROXY_MODEL
      ?? process.env.STEWARD_PROXY_MODEL
      ?? process.env.MARKITDOWN_LLM_MODEL;
    const apiKey = process.env.VISION_EXTRACTION_API_KEY
      ?? (provider === "openai" ? process.env.OPENAI_API_KEY : process.env.AZURE_OPENAI_API_KEY)
      ?? process.env.MARKITDOWN_LLM_API_KEY;
    const configuredVisionBaseUrl = process.env.VISION_EXTRACTION_BASE_URL?.trim();
    const configuredVisionUrl = isFullOpenAiApiUrl(configuredVisionBaseUrl) ? configuredVisionBaseUrl : undefined;
    const azureBaseUrl = configuredVisionUrl ? undefined : azureV1BaseUrlFromEndpoint(configuredVisionBaseUrl
      ?? process.env.AZURE_OPENAI_BASE_URL
      ?? azureV1BaseUrlFromEndpoint(process.env.AZURE_OPENAI_ENDPOINT)
      ?? DEFAULT_AZURE_OPENAI_BASE_URL);
    const openaiBaseUrl = configuredVisionUrl ? undefined : configuredVisionBaseUrl
      ?? process.env.OPENAI_BASE_URL;
    const url = process.env.VISION_EXTRACTION_CHAT_COMPLETIONS_URL
      ?? configuredVisionUrl
      ?? (provider === "openai"
        ? process.env.OPENAI_CHAT_COMPLETIONS_URL ?? chatCompletionsUrlFromBaseUrl(openaiBaseUrl) ?? DEFAULT_OPENAI_CHAT_COMPLETIONS_URL
        : process.env.AZURE_OPENAI_CHAT_COMPLETIONS_URL ?? chatCompletionsUrlFromBaseUrl(azureBaseUrl) ?? DEFAULT_AZURE_OPENAI_CHAT_COMPLETIONS_URL);
    return {
      enabled,
      provider,
      model,
      apiKey,
      url,
      timeoutMs: Number(process.env.VISION_EXTRACTION_TIMEOUT_MS ?? 60_000),
      maxImageBytes: Number(process.env.VISION_EXTRACTION_MAX_IMAGE_BYTES ?? 20 * 1024 * 1024),
      maxTokens: Number(process.env.VISION_EXTRACTION_MAX_TOKENS ?? 1500),
      minEmbeddedImageBytes: Number(process.env.VISION_EXTRACTION_MIN_EMBEDDED_IMAGE_BYTES ?? 0),
      concurrency: Math.max(1, Number(process.env.VISION_EXTRACTION_CONCURRENCY ?? 4) || 4),
      maxNormalizedImageBytes: Number(process.env.VISION_EXTRACTION_MAX_NORMALIZED_IMAGE_BYTES_PER_FILE ?? DEFAULT_VISION_MAX_NORMALIZED_IMAGE_BYTES_PER_DOCUMENT),
    };
  }

  private shouldRunVisionFor(name: string): boolean {
    if (process.env.VISION_EXTRACTION_ENABLED === "false") return false;
    if (isStandaloneImage(name)) return process.env.VISION_EXTRACTION_FOR_STANDALONE_IMAGES !== "false";
    if (isPdf(name)) return process.env.VISION_EXTRACTION_FOR_PDF_PAGES !== "false";
    if (isVisionOfficeDocument(name)) return process.env.VISION_EXTRACTION_FOR_OFFICE_IMAGES !== "false";
    return false;
  }

  private detectImageMimeType(name: string, data: Buffer): string {
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
    if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
    if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    const ext = path.extname(name).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    if (ext === ".gif") return "image/gif";
    return "image/png";
  }

  private async tryConvertWithVisionOnly(name: string, data: Buffer): Promise<MarkitdownConversionResult | null> {
    if (!this.shouldRunVisionFor(name)) return null;
    const candidates = isStandaloneImage(name)
      ? [{ location: "Image", filename: path.basename(name), mimeType: this.detectImageMimeType(name, data), data, anchor: { kind: "document" } as const }]
      : await this.extractVisionImages(name, data);
    const summary = await this.describeVisionImages(name, candidates);
    if (!summary?.processedImages) return null;
    return {
      markdown: [`# ${path.basename(markdownOutputName(name), path.extname(markdownOutputName(name)))}`, this.visionMarkdown(summary)].filter(Boolean).join("\n\n").trim(),
      outputName: markdownOutputName(name),
      converted: true,
      converter: "vision",
      vision: summary,
    };
  }

  private async enrichWithVision(name: string, data: Buffer, result: MarkitdownConversionResult): Promise<MarkitdownConversionResult> {
    if (!this.shouldRunVisionFor(name)) return result;
    const candidates = this.scopeVisionCandidatesToResult(result, await this.extractVisionImages(name, data));
    const summary = await this.describeVisionImages(name, candidates);
    if (!summary || !summary.images.length) return result;
    return {
      ...result,
      markdown: this.mergeVisionMarkdown(name, result.markdown, summary),
      vision: summary,
    };
  }

  private visionMarkdown(summary: VisionExtractionSummary): string {
    const blocks = summary.images.map((image, index) => this.visionImageBlock(image, index)).filter(Boolean);
    if (!blocks.length) return "";
    return [
      "## Visual Content",
      "",
      ...blocks,
    ].join("\n\n");
  }

  private scopeVisionCandidatesToResult(result: MarkitdownConversionResult, candidates: VisionImageCandidate[]): VisionImageCandidate[] {
    const sheetName = result.sourceName?.includes("#") ? result.sourceName.split("#").slice(1).join("#") : undefined;
    if (!sheetName) return candidates;
    return candidates.filter((candidate) => candidate.anchor?.kind !== "xlsx-sheet" || candidate.anchor.sheetName === sheetName);
  }

  private mergeVisionMarkdown(name: string, markdown: string, summary: VisionExtractionSummary): string {
    const images = summary.images.filter((image) => image.status === "processed" || image.status === "skipped" || image.status === "failed");
    if (!images.length) return markdown;
    if (isPdf(name)) return this.insertPdfVisionBlocks(markdown, images);
    const ext = path.extname(name).toLowerCase();
    if (ext === ".pptx") return this.insertPptVisionBlocks(markdown, images);
    if (ext === ".docx") return this.insertDocxVisionBlocks(markdown, images);
    if (ext === ".xlsx") return this.insertXlsxVisionBlocks(markdown, images);
    return `${markdown.trim()}\n\n${this.visionMarkdown(summary)}`.trim();
  }

  private visionImageBlock(image: VisionExtractionImageResult, _index: number): string {
    void _index;
    if (image.status === "processed" && image.markdown?.trim()) {
      return this.normalizeVisionMarkdown(image.markdown);
    }
    return "";
  }

  private normalizeVisionMarkdown(markdown: string): string {
    return markdown
      .trim()
      .replace(/\n{3,}/g, "\n\n")
      .replace(/([^\n])(?=(?:[A-Z][A-Za-z0-9 /&()|:'’.-]{3,}:)$)/gm, "$1\n\n");
  }

  private stripMarkdownDataImagePlaceholders(markdown: string): string {
    return markdown
      .replace(/!\[[^\]\n]*\]\(data:image\/[^)]*\)/gi, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/^\s{0,3}#{1,6}\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private stripMarkdownLocalImagePlaceholders(markdown: string): string {
    return markdown
      .replace(/!\[[^\]\n]*\]\((?!(?:https?:|data:))[^)\n]+\.(?:png|jpe?g|gif|webp|bmp|emf|wmf|svg)(?:\?[^)\n]*)?\)/gi, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/^\s{0,3}#{1,6}\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private insertPdfVisionBlocks(markdown: string, images: VisionExtractionImageResult[]): string {
    const byPage = new Map<number, { blocks: string[]; replacePageText: boolean; textHints: string[] }>();
    const fallback: string[] = [];
    images.forEach((image, index) => {
      const block = this.visionImageBlock(image, index);
      if (!block) return;
      if (image.anchor?.kind === "pdf-page") {
        const pageBlocks = byPage.get(image.anchor.page) ?? { blocks: [], replacePageText: false, textHints: [] };
        pageBlocks.blocks.push(block);
        pageBlocks.replacePageText ||= image.anchor.replacePageText === true;
        if (Array.isArray(image.anchor.textHints)) {
          for (const hint of image.anchor.textHints) {
            if (typeof hint === "string" && hint.trim()) pageBlocks.textHints.push(hint);
          }
        }
        byPage.set(image.anchor.page, pageBlocks);
      } else {
        fallback.push(block);
      }
    });

    if (markdown.includes("\f")) {
      const pages = markdown.split(/\f/g);
      const entriesByPageSegment = new Map<number, { blocks: string[]; replacePageText: boolean }>();
      for (const [page, entry] of byPage.entries()) {
        const segmentIndex = this.resolvePdfVisionSegmentIndex(pages, page, entry.textHints);
        const existing = entriesByPageSegment.get(segmentIndex) ?? { blocks: [], replacePageText: false };
        existing.blocks.push(...entry.blocks);
        existing.replacePageText ||= entry.replacePageText;
        entriesByPageSegment.set(segmentIndex, existing);
      }
      const merged = pages.map((page, pageIndex) => {
        const entry = entriesByPageSegment.get(pageIndex);
        if (!entry?.blocks.length) return page.trimEnd();
        if (entry.replacePageText) return entry.blocks.filter((part) => part.trim()).join("\n\n");
        return [page.trimEnd(), ...entry.blocks].filter((part) => part.trim()).join("\n\n");
      }).join("\n\n\f\n\n");
      return [merged.trim(), ...fallback].filter((part) => part.trim()).join("\n\n").trim();
    }

    const singlePageEntry = byPage.size === 1 ? byPage.get(1) : undefined;
    if (singlePageEntry?.replacePageText && singlePageEntry.blocks.length) {
      return [...singlePageEntry.blocks, ...fallback].filter((part) => part.trim()).join("\n\n").trim();
    }

    const inlineBlocks = [...byPage.entries()].sort(([left], [right]) => left - right).flatMap(([, entry]) => entry.blocks);
    return [markdown.trim(), ...inlineBlocks, ...fallback].filter((part) => part.trim()).join("\n\n").trim();
  }

  private resolvePdfVisionSegmentIndex(pages: string[], page: number, textHints: string[]): number {
    const fallbackIndex = Math.max(0, Math.min(pages.length - 1, page - 1));
    const hints = [...new Set(textHints.map((hint) => this.compactPdfTextHint(hint)).filter((hint) => hint.length >= 8))];
    if (!hints.length) return fallbackIndex;
    const normalizedPages = pages.map((part) => this.compactPdfTextHint(part));
    const fallbackScore = this.scorePdfPageHints(normalizedPages[fallbackIndex] ?? "", hints);
    let bestIndex = fallbackIndex;
    let bestScore = fallbackScore;
    normalizedPages.forEach((part, index) => {
      const score = this.scorePdfPageHints(part, hints);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestScore >= Math.max(16, fallbackScore + 8) ? bestIndex : fallbackIndex;
  }

  private compactPdfTextHint(value: string): string {
    return value.replace(/\s+/g, "");
  }

  private scorePdfPageHints(pageText: string, hints: string[]): number {
    let score = 0;
    for (const hint of hints) {
      if (pageText.includes(hint)) score += Math.min(80, hint.length);
    }
    return score;
  }

  private insertPptVisionBlocks(markdown: string, images: VisionExtractionImageResult[]): string {
    const bySlide = new Map<number, string[]>();
    const fallback: string[] = [];
    images.forEach((image, index) => {
      const block = this.visionImageBlock(image, index);
      if (!block) return;
      if (image.anchor?.kind === "ppt-slide") {
        const blocks = bySlide.get(image.anchor.slide) ?? [];
        blocks.push(block);
        bySlide.set(image.anchor.slide, blocks);
      } else {
        fallback.push(block);
      }
    });

    const lines = this.stripMarkdownLocalImagePlaceholders(markdown).split("\n");
    const slideStarts: Array<{ slide: number; line: number }> = [];
    lines.forEach((line, index) => {
      const match = line.match(/(?:^|\b)slide(?:\s+number:)?\s*(\d+)\b/i);
      if (match) slideStarts.push({ slide: Number(match[1]), line: index });
    });
    if (!slideStarts.length) {
      const inlineBlocks = [...bySlide.entries()].sort(([left], [right]) => left - right).flatMap(([, blocks]) => blocks);
      return [markdown.trim(), ...inlineBlocks, ...fallback].filter((part) => part.trim()).join("\n\n").trim();
    }

    const insertions = new Map<number, string[]>();
    slideStarts.forEach((start, index) => {
      const blocks = bySlide.get(start.slide);
      if (!blocks?.length) return;
      const nextStart = slideStarts[index + 1]?.line ?? lines.length;
      insertions.set(nextStart, [...(insertions.get(nextStart) ?? []), ...blocks]);
      bySlide.delete(start.slide);
    });

    const output: string[] = [];
    for (let index = 0; index <= lines.length; index += 1) {
      const blocks = insertions.get(index);
      if (blocks?.length) output.push("", ...blocks, "");
      if (index < lines.length) output.push(lines[index]);
    }
    const remaining = [...bySlide.entries()].sort(([left], [right]) => left - right).flatMap(([, blocks]) => blocks);
    return [output.join("\n").trim(), ...remaining, ...fallback].filter((part) => part.trim()).join("\n\n").trim();
  }

  private insertDocxVisionBlocks(markdown: string, images: VisionExtractionImageResult[]): string {
    let output = this.stripMarkdownDataImagePlaceholders(markdown);
    const fallback: string[] = [];
    images.forEach((image, index) => {
      const block = this.visionImageBlock(image, index);
      if (!block) return;
      const anchor = image.anchor?.kind === "docx-paragraph" ? image.anchor : undefined;
      const inserted = anchor && (
        this.insertAfterText(output, anchor.paragraphText, block)
        ?? this.insertAfterText(output, anchor.beforeText, block)
        ?? this.insertBeforeText(output, anchor.afterText, block)
      );
      if (inserted) {
        output = inserted;
      } else {
        fallback.push(block);
      }
    });
    return [output, ...fallback].filter((part) => part.trim()).join("\n\n").trim();
  }

  private insertXlsxVisionBlocks(markdown: string, images: VisionExtractionImageResult[]): string {
    const lines = markdown.trim().split("\n");
    const detailBlocks: string[] = [];
    images.forEach((image, index) => {
      const block = this.visionImageBlock(image, index);
      if (!block) return;
      detailBlocks.push(block);
      const anchor = image.anchor?.kind === "xlsx-sheet" ? image.anchor : undefined;
      if (anchor?.row === undefined || anchor.col === undefined) return;
      const tableStart = lines.findIndex((line) => line.startsWith("|"));
      const tableLineIndex = tableStart < 0 ? -1 : tableStart + 2 + anchor.row;
      if (tableLineIndex >= lines.length || !lines[tableLineIndex]?.startsWith("|")) return;
      const cells = lines[tableLineIndex].slice(1, -1).split(" | ");
      if (anchor.col >= cells.length) return;
      const location = anchor.cell ? `Image ${anchor.cell}` : "Image";
      cells[anchor.col] = cells[anchor.col] ? `${cells[anchor.col]}<br>${location}` : location;
      lines[tableLineIndex] = `| ${cells.join(" | ")} |`;
    });
    return [lines.join("\n").trim(), ...detailBlocks].filter((part) => part.trim()).join("\n\n").trim();
  }

  private insertAfterText(markdown: string, text: string | undefined, block: string): string | null {
    const needle = text?.trim();
    if (!needle) return null;
    const index = markdown.indexOf(needle);
    if (index < 0) return null;
    const end = index + needle.length;
    return `${markdown.slice(0, end).trimEnd()}\n\n${block}\n\n${markdown.slice(end).trimStart()}`.trim();
  }

  private insertBeforeText(markdown: string, text: string | undefined, block: string): string | null {
    const needle = text?.trim();
    if (!needle) return null;
    const index = markdown.indexOf(needle);
    if (index < 0) return null;
    return `${markdown.slice(0, index).trimEnd()}\n\n${block}\n\n${markdown.slice(index).trimStart()}`.trim();
  }

  private async extractVisionImages(name: string, data: Buffer): Promise<VisionImageCandidate[]> {
    if (isStandaloneImage(name)) {
      return [{ location: "Image", filename: path.basename(name), mimeType: this.detectImageMimeType(name, data), data, anchor: { kind: "document" } }];
    }
    if (isPdf(name)) return this.extractPdfVisionPages(name, data);
    if (isVisionOfficeDocument(name)) return this.extractOfficeImages(name, data);
    return [];
  }

  private async extractOfficeImages(name: string, data: Buffer): Promise<VisionImageCandidate[]> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-vision-office-"));
    const inputPath = path.join(tmpDir, path.basename(name));
    const outDir = path.join(tmpDir, "images");
    await fs.writeFile(inputPath, data);
    await fs.mkdir(outDir, { recursive: true });
    try {
      const python = markitdownPythonCommand(this.options.pythonCommand);
      const script = String.raw`
import json
import os
import pathlib
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

input_path, out_dir = sys.argv[1], pathlib.Path(sys.argv[2])
ext = pathlib.Path(input_path).suffix.lower()
image_exts = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'}
mime = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp'}
NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'rel': 'http://schemas.openxmlformats.org/package/2006/relationships',
    'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'xdr': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
}
RID = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

def safe(value):
    return re.sub(r'[^\w.\-]+', '_', value, flags=re.UNICODE).strip('_') or 'image'

def norm_target(source_part, target):
    if not target:
        return ''
    if target.startswith('/'):
        return posixpath.normpath(target.lstrip('/'))
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target))

def rels_for(archive, source_part):
    rels_path = posixpath.join(posixpath.dirname(source_part), '_rels', posixpath.basename(source_part) + '.rels')
    if rels_path not in archive.namelist():
        return {}
    root = ET.fromstring(archive.read(rels_path))
    rels = {}
    for rel in root.findall('rel:Relationship', NS):
        rel_id = rel.attrib.get('Id')
        if rel_id:
            rels[rel_id] = norm_target(source_part, rel.attrib.get('Target', ''))
    return rels

def read_xml(archive, name):
    if name not in archive.namelist():
        return None
    return ET.fromstring(archive.read(name))

def text_from(element, xpath):
    return ''.join(node.text or '' for node in element.findall(xpath, NS)).strip()

def compact_text(value, limit=180):
    value = re.sub(r'\s+', ' ', value or '').strip()
    return value[:limit].rstrip() + ('...' if len(value) > limit else '')

def blip_rids(element):
    result = []
    for blip in element.findall('.//a:blip', NS):
        rel_id = blip.attrib.get(RID + 'embed') or blip.attrib.get(RID + 'link')
        if rel_id:
            result.append(rel_id)
    return result

def col_name(index):
    value = ''
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        value = chr(65 + remainder) + value
    return value

def cell_ref(row, col):
    return f'{col_name(col)}{row + 1}'

def rect_area(width, height):
    return max(0, width) * max(0, height)

def compact_text_chars(value):
    return len(re.sub(r'\s+', '', value or ''))

def office_float_env(name, fallback):
    try:
        return float(os.environ.get(name, fallback))
    except (TypeError, ValueError):
        return float(fallback)

def office_int_env(name, fallback):
    try:
        return int(os.environ.get(name, fallback))
    except (TypeError, ValueError):
        return int(fallback)

def media_size(archive, media_path):
    if not media_path or media_path not in archive.namelist():
        return 0
    try:
        return archive.getinfo(media_path).file_size
    except KeyError:
        return len(archive.read(media_path))

def pptx_slide_size(archive):
    root = read_xml(archive, 'ppt/presentation.xml')
    if root is None:
        return (9144000, 5143500)
    size = root.find('.//p:sldSz', NS)
    if size is None:
        return (9144000, 5143500)
    try:
        return (int(size.attrib.get('cx', '9144000')), int(size.attrib.get('cy', '5143500')))
    except ValueError:
        return (9144000, 5143500)

def pptx_picture_bounds(pic):
    xfrm = pic.find('.//a:xfrm', NS)
    if xfrm is None:
        return (0, 0, 0, 0)
    off = xfrm.find('a:off', NS)
    ext = xfrm.find('a:ext', NS)
    try:
        x = int(off.attrib.get('x', '0')) if off is not None else 0
        y = int(off.attrib.get('y', '0')) if off is not None else 0
        cx = int(ext.attrib.get('cx', '0')) if ext is not None else 0
        cy = int(ext.attrib.get('cy', '0')) if ext is not None else 0
    except ValueError:
        return (0, 0, 0, 0)
    return (x, y, cx, cy)

def pptx_is_full_slide(x, y, cx, cy, slide_w, slide_h):
    slide_area = rect_area(slide_w, slide_h)
    if not slide_area:
        return False
    area_ratio = rect_area(cx, cy) / slide_area
    tolerance_x = max(1, slide_w * 0.02)
    tolerance_y = max(1, slide_h * 0.02)
    return area_ratio >= 0.94 and abs(x) <= tolerance_x and abs(y) <= tolerance_y and abs((x + cx) - slide_w) <= tolerance_x and abs((y + cy) - slide_h) <= tolerance_y

def add_record(records, archive, media_path, location, anchor, context_text=''):
    if not media_path or media_path not in archive.namelist():
        return
    suffix = pathlib.PurePosixPath(media_path).suffix.lower()
    if suffix not in image_exts:
        return
    records.append({
        'mediaPath': media_path,
        'filename': media_path,
        'location': location,
        'mimeType': mime.get(suffix, 'image/png'),
        'anchor': anchor,
        'contextText': compact_text(context_text, 1200),
    })

def collect_docx(records, archive):
    part = 'word/document.xml'
    root = read_xml(archive, part)
    if root is None:
        return
    rels = rels_for(archive, part)
    paragraphs = root.findall('.//w:p', NS)
    paragraph_texts = [text_from(paragraph, './/w:t') for paragraph in paragraphs]
    for index, paragraph in enumerate(paragraphs):
        rel_ids = blip_rids(paragraph)
        if not rel_ids:
            continue
        text = paragraph_texts[index]
        before = next((paragraph_texts[pos] for pos in range(index - 1, -1, -1) if paragraph_texts[pos]), '')
        after = next((paragraph_texts[pos] for pos in range(index + 1, len(paragraph_texts)) if paragraph_texts[pos]), '')
        anchor = {
            'kind': 'docx-paragraph',
            'paragraphText': compact_text(text, 240),
            'beforeText': compact_text(before, 240),
            'afterText': compact_text(after, 240),
        }
        label_text = compact_text(text or before or after, 80)
        location = f'Word image near "{label_text}"' if label_text else 'Word embedded image'
        context = '\n'.join(value for value in (before, text, after) if value)
        for rel_id in rel_ids:
            add_record(records, archive, rels.get(rel_id), location, anchor, context)

def collect_pptx(records, archive):
    slide_parts = []
    for name in archive.namelist():
        match = re.match(r'ppt/slides/slide(\d+)\.xml$', name)
        if match:
            slide_parts.append((int(match.group(1)), name))
    slide_w, slide_h = pptx_slide_size(archive)
    slide_area = rect_area(slide_w, slide_h)
    min_region_area_ratio = office_float_env('VISION_EXTRACTION_PPTX_MIN_REGION_AREA_RATIO', os.environ.get('VISION_EXTRACTION_PDF_MIN_REGION_AREA_RATIO', '0.1'))
    background_max_bytes = office_int_env('VISION_EXTRACTION_PPTX_BACKGROUND_MAX_BYTES', os.environ.get('VISION_EXTRACTION_PDF_BACKGROUND_MAX_BYTES', '20000'))
    for slide, part in sorted(slide_parts):
        root = read_xml(archive, part)
        if root is None:
            continue
        rels = rels_for(archive, part)
        slide_text = ' '.join(node.text or '' for node in root.findall('.//a:t', NS)).strip()
        text_chars = compact_text_chars(slide_text)
        partials = []
        full_slide_candidates = []
        seen_media_on_slide = set()
        for pic in root.findall('.//p:pic', NS):
            x, y, cx, cy = pptx_picture_bounds(pic)
            area_ratio = rect_area(cx, cy) / slide_area if slide_area else 0
            if area_ratio <= 0:
                continue
            full_slide = pptx_is_full_slide(x, y, cx, cy, slide_w, slide_h)
            for rel_id in blip_rids(pic):
                media_path = rels.get(rel_id)
                if not media_path or media_path in seen_media_on_slide:
                    continue
                seen_media_on_slide.add(media_path)
                byte_size = media_size(archive, media_path)
                if full_slide and byte_size <= background_max_bytes:
                    continue
                candidate = (media_path, area_ratio, byte_size)
                if full_slide:
                    full_slide_candidates.append(candidate)
                    continue
                if area_ratio < min_region_area_ratio:
                    continue
                if byte_size and byte_size < background_max_bytes and area_ratio < 0.18:
                    continue
                partials.append(candidate)
        selected = partials
        if not selected and full_slide_candidates and text_chars == 0:
            selected = full_slide_candidates[:1]
        for media_path, _area_ratio, _byte_size in selected:
            add_record(records, archive, media_path, f'Slide {slide} image', {'kind': 'ppt-slide', 'slide': slide}, slide_text)

def collect_xlsx(records, archive):
    workbook_part = 'xl/workbook.xml'
    root = read_xml(archive, workbook_part)
    if root is None:
        return
    workbook_rels = rels_for(archive, workbook_part)
    for sheet in root.findall('.//x:sheet', NS):
        sheet_name = sheet.attrib.get('name') or 'Sheet'
        sheet_part = workbook_rels.get(sheet.attrib.get(RID + 'id'))
        if not sheet_part:
            continue
        sheet_root = read_xml(archive, sheet_part)
        if sheet_root is None:
            continue
        sheet_rels = rels_for(archive, sheet_part)
        drawing_parts = []
        for drawing in sheet_root.findall('.//x:drawing', NS):
            drawing_part = sheet_rels.get(drawing.attrib.get(RID + 'id'))
            if drawing_part:
                drawing_parts.append(drawing_part)
        for drawing_part in drawing_parts:
            drawing_root = read_xml(archive, drawing_part)
            if drawing_root is None:
                continue
            drawing_rels = rels_for(archive, drawing_part)
            anchors = drawing_root.findall('.//xdr:oneCellAnchor', NS) + drawing_root.findall('.//xdr:twoCellAnchor', NS)
            for anchor_node in anchors:
                from_node = anchor_node.find('xdr:from', NS)
                row = int(from_node.findtext('xdr:row', '0', NS)) if from_node is not None else 0
                col = int(from_node.findtext('xdr:col', '0', NS)) if from_node is not None else 0
                cell = cell_ref(row, col)
                anchor = {'kind': 'xlsx-sheet', 'sheetName': sheet_name, 'cell': cell, 'row': row, 'col': col}
                for rel_id in blip_rids(anchor_node):
                    add_record(records, archive, drawing_rels.get(rel_id), f'Sheet {sheet_name} cell {cell} image', anchor, f'Sheet {sheet_name} {cell}')

records = []
with zipfile.ZipFile(input_path) as archive:
    if ext == '.docx':
        collect_docx(records, archive)
    elif ext == '.pptx':
        collect_pptx(records, archive)
    elif ext == '.xlsx':
        collect_xlsx(records, archive)

    recorded = {record['mediaPath'] for record in records}
    for entry in archive.namelist():
        suffix = pathlib.PurePosixPath(entry).suffix.lower()
        if suffix not in image_exts or entry in recorded:
            continue
        if ext == '.docx' and not entry.startswith('word/media/'):
            continue
        if ext == '.pptx' and not entry.startswith('ppt/media/'):
            continue
        if ext == '.pptx':
            continue
        if ext == '.xlsx' and not entry.startswith('xl/media/'):
            continue
        add_record(records, archive, entry, 'Embedded image', {'kind': 'document'}, '')

    output_records = []
    for index, record in enumerate(records, 1):
        media_path = record.pop('mediaPath')
        data = archive.read(media_path)
        out = out_dir / (str(index).zfill(4) + '-' + safe(pathlib.PurePosixPath(media_path).name))
        out.write_bytes(data)
        record['path'] = str(out)
        record['bytes'] = len(data)
        output_records.append(record)

print(json.dumps(output_records, ensure_ascii=False))
`;
      const { stdout } = await execFileAsync(python, ["-c", script, inputPath, outDir], {
        timeout: Number(process.env.VISION_EXTRACTION_EXTRACT_TIMEOUT_MS ?? 60_000),
        maxBuffer: 4 * 1024 * 1024,
      });
      const records = JSON.parse(stdout) as Array<{ path: string; filename?: string; location: string; mimeType: string; anchor?: VisionAnchor; contextText?: string }>;
      return Promise.all(records.map(async (record) => ({
        location: record.location,
        filename: record.filename,
        mimeType: record.mimeType,
        anchor: record.anchor,
        contextText: record.contextText,
        data: await fs.readFile(record.path),
      })));
    } catch {
      return [];
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async extractPdfVisionPages(name: string, data: Buffer): Promise<VisionImageCandidate[]> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-vision-pdf-"));
    const inputPath = path.join(tmpDir, path.basename(name));
    const outDir = path.join(tmpDir, "regions");
    await fs.writeFile(inputPath, data);
    await fs.mkdir(outDir, { recursive: true });
    try {
      const python = markitdownPythonCommand(this.options.pythonCommand);
      const script = String.raw`
import json
import math
import os
import pathlib
import re
import sys

input_path, out_dir = sys.argv[1], pathlib.Path(sys.argv[2])
max_pages = int(sys.argv[3])
dpi = int(sys.argv[4])
min_region_area_ratio = float(sys.argv[5])
full_page_text_max_chars = int(sys.argv[6])
background_max_bytes = int(sys.argv[7])
records = []

try:
    import fitz
except Exception:
    print('[]')
    raise SystemExit(0)

doc = fitz.open(input_path)
matrix = fitz.Matrix(dpi / 72, dpi / 72)
def rect_area(rect):
    return max(0.0, rect.width) * max(0.0, rect.height)

def intersection_ratio(left, right):
    inter = left & right
    denom = min(rect_area(left), rect_area(right))
    return rect_area(inter) / denom if denom else 0.0

def vertical_overlap_ratio(left, right):
    overlap = max(0.0, min(left.y1, right.y1) - max(left.y0, right.y0))
    denom = min(max(0.0, left.height), max(0.0, right.height))
    return overlap / denom if denom else 0.0

def is_full_page(rect, page_rect):
    page_area = rect_area(page_rect)
    if not page_area:
        return False
    return rect_area(rect) / page_area >= 0.94 and abs(rect.x0 - page_rect.x0) <= 3 and abs(rect.y0 - page_rect.y0) <= 3 and abs(rect.x1 - page_rect.x1) <= 3 and abs(rect.y1 - page_rect.y1) <= 3

def image_size(block):
    value = block.get('size')
    if isinstance(value, int):
        return value
    image = block.get('image')
    return len(image) if isinstance(image, (bytes, bytearray)) else 0

def text_from_blocks(blocks):
    chunks = []
    for block in blocks:
        if block.get('type') != 0:
            continue
        for line in block.get('lines', []):
            text = ''.join(span.get('text', '') for span in line.get('spans', [])).strip()
            if text:
                chunks.append(text)
    return '\\n'.join(chunks)

def clip_with_padding(rect, page_rect):
    pad = max(4, min(page_rect.width, page_rect.height) * 0.012)
    return fitz.Rect(rect.x0 - pad, rect.y0 - pad, rect.x1 + pad, rect.y1 + pad) & page_rect

def candidate_score(area_ratio, byte_size, text_chars, full_page):
    score = area_ratio * 100.0
    if byte_size:
        score += min(18.0, math.log10(max(byte_size, 1)) * 3.0)
    if full_page:
        if text_chars == 0:
            score += 26.0
        elif text_chars <= full_page_text_max_chars:
            score -= 42.0
        else:
            score -= 70.0
    else:
        score += 12.0
        if area_ratio >= 0.25:
            score += 15.0
        elif area_ratio >= 0.15:
            score += 8.0
    return score

def merge_related_partials(partials, page_rect):
    if len(partials) <= 1:
        return partials
    remaining = sorted(partials, key=lambda item: (item['rect'].y0, item['rect'].x0))
    groups = []
    while remaining:
        group = [remaining.pop(0)]
        changed = True
        while changed:
            changed = False
            group_rect = group[0]['rect']
            for item in group[1:]:
                group_rect = group_rect | item['rect']
            for item in list(remaining):
                gap = max(0.0, max(item['rect'].x0 - group_rect.x1, group_rect.x0 - item['rect'].x1, item['rect'].y0 - group_rect.y1, group_rect.y0 - item['rect'].y1))
                if vertical_overlap_ratio(group_rect, item['rect']) >= 0.45 or gap <= 12:
                    candidate_rect = group_rect | item['rect']
                    if rect_area(candidate_rect) / rect_area(page_rect) <= 0.82:
                        group.append(item)
                        remaining.remove(item)
                        changed = True
        groups.append(group)
    merged = []
    for group in groups:
        if len(group) == 1:
            merged.append(group[0])
            continue
        rect = group[0]['rect']
        score = max(item['score'] for item in group) + 12.0
        byte_size = sum(item['bytes'] for item in group)
        for item in group[1:]:
            rect = rect | item['rect']
        merged.append({
            'rect': rect,
            'areaRatio': rect_area(rect) / rect_area(page_rect),
            'bytes': byte_size,
            'fullPage': False,
            'score': score,
            'merged': True,
        })
    return merged

def union_rects(rects):
    if not rects:
        return None
    union = rects[0]
    for rect in rects[1:]:
        union = union | rect
    return union

def text_line_metrics(blocks, page_rect):
    prose_lines = 0
    label_lines = 0
    vertical_labels = 0
    for block in blocks:
        if block.get('type') != 0:
            continue
        for line in block.get('lines', []):
            text = ''.join(span.get('text', '') for span in line.get('spans', [])).strip()
            compact = re.sub(r'\s+', '', text)
            if not compact:
                continue
            rect = fitz.Rect(line.get('bbox', block.get('bbox', (0, 0, 0, 0)))) & page_rect
            width_ratio = rect.width / page_rect.width if page_rect.width else 0
            height_ratio = rect.height / page_rect.height if page_rect.height else 0
            if len(compact) >= 18 and width_ratio >= 0.42:
                prose_lines += 1
            if len(compact) <= 28 or width_ratio < 0.35:
                label_lines += 1
            if len(compact) >= 2 and rect.height > rect.width * 1.45 and height_ratio >= 0.03:
                vertical_labels += 1
    return prose_lines, label_lines, vertical_labels

def compact_hint_text(value):
    return re.sub(r'\s+', '', value or '').strip()

def page_text_hints(value):
    lines = []
    for raw in (value or '').splitlines():
        compact = compact_hint_text(raw)
        if len(compact) >= 6:
            lines.append(compact[:120])
    hints = []
    for line in lines:
        if re.search(r'[图表]\s*\d|图\s*\d|表\s*\d', line):
            hints.append(line)
    for line in lines:
        if len(line) >= 12:
            hints.append(line)
    compact = compact_hint_text(value)
    if compact:
        step = max(1, len(compact) // 5)
        for start in range(0, len(compact), step):
            chunk = compact[start:start + 80]
            if len(chunk) >= 16:
                hints.append(chunk)
    unique = []
    seen = set()
    for hint in hints:
        if hint in seen:
            continue
        seen.add(hint)
        unique.append(hint)
        if len(unique) >= 10:
            break
    return unique

def vector_diagram_candidate(page, page_dict, page_rect, page_area, selected):
    if selected:
        return None
    vector_min_drawings = int(os.environ.get('VISION_EXTRACTION_PDF_VECTOR_MIN_DRAWINGS', '40'))
    vector_min_area_ratio = float(os.environ.get('VISION_EXTRACTION_PDF_VECTOR_MIN_AREA_RATIO', '0.18'))
    vector_max_prose_lines = int(os.environ.get('VISION_EXTRACTION_PDF_VECTOR_MAX_PROSE_LINES', '3'))
    vector_min_label_lines = int(os.environ.get('VISION_EXTRACTION_PDF_VECTOR_MIN_LABEL_LINES', '10'))
    drawing_rects = []
    try:
        drawings = page.get_drawings()
    except Exception:
        drawings = []
    for drawing in drawings:
        rect = drawing.get('rect')
        if not rect or rect.is_empty or rect.is_infinite:
            continue
        rect = rect & page_rect
        area = rect_area(rect)
        if area <= 1:
            continue
        drawing_rects.append(rect)
    if len(drawing_rects) < vector_min_drawings:
        return None
    drawing_rect = union_rects(drawing_rects)
    if not drawing_rect:
        return None
    area_ratio = rect_area(drawing_rect) / page_area if page_area else 0
    if area_ratio < vector_min_area_ratio:
        return None
    prose_lines, label_lines, vertical_labels = text_line_metrics(page_dict.get('blocks', []), page_rect)
    if prose_lines > vector_max_prose_lines:
        return None
    if label_lines + vertical_labels < vector_min_label_lines:
        return None
    return {
        'rect': drawing_rect,
        'areaRatio': area_ratio,
        'bytes': 0,
        'fullPage': False,
        'score': 86.0 + min(20.0, len(drawing_rects) / 10.0) + area_ratio * 20.0,
        'replacePageText': True,
        'vectorDiagram': True,
        'rotateDegrees': 90 if vertical_labels >= 6 and drawing_rect.height > drawing_rect.width * 1.25 else 0,
    }

all_candidates = []
for page_index, page in enumerate(doc):
    if max_pages > 0 and page_index >= max_pages:
        break
    page_rect = page.rect
    page_area = rect_area(page_rect)
    if not page_area:
        continue
    page_dict = page.get_text('dict')
    page_text = (page.get_text('text') or text_from_blocks(page_dict.get('blocks', []))).strip()
    text_chars = len(re.sub(r'\s+', '', page_text))
    image_candidates = []

    if page.get_images(full=True):
        for block in page_dict.get('blocks', []):
            if block.get('type') != 1:
                continue
            rect = fitz.Rect(block.get('bbox', (0, 0, 0, 0))) & page_rect
            area_ratio = rect_area(rect) / page_area
            if area_ratio <= 0:
                continue
            byte_size = image_size(block)
            full_page = is_full_page(rect, page_rect)
            if full_page and byte_size <= background_max_bytes:
                continue
            if not full_page and area_ratio < min_region_area_ratio:
                continue
            if not full_page and byte_size and byte_size < background_max_bytes and area_ratio < 0.18:
                continue
            image_candidates.append({
                'rect': rect,
                'areaRatio': area_ratio,
                'bytes': byte_size,
                'fullPage': full_page,
                'score': candidate_score(area_ratio, byte_size, text_chars, full_page),
            })

    deduped = []
    for candidate in sorted(image_candidates, key=lambda item: (item['score'], item['areaRatio']), reverse=True):
        if any(intersection_ratio(candidate['rect'], existing['rect']) > 0.86 for existing in deduped):
            continue
        deduped.append(candidate)

    partials = [candidate for candidate in deduped if not candidate['fullPage']]
    partials = merge_related_partials(partials, page_rect)
    full_pages = [candidate for candidate in deduped if candidate['fullPage']]
    selected = partials
    if not selected and full_pages and text_chars == 0:
        selected = full_pages[:1]
    vector_candidate = vector_diagram_candidate(page, page_dict, page_rect, page_area, selected)
    if vector_candidate:
        selected = [vector_candidate]

    for index, candidate in enumerate(selected, 1):
        region = 'vector diagram' if candidate.get('vectorDiagram') else 'full page' if candidate['fullPage'] else f'region {index}'
        all_candidates.append({
            'page': page_index + 1,
            'region': region,
            'rect': candidate['rect'],
            'score': candidate['score'],
            'areaRatio': candidate['areaRatio'],
            'textChars': text_chars,
            'contextText': '' if candidate.get('replacePageText') else page_text[:1200],
            'textHints': page_text_hints(page_text),
            'replacePageText': candidate.get('replacePageText', False),
            'rotateDegrees': candidate.get('rotateDegrees', 0),
        })

selected_candidates = sorted(all_candidates, key=lambda item: item['score'], reverse=True)
selected_candidates.sort(key=lambda item: (item['page'], item['region']))

for out_index, candidate in enumerate(selected_candidates, 1):
    page = doc[candidate['page'] - 1]
    clip = clip_with_padding(candidate['rect'], page.rect)
    out = out_dir / f"page-{candidate['page']}-{candidate['region'].replace(' ', '-')}-{out_index}.png"
    rotate_degrees = int(candidate.get('rotateDegrees', 0) or 0)
    render_matrix = fitz.Matrix(dpi / 72, dpi / 72).prerotate(rotate_degrees) if rotate_degrees else matrix
    pix = page.get_pixmap(matrix=render_matrix, clip=clip, alpha=False)
    pix.save(str(out))
    location = f"PDF page {candidate['page']} {candidate['region']}"
    records.append({
        'path': str(out),
        'filename': out.name,
        'location': location,
        'mimeType': 'image/png',
        'anchor': {'kind': 'pdf-page', 'page': candidate['page'], 'region': candidate['region'], 'replacePageText': candidate.get('replacePageText', False), 'textHints': candidate.get('textHints', [])},
        'contextText': candidate['contextText'],
        'rotateDegrees': rotate_degrees,
        'score': round(candidate['score'], 2),
        'areaRatio': round(candidate['areaRatio'], 4),
        'textChars': candidate['textChars'],
    })

print(json.dumps(records, ensure_ascii=False))
`;
      const configuredMaxPages = Number(process.env.VISION_EXTRACTION_PDF_MAX_PAGES ?? 0);
      const maxPages = Number.isFinite(configuredMaxPages) && configuredMaxPages > 0 ? configuredMaxPages : 0;
      const dpi = Number(process.env.VISION_EXTRACTION_PDF_DPI ?? 144);
      const minRegionAreaRatio = Number(process.env.VISION_EXTRACTION_PDF_MIN_REGION_AREA_RATIO ?? 0.1);
      const fullPageTextMaxChars = Number(process.env.VISION_EXTRACTION_PDF_FULL_PAGE_TEXT_MAX_CHARS ?? 160);
      const backgroundMaxBytes = Number(process.env.VISION_EXTRACTION_PDF_BACKGROUND_MAX_BYTES ?? 20_000);
      const { stdout } = await execFileAsync(python, [
        "-c",
        script,
        inputPath,
        outDir,
        String(maxPages),
        String(dpi),
        String(minRegionAreaRatio),
        String(fullPageTextMaxChars),
        String(backgroundMaxBytes),
      ], {
        timeout: Number(process.env.VISION_EXTRACTION_EXTRACT_TIMEOUT_MS ?? 60_000),
        maxBuffer: 4 * 1024 * 1024,
      });
      const records = JSON.parse(stdout) as Array<{ path: string; filename?: string; location: string; mimeType: string; anchor?: VisionAnchor; contextText?: string }>;
      return Promise.all(records.map(async (record) => ({
        location: record.location,
        filename: record.filename,
        mimeType: record.mimeType,
        anchor: record.anchor,
        contextText: record.contextText,
        data: await fs.readFile(record.path),
      })));
    } catch {
      return [];
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async describeVisionImages(sourceName: string, candidates: VisionImageCandidate[]): Promise<VisionExtractionSummary | null> {
    const config = this.visionConfig();
    if (!config.enabled || !config.model || !config.apiKey || !config.url) return null;
    const processCandidate = async (candidate: VisionImageCandidate): Promise<VisionExtractionImageResult> => {
      if (candidate.data.byteLength > config.maxImageBytes) {
        return { location: candidate.location, filename: candidate.filename, mimeType: candidate.mimeType, anchor: candidate.anchor, bytes: candidate.data.byteLength, status: "skipped", error: `Image exceeds ${config.maxImageBytes} byte limit` };
      }
      if (this.shouldSkipSmallEmbeddedImage(sourceName, candidate, config)) {
        return { location: candidate.location, filename: candidate.filename, mimeType: candidate.mimeType, anchor: candidate.anchor, bytes: candidate.data.byteLength, status: "skipped", error: "Small embedded image skipped; placeholder retained." };
      }
      try {
        const markdown = await this.callVisionModelWithTimeoutRetry(sourceName, candidate, config);
        return {
          location: candidate.location,
          filename: candidate.filename,
          mimeType: candidate.mimeType,
          anchor: candidate.anchor,
          bytes: candidate.data.byteLength,
          status: "processed",
          markdown,
        };
      } catch (error) {
        return { location: candidate.location, filename: candidate.filename, mimeType: candidate.mimeType, anchor: candidate.anchor, bytes: candidate.data.byteLength, status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    };

    const normalizedCandidates: VisionImageCandidate[] = [];
    const skippedImages: VisionExtractionImageResult[] = [];
    let normalizedImageBytes = 0;
    for (const candidate of candidates) {
      const normalized = await this.normalizeVisionImageCandidate(candidate);
      const nextTotal = normalizedImageBytes + normalized.data.byteLength;
      if (nextTotal > config.maxNormalizedImageBytes) {
        skippedImages.push({ location: normalized.location, filename: normalized.filename, mimeType: normalized.mimeType, anchor: normalized.anchor, bytes: normalized.data.byteLength, status: "skipped", error: `Skipped after VISION_EXTRACTION_MAX_NORMALIZED_IMAGE_BYTES_PER_FILE=${config.maxNormalizedImageBytes}` });
        continue;
      }
      normalizedImageBytes = nextTotal;
      normalizedCandidates.push(normalized);
    }

    const images = new Array<VisionExtractionImageResult | undefined>(normalizedCandidates.length);
    let nextIndex = 0;
    const workerCount = Math.min(config.concurrency, normalizedCandidates.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < normalizedCandidates.length) {
        const index = nextIndex;
        nextIndex += 1;
        images[index] = await processCandidate(normalizedCandidates[index]);
      }
    });
    await Promise.all(workers);
    const orderedImages = images.filter((image): image is VisionExtractionImageResult => Boolean(image));

    const allImages = [...orderedImages, ...skippedImages];
    return {
      enabled: true,
      model: config.model,
      processedImages: allImages.filter((image) => image.status === "processed").length,
      failedImages: allImages.filter((image) => image.status === "failed").length,
      skippedImages: allImages.filter((image) => image.status === "skipped").length,
      images: allImages,
    };
  }

  private shouldSkipSmallEmbeddedImage(sourceName: string, candidate: VisionImageCandidate, config: ReturnType<MarkitdownConverter["visionConfig"]>): boolean {
    if (isStandaloneImage(sourceName) || isPdf(sourceName)) return false;
    if (config.minEmbeddedImageBytes <= 0) return false;
    return candidate.data.byteLength < config.minEmbeddedImageBytes;
  }

  private async normalizeVisionImageCandidate(candidate: VisionImageCandidate): Promise<VisionImageCandidate> {
    if (candidate.data.byteLength <= VISION_IMAGE_COMPRESSION_THRESHOLD_BYTES) return candidate;
    try {
      const compressed = await this.compressVisionImage(candidate);
      if (!compressed || compressed.data.byteLength >= candidate.data.byteLength) return candidate;
      return compressed;
    } catch {
      return candidate;
    }
  }

  private async compressVisionImage(candidate: VisionImageCandidate): Promise<VisionImageCandidate | null> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-vision-compress-"));
    const ext = candidate.mimeType === "image/png" ? ".png" : candidate.mimeType === "image/webp" ? ".webp" : candidate.mimeType === "image/gif" ? ".gif" : ".jpg";
    const inputPath = path.join(tmpDir, `input${ext}`);
    const outputPath = path.join(tmpDir, "output.jpg");
    await fs.writeFile(inputPath, candidate.data);
    try {
      const python = markitdownPythonCommand(this.options.pythonCommand);
      const script = String.raw`
import json
import sys

input_path, output_path = sys.argv[1], sys.argv[2]
threshold = int(sys.argv[3])
max_edge = int(sys.argv[4])
qualities = [int(value) for value in sys.argv[5].split(',') if value.strip()]

try:
    from PIL import Image, ImageOps
except Exception:
    print(json.dumps({'ok': False, 'error': 'Pillow unavailable'}))
    raise SystemExit(0)

try:
    image = Image.open(input_path)
    try:
        image.seek(0)
    except Exception:
        pass
    image = ImageOps.exif_transpose(image)
    if image.mode in ('RGBA', 'LA') or ('transparency' in image.info):
        background = Image.new('RGB', image.size, (255, 255, 255))
        alpha = image.convert('RGBA').getchannel('A')
        background.paste(image.convert('RGBA'), mask=alpha)
        image = background
    else:
        image = image.convert('RGB')

    width, height = image.size
    longest = max(width, height)
    if longest > max_edge:
        scale = max_edge / float(longest)
        new_size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
        image = image.resize(new_size, Image.Resampling.LANCZOS)

    best = None
    for quality in qualities:
        image.save(output_path, format='JPEG', quality=quality, optimize=True, progressive=True)
        with open(output_path, 'rb') as handle:
            data = handle.read()
        record = {'ok': True, 'path': output_path, 'bytes': len(data), 'quality': quality, 'width': image.size[0], 'height': image.size[1]}
        if best is None or record['bytes'] < best['bytes']:
            best = record
        if record['bytes'] <= threshold:
            best = record
            break
    print(json.dumps(best or {'ok': False}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({'ok': False, 'error': str(exc)}))
`;
      const { stdout } = await execFileAsync(python, [
        "-c",
        script,
        inputPath,
        outputPath,
        String(VISION_IMAGE_COMPRESSION_THRESHOLD_BYTES),
        String(VISION_IMAGE_COMPRESSION_MAX_EDGE),
        VISION_IMAGE_COMPRESSION_QUALITIES.join(","),
      ], {
        timeout: 30_000,
        maxBuffer: 512 * 1024,
      });
      const result = JSON.parse(stdout) as { ok?: boolean; path?: string };
      if (!result.ok || !result.path) return null;
      const data = await fs.readFile(result.path);
      return {
        ...candidate,
        data,
        mimeType: "image/jpeg",
        filename: candidate.filename ? `${path.basename(candidate.filename, path.extname(candidate.filename))}.jpg` : candidate.filename,
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async callVisionModelWithTimeoutRetry(sourceName: string, candidate: VisionImageCandidate, config: ReturnType<MarkitdownConverter["visionConfig"]>): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= VISION_TIMEOUT_RETRY_COUNT; attempt += 1) {
      try {
        return await this.callVisionModel(sourceName, candidate, config);
      } catch (error) {
        lastError = error;
        if (!this.isVisionTimeoutError(error) || attempt >= VISION_TIMEOUT_RETRY_COUNT) throw error;
        await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private isVisionTimeoutError(error: unknown): boolean {
    const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return /timeout|timed out|aborted/i.test(text);
  }

  private async callVisionModel(sourceName: string, candidate: VisionImageCandidate, config: ReturnType<MarkitdownConverter["visionConfig"]>): Promise<string> {
    const prompt = process.env.VISION_EXTRACTION_PROMPT ?? [
      "Convert the visible image content into natural Markdown that can be inserted back into the source document near its original location.",
      "Describe only what is visible in the image, faithfully and with the level of detail needed to preserve the document content.",
      "For ordinary real-world photos, product photos, warehouse scenes, decorative screenshots, or video thumbnails, return exactly one short sentence wrapped in <image>...</image>.",
      "Ignore playback controls, cursor/hand overlays, generic UI chrome, and labels or numbers that do not express a business rule, process step, table value, entity, or relationship.",
      "Only write more than one sentence when the image contains substantial embedded business text, a table, a process flow, diagram, mind map, UI state, chart, or structured relationship.",
      "For structured images, reconstruct the visible content instead of summarizing it. Preserve visible labels, entities, numbers, steps, relationships, table cells, card titles, prices, limits, and feature bullets where legible.",
      "For tables, pricing matrices, comparison cards, UI screens, and dense labeled diagrams, prefer a Markdown table or grouped bullets that keep each visible row, column, card, section, or node distinct.",
      "Do not wrap structured images, tables, diagrams, UI screens, or dense labeled content in <image> tags; use <image> only for ordinary illustrative images.",
      "Do not collapse structured content into broad categories such as \"visible features include\" when individual visible items can be read.",
      "If small text is not legible, say that the small text is not fully legible instead of inventing missing content.",
      "Use concise bullets only for structured content where bullets are clearer than a short paragraph.",
      "Do not use fixed section headings such as Extracted Text, Visual Description, or Diagram / Flow Structure.",
      "Do not mention OCR, image numbers, source files, page regions, or that you are analyzing an image.",
      "Avoid repeating surrounding text unless the image adds new detail.",
      `Source file: ${sourceName}`,
      `Image location: ${candidate.location}`,
      candidate.contextText?.trim() ? `Surrounding extracted text:\n${candidate.contextText.trim()}` : "",
    ].join("\n");
    const dataUrl = `data:${candidate.mimeType};base64,${candidate.data.toString("base64")}`;
    const useResponsesApi = isResponsesUrl(config.url!);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.provider === "azure") headers["api-key"] = config.apiKey!;
    else headers.Authorization = `Bearer ${config.apiKey}`;
    const body = useResponsesApi
      ? {
        model: config.model,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl },
          ],
        }],
        stream: false,
        max_output_tokens: config.maxTokens,
      }
      : {
        model: config.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        stream: false,
        max_completion_tokens: config.maxTokens,
      };
    const response = await fetch(config.url!, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`vision request failed ${response.status}: ${detail.slice(0, 300)}`);
    }
    const json = await response.json() as { choices?: Array<{ message?: { content?: unknown } }>; output_text?: unknown; output?: unknown };
    if (useResponsesApi) {
      const text = this.extractResponsesText(json);
      if (text) return text;
      throw new Error("vision response was empty");
    }
    const content = json.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content.map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").join("\n").trim();
      if (text) return text;
    }
    throw new Error("vision response was empty");
  }

  private extractResponsesText(json: { output_text?: unknown; output?: unknown }): string {
    if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text.trim();
    if (!Array.isArray(json.output)) return "";
    const chunks: string[] = [];
    for (const item of json.output) {
      if (!item || typeof item !== "object") continue;
      const record = item as { content?: unknown; text?: unknown };
      if (typeof record.text === "string" && record.text.trim()) chunks.push(record.text.trim());
      if (!Array.isArray(record.content)) continue;
      for (const part of record.content) {
        if (typeof part === "string" && part.trim()) {
          chunks.push(part.trim());
          continue;
        }
        if (!part || typeof part !== "object") continue;
        const content = part as { text?: unknown; type?: unknown };
        if (typeof content.text === "string" && content.text.trim()) chunks.push(content.text.trim());
      }
    }
    return chunks.join("\n").trim();
  }

  private uniqueOutputName(name: string, seen: Map<string, number>): string {
    const key = name.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return name;
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    return `${stem}-${count + 1}${ext}`;
  }

  private async extractZipEntries(name: string, data: Buffer): Promise<Array<{ name: string; data: Buffer; tempRoot: string }>> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-upload-zip-"));
    const zipPath = path.join(tmpDir, path.basename(name));
    const outDir = path.join(tmpDir, "extracted");
    await fs.writeFile(zipPath, data);
    try {
      const python = markitdownPythonCommand(this.options.pythonCommand);
      const script = [
        "import json, os, pathlib, re, shutil, sys, zipfile",
        "zip_path, out_dir = sys.argv[1], sys.argv[2]",
        "max_entries = int(os.environ.get('MARKITDOWN_ZIP_MAX_ENTRIES', '10000'))",
        "max_total_bytes = int(os.environ.get('MARKITDOWN_ZIP_MAX_TOTAL_BYTES', str(512 * 1024 * 1024)))",
        "supported_exts = {'.md','.markdown','.txt','.csv','.json','.yaml','.yml','.xml','.html','.htm','.ts','.tsx','.js','.jsx','.py','.java','.go','.rs','.sql','.css','.scss','.log','.pdf','.doc','.docx','.ppt','.pptx','.xls','.xlsx','.msg','.png','.jpg','.jpeg','.gif','.webp'}",
        "def decode_zip_name(value):",
        "    try:",
        "        raw_bytes = value.encode('cp437')",
        "    except UnicodeEncodeError:",
        "        return value",
        "    try:",
        "        utf8_candidate = raw_bytes.decode('utf-8')",
        "        if utf8_candidate:",
        "            return utf8_candidate",
        "    except UnicodeDecodeError:",
        "        pass",
        "    mojibake_chars = set('鍦烘櫙涓氬姟璇箟閭妯澘鏌琛屼负瑙勮寖璺ㄧ郴缁熸煡笌鏅鸿兘闂瓟鈺暶溝兠宦暎毛')",
        "    def score(candidate, enc):",
        "        cjk = sum(1 for ch in candidate if '\\u4e00' <= ch <= '\\u9fff')",
        "        ascii = sum(1 for ch in candidate if ch.isascii() and (ch.isalnum() or ch in '._- /()#'))",
        "        private = sum(1 for ch in candidate if '\\ue000' <= ch <= '\\uf8ff')",
        "        box = sum(1 for ch in candidate if '\\u2500' <= ch <= '\\u257f')",
        "        suspicious = sum(1 for ch in candidate if ch in mojibake_chars)",
        "        bonus = 4 if enc == 'utf-8' else 0",
        "        return cjk * 3 + ascii * 0.1 + bonus - suspicious * 8 - private * 20 - box * 12 - candidate.count('\\ufffd') * 20",
        "    best = value",
        "    best_score = score(value, 'zipfile')",
        "    for enc in ('utf-8', 'gb18030', 'gbk', 'big5'):",
        "        try:",
        "            candidate = raw_bytes.decode(enc)",
        "        except UnicodeDecodeError:",
        "            continue",
        "        candidate_score = score(candidate, enc)",
        "        if candidate_score > best_score:",
        "            best, best_score = candidate, candidate_score",
        "    return best",
        "def safe_part(part):",
        "    return re.sub(r'[^\\w.\\- ()]', '_', part, flags=re.UNICODE).strip(' .') or 'file'",
        "def unique_dest(path):",
        "    if not path.exists():",
        "        return path",
        "    stem, suffix = path.stem, path.suffix",
        "    for idx in range(2, 1000):",
        "        candidate = path.with_name(f'{stem}-{idx}{suffix}')",
        "        if not candidate.exists():",
        "            return candidate",
        "    raise RuntimeError(f'too many duplicate zip entries for {path.name}')",
        "entries = []",
        "total = 0",
        "with zipfile.ZipFile(zip_path) as archive:",
        "    for info in archive.infolist():",
        "        if info.is_dir():",
        "            continue",
        "        raw = decode_zip_name(info.filename).replace('\\\\', '/')",
        "        parts = [safe_part(p) for p in pathlib.PurePosixPath(raw).parts if p not in ('', '.', '..') and p != '__MACOSX' and not p.startswith('.')]",
        "        if not parts:",
        "            continue",
        "        if pathlib.PurePosixPath('/'.join(parts)).suffix.lower() not in supported_exts:",
        "            continue",
        "        total += info.file_size",
        "        if len(entries) >= max_entries or total > max_total_bytes:",
        "            raise RuntimeError('zip upload exceeds configured entry or size limits')",
        "        dest = unique_dest(pathlib.Path(out_dir).joinpath(*parts))",
        "        parent = pathlib.Path(out_dir)",
        "        conflict = False",
        "        for part in dest.relative_to(out_dir).parts[:-1]:",
        "            parent = parent / part",
        "            if parent.exists() and not parent.is_dir():",
        "                conflict = True",
        "                break",
        "        if conflict:",
        "            continue",
        "        dest.parent.mkdir(parents=True, exist_ok=True)",
        "        with archive.open(info) as src, open(dest, 'wb') as dst:",
        "            shutil.copyfileobj(src, dst)",
        "        entries.append({'name': '/'.join(parts), 'path': str(dest)})",
        "print(json.dumps(entries))",
      ].join("\n");
      const { stdout } = await execFileAsync(python, ["-c", script, zipPath, outDir], {
        timeout: this.options.timeoutMs ?? Number(process.env.MARKITDOWN_ZIP_TIMEOUT_MS ?? 30_000),
        maxBuffer: 2 * 1024 * 1024,
        env: markitdownPythonEnv(),
      });
      const entries = JSON.parse(stdout) as Array<{ name: string; path: string }>;
      if (!entries.length) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        return [];
      }
      return Promise.all(entries.map(async (entry) => ({ name: entry.name, data: await fs.readFile(entry.path), tempRoot: tmpDir })));
    } catch (error) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async convertWithPython(name: string, data: Buffer): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-markitdown-"));
    const inputPath = path.join(tmpDir, path.basename(name));
    await fs.writeFile(inputPath, data);
    try {
      const python = markitdownPythonCommand(this.options.pythonCommand);
      const script = [
        "import os",
        "import pathlib",
        "import subprocess",
        "import sys",
        "import tempfile",
        "import zipfile",
        "from markitdown import MarkItDown",
        "kwargs = {}",
        "if os.environ.get('MARKITDOWN_ENABLE_PLUGINS', 'true').lower() not in ('0', 'false', 'no'):",
        "    kwargs['enable_plugins'] = True",
        "docintel_endpoint = os.environ.get('MARKITDOWN_DOCINTEL_ENDPOINT')",
        "if docintel_endpoint:",
        "    kwargs['docintel_endpoint'] = docintel_endpoint",
        "docintel_api_version = os.environ.get('MARKITDOWN_DOCINTEL_API_VERSION')",
        "if docintel_api_version:",
        "    kwargs['docintel_api_version'] = docintel_api_version",
        "docintel_key = os.environ.get('MARKITDOWN_DOCINTEL_KEY') or os.environ.get('MARKITDOWN_AZURE_API_KEY')",
        "if docintel_key and not os.environ.get('AZURE_API_KEY'):",
        "    os.environ['AZURE_API_KEY'] = docintel_key",
        "def _chat_base_url(value):",
        "    if not value:",
        "        return value",
        "    suffix = '/chat/completions'",
        "    return value[:-len(suffix)] if value.endswith(suffix) else value",
        "def _extract_emf_wmf_text(file_path):",
        "    suffix = pathlib.Path(file_path).suffix.lower()",
        "    if suffix not in ('.docx', '.pptx', '.xlsx'):",
        "        return ''",
        "    chunks = []",
        "    try:",
        "        with zipfile.ZipFile(file_path) as archive:",
        "            media_names = [name for name in archive.namelist() if pathlib.PurePosixPath(name).suffix.lower() in ('.emf', '.wmf') and '/media/' in name]",
        "            for media_name in media_names:",
        "                data = archive.read(media_name)",
        "                with tempfile.NamedTemporaryFile(suffix=pathlib.PurePosixPath(media_name).suffix.lower(), delete=False) as media_file:",
        "                    media_file.write(data)",
        "                    media_path = media_file.name",
        "                try:",
        "                    strings = subprocess.run(['strings', '-el', media_path], check=False, capture_output=True, text=True, timeout=30).stdout.splitlines()",
        "                except (OSError, subprocess.TimeoutExpired):",
        "                    strings = []",
        "                finally:",
        "                    pathlib.Path(media_path).unlink(missing_ok=True)",
        "                cleaned = []",
        "                for value in strings:",
        "                    value = value.strip().replace('\\x00', '')",
        "                    if not value:",
        "                        continue",
        "                    cleaned.append(value)",
        "                if cleaned:",
        "                    chunks.append('### ' + media_name + '\\n\\n```text\\n' + '\\n'.join(cleaned) + '\\n```')",
        "                else:",
        "                    chunks.append('### ' + media_name + '\\n\\n_EMF/WMF media detected, but no embedded text strings were extracted._')",
        "    except zipfile.BadZipFile:",
        "        return ''",
        "    if not chunks:",
        "        return ''",
        "    return '\\n\\n## Extracted EMF/WMF Text\\n\\nThe following text was extracted from embedded Office vector media because vision OCR may not process EMF/WMF images directly. Review the original source file when table layout matters.\\n\\n' + '\\n\\n'.join(chunks)",
        "allow_markitdown_llm = os.environ.get('MARKITDOWN_ALLOW_LLM_IN_MARKITDOWN', 'false').lower() in ('1', 'true', 'yes')",
        "llm_model = os.environ.get('MARKITDOWN_LLM_MODEL') if allow_markitdown_llm else None",
        "if llm_model:",
        "    from openai import OpenAI",
        "    llm_api_key = os.environ.get('MARKITDOWN_LLM_API_KEY') or os.environ.get('OPENAI_API_KEY') or os.environ.get('AZURE_OPENAI_API_KEY')",
        "    azure_endpoint = os.environ.get('AZURE_OPENAI_ENDPOINT')",
        "    azure_v1_base = (azure_endpoint.rstrip('/') + '/openai/v1') if azure_endpoint else None",
        `    llm_base_url = os.environ.get('MARKITDOWN_LLM_BASE_URL') or os.environ.get('AZURE_OPENAI_BASE_URL') or _chat_base_url(os.environ.get('AZURE_OPENAI_CHAT_COMPLETIONS_URL')) or azure_v1_base or ('${DEFAULT_AZURE_OPENAI_BASE_URL}' if os.environ.get('AZURE_OPENAI_API_KEY') else None)`,
        "    client_kwargs = {}",
        "    if llm_api_key:",
        "        client_kwargs['api_key'] = llm_api_key",
        "    if llm_base_url:",
        "        client_kwargs['base_url'] = llm_base_url",
        "    kwargs['llm_client'] = OpenAI(**client_kwargs)",
        "    kwargs['llm_model'] = llm_model",
        "    kwargs['llm_prompt'] = os.environ.get('MARKITDOWN_LLM_PROMPT', 'Extract all visible text from this image exactly, then add a short markdown description if helpful.')",
        "md = MarkItDown(**kwargs)",
        "result = md.convert(sys.argv[1])",
        "text = result.text_content or ''",
        "if not text.strip() and pathlib.Path(sys.argv[1]).suffix.lower() == '.pdf':",
        "    try:",
        "        text = subprocess.run(['pdftotext', sys.argv[1], '-'], check=False, capture_output=True, text=True, timeout=int(os.environ.get('MARKITDOWN_PDF_TEXT_TIMEOUT_MS', '30000')) / 1000).stdout",
        "    except (OSError, subprocess.TimeoutExpired):",
        "        text = ''",
        "if not text.strip() and llm_model and pathlib.Path(sys.argv[1]).suffix.lower() == '.pdf':",
        "    max_pages = int(os.environ.get('MARKITDOWN_PDF_VISION_MAX_PAGES', '10'))",
        "    with tempfile.TemporaryDirectory(prefix='markitdown-pdf-vision-') as out_dir:",
        "        prefix = os.path.join(out_dir, 'page')",
        "        subprocess.run(['pdftoppm', '-png', '-r', os.environ.get('MARKITDOWN_PDF_VISION_DPI', '180'), '-f', '1', '-l', str(max_pages), sys.argv[1], prefix], check=True, timeout=int(os.environ.get('MARKITDOWN_PDF_VISION_RENDER_TIMEOUT_MS', '30000')) / 1000)",
        "        chunks = []",
        "        for image_path in sorted(pathlib.Path(out_dir).glob('page-*.png')):",
        "            image_result = md.convert(str(image_path))",
        "            image_text = (image_result.text_content or '').strip()",
        "            if image_text:",
        "                chunks.append(f'## Page {len(chunks) + 1}\\n\\n{image_text}')",
        "        text = '\\n\\n'.join(chunks)",
        "emf_wmf_text = _extract_emf_wmf_text(sys.argv[1])",
        "if emf_wmf_text:",
        "    text = (text.rstrip() + '\\n\\n' + emf_wmf_text).strip()",
        "sys.stdout.write(text)",
      ].join("\n");
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(python, ["-c", script, inputPath], {
          timeout: this.options.timeoutMs ?? documentConversionTimeoutMs(),
          maxBuffer: 20 * 1024 * 1024,
          env: markitdownPythonEnv(),
        }));
      } catch (error) {
        throw new Error(formatPythonFailure(error));
      }
      const markdown = stdout.trim();
      if (!markdown) throw new Error("empty markdown output");
      return markdown;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async convertExcelSheets(name: string, data: Buffer): Promise<MarkitdownConversionResult[]> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-markitdown-excel-"));
    const inputPath = path.join(tmpDir, path.basename(name));
    await fs.writeFile(inputPath, data);
    try {
      const python = markitdownPythonCommand(this.options.pythonCommand);
      const script = [
        "import json",
        "import sys",
        "import pandas as pd",
        "def cell_text(value):",
        "    if value is None:",
        "        return ''",
        "    try:",
        "        if pd.isna(value):",
        "            return ''",
        "    except (TypeError, ValueError):",
        "        pass",
        "    if isinstance(value, float) and value.is_integer():",
        "        value = int(value)",
        "    text = str(value)",
        "    return text.replace('\\r\\n', '\\n').replace('\\r', '\\n').replace('|', '\\\\|').replace('\\n', '<br>')",
        "def trim_grid(rows):",
        "    rows = [[cell_text(cell) for cell in row] for row in rows]",
        "    while rows and all(cell == '' for cell in rows[-1]):",
        "        rows.pop()",
        "    width = max((len(row) for row in rows), default=0)",
        "    while width and all((row[col] if col < len(row) else '') == '' for row in rows for col in [width - 1]):",
        "        width -= 1",
        "    return [row[:width] + [''] * max(0, width - len(row)) for row in rows]",
        "def markdown_table(rows):",
        "    rows = trim_grid(rows)",
        "    if not rows or not rows[0]:",
        "        return '_This sheet is empty._'",
        "    width = len(rows[0])",
        "    header = [f'Column {idx + 1}' for idx in range(width)]",
        "    lines = ['| ' + ' | '.join(header) + ' |', '| ' + ' | '.join(['---'] * width) + ' |']",
        "    lines.extend('| ' + ' | '.join(row) + ' |' for row in rows)",
        "    return '\\n'.join(lines)",
        "book = pd.read_excel(sys.argv[1], sheet_name=None, header=None, dtype=object, keep_default_na=False, na_filter=False)",
        "result = []",
        "for sheet_name, frame in book.items():",
        "    rows = frame.where(pd.notna(frame), '').values.tolist()",
        "    result.append({'sheetName': str(sheet_name), 'markdown': f'# {sheet_name}\\n\\n' + markdown_table(rows)})",
        "print(json.dumps(result, ensure_ascii=False))",
      ].join("\n");
      const { stdout } = await execFileAsync(python, ["-c", script, inputPath], {
        timeout: this.options.timeoutMs ?? documentConversionTimeoutMs(),
        maxBuffer: 20 * 1024 * 1024,
        env: markitdownPythonEnv(),
      });
      const sheets = JSON.parse(stdout) as Array<{ sheetName: string; markdown: string }>;
      if (!sheets.length) throw new Error("empty workbook output");
      return sheets.map((sheet) => ({
        markdown: sheet.markdown.trim(),
        outputName: excelSheetOutputName(name, sheet.sheetName, sheets.length),
        converted: true,
        converter: "markitdown",
        sourceName: `${name}#${sheet.sheetName}`,
      }));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async assertDocumentWithinLimits(name: string, data: Buffer): Promise<void> {
    const ext = path.extname(name).toLowerCase();
    if (isPdf(name)) {
      const maxBytes = envNumber("PDF_MAX_BYTES", DEFAULT_PDF_MAX_BYTES);
      if (data.byteLength > maxBytes) throw new Error(`PDF ${name} is ${formatBytes(data.byteLength)}, exceeding the ${formatBytes(maxBytes)} limit.`);
      const maxPages = envNumber("PDF_MAX_PAGES", DEFAULT_PDF_MAX_PAGES);
      const pages = await this.pdfPageCount(name, data);
      if (pages !== undefined && pages > maxPages) throw new Error(`PDF ${name} has ${pages} pages, exceeding the ${maxPages}-page limit.`);
      return;
    }

    if (isPresentation(name)) {
      const maxBytes = envNumber("PRESENTATION_MAX_BYTES", DEFAULT_PRESENTATION_MAX_BYTES);
      if (data.byteLength > maxBytes) throw new Error(`Presentation ${name} is ${formatBytes(data.byteLength)}, exceeding the ${formatBytes(maxBytes)} limit.`);
      if (ext === ".pptx") {
        const metadata = await this.officeOpenXmlMetadata(name, data);
        const maxSlides = envNumber("PRESENTATION_MAX_SLIDES", DEFAULT_PRESENTATION_MAX_SLIDES);
        if (metadata.slides !== undefined && metadata.slides > maxSlides) throw new Error(`Presentation ${name} has ${metadata.slides} slides, exceeding the ${maxSlides}-slide limit.`);
      }
      return;
    }

    if (isWordDocument(name)) {
      const maxBytes = envNumber("WORD_MAX_BYTES", DEFAULT_WORD_MAX_BYTES);
      if (data.byteLength > maxBytes) throw new Error(`Word document ${name} is ${formatBytes(data.byteLength)}, exceeding the ${formatBytes(maxBytes)} limit.`);
      return;
    }
  }

  private async pdfPageCount(name: string, data: Buffer): Promise<number | undefined> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-pdf-metadata-"));
    const inputPath = path.join(tmpDir, path.basename(name));
    await fs.writeFile(inputPath, data);
    try {
      const python = markitdownPythonCommand(this.options.pythonCommand);
      const script = "import fitz, sys; print(fitz.open(sys.argv[1]).page_count)";
      const { stdout } = await execFileAsync(python, ["-c", script, inputPath], {
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
      const pages = Number(stdout.trim());
      return Number.isFinite(pages) ? pages : undefined;
    } catch {
      return undefined;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async officeOpenXmlMetadata(name: string, data: Buffer): Promise<{ slides?: number }> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-office-metadata-"));
    const inputPath = path.join(tmpDir, path.basename(name));
    await fs.writeFile(inputPath, data);
    try {
      const python = markitdownPythonCommand(this.options.pythonCommand);
      const script = String.raw`
import json
import sys
import zipfile

path = sys.argv[1]
try:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
    slides = len([name for name in names if name.startswith('ppt/slides/slide') and name.endswith('.xml')])
    print(json.dumps({'slides': slides if slides else None}, ensure_ascii=False))
except Exception:
    print(json.dumps({}))
`;
      const { stdout } = await execFileAsync(python, ["-c", script, inputPath], {
        timeout: 15_000,
        maxBuffer: 128 * 1024,
      });
      return JSON.parse(stdout) as { slides?: number };
    } catch {
      return {};
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
}

export const markitdownConverter = new MarkitdownConverter();
