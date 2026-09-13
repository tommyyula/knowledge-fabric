import { createHash, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  Role,
  Task,
  TaskState,
  type AgentCard,
  type Artifact,
  type Message,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type User,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  restHandler,
  type UserBuilder,
} from "@a2a-js/sdk/server/express";
import { RestRequestMalformedError } from "@a2a-js/sdk/errors";
import { requireGatewayTenantContext, type TenantContext } from "../auth/requireTenantContext";
import { env } from "../env";
import { createSession, findExternalQueryIdempotency, getSession, listRunEvents, recordExternalAccessAuditEvent, updateExternalQueryIdempotency } from "../ontologies/repository";
import { readJourneyState } from "../ontologies/workspace";
import { resolveKnowledgeBaseAccess } from "../ontologies/access";
import { PersistentA2ATaskStore, type TaskReservation } from "./a2a-task-store";
import { FileQueryAttachmentStager, type InlineQueryAttachment, type QueryAttachmentReceipt } from "./a2a-attachments";
import { isWorkspaceQueryReady } from "./query-readiness";

const searchInputSchema = z.object({
  operation: z.literal("knowledge_base_search"),
  // Kept only so older or over-eager A2A clients cannot accidentally filter the catalog.
  q: z.unknown().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

const queryInputSchema = z.object({
  operation: z.literal("knowledge_base_query"),
  knowledgeBaseId: z.string().trim().min(1),
}).strict();

interface QueryAdmission {
  kind: "query";
}

interface CatalogAdmission {
  kind: "catalog";
  data: unknown;
}

type A2AAdmission = QueryAdmission | CatalogAdmission;

class GatewayA2AUser implements User {
  readonly isAuthenticated = true;

  constructor(
    readonly userName: string,
    readonly tenantId: string,
    readonly ownerId: string,
    readonly authorization: string,
    readonly admission?: A2AAdmission,
  ) {}
}

const authenticatedContexts = new WeakMap<Request, TenantContext>();
const admittedRequests = new WeakMap<Request, A2AAdmission>();
const taskStore = new PersistentA2ATaskStore();
const attachmentStager = new FileQueryAttachmentStager();
const activeExecutions = new Map<string, { controller: AbortController; task: Task; context: ServerCallContext; authorization: string; knowledgeBaseId: string }>();

function a2aError(res: Response, status: number, statusName: string, message: string): void {
  res.setHeader("A2A-Version", "1.0");
  res.status(status).type("application/a2a+json").json({ error: { code: status, status: statusName, message, details: [] } });
}

function replayTask(req: Request, res: Response, task: Task): void {
  res.setHeader("A2A-Version", "1.0");
  if (req.path === "/message:stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.end(`data: ${JSON.stringify({ task: Task.toJSON(task) })}\n\n`);
    return;
  }
  res.type("application/a2a+json").json({ task: Task.toJSON(task) });
}

function rawParts(req: Request): Array<Record<string, unknown>> {
  const message = req.body?.message;
  return Array.isArray(message?.parts) ? message.parts : [];
}

function rawOperation(req: Request): unknown {
  const parts = rawParts(req).filter((part) => Object.prototype.hasOwnProperty.call(part, "data"));
  return parts.length === 1 ? parts[0].data : undefined;
}

function rawQuestion(req: Request): string | undefined {
  const parts = rawParts(req).filter((part) => Object.prototype.hasOwnProperty.call(part, "text"));
  return parts.length === 1 && typeof parts[0].text === "string" && parts[0].text.trim() ? String(parts[0].text).trim() : undefined;
}

function hasExactlyOneContentField(part: Record<string, unknown>): boolean {
  return ["data", "text", "raw", "url"].filter((key) => Object.prototype.hasOwnProperty.call(part, key)).length === 1;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function auditAdmissionError(ctx: TenantContext, knowledgeBaseId: string | undefined, errorCode: string, status: number, startedAt: number): Promise<void> {
  const access = knowledgeBaseId ? await resolveKnowledgeBaseAccess(ctx, knowledgeBaseId) : null;
  await recordExternalAccessAuditEvent({
    requestId: randomUUID(),
    protocol: "a2a",
    operation: "knowledge_base_query",
    tenantId: ctx.tenantId,
    ownerId: ctx.ownerId,
    ontologyId: knowledgeBaseId,
    workspaceTenantId: access?.workspaceTenantId,
    workspaceOwnerId: access?.workspaceOwnerId,
    authorizationRole: access?.role,
    authorizationSource: access?.source,
    outcome: "error",
    errorCode,
    status,
    durationMs: Date.now() - startedAt,
  }).catch((error) => console.error("[a2a] failed to record admission audit event", error));
}

export async function requireA2AAuthentication(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await requireGatewayTenantContext(req);
    authenticatedContexts.set(req, context);
    next();
  } catch {
    res.setHeader("WWW-Authenticate", "Bearer");
    a2aError(res, 401, "UNAUTHENTICATED", "Authentication required");
  }
}

export async function admitA2ARequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ctx = authenticatedContexts.get(req);
  if (!ctx) return void a2aError(res, 401, "UNAUTHENTICATED", "Authentication required");
  try {
    const expiredTaskIds = await taskStore.purgeExpired();
    await Promise.all(expiredTaskIds.map((taskId) => attachmentStager.cleanup(taskId)));
  } catch (error) {
    console.error("[a2a] failed to purge expired Tasks", error);
    return void a2aError(res, 500, "INTERNAL", "A2A Task expiry cleanup failed");
  }
  const taskPath = req.path.match(/^\/tasks\/([^/:]+)(?::(?:cancel|subscribe))?$/);
  if (taskPath) {
    const taskId = decodeURIComponent(taskPath[1]);
    if (!await taskStore.findByTaskId(ctx.tenantId, ctx.ownerId, taskId)) return void a2aError(res, 404, "NOT_FOUND", `Task not found: ${taskId}`);
    return void next();
  }
  if (req.method !== "POST" || (req.path !== "/message:send" && req.path !== "/message:stream")) return void next();
  const startedAt = Date.now();
  const parts = rawParts(req);
  if (!parts.length || parts.some((part) => !hasExactlyOneContentField(part))) return void a2aError(res, 400, "INVALID_ARGUMENT", "Every Part must contain exactly one supported content field");
  const operation = rawOperation(req);
  const search = searchInputSchema.safeParse(operation);
  if (search.success) {
    if (parts.length !== 1) return void a2aError(res, 400, "INVALID_ARGUMENT", "knowledge_base_search accepts only its operation Data Part");
    try {
      const data = await searchKnowledgeBases(search.data, req.header("authorization") ?? "", ctx);
      admittedRequests.set(req, { kind: "catalog", data });
      return void next();
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === "number" ? Number((error as { status: number }).status) : 400;
      return void a2aError(res, status, status === 404 ? "NOT_FOUND" : "INVALID_ARGUMENT", error instanceof Error ? error.message : "Catalog request failed");
    }
  }
  const query = queryInputSchema.safeParse(operation);
  const question = rawQuestion(req);
  const messageId = typeof req.body?.message?.messageId === "string" ? req.body.message.messageId.trim() : "";
  const role = req.body?.message?.role;
  const callerTaskId = req.body?.message?.taskId;
  if (!query.success || !question || !messageId || messageId.length > 512 || (role !== "ROLE_USER" && role !== 1) || (typeof callerTaskId === "string" && callerTaskId)) {
    if (query.success) await auditAdmissionError(ctx, query.data.knowledgeBaseId, "invalid_request", 400, startedAt);
    return void a2aError(res, 400, "INVALID_ARGUMENT", "knowledge_base_query requires a user Message with operation, knowledgeBaseId, one Text Part, and a server-generated taskId");
  }
  if (parts.some((part) => Object.prototype.hasOwnProperty.call(part, "url"))) {
    await auditAdmissionError(ctx, query.data.knowledgeBaseId, "invalid_attachment", 400, startedAt);
    return void a2aError(res, 400, "INVALID_ARGUMENT", "Remote URI File Parts are not supported");
  }
  if (parts.some((part) => Object.prototype.hasOwnProperty.call(part, "raw") && typeof part.raw !== "string")) {
    await auditAdmissionError(ctx, query.data.knowledgeBaseId, "invalid_attachment", 400, startedAt);
    return void a2aError(res, 400, "INVALID_ARGUMENT", "Inline File Parts require Base64 string bytes");
  }
  const suppliedContextId = typeof req.body.message.contextId === "string" && req.body.message.contextId.trim() ? req.body.message.contextId.trim() : undefined;
  const taskId = randomUUID();
  const inlineAttachments: InlineQueryAttachment[] = rawParts(req)
    .filter((part) => typeof part.raw === "string")
    .map((part) => ({ raw: String(part.raw), filename: typeof part.filename === "string" ? part.filename : undefined, mediaType: typeof part.mediaType === "string" ? part.mediaType : undefined }));
  let attachments: QueryAttachmentReceipt[];
  try {
    attachments = await attachmentStager.stage(taskId, inlineAttachments);
  } catch (error) {
    await auditAdmissionError(ctx, query.data.knowledgeBaseId, "invalid_attachment", 400, startedAt);
    return void a2aError(res, 400, "INVALID_ARGUMENT", error instanceof Error ? error.message : "Invalid Query Attachment");
  }
  const requestFingerprint = fingerprint({ operation: query.data.operation, knowledgeBaseId: query.data.knowledgeBaseId, contextId: suppliedContextId ?? null, question, attachments });
  const previous = await taskStore.findByMessageId(ctx.tenantId, ctx.ownerId, messageId);
  if (previous) {
    await attachmentStager.cleanup(taskId);
    if (previous.requestFingerprint !== requestFingerprint) {
      await auditAdmissionError(ctx, query.data.knowledgeBaseId, "message_id_reused", 409, startedAt);
      return void a2aError(res, 409, "ALREADY_EXISTS", "messageId was already used for a different query");
    }
    return void replayTask(req, res, previous.task);
  }
  const access = await resolveKnowledgeBaseAccess(ctx, query.data.knowledgeBaseId);
  if (!access) {
    await attachmentStager.cleanup(taskId);
    await auditAdmissionError(ctx, query.data.knowledgeBaseId, "knowledge_base_not_found", 404, startedAt);
    return void a2aError(res, 404, "NOT_FOUND", "Knowledge Base not found");
  }
  const project = access.project;
  const root = access.workspaceRoot;
  const state = await readJourneyState(root);
  if (!await isWorkspaceQueryReady(root, state)) {
    await attachmentStager.cleanup(taskId);
    await auditAdmissionError(ctx, project.id, "knowledge_base_not_query_ready", 409, startedAt);
    return void a2aError(res, 409, "FAILED_PRECONDITION", "Knowledge Base is not query-ready");
  }
  const session = suppliedContextId
    ? await getSession(ctx.tenantId, ctx.ownerId, project.id, suppliedContextId, project)
    : await createSession(ctx.tenantId, ctx.ownerId, project.id, "External Conversation", "external", project);
  if (!session) {
    await attachmentStager.cleanup(taskId);
    await auditAdmissionError(ctx, project.id, "conversation_not_found", 404, startedAt);
    return void a2aError(res, 404, "NOT_FOUND", "External Conversation not found");
  }
  const now = new Date().toISOString();
  const task: Task = {
    id: taskId,
    contextId: session.id,
    status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now },
    artifacts: [],
    history: [],
    metadata: { operation: query.data.operation, knowledgeBaseId: project.id, messageId, attachments, attachmentsProcessed: false },
  };
  let reservation: TaskReservation;
  try {
    reservation = await taskStore.reserve({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, messageId, requestFingerprint, knowledgeBaseId: project.id, task });
  } catch (error) {
    await attachmentStager.cleanup(taskId);
    throw error;
  }
  if (reservation.kind === "message_conflict") {
    await attachmentStager.cleanup(taskId);
    await auditAdmissionError(ctx, project.id, "message_id_reused", 409, startedAt);
    return void a2aError(res, 409, "ALREADY_EXISTS", "messageId was already used for a different query");
  }
  if (reservation.kind === "context_conflict") {
    await attachmentStager.cleanup(taskId);
    await auditAdmissionError(ctx, project.id, "context_busy", 409, startedAt);
    return void a2aError(res, 409, "ABORTED", "Another A2A Query Task is active in this context");
  }
  if (reservation.kind === "replay") {
    await attachmentStager.cleanup(taskId);
    return void replayTask(req, res, reservation.record.task);
  }
  req.body.message.taskId = taskId;
  req.body.message.contextId = session.id;
  req.body.message.parts = rawParts(req).filter((part) => !Object.prototype.hasOwnProperty.call(part, "raw"));
  req.body.configuration = { ...(req.body.configuration ?? {}), returnImmediately: true };
  admittedRequests.set(req, { kind: "query" });
  next();
}

