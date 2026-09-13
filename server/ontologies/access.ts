import type { OntologyProject } from "../../src/contracts/ontology";
import type { TenantContext } from "../auth/requireTenantContext";
import {
  getAccessibleKnowledgeBaseProject,
  knowledgeBaseCapabilities,
  type EffectiveKnowledgeBaseRole,
  type KnowledgeBaseAccessSource,
} from "./repository";
import { workspacePath } from "./workspace";

export type KnowledgeBaseCapability =
  | "use"
  | "contribute"
  | "review"
  | "manageShares"
  | "manageManagers"
  | "editProfile"
  | "delete";

export interface KnowledgeBaseAccess {
  project: OntologyProject;
  actorTenantId: string;
  actorUserId: string;
  workspaceTenantId: string;
  workspaceOwnerId: string;
  role: EffectiveKnowledgeBaseRole;
  source: KnowledgeBaseAccessSource;
  workspaceRoot: string;
}

export async function resolveKnowledgeBaseAccess(
  ctx: Pick<TenantContext, "tenantId" | "ownerId">,
  ontologyId: string,
): Promise<KnowledgeBaseAccess | null> {
  const decision = await getAccessibleKnowledgeBaseProject(ctx.tenantId, ctx.ownerId, ontologyId);
  const project = decision?.project;
  if (!decision || !project?.tenantId || !project.ownerId || project.deletedAt) return null;
  return {
    project,
    actorTenantId: ctx.tenantId,
    actorUserId: ctx.ownerId,
    workspaceTenantId: project.tenantId,
    workspaceOwnerId: project.ownerId,
    role: decision.role,
    source: decision.source,
    workspaceRoot: workspacePath(project.tenantId, project.ownerId, project.id),
  };
}

export function hasKnowledgeBaseCapability(access: KnowledgeBaseAccess, capability: KnowledgeBaseCapability): boolean {
  return knowledgeBaseCapabilities(access.role)[capability];
}

export function canManageRole(access: KnowledgeBaseAccess, role: EffectiveKnowledgeBaseRole): boolean {
  if (access.role === "owner") return role !== "owner";
  return access.role === "manager" && (role === "viewer" || role === "editor");
}
