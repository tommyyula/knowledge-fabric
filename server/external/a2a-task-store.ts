import fs from "node:fs/promises";
import path from "node:path";
import { Task, TaskState, type ListTasksRequest, type ListTasksResponse } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { pool, query } from "../db/client";
import { env } from "../env";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATES = new Set([
  TaskState.TASK_STATE_SUBMITTED,
  TaskState.TASK_STATE_WORKING,
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
]);

export interface A2ATaskRecord {
  tenantId: string;
  ownerId: string;
  messageId: string;
  requestFingerprint: string;
  knowledgeBaseId: string;
  task: Task;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type TaskReservation =
  | { kind: "created"; record: A2ATaskRecord }
  | { kind: "replay"; record: A2ATaskRecord }
  | { kind: "message_conflict"; record: A2ATaskRecord }
  | { kind: "context_conflict"; record: A2ATaskRecord };

interface ScopedUser {
  tenantId?: string;
  ownerId?: string;
}

function scope(context: ServerCallContext): { tenantId: string; ownerId: string } {
  const user = context.user as ScopedUser | undefined;
  if (!context.tenant || !user?.ownerId) throw new Error("A2A Task Store requires an authenticated tenant and owner");
  return { tenantId: context.tenant, ownerId: user.ownerId };
}

function sanitizedTask(task: Task): Task {
  return { ...Task.fromJSON(Task.toJSON(task)), history: [] };
}

function toRecord(row: Record<string, unknown>): A2ATaskRecord {
  return {
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    messageId: String(row.message_id),
    requestFingerprint: String(row.request_fingerprint),
    knowledgeBaseId: String(row.knowledge_base_id),
    task: sanitizedTask(Task.fromJSON(row.task_json)),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
  };
}

export class PersistentA2ATaskStore implements TaskStore {
  private readonly filePath = path.join(env.dataRoot, "a2a-task-store.json");
  private readonly records = new Map<string, A2ATaskRecord>();
  private hydrated = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  private key(tenantId: string, ownerId: string, taskId: string): string {
    return `${tenantId}\u0000${ownerId}\u0000${taskId}`;
  }

