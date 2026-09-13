import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOntologyRuntimeMcpServer } from "../server/chat/ontology-runtime-tools";
import { createOperationRunStore } from "../server/operations/store";
import { toPublicOperationRun } from "../server/operations/visibility";
import { operationRunStatusKey } from "../src/lib/operation-runs";

const createFileOperationRunStore = (context: Parameters<typeof createOperationRunStore>[0]) =>
  createOperationRunStore(context, null);

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeJourneyState(root: string, input: { flow: "build" | "maintenance"; phase: "bootstrap" | "ingest" | "verify" | "review" | "ready" }) {
  await mkdir(path.join(root, ".runtime"), { recursive: true });
  await writeFile(path.join(root, ".runtime", "journey-state.json"), JSON.stringify({
    flow: input.flow,
    phase: input.phase,
    bootstrap: { pageTypes: [], sources: [], step: 6, totalSteps: 6, status: "done", awaitingUser: false, rawSources: [] },
    ingest: { files: [], generatedPages: [], totalBatches: 0, completedBatches: 0, progress: 100, batches: [], status: "completed" },
    verify: { status: "done", questionCount: 0, coverage: 0, autoFixed: 0, needsInput: 0, cases: [], fixes: [] },
    review: undefined,
    updatedAt: new Date("2026-08-17T08:00:00.000Z").toISOString(),
  }, null, 2), "utf-8");
  if (input.phase === "verify") {
    await mkdir(path.join(root, "verify", "test-plan"), { recursive: true });
    await writeFile(path.join(root, "verify", "test-plan", "dataset.json"), JSON.stringify({
      source_path: "raw",
      plan_id: "test-plan",
      draft_id: "ingest-test-plan",
      knowledge_path: "pending_review/drafts/ingest-test-plan/knowledge",
      date: "2026-08-17",
      questions: [
        {
          id: 1,
          level: "fact",
          question: "What is being verified?",
          expected_answer: "The staged knowledge.",
          source_file: "raw/source.md",
        },
      ],
    }, null, 2), "utf-8");
  }
}

test("Operation Run status projection distinguishes automatic terminal outcomes", () => {
  const base = {
    id: "op_status",
    ontologyId: "knowledge-base-a",
    sessionId: "conversation-a",
    userRequest: "Run an operation.",
    title: "Status projection",
    logs: [],
    artifacts: [],
    startedAt: "2026-08-17T08:00:00.000Z",
  };

  assert.equal(operationRunStatusKey({ ...base, status: "succeeded" }), "operations.status.succeeded");
  assert.equal(operationRunStatusKey({ ...base, status: "cancelled", errorCode: "agent_run_cancelled" }), "operations.status.cancelled");
  assert.equal(operationRunStatusKey({ ...base, status: "failed", errorCode: "agent_run_failed" }), "operations.status.agentFailed");
  assert.equal(operationRunStatusKey({ ...base, status: "failed", errorCode: "operation_finish_missing" }), "operations.status.incomplete");
});

