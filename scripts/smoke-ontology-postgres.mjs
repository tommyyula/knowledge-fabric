import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

const root = process.cwd();
const workspaceRoot = await mkdtemp(path.join(tmpdir(), "ontology-pg-workspaces-"));
const serverPort = String(22000 + Math.floor(Math.random() * 1000));
const pgPort = String(23000 + Math.floor(Math.random() * 1000));
const containerName = `ontology-studio-pg-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const databaseUrl = `postgresql://ontology:ontology@127.0.0.1:${pgPort}/ontology`;

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(" ")} failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const server = { child: null, logs: "" };
async function cleanup() {
  if (server.child) server.child.kill("SIGTERM");
  await run("docker", ["rm", "-f", containerName]).catch(() => undefined);
  await rm(workspaceRoot, { recursive: true, force: true });
}
process.on("SIGINT", () => void cleanup().finally(() => process.exit(130)));
process.on("SIGTERM", () => void cleanup().finally(() => process.exit(143)));

async function waitForPostgres() {
  for (let i = 0; i < 80; i += 1) {
    const client = new pg.Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("postgres did not become ready");
}

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/healthz`);
      if (res.ok) return;
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy\n${server.logs}`);
}

async function api(pathname, init = {}) {
  return fetch(`http://127.0.0.1:${serverPort}${pathname}`, {
    ...init,
    headers: { TenantID: "pg-smoke-tenant", "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(30000),
  });
}

try {
  await run("docker", [
    "run", "-d", "--rm",
    "--name", containerName,
    "-e", "POSTGRES_USER=ontology",
    "-e", "POSTGRES_PASSWORD=ontology",
    "-e", "POSTGRES_DB=ontology",
    "-p", `${pgPort}:5432`,
    "postgres:16-alpine",
  ]);
  await waitForPostgres();

  const legacyClient = new pg.Client({ connectionString: databaseUrl });
  await legacyClient.connect();
  await legacyClient.query(`
    create table a2a_tasks (
      id text primary key,
      context_id text not null,
      tenant_id text not null,
      status jsonb not null,
      history jsonb not null default '[]'::jsonb,
      artifacts jsonb not null default '[]'::jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await legacyClient.query(
    "insert into a2a_tasks (id, context_id, tenant_id, status) values ($1, $2, $3, $4::jsonb)",
    ["legacy-task", "legacy-context", "legacy-tenant", JSON.stringify({ state: "submitted" })],
  );
  await legacyClient.end();

  server.child = spawn("pnpm", ["exec", "tsx", "server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ONTOLOGY_SERVER_PORT: serverPort,
      ONTOLOGY_WORKSPACE_ROOT: workspaceRoot,
      ONTOLOGY_ENABLE_CLAUDE: "false",
      ONTOLOGY_IAM_ENABLED: "false",
      VITE_IAM_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.child.stdout.on("data", (chunk) => { server.logs += chunk.toString(); });
  server.child.stderr.on("data", (chunk) => { server.logs += chunk.toString(); });
  await waitForServer();

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const migrations = await client.query("select id from ontology_schema_migrations order by id");
  for (const id of ["0001_ontology_core", "0002_session_store_indexes", "0012_ontology_a2a_tasks"]) {
    if (!migrations.rows.some((row) => row.id === id)) throw new Error(`missing migration ${id}`);
  }
  const a2aTables = await client.query(`
    select table_name, column_name, data_type
    from information_schema.columns
    where table_schema=current_schema()
      and table_name in ('a2a_tasks', 'ontology_a2a_tasks')
      and column_name in ('id', 'task_id', 'status')
    order by table_name, column_name
  `);
  if (!a2aTables.rows.some((row) => row.table_name === "a2a_tasks" && row.column_name === "status" && row.data_type === "jsonb")) {
    throw new Error(`legacy a2a_tasks schema was changed: ${JSON.stringify(a2aTables.rows)}`);
  }
  if (!a2aTables.rows.some((row) => row.table_name === "ontology_a2a_tasks" && row.column_name === "task_id") ||
      !a2aTables.rows.some((row) => row.table_name === "ontology_a2a_tasks" && row.column_name === "status" && row.data_type === "integer")) {
    throw new Error(`ontology_a2a_tasks schema is missing or invalid: ${JSON.stringify(a2aTables.rows)}`);
  }
  const legacyTask = await client.query("select id, status from a2a_tasks where id='legacy-task'");
  if (legacyTask.rows[0]?.id !== "legacy-task" || legacyTask.rows[0]?.status?.state !== "submitted") {
    throw new Error("legacy a2a_tasks data was changed");
  }

  const createRes = await api("/api/v1/ontologies", { method: "POST", body: JSON.stringify({ name: "Postgres Smoke Ontology" }) });
  if (createRes.status !== 201) throw new Error(`create failed ${createRes.status}: ${await createRes.text()}`);
  const created = await createRes.json();
  const { project, session } = created.data;

  const chatRes = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`, { method: "POST", body: JSON.stringify({ message: "Postgres smoke chat" }) });
  if (!chatRes.ok) throw new Error(`chat failed ${chatRes.status}: ${await chatRes.text()}`);

  const patchRes = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ preview: "Postgres renamed smoke" }) });
  if (!patchRes.ok) throw new Error(`session patch failed ${patchRes.status}: ${await patchRes.text()}`);

  await run("pnpm", ["exec", "tsx", "scripts/exercise-claude-session-store.ts", "pg-smoke-tenant", project.id, session.id], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  const counts = await client.query(`
    select
      (select count(*)::int from ontology_projects) as projects,
      (select count(*)::int from ontology_sessions) as sessions,
      (select count(*)::int from ontology_messages) as messages,
      (select count(*)::int from ontology_run_events) as events,
      (select count(*)::int from claude_session_store_entries) as session_store_entries
  `);
  const row = counts.rows[0];
  for (const key of ["projects", "sessions", "messages", "events"]) {
    if (Number(row[key]) < 1) throw new Error(`expected ${key} rows, got ${row[key]}`);
  }
  if (Number(row.session_store_entries) !== 0) throw new Error("session store delete exercise should leave zero rows");

  const renamed = await client.query("select preview from ontology_sessions where id=$1", [session.id]);
  if (renamed.rows[0]?.preview !== "Postgres renamed smoke") throw new Error("session rename was not persisted");

  const deleteRes = await api(`/api/v1/ontologies/${project.id}/sessions/${session.id}`, { method: "DELETE" });
  if (deleteRes.status !== 204) throw new Error(`session delete failed ${deleteRes.status}: ${await deleteRes.text()}`);
  const afterDelete = await client.query("select count(*)::int as count from ontology_sessions where id=$1", [session.id]);
  if (Number(afterDelete.rows[0].count) !== 0) throw new Error("session delete did not persist");

  await client.end();
  console.log("ontology postgres smoke ok", { projectId: project.id, migrations: migrations.rows.map((row) => row.id) });
} finally {
  await cleanup();
}
