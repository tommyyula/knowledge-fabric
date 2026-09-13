import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { TaskState } from "@a2a-js/sdk";
import { ClientFactory, DefaultAgentCardResolver, RestTransportFactory } from "@a2a-js/sdk/client";

const root = process.cwd();
const dataRoot = await mkdtemp(path.join(tmpdir(), "a2a-external-query-"));
const port = String(21000 + Math.floor(Math.random() * 1000));
const serverEnv = {
  ...process.env,
  APP_DATA_ROOT: dataRoot,
  DATABASE_URL: "",
  COMPOSIO_API_KEY: "",
  ONTOLOGY_SERVER_PORT: port,
  A2A_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  ONTOLOGY_WORKSPACE_ROOT: path.join(dataRoot, "ontology-workspaces"),
  ONTOLOGY_ENABLE_CLAUDE: "false",
  ONTOLOGY_IAM_ENABLED: "true",
  VITE_IAM_ENABLED: "true",
  A2A_QUERY_START_DELAY_MS: "250",
};

function startServer() {
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: root,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  server.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  return { server, logs: () => logs };
}

let active = startServer();

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // Keep waiting for the isolated server.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy\n${active.logs()}`);
}

function gatewayToken(userId) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "gateway-validated" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    email: `${userId}@example.test`,
    data: { user_id: userId, user_name: userId, tenant_id: "a2a-tenant" },
  })).toString("base64url");
  return `${header}.${payload}.gateway-validated`;
}

function authenticatedSdkFetch(userId) {
  return async (input, init = {}) => {
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    headers.set("Authorization", `Bearer ${gatewayToken(userId)}`);
    const response = await fetch(input, { ...init, headers });
    if (!response.ok) throw new Error(`SDK fetch failed ${response.status}: ${await response.clone().text()} url=${input instanceof Request ? input.url : input}`);
    return response;
  };
}

