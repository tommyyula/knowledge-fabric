import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { requireTenantContext } from "../auth/requireTenantContext";
import { asyncRoute } from "../http";
import { appendMessage, appendRunEvent, createOrGetConversationSnapshot, createSession, deleteSession, getConversationSnapshotByToken, getLatestRunStatus, getProjectById, getSession, getTombstonePreference, isTerminalRunEvent, listMessages, listRunEvents, listSessions, recordKnowledgeBaseChange, updateClaudeSessionId, updateProject, updateSession, type OntologyRunEventRecord } from "../ontologies/repository";
import { hasKnowledgeBaseCapability, resolveKnowledgeBaseAccess, type KnowledgeBaseAccess } from "../ontologies/access";
// 1. Bitbucket 相关
import { checkoutBitbucketRepository } from "../bitbucket/git";

// 2. Ontologies / Workspace 相关
import {
    acquireWorkflowLock,
    countMarkdownFiles,
    ensureWorkspace,
    listReviewReadyDraftIds,
    listPendingReviewDrafts,
    readReviewDraftDetail,
    readJourneyState,
    readReviewGate,
    readWorkflowContinuation,
    refreshRawSourcesInJourney,
    resolveWorkspaceFile,
    workspacePath,
    writeJourneyState,
    type WorkflowLockPhase,
} from "../ontologies/workspace";

// 3. Resource Library / Repository 相关
import {
    listResourceBindingsForOntology,
    listResourceLibrary,
    readBitbucketRepositoryReference,
    readAccessibleResourceObject,
    readResourceFolderObjects,
    readResourceObject,
    recordResourceBinding,
    type PublicResourceRecord,
    type ResourceBindingRecord,
    type ResourceLibrarySnapshot,
    type ResourceObjectReadResult,
} from "../resource-library/repository";
import { safeConvertedUploadPath, writeConvertedUploads } from "../files/converted-upload-writer";
import { formatUploadSize, MAX_UPLOAD_FILE_BYTES, UploadValidationError } from "../uploads/multipart";
import { createWorkspaceRunTrace, generateFollowupSuggestions, streamOntologyAgent, type FollowupWorkflowState } from "./claude-runner";
import { deleteClaudeSessionStoreForAppSession } from "./claude-session-store";
import { encodeAssistantUiEvent } from "./assistant-ui-stream";
import {
  encodeAiSdkDone,
  encodeAiSdkUiChunk,
  ontologyRunMessageId,
  OntologyAiSdkStreamProjector,
} from "./ai-sdk-ui-stream";
import { bootstrapAwareInitialJourneyState, projectBootstrapJourney } from "./bootstrap-observer";
import { continueInitialBootstrapBuild } from "./bootstrap-supervisor";
import { mergeBootstrapToolState, parseBootstrapToolUpdate } from "./ontology-runtime-tools";
import { isComposioConfigured } from "../composio/client";
import { listComposioConnections } from "../composio/connection-store";
import type { JourneyState, OntologyMessage, OntologyProject, OntologySession, OntologyStreamEvent } from "../../src/contracts/ontology";
import { agentRunCancelledMessage, agentRunFailedMessage, formatReviewReady, formatWorkflowLocked, normalizeUiLocale, reviewReadyFileCount, WorkflowStatusAnnouncer, workflowContinuationLimitMessage, type UiLocale } from "./workflow-status-messages";
import { ClaudeWorkflowTextSuppressor } from "./workflow-text-suppression";
import { buildRepoIngestRoutingHint } from "./repo-ingest-routing";
import { createConfiguredOperationRunStore } from "../operations/configured-store";
import { reconcileOperationRunAfterChatCompletion } from "../operations/reconcile-agent-run";
import { applySlashCommandTriggerPrefix, slashCommandIds } from "../../src/contracts/slash-commands";

export const chatRouter = Router();
type RunSubscriber = (record: OntologyRunEventRecord | null) => void;

interface ChatRunResult {
  message?: OntologyMessage;
  events: OntologyStreamEvent[];
  journeyState: JourneyState | null;
  claudeSessionId?: string | null;
  cancelled?: boolean;
  error?: string;
}

interface ActiveChatRun {
  key: string;
  runId: string;
  controller: AbortController;
  startedAt: number;
  subscribers: Set<RunSubscriber>;
  promise: Promise<ChatRunResult>;
  emit: (event: OntologyStreamEvent) => Promise<OntologyRunEventRecord | null>;
  flush: () => Promise<void>;
  done: boolean;
  cancelled: boolean;
  reconcileCancellation: () => Promise<void>;
}

const activeChatRuns = new Map<string, ActiveChatRun>();
const TEXT_DELTA_BATCH_MAX_BYTES = 4 * 1024;
const TEXT_DELTA_BATCH_MAX_DELAY_MS = 250;

class TextDeltaBatcher {
  private readonly textParts: string[] = [];
  private textBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  constructor(private readonly persist: (event: OntologyStreamEvent) => Promise<OntologyRunEventRecord>) {}

  async emit(event: OntologyStreamEvent): Promise<OntologyRunEventRecord | null> {
    this.throwIfFailed();
    if (event.type === "text-delta") return this.appendText(event.delta);
    await this.flushText();
    return this.persistEvent(event);
  }

  async flush(): Promise<void> {
    await this.flushText();
    await this.writeTail;
    this.throwIfFailed();
  }

  private async appendText(delta: string): Promise<OntologyRunEventRecord | null> {
    let persisted: OntologyRunEventRecord | null = null;
    for (const character of delta) {
      const characterBytes = Buffer.byteLength(character);
      if (this.textBytes + characterBytes > TEXT_DELTA_BATCH_MAX_BYTES) persisted = await this.flushText();
      this.textParts.push(character);
      this.textBytes += characterBytes;
      if (this.textBytes === TEXT_DELTA_BATCH_MAX_BYTES) persisted = await this.flushText();
    }
    if (this.textParts.length) this.scheduleFlush();
    return persisted;
  }

  private async flushText(): Promise<OntologyRunEventRecord | null> {
    this.clearTimer();
    if (!this.textParts.length) {
      await this.writeTail;
      this.throwIfFailed();
      return null;
    }
    const delta = this.textParts.join("");
    this.textParts.length = 0;
    this.textBytes = 0;
    return this.persistEvent({ type: "text-delta", delta });
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushText().catch((error) => { this.failure ??= error; });
    }, TEXT_DELTA_BATCH_MAX_DELAY_MS);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private persistEvent(event: OntologyStreamEvent): Promise<OntologyRunEventRecord> {
    this.throwIfFailed();
    const write = this.writeTail.then(() => {
      this.throwIfFailed();
      return this.persist(event);
    });
    this.writeTail = write.then(() => undefined, (error) => { this.failure ??= error; });
    return write;
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }
}

function activeChatRunKey(input: { tenantId: string; ownerId: string; ontologyId: string; sessionId: string }): string {
  return `${input.tenantId}:${input.ownerId}:${input.ontologyId}:${input.sessionId}`;
}

function getActiveChatRun(key: string): ActiveChatRun | null {
  const run = activeChatRuns.get(key);
  return run && !run.done ? run : null;
}

async function finishActiveChatRun(run: ActiveChatRun): Promise<void> {
  if (run.done) return;
  try {
    await run.flush();
  } finally {
    run.done = true;
    if (activeChatRuns.get(run.key) === run) activeChatRuns.delete(run.key);
    for (const subscriber of run.subscribers) {
      try { subscriber(null); } catch { /* subscriber disconnected */ }
    }
    run.subscribers.clear();
  }
}

