import type { OperationRun } from "../../src/contracts/ontology";
import { isOperationId } from "./model";
import type { OperationRunCursor } from "./store";

export function operationRunCursor(run: Pick<OperationRun, "startedAt" | "id">): OperationRunCursor {
  return { startedAt: run.startedAt, id: run.id };
}

export function encodeOperationRunCursor(cursor: OperationRunCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeOperationRunCursor(value: string): OperationRunCursor {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid Operation Run cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid Operation Run cursor");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Operation Run cursor");
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    typeof record.id !== "string" ||
    !isOperationId(record.id)
  ) {
    throw new Error("Invalid Operation Run cursor");
  }
  const cursor = { startedAt: new Date(record.startedAt).toISOString(), id: record.id };
  if (encodeOperationRunCursor(cursor) !== value) throw new Error("Invalid Operation Run cursor");
  return cursor;
}
