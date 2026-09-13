import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { env } from "../env";
import { getSourceFile } from "../files/source-file-store";
import type { BootstrapRawSource, JourneyState, OntologyFileNode, OntologyProject, ReviewFile, ReviewState, TemplateSyncStatus, VerifyCase, VerifyState } from "../../src/contracts/ontology";

export const CONTENT_ROOT = "knowledge";
export const LEGACY_CONTENT_ROOT = "wiki";
const INGEST_DRAFT_BASELINE_FILES = ["index.md", "overview.md", "glossary.md", "log.md"] as const;
const ONTOLOGY_UPDATE_MATERIALS_ROOT = "ontology-update-materials";
const ONTOLOGY_UPDATE_EXCLUDED_KNOWLEDGE_FILES = new Set(["index.md", "overview.md", "log.md"]);
const VERIFY_REVIEW_DWELL_MS = 8000;
const MANAGED_TEMPLATE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const MANAGED_BOOTSTRAP_TEMPLATE_FILE = "BOOTSTRAP.md";
const MANAGED_TEMPLATE_DIRS = [".claude", ".codex", "skills", "tools"] as const;
const TEMPLATE_FILE_PATTERN = /\.(md|ya?ml|json|toml|py)$/i;
const TEMPLATE_FILE_SIZE_LIMIT = 2 * 1024 * 1024;
const TEMPLATE_SYNC_FILE = ".runtime/template-sync.json";
const SCHEMA_SYNC_FILE = ".runtime/schema-sync.json";
const WORKFLOW_LOCK_DIR = ".runtime/workflow-lock";
const WORKFLOW_LOCK_FILE = ".runtime/workflow-lock.json";
const WORKFLOW_LOCK_OWNER_FILE = "owner.json";
const WORKFLOW_LOCK_INCOMPLETE_GRACE_MS = 5000;
const ORPHAN_WORKFLOW_RECLAIM_GRACE_MS = 60_000;
const MANAGED_TEMPLATE_VAR_RE = /\{\{\s*((?:KNOWLEDGE|WIKI)_[A-Z0-9_]+|CONTENT_LANGUAGE)\s*\}\}/g;
const MANAGED_TEMPLATE_SCHEMA_VARS = new Set([
  "KNOWLEDGE_SUBDIRS",
  "KNOWLEDGE_SUBDIRS_TYPES",
  "KNOWLEDGE_SUBDIRS_LIST",
  "KNOWLEDGE_NAMING_CONVENTIONS",
  "KNOWLEDGE_INDEX_SECTIONS",
  "WIKI_SUBDIRS",
  "WIKI_SUBDIRS_TYPES",
  "WIKI_SUBDIRS_LIST",
  "WIKI_NAMING_CONVENTIONS",
  "WIKI_INDEX_SECTIONS",
  "WIKI_PAGE_FORMAT",
]);
const SCHEMA_RECONCILIATION_IGNORED_CONTENT_DIRS = new Set(["glossary", "graph", "index", "log", "overview", "sources", "syntheses"]);
const SCHEMA_RECONCILIATION_RESERVED_DIRS = new Set([
  "archived",
  "diff",
  "graph",
  "ingest-plans",
  "glossary",
  "knowledge",
  "index",
  "log",
  "operations",
  "ontology",
  "overview",
  "pending_review",
  "raw",
  "skills",
  "sources",
  "src",
  "syntheses",
  "tools",
  "wiki",
]);
const MANAGED_TEMPLATE_DIRECTORY_DESCRIPTIONS: Record<string, string> = {
  business_capabilities: "What the system can do: functional areas and capabilities",
  business_flows: "End-to-end workflows, trigger conditions, decision logic, and closure steps",
  business_objects: "Core domain entities, data models, and field-level definitions",
  data_tables: "Data table definitions: fields, types, constraints, and table relationships",
  interfaces: "API endpoints, controllers, tools, and external integrations",
  rules: "Business rules: routing, escalation, SLA, priority, and constraints",
  scenarios: "Execution scenarios: triggers, judgement logic, steps, and closure mechanism",
  templates: "Execution templates such as emails and reusable message patterns",
  terminology: "Term mappings from system vocabulary to business meaning",
  glossary: "Shared glossary and terminology mappings",
};
type JourneyStateWriteListener = (root: string, state: JourneyState) => Promise<void> | void;
const journeyStateWriteListeners = new Set<JourneyStateWriteListener>();
export function registerJourneyStateWriteListener(listener: JourneyStateWriteListener): () => void {
  journeyStateWriteListeners.add(listener);
  return () => journeyStateWriteListeners.delete(listener);
}

interface ManagedTemplateBootstrapResult {
  name: string;
  description: string;
  emoji?: string;
  content_language?: string;
  knowledge_subdirs?: string[];
  wiki_subdirs?: string[];
  naming_conventions?: string[];
}

interface ManagedTemplateContext {
  result: ManagedTemplateBootstrapResult;
  source: string;
}

interface TemplateSyncRecord {
  version: 1;
  templateHash: string;
  status: "ok" | "pending_variables" | "blocked";
  syncedAt: string;
  source?: string;
  managedFiles?: string[];
  unresolvedVars?: string[];
  reason?: string;
  varsPreview?: Record<string, string>;
}

interface SchemaSyncRecord {
  version: 1;
  status: "ok" | "failed";
  syncedAt: string;
  source?: string;
  addedKnowledgeSubdirs: string[];
  renderedFiles?: string[];
  error?: string;
}

interface SchemaReconciliationContext {
  result: ManagedTemplateBootstrapResult;
  source: string;
  comparisonSubdirs: string[];
}

export type WorkflowLockPhase = "ingest" | "verify" | "review";

export interface WorkflowLockRecord {
  version: 1;
  ontologyId: string;
  sessionId: string;
  runId: string;
  workflow: "ingest";
  phase: WorkflowLockPhase;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowLockOwner {
  ontologyId: string;
  sessionId: string;
  runId: string;
  workflow?: "ingest";
  phase?: WorkflowLockPhase;
}

export type WorkflowLockAcquireResult =
  | { acquired: true; lock: WorkflowLockRecord; reclaimed?: boolean }
  | { acquired: false; lock: WorkflowLockRecord | null };

export interface IngestDraftBaselineFile {
  sourcePath: string;
  targetPath: string;
  size: number;
  sha256: string;
  status: "copied" | "exists";
}

export interface IngestDraftBaselineResult {
  draftId: string;
  files: IngestDraftBaselineFile[];
}

export class PendingReviewDraftConflictError extends Error {
  readonly status = 409;
  readonly code = "pending_review_draft_exists";

  constructor(
    readonly requestedDraftId: string,
    readonly existingDraftIds: string[],
  ) {
    super(pendingReviewDraftConflictMessage(requestedDraftId, existingDraftIds));
    this.name = "PendingReviewDraftConflictError";
  }
}

export const initialJourneyState = (): JourneyState => ({
  flow: "maintenance",
  phase: "ready",
  bootstrap: { name: null, description: null, pageTypes: [], sources: [], step: 0, totalSteps: 6, status: "done", awaitingUser: false, rawSources: [] },
  ingest: { files: [], generatedPages: [], totalBatches: 0, completedBatches: 0, progress: 0, batches: [] },
  verify: { status: "generating", questionCount: 0, coverage: 0, autoFixed: 0, needsInput: 0, cases: [], fixes: [] },
  updatedAt: new Date().toISOString(),
});

function normalizeJourneyStateShape(state: JourneyState): JourneyState {
  const legacyBootstrapStatus = state.bootstrap.status as string | undefined;
  const legacyVerify = state.verify as VerifyState & { phase?: VerifyState["status"] };
  const legacyReview = state.review as (ReviewState & { mode?: "build" | "ingest" }) | undefined;
  const phase = legacyBootstrapStatus === "ingesting" && state.phase === "bootstrap"
    ? "ingest"
    : legacyBootstrapStatus === "review_pending"
      ? "review"
      : state.phase;
  const bootstrapStatus: JourneyState["bootstrap"]["status"] =
    legacyBootstrapStatus === "complete" ||
    legacyBootstrapStatus === "ingesting" ||
    legacyBootstrapStatus === "review_pending"
      ? "done"
      : legacyBootstrapStatus === "schema_confirmed"
        ? "schema_confirmation"
        : state.bootstrap.status;
  const flow = state.flow ?? (
    legacyReview?.mode === "ingest" || phase === "ready"
      ? "maintenance"
      : "build"
  );

  return {
    ...state,
    flow,
    phase,
    bootstrap: {
      ...state.bootstrap,
      status: bootstrapStatus,
      awaitingUser: phase === "bootstrap" ? state.bootstrap.awaitingUser : false,
    },
    verify: {
      ...state.verify,
      status: state.verify.status ?? legacyVerify.phase ?? "generating",
    },
    review: state.review
      ? {
          description: state.review.description,
          files: state.review.files,
          status: state.review.status ?? (phase === "ready" ? "approved" : "pending"),
          draftId: state.review.draftId,
        }
      : undefined,
  };
}

function safePathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (/^[A-Za-z0-9._-]+$/.test(trimmed)) return trimmed;
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  return `${label}-${digest}`;
}

export function workspacePath(tenantId: string, userId: string, ontologyId: string): string {
  const root = path.resolve(env.workspaceRoot);
  const workspace = path.resolve(root, "tenants", safePathSegment(tenantId, "tenant"), "users", safePathSegment(userId, "user"), "ontologies", safePathSegment(ontologyId, "ontology"));
  if (!workspace.startsWith(`${root}${path.sep}`)) throw new Error("Path escapes ontology workspace");
  return workspace;
}

export function resolveWorkspaceFile(root: string, requested = "CLAUDE.md"): string {
  if (path.isAbsolute(requested)) throw new Error("Absolute paths are not allowed");
  const normalized = requested.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) throw new Error("Parent paths are not allowed");
  const resolved = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error("Path escapes ontology workspace");
  }
  return resolved;
}

function hasErrorCode(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === code);
}

function workflowLockPaths(root: string): { dir: string; mirror: string; owner: string } {
  const dir = resolveWorkspaceFile(root, WORKFLOW_LOCK_DIR);
  return {
    dir,
    mirror: resolveWorkspaceFile(root, WORKFLOW_LOCK_FILE),
    owner: path.join(dir, WORKFLOW_LOCK_OWNER_FILE),
  };
}

function normalizeWorkflowLock(value: unknown): WorkflowLockRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<WorkflowLockRecord>;
  if (record.version !== 1) return null;
  if (record.workflow !== "ingest") return null;
  if (record.phase !== "ingest" && record.phase !== "verify" && record.phase !== "review") return null;
  if (!record.ontologyId || !record.sessionId || !record.runId || !record.createdAt || !record.updatedAt) return null;
  return {
    version: 1,
    ontologyId: record.ontologyId,
    sessionId: record.sessionId,
    runId: record.runId,
    workflow: "ingest",
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function readWorkflowLockFile(file: string): Promise<WorkflowLockRecord | null> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    return normalizeWorkflowLock(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeWorkflowLockFiles(root: string, lock: WorkflowLockRecord): Promise<void> {
  const paths = workflowLockPaths(root);
  const raw = JSON.stringify(lock, null, 2);
  await fs.mkdir(path.dirname(paths.mirror), { recursive: true });
  await fs.writeFile(paths.owner, raw, "utf-8");
  await fs.writeFile(paths.mirror, raw, "utf-8");
}

function workflowLockFromOwner(owner: WorkflowLockOwner, createdAt = new Date().toISOString()): WorkflowLockRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    ontologyId: owner.ontologyId,
    sessionId: owner.sessionId,
    runId: owner.runId,
    workflow: owner.workflow ?? "ingest",
    phase: owner.phase ?? "ingest",
    createdAt,
    updatedAt: now,
  };
}

function isSameWorkflowOwner(lock: WorkflowLockRecord, owner: WorkflowLockOwner): boolean {
  return lock.ontologyId === owner.ontologyId && lock.sessionId === owner.sessionId;
}

function isWorkflowRuntimePhase(phase: JourneyState["phase"] | undefined): boolean {
  return phase === "ingest" || phase === "verify" || phase === "review";
}

function timestampOlderThan(value: string | undefined, ageMs: number): boolean {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && Date.now() - timestamp > ageMs;
}

async function hasDirectoryEntry(root: string, relativeDir: string, accepts: (entry: import("node:fs").Dirent) => boolean): Promise<boolean> {
  const fullDir = resolveWorkspaceFile(root, relativeDir);
  const entries = await fs.readdir(fullDir, { withFileTypes: true }).catch(() => []);
  return entries.some(accepts);
}

async function workflowRuntimeHasArtifacts(root: string): Promise<boolean> {
  const [hasPlans, hasDrafts, hasVerifyArtifacts] = await Promise.all([
    hasDirectoryEntry(root, "ingest-plans", (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json")),
    hasDirectoryEntry(root, "pending_review/drafts", (entry) => entry.isDirectory()),
    hasDirectoryEntry(root, "verify", (entry) => entry.name !== ".DS_Store"),
  ]);
  return hasPlans || hasDrafts || hasVerifyArtifacts;
}

async function isOrphanWorkflowRuntime(root: string, options: { state?: JourneyState | null; lock?: WorkflowLockRecord | null; requireStale?: boolean } = {}): Promise<boolean> {
  const state = options.state === undefined ? await readStoredJourneyState(root).catch(() => null) : options.state;
  const lock = options.lock === undefined ? await readWorkflowLock(root).catch(() => null) : options.lock;
  if (!lock && !isWorkflowRuntimePhase(state?.phase)) return false;
  if (await workflowRuntimeHasArtifacts(root)) return false;
  if (options.requireStale) {
    const timestamp = lock?.updatedAt ?? state?.updatedAt;
    if (!timestampOlderThan(timestamp, ORPHAN_WORKFLOW_RECLAIM_GRACE_MS)) return false;
  }
  return true;
}

async function workflowLockCanBeReclaimed(root: string, lock?: WorkflowLockRecord | null): Promise<boolean> {
  const state = await readStoredJourneyState(root).catch(() => null);
  if (state?.phase === "ready" && (state.review?.status === "approved" || state.review?.status === "discarded")) return true;
  return isOrphanWorkflowRuntime(root, { state, lock, requireStale: true });
}

export async function readWorkflowLock(root: string): Promise<WorkflowLockRecord | null> {
  const paths = workflowLockPaths(root);
  return await readWorkflowLockFile(paths.owner) ?? await readWorkflowLockFile(paths.mirror);
}

export async function releaseWorkflowLock(root: string, owner?: Partial<Pick<WorkflowLockOwner, "ontologyId" | "sessionId" | "runId">>, options: { force?: boolean } = {}): Promise<boolean> {
  const paths = workflowLockPaths(root);
  if (!options.force && owner) {
    const current = await readWorkflowLock(root);
    if (!current) return false;
    if (owner.ontologyId && current.ontologyId !== owner.ontologyId) return false;
    if (owner.sessionId && current.sessionId !== owner.sessionId) return false;
    if (owner.runId && current.runId !== owner.runId) return false;
  }
  await fs.rm(paths.dir, { recursive: true, force: true });
  await fs.rm(paths.mirror, { force: true });
  return true;
}

export async function acquireWorkflowLock(root: string, owner: WorkflowLockOwner): Promise<WorkflowLockAcquireResult> {
  const paths = workflowLockPaths(root);
  await fs.mkdir(path.dirname(paths.mirror), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(paths.dir);
      const lock = workflowLockFromOwner(owner);
      await writeWorkflowLockFiles(root, lock);
      return { acquired: true, lock, reclaimed: attempt > 0 };
    } catch (err) {
      if (!hasErrorCode(err, "EEXIST")) throw err;
    }

    const current = await readWorkflowLock(root);
    if (current && isSameWorkflowOwner(current, owner)) {
      const lock = {
        ...current,
        runId: owner.runId,
        workflow: owner.workflow ?? current.workflow,
        phase: owner.phase ?? current.phase,
        updatedAt: new Date().toISOString(),
      };
      await writeWorkflowLockFiles(root, lock);
      return { acquired: true, lock };
    }

    if (!current) {
      const stat = await fs.stat(paths.dir).catch(() => null);
      const incompleteIsOld = !stat || Date.now() - stat.mtimeMs > WORKFLOW_LOCK_INCOMPLETE_GRACE_MS;
      if (incompleteIsOld || await workflowLockCanBeReclaimed(root, current)) {
        await releaseWorkflowLock(root, undefined, { force: true });
        continue;
      }
      return { acquired: false, lock: null };
    }

    if (await workflowLockCanBeReclaimed(root, current)) {
      await releaseWorkflowLock(root, undefined, { force: true });
      continue;
    }

    return { acquired: false, lock: current };
  }

  return { acquired: false, lock: await readWorkflowLock(root) };
}

export async function ensureWorkspace(project: OntologyProject, tenantId: string, userId: string): Promise<string> {
  const root = workspacePath(tenantId, userId, project.id);
  await seedInitialWikiRoot(root);
  await fs.mkdir(path.join(root, "raw"), { recursive: true });
  await fs.mkdir(path.join(root, "sources"), { recursive: true });
  await fs.mkdir(path.join(root, ".runtime"), { recursive: true });
  await syncManagedAgentTemplate(root, project);

  await writeIfMissing(path.join(root, "CLAUDE.md"), `# ${project.name} Knowledge Base Agent\n\nThis knowledge base workspace is seeded from the bundled knowledge agent template. Keep answers grounded in workspace files.\n`);
  const state = initialJourneyState();
  if (await fileExists(path.join(root, "BOOTSTRAP.md"))) {
    state.flow = "build";
    state.phase = "bootstrap";
    state.bootstrap.step = 1;
    state.bootstrap.status = "goal_selection";
    state.bootstrap.awaitingUser = true;
  }
  await writeIfMissing(path.join(root, ".runtime", "journey-state.json"), JSON.stringify(state, null, 2));
  return root;
}

/**
 * Read-only managed-template sync state for a workspace. `updateAvailable` is
 * true only when the bundled template version changed since the last sync — the
 * case the UI surfaces as a manual "Sync" button. Cheap enough to poll.
 */
export async function getManagedTemplateSyncStatus(project: OntologyProject, tenantId: string, userId: string): Promise<TemplateSyncStatus> {
  const root = workspacePath(tenantId, userId, project.id);
  let templateHash: string;
  try {
    templateHash = await calculateManagedTemplateHashCached(env.initialWikiSource);
  } catch {
    return { status: "up_to_date", updateAvailable: false };
  }
  const current = await readTemplateSyncRecord(root);
  if (!current) return { status: "uninitialized", updateAvailable: false };
  if (current.templateHash !== templateHash) {
    return { status: "update_available", updateAvailable: true, syncedAt: current.syncedAt };
  }
  if (current.status === "blocked") return { status: "blocked", updateAvailable: false, syncedAt: current.syncedAt, reason: current.reason };
  if (current.status === "pending_variables") return { status: "pending_variables", updateAvailable: false, syncedAt: current.syncedAt };
  return { status: "up_to_date", updateAvailable: false, syncedAt: current.syncedAt };
}

/** Apply a pending managed-template update on explicit user action (the Sync button). */
export async function applyManagedTemplateSync(project: OntologyProject, tenantId: string, userId: string): Promise<TemplateSyncStatus> {
  const root = workspacePath(tenantId, userId, project.id);
  await syncManagedAgentTemplate(root, project, { force: true });
  return getManagedTemplateSyncStatus(project, tenantId, userId);
}

async function contentRootForRead(root: string): Promise<string> {
  if (await fileExists(resolveWorkspaceFile(root, CONTENT_ROOT))) return CONTENT_ROOT;
  if (await fileExists(resolveWorkspaceFile(root, LEGACY_CONTENT_ROOT))) return LEGACY_CONTENT_ROOT;
  return CONTENT_ROOT;
}

async function seedInitialWikiRoot(root: string): Promise<void> {
  const source = env.initialWikiSource;
  try {
    await fs.access(path.join(root, "CLAUDE.md"), constants.F_OK);
    return;
  } catch {
    // Continue and seed from the canonical local Claude agent directory when available.
  }
  try {
    await fs.mkdir(root, { recursive: true });
    await copyInitialWikiTemplate(source, root);
  } catch (err) {
    await fs.mkdir(root, { recursive: true });
    console.warn(`[workspace] Initial knowledge source unavailable (${source}); created empty ontology workspace.`, err instanceof Error ? err.message : err);
  }
}

const workspaceSyncChains = new Map<string, Promise<unknown>>();

/**
 * Serialize workspace-mutating template syncs per root within this process.
 * The same workspace is hit concurrently all the time: opening it fans out
 * parallel tree/files/raw fetches, and `useOntologyRawSources` polls `/raw`
 * every 5s — each call reaches ensureWorkspace -> syncManagedAgentTemplate.
 * Without this gate two syncs run the destructive rm+cp against the same
 * directory at once and the recursive rmdir races the concurrent copy, which
 * surfaced as `ENOTEMPTY: directory not empty, rmdir '.../skills/...'`.
 * Holding the lock across the hash-check early-return also collapses the poll
 * storm: once one sync writes status "ok", queued callers return cheaply.
 */
function withWorkspaceSyncLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = workspaceSyncChains.get(key) ?? Promise.resolve();
  const result = previous.then(() => task());
  const tail = result.then(() => undefined, () => undefined);
  workspaceSyncChains.set(key, tail);
  void tail.then(() => {
    if (workspaceSyncChains.get(key) === tail) workspaceSyncChains.delete(key);
  });
  return result;
}

interface ManagedTemplateSyncOptions {
  /** Apply even a managed-template version change — set only by the manual Sync button. */
  force?: boolean;
}

function syncManagedAgentTemplate(root: string, project: OntologyProject, options: ManagedTemplateSyncOptions = {}): Promise<void> {
  return withWorkspaceSyncLock(root, () => syncManagedAgentTemplateLocked(root, project, options));
}

