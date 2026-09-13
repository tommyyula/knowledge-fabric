import { Router } from "express";
import { z } from "zod";
import { requireTenantContext } from "../auth/requireTenantContext";
import { asyncRoute } from "../http";
import { getAccessibleKnowledgeBaseProject, listAccessibleKnowledgeBaseProjects } from "../ontologies/repository";
import { workspacePath } from "../ontologies/workspace";
import { compareOperationRunsNewestFirst } from "../../src/lib/operation-run-order";
import { createConfiguredOperationRunStore } from "./configured-store";
import { decodeOperationRunCursor, encodeOperationRunCursor, operationRunCursor } from "./history";
import { toPublicOperationRun } from "./visibility";

export const operationsRouter = Router();

const listQuerySchema = z.object({
  ontologyId: z.string().trim().min(1).max(200).optional(),
  sessionId: z.string().trim().min(1).max(200).optional(),
  search: z.string().trim().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(2_000).transform((value, context) => {
    try {
      return decodeOperationRunCursor(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid Operation Run cursor" });
      return z.NEVER;
    }
  }).optional(),
});
const operationScopeSchema = z.object({
  ontologyId: z.string().trim().min(1).max(200),
});
const operationPatchSchema = operationScopeSchema.extend({
  title: z.string().trim().min(1).max(200),
}).strict();

function missingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

operationsRouter.get("/", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const query = listQuerySchema.parse(req.query);
  const accessibleProjects = query.ontologyId
    ? [await getAccessibleKnowledgeBaseProject(ctx.tenantId, ctx.ownerId, query.ontologyId)].filter((d) => d !== null)
    : await listAccessibleKnowledgeBaseProjects(ctx.tenantId, ctx.ownerId);

  if (query.ontologyId && accessibleProjects.length === 0) {
    return void res.status(404).json({ error: "Ontology not found" });
  }

  const candidates = (await Promise.all(accessibleProjects.map(({ project }) => createConfiguredOperationRunStore({
    workspaceRoot: workspacePath(project.tenantId, project.ownerId, project.id),
    tenantId: project.tenantId,
    ownerId: project.ownerId,
    knowledgeBaseId: project.id,
  }).list({
    conversationId: query.sessionId,
    search: query.search,
    cursor: query.cursor,
    limit: query.limit + 1,
  }))))
    .flat()
    .sort(compareOperationRunsNewestFirst);
  const hasMore = candidates.length > query.limit;
  const runs = candidates.slice(0, query.limit);
  const nextCursor = hasMore && runs.length
    ? encodeOperationRunCursor(operationRunCursor(runs[runs.length - 1]))
    : undefined;

  res.json({ data: { items: runs.map(toPublicOperationRun), nextCursor } });
}));

operationsRouter.patch("/:operationId", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const input = operationPatchSchema.parse(req.body ?? {});
  const decision = await getAccessibleKnowledgeBaseProject(ctx.tenantId, ctx.ownerId, input.ontologyId);
  if (!decision) return void res.status(404).json({ error: "Operation not found" });
  const project = decision.project;

  const root = workspacePath(project.tenantId, project.ownerId, project.id);
  const store = createConfiguredOperationRunStore({ workspaceRoot: root, tenantId: project.tenantId, ownerId: project.ownerId, knowledgeBaseId: project.id });
  const operationId = String(req.params.operationId);
  const run = await store.read(operationId).catch((error) => {
    if (missingFile(error)) return null;
    throw error;
  });
  if (!run || run.ontologyId !== project.id) {
    return void res.status(404).json({ error: "Operation not found" });
  }

  res.json({ data: toPublicOperationRun(await store.updateTitle(operationId, input.title)) });
}));

operationsRouter.delete("/:operationId", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const { ontologyId } = operationScopeSchema.parse(req.query);
  const decision = await getAccessibleKnowledgeBaseProject(ctx.tenantId, ctx.ownerId, ontologyId);
  if (!decision) return void res.status(404).json({ error: "Operation not found" });
  const project = decision.project;

  const root = workspacePath(project.tenantId, project.ownerId, project.id);
  const store = createConfiguredOperationRunStore({ workspaceRoot: root, tenantId: project.tenantId, ownerId: project.ownerId, knowledgeBaseId: project.id });
  const operationId = String(req.params.operationId);
  const run = await store.read(operationId).catch((error) => {
    if (missingFile(error)) return null;
    throw error;
  });
  if (!run || run.ontologyId !== project.id) {
    return void res.status(404).json({ error: "Operation not found" });
  }
  if (run.status === "running") {
    return void res.status(409).json({ error: "Running operations cannot be deleted" });
  }

  await store.delete(operationId);
  res.status(204).send();
}));
