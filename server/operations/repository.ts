import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OperationArtifact, OperationLogEntry, OperationRun } from "../../src/contracts/ontology";
import { compareOperationRunsNewestFirst } from "../../src/lib/operation-run-order";
import { resolveWorkspaceFile } from "../ontologies/workspace";
import type { AppendOperationLogInput, FinishOperationRunFromAgentInput, FinishOperationRunInput, ListOperationRunsOptions, OperationRunCreateResult, OperationRunStore, OperationRunStoreContext, StartOperationRunInput, StoredOperationRun } from "./store";
import { assertOperationId, createOperationId, isOperationId, operationWorkspacePaths, parseOperationErrorCode, resolveOperationFinishOutcome } from "./model";

const OPERATION_RUNTIME_DIR = ".runtime/operations";

export interface CreateOperationRunInput {
  tenantId?: string;
  ownerId?: string;
  ontologyId: string;
  sessionId: string;
  agentRunId?: string;
  userRequest: string;
  title?: string;
  now?: Date;
}

export interface FileOperationRun extends OperationRun {
  tenantId?: string;
  ownerId?: string;
  agentRunId?: string;
}

export interface FileOperationRunCreateResult {
  run: FileOperationRun;
  operationPath: string;
  reportPath: string;
  artifactsDir: string;
}

export interface FileListOperationRunsOptions {
  sessionId?: string;
  search?: string;
  limit?: number;
  cursor?: { startedAt: string; id: string };
}

function isBeforeCursor(run: OperationRun, cursor: { startedAt: string; id: string }): boolean {
  return run.startedAt < cursor.startedAt || (run.startedAt === cursor.startedAt && run.id < cursor.id);
}

function matchesSearch(run: OperationRun, search: string): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [run.title, run.userRequest, run.resultSummary]
    .some((value) => value?.toLocaleLowerCase().includes(needle));
}

function relativeOperationPath(operationId: string): string {
  assertOperationId(operationId);
  return path.posix.join(OPERATION_RUNTIME_DIR, `${operationId}.json`);
}

function workspaceRelativePath(root: string, requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  const normalized = requested.replace(/\\/g, "/");
  resolveWorkspaceFile(root, normalized);
  return normalized;
}

function uniqueArtifacts(artifacts: OperationArtifact[]): OperationArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.path)) return false;
    seen.add(artifact.path);
    return true;
  });
}

function normalizeOperationRun(value: unknown): FileOperationRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operation run file");
  const record = value as Partial<FileOperationRun>;
  if (typeof record.id !== "string" || !isOperationId(record.id)) throw new Error("Invalid operation run id");
  if (
    typeof record.ontologyId !== "string" || !record.ontologyId ||
    typeof record.sessionId !== "string" || !record.sessionId ||
    typeof record.userRequest !== "string" || !record.userRequest ||
    typeof record.startedAt !== "string" || !record.startedAt
  ) throw new Error("Invalid operation run shape");
  if (record.status !== "running" && record.status !== "succeeded" && record.status !== "failed" && record.status !== "cancelled") throw new Error("Invalid operation status");
  const logs: OperationLogEntry[] = Array.isArray(record.logs)
    ? record.logs
        .filter((log): log is OperationLogEntry => Boolean(log && typeof log === "object" && !Array.isArray(log) && typeof log.at === "string" && typeof log.summary === "string"))
        .map((log) => ({ at: log.at, summary: log.summary, path: typeof log.path === "string" ? log.path : undefined }))
    : [];
  const artifacts: OperationArtifact[] = Array.isArray(record.artifacts)
    ? record.artifacts
        .filter((artifact): artifact is OperationArtifact => Boolean(artifact && typeof artifact === "object" && !Array.isArray(artifact) && typeof artifact.path === "string"))
        .map((artifact) => ({ path: artifact.path, description: typeof artifact.description === "string" ? artifact.description : undefined }))
    : [];
  return {
    id: record.id,
    tenantId: typeof record.tenantId === "string" ? record.tenantId : undefined,
    ownerId: typeof record.ownerId === "string" ? record.ownerId : undefined,
    ontologyId: record.ontologyId,
    sessionId: record.sessionId,
    agentRunId: typeof record.agentRunId === "string" ? record.agentRunId : undefined,
    userRequest: record.userRequest,
    status: record.status,
    title: typeof record.title === "string" ? record.title : undefined,
    logs,
    artifacts: uniqueArtifacts(artifacts),
    resultSummary: typeof record.resultSummary === "string" ? record.resultSummary : undefined,
    reportPath: typeof record.reportPath === "string" ? record.reportPath : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    errorCode: parseOperationErrorCode(record.errorCode),
    startedAt: record.startedAt,
    finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : undefined,
  };
}