test("the file Operation Run store preserves its caller scope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-operation-store-"));
  try {
    const store = createFileOperationRunStore({
      workspaceRoot: root,
      tenantId: "tenant-a",
      ownerId: "owner-a",
      knowledgeBaseId: "knowledge-base-a",
    });
    const created = await store.create({
      conversationId: "conversation-a",
      agentRunId: "agent-run-a",
      userRequest: "Check order ORD-100 and summarize its current status.",
      title: "Check order status",
      now: new Date("2026-08-17T08:00:00.000Z"),
    });

    const reloaded = await store.read(created.run.id);
    const listed = await store.list({ conversationId: "conversation-a" });

    assert.deepEqual(
      {
        tenantId: reloaded.tenantId,
        ownerId: reloaded.ownerId,
        ontologyId: reloaded.ontologyId,
        sessionId: reloaded.sessionId,
        agentRunId: reloaded.agentRunId,
        userRequest: reloaded.userRequest,
      },
      {
        tenantId: "tenant-a",
        ownerId: "owner-a",
        ontologyId: "knowledge-base-a",
        sessionId: "conversation-a",
        agentRunId: "agent-run-a",
        userRequest: "Check order ORD-100 and summarize its current status.",
      },
    );
    assert.deepEqual(listed.map((run) => run.id), [created.run.id]);
    assert.deepEqual(
      Object.keys(toPublicOperationRun(reloaded)).filter((key) => ["tenantId", "ownerId", "agentRunId"].includes(key)),
      [],
      "history API projection must not expose internal Operation Run identity fields",
    );

    await store.delete(created.run.id);
    await assert.rejects(store.read(created.run.id), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the file Operation Run store pages equal timestamps without duplicates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-operation-store-"));
  try {
    const store = createFileOperationRunStore({
      workspaceRoot: root,
      tenantId: "tenant-a",
      ownerId: "owner-a",
      knowledgeBaseId: "knowledge-base-a",
    });
    const startedAt = new Date("2026-08-17T08:00:00.000Z");
    const created = await Promise.all([
      store.create({ conversationId: "conversation-a", agentRunId: "agent-run-a", userRequest: "First request", now: startedAt }),
      store.create({ conversationId: "conversation-a", agentRunId: "agent-run-b", userRequest: "Second request", now: startedAt }),
      store.create({ conversationId: "conversation-a", agentRunId: "agent-run-c", userRequest: "Third request", now: startedAt }),
    ]);
    const expectedIds = created.map(({ run }) => run.id).sort().reverse();

    const firstPage = await store.list({ limit: 2 });
    const boundary = firstPage.at(-1);
    assert(boundary);
    const secondPage = await store.list({
      limit: 2,
      cursor: { startedAt: boundary.startedAt, id: boundary.id },
    });

    assert.deepEqual(
      [...firstPage, ...secondPage].map((run) => run.id),
      expectedIds,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the file Operation Run store returns every started run without a request prefix", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-operation-store-"));
  try {
    const store = createFileOperationRunStore({
      workspaceRoot: root,
      tenantId: "tenant-a",
      ownerId: "owner-a",
      knowledgeBaseId: "knowledge-base-a",
    });
    const created = await store.create({
      conversationId: "conversation-a",
      agentRunId: "agent-run-a",
      userRequest: "Check order ORD-100 without a command prefix.",
    });

    assert.deepEqual(
      (await store.list()).map((run) => run.id),
      [created.run.id],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the file Operation Run store searches all history fields beyond the first page", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-operation-store-"));
  try {
    const store = createFileOperationRunStore({
      workspaceRoot: root,
      tenantId: "tenant-a",
      ownerId: "owner-a",
      knowledgeBaseId: "knowledge-base-a",
    });
    const summaryMatch = await store.create({
      conversationId: "conversation-a",
      agentRunId: "agent-run-summary",
      userRequest: "Generate the final report.",
      title: "Quarterly report",
      now: new Date("2026-08-17T06:00:00.000Z"),
    });
    await store.finish({
      operationId: summaryMatch.run.id,
      status: "succeeded",
      resultSummary: "Shipment SHIP-900 was delivered.",
    });
    const requestMatch = await store.create({
      conversationId: "conversation-a",
      agentRunId: "agent-run-request",
      userRequest: "Investigate invoice INV-200.",
      now: new Date("2026-08-17T07:00:00.000Z"),
    });
    const titleMatch = await store.create({
      conversationId: "conversation-b",
      agentRunId: "agent-run-title",
      userRequest: "Review the latest item.",
      title: "Customer CASE-300 review",
      now: new Date("2026-08-17T08:00:00.000Z"),
    });
    await store.create({
      conversationId: "conversation-a",
      agentRunId: "agent-run-newest",
      userRequest: "Unrelated newest request.",
      now: new Date("2026-08-17T09:00:00.000Z"),
    });

    assert.deepEqual((await store.list({ search: "ship-900", limit: 1 })).map((run) => run.id), [summaryMatch.run.id]);
    assert.deepEqual((await store.list({ search: "inv-200" })).map((run) => run.id), [requestMatch.run.id]);
    assert.deepEqual(
      (await store.list({ conversationId: "conversation-b", search: "case-300" })).map((run) => run.id),
      [titleMatch.run.id],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the file Operation Run store supplies caller scope for legacy records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-operation-store-"));
  try {
    const operationId = "op_legacy-operation";
    const runtimeDirectory = path.join(root, ".runtime", "operations");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(
      path.join(runtimeDirectory, `${operationId}.json`),
      JSON.stringify({
        id: operationId,
        ontologyId: "knowledge-base-a",
        sessionId: "conversation-a",
        userRequest: "operate: Check a legacy record.",
        status: "running",
        logs: [],
        artifacts: [],
        startedAt: "2026-08-16T08:00:00.000Z",
      }),
      "utf-8",
    );
    const store = createFileOperationRunStore({ workspaceRoot: root, tenantId: "tenant-a", ownerId: "owner-a", knowledgeBaseId: "knowledge-base-a" });

    const reloaded = await store.read(operationId);

    assert.deepEqual(
      { tenantId: reloaded.tenantId, ownerId: reloaded.ownerId },
      { tenantId: "tenant-a", ownerId: "owner-a" },
    );

    const renamed = await store.updateTitle(operationId, "Renamed legacy operation");
    assert.deepEqual(
      { tenantId: renamed.tenantId, ownerId: renamed.ownerId, title: renamed.title },
      { tenantId: "tenant-a", ownerId: "owner-a", title: "Renamed legacy operation" },
    );

    const logged = await store.appendLog({ operationId, summary: "Checked the legacy record." });
    assert.deepEqual(
      { tenantId: logged.tenantId, ownerId: logged.ownerId, logCount: logged.logs.length },
      { tenantId: "tenant-a", ownerId: "owner-a", logCount: 1 },
    );

    const finished = await store.finish({
      operationId,
      status: "succeeded",
      resultSummary: "Legacy record checked.",
    });
    assert.deepEqual(
      { tenantId: finished.tenantId, ownerId: finished.ownerId, status: finished.status },
      { tenantId: "tenant-a", ownerId: "owner-a", status: "succeeded" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operation_start uses the server-held Operation Run context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-operation-runtime-"));
  await writeJourneyState(root, { flow: "maintenance", phase: "ready" });
  const runtimeServer = createOntologyRuntimeMcpServer(root, {
    tenantId: "tenant-a",
    ownerId: "owner-a",
    ontologyId: "knowledge-base-a",
    sessionId: "conversation-a",
    runId: "agent-run-a",
    userRequest: "Check order ORD-100 and summarize its current status.",
    runTrace: { readOperateSkillPaths: new Set(["skills/operate/SKILL.md"]) },
  }, createFileOperationRunStore);
  const client = new Client({ name: "operation-store-contract", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtimeServer.instance.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "operation_start",
      arguments: {
        title: "Check order status",
        user_request: "Agent-supplied paraphrase that must not become the record.",
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(
      Object.hasOwn(result.structuredContent ?? {}, "operation_path"),
      false,
      "provider-neutral operation_start output must not expose the JSON record path",
    );

    const store = createFileOperationRunStore({ workspaceRoot: root, tenantId: "tenant-a", ownerId: "owner-a", knowledgeBaseId: "knowledge-base-a" });
    const [created] = await store.list();
    assert.deepEqual(
      {
        tenantId: created.tenantId,
        ownerId: created.ownerId,
        ontologyId: created.ontologyId,
        sessionId: created.sessionId,
        agentRunId: created.agentRunId,
        userRequest: created.userRequest,
      },
      {
        tenantId: "tenant-a",
        ownerId: "owner-a",
        ontologyId: "knowledge-base-a",
        sessionId: "conversation-a",
        agentRunId: "agent-run-a",
        userRequest: "Check order ORD-100 and summarize its current status.",
      },
    );
  } finally {
    await client.close().catch(() => undefined);
    await runtimeServer.instance.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("operation_start is blocked during Verify and does not create an Operation Run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-operation-runtime-"));
  await writeJourneyState(root, { flow: "build", phase: "verify" });
  const runtimeServer = createOntologyRuntimeMcpServer(root, {
    tenantId: "tenant-a",
    ownerId: "owner-a",
    ontologyId: "knowledge-base-a",
    sessionId: "conversation-a",
    runId: "agent-run-a",
    userRequest: "Import source documents and verify the staged knowledge.",
    runTrace: { readOperateSkillPaths: new Set(["skills/operate/SKILL.md"]) },
  }, createFileOperationRunStore);
  const client = new Client({ name: "operation-start-gate-contract", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtimeServer.instance.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "operation_start",
      arguments: {
        title: "Batch answer verification questions",
        user_request: "Agent-supplied paraphrase that must not become the record.",
      },
    });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as Record<string, unknown>)?.reason, "operation_not_allowed_in_workflow");
    assert.equal((result.structuredContent as Record<string, unknown>)?.phase, "verify");
    assert.match(String(result.content?.[0]?.type === "text" ? result.content[0].text : ""), /Current workflow phase: verify/);

    const store = createFileOperationRunStore({ workspaceRoot: root, tenantId: "tenant-a", ownerId: "owner-a", knowledgeBaseId: "knowledge-base-a" });
    assert.deepEqual(await store.list(), []);
  } finally {
    await client.close().catch(() => undefined);
    await runtimeServer.instance.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge_prepare_ingest_draft rejects a new draft while an existing ingest draft is unfinished", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-ingest-draft-gate-"));
  await mkdir(path.join(root, "pending_review", "drafts", "ingest-existing", "knowledge"), { recursive: true });
  await mkdir(path.join(root, "ingest-plans"), { recursive: true });
  await writeFile(path.join(root, "ingest-plans", "new-source.json"), JSON.stringify({
    plan_id: "new-source",
    draft_id: "ingest-new-source",
    source_name: "New Source",
    created_at: "2026-08-17 08:00",
    target_directory: "raw/new-source",
    total_files: 1,
    total_batches: 1,
    status: "in_progress",
    batches: [
      {
        id: "batch-1",
        label: "New Source",
        description: "New source batch",
        files: ["raw/new-source/doc.md"],
        status: "pending",
      },
    ],
  }, null, 2), "utf-8");

  const runtimeServer = createOntologyRuntimeMcpServer(root);
  const client = new Client({ name: "ingest-draft-gate-contract", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtimeServer.instance.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "knowledge_prepare_ingest_draft",
      arguments: { draft_id: "ingest-new-source" },
    });

    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as Record<string, unknown>)?.reason, "pending_review_draft_exists");
    assert.deepEqual((result.structuredContent as Record<string, unknown>)?.existingDraftIds, ["ingest-existing"]);
    const message = String(result.content?.[0]?.type === "text" ? result.content[0].text : "");
    assert.match(message, /Continue the existing ingest workflow first for ingest-existing/);
    assert.match(message, /Run Verify for pending_review\/drafts\/ingest-existing\/knowledge/);
    assert.equal(await pathExists(path.join(root, "pending_review", "drafts", "ingest-new-source")), false);
  } finally {
    await client.close().catch(() => undefined);
    await runtimeServer.instance.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
