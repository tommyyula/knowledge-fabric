import fs from "node:fs/promises";
import path from "node:path";
import { pool, query } from "../db/client";
import { env } from "../env";

type DeliveryStatus = "in_progress" | "completed" | "failed" | "unknown";

interface SupportReportIdempotencyRecord {
  tenantId: string;
  ownerId: string;
  reportRequestId: string;
  requestFingerprint: string;
  status: DeliveryStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type SupportReportClaim =
  "claimed" | "replay" | "in_progress" | "unknown" | "conflict";

const localStorePath = path.join(
  env.dataRoot,
  "support-report-idempotency.json",
);
const localRecords = new Map<string, SupportReportIdempotencyRecord>();
let hydratePromise: Promise<void> | null = null;
let persistPromise = Promise.resolve();

function key(
  input: Pick<
    SupportReportIdempotencyRecord,
    "tenantId" | "ownerId" | "reportRequestId"
  >,
): string {
  return `${input.tenantId}\u0000${input.ownerId}\u0000${input.reportRequestId}`;
}

function fromRow(row: Record<string, unknown>): SupportReportIdempotencyRecord {
  return {
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    reportRequestId: String(row.report_request_id),
    requestFingerprint: String(row.request_fingerprint),
    status: row.status as DeliveryStatus,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
  };
}

async function hydrateLocal(): Promise<void> {
  hydratePromise ??= fs
    .readFile(localStorePath, "utf8")
    .then((text) => JSON.parse(text) as SupportReportIdempotencyRecord[])
    .then((records) => {
      for (const record of records) localRecords.set(key(record), record);
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  await hydratePromise;
}

async function persistLocal(): Promise<void> {
  const persist = async () => {
    await fs.mkdir(path.dirname(localStorePath), { recursive: true });
    const temporaryPath = `${localStorePath}.${process.pid}.tmp`;
    await fs.writeFile(
      temporaryPath,
      JSON.stringify([...localRecords.values()], null, 2),
      "utf8",
    );
    await fs.rename(temporaryPath, localStorePath);
  };
  persistPromise = persistPromise.then(persist, persist);
  await persistPromise;
}

export async function claimSupportReport(input: {
  tenantId: string;
  ownerId: string;
  reportRequestId: string;
  requestFingerprint: string;
  now: Date;
  expiresAt: Date;
}): Promise<SupportReportClaim> {
  if (pool) {
    await query(
      "delete from support_report_idempotency where tenant_id=$1 and owner_id=$2 and report_request_id=$3 and expires_at <= $4",
      [
        input.tenantId,
        input.ownerId,
        input.reportRequestId,
        input.now.toISOString(),
      ],
    );
    const inserted = await query<Record<string, unknown>>(
      `insert into support_report_idempotency
         (tenant_id, owner_id, report_request_id, request_fingerprint, status, created_at, updated_at, expires_at)
       values ($1,$2,$3,$4,'in_progress',$5,$5,$6)
       on conflict do nothing
       returning *`,
      [
        input.tenantId,
        input.ownerId,
        input.reportRequestId,
        input.requestFingerprint,
        input.now.toISOString(),
        input.expiresAt.toISOString(),
      ],
    );
    if (inserted.rows.length) return "claimed";
    const existingResult = await query<Record<string, unknown>>(
      "select * from support_report_idempotency where tenant_id=$1 and owner_id=$2 and report_request_id=$3",
      [input.tenantId, input.ownerId, input.reportRequestId],
    );
    const existing = existingResult.rows[0]
      ? fromRow(existingResult.rows[0])
      : null;
    if (!existing) return claimSupportReport(input);
    if (existing.requestFingerprint !== input.requestFingerprint)
      return "conflict";
    if (existing.status === "completed") return "replay";
    if (existing.status === "unknown") return "unknown";
    if (existing.status === "in_progress") return "in_progress";
    const retried = await query<Record<string, unknown>>(
      `update support_report_idempotency
       set status='in_progress', updated_at=$4
       where tenant_id=$1 and owner_id=$2 and report_request_id=$3 and status='failed'
       returning *`,
      [
        input.tenantId,
        input.ownerId,
        input.reportRequestId,
        input.now.toISOString(),
      ],
    );
    return retried.rows.length ? "claimed" : "in_progress";
  }

  await hydrateLocal();
  const recordKey = key(input);
  const existing = localRecords.get(recordKey);
  const activeExisting =
    existing && Date.parse(existing.expiresAt) > input.now.getTime()
      ? existing
      : null;
  if (activeExisting) {
    if (activeExisting.requestFingerprint !== input.requestFingerprint)
      return "conflict";
    if (activeExisting.status === "completed") return "replay";
    if (activeExisting.status === "unknown") return "unknown";
    if (activeExisting.status === "in_progress") return "in_progress";
  }
  const record: SupportReportIdempotencyRecord = {
    tenantId: input.tenantId,
    ownerId: input.ownerId,
    reportRequestId: input.reportRequestId,
    requestFingerprint: input.requestFingerprint,
    status: "in_progress",
    createdAt: activeExisting?.createdAt ?? input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    expiresAt: activeExisting?.expiresAt ?? input.expiresAt.toISOString(),
  };
  localRecords.set(recordKey, record);
  await persistLocal();
  return "claimed";
}

async function updateStatus(input: {
  tenantId: string;
  ownerId: string;
  reportRequestId: string;
  status: Exclude<DeliveryStatus, "in_progress">;
  now: Date;
}): Promise<void> {
  if (pool) {
    await query(
      `update support_report_idempotency set status=$4, updated_at=$5
       where tenant_id=$1 and owner_id=$2 and report_request_id=$3 and status='in_progress'`,
      [
        input.tenantId,
        input.ownerId,
        input.reportRequestId,
        input.status,
        input.now.toISOString(),
      ],
    );
    return;
  }
  await hydrateLocal();
  const recordKey = key(input);
  const existing = localRecords.get(recordKey);
  if (!existing || existing.status !== "in_progress") return;
  localRecords.set(recordKey, {
    ...existing,
    status: input.status,
    updatedAt: input.now.toISOString(),
  });
  await persistLocal();
}

export function completeSupportReport(
  input: Omit<Parameters<typeof updateStatus>[0], "status">,
): Promise<void> {
  return updateStatus({ ...input, status: "completed" });
}

export function failSupportReport(
  input: Omit<Parameters<typeof updateStatus>[0], "status">,
): Promise<void> {
  return updateStatus({ ...input, status: "failed" });
}

export function markSupportReportUnknown(
  input: Omit<Parameters<typeof updateStatus>[0], "status">,
): Promise<void> {
  return updateStatus({ ...input, status: "unknown" });
}
