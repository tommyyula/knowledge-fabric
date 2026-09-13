import http from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const dataRoot = await mkdtemp(path.join(tmpdir(), "knowledge-operate-live-"));
const workspaceRoot = path.join(dataRoot, "ontology-workspaces");
const resourceRoot = path.join(dataRoot, "resource-library");
const claudeSessionStoreRoot = path.join(dataRoot, "claude-session-store");
const serverPort = String(22000 + Math.floor(Math.random() * 1000));
const mockPort = String(23000 + Math.floor(Math.random() * 1000));
const tenantId = "operate-live-tenant";
const mockCalls = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : null;
}

const mockServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${mockPort}`);
    if (req.method === "GET" && url.pathname === "/orders/ORD-1001") {
      mockCalls.push({ method: "GET", path: url.pathname });
      return jsonResponse(res, 200, {
        id: "ORD-1001",
        status: "ready_for_picking",
        inventoryReserved: true,
        warehouse: "WH-SH-01",
        priority: "rush",
      });
    }
    if (req.method === "POST" && url.pathname === "/picking-tasks") {
      const body = await readRequestBody(req);
      mockCalls.push({ method: "POST", path: url.pathname, body });
      return jsonResponse(res, 201, {
        taskId: "PICK-ORD-1001-001",
        status: "created",
        orderId: body?.orderId,
        warehouse: body?.warehouse,
        priority: body?.priority,
      });
    }
    mockCalls.push({ method: req.method, path: url.pathname, unexpected: true });
    return jsonResponse(res, 404, { error: "not_found", path: url.pathname });
  } catch (error) {
    return jsonResponse(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

await new Promise((resolve) => mockServer.listen(Number(mockPort), "127.0.0.1", resolve));

const server = spawn(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    APP_DATA_ROOT: dataRoot,
    ONTOLOGY_WORKSPACE_ROOT: workspaceRoot,
    RESOURCE_LIBRARY_ROOT: resourceRoot,
    CLAUDE_SESSION_STORE_ROOT: claudeSessionStoreRoot,
    ONTOLOGY_SERVER_PORT: serverPort,
    ONTOLOGY_ENABLE_CLAUDE: "true",
    ONTOLOGY_IAM_ENABLED: "false",
    VITE_IAM_ENABLED: "false",
    DATABASE_URL: "",
    CLAUDE_SESSION_STORE: "file",
    COMPOSIO_API_KEY: "",
    ONTOLOGY_PROXY_MODEL: process.env.ONTOLOGY_PROXY_MODEL ?? process.env.STEWARD_PROXY_MODEL ?? "gpt-5.4",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
server.stdout.on("data", (chunk) => { logs += chunk.toString(); });
server.stderr.on("data", (chunk) => { logs += chunk.toString(); });

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${serverPort}/healthz`)).ok) return;
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy\n${logs}`);
}

async function api(pathname, init = {}) {
  return fetch(`http://127.0.0.1:${serverPort}${pathname}`, {
    ...init,
    headers: { TenantID: tenantId, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(300000),
  });
}

