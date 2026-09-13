import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { BootstrapState, JourneyState } from "../../src/contracts/ontology";
import { acquireWorkflowLock, assertValidIngestPlanForDraft, listReviewReadyDraftIds, PendingReviewDraftConflictError, prepareIngestDraftBaseline, readActiveReviewDraftContext, readJourneyState, readReviewGate, saveKnowledgeSynthesis, updateOntologyInstanceGleaning, updateOntologyScenarioCards, writeJourneyState, type WorkflowLockPhase, type WorkflowLockRecord } from "../ontologies/workspace";
import { getSourceFile, listSourceFiles, readExtractionReport, sourceFileReadHint } from "../files/source-file-store";
import { classifyRawRepoPath, hasReadCodingRepoIngestSkill, NON_REPO_CODING_INGEST_GATE_MESSAGE, rawRepoRootsFromIngestPlanText, readIngestPlanTextForDraft, REPO_DOCUMENT_INGEST_GATE_MESSAGE, REPO_INGEST_SKILL_GATE_MESSAGE } from "./repo-ingest-routing";
import { createConfiguredOperationRunStore } from "../operations/configured-store";
import type { OperationRunStoreFactory } from "../operations/store";

const BOOTSTRAP_TOTAL_STEPS = 6;

const bootstrapStatusSchema = z.enum([
  "goal_selection",
  "materials_collection",
  "materials_ready",
  "schema_proposed",
  "schema_confirmation",
  "metadata_proposed",
  "metadata_confirmation",
  "hydrating",
  "done",
]);

const statusGuide = [
  "goal_selection: clarifying what the knowledge should cover; waiting for user goal.",
  "materials_collection: waiting for source files in raw/.",
  "materials_ready: raw/ has source files and the agent is ready to propose structure.",
  "schema_proposed/schema_confirmation: structure has been proposed and needs user confirmation.",
  "metadata_proposed/metadata_confirmation: name, description, emoji, language, and naming rules need user confirmation.",
  "hydrating: confirmed bootstrap metadata is being written into project files.",
  "done: bootstrap is complete. Use build_phase to move the right-panel node to ingest, verify, review.",
].join(" ");

const bootstrapToolUpdateSchema = z.object({
  status: bootstrapStatusSchema,
  bootstrap_step: z.number().int().min(1).max(8).optional(),
  bootstep: z.number().int().min(1).max(8).optional(),
  build_phase: z.enum(["bootstrap", "ingest", "review", "verify", "ready"]).optional(),
  claude_workflow: z.enum(["bootstrap", "ingest", "review", "verify", "query"]).optional(),
  awaitingUser: z.boolean().optional(),
  summary: z.string().max(240).optional(),
  goal: z.string().max(500).optional(),
  knowledge_subdirs: z.array(z.string()).max(12).optional(),
  wiki_subdirs: z.array(z.string()).max(12).optional(),
  name: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  emoji: z.string().max(8).optional(),
  content_language: z.string().max(80).optional(),
  naming_conventions: z.array(z.string()).max(12).optional(),
});

const ontologyScenarioStatusSchema = z.enum(["pending", "processing", "success"]);

const ontologyScenarioCardSchema = z.object({
  id: z.string().trim().min(1).max(120),
  status: ontologyScenarioStatusSchema.optional(),
  name: z.string().trim().min(1).max(240).optional(),
  actor: z.string().trim().min(1).max(240).optional(),
  decision: z.string().trim().min(1).max(500).optional(),
  target: z.string().trim().min(1).max(240).optional(),
  conclusions: z.array(z.unknown()).optional(),
  evidence: z.array(z.unknown()).optional(),
  dataScope: z.string().trim().min(1).max(500).optional(),
  freshness: z.string().trim().min(1).max(240).optional(),
  candidateAction: z.string().trim().min(1).max(240).optional(),
}).passthrough();

export interface OntologyRuntimeRunContext {
  tenantId: string;
  ownerId: string;
  ontologyId: string;
  sessionId: string;
  runId?: string;
  userRequest: string;
  locale?: "zh" | "en" | "ja";
  runTrace?: {
    readIngestSkillPaths?: Iterable<string>;
    readOperateSkillPaths?: Iterable<string>;
  };
}

export type BootstrapToolUpdate = z.infer<typeof bootstrapToolUpdateSchema>;

function hasList(value: string[] | undefined): value is string[] {
  return Array.isArray(value) && value.length > 0;
}