function startActiveChatRun(
  input: {
    key: string;
    runId: string;
    tenantId: string;
    ontologyId: string;
    sessionId: string;
    onComplete?: (result: ChatRunResult) => Promise<void>;
  },
  executor: (emit: (event: OntologyStreamEvent) => Promise<OntologyRunEventRecord | null>, signal: AbortSignal) => Promise<ChatRunResult>,
): ActiveChatRun {
  const controller = new AbortController();
  const subscribers = new Set<RunSubscriber>();
  let sequence = 0;
  const batcher = new TextDeltaBatcher(async (event) => {
    sequence += 1;
    const record = await appendRunEvent({
      tenantId: input.tenantId,
      ontologyId: input.ontologyId,
      sessionId: input.sessionId,
      runId: input.runId,
      sequence,
      event,
    });
    for (const subscriber of subscribers) {
      try { subscriber(record); } catch { /* subscriber disconnected */ }
    }
    return record;
  });
  const run: ActiveChatRun = {
    key: input.key,
    runId: input.runId,
    controller,
    startedAt: Date.now(),
    subscribers,
    done: false,
    cancelled: false,
    reconcileCancellation: () => input.onComplete?.({ events: [], journeyState: null, cancelled: true }) ?? Promise.resolve(),
    emit: async (event: OntologyStreamEvent) => {
      if (run.cancelled && event.type !== "error") return null;
      return batcher.emit(event);
    },
    flush: () => batcher.flush(),
    promise: Promise.resolve({ events: [], journeyState: null }),
  };

  activeChatRuns.set(input.key, run);

  run.promise = (async () => {
    let result: ChatRunResult;
    try {
      result = await executor(run.emit, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted && !run.cancelled) {
        const message = err instanceof Error ? err.message : String(err);
        // The batcher latches its first write failure and rethrows it from every later call, so a
        // run-event store hiccup would otherwise stop the run from reporting why it died.
        await run.emit({ type: "error", error: message }).catch((emitError) => {
          console.error("[chat] failed to emit run error", { runId: input.runId, error: message, emitError });
        });
        result = { events: [], journeyState: null, error: message };
      } else {
        result = { events: [], journeyState: null, cancelled: true };
      }
    }
    try {
      await input.onComplete?.(result);
    } catch (error) {
      const message = `Operation Run reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error("[chat] failed to reconcile Operation Run", {
        runId: input.runId,
        error: message,
      });
      await run.emit({ type: "error", error: message }).catch(() => undefined);
      result = { ...result, error: message };
    } finally {
      await finishActiveChatRun(run).catch((flushError) => {
        console.error("[chat] failed to finish run", { runId: input.runId, error: flushError });
      });
    }
    return result;
  })();
  return run;
}

const CANCEL_SETTLE_TIMEOUT_MS = 3_000;

/** Waits for a promise but never longer than `timeoutMs`, so a wedged run cannot block the caller. */
async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([promise.then(() => undefined, () => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelActiveChatRun(key: string): Promise<boolean> {
  const run = activeChatRuns.get(key);
  if (!run) return false;
  run.cancelled = true;
  await run.emit({ type: "error", error: "Chat run cancelled" }).catch(() => undefined);
  run.controller.abort();
  await run.reconcileCancellation();
  // Give the executor a bounded moment to unwind and record its cancelled assistant message. The
  // client refreshes history as soon as this request returns, so racing it would show the user a
  // turn with no reply — exactly the dangling-message problem cancelling is meant to avoid. The
  // bound keeps a run that ignores the abort from holding up the response.
  await settleWithin(run.promise, CANCEL_SETTLE_TIMEOUT_MS);
  // The run is torn down either way; a flush failure must not turn cancel into an HTTP 500 and
  // leave the client believing the run is still alive.
  await finishActiveChatRun(run).catch((flushError) => {
    console.error("[chat] failed to finish cancelled run", { runId: run.runId, error: flushError });
  });
  return true;
}

async function cancelChatRun(input: { key: string; tenantId: string; ownerId: string; ontologyId: string; sessionId: string }): Promise<{ cancelled: boolean; local: boolean; runId: string | null; orphaned?: boolean }> {
  if (await cancelActiveChatRun(input.key)) {
    return { cancelled: true, local: true, runId: null };
  }

  const status = await getLatestRunStatus({
    tenantId: input.tenantId,
    ontologyId: input.ontologyId,
    sessionId: input.sessionId,
  });
  if (!status.active || !status.runId) {
    return { cancelled: false, local: false, runId: status.runId };
  }

  await appendRunEvent({
    tenantId: input.tenantId,
    ontologyId: input.ontologyId,
    sessionId: input.sessionId,
    runId: status.runId,
    sequence: (status.lastSequence ?? status.eventCount ?? 0) + 1,
    event: { type: "error", error: "Chat run cancelled" },
  });
  await reconcileOperationRunAfterChatCompletion({
    store: createConfiguredOperationRunStore({
      workspaceRoot: workspacePath(input.tenantId, input.ownerId, input.ontologyId),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      knowledgeBaseId: input.ontologyId,
    }),
    conversationId: input.sessionId,
    agentRunId: status.runId,
    result: { cancelled: true },
  });
  return { cancelled: true, local: false, runId: status.runId, orphaned: true };
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; message?: unknown };
  const name = typeof record.name === "string" ? record.name : "";
  const message = typeof record.message === "string" ? record.message : "";
  return name === "AbortError" || /abort|aborted|cancel|cancelled|canceled/i.test(message);
}

const chatSchema = z.object({
  message: z.string().min(1).optional(),
  messages: z.array(z.unknown()).optional(),
  backendMessage: z.string().min(1).optional(),
  slashCommandId: z.enum(slashCommandIds).optional(),
  locale: z.enum(["zh", "en", "ja"]).optional(),
  workspaceFiles: z.array(z.string().trim().min(1).max(500)).optional(),
  workspaceReferences: z.array(z.string().trim().min(1).max(500)).optional(),
  resourceIds: z.array(z.string().trim().min(1).max(120)).optional(),
  resourceFolderIds: z.array(z.string().trim().min(1).max(120)).optional(),
  stream: z.boolean().optional(),
  streamFormat: z.enum(["ontology", "ai-sdk"]).optional(),
  disabledConnectors: z.array(z.string()).optional(),
});
const sessionPatchSchema = z.object({ preview: z.string().trim().min(1).max(200).optional() });
const suggestionsSchema = z.object({
  clientMessages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(4000),
    createdAt: z.string().max(80).optional(),
  })).max(12).optional(),
});

const SSE_HEARTBEAT_INTERVAL_MS = 25_000;
const SSE_HEARTBEAT_FRAME = ": heartbeat\n\n";
const MAX_WORKFLOW_CONTINUATIONS = 20;

function journeyPhaseRank(state: JourneyState | null): number {
  if (!state) return 0;
  switch (state.phase) {
    case "bootstrap": return state.bootstrap.status === "hydrating" ? 2 : 1;
    case "ingest": return 3;
    case "verify": return 4;
    case "review": return 5;
    case "ready": return 6;
  }
}

function workflowMode(state: JourneyState): "building" | "manage" {
  if (state.flow === "build" && state.phase !== "ready") return "building";
  return "manage";
}

function userDecisionNeeded(state: JourneyState): string | null {
  const status = state.bootstrap.status;
  if (state.phase === "review" || state.review?.status === "pending") return "review_staged_changes";
  if (state.phase !== "bootstrap") return null;
  switch (status) {
    case "goal_selection": return "provide_goal";
    case "materials_collection": return "upload_source_materials";
    case "materials_ready": return "generate_schema";
    case "schema_proposed":
    case "schema_confirmation": return "confirm_or_adjust_schema";
    case "metadata_proposed":
    case "metadata_confirmation": return "confirm_or_adjust_metadata";
    default: return null;
  }
}

function nextExpectedAction(decision: string | null): string | null {
  switch (decision) {
    case "provide_goal": return "User should describe what this knowledge base should cover.";
    case "upload_source_materials": return "User should upload source materials, or explicitly continue without materials.";
    case "generate_schema": return "User can ask the assistant to inspect materials and propose the knowledge structure.";
    case "confirm_or_adjust_schema": return "User should confirm the proposed structure or describe structural adjustments.";
    case "confirm_or_adjust_metadata": return "User should confirm the proposed name, description, emoji, language, and naming rules or describe adjustments.";
    case "review_staged_changes": return "User can ask chat to summarize risks or request adjustments; approve/discard happens in the Review panel.";
    default: return null;
  }
}

function buildFollowupWorkflowState(project: OntologyProject, state: JourneyState): FollowupWorkflowState {
  const decision = userDecisionNeeded(state);
  const reviewFiles = state.review?.files ?? [];
  const newCount = reviewFiles.filter((file) => file.status === "new").length;
  const modifiedCount = reviewFiles.filter((file) => file.status === "modified").length;
  return {
    project: {
      name: project.name,
      description: project.description,
      pageCount: project.pageCount,
      status: project.status,
    },
    journey: {
      mode: workflowMode(state),
      flow: state.flow,
      phase: state.phase,
      bootstrapStatus: state.bootstrap.status ?? null,
      awaitingUser: Boolean(state.bootstrap.awaitingUser),
      userDecisionNeeded: decision,
      nextExpectedAction: nextExpectedAction(decision),
      confirmationPrompt: state.bootstrap.confirmationPrompt ?? null,
    },
    ingest: {
      status: state.ingest.status ?? null,
      progress: state.ingest.progress,
      completedBatches: state.ingest.completedBatches,
      totalBatches: state.ingest.totalBatches,
      generatedPagesCount: state.ingest.generatedPages?.length ?? 0,
    },
    verify: {
      status: state.verify.status,
      questionCount: state.verify.questionCount,
      passCount: state.verify.passCount ?? state.verify.cases.filter((item) => item.status === "pass" || item.status === "fixed").length,
      failCount: state.verify.failCount ?? state.verify.cases.filter((item) => item.status === "fail").length,
      fixedCount: state.verify.fixedCount ?? state.verify.autoFixed,
    },
    review: state.review ? {
      status: state.review.status ?? null,
      draftId: state.review.draftId,
      fileCount: reviewFiles.length,
      newCount,
      modifiedCount,
    } : null,
  };
}

function createHeartbeatSseWriter(res: Response) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stop = () => {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  const resetTimer = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(SSE_HEARTBEAT_FRAME);
    }, SSE_HEARTBEAT_INTERVAL_MS);
  };

  resetTimer();

  return {
    write(chunk: string) {
      if (closed || res.writableEnded) return false;
      resetTimer();
      return res.write(chunk);
    },
    stop,
  };
}

function sequenceFromQuery(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function stringFromQuery(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function streamFormatFromQuery(value: unknown): "ontology" | "ai-sdk" {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "ontology" ? "ontology" : "ai-sdk";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeRunCursorAiSdkChunk(runId: string, sequence: number): string {
  return encodeAiSdkUiChunk({
    type: "data-run-event",
    id: `${runId}:${sequence}`,
    data: { runId, sequence },
    transient: true,
  } as Parameters<typeof encodeAiSdkUiChunk>[0]);
}

async function streamRunToResponse(input: {
  req: Request;
  res: Response;
  tenantId: string;
  ontologyId: string;
  sessionId: string;
  runId: string;
  afterSequence?: number;
  streamFormat?: "ontology" | "ai-sdk";
  activeRun?: ActiveChatRun | null;
}) {
  const format = input.streamFormat ?? "ai-sdk";
  input.res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const streamWriter = createHeartbeatSseWriter(input.res);
  const aiSdkProjector = format === "ai-sdk"
    ? new OntologyAiSdkStreamProjector(input.runId)
    : null;
  let closed = false;
  let cursor = input.afterSequence ?? 0;
  let terminal = false;
  const queued: (OntologyRunEventRecord | null)[] = [];
  let resolveNext: (() => void) | null = null;

  const enqueue = (record: OntologyRunEventRecord | null) => {
    queued.push(record);
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve();
    }
  };

  input.req.on("close", () => {
    closed = true;
    streamWriter.stop();
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve();
    }
  });

  const writeRecord = (record: OntologyRunEventRecord) => {
    const sequence = record.sequence ?? 0;
    if (sequence <= cursor || closed || input.res.writableEnded) return;
    cursor = sequence;
    const event = record.event as OntologyStreamEvent;
    if (aiSdkProjector) {
      streamWriter.write(encodeRunCursorAiSdkChunk(input.runId, sequence));
      for (const chunk of aiSdkProjector.project(event, sequence)) {
        streamWriter.write(encodeAiSdkUiChunk(chunk));
      }
    } else {
      streamWriter.write(encodeAssistantUiEvent(event));
    }
    if (isTerminalRunEvent(event)) terminal = true;
  };

  const replayPersisted = async () => {
    const records = await listRunEvents({
      tenantId: input.tenantId,
      ontologyId: input.ontologyId,
      sessionId: input.sessionId,
      runId: input.runId,
      afterSequence: cursor,
    });
    for (const record of records) writeRecord(record);
    return records.length;
  };

  if (aiSdkProjector) streamWriter.write(encodeAiSdkUiChunk(aiSdkProjector.start()));

  const subscriber: RunSubscriber = (record) => enqueue(record);
  input.activeRun?.subscribers.add(subscriber);

  try {
    await replayPersisted();
    const pollUntil = Date.now() + 30 * 60 * 1000;
    while (!closed && !terminal) {
      if (input.activeRun && !input.activeRun.done) {
        if (!queued.length) {
          await new Promise<void>((resolve) => { resolveNext = resolve; });
        }
        const record = queued.shift();
        if (record === null) {
          await replayPersisted();
          break;
        }
        if (record) writeRecord(record);
        continue;
      }

      await replayPersisted();
      if (terminal || Date.now() >= pollUntil) break;
      await sleep(1000);
    }
    await replayPersisted();
    if (!closed && aiSdkProjector && terminal) streamWriter.write(encodeAiSdkDone());
  } finally {
    input.activeRun?.subscribers.delete(subscriber);
    streamWriter.stop();
    if (!closed && !input.res.writableEnded) input.res.end();
  }
}

function textFromAiSdkMessages(messages: unknown[] | undefined): string | null {
  if (!messages) return null;
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user" || !Array.isArray(record.parts)) continue;
    const text = record.parts
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const partRecord = part as Record<string, unknown>;
        return partRecord.type === "text" && typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

function latestUserPartsFromAiSdkMessages(messages: unknown[] | undefined, visibleText: string): Record<string, unknown>[] | undefined {
  if (!messages) return undefined;
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user" || !Array.isArray(record.parts)) continue;
    const parts: Record<string, unknown>[] = [];
    for (const part of record.parts) {
      if (!part || typeof part !== "object") continue;
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type === "text") continue;
      if (partRecord.type !== "file") continue;
      const filename = typeof partRecord.filename === "string" ? partRecord.filename : "";
      if (!filename) continue;
      const filePart: Record<string, unknown> = {
        type: "file",
        filename,
        mediaType: typeof partRecord.mediaType === "string" ? partRecord.mediaType : "application/octet-stream",
      };
      if (partRecord.providerMetadata && typeof partRecord.providerMetadata === "object") {
        filePart.providerMetadata = partRecord.providerMetadata;
      }
      parts.push(filePart);
    }
    if (!parts.length) return undefined;
    return [{ type: "text", text: visibleText }, ...parts];
  }
  return undefined;
}

function workspaceReferenceParts(paths: readonly string[]): Record<string, unknown>[] {
  const uniquePaths = Array.from(new Set(paths.map((item) => item.trim()).filter(Boolean)));
  return uniquePaths.map((filePath) => {
    const label = path.basename(filePath);
    return {
      type: "file",
      filename: label || filePath,
      mediaType: "text/markdown",
      providerMetadata: { workspace: { path: filePath, label: label || filePath } },
    };
  });
}

function normalizeWorkspaceReferencePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

async function workspaceFileExists(root: string, requestedPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(resolveWorkspaceFile(root, requestedPath));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function workspacePathExists(root: string, requestedPath: string): Promise<boolean> {
  try {
    await fs.stat(resolveWorkspaceFile(root, requestedPath));
    return true;
  } catch {
    return false;
  }
}

async function workspaceReferenceFilePaths(root: string, requestedPath: string, limit = 500): Promise<string[]> {
  const normalized = normalizeWorkspaceReferencePath(requestedPath);
  if (!normalized || normalized.includes("://") || normalized.split("/").includes("..")) return [];
  const stat = await fs.stat(resolveWorkspaceFile(root, normalized)).catch(() => null);
  if (!stat) return [];
  if (stat.isFile()) return [normalized];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  const visit = async (relativeDir: string): Promise<void> => {
    if (files.length >= limit) return;
    const entries = await fs.readdir(resolveWorkspaceFile(root, relativeDir), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= limit) return;
      const child = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  await visit(normalized);
  return files;
}

async function canonicalizeWorkspaceReferencePaths(root: string, paths: readonly string[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const item of paths) {
    const normalized = normalizeWorkspaceReferencePath(item);
    if (!normalized || normalized.includes("://") || normalized.includes("..")) continue;
    canonical.push(normalized);
  }
  return Array.from(new Set(canonical));
}

function withWorkspaceReferenceParts(parts: Record<string, unknown>[] | undefined, visibleText: string, paths: readonly string[]): Record<string, unknown>[] | undefined {
  const references = workspaceReferenceParts(paths);
  if (!references.length) return parts;
  const existingParts = parts?.length ? parts : [{ type: "text", text: visibleText }];
  const existingWorkspacePaths = new Set(existingParts
    .map((part) => {
      const metadata = part.providerMetadata;
      if (!metadata || typeof metadata !== "object") return "";
      const workspace = (metadata as Record<string, unknown>).workspace;
      if (!workspace || typeof workspace !== "object") return "";
      const workspacePath = (workspace as Record<string, unknown>).path;
      return typeof workspacePath === "string" ? workspacePath : "";
    })
    .filter(Boolean));
  return [
    ...existingParts,
    ...references.filter((part) => {
      const metadata = part.providerMetadata as { workspace?: { path?: string } } | undefined;
      const workspacePath = metadata?.workspace?.path;
      return workspacePath ? !existingWorkspacePaths.has(workspacePath) : true;
    }),
  ];
}

async function withResourceLibraryReferenceParts(input: {
  tenantId: string;
  ownerId: string;
  parts: Record<string, unknown>[] | undefined;
  visibleText: string;
  resourceIds: readonly string[];
  resourceFolderIds: readonly string[];
}): Promise<Record<string, unknown>[] | undefined> {
  const resourceIds = Array.from(new Set(input.resourceIds.map((id) => id.trim()).filter(Boolean)));
  const resourceFolderIds = Array.from(new Set(input.resourceFolderIds.map((id) => id.trim()).filter(Boolean)));
  if (!resourceIds.length && !resourceFolderIds.length) return input.parts;

  const existingParts = input.parts?.length ? input.parts : [{ type: "text", text: input.visibleText }];
  const existingResourceIds = new Set<string>();
  const existingResourceFolderIds = new Set<string>();
  for (const part of existingParts) {
    const metadata = part.providerMetadata;
    if (!metadata || typeof metadata !== "object") continue;
    const resource = (metadata as Record<string, unknown>).resource;
    if (resource && typeof resource === "object") {
      const id = (resource as Record<string, unknown>).id;
      if (typeof id === "string") existingResourceIds.add(id);
    }
    const resourceFolder = (metadata as Record<string, unknown>).resourceFolder;
    if (resourceFolder && typeof resourceFolder === "object") {
      const id = (resourceFolder as Record<string, unknown>).id;
      if (typeof id === "string") existingResourceFolderIds.add(id);
    }
  }

  const emptyLibrary: ResourceLibrarySnapshot = { resources: [], folders: [] };
  const library = await listResourceLibrary(input.tenantId, input.ownerId).catch(() => emptyLibrary);
  const resourceById = new Map(library.resources.map((resource) => [resource.id, resource]));
  const folderById = new Map(library.folders.map((folder) => [folder.id, folder]));
  const references: Record<string, unknown>[] = [];

  for (const id of resourceIds) {
    if (existingResourceIds.has(id)) continue;
    const resource = resourceById.get(id);
    const name = resource?.name ?? id;
    references.push({
      type: "file",
      mediaType: resource?.contentType ?? "text/plain",
      filename: name,
      url: `data:text/plain;charset=utf-8,${encodeURIComponent(`resource:${id}`)}`,
      providerMetadata: { resource: { id, name } },
    });
  }

  for (const id of resourceFolderIds) {
    if (existingResourceFolderIds.has(id)) continue;
    const folder = folderById.get(id);
    const name = folder?.name ?? id;
    references.push({
      type: "file",
      mediaType: "application/x-resource-folder",
      filename: name,
      url: `data:text/plain;charset=utf-8,${encodeURIComponent(`resource-folder:${id}`)}`,
      providerMetadata: { resourceFolder: { id, name } },
    });
  }

  return references.length ? [...existingParts, ...references] : input.parts;
}

function titleFromPrompt(message: string): string {
  const normalized = message
    .replace(/\bUploaded workspace files:[\s\S]*$/i, "")
    .replace(/\bReferenced workspace files:[\s\S]*$/i, "")
    .replace(/@resource-folder:[A-Za-z0-9_-]+/g, "")
    .replace(/@resource:[A-Za-z0-9_-]+/g, "")
    .replace(/^这个知识库覆盖[:：]\s*/i, "")
    .replace(/相关资料已上传[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "New ontology session";
  return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized;
}

function withWorkspaceFileContext(message: string, paths: readonly string[]): string {
  if (!paths.length) return message;
  const uniquePaths = Array.from(new Set(paths.map((filePath) => filePath.trim()).filter(Boolean)));
  if (!uniquePaths.length) return message;
  const visiblePaths = uniquePaths.slice(0, 200);
  const hiddenCount = Math.max(0, uniquePaths.length - visiblePaths.length);
  return [
    message,
    "<workspace_file_references>",
    ...visiblePaths.map((filePath) => `- ${filePath}`),
    ...(hiddenCount ? [`- ... ${hiddenCount} more files were uploaded. Inspect raw/ or the referenced archive folder when broad coverage is needed.`] : []),
    "</workspace_file_references>",
  ].join("\n");
}

async function withRepoIngestRoutingHint(root: string, message: string, paths: readonly string[]): Promise<string> {
  const hint = await buildRepoIngestRoutingHint(root, paths);
  return hint ? `${message}\n\n${hint}` : message;
}

function resourceIdsFromText(text: string | undefined): string[] {
  if (!text) return [];
  return Array.from(new Set(Array.from(text.matchAll(/@resource:([A-Za-z0-9_-]+)/g)).map((match) => match[1]).filter(Boolean)));
}

function resourceFolderIdsFromText(text: string | undefined): string[] {
  if (!text) return [];
  return Array.from(new Set(Array.from(text.matchAll(/@resource-folder:([A-Za-z0-9_-]+)/g)).map((match) => match[1]).filter(Boolean)));
}

function stripResourceReferenceTokens(text: string): string {
  return text
    .replace(/@resource-folder:[A-Za-z0-9_-]+/g, "")
    .replace(/@resource:[A-Za-z0-9_-]+/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function legacyResourceRawRoot(resourceId: string): string {
  return path.posix.join("raw", "resources", safeConvertedUploadPath(resourceId));
}

function likelyConvertedOutputName(name: string): string {
  const ext = path.extname(name);
  if (!ext || ext.toLowerCase() === ".md" || ext.toLowerCase() === ".markdown") return name;
  return `${name.slice(0, -ext.length)}.md`;
}

function resourceFolderTargetDir(object: ResourceObjectReadResult): string {
  const folderSegments = object.folderPath.flatMap((segment) => safeConvertedUploadPath(segment).split("/").filter(Boolean));
  return path.posix.join("raw", "resources", ...folderSegments);
}

async function chooseResourceTargetDir(root: string, object: ResourceObjectReadResult): Promise<string> {
  const baseDir = resourceFolderTargetDir(object);
  if (await workspaceFileExists(root, baseDir)) return legacyResourceRawRoot(object.resource.id);
  const expectedPath = path.posix.join(baseDir, safeConvertedUploadPath(likelyConvertedOutputName(object.resource.name)));
  if (!(await workspacePathExists(root, expectedPath))) return baseDir;
  return path.posix.join(baseDir, safeConvertedUploadPath(object.resource.id));
}

function preferredExistingBindings(bindings: readonly ResourceBindingRecord[], resourceId: string): ResourceBindingRecord[] {
  const legacyRawRoot = legacyResourceRawRoot(resourceId);
  return bindings
    .filter((binding) => binding.resourceId === resourceId)
    .sort((left, right) => {
      const leftLegacy = left.rawRoot === legacyRawRoot;
      const rightLegacy = right.rawRoot === legacyRawRoot;
      if (leftLegacy !== rightLegacy) return leftLegacy ? -1 : 1;
      return Date.parse(left.createdAt) - Date.parse(right.createdAt);
    });
}

async function readableBindingPaths(root: string, binding: ResourceBindingRecord): Promise<string[]> {
  const directPaths = Array.from(new Set((binding.rawPaths.length ? binding.rawPaths : [binding.rawRoot]).filter(Boolean)));
  const paths: string[] = [];
  for (const directPath of directPaths) paths.push(...await workspaceReferenceFilePaths(root, directPath));
  if (paths.length) return Array.from(new Set(paths));
  return Array.from(new Set(await workspaceReferenceFilePaths(root, binding.rawRoot)));
}

async function materializeResourceReferences(input: { tenantId: string; ownerId: string; ontologyId: string; root: string; resourceIds: readonly string[]; resourceFolderIds: readonly string[] }): Promise<string[]> {
  const paths: string[] = [];
  const seenResourceIds = new Set<string>();
  const objects: ResourceObjectReadResult[] = [];
  const repositoryReferences: PublicResourceRecord[] = [];
  let totalBytes = 0;
  const collectObject = (object: Awaited<ReturnType<typeof readResourceObject>>): void => {
    if (!object) return;
    if (seenResourceIds.has(object.resource.id)) return;
    seenResourceIds.add(object.resource.id);
    totalBytes += object.data.byteLength;
    if (totalBytes > MAX_UPLOAD_FILE_BYTES) {
      throw new UploadValidationError(`Referenced resources total ${formatUploadSize(totalBytes)}; maximum upload size is ${formatUploadSize(MAX_UPLOAD_FILE_BYTES)}.`, 413);
    }
    objects.push(object);
  };
  for (const resourceId of [...new Set(input.resourceIds)]) {
    const repositoryReference = await readBitbucketRepositoryReference(input.tenantId, input.ownerId, resourceId);
    if (repositoryReference) repositoryReferences.push(repositoryReference);
    else collectObject(await readAccessibleResourceObject(input.tenantId, input.ownerId, resourceId, new Set([input.ontologyId])));
  }
  for (const folderId of [...new Set(input.resourceFolderIds)]) {
    const folderObjects = await readResourceFolderObjects(input.tenantId, input.ownerId, folderId);
    for (const object of folderObjects) collectObject(object);
  }
  const existingBindings = await listResourceBindingsForOntology(input.tenantId, input.ownerId, input.ontologyId, [...objects.map((object) => object.resource.id), ...repositoryReferences.map((resource) => resource.id)]);
  for (const object of objects) {
    let reusedPaths: string[] = [];
    for (const binding of preferredExistingBindings(existingBindings, object.resource.id)) {
      reusedPaths = await readableBindingPaths(input.root, binding);
      if (reusedPaths.length) break;
    }
    if (!reusedPaths.length) {
      const legacyRawRoot = legacyResourceRawRoot(object.resource.id);
      const legacyPaths = await workspaceReferenceFilePaths(input.root, legacyRawRoot);
      if (legacyPaths.length) {
        await recordResourceBinding(input.tenantId, input.ownerId, {
          resourceId: object.resource.id,
          ontologyId: input.ontologyId,
          rawRoot: legacyRawRoot,
          rawPaths: legacyPaths,
        });
        reusedPaths = legacyPaths;
      }
    }
    if (reusedPaths.length) {
      paths.push(...reusedPaths);
      continue;
    }

    const targetDir = await chooseResourceTargetDir(input.root, object);
    const convertedFiles = await writeConvertedUploads(input.root, targetDir, {
      name: object.resource.name,
      data: object.data,
      contentType: object.resource.contentType,
    });
    for (const converted of convertedFiles) {
      paths.push(converted.path);
    }
    await recordResourceBinding(input.tenantId, input.ownerId, {
      resourceId: object.resource.id,
      ontologyId: input.ontologyId,
      rawRoot: targetDir,
      rawPaths: convertedFiles.map((converted) => converted.path),
    });
  }
  for (const repositoryReference of repositoryReferences) {
    let reusedPaths: string[] = [];
    for (const binding of preferredExistingBindings(existingBindings, repositoryReference.id)) {
      reusedPaths = await readableBindingPaths(input.root, binding);
      if (reusedPaths.length) break;
    }
    if (reusedPaths.length) {
      paths.push(...reusedPaths);
      continue;
    }
    if (!repositoryReference.bitbucket) continue;
    const checkout = await checkoutBitbucketRepository({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      workspaceRoot: input.root,
      referenceId: repositoryReference.id,
      workspace: repositoryReference.bitbucket.workspace,
      repoSlug: repositoryReference.bitbucket.repoSlug,
      branch: repositoryReference.bitbucket.defaultBranch,
    });
    paths.push(...checkout.rawPaths);
    await recordResourceBinding(input.tenantId, input.ownerId, { resourceId: repositoryReference.id, ontologyId: input.ontologyId, rawRoot: checkout.rawRoot, rawPaths: checkout.rawPaths });
  }
  return paths;
}

function stripRuntimeContextBlocks(message: string): string {
  return message
    .replace(/<workspace_file_references>[\s\S]*?<\/workspace_file_references>/gi, " ")
    .replace(/<resource_library_files>[\s\S]*?<\/resource_library_files>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasExplicitQueryPrefix(message: string): boolean {
  return /^\s*(?:query\s*:|\/knowledge-query\b)/i.test(message);
}

function hasExplicitOperatePrefix(message: string): boolean {
  return /^\s*operate\s*:/i.test(message);
}

function isObviousChatOrIdentityRequest(message: string): boolean {
  const compact = stripRuntimeContextBlocks(message).trim().toLowerCase();
  if (!compact) return true;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|done|cool|great)[.!?\s]*$/i.test(compact)) return true;
  if (/^(你好|您好|谢谢|多谢|好的|好|可以|收到|明白|嗯|是|不是|完成了)[。！!？?\s]*$/.test(compact)) return true;
  return /\bwho are you\b|\bwhat model\b|\bwhich model\b|\bwhat can you do\b|你是谁|你是什么模型|你能做什么|你可以做什么/.test(compact);
}

function isExplicitNonQueryWorkflowRequest(message: string): boolean {
  const compact = stripRuntimeContextBlocks(message).trim().toLowerCase();
  if (!compact) return true;
  if (/backend has already|current journey state json|do not edit files|right review panel/i.test(compact)) return true;
  if (/^\s*\/?(?:knowledge-)?(?:ingest|challenge|review)\b/i.test(compact)) return true;
  return [
    /\bingest\b|\bimport\b|\bupload\b|\bsync\s+(?:code|repo|repos)\b|\bpull\s+(?:code|repo|repos)\b/,
    /导入|摄入|上传|加入知识|同步代码|拉取代码|更新代码/,
    /\bedit\b|\bchange\b|\bupdate\b|\bdelete\b|\bremove\b|\brename\b|\bfix\b|\bcorrect\b/,
    /修改|改成|更新|删除|移除|重命名|修正|纠正|补充/,
    /\breview\s+pending\b|\bapprove\b|\bdiscard\b|\bsave\b|\bstage\b|\bstaged\b|\bsynthesis\b/,
    /审阅|审核|通过|丢弃|保存|存成|整理成待审核|待审核|暂存|合入/,
    /\bchallenge\b|\bvalidate\s+knowledge\b|\bspot\s+check\b/,
    /\bontology\b.*\b(?:distill|extract|generate|build|create)\b|\b(?:distill|extract|generate|build|create)\b.*\bontology\b/,
    /验证知识|校验知识|检查知识准确性|生成校验问题|校验问题|挑战模式|本体.*(?:生成|提取|抽取|构建|建模|蒸馏|提炼)|(?:生成|提取|抽取|构建|建模|蒸馏|提炼).*本体|本体图谱|ontology graph/,
    /^(continue|go ahead|start|confirm|next|继续|开始|确认|下一步)[.!?。！\s]*$/i,
    /创建新知识库|新建知识库|create (?:a )?new knowledge base/,
  ].some((pattern) => pattern.test(compact));
}

function shouldAddMaintenanceIntentionContext(state: JourneyState, prompt: string): boolean {
  if (state.flow !== "maintenance" || state.phase !== "ready") return false;
  if (hasExplicitQueryPrefix(prompt)) return false;
  if (hasExplicitOperatePrefix(prompt)) return false;
  if (isObviousChatOrIdentityRequest(prompt)) return false;
  if (isExplicitNonQueryWorkflowRequest(prompt)) return false;
  return true;
}

function withMaintenanceIntentionContext(prompt: string, state: JourneyState): string {
  if (!shouldAddMaintenanceIntentionContext(state, prompt)) return prompt;
  return [
    "<intent_judgment_context>",
    "Common ambiguous intent cases:",
    "Business query => read and follow skills/operate/SKILL.md: checking concrete records, external systems, APIs, databases, exact IDs, or named business instances such as orders, approvals, tickets, customers, shipments, or inventory.",
    "Knowledge query => read and follow skills/query-deepen/SKILL.md: asking business rules, business objects, concepts, definitions, workflows, SOPs, or what the knowledge says.",
    "Ontology query => read and follow skills/query-ontology/SKILL.md only when the user explicitly mentions ontology/本体 or asks about ontology objects, relations, instances, fields, or links.",
    "For other intents, follow the Intent Recognition section in CLAUDE.md.",
    "</intent_judgment_context>",
    "",
    "<user_request>",
    prompt,
    "</user_request>",
  ].join("\n");
}

function isOntologyDistillRequest(message: string): boolean {
  const compact = stripRuntimeContextBlocks(message).trim().toLowerCase();
  if (!compact) return false;
  return [
    /ontology-distill/,
    /\bontology\b.*\b(?:distill|extract|generate|build|create)\b/,
    /\b(?:distill|extract|generate|build|create)\b.*\bontology\b/,
    /本体.*(?:生成|提取|抽取|构建|建模|蒸馏|提炼)/,
    /(?:生成|提取|抽取|构建|建模|蒸馏|提炼).*本体/,
    /本体图谱|ontology graph/,
  ].some((pattern) => pattern.test(compact));
}

async function withReviewLockContext(root: string, prompt: string): Promise<string> {
  const reviewReadyDraftIds = await listReviewReadyDraftIds(root).catch(() => []);
  if (!reviewReadyDraftIds.length) return prompt;
  return [
    "Authoritative workspace rule:",
    "The workspace is in Review Lock because these review-ready drafts have meta.json:",
    ...reviewReadyDraftIds.map((draftId) => `- ${draftId}`),
    "",
    "While Review Lock is active:",
    "- Do not create a new pending_review/drafts/<draft-id>.",
    "- Do not create or update ingest-plans/<plan-id>.json for a new ingest.",
    "- Do not start single-ingest, batch-ingest, coding-repo-ingest, or knowledge-edit workflows that create a new draft.",
    "- Do not write new ingest or formal-knowledge-edit content into an existing Review draft.",
    "- If the user asks to revise an existing Review draft, use review-draft-edit and edit only that existing draft.",
    "- If the user asks to import new knowledge or edit formal knowledge, stop and tell the user to approve or discard all pending Review drafts first.",
    "",
    "Current prompt:",
    prompt,
  ].join("\n");
}

function shouldAutoTitle(preview: string): boolean {
  return preview === "New ontology session" || preview === "新知识构建" || preview === "知识库构建中" || preview.startsWith("Created ");
}

async function enabledComposioConnections(tenantId: string, userId: string, disabledConnectors: string[] | undefined) {
  if (!isComposioConfigured()) return [];
  const disabled = new Set((disabledConnectors ?? []).map((item) => item.toLowerCase()));
  return (await listComposioConnections(tenantId, userId)).filter((connection) => !disabled.has(connection.app.toLowerCase()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toolNameFromEvent(event: unknown): string | null {
  if (!isRecord(event) || event.type !== "tool") return null;
  return typeof event.tool === "string" && event.tool.trim() ? event.tool : "tool";
}

function toolPartFromEvent(record: OntologyRunEventRecord, index: number): Record<string, unknown> | null {
  const toolName = toolNameFromEvent(record.event);
  if (!toolName || !isRecord(record.event)) return null;
  return {
    type: `tool-${toolName}`,
    toolCallId: `${record.createdAt}-${index}`,
    state: "input-available",
    input: record.event.input ?? {},
    providerExecuted: true,
  };
}

class TaggedAnswerExtractor {
  private buffer = "";

  push(delta: string): OntologyStreamEvent[] {
    this.buffer += delta;
    return this.drain(false);
  }

  flush(): OntologyStreamEvent[] {
    return this.drain(true);
  }

  private drain(flushAll: boolean): OntologyStreamEvent[] {
    const events: OntologyStreamEvent[] = [];
    const tags = [
      { tag: "working_answer", tool: "intermediate" },
      { tag: "deepening_queries", tool: "deepening" },
    ] as const;

    while (this.buffer) {
      let next = -1;
      let matched: (typeof tags)[number] | null = null;
      for (const candidate of tags) {
        const idx = this.buffer.indexOf(`<${candidate.tag}>`);
        if (idx !== -1 && (next === -1 || idx < next)) {
          next = idx;
          matched = candidate;
        }
      }

      if (next === -1 || !matched) {
        const keep = flushAll ? 0 : possibleTagPrefixLength(this.buffer, tags.map((item) => `<${item.tag}>`));
        const safeText = keep ? this.buffer.slice(0, -keep) : this.buffer;
        if (safeText) {
          events.push({ type: "text-delta", delta: safeText });
          this.buffer = keep ? this.buffer.slice(-keep) : "";
        }
        if (flushAll && this.buffer) {
          events.push({ type: "text-delta", delta: this.buffer });
          this.buffer = "";
        }
        break;
      }

      if (next > 0) {
        events.push({ type: "text-delta", delta: this.buffer.slice(0, next) });
        this.buffer = this.buffer.slice(next);
      }

      const open = `<${matched.tag}>`;
      const close = `</${matched.tag}>`;
      const closeIdx = this.buffer.indexOf(close, open.length);
      if (closeIdx === -1) {
        if (flushAll) {
          events.push({ type: "text-delta", delta: this.buffer });
          this.buffer = "";
        }
        break;
      }

      const content = this.buffer.slice(open.length, closeIdx).trim();
      this.buffer = this.buffer.slice(closeIdx + close.length);
      if (content) events.push({ type: "tool", tool: matched.tool, input: { content } });
    }

    return events;
  }
}

function possibleTagPrefixLength(text: string, openings: readonly string[]) {
  const max = Math.min(text.length, Math.max(...openings.map((opening) => opening.length - 1)));
  for (let len = max; len > 0; len -= 1) {
    const suffix = text.slice(-len);
    if (openings.some((opening) => opening.startsWith(suffix))) return len;
  }
  return 0;
}

function runIdFromRunMessageId(messageId: string | undefined): string | null {
  const suffix = ":message";
  return messageId?.endsWith(suffix) ? messageId.slice(0, -suffix.length) : null;
}

function withPersistedToolParts(messages: OntologyMessage[], events: OntologyRunEventRecord[]): OntologyMessage[] {
  let eventStart = 0;
  return messages.map((message, messageIndex) => {
    if (message.role === "user" || message.role === "system") eventStart = Date.parse(message.createdAt ?? "") || 0;
    if (message.role !== "agent" && message.role !== "assistant") return message;

    const messageRunId = runIdFromRunMessageId(message.id);
    const eventEnd = Date.parse(message.createdAt ?? "") || Number.MAX_SAFE_INTEGER;
    const toolParts = events
      .filter((event, index) => {
        const createdAt = Date.parse(event.createdAt);
        const inWindow = createdAt >= eventStart && createdAt <= eventEnd;
        const belongsToMessage = messageRunId ? event.runId === messageRunId : inWindow;
        return belongsToMessage && toolPartFromEvent(event, index);
      })
      .map((event, index) => toolPartFromEvent(event, messageIndex + index))
      .filter((part): part is Record<string, unknown> => Boolean(part));

    if (!toolParts.length) return message;
    return { ...message, parts: [...toolParts, { type: "text", text: message.content }] };
  });
}

interface JourneyToolProjection {
  state: JourneyState | null;
  blockedMessage?: string;
  bootstrapToIngestHandoff?: boolean;
}

function workflowPhaseFromJourneyToolUpdate(update: NonNullable<ReturnType<typeof parseBootstrapToolUpdate>>, state?: JourneyState): WorkflowLockPhase | null {
  if (update.build_phase === "ingest" || update.claude_workflow === "ingest") return "ingest";
  if (update.build_phase === "verify" || update.claude_workflow === "verify") return "verify";
  if (update.build_phase === "review" || update.claude_workflow === "review" || state?.phase === "review") return "review";
  return null;
}

function isBootstrapToIngestHandoff(
  current: JourneyState,
  next: JourneyState,
  update: NonNullable<ReturnType<typeof parseBootstrapToolUpdate>>,
): boolean {
  const result = next.bootstrap.result;
  const workflowAllowsBootstrapHandoff = !update.claude_workflow ||
    update.claude_workflow === "bootstrap" ||
    update.claude_workflow === "ingest";
  return current.flow === "build" &&
    current.phase === "bootstrap" &&
    update.status === "done" &&
    workflowAllowsBootstrapHandoff &&
    (update.build_phase === "ingest" || next.phase === "ingest") &&
    next.flow === "build" &&
    next.phase === "ingest" &&
    next.bootstrap.status === "done" &&
    next.bootstrap.awaitingUser === false &&
    Boolean(result?.name && result.description && result.emoji && result.knowledge_subdirs?.length);
}

/**
 * Records the assistant side of a turn that ended without a normal reply — either an error or a
 * cancellation. Without this the run terminates cleanly but leaves no trace in history, so the UI
 * shows the user's message with nothing after it. Best effort by design: a failure here must not
 * mask the original outcome.
 */
async function persistUnansweredTurn(input: {
  tenantId: string;
  ownerId: string;
  ontologyId: string;
  sessionId: string;
  runId: string;
  text: string;
  claudeSessionId: string;
  previousClaudeSessionId: string;
  notice: string;
}): Promise<OntologyMessage | null> {
  // Session continuity and transcript durability are independent best-effort writes. A failure
  // updating the SDK session id must not leave the user's turn without an assistant message.
  if (input.claudeSessionId && input.claudeSessionId !== input.previousClaudeSessionId) {
    await updateClaudeSessionId(
      { tenantId: input.tenantId, ontologyId: input.ontologyId, sessionId: input.sessionId },
      input.claudeSessionId,
    ).catch((err) => {
      console.error("[chat] failed to persist Claude session for unanswered turn", {
        runId: input.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  try {
    return await appendMessage(
      {
        tenantId: input.tenantId,
        ownerId: input.ownerId,
        ontologyId: input.ontologyId,
        sessionId: input.sessionId,
      },
      {
        id: ontologyRunMessageId(input.runId),
        role: "agent",
        content: `${input.text}${input.notice}`.trim(),
      },
    );
  } catch (err) {
    console.error("[chat] failed to persist unanswered turn", { runId: input.runId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function projectJourneyToolEvent(
  cwd: string,
  event: OntologyStreamEvent,
  owner: { ontologyId: string; sessionId: string; runId: string; locale: UiLocale },
): Promise<JourneyToolProjection | null> {
  if (event.type !== "tool" || (!event.tool.includes("knowledge_update_journey") && !event.tool.includes("ontology_update_journey"))) return null;
  const update = parseBootstrapToolUpdate(event.input);
  if (!update) return null;
  const requestedLockPhase = workflowPhaseFromJourneyToolUpdate(update);
  if (requestedLockPhase) {
    const result = await acquireWorkflowLock(cwd, {
      ontologyId: owner.ontologyId,
      sessionId: owner.sessionId,
      runId: owner.runId,
      workflow: "ingest",
      phase: requestedLockPhase,
    });
    if (!result.acquired) {
      return {
        state: null,
        blockedMessage: formatWorkflowLocked(owner.locale, result.lock?.sessionId),
      };
    }
  }
  const current = update.build_phase === "ingest" || update.claude_workflow === "ingest"
    ? await refreshRawSourcesInJourney(cwd)
    : await readJourneyState(cwd);
  const requestsWorkflowPhase = Boolean(update.build_phase && update.build_phase !== "bootstrap" && update.build_phase !== "ready") || update.claude_workflow === "ingest" || update.claude_workflow === "verify" || update.claude_workflow === "review";
  // Once bootstrap is complete and ready, do not allow tool calls to regress back into Bootstrap.
  if (current.phase === "ready" && current.bootstrap.status === "done" && !requestsWorkflowPhase) return null;
  const next = mergeBootstrapToolState(current, update);
  const requestsReview = update.build_phase === "review" || update.claude_workflow === "review" || next.phase === "review";
  if (requestsReview) {
    const gate = await readReviewGate(cwd);
    if (!gate.allowed) return { state: await readJourneyState(cwd) };
  }
  const bootstrapToIngestHandoff = isBootstrapToIngestHandoff(current, next, update);
  const lockPhase = workflowPhaseFromJourneyToolUpdate(update, next);
  if (lockPhase && !requestedLockPhase) {
    const result = await acquireWorkflowLock(cwd, {
      ontologyId: owner.ontologyId,
      sessionId: owner.sessionId,
      runId: owner.runId,
      workflow: "ingest",
      phase: lockPhase,
    });
    if (!result.acquired) {
      return {
        state: null,
        blockedMessage: formatWorkflowLocked(owner.locale, result.lock?.sessionId),
      };
    }
  }
  await writeJourneyState(cwd, next);
  return { state: await readJourneyState(cwd), bootstrapToIngestHandoff };
}

function shouldSyncProjectIdentity(state: JourneyState): boolean {
  const status = state.bootstrap.status;
  return Boolean(
    state.bootstrap.result?.name &&
    (status === "hydrating" || status === "done")
  );
}

function textDeltaWithParagraphBoundary(existingText: string, message: string): string {
  const prefix = existingText.trim() ? existingText.endsWith("\n") ? "" : "\n\n" : "";
  return `${prefix}${message}\n\n`;
}

const INITIAL_BOOTSTRAP_INGEST_PROMPT = [
  "Bootstrap has been confirmed and bootstrap-result.json has been written.",
  "Now execute the Ingest Workflow for the uploaded raw sources under raw/.",
  "Route repo-shaped raw sources to skills/coding-repo-ingest/SKILL.md. For non-repo sources, count files recursively and route to skills/single-ingest/SKILL.md or skills/batch-ingest/SKILL.md based on file count.",
  "Do not ask the user for another confirmation.",
  "Do not report internal setup, template hydration, or write-permission status to the user.",
  "If you encounter issues, try to resolve them yourself.",
].join("\n");

async function executeOntologyChatRun(input: {
  runId: string;
  tenantId: string;
  ownerId: string;
  workspaceTenantId: string;
  workspaceOwnerId: string;
  userId: string;
  userRequest: string;
  project: OntologyProject;
  session: OntologySession;
  cwd: string;
  promptMessage: string;
  locale: UiLocale;
  disabledConnectors?: string[];
  readOnly: boolean;
  actorDisplayName: string;
  authorizationRole: KnowledgeBaseAccess["role"];
  authorizationSource: KnowledgeBaseAccess["source"];
}, emitRunEvent: (event: OntologyStreamEvent) => Promise<OntologyRunEventRecord | null>, signal: AbortSignal): Promise<ChatRunResult> {
  const session = input.session;
  if (!session) return { events: [], journeyState: null, error: "Session not found" };

  const events: OntologyStreamEvent[] = [];
  const textParts: string[] = [];
  let claudeSessionId = session.claudeSessionId ?? "";
  let journeyState: JourneyState | null = null;
  const runStartedAt = Date.now();
  let firstTextDeltaAt = 0;
  const workflowStatusAnnouncer = new WorkflowStatusAnnouncer(input.locale);
  const claudeTextSuppressor = new ClaudeWorkflowTextSuppressor();
  const runTrace = createWorkspaceRunTrace();
  const pendingDraftIdsBefore = new Set((await listPendingReviewDrafts(input.cwd).catch(() => [])).map((draft) => draft.draftId));
  let workflowLockConflictAnnounced = false;

  // Cancelling is the escape hatch users reach for when a run stops making progress, so it must
  // close the transcript the same way an error does. Every `cancelled` exit routes through here.
  const cancelledResult = async (): Promise<ChatRunResult> => {
    const cancelled = await persistUnansweredTurn({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      ontologyId: input.project.id,
      sessionId: session.id,
      runId: input.runId,
      text: textParts.join(""),
      claudeSessionId,
      previousClaudeSessionId: session.claudeSessionId ?? "",
      notice: agentRunCancelledMessage(input.locale),
    });
    // emit() drops non-error events once the signal is aborted, so record it locally instead.
    if (cancelled) events.push({ type: "message", message: cancelled });
    return { message: cancelled ?? undefined, events, journeyState, claudeSessionId, cancelled: true };
  };

  const emitWorkflowStatusMessages = async (state: JourneyState) => {
    for (const message of workflowStatusAnnouncer.ingestBatchMessages(state)) {
      await emit({ type: "text-delta", delta: textDeltaWithParagraphBoundary(textParts.join(""), message) }, "backend");
    }
    const reviewReady = workflowStatusAnnouncer.reviewReadyRequest(state);
    if (!reviewReady) return;
    const fileCount = await reviewReadyFileCount(input.cwd, state, reviewReady.draftId);
    await emit({ type: "text-delta", delta: textDeltaWithParagraphBoundary(textParts.join(""), formatReviewReady(input.locale, fileCount)) }, "backend");
    workflowStatusAnnouncer.markReviewReadyAnnounced(reviewReady.key);
  };

  const emit = async (event: OntologyStreamEvent, source: "claude" | "backend" = "claude") => {
    if (signal.aborted && event.type !== "error") return;
    if (source === "claude" && event.type === "tool") claudeTextSuppressor.observeTool(event);
    if (event.type === "text-delta" && source === "claude" && claudeTextSuppressor.shouldSuppressClaudeText()) return;
    if (event.type === "text-delta" && !firstTextDeltaAt) {
      firstTextDeltaAt = Date.now();
      console.log(`[chat/timing] first-text-delta runId=${input.runId} ms=${firstTextDeltaAt - runStartedAt}`);
    }
    events.push(event);
    if (event.type === "text-delta") textParts.push(event.delta);
    if (event.type === "finish" && event.claudeSessionId) claudeSessionId = event.claudeSessionId;
    if (event.type === "journey-state") {
      journeyState = event.state;
      claudeTextSuppressor.observeJourney(event.state);
    }
    await emitRunEvent(event);
    if (event.type === "journey-state") await emitWorkflowStatusMessages(event.state);
  };

  const runAgentPrompt = async (agentPrompt: string, composioConnections: Awaited<ReturnType<typeof enabledComposioConnections>>, options: { suppressClaudeText?: boolean; freshRunTrace?: boolean } = {}) => {
    if (options.suppressClaudeText) claudeTextSuppressor.enable();
    const taggedAnswerExtractor = new TaggedAnswerExtractor();
    const guardedPrompt = await withReviewLockContext(input.cwd, agentPrompt);
    const promptRunTrace = options.freshRunTrace ? createWorkspaceRunTrace() : runTrace;
    for await (const event of streamOntologyAgent({
      prompt: guardedPrompt,
      cwd: input.cwd,
      resume: claudeSessionId || session.claudeSessionId,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      userId: input.userId,
      ontologyId: input.project.id,
      appSessionId: session.id,
      runId: input.runId,
      userRequest: input.userRequest,
      locale: input.locale,
      composioConnections,
      runTrace: promptRunTrace,
      readOnly: input.readOnly,
    }, { signal })) {
      const projectedEvents = event.type === "text-delta"
        ? taggedAnswerExtractor.push(event.delta)
        : event.type === "finish"
          ? [...taggedAnswerExtractor.flush(), event]
          : [event];

      for (const projectedEvent of projectedEvents) {
        if (projectedEvent.type === "finish") {
          if (projectedEvent.claudeSessionId) claudeSessionId = projectedEvent.claudeSessionId;
          continue;
        }
        await emit(projectedEvent);
        const toolProjection = await projectJourneyToolEvent(input.cwd, projectedEvent, {
          ontologyId: input.project.id,
          sessionId: session.id,
          runId: input.runId,
          locale: input.locale,
        });
        if (toolProjection?.blockedMessage && !workflowLockConflictAnnounced) {
          workflowLockConflictAnnounced = true;
          await emit({ type: "text-delta", delta: textDeltaWithParagraphBoundary(textParts.join(""), toolProjection.blockedMessage) }, "backend");
        }
        const toolState = toolProjection?.state ?? null;
        if (toolState) {
          await emit({ type: "journey-state", state: toolState });
          if (shouldSyncProjectIdentity(toolState)) {
            const result = toolState.bootstrap.result!;
            const pageCount = await countMarkdownFiles(input.cwd);
            await updateProject(input.workspaceTenantId, input.workspaceOwnerId, input.project.id, {
              name: result.name,
              description: result.description,
              emoji: result.emoji,
              pageCount,
              status: "bootstrapping",
            });
            if (shouldAutoTitle(session.preview)) {
              await updateSession(input.tenantId, input.ownerId, input.project.id, session.id, { preview: result.name });
            }
            await emit({ type: "tree-updated", ontologyId: input.project.id });
          }
        }
      }
    }
  };

  try {
    let initialBootstrapState = await bootstrapAwareInitialJourneyState(input.cwd);
    workflowStatusAnnouncer.seed(initialBootstrapState);
    claudeTextSuppressor.seed(initialBootstrapState);
    if (initialBootstrapState.phase === "bootstrap") await emit({ type: "journey-state", state: initialBootstrapState });

    if (initialBootstrapState.phase === "bootstrap") {
      const status = initialBootstrapState.bootstrap.status;
      if (status === "materials_collection" || status === "materials_ready") {
        const refreshed = await refreshRawSourcesInJourney(input.cwd);
        initialBootstrapState = refreshed;
        await emit({ type: "journey-state", state: refreshed });
      }
    }

    const composioConnections = await enabledComposioConnections(input.tenantId, input.userId, input.disabledConnectors);
    {
      const hasExplicitIntentPrefix = hasExplicitQueryPrefix(input.promptMessage) || hasExplicitOperatePrefix(input.promptMessage);
      const routedPrompt = !hasExplicitIntentPrefix && isOntologyDistillRequest(input.promptMessage)
        ? input.promptMessage
        : withMaintenanceIntentionContext(input.promptMessage, initialBootstrapState);
      await runAgentPrompt(routedPrompt, composioConnections);
      const bootstrapProjection = await projectBootstrapJourney(input.cwd, textParts.join(""));
      if (bootstrapProjection) {
        const currentRank = journeyPhaseRank(journeyState);
        const projectionRank = journeyPhaseRank(bootstrapProjection.state);
        if (projectionRank >= currentRank) {
          if (bootstrapProjection.hydratingState) await emit({ type: "journey-state", state: bootstrapProjection.hydratingState });
          await emit({ type: "journey-state", state: bootstrapProjection.state });
        }
        if (bootstrapProjection.result) {
          const pageCount = await countMarkdownFiles(input.cwd);
          await updateProject(input.workspaceTenantId, input.workspaceOwnerId, input.project.id, {
            name: bootstrapProjection.result.name,
            description: bootstrapProjection.result.description,
            emoji: bootstrapProjection.result.emoji,
            pageCount,
            status: "bootstrapping",
          });
          if (shouldAutoTitle(session.preview)) {
            await updateSession(input.tenantId, input.ownerId, input.project.id, session.id, { preview: bootstrapProjection.result.name });
          }
          await emit({ type: "tree-updated", ontologyId: input.project.id });
        }
      }
      if (!signal.aborted) {
        await continueInitialBootstrapBuild({
          root: input.cwd,
          owner: {
            ontologyId: input.project.id,
            sessionId: session.id,
            runId: input.runId,
          },
          runInitialIngest: async () => {
            await emit({ type: "tree-updated", ontologyId: input.project.id });
            await runAgentPrompt(INITIAL_BOOTSTRAP_INGEST_PROMPT, composioConnections, { suppressClaudeText: true });
          },
        });
      }
      for (let i = 0; i < MAX_WORKFLOW_CONTINUATIONS && !signal.aborted; i += 1) {
        const continuation = await readWorkflowContinuation(input.cwd);
        if (!continuation) break;
        await runAgentPrompt(continuation.prompt, composioConnections, { suppressClaudeText: true });
        const next = await readWorkflowContinuation(input.cwd);
        if (!next) break;
      }
      if (!signal.aborted && await readWorkflowContinuation(input.cwd)) {
        await emit({ type: "text-delta", delta: workflowContinuationLimitMessage(input.locale) }, "backend");
      }
    }
    if (signal.aborted) return await cancelledResult();
    await emit({ type: "finish", sessionId: session.id, claudeSessionId: claudeSessionId || session.claudeSessionId });
  } catch (err) {
    if (signal.aborted || isAbortLikeError(err)) return await cancelledResult();
    const message = err instanceof Error ? err.message : String(err);
    console.error("[chat] agent run failed", { runId: input.runId, error: message, elapsedMs: Date.now() - runStartedAt });
    const errorEvent: OntologyStreamEvent = { type: "error", error: message };
    // Close the turn in durable history. Returning here without persisting leaves the user's
    // message in the transcript with no reply at all, which reads as "the chat is stuck" even
    // though the run terminated cleanly. Persist before the terminal event so the client's error
    // callback cannot refresh history before the failed assistant message exists.
    const failure = await persistUnansweredTurn({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      ontologyId: input.project.id,
      sessionId: session.id,
      runId: input.runId,
      text: textParts.join(""),
      claudeSessionId,
      previousClaudeSessionId: session.claudeSessionId ?? "",
      notice: agentRunFailedMessage(input.locale, message),
    });
    await emit(errorEvent).catch((emitError) => {
      console.error("[chat] failed to emit agent run error", {
        runId: input.runId,
        error: message,
        emitError: emitError instanceof Error ? emitError.message : String(emitError),
      });
    });
    // emit() records the event locally before writing it. Only add the fallback if that behavior
    // changes, otherwise a run-event store failure would duplicate the message in this result.
    if (failure) {
      const failureEvent: OntologyStreamEvent = { type: "message", message: failure };
      await emit(failureEvent).catch(() => {
        if (!events.includes(failureEvent)) events.push(failureEvent);
      });
    }
    return { message: failure ?? undefined, events, journeyState, claudeSessionId, error: errorEvent.error };
  }

  if (signal.aborted) return await cancelledResult();
  if (!input.readOnly) {
    const newDrafts = (await listPendingReviewDrafts(input.cwd).catch(() => [])).filter((draft) => !pendingDraftIdsBefore.has(draft.draftId));
    for (const draft of newDrafts) {
      const detail = await readReviewDraftDetail(input.cwd, draft.draftId).catch(() => null);
      const paths = detail?.files.map((file) => file.path) ?? [];
      const action = draft.operation.toLocaleLowerCase().includes("ingest") ? "ingest_submitted" : "pending_write_created";
      const timestamp = new Date().toISOString();
      const entry = `\n## [${timestamp}] ${action} | ${draft.description || draft.operation}\n\n- actorUserId: \`${input.ownerId}\`\n- actorDisplayName: ${input.actorDisplayName.replace(/\r?\n/g, " ")}\n- actorTenantId: \`${input.tenantId}\`\n- paths: ${paths.length ? paths.map((value) => `\`${value}\``).join(", ") : "(none)"}\n`;
      await fs.appendFile(path.join(input.cwd, "pending_review", "drafts", draft.draftId, "knowledge", "log.md"), entry, "utf8").catch(() => undefined);
      await recordKnowledgeBaseChange({
        ontologyId: input.project.id,
        workspaceTenantId: input.workspaceTenantId,
        workspaceOwnerId: input.workspaceOwnerId,
        actorTenantId: input.tenantId,
        actorUserId: input.ownerId,
        actorDisplayName: input.actorDisplayName,
        protocol: "workbench",
        authorizationRole: input.authorizationRole,
        authorizationSource: input.authorizationSource,
        action,
        outcome: "applied",
        details: { draftId: draft.draftId, summary: draft.description, paths },
      });
    }
  }
  await updateClaudeSessionId({ tenantId: input.tenantId, ontologyId: input.project.id, sessionId: session.id }, claudeSessionId);
  const text = textParts.join("") || "Done.";
  const assistant = await appendMessage(
    {
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      ontologyId: input.project.id,
      sessionId: session.id,
    },
    { id: ontologyRunMessageId(input.runId), role: "agent", content: text },
  );
  const messageEvent: OntologyStreamEvent = { type: "message", message: assistant };
  await emit(messageEvent);
  console.log(`[chat/timing] turn-complete runId=${input.runId} total_ms=${Date.now() - runStartedAt} text_chars=${text.length}`);
  return { message: assistant, events, journeyState, claudeSessionId };
}

async function actorSession(
  ctx: Awaited<ReturnType<typeof requireTenantContext>>,
  ontologyId: string,
  sessionId: string,
): Promise<{ access: KnowledgeBaseAccess; session: OntologySession } | null> {
  const access = await resolveKnowledgeBaseAccess(ctx, ontologyId);
  if (!access) return null;
  const session = await getSession(ctx.tenantId, ctx.ownerId, access.project.id, sessionId, access.project);
  return session ? { access, session } : null;
}

async function auditConversationLink(
  access: KnowledgeBaseAccess,
  input: { actorTenantId: string; actorUserId: string; actorDisplayName: string; action: string; details?: Record<string, unknown> },
): Promise<void> {
  await recordKnowledgeBaseChange({
    ontologyId: access.project.id,
    workspaceTenantId: access.workspaceTenantId,
    workspaceOwnerId: access.workspaceOwnerId,
    actorTenantId: input.actorTenantId,
    actorUserId: input.actorUserId,
    actorDisplayName: input.actorDisplayName,
    protocol: "workbench",
    authorizationRole: access.role,
    authorizationSource: access.source,
    action: input.action,
    outcome: "applied",
    details: input.details,
  });
}

function sanitizeSnapshotContent(content: string): string {
  return content
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label ?? target.split("/").pop() ?? "reference")
    .replace(/\bfile:\/\/\S+/gi, "")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s`]+/g, "[path omitted]")
    .replace(/(^|[\s(`])\/(?!\/)[^\s`)\]]+/gm, "$1[path omitted]")
    .replace(/(^|[\s(`])\.\.?[\\/][^\s`)\]]+/gm, "$1[path omitted]")
    .replace(/\b(?:knowledge|wiki|raw|drafts|\.runtime)[\\/][^\s`)\]]+/gi, "[path omitted]")
    .trim();
}

