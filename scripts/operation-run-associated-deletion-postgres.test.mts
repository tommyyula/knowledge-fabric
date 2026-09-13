import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import type pg from "pg";

let pool: pg.Pool | null;
let repository: typeof import("../server/ontologies/repository.ts");
let createOperationRunStore: typeof import("../server/operations/store.ts").createOperationRunStore;
let workspacePath: typeof import("../server/ontologies/workspace.ts").workspacePath;
let dataRoot: string;

test.before(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "knowledge-associated-operation-delete-"));
  process.env.APP_DATA_ROOT = dataRoot;
  const [clientModule, migrationModule, repositoryModule, storeModule, workspaceModule] = await Promise.all([
    import("../server/db/client.ts"),
    import("../server/db/migrations.ts"),
    import("../server/ontologies/repository.ts"),
    import("../server/operations/store.ts"),
    import("../server/ontologies/workspace.ts"),
  ]);
  pool = clientModule.pool;
  repository = repositoryModule;
  createOperationRunStore = storeModule.createOperationRunStore;
  workspacePath = workspaceModule.workspacePath;
  if (pool) await migrationModule.ensureMigrations();
});

test.after(async () => {
  await pool?.end();
  await rm(dataRoot, { recursive: true, force: true });
});

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

async function removeTenantRows(tenantId: string): Promise<void> {
  if (!pool) return;
  await pool.query("delete from ontology_operation_logs where tenant_id=$1", [tenantId]).catch(() => undefined);
  await pool.query("delete from ontology_operation_artifacts where tenant_id=$1", [tenantId]).catch(() => undefined);
  await pool.query("delete from ontology_operation_runs where tenant_id=$1", [tenantId]).catch(() => undefined);
  await pool.query("delete from ontology_projects where tenant_id=$1", [tenantId]).catch(() => undefined);
}

type DeleteFailureTable =
  | "ontology_operation_logs"
  | "ontology_operation_artifacts"
  | "ontology_operation_runs"
  | "ontology_sessions"
  | "ontology_projects";

