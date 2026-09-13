import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("Operation Run history API searches and pages a stable owner-scoped result set", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "knowledge-operation-history-api-"));
  process.env.APP_DATA_ROOT = dataRoot;
  process.env.DATABASE_URL = "";
  process.env.ONTOLOGY_IAM_ENABLED = "false";
  context.after(() => rm(dataRoot, { recursive: true, force: true }));

  const [{ operationsRouter }, { errorHandler }, { createProject }, { workspacePath }, { createOperationRunStore }] = await Promise.all([
    import("../server/operations/routes.ts"),
    import("../server/http.ts"),
    import("../server/ontologies/repository.ts"),
    import("../server/ontologies/workspace.ts"),
    import("../server/operations/store.ts"),
  ]);
  const firstProject = await createProject({ tenantId: "tenant-a", ownerId: "owner-a", name: "First KB" });
  const secondProject = await createProject({ tenantId: "tenant-a", ownerId: "owner-a", name: "Second KB" });
  const hiddenProject = await createProject({ tenantId: "tenant-b", ownerId: "owner-b", name: "Hidden KB" });
  const storeFor = (tenantId: string, ownerId: string, knowledgeBaseId: string) => createOperationRunStore({
    workspaceRoot: workspacePath(tenantId, ownerId, knowledgeBaseId),
    tenantId,
    ownerId,
    knowledgeBaseId,
  }, null);
  const firstStore = storeFor("tenant-a", "owner-a", firstProject.id);
  const secondStore = storeFor("tenant-a", "owner-a", secondProject.id);
  const sharedTime = new Date("2026-08-17T08:00:00.000Z");
  const created = await Promise.all([
    firstStore.create({ conversationId: "conversation-a", agentRunId: "agent-run-a", userRequest: "First unprefixed request", now: sharedTime }),
    secondStore.create({ conversationId: "conversation-b", agentRunId: "agent-run-b", userRequest: "Second unprefixed request", now: sharedTime }),
    firstStore.create({ conversationId: "conversation-a", agentRunId: "agent-run-search", userRequest: "Find the archived shipment needle", now: new Date("2026-08-17T07:00:00.000Z") }),
  ]);
  await storeFor("tenant-b", "owner-b", hiddenProject.id).create({
    conversationId: "conversation-hidden",
    agentRunId: "agent-run-hidden",
    userRequest: "Tenant B secret operation",
    now: new Date("2026-08-17T09:00:00.000Z"),
  });
  const equalTimestampIds = created.slice(0, 2).map(({ run }) => run.id).sort().reverse();

  const app = express();
  app.use(express.json());
  app.use("/api/v1/operations", operationsRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = await listen(server);
  const ownerHeaders = { "x-tenant-id": "tenant-a", "x-user-id": "owner-a" };

  const firstResponse = await fetch(`${baseUrl}/api/v1/operations?limit=2`, { headers: ownerHeaders });
  assert.equal(firstResponse.status, 200);
  const firstPage = await firstResponse.json() as { data: { items: Array<{ id: string }>; nextCursor?: string } };
  assert.deepEqual(firstPage.data.items.map((run) => run.id), equalTimestampIds);
  assert.equal(typeof firstPage.data.nextCursor, "string");

  const secondResponse = await fetch(
    `${baseUrl}/api/v1/operations?limit=2&cursor=${encodeURIComponent(firstPage.data.nextCursor ?? "")}`,
    { headers: ownerHeaders },
  );
  assert.equal(secondResponse.status, 200);
  const secondPage = await secondResponse.json() as { data: { items: Array<{ id: string }>; nextCursor?: string } };
  assert.deepEqual(secondPage.data.items.map((run) => run.id), [created[2].run.id]);
  assert.equal(secondPage.data.nextCursor, undefined);

  await Promise.all(Array.from({ length: 48 }, (_, index) => secondStore.create({
    conversationId: "conversation-bulk",
    agentRunId: `agent-run-bulk-${index}`,
    userRequest: `Bulk history request ${index}`,
    now: new Date(Date.parse("2026-08-17T06:00:00.000Z") - index * 1_000),
  })));
  const defaultResponse = await fetch(`${baseUrl}/api/v1/operations`, { headers: ownerHeaders });
  const defaultPage = await defaultResponse.json() as { data: { items: unknown[]; nextCursor?: string } };
  assert.equal(defaultPage.data.items.length, 50);
  assert.equal(typeof defaultPage.data.nextCursor, "string");

  const searchedResponse = await fetch(`${baseUrl}/api/v1/operations?search=ARCHIVED%20SHIPMENT&limit=1`, { headers: ownerHeaders });
  const searchedPage = await searchedResponse.json() as { data: { items: Array<{ id: string }> } };
  assert.deepEqual(searchedPage.data.items.map((run) => run.id), [created[2].run.id]);

  const filteredResponse = await fetch(
    `${baseUrl}/api/v1/operations?ontologyId=${encodeURIComponent(firstProject.id)}&sessionId=conversation-a`,
    { headers: ownerHeaders },
  );
  const filteredPage = await filteredResponse.json() as { data: { items: Array<{ id: string }> } };
  assert.deepEqual(new Set(filteredPage.data.items.map((run) => run.id)), new Set([created[0].run.id, created[2].run.id]));

  const hiddenResponse = await fetch(`${baseUrl}/api/v1/operations?search=secret`, { headers: ownerHeaders });
  const hiddenPage = await hiddenResponse.json() as { data: { items: unknown[] } };
  assert.deepEqual(hiddenPage.data.items, []);

  const runningDelete = await fetch(
    `${baseUrl}/api/v1/operations/${encodeURIComponent(created[0].run.id)}?ontologyId=${encodeURIComponent(firstProject.id)}`,
    { method: "DELETE", headers: ownerHeaders },
  );
  assert.equal(runningDelete.status, 409);
  assert.equal((await firstStore.read(created[0].run.id)).status, "running");

  const lifecyclePatch = await fetch(`${baseUrl}/api/v1/operations/${encodeURIComponent(created[0].run.id)}`, {
    method: "PATCH",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ ontologyId: firstProject.id, title: "Renamed run", status: "failed" }),
  });
  assert.equal(lifecyclePatch.status, 400);
  const titlePatch = await fetch(`${baseUrl}/api/v1/operations/${encodeURIComponent(created[0].run.id)}`, {
    method: "PATCH",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ ontologyId: firstProject.id, title: "Renamed run" }),
  });
  assert.equal(titlePatch.status, 200);
  const renamed = await titlePatch.json() as { data: { title?: string; status: string; startedAt: string } };
  assert.deepEqual(
    { title: renamed.data.title, status: renamed.data.status, startedAt: renamed.data.startedAt },
    { title: "Renamed run", status: created[0].run.status, startedAt: created[0].run.startedAt },
  );

  assert.equal((await fetch(`${baseUrl}/api/v1/operations?limit=101`, { headers: ownerHeaders })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/v1/operations?cursor=not-a-valid-cursor`, { headers: ownerHeaders })).status, 400);
});