async function sendA2AMessage(operation, authorization = `Bearer ${gatewayToken("a2a-owner")}`) {
  return fetch(`http://127.0.0.1:${port}/api/v1/a2a/message:send`, {
    method: "POST",
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      "A2A-Version": "1.0",
      "Content-Type": "application/a2a+json",
    },
    body: JSON.stringify({
      message: {
        messageId: crypto.randomUUID(),
        role: "ROLE_USER",
        parts: [{ data: operation, mediaType: "application/json" }],
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
}

async function internalApi(pathname, init = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${gatewayToken("a2a-owner")}`,
      TenantID: "a2a-tenant",
      "x-user-id": "a2a-owner",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

async function stopServer() {
  active.server.kill("SIGTERM");
  await new Promise((resolve) => active.server.once("exit", resolve));
}

async function createQueryReadyKnowledgeBases() {
  const projects = [];
  for (const name of ["A2A Platform Reference", "A2A Platform Reference Next"]) {
    const response = await internalApi("/api/v1/ontologies", { method: "POST", body: JSON.stringify({ name }) });
    if (response.status !== 201) throw new Error(`A2A fixture creation failed ${response.status}: ${await response.text()}`);
    projects.push((await response.json()).data.project);
  }
  for (const project of projects) {
    const workspace = path.join(serverEnv.ONTOLOGY_WORKSPACE_ROOT, "tenants", "a2a-tenant", "users", "a2a-owner", "ontologies", project.id);
    const journeyPath = path.join(workspace, ".runtime", "journey-state.json");
    const journey = JSON.parse(await readFile(journeyPath, "utf8"));
    journey.flow = "maintenance";
    journey.phase = "ready";
    journey.bootstrap = { ...journey.bootstrap, status: "done", awaitingUser: false };
    await writeFile(journeyPath, JSON.stringify(journey, null, 2));
    const knowledge = path.join(workspace, "knowledge");
    await mkdir(knowledge, { recursive: true });
    for (const file of ["index.md", "overview.md", "glossary.md", "log.md"]) {
      await writeFile(path.join(knowledge, file), `# ${file}\n`);
    }
  }
  await stopServer();
  const rebuild = spawn(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/rebuild-query-readiness.ts"], { cwd: root, env: serverEnv, stdio: "pipe" });
  let output = "";
  rebuild.stdout.on("data", (chunk) => { output += chunk.toString(); });
  rebuild.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const code = await new Promise((resolve) => rebuild.once("exit", resolve));
  if (code !== 0) throw new Error(`A2A readiness fixture failed: ${output}`);
  active = startServer();
  await waitForHealth();
  return projects;
}

async function sendA2AQuery(knowledgeBaseId, messageId, contextId, extraParts = [], question = "Summarize this knowledge base.") {
  return fetch(`http://127.0.0.1:${port}/api/v1/a2a/message:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gatewayToken("a2a-owner")}`, "A2A-Version": "1.0", "Content-Type": "application/a2a+json" },
    body: JSON.stringify({
      message: {
        messageId,
        ...(contextId ? { contextId } : {}),
        role: "ROLE_USER",
        parts: [
          { data: { operation: "knowledge_base_query", knowledgeBaseId }, mediaType: "application/json" },
          { text: question, mediaType: "text/plain" },
          ...extraParts,
        ],
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
}

async function getA2ATask(taskId, ownerId = "a2a-owner") {
  return fetch(`http://127.0.0.1:${port}/api/v1/a2a/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${gatewayToken(ownerId)}`, "A2A-Version": "1.0" },
    signal: AbortSignal.timeout(30_000),
  });
}

try {
  await waitForHealth();
  const [ready, readyNext] = await createQueryReadyKnowledgeBases();
  const response = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
  if (!response.ok) throw new Error(`Agent Card discovery failed ${response.status}: ${await response.text()}`);
  const card = await response.json();
  if (card.name !== "Knowledge Fabric" || card.supportedInterfaces?.[0]?.protocolBinding !== "HTTP+JSON" || card.supportedInterfaces?.[0]?.protocolVersion !== "1.0") {
    throw new Error(`Agent Card did not advertise the A2A 1.0 HTTP+JSON interface: ${JSON.stringify(card)}`);
  }
  if (!card.securitySchemes || !Array.isArray(card.securityRequirements) || !card.skills?.some((skill) => skill.id === "knowledge_base_search")) {
    throw new Error(`Agent Card did not publish authentication and catalog discovery: ${JSON.stringify(card)}`);
  }
  const catalogSkill = card.skills.find((skill) => skill.id === "knowledge_base_search");
  if (catalogSkill.examples?.some((example) => Object.hasOwn(JSON.parse(example), "q"))) {
    throw new Error(`Agent Card still advertises ambiguous A2A catalog filtering: ${JSON.stringify(catalogSkill)}`);
  }
  if (!card.skills.some((skill) => skill.id === "knowledge_base_query")) throw new Error(`Agent Card did not advertise the available query Task: ${JSON.stringify(card)}`);
  const documentation = await fetch(card.documentationUrl.replace("http://localhost:8888", `http://127.0.0.1:${port}`));
  const documentationText = await documentation.text();
  if (!documentation.ok || !documentationText.includes("attachmentsProcessed:false") || !documentationText.includes("A2A-Version: 1.0")) throw new Error("A2A integration documentation is not publicly available or complete");

  const unauthenticated = await sendA2AMessage({ operation: "knowledge_base_search" }, "");
  if (unauthenticated.status !== 401) {
    throw new Error(`A2A operation did not require authentication: ${unauthenticated.status} ${await unauthenticated.text()}`);
  }

  const search = await sendA2AMessage({ operation: "knowledge_base_search", limit: 20 });
  if (!search.ok) throw new Error(`A2A catalog search failed ${search.status}: ${await search.text()}\n${active.logs()}`);
  const searchBody = await search.json();
  const catalog = searchBody.message?.parts?.find((part) => Object.hasOwn(part, "data"))?.data;
  if (!Array.isArray(catalog?.items) || catalog.nextCursor !== null) {
    throw new Error(`A2A catalog search did not return a structured Message: ${JSON.stringify(searchBody)}`);
  }
  if (!catalog.items.some((item) => item.knowledgeBaseId === ready.id) || !catalog.items.some((item) => item.knowledgeBaseId === readyNext.id)) {
    throw new Error(`A2A catalog did not preserve REST caller scope: ${JSON.stringify(catalog)}`);
  }
  const sdkFetch = authenticatedSdkFetch("a2a-owner");
  const sdkClient = await new ClientFactory({
    transports: [new RestTransportFactory({ fetchImpl: sdkFetch })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: sdkFetch }),
  }).createFromUrl(`http://127.0.0.1:${port}`);
  const sdkCatalogMessage = await sdkClient.sendMessage({
    tenant: "",
    message: {
      messageId: crypto.randomUUID(), contextId: "", taskId: "", role: 1,
      parts: [{ content: { $case: "data", value: { operation: "knowledge_base_search", limit: 20 } }, metadata: undefined, filename: "", mediaType: "application/json" }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  }).catch((error) => { throw new Error(`Official A2A client request failed: ${error instanceof Error ? error.stack : error}\n${active.logs()}`); });
  const sdkCatalog = sdkCatalogMessage.parts?.find((part) => part.content?.$case === "data")?.content?.value;
  if (!Array.isArray(sdkCatalog?.items) || !sdkCatalog.items.some((item) => item.knowledgeBaseId === ready.id)) {
    throw new Error(`Official A2A 1.0 client could not discover the Queryable Knowledge Base Catalog: ${JSON.stringify(sdkCatalogMessage)}`);
  }
  const sdkQueryTask = await sdkClient.sendMessage({
    tenant: "",
    message: {
      messageId: "a2a-sdk-query-smoke", contextId: "", taskId: "", role: 1,
      parts: [
        { content: { $case: "data", value: { operation: "knowledge_base_query", knowledgeBaseId: ready.id } }, metadata: undefined, filename: "", mediaType: "application/json" },
        { content: { $case: "text", value: "Answer through the official A2A client." }, metadata: undefined, filename: "", mediaType: "text/plain" },
      ],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  });
  if (!("id" in sdkQueryTask) || !sdkQueryTask.id) throw new Error(`Official A2A client query did not create a Task: ${JSON.stringify(sdkQueryTask)}`);
  let sdkCompletedTask = sdkQueryTask;
  for (let attempt = 0; attempt < 40 && sdkCompletedTask.status?.state !== TaskState.TASK_STATE_COMPLETED; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    sdkCompletedTask = await sdkClient.getTask({ tenant: "", id: sdkQueryTask.id, historyLength: 0 });
  }
  if (sdkCompletedTask.status?.state !== TaskState.TASK_STATE_COMPLETED || !sdkCompletedTask.artifacts?.some((artifact) => artifact.name === "knowledge-answer")) {
    throw new Error(`Official A2A client could not complete and poll a query Task: ${JSON.stringify(sdkCompletedTask)}`);
  }
  const ignoredFilter = await sendA2AMessage({ operation: "knowledge_base_search", q: "does-not-match-any-knowledge-base" });
  const ignoredFilterCatalog = (await ignoredFilter.json()).message?.parts?.find((part) => Object.hasOwn(part, "data"))?.data;
  if (!ignoredFilter.ok || !ignoredFilterCatalog?.items?.some((item) => item.knowledgeBaseId === ready.id) || !ignoredFilterCatalog.items.some((item) => item.knowledgeBaseId === readyNext.id)) {
    throw new Error(`A2A catalog still applied the removed q filter: ${JSON.stringify(ignoredFilterCatalog)}`);
  }
  const firstPage = await sendA2AMessage({ operation: "knowledge_base_search", limit: 1 });
  const firstCatalog = (await firstPage.json()).message?.parts?.find((part) => Object.hasOwn(part, "data"))?.data;
  if (!firstPage.ok || firstCatalog?.items?.length !== 1 || typeof firstCatalog?.nextCursor !== "string") throw new Error(`A2A catalog did not expose opaque pagination: ${JSON.stringify(firstCatalog)}`);
  const secondPage = await sendA2AMessage({ operation: "knowledge_base_search", limit: 1, cursor: firstCatalog.nextCursor });
  const secondCatalog = (await secondPage.json()).message?.parts?.find((part) => Object.hasOwn(part, "data"))?.data;
  if (!secondPage.ok || secondCatalog?.items?.length !== 1 || secondCatalog?.nextCursor !== null || secondCatalog.items[0].knowledgeBaseId === firstCatalog.items[0].knowledgeBaseId) {
    throw new Error(`A2A catalog cursor did not return the next page: ${JSON.stringify(secondCatalog)}`);
  }
  const isolatedCatalogResponse = await sendA2AMessage({ operation: "knowledge_base_search" }, `Bearer ${gatewayToken("another-owner")}`);
  const isolatedCatalog = (await isolatedCatalogResponse.json()).message?.parts?.find((part) => Object.hasOwn(part, "data"))?.data;
  if (!isolatedCatalogResponse.ok || isolatedCatalog?.items?.length !== 0) throw new Error(`A2A catalog leaked another principal's Knowledge Bases: ${JSON.stringify(isolatedCatalog)}`);
  const invalidOperation = await sendA2AMessage({ operation: "guess_from_text" });
  if (invalidOperation.status !== 400) throw new Error(`A2A accepted an unknown implicit operation: ${invalidOperation.status} ${await invalidOperation.text()}`);

  const messageId = "a2a-query-smoke";
  const query = await sendA2AQuery(ready.id, messageId);
  if (!query.ok) throw new Error(`A2A query was not accepted ${query.status}: ${await query.text()}\n${active.logs()}`);
  const accepted = await query.json();
  if (!accepted.task?.id || !accepted.task?.contextId || !["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED"].includes(accepted.task?.status?.state)) {
    throw new Error(`A2A query did not return an accepted Task: ${JSON.stringify(accepted)}`);
  }
  let completed;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const poll = await getA2ATask(accepted.task.id);
    if (!poll.ok) throw new Error(`A2A Task polling failed ${poll.status}: ${await poll.text()}`);
    const task = await poll.json();
    if (task.status?.state === "TASK_STATE_COMPLETED") { completed = task; break; }
    if (["TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"].includes(task.status?.state)) throw new Error(`A2A query reached the wrong terminal state: ${JSON.stringify(task)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const answer = completed?.artifacts?.find((artifact) => artifact.name === "knowledge-answer")?.parts?.find((part) => typeof part.text === "string")?.text;
  if (!String(answer ?? "").trim() || completed.contextId !== accepted.task.contextId) throw new Error(`A2A Task did not expose the knowledge answer Artifact: ${JSON.stringify(completed)}`);
  if (JSON.stringify(completed.history ?? []).includes("Summarize this knowledge base.")) throw new Error(`A2A Task persisted or projected the caller's question in Task history: ${JSON.stringify(completed.history)}`);
  const replay = await sendA2AQuery(ready.id, messageId);
  const replayBody = await replay.json();
  if (!replay.ok || replayBody.task?.id !== accepted.task.id) throw new Error(`A2A messageId retry did not replay the original Task: ${JSON.stringify(replayBody)}`);
  const conflictingReplay = await sendA2AQuery(ready.id, messageId, undefined, [], "Use the same messageId for another question.");
  if (conflictingReplay.status !== 409) throw new Error(`A2A conflicting messageId reuse was not rejected: ${conflictingReplay.status} ${await conflictingReplay.text()}`);
  const isolatedPoll = await getA2ATask(accepted.task.id, "another-owner");
  if (isolatedPoll.status !== 404) throw new Error(`A2A Task was visible to another principal: ${isolatedPoll.status} ${await isolatedPoll.text()}`);

  const continuation = await sendA2AQuery(ready.id, "a2a-continuation-smoke", accepted.task.contextId, [], "Continue the previous answer.");
  const continuationBody = await continuation.json();
  if (!continuation.ok || continuationBody.task?.contextId !== accepted.task.contextId) throw new Error(`A2A continuation did not retain contextId: ${JSON.stringify(continuationBody)}`);

  const attachmentBytes = Buffer.from("temporary attachment input").toString("base64");
  const withAttachment = await sendA2AQuery(ready.id, "a2a-attachment-smoke", undefined, [{ raw: attachmentBytes, filename: "notes.txt", mediaType: "text/custom" }]);
  if (!withAttachment.ok) throw new Error(`A2A inline attachment was rejected ${withAttachment.status}: ${await withAttachment.text()}`);
  const attachmentTask = (await withAttachment.json()).task;
  const receipt = attachmentTask?.metadata?.attachments?.[0];
  if (receipt?.name !== "notes.txt" || receipt?.mediaType !== "text/custom" || receipt?.size !== 26 || receipt?.processed !== false || attachmentTask?.metadata?.attachmentsProcessed !== false) {
    throw new Error(`A2A Task did not explicitly receipt the unprocessed attachment: ${JSON.stringify(attachmentTask)}`);
  }
  if (JSON.stringify(attachmentTask).includes(attachmentBytes)) throw new Error("A2A Task persisted or replayed raw attachment bytes");

  const remoteFile = await sendA2AQuery(ready.id, "a2a-remote-file-smoke", undefined, [{ url: "https://example.test/file.txt", filename: "file.txt" }]);
  if (remoteFile.status !== 400) throw new Error(`A2A query accepted a remote URI File Part: ${remoteFile.status} ${await remoteFile.text()}`);
  const malformedFile = await sendA2AQuery(ready.id, "a2a-malformed-file-smoke", undefined, [{ raw: null, filename: "file.txt" }]);
  if (malformedFile.status !== 400) throw new Error(`A2A query accepted a malformed inline File Part: ${malformedFile.status} ${await malformedFile.text()}`);

  const cancelQuery = await sendA2AQuery(ready.id, "a2a-cancel-smoke");
  const cancelTask = (await cancelQuery.json()).task;
  const canceled = await fetch(`http://127.0.0.1:${port}/api/v1/a2a/tasks/${cancelTask.id}:cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gatewayToken("a2a-owner")}`, "A2A-Version": "1.0" },
  });
  const canceledTask = await canceled.json();
  if (!canceled.ok || canceledTask.status?.state !== "TASK_STATE_CANCELED") throw new Error(`A2A active Task cancellation failed: ${JSON.stringify(canceledTask)}`);
  const repeatedCancel = await fetch(`http://127.0.0.1:${port}/api/v1/a2a/tasks/${cancelTask.id}:cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gatewayToken("a2a-owner")}`, "A2A-Version": "1.0" },
  });
  if (!repeatedCancel.ok || (await repeatedCancel.json()).status?.state !== "TASK_STATE_CANCELED") throw new Error("A2A repeated cancellation was not idempotent");

  const activeContext = await sendA2AQuery(ready.id, "a2a-context-active-smoke");
  const activeTask = (await activeContext.json()).task;
  const concurrent = await sendA2AQuery(ready.id, "a2a-context-conflict-smoke", activeTask.contextId);
  if (concurrent.status !== 409) throw new Error(`A2A accepted concurrent work in one context: ${concurrent.status} ${await concurrent.text()}`);
  await fetch(`http://127.0.0.1:${port}/api/v1/a2a/tasks/${activeTask.id}:cancel`, { method: "POST", headers: { Authorization: `Bearer ${gatewayToken("a2a-owner")}`, "A2A-Version": "1.0" } });

  const streamed = await fetch(`http://127.0.0.1:${port}/api/v1/a2a/message:stream`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gatewayToken("a2a-owner")}`, "A2A-Version": "1.0", "Content-Type": "application/a2a+json" },
    body: JSON.stringify({ message: { messageId: "a2a-stream-smoke", role: "ROLE_USER", parts: [
      { data: { operation: "knowledge_base_query", knowledgeBaseId: ready.id }, mediaType: "application/json" },
      { text: "Stream this knowledge answer.", mediaType: "text/plain" },
    ] } }),
    signal: AbortSignal.timeout(30_000),
  });
  const streamEvents = await streamed.text();
  if (!streamed.ok || !String(streamed.headers.get("content-type")).includes("text/event-stream") || !streamEvents.includes('"task"') || !streamEvents.includes('"artifactUpdate"') || !streamEvents.includes('"append":true') || !streamEvents.includes("TASK_STATE_COMPLETED")) {
    throw new Error(`A2A streaming did not emit the Task and answer lifecycle: ${streamed.status} ${streamEvents}`);
  }

  const disconnectController = new AbortController();
  const disconnectStream = await fetch(`http://127.0.0.1:${port}/api/v1/a2a/message:stream`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gatewayToken("a2a-owner")}`, "A2A-Version": "1.0", "Content-Type": "application/a2a+json" },
    body: JSON.stringify({ message: { messageId: "a2a-disconnect-smoke", role: "ROLE_USER", parts: [
      { data: { operation: "knowledge_base_query", knowledgeBaseId: ready.id }, mediaType: "application/json" },
      { text: "Complete after this stream disconnects.", mediaType: "text/plain" },
    ] } }),
    signal: disconnectController.signal,
  });
  const firstChunk = await disconnectStream.body.getReader().read();
  const firstEvent = new TextDecoder().decode(firstChunk.value);
  const disconnectedTaskId = firstEvent.match(/"id":"([0-9a-f-]{36})"/i)?.[1];
  if (!disconnectedTaskId) throw new Error(`A2A disconnect stream did not begin with a Task: ${firstEvent}`);
  disconnectController.abort();
  let completedAfterDisconnect = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const poll = await getA2ATask(disconnectedTaskId);
    const task = await poll.json();
    if (task.status?.state === "TASK_STATE_COMPLETED") { completedAfterDisconnect = true; break; }
  }
  if (!completedAfterDisconnect) throw new Error("Disconnecting A2A SSE canceled or orphaned the underlying query");

  const listed = await fetch(`http://127.0.0.1:${port}/api/v1/a2a/tasks?includeArtifacts=true`, { headers: { Authorization: `Bearer ${gatewayToken("a2a-owner")}`, "A2A-Version": "1.0" } });
  const listBody = await listed.json();
  if (!listed.ok || !listBody.tasks?.some((task) => task.id === accepted.task.id)) throw new Error(`A2A Task listing omitted the caller's Task: ${JSON.stringify(listBody)}`);

  const recoverable = await sendA2AQuery(ready.id, "a2a-restart-smoke", undefined, [{ raw: Buffer.from("restart cleanup").toString("base64"), filename: "restart.txt" }]);
  const recoverableTask = (await recoverable.json()).task;
  const expiring = await sendA2AQuery(ready.id, "a2a-expiry-smoke", undefined, [{ raw: Buffer.from("expiry cleanup").toString("base64"), filename: "expiry.txt" }]);
  const expiringTask = (await expiring.json()).task;
  await stopServer();
  const taskStorePath = path.join(dataRoot, "a2a-task-store.json");
  const taskRecords = JSON.parse(await readFile(taskStorePath, "utf8"));
  const expiredRecord = taskRecords.find((record) => record.task?.id === expiringTask.id);
  if (!expiredRecord) throw new Error("A2A expiry fixture Task was not persisted");
  expiredRecord.expiresAt = new Date(Date.now() - 1_000).toISOString();
  await writeFile(taskStorePath, JSON.stringify(taskRecords, null, 2));
  const ontologyStorePath = path.join(dataRoot, "ontology-store.json");
  const ontologySnapshot = JSON.parse(await readFile(ontologyStorePath, "utf8"));
  const recoveryRunId = crypto.randomUUID();
  const recoveredAnswer = "Recovered from the persisted Run answer.";
  ontologySnapshot.externalQueryIdempotency ??= [];
  ontologySnapshot.externalQueryIdempotency.push({
    tenantId: "a2a-tenant",
    ownerId: "a2a-owner",
    ontologyId: ready.id,
    keyHash: createHash("sha256").update("a2a-restart-smoke").digest("hex"),
    requestFingerprint: "restart-smoke",
    conversationId: recoverableTask.contextId,
    status: "in_progress",
    runId: recoveryRunId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  ontologySnapshot.events ??= [];
  ontologySnapshot.events.push(
    { tenantId: "a2a-tenant", ontologyId: ready.id, sessionId: recoverableTask.contextId, runId: recoveryRunId, sequence: 1, event: { type: "text-delta", delta: recoveredAnswer }, createdAt: new Date().toISOString() },
    { tenantId: "a2a-tenant", ontologyId: ready.id, sessionId: recoverableTask.contextId, runId: recoveryRunId, sequence: 2, event: { type: "message", message: { content: recoveredAnswer } }, createdAt: new Date().toISOString() },
  );
  await writeFile(ontologyStorePath, JSON.stringify(ontologySnapshot, null, 2));
  await mkdir(path.join(dataRoot, "a2a-query-attachments", expiringTask.id), { recursive: true });
  await writeFile(path.join(dataRoot, "a2a-query-attachments", expiringTask.id, "expired.txt"), "expired");
  active = startServer();
  await waitForHealth();
  const durableCompleted = await getA2ATask(accepted.task.id);
  if (!durableCompleted.ok || (await durableCompleted.json()).status?.state !== "TASK_STATE_COMPLETED") throw new Error("A2A completed Task did not survive restart");
  const recovered = await getA2ATask(recoverableTask.id);
  const recoveredTask = await recovered.json();
  const recoveredArtifact = recoveredTask.artifacts?.find((artifact) => artifact.name === "knowledge-answer")?.parts?.find((part) => typeof part.text === "string")?.text;
  if (!recovered.ok || recoveredTask.status?.state !== "TASK_STATE_COMPLETED" || recoveredArtifact !== recoveredAnswer) {
    throw new Error(`A2A interrupted Task was not reconciled after restart: ${JSON.stringify(recoveredTask)}`);
  }
  const expired = await getA2ATask(expiringTask.id);
  if (expired.status !== 404) throw new Error(`Expired A2A Task remained queryable: ${expired.status} ${await expired.text()}`);
  await rejectsAccess(path.join(dataRoot, "a2a-query-attachments", recoverableTask.id), "A2A restart reconciliation left Query Attachments behind");
  await rejectsAccess(path.join(dataRoot, "a2a-query-attachments", expiringTask.id), "A2A expiry left Query Attachments behind");
  const ontologyStore = JSON.parse(await readFile(path.join(dataRoot, "ontology-store.json"), "utf8"));
  const a2aAudits = (ontologyStore.externalAccessAuditEvents ?? []).filter((event) => event.protocol === "a2a");
  if (!a2aAudits.some((event) => event.operation === "knowledge_base_search") || !a2aAudits.some((event) => event.operation === "knowledge_base_query")) {
    throw new Error(`A2A operations were not identified in external access audit: ${JSON.stringify(a2aAudits)}`);
  }
  const auditText = JSON.stringify(a2aAudits);
  if (auditText.includes("Summarize this knowledge base") || auditText.includes(attachmentBytes) || auditText.includes("a2a-query-attachments")) throw new Error("A2A audit persisted query content, attachment bytes, or internal paths");
  const taskStoreText = await readFile(path.join(dataRoot, "a2a-task-store.json"), "utf8");
  if (taskStoreText.includes(attachmentBytes)) throw new Error("A2A Task Store persisted raw attachment bytes");
  console.log("A2A external query smoke ok");
} finally {
  active.server.kill("SIGTERM");
  await rm(dataRoot, { recursive: true, force: true });
}

async function rejectsAccess(target, message) {
  try {
    await access(target);
  } catch {
    return;
  }
  throw new Error(message);
}
