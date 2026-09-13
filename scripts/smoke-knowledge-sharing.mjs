import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const dataRoot = await mkdtemp(path.join(tmpdir(), "knowledge-sharing-smoke-"));
const port = 31000 + Math.floor(Math.random() * 1000);
const emailRequests = [];
const emailServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    emailRequests.push(body);
    res.statusCode = body.includes("future-user@example.test") || body.includes("future-manager@example.test") ? 500 : 204;
    res.end();
  });
});
await new Promise((resolve) => emailServer.listen(0, "127.0.0.1", resolve));
const emailAddress = emailServer.address();
if (!emailAddress || typeof emailAddress === "string") throw new Error("email fixture did not start");
const backend = spawn(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ONTOLOGY_SERVER_PORT: String(port),
    APP_DATA_ROOT: dataRoot,
    ONTOLOGY_WORKSPACE_ROOT: path.join(dataRoot, "workspaces"),
    RESOURCE_LIBRARY_ROOT: path.join(dataRoot, "resources"),
    CLAUDE_SESSION_STORE_ROOT: path.join(dataRoot, "sessions"),
    DATABASE_URL: "",
    ONTOLOGY_IAM_ENABLED: "false",
    ONTOLOGY_ENABLE_CLAUDE: "false",
    SUPPORT_EMAIL_API_URL: `http://127.0.0.1:${emailAddress.port}/send`,
    COMPOSIO_API_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
backend.stdout.on("data", (chunk) => { logs += chunk.toString(); });
backend.stderr.on("data", (chunk) => { logs += chunk.toString(); });

const identity = (userId, tenantId) => ({ "x-user-id": userId, TenantID: tenantId, "Content-Type": "application/json" });
async function api(pathname, init = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
}
async function status(response, expected, label) {
  if (response.status !== expected) throw new Error(`${label}: expected ${expected}, got ${response.status} ${await response.text()}\n${logs}`);
  return response;
}
function assert(value, label) { if (!value) throw new Error(`${label}\n${logs}`); }

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await api("/healthz")).ok) break; } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (attempt === 79) throw new Error(`backend did not start\n${logs}`);
  }

  const owner = identity("owner", "owner-tenant");
  const viewer = identity("viewer", "viewer-tenant");
  const editor = identity("editor", "editor-tenant");
  const manager = identity("manager", "manager-tenant");
  const dual = identity("dual", "owner-tenant");
  const createdResponse = await status(await api("/api/v1/ontologies", { method: "POST", headers: owner, body: JSON.stringify({ name: "Shared smoke KB" }) }), 201, "create");
  const created = (await createdResponse.json()).data;
  const id = created.project.id;
  await status(await api(`/api/v1/ontologies/${id}`, { method: "PATCH", headers: owner, body: JSON.stringify({ status: "active" }) }), 200, "activate");

  for (const [identifier, tenantId, role] of [["viewer", "viewer-tenant", "viewer"], ["editor", "editor-tenant", "editor"], ["manager", "manager-tenant", "manager"], ["dual", "owner-tenant", "editor"]]) {
    await status(await api(`/api/v1/ontologies/${id}/shares`, { method: "POST", headers: owner, body: JSON.stringify({ identifier, tenantId, role }) }), 201, `grant ${role}`);
  }
  const invitationResponse = await status(await api(`/api/v1/ontologies/${id}/shares`, { method: "POST", headers: owner, body: JSON.stringify({ identifier: "future-user@example.test", role: "viewer" }) }), 201, "non-IAM invitation");
  const invitation = (await invitationResponse.json()).data.invitation;
  assert(invitation.deliveryStatus === "failed", "failed email did not leave a retryable invitation");
  const retryInvitation = await status(await api(`/api/v1/ontologies/${id}/shares`, { method: "POST", headers: owner, body: JSON.stringify({ identifier: "future-user@example.test", role: "editor" }) }), 201, "invitation retry");
  assert((await retryInvitation.json()).data.invitation.id === invitation.id, "invitation retry created a duplicate record");
  await status(await api(`/api/v1/ontologies/${id}/invitations/${invitation.id}`, { method: "DELETE", headers: owner }), 204, "invitation revoke");
  await status(await api(`/api/v1/ontologies/${id}/shares`, { method: "POST", headers: owner, body: JSON.stringify({ identifier: "future-manager@example.test", role: "manager" }) }), 201, "manager invitation");
  await status(await api(`/api/v1/ontologies/${id}/shares`, { method: "POST", headers: owner, body: JSON.stringify({ identifier: "invitee@local.dev", role: "viewer" }) }), 201, "deliver invitation");
  const deliveredEmail = emailRequests.find((body) => body.includes("invitee@local.dev"));
  const invitationToken = deliveredEmail?.match(/share\/invite\?token=([^"<\r\n]+)/)?.[1];
  assert(invitationToken, "delivered invitation did not contain an acceptance token");
  await status(await api("/api/v1/ontologies/share-invitations/accept", { method: "POST", headers: identity("intruder", "invitee-tenant"), body: JSON.stringify({ token: invitationToken, tenantId: "invitee-tenant" }) }), 403, "invitation email mismatch");
  const acceptedInvitation = await status(await api("/api/v1/ontologies/share-invitations/accept", { method: "POST", headers: identity("invitee", "invitee-tenant"), body: JSON.stringify({ token: invitationToken, tenantId: "invitee-tenant" }) }), 200, "accept invitation");
  assert((await acceptedInvitation.json()).data.project.accessRole === "viewer", "accepted invitation did not create Viewer access");
  await status(await api(`/api/v1/ontologies/${id}/shares/tenant`, { method: "PUT", headers: owner, body: JSON.stringify({ role: "viewer" }) }), 200, "tenant grant");
  const dualList = await status(await api("/api/v1/ontologies", { headers: dual }), 200, "dual list");
  assert((await dualList.json()).data.find((project) => project.id === id)?.accessRole === "editor", "direct Editor did not outrank tenant Viewer");

  await status(await api(`/api/v1/ontologies/${id}`, { method: "PATCH", headers: viewer, body: JSON.stringify({ name: "forbidden" }) }), 404, "viewer profile mutation");
  await status(await api(`/api/v1/ontologies/${id}/raw`, { method: "POST", headers: viewer, body: JSON.stringify({ name: "viewer.md", content: "no" }) }), 404, "viewer ingest");
  await status(await api(`/api/v1/ontologies/${id}/raw`, { method: "POST", headers: editor, body: JSON.stringify({ name: "editor.md", content: "# Editor source" }) }), 201, "editor ingest");
  const editorSessionResponse = await status(await api(`/api/v1/ontologies/${id}/sessions`, { method: "POST", headers: editor }), 201, "editor session");
  const editorSession = (await editorSessionResponse.json()).data;
  await status(await api(`/api/v1/ontologies/${id}/sessions/${editorSession.id}/chat`, { method: "POST", headers: editor, body: JSON.stringify({ message: "Prepare this Knowledge Base for queries.", stream: false }) }), 200, "editor ready run");
  await status(await api(`/api/v1/ontologies/${id}/shares`, { method: "POST", headers: manager, body: JSON.stringify({ identifier: "delegate", tenantId: "delegate-tenant", role: "editor" }) }), 201, "manager editor grant");
  await status(await api(`/api/v1/ontologies/${id}/shares`, { method: "POST", headers: manager, body: JSON.stringify({ identifier: "delegate", tenantId: "delegate-tenant", role: "manager" }) }), 403, "manager manager grant");
  await status(await api(`/api/v1/ontologies/${id}/shares`, { method: "POST", headers: manager, body: JSON.stringify({ identifier: "future-manager@example.test", role: "editor" }) }), 403, "manager invitation downgrade");

  const viewerJourney = await status(await api(`/api/v1/ontologies/${id}/journey`, { headers: viewer }), 200, "viewer journey projection");
  const viewerJourneyState = (await viewerJourney.json()).data;
  assert(!viewerJourneyState.review && viewerJourneyState.bootstrap.rawSources.length === 0, "viewer journey leaked pending review or source metadata");

  const viewerSessionResponse = await status(await api(`/api/v1/ontologies/${id}/sessions`, { method: "POST", headers: viewer }), 201, "viewer session");
  const viewerSession = (await viewerSessionResponse.json()).data;
  const ownerSessions = await status(await api(`/api/v1/ontologies/${id}/sessions`, { headers: owner }), 200, "owner sessions");
  assert(!(await ownerSessions.json()).data.some((session) => session.id === viewerSession.id), "private viewer session leaked to owner");
  await status(await api(`/api/v1/ontologies/${id}/sessions/${viewerSession.id}/chat`, { method: "POST", headers: viewer, body: JSON.stringify({ message: "What is available?", stream: false }) }), 200, "viewer query");
  await status(await api(`/api/v1/ontologies/${id}/sessions/${viewerSession.id}/chat`, { method: "POST", headers: viewer, body: JSON.stringify({ message: "Keep [the label](file:///private/secret.md), C:\\private\\secret.md, /etc/secret, and knowledge/internal.md out of the public snapshot.", stream: false }) }), 200, "viewer snapshot sanitization fixture");

  const knowledgeRoot = path.join(dataRoot, "workspaces", "tenants", "owner-tenant", "users", "owner", "ontologies", id, "knowledge");
  await mkdir(knowledgeRoot, { recursive: true });
  for (const file of ["index.md", "overview.md", "glossary.md", "log.md"]) await writeFile(path.join(knowledgeRoot, file), `# ${file}\n`, { flag: "a" });

  let externalItems = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const catalog = await status(await api("/api/v1/knowledge-bases", { headers: viewer }), 200, "shared REST catalog");
    externalItems = (await catalog.json()).data.items;
    if (externalItems.some((item) => item.knowledgeBaseId === id)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(externalItems.some((item) => item.knowledgeBaseId === id), "shared Viewer was missing from REST catalog");
  const restQuery = await status(await api(`/api/v1/knowledge-bases/${id}/queries`, { method: "POST", headers: { ...viewer, "Idempotency-Key": "shared-rest-query" }, body: JSON.stringify({ message: "Query through REST", stream: false }) }), 200, "shared REST query");
  assert(typeof (await restQuery.json()).data.answer === "string", "shared REST query returned no answer");

  const mcpInitialize = await status(await api("/api/v1/mcp", { method: "POST", headers: viewer, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) }), 200, "shared MCP initialize");
  const mcpSessionId = mcpInitialize.headers.get("mcp-session-id");
  assert(mcpSessionId, "MCP did not issue a session id");
  const mcpSearch = await status(await api("/api/v1/mcp", { method: "POST", headers: { ...viewer, "mcp-session-id": mcpSessionId }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "knowledge_base_search", arguments: {} } }) }), 200, "shared MCP search");
  assert((await mcpSearch.json()).result.structuredContent.items.some((item) => item.knowledgeBaseId === id), "shared Viewer was missing from MCP catalog");

  const a2aSearch = await status(await api("/api/v1/a2a/message:send", { method: "POST", headers: { ...viewer, "A2A-Version": "1.0", "Content-Type": "application/a2a+json" }, body: JSON.stringify({ message: { messageId: "shared-a2a-search", role: "ROLE_USER", parts: [{ data: { operation: "knowledge_base_search", limit: 20 }, mediaType: "application/json" }] } }) }), 200, "shared A2A search");
  const a2aItems = (await a2aSearch.json()).message?.parts?.find((part) => part.data)?.data?.items ?? [];
  assert(a2aItems.some((item) => item.knowledgeBaseId === id), "shared Viewer was missing from A2A catalog");
  const a2aQuery = await status(await api("/api/v1/a2a/message:send", { method: "POST", headers: { ...viewer, "A2A-Version": "1.0", "Content-Type": "application/a2a+json" }, body: JSON.stringify({ message: { messageId: "shared-a2a-query", role: "ROLE_USER", parts: [{ data: { operation: "knowledge_base_query", knowledgeBaseId: id }, mediaType: "application/json" }, { text: "Query through A2A", mediaType: "text/plain" }] } }) }), 200, "shared A2A query");
  const a2aTask = (await a2aQuery.json()).task;
  assert(a2aTask?.id, "shared A2A query did not create a Task");
  let completedA2ATask = a2aTask;
  for (let attempt = 0; attempt < 80 && completedA2ATask.status?.state !== "TASK_STATE_COMPLETED"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const poll = await status(await api(`/api/v1/a2a/tasks/${encodeURIComponent(a2aTask.id)}`, { headers: { ...viewer, "A2A-Version": "1.0" } }), 200, "shared A2A query poll");
    completedA2ATask = await poll.json();
  }
  assert(completedA2ATask.status?.state === "TASK_STATE_COMPLETED" && completedA2ATask.artifacts?.some((artifact) => artifact.name === "knowledge-answer"), "shared A2A query did not complete");

  const firstShare = await status(await api(`/api/v1/ontologies/${id}/sessions/${viewerSession.id}/share`, { method: "POST", headers: viewer }), 201, "publish snapshot");
  const snapshot = (await firstShare.json()).data;
  const secondShare = await status(await api(`/api/v1/ontologies/${id}/sessions/${viewerSession.id}/share`, { method: "POST", headers: viewer }), 201, "republish snapshot");
  assert((await secondShare.json()).data.token === snapshot.token, "snapshot link was not stable");
  const publicSnapshot = await status(await api(`/api/v1/ontologies/public/conversations/${snapshot.token}`), 200, "anonymous snapshot");
  const publicSnapshotText = JSON.stringify((await publicSnapshot.json()).data.messages);
  assert(publicSnapshotText.includes("the label") && !publicSnapshotText.includes("file://") && !publicSnapshotText.includes("private\\\\secret") && !publicSnapshotText.includes("/etc/secret") && !publicSnapshotText.includes("knowledge/internal"), "public snapshot leaked a link target or file path");
  await status(await api(`/api/v1/ontologies/${id}/sessions/${viewerSession.id}`, { method: "DELETE", headers: viewer }), 204, "delete source conversation");
  await status(await api(`/api/v1/ontologies/public/conversations/${snapshot.token}`), 410, "revoked snapshot tombstone");

  const library = await status(await api("/api/v1/resource-library", { headers: editor }), 200, "editor library");
  const editorResource = (await library.json()).data.resources.find((resource) => resource.name.includes("editor"));
  assert(editorResource, "editor upload was not mirrored into Resource Library");
  const viewerLibrary = await status(await api("/api/v1/resource-library", { headers: viewer }), 200, "viewer shared Resource Library");
  const sharedEditorResource = (await viewerLibrary.json()).data.resources.find((resource) => resource.id === editorResource.id);
  assert(sharedEditorResource?.shared && sharedEditorResource.uploaderUserId === "editor", "bound Resource was not projected with uploader metadata to a shared Viewer");
  const sharedResourcePreview = await status(await api(`/api/v1/resource-library/resources/${editorResource.id}/preview`, { headers: viewer }), 200, "viewer shared Resource preview");
  assert((await sharedResourcePreview.json()).data.content.includes("Editor source"), "shared Viewer could not read the bound Resource");
  await status(await api(`/api/v1/resource-library/resources/${editorResource.id}`, { method: "DELETE", headers: viewer }), 404, "viewer cannot delete uploader Resource");
  await status(await api(`/api/v1/resource-library/resources/${editorResource.id}`, { method: "DELETE", headers: editor }), 409, "bound resource deletion");

  await status(await api(`/api/v1/ontologies/${id}`, { method: "DELETE", headers: owner, body: JSON.stringify({ keepConversationHistory: true }) }), 204, "soft delete KB");
  const viewerLibraryAfterDelete = await status(await api("/api/v1/resource-library", { headers: viewer }), 200, "shared Resource Library after Knowledge Base deletion");
  assert(!(await viewerLibraryAfterDelete.json()).data.resources.some((resource) => resource.id === editorResource.id), "deleted Knowledge Base left its Resource shared with a Viewer");
  const viewerDeletedList = await status(await api("/api/v1/ontologies", { headers: viewer }), 200, "deleted placeholder list");
  assert((await viewerDeletedList.json()).data.some((project) => project.id === id && project.deletedAt), "shared recipient did not receive deletion tombstone");
  await status(await api(`/api/v1/ontologies/${id}/tombstone`, { method: "DELETE", headers: viewer, body: JSON.stringify({ keepConversationHistory: true }) }), 204, "remove tombstone");
  const viewerAfterRemoval = await status(await api("/api/v1/ontologies", { headers: viewer }), 200, "post tombstone list");
  assert(!(await viewerAfterRemoval.json()).data.some((project) => project.id === id), "removed tombstone remained visible");

  console.log("knowledge sharing smoke ok", { id });
} finally {
  backend.kill("SIGTERM");
  await new Promise((resolve) => emailServer.close(resolve));
  await rm(dataRoot, { recursive: true, force: true });
}
