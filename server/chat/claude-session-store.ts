import fs from "node:fs/promises";
import path from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../env";
import { pool, query } from "../db/client";

const memory = new Map<string, SessionStoreEntry[]>();

type SessionStoreScope = { tenantId: string; ontologyId: string; appSessionId: string };

function projectKey(scope: SessionStoreScope): string {
  return `${scope.tenantId}:${scope.ontologyId}:${scope.appSessionId}`;
}

function storageKey(key: SessionKey): string {
  return `${key.projectKey}:${key.sessionId}:${key.subpath ?? "__main__"}`;
}

function safeSegment(value: string) {
  return encodeURIComponent(value).replace(/%/g, "_");
}

function fileStoreRoot(scope: SessionStoreScope) {
  return path.resolve(env.claudeSessionStoreRoot, "tenants", safeSegment(scope.tenantId), "ontologies", safeSegment(scope.ontologyId), "sessions", safeSegment(scope.appSessionId));
}

function ontologyFileStoreRoot(scope: Pick<SessionStoreScope, "tenantId" | "ontologyId">) {
  return path.resolve(env.claudeSessionStoreRoot, "tenants", safeSegment(scope.tenantId), "ontologies", safeSegment(scope.ontologyId));
}

function fileForKey(scope: SessionStoreScope, key: SessionKey) {
  const root = fileStoreRoot(scope);
  const subkey = key.subpath ? safeSegment(key.subpath) : "__main__";
  const file = path.resolve(root, safeSegment(key.sessionId), `${subkey}.json`);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Claude session store path escaped data root");
  return file;
}

async function readJsonEntries(file: string): Promise<SessionStoreEntry[]> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as SessionStoreEntry[] : [];
  } catch {
    return [];
  }
}

function createFileClaudeSessionStore(scope: SessionStoreScope): SessionStore {
  const expectedProjectKey = projectKey(scope);
  return {
    async append(key, entries) {
      const file = fileForKey(scope, key);
      const existing = await readJsonEntries(file);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify([...existing, ...entries], null, 2), "utf-8");
    },
    async load(key) {
      const entries = await readJsonEntries(fileForKey(scope, key));
      return entries.length ? entries : null;
    },
    async listSessions(keyProject) {
      if (keyProject !== expectedProjectKey) return [];
      const root = fileStoreRoot(scope);
      const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      return Promise.all(dirs.filter((entry) => entry.isDirectory()).map(async (entry) => {
        const stat = await fs.stat(path.join(root, entry.name)).catch(() => null);
        return { sessionId: decodeURIComponent(entry.name.replace(/_/g, "%")), mtime: stat?.mtimeMs ?? Date.now() };
      }));
    },
    async delete(key) {
      await fs.rm(path.dirname(fileForKey(scope, key)), { recursive: true, force: true });
    },
    async listSubkeys(key) {
      if (key.projectKey !== expectedProjectKey) return [];
      const dir = path.dirname(fileForKey(scope, { ...key, subpath: "__main__" }));
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "__main__.json")
        .map((entry) => decodeURIComponent(entry.name.slice(0, -5).replace(/_/g, "%")));
    },
  };
}

