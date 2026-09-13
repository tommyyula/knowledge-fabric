import { Router } from "express";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { requireGatewayTenantContext, type TenantContext } from "../auth/requireTenantContext";
import { env } from "../env";
import { asyncRoute } from "../http";
import {
  createSession,
  deleteExternalQueryIdempotency,
  findExternalQueryIdempotency,
  getSession,
  listAccessibleKnowledgeBaseProjects,
  recordExternalAccessAuditEvent,
  recordExternalQueryIdempotency,
  type QueryReadyProjectCursor,
  updateExternalQueryIdempotency,
} from "../ontologies/repository";
import { readJourneyState, workspacePath } from "../ontologies/workspace";
import { resolveKnowledgeBaseAccess } from "../ontologies/access";
import { isWorkspaceQueryReady } from "./query-readiness";

export const externalRouter = Router();

const catalogQuerySchema = z.object({
  q: z.string().trim().max(200).optional().default(""),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const querySchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  conversationId: z.string().trim().min(1).optional(),
  stream: z.boolean().optional().default(false),
}).strict();

function problem(res: import("express").Response, status: number, code: string, title: string): void {
  res.status(status).type("application/problem+json").json({ type: `https://knowledge-fabric.dev/problems/${code}`, title, status, code });
}

function encodeCursor(cursor: QueryReadyProjectCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): QueryReadyProjectCursor | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<QueryReadyProjectCursor>;
    if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) || typeof value.ontologyId !== "string" || !value.ontologyId) throw new Error("invalid cursor");
    return { updatedAt: value.updatedAt, ontologyId: value.ontologyId };
  } catch {
    throw Object.assign(new Error("Invalid catalog cursor"), { status: 400 });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function externalProtocol(req: import("express").Request): "rest" | "mcp" | "a2a" {
  const forwarded = req.header("x-knowledge-fabric-internal-protocol");
  const address = req.socket.remoteAddress ?? "";
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  return loopback && (forwarded === "mcp" || forwarded === "a2a") ? forwarded : "rest";
}

function startRestAudit(req: import("express").Request, res: import("express").Response, ctx: TenantContext, operation: "knowledge_base_search" | "knowledge_base_query") {
  const requestId = randomUUID();
  const startedAt = Date.now();
  res.setHeader("x-request-id", requestId);
  return async (input: { status: number; errorCode?: string; ontologyId?: string; idempotencyKeyHash?: string }) => {
    try {
      const access = input.ontologyId ? await resolveKnowledgeBaseAccess(ctx, input.ontologyId) : null;
      await recordExternalAccessAuditEvent({
        requestId,
        protocol: externalProtocol(req),
        operation,
        tenantId: ctx.tenantId,
        ownerId: ctx.ownerId,
        ontologyId: input.ontologyId,
        workspaceTenantId: access?.workspaceTenantId,
        workspaceOwnerId: access?.workspaceOwnerId,
        authorizationRole: access?.role,
        authorizationSource: access?.source,
        idempotencyKeyHash: input.idempotencyKeyHash,
        outcome: input.errorCode ? "error" : "success",
        errorCode: input.errorCode,
        status: input.status,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.error("[external] failed to record access audit event", error);
    }
  };
}

function externalStreamLocation(knowledgeBaseId: string, conversationId: string, runId?: string): string {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
  return `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/conversations/${encodeURIComponent(conversationId)}/stream${query}`;
}

function dataFromSseFrame(frame: string): unknown {
  const line = frame.split(/\r?\n/).find((candidate) => candidate.startsWith("data:"));
  if (!line) return null;
  const value = line.slice("data:".length).trim();
  if (!value || value === "[DONE]") return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function pipeExternalSse(input: {
  res: import("express").Response;
  response: globalThis.Response;
  conversationId: string;
  streamUrl: string;
  onRunId?: (runId: string) => Promise<void>;
  onAnswer?: (answer: string) => Promise<void>;
}): Promise<void> {
  input.res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Conversation-Id": input.conversationId,
  });
  input.res.write(`event: conversation\ndata: ${JSON.stringify({ conversationId: input.conversationId, streamUrl: input.streamUrl })}\n\n`);
  const reader = input.response.body?.getReader();
  if (!reader) throw new Error("Internal query stream had no response body");
  const decoder = new TextDecoder();
  let pending = "";
  let answer = "";
  let announcedRunId: string | null = null;
  const inspect = async (frame: string) => {
    const data = dataFromSseFrame(frame);
    if (!data || typeof data !== "object") return;
    const event = data as { type?: unknown; data?: unknown; delta?: unknown };
    if (event.type === "data-run-event" && event.data && typeof event.data === "object") {
      const runId = (event.data as { runId?: unknown }).runId;
      if (typeof runId === "string" && runId && runId !== announcedRunId) {
        announcedRunId = runId;
        await input.onRunId?.(runId);
        input.res.write(`event: run\ndata: ${JSON.stringify({ runId, streamUrl: externalStreamLocationFromExisting(input.streamUrl, runId) })}\n\n`);
      }
    }
    if (event.type === "text-delta" && typeof event.delta === "string") answer += event.delta;
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const text = decoder.decode(next.value, { stream: true });
      pending += text;
      let boundary = pending.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        await inspect(frame);
        boundary = pending.indexOf("\n\n");
      }
      if (!input.res.writableEnded) input.res.write(text);
    }
    pending += decoder.decode();
    if (pending) await inspect(pending);
    if (answer.trim()) await input.onAnswer?.(answer);
  } finally {
    if (!input.res.writableEnded) input.res.end();
  }
}

