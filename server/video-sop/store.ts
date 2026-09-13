import fs from "node:fs/promises";
import path from "node:path";
import { pool, query } from "../db/client";
import { videoSopConfig } from "./config";
import {
  ACTIVE_VIDEO_SOP_STATUSES,
  type VideoSopJobRecord,
  type VideoSopStatus,
} from "./types";

const storePath = path.join(videoSopConfig.root, "jobs.json");
let hydrated = false;
const records = new Map<string, VideoSopJobRecord>();
let pendingWrite: Promise<void> = Promise.resolve();

function recordKey(tenantId: string, ownerId: string, jobId: string): string {
  return `${tenantId}\u0000${ownerId}\u0000${jobId}`;
}

function clone(record: VideoSopJobRecord): VideoSopJobRecord {
  return structuredClone(record);
}

function rowRecord(row: Record<string, unknown>): VideoSopJobRecord {
  const value = typeof row.record === "string" ? JSON.parse(row.record) : row.record;
  return value as VideoSopJobRecord;
}

async function hydrate(): Promise<void> {
  if (pool || hydrated) return;
  hydrated = true;
  try {
    const stored = JSON.parse(await fs.readFile(storePath, "utf8")) as VideoSopJobRecord[];
    for (const record of stored) {
      records.set(recordKey(record.tenantId, record.ownerId, record.id), record);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function persist(): Promise<void> {
  if (pool) return;
  const write = async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const temporary = `${storePath}.tmp`;
    await fs.writeFile(
      temporary,
      JSON.stringify([...records.values()], null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.rename(temporary, storePath);
  };
  pendingWrite = pendingWrite.then(write, write);
  await pendingWrite;
}

async function upsertDatabaseRecord(record: VideoSopJobRecord): Promise<void> {
  await query(
    `insert into video_sop_jobs
       (id, tenant_id, owner_id, status, record, created_at, updated_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (id) do update set
       status=excluded.status,
       record=excluded.record,
       updated_at=excluded.updated_at,
       expires_at=excluded.expires_at`,
    [
      record.id,
      record.tenantId,
      record.ownerId,
      record.status,
      record,
      record.createdAt,
      record.updatedAt,
      record.expiresAt,
    ],
  );
}

export async function createVideoSopJob(record: VideoSopJobRecord): Promise<void> {
  if (pool) {
    await upsertDatabaseRecord(record);
    return;
  }
  await hydrate();
  records.set(recordKey(record.tenantId, record.ownerId, record.id), clone(record));
  await persist();
}

export async function getVideoSopJob(
  tenantId: string,
  ownerId: string,
  jobId: string,
): Promise<VideoSopJobRecord | null> {
  if (pool) {
    const result = await query<Record<string, unknown>>(
      `select record from video_sop_jobs
       where id=$1 and tenant_id=$2 and owner_id=$3 and expires_at > now()`,
      [jobId, tenantId, ownerId],
    );
    return result.rows[0] ? rowRecord(result.rows[0]) : null;
  }
  await hydrate();
  const record = records.get(recordKey(tenantId, ownerId, jobId));
  return record && Date.parse(record.expiresAt) > Date.now() ? clone(record) : null;
}

export async function listVideoSopJobs(
  tenantId: string,
  ownerId: string,
): Promise<VideoSopJobRecord[]> {
  if (pool) {
    await query(`delete from video_sop_jobs where expires_at <= now()`);
    const result = await query<Record<string, unknown>>(
      `select record from video_sop_jobs
       where tenant_id=$1 and owner_id=$2 and expires_at > now()
       order by updated_at desc`,
      [tenantId, ownerId],
    );
    return result.rows.map(rowRecord);
  }
  await hydrate();
  let removedExpired = false;
  for (const [key, record] of records) {
    if (Date.parse(record.expiresAt) <= Date.now()) {
      records.delete(key);
      removedExpired = true;
    }
  }
  if (removedExpired) await persist();
  return [...records.values()]
    .filter(
      (record) =>
        record.tenantId === tenantId &&
        record.ownerId === ownerId &&
        Date.parse(record.expiresAt) > Date.now(),
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map(clone);
}

export async function updateVideoSopJob(
  tenantId: string,
  ownerId: string,
  jobId: string,
  patch: Partial<Omit<VideoSopJobRecord, "id" | "tenantId" | "ownerId" | "createdAt">>,
): Promise<VideoSopJobRecord | null> {
  const current = await getVideoSopJob(tenantId, ownerId, jobId);
  if (!current) return null;
  const updated: VideoSopJobRecord = {
    ...current,
    ...patch,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  };
  if (pool) {
    await upsertDatabaseRecord(updated);
  } else {
    records.set(recordKey(tenantId, ownerId, jobId), clone(updated));
    await persist();
  }
  return clone(updated);
}

export async function deleteVideoSopJob(
  tenantId: string,
  ownerId: string,
  jobId: string,
): Promise<boolean> {
  if (pool) {
    await query(
      `delete from video_sop_jobs where id=$1 and tenant_id=$2 and owner_id=$3`,
      [jobId, tenantId, ownerId],
    );
    return true;
  }
  await hydrate();
  const deleted = records.delete(recordKey(tenantId, ownerId, jobId));
  if (deleted) await persist();
  return deleted;
}

export async function markInterruptedVideoSopJobs(): Promise<VideoSopJobRecord[]> {
  const interrupted: VideoSopJobRecord[] = [];
  const now = new Date().toISOString();
  const terminalExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  if (pool) {
    const result = await query<Record<string, unknown>>(
      `select record from video_sop_jobs
       where status = any($1::text[]) and expires_at > now()`,
      [[...ACTIVE_VIDEO_SOP_STATUSES]],
    );
    for (const row of result.rows) interrupted.push(rowRecord(row));
    for (const record of interrupted) {
      await upsertDatabaseRecord({
        ...record,
        status: "failed",
        error: {
          code: "SERVER_RESTARTED",
          message: "The server restarted before video SOP processing completed. Please upload the videos again.",
        },
        updatedAt: now,
        completedAt: now,
        expiresAt: terminalExpiry,
      });
    }
    return interrupted;
  }

  await hydrate();
  for (const [key, record] of records) {
    if (!ACTIVE_VIDEO_SOP_STATUSES.has(record.status)) continue;
    interrupted.push(clone(record));
    records.set(key, {
      ...record,
      status: "failed",
      error: {
        code: "SERVER_RESTARTED",
        message: "The server restarted before video SOP processing completed. Please upload the videos again.",
      },
      updatedAt: now,
      completedAt: now,
      expiresAt: terminalExpiry,
    });
  }
  if (interrupted.length) await persist();
  return interrupted;
}

export function isTerminalVideoSopStatus(status: VideoSopStatus): boolean {
  return !ACTIVE_VIDEO_SOP_STATUSES.has(status);
}