chatRouter.get("/public/conversations/:token", asyncRoute(async (req, res) => {
  const snapshot = await getConversationSnapshotByToken(String(req.params.token));
  if (!snapshot) return void res.status(404).json({ error: "Shared conversation not found" });
  if (snapshot.revokedAt) return void res.status(410).json({ error: "Shared conversation is no longer available" });
  const sourceProject = await getProjectById(snapshot.sourceOntologyId);
  await recordKnowledgeBaseChange({
    ontologyId: snapshot.sourceOntologyId,
    workspaceTenantId: sourceProject?.tenantId ?? snapshot.ownerTenantId,
    workspaceOwnerId: sourceProject?.ownerId ?? snapshot.ownerUserId,
    actorTenantId: "anonymous",
    actorUserId: "anonymous",
    actorDisplayName: "Anonymous link visitor",
    protocol: "workbench",
    authorizationRole: "viewer",
    authorizationSource: "member",
    action: "conversation_link_opened",
    outcome: "applied",
    details: { snapshotId: snapshot.id },
  }).catch(() => undefined);
  res.json({ data: { id: snapshot.id, token: snapshot.token, knowledgeBaseId: snapshot.sourceOntologyId, messages: snapshot.messages, createdAt: snapshot.createdAt } });
}));


chatRouter.get("/:ontologyId/sessions", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const ontologyId = String(req.params.ontologyId);
  const access = await resolveKnowledgeBaseAccess(ctx, ontologyId);
  if (access) {
    // 正常路径：知识库未删除
    return void res.json({ data: await listSessions(ctx.tenantId, ctx.ownerId, access.project.id, access.project) });
  }
  // 已删除路径：检查用户是否有 keepConversations=true 的 tombstone 偏好
  const pref = await getTombstonePreference(ontologyId, ctx.tenantId, ctx.ownerId);
  if (!pref?.keepConversations) return void res.status(404).json({ error: "Ontology not found" });
  // 用 getProjectById 获取项目（不依赖 owner_id），传给 listSessions 避免内部 getProject 查不到
  const deletedProject = await getProjectById(ontologyId);
  if (!deletedProject) return void res.status(404).json({ error: "Ontology not found" });
  const sessions = await listSessions(ctx.tenantId, ctx.ownerId, ontologyId, deletedProject);
  return void res.json({ data: sessions });
}));