function externalStreamLocationFromExisting(streamUrl: string, runId: string): string {
  const separator = streamUrl.includes("?") ? "&" : "?";
  return `${streamUrl}${separator}runId=${encodeURIComponent(runId)}`;
}

async function collectInternalSse(input: {
  response: globalThis.Response;
  onRunId?: (runId: string) => Promise<void>;
}): Promise<string> {
  const reader = input.response.body?.getReader();
  if (!reader) throw new Error("Internal query stream had no response body");
  const decoder = new TextDecoder();
  let pending = "";
  let answer = "";
  let announcedRunId: string | null = null;
  const inspect = async (frame: string) => {
    const data = dataFromSseFrame(frame);
    if (!data || typeof data !== "object") return;
    const event = data as { type?: unknown; data?: unknown; delta?: unknown };
    if (event.type === "data-run-event" && event.data && typeof event.data === "object") {
      const runId = (event.data as { runId?: unknown }).runId;
      if (typeof runId === "string" && runId && runId !== announcedRunId) {
        announcedRunId = runId;
        await input.onRunId?.(runId);
      }
    }
    if (event.type === "text-delta" && typeof event.delta === "string") answer += event.delta;
  };
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    pending += decoder.decode(next.value, { stream: true });
    let boundary = pending.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      await inspect(frame);
      boundary = pending.indexOf("\n\n");
    }
  }
  pending += decoder.decode();
  if (pending) await inspect(pending);
  if (!answer.trim()) throw new Error("Knowledge query returned no answer");
  return answer;
}

externalRouter.get("/knowledge-bases", asyncRoute(async (req, res) => {
  const ctx = await requireGatewayTenantContext(req);
  const audit = startRestAudit(req, res, ctx, "knowledge_base_search");
  const parsed = catalogQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    await audit({ status: 400, errorCode: "invalid_request" });
    return void problem(res, 400, "invalid_request", "Invalid catalog request");
  }
  const query = parsed.data;
  let cursor: QueryReadyProjectCursor | undefined;
  try {
    cursor = decodeCursor(query.cursor);
  } catch {
    await audit({ status: 400, errorCode: "invalid_request" });
    return void problem(res, 400, "invalid_request", "Invalid catalog cursor");
  }
  const search = query.q.toLocaleLowerCase();
  const accessible = (await listAccessibleKnowledgeBaseProjects(ctx.tenantId, ctx.ownerId))
    .filter(({ project }) => !project.deletedAt)
    .filter(({ project }) => !search || `${project.name}\n${project.description}`.toLocaleLowerCase().includes(search))
    .filter(({ project }) => !cursor || (project.updatedAt ?? "") < cursor.updatedAt || ((project.updatedAt ?? "") === cursor.updatedAt && project.id < cursor.ontologyId))
    .sort((left, right) => (right.project.updatedAt ?? "").localeCompare(left.project.updatedAt ?? "") || right.project.id.localeCompare(left.project.id));
  const readiness = await Promise.all(accessible.map(async ({ project }) => {
    if (!project.tenantId || !project.ownerId) return false;
    const root = workspacePath(project.tenantId, project.ownerId, project.id);
    return isWorkspaceQueryReady(root, await readJourneyState(root));
  }));
  const projects = accessible.filter((_item, index) => readiness[index]).map(({ project }) => project).slice(0, query.limit + 1);
  const page = projects.slice(0, query.limit);
  const next = projects.length > query.limit ? page[page.length - 1] : null;
  const response = {
    data: {
      items: page.map((project) => ({
        knowledgeBaseId: project.id,
        name: project.name,
        description: project.description,
        updatedAt: project.updatedAt,
        queryReady: true,
      })),
      nextCursor: next?.updatedAt ? encodeCursor({ updatedAt: next.updatedAt, ontologyId: next.id }) : null,
    },
  };
  await audit({ status: 200 });
  res.json(response);
}));

