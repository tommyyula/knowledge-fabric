import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../env";
import {
  markitdownConverter,
  type MarkitdownConversionResult,
} from "../files/markitdown-converter";
import { resolveWorkspaceFile, workspacePath } from "../ontologies/workspace";
import { getProjectById } from "../ontologies/repository";
import { isSystemMetadataUploadPath } from "../uploads/system-files";
import { lookupIamUserDisplay } from "../auth/requireTenantContext";

export type ResourceType =
  "repo" | "doc" | "api" | "file" | "image" | "spreadsheet" | "website";
export type ResourceStatus = "unused" | "linked" | "outdated";

export interface ResourceFolderRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  parentId?: string;
}

export interface ResourceRecord {
  id: string;
  name: string;
  type: ResourceType;
  description: string;
  lastSynced: string;
  status: ResourceStatus;
  linkedOntologies: string[];
  size: number;
  source: "upload" | "resource-library" | "bitbucket";
  fileSize: string;
  folder?: string;
  objectKey?: string;
  bitbucket?: BitbucketRepositoryReference;
  contentType?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface ResourceBindingRecord {
  resourceId: string;
  ontologyId: string;
  rawRoot: string;
  rawPaths: string[];
  createdAt: string;
  updatedAt: string;
}

export type PublicResourceRecord = Omit<
  ResourceRecord,
  "objectKey" | "deletedAt"
> & { uploaderUserId?: string; uploaderTenantId?: string; shared?: boolean };
export interface ResourceObjectReadResult {
  resource: PublicResourceRecord;
  data: Buffer;
  folderPath: string[];
}

interface ResourceLibraryStore {
  resources: ResourceRecord[];
  folders: ResourceFolderRecord[];
  bindings: ResourceBindingRecord[];
}

export class ResourceInUseError extends Error {
  readonly ontologyIds: string[];