const strictBootstrapToolUpdateSchema = bootstrapToolUpdateSchema.superRefine((update, ctx) => {
  const subdirs = hasList(update.knowledge_subdirs) ? update.knowledge_subdirs : update.wiki_subdirs;
  const requireAwaitingUser = (expected: boolean) => {
    if (update.awaitingUser !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["awaitingUser"],
        message: `awaitingUser is required and must be ${expected} for status ${update.status}`,
      });
    }
  };
  const requireField = (field: keyof BootstrapToolUpdate) => {
    const value = update[field];
    if (typeof value !== "string" || !value.trim()) {
      ctx.addIssue({ code: "custom", path: [field], message: `${String(field)} is required for status ${update.status}` });
    }
  };
  const requireSubdirs = () => {
    if (!hasList(subdirs)) {
      ctx.addIssue({ code: "custom", path: ["knowledge_subdirs"], message: `knowledge_subdirs is required for status ${update.status}` });
    }
  };

  switch (update.status) {
    case "goal_selection":
    case "materials_collection":
    case "materials_ready":
      requireAwaitingUser(true);
      break;
    case "schema_proposed":
    case "schema_confirmation":
      requireAwaitingUser(true);
      requireSubdirs();
      break;
    case "metadata_proposed":
    case "metadata_confirmation":
      requireAwaitingUser(true);
      requireSubdirs();
      requireField("name");
      requireField("description");
      requireField("emoji");
      requireField("content_language");
      if (!hasList(update.naming_conventions)) {
        ctx.addIssue({ code: "custom", path: ["naming_conventions"], message: `naming_conventions is required for status ${update.status}` });
      }
      break;
    case "hydrating":
    case "done":
      requireAwaitingUser(false);
      break;
  }
});

const stepToNumber: Record<NonNullable<BootstrapState["status"]>, number> = {
  goal_selection: 1,
  materials_collection: 2,
  materials_ready: 2,
  schema_proposed: 3,
  schema_confirmation: 3,
  metadata_proposed: 4,
  metadata_confirmation: 4,
  hydrating: 5,
  done: 6,
};

const statusRank: Record<NonNullable<BootstrapState["status"]>, number> = {
  goal_selection: 1,
  materials_collection: 2,
  materials_ready: 2,
  schema_proposed: 3,
  schema_confirmation: 3,
  metadata_proposed: 4,
  metadata_confirmation: 4,
  hydrating: 5,
  done: 6,
};

function lifecycleRank(state: Pick<JourneyState, "phase" | "bootstrap">): number {
  switch (state.phase) {
    case "ready":
      return 9;
    case "review":
      return 8;
    case "verify":
      return 7;
    case "ingest":
      return 6;
    case "bootstrap":
      return statusRank[state.bootstrap.status ?? "goal_selection"];
  }
}

function statusFromBootstrapStep(update: BootstrapToolUpdate, current: JourneyState): NonNullable<BootstrapState["status"]> | null {
  const step = update.bootstrap_step ?? update.bootstep;
  if (!step) return null;
  switch (step) {
    case 1:
      return "goal_selection";
    case 2:
      return (current.bootstrap.rawSources?.length ?? 0) > 0 ? "materials_ready" : "materials_collection";
    case 3:
      return "schema_proposed";
    case 4:
      return "schema_confirmation";
    case 5:
      return update.awaitingUser === false ? "hydrating" : "metadata_confirmation";
    case 6:
      return "done";
    case 7:
      return "done";
    case 8:
      return "done";
    default:
      return null;
  }
}

function statusFromBuildPhase(update: BootstrapToolUpdate): NonNullable<BootstrapState["status"]> | null {
  const phase = update.build_phase ?? (update.claude_workflow === "ingest" || update.claude_workflow === "review" || update.claude_workflow === "verify" ? update.claude_workflow : undefined);
  switch (phase) {
    case "ingest":
    case "review":
    case "verify":
    case "ready":
      return "done";
    default:
      return null;
  }
}

function phaseFromStatus(status: NonNullable<BootstrapState["status"]>, update: BootstrapToolUpdate, current: JourneyState): JourneyState["phase"] {
  if (update.build_phase === "ready") return "ready";
  if (update.build_phase === "review" || update.claude_workflow === "review") return "review";
  if (update.build_phase === "ingest" || update.claude_workflow === "ingest") return "ingest";
  if (update.build_phase === "verify" || update.claude_workflow === "verify") return "verify";
  if (status === "done" && current.phase === "bootstrap") return "ingest";
  return "bootstrap";
}