async function writeOperationRun(root: string, run: OperationRun): Promise<void> {
  const file = resolveWorkspaceFile(root, relativeOperationPath(run.id));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(run, null, 2), "utf-8");
}

export async function createOperationRun(root: string, input: CreateOperationRunInput): Promise<FileOperationRunCreateResult> {
  const now = input.now ?? new Date();
  const operationId = createOperationId({ title: input.title, userRequest: input.userRequest, now });
  const paths = operationWorkspacePaths(operationId);
  const artifactDir = resolveWorkspaceFile(root, paths.artifactsDir);
  await fs.mkdir(artifactDir, { recursive: true });

  const run: FileOperationRun = {
    id: operationId,
    tenantId: input.tenantId,
    ownerId: input.ownerId,
    ontologyId: input.ontologyId,
    sessionId: input.sessionId,
    agentRunId: input.agentRunId,
    userRequest: input.userRequest,
    status: "running",
    title: input.title,
    logs: [{ at: now.toISOString(), summary: "Operation started." }],
    artifacts: [],
    startedAt: now.toISOString(),
  };
  await writeOperationRun(root, run);
  return {
    run,
    operationPath: relativeOperationPath(operationId),
    reportPath: paths.reportPath,
    artifactsDir: paths.artifactsDir,
  };
}

export async function readOperationRun(root: string, operationId: string): Promise<FileOperationRun> {
  const file = resolveWorkspaceFile(root, relativeOperationPath(operationId));
  const raw = await fs.readFile(file, "utf-8");
  return normalizeOperationRun(JSON.parse(raw));
}

export async function listOperationRuns(
  root: string,
  options: FileListOperationRunsOptions = {},
): Promise<FileOperationRun[]> {
  const directory = resolveWorkspaceFile(root, OPERATION_RUNTIME_DIR);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const runs = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry): Promise<OperationRun | null> => {
      try {
        const raw = await fs.readFile(resolveWorkspaceFile(root, path.posix.join(OPERATION_RUNTIME_DIR, entry.name)), "utf-8");
        return normalizeOperationRun(JSON.parse(raw));
      } catch (error) {
        console.warn(`[operations] skipping invalid operation record ${entry.name}:`, error instanceof Error ? error.message : String(error));
        return null;
      }
    }));

  return runs
    .filter((run): run is OperationRun => Boolean(run))
    .filter((run) => !options.sessionId || run.sessionId === options.sessionId)
    .filter((run) => !options.search || matchesSearch(run, options.search))
    .filter((run) => !options.cursor || isBeforeCursor(run, options.cursor))
    .sort(compareOperationRunsNewestFirst)
    .slice(0, options.limit);
}

export async function updateOperationRunTitle(root: string, operationId: string, title: string): Promise<FileOperationRun> {
  const run = await readOperationRun(root, operationId);
  run.title = title.trim();
  await writeOperationRun(root, run);
  return run;
}

export async function deleteOperationRun(root: string, operationId: string): Promise<void> {
  assertOperationId(operationId);
  await fs.rm(resolveWorkspaceFile(root, operationWorkspacePaths(operationId).publicDirectory), { recursive: true, force: true });
  await fs.rm(resolveWorkspaceFile(root, relativeOperationPath(operationId)));
}

export async function appendOperationLog(root: string, input: AppendOperationLogInput): Promise<FileOperationRun> {
  const run = await readOperationRun(root, input.operationId);
  if (run.status !== "running") throw new Error(`Operation ${input.operationId} is already ${run.status}`);
  const now = new Date().toISOString();
  const logPath = workspaceRelativePath(root, input.path);
  run.logs.push({ at: now, summary: input.summary, path: logPath });
  if (input.artifact && logPath) {
    run.artifacts = uniqueArtifacts([
      ...run.artifacts,
      {
        path: logPath,
        description: input.artifactDescription ?? input.summary,
      },
    ]);
  }
  await writeOperationRun(root, run);
  return run;
}

