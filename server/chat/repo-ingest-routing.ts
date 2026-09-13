import fs from "node:fs/promises";
import path from "node:path";

export const CODING_REPO_INGEST_SKILL_PATH = "skills/coding-repo-ingest/SKILL.md";
export const REPO_INGEST_PROMPT_HINT = "This ingest target is under raw/repos; you must Read and follow skills/coding-repo-ingest/SKILL.md before writing ingest-plans/*.json.";
export const REPO_INGEST_SKILL_GATE_MESSAGE = "This ingest target is under raw/repos; Read and follow skills/coding-repo-ingest/SKILL.md in this run, then retry.";
export const REPO_DOCUMENT_INGEST_GATE_MESSAGE = "This raw/repos target does not look like a code repository. Treat it as document material: do not use skills/coding-repo-ingest/SKILL.md; count files recursively and use skills/single-ingest/SKILL.md for 8 or fewer files, otherwise skills/batch-ingest/SKILL.md.";
export const NON_REPO_CODING_INGEST_GATE_MESSAGE = "skills/coding-repo-ingest/SKILL.md is only allowed for backend-validated code repositories under raw/repos/<id>. This target is not a validated raw/repos code repository. Use skills/single-ingest/SKILL.md or skills/batch-ingest/SKILL.md instead.";

const WORKFLOW_ID_RE = /^[A-Za-z0-9._-]+$/;
const REPO_SCAN_MAX_FILES = 1000;
const REPO_SCAN_MAX_DEPTH = 8;
const CODE_REPO_SOURCE_RATIO = 0.15;
const LARGE_REPO_SOURCE_RATIO = 0.05;
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".cs",
  ".php",
  ".rb",
  ".kt",
  ".swift",
  ".scala",
  ".dart",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
]);
const PROJECT_MARKERS = new Set([
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "pyproject.toml",
  "requirements.txt",
  "poetry.lock",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Dockerfile",
  "docker-compose.yml",
  "Makefile",
]);
const IGNORED_REPO_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);

export interface RepoShapeClassification {
  path: string;
  isCodeRepo: boolean;
  reason: string;
  totalFiles: number;
  sourceFiles: number;
  projectMarkers: number;
  sourceRatio: number;
  scannedFiles: number;
  truncated: boolean;
}

export interface RepoIngestPromptPreparation {
  prompt: string;
  allowedRepoPaths: Set<string>;
  documentRepoPaths: Map<string, RepoShapeClassification>;
}

export function normalizedWorkspacePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) return null;
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/").replace(/^\.\//, "")).replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
}

export function isRawRepoPath(value: unknown): boolean {
  const normalized = normalizedWorkspacePath(value);
  return normalized === "raw/repos" || Boolean(normalized?.startsWith("raw/repos/"));
}

export function rawRepoRootPath(value: unknown): string | null {
  const normalized = normalizedWorkspacePath(value);
  if (!normalized) return null;
  if (normalized === "raw/repos") return normalized;
  if (!normalized.startsWith("raw/repos/")) return null;
  const parts = normalized.split("/");
  return parts.length >= 3 ? parts.slice(0, 3).join("/") : "raw/repos";
}

export function hasRawRepoPath(paths: readonly string[]): boolean {
  return paths.some((item) => isRawRepoPath(item));
}

function workspaceAbsolutePath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

function isProjectMarker(fileName: string): boolean {
  if (PROJECT_MARKERS.has(fileName)) return true;
  return /^vite\.config\.[cm]?[jt]s$/.test(fileName) ||
    /^next\.config\.[cm]?[jt]s$/.test(fileName) ||
    /^webpack\.config\.[cm]?[jt]s$/.test(fileName);
}

function classificationReason(result: Omit<RepoShapeClassification, "reason">): string {
  const percent = Math.round(result.sourceRatio * 100);
  if (result.isCodeRepo) {
    return `${result.sourceFiles}/${result.totalFiles} code-like files (${percent}%) with ${result.projectMarkers} project marker${result.projectMarkers === 1 ? "" : "s"}`;
  }
  return `${result.sourceFiles}/${result.totalFiles} code-like files (${percent}%) and ${result.projectMarkers} project marker${result.projectMarkers === 1 ? "" : "s"}`;
}

