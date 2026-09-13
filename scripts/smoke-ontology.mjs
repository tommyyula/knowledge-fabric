import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const verifyClaudeIngest = process.argv.includes("--claude-ingest");
const enableClaude = process.argv.includes("--claude") || process.argv.includes("--claude-edit") || verifyClaudeIngest || process.env.ONTOLOGY_ENABLE_CLAUDE === "true";
const verifyClaudeEdit = process.argv.includes("--claude-edit");
const editMarker = `SMOKE_MARKER_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const ingestMarker = `INGEST_MARKER_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const workspaceRoot = await mkdtemp(path.join(tmpdir(), "ontology-workspaces-"));
const port = String(19000 + Math.floor(Math.random() * 1000));
const server = spawn(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ONTOLOGY_SERVER_PORT: port,
    ONTOLOGY_WORKSPACE_ROOT: workspaceRoot,
    ONTOLOGY_ENABLE_CLAUDE: enableClaude ? "true" : "false",
    ONTOLOGY_IAM_ENABLED: "false",
    VITE_IAM_ENABLED: "false",
    ...(enableClaude ? { ONTOLOGY_PROXY_MODEL: process.env.ONTOLOGY_PROXY_MODEL ?? process.env.STEWARD_PROXY_MODEL ?? "gpt-5.4" } : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
server.stdout.on("data", (chunk) => { logs += chunk.toString(); });
server.stderr.on("data", (chunk) => { logs += chunk.toString(); });

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy\n${logs}`);
}

async function api(pathname, init = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { TenantID: "smoke-tenant", "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(enableClaude ? 180000 : 30000),
  });
  return res;
}

function parseSse(text) {
  return text.split(/\n\n/).flatMap((block) => {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data)];
  });
}

try {
  await waitForHealth();
  const rejectedProxy = await fetch(`http://127.0.0.1:${port}/api/proxy/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "proxy:azure:gpt-5.4" },
    body: JSON.stringify({ messages: [{ role: "user", content: "should be rejected" }], max_tokens: 8 }),
    signal: AbortSignal.timeout(30000),
  });
  if (rejectedProxy.status !== 401) throw new Error(`unauthenticated proxy expected 401, got ${rejectedProxy.status}: ${await rejectedProxy.text()}`);

  const createRes = await api("/api/v1/ontologies", { method: "POST", body: JSON.stringify({ name: enableClaude ? "Claude Smoke Ontology" : "Smoke Ontology" }) });
  if (createRes.status !== 201) throw new Error(`create failed ${createRes.status}: ${await createRes.text()}`);
  const created = await createRes.json();
  const { project, session } = created.data;
  if (!project?.id || !session?.id) throw new Error("create response missing project/session");

  const workspace = path.join(workspaceRoot, "tenants", "smoke-tenant", "users", "dev-user", "ontologies", project.id);
  if (!existsSync(path.join(workspace, "CLAUDE.md"))) throw new Error("seeded root CLAUDE.md missing");

  const treeRes = await api(`/api/v1/ontologies/${project.id}/tree`);
  const treeText = await treeRes.text();
  if (!treeRes.ok) throw new Error(`content tree failed: ${treeText}`);
  if (treeText.includes("CLAUDE.md")) throw new Error(`content tree leaked workspace root files: ${treeText}`);

  const initialWorkspaceTreeRes = await api(`/api/v1/ontologies/${project.id}/tree?scope=workspace`);
  if (!initialWorkspaceTreeRes.ok) throw new Error(`initial workspace tree failed ${initialWorkspaceTreeRes.status}: ${await initialWorkspaceTreeRes.text()}`);
  const initialWorkspaceTree = await initialWorkspaceTreeRes.json();
  if (!JSON.stringify(initialWorkspaceTree.data ?? []).includes("CLAUDE.md")) throw new Error(`workspace tree missing seeded root CLAUDE.md: ${JSON.stringify(initialWorkspaceTree)}`);

  const escapeRes = await api(`/api/v1/ontologies/${project.id}/files?path=${encodeURIComponent("../../etc/passwd")}`);
  if (escapeRes.status !== 400) throw new Error(`path traversal expected 400, got ${escapeRes.status}`);

  const uploadRes = await api(`/api/v1/ontologies/${project.id}/files`, {
    method: "POST",
    body: JSON.stringify({ name: "../unsafe smoke.txt", content: `uploaded smoke file ${project.id}\n${ingestMarker}\n` }),
  });
  if (uploadRes.status !== 201) throw new Error(`upload failed ${uploadRes.status}: ${await uploadRes.text()}`);
  const uploaded = await uploadRes.json();
  if (!String(uploaded.data?.path ?? "").startsWith("raw/unsafe smoke.")) throw new Error(`upload path was not sanitized into raw/: ${JSON.stringify(uploaded)}`);
  const uploadedFileRes = await api(`/api/v1/ontologies/${project.id}/files?path=${encodeURIComponent(uploaded.data.path)}`);
  if (!uploadedFileRes.ok) throw new Error(`uploaded file read failed ${uploadedFileRes.status}: ${await uploadedFileRes.text()}`);
  const uploadedFile = await uploadedFileRes.json();
  if (!String(uploadedFile.data?.content ?? "").includes(`uploaded smoke file ${project.id}`)) throw new Error("uploaded raw file content mismatch");
  const workspaceTreeRes = await api(`/api/v1/ontologies/${project.id}/tree?scope=workspace`);
  if (!workspaceTreeRes.ok) throw new Error(`workspace tree failed ${workspaceTreeRes.status}: ${await workspaceTreeRes.text()}`);
  const workspaceTree = await workspaceTreeRes.json();
  const rawRoot = workspaceTree.data?.find((item) => item.path === "raw");
  if (!rawRoot?.children?.some((item) => item.path === uploaded.data.path)) throw new Error(`workspace tree missing uploaded raw file: ${JSON.stringify(workspaceTree)}`);

  const prompt = enableClaude
    ? verifyClaudeIngest
      ? `Read ${uploaded.data.path}. Then write a new markdown file at knowledge/smoke-ingest.md whose content includes exactly this marker: ${ingestMarker}. Reply with the marker and the workspace knowledge file path.`
      : verifyClaudeEdit
      ? `Use the Edit tool to append exactly this line to index.md: ${editMarker}. After editing, reply with the marker.`
      : "Read CLAUDE.md and reply with a short confirmation that the seeded knowledge agent is accessible. Do not edit files."
    : "Summarize the seeded knowledge workspace";
  const chatRes = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`, { method: "POST", body: JSON.stringify({ message: prompt }) });
  if (!chatRes.ok) throw new Error(`chat failed ${chatRes.status}: ${await chatRes.text()}`);
  const chat = await chatRes.json();
  if (!chat.data?.message?.content || !chat.data?.journeyState) throw new Error("chat response missing message/journeyState");
  if (enableClaude && !chat.data?.claudeSessionId) throw new Error("Claude mode did not return a claudeSessionId");

  const titledSessions = await api(`/api/v1/ontologies/${project.id}/sessions`).then((res) => res.json());
  const titledSession = titledSessions.data?.find((item) => item.id === session.id);
  const expectedTitle = prompt.length > 64 ? `${prompt.slice(0, 61)}...` : prompt;
  if (titledSession?.preview !== expectedTitle) throw new Error(`session preview was not auto-titled: ${titledSession?.preview} !== ${expectedTitle}`);

  if (verifyClaudeEdit) {
    const editedRes = await api(`/api/v1/ontologies/${project.id}/files?path=${encodeURIComponent("index.md")}`);
    if (!editedRes.ok) throw new Error(`edited file read failed ${editedRes.status}: ${await editedRes.text()}`);
    const edited = await editedRes.json();
    if (!edited.data?.content?.includes(editMarker)) throw new Error(`Claude edit marker missing from index.md: ${editMarker}`);

    const resumeRes = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`, { method: "POST", body: JSON.stringify({ message: `What exact smoke marker did you just append? Reply only with the marker.` }) });
    if (!resumeRes.ok) throw new Error(`resume chat failed ${resumeRes.status}: ${await resumeRes.text()}`);
    const resumeChat = await resumeRes.json();
    if (resumeChat.data?.claudeSessionId !== chat.data.claudeSessionId) throw new Error("Claude resume did not keep the same claudeSessionId");
    if (!String(resumeChat.data?.message?.content ?? "").includes(editMarker)) throw new Error(`resume response did not recall marker ${editMarker}: ${resumeChat.data?.message?.content}`);
  }

  if (verifyClaudeIngest) {
    const ingestRes = await api(`/api/v1/ontologies/${project.id}/files?path=${encodeURIComponent("knowledge/smoke-ingest.md")}`);
    if (!ingestRes.ok) throw new Error(`ingested workspace knowledge file read failed ${ingestRes.status}: ${await ingestRes.text()}`);
    const ingested = await ingestRes.json();
    if (!String(ingested.data?.content ?? "").includes(ingestMarker)) throw new Error(`ingested workspace knowledge file missing marker ${ingestMarker}: ${ingested.data?.content}`);

    const knowledgeTreeRes = await api(`/api/v1/ontologies/${project.id}/tree`);
    if (!knowledgeTreeRes.ok) throw new Error(`knowledge tree after ingest failed ${knowledgeTreeRes.status}: ${await knowledgeTreeRes.text()}`);
    const knowledgeTree = await knowledgeTreeRes.json();
    if (!JSON.stringify(knowledgeTree.data ?? []).includes("smoke-ingest.md")) throw new Error(`knowledge tree missing smoke-ingest.md after Claude ingest: ${JSON.stringify(knowledgeTree)}`);
  }

  if (!enableClaude) {
    const streamRes = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`, { method: "POST", body: JSON.stringify({ message: "Stream smoke", stream: true, streamFormat: "ontology" }) });
    if (!streamRes.ok) throw new Error(`stream failed ${streamRes.status}: ${await streamRes.text()}`);
    const events = parseSse(await streamRes.text());
    for (const type of ["text-delta", "journey-state", "finish", "message"]) {
      if (!events.some((event) => event.type === type)) throw new Error(`stream response missing ${type}`);
    }
    const streamedTextDeltas = events.filter((event) => event.type === "text-delta");
    const expectedFallbackText = `I updated the ontology workspace for: "query: Stream smoke".\n\nThis development fallback keeps the API/session/workspace path active. Set ONTOLOGY_ENABLE_CLAUDE=true with Claude credentials to execute the same workspace through Claude Agent SDK.`;
    if (streamedTextDeltas.map((event) => event.delta).join("") !== expectedFallbackText) throw new Error(`streamed text changed while batching deltas: ${JSON.stringify(streamedTextDeltas)}`);
    if (streamedTextDeltas.length !== 1) throw new Error(`expected one persisted text segment, got ${streamedTextDeltas.length}: ${JSON.stringify(streamedTextDeltas)}`);

    const oversizedPrompt = "x".repeat(4_500);
    const oversizedStreamRes = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`, {
      method: "POST",
      body: JSON.stringify({ message: oversizedPrompt, stream: true, streamFormat: "ontology" }),
    });
    if (!oversizedStreamRes.ok) throw new Error(`oversized stream failed ${oversizedStreamRes.status}: ${await oversizedStreamRes.text()}`);
    const oversizedEvents = parseSse(await oversizedStreamRes.text());
    const oversizedTextDeltas = oversizedEvents.filter((event) => event.type === "text-delta");
    const expectedOversizedText = `I updated the ontology workspace for: "query: ${oversizedPrompt}".\n\nThis development fallback keeps the API/session/workspace path active. Set ONTOLOGY_ENABLE_CLAUDE=true with Claude credentials to execute the same workspace through Claude Agent SDK.`;
    if (oversizedTextDeltas.map((event) => event.delta).join("") !== expectedOversizedText) throw new Error("oversized streamed text changed while batching deltas");
    if (oversizedTextDeltas.length < 2 || oversizedTextDeltas.some((event) => Buffer.byteLength(event.delta) > 4 * 1024)) throw new Error(`oversized text was not split into bounded segments: ${JSON.stringify(oversizedTextDeltas.map((event) => Buffer.byteLength(event.delta)))}`);

    const aiStreamRes = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`, { method: "POST", body: JSON.stringify({ message: "AI SDK stream smoke", stream: true, streamFormat: "ai-sdk" }) });
    if (!aiStreamRes.ok) throw new Error(`ai sdk stream failed ${aiStreamRes.status}: ${await aiStreamRes.text()}`);
    const aiStreamText = await aiStreamRes.text();
    if (!aiStreamText.includes("data: [DONE]")) throw new Error("ai sdk stream missing [DONE]");
    const aiEvents = parseSse(aiStreamText);
    for (const type of ["start", "text-start", "text-delta", "data-journey-state", "text-end", "data-claude-session", "finish"]) {
      if (!aiEvents.some((event) => event.type === type)) throw new Error(`ai sdk stream response missing ${type}: ${aiStreamText}`);
    }

    const afShapeRes = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.id,
        clientMessageId: "smoke-client-message",
        panelState: { status: "closed" },
        disabledConnectors: [],
        stream: true,
        streamFormat: "ai-sdk",
        messages: [{ parts: [{ type: "text", text: "Agent Factory shaped stream smoke" }], id: "smoke-user-message", role: "user" }],
      }),
    });
    if (!afShapeRes.ok) throw new Error(`agent factory shaped stream failed ${afShapeRes.status}: ${await afShapeRes.text()}`);
    const afShapeText = await afShapeRes.text();
    if (!afShapeText.includes("data: [DONE]")) throw new Error("agent factory shaped stream missing [DONE]");

    const session2Res = await api(`/api/v1/ontologies/${project.id}/sessions`, { method: "POST" });
    if (session2Res.status !== 201) throw new Error(`second session create failed ${session2Res.status}: ${await session2Res.text()}`);
    const session2 = (await session2Res.json()).data;
    if (!session2?.id || session2.ontologyId !== project.id) throw new Error("second session missing ontology linkage");

    const sharedPrompt1 = "Shared memory smoke from session one";
    const sharedPrompt2 = "Shared memory smoke from session two";
    const shared1 = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`, { method: "POST", body: JSON.stringify({ message: sharedPrompt1 }) });
    if (!shared1.ok) throw new Error(`shared session1 chat failed ${shared1.status}: ${await shared1.text()}`);
    const shared2 = await api(`/api/v1/ontologies/${project.id}/sessions/${session2.id}/chat`, { method: "POST", body: JSON.stringify({ message: sharedPrompt2 }) });
    if (!shared2.ok) throw new Error(`shared session2 chat failed ${shared2.status}: ${await shared2.text()}`);

    const session1Messages = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}/messages`).then((res) => res.json());
    const session2Messages = await api(`/api/v1/ontologies/${project.id}/sessions/${session2.id}/messages`).then((res) => res.json());
    if (!session1Messages.data?.some((msg) => msg.content === sharedPrompt1)) throw new Error("session1 transcript missing own prompt");
    if (session1Messages.data?.some((msg) => msg.content === sharedPrompt2)) throw new Error("session1 transcript incorrectly contains session2 prompt");
    if (!session2Messages.data?.some((msg) => msg.content === sharedPrompt2)) throw new Error("session2 transcript missing own prompt");
  }

  console.log("ontology smoke ok", { projectId: project.id, pageCount: project.pageCount, claude: enableClaude, claudeEdit: verifyClaudeEdit, claudeIngest: verifyClaudeIngest, claudeSessionId: chat.data.claudeSessionId });
} finally {
  server.kill("SIGTERM");
  await rm(workspaceRoot, { recursive: true, force: true });
}