chatRouter.post("/:ontologyId/sessions", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access) return void res.status(404).json({ error: "Ontology not found" });
  res.status(201).json({ data: await createSession(ctx.tenantId, ctx.ownerId, access.project.id, "New ontology session", "workbench", access.project) });
}));

chatRouter.patch("/:ontologyId/sessions/:sessionId", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  const session = access ? await updateSession(ctx.tenantId, ctx.ownerId, access.project.id, String(req.params.sessionId), sessionPatchSchema.parse(req.body ?? {}), access.project) : null;
  if (!session) return void res.status(404).json({ error: "Session not found" });
  res.json({ data: session });
}));

chatRouter.delete("/:ontologyId/sessions/:sessionId", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const found = await actorSession(ctx, String(req.params.ontologyId), String(req.params.sessionId));
  if (!found) return void res.status(404).json({ error: "Session not found" });
  const { access, session } = found;
  const key = activeChatRunKey({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: access.project.id, sessionId: session.id });
  await cancelActiveChatRun(key);
  const deleted = await deleteSession(ctx.tenantId, ctx.ownerId, access.project.id, session.id);
  if (deleted) await deleteClaudeSessionStoreForAppSession({ tenantId: ctx.tenantId, ontologyId: access.project.id, appSessionId: session.id });
  res.status(deleted ? 204 : 404).send(deleted ? undefined : { error: "Session not found" });
}));