async function syncManagedAgentTemplateLocked(root: string, project: OntologyProject, options: ManagedTemplateSyncOptions): Promise<void> {
  const source = env.initialWikiSource;
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(root, ".runtime"), { recursive: true });
    const templateHash = await calculateManagedTemplateHashCached(source);
    const current = await readTemplateSyncRecord(root);
    const context = await readManagedTemplateContext(root, project);
    const bootstrapActive = await fileExists(path.join(root, MANAGED_BOOTSTRAP_TEMPLATE_FILE));
    if (current?.templateHash === templateHash && current.status === "ok") return;
    if (current?.templateHash === templateHash && current.status === "pending_variables" && !context) return;
    // A managed-template *version change* on an already-initialized workspace is
    // applied only on explicit user action (the Sync button passes force). First-time
    // provisioning (no record) and variable re-rendering (same hash, newly available
    // context) stay automatic.
    if (current && current.templateHash !== templateHash && !options.force) return;

    const staging = path.join(root, ".runtime", `template-sync-${randomUUID()}`);
    await fs.rm(staging, { recursive: true, force: true });
    try {
      await fs.mkdir(staging, { recursive: true });
      await stageManagedTemplate(source, staging, { includeBootstrap: bootstrapActive });
      if (context) await renderManagedTemplateVariables(staging, context.result);
      const unresolvedVars = await scanUnresolvedManagedTemplateVars(staging);
      if (unresolvedVars.length && !bootstrapActive) {
        await writeTemplateSyncRecord(root, {
          version: 1,
          templateHash,
          status: "blocked",
          syncedAt: new Date().toISOString(),
          source: context?.source,
          unresolvedVars,
          reason: "Template variables could not be resolved safely for this workspace.",
        });
        return;
      }

      const managedFiles = await commitManagedTemplateStage(staging, root, { includeBootstrap: bootstrapActive });
      await writeTemplateSyncRecord(root, {
        version: 1,
        templateHash,
        status: unresolvedVars.length ? "pending_variables" : "ok",
        syncedAt: new Date().toISOString(),
        source: context?.source,
        managedFiles,
        unresolvedVars,
        ...(context ? { varsPreview: managedTemplateVarsPreview(context.result) } : {}),
      });
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[workspace] Managed knowledge template sync unavailable (${source}); continuing with existing workspace files.`, err instanceof Error ? err.message : err);
  }
}

const managedTemplateHashCache = new Map<string, Promise<string>>();

/**
 * The bundled managed template (env.initialWikiSource) is immutable for a
 * process's lifetime, so hash it once. Keeps per-request detection in
 * ensureWorkspace and the /template-sync status poll cheap (just a small JSON read).
 */
function calculateManagedTemplateHashCached(source: string): Promise<string> {
  let pending = managedTemplateHashCache.get(source);
  if (!pending) {
    pending = calculateManagedTemplateHash(source).catch((err: unknown) => {
      managedTemplateHashCache.delete(source);
      throw err;
    });
    managedTemplateHashCache.set(source, pending);
  }
  return pending;
}

async function calculateManagedTemplateHash(source: string): Promise<string> {
  const files = await listManagedTemplateSourceFiles(source);
  const hash = createHash("sha256");
  for (const relative of files) {
    const file = path.join(source, relative);
    hash.update(relative);
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listManagedTemplateSourceFiles(source: string): Promise<string[]> {
  const files: string[] = [];
  async function addFile(relative: string): Promise<void> {
    const file = path.join(source, relative);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > TEMPLATE_FILE_SIZE_LIMIT || !isTemplateFileAllowed(file)) return;
    files.push(relative.replace(/\\/g, "/"));
  }
  async function visitDir(relativeDir: string): Promise<void> {
    const dir = path.join(source, relativeDir);
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".runtime" || entry.name === ".DS_Store") continue;
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await visitDir(relative);
      } else {
        await addFile(relative);
      }
    }
  }
  for (const file of [...MANAGED_TEMPLATE_FILES, MANAGED_BOOTSTRAP_TEMPLATE_FILE]) await addFile(file);
  for (const dirname of MANAGED_TEMPLATE_DIRS) await visitDir(dirname);
  return [...new Set(files)].sort();
}

async function stageManagedTemplate(source: string, staging: string, options: { includeBootstrap: boolean }): Promise<void> {
  for (const file of MANAGED_TEMPLATE_FILES) await copyManagedTemplateFileIfExists(source, staging, file);
  if (options.includeBootstrap) await copyManagedTemplateFileIfExists(source, staging, MANAGED_BOOTSTRAP_TEMPLATE_FILE);
  for (const dirname of MANAGED_TEMPLATE_DIRS) await copyManagedTemplateSubdirIfExists(source, staging, dirname);
}

async function copyManagedTemplateFileIfExists(source: string, root: string, filename: string): Promise<void> {
  const src = path.join(source, filename);
  const stat = await fs.lstat(src).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > TEMPLATE_FILE_SIZE_LIMIT || !isTemplateFileAllowed(src)) return;
  const dest = path.join(root, filename);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function copyManagedTemplateSubdirIfExists(source: string, root: string, dirname: string): Promise<void> {
  const src = path.join(source, dirname);
  const stat = await fs.lstat(src).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return;
  const dest = path.join(root, dirname);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, {
    recursive: true,
    force: true,
    filter: templateFileFilter(src),
  });
}

async function renderManagedTemplateVariables(root: string, result: ManagedTemplateBootstrapResult): Promise<void> {
  const files = await listManagedTemplateFiles(root);
  for (const relative of files) {
    const file = path.join(root, relative);
    let content = await fs.readFile(file, "utf-8").catch(() => "");
    if (!content) continue;
    if (relative === "CLAUDE.md") {
      content = content.replace(/^#\s+.*(?:Ontology|Knowledge Base)? Agent\s*$/m, `# ${result.name} Knowledge Base Agent`);
    }
    await fs.writeFile(file, replaceManagedTemplateVariables(content, result), "utf-8");
  }
}

async function readManagedTemplateContext(root: string, project: OntologyProject): Promise<ManagedTemplateContext | null> {
  const bootstrapResult = await readJsonIfExists(path.join(root, "bootstrap-result.json"));
  if (isManagedTemplateBootstrapResult(bootstrapResult)) return { result: bootstrapResult, source: "bootstrap-result.json" };

  const journeyState = await readJsonIfExists(path.join(root, ".runtime", "journey-state.json"));
  if (journeyState && typeof journeyState === "object" && !Array.isArray(journeyState) && "bootstrap" in journeyState) {
    const bootstrap = (journeyState as { bootstrap?: Record<string, unknown>; phase?: unknown }).bootstrap;
    if (isManagedTemplateBootstrapResult(bootstrap?.result)) return { result: bootstrap.result, source: ".runtime/journey-state.json:bootstrap.result" };
    const derived = await deriveManagedTemplateResult(root, project, journeyState as JourneyState);
    if (derived) return { result: derived, source: ".runtime/journey-state.json:derived" };
  }

  const knowledgeDerived = await deriveManagedTemplateResult(root, project);
  if (knowledgeDerived) return { result: knowledgeDerived, source: "workspace-derived" };
  return null;
}

async function deriveManagedTemplateResult(root: string, project: OntologyProject, state?: JourneyState): Promise<ManagedTemplateBootstrapResult | null> {
  const bootstrap = state?.bootstrap;
  const isCompleted = state?.phase === "ready" || bootstrap?.status === "done" || await fileExists(path.join(root, CONTENT_ROOT, "index.md"));
  if (!isCompleted) return null;
  const knowledgeSubdirs = [
    ...new Set([
      ...(bootstrap?.pageTypes ?? []).map((pageType) => pageType.name),
      ...await listKnowledgeSubdirs(root),
    ].map(normalizeManagedTemplateDirName).filter(Boolean)),
  ];
  if (!knowledgeSubdirs.length) return null;
  return {
    name: (bootstrap?.name || project.name || "Knowledge Base").trim(),
    description: (bootstrap?.description || project.description || "Knowledge base workspace.").trim(),
    emoji: project.emoji,
    content_language: undefined,
    knowledge_subdirs: knowledgeSubdirs,
    naming_conventions: knowledgeSubdirs.map((dir) => `- ${managedTemplateDisplayName(dir).replace(/\b\w/g, (char) => char.toUpperCase())} pages: \`TitleCase.md\` (e.g. \`Example.md\`)`),
  };
}

async function listKnowledgeSubdirs(root: string): Promise<string[]> {
  const knowledgeRoot = path.join(root, CONTENT_ROOT);
  const entries = await fs.readdir(knowledgeRoot, { withFileTypes: true }).catch(() => []);
  const ignored = new Set(["sources", "syntheses", "graph"]);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !ignored.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readJsonIfExists(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

function isManagedTemplateBootstrapResult(value: unknown): value is ManagedTemplateBootstrapResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const hasKnowledgeDirs = Array.isArray(candidate.knowledge_subdirs) || Array.isArray(candidate.wiki_subdirs);
  return typeof candidate.name === "string" && typeof candidate.description === "string" && hasKnowledgeDirs;
}

function replaceManagedTemplateVariables(content: string, result: ManagedTemplateBootstrapResult): string {
  const normalizedSubdirs = managedTemplateSubdirs(result);
  const subdirs = normalizedSubdirs.map((dir) => `${dir}/`).join("\n  ");
  const subdirTypes = normalizedSubdirs.join(" | ");
  const namingConventions = (result.naming_conventions ?? []).join("\n");
  const subdirList = managedTemplateSubdirList(result);
  const indexSections = managedTemplateIndexSections(result);

  return content
    .replace(/\{\{KNOWLEDGE_NAME\}\}/g, result.name)
    .replace(/\{\{KNOWLEDGE_DESCRIPTION\}\}/g, result.description)
    .replace(/\{\{KNOWLEDGE_SUBDIRS\}\}/g, subdirs)
    .replace(/\{\{KNOWLEDGE_SUBDIRS_TYPES\}\}/g, subdirTypes)
    .replace(/\{\{KNOWLEDGE_NAMING_CONVENTIONS\}\}/g, namingConventions)
    .replace(/\{\{KNOWLEDGE_INDEX_SECTIONS\}\}/g, indexSections)
    .replace(/\{\{KNOWLEDGE_SUBDIRS_LIST\}\}/g, subdirList)
    .replace(/\{\{WIKI_NAME\}\}/g, result.name)
    .replace(/\{\{WIKI_DESCRIPTION\}\}/g, result.description)
    .replace(/\{\{WIKI_SUBDIRS\}\}/g, subdirs)
    .replace(/\{\{WIKI_SUBDIRS_TYPES\}\}/g, subdirTypes)
    .replace(/\{\{WIKI_NAMING_CONVENTIONS\}\}/g, namingConventions)
    .replace(/\{\{WIKI_INDEX_SECTIONS\}\}/g, indexSections)
    .replace(/\{\{WIKI_PAGE_FORMAT\}\}/g, managedTemplatePageFormat(result))
    .replace(/\{\{WIKI_SUBDIRS_LIST\}\}/g, subdirList)
    .replace(/\{\{CONTENT_LANGUAGE\}\}/g, result.content_language ?? "the user's primary language");
}

function managedTemplateSubdirs(result: ManagedTemplateBootstrapResult): string[] {
  const raw = result.knowledge_subdirs?.length ? result.knowledge_subdirs : result.wiki_subdirs ?? [];
  return raw.map(normalizeManagedTemplateDirName).filter(Boolean);
}

function normalizeManagedTemplateDirName(raw: string): string {
  return raw.trim().replace(/^knowledge\//, "").replace(/^wiki\//, "").replace(/^[-*]\s*/, "").replace(/\/+$/, "");
}

function managedTemplateDisplayName(dir: string): string {
  return normalizeManagedTemplateDirName(dir).replace(/_/g, " ");
}

function managedTemplateSubdirList(result: ManagedTemplateBootstrapResult): string {
  return managedTemplateSubdirs(result)
    .map((dir) => `- \`${CONTENT_ROOT}/${dir}/\` - ${MANAGED_TEMPLATE_DIRECTORY_DESCRIPTIONS[dir] ?? `${managedTemplateDisplayName(dir)} pages`}`)
    .join("\n");
}

function managedTemplateIndexSections(result: ManagedTemplateBootstrapResult): string {
  return managedTemplateSubdirs(result)
    .map((dir) => {
      const title = managedTemplateDisplayName(dir).replace(/\b\w/g, (char) => char.toUpperCase());
      return `## ${title}\n- Add ${managedTemplateDisplayName(dir)} pages under \`${CONTENT_ROOT}/${dir}/\`.`;
    })
    .join("\n\n");
}

function managedTemplatePageFormat(result: ManagedTemplateBootstrapResult): string {
  const typeValues = ["sources", ...managedTemplateSubdirs(result), "syntheses"].join(" | ");
  return [
    "```yaml",
    "---",
    'title: "Page Title"',
    `type: ${typeValues}`,
    "tags: []",
    "sources: []",
    "last_updated: YYYY-MM-DD",
    "---",
    "```",
    "",
    "Use `[[PageName]]` wikilinks to link to other knowledge pages.",
  ].join("\n");
}

function managedTemplateVarsPreview(result: ManagedTemplateBootstrapResult): Record<string, string> {
  const normalizedSubdirs = managedTemplateSubdirs(result);
  return {
    KNOWLEDGE_NAME: result.name,
    KNOWLEDGE_DESCRIPTION: result.description,
    CONTENT_LANGUAGE: result.content_language ?? "the user's primary language",
    KNOWLEDGE_SUBDIRS_TYPES: normalizedSubdirs.join(" | "),
  };
}

function managedTemplateDirDescription(dir: string): string {
  return MANAGED_TEMPLATE_DIRECTORY_DESCRIPTIONS[dir] ?? `${managedTemplateDisplayName(dir)} pages`;
}

function managedTemplateNamingConventionForDir(dir: string): string {
  const title = managedTemplateDisplayName(dir).replace(/\b\w/g, (char) => char.toUpperCase());
  return `- ${title} pages: \`TitleCase.md\` (e.g. \`Example.md\`)`;
}

function normalizeSchemaReconciliationDirName(raw: string): string | null {
  const dir = normalizeManagedTemplateDirName(raw);
  if (!dir || dir === "." || dir === ".." || dir.startsWith(".") || dir.includes("/") || dir.includes("..")) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(dir)) return null;
  if (SCHEMA_RECONCILIATION_RESERVED_DIRS.has(dir)) return null;
  return dir;
}

function uniqueSchemaSubdirs(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeSchemaReconciliationDirName).filter((dir): dir is string => Boolean(dir)))];
}

function approvedReviewKnowledgeSubdirs(reviews: readonly ReviewState[]): string[] {
  const dirs = new Set<string>();
  for (const review of reviews) {
    for (const file of review.files) {
      const normalized = file.path.replace(/\\/g, "/").replace(/^\/+/, "");
      if (!normalized.startsWith(`${CONTENT_ROOT}/`)) continue;
      const parts = normalized.split("/");
      if (parts.length < 3) continue;
      if (SCHEMA_RECONCILIATION_IGNORED_CONTENT_DIRS.has(parts[1])) continue;
      const dir = normalizeSchemaReconciliationDirName(parts[1]);
      if (dir) dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

function managedTemplateResultFromValue(value: unknown, project: OntologyProject): ManagedTemplateBootstrapResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const rawDirs = Array.isArray(candidate.knowledge_subdirs)
    ? candidate.knowledge_subdirs
    : Array.isArray(candidate.wiki_subdirs)
      ? candidate.wiki_subdirs
      : [];
  const knowledgeSubdirs = uniqueSchemaSubdirs(rawDirs.filter((item): item is string => typeof item === "string"));
  if (!knowledgeSubdirs.length) return null;
  const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : project.name || "Knowledge Base";
  const description = typeof candidate.description === "string" && candidate.description.trim() ? candidate.description.trim() : project.description || "Knowledge base workspace.";
  const emoji = typeof candidate.emoji === "string" && candidate.emoji.trim() ? candidate.emoji.trim() : project.emoji;
  const contentLanguage = typeof candidate.content_language === "string" && candidate.content_language.trim() ? candidate.content_language.trim() : undefined;
  const namingConventions = Array.isArray(candidate.naming_conventions)
    ? candidate.naming_conventions.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
  return {
    name,
    description,
    emoji,
    content_language: contentLanguage,
    knowledge_subdirs: knowledgeSubdirs,
    naming_conventions: namingConventions.length ? namingConventions : knowledgeSubdirs.map(managedTemplateNamingConventionForDir),
  };
}

async function readSchemaReconciliationContext(root: string, project: OntologyProject): Promise<SchemaReconciliationContext> {
  const bootstrapResult = managedTemplateResultFromValue(await readJsonIfExists(path.join(root, "bootstrap-result.json")), project);
  if (bootstrapResult) {
    return { result: bootstrapResult, source: "bootstrap-result.json", comparisonSubdirs: managedTemplateSubdirs(bootstrapResult) };
  }

  const stored = await readStoredJourneyState(root).catch(() => null);
  const journeyResult = managedTemplateResultFromValue(stored?.bootstrap.result, project);
  if (journeyResult) {
    return { result: journeyResult, source: ".runtime/journey-state.json:bootstrap.result", comparisonSubdirs: managedTemplateSubdirs(journeyResult) };
  }

  const pageTypeSubdirs = uniqueSchemaSubdirs(stored?.bootstrap.pageTypes.map((pageType) => pageType.name) ?? []);
  if (pageTypeSubdirs.length) {
    const result: ManagedTemplateBootstrapResult = {
      name: stored?.bootstrap.name || project.name || "Knowledge Base",
      description: stored?.bootstrap.description || project.description || "Knowledge base workspace.",
      emoji: project.emoji,
      knowledge_subdirs: pageTypeSubdirs,
      naming_conventions: pageTypeSubdirs.map(managedTemplateNamingConventionForDir),
    };
    return { result, source: ".runtime/journey-state.json:bootstrap.pageTypes", comparisonSubdirs: pageTypeSubdirs };
  }

  const derived = await deriveManagedTemplateResult(root, project, stored ?? undefined);
  if (derived) return { result: derived, source: "workspace-derived", comparisonSubdirs: [] };

  return {
    result: {
      name: project.name || "Knowledge Base",
      description: project.description || "Knowledge base workspace.",
      emoji: project.emoji,
      knowledge_subdirs: [],
      naming_conventions: [],
    },
    source: "project",
    comparisonSubdirs: [],
  };
}

function mergeManagedTemplateSchema(result: ManagedTemplateBootstrapResult, addedSubdirs: readonly string[]): ManagedTemplateBootstrapResult {
  const knowledgeSubdirs = uniqueSchemaSubdirs([...managedTemplateSubdirs(result), ...addedSubdirs]);
  const existing = result.naming_conventions?.filter((item) => item.trim()) ?? [];
  const namingConventions = existing.length ? [...existing] : knowledgeSubdirs.map(managedTemplateNamingConventionForDir);
  if (existing.length) {
    for (const dir of addedSubdirs) {
      const display = managedTemplateDisplayName(dir).toLowerCase();
      const normalized = dir.toLowerCase();
      const alreadyCovered = namingConventions.some((line) => {
        const lower = line.toLowerCase();
        return lower.includes(normalized) || lower.includes(display);
      });
      if (!alreadyCovered) namingConventions.push(managedTemplateNamingConventionForDir(dir));
    }
  }
  return {
    ...result,
    knowledge_subdirs: knowledgeSubdirs,
    naming_conventions: namingConventions,
  };
}

async function writeTextFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, file);
}

async function writeManagedTemplateBootstrapResult(root: string, result: ManagedTemplateBootstrapResult): Promise<void> {
  const file = path.join(root, "bootstrap-result.json");
  const current = await readJsonIfExists(file);
  const base = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {};
  const next: Record<string, unknown> = {
    ...base,
    ...result,
    knowledge_subdirs: managedTemplateSubdirs(result),
    naming_conventions: result.naming_conventions ?? managedTemplateSubdirs(result).map(managedTemplateNamingConventionForDir),
  };
  if ("wiki_subdirs" in base) next.wiki_subdirs = next.knowledge_subdirs;
  await writeTextFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
}

async function patchJourneySchemaState(root: string, project: OntologyProject, result: ManagedTemplateBootstrapResult): Promise<void> {
  const state = await readStoredJourneyState(root).catch(() => null);
  if (!state) return;
  const subdirs = managedTemplateSubdirs(result);
  const existingPageTypes = new Map(state.bootstrap.pageTypes.map((pageType) => [pageType.name, pageType]));
  const pageTypes = subdirs.map((dir) => {
    const existing = existingPageTypes.get(dir);
    return {
      name: dir,
      description: existing?.description ?? managedTemplateDirDescription(dir),
      confirmed: existing?.confirmed ?? true,
    };
  });
  const bootstrapResult: NonNullable<JourneyState["bootstrap"]["result"]> = {
    name: result.name,
    description: result.description,
    emoji: result.emoji ?? project.emoji,
    content_language: result.content_language,
    knowledge_subdirs: subdirs,
    wiki_subdirs: result.wiki_subdirs,
    naming_conventions: result.naming_conventions ?? subdirs.map(managedTemplateNamingConventionForDir),
  };
  await writeJourneyState(root, {
    ...state,
    bootstrap: {
      ...state.bootstrap,
      name: state.bootstrap.name ?? result.name,
      description: state.bootstrap.description ?? result.description,
      pageTypes,
      result: bootstrapResult,
    },
  });
}

function contentHasManagedSchemaVars(content: string): boolean {
  for (const match of content.matchAll(MANAGED_TEMPLATE_VAR_RE)) {
    if (MANAGED_TEMPLATE_SCHEMA_VARS.has(match[1])) return true;
  }
  return false;
}

async function listManagedTemplateSchemaSourceFiles(source: string): Promise<string[]> {
  const files = await listManagedTemplateSourceFiles(source);
  const selected: string[] = [];
  for (const relative of files) {
    const content = await fs.readFile(path.join(source, relative), "utf-8").catch(() => "");
    if (content && contentHasManagedSchemaVars(content)) selected.push(relative);
  }
  return selected;
}

