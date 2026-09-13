import { randomBytes } from "node:crypto";
import path from "node:path";
import type { OperationErrorCode, OperationStatus } from "../../src/contracts/ontology";

const OPERATION_ID_RE = /^op_[A-Za-z0-9._-]+$/;
const OPERATION_PUBLIC_DIR = "operations";
const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const OPERATION_SLUG_MAX_LENGTH = 64;
const OPERATION_ERROR_CODES = new Set<OperationErrorCode>([
  "agent_run_cancelled",
  "agent_run_failed",
  "operation_finish_missing",
]);

export interface OperationIdInput {
  title?: string;
  userRequest: string;
  now?: Date;
}

export interface OperationFinishOutcomeInput {
  status: Exclude<OperationStatus, "running">;
  resultSummary: string;
  error?: string;
}

function operationTimestamp(date = new Date()): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}Z`;
}

function randomCode(length = 6): string {
  const bytes = randomBytes(length);
  let result = "";
  for (const byte of bytes) result += RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length];
  return result;
}

function slugifyAscii(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncateSlug(value: string, maxLength = OPERATION_SLUG_MAX_LENGTH): string {
  if (value.length <= maxLength) return value;
  const shortened = value.slice(0, maxLength).replace(/-[^-]*$/, "").replace(/-+$/g, "");
  return shortened.length >= 12 ? shortened : value.slice(0, maxLength).replace(/-+$/g, "");
}

function uniqueParts(parts: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const part of parts) {
    const slug = slugifyAscii(part);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    unique.push(slug);
  }
  return unique;
}

function extractBusinessIds(source: string): string[] {
  const matches = source.match(/\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b/g) ?? [];
  return uniqueParts(matches.filter((match) => /\d/.test(match))).slice(0, 3);
}

function detectAction(source: string): string {
  if (/(创建|新建|提交|create|submit|open)/i.test(source)) return "create";
  if (/(取消|作废|cancel|void)/i.test(source)) return "cancel";
  if (/(更新|修改|变更|update|modify|change)/i.test(source)) return "update";
  if (/(审批|批准|拒绝|评估|approval|approve|reject|evaluate)/i.test(source)) return "evaluate";
  if (/(生成|导出|清单|generate|export|list)/i.test(source)) return "generate";
  if (/(处理|分流|排查|跟进|triage|handle|follow[- ]?up)/i.test(source)) return "handle";
  if (/(查询|查一下|检查|核查|查看|query|check|lookup|get|find)/i.test(source)) return "query";
  return "run";
}

function detectObject(source: string, ids: readonly string[]): string | undefined {
  const idPrefix = ids[0]?.split("-")[0];
  if (idPrefix === "load") return "load";
  if (idPrefix === "ord" || idPrefix === "order") return "order";
  if (idPrefix === "appr" || idPrefix === "approval") return "approval";
  if (idPrefix === "case" || idPrefix === "cs") return "customer-case";
  if (idPrefix === "ship" || idPrefix === "shipment") return "shipment";

  if (/(load|装载|车次)/i.test(source)) return "load";
  if (/(订单|order)/i.test(source)) return "order";
  if (/(审批|approval)/i.test(source)) return "approval";
  if (/(客户|客诉|customer|case|ticket)/i.test(source)) return "customer-case";
  if (/(运单|发货|shipment|delivery)/i.test(source)) return "shipment";
  return undefined;
}

function detectConcepts(source: string): string[] {
  const concepts: string[] = [];
  if (/(预约|appointment|appt)/i.test(source)) concepts.push("appointment");
  if (/(拣货|picking|pick)/i.test(source)) concepts.push("picking-task");
  if (/(异常|exception)/i.test(source)) concepts.push("exception");
  if (/(清单|list)/i.test(source)) concepts.push("list");
  if (/(状态|status)/i.test(source)) concepts.push("status");
  if (/(工作流|流程|workflow|flow)/i.test(source)) concepts.push("workflow");
  return concepts;
}

function operationSemanticSlug(input: Pick<OperationIdInput, "title" | "userRequest">): string {
  const source = [input.title, input.userRequest].filter(Boolean).join(" ");
  const ids = extractBusinessIds(source);
  const action = detectAction(source);
  const object = detectObject(source, ids);
  let concepts = detectConcepts(source).filter((concept) => concept !== object);
  if (concepts.length > 1) concepts = concepts.filter((concept) => concept !== "status");
  const includeObject = Boolean(object && !ids.some((id) => id === object || id.startsWith(`${object}-`)));
  const semanticParts = uniqueParts([action, ...(includeObject && object ? [object] : []), ...ids, ...concepts]);
  const semanticSlug = truncateSlug(semanticParts.join("-"));
  if (semanticSlug && semanticSlug !== "run") return semanticSlug;

  const fallback = truncateSlug(slugifyAscii(source));
  return fallback || "operation";
}

export function assertOperationId(operationId: string): void {
  if (!isOperationId(operationId)) throw new Error("Invalid operation id");
}

export function isOperationId(operationId: string): boolean {
  return OPERATION_ID_RE.test(operationId);
}

export function parseOperationErrorCode(value: unknown): OperationErrorCode | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && OPERATION_ERROR_CODES.has(value as OperationErrorCode)) {
    return value as OperationErrorCode;
  }
  throw new Error("Invalid Operation Run error code");
}

export function createOperationId(input: OperationIdInput): string {
  return `op_${operationTimestamp(input.now)}__${operationSemanticSlug(input)}__${randomCode(6)}`;
}

export function operationWorkspacePaths(operationId: string): {
  publicDirectory: string;
  reportPath: string;
  artifactsDir: string;
} {
  assertOperationId(operationId);
  const publicDirectory = path.posix.join(OPERATION_PUBLIC_DIR, operationId);
  return {
    publicDirectory,
    reportPath: path.posix.join(publicDirectory, "report.md"),
    artifactsDir: path.posix.join(publicDirectory, "artifacts"),
  };
}

export function resolveOperationFinishOutcome(input: OperationFinishOutcomeInput): {
  error: string | undefined;
  logSummary: string;
} {
  if (input.status === "succeeded") {
    return { error: undefined, logSummary: `Operation finished: ${input.resultSummary}` };
  }
  const error = input.error ?? input.resultSummary;
  return {
    error,
    logSummary: input.status === "cancelled" ? `Operation cancelled: ${error}` : `Operation failed: ${error}`,
  };
}
