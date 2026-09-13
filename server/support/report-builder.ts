import type {
  OntologyRunEventRecord,
  OntologyRunStatus,
} from "../ontologies/repository";
import type { JourneyState } from "../../src/contracts/ontology";

export interface ReportClientContext {
  pageUrl?: string;
  userAgent?: string;
  locale?: string;
  timeZone?: string;
  appRelease?: string;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function bounded(value: string, maximum = 2_000): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}… [truncated]`;
}

export function sanitizeDiagnostic(
  value: unknown,
  maximum = 2_000,
): string {
  return bounded(
    String(value ?? "")
      .replace(
        /-----BEGIN [^-]*(?:PRIVATE KEY|CREDENTIAL)[^-]*-----[\s\S]*?-----END [^-]+-----/gi,
        "[REDACTED_CREDENTIAL]",
      )
      .replace(
        /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi,
        "[REDACTED_HEADER]",
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
      .replace(
        /\b([\w-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|credential)[\w-]*)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
        "$1=[REDACTED]",
      )
      .replace(
        /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
        "[REDACTED_JWT]",
      )
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_ACCESS_KEY]")
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_TOKEN]")
      .replace(
        /\b(?:sk-(?:proj-)?|xox[baprs]-|glpat-|npm_)[A-Za-z0-9_-]{16,}\b/gi,
        "[REDACTED_TOKEN]",
      )
      .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/gi, "[REDACTED_TOKEN]")
      .replace(/\bfile:\/\/\/[^\s<>"']+/gi, "[REDACTED_PATH]")
      .replace(/\b[A-Za-z]:\\[^\s<>"']+/g, "[REDACTED_PATH]")
      .replace(
        /(?<![:/A-Za-z0-9._-])\/(?:[^/\s]+\/)+[^\s<>"']*/g,
        "[REDACTED_PATH]",
      ),
    maximum,
  );
}

function row(label: string, value: unknown): string {
  const displayValue =
    value === null || value === undefined || value === ""
      ? "Unavailable"
      : value;
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(sanitizeDiagnostic(displayValue))}</td></tr>`;
}

function journeyRows(state: JourneyState | null): string {
  if (!state) return row("Journey state", "Unavailable");
  return [
    row("Flow", state.flow),
    row("Phase", state.phase),
    row("Updated at", state.updatedAt),
    row("Bootstrap status", state.bootstrap.status),
    row("Ingest status", state.ingest.status),
    row("Ingest progress", `${state.ingest.progress ?? 0}%`),
    row("Verify status", state.verify.status),
    row("Review status", state.review?.status),
    row("Review draft", state.review?.draftId),
    row("Review file count", state.review?.files.length ?? 0),
  ].join("\n");
}

function eventRecord(
  event: OntologyRunEventRecord,
): Record<string, unknown> | null {
  return event.event &&
    typeof event.event === "object" &&
    !Array.isArray(event.event)
    ? (event.event as Record<string, unknown>)
    : null;
}

export function eventsWithinRunSnapshot(
  status: OntologyRunStatus,
  events: OntologyRunEventRecord[],
): OntologyRunEventRecord[] {
  return events.filter((event) => {
    if (
      status.lastSequence !== null &&
      event.sequence !== undefined &&
      event.sequence > status.lastSequence
    )
      return false;
    if (status.updatedAt && event.createdAt > status.updatedAt) return false;
    return true;
  });
}