export async function classifyRawRepoPath(root: string, value: unknown): Promise<RepoShapeClassification | null> {
  const repoPath = rawRepoRootPath(value);
  if (!repoPath) return null;

  let totalFiles = 0;
  let sourceFiles = 0;
  let projectMarkers = 0;
  let scannedFiles = 0;
  let truncated = false;

  const visit = async (relativeDir: string, depth: number): Promise<void> => {
    if (truncated || depth > REPO_SCAN_MAX_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(workspaceAbsolutePath(root, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isDirectory()) {
        if (!IGNORED_REPO_SCAN_DIRS.has(entry.name)) await visit(path.posix.join(relativeDir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      totalFiles += 1;
      scannedFiles += 1;
      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext)) sourceFiles += 1;
      if (isProjectMarker(entry.name)) projectMarkers += 1;
      if (scannedFiles >= REPO_SCAN_MAX_FILES) truncated = true;
    }
  };

  await visit(repoPath, 0);
  const sourceRatio = totalFiles ? sourceFiles / totalFiles : 0;
  const isCodeRepo = (sourceFiles >= 3 && projectMarkers >= 1) ||
    (sourceFiles >= 5 && sourceRatio >= CODE_REPO_SOURCE_RATIO) ||
    (sourceFiles >= 20 && sourceRatio >= LARGE_REPO_SOURCE_RATIO);
  const base = { path: repoPath, isCodeRepo, totalFiles, sourceFiles, projectMarkers, sourceRatio, scannedFiles, truncated };
  return { ...base, reason: classificationReason(base) };
}

async function directRawRepoRoots(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(workspaceAbsolutePath(root, "raw/repos"), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".tmp-"))
    .map((entry) => path.posix.join("raw/repos", entry.name));
}

function promptMentionsBroadRawIngest(prompt: string): boolean {
  return /uploaded raw sources under raw\/|ingest workflow for .*raw\/|inspect raw\/|bootstrap .*raw\//i.test(prompt);
}

export function rawRepoRootsFromText(text: string): string[] {
  const roots = new Set<string>();
  const re = /(?:^|[\s"'`(=])(?:\.\/)?(raw\/repos(?:\/[^\s"'`),;|&<>]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text.replace(/\\/g, "/")))) {
    const root = rawRepoRootPath(match[1]);
    if (root) roots.add(root);
  }
  return [...roots];
}

function formatClassificationList(items: readonly RepoShapeClassification[]): string {
  return items.map((item) => `- ${item.path}: ${item.reason}${item.truncated ? " (scan capped)" : ""}`).join("\n");
}

function codeRepoPromptHint(items: readonly RepoShapeClassification[]): string {
  return [
    REPO_INGEST_PROMPT_HINT,
    "Backend repo-shape check passed for:",
    formatClassificationList(items),
  ].join("\n");
}

function documentRepoPromptHint(items: readonly RepoShapeClassification[]): string {
  return [
    REPO_DOCUMENT_INGEST_GATE_MESSAGE,
    "Backend repo-shape check did not find enough code repository evidence for:",
    formatClassificationList(items),
  ].join("\n");
}

export async function prepareRepoIngestPrompt(root: string, prompt: string): Promise<RepoIngestPromptPreparation> {
  const roots = new Set(rawRepoRootsFromText(prompt));
  if (promptMentionsBroadRawIngest(prompt)) {
    for (const repoRoot of await directRawRepoRoots(root)) roots.add(repoRoot);
  }

  const classifications = (await Promise.all([...roots].map((repoRoot) => classifyRawRepoPath(root, repoRoot))))
    .filter((item): item is RepoShapeClassification => Boolean(item));
  const codeRepos = classifications.filter((item) => item.isCodeRepo);
  const documentRepos = classifications.filter((item) => !item.isCodeRepo);
  const allowedRepoPaths = new Set(codeRepos.map((item) => item.path));
  const documentRepoPaths = new Map(documentRepos.map((item) => [item.path, item] as const));
  const hints: string[] = [];
  if (codeRepos.length && !prompt.includes(REPO_INGEST_PROMPT_HINT)) hints.push(codeRepoPromptHint(codeRepos));
  if (documentRepos.length && !prompt.includes(REPO_DOCUMENT_INGEST_GATE_MESSAGE)) hints.push(documentRepoPromptHint(documentRepos));
  return {
    prompt: hints.length ? `${prompt}\n\n${hints.join("\n\n")}` : prompt,
    allowedRepoPaths,
    documentRepoPaths,
  };
}

export async function buildRepoIngestRoutingHint(root: string, paths: readonly string[]): Promise<string | null> {
  const classifications = (await Promise.all([...new Set(paths.map(rawRepoRootPath).filter((item): item is string => Boolean(item)))].map((repoRoot) => classifyRawRepoPath(root, repoRoot))))
    .filter((item): item is RepoShapeClassification => Boolean(item));
  if (!classifications.length) return null;
  const codeRepos = classifications.filter((item) => item.isCodeRepo);
  const documentRepos = classifications.filter((item) => !item.isCodeRepo);
  return [
    codeRepos.length ? codeRepoPromptHint(codeRepos) : "",
    documentRepos.length ? documentRepoPromptHint(documentRepos) : "",
  ].filter(Boolean).join("\n\n") || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function rawRepoRootsFromIngestPlan(plan: unknown): string[] {
  if (!isRecord(plan)) return [];
  const roots = new Set<string>();
  const targetRoot = rawRepoRootPath(plan.target_directory);
  if (targetRoot) roots.add(targetRoot);
  const batches = Array.isArray(plan.batches) ? plan.batches : [];
  for (const batch of batches) {
    if (!isRecord(batch) || !Array.isArray(batch.files)) continue;
    for (const file of batch.files) {
      const root = rawRepoRootPath(file);
      if (root) roots.add(root);
    }
  }
  return [...roots];
}

export function rawRepoRootsFromIngestPlanText(content: string | null | undefined): string[] {
  if (!content) return [];
  try {
    return rawRepoRootsFromIngestPlan(JSON.parse(content));
  } catch {
    return [];
  }
}

export function commandTextReferencesRawRepos(command: string): boolean {
  return /(^|[\s"'`(=])(?:\.\/)?raw\/repos(?:\/|["'`),;|&<>\s]|$)/.test(command.replace(/\\/g, "/"));
}

export function hasReadCodingRepoIngestSkill(paths: Iterable<string> | undefined): boolean {
  if (!paths) return false;
  for (const item of paths) {
    if (normalizedWorkspacePath(item) === CODING_REPO_INGEST_SKILL_PATH) return true;
  }
  return false;
}

export function ingestPlanPathForDraftId(draftId: string): string | null {
  const cleanDraftId = draftId.trim();
  if (!cleanDraftId.startsWith("ingest-")) return null;
  const planId = cleanDraftId.slice("ingest-".length);
  if (!planId || !WORKFLOW_ID_RE.test(planId) || planId === "." || planId === ".." || planId.includes("..")) return null;
  return path.posix.join("ingest-plans", `${planId}.json`);
}

export async function readIngestPlanText(root: string, relativePath: string): Promise<string | null> {
  const normalized = normalizedWorkspacePath(relativePath);
  if (!normalized || !/^ingest-plans\/[^/]+\.json$/.test(normalized)) return null;
  try {
    return await fs.readFile(path.join(root, normalized), "utf-8");
  } catch {
    return null;
  }
}

export async function readIngestPlanTextForDraft(root: string, draftId: string): Promise<string | null> {
  const planPath = ingestPlanPathForDraftId(draftId);
  return planPath ? readIngestPlanText(root, planPath) : null;
}
