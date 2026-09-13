import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const dataRoot = await mkdtemp(path.join(tmpdir(), "knowledge-maintenance-"));
const workspaceRoot = path.join(dataRoot, "ontology-workspaces");
const port = String(21000 + Math.floor(Math.random() * 1000));
const tenantId = "maintenance-smoke-tenant";
const server = spawn(path.join(root, "node_modules", ".bin", "tsx"), ["server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    APP_DATA_ROOT: dataRoot,
    ONTOLOGY_WORKSPACE_ROOT: workspaceRoot,
    RESOURCE_LIBRARY_ROOT: path.join(dataRoot, "resource-library"),
    CLAUDE_SESSION_STORE_ROOT: path.join(dataRoot, "claude-session-store"),
    ONTOLOGY_SERVER_PORT: port,
    ONTOLOGY_ENABLE_CLAUDE: "false",
    ONTOLOGY_IAM_ENABLED: "false",
    VITE_IAM_ENABLED: "false",
    DATABASE_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
server.stdout.on("data", (chunk) => { logs += chunk.toString(); });
server.stderr.on("data", (chunk) => { logs += chunk.toString(); });

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become healthy\n${logs}`);
}

async function api(pathname, init = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { TenantID: tenantId, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf-8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await waitForHealth();
  const createResponse = await api("/api/v1/ontologies", {
    method: "POST",
    body: JSON.stringify({ name: "Maintenance Journey Smoke" }),
  });
  const createText = await createResponse.text();
  assert(createResponse.status === 201, `create failed: ${createResponse.status} ${createText}`);
  const created = JSON.parse(createText);
  const ontologyId = created.data.project.id;
  const workspace = path.join(workspaceRoot, "tenants", tenantId, "users", "dev-user", "ontologies", ontologyId);
  const planId = "new-maintenance-source-2026-07-16-a1b2";
  const draftId = `ingest-${planId}`;
  const planPath = path.join(workspace, "ingest-plans", `${planId}.json`);

  await rm(path.join(workspace, "BOOTSTRAP.md"), { force: true });
  await writeJson(path.join(workspace, ".runtime", "journey-state.json"), {
    ...created.data.journeyState,
    flow: "maintenance",
    phase: "ready",
    bootstrap: { ...created.data.journeyState.bootstrap, status: "done", awaitingUser: false, step: 6 },
    ingest: { files: [], generatedPages: [], totalBatches: 0, completedBatches: 0, progress: 0, batches: [] },
    verify: { status: "generating", questionCount: 0, coverage: 0, autoFixed: 0, needsInput: 0, cases: [], fixes: [] },
    review: undefined,
    updatedAt: new Date().toISOString(),
  });

  // A valid legacy artifact must remain historical once a new maintenance run starts.
  await writeJson(path.join(workspace, "verify", "verify-old-bootstrap-source-2026-07-15.json"), {
    knowledge_path: "pending_review/drafts/ingest-old-bootstrap-source/knowledge",
    questions: [{ id: 1, level: "fact", question: "OLD_VERIFY_QUESTION", expected_answer: "old" }],
  });
  await writeJson(path.join(workspace, "verify", "verify-old-bootstrap-source-2026-07-15-results.json"), {
    knowledge_path: "pending_review/drafts/ingest-old-bootstrap-source/knowledge",
    results: [{ id: 1, question: "OLD_VERIFY_QUESTION", knowledge_answer: "old", result: "pass" }],
  });
  const draftIndex = path.join(workspace, "pending_review", "drafts", draftId, "knowledge", "index.md");
  await mkdir(path.dirname(draftIndex), { recursive: true });
  await writeFile(draftIndex, "# Current draft\n", "utf-8");
  await writeJson(planPath, {
    plan_id: planId,
    draft_id: draftId,
    target_directory: "raw/new-maintenance-source.md",
    total_files: 1,
    total_batches: 1,
    status: "in_progress",
    batches: [{ id: "batch-1", label: "new source", files: ["raw/new-maintenance-source.md"], status: "pending" }],
  });

  const pendingJourney = (await (await api(`/api/v1/ontologies/${ontologyId}/journey`)).json()).data;
  assert(pendingJourney.flow === "maintenance", `expected maintenance flow, got ${pendingJourney.flow}`);
  assert(pendingJourney.phase === "ingest", `stale Verify displaced pending ingest: ${pendingJourney.phase}`);
  assert(pendingJourney.ingest.planId === planId, `wrong active plan: ${pendingJourney.ingest.planId}`);
  assert(pendingJourney.ingest.status === "in_progress", `pending plan was marked ${pendingJourney.ingest.status}`);
  assert(pendingJourney.verify.questionCount === 0, "legacy Verify questions leaked into the active run");

  await writeJson(planPath, {
    plan_id: planId,
    draft_id: draftId,
    target_directory: "raw/new-maintenance-source.md",
    total_files: 1,
    total_batches: 1,
    status: "in_progress",
    batches: [{ id: "batch-1", label: "new source", files: ["raw/new-maintenance-source.md"], status: "success" }],
  });
  const preparingVerify = (await (await api(`/api/v1/ontologies/${ontologyId}/journey`)).json()).data;
  assert(preparingVerify.phase === "verify", `completed batches should prepare Verify, got ${preparingVerify.phase}`);
  assert(preparingVerify.verify.questionCount === 0, "old Verify appeared while current Verify was not generated");
  assert(preparingVerify.ingest.status === "in_progress", "Verify projection completed the plan before the skill did");

  const runDir = path.join(workspace, "verify", planId);
  await writeJson(path.join(runDir, "dataset.json"), {
    plan_id: planId,
    draft_id: draftId,
    source_path: "raw/new-maintenance-source.md",
    knowledge_path: `pending_review/drafts/${draftId}/knowledge`,
    questions: [{ id: 1, level: "fact", question: "CURRENT_VERIFY_QUESTION", expected_answer: "current" }],
  });
  await writeJson(path.join(runDir, "results.json"), {
    plan_id: planId,
    draft_id: draftId,
    knowledge_path: `pending_review/drafts/${draftId}/knowledge`,
    results: [{ id: 1, question: "CURRENT_VERIFY_QUESTION", knowledge_answer: "current", result: "pass" }],
  });
  const currentVerify = (await (await api(`/api/v1/ontologies/${ontologyId}/journey`)).json()).data;
  assert(currentVerify.phase === "verify", `Verify dwell should show current results first, got ${currentVerify.phase}`);
  assert(currentVerify.verify.planId === planId, `wrong Verify plan: ${currentVerify.verify.planId}`);
  assert(currentVerify.verify.draftId === draftId, `wrong Verify draft: ${currentVerify.verify.draftId}`);
  assert(currentVerify.verify.cases[0]?.question === "CURRENT_VERIFY_QUESTION", "current run directory was not projected");
  assert(currentVerify.ingest.status === "in_progress", "current Verify incorrectly completed its ingest plan");

  console.log("maintenance journey smoke ok", { ontologyId, planId, draftId });
} finally {
  server.kill("SIGTERM");
  await rm(dataRoot, { recursive: true, force: true });
}