  private async hydrate(): Promise<void> {
    if (pool || this.hydrated) return;
    this.hydrated = true;
    try {
      const stored = JSON.parse(await fs.readFile(this.filePath, "utf8")) as A2ATaskRecord[];
      for (const record of stored) {
        const normalized = { ...record, task: sanitizedTask(Task.fromJSON(record.task)) };
        this.records.set(this.key(record.tenantId, record.ownerId, record.task.id), normalized);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // The development fallback starts empty when no snapshot exists.
    }
  }

  private async persist(): Promise<void> {
    if (pool) return;
    const write = async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const records = [...this.records.values()].map((record) => ({ ...record, task: Task.toJSON(record.task) }));
      const temporaryPath = `${this.filePath}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify(records, null, 2), "utf8");
      await fs.rename(temporaryPath, this.filePath);
    };
    this.pendingWrite = this.pendingWrite.then(write, write);
    await this.pendingWrite;
  }

  async reserve(input: {
    tenantId: string;
    ownerId: string;
    messageId: string;
    requestFingerprint: string;
    knowledgeBaseId: string;
    task: Task;
  }): Promise<TaskReservation> {
    const now = new Date();
    const record: A2ATaskRecord = {
      ...input,
      task: sanitizedTask(input.task),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
    };
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(`delete from ontology_a2a_tasks where expires_at <= now()`);
        const existing = await client.query<Record<string, unknown>>(
          `select * from ontology_a2a_tasks where tenant_id=$1 and owner_id=$2 and message_id=$3 and expires_at > now() for update`,
          [input.tenantId, input.ownerId, input.messageId],
        );
        if (existing.rows[0]) {
          await client.query("commit");
          const found = toRecord(existing.rows[0]);
          return { kind: found.requestFingerprint === input.requestFingerprint ? "replay" : "message_conflict", record: found };
        }
        const active = await client.query<Record<string, unknown>>(
          `select * from ontology_a2a_tasks where tenant_id=$1 and owner_id=$2 and context_id=$3 and status in (1,2,6,8) and expires_at > now() limit 1 for update`,
          [input.tenantId, input.ownerId, input.task.contextId],
        );
        if (active.rows[0]) {
          await client.query("commit");
          return { kind: "context_conflict", record: toRecord(active.rows[0]) };
        }
        await client.query(
          `insert into ontology_a2a_tasks
             (task_id, tenant_id, owner_id, context_id, knowledge_base_id, message_id, request_fingerprint, status, task_json, expires_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [input.task.id, input.tenantId, input.ownerId, input.task.contextId, input.knowledgeBaseId, input.messageId, input.requestFingerprint, input.task.status?.state ?? 0, Task.toJSON(input.task), record.expiresAt],
        );
        await client.query("commit");
        return { kind: "created", record };
      } catch (error) {
        await client.query("rollback");
        if ((error as { code?: unknown }).code === "23505") {
          const existing = await client.query<Record<string, unknown>>(
            `select * from ontology_a2a_tasks where tenant_id=$1 and owner_id=$2 and message_id=$3 and expires_at > now()`,
            [input.tenantId, input.ownerId, input.messageId],
          );
          if (existing.rows[0]) {
            const found = toRecord(existing.rows[0]);
            return { kind: found.requestFingerprint === input.requestFingerprint ? "replay" : "message_conflict", record: found };
          }
          const active = await client.query<Record<string, unknown>>(
            `select * from ontology_a2a_tasks where tenant_id=$1 and owner_id=$2 and context_id=$3 and status in (1,2,6,8) and expires_at > now() limit 1`,
            [input.tenantId, input.ownerId, input.task.contextId],
          );
          if (active.rows[0]) return { kind: "context_conflict", record: toRecord(active.rows[0]) };
        }
        throw error;
      } finally {
        client.release();
      }
    }
    await this.hydrate();
    const existing = [...this.records.values()].find((candidate) =>
      candidate.tenantId === input.tenantId && candidate.ownerId === input.ownerId && candidate.messageId === input.messageId && Date.parse(candidate.expiresAt) > Date.now());
    if (existing) return { kind: existing.requestFingerprint === input.requestFingerprint ? "replay" : "message_conflict", record: structuredClone(existing) };
    const active = [...this.records.values()].find((candidate) =>
      candidate.tenantId === input.tenantId && candidate.ownerId === input.ownerId && candidate.task.contextId === input.task.contextId &&
      ACTIVE_STATES.has(candidate.task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED) && Date.parse(candidate.expiresAt) > Date.now());
    if (active) return { kind: "context_conflict", record: structuredClone(active) };
    this.records.set(this.key(input.tenantId, input.ownerId, input.task.id), record);
    await this.persist();
    return { kind: "created", record: structuredClone(record) };
  }