async function rehydrateManagedSchemaPromptFiles(root: string, result: ManagedTemplateBootstrapResult): Promise<string[]> {
  const source = env.initialWikiSource;
  const files = await listManagedTemplateSchemaSourceFiles(source);
  const rendered: string[] = [];
  for (const relative of files) {
    const sourceFile = path.join(source, relative);
    let content = await fs.readFile(sourceFile, "utf-8").catch(() => "");
    if (!content) continue;
    if (relative === "CLAUDE.md") {
      content = content.replace(/^#\s+.*(?:Ontology|Knowledge Base)? Agent\s*$/m, `# ${result.name} Knowledge Base Agent`);
    }
    const target = resolveWorkspaceFile(root, relative);
    await writeTextFileAtomic(target, replaceManagedTemplateVariables(content, result));
    rendered.push(relative.replace(/\\/g, "/"));
  }
  return rendered.sort();
}

async function writeSchemaSyncRecord(root: string, record: SchemaSyncRecord): Promise<void> {
  await writeTextFileAtomic(resolveWorkspaceFile(root, SCHEMA_SYNC_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

export async function reconcileApprovedReviewSchema(root: string, project: OntologyProject, reviews: readonly ReviewState[]): Promise<{ status: "ok" | "skipped"; addedKnowledgeSubdirs: string[]; renderedFiles?: string[] }> {
  const reviewSubdirs = approvedReviewKnowledgeSubdirs(reviews);
  if (!reviewSubdirs.length) return { status: "skipped", addedKnowledgeSubdirs: [] };

  try {
    return await withWorkspaceSyncLock(root, async () => {
      const context = await readSchemaReconciliationContext(root, project);
      const known = new Set(uniqueSchemaSubdirs(context.comparisonSubdirs));
      const addedKnowledgeSubdirs = reviewSubdirs.filter((dir) => !known.has(dir));
      if (!addedKnowledgeSubdirs.length) return { status: "skipped", addedKnowledgeSubdirs: [] };

      const result = mergeManagedTemplateSchema(context.result, addedKnowledgeSubdirs);
      await writeManagedTemplateBootstrapResult(root, result);
      await patchJourneySchemaState(root, project, result);
      const renderedFiles = await rehydrateManagedSchemaPromptFiles(root, result);
      await writeSchemaSyncRecord(root, {
        version: 1,
        status: "ok",
        syncedAt: new Date().toISOString(),
        source: context.source,
        addedKnowledgeSubdirs,
        renderedFiles,
      });
      return { status: "ok", addedKnowledgeSubdirs, renderedFiles };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeSchemaSyncRecord(root, {
      version: 1,
      status: "failed",
      syncedAt: new Date().toISOString(),
      addedKnowledgeSubdirs: reviewSubdirs,
      error: message,
    }).catch(() => undefined);
    throw error;
  }
}

async function listManagedTemplateFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function addIfFile(relative: string): Promise<void> {
    const file = path.join(root, relative);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > TEMPLATE_FILE_SIZE_LIMIT || !isTemplateFileAllowed(file)) return;
    files.push(relative.replace(/\\/g, "/"));
  }
  async function visit(relativeDir: string): Promise<void> {
    const dir = path.join(root, relativeDir);
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".runtime" || entry.name === ".DS_Store") continue;
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) await visit(relative);
      else await addIfFile(relative);
    }
  }
  for (const file of [...MANAGED_TEMPLATE_FILES, MANAGED_BOOTSTRAP_TEMPLATE_FILE]) await addIfFile(file);
  for (const dirname of MANAGED_TEMPLATE_DIRS) await visit(dirname);
  return [...new Set(files)].sort();
}

async function scanUnresolvedManagedTemplateVars(root: string): Promise<string[]> {
  const unresolved = new Set<string>();
  const files = await listManagedTemplateFiles(root);
  for (const relative of files) {
    const content = await fs.readFile(path.join(root, relative), "utf-8").catch(() => "");
    for (const match of content.matchAll(MANAGED_TEMPLATE_VAR_RE)) {
      unresolved.add(`${relative}:${match[1]}`);
    }
  }
  return [...unresolved].sort();
}

async function commitManagedTemplateStage(staging: string, root: string, options: { includeBootstrap: boolean }): Promise<string[]> {
  // Snapshot the managed file set from staging before renames move entries out of it.
  const staged = await listManagedTemplateFiles(staging);
  const copied: string[] = [];

  // Files: rename into place — a single-file rename is an atomic overwrite on the same filesystem.
  async function commitFileIfExists(relative: string): Promise<void> {
    const src = path.join(staging, relative);
    const stat = await fs.lstat(src).catch(() => null);
    if (!stat || !stat.isFile()) return;
    const dest = path.join(root, relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    copied.push(relative.replace(/\\/g, "/"));
  }

  for (const file of MANAGED_TEMPLATE_FILES) await commitFileIfExists(file);
  if (options.includeBootstrap) await commitFileIfExists(MANAGED_BOOTSTRAP_TEMPLATE_FILE);

  // Directories: atomic swap so the live directory is never observed emptied or half-written.
  for (const dirname of MANAGED_TEMPLATE_DIRS) {
    const src = path.join(staging, dirname);
    const stat = await fs.lstat(src).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    await atomicSwapDir(src, path.join(root, dirname), staging);
  }

  return [...new Set([...copied, ...staged])].sort();
}

/**
 * Replace `dest` with `src` atomically. Both must live on the same filesystem
 * (here everything is under the workspace root). The current `dest` is moved
 * into `trashDir` (the staging dir, which the caller removes afterwards) so the
 * swap-in is a single rename onto a non-existent path — never a recursive
 * delete on the live directory, which is what raced into ENOTEMPTY before.
 * A running agent holding old files open keeps valid handles (the inode moves
 * with the rename), and any cleanup failure lands on the trashed copy, not dest.
 */
async function atomicSwapDir(src: string, dest: string, trashDir: string): Promise<void> {
  const destExists = await fs.lstat(dest).then(() => true, () => false);
  let backup: string | null = null;
  if (destExists) {
    backup = path.join(trashDir, `replaced-${randomUUID()}`);
    await fs.rename(dest, backup);
  }
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (backup) await fs.rename(backup, dest).catch(() => undefined);
    throw err;
  }
}

async function readTemplateSyncRecord(root: string): Promise<TemplateSyncRecord | null> {
  const raw = await readJsonIfExists(path.join(root, TEMPLATE_SYNC_FILE));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Partial<TemplateSyncRecord>;
  if (record.version !== 1 || typeof record.templateHash !== "string" || typeof record.status !== "string") return null;
  return {
    version: 1,
    templateHash: record.templateHash,
    status: record.status === "ok" || record.status === "pending_variables" || record.status === "blocked" ? record.status : "blocked",
    syncedAt: typeof record.syncedAt === "string" ? record.syncedAt : new Date(0).toISOString(),
    source: typeof record.source === "string" ? record.source : undefined,
    managedFiles: Array.isArray(record.managedFiles) ? record.managedFiles.filter((item): item is string => typeof item === "string") : undefined,
    unresolvedVars: Array.isArray(record.unresolvedVars) ? record.unresolvedVars.filter((item): item is string => typeof item === "string") : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    varsPreview: record.varsPreview && typeof record.varsPreview === "object" && !Array.isArray(record.varsPreview) ? record.varsPreview as Record<string, string> : undefined,
  };
}

async function writeTemplateSyncRecord(root: string, record: TemplateSyncRecord): Promise<void> {
  const file = path.join(root, TEMPLATE_SYNC_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(record, null, 2), "utf-8");
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  try {
    await fs.access(file);
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf-8");
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function validateIngestArtifactId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) throw new Error(`${label} may only contain letters, numbers, dots, underscores, and dashes`);
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) throw new Error(`${label} cannot contain parent path segments`);
  return trimmed;
}

function validateIngestDraftId(draftId: string): string {
  return validateIngestArtifactId(draftId, "draft_id");
}

async function listPendingReviewDraftDirectoryIds(root: string): Promise<string[]> {
  const draftsRoot = resolveWorkspaceFile(root, "pending_review/drafts");
  const draftDirs = await fs.readdir(draftsRoot, { withFileTypes: true }).catch(() => []);
  const drafts = await Promise.all(draftDirs.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const dir = path.join(draftsRoot, entry.name);
    const stat = await fs.stat(dir).catch(() => null);
    return { id: entry.name, updatedAt: stat?.mtimeMs ?? 0 };
  }));
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt).map((draft) => draft.id);
}

function expectedIngestPlanPathForDraft(draftId: string): string {
  return draftId.startsWith("ingest-")
    ? `ingest-plans/${draftId.slice("ingest-".length)}.json`
    : "the matching ingest plan";
}

function pendingReviewDraftConflictMessage(requestedDraftId: string, existingDraftIds: readonly string[]): string {
  const existing = existingDraftIds.length ? existingDraftIds.join(", ") : "unknown";
  const activeDraftId = existingDraftIds.find((draftId) => draftId !== requestedDraftId) ?? existingDraftIds[0] ?? "the existing draft";
  const activeDraftPath = `pending_review/drafts/${activeDraftId}`;
  const activePlanPath = expectedIngestPlanPathForDraft(activeDraftId);
  return [
    `Cannot prepare a new ingest draft (${requestedDraftId}) because pending Review draft(s) already exist: ${existing}.`,
    "",
    "Do not create another pending_review/drafts/<draft-id> for a new ingest while an existing ingest/review workflow is unfinished.",
    "",
    `Continue the existing ingest workflow first for ${activeDraftId}:`,
    `- Re-read ${activePlanPath} and continue any remaining ingest work for ${activeDraftPath}/knowledge/.`,
    `- Keep writing only under ${activeDraftPath}/knowledge/ for that existing draft.`,
    `- Run Verify for ${activeDraftPath}/knowledge and write ${activeDraftPath}/meta.json only after Verify passes.`,
    "- Move the existing draft to Review and wait for the user to approve or discard it before starting another ingest.",
    "",
    "If the existing draft is abandoned or corrupt, ask the user to discard or recover pending Review drafts instead of creating a new one.",
  ].join("\n");
}

async function assertNoOtherPendingReviewDraft(root: string, requestedDraftId: string): Promise<void> {
  const existingDraftIds = await listPendingReviewDraftDirectoryIds(root);
  if (!existingDraftIds.length) return;
  if (existingDraftIds.length === 1 && existingDraftIds[0] === requestedDraftId) return;
  throw new PendingReviewDraftConflictError(requestedDraftId, existingDraftIds);
}

async function fileDigest(file: string): Promise<{ size: number; sha256: string }> {
  const data = await fs.readFile(file);
  return {
    size: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

export async function prepareIngestDraftBaseline(root: string, draftId: string): Promise<IngestDraftBaselineResult> {
  const cleanDraftId = validateIngestDraftId(draftId);
  await assertNoOtherPendingReviewDraft(root, cleanDraftId);
  try {
    await assertValidIngestPlanForDraft(root, cleanDraftId);
  } catch (err) {
    await cleanupIngestArtifactsForDraftBestEffort(root, cleanDraftId);
    throw err;
  }
  const sourceRoot = await contentRootForRead(root);
  const files: IngestDraftBaselineFile[] = [];

  for (const filename of INGEST_DRAFT_BASELINE_FILES) {
    const sourcePath = path.posix.join(sourceRoot, filename);
    const targetPath = path.posix.join("pending_review", "drafts", cleanDraftId, CONTENT_ROOT, filename);
    const source = resolveWorkspaceFile(root, sourcePath);
    const target = resolveWorkspaceFile(root, targetPath);
    if (!await fileExists(source)) throw new Error(`Required baseline file is missing: ${sourcePath}`);

    const sourceDigest = await fileDigest(source);
    if (await fileExists(target)) {
      const targetDigest = await fileDigest(target);
      if (targetDigest.sha256 !== sourceDigest.sha256) {
        throw new Error(`Draft baseline file already exists with different content: ${targetPath}`);
      }
      files.push({ sourcePath, targetPath, ...sourceDigest, status: "exists" });
      continue;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, constants.COPYFILE_EXCL);
    const targetDigest = await fileDigest(target);
    if (targetDigest.sha256 !== sourceDigest.sha256) throw new Error(`Copied baseline hash mismatch: ${targetPath}`);
    files.push({ sourcePath, targetPath, ...sourceDigest, status: "copied" });
  }

  return { draftId: cleanDraftId, files };
}

async function copyInitialWikiTemplate(source: string, root: string): Promise<void> {
  if (path.basename(source) === "skills" && await fileExists(path.join(source, "CLAUDE.md"))) {
    for (const file of ["AGENTS.md", "BOOTSTRAP.md", "CLAUDE.md"]) {
      const src = path.join(source, file);
      if (await fileExists(src)) await fs.copyFile(src, path.join(root, file), constants.COPYFILE_EXCL).catch(() => undefined);
    }
    await copyTemplateSubdirIfExists(source, root, ".claude");
    await copyTemplateSubdirIfExists(source, root, ".codex");
    await copyTemplateSubdirIfExists(source, root, "tools");
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await fs.cp(path.join(source, entry.name), path.join(root, "skills", entry.name), {
        recursive: true,
        force: false,
        filter: templateFileFilter(path.join(source, entry.name)),
      });
    }
    return;
  }

  if (await fileExists(path.join(source, "skills"))) {
    for (const file of ["AGENTS.md", "BOOTSTRAP.md", "CLAUDE.md"]) {
      const src = path.join(source, file);
      if (await fileExists(src)) await fs.copyFile(src, path.join(root, file), constants.COPYFILE_EXCL).catch(() => undefined);
    }
    await copyTemplateSubdirIfExists(source, root, ".claude");
    await copyTemplateSubdirIfExists(source, root, ".codex");
    await copyTemplateSubdirIfExists(source, root, "tools");
    await fs.cp(path.join(source, "skills"), path.join(root, "skills"), {
      recursive: true,
      force: false,
      filter: templateFileFilter(path.join(source, "skills")),
    });
    return;
  }

  await fs.cp(source, root, {
    recursive: true,
    force: false,
    filter: templateFileFilter(source),
  });
}

async function copyTemplateSubdirIfExists(source: string, root: string, dirname: string): Promise<void> {
  const src = path.join(source, dirname);
  if (!await fileExists(src)) return;
  await copyTemplateTreeMerge(src, path.join(root, dirname));
}

async function copyTemplateTreeMerge(src: string, dest: string): Promise<void> {
  const stat = await fs.lstat(src);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) await copyTemplateTreeMerge(path.join(src, entry.name), path.join(dest, entry.name));
    return;
  }
  if (!stat.isFile() || stat.size > TEMPLATE_FILE_SIZE_LIMIT) return;
  if (!isTemplateFileAllowed(src)) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest, constants.COPYFILE_EXCL).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return;
    throw error;
  });
}

function templateFileFilter(source: string) {
  return async (src: string): Promise<boolean> => {
    const rel = path.relative(source, src);
    if (rel.split(path.sep).some((part) => part === ".git" || part === "node_modules" || part === ".runtime" || part === ".codex")) return false;
    const stat = await fs.lstat(src);
    if (stat.isSymbolicLink()) return false;
    if (stat.isDirectory()) return true;
    if (!stat.isFile() || stat.size > TEMPLATE_FILE_SIZE_LIMIT) return false;
    return isTemplateFileAllowed(src);
  };
}

function isTemplateFileAllowed(file: string): boolean {
  return path.basename(file) === ".gitkeep" || TEMPLATE_FILE_PATTERN.test(file);
}

const TEXT_LIKE_SOURCE_EXTENSIONS = new Set([".md", ".txt", ".csv", ".json", ".yaml", ".yml"]);

function rawSourceStatus(filePath: string): BootstrapRawSource["status"] {
  return TEXT_LIKE_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? "ready" : "unsupported_for_schema";
}

export async function listRawSources(root: string): Promise<BootstrapRawSource[]> {
  const rawRoot = resolveWorkspaceFile(root, "raw");
  const sources: BootstrapRawSource[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      const rel = path.relative(root, full).replace(/\\/g, "/");
      sources.push({
        path: rel,
        name: entry.name,
        size: stat.size,
        status: rawSourceStatus(rel),
        uploadedAt: stat.mtime.toISOString(),
        ...await sourceMetadataForRawFile(root, rel),
      });
    }
  }
  await visit(rawRoot);
  return sources.sort((a, b) => a.path.localeCompare(b.path));
}

async function sourceMetadataForRawFile(root: string, filePath: string): Promise<Partial<BootstrapRawSource>> {
  const record = await getSourceFile(root, filePath);
  if (!record) return {};
  return {
    originalPath: record.originalPath,
    originalName: record.originalName,
    sourceName: record.sourceName,
    conversionStatus: record.conversionStatus,
    ...(record.conversionError ? { conversionError: record.conversionError } : {}),
  };
}

export async function refreshRawSourcesInJourney(root: string): Promise<JourneyState> {
  const current = await readJourneyState(root);
  const rawSources = await listRawSources(root);
  const activeBootstrap = current.flow === "build" && current.phase === "bootstrap" && current.bootstrap.status !== "done";
  const status = activeBootstrap && (current.bootstrap.status === "materials_collection" || current.bootstrap.status === "goal_selection") && rawSources.length
    ? "materials_ready"
    : current.bootstrap.status;
  const next: JourneyState = {
    ...current,
    phase: activeBootstrap ? "bootstrap" : current.phase,
    bootstrap: {
      ...current.bootstrap,
      rawSources,
      status,
      step: status === "materials_ready" || status === "materials_collection" ? 2 : current.bootstrap.step,
      awaitingUser: activeBootstrap ? true : current.bootstrap.awaitingUser,
    },
  };
  await writeJourneyState(root, next);
  return next;
}

export async function writeBootstrapGoal(root: string, goal: string): Promise<JourneyState> {
  const current = await readJourneyState(root);
  const rawSources = await listRawSources(root);
  const next: JourneyState = {
    ...current,
    flow: "build",
    phase: "bootstrap",
    bootstrap: {
      ...current.bootstrap,
      goal,
      rawSources,
      step: 2,
      totalSteps: Math.max(current.bootstrap.totalSteps || 0, 6),
      status: rawSources.length ? "materials_ready" : "materials_collection",
      awaitingUser: true,
      confirmationPrompt: rawSources.length
        ? "Materials are ready. Ask Claude to inspect raw/ and generate the schema when you are ready."
        : "Upload source materials into raw/ before schema generation.",
    },
  };
  await writeJourneyState(root, next);
  return next;
}

export async function markBootstrapMaterialsSkipped(root: string): Promise<JourneyState> {
  const current = await readJourneyState(root);
  const next: JourneyState = {
    ...current,
    flow: "build",
    phase: "bootstrap",
    bootstrap: {
      ...current.bootstrap,
      skippedMaterials: true,
      status: "materials_ready",
      step: 2,
      awaitingUser: false,
    },
  };
  await writeJourneyState(root, next);
  return next;
}

/**
 * Determine if the current session is a bootstrap-triggered build flow,
 * even after BOOTSTRAP.md has been deleted by the agent mid-run.
 * Checks journey state, so this remains true after BOOTSTRAP.md is deleted mid-run.
 * we're in a build flow.
 */
export async function isBootstrapFlow(root: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(root, ".runtime", "journey-state.json"), "utf-8");
    const state = normalizeJourneyStateShape(JSON.parse(raw) as JourneyState);
    return state.flow === "build" && state.phase !== "ready";
  } catch {
    return false;
  }
}

export async function readReviewState(root: string, options: { includeWithoutMeta?: boolean } = {}): Promise<ReviewState | null> {
  const draft = await readActiveReviewDraft(root, options);
  if (!draft) return null;
  return readReviewStateFromDraft(root, draft);
}

async function readReviewStateFromDraft(root: string, draft: ReviewDraftRecord): Promise<ReviewState | null> {
  const meta = await repairDraftMetaManifest(root, draft);
  const affected = [...new Set([...(meta.affected_files ?? []), ...(meta.new_files ?? []), ...(meta.modified_files ?? [])])];
  if (!affected.length) affected.push(...await listDraftKnowledgeFiles(draft.dir));
  if (!draft.metaRaw && !affected.length) return null;
  const files: ReviewFile[] = [];
  for (const filePath of affected) {
    if (!filePath.startsWith(`${CONTENT_ROOT}/`) && !filePath.startsWith(`${LEGACY_CONTENT_ROOT}/`)) continue;
    const draftPath = path.join(draft.dir, filePath);
    const content = await fs.readFile(draftPath, "utf-8").catch(() => "");
    if (!content) continue;
    const oldContent = await fs.readFile(resolveWorkspaceFile(root, filePath), "utf-8").catch(() => undefined);
    files.push({ path: filePath, status: oldContent === undefined ? "new" : "modified", content, oldContent });
  }
  if (!draft.metaRaw && !files.length) return null;
  return {
    description: meta.description ?? `Pending review: ${draft.id}`,
    files,
    status: "pending",
    draftId: draft.id,
  };
}

async function repairDraftMetaManifest(root: string, draft: ReviewDraftRecord): Promise<DraftMetaObject> {
  if (!draft.metaRaw) return parseDraftMetaObject(draft.metaRaw);
  const record = parseDraftMetaRecord(draft.metaRaw);
  if (!record) return parseDraftMetaObject(draft.metaRaw);

  const draftFiles = (await listDraftKnowledgeFiles(draft.dir))
    .filter((filePath) => filePath.startsWith(`${CONTENT_ROOT}/`) || filePath.startsWith(`${LEGACY_CONTENT_ROOT}/`));
  const newFiles: string[] = [];
  const modifiedFiles: string[] = [];
  for (const filePath of draftFiles) {
    if (await fileExists(resolveWorkspaceFile(root, filePath))) modifiedFiles.push(filePath);
    else newFiles.push(filePath);
  }
  const affectedFiles = [...new Set([...newFiles, ...modifiedFiles])].sort();
  newFiles.sort();
  modifiedFiles.sort();

  const currentAffected = draftMetaStringArray(record.affected_files).sort();
  const currentNew = draftMetaStringArray(record.new_files).sort();
  const currentModified = draftMetaStringArray(record.modified_files).sort();
  if (
    stringArraysEqual(currentAffected, affectedFiles) &&
    stringArraysEqual(currentNew, newFiles) &&
    stringArraysEqual(currentModified, modifiedFiles)
  ) {
    return parseDraftMetaObject(draft.metaRaw);
  }

  const nextRecord = {
    ...record,
    affected_files: affectedFiles,
    new_files: newFiles,
    modified_files: modifiedFiles,
  };
  const nextRaw = `${JSON.stringify(nextRecord, null, 2)}\n`;
  draft.metaRaw = nextRaw;
  draft.updatedAt = Date.now();
  try {
    await fs.writeFile(path.join(draft.dir, "meta.json"), nextRaw, "utf-8");
  } catch (err) {
    console.warn(`[workspace] Failed to repair pending review meta manifest for ${draft.id}.`, err instanceof Error ? err.message : err);
  }
  return parseDraftMetaObject(nextRaw);
}

