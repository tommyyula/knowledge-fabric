import type { JourneyState, OntologyStreamEvent } from "../../src/contracts/ontology";

export function journeyHasIngestWorkflow(state: JourneyState): boolean {
  const ingest = state.ingest;
  return Boolean(
    ingest.planId ||
    ingest.targetDirectory ||
    ingest.totalBatches > 0 ||
    ingest.completedBatches > 0 ||
    ingest.batches?.length ||
    ingest.status === "in_progress" ||
    ingest.status === "completed" ||
    ingest.status === "failed"
  );
}

export function shouldSuppressClaudeTextForJourney(state: JourneyState): boolean {
  return (state.phase === "ingest" || state.phase === "verify" || state.phase === "review") && journeyHasIngestWorkflow(state);
}

function journeyIsTerminalReviewDecision(state: JourneyState): boolean {
  return state.phase === "ready" && (state.review?.status === "approved" || state.review?.status === "discarded");
}

function toolInputRecord(event: OntologyStreamEvent): Record<string, unknown> | null {
  return event.type === "tool" && event.input && typeof event.input === "object" && !Array.isArray(event.input)
    ? event.input as Record<string, unknown>
    : null;
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").trim();
}

function pathTargetsWorkflowArtifact(value: string): boolean {
  const path = normalizedPath(value);
  return path === "ingest-plans" || path.startsWith("ingest-plans/") ||
    path === "pending_review/drafts" || path.startsWith("pending_review/drafts/") ||
    path === "verify" || path.startsWith("verify/");
}

function commandHasWorkflowWriteIntent(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  const writes = /(?:^|[\s;|&])(?:cp|mv|rm|mkdir|touch|tee)\b|(?:^|[\s;|&])sed\s+-i\b|(?:^|[\s;|&])perl\s+-i\b|>|>>|\.write_text\s*\(|\.write_bytes\s*\(|\.write\s*\(|open\s*\([^)]*["']w|fs\.writeFile|writeFileSync|json\.dump\s*\(|\.mkdir\s*\(/i.test(normalized);
  if (!writes) return false;
  return /(^|[\s"'`(=])ingest-plans(?:\/|["'`)]|$)/.test(normalized) ||
    /pending_review\/drafts/.test(normalized) ||
    /(^|[\s"'`(=])verify(?:\/|["'`)]|$)/.test(normalized);
}

function toolWritesWorkflowArtifact(event: OntologyStreamEvent): boolean {
  if (event.type !== "tool") return false;
  const tool = event.tool.toLowerCase();
  const input = toolInputRecord(event);
  if (!input) return false;
  if (tool === "bash" && typeof input.command === "string") return commandHasWorkflowWriteIntent(input.command);
  if (tool !== "write" && tool !== "edit" && tool !== "multiedit" && tool !== "notebookedit") return false;
  return ["file_path", "path", "notebook_path"].some((key) => typeof input[key] === "string" && pathTargetsWorkflowArtifact(input[key]));
}

export function toolRequestsWorkflowTextSuppression(event: OntologyStreamEvent): boolean {
  if (event.type !== "tool") return false;
  if (toolWritesWorkflowArtifact(event)) return true;
  if (!event.tool.includes("knowledge_update_journey") && !event.tool.includes("ontology_update_journey")) return false;
  const input = toolInputRecord(event);
  const buildPhase = input?.build_phase;
  const workflow = input?.claude_workflow;
  return buildPhase === "ingest" || buildPhase === "verify" || buildPhase === "review" ||
    workflow === "ingest" || workflow === "verify" || workflow === "review";
}

export class ClaudeWorkflowTextSuppressor {
  private active = false;

  seed(state: JourneyState): void {
    if (journeyIsTerminalReviewDecision(state)) this.active = false;
  }

  enable(): void {
    this.active = true;
  }

  observeTool(event: OntologyStreamEvent): void {
    if (toolRequestsWorkflowTextSuppression(event)) this.active = true;
  }

  observeJourney(state: JourneyState): void {
    if (journeyIsTerminalReviewDecision(state)) {
      this.active = false;
      return;
    }
    if (shouldSuppressClaudeTextForJourney(state)) this.active = true;
  }

  shouldSuppressClaudeText(): boolean {
    return this.active;
  }
}