const userBuilder: UserBuilder = async (req: Request) => {
  const context = authenticatedContexts.get(req);
  if (!context) throw new Error("A2A authentication middleware was not applied");
  return new GatewayA2AUser(
    `${context.tenantId}:${context.ownerId}`,
    context.tenantId,
    context.ownerId,
    req.header("authorization") ?? "",
    admittedRequests.get(req),
  );
};

function contextBuilder(options: Parameters<NonNullable<Parameters<typeof restHandler>[0]["contextBuilder"]>>[0]): ServerCallContext {
  const user = options.user as GatewayA2AUser | undefined;
  return new ServerCallContext({
    requestedExtensions: options.extensions,
    requestedVersion: options.requestedVersion,
    user,
    tenant: user?.tenantId,
    state: new Map([["headers", options.headers]]),
  });
}

function publicBaseUrl(): string {
  return (env.a2aPublicBaseUrl ?? `http://127.0.0.1:${env.port}`).replace(/\/$/, "");
}

const bearerRequirement = { schemes: { bearerAuth: { list: [] } } };

const agentCard: AgentCard = {
  name: "Knowledge Fabric",
  description: "Discovers and queries the authenticated caller's Query-ready Knowledge Bases.",
  supportedInterfaces: [{
    url: `${publicBaseUrl()}/api/v1/a2a`,
    protocolBinding: "HTTP+JSON",
    protocolVersion: "1.0",
    tenant: "",
  }],
  provider: undefined,
  version: "1.0.0",
  documentationUrl: `${publicBaseUrl()}/docs/external-knowledge-query-a2a`,
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false,
  },
  securitySchemes: {
    bearerAuth: {
      scheme: {
        $case: "httpAuthSecurityScheme",
        value: {
          description: "Gateway-validated Bearer JWT",
          scheme: "Bearer",
          bearerFormat: "JWT",
        },
      },
    },
  },
  securityRequirements: [bearerRequirement],
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  skills: [{
    id: "knowledge_base_search",
    name: "Discover Query-ready Knowledge Bases",
    description: "Lists the authenticated caller's Queryable Knowledge Base Catalog without text filtering, using an explicit operation Data Part.",
    tags: ["knowledge-base", "catalog", "discovery"],
    examples: ['{"operation":"knowledge_base_search","limit":20}'],
    inputModes: ["application/json"],
    outputModes: ["application/json"],
    securityRequirements: [bearerRequirement],
  }, {
    id: "knowledge_base_query",
    name: "Query a Knowledge Base",
    description: "Creates an A2A Query Task for an explicit knowledgeBaseId. Inline attachments may be received but are not processed.",
    tags: ["knowledge-base", "query", "task"],
    examples: ['{"operation":"knowledge_base_query","knowledgeBaseId":"kb-id"}'],
    inputModes: ["application/json", "text/plain", "application/octet-stream"],
    outputModes: ["text/plain", "application/json"],
    securityRequirements: [bearerRequirement],
  }],
  signatures: [],
};