type DraftMetaObject = {
  id?: string;
  operation?: string;
  description?: string;
  source_file?: string;
  affected_files?: string[];
  new_files?: string[];
  modified_files?: string[];
  log_entry?: string;
  index_additions?: DraftIndexAddition[];
};

interface ReviewDraftRecord {
  id: string;
  dir: string;
  metaRaw: string;
  updatedAt: number;
}

export interface ReviewGateState {
  allowed: boolean;
  reason: "no_draft" | "verify_missing" | "verify_in_progress" | "verify_failed" | "verify_passed" | "manual_review";
  message: string;
  draftId?: string;
  review: ReviewState | null;
  verify: VerifyState | null;
  verifyCommand?: string;
}

export interface PendingReviewDraftSummary {
  draftId: string;
  operation: string;
  description: string;
  updatedAt: string;
  fileCount: number;
  newCount: number;
  modifiedCount: number;
  canApprove: boolean;
  gateReason: ReviewGateState["reason"] | "empty_draft";
  gateMessage: string;
  verifyCommand?: string;
}

export interface PendingReviewDraftDetail extends PendingReviewDraftSummary {
  files: ReviewFile[];
}

export interface OntologyUpdateMaterialsResult {
  status: "created" | "skipped";
  updateId?: string;
  materialRoot?: string;
  diffPath?: string;
  includedFiles: string[];
  excludedFiles: string[];
  reason?: "no_material";
}

export interface SavedKnowledgeSynthesis {
  path: string;
  slug: string;
  title: string;
  indexLine: string;
  status: "created" | "unchanged";
}

export interface ReviewRecoveryArchive {
  recoveryId: string;
  recoveryPath: string;
  manifestPath: string;
  createdAt: string;
  draftIds: string[];
  archivedDrafts: string[];
  archivedIngestPlans: string[];
  archivedVerifyArtifacts: string[];
  archivedRuntimeArtifacts?: string[];
  orphanRuntime?: boolean;
}

export interface ReviewRecoveryResult {
  recovered: PendingReviewDraftSummary[];
  archive: ReviewRecoveryArchive | null;
}

async function listDraftKnowledgeFiles(draftDir: string): Promise<string[]> {
  const roots = [CONTENT_ROOT, LEGACY_CONTENT_ROOT];
  const files: string[] = [];
  async function visit(relativeDir: string): Promise<void> {
    const fullDir = path.join(draftDir, relativeDir);
    const entries = await fs.readdir(fullDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = path.posix.join(relativeDir.replace(/\\/g, "/"), entry.name);
      if (entry.isDirectory()) {
        await visit(rel);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(rel);
      }
    }
  }
  for (const rootName of roots) await visit(rootName);
  return files.sort();
}

async function latestDraftKnowledgeMtime(draftDir: string): Promise<number> {
  const files = await listDraftKnowledgeFiles(draftDir);
  const mtimes = await Promise.all(files.map(async (file) => {
    const stat = await fs.stat(path.join(draftDir, file)).catch(() => null);
    return stat?.mtimeMs ?? 0;
  }));
  return Math.max(0, ...mtimes);
}

async function readStoredJourneyState(root: string): Promise<JourneyState | null> {
  try {
    const raw = await fs.readFile(path.join(root, ".runtime", "journey-state.json"), "utf-8");
    return normalizeJourneyStateShape(JSON.parse(raw) as JourneyState);
  } catch {
    return null;
  }
}

function selectableDrafts(drafts: ReviewDraftRecord[], options: { includeWithoutMeta?: boolean }): ReviewDraftRecord[] {
  return options.includeWithoutMeta ? drafts : drafts.filter((draft) => draft.metaRaw);
}

export async function listReviewReadyDraftIds(root: string): Promise<string[]> {
  const draftsRoot = resolveWorkspaceFile(root, "pending_review/drafts");
  const draftDirs = await fs.readdir(draftsRoot, { withFileTypes: true }).catch(() => []);
  const drafts = await Promise.all(draftDirs.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const metaPath = path.join(draftsRoot, entry.name, "meta.json");
    const stat = await fs.stat(metaPath).catch(() => null);
    return stat?.isFile() ? { id: entry.name, updatedAt: stat.mtimeMs } : null;
  }));
  return drafts
    .filter((draft): draft is { id: string; updatedAt: number } => Boolean(draft))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((draft) => draft.id);
}

export async function isReviewLocked(root: string): Promise<boolean> {
  return (await listReviewReadyDraftIds(root)).length > 0;
}

function synthesisFallbackId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").toLowerCase();
  return `synthesis-${stamp}-${randomUUID().slice(0, 4)}`;
}

function slugifySynthesisSegment(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
}

function extractSynthesisTitle(content: string): string {
  const frontmatterTitle = /^---\s*\n[\s\S]*?\ntitle:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?\n---/m.exec(content)?.[1]?.trim();
  if (frontmatterTitle) return frontmatterTitle;
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  if (heading) return heading.replace(/#+\s*$/, "").trim();
  return "Saved Synthesis";
}

function normalizeSynthesisContent(content: string): string {
  const trimmed = content.replace(/\r\n/g, "\n").trim();
  if (!trimmed) throw new Error("Synthesis content is required.");
  return `${trimmed}\n`;
}

async function mergeSynthesisIndexLine(root: string, contentRoot: string, line: string): Promise<void> {
  const file = resolveWorkspaceFile(root, path.posix.join(contentRoot, "index.md"));
  let current = await fs.readFile(file, "utf-8").catch(() => "");
  if (current.includes(line)) return;

  const sectionPattern = "## Syntheses";
  const sectionPos = current.indexOf(sectionPattern);
  if (sectionPos === -1) {
    current = `${current.trimEnd()}\n\n${sectionPattern}\n${line}\n`;
  } else {
    const afterHeader = sectionPos + sectionPattern.length;
    const nextSection = current.indexOf("\n## ", afterHeader);
    current = nextSection === -1
      ? `${current.trimEnd()}\n${line}\n`
      : `${current.slice(0, nextSection).trimEnd()}\n${line}\n${current.slice(nextSection)}`;
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, current, "utf-8");
}

export async function saveKnowledgeSynthesis(root: string, input: { content: string; slug?: string; indexSummary?: string }): Promise<SavedKnowledgeSynthesis> {
  const reviewReadyDraftIds = await listReviewReadyDraftIds(root);
  if (reviewReadyDraftIds.length) {
    const error = new Error(`Cannot save a synthesis while pending Review drafts exist (${reviewReadyDraftIds.join(", ")}). Approve, discard, or recover the pending Review drafts first.`) as Error & { status?: number };
    error.status = 409;
    throw error;
  }

  const content = normalizeSynthesisContent(input.content);
  const contentRoot = CONTENT_ROOT;
  const title = extractSynthesisTitle(content);
  const slug = slugifySynthesisSegment(input.slug) || slugifySynthesisSegment(title) || synthesisFallbackId();
  const relativePath = path.posix.join(contentRoot, "syntheses", `${slug}.md`);
  const target = resolveWorkspaceFile(root, relativePath);

  const existing = await fs.readFile(target, "utf-8").catch(() => null);
  if (existing !== null && existing !== content) {
    const error = new Error(`Synthesis already exists at ${relativePath}. Choose a different slug before saving.`) as Error & { status?: number };
    error.status = 409;
    throw error;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  let status: SavedKnowledgeSynthesis["status"] = "unchanged";
  if (existing === null) {
    await fs.writeFile(target, content, { encoding: "utf-8", flag: "wx" });
    status = "created";
  }

  const summary = input.indexSummary?.trim() || "saved query synthesis";
  const indexLine = `- [${title}](syntheses/${slug}.md) — ${summary}`;
  await mergeSynthesisIndexLine(root, contentRoot, indexLine);
  await mergeLogEntry(root, path.posix.join(contentRoot, "log.md"), `## [${new Date().toISOString().slice(0, 10)}] query | Saved synthesis\n\n- Saved [${title}](syntheses/${slug}.md).`);

  return { path: relativePath, slug, title, indexLine, status };
}

async function listReviewDrafts(root: string, options: { includeWithoutMeta?: boolean } = {}): Promise<ReviewDraftRecord[]> {
  const draftsRoot = resolveWorkspaceFile(root, "pending_review/drafts");
  const draftDirs = await fs.readdir(draftsRoot, { withFileTypes: true }).catch(() => []);
  const drafts = await Promise.all(draftDirs.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const dir = path.join(draftsRoot, entry.name);
    const metaRaw = await fs.readFile(path.join(dir, "meta.json"), "utf-8").catch(() => "");
    const [stat, metaStat, contentUpdatedAt] = await Promise.all([
      fs.stat(dir).catch(() => null),
      fs.stat(path.join(dir, "meta.json")).catch(() => null),
      latestDraftKnowledgeMtime(dir),
    ]);
    return { id: entry.name, dir, metaRaw, updatedAt: Math.max(stat?.mtimeMs ?? 0, metaStat?.mtimeMs ?? 0, contentUpdatedAt) };
  }));
  return selectableDrafts(drafts, options).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readReviewDraftById(root: string, draftId: string, options: { includeWithoutMeta?: boolean } = {}): Promise<ReviewDraftRecord | null> {
  const normalized = draftId.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) return null;
  const drafts = await listReviewDrafts(root, options);
  return drafts.find((draft) => draft.id === normalized) ?? null;
}

async function readActiveReviewDraft(root: string, options: { includeWithoutMeta?: boolean } = {}): Promise<ReviewDraftRecord | null> {
  const drafts = await listReviewDrafts(root, options);
  if (!drafts.length) return null;

  const stored = await readStoredJourneyState(root);
  const activeId = stored?.review?.draftId;
  if (activeId) {
    const active = drafts.find((draft) => draft.id === activeId);
    if (active) return active;
  }
  if (stored?.phase === "ready" && (stored.review?.status === "approved" || stored.review?.status === "discarded")) {
    return null;
  }

  const verifyGroups = await readVerifyArtifactGroups(root);
  for (const group of verifyGroups) {
    const matched = drafts.find((draft) => verifyArtifactMatchesDraft(group, draft.id));
    if (matched) return matched;
  }

  return drafts[0] ?? null;
}

export async function readActiveReviewDraftContext(root: string): Promise<{ draftId: string; draftPath: string; phase?: JourneyState["phase"] } | null> {
  const draft = await readActiveReviewDraft(root, { includeWithoutMeta: true });
  if (!draft) return null;
  const stored = await readStoredJourneyState(root);
  return {
    draftId: draft.id,
    draftPath: `pending_review/drafts/${draft.id}`,
    phase: stored?.phase,
  };
}

function draftCanBypassVerify(meta: DraftMetaObject): boolean {
  return meta.operation === "knowledge-edit" && !meta.source_file;
}

async function readReviewGateForDraft(root: string, draft: ReviewDraftRecord, review?: ReviewState | null): Promise<ReviewGateState> {
  const meta = parseDraftMetaObject(draft.metaRaw);
  const reviewState = review === undefined ? await readReviewStateFromDraft(root, draft) : review;
  const verifyCommand = `verify ${meta.source_file || "raw/"} pending_review/drafts/${draft.id}/knowledge`;
  const matchingGroup = (await readVerifyArtifactGroups(root)).find((group) => verifyArtifactMatchesDraft(group, draft.id));
  const verify = matchingGroup ? projectVerifyState(matchingGroup) : null;

  if (draftCanBypassVerify(meta)) {
    return {
      allowed: true,
      reason: "manual_review",
      message: `Manual knowledge edit draft ${draft.id} can be reviewed without Verify.`,
      draftId: draft.id,
      review: reviewState,
      verify,
      verifyCommand,
    };
  }

  if (await isActiveReviewPhaseDraft(root, draft.id)) {
    return {
      allowed: true,
      reason: "verify_passed",
      message: `Review is active for draft ${draft.id}.`,
      draftId: draft.id,
      review: reviewState,
      verify,
      verifyCommand,
    };
  }

  if (!verify || !matchingGroup?.results) {
    return {
      allowed: false,
      reason: "verify_missing",
      message: reviewGateMessage(draft.id, meta.source_file, "verify_missing"),
      draftId: draft.id,
      review: reviewState,
      verify,
      verifyCommand,
    };
  }

  if (!verifyStatePassed(verify)) {
    const reason: ReviewGateState["reason"] = verify.status === "done" ? "verify_failed" : "verify_in_progress";
    return {
      allowed: false,
      reason,
      message: reviewGateMessage(draft.id, meta.source_file, reason),
      draftId: draft.id,
      review: reviewState,
      verify,
      verifyCommand,
    };
  }

  const draftKnowledgeUpdatedAt = await latestDraftKnowledgeMtime(draft.dir);
  if (draftKnowledgeUpdatedAt > matchingGroup.updatedAt + 1000) {
    return {
      allowed: false,
      reason: "verify_missing",
      message: `Review is blocked because draft ${draft.id} changed after its latest Verify results. Rerun ${verifyCommand}.`,
      draftId: draft.id,
      review: reviewState,
      verify,
      verifyCommand,
    };
  }

  return {
    allowed: true,
    reason: "verify_passed",
    message: `Verify passed for draft ${draft.id}. Review is available.`,
    draftId: draft.id,
    review: reviewState,
    verify,
    verifyCommand,
  };
}

function summarizeReviewDraft(draft: ReviewDraftRecord, review: ReviewState | null, gate: ReviewGateState): PendingReviewDraftSummary {
  const meta = parseDraftMetaObject(draft.metaRaw);
  const files = review?.files ?? [];
  const fileCount = files.length;
  const empty = fileCount === 0;
  return {
    draftId: draft.id,
    operation: meta.operation || "draft",
    description: meta.description || review?.description || `Pending review: ${draft.id}`,
    updatedAt: new Date(draft.updatedAt || Date.now()).toISOString(),
    fileCount,
    newCount: files.filter((file) => file.status === "new").length,
    modifiedCount: files.filter((file) => file.status === "modified").length,
    canApprove: !empty && gate.allowed,
    gateReason: empty ? "empty_draft" : gate.reason,
    gateMessage: empty ? `Draft ${draft.id} has no markdown changes.` : gate.message,
    verifyCommand: gate.verifyCommand,
  };
}

export async function listPendingReviewDrafts(root: string): Promise<PendingReviewDraftSummary[]> {
  const drafts = await listReviewDrafts(root, { includeWithoutMeta: true });
  const summaries = await Promise.all(drafts.map(async (draft) => {
    const review = await readReviewStateFromDraft(root, draft);
    const gate = await readReviewGateForDraft(root, draft, review);
    return summarizeReviewDraft(draft, review, gate);
  }));
  return summaries;
}

export async function readReviewDraftDetail(root: string, draftId: string): Promise<PendingReviewDraftDetail | null> {
  const draft = await readReviewDraftById(root, draftId, { includeWithoutMeta: true });
  if (!draft) return null;
  const review = await readReviewStateFromDraft(root, draft);
  const gate = await readReviewGateForDraft(root, draft, review);
  return {
    ...summarizeReviewDraft(draft, review, gate),
    files: review?.files ?? [],
  };
}

interface IngestPlanBatch {
  id?: string;
  label?: string;
  description?: string;
  files?: string[];
  status?: string;
}

interface IngestPlan {
  plan_id?: string;
  draft_id?: string;
  draftId?: string;
  target_directory?: string;
  total_files?: number;
  total_batches?: number;
  status?: string;
  batches?: IngestPlanBatch[];
}

const INGEST_PLAN_BATCH_FILE_LIMIT = 8;

export interface IngestPlanValidationResult {
  planId: string;
  draftId: string;
  planPath: string;
  totalFiles: number;
  totalBatches: number;
}

type IngestJourneyFile = NonNullable<JourneyState["ingest"]["files"]>[number];

function safeArtifactSegment(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") return null;
  return trimmed;
}

async function cleanupIngestArtifactsForDraft(root: string, draftId: string): Promise<string[]> {
  const plansRoot = resolveWorkspaceFile(root, "ingest-plans");
  const entries = await fs.readdir(plansRoot, { withFileTypes: true }).catch(() => []);
  const expectedPlanId = draftId.startsWith("ingest-") ? safeArtifactSegment(draftId.slice("ingest-".length)) : null;
  const deletedPlanIds: string[] = [];

  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map(async (entry) => {
      const planFile = path.join(plansRoot, entry.name);
      const basenamePlanId = safeArtifactSegment(path.basename(entry.name, path.extname(entry.name)));
      const raw = await fs.readFile(planFile, "utf-8").catch(() => "");
      let plan: IngestPlan | null;
      try {
        plan = JSON.parse(raw) as IngestPlan;
      } catch {
        plan = null;
      }

      const planDraftId = plan
        ? typeof plan.draft_id === "string"
          ? plan.draft_id
          : typeof plan.draftId === "string"
            ? plan.draftId
            : ""
        : "";
      const matchesDraft = planDraftId === draftId || Boolean(expectedPlanId && basenamePlanId === expectedPlanId);
      if (!matchesDraft) return;

      const planId = safeArtifactSegment(plan?.plan_id) ?? basenamePlanId ?? path.basename(entry.name, path.extname(entry.name));
      await fs.rm(planFile, { force: true }).catch((err) => {
        console.warn(`[workspace] Failed to remove ingest plan for draft ${draftId}:`, err instanceof Error ? err.message : String(err));
      });
      await fs.rm(resolveWorkspaceFile(root, path.posix.join("verify", planId)), { recursive: true, force: true }).catch((err) => {
        console.warn(`[workspace] Failed to remove verify artifacts for plan ${planId}:`, err instanceof Error ? err.message : String(err));
      });
      deletedPlanIds.push(planId);
    }));

  return deletedPlanIds.sort();
}

async function cleanupIngestArtifactsForDraftBestEffort(root: string, draftId: string): Promise<void> {
  await cleanupIngestArtifactsForDraft(root, draftId).catch((err) => {
    console.warn(`[workspace] Failed to clean ingest artifacts for draft ${draftId}:`, err instanceof Error ? err.message : String(err));
  });
}

function recoveryTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

function workspaceRelativePath(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}

async function archiveExistingPath(root: string, recoveryRoot: string, source: string, targetRelativePath: string): Promise<string | null> {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat) return null;
  const target = path.join(recoveryRoot, targetRelativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(source, target);
  return workspaceRelativePath(root, target);
}

async function copyExistingPath(root: string, recoveryRoot: string, source: string, targetRelativePath: string): Promise<string | null> {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat) return null;
  const target = path.join(recoveryRoot, targetRelativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (stat.isDirectory()) await fs.cp(source, target, { recursive: true });
  else await fs.copyFile(source, target);
  return workspaceRelativePath(root, target);
}

async function archiveIngestPlansForDraft(root: string, recoveryRoot: string, draftId: string): Promise<{ planIds: string[]; archived: string[] }> {
  const plansRoot = resolveWorkspaceFile(root, "ingest-plans");
  const entries = await fs.readdir(plansRoot, { withFileTypes: true }).catch(() => []);
  const expectedPlanId = draftId.startsWith("ingest-") ? safeArtifactSegment(draftId.slice("ingest-".length)) : null;
  const planIds = new Set<string>();
  const archived: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const planFile = path.join(plansRoot, entry.name);
    const basenamePlanId = safeArtifactSegment(path.basename(entry.name, path.extname(entry.name)));
    const raw = await fs.readFile(planFile, "utf-8").catch(() => "");
    let plan: IngestPlan | null = null;
    try {
      plan = JSON.parse(raw) as IngestPlan;
    } catch {
      plan = null;
    }

    const planDraftId = plan
      ? typeof plan.draft_id === "string"
        ? plan.draft_id
        : typeof plan.draftId === "string"
          ? plan.draftId
          : ""
      : "";
    const planId = safeArtifactSegment(plan?.plan_id) ?? basenamePlanId;
    const matchesDraft = planDraftId === draftId || Boolean(expectedPlanId && basenamePlanId === expectedPlanId);
    if (!matchesDraft) continue;

    if (planId) planIds.add(planId);
    const target = await archiveExistingPath(root, recoveryRoot, planFile, path.join("ingest-plans", entry.name));
    if (target) archived.push(target);
  }

  return { planIds: [...planIds].sort(), archived: archived.sort() };
}

async function archiveVerifyArtifactsForDraft(root: string, recoveryRoot: string, draftId: string, planIds: readonly string[], verifyGroups: readonly VerifyArtifactGroup[]): Promise<string[]> {
  const verifyRoot = resolveWorkspaceFile(root, "verify");
  const planIdSet = new Set(planIds);
  const candidates = new Set<string>();

  for (const planId of planIds) candidates.add(planId);
  for (const group of verifyGroups) {
    const matches = Boolean(group.planId && planIdSet.has(group.planId)) || verifyArtifactMatchesDraft(group, draftId);
    if (!matches) continue;
    for (const relative of Object.values(group.files)) {
      if (!relative) continue;
      const normalized = relative.replace(/\\/g, "/");
      candidates.add(normalized.includes("/") ? normalized.split("/")[0] : normalized);
    }
  }

  const archived: string[] = [];
  const archivedSources = new Set<string>();
  for (const relative of [...candidates].sort()) {
    const source = path.join(verifyRoot, relative);
    const resolved = path.resolve(source);
    if (archivedSources.has(resolved)) continue;
    archivedSources.add(resolved);
    const target = await archiveExistingPath(root, recoveryRoot, source, path.join("verify", relative));
    if (target) archived.push(target);
  }
  return archived.sort();
}

async function readLatestIngestPlan(root: string): Promise<IngestPlan | null> {
  const plansRoot = resolveWorkspaceFile(root, "ingest-plans");
  const entries = await fs.readdir(plansRoot, { withFileTypes: true }).catch(() => []);
  const plans = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map(async (entry) => {
      const file = path.join(plansRoot, entry.name);
      const raw = await fs.readFile(file, "utf-8").catch(() => "");
      const stat = await fs.stat(file).catch(() => null);
      try {
        return { plan: JSON.parse(raw) as IngestPlan, updatedAt: stat?.mtimeMs ?? 0 };
      } catch {
        return null;
      }
    }));
  return plans.filter((item): item is { plan: IngestPlan; updatedAt: number } => Boolean(item)).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.plan ?? null;
}

