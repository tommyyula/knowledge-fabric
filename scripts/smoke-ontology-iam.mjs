import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const workspaceRoot = await mkdtemp(path.join(tmpdir(), "ontology-iam-workspaces-"));
const ssoPort = String(27000 + Math.floor(Math.random() * 1000));
const serverPort = String(28000 + Math.floor(Math.random() * 1000));
const goodToken = "fake-good-token";
const user = {
  id: "iam-user-1",
  userName: "keyue.fen",
  firstName: "Keyue",
  lastName: "Fen",
  email: "keyue.fen@item.com",
  companyCode: "tenant-it",
  tenants: ["tenant-it", "tenant-sbfh"],
};

const sso = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${ssoPort}`);
  if (req.method === "POST" && url.pathname === "/oauth2/token") {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    const form = new URLSearchParams(body);
    const basic = `Basic ${Buffer.from("iam-client-smoke:iam-secret-smoke").toString("base64")}`;
    const hasClientAuth = req.headers.authorization === basic || (form.get("client_id") === "iam-client-smoke" && form.get("client_secret") === "iam-secret-smoke");
    if (!hasClientAuth || form.get("code") !== "valid-code") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: goodToken, refresh_token: "fake-refresh-token", expires_in: 3600 }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/user-info") {
    if (req.headers.authorization !== `Bearer ${goodToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, data: user }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

function listen(server, port) {
  return new Promise((resolve) => server.listen(Number(port), "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

await listen(sso, ssoPort);

const backend = spawn("pnpm", ["exec", "tsx", "server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ONTOLOGY_SERVER_PORT: serverPort,
    ONTOLOGY_WORKSPACE_ROOT: workspaceRoot,
    ONTOLOGY_ENABLE_CLAUDE: "false",
    ONTOLOGY_IAM_ENABLED: "true",
    SSO_URL: `http://127.0.0.1:${ssoPort}/`,
    IAM_CLIENT_ID: "iam-client-smoke",
    IAM_CLIENT_SECRET: "iam-secret-smoke",
    VITE_IAM_ENABLED: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
backend.stdout.on("data", (chunk) => { logs += chunk.toString(); });
backend.stderr.on("data", (chunk) => { logs += chunk.toString(); });

async function waitForHealth() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/healthz`);
      if (res.ok) return;
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`backend did not become healthy\n${logs}`);
}

async function api(pathname, init = {}) {
  return fetch(`http://127.0.0.1:${serverPort}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(30000),
  });
}

try {
  await waitForHealth();

  const noAuth = await api("/api/v1/ontologies", { headers: { TenantID: "tenant-it" } });
  if (noAuth.status !== 401) throw new Error(`expected ontology list without auth to be 401, got ${noAuth.status}: ${await noAuth.text()}`);

  const tokenRes = await api("/api/auth/exchange-token", {
    method: "POST",
    body: JSON.stringify({ code: "valid-code", redirect_uri: "http://127.0.0.1:8888/login" }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed ${tokenRes.status}: ${await tokenRes.text()}`);
  const tokenPayload = await tokenRes.json();
  if (tokenPayload.data?.access_token !== goodToken) throw new Error("token exchange did not return fake token");

  const meRes = await api("/api/auth/me", { headers: { Authorization: `Bearer ${goodToken}`, TenantID: "tenant-it" } });
  if (!meRes.ok) throw new Error(`me failed ${meRes.status}: ${await meRes.text()}`);
  const me = await meRes.json();
  if (me.data?.user_id !== user.id || me.data?.tenant_id !== "tenant-it" || !me.data?.tenants?.includes("tenant-sbfh")) {
    throw new Error(`unexpected me payload: ${JSON.stringify(me)}`);
  }

  const forbiddenTenant = await api("/api/v1/ontologies", { headers: { Authorization: `Bearer ${goodToken}`, TenantID: "tenant-other" } });
  if (forbiddenTenant.status !== 403) throw new Error(`expected forbidden tenant 403, got ${forbiddenTenant.status}: ${await forbiddenTenant.text()}`);

  const createRes = await api("/api/v1/ontologies", {
    method: "POST",
    headers: { Authorization: `Bearer ${goodToken}`, TenantID: "tenant-it" },
    body: JSON.stringify({ name: "IAM Smoke Ontology" }),
  });
  if (createRes.status !== 201) throw new Error(`create failed ${createRes.status}: ${await createRes.text()}`);
  const created = await createRes.json();
  if (created.data?.project?.tenantId !== "tenant-it" || created.data?.project?.ownerId !== user.id) {
    throw new Error(`created ontology not scoped to IAM user/tenant: ${JSON.stringify(created)}`);
  }

  const otherTenantList = await api("/api/v1/ontologies", { headers: { Authorization: `Bearer ${goodToken}`, TenantID: "tenant-sbfh" } });
  if (!otherTenantList.ok) throw new Error(`allowed second tenant list failed ${otherTenantList.status}: ${await otherTenantList.text()}`);
  const otherTenant = await otherTenantList.json();
  if (otherTenant.data?.some((project) => project.id === created.data.project.id)) throw new Error("ontology leaked across tenant list");

  console.log("ontology IAM smoke ok", { userId: me.data.user_id, tenantId: me.data.tenant_id, projectId: created.data.project.id });
} finally {
  backend.kill("SIGTERM");
  await close(sso).catch(() => undefined);
  await rm(workspaceRoot, { recursive: true, force: true });
}
