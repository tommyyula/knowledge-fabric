import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOperationId } from "../server/operations/model";
import { createOperationRunStore } from "../server/operations/store";

const root = await mkdtemp(path.join(tmpdir(), "knowledge-operation-"));

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

try {
  const store = createOperationRunStore({ workspaceRoot: root, tenantId: "tenant-smoke", ownerId: "owner-smoke", knowledgeBaseId: "kb/customer-success-demo" }, null);
  const journeyPath = path.join(root, ".runtime", "journey-state.json");
  await mkdir(path.dirname(journeyPath), { recursive: true });
  await writeFile(
    journeyPath,
    JSON.stringify(
      {
        flow: "maintenance",
        phase: "ready",
        updatedAt: "2026-08-13T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf-8",
  );
  const journeyBefore = await readFile(journeyPath, "utf-8");
  const fixedNow = new Date("2026-08-13T07:42:33.000Z");

  const readableChineseId = createOperationId({
    title: "查询 LOAD-40084 预约状态",
    userRequest: "LOAD-40084 是否已经做过预约，如果有预约的时间是什么",
    now: fixedNow,
  });
  assert.match(
    readableChineseId,
    /^op_20260813-074233Z__query-load-40084-appointment__[a-z0-9]{6}$/,
    "operation id should include UTC timestamp, semantic task slug, and random code",
  );

  const created = await store.create({
    conversationId: "session:main/chat",
    agentRunId: "agent-run:main",
    userRequest: "operate: Check the customer success workflow from knowledge and ontology, then generate results.",
    title: "Customer success workflow check",
    now: fixedNow,
  });

  assert.match(
    created.run.id,
    /^op_20260813-074233Z__generate-customer-case-workflow__[a-z0-9]{6}$/,
    "operation id should include UTC timestamp, semantic task slug, and random code",
  );
  assert.equal(created.run.status, "running");
  assert.equal(created.reportPath, `operations/${created.run.id}/report.md`);
  assert.equal(created.artifactsDir, `operations/${created.run.id}/artifacts`);
  const operationPath = `.runtime/operations/${created.run.id}.json`;
  assert.equal(await exists(path.join(root, operationPath)), true, "runtime operation JSON should be written");
  assert.equal(await exists(path.join(root, created.artifactsDir)), true, "artifacts directory should be created");

  await store.appendLog({
    operationId: created.run.id,
    summary: "Read relevant knowledge and ontology files.",
    path: "knowledge/index.md",
  });

  const artifactPath = path.posix.join(created.artifactsDir, "result.json");
  await writeFile(path.join(root, artifactPath), JSON.stringify({ ok: true }, null, 2), "utf-8");
  await store.appendLog({
    operationId: created.run.id,
    summary: "Generated operation result JSON.",
    path: artifactPath,
    artifact: true,
  });

  await store.finish({
    operationId: created.run.id,
    status: "succeeded",
    resultSummary: "Check completed with no blocking issues.",
    reportMarkdown: "# Operation Report\n\nCheck completed with no blocking issues.",
  });

  const finished = await store.read(created.run.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.resultSummary, "Check completed with no blocking issues.");
  assert.equal(finished.reportPath, created.reportPath);
  assert.equal(finished.artifacts.some((artifact) => artifact.path === artifactPath), true);
  assert.equal(finished.artifacts.some((artifact) => artifact.path === created.reportPath), true);
  assert.equal(await exists(path.join(root, created.reportPath)), true, "report should be written on finish");

  const journeyAfter = await readFile(journeyPath, "utf-8");
  assert.equal(journeyAfter, journeyBefore, "operation repository must not modify JourneyState");

  const newerRun = await store.create({
    conversationId: "session:follow-up",
    agentRunId: "agent-run:follow-up",
    userRequest: "  OPERATE: Generate a follow-up result.",
    now: new Date("2026-08-13T08:00:00.000Z"),
  });
  const internalRun = await store.create({
    conversationId: "session:verification",
    agentRunId: "agent-run:verification",
    userRequest: "Batch answer verification questions",
    now: new Date("2026-08-13T09:00:00.000Z"),
  });
  await writeFile(path.join(root, ".runtime", "operations", "broken.json"), "{not-json", "utf-8");
  await writeFile(path.join(root, ".runtime", "operations", "incomplete.json"), JSON.stringify({ id: "op_incomplete" }), "utf-8");

  const allRuns = await store.list();
  assert.deepEqual(
    allRuns.map((run) => run.id),
    [internalRun.run.id, newerRun.run.id, finished.id],
    "operation runs should be sorted newest first while ignoring invalid records",
  );

  const userRuns = await store.list();
  assert.deepEqual(
    userRuns.map((run) => run.id),
    [internalRun.run.id, newerRun.run.id, finished.id],
    "every successfully started operation should be user-visible",
  );

  const sessionRuns = await store.list({
    conversationId: finished.sessionId,
  });
  assert.deepEqual(sessionRuns.map((run) => run.id), [finished.id], "session filtering should only return matching runs");
  const missingStore = createOperationRunStore({
    workspaceRoot: path.join(root, "missing-workspace"),
    tenantId: "tenant-smoke",
    ownerId: "owner-smoke",
    knowledgeBaseId: "kb/customer-success-demo",
  }, null);
  assert.deepEqual(await missingStore.list(), [], "missing operation directories should return an empty list");

  const renamed = await store.updateTitle(finished.id, "Renamed operation");
  assert.equal(renamed.title, "Renamed operation", "operation titles should be persisted");
  assert.equal((await store.read(finished.id)).title, "Renamed operation");

  await store.delete(finished.id);
  assert.equal(await exists(path.join(root, operationPath)), false, "deleting a run should remove its runtime record");
  assert.equal(await exists(path.join(root, created.reportPath)), false, "deleting a run should remove its report");
  assert.equal(await exists(path.join(root, created.artifactsDir)), false, "deleting a run should remove its artifacts directory");
  assert.equal(await readFile(journeyPath, "utf-8"), journeyBefore, "operation mutations must not modify JourneyState");

  console.log("operation run smoke ok", { operationId: created.run.id });
} finally {
  await rm(root, { recursive: true, force: true });
}