  constructor(ontologyIds: string[]) {
    super("Resource is linked to an active Knowledge Base");
    this.name = "ResourceInUseError";
    this.ontologyIds = ontologyIds;
  }
}

async function activeBindingOntologyIds(store: ResourceLibraryStore, resourceIds: ReadonlySet<string>): Promise<string[]> {
  const ontologyIds = [...new Set(store.bindings.filter((binding) => resourceIds.has(binding.resourceId)).map((binding) => binding.ontologyId))];
  const projects = await Promise.all(ontologyIds.map((ontologyId) => getProjectById(ontologyId)));
  return ontologyIds.filter((_ontologyId, index) => Boolean(projects[index] && !projects[index]?.deletedAt));
}

export interface ResourceLibrarySnapshot {
  resources: PublicResourceRecord[];
  folders: ResourceFolderRecord[];
}

export type ResourceUploadResult =
  | PublicResourceRecord
  | {
      folder: ResourceFolderRecord;
      resources: PublicResourceRecord[];
      extracted: true;
    }
  | {
      resources: PublicResourceRecord[];
      ignored: true;
    };

const TEXT_RESOURCE_EXTENSIONS = new Set([
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
const storeWriteLocks = new Map<string, Promise<void>>();
const storeLockTimeoutMs = 30_000;
const storeLockStaleMs = 60_000;

function scopeRoot(tenantId: string, ownerId: string): string {
  return path.join(
    env.resourceLibraryRoot,
    "resource-library",
    "tenants",
    safeSegment(tenantId),
    "users",
    safeSegment(ownerId),
  );
}

export interface BitbucketRepositoryReference {
  workspace: string;
  repoSlug: string;
  defaultBranch: string;
}

export function resourceLibraryUserDirectory(
  tenantId: string,
  ownerId: string,
): string {
  return scopeRoot(tenantId, ownerId);
}

function storePath(tenantId: string, ownerId: string): string {
  return path.join(scopeRoot(tenantId, ownerId), "metadata.json");
}

function objectRoot(tenantId: string, ownerId: string): string {
  return path.join(scopeRoot(tenantId, ownerId), "objects");
}

function objectPath(
  tenantId: string,
  ownerId: string,
  objectKey: string,
): string {
  return path.join(objectRoot(tenantId, ownerId), objectKey);
}

export function bitbucketRepositoryCacheDirectory(
  tenantId: string,
  ownerId: string,
  resourceId: string,
): string {
  return path.join(
    resourceLibraryUserDirectory(tenantId, ownerId),
    "repos",
    safeSegment(resourceId),
  );
}

function storeLockKey(tenantId: string, ownerId: string): string {
  return `${safeSegment(tenantId)}\u0000${safeSegment(ownerId)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireStoreFileLock(
  tenantId: string,
  ownerId: string,
): Promise<() => Promise<void>> {
  const dir = path.dirname(storePath(tenantId, ownerId));
  const lockDir = path.join(dir, ".metadata.lock");
  const startedAt = Date.now();
  let attempt = 0;
  await fs.mkdir(dir, { recursive: true });

  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs
        .writeFile(
          path.join(lockDir, "owner.json"),
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          "utf8",
        )
        .catch(() => undefined);
      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const stat = await fs.stat(lockDir).catch((statErr) => {
        if ((statErr as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw statErr;
      });
      if (stat && Date.now() - stat.mtimeMs > storeLockStaleMs) {
        await fs
          .rm(lockDir, { recursive: true, force: true })
          .catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt > storeLockTimeoutMs)
        throw new Error("Timed out waiting for resource library metadata lock");
      attempt += 1;
      await sleep(Math.min(250, 25 + attempt * 10));
    }
  }
}

async function withStoreWriteLock<T>(
  tenantId: string,
  ownerId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = storeLockKey(tenantId, ownerId);
  const previous = storeWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  storeWriteLocks.set(key, current);
  await previous.catch(() => undefined);
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquireStoreFileLock(tenantId, ownerId);
    return await task();
  } finally {
    try {
      if (releaseFileLock) await releaseFileLock();
    } finally {
      release();
      if (storeWriteLocks.get(key) === current) storeWriteLocks.delete(key);
    }
  }
}

async function deleteResourceObjects(
  tenantId: string,
  ownerId: string,
  resources: Pick<ResourceRecord, "objectKey">[],
): Promise<void> {
  const objectKeys = Array.from(
    new Set(
      resources
        .map((resource) => resource.objectKey)
        .filter((key): key is string => Boolean(key)),
    ),
  );
  await Promise.all(
    objectKeys.map((objectKey) =>
      fs.rm(objectPath(tenantId, ownerId, objectKey), { force: true }),
    ),
  );
}

function normalizeRelativePath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (
    !normalized ||
    normalized.includes("://") ||
    normalized.split("/").includes("..")
  )
    throw new Error("Invalid resource binding path");
  return normalized;
}

function isSameOrChildPath(value: string, root: string): boolean {
  return value === root || value.startsWith(`${root}/`);
}

function legacyRawRootForResource(resourceId: string): string {
  return path.posix.join("raw", "resources", safeFilename(resourceId));
}

function safeSegment(value: string): string {
  return value.replace(/[^\w.-]/g, "_").slice(0, 120) || "default";
}

function safeFilename(name: string): string {
  const base = path
    .basename(name.replace(/\\/g, "/"))
    .replace(/[^\p{L}\p{N}_.\- ()]/gu, "_")
    .trim();
  if (!base || base === "." || base === "..")
    return `resource-${Date.now()}.bin`;
  return base.length > 180
    ? `${base.slice(0, 120)}-${Date.now()}${path.extname(base).slice(0, 20)}`
    : base;
}

function archiveFolderName(name: string): string {
  const filename = safeFilename(name);
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  return stem.trim() || `archive-${Date.now()}`;
}

export function inferResourceType(name: string): ResourceType {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext))
    return "image";
  if (["xlsx", "xls", "csv"].includes(ext)) return "spreadsheet";
  if (["pdf", "doc", "docx", "md", "txt"].includes(ext)) return "doc";
  if (["yaml", "yml", "json"].includes(ext)) return "api";
  return "file";
}

export function formatFileSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function publicResource(resource: ResourceRecord): PublicResourceRecord {
  const {
    objectKey: _objectKey,
    deletedAt: _deletedAt,
    ...safeResource
  } = resource;
  void _objectKey;
  void _deletedAt;
  return {
    ...safeResource,
    lastSynced: resource.updatedAt || resource.lastSynced,
    fileSize: resource.fileSize || formatFileSize(resource.size),
  };
}

function publicResourceWithBindings(
  resource: ResourceRecord,
  bindingOntologyIds: readonly string[],
): PublicResourceRecord {
  const linkedOntologies = Array.from(
    new Set([...resource.linkedOntologies, ...bindingOntologyIds]),
  ).sort();
  return publicResource({
    ...resource,
    linkedOntologies,
    status: linkedOntologies.length ? "linked" : resource.status,
  });
}

function isResourceBindingRecord(
  value: unknown,
): value is ResourceBindingRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ResourceBindingRecord>;
  return (
    typeof record.resourceId === "string" &&
    typeof record.ontologyId === "string" &&
    typeof record.rawRoot === "string" &&
    Array.isArray(record.rawPaths) &&
    record.rawPaths.every((item) => typeof item === "string") &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

async function readStore(
  tenantId: string,
  ownerId: string,
): Promise<ResourceLibraryStore> {
  const file = storePath(tenantId, ownerId);
  try {
    const parsed = JSON.parse(
      await fs.readFile(file, "utf8"),
    ) as Partial<ResourceLibraryStore>;
    return {
      resources: parsed.resources ?? [],
      folders: parsed.folders ?? [],
      bindings: Array.isArray(parsed.bindings)
        ? parsed.bindings.filter(isResourceBindingRecord)
        : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { resources: [], folders: [], bindings: [] };
    throw err;
  }
}

async function readExistingStore(
  tenantId: string,
  ownerId: string,
): Promise<ResourceLibraryStore | null> {
  try {
    await fs.access(storePath(tenantId, ownerId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return readStore(tenantId, ownerId);
}

async function writeStore(
  tenantId: string,
  ownerId: string,
  store: ResourceLibraryStore,
): Promise<void> {
  const file = storePath(tenantId, ownerId);
  const dir = path.dirname(file);
  const tempFile = path.join(
    dir,
    `.metadata-${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tempFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await fs.rename(tempFile, file);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function updateStore<T>(
  tenantId: string,
  ownerId: string,
  updater: (store: ResourceLibraryStore) => Promise<T> | T,
): Promise<T> {
  return withStoreWriteLock(tenantId, ownerId, async () => {
    const store = await readStore(tenantId, ownerId);
    const result = await updater(store);
    await writeStore(tenantId, ownerId, store);
    return result;
  });
}

function bindingKey(
  binding: Pick<ResourceBindingRecord, "resourceId" | "ontologyId" | "rawRoot">,
): string {
  return `${binding.resourceId}\u0000${binding.ontologyId}\u0000${binding.rawRoot}`;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sourceFileDirFromPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let normalized: string;
  try {
    normalized = normalizeRelativePath(value);
  } catch {
    return null;
  }
  const parts = normalized.split("/");
  if (
    parts[0] !== ".runtime" ||
    parts[1] !== "source-files" ||
    !parts[2] ||
    parts[2] === "manifest.json"
  )
    return null;
  return path.posix.join(".runtime", "source-files", parts[2]);
}

function sourceFileDirsForRecord(record: unknown): string[] {
  if (!record || typeof record !== "object") return [];
  const value = record as {
    originalPath?: unknown;
    extractionReportPath?: unknown;
  };
  return [
    sourceFileDirFromPath(value.originalPath),
    sourceFileDirFromPath(value.extractionReportPath),
  ].filter((item): item is string => Boolean(item));
}

function sourceRecordMatchesBinding(
  record: unknown,
  binding: ResourceBindingRecord,
): boolean {
  if (!record || typeof record !== "object") return false;
  const markdownPath = (record as { markdownPath?: unknown }).markdownPath;
  if (typeof markdownPath !== "string") return false;
  let normalizedMarkdown: string;
  try {
    normalizedMarkdown = normalizeRelativePath(markdownPath);
  } catch {
    return false;
  }
  const rawRoot = normalizeRelativePath(binding.rawRoot);
  const rawPaths = new Set(binding.rawPaths.map(normalizeRelativePath));
  return (
    rawPaths.has(normalizedMarkdown) ||
    isSameOrChildPath(normalizedMarkdown, rawRoot)
  );
}

async function cleanupWorkspaceSourceFilesForBinding(
  root: string,
  binding: ResourceBindingRecord,
): Promise<void> {
  const manifestFile = resolveWorkspaceFile(
    root,
    ".runtime/source-files/manifest.json",
  );
  let records: unknown[];
  try {
    const parsed = JSON.parse(
      await fs.readFile(manifestFile, "utf-8"),
    ) as unknown;
    if (!Array.isArray(parsed)) return;
    records = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const removed: unknown[] = [];
  const remaining: unknown[] = [];
  for (const record of records) {
    if (sourceRecordMatchesBinding(record, binding)) removed.push(record);
    else remaining.push(record);
  }
  if (!removed.length) return;

  const remainingDirs = new Set(remaining.flatMap(sourceFileDirsForRecord));
  const removableDirs = Array.from(
    new Set(removed.flatMap(sourceFileDirsForRecord)),
  ).filter((dir) => !remainingDirs.has(dir));

  await fs.writeFile(
    manifestFile,
    `${JSON.stringify(remaining, null, 2)}\n`,
    "utf-8",
  );
  await Promise.all(
    removableDirs.map((dir) =>
      fs.rm(resolveWorkspaceFile(root, dir), { recursive: true, force: true }),
    ),
  );
}

async function deleteWorkspaceBindings(
  tenantId: string,
  ownerId: string,
  bindings: ResourceBindingRecord[],
): Promise<void> {
  const unique = Array.from(
    new Map(bindings.map((binding) => [bindingKey(binding), binding])).values(),
  );
  for (const binding of unique) {
    const root = workspacePath(tenantId, ownerId, binding.ontologyId);
    const rawRoot = normalizeRelativePath(binding.rawRoot);
    await fs.rm(resolveWorkspaceFile(root, rawRoot), {
      recursive: true,
      force: true,
    });
    await cleanupWorkspaceSourceFilesForBinding(root, { ...binding, rawRoot });
  }
}

async function legacyWorkspaceBindingsForResources(
  tenantId: string,
  ownerId: string,
  resourceIds: Set<string>,
  knownBindings: ResourceBindingRecord[],
): Promise<ResourceBindingRecord[]> {
  if (!resourceIds.size) return [];
  const probeWorkspace = workspacePath(
    tenantId,
    ownerId,
    "__resource_binding_probe__",
  );
  const ontologiesRoot = path.dirname(probeWorkspace);
  const ontologies = await fs
    .readdir(ontologiesRoot, { withFileTypes: true })
    .catch(() => []);
  const knownKeys = new Set(knownBindings.map(bindingKey));
  const now = new Date().toISOString();
  const bindings: ResourceBindingRecord[] = [];

  for (const resourceId of resourceIds) {
    const rawRoot = legacyRawRootForResource(resourceId);
    for (const entry of ontologies) {
      if (!entry.isDirectory()) continue;
      const binding: ResourceBindingRecord = {
        resourceId,
        ontologyId: entry.name,
        rawRoot,
        rawPaths: [],
        createdAt: now,
        updatedAt: now,
      };
      if (knownKeys.has(bindingKey(binding))) continue;
      const root = workspacePath(tenantId, ownerId, entry.name);
      if (await fileExists(resolveWorkspaceFile(root, rawRoot)))
        bindings.push(binding);
    }
  }

  return bindings;
}

async function deleteResourceBindingsForIds(
  tenantId: string,
  ownerId: string,
  store: ResourceLibraryStore,
  resourceIds: Set<string>,
): Promise<void> {
  const knownBindings = store.bindings.filter((binding) =>
    resourceIds.has(binding.resourceId),
  );
  const legacyBindings = await legacyWorkspaceBindingsForResources(
    tenantId,
    ownerId,
    resourceIds,
    knownBindings,
  );
  await deleteWorkspaceBindings(tenantId, ownerId, [
    ...knownBindings,
    ...legacyBindings,
  ]);
  store.bindings = store.bindings.filter(
    (binding) => !resourceIds.has(binding.resourceId),
  );
}

export async function recordResourceBinding(
  tenantId: string,
  ownerId: string,
  input: {
    resourceId: string;
    ontologyId: string;
    rawRoot: string;
    rawPaths?: readonly string[];
  },
): Promise<ResourceBindingRecord> {
  const rawRoot = normalizeRelativePath(input.rawRoot);
  const rawPaths = Array.from(
    new Set(
      (input.rawPaths?.length ? input.rawPaths : [rawRoot]).map(
        normalizeRelativePath,
      ),
    ),
  );
  return updateStore(tenantId, ownerId, (store) => {
    const now = new Date().toISOString();
    const resource = store.resources.find(
      (item) => item.id === input.resourceId && !item.deletedAt,
    );
    if (resource) {
      resource.linkedOntologies = Array.from(
        new Set([...resource.linkedOntologies, input.ontologyId]),
      ).sort();
      resource.status = "linked";
      resource.updatedAt = now;
      resource.lastSynced = now;
    }
    const existing = store.bindings.find(
      (binding) =>
        binding.resourceId === input.resourceId &&
        binding.ontologyId === input.ontologyId &&
        binding.rawRoot === rawRoot,
    );
    if (existing) {
      existing.rawPaths = Array.from(
        new Set([...existing.rawPaths, ...rawPaths]),
      );
      existing.updatedAt = now;
      return existing;
    }
    const binding: ResourceBindingRecord = {
      resourceId: input.resourceId,
      ontologyId: input.ontologyId,
      rawRoot,
      rawPaths,
      createdAt: now,
      updatedAt: now,
    };
    store.bindings.push(binding);
    return binding;
  });
}

export async function deleteResourceBindingsForOntology(
  tenantId: string,
  ownerId: string,
  ontologyId: string,
): Promise<number> {
  return withStoreWriteLock(tenantId, ownerId, async () => {
    const store = await readExistingStore(tenantId, ownerId);
    if (!store) return 0;
    const before = store.bindings.length;
    store.bindings = store.bindings.filter(
      (binding) => binding.ontologyId !== ontologyId,
    );
    let changed = before !== store.bindings.length;
    for (const resource of store.resources) {
      if (resource.linkedOntologies.includes(ontologyId)) {
        resource.linkedOntologies = resource.linkedOntologies.filter(
          (id) => id !== ontologyId,
        );
        resource.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    const removed = before - store.bindings.length;
    if (changed) await writeStore(tenantId, ownerId, store);
    return removed;
  });
}

export async function deleteAllResourceBindingsForOntology(ontologyId: string): Promise<number> {
  const tenantsRoot = path.join(env.resourceLibraryRoot, "resource-library", "tenants");
  const tenants = await fs.readdir(tenantsRoot, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const tenant of tenants) {
    if (!tenant.isDirectory()) continue;
    const usersRoot = path.join(tenantsRoot, tenant.name, "users");
    const users = await fs.readdir(usersRoot, { withFileTypes: true }).catch(() => []);
    for (const user of users) {
      if (!user.isDirectory()) continue;
      removed += await deleteResourceBindingsForOntology(tenant.name, user.name, ontologyId);
    }
  }
  return removed;
}

export async function listResourceLibrary(
  tenantId: string,
  ownerId: string,
): Promise<ResourceLibrarySnapshot> {
  const store = await readStore(tenantId, ownerId);
  const bindingOntologiesByResource = new Map<string, string[]>();
  for (const binding of store.bindings) {
    const ontologyIds =
      bindingOntologiesByResource.get(binding.resourceId) ?? [];
    ontologyIds.push(binding.ontologyId);
    bindingOntologiesByResource.set(binding.resourceId, ontologyIds);
  }
  return {
    resources: store.resources
      .filter((resource) => !resource.deletedAt)
      .map((resource) => ({
        ...publicResourceWithBindings(
          resource,
          bindingOntologiesByResource.get(resource.id) ?? [],
        ),
      })),
    folders: store.folders,
  };
}

async function listStoredResourceLibraryScopes(): Promise<Array<{ tenantId: string; ownerId: string }>> {
  const tenantsRoot = path.join(env.resourceLibraryRoot, "resource-library", "tenants");
  const tenants = await fs.readdir(tenantsRoot, { withFileTypes: true }).catch(() => []);
  const scopes: Array<{ tenantId: string; ownerId: string }> = [];
  for (const tenant of tenants) {
    if (!tenant.isDirectory()) continue;
    const usersRoot = path.join(tenantsRoot, tenant.name, "users");
    const users = await fs.readdir(usersRoot, { withFileTypes: true }).catch(() => []);
    for (const user of users) {
      if (user.isDirectory()) scopes.push({ tenantId: tenant.name, ownerId: user.name });
    }
  }
  return scopes;
}

export async function listAccessibleResourceLibrary(
  tenantId: string,
  ownerId: string,
  accessibleOntologyIds: ReadonlySet<string>,
  authorization?: string,
): Promise<ResourceLibrarySnapshot> {
  const own = await listResourceLibrary(tenantId, ownerId);
  const knownResourceIds = new Set(own.resources.map((resource) => resource.id));
  const shared: PublicResourceRecord[] = [];
  for (const scope of await listStoredResourceLibraryScopes()) {
    if (scope.tenantId === safeSegment(tenantId) && scope.ownerId === safeSegment(ownerId)) continue;
    const store = await readExistingStore(scope.tenantId, scope.ownerId);
    if (!store) continue;
    const visibleBindings = new Map<string, string[]>();
    for (const binding of store.bindings) {
      if (!accessibleOntologyIds.has(binding.ontologyId)) continue;
      const ontologyIds = visibleBindings.get(binding.resourceId) ?? [];
      ontologyIds.push(binding.ontologyId);
      visibleBindings.set(binding.resourceId, ontologyIds);
    }

    // 查询该 scope 上传者的展示信息（userName + companyName）
    let uploaderDisplayName = scope.ownerId;
    let uploaderCompanyName = scope.tenantId;
    if (authorization && env.iamEnabled) {
      const display = await lookupIamUserDisplay(authorization, scope.ownerId, scope.tenantId).catch(() => null);
      if (display) {
        uploaderDisplayName = display.userName;
        uploaderCompanyName = display.companyName;
      }
    }

    for (const resource of store.resources) {
      const ontologyIds = visibleBindings.get(resource.id);
      if (!ontologyIds?.length || resource.deletedAt || knownResourceIds.has(resource.id)) continue;
      knownResourceIds.add(resource.id);
      shared.push({
        ...publicResourceWithBindings({ ...resource, folder: undefined, linkedOntologies: [] }, ontologyIds),
        uploaderUserId: uploaderDisplayName,
        uploaderTenantId: uploaderCompanyName,
        shared: true,
      });
    }
  }
  return { resources: [...own.resources, ...shared], folders: own.folders };
}

export async function createResourceFolder(
  tenantId: string,
  ownerId: string,
  input: { name: string; parentId?: string },
): Promise<ResourceFolderRecord> {
  return updateStore(tenantId, ownerId, (store) => {
    const now = new Date().toISOString();
    const folder: ResourceFolderRecord = {
      id: `f-${randomUUID()}`,
      name: input.name.trim(),
      createdAt: now,
      updatedAt: now,
      ...(input.parentId ? { parentId: input.parentId } : {}),
    };
    store.folders.unshift(folder);
    return folder;
  });
}

function collectFolderTreeIds(
  folders: ResourceFolderRecord[],
  rootFolderId: string,
): Set<string> {
  const ids = new Set<string>([rootFolderId]);
  const visit = (parentId: string) => {
    for (const folder of folders) {
      if (folder.parentId !== parentId || ids.has(folder.id)) continue;
      ids.add(folder.id);
      visit(folder.id);
    }
  };
  visit(rootFolderId);
  return ids;
}

function folderPathForResource(
  folders: ResourceFolderRecord[],
  folderId: string | undefined,
): string[] {
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const segments: string[] = [];
  const seen = new Set<string>();
  let cursor = folderId ? folderById.get(folderId) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    segments.unshift(cursor.name);
    seen.add(cursor.id);
    cursor = cursor.parentId ? folderById.get(cursor.parentId) : undefined;
  }
  return segments;
}

export async function renameResourceFolder(
  tenantId: string,
  ownerId: string,
  folderId: string,
  name: string,
): Promise<ResourceFolderRecord | null> {
  return updateStore(tenantId, ownerId, (store) => {
    const folder = store.folders.find((item) => item.id === folderId);
    if (!folder) return null;
    folder.name = name.trim();
    folder.updatedAt = new Date().toISOString();
    return folder;
  });
}

export async function deleteResourceFolder(
  tenantId: string,
  ownerId: string,
  folderId: string,
): Promise<boolean> {
  return updateStore(tenantId, ownerId, async (store) => {
    if (!store.folders.some((folder) => folder.id === folderId)) return false;
    const folderIds = collectFolderTreeIds(store.folders, folderId);
    const resourcesToDelete = store.resources.filter(
      (resource) => resource.folder && folderIds.has(resource.folder),
    );
    const resourceIds = new Set(
      resourcesToDelete.map((resource) => resource.id),
    );
    const activeOntologyIds = await activeBindingOntologyIds(store, resourceIds);
    if (activeOntologyIds.length) throw new ResourceInUseError(activeOntologyIds);
    await deleteResourceBindingsForIds(tenantId, ownerId, store, resourceIds);
    await deleteResourceObjects(tenantId, ownerId, resourcesToDelete);
    store.folders = store.folders.filter((folder) => !folderIds.has(folder.id));
    store.resources = store.resources.filter(
      (resource) => !resource.folder || !folderIds.has(resource.folder),
    );
    return true;
  });
}

export async function createResource(
  tenantId: string,
  ownerId: string,
  input: {
    name: string;
    data: Buffer;
    folder?: string;
    contentType?: string;
    description?: string;
  },
): Promise<PublicResourceRecord> {
  const now = new Date().toISOString();
  const id = `r-${randomUUID()}`;
  const filename = safeFilename(input.name);
  const objectKey = `${id}-${filename}`;
  const objectPath = path.join(objectRoot(tenantId, ownerId), objectKey);
  await fs.mkdir(path.dirname(objectPath), { recursive: true });
  await fs.writeFile(objectPath, input.data);

  return updateStore(tenantId, ownerId, (store) => {
    const resource: ResourceRecord = {
      id,
      name: filename,
      type: inferResourceType(filename),
      description: input.description?.trim() || "Uploaded file",
      lastSynced: now,
      status: "unused",
      linkedOntologies: [],
      size: input.data.byteLength,
      source: "upload",
      fileSize: formatFileSize(input.data.byteLength),
      ...(input.folder ? { folder: input.folder } : {}),
      objectKey,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      createdAt: now,
      updatedAt: now,
    };
    store.resources.unshift(resource);
    return publicResource(resource);
  });
}

async function directorySize(directory: string): Promise<number> {
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  let size = 0;
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) size += await directorySize(target);
    else if (entry.isFile()) size += (await fs.stat(target)).size;
  }
  return size;
}

export interface BitbucketRepositoryCachedFile {
  path: string;
  size: number;
}

function cachedRepositoryRelativePath(value: string): string {
  const normalized = normalizeRelativePath(value);
  if (normalized.split("/").includes(".git"))
    throw new Error("Repository Git metadata cannot be previewed");
  return normalized;
}

function cachedRepositoryFilePath(
  tenantId: string,
  ownerId: string,
  resourceId: string,
  relativePath: string,
): string {
  const root = bitbucketRepositoryCacheDirectory(tenantId, ownerId, resourceId);
  const file = path.resolve(
    root,
    ...cachedRepositoryRelativePath(relativePath).split("/"),
  );
  if (!file.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error("Repository preview path escapes cache");
  return file;
}

export async function listBitbucketRepositoryCachedFiles(
  tenantId: string,
  ownerId: string,
  resourceId: string,
): Promise<BitbucketRepositoryCachedFile[]> {
  const root = bitbucketRepositoryCacheDirectory(tenantId, ownerId, resourceId);
  const files: BitbucketRepositoryCachedFile[] = [];
  const walk = async (directory: string, relative = ""): Promise<void> => {
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const nextRelative = relative
        ? path.posix.join(relative, entry.name)
        : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target, nextRelative);
      else if (entry.isFile()) {
        if (files.length >= 10_000)
          throw new Error("Repository contains too many files to preview");
        files.push({ path: nextRelative, size: (await fs.stat(target)).size });
      }
    }
  };
  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function readBitbucketRepositoryCachedFile(
  tenantId: string,
  ownerId: string,
  resourceId: string,
  relativePath: string,
): Promise<{ path: string; content: string; contentType: string } | null> {
  const normalized = cachedRepositoryRelativePath(relativePath);
  const file = cachedRepositoryFilePath(
    tenantId,
    ownerId,
    resourceId,
    normalized,
  );
  let data: Buffer;
  try {
    data = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const likelyText = !data
    .subarray(0, Math.min(data.byteLength, 4096))
    .includes(0);
  return {
    path: normalized,
    content: likelyText
      ? data
          .subarray(0, 2 * 1024 * 1024)
          .toString("utf8")
          .replace(/^\uFEFF/, "")
      : "This repository file is binary and cannot be rendered as text preview.",
    contentType: likelyText
      ? "text/plain; charset=utf-8"
      : "text/markdown; charset=utf-8",
  };
}

export async function updateBitbucketRepositoryCacheSummary(
  tenantId: string,
  ownerId: string,
  resourceId: string,
): Promise<PublicResourceRecord | null> {
  const size = await directorySize(
    bitbucketRepositoryCacheDirectory(tenantId, ownerId, resourceId),
  );
  return updateStore(tenantId, ownerId, (store) => {
    const resource = store.resources.find(
      (item) =>
        item.id === resourceId &&
        item.source === "bitbucket" &&
        !item.deletedAt,
    );
    if (!resource) return null;
    const now = new Date().toISOString();
    resource.size = size;
    resource.fileSize = formatFileSize(size);
    resource.lastSynced = now;
    resource.updatedAt = now;
    return publicResource(resource);
  });
}

export async function createBitbucketRepositoryReference(
  tenantId: string,
  ownerId: string,
  input: {
    name: string;
    workspace: string;
    repoSlug: string;
    defaultBranch: string;
  },
): Promise<PublicResourceRecord> {
  return updateStore(tenantId, ownerId, (store) => {
    const existing = store.resources.find(
      (item) =>
        !item.deletedAt &&
        item.source === "bitbucket" &&
        item.bitbucket?.workspace === input.workspace &&
        item.bitbucket.repoSlug === input.repoSlug,
    );
    if (existing) {
      const error = new Error("Repository already exists in the Resource Library") as Error & { status: number };
      error.status = 409;
      throw error;
    }
    const now = new Date().toISOString();
    const resource: ResourceRecord = {
      id: `r-${randomUUID()}`,
      name: input.name.trim(),
      type: "repo",
      description: `Bitbucket repository · ${input.defaultBranch}`,
      lastSynced: now,
      status: "unused",
      linkedOntologies: [],
      size: 0,
      source: "bitbucket",
      fileSize: "",
      bitbucket: {
        workspace: input.workspace,
        repoSlug: input.repoSlug,
        defaultBranch: input.defaultBranch,
      },
      createdAt: now,
      updatedAt: now,
    };
    store.resources.unshift(resource);
    return publicResource(resource);
  });
}

export async function readBitbucketRepositoryReference(
  tenantId: string,
  ownerId: string,
  resourceId: string,
): Promise<PublicResourceRecord | null> {
  const store = await readStore(tenantId, ownerId);
  const resource = store.resources.find(
    (item) =>
      item.id === resourceId &&
      !item.deletedAt &&
      item.source === "bitbucket" &&
      item.bitbucket,
  );
  return resource ? publicResource(resource) : null;
}

function markdownOutputName(name: string): string {
  const ext = path.extname(name);
  if (!ext || ext.toLowerCase() === ".md" || ext.toLowerCase() === ".markdown")
    return name;
  return `${name.slice(0, -ext.length)}.md`;
}

function safeResourcePath(name: string): string {
  const safePath = name
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map(safeFilename)
    .join("/");
  return safePath || safeFilename(markdownOutputName(name));
}

async function convertUploadToMarkdown(input: {
  name: string;
  data: Buffer;
  contentType?: string;
}): Promise<MarkitdownConversionResult[]> {
  try {
    const converted = await markitdownConverter.convertMany(input);
    const failed = converted.find((item) => {
      const sourceExt = path
        .extname(item.sourceName ?? input.name)
        .toLowerCase();
      return (
        !item.converted && sourceExt && !TEXT_RESOURCE_EXTENSIONS.has(sourceExt)
      );
    });
    if (failed) {
      const source = failed.sourceName ?? input.name;
      const reason = `Markdown conversion failed or was unavailable for ${source}.`;
      const finalError = new Error(
        `Document processing failed for ${input.name}: ${reason}`,
      );
      (finalError as Error & { status?: number }).status = 422;
      throw finalError;
    }
    return converted;
  } catch (error) {
    if (typeof (error as { status?: unknown })?.status === "number")
      throw error;
    const message = error instanceof Error ? error.message : String(error);
    const finalError = new Error(
      `Document processing failed for ${input.name}: ${message}`,
    );
    (finalError as Error & { status?: number }).status = 422;
    throw finalError;
  }
}

async function ensureConvertedFolderPath(
  tenantId: string,
  ownerId: string,
  foldersByPath: Map<string, ResourceFolderRecord>,
  parts: string[],
  rootParentId?: string,
): Promise<string | undefined> {
  let parentId = rootParentId;
  let currentPath = "";
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const existing = foldersByPath.get(currentPath);
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const folder = await createResourceFolder(tenantId, ownerId, {
      name: part,
      ...(parentId ? { parentId } : {}),
    });
    foldersByPath.set(currentPath, folder);
    parentId = folder.id;
  }
  return parentId;
}

async function createConvertedResourceUpload(
  tenantId: string,
  ownerId: string,
  input: {
    name: string;
    data: Buffer;
    folder?: string;
    contentType?: string;
    description?: string;
  },
): Promise<ResourceUploadResult> {
  if (isSystemMetadataUploadPath(input.name))
    return { resources: [], ignored: true };
  const convertedFiles = await convertUploadToMarkdown({
    name: input.name,
    data: input.data,
    contentType: input.contentType,
  });
  if (!convertedFiles.length)
    throw new Error(`Upload ${input.name} did not produce Markdown resources`);

  const normalized = convertedFiles
    .map((converted) => ({
      converted,
      safePath: safeResourcePath(
        converted.outputName || markdownOutputName(input.name),
      ),
    }))
    .filter((item) => !isSystemMetadataUploadPath(item.safePath))
    .sort((a, b) => a.safePath.localeCompare(b.safePath));
  if (!normalized.length) return { resources: [], ignored: true };
  const hasNestedPaths = normalized.some((item) => item.safePath.includes("/"));
  const shouldGroupFlatFiles = normalized.length > 1 && !hasNestedPaths;
  const foldersByPath = new Map<string, ResourceFolderRecord>();
  const flatGroupFolder = shouldGroupFlatFiles
    ? await createResourceFolder(tenantId, ownerId, {
        name: archiveFolderName(input.name),
        ...(input.folder ? { parentId: input.folder } : {}),
      })
    : undefined;
  let rootFolder = flatGroupFolder;
  const resources: PublicResourceRecord[] = [];

  for (const item of normalized) {
    const parts = item.safePath.split("/").filter(Boolean);
    const fileName =
      parts.pop() || safeFilename(markdownOutputName(input.name));
    const folder = parts.length
      ? await ensureConvertedFolderPath(
          tenantId,
          ownerId,
          foldersByPath,
          parts,
          input.folder,
        )
      : (flatGroupFolder?.id ?? input.folder);
    if (!rootFolder && parts.length) rootFolder = foldersByPath.get(parts[0]);
    resources.push(
      await createResource(tenantId, ownerId, {
        name: fileName,
        data: Buffer.from(item.converted.markdown, "utf8"),
        ...(folder ? { folder } : {}),
        contentType: "text/markdown; charset=utf-8",
        description:
          input.description?.trim() ||
          `Converted from ${item.converted.sourceName ?? input.name}`,
      }),
    );
  }

  if (rootFolder) return { folder: rootFolder, resources, extracted: true };
  if (resources[0]) return resources[0];
  throw new Error(
    `Upload ${input.name} did not produce Resource Library entries`,
  );
}

export async function createResourceUpload(
  tenantId: string,
  ownerId: string,
  input: {
    name: string;
    data: Buffer;
    folder?: string;
    contentType?: string;
    description?: string;
  },
): Promise<ResourceUploadResult> {
  return createConvertedResourceUpload(tenantId, ownerId, input);
}

export async function createResourceFromFile(
  tenantId: string,
  ownerId: string,
  input: {
    name: string;
    filePath: string;
    size: number;
    folder?: string;
    contentType?: string;
    description?: string;
  },
): Promise<PublicResourceRecord> {
  const now = new Date().toISOString();
  const id = `r-${randomUUID()}`;
  const filename = safeFilename(input.name);
  const objectKey = `${id}-${filename}`;
  const objectPath = path.join(objectRoot(tenantId, ownerId), objectKey);
  await fs.mkdir(path.dirname(objectPath), { recursive: true });
  await fs.copyFile(input.filePath, objectPath);

  return updateStore(tenantId, ownerId, (store) => {
    const resource: ResourceRecord = {
      id,
      name: filename,
      type: inferResourceType(filename),
      description: input.description?.trim() || "Uploaded file",
      lastSynced: now,
      status: "unused",
      linkedOntologies: [],
      size: input.size,
      source: "upload",
      fileSize: formatFileSize(input.size),
      ...(input.folder ? { folder: input.folder } : {}),
      objectKey,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      createdAt: now,
      updatedAt: now,
    };
    store.resources.unshift(resource);
    return publicResource(resource);
  });
}

export async function createResourceUploadFromFile(
  tenantId: string,
  ownerId: string,
  input: {
    name: string;
    filePath: string;
    size: number;
    folder?: string;
    contentType?: string;
    description?: string;
  },
): Promise<ResourceUploadResult> {
  void input.size;
  return createConvertedResourceUpload(tenantId, ownerId, {
    name: input.name,
    data: await fs.readFile(input.filePath),
    folder: input.folder,
    contentType: input.contentType,
    description: input.description,
  });
}

export async function renameResource(
  tenantId: string,
  ownerId: string,
  resourceId: string,
  input: { name?: string; folder?: string | null },
): Promise<PublicResourceRecord | null> {
  return updateStore(tenantId, ownerId, (store) => {
    const resource = store.resources.find(
      (item) => item.id === resourceId && !item.deletedAt,
    );
    if (!resource) return null;
    if (input.name !== undefined) resource.name = safeFilename(input.name);
    if (input.folder !== undefined) {
      if (input.folder) resource.folder = input.folder;
      else delete resource.folder;
    }
    resource.type = inferResourceType(resource.name);
    resource.updatedAt = new Date().toISOString();
    resource.lastSynced = resource.updatedAt;
    return publicResource(resource);
  });
}

export async function deleteResource(
  tenantId: string,
  ownerId: string,
  resourceId: string,
): Promise<boolean> {
  return updateStore(tenantId, ownerId, async (store) => {
    const resource = store.resources.find((item) => item.id === resourceId);
    if (!resource) return false;
    const activeOntologyIds = await activeBindingOntologyIds(store, new Set([resourceId]));
    if (activeOntologyIds.length) throw new ResourceInUseError(activeOntologyIds);
    await deleteResourceBindingsForIds(
      tenantId,
      ownerId,
      store,
      new Set([resourceId]),
    );
    await deleteResourceObjects(tenantId, ownerId, [resource]);
    if (resource.source === "bitbucket")
      await fs.rm(
        bitbucketRepositoryCacheDirectory(tenantId, ownerId, resource.id),
        { recursive: true, force: true },
      );
    store.resources = store.resources.filter((item) => item.id !== resourceId);
    return true;
  });
}

export async function readResourceObject(
  tenantId: string,
  ownerId: string,
  resourceId: string,
): Promise<ResourceObjectReadResult | null> {
  const store = await readStore(tenantId, ownerId);
  const resource = store.resources.find(
    (item) => item.id === resourceId && !item.deletedAt,
  );
  if (!resource?.objectKey) return null;
  const data = await fs.readFile(
    path.join(objectRoot(tenantId, ownerId), resource.objectKey),
  );
  return {
    resource: publicResource(resource),
    data,
    folderPath: folderPathForResource(store.folders, resource.folder),
  };
}

export async function readAccessibleResourceObject(
  tenantId: string,
  ownerId: string,
  resourceId: string,
  accessibleOntologyIds: ReadonlySet<string>,
): Promise<ResourceObjectReadResult | null> {
  const own = await readResourceObject(tenantId, ownerId, resourceId);
  if (own) return own;
  for (const scope of await listStoredResourceLibraryScopes()) {
    if (scope.tenantId === safeSegment(tenantId) && scope.ownerId === safeSegment(ownerId)) continue;
    const store = await readExistingStore(scope.tenantId, scope.ownerId);
    if (!store) continue;
    const ontologyIds = store.bindings
      .filter((binding) => binding.resourceId === resourceId && accessibleOntologyIds.has(binding.ontologyId))
      .map((binding) => binding.ontologyId);
    if (!ontologyIds.length) continue;
    const resource = store.resources.find((item) => item.id === resourceId && !item.deletedAt);
    if (!resource?.objectKey) return null;
    return {
      resource: {
        ...publicResourceWithBindings({ ...resource, folder: undefined, linkedOntologies: [] }, ontologyIds),
        uploaderTenantId: scope.tenantId,
        uploaderUserId: scope.ownerId,
        shared: true,
      },
      data: await fs.readFile(path.join(objectRoot(scope.tenantId, scope.ownerId), resource.objectKey)),
      folderPath: [],
    };
  }
  return null;
}

export async function readResourceFolderObjects(
  tenantId: string,
  ownerId: string,
  folderId: string,
): Promise<ResourceObjectReadResult[]> {
  const store = await readStore(tenantId, ownerId);
  if (!store.folders.some((item) => item.id === folderId)) return [];
  const folderIds = collectFolderTreeIds(store.folders, folderId);
  const resources = store.resources
    .filter((resource): resource is ResourceRecord & { objectKey: string } =>
      Boolean(
        resource.folder &&
        resource.objectKey &&
        folderIds.has(resource.folder) &&
        !resource.deletedAt,
      ),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const objects: ResourceObjectReadResult[] = [];
  for (const resource of resources) {
    const data = await fs.readFile(
      path.join(objectRoot(tenantId, ownerId), resource.objectKey),
    );
    objects.push({
      resource: publicResource(resource),
      data,
      folderPath: folderPathForResource(store.folders, resource.folder),
    });
  }
  return objects;
}

export async function listResourceBindingsForOntology(
  tenantId: string,
  ownerId: string,
  ontologyId: string,
  resourceIds: readonly string[],
): Promise<ResourceBindingRecord[]> {
  const ids = new Set(resourceIds.filter(Boolean));
  if (!ids.size) return [];
  const store = await readStore(tenantId, ownerId);
  return store.bindings
    .filter(
      (binding) =>
        binding.ontologyId === ontologyId && ids.has(binding.resourceId),
    )
    .map((binding) => ({ ...binding, rawPaths: [...binding.rawPaths] }));
}

export async function getResourceBinding(
  tenantId: string,
  ownerId: string,
  resourceId: string,
  ontologyId: string,
): Promise<ResourceBindingRecord | null> {
  const store = await readStore(tenantId, ownerId);
  return (
    store.bindings.find(
      (binding) =>
        binding.resourceId === resourceId && binding.ontologyId === ontologyId,
    ) ?? null
  );
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  const write = (value: string, offset: number, length: number) =>
    header.write(value.slice(0, length), offset, length, "utf8");
  write(name, 0, 100);
  write("0000644\0", 100, 8);
  write("0000000\0", 108, 8);
  write("0000000\0", 116, 8);
  write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  write(
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0") + "\0",
    136,
    12,
  );
  header.fill(" ", 148, 156);
  write("0", 156, 1);
  write("ustar", 257, 6);
  write("00", 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return header;
}

export async function readFolderArchive(
  tenantId: string,
  ownerId: string,
  folderId: string,
): Promise<{ name: string; data: Buffer } | null> {
  const store = await readStore(tenantId, ownerId);
  const folder = store.folders.find((item) => item.id === folderId);
  if (!folder) return null;
  const folderIds = collectFolderTreeIds(store.folders, folderId);
  const folderById = new Map(store.folders.map((item) => [item.id, item]));
  const archiveNameForResource = (resource: ResourceRecord): string => {
    const segments: string[] = [];
    const seen = new Set<string>();
    let cursor = resource.folder ? folderById.get(resource.folder) : undefined;
    while (cursor && cursor.id !== folderId && !seen.has(cursor.id)) {
      segments.unshift(safeFilename(cursor.name));
      seen.add(cursor.id);
      cursor = cursor.parentId ? folderById.get(cursor.parentId) : undefined;
    }
    return path.posix.join(...segments, safeFilename(resource.name));
  };
  const chunks: Buffer[] = [];
  const resources = store.resources.filter(
    (resource): resource is ResourceRecord & { objectKey: string } =>
      Boolean(
        resource.folder &&
        resource.objectKey &&
        folderIds.has(resource.folder) &&
        !resource.deletedAt,
      ),
  );
  for (const resource of resources) {
    const data = await fs.readFile(
      path.join(objectRoot(tenantId, ownerId), resource.objectKey),
    );
    chunks.push(
      tarHeader(archiveNameForResource(resource), data.byteLength),
      data,
    );
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return {
    name: `${safeFilename(folder.name)}.tar`,
    data: Buffer.concat(chunks),
  };
}
