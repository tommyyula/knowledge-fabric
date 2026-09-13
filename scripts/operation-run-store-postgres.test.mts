import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { pool } from "../server/db/client";
import { ensureMigrations } from "../server/db/migrations";
import { env } from "../server/env";
import { reconcileOperationRunAfterChatCompletion } from "../server/operations/reconcile-agent-run";
import { createOperationRunStore } from "../server/operations/store";

const execFileAsync = promisify(execFile);

test.after(async () => {
  await pool?.end();
});

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

async function removeTenantRows(tenantId: string): Promise<void> {
  if (!pool) return;
  await pool.query("delete from ontology_operation_logs where tenant_id=$1", [tenantId]).catch(() => undefined);
  await pool.query("delete from ontology_operation_artifacts where tenant_id=$1", [tenantId]).catch(() => undefined);
  await pool.query("delete from ontology_operation_runs where tenant_id=$1", [tenantId]).catch(() => undefined);
}

async function installScopedDeleteFailure(
  table: "ontology_operation_logs" | "ontology_operation_artifacts" | "ontology_operation_runs",
  tenantId: string,
): Promise<() => Promise<void>> {
  assert(pool, "DATABASE_URL is required for the PostgreSQL Operation Run test");
  const suffix = randomUUID().replace(/-/g, "");
  const functionName = `test_fail_operation_delete_${suffix}`;
  const triggerName = `test_fail_operation_delete_${suffix}`;
  const tenantLiteral = tenantId.replace(/'/g, "''");
  await pool.query(`create function ${functionName}() returns trigger language plpgsql as $$
    begin raise exception 'forced Operation deletion failure'; end
  $$`);
  await pool.query(`create trigger ${triggerName} before delete on ${table}
    for each row when (old.tenant_id = '${tenantLiteral}') execute function ${functionName}()`);
  return async () => {
    await pool.query(`drop trigger if exists ${triggerName} on ${table}`);
    await pool.query(`drop function if exists ${functionName}()`);
  };
}

async function createOperationRunFixture(
  context: TestContext,
  prefix: string,
  agentRunId: string,
  userRequest: string,
) {
  assert(pool, "DATABASE_URL is required for the PostgreSQL Operation Run test");
  await ensureMigrations();
  const tenantId = `${prefix}-${randomUUID()}`;
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "knowledge-operation-postgres-"));
  context.after(async () => {
    await removeTenantRows(tenantId);
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  const store = createOperationRunStore({
    workspaceRoot,
    tenantId,
    ownerId: "owner-a",
    knowledgeBaseId: "knowledge-base-a",
  }, pool);
  const created = await store.create({
    conversationId: "conversation-a",
    agentRunId,
    userRequest,
  });
  return { store, created };
}

test("PostgreSQL persists an idempotent Operation Run start without workspace JSON", { skip: !env.databaseUrl }, async (context) => {
  assert(pool, "DATABASE_URL is required for the PostgreSQL Operation Run test");
  await ensureMigrations();
  const tenantId = `operation-store-${randomUUID()}`;
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "knowledge-operation-postgres-"));
  context.after(async () => {
    await removeTenantRows(tenantId);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const scope = { workspaceRoot, tenantId, ownerId: "owner-a", knowledgeBaseId: "knowledge-base-a" };
  const firstStore = createOperationRunStore(scope, pool);
  const startInput = {
    conversationId: "conversation-a",
    agentRunId: "agent-run-a",
    userRequest: "Check order ORD-100 without relying on a prompt prefix.",
    title: "Check order status",
    now: new Date("2026-08-17T08:00:00.000Z"),
  };
  const [first, concurrent] = await Promise.all([
    firstStore.create(startInput),
    createOperationRunStore(scope, pool).create(startInput),
  ]);
  const repeated = await firstStore.create({
    conversationId: "conversation-a",
    agentRunId: "agent-run-a",
    userRequest: "A later paraphrase must not replace the server-held request.",
    title: "Different title",
  });
  const restartedStore = createOperationRunStore(scope, pool);
  const reloaded = await restartedStore.read(first.run.id);

  assert.equal(concurrent.run.id, first.run.id);
  assert.equal(repeated.run.id, first.run.id);
  assert.equal(reloaded.userRequest, "Check order ORD-100 without relying on a prompt prefix.");
  assert.deepEqual((await restartedStore.list()).map((run) => run.id), [first.run.id]);
  assert.equal(await exists(path.join(workspaceRoot, ".runtime", "operations", `${first.run.id}.json`)), false);
  assert.equal(await exists(path.join(workspaceRoot, first.artifactsDir)), false);
});

test("PostgreSQL preserves concurrent progress and the complete Operation Run lifecycle", { skip: !env.databaseUrl }, async (context) => {
  assert(pool, "DATABASE_URL is required for the PostgreSQL Operation Run test");
  await ensureMigrations();
  const tenantId = `operation-lifecycle-${randomUUID()}`;
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "knowledge-operation-postgres-"));
  context.after(async () => {
    await removeTenantRows(tenantId);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const store = createOperationRunStore({
    workspaceRoot,
    tenantId,
    ownerId: "owner-a",
    knowledgeBaseId: "knowledge-base-a",
  }, pool);
  const created = await store.create({
    conversationId: "conversation-a",
    agentRunId: "agent-run-a",
    userRequest: "Generate an operation result.",
  });
  const artifactPath = path.posix.join(created.artifactsDir, "result.json");
  await mkdir(path.dirname(path.join(workspaceRoot, artifactPath)), { recursive: true });
  await writeFile(path.join(workspaceRoot, artifactPath), JSON.stringify({ ok: true }), "utf8");

  await Promise.all([
    store.appendLog({ operationId: created.run.id, summary: "First concurrent progress.", path: artifactPath, artifact: true }),
    store.appendLog({ operationId: created.run.id, summary: "Second concurrent progress.", path: artifactPath, artifact: true }),
  ]);
  await store.updateTitle(created.run.id, "Renamed operation");
  await store.finish({
    operationId: created.run.id,
    status: "succeeded",
    resultSummary: "Operation completed.",
    reportMarkdown: "# Result\n\nOperation completed.",
  });

  const reloaded = await createOperationRunStore({
    workspaceRoot,
    tenantId,
    ownerId: "owner-a",
    knowledgeBaseId: "knowledge-base-a",
  }, pool).read(created.run.id);
  assert.equal(reloaded.status, "succeeded");
  assert.equal(reloaded.title, "Renamed operation");
  assert.equal(reloaded.logs.length, 4);
  assert.deepEqual(new Set(reloaded.logs.slice(1, 3).map((log) => log.summary)), new Set(["First concurrent progress.", "Second concurrent progress."]));
  assert.deepEqual(reloaded.artifacts.map((artifact) => artifact.path).sort(), [artifactPath, created.reportPath].sort());
  assert.equal(await exists(path.join(workspaceRoot, created.reportPath)), true);
  const originalReport = await readFile(path.join(workspaceRoot, created.reportPath), "utf8");
  await assert.rejects(store.finish({
    operationId: created.run.id,
    status: "failed",
    resultSummary: "Must be rejected.",
    reportMarkdown: "# Overwritten",
  }), /already succeeded/);
  assert.equal(await readFile(path.join(workspaceRoot, created.reportPath), "utf8"), originalReport);

  await store.delete(created.run.id);
  await assert.rejects(store.read(created.run.id), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(await exists(path.join(workspaceRoot, "operations", created.run.id)), false);
});

test("PostgreSQL rolls back an Operation deletion at every associated row failure point", { skip: !env.databaseUrl }, async (context) => {
  assert(pool, "DATABASE_URL is required for the PostgreSQL Operation Run test");
  await ensureMigrations();
  const tenantId = `operation-delete-rollback-${randomUUID()}`;
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "knowledge-operation-postgres-"));
  context.after(async () => {
    await removeTenantRows(tenantId);
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  const store = createOperationRunStore({
    workspaceRoot,
    tenantId,
    ownerId: "owner-a",
    knowledgeBaseId: "knowledge-base-a",
  }, pool);
  const created = await store.create({
    conversationId: "conversation-a",
    agentRunId: "agent-run-a",
    userRequest: "Generate a deletable Operation Artifact.",
  });
  const artifactPath = path.posix.join(created.artifactsDir, "result.json");
  await mkdir(path.join(workspaceRoot, created.artifactsDir), { recursive: true });
  await writeFile(path.join(workspaceRoot, artifactPath), JSON.stringify({ ok: true }), "utf8");
  await store.appendLog({ operationId: created.run.id, summary: "Generated result.", path: artifactPath, artifact: true });
  await store.finish({ operationId: created.run.id, status: "succeeded", resultSummary: "Completed." });

  for (const table of ["ontology_operation_logs", "ontology_operation_artifacts", "ontology_operation_runs"] as const) {
    const removeFailure = await installScopedDeleteFailure(table, tenantId);
    try {
      await assert.rejects(store.delete(created.run.id), /forced Operation deletion failure/);
      const preserved = await store.read(created.run.id);
      assert.equal(preserved.logs.length, 3);
      assert.deepEqual(preserved.artifacts.map((artifact) => artifact.path), [artifactPath]);
      assert.equal(await exists(path.join(workspaceRoot, created.artifactsDir)), true);
    } finally {
      await removeFailure();
    }
  }

  await store.delete(created.run.id);
  await assert.rejects(store.read(created.run.id), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(await exists(path.join(workspaceRoot, created.artifactsDir)), false);
});

test("PostgreSQL Operation Run history is scope-isolated and never dual-reads workspace JSON", { skip: !env.databaseUrl }, async (context) => {
  assert(pool, "DATABASE_URL is required for the PostgreSQL Operation Run test");
  await ensureMigrations();
  const tenantId = `operation-isolation-${randomUUID()}`;
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "knowledge-operation-postgres-"));
  context.after(async () => {
    await removeTenantRows(tenantId);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const scope = { workspaceRoot, tenantId, ownerId: "owner-a", knowledgeBaseId: "knowledge-base-a" };
  const store = createOperationRunStore(scope, pool);
  const created = await store.create({
    conversationId: "conversation-a",
    agentRunId: "agent-run-a",
    userRequest: "Visible PostgreSQL operation.",
  });
  const runtimeDirectory = path.join(workspaceRoot, ".runtime", "operations");
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(path.join(runtimeDirectory, "op_legacy-json.json"), JSON.stringify({
    id: "op_legacy-json",
    ontologyId: "knowledge-base-a",
    sessionId: "conversation-a",
    userRequest: "operate: legacy JSON must stay invisible to PostgreSQL",
    status: "running",
    logs: [],
    artifacts: [],
    startedAt: "2026-08-17T00:00:00.000Z",
  }), "utf8");

  assert.deepEqual((await store.list()).map((run) => run.id), [created.run.id]);
  assert.deepEqual((await store.list({ conversationId: "other-conversation" })).map((run) => run.id), []);
  for (const hiddenScope of [
    { ...scope, tenantId: `${tenantId}-other` },
    { ...scope, ownerId: "owner-b" },
    { ...scope, knowledgeBaseId: "knowledge-base-b" },
  ]) {
    const hiddenStore = createOperationRunStore(hiddenScope, pool);
    assert.deepEqual(await hiddenStore.list(), []);
    await assert.rejects(hiddenStore.read(created.run.id), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  }
});

test("PostgreSQL pages equal timestamps and searches beyond the first page", { skip: !env.databaseUrl }, async (context) => {
  assert(pool, "DATABASE_URL is required for the PostgreSQL Operation Run test");
  await ensureMigrations();
  const tenantId = `operation-history-${randomUUID()}`;
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "knowledge-operation-postgres-"));
  context.after(async () => {
    await removeTenantRows(tenantId);
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  const store = createOperationRunStore({
    workspaceRoot,
    tenantId,
    ownerId: "owner-a",
    knowledgeBaseId: "knowledge-base-a",
  }, pool);
  const sharedTime = new Date("2026-08-17T08:00:00.000Z");
  const equalTimestampRuns = await Promise.all([
    store.create({ conversationId: "conversation-a", agentRunId: "agent-run-a", userRequest: "First request", now: sharedTime }),
    store.create({ conversationId: "conversation-a", agentRunId: "agent-run-b", userRequest: "Second request", now: sharedTime }),
    store.create({ conversationId: "conversation-a", agentRunId: "agent-run-c", userRequest: "Third request", now: sharedTime }),
  ]);
  const searchable = await store.create({
    conversationId: "conversation-b",
    agentRunId: "agent-run-search",
    userRequest: "Prepare an older report.",
    now: new Date("2026-08-17T07:00:00.000Z"),
  });
  await store.finish({
    operationId: searchable.run.id,
    status: "succeeded",
    resultSummary: "The hidden pagination needle is present.",
  });
  const expectedIds = equalTimestampRuns.map(({ run }) => run.id).sort().reverse();

  const firstPage = await store.list({ limit: 2 });
  const boundary = firstPage.at(-1);
  assert(boundary);
  const secondPage = await store.list({
    limit: 2,
    cursor: { startedAt: boundary.startedAt, id: boundary.id },
  });

  assert.deepEqual(firstPage.map((run) => run.id), expectedIds.slice(0, 2));
  assert.deepEqual(secondPage.map((run) => run.id), [...expectedIds.slice(2), searchable.run.id]);
  assert.deepEqual(
    (await store.list({ search: "PAGINATION NEEDLE", limit: 1 })).map((run) => run.id),
    [searchable.run.id],
  );
});

test("a cancelled Agent Run closes its still-running Operation Run", { skip: !env.databaseUrl }, async (context) => {
  const { store, created } = await createOperationRunFixture(
    context,
    "operation-cancelled",
    "agent-run-cancelled",
    "Cancel this operation safely.",
  );

  const reconciled = await reconcileOperationRunAfterChatCompletion({
    store,
    conversationId: "conversation-a",
    agentRunId: "agent-run-cancelled",
    result: { cancelled: true },
  });

  assert.equal(reconciled?.id, created.run.id);
  assert.equal(reconciled?.status, "cancelled");
  assert.equal(reconciled?.errorCode, "agent_run_cancelled");
  assert.equal(reconciled?.error, "The Agent Run was cancelled before the Operation completed.");
  assert.ok(reconciled?.finishedAt);
  assert.equal(reconciled?.logs.at(-1)?.summary, "Operation cancelled: The Agent Run was cancelled before the Operation completed.");
});

test("a failed Agent Run closes its Operation Run with a safe failure description", { skip: !env.databaseUrl }, async (context) => {
  const { store, created } = await createOperationRunFixture(
    context,
    "operation-agent-failed",
    "agent-run-failed",
    "Run an operation that encounters an Agent failure.",
  );

  const reconciled = await reconcileOperationRunAfterChatCompletion({
    store,
    conversationId: "conversation-a",
    agentRunId: "agent-run-failed",
    result: { error: "Unsafe upstream detail must not be persisted." },
  });

  assert.equal(reconciled?.id, created.run.id);
  assert.equal(reconciled?.status, "failed");
  assert.equal(reconciled?.errorCode, "agent_run_failed");
  assert.equal(reconciled?.error, "The Agent Run failed before the Operation completed.");
  assert.ok(reconciled?.finishedAt);
});

test("a completed Agent Run fails an Operation Run that omitted operation_finish", { skip: !env.databaseUrl }, async (context) => {
  const { store, created } = await createOperationRunFixture(
    context,
    "operation-finish-missing",
    "agent-run-completed",
    "Complete without reporting an Operation result.",
  );

  const reconciled = await reconcileOperationRunAfterChatCompletion({
    store,
    conversationId: "conversation-a",
    agentRunId: "agent-run-completed",
    result: {},
  });

  assert.equal(reconciled?.id, created.run.id);
  assert.equal(reconciled?.status, "failed");
  assert.equal(reconciled?.errorCode, "operation_finish_missing");
  assert.equal(reconciled?.error, "The Agent Run completed without calling operation_finish.");
  assert.ok(reconciled?.finishedAt);
});

test("an explicit business failure remains authoritative during Agent reconciliation", { skip: !env.databaseUrl }, async (context) => {
  const { store, created } = await createOperationRunFixture(
    context,
    "operation-explicit-failed",
    "agent-run-explicit-failed",
    "Return an explicit business failure.",
  );
  await store.finish({
    operationId: created.run.id,
    status: "failed",
    resultSummary: "The requested business change was rejected.",
    error: "Approval APPR-100 is already closed.",
  });

  await reconcileOperationRunAfterChatCompletion({
    store,
    conversationId: "conversation-a",
    agentRunId: "agent-run-explicit-failed",
    result: { error: "Agent failed after the explicit business result." },
  });
  const reloaded = await store.read(created.run.id);

  assert.equal(reloaded.status, "failed");
  assert.equal(reloaded.resultSummary, "The requested business change was rejected.");
  assert.equal(reloaded.error, "Approval APPR-100 is already closed.");
  assert.equal(reloaded.errorCode, undefined);
  assert.equal(reloaded.logs.length, 2);
});

test("explicit and automatic Operation Run closure race without mixing terminal outcomes", { skip: !env.databaseUrl }, async (context) => {
  const { store, created } = await createOperationRunFixture(
    context,
    "operation-finish-race",
    "agent-run-race",
    "Race explicit success with automatic closure.",
  );

  await Promise.allSettled([
    store.finish({
      operationId: created.run.id,
      status: "succeeded",
      resultSummary: "The explicit Operation result won.",
    }),
    reconcileOperationRunAfterChatCompletion({
      store,
      conversationId: "conversation-a",
      agentRunId: "agent-run-race",
      result: {},
    }),
  ]);
  const reloaded = await store.read(created.run.id);

  assert.equal(reloaded.logs.length, 2, "only one terminal log may be appended");
  assert.ok(reloaded.finishedAt);
  assert.ok(
    (reloaded.status === "succeeded" &&
      reloaded.resultSummary === "The explicit Operation result won." &&
      reloaded.error === undefined &&
      reloaded.errorCode === undefined) ||
    (reloaded.status === "failed" &&
      reloaded.resultSummary === "The Agent Run completed without calling operation_finish." &&
      reloaded.error === "The Agent Run completed without calling operation_finish." &&
      reloaded.errorCode === "operation_finish_missing"),
    "the first terminal writer must win as one complete outcome",
  );
});

test("Operation Run migrations add error codes without introducing foreign keys", { skip: !env.databaseUrl }, async () => {
  assert(pool, "DATABASE_URL is required for the PostgreSQL Operation Run test");
  await ensureMigrations();
  const migration = await pool.query("select id from ontology_schema_migrations where id = any($1::text[])", [[
    "0014_operation_runs",
    "0015_operation_run_error_code",
    "0016_operation_run_finish_time_check",
    "0017_operation_run_error_code_check",
  ]]);
  assert.equal(migration.rows.length, 4);
  const errorCodeColumn = await pool.query(
    `select column_name from information_schema.columns
     where table_schema=current_schema() and table_name='ontology_operation_runs' and column_name='error_code'`,
  );
  assert.equal(errorCodeColumn.rows.length, 1);
  const finishTimeConstraint = await pool.query(
    `select constraint_name from information_schema.table_constraints
     where table_schema=current_schema() and table_name='ontology_operation_runs'
       and constraint_name='ontology_operation_runs_finish_time_check'`,
  );
  assert.equal(finishTimeConstraint.rows.length, 1);
  const errorCodeConstraint = await pool.query(
    `select constraint_name from information_schema.table_constraints
     where table_schema=current_schema() and table_name='ontology_operation_runs'
       and constraint_name='ontology_operation_runs_error_code_check'`,
  );
  assert.equal(errorCodeConstraint.rows.length, 1);
  const constraints = await pool.query<{ table_name: string; constraint_type: string }>(
    `select table_name, constraint_type from information_schema.table_constraints
     where table_schema=current_schema()
       and table_name = any($1::text[])`,
    [["ontology_operation_runs", "ontology_operation_logs", "ontology_operation_artifacts"]],
  );
  assert.deepEqual(new Set(constraints.rows.map((row) => row.table_name)), new Set([
    "ontology_operation_runs",
    "ontology_operation_logs",
    "ontology_operation_artifacts",
  ]));
  assert.equal(constraints.rows.some((row) => row.constraint_type === "FOREIGN KEY"), false);
});

test("a configured PostgreSQL failure never falls back to workspace JSON", async () => {
  const childScript = `
    import assert from "node:assert/strict";
    import { mkdtemp, rm, stat } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import path from "node:path";
    const { createOperationRunStore } = await import("./server/operations/store.ts");
    const { pool } = await import("./server/db/client.ts");
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "knowledge-operation-failed-db-"));
    let failed = false;
    try {
      const store = createOperationRunStore({ workspaceRoot, tenantId: "tenant-failure", ownerId: "owner-a", knowledgeBaseId: "knowledge-base-a" }, pool);
      await store.create({ conversationId: "conversation-a", agentRunId: "agent-run-a", userRequest: "Do not fall back." });
    } catch {
      failed = true;
    } finally {
      assert.equal(failed, true);
      assert.equal(await stat(path.join(workspaceRoot, ".runtime", "operations")).then(() => true, () => false), false);
      await rm(workspaceRoot, { recursive: true, force: true });
      await pool?.end();
    }
  `;
  await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid?connect_timeout=1",
    },
    timeout: 15_000,
  });
});