function runDiagnostics(
  status: OntologyRunStatus,
  events: OntologyRunEventRecord[],
): { rows: string; details: string } {
  if (!status.runId)
    return {
      rows: row("Run state", "Unavailable"),
      details: "<p>No persisted Run events were available.</p>",
    };
  const failed = events.some((event) => eventRecord(event)?.type === "error");
  const state = failed ? "Failed" : status.completed ? "Completed" : "Active";
  const rows = [
    row("Run ID", status.runId),
    row("Run state", state),
    row("Event count", status.eventCount),
    row("Last sequence", status.lastSequence),
    row("Updated at", status.updatedAt),
  ].join("\n");
  const details = events
    .slice(-100)
    .flatMap((event) => {
      const record = eventRecord(event);
      if (record?.type === "tool" && typeof record.tool === "string") {
        return [
          `<li><strong>Tool</strong> ${escapeHtml(sanitizeDiagnostic(record.tool, 200))} <small>${escapeHtml(event.createdAt)}</small></li>`,
        ];
      }
      if (record?.type === "error" && typeof record.error === "string") {
        return [
          `<li><strong>Error</strong> ${escapeHtml(sanitizeDiagnostic(record.error))} <small>${escapeHtml(event.createdAt)}</small></li>`,
        ];
      }
      return [];
    })
    .join("\n");
  return {
    rows,
    details: details
      ? `<ul>${details}</ul>`
      : "<p>No error or tool events were recorded for the latest Run.</p>",
  };
}

export function buildCoreReport(input: {
  reportRequestId: string;
  submittedAt: string;
  tenantId: string;
  user: { id: string; displayName: string; email: string };
  project: { id: string; name: string; status: string };
  session: { id: string; preview: string };
  messages: Array<{ role: string; content: string; createdAt?: string }>;
  clientContext?: ReportClientContext;
  appRelease: string;
  journeyState: JourneyState | null;
  runStatus: OntologyRunStatus;
  runEvents: OntologyRunEventRecord[];
}): string {
  const messages = input.messages
    .filter(
      (message) =>
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "agent",
    )
    .slice(-20)
    .map(
      (message) =>
        `<article class="message"><div><strong>${escapeHtml(message.role === "user" ? "User" : "Assistant")}</strong><time>${escapeHtml(message.createdAt ?? "")}</time></div><pre>${escapeHtml(sanitizeDiagnostic(message.content, 4_000))}</pre></article>`,
    )
    .join("\n");
  const client = input.clientContext ?? {};
  const run = runDiagnostics(
    input.runStatus,
    eventsWithinRunSnapshot(input.runStatus, input.runEvents),
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Knowledge Fabric Technical Issue Report</title>
<style>body{font-family:system-ui,sans-serif;color:#1f2937;max-width:960px;margin:24px auto;padding:0 20px}h1{font-size:24px}h2{font-size:18px;margin-top:28px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d1d5db;padding:8px;text-align:left;vertical-align:top}th{width:220px;background:#f3f4f6}.message{border:1px solid #d1d5db;border-radius:8px;padding:12px;margin:10px 0}.message div{display:flex;justify-content:space-between;gap:16px}.message time{color:#6b7280;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:8px 0 0}</style></head>
<body><h1>Technical Issue Report</h1>
<h2>Report</h2><table>
${row("Report request ID", input.reportRequestId)}
${row("Submitted at", input.submittedAt)}
${row("Tenant", input.tenantId)}
${row("User ID", input.user.id)}
${row("User", input.user.displayName)}
${row("User email", input.user.email)}
</table>
<h2>Knowledge Base conversation</h2><table>
${row("Knowledge Base", input.project.name)}
${row("Knowledge Base ID", input.project.id)}
${row("Knowledge Base status", input.project.status)}
${row("Session", input.session.preview)}
${row("Session ID", input.session.id)}
</table>
<h2>Client diagnostics</h2><table>
${row("Page URL", client.pageUrl)}
${row("User agent", client.userAgent)}
${row("Locale", client.locale)}
${row("Time zone", client.timeZone)}
${row("Client application release", client.appRelease)}
${row("Server application release", input.appRelease)}
</table>
<h2>Journey state</h2><table>${journeyRows(input.journeyState)}</table>
<h2>Run diagnostics</h2><table>${run.rows}</table>${run.details}
<h2>Recent conversation</h2>${messages || "<p>No persisted messages were available.</p>"}
</body></html>`;
}