function createPostgresClaudeSessionStore(scope: SessionStoreScope): SessionStore {
  const expectedProjectKey = projectKey(scope);
  return {
    async append(key: SessionKey, entries: SessionStoreEntry[]) {
      const subkey = key.subpath ?? "";
      if (pool) {
        await query(
          `insert into claude_session_store_entries (tenant_id, ontology_id, app_session_id, sdk_session_id, subkey, value)
           values ($1,$2,$3,$4,$5,$6::jsonb)
           on conflict (tenant_id, ontology_id, app_session_id, sdk_session_id, subkey)
           do update set value = claude_session_store_entries.value || excluded.value, updated_at = now()`,
          [scope.tenantId, scope.ontologyId, scope.appSessionId, key.sessionId, subkey, JSON.stringify(entries)],
        );
        return;
      }
      const sk = storageKey(key);
      memory.set(sk, [...(memory.get(sk) ?? []), ...entries]);
    },
    async load(key: SessionKey) {
      const subkey = key.subpath ?? "";
      if (pool) {
        const res = await query<{ value: SessionStoreEntry[] }>(
          "select value from claude_session_store_entries where tenant_id=$1 and ontology_id=$2 and app_session_id=$3 and sdk_session_id=$4 and subkey=$5",
          [scope.tenantId, scope.ontologyId, scope.appSessionId, key.sessionId, subkey],
        );
        return res.rows[0]?.value ?? null;
      }
      return memory.get(storageKey(key)) ?? null;
    },
    async listSessions(keyProject: string) {
      if (keyProject !== expectedProjectKey) return [];
      if (pool) {
        const res = await query<{ sdk_session_id: string; mtime: string }>(
          "select sdk_session_id, max(updated_at) as mtime from claude_session_store_entries where tenant_id=$1 and ontology_id=$2 and app_session_id=$3 group by sdk_session_id",
          [scope.tenantId, scope.ontologyId, scope.appSessionId],
        );
        return res.rows.map((r) => ({ sessionId: r.sdk_session_id, mtime: new Date(r.mtime).getTime() }));
      }
      const ids = new Set<string>();
      for (const key of memory.keys()) if (key.startsWith(`${expectedProjectKey}:`)) ids.add(key.split(":")[3]);
      return [...ids].map((sessionId) => ({ sessionId, mtime: Date.now() }));
    },
    async delete(key: SessionKey) {
      if (pool) {
        await query("delete from claude_session_store_entries where tenant_id=$1 and ontology_id=$2 and app_session_id=$3 and sdk_session_id=$4", [scope.tenantId, scope.ontologyId, scope.appSessionId, key.sessionId]);
        return;
      }
      for (const sk of memory.keys()) if (sk.startsWith(`${key.projectKey}:${key.sessionId}:`)) memory.delete(sk);
    },
    async listSubkeys(key: { projectKey: string; sessionId: string }) {
      if (key.projectKey !== expectedProjectKey) return [];
      if (pool) {
        const res = await query<{ subkey: string }>("select subkey from claude_session_store_entries where tenant_id=$1 and ontology_id=$2 and app_session_id=$3 and sdk_session_id=$4 and subkey <> ''", [scope.tenantId, scope.ontologyId, scope.appSessionId, key.sessionId]);
        return res.rows.map((r) => r.subkey);
      }
      return [...memory.keys()].filter((sk) => sk.startsWith(`${key.projectKey}:${key.sessionId}:`) && !sk.endsWith(":__main__")).map((sk) => sk.slice(`${key.projectKey}:${key.sessionId}:`.length));
    },
  };
}

export function createClaudeSessionStore(scope: SessionStoreScope): SessionStore {
  if (env.claudeSessionStore === "postgres") return createPostgresClaudeSessionStore(scope);
  return createFileClaudeSessionStore(scope);
}

export async function deleteClaudeSessionStoreForAppSession(scope: SessionStoreScope): Promise<void> {
  if (env.claudeSessionStore === "postgres") {
    if (pool) {
      await query(
        "delete from claude_session_store_entries where tenant_id=$1 and ontology_id=$2 and app_session_id=$3",
        [scope.tenantId, scope.ontologyId, scope.appSessionId],
      );
      return;
    }
    const prefix = `${projectKey(scope)}:`;
    for (const key of memory.keys()) if (key.startsWith(prefix)) memory.delete(key);
    return;
  }
  await fs.rm(fileStoreRoot(scope), { recursive: true, force: true });
}

export async function deleteClaudeSessionStoreForOntology(scope: Pick<SessionStoreScope, "tenantId" | "ontologyId">): Promise<void> {
  if (env.claudeSessionStore === "postgres") {
    if (pool) {
      await query(
        "delete from claude_session_store_entries where tenant_id=$1 and ontology_id=$2",
        [scope.tenantId, scope.ontologyId],
      );
      return;
    }
    const prefix = `${scope.tenantId}:${scope.ontologyId}:`;
    for (const key of memory.keys()) if (key.startsWith(prefix)) memory.delete(key);
    return;
  }
  await fs.rm(ontologyFileStoreRoot(scope), { recursive: true, force: true });
}

export { createPostgresClaudeSessionStore };
