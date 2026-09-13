import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireGatewayTenantContext, type TenantContext } from "../auth/requireTenantContext";
import { env } from "../env";
import { asyncRoute } from "../http";

export const externalMcpRouter = Router();

interface McpSession {
  tenantId: string;
  ownerId: string;
  conversationsByKnowledgeBase: Map<string, string>;
  pendingQueries: Map<string, McpQueryInput>;
}

const sessions = new Map<string, McpSession>();

const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const searchSchema = z.object({
  q: z.string().max(200).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const querySchema = z.object({
  knowledgeBaseId: z.string().min(1),
  message: z.string().trim().min(1).max(20_000),
  conversationId: z.string().trim().min(1).optional(),
  newConversation: z.boolean().optional().default(false),
  requestId: z.string().trim().min(1).max(512),
});

type McpQueryInput = z.infer<typeof querySchema>;

const tools = [
  {
    name: "knowledge_base_search",
    description: "Search the authenticated caller's query-ready knowledge bases.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Optional name or description search text." },
        cursor: { type: "string", description: "Opaque cursor returned by a previous search." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size; defaults to 20." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_base_query",
    description: "Ask one query-ready knowledge base. Within one MCP session, later new questions automatically continue the most recent server conversation for that knowledge base. Generate a requestId only for a new query. If the result says in_progress, retry with the exact retry arguments returned by the tool, especially the unchanged requestId; never generate a new requestId for that retry. A conversationId is server-issued UUID data, never a requestId; set newConversation true only to start a separate conversation.",
    inputSchema: {
      type: "object",
      properties: {
        knowledgeBaseId: { type: "string" },
        message: { type: "string" },
        conversationId: { type: "string", description: "Optional server-issued UUID. Normally omit it: the MCP session continues its current knowledge-base conversation automatically." },
        newConversation: { type: "boolean", description: "Set true only to intentionally start a separate conversation instead of continuing the current one." },
        requestId: { type: "string", description: "Caller-chosen idempotency key. Generate it once for a new query; retain it exactly when retrying an in-progress query." },
      },
      required: ["knowledgeBaseId", "message", "requestId"],
      additionalProperties: false,
    },
  },
];

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

function sessionFor(req: import("express").Request, ctx: TenantContext): McpSession | null {
  const id = req.header("mcp-session-id");
  if (!id) return null;
  const session = sessions.get(id) ?? null;
  if (!session || session.tenantId !== ctx.tenantId || session.ownerId !== ctx.ownerId) return null;
  return session;
}

async function callRest(pathname: string, req: import("express").Request, init: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${env.port}/api/v1${pathname}`, {
    ...init,
    headers: {
      authorization: req.header("authorization") ?? "",
      TenantID: req.header("TenantID") ?? req.header("tenant-id") ?? "",
      "x-user-id": req.header("x-user-id") ?? "",
      "content-type": "application/json",
      "x-knowledge-fabric-internal-protocol": "mcp",
      ...(init.headers ?? {}),
    },
  });
}

async function toolError(response: Response): Promise<{ isError: true; content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> }> {
  const body = await response.json().catch(() => null) as { code?: unknown; title?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "query_execution_failed";
  const title = typeof body?.title === "string" ? body.title : "Knowledge Fabric request failed";
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${title}` }],
    structuredContent: { code, status: response.status },
  };
}

async function drainStream(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  while (true) {
    const next = await reader.read();
    if (next.done) return;
  }
}

function inProgressToolResult(input: McpQueryInput, data: Record<string, unknown>) {
  const retryArguments = {
    knowledgeBaseId: input.knowledgeBaseId,
    message: input.message,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    requestId: input.requestId,
  };
  return {
    content: [{
      type: "text" as const,
      text: `Knowledge query is in progress. The server-issued conversationId is ${String(data.conversationId ?? "unknown")}; it is not the requestId. Retry knowledge_base_query after ${data.retryAfterMs ?? 60000}ms with these exact arguments; do not change requestId:\n${JSON.stringify(retryArguments)}`,
    }],
    structuredContent: { ...data, retryArguments },
  };
}

function completedToolResult(answer: string, conversationId: string) {
  return {
    content: [{
      type: "text" as const,
      text: `${answer}\n\n[Knowledge Fabric conversationId: ${conversationId}. For a later new question in this MCP session, omit conversationId and use a new requestId; the server will continue this conversation.]`,
    }],
    structuredContent: { conversationId, answer },
  };
}

function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function resolveQueryInput(session: McpSession, input: McpQueryInput): McpQueryInput {
  const pending = session.pendingQueries.get(input.requestId);
  if (pending) return pending;
  if (input.newConversation) return input;
  const currentConversationId = session.conversationsByKnowledgeBase.get(input.knowledgeBaseId);
  if (!currentConversationId) return input;
  return {
    ...input,
    conversationId: isUuid(input.conversationId) ? input.conversationId : currentConversationId,
  };
}