function pageTypesFromDirs(dirs: readonly string[], confirmed: boolean): BootstrapState["pageTypes"] {
  const seen = new Set<string>();
  return dirs
    .map((dir) => dir.trim().replace(/^knowledge\//, "").replace(/^wiki\//, "").replace(/\/+$/, ""))
    .filter((dir) => dir && !dir.includes("{{") && !dir.includes(" "))
    .filter((dir) => {
      if (seen.has(dir)) return false;
      seen.add(dir);
      return true;
    })
    .map((name) => ({ name, confirmed }));
}

export function mergeBootstrapToolState(current: JourneyState, update: BootstrapToolUpdate): JourneyState {
  const requestedStatus = update.status;
  const stepStatus = statusFromBootstrapStep(update, current);
  const phaseStatus = statusFromBuildPhase(update);
  const subdirs = update.knowledge_subdirs?.length ? update.knowledge_subdirs : update.wiki_subdirs;
  const hasExistingSchema = current.bootstrap.pageTypes.length > 0;
  const schemaFallbackStatus: NonNullable<BootstrapState["status"]> = current.bootstrap.rawSources?.length
    ? "materials_ready"
    : current.bootstrap.status ?? "materials_collection";
  const statusFromRequest: NonNullable<BootstrapState["status"]> =
    (requestedStatus === "schema_proposed" || requestedStatus === "schema_confirmation") && !subdirs?.length && !hasExistingSchema
        ? schemaFallbackStatus
        : requestedStatus;
  const candidateStatus = [statusFromRequest, stepStatus, phaseStatus].filter((status): status is NonNullable<BootstrapState["status"]> => Boolean(status)).sort((a, b) => statusRank[b] - statusRank[a])[0];
  const currentStatus = current.bootstrap.status ?? "goal_selection";
  const candidatePhase = phaseFromStatus(candidateStatus, update, current);
  const candidateRank = lifecycleRank({ phase: candidatePhase, bootstrap: { ...current.bootstrap, status: candidateStatus } });
  const currentRank = lifecycleRank(current);
  const requestsReview = update.build_phase === "review" || update.claude_workflow === "review";
  const requestsWorkflowStart = current.phase === "ready" && (
    update.build_phase === "ingest" ||
    update.build_phase === "verify" ||
    update.build_phase === "review" ||
    update.claude_workflow === "ingest" ||
    update.claude_workflow === "verify" ||
    update.claude_workflow === "review"
  );
  const acceptsStatus = requestsReview || requestsWorkflowStart || candidateRank >= currentRank;
  const status = acceptsStatus ? candidateStatus : currentStatus;
  const result = update.name && update.description && update.emoji && subdirs?.length && update.naming_conventions?.length
    ? {
        name: update.name,
        description: update.description,
        emoji: update.emoji,
        content_language: update.content_language,
        knowledge_subdirs: subdirs,
        wiki_subdirs: update.wiki_subdirs,
        naming_conventions: update.naming_conventions,
      }
    : current.bootstrap.result;
  const pageTypes = subdirs?.length
    ? pageTypesFromDirs(subdirs, status === "hydrating" || status === "done" || candidatePhase !== "bootstrap")
    : current.bootstrap.pageTypes;
  const startsMaintenanceWork = current.phase === "ready" && (candidatePhase === "ingest" || candidatePhase === "verify");
  const ingest = startsMaintenanceWork && candidatePhase === "ingest"
    ? { files: [], generatedPages: [], totalBatches: 0, completedBatches: 0, progress: 0, batches: [], status: "in_progress" as const }
    : current.ingest;
  const verify = startsMaintenanceWork
    ? { status: "generating" as const, questionCount: 0, coverage: 0, autoFixed: 0, needsInput: 0, cases: [], fixes: [] }
    : current.verify;
  return {
    ...current,
    flow: candidatePhase === "ready" ? "maintenance" : current.phase === "ready" ? "maintenance" : current.flow,
    phase: acceptsStatus ? candidatePhase : current.phase,
    ingest,
    verify,
    review: startsMaintenanceWork ? undefined : current.review,
    bootstrap: {
      ...current.bootstrap,
      name: update.name ?? result?.name ?? current.bootstrap.name,
      description: update.description ?? result?.description ?? current.bootstrap.description,
      goal: update.goal ?? current.bootstrap.goal,
      pageTypes,
      step: stepToNumber[status] ?? current.bootstrap.step,
      totalSteps: Math.max(current.bootstrap.totalSteps || BOOTSTRAP_TOTAL_STEPS, BOOTSTRAP_TOTAL_STEPS),
      status,
      awaitingUser: acceptsStatus
        ? update.awaitingUser ?? (candidatePhase === "bootstrap" && (status === "goal_selection" || status === "materials_collection" || status === "materials_ready" || status === "schema_confirmation" || status === "metadata_proposed" || status === "metadata_confirmation"))
        : current.bootstrap.awaitingUser,
      confirmationPrompt: acceptsStatus ? update.summary ?? current.bootstrap.confirmationPrompt : current.bootstrap.confirmationPrompt,
      result,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function parseBootstrapToolUpdate(input: unknown): BootstrapToolUpdate | null {
  const parsed = strictBootstrapToolUpdateSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function formatBootstrapToolUpdateError(input: unknown): string | null {
  const parsed = strictBootstrapToolUpdateSchema.safeParse(input);
  if (parsed.success) return null;
  return parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

function workflowPhaseFromToolUpdate(update: BootstrapToolUpdate, state?: JourneyState): WorkflowLockPhase | null {
  if (update.build_phase === "ingest" || update.claude_workflow === "ingest") return "ingest";
  if (update.build_phase === "verify" || update.claude_workflow === "verify") return "verify";
  if (update.build_phase === "review" || update.claude_workflow === "review" || state?.phase === "review") return "review";
  return null;
}

function workflowLockConflictMessage(lock: WorkflowLockRecord | null, locale: OntologyRuntimeRunContext["locale"]): string {
  const holder = lock?.sessionId ? ` (${lock.sessionId})` : "";
  switch (locale) {
    case "en":
      return `This knowledge base is already running a write workflow in another session${holder}. Wait for the current Review to be approved or discarded before starting another ingest or edit.`;
    case "ja":
      return `このナレッジベースでは別のセッション${holder}で書き込みワークフローが実行中です。現在の Review を承認または破棄してから、別のインポートや編集を開始してください。`;
    default:
      return `当前知识库正在另一个会话${holder}中执行写入工作流。请先完成当前 Review 的 approve 或 discard，再开始新的导入或编辑。`;
  }
}

async function acquireRuntimeWorkflowLock(cwd: string, context: OntologyRuntimeRunContext | undefined, phase: WorkflowLockPhase): Promise<string | null> {
  if (!context?.runId) return null;
  const result = await acquireWorkflowLock(cwd, {
    ontologyId: context.ontologyId,
    sessionId: context.sessionId,
    runId: context.runId,
    workflow: "ingest",
    phase,
  });
  return result.acquired ? null : workflowLockConflictMessage(result.lock, context.locale);
}

const OPERATE_SKILL_PATH = "skills/operate/SKILL.md";

function normalizedRuntimePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasReadOperateSkill(paths: Iterable<string> | undefined): boolean {
  if (!paths) return false;
  for (const item of paths) {
    if (normalizedRuntimePath(item) === OPERATE_SKILL_PATH) return true;
  }
  return false;
}

async function operationStartBlock(cwd: string, context: OntologyRuntimeRunContext | undefined): Promise<{
  message: string;
  structuredContent: Record<string, unknown>;
} | null> {
  const state = await readJourneyState(cwd).catch((): JourneyState | null => null);
  const phase = state?.phase ?? "unknown";
  const flow = state?.flow ?? "unknown";
  const inMaintenanceReady = state?.flow === "maintenance" && state.phase === "ready";
  const enteredOperate = hasReadOperateSkill(context?.runTrace?.readOperateSkillPaths);
  if (inMaintenanceReady && enteredOperate) return null;

  if (!inMaintenanceReady) {
    return {
      message: [
        "operation_start is blocked in the current knowledge workflow.",
        "",
        "Operation Run tools are only for user-requested business operations in maintenance ready mode after reading skills/operate/SKILL.md.",
        "",
        `Current workflow phase: ${phase}.`,
        "",
        "Do not create an Operation Run for ingest, verify, review, QA batch answering, or knowledge maintenance steps. Continue the current knowledge workflow using its required artifact paths.",
      ].join("\n"),
      structuredContent: {
        status: "blocked",
        reason: "operation_not_allowed_in_workflow",
        flow,
        phase,
        expected: "continue_current_knowledge_workflow",
      },
    };
  }

  return {
    message: [
      "operation_start is blocked because this run has not entered the Operate workflow.",
      "",
      "Before using Operation Run tools, read and follow skills/operate/SKILL.md in this same run. Operation Run tools are not available for query, verify, ingest, review, or general knowledge maintenance.",
    ].join("\n"),
    structuredContent: {
      status: "blocked",
      reason: "operate_skill_not_read",
      flow,
      phase,
      expected: OPERATE_SKILL_PATH,
    },
  };
}

function pendingReviewDraftConflictDetails(err: unknown): {
  requestedDraftId: string;
  existingDraftIds: string[];
} | null {
  if (err instanceof PendingReviewDraftConflictError) {
    return {
      requestedDraftId: err.requestedDraftId,
      existingDraftIds: err.existingDraftIds,
    };
  }
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (record.code === "pending_review_draft_exists") {
      const requestedDraftId = typeof record.requestedDraftId === "string" ? record.requestedDraftId : "";
      const existingDraftIds = Array.isArray(record.existingDraftIds)
        ? record.existingDraftIds.filter((item): item is string => typeof item === "string")
        : [];
      if (requestedDraftId && existingDraftIds.length) return { requestedDraftId, existingDraftIds };
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  const match = /^Cannot prepare a new ingest draft \(([^)]+)\) because pending Review draft\(s\) already exist: ([^\n.]+)/.exec(message);
  if (!match) return null;
  return {
    requestedDraftId: match[1],
    existingDraftIds: match[2].split(",").map((item) => item.trim()).filter(Boolean),
  };
}

export function createOntologyRuntimeMcpServer(
  cwd: string,
  runContext?: OntologyRuntimeRunContext,
  operationRunStoreFactory: OperationRunStoreFactory = createConfiguredOperationRunStore,
) {
  const operationRunStore = runContext
    ? operationRunStoreFactory({
        workspaceRoot: cwd,
        tenantId: runContext.tenantId,
        ownerId: runContext.ownerId,
        knowledgeBaseId: runContext.ontologyId,
      })
    : null;
  return createSdkMcpServer({
    name: "knowledge_runtime",
    version: "1.0.0",
    alwaysLoad: true,
    instructions: [
      "knowledge_update_journey only synchronizes the web app right-side build panel.",
      "Do not change your workflow, reasoning, or user-facing answer because of this UI tool.",
      "Use the workspace CLAUDE.md, BOOTSTRAP.md, and skills as the source of truth for what work to do next.",
      "Do not call knowledge_update_journey with build_phase=ready; ready/maintenace is app-owned after review approval or discard",
      "Uploaded source documents may have both Markdown and original-file forms plus extraction reports. Use knowledge_list_source_files or knowledge_get_source_file to find originalPath/extractionReportPath; use knowledge_get_extraction_report before trusting converted Markdown for JSON structure summaries, tables, images, PDFs, spreadsheets, or EMF/WMF media.",
      "Use knowledge_prepare_ingest_draft to create the initial pending_review/drafts/<draft-id>/knowledge baseline. Do not recreate baseline files by reading knowledge/index.md, overview.md, glossary.md, or log.md and writing them yourself.",
      "Creating files under pending_review/drafts is not enough to enter Review. Do not call knowledge_update_journey with build_phase=review until the owning skill's Verify Gate has fully passed for that draft and a matching Verify results artifact exists with zero failures.",
      "Before the current draft's Verify Gate passes, keep the journey in ingest or verify with awaitingUser=false and continue the verification workflow.",
      "For user-approved query answer saves, use knowledge_save_synthesis. Do not create pending_review/drafts/query-* drafts, ingest plans, Verify artifacts, or Review handoffs for saved syntheses.",
      "For ontology-distill scenario queues, use ontology_update_scenario_cards. Do not edit ontology/artifacts/scenario-cards.json directly.",
      "For ontology-distill missed-instance passes, use ontology_instance_gleaning. Do not edit ontology/artifacts/instance-gleaning-state.json directly.",
      "For operation-style user requests, call operation_start before executing, operation_log for important progress or artifacts, and operation_finish when the operation succeeds or fails. These tools record operation activity only and never update JourneyState.",
    ].join("\n"),
    tools: [
      tool(
        "operation_start",
        "Start a user-requested operation run. Use this before executing operation-style requests so the app can retain a minimal execution record.",
        {
          title: z.string().trim().min(1).max(200).optional().describe("Short operation title."),
          user_request: z.string().trim().min(1).max(5000).describe("The user's operation request in their own terms."),
        },
        async (args) => {
          if (!runContext?.ontologyId || !runContext.sessionId || !runContext.runId || !runContext.userRequest || !operationRunStore) {
            return {
              isError: true,
              content: [{ type: "text", text: "operation_start requires complete Operation Run context." }],
              structuredContent: { status: "error", reason: "missing_runtime_context" },
            };
          }
          const block = await operationStartBlock(cwd, runContext);
          if (block) {
            return {
              isError: true,
              content: [{ type: "text", text: block.message }],
              structuredContent: block.structuredContent,
            };
          }
          try {
            const result = await operationRunStore.create({
              conversationId: runContext.sessionId,
              agentRunId: runContext.runId,
              userRequest: runContext.userRequest,
              title: args.title,
            });
            const structuredContent = {
              status: result.run.status,
              operation_id: result.run.id,
              report_path: result.reportPath,
              artifacts_dir: result.artifactsDir,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
              structuredContent,
            };
          } catch (err) {
            if (err instanceof PendingReviewDraftConflictError) {
              return {
                isError: true,
                content: [{ type: "text", text: err.message }],
                structuredContent: {
                  status: "blocked",
                  reason: err.code,
                  requestedDraftId: err.requestedDraftId,
                  existingDraftIds: err.existingDraftIds,
                },
              };
            }
            return {
              isError: true,
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
              structuredContent: { status: "error" },
            };
          }
        },
        { alwaysLoad: true },
      ),
      tool(
        "operation_log",
        "Append a short progress log to an operation run. Use type=artifact with a workspace-relative path when a user-visible output file is created or updated.",
        {
          operation_id: z.string().trim().min(1).max(220).describe("Operation id returned by operation_start."),
          type: z.enum(["progress", "artifact"]).optional().describe("Use artifact when path points to a user-visible operation output."),
          summary: z.string().trim().min(1).max(2000).describe("Short description of what was done."),
          path: z.string().trim().min(1).max(500).optional().describe("Optional workspace-relative path related to this log entry."),
          artifact_description: z.string().trim().min(1).max(500).optional().describe("Optional artifact description; defaults to summary."),
        },
        async (args) => {
          if (args.type === "artifact" && !args.path) {
            return {
              isError: true,
              content: [{ type: "text", text: "operation_log with type=artifact requires path." }],
              structuredContent: { status: "error", reason: "artifact_path_required" },
            };
          }
          if (!operationRunStore) {
            return {
              isError: true,
              content: [{ type: "text", text: "operation_log requires complete Operation Run context." }],
              structuredContent: { status: "error", reason: "missing_runtime_context" },
            };
          }
          try {
            const run = await operationRunStore.appendLog({
              operationId: args.operation_id,
              summary: args.summary,
              path: args.path,
              artifact: args.type === "artifact",
              artifactDescription: args.artifact_description,
            });
            const structuredContent = {
              status: run.status,
              operation_id: run.id,
              log_count: run.logs.length,
              artifact_count: run.artifacts.length,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
              structuredContent,
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
              structuredContent: { status: "error" },
            };
          }
        },
        { alwaysLoad: true },
      ),
      tool(
        "operation_finish",
        "Finish an operation run as succeeded or failed. Optionally writes a human-readable Markdown report to operations/<operation-id>/report.md.",
        {
          operation_id: z.string().trim().min(1).max(220).describe("Operation id returned by operation_start."),
          status: z.enum(["succeeded", "failed"]).describe("Final operation status."),
          result_summary: z.string().trim().min(1).max(5000).describe("Concise final outcome for the user."),
          report_markdown: z.string().trim().min(1).max(500_000).optional().describe("Optional complete Markdown operation report."),
          error: z.string().trim().min(1).max(5000).optional().describe("Failure detail when status=failed."),
        },
        async (args) => {
          if (!operationRunStore) {
            return {
              isError: true,
              content: [{ type: "text", text: "operation_finish requires complete Operation Run context." }],
              structuredContent: { status: "error", reason: "missing_runtime_context" },
            };
          }
          try {
            const run = await operationRunStore.finish({
              operationId: args.operation_id,
              status: args.status,
              resultSummary: args.result_summary,
              reportMarkdown: args.report_markdown,
              error: args.error,
            });
            const structuredContent = {
              status: run.status,
              operation_id: run.id,
              report_path: run.reportPath,
              artifact_count: run.artifacts.length,
              finished_at: run.finishedAt,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
              structuredContent,
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
              structuredContent: { status: "error" },
            };
          }
        },
        { alwaysLoad: true },
      ),
      tool(
        "knowledge_list_source_files",
        "List uploaded source-file mappings. Use this to find the original file behind a converted Markdown file.",
        {
          markdownPath: z.string().trim().min(1).max(500).optional().describe("Optional Markdown path such as raw/foo.md. If omitted, returns all source-file mappings."),
        },
        async (args) => {
          const records = await listSourceFiles(cwd, args.markdownPath);
          const items = records.map((record) => ({
            markdownPath: record.markdownPath,
            originalPath: record.originalPath,
            originalName: record.originalName,
            size: record.size,
            sha256: record.sha256,
            contentType: record.contentType,
            extension: record.extension,
            sourceName: record.sourceName,
            converter: record.converter,
            conversionStatus: record.conversionStatus,
            conversionError: record.conversionError,
            extractionReportPath: record.extractionReportPath,
            lossRisk: record.lossRisk,
            extractionWarnings: record.extractionWarnings,
            readHint: sourceFileReadHint(record),
          }));
          return {
            content: [{ type: "text", text: items.length ? JSON.stringify(items, null, 2) : "No source-file mappings found." }],
            structuredContent: { files: items },
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        "knowledge_get_source_file",
        "Get one uploaded source-file mapping by Markdown path or originalPath. Use Read on originalPath for contents.",
        {
          path: z.string().trim().min(1).max(500).describe("Markdown path or originalPath, for example raw/foo.md or .runtime/source-files/.../foo.pdf."),
        },
        async (args) => {
          const record = await getSourceFile(cwd, args.path);
          if (!record) {
            return {
              isError: true,
              content: [{ type: "text", text: `No source-file mapping found for ${args.path}.` }],
            };
          }
          const item = {
            markdownPath: record.markdownPath,
            originalPath: record.originalPath,
            originalName: record.originalName,
            size: record.size,
            sha256: record.sha256,
            contentType: record.contentType,
            extension: record.extension,
            sourceName: record.sourceName,
            converter: record.converter,
            conversionStatus: record.conversionStatus,
            conversionError: record.conversionError,
            extractionReportPath: record.extractionReportPath,
            lossRisk: record.lossRisk,
            extractionWarnings: record.extractionWarnings,
            readHint: sourceFileReadHint(record),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(item, null, 2) }],
            structuredContent: item,
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        "knowledge_get_extraction_report",
        "Get the extraction report for an uploaded source by Markdown path or originalPath. Use this before trusting converted Markdown for JSON structure summaries, tables, images, PDFs, spreadsheets, or EMF/WMF media.",
        {
          path: z.string().trim().min(1).max(500).describe("Markdown path or originalPath, for example raw/foo.md or .runtime/source-files/.../foo.pdf."),
        },
        async (args) => {
          const report = await readExtractionReport(cwd, args.path);
          if (!report) {
            return {
              isError: true,
              content: [{ type: "text", text: `No extraction report found for ${args.path}.` }],
            };
          }
          return {
            content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
            structuredContent: { report },
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        "knowledge_get_review_context",
        "Get the active pending Review draft, if any. Use this before editing content that is currently shown in the Review panel.",
        {},
        async () => {
          const [journey, activeDraft, gate, reviewReadyDraftIds] = await Promise.all([
            readJourneyState(cwd),
            readActiveReviewDraftContext(cwd),
            readReviewGate(cwd).catch(() => null),
            listReviewReadyDraftIds(cwd).catch(() => []),
          ]);
          const files = gate?.review?.files.map((file) => ({
            path: file.path,
            status: file.status,
          })) ?? [];
          const context = {
            flow: journey.flow,
            phase: journey.phase,
            activeDraftId: activeDraft?.draftId ?? gate?.draftId ?? null,
            activeDraftPath: activeDraft?.draftPath ?? (gate?.draftId ? `pending_review/drafts/${gate.draftId}` : null),
            reviewAllowed: gate?.allowed ?? false,
            reviewGateReason: gate?.reason ?? null,
            verifyCommand: gate?.verifyCommand ?? null,
            reviewLocked: reviewReadyDraftIds.length > 0,
            reviewReadyDraftIds,
            files,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(context, null, 2) }],
            structuredContent: context,
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        "knowledge_prepare_ingest_draft",
        "After writing ingest-plans/<plan_id>.json, validate the saved ingest plan for <draft_id>, then create the initial ingest draft baseline by byte-copying knowledge/index.md, overview.md, glossary.md, and log.md into pending_review/drafts/<draft_id>/knowledge. Use this instead of Read+Write copying.",
        {
          draft_id: z.string().trim().min(1).max(180).describe("Draft id such as ingest-source-2026-08-02-ab12. Must not contain path separators."),
        },
        async (args) => {
          const lockMessage = await acquireRuntimeWorkflowLock(cwd, runContext, "ingest");
          if (lockMessage) {
            return {
              isError: true,
              content: [{ type: "text", text: lockMessage }],
              structuredContent: { status: "blocked", reason: "workflow_locked" },
            };
          }
          const planText = await readIngestPlanTextForDraft(cwd, args.draft_id);
          const repoRoots = rawRepoRootsFromIngestPlanText(planText);
          if (repoRoots.length) {
            const classifications = (await Promise.all(repoRoots.map((repoRoot) => classifyRawRepoPath(cwd, repoRoot))))
              .filter((item): item is NonNullable<Awaited<ReturnType<typeof classifyRawRepoPath>>> => Boolean(item));
            const documentRepos = classifications.filter((item) => !item.isCodeRepo);
            if (documentRepos.length) {
              return {
                isError: true,
                content: [{ type: "text", text: `${REPO_DOCUMENT_INGEST_GATE_MESSAGE} Backend repo-shape check: ${documentRepos.map((item) => `${item.path}: ${item.reason}`).join("; ")}.` }],
                structuredContent: { status: "error", reason: "raw_repo_document_material" },
              };
            }
            if (!hasReadCodingRepoIngestSkill(runContext?.runTrace?.readIngestSkillPaths)) {
              return {
                isError: true,
                content: [{ type: "text", text: REPO_INGEST_SKILL_GATE_MESSAGE }],
                structuredContent: { status: "error", reason: "coding_repo_ingest_skill_required" },
              };
            }
          }
          if (!repoRoots.length && hasReadCodingRepoIngestSkill(runContext?.runTrace?.readIngestSkillPaths)) {
            return {
              isError: true,
              content: [{ type: "text", text: NON_REPO_CODING_INGEST_GATE_MESSAGE }],
              structuredContent: { status: "error", reason: "coding_repo_ingest_not_allowed" },
            };
          }
          try {
            const result = await prepareIngestDraftBaseline(cwd, args.draft_id);
            return {
              content: [{ type: "text", text: `Prepared ingest draft baseline for ${result.draftId}: ${result.files.length} files.` }],
              structuredContent: { status: "ok", ...result },
            };
          } catch (err) {
            const conflict = pendingReviewDraftConflictDetails(err);
            if (conflict) {
              return {
                isError: true,
                content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
                structuredContent: {
                  status: "blocked",
                  reason: "pending_review_draft_exists",
                  requestedDraftId: conflict.requestedDraftId,
                  existingDraftIds: conflict.existingDraftIds,
                },
              };
            }
            return {
              isError: true,
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
              structuredContent: { status: "error" },
            };
          }
        },
        { alwaysLoad: true },
      ),
      tool(
        "knowledge_save_synthesis",
        "Save a user-approved query answer directly as a knowledge synthesis. This tool writes knowledge/syntheses/<slug>.md, updates the Syntheses section in knowledge/index.md, and appends knowledge/log.md. It is only allowed when there are no pending Review drafts.",
        {
          content: z.string().trim().min(1).max(200_000).describe("Complete Markdown content for the synthesis page. Include the desired title as frontmatter title or an H1 heading."),
          slug: z.string().trim().min(1).max(120).optional().describe("Optional ASCII filename slug. If omitted, the backend derives one from frontmatter title or the first H1 heading."),
          index_summary: z.string().trim().min(1).max(240).optional().describe("Optional one-line summary for the knowledge/index.md Syntheses entry."),
        },
        async (args) => {
          try {
            const result = await saveKnowledgeSynthesis(cwd, {
              content: args.content,
              slug: args.slug,
              indexSummary: args.index_summary,
            });
            const { status: saveStatus, ...saved } = result;
            return {
              content: [{ type: "text", text: `Saved synthesis to ${result.path}.` }],
              structuredContent: { status: "ok", saveStatus, ...saved },
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
              structuredContent: { status: "error" },
            };
          }
        },
        { alwaysLoad: true },
      ),
      tool(
        "ontology_update_scenario_cards",
        "Create or advance the ontology-distill scenario queue. Use set_queue to create/adjust cards, start_next before modeling, complete_current after the current scenario completes modeling, instance gleaning, and validator checks, and status to inspect progress.",
        {
          operation: z.enum(["set_queue", "start_next", "complete_current", "status"]).describe("Queue operation. set_queue writes/adjusts the ordered queue; start_next marks the first unfinished scenario processing; complete_current marks the current processing scenario success; status reads current queue state."),
          scenario_id: z.string().trim().min(1).max(120).optional().describe("Required only for complete_current. Must match the current processing scenario id."),
          scenario_cards: z.array(ontologyScenarioCardSchema).optional().describe("Required only for set_queue. Ordered scenario cards; backend preserves completed cards and normalizes unfinished cards to pending."),
        },
        async (args) => {
          try {
            const result = await updateOntologyScenarioCards(cwd, args);
            const structuredContent: Record<string, unknown> = { ...result };
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              structuredContent,
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
              structuredContent: { status: "error" },
            };
          }
        },
        { alwaysLoad: true },
      ),
      tool(
        "ontology_instance_gleaning",
        "Force bounded missed-instance extraction passes for ontology-distill. Use next after the first ontology/object-instances.yaml draft and after each pass; the backend computes added Object/Link Instance ids and complete_current is blocked until three passes are completed.",
        {
          operation: z.enum(["next", "status", "reset"]).describe("next records the previous pass if one is active, then issues the next missed-instance prompt until complete; status inspects progress; reset restarts gleaning for the current processing scenario."),
          scenario_id: z.string().trim().min(1).max(120).optional().describe("Optional guard. When provided, it must match the current processing scenario id."),
        },
        async (args) => {
          try {
            const result = await updateOntologyInstanceGleaning(cwd, args);
            const structuredContent: Record<string, unknown> = { ...result };
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              structuredContent,
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
              structuredContent: { status: "error" },
            };
          }
        },
        { alwaysLoad: true },
      ),
      tool(
        "knowledge_update_journey",
        "Synchronize the app's right-side knowledge-base build panel with the current bootstrap step.",
        {
          status: bootstrapStatusSchema.describe(`Current lifecycle status. ${statusGuide}`),
          bootstrap_step: bootstrapToolUpdateSchema.shape.bootstrap_step.describe("Optional explicit bootstrap step: 1 goal, 2 materials, 3 structure proposal, 4 metadata confirmation, 5 hydration, 6 done. Use build_phase for ingest, verify, review, or ready."),
          bootstep: bootstrapToolUpdateSchema.shape.bootstep.describe("Deprecated alias for bootstrap_step."),
          build_phase: bootstrapToolUpdateSchema.shape.build_phase.describe("Right-panel phase to show: bootstrap, ingest, review, verify, or ready. Use review only when the current pending_review/drafts item has fully passed Verify."),
          claude_workflow: bootstrapToolUpdateSchema.shape.claude_workflow.describe("Workflow currently being executed: bootstrap, ingest, review, verify, or query."),
          awaitingUser: bootstrapToolUpdateSchema.shape.awaitingUser.describe("True when the next action is waiting for the user."),
          summary: bootstrapToolUpdateSchema.shape.summary.describe("Short UI-facing note about what is being confirmed or initialized."),
          goal: bootstrapToolUpdateSchema.shape.goal.describe("User-confirmed knowledge-base goal or purpose, only if explicitly known."),
          knowledge_subdirs: bootstrapToolUpdateSchema.shape.knowledge_subdirs.describe("Proposed knowledge subdirectories, without requiring descriptions."),
          wiki_subdirs: bootstrapToolUpdateSchema.shape.wiki_subdirs.describe("Deprecated alias for knowledge_subdirs."),
          name: bootstrapToolUpdateSchema.shape.name.describe("Proposed final knowledge base name, only if already known."),
          description: bootstrapToolUpdateSchema.shape.description.describe("Proposed final knowledge base description, only if already known."),
          emoji: bootstrapToolUpdateSchema.shape.emoji.describe("Proposed emoji, only if already known."),
          content_language: bootstrapToolUpdateSchema.shape.content_language.describe("Content language, only if already known."),
          naming_conventions: bootstrapToolUpdateSchema.shape.naming_conventions.describe("Naming conventions, only if already known."),
        },
        async (args) => {
          const validationError = formatBootstrapToolUpdateError(args);
          if (validationError) {
            return {
              isError: true,
              content: [{ type: "text", text: `Invalid knowledge_update_journey input: ${validationError}. Retry the tool call with all fields required for status ${args.status}.` }],
            };
          }
          const update = strictBootstrapToolUpdateSchema.parse(args);
          const current = await readJourneyState(cwd);
          const state = mergeBootstrapToolState(current, update);
          const lockPhase = workflowPhaseFromToolUpdate(update, state);
          if (lockPhase) {
            const lockMessage = await acquireRuntimeWorkflowLock(cwd, runContext, lockPhase);
            if (lockMessage) {
              return {
                isError: true,
                content: [{ type: "text", text: lockMessage }],
                structuredContent: { status: "blocked", phase: current.phase, reason: "workflow_locked" },
              };
            }
          }
          const requestsReview = update.build_phase === "review" || update.claude_workflow === "review" || state.phase === "review";
          if (requestsReview) {
            const gate = await readReviewGate(cwd);
            if (!gate.allowed) {
              return {
                isError: true,
                content: [{ type: "text", text: `${gate.message} Do not enter Review yet; continue the Verify Gate first.` }],
                structuredContent: { status: "blocked", phase: "verify", reason: gate.reason, draftId: gate.draftId, verifyCommand: gate.verifyCommand },
              };
            }
            if (gate.draftId?.startsWith("ingest-")) {
              try {
                await assertValidIngestPlanForDraft(cwd, gate.draftId);
              } catch (err) {
                return {
                  isError: true,
                  content: [{ type: "text", text: `${err instanceof Error ? err.message : String(err)} Do not enter Review yet; fix the ingest plan first.` }],
                  structuredContent: { status: "blocked", phase: "ingest", reason: "invalid_ingest_plan", draftId: gate.draftId, verifyCommand: gate.verifyCommand },
                };
              }
            }
          }
          await writeJourneyState(cwd, state);
          return {
            content: [{ type: "text", text: `Journey state updated: ${update.status}` }],
            structuredContent: { status: update.status, phase: state.phase },
          };
        },
        { alwaysLoad: true },
      ),
    ],
  });
}