chatRouter.get("/:ontologyId/sessions/:sessionId/messages", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const ontologyId = String(req.params.ontologyId);
  const sessionId = String(req.params.sessionId);
  const found = await actorSession(ctx, ontologyId, sessionId);
  if (found) {
    // 正常路径：知识库未删除
    const messageCtx = { tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: found.access.project.id, sessionId: found.session.id };
    const messages = await listMessages(messageCtx);
    const events = await listRunEvents(messageCtx);
    return void res.json({ data: withPersistedToolParts(messages, events) });
  }
  // 只读路径：知识库已删除但 keepConversations=true，允许读取消息历史
  const pref = await getTombstonePreference(ontologyId, ctx.tenantId, ctx.ownerId);
  if (!pref?.keepConversations) return void res.status(404).json({ error: "Session not found" });
  const deletedProject = await getProjectById(ontologyId);
  if (!deletedProject) return void res.status(404).json({ error: "Session not found" });
  const session = await getSession(ctx.tenantId, ctx.ownerId, ontologyId, sessionId, deletedProject);
  if (!session) return void res.status(404).json({ error: "Session not found" });
  const messageCtx = { tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId, sessionId };
  const messages = await listMessages(messageCtx);
  const events = await listRunEvents(messageCtx);
  return void res.json({ data: withPersistedToolParts(messages, events) });
}));