async function readLatestIngestPlanFile(root: string): Promise<{ path: string; plan: IngestPlan; updatedAt: number } | null> {
  const plansRoot = resolveWorkspaceFile(root, "ingest-plans");
  const entries = await fs.readdir(plansRoot, { withFileTypes: true }).catch(() => []);
  const plans = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map(async (entry) => {
      const file = path.join(plansRoot, entry.name);
      const raw = await fs.readFile(file, "utf-8").catch(() => "");
      const stat = await fs.stat(file).catch(() => null);
      try {
        return { path: file, plan: JSON.parse(raw) as IngestPlan, updatedAt: stat?.mtimeMs ?? 0 };
      } catch {
        return null;
      }
    }));
  return plans.filter((item): item is { path: string; plan: IngestPlan; updatedAt: number } => Boolean(item)).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

function normalizedPlanSourcePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) return null;
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/").replace(/^\.\//, "")).replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
}

function validateIngestPlanForDraft(planPath: string, plan: IngestPlan, expectedDraftId: string): IngestPlanValidationResult {
  const relativePlanPath = planPath.replace(/\\/g, "/").split("/").slice(-2).join("/");
  const errors: string[] = [];
  const filenamePlanId = path.basename(planPath, path.extname(planPath));

  let planId = "";
  let draftId = "";
  try {
    planId = validateIngestArtifactId(String(plan.plan_id ?? ""), "plan_id");
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  try {
    draftId = validateIngestArtifactId(String(plan.draft_id ?? plan.draftId ?? ""), "draft_id");
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  if (planId && filenamePlanId !== planId) errors.push(`file path must be ingest-plans/${planId}.json to match plan_id`);
  if (planId && draftId && draftId !== `ingest-${planId}`) errors.push("draft_id must equal ingest-<plan_id>");
  if (draftId && draftId !== expectedDraftId) errors.push(`draft_id must match requested draft ${expectedDraftId}`);

  const targetDirectory = normalizedPlanSourcePath(plan.target_directory);
  if (!targetDirectory) errors.push("target_directory must be a workspace-relative path");

  const batches = Array.isArray(plan.batches) ? plan.batches : null;
  if (!batches) errors.push("batches must be an array");
  else if (!batches.length) errors.push("batches must include at least one batch");

  const declaredTotalBatches = plan.total_batches;
  if (!Number.isInteger(declaredTotalBatches) || Number(declaredTotalBatches) < 1) {
    errors.push("total_batches must be a positive integer");
  } else if (batches && declaredTotalBatches !== batches.length) {
    errors.push(`total_batches must equal batches.length (${batches.length})`);
  }

  const seenFiles = new Set<string>();
  let actualFileCount = 0;
  let hasOversizedBatch = false;
  if (batches) {
    batches.forEach((batch, index) => {
      const batchLabel = batch.id || `batch-${index + 1}`;
      if (!Array.isArray(batch.files)) {
        errors.push(`${batchLabel}.files must be an array`);
        return;
      }
      if (!batch.files.length) errors.push(`${batchLabel}.files must include at least one source file`);
      if (batch.files.length > INGEST_PLAN_BATCH_FILE_LIMIT) {
        hasOversizedBatch = true;
        errors.push(`${batchLabel}.files has ${batch.files.length} files; max is ${INGEST_PLAN_BATCH_FILE_LIMIT}`);
      }
      for (const file of batch.files) {
        const normalized = normalizedPlanSourcePath(file);
        if (!normalized) {
          errors.push(`${batchLabel}.files contains an invalid workspace path`);
          continue;
        }
        if (targetDirectory && normalized !== targetDirectory && !normalized.startsWith(`${targetDirectory}/`)) {
          errors.push(`${batchLabel}.files contains ${normalized}, which is outside target_directory ${targetDirectory}`);
        }
        if (seenFiles.has(normalized)) errors.push(`source file appears in multiple batches: ${normalized}`);
        seenFiles.add(normalized);
        actualFileCount += 1;
      }
    });
  }

  const declaredTotalFiles = plan.total_files;
  if (!Number.isInteger(declaredTotalFiles) || Number(declaredTotalFiles) < 1) {
    errors.push("total_files must be a positive integer");
  } else if (declaredTotalFiles !== actualFileCount) {
    errors.push(`total_files must equal the number of batch files (${actualFileCount})`);
  }

  if (errors.length) {
    const guidance = hasOversizedBatch
      ? `Read the owning ingest skill again; for repo-shaped raw sources use skills/coding-repo-ingest/SKILL.md, otherwise use skills/batch-ingest/SKILL.md. Regenerate ${relativePlanPath} with no more than ${INGEST_PLAN_BATCH_FILE_LIMIT} files per batch, then retry knowledge_prepare_ingest_draft. Do not finish the turn until the tool succeeds.`
      : "Regenerate the saved ingest plan and retry knowledge_prepare_ingest_draft.";
    throw new Error(`Invalid ingest plan ${relativePlanPath}: ${errors.join("; ")}. ${guidance}`);
  }

  return {
    planId,
    draftId,
    planPath: relativePlanPath,
    totalFiles: actualFileCount,
    totalBatches: batches?.length ?? 0,
  };
}

export async function assertValidIngestPlanForDraft(root: string, draftId: string): Promise<IngestPlanValidationResult> {
  const cleanDraftId = validateIngestDraftId(draftId);
  if (!cleanDraftId.startsWith("ingest-")) throw new Error("Invalid ingest plan: draft_id must start with ingest-.");

  const planId = validateIngestArtifactId(cleanDraftId.slice("ingest-".length), "plan_id");
  const planPath = resolveWorkspaceFile(root, path.posix.join("ingest-plans", `${planId}.json`));
  let raw: string;
  try {
    raw = await fs.readFile(planPath, "utf-8");
  } catch {
    throw new Error(`Invalid ingest plan: expected ingest-plans/${planId}.json before preparing draft ${cleanDraftId}. Regenerate the saved ingest plan and retry knowledge_prepare_ingest_draft.`);
  }

  let plan: IngestPlan;
  try {
    plan = JSON.parse(raw) as IngestPlan;
  } catch {
    throw new Error(`Invalid ingest plan ingest-plans/${planId}.json: file must be valid JSON. Regenerate the saved ingest plan and retry knowledge_prepare_ingest_draft.`);
  }

  return validateIngestPlanForDraft(planPath, plan, cleanDraftId);
}

export interface MatchingIngestPlanResult {
  planId: string;
  draftId: string;
  planPath: string;
}

export async function assertMatchingIngestPlanForDraft(root: string, draftId: string): Promise<MatchingIngestPlanResult> {
  const cleanDraftId = validateIngestDraftId(draftId);
  if (!cleanDraftId.startsWith("ingest-")) throw new Error("Invalid ingest draft: draft_id must start with ingest-.");

  const planId = validateIngestArtifactId(cleanDraftId.slice("ingest-".length), "plan_id");
  const planRelativePath = path.posix.join("ingest-plans", `${planId}.json`);
  const planPath = resolveWorkspaceFile(root, planRelativePath);
  let raw: string;
  try {
    raw = await fs.readFile(planPath, "utf-8");
  } catch {
    throw new Error(`This ingest draft has no matching ingest plan. Before writing pending_review/drafts/${cleanDraftId}/knowledge/..., create ${planRelativePath} with plan_id=${planId} and draft_id=${cleanDraftId}, then retry.`);
  }

  let plan: IngestPlan;
  try {
    plan = JSON.parse(raw) as IngestPlan;
  } catch {
    throw new Error(`Invalid matching ingest plan: ${planRelativePath} must be valid JSON before writing pending_review/drafts/${cleanDraftId}/knowledge/... or meta.json.`);
  }

  const parsedPlanId = typeof plan.plan_id === "string" ? plan.plan_id.trim() : "";
  const parsedDraftId = typeof plan.draft_id === "string"
    ? plan.draft_id.trim()
    : typeof plan.draftId === "string"
      ? plan.draftId.trim()
      : "";
  if (parsedPlanId !== planId || parsedDraftId !== cleanDraftId) {
    throw new Error(`Invalid matching ingest plan: ${planRelativePath} must contain plan_id=${planId} and draft_id=${cleanDraftId}. Fix the plan and retry.`);
  }

  return { planId, draftId: cleanDraftId, planPath: planRelativePath };
}

export async function assertIngestMetaArtifactsForWrite(root: string, draftId: string): Promise<MatchingIngestPlanResult & { draftFiles: string[] }> {
  const plan = await assertMatchingIngestPlanForDraft(root, draftId);
  const draftDir = resolveWorkspaceFile(root, path.posix.join("pending_review", "drafts", plan.draftId));
  const draftFiles = await listDraftKnowledgeFiles(draftDir);
  if (!draftFiles.length) {
    throw new Error(`Do not write pending_review/drafts/${plan.draftId}/meta.json yet. Draft markdown content must exist under pending_review/drafts/${plan.draftId}/knowledge first.`);
  }

  const hasVerifyResults = (await readVerifyArtifactGroups(root)).some((group) => Boolean(group.results));
  if (!hasVerifyResults) {
    throw new Error(`Do not write pending_review/drafts/${plan.draftId}/meta.json yet. Ensure ${plan.planPath} exists, draft markdown content exists under pending_review/drafts/${plan.draftId}/knowledge, and Verify has produced a results artifact.`);
  }

  return { ...plan, draftFiles };
}

export async function completeLatestIngestPlan(root: string): Promise<void> {
  const latest = await readLatestIngestPlanFile(root);
  if (!latest || latest.plan.status === "completed") return;
  const batchStatuses = latest.plan.batches?.map((batch) => String(batch.status ?? "pending").toLowerCase()) ?? [];
  const hasPendingBatch = batchStatuses.some((status) => !["success", "completed", "done", "failed", "error"].includes(status));
  if (hasPendingBatch) return;
  await fs.writeFile(latest.path, JSON.stringify({ ...latest.plan, status: "completed" }, null, 2), "utf-8");
}

export interface WorkflowContinuation {
  reason: "ingest";
  phase: "execute" | "finalize";
  prompt: string;
  fingerprint: string;
  pendingBatches: number;
  pendingBatchLabels: string[];
}

function isTerminalIngestBatchStatus(status: string): boolean {
  return ["success", "completed", "done", "failed", "error"].includes(status);
}

function pendingIngestBatchLabels(plan: IngestPlan): string[] {
  const total = Number(plan.total_batches) || plan.batches?.length || 0;
  return (plan.batches ?? []).flatMap((batch, index) => {
    const status = String(batch.status ?? "pending").toLowerCase();
    if (isTerminalIngestBatchStatus(status)) return [];
    const id = batch.id || `batch-${index + 1}`;
    const ordinal = total ? `${index + 1}/${total}` : String(index + 1);
    const label = batch.label ? ` - ${batch.label}` : "";
    const fileCount = Array.isArray(batch.files) ? ` (${batch.files.length} files)` : "";
    return [`Batch ${ordinal} (${id})${label}${fileCount}`];
  });
}

async function isCompletedIngestPlanFinalized(root: string, plan: IngestPlan): Promise<boolean> {
  const stored = await readStoredJourneyState(root);
  if (stored?.phase === "ready" && (stored.review?.status === "approved" || stored.review?.status === "discarded")) return true;

  const draft = await readIngestPlanDraft(root, plan);
  if (!draft?.metaRaw) return false;

  const review = await readReviewStateFromDraft(root, draft);
  if (!review?.files.length) return false;

  const meta = parseDraftMetaObject(draft.metaRaw);
  const gate = await readReviewGateForDraft(root, draft, review);
  const verify = gate.verify ?? await readVerifyStateForDraft(root, draft.id);
  return gate.allowed && (draftCanBypassVerify(meta) || verifyStatePassed(verify));
}

export async function readWorkflowContinuation(root: string): Promise<WorkflowContinuation | null> {
  if (await isReviewLocked(root)) return null;
  const plan = await readLatestIngestPlan(root);
  if (!plan?.batches?.length) return null;
  const statuses = plan.batches.map((batch) => String(batch.status ?? "pending").toLowerCase());
  const pendingBatchLabels = pendingIngestBatchLabels(plan);
  const pendingBatches = pendingBatchLabels.length;
  if (plan.status === "completed" && await isCompletedIngestPlanFinalized(root, plan)) return null;
  const planPath = plan.plan_id ? `ingest-plans/${plan.plan_id}.json` : "the latest ingest plan under ingest-plans/";
  if (!pendingBatches) {
    return {
      reason: "ingest",
      phase: "finalize",
      pendingBatches,
      pendingBatchLabels,
      fingerprint: `${plan.plan_id ?? "batch-ingest"}:${statuses.join(",")}:finalize:${plan.status ?? "in_progress"}`,
      prompt: [
        "Continue the current ingest workflow after all planned batches have been processed.",
        `Use ${planPath}.`,
        "The saved plan has no pending batches. Finalize the ingest workflow, complete the plan status, and proceed through the owning ingest skill's Verify Gate.",
        "Follow the owning ingest skill's finalization and Verify Gate.",
        "Do not report ingest as complete until the saved plan status and required review/verify artifacts are durable on disk.",
        "Do not wait for another user confirmation.",
      ].join("\n"),
    };
  }
  return {
    reason: "ingest",
    phase: "execute",
    pendingBatches,
    pendingBatchLabels,
    fingerprint: `${plan.plan_id ?? "batch-ingest"}:${statuses.join(",")}:execute`,
    prompt: [
      "Continue the current ingest workflow according to the active ingest plan.",
      `Use ${planPath}.`,
      `The saved plan still has pending batches: ${pendingBatchLabels.join("; ")}.`,
      "The saved plan is the source of truth. Continue from the first pending batch in the plan, not from prior chat text.",
      "Before reporting any batch as complete, re-read the saved plan file and confirm that the batch status is no longer pending.",
      "Do not say ingest is finished while any batch remains pending in the saved plan.",
      "Follow CLAUDE.md routing and the owning ingest skill.",
      "Do not wait for another user confirmation.",
    ].join("\n"),
  };
}

function toIngestBatchStatus(value: string | undefined): JourneyState["ingest"]["batches"][number]["status"] {
  switch (value?.toLowerCase()) {
    case "success":
    case "completed":
    case "done":
      return "success";
    case "failed":
    case "error":
      return "failed";
    case "processing":
    case "running":
    case "in_progress":
      return "processing";
    default:
      return "pending";
  }
}

function isIngestPlanCompleted(plan: IngestPlan | null): boolean {
  return String(plan?.status ?? "").toLowerCase() === "completed";
}

function hasPendingIngestBatch(plan: IngestPlan | null): boolean {
  if (!plan || isIngestPlanCompleted(plan)) return false;
  const statuses = plan.batches?.map((batch) => String(batch.status ?? "pending").toLowerCase()) ?? [];
  return !statuses.length || statuses.some((status) => !isTerminalIngestBatchStatus(status));
}

function normalizedWorkspacePath(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized || null;
}

function rawSourcesForSourcePath(rawSources: BootstrapRawSource[], sourcePath: string | undefined): BootstrapRawSource[] {
  const target = normalizedWorkspacePath(sourcePath);
  if (!target) return [];
  return rawSources.filter((source) => {
    const sourceFile = normalizedWorkspacePath(source.path);
    return Boolean(sourceFile && (sourceFile === target || sourceFile.startsWith(`${target}/`)));
  });
}

function ingestFileStatusFromBatchStatus(status: string | undefined): IngestJourneyFile["status"] {
  switch (toIngestBatchStatus(status)) {
    case "success":
      return "done";
    case "failed":
      return "error";
    case "processing":
      return "processing";
    default:
      return "pending";
  }
}

function ingestFilesFromPlan(plan: IngestPlan, rawSources: BootstrapRawSource[]): JourneyState["ingest"]["files"] {
  const filesByPath = new Map<string, IngestJourneyFile["status"]>();
  for (const batch of plan.batches ?? []) {
    const status = ingestFileStatusFromBatchStatus(batch.status);
    for (const file of batch.files ?? []) {
      const normalized = normalizedWorkspacePath(file);
      if (normalized) filesByPath.set(normalized, status);
    }
  }
  if (filesByPath.size) {
    return [...filesByPath.entries()].map(([path, status]) => ({ path, status }));
  }

  const fallbackStatus: IngestJourneyFile["status"] =
    plan.status === "completed" ? "done" : plan.status === "failed" ? "error" : "processing";
  return rawSourcesForSourcePath(rawSources, plan.target_directory).map((source) => ({ path: source.path, status: fallbackStatus }));
}

function ingestStateFromPlan(state: JourneyState, plan: IngestPlan, rawSources: BootstrapRawSource[]): JourneyState["ingest"] {
  const batches = (plan.batches ?? []).map((batch, index) => {
    const files = Array.isArray(batch.files) ? batch.files.filter((file): file is string => typeof file === "string") : [];
    return {
      id: batch.id || `batch-${index + 1}`,
      label: batch.label || `Batch ${index + 1}`,
      description: batch.description || files.slice(0, 2).join(", ") || plan.target_directory || "",
      fileCount: files.length,
      status: toIngestBatchStatus(batch.status),
      files,
    };
  });
  const planTotalBatches = Math.max(Number(plan.total_batches) || 0, batches.length);
  const samePlan = Boolean(plan.plan_id && state.ingest.planId === plan.plan_id);
  const totalBatches = planTotalBatches || (samePlan ? state.ingest.totalBatches : 0);
  const completedBatches = batches.filter((batch) => batch.status === "success").length;
  const failedBatches = batches.filter((batch) => batch.status === "failed").length;
  const progress = totalBatches ? Math.round(((completedBatches + failedBatches) / totalBatches) * 100) : state.ingest.progress;
  const files = ingestFilesFromPlan(plan, rawSources);
  return {
    ...state.ingest,
    planId: plan.plan_id,
    targetDirectory: normalizedWorkspacePath(plan.target_directory) ?? undefined,
    status: plan.status === "completed" ? "completed" : plan.status === "failed" ? "failed" : "in_progress",
    files,
    totalBatches,
    completedBatches,
    progress,
    batches: batches.length ? batches : state.ingest.batches,
  };
}

type VerifyArtifactKind = "dataset" | "questions" | "initialAnswers" | "failedQuestions" | "failedAnswers" | "results";

interface VerifyArtifactGroup {
  base: string;
  planId?: string;
  draftId?: string;
  updatedAt: number;
  files: Partial<Record<VerifyArtifactKind, string>>;
  dataset?: unknown;
  questions?: unknown;
  initialAnswers?: unknown;
  failedQuestions?: unknown;
  failedAnswers?: unknown;
  results?: unknown;
}

const VERIFY_ARTIFACT_RE = /^verify-(.+)-(\d{4}-\d{2}-\d{2})(?:-(questions|knowledge-answers|failed-questions|failed-knowledge-answers|results))?\.json$/;
const VERIFY_RUN_FILES: Record<string, VerifyArtifactKind> = {
  "dataset.json": "dataset",
  "questions.json": "questions",
  "knowledge-answers.json": "initialAnswers",
  "failed-questions.json": "failedQuestions",
  "failed-knowledge-answers.json": "failedAnswers",
  "results.json": "results",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function verifyArtifactKind(suffix: string | undefined): VerifyArtifactKind {
  switch (suffix) {
    case "questions": return "questions";
    case "knowledge-answers": return "initialAnswers";
    case "failed-questions": return "failedQuestions";
    case "failed-knowledge-answers": return "failedAnswers";
    case "results": return "results";
    default: return "dataset";
  }
}

async function readVerifyArtifactGroups(root: string): Promise<VerifyArtifactGroup[]> {
  const verifyRoot = resolveWorkspaceFile(root, "verify");
  const entries = await fs.readdir(verifyRoot, { withFileTypes: true }).catch(() => []);
  const groups = new Map<string, VerifyArtifactGroup>();
  const addArtifact = async (base: string, kind: VerifyArtifactKind, file: string, relativePath: string, planId?: string) => {
    const [raw, stat] = await Promise.all([
      fs.readFile(file, "utf-8").catch(() => ""),
      fs.stat(file).catch(() => null),
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const record = asRecord(parsed);
    const artifactPlanId = stringValue(record?.plan_id);
    const artifactDraftId = stringValue(record?.draft_id);
    const group = groups.get(base) ?? { base, planId, updatedAt: 0, files: {} };
    if (planId && artifactPlanId && artifactPlanId !== planId) return;
    if (group.draftId && artifactDraftId && group.draftId !== artifactDraftId) return;
    group.planId = artifactPlanId ?? group.planId ?? planId;
    group.draftId = artifactDraftId ?? group.draftId;
    group.updatedAt = Math.max(group.updatedAt, stat?.mtimeMs ?? 0);
    group.files[kind] = relativePath;
    switch (kind) {
      case "dataset": group.dataset = parsed; break;
      case "questions": group.questions = parsed; break;
      case "initialAnswers": group.initialAnswers = parsed; break;
      case "failedQuestions": group.failedQuestions = parsed; break;
      case "failedAnswers": group.failedAnswers = parsed; break;
      case "results": group.results = parsed; break;
    }
    groups.set(base, group);
  };
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const runEntries = await fs.readdir(path.join(verifyRoot, entry.name), { withFileTypes: true }).catch(() => []);
      for (const runEntry of runEntries) {
        const kind = runEntry.isFile() ? VERIFY_RUN_FILES[runEntry.name.toLowerCase()] : undefined;
        if (!kind) continue;
        await addArtifact(entry.name, kind, path.join(verifyRoot, entry.name, runEntry.name), path.posix.join(entry.name, runEntry.name), entry.name);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const match = VERIFY_ARTIFACT_RE.exec(entry.name);
    if (!match) continue;
    const [, slug, date, suffix] = match;
    const base = `verify-${slug}-${date}`;
    const kind = verifyArtifactKind(suffix);
    await addArtifact(base, kind, path.join(verifyRoot, entry.name), entry.name);
  }
  return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function recordArray(value: unknown, key: string): Record<string, unknown>[] {
  const source = Array.isArray(value) ? value : asRecord(value)?.[key];
  if (!Array.isArray(source)) return [];
  return source.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
}

function verifyQuestions(value: unknown): Record<string, unknown>[] {
  return recordArray(value, "questions");
}

function verifyAnswerItems(value: unknown): Record<string, unknown>[] {
  const results = recordArray(value, "results");
  if (results.length) return results;
  return recordArray(value, "answers");
}

function verifyItemKey(item: Record<string, unknown>, fallback: number): string {
  const id = item.id;
  if (typeof id === "string" && id.trim()) return id.trim();
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return stringValue(item.question) ?? `question-${fallback + 1}`;
}

function verifyQuestionText(item: Record<string, unknown>, fallback: string): string {
  return meaningfulVerifyQuestionText(item) ?? fallback;
}

function meaningfulVerifyQuestionText(item: Record<string, unknown>): string | undefined {
  const text = stringValue(item.question) ?? stringValue(item.name);
  if (!text) return undefined;
  const id = item.id;
  const idText = typeof id === "string" && id.trim() ? id.trim() : typeof id === "number" && Number.isFinite(id) ? String(id) : undefined;
  if (idText && text === idText) return undefined;
  if (/^(?:question\s*)?\d+$/i.test(text)) return undefined;
  return text;
}

function isPlaceholderVerifyQuestionText(text: string | undefined, id: string): boolean {
  const normalized = text?.trim();
  if (!normalized) return true;
  if (normalized === id) return true;
  return /^question\s*\d+$/i.test(normalized);
}

function verifyAnswerText(item: Record<string, unknown>): string | undefined {
  return stringValue(item.knowledge_answer) ?? stringValue(item.answer) ?? stringValue(item.knowledgeAnswer);
}

function verifyResultStatus(value: unknown): "pass" | "fail" | null {
  const normalized = stringValue(value)?.toLowerCase();
  if (!normalized) return null;
  if (normalized === "pass" || normalized === "passed" || normalized === "success") return "pass";
  if (normalized === "fail" || normalized === "failed" || normalized === "error") return "fail";
  return null;
}

function readAnsweredCount(value: unknown, fallbackItems: Record<string, unknown>[]): number {
  return numberValue(asRecord(value)?.answered) ?? fallbackItems.filter((item) => Boolean(verifyAnswerText(item))).length;
}

function mergeVerifyCase(target: VerifyCase, patch: Partial<VerifyCase>): VerifyCase {
  for (const [key, value] of Object.entries(patch) as [keyof VerifyCase, VerifyCase[keyof VerifyCase]][]) {
    if (value !== undefined && value !== "") target[key] = value as never;
  }
  return target;
}

function projectVerifyState(group: VerifyArtifactGroup): VerifyState | null {
  const datasetQuestions = verifyQuestions(group.dataset);
  const initialAnswers = verifyAnswerItems(group.initialAnswers);
  const failedQuestions = verifyQuestions(group.failedQuestions);
  const failedAnswers = verifyAnswerItems(group.failedAnswers);
  const finalResults = verifyAnswerItems(group.results);
  if (!datasetQuestions.length && !initialAnswers.length && !failedQuestions.length && !failedAnswers.length && !finalResults.length) return null;

  const failedIds = new Set(failedQuestions.map((item, index) => verifyItemKey(item, index)));
  const cases = new Map<string, VerifyCase>();

  const ensureCase = (item: Record<string, unknown>, index: number): VerifyCase => {
    const id = verifyItemKey(item, index);
    const fallback = `Question ${index + 1}`;
    const question = verifyQuestionText(item, fallback);
    const existing = cases.get(id);
    if (existing) {
      const updatedQuestion = meaningfulVerifyQuestionText(item);
      const hasExplicitQuestion = Boolean(stringValue(item.question));
      if (updatedQuestion && (hasExplicitQuestion || isPlaceholderVerifyQuestionText(existing.question ?? existing.name, id))) {
        existing.name = updatedQuestion;
        existing.question = updatedQuestion;
      }
      return existing;
    }
    const created: VerifyCase = {
      id,
      name: question,
      question,
      status: "running",
    };
    cases.set(id, created);
    return created;
  };

  datasetQuestions.forEach((item, index) => {
    mergeVerifyCase(ensureCase(item, index), {
      level: stringValue(item.level),
      expectedAnswer: stringValue(item.expected_answer) ?? stringValue(item.expectedAnswer),
      sourceFile: stringValue(item.source_file) ?? stringValue(item.sourceFile),
    });
  });

  initialAnswers.forEach((item, index) => {
    mergeVerifyCase(ensureCase(item, index), {
      initialAnswer: verifyAnswerText(item),
      knowledgeReference: item.knowledge_reference ?? item.sources,
    });
  });

  failedQuestions.forEach((item, index) => {
    mergeVerifyCase(ensureCase(item, index), {
      status: group.failedAnswers ? "retesting" : "fixing",
      level: stringValue(item.level),
    });
  });

  failedAnswers.forEach((item, index) => {
    mergeVerifyCase(ensureCase(item, index), {
      status: "retesting",
      knowledgeAnswer: verifyAnswerText(item),
      knowledgeReference: item.knowledge_reference ?? item.sources,
    });
  });

  finalResults.forEach((item, index) => {
    const target = ensureCase(item, index);
    const result = verifyResultStatus(item.result ?? item.status ?? item.verdict);
    const repaired = failedIds.has(target.id ?? "");
    mergeVerifyCase(target, {
      expectedAnswer: stringValue(item.expected_answer) ?? stringValue(item.expectedAnswer) ?? target.expectedAnswer,
      knowledgeAnswer: verifyAnswerText(item) ?? target.knowledgeAnswer ?? target.initialAnswer,
      knowledgeReference: item.knowledge_reference ?? item.sources ?? target.knowledgeReference,
      note: stringValue(item.note),
      status: result === "pass" && repaired ? "fixed" : result ?? target.status,
      repaired,
    });
  });

  if (failedIds.size && !finalResults.length) {
    for (const item of cases.values()) {
      if (failedIds.has(item.id ?? "")) continue;
      if (item.initialAnswer) item.status = "pass";
    }
  }

  const caseList = [...cases.values()];
  const questionCount = caseList.length;
  const answeredCount = readAnsweredCount(group.initialAnswers, initialAnswers);
  const hasResults = Boolean(group.results && finalResults.length);
  const passCount = hasResults
    ? caseList.filter((item) => item.status === "pass" || item.status === "fixed").length
    : failedIds.size
      ? Math.max(questionCount - failedIds.size, 0)
      : 0;
  const failCount = hasResults
    ? caseList.filter((item) => item.status === "fail").length
    : failedIds.size;
  const fixedCount = caseList.filter((item) => item.status === "fixed" || item.repaired).length;
  const status: VerifyState["status"] = hasResults
    ? "done"
    : failedIds.size || group.failedAnswers
      ? "fixing"
      : group.dataset || group.initialAnswers
        ? "testing"
        : "generating";
  const coverage = questionCount
    ? hasResults || failedIds.size
      ? Math.round((passCount / questionCount) * 100)
      : Math.round((Math.min(answeredCount, questionCount) / questionCount) * 100)
    : 0;

  return {
    status,
    questionCount,
    coverage,
    autoFixed: fixedCount,
    needsInput: failCount,
    cases: caseList,
    fixes: caseList.map((item) => item.note).filter((note): note is string => Boolean(note)),
    passCount,
    failCount,
    fixedCount,
    answeredCount,
    planId: group.planId,
    draftId: group.draftId ?? verifyArtifactDraftIds(group)[0],
    artifactBase: group.base,
    artifactUpdatedAt: group.updatedAt ? new Date(group.updatedAt).toISOString() : undefined,
  };
}

async function readVerifyStateFromArtifacts(root: string): Promise<VerifyState | null> {
  const latest = (await readVerifyArtifactGroups(root))[0];
  return latest ? projectVerifyState(latest) : null;
}

function normalizeWorkspacePath(value: string | undefined): string {
  return (value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function verifyArtifactKnowledgePaths(group: VerifyArtifactGroup): string[] {
  return [group.dataset, group.questions, group.initialAnswers, group.failedQuestions, group.failedAnswers, group.results]
    .map((artifact) => normalizeWorkspacePath(stringValue(asRecord(artifact)?.knowledge_path)))
    .filter(Boolean);
}

function verifyArtifactDraftIds(group: VerifyArtifactGroup): string[] {
  const explicit = [group.draftId, group.dataset, group.questions, group.initialAnswers, group.failedQuestions, group.failedAnswers, group.results]
    .map((artifact) => typeof artifact === "string" ? artifact : stringValue(asRecord(artifact)?.draft_id))
    .filter((value): value is string => Boolean(value));
  const fromPaths = verifyArtifactKnowledgePaths(group).flatMap((candidate) => {
    const match = candidate.match(/(?:^|\/)pending_review\/drafts\/([^/]+)\/knowledge$/);
    return match?.[1] ? [match[1]] : [];
  });
  return [...new Set([...explicit, ...fromPaths])];
}

function verifyArtifactMatchesDraft(group: VerifyArtifactGroup, draftId: string): boolean {
  if (verifyArtifactDraftIds(group).includes(draftId)) return true;
  const expected = `pending_review/drafts/${draftId}/knowledge`;
  return verifyArtifactKnowledgePaths(group).some((candidate) => candidate === expected || candidate.endsWith(`/${expected}`));
}

async function readVerifyStateForDraft(root: string, draftId: string): Promise<VerifyState | null> {
  const group = (await readVerifyArtifactGroups(root)).find((candidate) => verifyArtifactMatchesDraft(candidate, draftId));
  return group ? projectVerifyState(group) : null;
}

async function readIngestPlanDraft(root: string, plan: IngestPlan | null): Promise<ReviewDraftRecord | null> {
  if (!plan) return null;
  const candidates = [plan.draft_id, plan.plan_id ? `ingest-${plan.plan_id}` : undefined]
    .filter((value): value is string => Boolean(value));
  for (const draftId of candidates) {
    const draft = await readReviewDraftById(root, draftId, { includeWithoutMeta: true });
    if (draft) return draft;
  }
  return null;
}

function verifyStatePassed(verify: VerifyState | null): boolean {
  if (!verify || verify.status !== "done") return false;
  if (verify.questionCount <= 0) return false;
  if (verify.coverage < 100) return false;
  if ((verify.failCount ?? 0) > 0 || verify.needsInput > 0) return false;
  return (verify.passCount ?? 0) >= verify.questionCount;
}

function reviewGateMessage(draftId: string, sourcePath: string | undefined, reason: ReviewGateState["reason"]): string {
  const command = `verify ${sourcePath || "raw/"} pending_review/drafts/${draftId}/knowledge`;
  if (reason === "verify_failed") {
    return `Review is blocked because Verify has not passed for draft ${draftId}. Fix the draft and rerun ${command}.`;
  }
  if (reason === "verify_in_progress") {
    return `Review is blocked until Verify finishes for draft ${draftId}. Continue ${command}.`;
  }
  return `Review is blocked until Verify passes for draft ${draftId}. Run ${command}.`;
}

async function isActiveReviewPhaseDraft(root: string, draftId: string): Promise<boolean> {
  const stored = await readStoredJourneyState(root);
  return stored?.phase === "review" && stored.review?.draftId === draftId;
}

export async function readReviewGate(root: string): Promise<ReviewGateState> {
  const draft = await readActiveReviewDraft(root, { includeWithoutMeta: true });
  if (!draft) {
    return { allowed: false, reason: "no_draft", message: "No pending review draft found.", review: null, verify: null };
  }

  const review = await readReviewState(root, { includeWithoutMeta: true });
  return readReviewGateForDraft(root, draft, review);
}

function journeyWithoutUpdatedAt(state: JourneyState): string {
  const rest: Partial<JourneyState> = { ...state };
  delete rest.updatedAt;
  return JSON.stringify(rest);
}

async function writeJourneyStateIfChanged(root: string, current: JourneyState, next: JourneyState): Promise<JourneyState> {
  if (journeyWithoutUpdatedAt(current) === journeyWithoutUpdatedAt(next)) return current;
  await writeJourneyState(root, next);
  return { ...next, updatedAt: new Date().toISOString() };
}

function completedIngestFromReview(state: JourneyState, rawSources: BootstrapRawSource[], review: ReviewState, sourcePath?: string): JourneyState["ingest"] {
  const targetDirectory = normalizedWorkspacePath(sourcePath) ?? undefined;
  const files = targetDirectory
    ? rawSourcesForSourcePath(rawSources, targetDirectory).map((source) => ({ path: source.path, status: "done" as const }))
    : [];
  const batches = targetDirectory
    ? [{
        id: "review-source",
        label: path.posix.basename(targetDirectory) || targetDirectory,
        description: targetDirectory,
        fileCount: files.length,
        status: "success" as const,
        files: files.map((file) => file.path),
      }]
    : [];
  const totalBatches = batches.length;
  const completedBatches = batches.filter((batch) => batch.status === "success").length;

  return {
    ...state.ingest,
    planId: undefined,
    targetDirectory,
    status: targetDirectory ? "completed" : undefined,
    files,
    generatedPages: review.files.map((file) => file.path),
    totalBatches,
    completedBatches,
    progress: totalBatches ? 100 : 0,
    batches,
  };
}

function emptyIngestState(): JourneyState["ingest"] {
  return { files: [], generatedPages: [], totalBatches: 0, completedBatches: 0, progress: 0, batches: [] };
}

function emptyVerifyState(plan?: IngestPlan | null, draftId?: string): VerifyState {
  return {
    status: "generating",
    questionCount: 0,
    coverage: 0,
    autoFixed: 0,
    needsInput: 0,
    cases: [],
    fixes: [],
    planId: plan?.plan_id,
    draftId,
  };
}

async function hasPublishedKnowledgeBaseline(root: string): Promise<boolean> {
  const files = await Promise.all(INGEST_DRAFT_BASELINE_FILES.map((file) => fileExists(path.join(root, CONTENT_ROOT, file))));
  return files.every(Boolean);
}

function recoveredOrphanWorkflowState(state: JourneyState, rawSources: BootstrapRawSource[], publishedKnowledge: boolean): JourneyState {
  const returnToBuild = state.flow === "build" || !publishedKnowledge;
  return {
    ...state,
    flow: returnToBuild ? "build" : "maintenance",
    phase: returnToBuild ? "ingest" : "ready",
    bootstrap: {
      ...state.bootstrap,
      status: "done",
      awaitingUser: false,
      step: state.bootstrap.totalSteps || 6,
      rawSources,
      confirmationPrompt: undefined,
    },
    ingest: returnToBuild ? state.ingest : emptyIngestState(),
    verify: returnToBuild ? state.verify : emptyVerifyState(),
    review: undefined,
    updatedAt: new Date().toISOString(),
  };
}

async function projectJourneyFromArtifacts(root: string, state: JourneyState): Promise<JourneyState> {
  const ingestPlan = await readLatestIngestPlan(root);
  const hasActiveIngestPlan = Boolean(ingestPlan && !isIngestPlanCompleted(ingestPlan));
  const hasPendingIngestWork = hasPendingIngestBatch(ingestPlan);
  const planDraft = await readIngestPlanDraft(root, ingestPlan);
  const reviewGate = planDraft
    ? await readReviewGateForDraft(root, planDraft)
    : await readReviewGate(root);
  const reviewDraft = planDraft ?? (reviewGate.draftId ? await readReviewDraftById(root, reviewGate.draftId, { includeWithoutMeta: true }) : null);
  const reviewMeta = reviewDraft?.metaRaw ? parseDraftMetaObject(reviewDraft.metaRaw) : {};
  const verify = planDraft
    ? reviewGate.verify ?? await readVerifyStateForDraft(root, planDraft.id)
    : !ingestPlan && state.phase === "verify"
      ? await readVerifyStateFromArtifacts(root)
      : null;

  if (await isOrphanWorkflowRuntime(root, { state, requireStale: true })) {
    const rawSources = state.bootstrap.rawSources?.length ? state.bootstrap.rawSources : await listRawSources(root);
    const publishedKnowledge = await hasPublishedKnowledgeBaseline(root);
    await releaseWorkflowLock(root, undefined, { force: true });
    return writeJourneyStateIfChanged(root, state, recoveredOrphanWorkflowState(state, rawSources, publishedKnowledge));
  }

  const review = reviewGate.review;
  // A query-ready Knowledge Base has no workflow artifacts to project. Avoid
  // recursively walking raw/ merely to return its already-authoritative state.
  if (!review && state.phase === "ready" && state.bootstrap.status === "done" && !hasActiveIngestPlan) return state;

  const rawSources = state.bootstrap.rawSources?.length ? state.bootstrap.rawSources : await listRawSources(root);

  // Pending work in the active plan always wins over historical drafts and Verify artifacts.
  if (ingestPlan && hasPendingIngestWork) {
    const draftId = planDraft?.id ?? ingestPlan.draft_id;
    const keepsCurrentVerify = Boolean(
      (state.verify.planId && state.verify.planId === ingestPlan.plan_id) ||
      (draftId && state.verify.draftId === draftId)
    );
    const next: JourneyState = {
      ...state,
      phase: "ingest",
      bootstrap: {
        ...state.bootstrap,
        status: "done",
        awaitingUser: false,
        rawSources,
      },
      ingest: ingestStateFromPlan(state, ingestPlan, rawSources),
      verify: keepsCurrentVerify ? state.verify : emptyVerifyState(ingestPlan, draftId),
      review: undefined,
      updatedAt: new Date().toISOString(),
    };
    return writeJourneyStateIfChanged(root, state, next);
  }

  if (!review) {
    if (state.phase === "ready" && state.bootstrap.status === "done" && !hasActiveIngestPlan) return state;
    if (verify || hasActiveIngestPlan) {
      const ingest = ingestPlan ? ingestStateFromPlan(state, ingestPlan, rawSources) : state.ingest;
      const next: JourneyState = {
        ...state,
        phase: "verify",
        bootstrap: {
          ...state.bootstrap,
          status: state.phase === "bootstrap" ? state.bootstrap.status : "done",
          awaitingUser: false,
          rawSources,
        },
        ingest,
        verify: verify ?? emptyVerifyState(ingestPlan, planDraft?.id ?? ingestPlan?.draft_id),
        review: undefined,
        updatedAt: new Date().toISOString(),
      };
      return writeJourneyStateIfChanged(root, state, next);
    }
    if (!ingestPlan || isIngestPlanCompleted(ingestPlan)) return state;
    const next: JourneyState = {
      ...state,
      phase: "ingest",
      bootstrap: {
        ...state.bootstrap,
        status: "done",
        awaitingUser: false,
        rawSources,
      },
      ingest: ingestStateFromPlan(state, ingestPlan, rawSources),
      updatedAt: new Date().toISOString(),
    };
    return writeJourneyStateIfChanged(root, state, next);
  }

  const ingest = ingestPlan
    ? ingestStateFromPlan(state, ingestPlan, rawSources)
    : completedIngestFromReview(state, rawSources, review, reviewMeta.source_file);
  if (!reviewGate.allowed) {
    const next: JourneyState = {
      ...state,
      phase: "verify",
      bootstrap: {
        ...state.bootstrap,
        status: "done",
        awaitingUser: false,
        rawSources,
        confirmationPrompt: reviewGate.message,
      },
      ingest,
      verify: reviewGate.verify ?? verify ?? { ...emptyVerifyState(ingestPlan, planDraft?.id ?? ingestPlan?.draft_id), status: "testing" },
      review: undefined,
      updatedAt: new Date().toISOString(),
    };
    return writeJourneyStateIfChanged(root, state, next);
  }
  const base: JourneyState = {
    ...state,
    bootstrap: {
      ...state.bootstrap,
      status: "done",
      awaitingUser: false,
      step: state.bootstrap.totalSteps || 6,
      rawSources,
      confirmationPrompt: "检查已完成，请审核待写入的知识变更。",
    },
    ingest,
    verify: reviewGate.verify ?? verify ?? { ...state.verify, status: state.verify.status === "done" ? "done" : "testing" },
    review: { ...review, status: "pending" },
  };
  if (shouldHoldVerifyBeforeReview(state, base.verify)) {
    const next: JourneyState = {
      ...base,
      phase: "verify",
      bootstrap: {
        ...base.bootstrap,
        status: "done",
        awaitingUser: false,
        confirmationPrompt: "正在验证生成的知识内容。",
      },
    };
    return writeJourneyStateIfChanged(root, state, next);
  }
  const next: JourneyState = { ...base, phase: "review" };
  return writeJourneyStateIfChanged(root, state, next);
}

function hasSameCompletedVerifyArtifact(state: JourneyState, verify: VerifyState): boolean {
  return state.verify.status === "done" &&
    Boolean(state.verify.artifactBase) &&
    state.verify.artifactBase === verify.artifactBase &&
    state.verify.artifactUpdatedAt === verify.artifactUpdatedAt;
}

function shouldHoldVerifyBeforeReview(state: JourneyState, verify: VerifyState | null): boolean {
  if (!verify || verify.status !== "done") return false;
  if (state.phase === "ready" || state.phase === "review") return false;
  if (!hasSameCompletedVerifyArtifact(state, verify)) return true;
  if (state.phase !== "verify") return true;
  const updatedAt = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return Date.now() - updatedAt < VERIFY_REVIEW_DWELL_MS;
}

export async function completeBootstrap(root: string): Promise<void> {
  await fs.rm(resolveWorkspaceFile(root, "BOOTSTRAP.md"), { force: true }).catch(() => undefined);
}

function ontologyUpdateId(ontologyId: string, now = new Date()): string {
  const cleanOntologyId = ontologyId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "ontology";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const random = randomBytes(4).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toLowerCase().padEnd(6, "0");
  return `${cleanOntologyId}-${stamp}-${random}`;
}

function ontologyUpdateMaterialRelativePath(originalPath: string): string | null {
  const normalized = path.posix.normalize(originalPath.replace(/\\/g, "/").replace(/^\/+/, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  if (!normalized.startsWith(`${CONTENT_ROOT}/`) && !normalized.startsWith(`${LEGACY_CONTENT_ROOT}/`)) return null;
  const parts = normalized.split("/");
  const basename = parts[parts.length - 1];
  if (parts.length === 2 && ONTOLOGY_UPDATE_EXCLUDED_KNOWLEDGE_FILES.has(basename)) return null;
  return path.posix.join(CONTENT_ROOT, ...parts.slice(1));
}

function mergeReviewFilesForOntologyMaterials(reviews: ReviewState[]): { included: Map<string, ReviewFile & { materialPath: string }>; excluded: string[] } {
  const included = new Map<string, ReviewFile & { materialPath: string }>();
  const excluded = new Set<string>();

  for (const review of reviews) {
    for (const file of review.files) {
      const materialPath = ontologyUpdateMaterialRelativePath(file.path);
      if (!materialPath) {
        excluded.add(file.path);
        continue;
      }

      const existing = included.get(materialPath);
      included.set(materialPath, {
        ...file,
        status: existing?.status === "new" ? "new" : file.status,
        oldContent: existing?.oldContent ?? file.oldContent,
        materialPath,
      });
    }
  }

  return { included, excluded: [...excluded].sort() };
}

interface MaterialDiffLine {
  type: "context" | "added" | "removed";
  text: string;
}

function splitMaterialDiffLines(value: string | undefined): string[] {
  return (value ?? "").replace(/\r\n/g, "\n").split("\n");
}

function buildMaterialLineDiff(oldContent: string | undefined, newContent: string): MaterialDiffLine[] {
  const oldLines = splitMaterialDiffLines(oldContent);
  const newLines = splitMaterialDiffLines(newContent);
  if (oldContent === undefined) return newLines.map((text) => ({ type: "added", text }));
  if (oldContent === newContent) return newLines.map((text) => ({ type: "context", text }));

  if (oldLines.length * newLines.length > 160_000) {
    return [
      ...oldLines.map((text) => ({ type: "removed" as const, text })),
      ...newLines.map((text) => ({ type: "added" as const, text })),
    ];
  }

  const dp = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const diff: MaterialDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      diff.push({ type: "context", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      diff.push({ type: "removed", text: oldLines[i] });
      i += 1;
    } else {
      diff.push({ type: "added", text: newLines[j] });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    diff.push({ type: "removed", text: oldLines[i] });
    i += 1;
  }
  while (j < newLines.length) {
    diff.push({ type: "added", text: newLines[j] });
    j += 1;
  }
  return diff;
}

function materialDiffMarkdown(files: Iterable<ReviewFile & { materialPath: string }>): string {
  const sections = ["# Ontology Update Diff"];
  for (const file of [...files].sort((a, b) => a.materialPath.localeCompare(b.materialPath))) {
    const lines = buildMaterialLineDiff(file.oldContent, file.content);
    sections.push(
      [
        `## ${file.materialPath}`,
        "",
        `Status: ${file.status}`,
        "",
        "```diff",
        ...lines.map((line) => `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}${line.text}`),
        "```",
      ].join("\n"),
    );
  }
  return `${sections.join("\n\n")}\n`;
}

export async function createOntologyUpdateMaterials(root: string, ontologyId: string, reviews: ReviewState[]): Promise<OntologyUpdateMaterialsResult> {
  const { included, excluded } = mergeReviewFilesForOntologyMaterials(reviews);
  if (!included.size) {
    return { status: "skipped", includedFiles: [], excludedFiles: excluded, reason: "no_material" };
  }

  const updateId = ontologyUpdateId(ontologyId);
  const materialRoot = path.posix.join(ONTOLOGY_UPDATE_MATERIALS_ROOT, updateId);
  const fullRoot = resolveWorkspaceFile(root, materialRoot);
  await fs.mkdir(fullRoot, { recursive: true });

  for (const file of included.values()) {
    const target = path.join(fullRoot, file.materialPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, "utf-8");
  }

  const diffPath = path.posix.join(materialRoot, "diff.md");
  await fs.writeFile(resolveWorkspaceFile(root, diffPath), materialDiffMarkdown(included.values()), "utf-8");

  return {
    status: "created",
    updateId,
    materialRoot,
    diffPath,
    includedFiles: [...included.keys()].sort(),
    excludedFiles: excluded,
  };
}

async function applyReviewDraftRecord(root: string, draft: ReviewDraftRecord): Promise<ReviewState | null> {
  await assertReviewGatePassed(root, draft);
  const review = await readReviewStateFromDraft(root, draft);
  if (!review || !draft) return null;
  const meta = parseDraftMeta(draft.metaRaw);
  let logMerged = false;
  let indexApplied = false;

  for (const file of review.files.sort((a, b) => a.path.localeCompare(b.path))) {
    const result = await applyReviewFile(root, file, meta);
    if (result === "log_merge") logMerged = true;
    if (file.path.endsWith("/index.md")) indexApplied = true;
  }

  if (meta.log_entry && !logMerged) await mergeLogEntry(root, `${CONTENT_ROOT}/log.md`, meta.log_entry);
  if (meta.index_additions.length && !indexApplied) await mergeIndexAdditions(root, `${CONTENT_ROOT}/index.md`, meta.index_additions);

  await fs.rm(draft.dir, { recursive: true, force: true });
  await cleanupIngestArtifactsForDraftBestEffort(root, draft.id);
  return review;
}

export async function applyReviewDraft(root: string, draftId: string): Promise<ReviewState | null> {
  const draft = await readReviewDraftById(root, draftId, { includeWithoutMeta: true });
  if (!draft) return null;
  return applyReviewDraftRecord(root, draft);
}

export async function applyLatestReviewDraft(root: string): Promise<ReviewState | null> {
  const draft = await readActiveReviewDraft(root, { includeWithoutMeta: true });
  if (!draft) return null;
  return applyReviewDraftRecord(root, draft);
}

export async function applyAllReviewDrafts(root: string): Promise<ReviewState[]> {
  const drafts = (await listReviewDrafts(root, { includeWithoutMeta: true })).sort((a, b) => a.updatedAt - b.updatedAt);
  const blocked: PendingReviewDraftSummary[] = [];
  for (const draft of drafts) {
    const detail = await readReviewDraftDetail(root, draft.id);
    if (!detail?.canApprove) {
      blocked.push(detail ?? {
        draftId: draft.id,
        operation: "draft",
        description: `Pending review: ${draft.id}`,
        updatedAt: new Date(draft.updatedAt || Date.now()).toISOString(),
        fileCount: 0,
        newCount: 0,
        modifiedCount: 0,
        canApprove: false,
        gateReason: "empty_draft",
        gateMessage: `Draft ${draft.id} has no markdown changes.`,
      });
    }
  }
  if (blocked.length) {
    const error = new Error(`Cannot approve all drafts. ${blocked[0].gateMessage}`) as Error & { status?: number };
    error.status = 409;
    throw error;
  }

  const applied: ReviewState[] = [];
  for (const draft of drafts) {
    const review = await applyReviewDraftRecord(root, draft);
    if (review) applied.push(review);
  }
  return applied;
}

type DraftIndexAddition = { section?: string; line?: string };
type DraftMeta = { log_entry?: string; index_additions?: DraftIndexAddition[] };

function draftMetaStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function parseDraftMetaRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseDraftMetaObject(raw: string): DraftMetaObject {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return {
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      operation: typeof parsed.operation === "string" ? parsed.operation : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
      source_file: typeof parsed.source_file === "string" ? parsed.source_file.trim() : undefined,
      affected_files: draftMetaStringArray(parsed.affected_files),
      new_files: draftMetaStringArray(parsed.new_files),
      modified_files: draftMetaStringArray(parsed.modified_files),
      log_entry: typeof parsed.log_entry === "string" ? parsed.log_entry : undefined,
      index_additions: Array.isArray(parsed.index_additions) ? parsed.index_additions as DraftIndexAddition[] : [],
    };
  } catch {
    return {};
  }
}

function parseDraftMeta(raw: string): { log_entry: string; index_additions: DraftIndexAddition[] } {
  const parsed = parseDraftMetaObject(raw) as DraftMeta;
  return {
    log_entry: typeof parsed.log_entry === "string" ? parsed.log_entry.trim() : "",
    index_additions: Array.isArray(parsed.index_additions) ? parsed.index_additions : [],
  };
}

async function assertReviewGatePassed(root: string, draft?: ReviewDraftRecord): Promise<ReviewGateState> {
  const gate = draft ? await readReviewGateForDraft(root, draft) : await readReviewGate(root);
  if (gate.reason === "no_draft") return gate;
  if (gate.allowed) return gate;
  const error = new Error(gate.message) as Error & { status?: number };
  error.status = 409;
  throw error;
}

async function applyReviewFile(root: string, file: ReviewFile, meta: { log_entry: string }): Promise<string> {
  if (file.path.endsWith("/log.md") && meta.log_entry) {
    await mergeLogEntry(root, file.path, meta.log_entry);
    return "log_merge";
  }
  await writeFile(root, file.path, file.content);
  return "copy";
}

async function mergeLogEntry(root: string, targetPath: string, logEntry: string): Promise<void> {
  if (!logEntry.trim()) return;
  const file = resolveWorkspaceFile(root, targetPath);
  const current = await fs.readFile(file, "utf-8").catch(() => "");
  const match = /^## \[\d{4}-\d{2}-\d{2}\]/m.exec(current);
  const next = match
    ? `${current.slice(0, match.index)}${logEntry}\n\n${current.slice(match.index)}`
    : `${current.trimEnd()}\n\n${logEntry}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, next, "utf-8");
}

async function mergeIndexAdditions(root: string, targetPath: string, additions: DraftIndexAddition[]): Promise<void> {
  const validAdditions = additions.filter((addition) => addition.section?.trim() && addition.line?.trim());
  if (!validAdditions.length) return;
  const file = resolveWorkspaceFile(root, targetPath);
  let current = await fs.readFile(file, "utf-8").catch(() => "");
  for (const addition of validAdditions) {
    const sectionPattern = `## ${addition.section!.trim()}`;
    const line = addition.line!.trim();
    const sectionPos = current.indexOf(sectionPattern);
    if (sectionPos === -1) {
      current += `\n\n${sectionPattern}\n${line}\n`;
      continue;
    }
    const afterHeader = sectionPos + sectionPattern.length;
    const nextSection = current.indexOf("\n## ", afterHeader);
    current = nextSection === -1
      ? `${current.trimEnd()}\n${line}\n`
      : `${current.slice(0, nextSection).trimEnd()}\n${line}\n${current.slice(nextSection)}`;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, current, "utf-8");
}

export async function discardLatestReviewDraft(root: string): Promise<ReviewState | null> {
  const draft = await readActiveReviewDraft(root, { includeWithoutMeta: true });
  const review = draft ? await readReviewStateFromDraft(root, draft) : null;
  if (!draft || !review) return null;
  await fs.rm(draft.dir, { recursive: true, force: true });
  await cleanupIngestArtifactsForDraftBestEffort(root, draft.id);
  return review;
}

export async function discardReviewDraft(root: string, draftId: string): Promise<ReviewState | null> {
  const draft = await readReviewDraftById(root, draftId, { includeWithoutMeta: true });
  const review = draft ? await readReviewStateFromDraft(root, draft) : null;
  if (!draft || !review) return null;
  await fs.rm(draft.dir, { recursive: true, force: true });
  await cleanupIngestArtifactsForDraftBestEffort(root, draft.id);
  return review;
}

export async function discardAllReviewDrafts(root: string): Promise<PendingReviewDraftSummary[]> {
  const summaries = await listPendingReviewDrafts(root);
  const drafts = await listReviewDrafts(root, { includeWithoutMeta: true });
  await Promise.all(drafts.map(async (draft) => {
    await fs.rm(draft.dir, { recursive: true, force: true });
    await cleanupIngestArtifactsForDraftBestEffort(root, draft.id);
  }));
  return summaries;
}

async function recoverOrphanWorkflowRuntime(root: string): Promise<ReviewRecoveryResult> {
  if (!await isOrphanWorkflowRuntime(root, { requireStale: false })) return { recovered: [], archive: null };

  const createdAt = new Date().toISOString();
  const recoveryId = `${recoveryTimestamp()}-${randomUUID().slice(0, 8)}`;
  const recoveryRoot = resolveWorkspaceFile(root, path.posix.join(".runtime", "review-recovery", recoveryId));
  await fs.mkdir(recoveryRoot, { recursive: true });

  const lockPaths = workflowLockPaths(root);
  const archivedRuntimeArtifacts = (await Promise.all([
    copyExistingPath(root, recoveryRoot, resolveWorkspaceFile(root, ".runtime/journey-state.json"), path.join("runtime", "journey-state.json.before")),
    copyExistingPath(root, recoveryRoot, lockPaths.mirror, path.join("runtime", "workflow-lock.json.before")),
    copyExistingPath(root, recoveryRoot, lockPaths.dir, path.join("runtime", "workflow-lock.before")),
  ])).filter((item): item is string => Boolean(item)).sort();

  const manifest = {
    version: 1,
    type: "review-recovery",
    orphanRuntime: true,
    createdAt,
    draftIds: [],
    recovered: [],
    archived: {
      drafts: [],
      ingestPlans: [],
      verifyArtifacts: [],
      runtime: archivedRuntimeArtifacts,
    },
  };
  const manifestFile = path.join(recoveryRoot, "manifest.json");
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  return {
    recovered: [],
    archive: {
      recoveryId,
      recoveryPath: workspaceRelativePath(root, recoveryRoot),
      manifestPath: workspaceRelativePath(root, manifestFile),
      createdAt,
      draftIds: [],
      archivedDrafts: [],
      archivedIngestPlans: [],
      archivedVerifyArtifacts: [],
      archivedRuntimeArtifacts,
      orphanRuntime: true,
    },
  };
}

export async function recoverPendingReviewDrafts(root: string): Promise<ReviewRecoveryResult> {
  const drafts = await listReviewDrafts(root, { includeWithoutMeta: true });
  if (!drafts.length) return recoverOrphanWorkflowRuntime(root);

  const recovered = await listPendingReviewDrafts(root);
  const createdAt = new Date().toISOString();
  const recoveryId = `${recoveryTimestamp()}-${randomUUID().slice(0, 8)}`;
  const recoveryRoot = resolveWorkspaceFile(root, path.posix.join(".runtime", "review-recovery", recoveryId));
  await fs.mkdir(recoveryRoot, { recursive: true });

  const verifyGroups = await readVerifyArtifactGroups(root).catch(() => []);
  const archivedDrafts: string[] = [];
  const archivedIngestPlans: string[] = [];
  const archivedVerifyArtifacts: string[] = [];

  for (const draft of drafts) {
    const archivedDraft = await archiveExistingPath(root, recoveryRoot, draft.dir, path.join("drafts", draft.id));
    if (archivedDraft) archivedDrafts.push(archivedDraft);

    const planArchive = await archiveIngestPlansForDraft(root, recoveryRoot, draft.id);
    archivedIngestPlans.push(...planArchive.archived);
    archivedVerifyArtifacts.push(...await archiveVerifyArtifactsForDraft(root, recoveryRoot, draft.id, planArchive.planIds, verifyGroups));
  }

  const manifest = {
    version: 1,
    type: "review-recovery",
    createdAt,
    draftIds: drafts.map((draft) => draft.id),
    recovered,
    archived: {
      drafts: archivedDrafts.sort(),
      ingestPlans: archivedIngestPlans.sort(),
      verifyArtifacts: archivedVerifyArtifacts.sort(),
    },
  };
  const manifestFile = path.join(recoveryRoot, "manifest.json");
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  return {
    recovered,
    archive: {
      recoveryId,
      recoveryPath: workspaceRelativePath(root, recoveryRoot),
      manifestPath: workspaceRelativePath(root, manifestFile),
      createdAt,
      draftIds: drafts.map((draft) => draft.id),
      archivedDrafts: archivedDrafts.sort(),
      archivedIngestPlans: archivedIngestPlans.sort(),
      archivedVerifyArtifacts: archivedVerifyArtifacts.sort(),
    },
  };
}

export async function readJourneyState(root: string): Promise<JourneyState> {
  try {
    const raw = await fs.readFile(path.join(root, ".runtime", "journey-state.json"), "utf-8");
    const state = normalizeJourneyStateShape(JSON.parse(raw) as JourneyState);
    if (await fileExists(path.join(root, "BOOTSTRAP.md")) && state.phase === "ready" && (state.bootstrap.status as string | undefined) !== "done") {
      return projectJourneyFromArtifacts(root, {
        ...state,
        flow: "build",
        phase: "bootstrap",
        bootstrap: {
          ...state.bootstrap,
          step: state.bootstrap.step || 1,
          totalSteps: state.bootstrap.totalSteps || 6,
          status: state.bootstrap.status && state.bootstrap.status !== "done" ? state.bootstrap.status : "goal_selection",
          awaitingUser: state.bootstrap.awaitingUser ?? true,
        },
        updatedAt: new Date().toISOString(),
      });
    }
    return projectJourneyFromArtifacts(root, state);
  } catch {
    const state = initialJourneyState();
    if (await fileExists(path.join(root, "BOOTSTRAP.md"))) {
      state.flow = "build";
      state.phase = "bootstrap";
      state.bootstrap.step = 1;
      state.bootstrap.status = "goal_selection";
      state.bootstrap.awaitingUser = true;
    }
    await writeJourneyState(root, state);
    return projectJourneyFromArtifacts(root, state);
  }
}

export async function writeJourneyState(root: string, state: JourneyState): Promise<void> {
  await fs.mkdir(path.join(root, ".runtime"), { recursive: true });
  const persisted = { ...state, updatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(root, ".runtime", "journey-state.json"), JSON.stringify(persisted, null, 2));
  for (const listener of journeyStateWriteListeners) {
    try {
      await listener(root, persisted);
    } catch (error) {
      console.warn("[journey-state] readiness projection update failed", error);
    }
  }
}

const ONTOLOGY_SCENARIO_CARDS_FILE = "ontology/artifacts/scenario-cards.json";
const ONTOLOGY_INSTANCE_GLEANING_FILE = "ontology/artifacts/instance-gleaning-state.json";
const ONTOLOGY_OBJECT_INSTANCES_FILE = "ontology/object-instances.yaml";
const ONTOLOGY_INSTANCE_GLEANING_MAX_ROUNDS = 3;
const ONTOLOGY_SCENARIO_STATUSES = ["pending", "processing", "success"] as const;

export type OntologyScenarioStatus = typeof ONTOLOGY_SCENARIO_STATUSES[number];
export type OntologyScenarioCardsOperation = "set_queue" | "start_next" | "complete_current" | "status";
export type OntologyInstanceGleaningOperation = "next" | "status" | "reset";

export interface OntologyScenarioCard {
  id: string;
  status: OntologyScenarioStatus;
  name?: string;
  actor?: string;
  decision?: string;
  target?: string;
  conclusions?: unknown[];
  evidence?: unknown[];
  dataScope?: string;
  freshness?: string;
  candidateAction?: string;
  [key: string]: unknown;
}

export interface OntologyScenarioCardsDoc {
  scenario_cards: OntologyScenarioCard[];
}

export interface OntologyScenarioCardsUpdateInput {
  operation: OntologyScenarioCardsOperation;
  scenario_id?: string;
  scenario_cards?: unknown[];
}

export interface OntologyScenarioCardsState extends OntologyScenarioCardsDoc {
  scenarioCardsFound: boolean;
  current: OntologyScenarioCard | null;
  next: OntologyScenarioCard | null;
  allComplete: boolean;
  allowedNextOperation: OntologyScenarioCardsOperation;
}

export interface OntologyInstanceGleaningCounts {
  objectInstances: number;
  linkInstances: number;
}

export interface OntologyInstanceGleaningActiveRound {
  round: number;
  startedAt: string;
  beforeCounts: OntologyInstanceGleaningCounts;
  objectInstanceIds: string[];
  linkInstanceIds: string[];
}

export interface OntologyInstanceGleaningRound {
  round: number;
  startedAt: string;
  completedAt: string;
  beforeCounts: OntologyInstanceGleaningCounts;
  afterCounts: OntologyInstanceGleaningCounts;
  addedObjectInstanceIds: string[];
  addedLinkInstanceIds: string[];
}

export interface OntologyInstanceGleaningState {
  scenarioId: string;
  maxRounds: number;
  issuedRounds: number;
  completedRounds: number;
  rounds: OntologyInstanceGleaningRound[];
  activeRound?: OntologyInstanceGleaningActiveRound;
  complete: boolean;
  current: OntologyScenarioCard;
  prompt?: string;
  nextRound?: number;
}

export interface OntologyInstanceGleaningInput {
  operation: OntologyInstanceGleaningOperation;
  scenario_id?: string;
}

interface PersistedOntologyInstanceGleaningState {
  scenarioId: string;
  maxRounds: number;
  issuedRounds: number;
  completedRounds: number;
  rounds: OntologyInstanceGleaningRound[];
  activeRound?: OntologyInstanceGleaningActiveRound;
  complete: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isOntologyScenarioStatus(value: unknown): value is OntologyScenarioStatus {
  return ONTOLOGY_SCENARIO_STATUSES.includes(value as OntologyScenarioStatus);
}

function normalizeStoredScenarioCard(value: unknown, index: number): OntologyScenarioCard {
  if (!isPlainRecord(value)) throw new Error(`scenario_cards[${index}] must be an object.`);
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) throw new Error(`scenario_cards[${index}].id is required.`);
  if (!isOntologyScenarioStatus(value.status)) {
    throw new Error(`scenario_cards[${index}].status must be pending, processing, or success.`);
  }
  return { ...value, id, status: value.status };
}

function normalizeSetQueueScenarioCard(value: unknown, index: number): OntologyScenarioCard {
  if (!isPlainRecord(value)) throw new Error(`scenario_cards[${index}] must be an object.`);
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) throw new Error(`scenario_cards[${index}].id is required.`);
  if (value.status !== undefined && !isOntologyScenarioStatus(value.status)) {
    throw new Error(`scenario_cards[${index}].status must be pending, processing, or success when provided.`);
  }
  return { ...value, id, status: "pending" };
}

function normalizeScenarioCardsDoc(value: unknown): OntologyScenarioCardsDoc {
  if (!isPlainRecord(value) || !Array.isArray(value.scenario_cards)) {
    throw new Error(`${ONTOLOGY_SCENARIO_CARDS_FILE} must contain a scenario_cards array.`);
  }
  const scenarioCards = value.scenario_cards.map(normalizeStoredScenarioCard);
  validateScenarioQueue(scenarioCards);
  return { scenario_cards: scenarioCards };
}

function validateScenarioQueue(scenarioCards: readonly OntologyScenarioCard[]): void {
  const ids = new Set<string>();
  let processingCount = 0;
  let seenUnfinished = false;
  scenarioCards.forEach((card, index) => {
    if (ids.has(card.id)) throw new Error(`Duplicate scenario id: ${card.id}.`);
    ids.add(card.id);
    if (card.status === "processing") processingCount += 1;
    if (!seenUnfinished && card.status === "success") return;
    if (!seenUnfinished) {
      seenUnfinished = true;
      return;
    }
    if (card.status !== "pending") {
      throw new Error(`scenario_cards[${index}] must stay pending until earlier unfinished scenarios are completed.`);
    }
  });
  if (processingCount > 1) throw new Error("At most one scenario may be processing.");
}

function scenarioCardsState(doc: OntologyScenarioCardsDoc | null, found: boolean): OntologyScenarioCardsState {
  const scenarioCards = doc?.scenario_cards ?? [];
  const current = scenarioCards.find((card) => card.status !== "success") ?? null;
  const allComplete = scenarioCards.length > 0 && scenarioCards.every((card) => card.status === "success");
  const allowedNextOperation: OntologyScenarioCardsOperation = !found || !scenarioCards.length
    ? "set_queue"
    : allComplete
      ? "set_queue"
      : current?.status === "processing"
        ? "complete_current"
        : "start_next";
  return {
    scenarioCardsFound: found,
    scenario_cards: scenarioCards,
    current,
    next: current,
    allComplete,
    allowedNextOperation,
  };
}

function currentProcessingScenario(doc: OntologyScenarioCardsDoc): OntologyScenarioCard {
  const index = doc.scenario_cards.findIndex((card) => card.status !== "success");
  if (index < 0) throw new Error("All scenarios are already success.");
  const card = doc.scenario_cards[index];
  if (card.status !== "processing") throw new Error(`Scenario ${card.id} is not processing. Call start_next first.`);
  return card;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))].sort()
    : [];
}

function normalizeGleaningCounts(value: unknown): OntologyInstanceGleaningCounts {
  const record = isPlainRecord(value) ? value : {};
  const objectInstances = typeof record.objectInstances === "number" && Number.isFinite(record.objectInstances)
    ? Math.max(0, Math.trunc(record.objectInstances))
    : 0;
  const linkInstances = typeof record.linkInstances === "number" && Number.isFinite(record.linkInstances)
    ? Math.max(0, Math.trunc(record.linkInstances))
    : 0;
  return { objectInstances, linkInstances };
}

function normalizeActiveGleaningRound(value: unknown, maxRounds: number): OntologyInstanceGleaningActiveRound | undefined {
  if (!isPlainRecord(value)) return undefined;
  const round = typeof value.round === "number" && Number.isInteger(value.round) ? value.round : 0;
  if (round <= 0 || round > maxRounds) return undefined;
  const startedAt = typeof value.startedAt === "string" && value.startedAt.trim() ? value.startedAt : new Date().toISOString();
  const objectInstanceIds = normalizeStringArray(value.objectInstanceIds);
  const linkInstanceIds = normalizeStringArray(value.linkInstanceIds);
  const beforeCounts = isPlainRecord(value.beforeCounts)
    ? normalizeGleaningCounts(value.beforeCounts)
    : { objectInstances: objectInstanceIds.length, linkInstances: linkInstanceIds.length };
  return { round, startedAt, beforeCounts, objectInstanceIds, linkInstanceIds };
}

function normalizeCompletedGleaningRound(value: unknown, maxRounds: number): OntologyInstanceGleaningRound | null {
  if (!isPlainRecord(value)) return null;
  const round = typeof value.round === "number" && Number.isInteger(value.round) ? value.round : 0;
  if (round <= 0 || round > maxRounds) return null;
  const startedAt = typeof value.startedAt === "string" && value.startedAt.trim() ? value.startedAt : new Date().toISOString();
  const completedAt = typeof value.completedAt === "string" && value.completedAt.trim() ? value.completedAt : startedAt;
  return {
    round,
    startedAt,
    completedAt,
    beforeCounts: normalizeGleaningCounts(value.beforeCounts),
    afterCounts: normalizeGleaningCounts(value.afterCounts),
    addedObjectInstanceIds: normalizeStringArray(value.addedObjectInstanceIds),
    addedLinkInstanceIds: normalizeStringArray(value.addedLinkInstanceIds),
  };
}

function legacyPassesToGleaningRounds(value: unknown, maxRounds: number): OntologyInstanceGleaningRound[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainRecord).map((item): OntologyInstanceGleaningRound | null => {
    const round = typeof item.round === "number" && Number.isInteger(item.round) ? item.round : 0;
    if (round <= 0 || round > maxRounds) return null;
    const addedInstances = typeof item.addedInstances === "number" && Number.isFinite(item.addedInstances) ? Math.max(0, Math.trunc(item.addedInstances)) : 0;
    const addedLinks = typeof item.addedLinks === "number" && Number.isFinite(item.addedLinks) ? Math.max(0, Math.trunc(item.addedLinks)) : 0;
    const completedAt = typeof item.completedAt === "string" && item.completedAt.trim() ? item.completedAt : new Date().toISOString();
    return {
      round,
      startedAt: completedAt,
      completedAt,
      beforeCounts: { objectInstances: 0, linkInstances: 0 },
      afterCounts: { objectInstances: addedInstances, linkInstances: addedLinks },
      addedObjectInstanceIds: [],
      addedLinkInstanceIds: [],
    };
  }).filter((item): item is OntologyInstanceGleaningRound => Boolean(item));
}

function normalizeInstanceGleaningState(value: unknown, current: OntologyScenarioCard): OntologyInstanceGleaningState {
  if (!isPlainRecord(value) || value.scenarioId !== current.id) {
    return initialInstanceGleaningState(current);
  }
  const maxRounds = typeof value.maxRounds === "number" && Number.isInteger(value.maxRounds) && value.maxRounds > 0
    ? value.maxRounds
    : ONTOLOGY_INSTANCE_GLEANING_MAX_ROUNDS;
  const completed = Array.isArray(value.rounds)
    ? value.rounds.map((item) => normalizeCompletedGleaningRound(item, maxRounds)).filter((item): item is OntologyInstanceGleaningRound => Boolean(item))
    : legacyPassesToGleaningRounds(value.passes, maxRounds);
  const rounds = [...completed].sort((a, b) => a.round - b.round);
  const activeRound = normalizeActiveGleaningRound(value.activeRound, maxRounds);
  const completedRounds = Math.min(maxRounds, Math.max(0, ...rounds.map((item) => item.round)));
  const issuedRounds = typeof value.issuedRounds === "number" && Number.isInteger(value.issuedRounds)
    ? Math.max(0, Math.min(value.issuedRounds, maxRounds))
    : 0;
  return {
    scenarioId: current.id,
    maxRounds,
    issuedRounds: Math.max(issuedRounds, completedRounds, activeRound?.round ?? 0),
    completedRounds,
    rounds,
    activeRound: activeRound && activeRound.round > completedRounds ? activeRound : undefined,
    complete: completedRounds >= maxRounds,
    current,
  };
}

function persistedInstanceGleaningState(state: OntologyInstanceGleaningState): PersistedOntologyInstanceGleaningState {
  return {
    scenarioId: state.scenarioId,
    maxRounds: state.maxRounds,
    issuedRounds: state.issuedRounds,
    completedRounds: state.completedRounds,
    rounds: state.rounds,
    activeRound: state.activeRound,
    complete: state.completedRounds >= state.maxRounds,
  };
}

function normalizeInstanceGleaningScenarioStates(value: unknown): Record<string, PersistedOntologyInstanceGleaningState> {
  const scenarioStates: Record<string, PersistedOntologyInstanceGleaningState> = {};

  if (isPlainRecord(value) && isPlainRecord(value.scenarioStates)) {
    for (const [scenarioId, rawState] of Object.entries(value.scenarioStates)) {
      if (!scenarioId.trim() || !isPlainRecord(rawState)) continue;
      const current = { id: scenarioId, status: "processing" as const };
      scenarioStates[scenarioId] = persistedInstanceGleaningState(normalizeInstanceGleaningState({ ...rawState, scenarioId }, current));
    }
    return scenarioStates;
  }

  // Backward compatibility: migrate the previous single-scenario file shape.
  if (isPlainRecord(value) && typeof value.scenarioId === "string" && value.scenarioId.trim()) {
    const scenarioId = value.scenarioId.trim();
    const current = { id: scenarioId, status: "processing" as const };
    scenarioStates[scenarioId] = persistedInstanceGleaningState(normalizeInstanceGleaningState(value, current));
  }

  return scenarioStates;
}

function initialInstanceGleaningState(current: OntologyScenarioCard): OntologyInstanceGleaningState {
  return {
    scenarioId: current.id,
    maxRounds: ONTOLOGY_INSTANCE_GLEANING_MAX_ROUNDS,
    issuedRounds: 0,
    completedRounds: 0,
    rounds: [],
    complete: false,
    current,
  };
}

function extractInstanceIdsFromYaml(text: string): { objectInstanceIds: string[]; linkInstanceIds: string[] } {
  const objectInstanceIds = new Set<string>();
  const linkInstanceIds = new Set<string>();
  let section: "instances" | "link_instances" | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      if (/^instances\s*:/.test(line)) section = "instances";
      else if (/^link_instances\s*:/.test(line)) section = "link_instances";
      else section = null;
    }
    const match = line.match(/^\s*-\s+id:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))/);
    const id = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
    if (!id || !section) continue;
    if (section === "instances") objectInstanceIds.add(id);
    if (section === "link_instances") linkInstanceIds.add(id);
  }

  return {
    objectInstanceIds: [...objectInstanceIds].sort(),
    linkInstanceIds: [...linkInstanceIds].sort(),
  };
}

