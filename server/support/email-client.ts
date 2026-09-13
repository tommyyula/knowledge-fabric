import { sanitizeDiagnostic } from "./report-builder";

export type ReportDeliveryOutcome = "rejected" | "unknown";

const DEFINITELY_UNSENT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_INVALID_URL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function collectErrorCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > 3) return [];
  const record = error as {
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  return [
    ...(typeof record.code === "string" ? [record.code] : []),
    ...collectErrorCodes(record.cause, depth + 1),
    ...(Array.isArray(record.errors)
      ? record.errors.flatMap((item) => collectErrorCodes(item, depth + 1))
      : []),
  ];
}

export function deliveryOutcomeForFetchError(
  error: unknown,
): ReportDeliveryOutcome {
  return collectErrorCodes(error).some((code) =>
    DEFINITELY_UNSENT_ERROR_CODES.has(code),
  )
    ? "rejected"
    : "unknown";
}

export class ReportDeliveryError extends Error {
  readonly status = 502;

  constructor(readonly outcome: ReportDeliveryOutcome) {
    super("Unable to deliver Technical Issue Report");
    this.name = "ReportDeliveryError";
  }
}

export function recipientList(value: string): string[] {
  return value
    .split(",")
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

function sanitizeEmailTitleSegment(value: unknown): string {
  const sanitized = sanitizeDiagnostic(value, 200)
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || "Unnamed Knowledge Base";
}

export async function sendReportEmail(input: {
  apiUrl: string;
  recipients: string[];
  timeoutMs: number;
  reportRequestId: string;
  knowledgeBaseName: string;
  html: string;
}): Promise<void> {
  const form = new FormData();
  input.recipients.forEach((recipient, index) =>
    form.append(`Emails[${index}]`, recipient),
  );
  form.append(
    "Title",
    `[Knowledge Fabric][Technical Issue Report][${input.reportRequestId}] ${sanitizeEmailTitleSegment(input.knowledgeBaseName)}`,
  );
  form.append(
    "Body",
    "A Technical Issue Report was submitted from Knowledge Fabric.<br>" +
      `Report request ID: ${input.reportRequestId}`,
  );
  form.append(
    "attachments",
    new Blob([input.html], { type: "text/html;charset=utf-8" }),
    `knowledge-fabric-issue-report-${input.reportRequestId}.html`,
  );

  let response: Response;
  try {
    response = await fetch(input.apiUrl, {
      method: "POST",
      headers: { "Time-Zone": "Asia/Shanghai" },
      body: form,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    throw new ReportDeliveryError(deliveryOutcomeForFetchError(error));
  }
  if (!response.ok) throw new ReportDeliveryError("rejected");
}

export async function sendKnowledgeBaseInvite(input: {
  apiUrl: string;
  recipient: string;
  timeoutMs: number;
  sharer: string;
  knowledgeBaseName: string;
  role: string;
  openUrl: string;
}): Promise<void> {
  const form = new FormData();
  form.append("Emails[0]", input.recipient);
  form.append("Title", `[Knowledge Fabric] ${sanitizeEmailTitleSegment(input.sharer)} shared a knowledge base with you`);
  form.append("Body", [
    `${sanitizeEmailTitleSegment(input.sharer)} shared ${sanitizeEmailTitleSegment(input.knowledgeBaseName)} with you.<br>`,
    `Permission: ${sanitizeEmailTitleSegment(input.role)}<br>`,
    `<a href="${input.openUrl}">Open Knowledge Base</a>`,
  ].join(""));
  let response: Response;
  try {
    response = await fetch(input.apiUrl, {
      method: "POST",
      headers: { "Time-Zone": "Asia/Shanghai" },
      body: form,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    throw new ReportDeliveryError(deliveryOutcomeForFetchError(error));
  }
  if (!response.ok) throw new ReportDeliveryError("rejected");
}