async function writeWorkspaceFile(workspace, relativePath, content) {
  const file = path.join(workspace, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf-8");
}

async function seedReadyOperationWorkspace(workspace) {
  await rm(path.join(workspace, "BOOTSTRAP.md"), { force: true });
  await writeWorkspaceFile(workspace, ".runtime/journey-state.json", JSON.stringify({
    flow: "maintenance",
    phase: "ready",
    bootstrap: { name: "Mock Order Operations", description: "Mock order fulfillment operations", pageTypes: [], sources: [], step: 6, totalSteps: 6, status: "done", awaitingUser: false, rawSources: [] },
    ingest: { files: [], generatedPages: [], totalBatches: 0, completedBatches: 0, progress: 100, batches: [], status: "completed" },
    verify: { status: "done", questionCount: 1, coverage: 100, autoFixed: 0, needsInput: 0, cases: [], fixes: [], passCount: 1, failCount: 0 },
    updatedAt: new Date().toISOString(),
  }, null, 2));
  await writeWorkspaceFile(workspace, "knowledge/index.md", [
    "# Mock Order Operations",
    "",
    "- [[runbooks/order-fulfillment-operations]]",
  ].join("\n"));
  await writeWorkspaceFile(workspace, "knowledge/runbooks/order-fulfillment-operations.md", [
    "# Order Fulfillment Operations",
    "",
    "Use this runbook for order status checks and picking task creation.",
    "",
    `Mock business backend base URL: http://127.0.0.1:${mockPort}`,
    "",
    "For order `ORD-1001`:",
    "",
    "1. Call `GET /orders/ORD-1001` on the mock business backend.",
    "2. If `status` is `ready_for_picking` and `inventoryReserved` is true, create a picking task by calling `POST /picking-tasks` with JSON body:",
    "",
    "```json",
    "{\"orderId\":\"ORD-1001\",\"warehouse\":\"<warehouse from order>\",\"priority\":\"<priority from order>\"}",
    "```",
    "",
    "Use Bash with `curl` to call the mock business backend. Do not invent the result without calling the backend.",
  ].join("\n"));
  await writeWorkspaceFile(workspace, "ontology/actions.yaml", [
    "actions:",
    "  - id: check_order_status",
    "    object: Order",
    "    endpoint: GET /orders/{orderId}",
    "    result_state: order_status_known",
    "  - id: create_picking_task",
    "    object: PickingTask",
    "    endpoint: POST /picking-tasks",
    "    preconditions:",
    "      - order.status == ready_for_picking",
    "      - order.inventoryReserved == true",
    "    result_state: picking_task_created",
  ].join("\n"));
  await writeWorkspaceFile(workspace, "ontology/object-model.yaml", [
    "objects:",
    "  Order:",
    "    fields: [id, status, inventoryReserved, warehouse, priority]",
    "  PickingTask:",
    "    fields: [taskId, orderId, warehouse, priority, status]",
  ].join("\n"));
}

async function readOperationRuns(workspace) {
  const dir = path.join(workspace, ".runtime", "operations");
  const files = await readdir(dir);
  const runs = [];
  for (const file of files.filter((item) => item.endsWith(".json"))) {
    runs.push(JSON.parse(await readFile(path.join(dir, file), "utf-8")));
  }
  return runs;
}

try {
  await waitForHealth();
  const createResponse = await api("/api/v1/ontologies", {
    method: "POST",
    body: JSON.stringify({ name: "Operate Live Smoke" }),
  });
  const createText = await createResponse.text();
  assert(createResponse.status === 201, `create failed: ${createResponse.status} ${createText}`);
  const created = JSON.parse(createText);
  const { project, session } = created.data;
  const workspace = path.join(workspaceRoot, "tenants", tenantId, "users", "dev-user", "ontologies", project.id);
  assert(existsSync(path.join(workspace, "CLAUDE.md")), "workspace CLAUDE.md missing");
  await seedReadyOperationWorkspace(workspace);

  const prompt = [
    "请执行一个业务操作，不要只解释：",
    "根据 knowledge 和 ontology 查一下订单 ORD-1001。",
    "如果它符合拣货条件，请实际调用业务系统创建拣货任务。",
    "完成后汇报你实际做了什么、调用结果和产物位置。",
  ].join("\n");

  const chatResponse = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`, {
    method: "POST",
    body: JSON.stringify({ message: prompt }),
  });
  const chatText = await chatResponse.text();
  assert(chatResponse.ok, `chat failed: ${chatResponse.status} ${chatText}\nserver logs:\n${logs}`);
  const chat = JSON.parse(chatText).data;
  const events = chat.events ?? [];
  const toolNames = events.filter((event) => event.type === "tool").map((event) => event.tool);
  const assistantText = chat.message?.content ?? "";

  assert(toolNames.some((name) => name.includes("operation_start")), `Claude did not call operation_start. tools=${JSON.stringify(toolNames)}\nanswer=${assistantText}`);
  assert(toolNames.some((name) => name.includes("operation_finish")), `Claude did not call operation_finish. tools=${JSON.stringify(toolNames)}\nanswer=${assistantText}`);
  assert(toolNames.some((name) => name === "Bash" || name.includes("Bash")), `Claude did not use Bash/curl. tools=${JSON.stringify(toolNames)}\nanswer=${assistantText}`);
  assert(mockCalls.some((call) => call.method === "GET" && call.path === "/orders/ORD-1001"), `mock backend did not receive order lookup. calls=${JSON.stringify(mockCalls)}\nanswer=${assistantText}`);
  const pickingCall = mockCalls.find((call) => call.method === "POST" && call.path === "/picking-tasks");
  assert(pickingCall, `mock backend did not receive picking task creation. calls=${JSON.stringify(mockCalls)}\nanswer=${assistantText}`);
  assert(pickingCall.body?.orderId === "ORD-1001", `unexpected picking body: ${JSON.stringify(pickingCall.body)}`);
  assert(pickingCall.body?.warehouse === "WH-SH-01", `picking task did not use warehouse from backend: ${JSON.stringify(pickingCall.body)}`);

  const operationRuns = await readOperationRuns(workspace);
  assert(operationRuns.length >= 1, "no operation run JSON was written");
  const latestRun = operationRuns.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))).at(-1);
  assert(latestRun.status === "succeeded", `operation did not finish succeeded: ${JSON.stringify(latestRun, null, 2)}`);
  assert(latestRun.logs.length >= 2, `operation logs were not recorded: ${JSON.stringify(latestRun, null, 2)}`);

  console.log("operate live smoke ok", {
    projectId: project.id,
    sessionId: session.id,
    operationId: latestRun.id,
    toolNames,
    mockCalls,
    claudeSessionId: chat.claudeSessionId,
  });
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => mockServer.close(resolve));
  await rm(dataRoot, { recursive: true, force: true });
}