chatRouter.post("/:ontologyId/sessions/:sessionId/share", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const ontologyId = String(req.params.ontologyId);
  const sessionId = String(req.params.sessionId);

  const found = await actorSession(ctx, ontologyId, sessionId);
  if (found) {
    // 正常路径：知识库未删除
    const { access, session } = found;
    const messages = await listMessages({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: access.project.id, sessionId: session.id });
    const snapshot = await createOrGetConversationSnapshot({
      token: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      sourceSessionId: session.id,
      sourceOntologyId: access.project.id,
      ownerTenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      messages: messages
        .filter((message) => message.role === "user" || message.role === "agent")
        .map((message) => ({ role: message.role === "user" ? "user" as const : "assistant" as const, content: sanitizeSnapshotContent(message.content), createdAt: message.createdAt })),
    });
    await auditConversationLink(access, { actorTenantId: ctx.tenantId, actorUserId: ctx.ownerId, actorDisplayName: ctx.user.displayName, action: "conversation_link_published", details: { snapshotId: snapshot.id, sessionId: session.id } });
    return void res.status(201).json({ data: { id: snapshot.id, token: snapshot.token, messages: snapshot.messages, createdAt: snapshot.createdAt } });
  }

  // 已删除路径：知识库已删除但 keepConversations=true，仍允许分享
  const pref = await getTombstonePreference(ontologyId, ctx.tenantId, ctx.ownerId);
  if (!pref?.keepConversations) return void res.status(404).json({ error: "Session not found" });
  const deletedProject = await getProjectById(ontologyId);
  if (!deletedProject) return void res.status(404).json({ error: "Session not found" });
  const session = await getSession(ctx.tenantId, ctx.ownerId, ontologyId, sessionId, deletedProject);
  if (!session) return void res.status(404).json({ error: "Session not found" });
  const messages = await listMessages({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId, sessionId });
  const snapshot = await createOrGetConversationSnapshot({
    token: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
    sourceSessionId: session.id,
    sourceOntologyId: ontologyId,
    ownerTenantId: ctx.tenantId,
    ownerUserId: ctx.ownerId,
    messages: messages
      .filter((message) => message.role === "user" || message.role === "agent")
      .map((message) => ({ role: message.role === "user" ? "user" as const : "assistant" as const, content: sanitizeSnapshotContent(message.content), createdAt: message.createdAt })),
  });
  await recordKnowledgeBaseChange({
    ontologyId,
    workspaceTenantId: deletedProject.tenantId,
    workspaceOwnerId: deletedProject.ownerId,
    actorTenantId: ctx.tenantId,
    actorUserId: ctx.ownerId,
    actorDisplayName: ctx.user.displayName,
    protocol: "workbench",
    authorizationRole: "owner",
    authorizationSource: "owner",
    action: "conversation_link_published",
    outcome: "applied",
    details: { snapshotId: snapshot.id, sessionId: session.id },
  }).catch(() => undefined);
  return void res.status(201).json({ data: { id: snapshot.id, token: snapshot.token, messages: snapshot.messages, createdAt: snapshot.createdAt } });
}));