async function callTool(name: string, rawArguments: unknown, session: McpSession, req: import("express").Request): Promise<unknown> {
  if (name === "knowledge_base_search") {
    const input = searchSchema.parse(rawArguments ?? {});
    const query = new URLSearchParams();
    if (input.q) query.set("q", input.q);
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit) query.set("limit", String(input.limit));
    const response = await callRest(`/knowledge-bases${query.size ? `?${query}` : ""}`, req, { method: "GET" });
    if (!response.ok) return toolError(response);
    const body = await response.json() as { data: unknown };
    return { content: [{ type: "text" as const, text: JSON.stringify(body.data) }], structuredContent: body.data };
  }
  if (name === "knowledge_base_query") {
    const input = resolveQueryInput(session, querySchema.parse(rawArguments ?? {}));
    const response = await callRest(`/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/queries`, req, {
      method: "POST",
      headers: { "Idempotency-Key": input.requestId },
      body: JSON.stringify({ message: input.message, conversationId: input.conversationId, stream: true }),
    });
    if (response.status === 202) {
      const body = await response.json() as { data: Record<string, unknown> };
      const conversationId = body.data.conversationId;
      if (typeof conversationId === "string") session.conversationsByKnowledgeBase.set(input.knowledgeBaseId, conversationId);
      return inProgressToolResult(input, body.data);
    }
    if (!response.ok) return toolError(response);
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const conversationId = response.headers.get("x-conversation-id");
      if (!conversationId) return {
        isError: true,
        content: [{ type: "text", text: "query_execution_failed: Knowledge query did not create a conversation" }],
        structuredContent: { code: "query_execution_failed", status: 502 },
      };
      void drainStream(response).catch((error: unknown) => console.error("[external/mcp] query stream drain failed", error));
      session.conversationsByKnowledgeBase.set(input.knowledgeBaseId, conversationId);
      session.pendingQueries.set(input.requestId, input);
      return inProgressToolResult(input, {
          status: "in_progress",
          conversationId,
          requestId: input.requestId,
          retryAfterMs:60000,
          streamUrl: `/api/v1/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/conversations/${encodeURIComponent(conversationId)}/stream`,
      });
    }
    const body = await response.json() as { data?: { conversationId?: unknown; answer?: unknown } };
    const answer = typeof body.data?.answer === "string" ? body.data.answer : "";
    const conversationId = typeof body.data?.conversationId === "string" ? body.data.conversationId : null;
    if (!conversationId) return {
      isError: true,
      content: [{ type: "text", text: "query_execution_failed: Knowledge query did not return a conversation" }],
      structuredContent: { code: "query_execution_failed", status: 502 },
    };
    session.conversationsByKnowledgeBase.set(input.knowledgeBaseId, conversationId);
    session.pendingQueries.delete(input.requestId);
    return completedToolResult(answer, conversationId);
  }
  return null;
}

externalMcpRouter.post("/mcp", asyncRoute(async (req, res) => {
  const parsed = rpcRequestSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC request"));
  const rpc = parsed.data;
  let ctx: TenantContext;
  try {
    ctx = await requireGatewayTenantContext(req);
  } catch {
    return void res.status(401).json(rpcError(rpc.id, -32001, "Authentication required"));
  }

  if (rpc.method === "initialize") {
    const id = randomUUID();
    sessions.set(id, { tenantId: ctx.tenantId, ownerId: ctx.ownerId, conversationsByKnowledgeBase: new Map(), pendingQueries: new Map() });
    res.setHeader("Mcp-Session-Id", id);
    return void res.json(rpcResult(rpc.id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "knowledge-fabric", version: "1.0.0" },
    }));
  }

  const session = sessionFor(req, ctx);
  if (!session) return void res.status(400).json(rpcError(rpc.id, -32002, "Valid Mcp-Session-Id header required"));
  if (rpc.method === "notifications/initialized") return void res.sendStatus(202);
  if (rpc.method === "tools/list") return void res.json(rpcResult(rpc.id, { tools }));
  if (rpc.method !== "tools/call") return void res.status(404).json(rpcError(rpc.id, -32601, "Method not found"));

  const toolCall = z.object({ name: z.string().min(1), arguments: z.unknown().optional() }).safeParse(rpc.params);
  if (!toolCall.success) return void res.status(400).json(rpcError(rpc.id, -32602, "Invalid tools/call parameters"));
  try {
    const result = await callTool(toolCall.data.name, toolCall.data.arguments, session, req);
    if (!result) return void res.status(404).json(rpcError(rpc.id, -32602, "Unknown tool"));
    return void res.json(rpcResult(rpc.id, result));
  } catch (error) {
    if (error instanceof z.ZodError) return void res.status(400).json(rpcError(rpc.id, -32602, "Invalid tool arguments"));
    console.error("[external/mcp] tool call failed", error);
    return void res.status(500).json(rpcError(rpc.id, -32603, "Internal error"));
  }
}));

externalMcpRouter.get("/mcp", asyncRoute(async (req, res) => {
  const ctx = await requireGatewayTenantContext(req).catch(() => null);
  if (!ctx || !sessionFor(req, ctx)) return void res.sendStatus(401);
  res.status(405).setHeader("Allow", "POST").end();
}));