function knowledgeAnswerArtifact(answer: string, attachments: unknown): Artifact {
  return {
    artifactId: "knowledge-answer",
    name: "knowledge-answer",
    description: "Answer from the selected Query-ready Knowledge Base",
    parts: [{ content: { $case: "text", value: answer }, metadata: undefined, filename: "", mediaType: "text/plain" }],
    metadata: { attachments, attachmentsProcessed: false },
    extensions: [],
  };
}

function answerFromRunEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const record = event as Record<string, unknown>;
  if (record.type !== "message" || !record.message || typeof record.message !== "object" || Array.isArray(record.message)) return undefined;
  const content = (record.message as Record<string, unknown>).content;
  return typeof content === "string" && content.trim() ? content : undefined;
}

export async function initializeA2A(): Promise<void> {
  await taskStore.purgeExpired();
  const active = await taskStore.activeRecords();
  for (const record of active) {
    const external = await findExternalQueryIdempotency({
      tenantId: record.tenantId,
      ownerId: record.ownerId,
      ontologyId: record.knowledgeBaseId,
      keyHash: createHash("sha256").update(record.messageId).digest("hex"),
    });
    const attachments = record.task.metadata?.attachments ?? [];
    let answer = external?.status === "completed" && external.answer ? external.answer : undefined;
    if (!answer && external?.runId) {
      const events = await listRunEvents({
        tenantId: record.tenantId,
        ontologyId: record.knowledgeBaseId,
        sessionId: external.conversationId,
        runId: external.runId,
      });
      const runAnswers = events.map((event) => answerFromRunEvent(event.event)).filter((value): value is string => Boolean(value));
      answer = runAnswers[runAnswers.length - 1];
      if (answer) {
        await updateExternalQueryIdempotency({
          tenantId: external.tenantId,
          ownerId: external.ownerId,
          ontologyId: external.ontologyId,
          keyHash: external.keyHash,
          status: "completed",
          runId: external.runId,
          answer,
        });
      }
    }
    if (answer) {
      record.task = {
        ...record.task,
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
        artifacts: [knowledgeAnswerArtifact(answer, attachments)],
      };
    } else {
      record.task = {
        ...record.task,
        status: {
          state: TaskState.TASK_STATE_FAILED,
          timestamp: new Date().toISOString(),
          message: {
            messageId: randomUUID(), contextId: record.task.contextId, taskId: record.task.id, role: Role.ROLE_AGENT,
            parts: [{ content: { $case: "text", value: "A2A Query Task was interrupted by a service restart" }, metadata: undefined, filename: "", mediaType: "text/plain" }],
            metadata: { code: "service_interrupted" }, extensions: [], referenceTaskIds: [],
          },
        },
      };
    }
    await taskStore.saveRecord(record);
  }
  await attachmentStager.cleanupAll();
}