async function scanOntologyInstanceSnapshot(root: string): Promise<Omit<OntologyInstanceGleaningActiveRound, "round" | "startedAt">> {
  const file = resolveWorkspaceFile(root, ONTOLOGY_OBJECT_INSTANCES_FILE);
  const text = await fs.readFile(file, "utf-8").catch(() => "");
  const parsed = extractInstanceIdsFromYaml(text);
  const objectIds = parsed.objectInstanceIds;
  const linkIds = parsed.linkInstanceIds;
  return {
    beforeCounts: { objectInstances: objectIds.length, linkInstances: linkIds.length },
    objectInstanceIds: objectIds,
    linkInstanceIds: linkIds,
  };
}

function idDifference(after: readonly string[], before: readonly string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((id) => !beforeSet.has(id)).sort();
}

function instanceGleaningPrompt(current: OntologyScenarioCard, round: number, maxRounds: number): string {
  return [
    `MANY Object Instances and Link Instances may have been missed in the last extraction. Continue instance extraction pass ${round}/${maxRounds}.`,
    "",
    "Re-read:",
    "- the current scenario decision, target, conclusions, and evidence returned below;",
    "- ontology/object-model.yaml;",
    "- ontology/object-instances.yaml;",
    "- the relevant knowledge/ evidence for this scenario.",
    "",
    "Only add missing Object/Link Instances that:",
    "- match existing Object Types, properties, Relation Types, and object_type_relations[];",
    "- are supported by evidence in knowledge/;",
    "- are not duplicates of already extracted items.",
    "",
    "Do not create new Object Types, properties, Relation Types, or guessed links.",
    "Update ontology/object-instances.yaml if you find missing items. Then call ontology_instance_gleaning next again. The backend will compute added Object/Link Instance ids.",
    "",
    "Current scenario:",
    JSON.stringify(current, null, 2),
  ].join("\n");
}