externalRouter.post("/knowledge-bases/:knowledgeBaseId/queries", asyncRoute(async (req, res) => {
  const ctx = await requireGatewayTenantContext(req);
  const audit = startRestAudit(req, res, ctx, "knowledge_base_query");
  const parsed = querySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    await audit({ status: 400, errorCode: "invalid_request" });
    return void problem(res, 400, "invalid_request", "Invalid query request");
  }
  const body = parsed.data;
  const idempotencyKey = req.header("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 512) {
    await audit({ status: 400, errorCode: "idempotency_key_required" });
    return void problem(res, 400, "idempotency_key_required", "Idempotency-Key header is required");
  }
  const keyHash = sha256(idempotencyKey);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.knowledgeBaseId));
  if (!access) {
    await audit({ status: 404, errorCode: "knowledge_base_not_found", idempotencyKeyHash: keyHash });
    return void problem(res, 404, "knowledge_base_not_found", "Knowledge Base not found");
  }
  const project = access.project;
  const root = access.workspaceRoot;
  const state = await readJourneyState(root);
  if (!await isWorkspaceQueryReady(root, state)) {
    await audit({ status: 409, errorCode: "knowledge_base_not_query_ready", ontologyId: project.id, idempotencyKeyHash: keyHash });
    return void problem(res, 409, "knowledge_base_not_query_ready", "Knowledge Base is not query-ready");
  }
  const requestFingerprint = sha256(JSON.stringify({
    knowledgeBaseId: project.id,
    conversationId: body.conversationId ?? null,
    message: body.message,
    stream: body.stream,
  }));
  const previous = await findExternalQueryIdempotency({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, ontologyId: project.id, keyHash });
  if (previous) {
    if (previous.requestFingerprint !== requestFingerprint) {
      await audit({ status: 409, errorCode: "idempotency_key_reused", ontologyId: project.id, idempotencyKeyHash: keyHash });
      return void problem(res, 409, "idempotency_key_reused", "Idempotency-Key was already used for a different query");
    }
    if (previous.status === "in_progress") {
      await audit({ status: 202, ontologyId: project.id, idempotencyKeyHash: keyHash });
      return void res.status(202).json({
        data: {
          status: "in_progress",
          conversationId: previous.conversationId,
          runId: previous.runId ?? null,
          requestId: idempotencyKey,
          retryAfterMs: 60000,
          streamUrl: externalStreamLocation(project.id, previous.conversationId, previous.runId),
        },
      });
    }
    if (!previous.answer) {
      await audit({ status: 502, errorCode: "query_execution_failed", ontologyId: project.id, idempotencyKeyHash: keyHash });
      return void problem(res, 502, "query_execution_failed", "Knowledge query returned no answer");
    }
    await audit({ status: 200, ontologyId: project.id, idempotencyKeyHash: keyHash });
    return void res.json({ data: { conversationId: previous.conversationId, answer: previous.answer } });
  }
  const session = body.conversationId
    ? await getSession(ctx.tenantId, ctx.ownerId, project.id, body.conversationId, project)
    : await createSession(ctx.tenantId, ctx.ownerId, project.id, "External API conversation", "external", project);
  if (!session) {
    await audit({ status: 404, errorCode: "conversation_not_found", ontologyId: project.id, idempotencyKeyHash: keyHash });
    return void problem(res, 404, "conversation_not_found", "Conversation not found");
  }

  const idempotencyRecord = {
    tenantId: ctx.tenantId,
    ownerId: ctx.ownerId,
    ontologyId: project.id,
    keyHash,
  };
  await recordExternalQueryIdempotency({
    ...idempotencyRecord,
    requestFingerprint,
    conversationId: session.id,
    status: "in_progress",
  });

  if (body.stream) {
    let internalStream: Response;
    try {
      internalStream = await fetch(`http://127.0.0.1:${env.port}/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`, {
        method: "POST",
        headers: {
          authorization: req.header("authorization") ?? "",
          TenantID: ctx.tenantId,
          "x-user-id": ctx.ownerId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: body.message, stream: true, streamFormat: "ai-sdk" }),
      });
      if (!internalStream.ok) throw new Error(`internal query returned ${internalStream.status}`);
    } catch {
      await deleteExternalQueryIdempotency(idempotencyRecord);
      await audit({ status: 502, errorCode: "query_execution_failed", ontologyId: project.id, idempotencyKeyHash: keyHash });
      return void problem(res, 502, "query_execution_failed", "Knowledge query failed");
    }
    const streamUrl = externalStreamLocation(project.id, session.id);
    try {
      await pipeExternalSse({
        res,
        response: internalStream,
        conversationId: session.id,
        streamUrl,
        onRunId: async (runId) => updateExternalQueryIdempotency({
          ...idempotencyRecord,
          status: "in_progress",
          runId,
        }),
        onAnswer: async (answer) => updateExternalQueryIdempotency({
          ...idempotencyRecord,
          status: "completed",
          answer,
        }),
      });
      await audit({ status: 200, ontologyId: project.id, idempotencyKeyHash: keyHash });
    } catch (error) {
      console.error("[external] query stream failed", error);
      await deleteExternalQueryIdempotency(idempotencyRecord);
      await audit({ status: 502, errorCode: "query_execution_failed", ontologyId: project.id, idempotencyKeyHash: keyHash });
      if (!res.headersSent) problem(res, 502, "query_execution_failed", "Knowledge query failed");
    }
    return;
  }

  let internalResponse: Response;
  try {
    internalResponse = await fetch(`http://127.0.0.1:${env.port}/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`, {
      method: "POST",
      headers: {
        authorization: req.header("authorization") ?? "",
        TenantID: ctx.tenantId,
        "x-user-id": ctx.ownerId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: body.message, stream: true, streamFormat: "ai-sdk" }),
    });
    if (!internalResponse.ok) throw new Error(`internal query returned ${internalResponse.status}`);
  } catch {
    await deleteExternalQueryIdempotency(idempotencyRecord);
    await audit({ status: 502, errorCode: "query_execution_failed", ontologyId: project.id, idempotencyKeyHash: keyHash });
    return void problem(res, 502, "query_execution_failed", "Knowledge query failed");
  }
  let answer: string;
  try {
    answer = await collectInternalSse({
      response: internalResponse,
      onRunId: async (runId) => updateExternalQueryIdempotency({
        ...idempotencyRecord,
        status: "in_progress",
        runId,
      }),
    });
  } catch {
    await deleteExternalQueryIdempotency(idempotencyRecord);
    await audit({ status: 502, errorCode: "query_execution_failed", ontologyId: project.id, idempotencyKeyHash: keyHash });
    return void problem(res, 502, "query_execution_failed", "Knowledge query returned no answer");
  }
  await updateExternalQueryIdempotency({
    ...idempotencyRecord,
    status: "completed",
    answer,
  });
  await audit({ status: 200, ontologyId: project.id, idempotencyKeyHash: keyHash });
  res.json({ data: { conversationId: session.id, answer } });
}));