function dataPart(message: Message): unknown {
  const parts = message.parts.filter((part) => part.content?.$case === "data");
  if (parts.length !== 1) {
    throw new RestRequestMalformedError({ message: "Exactly one operation Data Part is required" });
  }
  return parts[0].content?.value;
}

async function searchKnowledgeBases(input: z.infer<typeof searchInputSchema>, authorization: string, ctx: TenantContext): Promise<unknown> {
  const query = new URLSearchParams();
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.limit) query.set("limit", String(input.limit));
  const response = await fetch(`http://127.0.0.1:${env.port}/api/v1/knowledge-bases${query.size ? `?${query}` : ""}`, {
    headers: {
      authorization,
      TenantID: ctx.tenantId,
      "x-user-id": ctx.ownerId,
      "x-knowledge-fabric-internal-protocol": "a2a",
    },
  });
  const body = await response.json().catch(() => null) as { data?: unknown; title?: unknown } | null;
  if (!response.ok) {
    throw Object.assign(new Error(typeof body?.title === "string" ? body.title : "Queryable Knowledge Base Catalog request failed"), { status: response.status });
  }
  return body?.data;
}

class KnowledgeFabricAgentExecutor implements AgentExecutor {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const user = requestContext.context.user;
    if (!(user instanceof GatewayA2AUser)) {
      throw new RestRequestMalformedError({ message: "Authentication required", statusCode: 401 });
    }
    if (user.admission?.kind === "catalog") {
      eventBus.publish(AgentEvent.message({
        messageId: randomUUID(),
        contextId: requestContext.contextId,
        taskId: "",
        role: Role.ROLE_AGENT,
        parts: [{
          content: { $case: "data", value: user.admission.data },
          metadata: undefined,
          filename: "",
          mediaType: "application/json",
        }],
        metadata: { operation: "knowledge_base_search" },
        extensions: [],
        referenceTaskIds: [],
      }));
      eventBus.finished();
      return;
    }
    if (user.admission?.kind !== "query") throw new RestRequestMalformedError({ message: "A2A request was not admitted" });
    const parsed = queryInputSchema.safeParse(dataPart(requestContext.userMessage));
    const question = requestContext.userMessage.parts.filter((part) => part.content?.$case === "text" && part.content.value.trim()).map((part) => part.content?.value)[0];
    if (!parsed.success || typeof question !== "string") throw new Error("Admitted A2A query became invalid");
    const working: Task = {
      id: requestContext.taskId,
      contextId: requestContext.contextId,
      status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
      metadata: {
        operation: "knowledge_base_query",
        knowledgeBaseId: parsed.data.knowledgeBaseId,
        messageId: requestContext.userMessage.messageId,
        attachments: requestContext.task?.metadata?.attachments ?? [],
        attachmentsProcessed: false,
      },
    };
    await taskStore.save(working, requestContext.context);
    const controller = new AbortController();
    activeExecutions.set(working.id, { controller, task: working, context: requestContext.context, authorization: user.authorization, knowledgeBaseId: parsed.data.knowledgeBaseId });
    eventBus.publish(AgentEvent.task(working));
    try {
      if (env.a2aQueryStartDelayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, env.a2aQueryStartDelayMs);
          controller.signal.addEventListener("abort", () => { clearTimeout(timer); reject(controller.signal.reason); }, { once: true });
        });
      }
      const response = await fetch(`http://127.0.0.1:${env.port}/api/v1/knowledge-bases/${encodeURIComponent(parsed.data.knowledgeBaseId)}/queries`, {
        method: "POST",
        headers: {
          authorization: user.authorization,
          TenantID: user.tenantId,
          "x-user-id": user.ownerId,
          "content-type": "application/json",
          "idempotency-key": requestContext.userMessage.messageId,
          "x-knowledge-fabric-internal-protocol": "a2a",
        },
        body: JSON.stringify({ message: question, conversationId: requestContext.contextId, stream: false }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as { data?: { conversationId?: unknown; answer?: unknown }; title?: unknown } | null;
      if (!response.ok || typeof body?.data?.answer !== "string" || !body.data.answer.trim()) {
        throw new Error(typeof body?.title === "string" ? body.title : "Knowledge query failed");
      }
      const artifact = knowledgeAnswerArtifact(body.data.answer, working.metadata?.attachments ?? []);
      const completed: Task = {
        ...working,
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
        artifacts: [artifact],
      };
      if (controller.signal.aborted) return;
      eventBus.publish(AgentEvent.artifactUpdate({ taskId: completed.id, contextId: completed.contextId, artifact, append: true, lastChunk: true, metadata: { attachmentsProcessed: false } }));
      if (controller.signal.aborted) return;
      eventBus.publish(AgentEvent.statusUpdate({ taskId: completed.id, contextId: completed.contextId, status: completed.status, metadata: undefined }));
    } catch {
      if (controller.signal.aborted) return;
      const failed: Task = {
        ...working,
        status: {
          state: TaskState.TASK_STATE_FAILED,
          timestamp: new Date().toISOString(),
          message: {
            messageId: randomUUID(), contextId: working.contextId, taskId: working.id, role: Role.ROLE_AGENT,
            parts: [{ content: { $case: "text", value: "Knowledge query failed" }, metadata: undefined, filename: "", mediaType: "text/plain" }],
            metadata: { code: "query_execution_failed" }, extensions: [], referenceTaskIds: [],
          },
        },
      };
      await taskStore.save(failed, requestContext.context);
      eventBus.publish(AgentEvent.statusUpdate({ taskId: failed.id, contextId: failed.contextId, status: failed.status, metadata: undefined }));
    } finally {
      if (activeExecutions.get(requestContext.taskId)?.controller === controller) activeExecutions.delete(requestContext.taskId);
      await attachmentStager.cleanup(requestContext.taskId).catch((error) => console.error("[a2a] failed to clean Query Attachments", error));
      eventBus.finished();
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const active = activeExecutions.get(taskId);
    if (!active) throw new Error("A2A Query Task is no longer active");
    active.controller.abort(new Error("A2A Query Task canceled"));
    try {
      const response = await fetch(`http://127.0.0.1:${env.port}/api/v1/ontologies/${encodeURIComponent(active.knowledgeBaseId)}/sessions/${encodeURIComponent(active.task.contextId)}/cancel`, {
        method: "POST",
        headers: {
          authorization: active.authorization,
          TenantID: active.context.tenant ?? "",
        },
      });
      if (!response.ok) console.error(`[a2a] underlying Run cancellation returned ${response.status}`);
    } catch (error) {
      console.error("[a2a] failed to cancel underlying Run", error);
    }
    const canceled: Task = {
      ...active.task,
      status: {
        state: TaskState.TASK_STATE_CANCELED,
        timestamp: new Date().toISOString(),
        message: {
          messageId: randomUUID(), contextId: active.task.contextId, taskId, role: Role.ROLE_AGENT,
          parts: [{ content: { $case: "text", value: "A2A Query Task canceled" }, metadata: undefined, filename: "", mediaType: "text/plain" }],
          metadata: { code: "task_canceled" }, extensions: [], referenceTaskIds: [],
        },
      },
    };
    await taskStore.save(canceled, active.context);
    await attachmentStager.cleanup(taskId).catch((error) => console.error("[a2a] failed to clean canceled Query Attachments", error));
    eventBus.publish(AgentEvent.statusUpdate({ taskId, contextId: canceled.contextId, status: canceled.status, metadata: undefined }));
    eventBus.finished();
  }
}

const requestHandler = new DefaultRequestHandler(
  agentCard,
  taskStore,
  new KnowledgeFabricAgentExecutor(),
);

export const a2aAgentCardHandler = agentCardHandler({ agentCardProvider: requestHandler });
export const a2aRestHandler = restHandler({ requestHandler, userBuilder, contextBuilder });