function withInstanceGleaningComputedFields(state: OntologyInstanceGleaningState): OntologyInstanceGleaningState {
  return {
    ...state,
    complete: state.completedRounds >= state.maxRounds,
    nextRound: state.completedRounds < state.maxRounds ? state.completedRounds + 1 : undefined,
  };
}

async function readInstanceGleaningState(root: string, current: OntologyScenarioCard): Promise<OntologyInstanceGleaningState> {
  const value = await readJsonIfExists(resolveWorkspaceFile(root, ONTOLOGY_INSTANCE_GLEANING_FILE));
  if (isPlainRecord(value) && isPlainRecord(value.scenarioStates)) {
    const state = value.scenarioStates[current.id];
    return normalizeInstanceGleaningState(isPlainRecord(state) ? { ...state, scenarioId: current.id } : state, current);
  }
  return normalizeInstanceGleaningState(value, current);
}

async function writeInstanceGleaningState(root: string, state: OntologyInstanceGleaningState): Promise<void> {
  const file = resolveWorkspaceFile(root, ONTOLOGY_INSTANCE_GLEANING_FILE);
  const tmp = path.join(path.dirname(file), `.instance-gleaning-${randomUUID()}.tmp`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const existing = await readJsonIfExists(file);
  const scenarioStates = normalizeInstanceGleaningScenarioStates(existing);
  scenarioStates[state.scenarioId] = persistedInstanceGleaningState(state);
  const persisted = { scenarioStates };
  await fs.writeFile(tmp, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, file);
}

function assertScenarioId(input: OntologyInstanceGleaningInput, current: OntologyScenarioCard): void {
  const scenarioId = input.scenario_id?.trim();
  if (scenarioId && scenarioId !== current.id) {
    throw new Error(`Current processing scenario is ${current.id}, not ${scenarioId}.`);
  }
}

export async function updateOntologyInstanceGleaning(root: string, input: OntologyInstanceGleaningInput): Promise<OntologyInstanceGleaningState> {
  const scenarioCards = await readOntologyScenarioCards(root);
  if (!scenarioCards) throw new Error("No scenario cards queue found. Call ontology_update_scenario_cards set_queue first.");
  const current = currentProcessingScenario(scenarioCards);
  assertScenarioId(input, current);

  if (input.operation === "reset") {
    const state = initialInstanceGleaningState(current);
    await writeInstanceGleaningState(root, state);
    return withInstanceGleaningComputedFields(state);
  }

  let state = await readInstanceGleaningState(root, current);
  if (input.operation === "status") {
    return withInstanceGleaningComputedFields(state);
  }

  const currentSnapshot = await scanOntologyInstanceSnapshot(root);

  if (state.activeRound) {
    const completedAt = new Date().toISOString();
    const round: OntologyInstanceGleaningRound = {
      round: state.activeRound.round,
      startedAt: state.activeRound.startedAt,
      completedAt,
      beforeCounts: state.activeRound.beforeCounts,
      afterCounts: currentSnapshot.beforeCounts,
      addedObjectInstanceIds: idDifference(currentSnapshot.objectInstanceIds, state.activeRound.objectInstanceIds),
      addedLinkInstanceIds: idDifference(currentSnapshot.linkInstanceIds, state.activeRound.linkInstanceIds),
    };
    state = {
      ...state,
      rounds: [...state.rounds.filter((item) => item.round !== round.round), round].sort((a, b) => a.round - b.round),
      completedRounds: Math.max(state.completedRounds, round.round),
      activeRound: undefined,
    };
  }

  if (state.completedRounds >= state.maxRounds) {
    await writeInstanceGleaningState(root, state);
    return withInstanceGleaningComputedFields(state);
  }

  const round = state.completedRounds + 1;
  state = {
    ...state,
    issuedRounds: round,
    activeRound: {
      round,
      startedAt: new Date().toISOString(),
      ...currentSnapshot,
    },
    prompt: instanceGleaningPrompt(current, round, state.maxRounds),
  };
  await writeInstanceGleaningState(root, state);
  return withInstanceGleaningComputedFields(state);
}

async function assertInstanceGleaningComplete(root: string, scenarioId: string): Promise<void> {
  const scenarioCards = await readOntologyScenarioCards(root);
  if (!scenarioCards) throw new Error("No scenario cards queue found. Call set_queue first.");
  const current = currentProcessingScenario(scenarioCards);
  if (current.id !== scenarioId) throw new Error(`Cannot complete ${scenarioId}; current processing scenario is ${current.id}.`);
  const state = await readInstanceGleaningState(root, current);
  if (state.completedRounds < state.maxRounds) {
    throw new Error(`Instance gleaning is incomplete for scenario ${scenarioId}: completed ${state.completedRounds}/${state.maxRounds}. Call ontology_instance_gleaning next until it reports complete before complete_current.`);
  }
}

async function writeOntologyScenarioCards(root: string, doc: OntologyScenarioCardsDoc): Promise<void> {
  validateScenarioQueue(doc.scenario_cards);
  const file = resolveWorkspaceFile(root, ONTOLOGY_SCENARIO_CARDS_FILE);
  const tmp = path.join(path.dirname(file), `.scenario-cards-${randomUUID()}.tmp`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, file);
}

export async function readOntologyScenarioCards(root: string): Promise<OntologyScenarioCardsDoc | null> {
  const value = await readJsonIfExists(resolveWorkspaceFile(root, ONTOLOGY_SCENARIO_CARDS_FILE));
  return value === null ? null : normalizeScenarioCardsDoc(value);
}

export async function updateOntologyScenarioCards(root: string, input: OntologyScenarioCardsUpdateInput): Promise<OntologyScenarioCardsState> {
  switch (input.operation) {
    case "status": {
      const current = await readOntologyScenarioCards(root);
      return scenarioCardsState(current, Boolean(current));
    }
    case "set_queue": {
      if (!Array.isArray(input.scenario_cards) || input.scenario_cards.length === 0) {
        throw new Error("set_queue requires a non-empty scenario_cards array.");
      }
      const incoming = input.scenario_cards.map(normalizeSetQueueScenarioCard);
      const seen = new Set<string>();
      for (const card of incoming) {
        if (seen.has(card.id)) throw new Error(`Duplicate scenario id: ${card.id}.`);
        seen.add(card.id);
      }
      let current: OntologyScenarioCardsDoc | null = null;
      try {
        current = await readOntologyScenarioCards(root);
      } catch {
        current = null;
      }
      if (current?.scenario_cards.some((card) => card.status === "processing")) {
        throw new Error("Cannot reset the scenario queue while a scenario is processing. Complete the current scenario first.");
      }
      const completedIds = current?.scenario_cards.filter((card) => card.status === "success").map((card) => card.id) ?? [];
      for (let index = 0; index < completedIds.length; index += 1) {
        if (incoming[index]?.id !== completedIds[index]) {
          throw new Error("set_queue must preserve already successful scenarios at the start of the queue.");
        }
      }
      const completedIdSet = new Set(completedIds);
      const next: OntologyScenarioCardsDoc = {
        scenario_cards: incoming.map((card) => ({
          ...card,
          status: completedIdSet.has(card.id) ? "success" : "pending",
        })),
      };
      await writeOntologyScenarioCards(root, next);
      return scenarioCardsState(next, true);
    }
    case "start_next": {
      const current = await readOntologyScenarioCards(root);
      if (!current) throw new Error("No scenario cards queue found. Call set_queue first.");
      const index = current.scenario_cards.findIndex((card) => card.status !== "success");
      if (index < 0) return scenarioCardsState(current, true);
      const card = current.scenario_cards[index];
      if (card.status === "processing") return scenarioCardsState(current, true);
      const next: OntologyScenarioCardsDoc = {
        scenario_cards: current.scenario_cards.map((item, itemIndex) => itemIndex === index ? { ...item, status: "processing" } : item),
      };
      await writeOntologyScenarioCards(root, next);
      return scenarioCardsState(next, true);
    }
    case "complete_current": {
      const scenarioId = input.scenario_id?.trim();
      if (!scenarioId) throw new Error("complete_current requires scenario_id.");
      const current = await readOntologyScenarioCards(root);
      if (!current) throw new Error("No scenario cards queue found. Call set_queue first.");
      const index = current.scenario_cards.findIndex((card) => card.status !== "success");
      if (index < 0) throw new Error("All scenarios are already success.");
      const card = current.scenario_cards[index];
      if (card.status !== "processing") throw new Error(`Scenario ${card.id} is not processing. Call start_next first.`);
      if (card.id !== scenarioId) throw new Error(`Cannot complete ${scenarioId}; current processing scenario is ${card.id}.`);
      await assertInstanceGleaningComplete(root, scenarioId);
      const next: OntologyScenarioCardsDoc = {
        scenario_cards: current.scenario_cards.map((item, itemIndex) => itemIndex === index ? { ...item, status: "success" } : item),
      };
      await writeOntologyScenarioCards(root, next);
      return scenarioCardsState(next, true);
    }
  }
}

export async function readTree(root: string, dir = "."): Promise<OntologyFileNode[]> {
  const fullDir = resolveWorkspaceFile(root, dir);
  const entries = await fs.readdir(fullDir, { withFileTypes: true }).catch(() => []);
  const nodes = await Promise.all(entries.map(async (entry): Promise<OntologyFileNode | null> => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return null;
    const normalizedDir = dir === "." ? "" : dir.replace(/\\/g, "/");
    const rel = path.posix.join(normalizedDir, entry.name);
    if (entry.isDirectory()) {
      return { name: entry.name, path: rel, type: "dir" as const, children: await readTree(root, rel) };
    }
    return { name: entry.name, path: rel, type: "file" as const };
  }));
  const visibleNodes = nodes.filter((node): node is OntologyFileNode => Boolean(node));
  return visibleNodes.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);
}