externalRouter.get("/knowledge-bases/:knowledgeBaseId/conversations/:conversationId/stream", asyncRoute(async (req, res) => {
  const ctx = await requireGatewayTenantContext(req);
  const audit = startRestAudit(req, res, ctx, "knowledge_base_query");
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.knowledgeBaseId));
  if (!access) {
    await audit({ status: 404, errorCode: "knowledge_base_not_found" });
    return void problem(res, 404, "knowledge_base_not_found", "Knowledge Base not found");
  }
  const project = access.project;
  const conversationId = String(req.params.conversationId);
  const session = await getSession(ctx.tenantId, ctx.ownerId, project.id, conversationId, project);
  if (!session) {
    await audit({ status: 404, errorCode: "conversation_not_found", ontologyId: project.id });
    return void problem(res, 404, "conversation_not_found", "Conversation not found");
  }
  const runId = typeof req.query.runId === "string" && req.query.runId.trim() ? req.query.runId.trim() : undefined;
  const after = typeof req.query.after === "string" && /^\d+$/.test(req.query.after) ? req.query.after : undefined;
  const search = new URLSearchParams({ format: "ai-sdk" });
  if (runId) search.set("runId", runId);
  if (after) search.set("after", after);
  let internalStream: Response;
  try {
    internalStream = await fetch(`http://127.0.0.1:${env.port}/api/v1/ontologies/${project.id}/sessions/${session.id}/chat/stream?${search}`, {
      headers: { authorization: req.header("authorization") ?? "", TenantID: ctx.tenantId, "x-user-id": ctx.ownerId },
    });
    if (internalStream.status === 204) {
      await audit({ status: 204, ontologyId: project.id });
      return void res.status(204).end();
    }
    if (!internalStream.ok) throw new Error(`internal stream returned ${internalStream.status}`);
    await pipeExternalSse({
      res,
      response: internalStream,
      conversationId: session.id,
      streamUrl: externalStreamLocation(project.id, session.id, runId),
    });
    await audit({ status: 200, ontologyId: project.id });
  } catch (error) {
    console.error("[external] stream recovery failed", error);
    await audit({ status: 502, errorCode: "query_execution_failed", ontologyId: project.id });
    if (!res.headersSent) problem(res, 502, "query_execution_failed", "Knowledge query stream failed");
  }
}));