export async function finishOperationRun(root: string, input: FinishOperationRunInput): Promise<FileOperationRun> {
  const run = await readOperationRun(root, input.operationId);
  if (run.status !== "running") throw new Error(`Operation ${input.operationId} is already ${run.status}`);
  const now = new Date().toISOString();
  let savedReportPath = run.reportPath;
  if (input.reportMarkdown?.trim()) {
    savedReportPath = operationWorkspacePaths(input.operationId).reportPath;
    const file = resolveWorkspaceFile(root, savedReportPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, input.reportMarkdown.trimEnd() + "\n", "utf-8");
    run.artifacts = uniqueArtifacts([
      ...run.artifacts,
      {
        path: savedReportPath,
        description: "Operation report",
      },
    ]);
  }
  run.status = input.status;
  run.resultSummary = input.resultSummary;
  run.reportPath = savedReportPath;
  const outcome = resolveOperationFinishOutcome(input);
  run.error = outcome.error;
  run.errorCode = input.errorCode;
  run.finishedAt = now;
  run.logs.push({
    at: now,
    summary: outcome.logSummary,
    path: savedReportPath,
  });
  await writeOperationRun(root, run);
  return run;
}

export function operationPaths(operationId: string): { operationPath: string; reportPath: string; artifactsDir: string } {
  assertOperationId(operationId);
  const paths = operationWorkspacePaths(operationId);
  return {
    operationPath: relativeOperationPath(operationId),
    reportPath: paths.reportPath,
    artifactsDir: paths.artifactsDir,
  };
}

export class FileOperationRunStore implements OperationRunStore {
  constructor(private readonly context: OperationRunStoreContext) {}

  private withCallerScope(run: FileOperationRun): StoredOperationRun {
    return {
      ...run,
      tenantId: run.tenantId ?? this.context.tenantId,
      ownerId: run.ownerId ?? this.context.ownerId,
    };
  }

  async create(input: StartOperationRunInput): Promise<OperationRunCreateResult> {
    const created = await createOperationRun(this.context.workspaceRoot, {
      tenantId: this.context.tenantId,
      ownerId: this.context.ownerId,
      ontologyId: this.context.knowledgeBaseId,
      sessionId: input.conversationId,
      agentRunId: input.agentRunId,
      userRequest: input.userRequest,
      title: input.title,
      now: input.now,
    });
    return {
      run: this.withCallerScope(created.run),
      reportPath: created.reportPath,
      artifactsDir: created.artifactsDir,
    };
  }

  async read(operationId: string): Promise<StoredOperationRun> {
    return this.withCallerScope(await readOperationRun(this.context.workspaceRoot, operationId));
  }

  async list(options: ListOperationRunsOptions = {}): Promise<StoredOperationRun[]> {
    return (await listOperationRuns(this.context.workspaceRoot, {
      sessionId: options.conversationId,
      search: options.search,
      limit: options.limit,
      cursor: options.cursor,
    })).map((run) => this.withCallerScope(run));
  }

  async updateTitle(operationId: string, title: string): Promise<StoredOperationRun> {
    return this.withCallerScope(await updateOperationRunTitle(this.context.workspaceRoot, operationId, title));
  }

  delete(operationId: string): Promise<void> {
    return deleteOperationRun(this.context.workspaceRoot, operationId);
  }

  async appendLog(input: AppendOperationLogInput): Promise<StoredOperationRun> {
    return this.withCallerScope(await appendOperationLog(this.context.workspaceRoot, input));
  }

  async finish(input: FinishOperationRunInput): Promise<StoredOperationRun> {
    return this.withCallerScope(await finishOperationRun(this.context.workspaceRoot, input));
  }

  async finishFromAgentRun(input: FinishOperationRunFromAgentInput): Promise<StoredOperationRun | null> {
    const run = (await listOperationRuns(this.context.workspaceRoot, { sessionId: input.conversationId }))
      .find((candidate) => candidate.agentRunId === input.agentRunId);
    if (!run) return null;
    if (run.status !== "running") return this.withCallerScope(run);
    return this.finish({
      operationId: run.id,
      status: input.status,
      resultSummary: input.resultSummary,
      error: input.error,
      errorCode: input.errorCode,
    });
  }

}