export async function readWorkspaceTree(root: string): Promise<OntologyFileNode[]> {
  return readTree(root, ".");
}

export async function readContentTree(root: string): Promise<OntologyFileNode[]> {
  return readTree(root, await contentRootForRead(root));
}

export async function readFile(root: string, requested: string): Promise<string> {
  return fs.readFile(resolveWorkspaceFile(root, requested), "utf-8");
}

export async function writeFile(root: string, requested: string, content: string): Promise<string> {
  const file = resolveWorkspaceFile(root, requested);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf-8");
  return requested.replace(/\\/g, "/");
}

export async function appendWikiNote(root: string, prompt: string, answer: string): Promise<void> {
  const contentRoot = await contentRootForRead(root);
  const index = resolveWorkspaceFile(root, `${contentRoot}/log.md`);
  const stamp = new Date().toISOString();
  await fs.mkdir(path.dirname(index), { recursive: true });
  await fs.appendFile(index, `\n\n## Agent note ${stamp}\n\n**User:** ${prompt}\n\n${answer}\n`, "utf-8");
}


export async function countMarkdownFiles(root: string, dir?: string): Promise<number> {
  const targetDir = dir ?? await contentRootForRead(root);
  return countMarkdownFilesInDir(root, targetDir);
}

async function countMarkdownFilesInDir(root: string, dir: string): Promise<number> {
  const fullDir = resolveWorkspaceFile(root, dir);
  const entries = await fs.readdir(fullDir, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (entry.name === ".runtime" || entry.name === "node_modules" || entry.name === ".git") continue;
    const normalizedDir = dir === "." ? "" : dir.replace(/\\/g, "/");
    const rel = path.posix.join(normalizedDir, entry.name);
    if (entry.isDirectory()) count += await countMarkdownFilesInDir(root, rel);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) count += 1;
  }
  return count;
}
