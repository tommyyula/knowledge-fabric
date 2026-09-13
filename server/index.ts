import express from "express";
import path from "node:path";
import { env } from "./env";
import { preflightDatabase } from "./db/client";
import { ensureMigrations } from "./db/migrations";
import { errorHandler } from "./http";
import { chatRouter } from "./chat/routes";
import { filesRouter } from "./files/routes";
import { ontologiesRouter } from "./ontologies/routes";
import { authRouter } from "./auth/routes";
import { composioRouter } from "./composio/routes";
import { anthropicOpenAiProxyRouter } from "./proxy/anthropic-openai-proxy";
import { initializeAzureChatCompletionPool } from "./proxy/azure-chat-completion-pool";
import { resourceLibraryRouter } from "./resource-library/routes";
import { adminDataRouter } from "./admin-data/routes";
import { externalRouter } from "./external/routes";
import { externalMcpRouter } from "./external/mcp";
import { admitA2ARequest, a2aAgentCardHandler, a2aRestHandler, initializeA2A, requireA2AAuthentication } from "./external/a2a";
import { registerQueryReadinessProjection } from "./external/query-readiness";
import { supportRouter } from "./support/routes";
import { operationsRouter } from "./operations/routes";
import { videoSopRouter } from "./video-sop/routes";
import { initializeVideoSopJobs } from "./video-sop/runner";

const app = express();
initializeAzureChatCompletionPool();
registerQueryReadinessProjection();

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? "90mb", type: ["application/json", "application/a2a+json"] }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.header("origin") ?? "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, TenantID, tenant-id, x-tenant-id, x-user-id");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

app.get("/healthz", (_req, res) => res.json({ ok: true, service: "ontology-studio", database: Boolean(env.databaseUrl) }));
app.get("/docs/external-knowledge-query-a2a", (_req, res) => res.sendFile(path.resolve("docs/external-knowledge-query-a2a.md")));
app.use("/.well-known/agent-card.json", a2aAgentCardHandler);
app.use("/api/auth", authRouter);
app.use("/api/composio", composioRouter);
app.use("/api/v1/ontologies", ontologiesRouter);
app.use("/api/v1/ontologies", filesRouter);
app.use("/api/v1/ontologies", chatRouter);
app.use("/api/v1/resource-library", resourceLibraryRouter);
app.use("/api/v1/video-sop", videoSopRouter);
app.use("/api/v1/admin/data", adminDataRouter);
app.use("/api/v1/support", supportRouter);
app.use("/api/v1/operations", operationsRouter);
app.use("/api/v1", externalRouter);
app.use("/api/v1", externalMcpRouter);
app.use("/api/v1/a2a", requireA2AAuthentication, admitA2ARequest, a2aRestHandler);
app.use("/api/proxy", anthropicOpenAiProxyRouter);
app.use(errorHandler);

await preflightDatabase();
await ensureMigrations();
await initializeVideoSopJobs();
await initializeA2A();
app.listen(env.port, () => {
  console.log(`[ontology-studio] server listening on http://localhost:${env.port}`);
});