  async findByMessageId(tenantId: string, ownerId: string, messageId: string): Promise<A2ATaskRecord | undefined> {
    if (pool) {
      const result = await query<Record<string, unknown>>(
        `select * from ontology_a2a_tasks where tenant_id=$1 and owner_id=$2 and message_id=$3 and expires_at > now()`,
        [tenantId, ownerId, messageId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    }
    await this.hydrate();
    const record = [...this.records.values()].find((candidate) =>
      candidate.tenantId === tenantId && candidate.ownerId === ownerId && candidate.messageId === messageId && Date.parse(candidate.expiresAt) > Date.now());
    return record ? structuredClone(record) : undefined;
  }

  async findByTaskId(tenantId: string, ownerId: string, taskId: string): Promise<A2ATaskRecord | undefined> {
    if (pool) {
      const result = await query<Record<string, unknown>>(
        `select * from ontology_a2a_tasks where tenant_id=$1 and owner_id=$2 and task_id=$3 and expires_at > now()`,
        [tenantId, ownerId, taskId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    }
    await this.hydrate();
    const record = this.records.get(this.key(tenantId, ownerId, taskId));
    return record && Date.parse(record.expiresAt) > Date.now() ? structuredClone(record) : undefined;
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const owner = scope(context);
    if (pool) {
      const result = await query<Record<string, unknown>>(
        `select * from ontology_a2a_tasks where task_id=$1 and tenant_id=$2 and owner_id=$3 and expires_at > now()`,
        [taskId, owner.tenantId, owner.ownerId],
      );
      return result.rows[0] ? sanitizedTask(toRecord(result.rows[0]).task) : undefined;
    }
    await this.hydrate();
    const record = this.records.get(this.key(owner.tenantId, owner.ownerId, taskId));
    if (!record || Date.parse(record.expiresAt) <= Date.now()) return undefined;
    return sanitizedTask(record.task);
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const owner = scope(context);
    const updatedAt = new Date().toISOString();
    if (pool) {
      await query(
        `update ontology_a2a_tasks set context_id=$4, status=$5, task_json=$6, updated_at=$7
         where task_id=$1 and tenant_id=$2 and owner_id=$3
           and not (status=$8 and $5<>$8)`,
        [task.id, owner.tenantId, owner.ownerId, task.contextId, task.status?.state ?? 0, Task.toJSON(task), updatedAt, TaskState.TASK_STATE_CANCELED],
      );
      return;
    }
    await this.hydrate();
    const key = this.key(owner.tenantId, owner.ownerId, task.id);
    const current = this.records.get(key);
    if (!current) throw new Error(`A2A Task ${task.id} was not reserved`);
    if (current.task.status?.state === TaskState.TASK_STATE_CANCELED && task.status?.state !== TaskState.TASK_STATE_CANCELED) return;
    this.records.set(key, { ...current, task: sanitizedTask(task), updatedAt });
    await this.persist();
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const owner = scope(context);
    let records: A2ATaskRecord[];
    if (pool) {
      const result = await query<Record<string, unknown>>(
        `select * from ontology_a2a_tasks where tenant_id=$1 and owner_id=$2 and expires_at > now()`,
        [owner.tenantId, owner.ownerId],
      );
      records = result.rows.map(toRecord);
    } else {
      await this.hydrate();
      records = [...this.records.values()].filter((record) => record.tenantId === owner.tenantId && record.ownerId === owner.ownerId && Date.parse(record.expiresAt) > Date.now());
    }
    let tasks = records.map((record) => sanitizedTask(record.task));
    if (params.contextId) tasks = tasks.filter((task) => task.contextId === params.contextId);
    if (Number(params.status) !== TaskState.TASK_STATE_UNSPECIFIED) tasks = tasks.filter((task) => task.status?.state === params.status);
    if (params.statusTimestampAfter) {
      const after = Date.parse(params.statusTimestampAfter);
      tasks = tasks.filter((task) => task.status?.timestamp && Date.parse(task.status.timestamp) > after);
    }
    tasks.sort((left, right) => (right.status?.timestamp ?? "").localeCompare(left.status?.timestamp ?? "") || right.id.localeCompare(left.id));
    const totalSize = tasks.length;
    if (params.pageToken) {
      const [timestamp, ...id] = Buffer.from(params.pageToken, "base64url").toString("utf8").split("|");
      const index = tasks.findIndex((task) => (task.status?.timestamp ?? "") === timestamp && task.id === id.join("|"));
      tasks = index < 0 ? [] : tasks.slice(index + 1);
    }
    const pageSize = params.pageSize ?? 50;
    const page = tasks.slice(0, pageSize).map((task) => ({ ...task, artifacts: params.includeArtifacts ? task.artifacts : [] }));
    const last = page[page.length - 1];
    return {
      tasks: page,
      nextPageToken: last && tasks.length > page.length ? Buffer.from(`${last.status?.timestamp ?? ""}|${last.id}`).toString("base64url") : "",
      pageSize,
      totalSize,
    };
  }

  async activeRecords(): Promise<A2ATaskRecord[]> {
    if (pool) {
      const result = await query<Record<string, unknown>>(`select * from ontology_a2a_tasks where status in (1,2,6,8) and expires_at > now()`);
      return result.rows.map(toRecord);
    }
    await this.hydrate();
    return [...this.records.values()].filter((record) => ACTIVE_STATES.has(record.task.status?.state ?? 0) && Date.parse(record.expiresAt) > Date.now()).map((record) => structuredClone(record));
  }

  async purgeExpired(): Promise<string[]> {
    if (pool) {
      const result = await query<{ task_id: string }>("delete from ontology_a2a_tasks where expires_at <= now() returning task_id");
      return result.rows.map((row) => String(row.task_id));
    }
    await this.hydrate();
    const expired = [...this.records.entries()].filter(([, record]) => Date.parse(record.expiresAt) <= Date.now());
    if (!expired.length) return [];
    for (const [key] of expired) this.records.delete(key);
    await this.persist();
    return expired.map(([, record]) => record.task.id);
  }

  async saveRecord(record: A2ATaskRecord): Promise<void> {
    const context = { tenant: record.tenantId, user: { ownerId: record.ownerId } } as unknown as ServerCallContext;
    await this.save(record.task, context);
  }
}
