import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const openApi = await readFile(path.join(root, "docs", "external-knowledge-query.openapi.yaml"), "utf8");
if (!openApi.includes("openapi: 3.1.0") || !openApi.includes("/knowledge-bases/{knowledgeBaseId}/queries:") || !openApi.includes("idempotency_key_reused")) {
  throw new Error("external OpenAPI contract is missing the query and idempotency definitions");
}
const mcpDocumentation = await readFile(path.join(root, "docs", "external-knowledge-query-mcp.md"), "utf8");
if (!mcpDocumentation.includes("knowledge_base_search") || !mcpDocumentation.includes("knowledge_base_query")) {
  throw new Error("external MCP documentation is missing the public tool definitions");
}
const dataRoot = await mkdtemp(path.join(tmpdir(), "external-knowledge-catalog-"));
const workspaceRoot = path.join(dataRoot, "ontology-workspaces");
const port = String(20000 + Math.floor(Math.random() * 1000));
const serverEnv = {
  ...process.env,
  APP_DATA_ROOT: dataRoot,
  DATABASE_URL: "",
  COMPOSIO_API_KEY: "",
  ONTOLOGY_SERVER_PORT: port,
  ONTOLOGY_WORKSPACE_ROOT: workspaceRoot,
  ONTOLOGY_ENABLE_CLAUDE: "false",
  ONTOLOGY_IAM_ENABLED: "true",
  VITE_IAM_ENABLED: "true",
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

async function stopServer(server) {
  if (!server.pid) return;
  server.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function waitForHealth(logs) {
  for (let i = 0; i < 40; i += 1) {
    try {
      if (!logs().includes("server listening on")) throw new Error("server has not started listening");
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // Keep waiting for the local server.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy\n${logs()}`);
}

async function waitForServerStopped() {
  for (let i = 0; i < 20; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("initial catalog server still accepted requests after shutdown");
}

async function api(pathname, init = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: {
      TenantID: "catalog-tenant",
      "x-user-id": "catalog-owner",
      Authorization: `Bearer ${gatewayToken("catalog-owner")}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

function gatewayToken(userId) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "gateway-validated" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    email: `${userId}@example.test`,
    data: { user_id: userId, user_name: userId, tenant_id: "catalog-tenant", company_code: "catalog-tenant", tenants: ["catalog-tenant"] },
  })).toString("base64url");
  return `${header}.${payload}.gateway-validated`;
}

async function publicApi(pathname, init = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${gatewayToken("catalog-owner")}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

async function mcp(rpc, sessionId) {
  return fetch(`http://127.0.0.1:${port}/api/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gatewayToken("catalog-owner")}`,
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(rpc),
    signal: AbortSignal.timeout(30_000),
  });
}

async function createKnowledgeBase(name, ownerId = "catalog-owner") {
  const response = await api("/api/v1/ontologies", {
    method: "POST",
    headers: { "x-user-id": ownerId, Authorization: `Bearer ${gatewayToken(ownerId)}` },
    body: JSON.stringify({ name }),
  });
  if (response.status !== 201) throw new Error(`knowledge base creation failed ${response.status}: ${await response.text()}`);
  return (await response.json()).data.project;
}

async function setJourney(project, ownerId, update) {
  const workspace = path.join(workspaceRoot, "tenants", "catalog-tenant", "users", ownerId, "ontologies", project.id);
  const journeyPath = path.join(workspace, ".runtime", "journey-state.json");
  const state = JSON.parse(await readFile(journeyPath, "utf8"));
  state.flow = update.flow;
  state.phase = update.phase;
  state.bootstrap = { ...state.bootstrap, status: "done", awaitingUser: false };
  if (update.phase === "review") state.review = { ...(state.review ?? {}), status: "pending", description: "Review is open", files: [] };
  await writeFile(journeyPath, JSON.stringify(state, null, 2));
  if (update.flow === "maintenance" && update.phase === "ready") {
    const knowledge = path.join(workspace, "knowledge");
    await mkdir(knowledge, { recursive: true });
    for (const file of ["index.md", "overview.md", "glossary.md", "log.md"]) {
      await writeFile(path.join(knowledge, file), `# ${file}\n`);
    }
  }
}

async function rebuildQueryReadiness() {
  const rebuild = spawn(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/rebuild-query-readiness.ts"], {
    cwd: root,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  rebuild.stdout.on("data", (chunk) => { output += chunk.toString(); });
  rebuild.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const code = await new Promise((resolve) => rebuild.once("exit", resolve));
  if (code !== 0) throw new Error(`readiness rebuild failed: ${output}`);
}

let active = startServer();

try {
  await waitForHealth(active.logs);
  const ready = await createKnowledgeBase("Platform Reference");
  const readyNext = await createKnowledgeBase("Platform Reference Next");
  const building = await createKnowledgeBase("Knowledge Base Still Building");
  const review = await createKnowledgeBase("Review Reference");
  const otherOwner = await createKnowledgeBase("Other Platform Reference", "another-owner");

  await setJourney(ready, "catalog-owner", { flow: "maintenance", phase: "ready" });
  await setJourney(readyNext, "catalog-owner", { flow: "maintenance", phase: "ready" });
  await setJourney(building, "catalog-owner", { flow: "build", phase: "ingest" });
  await setJourney(review, "catalog-owner", { flow: "maintenance", phase: "review" });
  await setJourney(otherOwner, "another-owner", { flow: "maintenance", phase: "ready" });
  await stopServer(active.server);
  await waitForServerStopped();

  await rebuildQueryReadiness();
  active = startServer();
  await waitForHealth(active.logs);

  const firstPage = await publicApi("/api/v1/knowledge-bases?q=reference&limit=1");
  if (!firstPage.ok) throw new Error(`catalog request failed ${firstPage.status}: ${await firstPage.text()}`);
  const firstBody = await firstPage.json();
  if (firstBody.data?.items?.length !== 1 || typeof firstBody.data?.nextCursor !== "string") throw new Error(`catalog did not return the first cursor page: ${JSON.stringify(firstBody)}`);
  const [firstItem] = firstBody.data.items;
  if (![ready.id, readyNext.id].includes(firstItem.knowledgeBaseId) || firstItem.queryReady !== true || typeof firstItem.updatedAt !== "string") {
    throw new Error(`catalog item did not expose the public ready knowledge base shape: ${JSON.stringify(firstItem)}`);
  }

  const secondPage = await publicApi(`/api/v1/knowledge-bases?q=reference&limit=1&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`);
  if (!secondPage.ok) throw new Error(`second catalog page failed ${secondPage.status}: ${await secondPage.text()}`);
  const secondBody = await secondPage.json();
  if (secondBody.data?.items?.length !== 1 || secondBody.data?.nextCursor !== null) throw new Error(`catalog did not finish cursor pagination: ${JSON.stringify(secondBody)}`);
  const [secondItem] = secondBody.data.items;
  if (secondItem.knowledgeBaseId === firstItem.knowledgeBaseId || ![ready.id, readyNext.id].includes(secondItem.knowledgeBaseId)) {
    throw new Error(`catalog cursor returned the wrong ready knowledge base: ${JSON.stringify(secondItem)}`);
  }

  const oversizedPage = await publicApi("/api/v1/knowledge-bases?limit=101");
  if (oversizedPage.status !== 400) {
    throw new Error(`catalog accepted a page larger than 100: ${oversizedPage.status} ${await oversizedPage.text()}`);
  }

  const invalidCursor = await publicApi("/api/v1/knowledge-bases?cursor=not-a-valid-cursor");
  if (invalidCursor.status !== 400 || !String(invalidCursor.headers.get("content-type")).includes("application/problem+json")) {
    throw new Error(`catalog invalid cursor did not return a public problem: ${invalidCursor.status} ${await invalidCursor.text()}`);
  }

  const notReadyQuery = await publicApi(`/api/v1/knowledge-bases/${building.id}/queries`, {
    method: "POST",
    headers: { "Idempotency-Key": "building-query" },
    body: JSON.stringify({ message: "Can I query this knowledge base?" }),
  });
  if (notReadyQuery.status !== 409 || !String(notReadyQuery.headers.get("content-type")).includes("application/problem+json")) {
    throw new Error(`non-ready knowledge base did not return the public conflict contract: ${notReadyQuery.status} ${await notReadyQuery.text()}`);
  }
  const notReadyProblem = await notReadyQuery.json();
  if (notReadyProblem.code !== "knowledge_base_not_query_ready") {
    throw new Error(`non-ready knowledge base returned the wrong problem code: ${JSON.stringify(notReadyProblem)}`);
  }

  const readyQuery = await publicApi(`/api/v1/knowledge-bases/${ready.id}/queries`, {
    method: "POST",
    headers: { "Idempotency-Key": "ready-query" },
    body: JSON.stringify({ message: "Summarize this knowledge base." }),
  });
  if (!readyQuery.ok) throw new Error(`ready knowledge base query failed ${readyQuery.status}: ${await readyQuery.text()}\n${active.logs()}`);
  const readyResult = await readyQuery.json();
  if (typeof readyResult.data?.conversationId !== "string" || !String(readyResult.data?.answer ?? "").trim()) {
    throw new Error(`ready knowledge base query did not return a conversation and answer: ${JSON.stringify(readyResult)}`);
  }
  if (!readyQuery.headers.get("x-request-id")) throw new Error("ready knowledge base query did not return a request correlation ID");

  await stopServer(active.server);
  await waitForServerStopped();
  active = startServer();
  await waitForHealth(active.logs);

  const repeatedQuery = await publicApi(`/api/v1/knowledge-bases/${ready.id}/queries`, {
    method: "POST",
    headers: { "Idempotency-Key": "ready-query" },
    body: JSON.stringify({ message: "Summarize this knowledge base." }),
  });
  if (!repeatedQuery.ok) throw new Error(`idempotent retry failed ${repeatedQuery.status}: ${await repeatedQuery.text()}`);
  const repeatedResult = await repeatedQuery.json();
  if (repeatedResult.data?.conversationId !== readyResult.data.conversationId || repeatedResult.data?.answer !== readyResult.data.answer) {
    throw new Error(`idempotent retry did not replay the original result: ${JSON.stringify(repeatedResult)}`);
  }

  const conflictingRetry = await publicApi(`/api/v1/knowledge-bases/${ready.id}/queries`, {
    method: "POST",
    headers: { "Idempotency-Key": "ready-query" },
    body: JSON.stringify({ message: "Answer a different question." }),
  });
  if (conflictingRetry.status !== 409) throw new Error(`conflicting idempotency retry was not rejected: ${conflictingRetry.status} ${await conflictingRetry.text()}`);

  const continuation = await publicApi(`/api/v1/knowledge-bases/${ready.id}/queries`, {
    method: "POST",
    headers: { "Idempotency-Key": "continued-query" },
    body: JSON.stringify({ conversationId: readyResult.data.conversationId, message: "Tell me more." }),
  });
  if (!continuation.ok) throw new Error(`conversation continuation failed ${continuation.status}: ${await continuation.text()}`);
  const continuationResult = await continuation.json();
  if (continuationResult.data?.conversationId !== readyResult.data.conversationId || !String(continuationResult.data?.answer ?? "").trim()) {
    throw new Error(`conversation continuation did not reuse the supplied conversation: ${JSON.stringify(continuationResult)}`);
  }

  const missingConversation = await publicApi(`/api/v1/knowledge-bases/${ready.id}/queries`, {
    method: "POST",
    headers: { "Idempotency-Key": "missing-conversation" },
    body: JSON.stringify({ conversationId: "missing-conversation", message: "Tell me more." }),
  });
  if (missingConversation.status !== 404 || !String(missingConversation.headers.get("content-type")).includes("application/problem+json")) {
    throw new Error(`missing conversation did not return the public not-found contract: ${missingConversation.status} ${await missingConversation.text()}`);
  }

  const streamedQuery = await publicApi(`/api/v1/knowledge-bases/${ready.id}/queries`, {
    method: "POST",
    headers: { "Idempotency-Key": "streamed-query" },
    body: JSON.stringify({ message: "Stream this answer.", stream: true }),
  });
  if (!streamedQuery.ok || !String(streamedQuery.headers.get("content-type")).includes("text/event-stream")) {
    throw new Error(`streamed query did not open an SSE response: ${streamedQuery.status} ${await streamedQuery.text()}`);
  }
  const streamedEvents = await streamedQuery.text();
  if (!streamedEvents.includes("event: conversation") || !streamedEvents.includes("text-delta")) {
    throw new Error(`streamed query did not expose conversation and text events: ${streamedEvents}`);
  }

  const streamedReplay = await publicApi(`/api/v1/knowledge-bases/${ready.id}/queries`, {
    method: "POST",
    headers: { "Idempotency-Key": "streamed-query" },
    body: JSON.stringify({ message: "Stream this answer.", stream: true }),
  });
  if (!streamedReplay.ok || String(streamedReplay.headers.get("content-type")).includes("text/event-stream")) {
    throw new Error(`completed stream retry did not replay the final JSON result: ${streamedReplay.status} ${await streamedReplay.text()}`);
  }
  const streamedReplayResult = await streamedReplay.json();
  if (typeof streamedReplayResult.data?.conversationId !== "string" || !String(streamedReplayResult.data?.answer ?? "").trim()) {
    throw new Error(`completed stream retry did not return the persisted result: ${JSON.stringify(streamedReplayResult)}`);
  }

  const initialize = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  const mcpSessionId = initialize.headers.get("mcp-session-id");
  if (!initialize.ok || !mcpSessionId) throw new Error(`MCP initialize failed: ${initialize.status} ${await initialize.text()}`);
  const initialized = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, mcpSessionId);
  if (initialized.status !== 202) throw new Error(`MCP initialized notification failed: ${initialized.status}`);
  const mcpTools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, mcpSessionId);
  const mcpToolsBody = await mcpTools.json();
  if (!mcpTools.ok || !mcpToolsBody.result?.tools?.some((tool) => tool.name === "knowledge_base_search") || !mcpToolsBody.result?.tools?.some((tool) => tool.name === "knowledge_base_query")) {
    throw new Error(`MCP tools/list did not expose the public tool set: ${JSON.stringify(mcpToolsBody)}`);
  }
  const mcpSearch = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "knowledge_base_search", arguments: { q: "Platform" } } }, mcpSessionId);
  const mcpSearchBody = await mcpSearch.json();
  if (!mcpSearch.ok || !mcpSearchBody.result?.structuredContent?.items?.some((item) => item.knowledgeBaseId === ready.id)) {
    throw new Error(`MCP search did not match REST catalog scope: ${JSON.stringify(mcpSearchBody)}`);
  }
  const mcpQuery = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "knowledge_base_query", arguments: { knowledgeBaseId: ready.id, message: "Ask through MCP.", requestId: "mcp-query" } } }, mcpSessionId);
  const mcpQueryBody = await mcpQuery.json();
  if (!mcpQuery.ok || mcpQueryBody.result?.structuredContent?.status !== "in_progress" || typeof mcpQueryBody.result?.structuredContent?.conversationId !== "string" || !String(mcpQueryBody.result?.content?.[0]?.text ?? "").includes('"requestId":"mcp-query"') || !String(mcpQueryBody.result?.content?.[0]?.text ?? "").includes("server-issued conversationId")) {
    throw new Error(`MCP query did not return prompt in-progress recovery data: ${JSON.stringify(mcpQueryBody)}`);
  }
  let mcpCompleted = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retry = await mcp({ jsonrpc: "2.0", id: 5 + attempt, method: "tools/call", params: { name: "knowledge_base_query", arguments: { knowledgeBaseId: ready.id, message: "Ask through MCP.", requestId: "mcp-query" } } }, mcpSessionId);
    const retryBody = await retry.json();
    if (String(retryBody.result?.structuredContent?.answer ?? "").trim()) {
      mcpCompleted = retryBody;
      break;
    }
  }
  if (!mcpCompleted) {
    throw new Error("MCP query did not complete after retrying its in-progress request");
  }
  const mcpConversationId = mcpCompleted.result?.structuredContent?.conversationId;
  const mcpFollowup = await mcp({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "knowledge_base_query", arguments: { knowledgeBaseId: ready.id, message: "Continue through the same MCP conversation.", requestId: "mcp-followup", conversationId: "mcp-query" } } }, mcpSessionId);
  const mcpFollowupBody = await mcpFollowup.json();
  if (!mcpFollowup.ok || mcpFollowupBody.result?.structuredContent?.status !== "in_progress" || mcpFollowupBody.result?.structuredContent?.conversationId !== mcpConversationId) {
    throw new Error(`MCP follow-up did not recover the server conversation from its session state: ${JSON.stringify(mcpFollowupBody)}`);
  }
  console.log("external knowledge catalog smoke ok");
} finally {
  await stopServer(active.server);
  await rm(dataRoot, { recursive: true, force: true });
}