// ---------------------------------------------------------------------------
// Ontology workspace export
// GET /api/v1/ontologies/:ontologyId/export
//
// 调用方携带有效 Bearer Token，接口从 Token 中解析 tenant_id + user_id，
// 再通过 ontologyId 定位对应的 workspace 目录，打包成 tar.gz 流式返回。
// ---------------------------------------------------------------------------

function downloadName(value: string): string {
  return value.replace(/["\r\n]/g, "_") || "ontology";
}

function exportContentDisposition(name: string): string {
  const safeName = downloadName(name);
  const asciiName = safeName.replace(/[^\x20-\x7E]/g, "_");
  return `attachment; filename="${asciiName}.tar.gz"; filename*=UTF-8''${encodeURIComponent(safeName)}.tar.gz`;
}

externalRouter.get("/ontologies/:ontologyId/export", asyncRoute(async (req, res) => {
  const ctx = await requireGatewayTenantContext(req);
  const ontologyId = String(req.params.ontologyId).trim();

  if (!ontologyId) {
    return void problem(res, 400, "invalid_request", "ontologyId is required");
  }

  // 构造并校验 workspace 路径（workspacePath 内部已做路径沙盒检验）
  let workspaceDir: string;
  try {
    workspaceDir = workspacePath(ctx.tenantId, ctx.ownerId, ontologyId);
  } catch {
    return void problem(res, 400, "invalid_request", "Invalid ontology workspace path");
  }

  // 确认目录存在
  try {
    const stat = await fs.stat(workspaceDir);
    if (!stat.isDirectory()) {
      return void problem(res, 404, "ontology_not_found", "Ontology workspace not found");
    }
  } catch {
    return void problem(res, 404, "ontology_not_found", "Ontology workspace not found");
  }

  const archiveName = ontologyId;
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", exportContentDisposition(archiveName));

  const archive = spawn(
    "tar",
    [
      "-czf",
      "-",
      "-C",
      // 以 workspaceDir 的父目录为基准，只打包该目录本身
      path.dirname(workspaceDir),
      "--",
      path.basename(workspaceDir),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  archive.stderr.setEncoding("utf8");
  archive.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });

  req.on("aborted", () => archive.kill());
  archive.stdout.pipe(res);

  try {
    await new Promise<void>((resolve, reject) => {
      archive.once("error", reject);
      archive.once("close", (code) => {
        if (code === 0 || req.aborted) resolve();
        else reject(new Error(stderr.trim() || `tar exited with code ${code ?? "unknown"}`));
      });
    });
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error as Error);
      return;
    }
    throw error;
  }
}));