chatRouter.post("/:ontologyId/sessions/:sessionId/cancel", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const found = await actorSession(ctx, String(req.params.ontologyId), String(req.params.sessionId));
  if (!found) return void res.status(404).json({ error: "Ontology or session not found" });
  const key = activeChatRunKey({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: found.access.project.id, sessionId: found.session.id });
  res.json({ data: await cancelChatRun({ key, tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: found.access.project.id, sessionId: found.session.id }) });
}));

chatRouter.get("/:ontologyId/sessions/:sessionId/chat/status", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const found = await actorSession(ctx, String(req.params.ontologyId), String(req.params.sessionId));
  if (!found) return void res.status(404).json({ error: "Ontology or session not found" });
  const { access, session } = found;
  const key = activeChatRunKey({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: access.project.id, sessionId: session.id });
  const localRun = getActiveChatRun(key);
  const status = await getLatestRunStatus({ tenantId: ctx.tenantId, ontologyId: access.project.id, sessionId: session.id });
  res.json({
    data: {
      ...status,
      active: Boolean(localRun) || status.active,
      local: Boolean(localRun),
      runId: localRun?.runId ?? status.runId,
    },
  });
}));

chatRouter.get("/:ontologyId/sessions/:sessionId/chat/stream", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const found = await actorSession(ctx, String(req.params.ontologyId), String(req.params.sessionId));
  if (!found) return void res.status(404).json({ error: "Ontology or session not found" });
  const { access, session } = found;
  const key = activeChatRunKey({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: access.project.id, sessionId: session.id });
  const localRun = getActiveChatRun(key);
  const status = await getLatestRunStatus({ tenantId: ctx.tenantId, ontologyId: access.project.id, sessionId: session.id });
  const requestedRunId = stringFromQuery(req.query.runId);
  const runId = requestedRunId ?? localRun?.runId ?? status.runId;
  const streamLocalRun = localRun?.runId === runId ? localRun : null;
  const runIsActive = Boolean(streamLocalRun) || (status.runId === runId && status.active);
  if (!runId || !runIsActive) return void res.status(204).end();
  await streamRunToResponse({
    req,
    res,
    tenantId: ctx.tenantId,
    ontologyId: access.project.id,
    sessionId: session.id,
    runId,
    afterSequence: sequenceFromQuery(req.query.after),
    streamFormat: streamFormatFromQuery(req.query.format),
    activeRun: streamLocalRun,
  });
}));

