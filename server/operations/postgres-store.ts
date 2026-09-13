import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import type { OperationArtifact, OperationLogEntry, OperationStatus } from "../../src/contracts/ontology";
import { resolveWorkspaceFile } from "../ontologies/workspace";
import { createOperationId, operationWorkspacePaths, parseOperationErrorCode, resolveOperationFinishOutcome } from "./model";
import { deleteScopedOperationRows, removeOperationRunFilesBestEffort } from "./postgres-deletion";
import type {
  AppendOperationLogInput,
  FinishOperationRunFromAgentInput,
  FinishOperationRunInput,
  ListOperationRunsOptions,
  OperationRunCreateResult,
  OperationRunDatabase,
  OperationRunStore,
  OperationRunStoreContext,
  StartOperationRunInput,
  StoredOperationRun,
} from "./store";

function timestamp(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function operationNotFound(operationId: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Operation ${operationId} not found`), { code: "ENOENT" });
}

function normalizeWorkspacePath(workspaceRoot: string, requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  const normalized = requested.replace(/\\/g, "/");
  resolveWorkspaceFile(workspaceRoot, normalized);
  return normalized;
}

function hydrateStoredOperationRun(input: {
  run: Record<string, unknown>;
  logs: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
}): StoredOperationRun {
  const { run, logs, artifacts } = input;
  return {
    id: String(run.id),
    tenantId: String(run.tenant_id),
    ownerId: String(run.owner_id),
    ontologyId: String(run.knowledge_base_id),
    sessionId: String(run.conversation_id),
    agentRunId: String(run.agent_run_id),
    userRequest: String(run.user_request),
    status: run.status as OperationStatus,
    title: run.title === null ? undefined : String(run.title),
    logs: logs.map((log): OperationLogEntry => ({
      at: timestamp(log.at),
      summary: String(log.summary),
      path: log.path === null ? undefined : String(log.path),
    })),
    artifacts: artifacts.map((artifact): OperationArtifact => ({
      path: String(artifact.path),
      description: artifact.description === null ? undefined : String(artifact.description),
    })),
    resultSummary: run.result_summary === null ? undefined : String(run.result_summary),
    reportPath: run.report_path === null ? undefined : String(run.report_path),
    error: run.error === null ? undefined : String(run.error),
    errorCode: parseOperationErrorCode(run.error_code),
    startedAt: timestamp(run.started_at),
    finishedAt: run.finished_at === null ? undefined : timestamp(run.finished_at),
  };
}

export class PostgresOperationRunStore implements OperationRunStore {
  constructor(
    private readonly context: OperationRunStoreContext,
    private readonly database: OperationRunDatabase,
  ) {}

  private scopeParams(): [string, string, string] {
    return [this.context.tenantId, this.context.ownerId, this.context.knowledgeBaseId];
  }

  private async withTransaction<T>(action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query("begin");
      const result = await action(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockRunningOperation(client: pg.PoolClient, operationId: string): Promise<Record<string, unknown>> {
    const result = await client.query<Record<string, unknown>>(
      `select * from ontology_operation_runs
       where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3 and id=$4 for update`,
      [...this.scopeParams(), operationId],
    );
    const run = result.rows[0];
    if (!run) throw operationNotFound(operationId);
    if (run.status !== "running") throw new Error(`Operation ${operationId} is already ${String(run.status)}`);
    return run;
  }

  private async appendLogRow(
    client: pg.PoolClient,
    input: { operationId: string; at: string; summary: string; path?: string },
  ): Promise<void> {
    await client.query(
      `insert into ontology_operation_logs
         (tenant_id, owner_id, knowledge_base_id, operation_id, sequence, at, summary, path)
       select $1,$2,$3,$4,coalesce(max(sequence),0)+1,$5,$6,$7
       from ontology_operation_logs
       where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3 and operation_id=$4`,
      [...this.scopeParams(), input.operationId, input.at, input.summary, input.path ?? null],
    );
  }

  async create(input: StartOperationRunInput): Promise<OperationRunCreateResult> {
    const now = input.now ?? new Date();
    const operationId = createOperationId({ title: input.title, userRequest: input.userRequest, now });
    const row = await this.withTransaction(async (client) => {
      const inserted = await client.query<Record<string, unknown>>(
        `insert into ontology_operation_runs
           (id, tenant_id, owner_id, knowledge_base_id, conversation_id, agent_run_id, user_request, status, title, started_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$9)
         on conflict (tenant_id, owner_id, knowledge_base_id, conversation_id, agent_run_id) do nothing
         returning *`,
        [operationId, ...this.scopeParams(), input.conversationId, input.agentRunId, input.userRequest, input.title ?? null, now.toISOString()],
      );
      if (inserted.rows[0]) {
        await client.query(
          `insert into ontology_operation_logs
             (tenant_id, owner_id, knowledge_base_id, operation_id, sequence, at, summary)
           values ($1,$2,$3,$4,1,$5,'Operation started.')`,
          [...this.scopeParams(), operationId, now.toISOString()],
        );
        return inserted.rows[0];
      }
      const existing = await client.query<Record<string, unknown>>(
        `select * from ontology_operation_runs
         where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3 and conversation_id=$4 and agent_run_id=$5`,
        [...this.scopeParams(), input.conversationId, input.agentRunId],
      );
      if (!existing.rows[0]) throw new Error("Operation Run idempotency conflict could not be resolved");
      return existing.rows[0];
    });
    const run = await this.read(String(row.id));
    const paths = operationWorkspacePaths(run.id);
    return { run, reportPath: paths.reportPath, artifactsDir: paths.artifactsDir };
  }

  async read(operationId: string): Promise<StoredOperationRun> {
    const [runResult, logsResult, artifactsResult] = await Promise.all([
      this.database.query<Record<string, unknown>>(
        `select * from ontology_operation_runs
         where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3 and id=$4`,
        [...this.scopeParams(), operationId],
      ),
      this.database.query<Record<string, unknown>>(
        `select at, summary, path from ontology_operation_logs
         where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3 and operation_id=$4 order by sequence`,
        [...this.scopeParams(), operationId],
      ),
      this.database.query<Record<string, unknown>>(
        `select path, description from ontology_operation_artifacts
         where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3 and operation_id=$4 order by created_at, path`,
        [...this.scopeParams(), operationId],
      ),
    ]);
    if (!runResult.rows[0]) throw operationNotFound(operationId);
    return hydrateStoredOperationRun({
      run: runResult.rows[0],
      logs: logsResult.rows,
      artifacts: artifactsResult.rows,
    });
  }

  async list(options: ListOperationRunsOptions = {}): Promise<StoredOperationRun[]> {
    const params: unknown[] = this.scopeParams();
    const filters: string[] = [];
    if (options.conversationId) {
      params.push(options.conversationId);
      filters.push(`conversation_id=$${params.length}`);
    }
    if (options.search?.trim()) {
      params.push(options.search.trim().toLocaleLowerCase());
      const searchParam = `$${params.length}`;
      filters.push(`(
        position(${searchParam} in lower(coalesce(title, ''))) > 0 or
        position(${searchParam} in lower(user_request)) > 0 or
        position(${searchParam} in lower(coalesce(result_summary, ''))) > 0
      )`);
    }
    if (options.cursor) {
      params.push(options.cursor.startedAt, options.cursor.id);
      const startedAtParam = `$${params.length - 1}`;
      const idParam = `$${params.length}`;
      filters.push(`(started_at < ${startedAtParam} or (started_at = ${startedAtParam} and id < ${idParam}))`);
    }
    const whereFilters = filters.length ? ` and ${filters.join(" and ")}` : "";
    let limitClause = "";
    if (options.limit !== undefined) {
      params.push(options.limit);
      limitClause = ` limit $${params.length}`;
    }
    const result = await this.database.query<Record<string, unknown>>(
      `select id from ontology_operation_runs
       where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3${whereFilters}
       order by started_at desc, id desc${limitClause}`,
      params,
    );
    return Promise.all(result.rows.map((row) => this.read(String(row.id))));
  }

  async updateTitle(operationId: string, title: string): Promise<StoredOperationRun> {
    const updated = await this.database.query(
      `update ontology_operation_runs set title=$5, updated_at=now()
       where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3 and id=$4 returning id`,
      [...this.scopeParams(), operationId, title.trim()],
    );
    if (!updated.rows.length) throw operationNotFound(operationId);
    return this.read(operationId);
  }

  async delete(operationId: string): Promise<void> {
    const operationIds = await this.withTransaction(async (client) => {
      const deleted = await deleteScopedOperationRows(client, {
        target: "operation",
        tenantId: this.context.tenantId,
        ownerId: this.context.ownerId,
        knowledgeBaseId: this.context.knowledgeBaseId,
        operationId,
      });
      if (!deleted.length) throw operationNotFound(operationId);
      return deleted;
    });
    await removeOperationRunFilesBestEffort(this.context.workspaceRoot, operationIds);
  }

  async appendLog(input: AppendOperationLogInput): Promise<StoredOperationRun> {
    const logPath = normalizeWorkspacePath(this.context.workspaceRoot, input.path);
    const now = new Date().toISOString();
    await this.withTransaction(async (client) => {
      await this.lockRunningOperation(client, input.operationId);
      await this.appendLogRow(client, {
        operationId: input.operationId,
        at: now,
        summary: input.summary,
        path: logPath,
      });
      if (input.artifact && logPath) {
        await client.query(
          `insert into ontology_operation_artifacts
             (tenant_id, owner_id, knowledge_base_id, operation_id, path, description, created_at)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (tenant_id, owner_id, knowledge_base_id, operation_id, path) do update
           set description=coalesce(ontology_operation_artifacts.description, excluded.description)`,
          [...this.scopeParams(), input.operationId, logPath, input.artifactDescription ?? input.summary, now],
        );
      }
    });
    return this.read(input.operationId);
  }

  async finish(input: FinishOperationRunInput): Promise<StoredOperationRun> {
    const now = new Date().toISOString();
    const savedReportPath = input.reportMarkdown?.trim() ? operationWorkspacePaths(input.operationId).reportPath : undefined;
    const outcome = resolveOperationFinishOutcome(input);
    await this.withTransaction(async (client) => {
      const current = await this.lockRunningOperation(client, input.operationId);
      if (savedReportPath) {
        const reportFile = resolveWorkspaceFile(this.context.workspaceRoot, savedReportPath);
        await fs.mkdir(path.dirname(reportFile), { recursive: true });
        await fs.writeFile(reportFile, input.reportMarkdown!.trimEnd() + "\n", "utf8");
      }
      const reportPath = savedReportPath ?? (current.report_path === null ? undefined : String(current.report_path));
      if (savedReportPath) {
        await client.query(
          `insert into ontology_operation_artifacts
             (tenant_id, owner_id, knowledge_base_id, operation_id, path, description, created_at)
           values ($1,$2,$3,$4,$5,'Operation report',$6)
           on conflict (tenant_id, owner_id, knowledge_base_id, operation_id, path) do nothing`,
          [...this.scopeParams(), input.operationId, savedReportPath, now],
        );
      }
      await this.appendLogRow(client, {
        operationId: input.operationId,
        at: now,
        summary: outcome.logSummary,
        path: reportPath,
      });
      await client.query(
        `update ontology_operation_runs
         set status=$5, result_summary=$6, report_path=$7, error=$8, error_code=$9, finished_at=$10, updated_at=$10
         where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3 and id=$4`,
        [
          ...this.scopeParams(),
          input.operationId,
          input.status,
          input.resultSummary,
          reportPath ?? null,
          outcome.error ?? null,
          input.errorCode ?? null,
          now,
        ],
      );
    });
    return this.read(input.operationId);
  }

  async finishFromAgentRun(input: FinishOperationRunFromAgentInput): Promise<StoredOperationRun | null> {
    const now = new Date().toISOString();
    let operationId: string | null = null;
    await this.withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `select * from ontology_operation_runs
         where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3
           and conversation_id=$4 and agent_run_id=$5
         for update`,
        [...this.scopeParams(), input.conversationId, input.agentRunId],
      );
      const run = result.rows[0];
      if (!run) return;
      operationId = String(run.id);
      if (run.status !== "running") return;

      await this.appendLogRow(client, {
        operationId,
        at: now,
        summary: resolveOperationFinishOutcome(input).logSummary,
      });
      await client.query(
        `update ontology_operation_runs
         set status=$6, result_summary=$7, error=$8, error_code=$9, finished_at=$10, updated_at=$10
         where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3
           and conversation_id=$4 and agent_run_id=$5 and status='running'`,
        [
          ...this.scopeParams(),
          input.conversationId,
          input.agentRunId,
          input.status,
          input.resultSummary,
          input.error,
          input.errorCode,
          now,
        ],
      );
    });
    return operationId ? this.read(operationId) : null;
  }
}