async function installScopedDeleteFailure(table: DeleteFailureTable, tenantId: string): Promise<() => Promise<void>> {
  assert(pool, "DATABASE_URL is required for associated Operation deletion tests");
  const suffix = randomUUID().replace(/-/g, "");
  const functionName = `test_fail_associated_delete_${suffix}`;
  const triggerName = `test_fail_associated_delete_${suffix}`;
  const tenantLiteral = tenantId.replace(/'/g, "''");
  await pool.query(`create function ${functionName}() returns trigger language plpgsql as $$
    begin raise exception 'forced associated deletion failure'; end
  $$`);
  await pool.query(`create trigger ${triggerName} before delete on ${table}
    for each row when (old.tenant_id = '${tenantLiteral}') execute function ${functionName}()`);
  return async () => {
    await pool?.query(`drop trigger if exists ${triggerName} on ${table}`);
    await pool?.query(`drop function if exists ${functionName}()`);
  };
}

async function createFinishedOperation(
  store: ReturnType<typeof createOperationRunStore>,
  conversationId: string,
  agentRunId: string,
) {
  const created = await store.create({ conversationId, agentRunId, userRequest: `Run ${agentRunId}.` });
  const artifactPath = path.posix.join(created.artifactsDir, "result.json");
  const root = workspacePath(created.run.tenantId, created.run.ownerId, created.run.ontologyId);
  await mkdir(path.join(root, created.artifactsDir), { recursive: true });
  await writeFile(path.join(root, artifactPath), JSON.stringify({ ok: true }), "utf8");
  await store.appendLog({ operationId: created.run.id, summary: "Generated result.", path: artifactPath, artifact: true });
  const run = await store.finish({ operationId: created.run.id, status: "succeeded", resultSummary: "Completed." });
  return { run, artifactsDir: created.artifactsDir };
}

test("deleting a Knowledge Base Conversation removes only its scoped Operation data", async (context: TestContext) => {
  if (!pool) return context.skip("DATABASE_URL is required for associated Operation deletion tests");
  const tenantId = `conversation-operation-delete-${randomUUID()}`;
  const ownerId = "owner-a";
  context.after(() => removeTenantRows(tenantId));
  const project = await repository.createProject({ tenantId, ownerId, name: "Target Knowledge Base" });
  const siblingProject = await repository.createProject({ tenantId, ownerId, name: "Sibling Knowledge Base" });
  const targetConversation = await repository.createSession(tenantId, ownerId, project.id, "Target Conversation");
  const siblingConversation = await repository.createSession(tenantId, ownerId, project.id, "Sibling Conversation");
  const targetStore = createOperationRunStore({
    workspaceRoot: workspacePath(tenantId, ownerId, project.id), tenantId, ownerId, knowledgeBaseId: project.id,
  }, pool);
  const otherOwnerStore = createOperationRunStore({
    workspaceRoot: workspacePath(tenantId, "owner-b", project.id), tenantId, ownerId: "owner-b", knowledgeBaseId: project.id,
  }, pool);
  const siblingProjectStore = createOperationRunStore({
    workspaceRoot: workspacePath(tenantId, ownerId, siblingProject.id), tenantId, ownerId, knowledgeBaseId: siblingProject.id,
  }, pool);
  const target = await createFinishedOperation(targetStore, targetConversation.id, "agent-target");
  const siblingConversationRun = await createFinishedOperation(targetStore, siblingConversation.id, "agent-sibling-conversation");
  const otherOwnerRun = await createFinishedOperation(otherOwnerStore, targetConversation.id, "agent-other-owner");
  const siblingProjectRun = await createFinishedOperation(siblingProjectStore, targetConversation.id, "agent-sibling-project");

  assert.equal(await repository.deleteSession(tenantId, ownerId, project.id, targetConversation.id), true);

  assert.equal(await repository.getSession(tenantId, ownerId, project.id, targetConversation.id), null);
  await assert.rejects(targetStore.read(target.run.id), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(await exists(path.join(workspacePath(tenantId, ownerId, project.id), target.artifactsDir)), false);
  assert.equal((await targetStore.read(siblingConversationRun.run.id)).id, siblingConversationRun.run.id);
  assert.equal((await otherOwnerStore.read(otherOwnerRun.run.id)).id, otherOwnerRun.run.id);
  assert.equal((await siblingProjectStore.read(siblingProjectRun.run.id)).id, siblingProjectRun.run.id);
});

test("deleting a Knowledge Base removes only its scoped Operation data", async (context: TestContext) => {
  if (!pool) return context.skip("DATABASE_URL is required for associated Operation deletion tests");
  const tenantId = `knowledge-base-operation-delete-${randomUUID()}`;
  const otherTenantId = `${tenantId}-other`;
  const ownerId = "owner-a";
  context.after(async () => {
    await removeTenantRows(tenantId);
    await removeTenantRows(otherTenantId);
  });
  const project = await repository.createProject({ tenantId, ownerId, name: "Target Knowledge Base" });
  const siblingProject = await repository.createProject({ tenantId, ownerId, name: "Sibling Knowledge Base" });
  const firstConversation = await repository.createSession(tenantId, ownerId, project.id, "First Conversation");
  const secondConversation = await repository.createSession(tenantId, ownerId, project.id, "Second Conversation");
  const targetStore = createOperationRunStore({
    workspaceRoot: workspacePath(tenantId, ownerId, project.id), tenantId, ownerId, knowledgeBaseId: project.id,
  }, pool);
  const siblingProjectStore = createOperationRunStore({
    workspaceRoot: workspacePath(tenantId, ownerId, siblingProject.id), tenantId, ownerId, knowledgeBaseId: siblingProject.id,
  }, pool);
  const otherOwnerStore = createOperationRunStore({
    workspaceRoot: workspacePath(tenantId, "owner-b", project.id), tenantId, ownerId: "owner-b", knowledgeBaseId: project.id,
  }, pool);
  const otherTenantStore = createOperationRunStore({
    workspaceRoot: workspacePath(otherTenantId, ownerId, project.id), tenantId: otherTenantId, ownerId, knowledgeBaseId: project.id,
  }, pool);
  const firstTarget = await createFinishedOperation(targetStore, firstConversation.id, "agent-target-first");
  const secondTarget = await createFinishedOperation(targetStore, secondConversation.id, "agent-target-second");
  const siblingProjectRun = await createFinishedOperation(siblingProjectStore, firstConversation.id, "agent-sibling-project");
  const otherOwnerRun = await createFinishedOperation(otherOwnerStore, firstConversation.id, "agent-other-owner");
  const otherTenantRun = await createFinishedOperation(otherTenantStore, firstConversation.id, "agent-other-tenant");

  assert.equal(await repository.deleteProject(tenantId, ownerId, project.id), true);

  assert.equal(await repository.getProject(tenantId, ownerId, project.id), null);
  await assert.rejects(targetStore.read(firstTarget.run.id), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(targetStore.read(secondTarget.run.id), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(await exists(path.join(workspacePath(tenantId, ownerId, project.id), firstTarget.artifactsDir)), false);
  assert.equal(await exists(path.join(workspacePath(tenantId, ownerId, project.id), secondTarget.artifactsDir)), false);
  assert.equal((await siblingProjectStore.read(siblingProjectRun.run.id)).id, siblingProjectRun.run.id);
  assert.equal((await otherOwnerStore.read(otherOwnerRun.run.id)).id, otherOwnerRun.run.id);
  assert.equal((await otherTenantStore.read(otherTenantRun.run.id)).id, otherTenantRun.run.id);
});

test("Conversation deletion rolls back at every database failure point", async (context: TestContext) => {
  if (!pool) return context.skip("DATABASE_URL is required for associated Operation deletion tests");
  const tenantId = `conversation-delete-rollback-${randomUUID()}`;
  const ownerId = "owner-a";
  context.after(() => removeTenantRows(tenantId));
  const project = await repository.createProject({ tenantId, ownerId, name: "Rollback Knowledge Base" });
  const conversation = await repository.createSession(tenantId, ownerId, project.id, "Rollback Conversation");
  const store = createOperationRunStore({
    workspaceRoot: workspacePath(tenantId, ownerId, project.id), tenantId, ownerId, knowledgeBaseId: project.id,
  }, pool);
  const operation = await createFinishedOperation(store, conversation.id, "agent-conversation-rollback");

  for (const table of [
    "ontology_operation_logs",
    "ontology_operation_artifacts",
    "ontology_operation_runs",
    "ontology_sessions",
  ] as const) {
    const removeFailure = await installScopedDeleteFailure(table, tenantId);
    try {
      await assert.rejects(
        repository.deleteSession(tenantId, ownerId, project.id, conversation.id),
        /forced associated deletion failure/,
      );
      assert.equal((await repository.getSession(tenantId, ownerId, project.id, conversation.id))?.id, conversation.id);
      assert.equal((await store.read(operation.run.id)).id, operation.run.id);
      assert.equal(await exists(path.join(workspacePath(tenantId, ownerId, project.id), operation.artifactsDir)), true);
    } finally {
      await removeFailure();
    }
  }

  assert.equal(await repository.deleteSession(tenantId, ownerId, project.id, conversation.id), true);
});

test("Knowledge Base deletion rolls back at every database failure point", async (context: TestContext) => {
  if (!pool) return context.skip("DATABASE_URL is required for associated Operation deletion tests");
  const tenantId = `knowledge-base-delete-rollback-${randomUUID()}`;
  const ownerId = "owner-a";
  context.after(() => removeTenantRows(tenantId));
  const project = await repository.createProject({ tenantId, ownerId, name: "Rollback Knowledge Base" });
  const conversation = await repository.createSession(tenantId, ownerId, project.id, "Rollback Conversation");
  const store = createOperationRunStore({
    workspaceRoot: workspacePath(tenantId, ownerId, project.id), tenantId, ownerId, knowledgeBaseId: project.id,
  }, pool);
  const operation = await createFinishedOperation(store, conversation.id, "agent-project-rollback");

  for (const table of [
    "ontology_operation_logs",
    "ontology_operation_artifacts",
    "ontology_operation_runs",
    "ontology_projects",
  ] as const) {
    const removeFailure = await installScopedDeleteFailure(table, tenantId);
    try {
      await assert.rejects(
        repository.deleteProject(tenantId, ownerId, project.id),
        /forced associated deletion failure/,
      );
      assert.equal((await repository.getProject(tenantId, ownerId, project.id))?.id, project.id);
      assert.equal((await store.read(operation.run.id)).id, operation.run.id);
      assert.equal(await exists(path.join(workspacePath(tenantId, ownerId, project.id), operation.artifactsDir)), true);
    } finally {
      await removeFailure();
    }
  }

  assert.equal(await repository.deleteProject(tenantId, ownerId, project.id), true);
});