chatRouter.post("/:ontologyId/sessions/:sessionId/suggestions", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const body = suggestionsSchema.parse(req.body ?? {});
  const found = await actorSession(ctx, String(req.params.ontologyId), String(req.params.sessionId));
  if (!found) return void res.status(404).json({ error: "Ontology or session not found" });
  const { access, session } = found;
  const project = access.project;

  const messageCtx = { tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: project.id, sessionId: session.id };
  const [messages, cwd] = await Promise.all([
    listMessages(messageCtx),
    ensureWorkspace(project, access.workspaceTenantId, access.workspaceOwnerId),
  ]);
  const journeyState = await readJourneyState(cwd);

  const persistedMessages = messages.map((message) => ({
    role: message.role === "user" ? "user" as const : "assistant" as const,
    content: message.content,
    parts: message.parts,
    createdAt: message.createdAt,
  }));
  const rawClientMessages = body.clientMessages ?? [];
  const persistedTailOffset = Math.max(0, persistedMessages.length - rawClientMessages.length);
  const clientMessages = rawClientMessages.map((message, index) => ({
    role: message.role,
    content: message.content,
    createdAt: message.createdAt ?? persistedMessages[persistedTailOffset + index]?.createdAt,
  }));
  const suggestionMessages = clientMessages.length >= persistedMessages.length ? clientMessages : persistedMessages;

  const suggestions = await generateFollowupSuggestions({
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    cwd,
    messages: suggestionMessages,
    workflowState: buildFollowupWorkflowState(project, journeyState),
  });

  res.json({ data: { suggestions } });
}));

chatRouter.post("/:ontologyId/sessions/:sessionId/chat", asyncRoute(async (req, res) => {
  // Wall-clock marks for everything that runs before the SSE response opens —
  // this pre-stream work is exactly what the client measures as chat TTFB.
  const timingStart = Date.now();
  const timing: Record<string, number> = {};
  const markTiming = (name: string) => { timing[name] = Date.now() - timingStart; };
  const ctx = await requireTenantContext(req);
  markTiming("auth");
  const parsedBody = chatSchema.parse(req.body ?? {});
  const visibleMessage = (parsedBody.message?.trim() || textFromAiSdkMessages(parsedBody.messages) || "").trim();
  const backendMessage = parsedBody.backendMessage?.trim() ?? "";
  const message = (visibleMessage || backendMessage).trim();
  const effectiveBackendMessage = backendMessage || applySlashCommandTriggerPrefix(message, parsedBody.slashCommandId);
  const { stream, streamFormat, disabledConnectors } = parsedBody;
  const uiLocale = normalizeUiLocale(parsedBody.locale, req.headers["accept-language"]);
  if (!message) {
    return void res.status(400).json({ error: "Validation failed: message must contain non-whitespace text", issues: [{ path: ["message"], message: "message must contain non-whitespace text" }] });
  }
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  const session = access ? await getSession(ctx.tenantId, ctx.ownerId, access.project.id, String(req.params.sessionId), access.project) : null;
  if (!access || !session) return void res.status(404).json({ error: "Ontology or session not found" });
  const project = access.project;

  markTiming("load_session");

  const activeRunKey = activeChatRunKey({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: project.id, sessionId: session.id });
  await cancelChatRun({ key: activeRunKey, tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: project.id, sessionId: session.id });

  if (shouldAutoTitle(session.preview)) {
    const existingMessages = await listMessages({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: project.id, sessionId: session.id });
    if (existingMessages.length === 0) {
      await updateSession(ctx.tenantId, ctx.ownerId, project.id, session.id, { preview: titleFromPrompt(message) }, project);
    }
  }
  markTiming("history");
  const cwd = await ensureWorkspace(project, access.workspaceTenantId, access.workspaceOwnerId);
  markTiming("workspace");
  const resourceIds = [
    ...(parsedBody.resourceIds ?? []),
    ...resourceIdsFromText(message),
    ...resourceIdsFromText(effectiveBackendMessage),
  ];
  const resourceFolderIds = [
    ...(parsedBody.resourceFolderIds ?? []),
    ...resourceFolderIdsFromText(message),
    ...resourceFolderIdsFromText(effectiveBackendMessage),
  ];
  if (!hasKnowledgeBaseCapability(access, "contribute") && (resourceIds.length > 0 || resourceFolderIds.length > 0)) {
    return void res.status(403).json({ error: "Viewer access cannot ingest resources" });
  }
  const resourcePaths = await materializeResourceReferences({
    tenantId: ctx.tenantId,
    ownerId: ctx.ownerId,
    ontologyId: project.id,
    root: cwd,
    resourceIds,
    resourceFolderIds,
  });
  const workspacePaths = await canonicalizeWorkspaceReferencePaths(cwd, parsedBody.workspaceFiles ?? []);
  const workspaceReferencePaths = await canonicalizeWorkspaceReferencePaths(cwd, parsedBody.workspaceReferences ?? []);
  const referencedPaths = [...workspacePaths, ...resourcePaths];
  if (resourcePaths.length) await refreshRawSourcesInJourney(cwd);
  const cleanMessage = stripResourceReferenceTokens(effectiveBackendMessage || message);
  const promptMessage = await withRepoIngestRoutingHint(cwd, withWorkspaceFileContext(cleanMessage || message, referencedPaths), referencedPaths);
  const visibleUserMessage = stripResourceReferenceTokens(visibleMessage || message) || visibleMessage || message;
  const clientUserParts = latestUserPartsFromAiSdkMessages(parsedBody.messages, visibleUserMessage);
  const visibleWorkspacePartPaths = clientUserParts?.length
    ? workspaceReferencePaths
    : Array.from(new Set([...workspaceReferencePaths, ...workspacePaths]));
  const visibleUserPartsWithWorkspace = withWorkspaceReferenceParts(clientUserParts, visibleUserMessage, visibleWorkspacePartPaths);
  const visibleUserParts = await withResourceLibraryReferenceParts({
    tenantId: ctx.tenantId,
    ownerId: ctx.ownerId,
    parts: visibleUserPartsWithWorkspace,
    visibleText: visibleUserMessage,
    resourceIds,
    resourceFolderIds,
  });
  await appendMessage({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: project.id, sessionId: session.id }, { role: "user", content: visibleUserMessage, parts: visibleUserParts });
  markTiming("persist_user");

  const runId = randomUUID();
  const run = startActiveChatRun({
    key: activeRunKey,
    runId,
    tenantId: ctx.tenantId,
    ontologyId: project.id,
    sessionId: session.id,
    onComplete: async (result) => {
      await reconcileOperationRunAfterChatCompletion({
        store: createConfiguredOperationRunStore({
          workspaceRoot: cwd,
          tenantId: ctx.tenantId,
          ownerId: ctx.ownerId,
          knowledgeBaseId: project.id,
        }),
        conversationId: session.id,
        agentRunId: runId,
        result,
      });
    },
  }, (emit, signal) => executeOntologyChatRun({
    runId,
    tenantId: ctx.tenantId,
    ownerId: ctx.ownerId,
    workspaceTenantId: access.workspaceTenantId,
    workspaceOwnerId: access.workspaceOwnerId,
    userId: ctx.user.id,
    userRequest: visibleUserMessage,
    project,
    session,
    cwd,
    promptMessage,
    locale: uiLocale,
    disabledConnectors,
    readOnly: !hasKnowledgeBaseCapability(access, "contribute"),
    actorDisplayName: ctx.user.displayName,
    authorizationRole: access.role,
    authorizationSource: access.source,
  }, emit, signal));

  console.log(`[chat/timing] pre-stream runId=${runId} ${JSON.stringify(timing)}`);

  if (stream) {
    await streamRunToResponse({
      req,
      res,
      tenantId: ctx.tenantId,
      ontologyId: project.id,
      sessionId: session.id,
      runId,
      streamFormat: streamFormat ?? "ai-sdk",
      activeRun: run,
    });
    return;
  }

  const result = await run.promise;
  if (result.cancelled) return void res.status(499).json({ error: "Chat run cancelled" });
  if (result.error) return void res.status(500).json({ error: result.error, events: result.events, journeyState: result.journeyState, claudeSessionId: result.claudeSessionId });
  res.json({ data: { message: result.message, events: result.events, journeyState: result.journeyState, claudeSessionId: result.claudeSessionId } });
}));
