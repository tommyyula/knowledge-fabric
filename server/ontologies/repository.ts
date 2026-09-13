import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import type { JourneyFlow, JourneyPhase, JourneyState, OntologyMessage, OntologyProject, OntologySession } from "../../src/contracts/ontology";
import { pool, query } from "../db/client";
import { env } from "../env";
import {
  deleteScopedOperationRows,
  removeOperationRunFilesBestEffort,
  type OperationDeletionScope,
} from "../operations/postgres-deletion";
import { readJourneyState, workspacePath } from "./workspace";

export type KnowledgeBaseRole = "viewer" | "editor" | "manager";
export type EffectiveKnowledgeBaseRole = KnowledgeBaseRole | "owner";
export type KnowledgeBaseShareScope = "user" | "tenant";
export type KnowledgeBaseAccessSource = "owner" | "member" | "tenant";

export interface KnowledgeBaseShare {
  id: string;
  ontologyId: string;
  scope: KnowledgeBaseShareScope;
  subjectUserId?: string;
  subjectTenantId: string;
  subjectUsername?: string;
  subjectUseremail?: string;
  subjectCompanyname?: string;
  role: KnowledgeBaseRole;
  createdByUserId: string;
  createdByUsername?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingKnowledgeBaseInvitation {
  id: string;
  ontologyId: string;
  email: string;
  role: KnowledgeBaseRole;
  tokenHash: string;
  createdByUserId: string;
  deliveryStatus: "pending" | "sent" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseChangeRecord {
  id: string;
  ontologyId: string;
  workspaceTenantId: string;
  workspaceOwnerId: string;
  actorTenantId: string;
  actorUserId: string;
  actorDisplayName: string;
  protocol: "workbench" | "rest" | "mcp" | "a2a";
  authorizationRole: EffectiveKnowledgeBaseRole;
  authorizationSource: KnowledgeBaseAccessSource;
  action: string;
  outcome: "applied" | "rejected" | "failed";
  correlationId?: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationSnapshotRecord {
  id: string;
  token: string;
  sourceSessionId: string;
  sourceOntologyId: string;
  ownerTenantId: string;
  ownerUserId: string;
  messages: Array<{ role: "user" | "assistant"; content: string; createdAt?: string }>;
  createdAt: string;
  revokedAt?: string;
}

export interface AccessibleKnowledgeBaseProject {
  project: OntologyProject;
  role: EffectiveKnowledgeBaseRole;
  source: KnowledgeBaseAccessSource;
}

const memory = {
  projects: new Map<string, OntologyProject & { tenantId: string; ownerId: string }>(),
  sessions: new Map<string, OntologySession & { tenantId: string; ownerId: string; ontologyId: string }>(),
  messages: new Map<string, OntologyMessage[]>(),
  events: [] as Array<{ tenantId: string; ontologyId: string; sessionId?: string; runId?: string; sequence?: number; event: unknown; createdAt: string }>,
  queryReadiness: new Map<string, QueryReadinessProjection>(),
  externalQueryIdempotency: new Map<string, ExternalQueryIdempotencyRecord>(),
  externalAccessAuditEvents: [] as ExternalAccessAuditEvent[],
  shares: new Map<string, KnowledgeBaseShare>(),
  pendingInvitations: new Map<string, PendingKnowledgeBaseInvitation>(),
  changeRecords: [] as KnowledgeBaseChangeRecord[],
  conversationSnapshots: new Map<string, ConversationSnapshotRecord>(),
  tombstonePreferences: new Map<string, { ontologyId: string; tenantId: string; userId: string; placeholderRemovedAt?: string; keepConversations: boolean; updatedAt: string }>(),
};

const memoryStorePath = path.resolve(env.workspaceRoot, "..", "ontology-store.json");
let memoryHydrated = false;

interface MemorySnapshot {
  projects?: Array<OntologyProject & { tenantId: string; ownerId: string }>;
  sessions?: Array<OntologySession & { tenantId: string; ownerId: string; ontologyId: string }>;
  messages?: Record<string, OntologyMessage[]>;
  events?: Array<{ tenantId: string; ontologyId: string; sessionId?: string; runId?: string; sequence?: number; event: unknown; createdAt: string }>;
  queryReadiness?: QueryReadinessProjection[];
  externalQueryIdempotency?: ExternalQueryIdempotencyRecord[];
  externalAccessAuditEvents?: ExternalAccessAuditEvent[];
  shares?: KnowledgeBaseShare[];
  pendingInvitations?: PendingKnowledgeBaseInvitation[];
  changeRecords?: KnowledgeBaseChangeRecord[];
  conversationSnapshots?: ConversationSnapshotRecord[];
  tombstonePreferences?: Array<{ ontologyId: string; tenantId: string; userId: string; placeholderRemovedAt?: string; keepConversations: boolean; updatedAt: string }>;
}

export interface QueryReadinessProjection {
  tenantId: string;
  ownerId: string;
  ontologyId: string;
  flow: JourneyFlow;
  phase: JourneyPhase;
  queryReady: boolean;
  projectedAt: string;
}

export interface QueryReadyProjectCursor {
  updatedAt: string;
  ontologyId: string;
}

export interface ExternalQueryIdempotencyRecord {
  tenantId: string;
  ownerId: string;
  ontologyId: string;
  keyHash: string;
  requestFingerprint: string;
  conversationId: string;
  status: "in_progress" | "completed";
  runId?: string;
  answer?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ExternalAccessAuditEvent {
  id: string;
  requestId: string;
  protocol: "rest" | "mcp" | "a2a";
  operation: "knowledge_base_search" | "knowledge_base_query";
  tenantId: string;
  ownerId: string;
  ontologyId?: string;
  workspaceTenantId?: string;
  workspaceOwnerId?: string;
  authorizationRole?: EffectiveKnowledgeBaseRole;
  authorizationSource?: KnowledgeBaseAccessSource;
  idempotencyKeyHash?: string;
  outcome: "success" | "error";
  errorCode?: string;
  status: number;
  durationMs: number;
  createdAt: string;
  expiresAt: string;
}

function externalQueryIdempotencyMemoryKey(input: Pick<ExternalQueryIdempotencyRecord, "tenantId" | "ownerId" | "ontologyId" | "keyHash">): string {
  return `${input.tenantId}\u0000${input.ownerId}\u0000${input.ontologyId}\u0000${input.keyHash}`;
}

function timeAgoFrom(updatedAt: number): string {
  const diffMs = Math.max(0, Date.now() - updatedAt);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 2 * day) return "yesterday";
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return new Date(updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function latestUserMessageAt(messages: readonly OntologyMessage[] | undefined): number | null {
  let latest: number | null = null;
  for (const message of messages ?? []) {
    if (message.role !== "user" || !message.createdAt) continue;
    const value = Date.parse(message.createdAt);
    if (!Number.isFinite(value)) continue;
    latest = latest === null ? value : Math.max(latest, value);
  }
  return latest;
}

function normalizeMemorySession(
  session: OntologySession & { tenantId: string; ownerId: string; ontologyId: string },
  messages?: readonly OntologyMessage[],
): OntologySession & { tenantId: string; ownerId: string; ontologyId: string } {
  const updatedAt = Number(session.updatedAt || Date.parse(session.createdAt ?? "") || Date.now());
  const createdAt = Date.parse(session.createdAt ?? "");
  const lastActiveAt = Number(session.lastActiveAt || latestUserMessageAt(messages) || (Number.isFinite(createdAt) ? createdAt : updatedAt));
  return {
    ...session,
    updatedAt,
    lastActiveAt,
    timeAgo: timeAgoFrom(lastActiveAt),
  };
}

function ontologyWorkspacePath(tenantId: string, ownerId: string, ontologyId: string): string {
  return path.join(env.workspaceRoot, "tenants", tenantId, "users", ownerId, "ontologies", ontologyId);
}

function projectStatusFromJourneyState(state: JourneyState): OntologyProject["status"] {
  return state.flow === "build" && state.phase !== "ready" ? "bootstrapping" : "active";
}

async function inferProjectStatusFromWorkspace(ontologyRoot: string, fallback: OntologyProject["status"]): Promise<OntologyProject["status"]> {
  try {
    const stat = await fs.stat(ontologyRoot).catch(() => null);
    if (!stat?.isDirectory()) return fallback;
    return projectStatusFromJourneyState(await readJourneyState(ontologyRoot));
  } catch {
    return fallback;
  }
}

async function refreshMemoryProjectStatusesFromWorkspaces(): Promise<boolean> {
  let changed = false;
  for (const [projectId, project] of memory.projects.entries()) {
    const ontologyRoot = ontologyWorkspacePath(project.tenantId, project.ownerId, project.id);
    const status = await inferProjectStatusFromWorkspace(ontologyRoot, project.status);
    if (status === project.status) continue;
    memory.projects.set(projectId, { ...project, status });
    changed = true;
  }
  return changed;
}

async function hydrateMemory(): Promise<void> {
  if (pool || memoryHydrated) return;
  memoryHydrated = true;
  try {
    const snapshot = JSON.parse(await fs.readFile(memoryStorePath, "utf-8")) as MemorySnapshot;
    for (const project of snapshot.projects ?? []) memory.projects.set(project.id, project);
    for (const session of snapshot.sessions ?? []) memory.sessions.set(session.id, session);
    for (const [sessionId, messages] of Object.entries(snapshot.messages ?? {})) memory.messages.set(sessionId, messages);
    for (const [sessionId, session] of memory.sessions.entries()) {
      memory.sessions.set(sessionId, normalizeMemorySession(session, memory.messages.get(sessionId)));
    }
    memory.events = snapshot.events ?? [];
    for (const projection of snapshot.queryReadiness ?? []) {
      memory.queryReadiness.set(projection.ontologyId, projection);
    }
    for (const record of snapshot.externalQueryIdempotency ?? []) {
      if (Date.parse(record.expiresAt) > Date.now()) memory.externalQueryIdempotency.set(externalQueryIdempotencyMemoryKey(record), record);
    }
    memory.externalAccessAuditEvents = snapshot.externalAccessAuditEvents ?? [];
    for (const share of snapshot.shares ?? []) memory.shares.set(share.id, share);
    for (const invitation of snapshot.pendingInvitations ?? []) memory.pendingInvitations.set(invitation.id, invitation);
    memory.changeRecords = snapshot.changeRecords ?? [];
    for (const conversationSnapshot of snapshot.conversationSnapshots ?? []) {
      memory.conversationSnapshots.set(conversationSnapshot.id, conversationSnapshot);
    }
    for (const preference of snapshot.tombstonePreferences ?? []) {
      memory.tombstonePreferences.set(`${preference.ontologyId}\u0000${preference.tenantId}\u0000${preference.userId}`, preference);
    }
    if (await refreshMemoryProjectStatusesFromWorkspaces()) await persistMemory();
    return;
  } catch {
    await recoverMemoryFromWorkspaces();
    await persistMemory();
  }
}

async function persistMemory(): Promise<void> {
  if (pool) return;
  const snapshot: MemorySnapshot = {
    projects: [...memory.projects.values()],
    sessions: [...memory.sessions.values()],
    messages: Object.fromEntries(memory.messages.entries()),
    events: memory.events,
    queryReadiness: [...memory.queryReadiness.values()],
    externalQueryIdempotency: [...memory.externalQueryIdempotency.values()],
    externalAccessAuditEvents: memory.externalAccessAuditEvents,
    shares: [...memory.shares.values()],
    pendingInvitations: [...memory.pendingInvitations.values()],
    changeRecords: memory.changeRecords,
    conversationSnapshots: [...memory.conversationSnapshots.values()],
    tombstonePreferences: [...memory.tombstonePreferences.values()],
  };
  await fs.mkdir(path.dirname(memoryStorePath), { recursive: true });
  await fs.writeFile(memoryStorePath, JSON.stringify(snapshot, null, 2), "utf-8");
}

async function recoverMemoryFromWorkspaces(): Promise<void> {
  const root = path.resolve(env.workspaceRoot, "tenants");
  const tenants = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const tenantEntry of tenants) {
    if (!tenantEntry.isDirectory()) continue;
    const tenantId = tenantEntry.name;
    const usersRoot = path.join(root, tenantId, "users");
    const users = await fs.readdir(usersRoot, { withFileTypes: true }).catch(() => []);
    for (const userEntry of users) {
      if (!userEntry.isDirectory()) continue;
      const ownerId = userEntry.name;
      const ontologiesRoot = path.join(usersRoot, ownerId, "ontologies");
      const ontologies = await fs.readdir(ontologiesRoot, { withFileTypes: true }).catch(() => []);
      for (const ontologyEntry of ontologies) {
        if (!ontologyEntry.isDirectory()) continue;
        const ontologyId = ontologyEntry.name;
        const ontologyRoot = path.join(ontologiesRoot, ontologyId);
        const stat = await fs.stat(ontologyRoot).catch(() => null);
        const createdAt = stat?.birthtime?.toISOString() ?? new Date().toISOString();
        const updatedAt = stat?.mtime?.toISOString() ?? createdAt;
        const name = await recoverProjectName(ontologyRoot, ontologyId);
        const status = await inferProjectStatusFromWorkspace(ontologyRoot, "active");
        const project: OntologyProject & { tenantId: string; ownerId: string } = {
          id: ontologyId,
          tenantId,
          ownerId,
          name,
          description: "Recovered from local ontology workspace.",
          pageCount: 1,
          status,
          color: "#8ab4f8",
          emoji: "📚",
          favorite: false,
          lastUpdated: updatedAt.slice(0, 10),
          createdAt,
          updatedAt,
        };
        memory.projects.set(project.id, project);
        const sessionId = randomUUID();
        const session: OntologySession & { tenantId: string; ownerId: string; ontologyId: string } = {
          id: sessionId,
          ontologyId,
          projectId: ontologyId,
          projectName: name,
          projectColor: project.color,
          preview: "Recovered workspace session",
          updatedAt: Date.parse(updatedAt),
          lastActiveAt: Date.parse(createdAt),
          timeAgo: timeAgoFrom(Date.parse(createdAt)),
          claudeSessionId: null,
          createdAt,
          tenantId,
          ownerId,
        };
        memory.sessions.set(sessionId, session);
        memory.messages.set(sessionId, []);
      }
    }
  }
}

function markdownHeading(content: string): string | null {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

async function recoverProjectName(ontologyRoot: string, fallback: string): Promise<string> {
  const bootstrapResult = await readJsonFile(path.join(ontologyRoot, "bootstrap-result.json"));
  const bootstrapResultName = stringField(bootstrapResult, "name");
  if (bootstrapResultName) return bootstrapResultName;

  const journeyState = await readJsonFile(path.join(ontologyRoot, ".runtime", "journey-state.json"));
  const bootstrap = journeyState && typeof journeyState === "object" && !Array.isArray(journeyState)
    ? (journeyState as Record<string, unknown>).bootstrap
    : null;
  const journeyResult = bootstrap && typeof bootstrap === "object" && !Array.isArray(bootstrap)
    ? (bootstrap as Record<string, unknown>).result
    : null;
  const journeyResultName = stringField(journeyResult, "name") ?? stringField(bootstrap, "name");
  if (journeyResultName) return journeyResultName;

  for (const relative of ["knowledge/index.md", "wiki/index.md"]) {
    const index = await fs.readFile(path.join(ontologyRoot, relative), "utf-8").catch(() => "");
    const heading = markdownHeading(index);
    if (heading) return heading;
  }

  const claude = await fs.readFile(path.join(ontologyRoot, "CLAUDE.md"), "utf-8").catch(() => "");
  const claudeHeading = claude.match(/^#\s+(.+?)(?:\s+(?:Ontology|Knowledge Base) Agent)?\s*$/m)?.[1]?.trim();
  return claudeHeading || `Recovered Ontology ${fallback.slice(0, 8)}`;
}

export interface OntologyRunEventRecord {
  tenantId: string;
  ontologyId: string;
  sessionId?: string;
  runId?: string;
  sequence?: number;
  event: unknown;
  createdAt: string;
}

export interface OntologyRunStatus {
  runId: string | null;
  active: boolean;
  completed: boolean;
  eventCount: number;
  lastSequence: number | null;
  updatedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isTerminalRunEvent(event: unknown): boolean {
  if (!isRecord(event) || typeof event.type !== "string") return false;
  return event.type === "message" || event.type === "error";
}

function toProject(row: Record<string, unknown>): OntologyProject {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    pageCount: Number(row.page_count ?? 1),
    status: (row.status as OntologyProject["status"]) ?? "active",
    color: String(row.color ?? "#8ab4f8"),
    emoji: String(row.emoji ?? "📚"),
    favorite: row.favorite === true || row.favorite === "true",
    lastUpdated: new Date(String(row.updated_at ?? Date.now())).toISOString().slice(0, 10),
    createdAt: new Date(String(row.created_at ?? Date.now())).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? Date.now())).toISOString(),
    deletedAt: row.deleted_at ? new Date(String(row.deleted_at)).toISOString() : undefined,
  };
}

function toSession(row: Record<string, unknown>, project?: OntologyProject): OntologySession {
  const updated = new Date(String(row.updated_at ?? Date.now())).getTime();
  const lastActive = new Date(String(row.last_active_at ?? row.created_at ?? row.updated_at ?? Date.now())).getTime();
  return {
    id: String(row.id),
    ontologyId: String(row.ontology_id),
    projectId: String(row.ontology_id),
    projectName: project?.name ?? "Ontology",
    projectColor: project?.color ?? "#8ab4f8",
    preview: String(row.preview ?? "New ontology session"),
    origin: row.origin === "external" ? "external" : "workbench",
    updatedAt: updated,
    lastActiveAt: lastActive,
    timeAgo: timeAgoFrom(lastActive),
    claudeSessionId: row.claude_session_id ? String(row.claude_session_id) : null,
    createdAt: new Date(String(row.created_at ?? Date.now())).toISOString(),
  };
}

function withProjectSessionIdentity(
  session: OntologySession & { tenantId: string; ownerId: string; ontologyId: string },
  project: OntologyProject,
): OntologySession & { tenantId: string; ownerId: string; ontologyId: string } {
  const updatedAt = Number(session.updatedAt || Date.now());
  const lastActiveAt = Number(session.lastActiveAt || updatedAt);
  return {
    ...session,
    projectName: project.name,
    projectColor: project.color,
    updatedAt,
    lastActiveAt,
    timeAgo: timeAgoFrom(lastActiveAt),
  };
}

async function touchSessionUpdated(ctx: { tenantId: string; ownerId: string; ontologyId: string; sessionId: string }): Promise<void> {
  if (pool) {
    await query(
      "update ontology_sessions set updated_at=now() where tenant_id=$1 and owner_id=$2 and ontology_id=$3 and id=$4",
      [ctx.tenantId, ctx.ownerId, ctx.ontologyId, ctx.sessionId],
    );
    return;
  }
  const session = memory.sessions.get(ctx.sessionId);
  if (!session || session.tenantId !== ctx.tenantId || session.ownerId !== ctx.ownerId || session.ontologyId !== ctx.ontologyId) return;
  const updatedAt = Date.now();
  const lastActiveAt = Number(session.lastActiveAt || session.updatedAt || updatedAt);
  memory.sessions.set(ctx.sessionId, { ...session, updatedAt, lastActiveAt, timeAgo: timeAgoFrom(lastActiveAt) });
}

async function touchSessionUserActivity(ctx: { tenantId: string; ownerId: string; ontologyId: string; sessionId: string }): Promise<void> {
  if (pool) {
    await query(
      "update ontology_sessions set updated_at=now(), last_active_at=now() where tenant_id=$1 and owner_id=$2 and ontology_id=$3 and id=$4",
      [ctx.tenantId, ctx.ownerId, ctx.ontologyId, ctx.sessionId],
    );
    return;
  }
  const session = memory.sessions.get(ctx.sessionId);
  if (!session || session.tenantId !== ctx.tenantId || session.ownerId !== ctx.ownerId || session.ontologyId !== ctx.ontologyId) return;
  const now = Date.now();
  memory.sessions.set(ctx.sessionId, { ...session, updatedAt: now, lastActiveAt: now, timeAgo: "just now" });
}

export async function listProjects(tenantId: string, ownerId: string): Promise<OntologyProject[]> {
  if (pool) {
    const res = await query<Record<string, unknown>>("select * from ontology_projects where tenant_id=$1 and owner_id=$2 and deleted_at is null order by updated_at desc", [tenantId, ownerId]);
    return res.rows.map(toProject);
  }
  await hydrateMemory();
  return [...memory.projects.values()].filter((p) => p.tenantId === tenantId && p.ownerId === ownerId && !p.deletedAt);
}

function roleRank(role: EffectiveKnowledgeBaseRole): number {
  return role === "owner" ? 4 : role === "manager" ? 3 : role === "editor" ? 2 : 1;
}

export function knowledgeBaseCapabilities(role: EffectiveKnowledgeBaseRole) {
  const contribute = role !== "viewer";
  const manageShares = role === "owner" || role === "manager";
  return {
    use: true,
    contribute,
    review: contribute,
    manageShares,
    manageManagers: role === "owner",
    editProfile: role === "owner",
    delete: role === "owner",
  };
}

function toKnowledgeBaseShare(row: Record<string, unknown>): KnowledgeBaseShare {
  return {
    id: String(row.id),
    ontologyId: String(row.ontology_id),
    scope: row.scope === "tenant" ? "tenant" : "user",
    subjectUserId: row.subject_user_id ? String(row.subject_user_id) : undefined,
    subjectTenantId: String(row.subject_tenant_id),
    subjectUsername: row.subject_username ? String(row.subject_username) : undefined,
    subjectUseremail: row.subject_useremail ? String(row.subject_useremail) : undefined,
    subjectCompanyname: row.subject_companyname ? String(row.subject_companyname) : undefined,
    role: row.role === "manager" ? "manager" : row.role === "editor" ? "editor" : "viewer",
    createdByUserId: String(row.created_by_user_id),
    createdByUsername: row.created_by_username ? String(row.created_by_username) : undefined,
    createdAt: new Date(String(row.created_at ?? Date.now())).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? Date.now())).toISOString(),
  };
}

function shareApplies(share: KnowledgeBaseShare, tenantId: string, userId: string, project: OntologyProject): boolean {
  if (share.ontologyId !== project.id) return false;
  if (share.scope === "user") return share.subjectTenantId === tenantId && share.subjectUserId === userId;
  return share.subjectTenantId === project.tenantId && project.tenantId === tenantId && share.role !== "manager";
}

function withAccess(project: OntologyProject, role: EffectiveKnowledgeBaseRole, source: KnowledgeBaseAccessSource): OntologyProject {
  return { ...project, accessRole: role, accessSource: source, capabilities: knowledgeBaseCapabilities(role) };
}

export async function listAccessibleKnowledgeBaseProjects(tenantId: string, userId: string): Promise<AccessibleKnowledgeBaseProject[]> {
  if (pool) {
    const result = await query<Record<string, unknown>>(
      `select p.*, s.role as share_role, s.scope as share_scope,
              s.created_by_username as share_created_by_username,
              tp.placeholder_removed_at, tp.keep_conversations
       from ontology_projects p
       left join ontology_shares s on s.ontology_id=p.id and (
         (s.scope='user' and s.subject_user_id=$2 and s.subject_tenant_id=$1)
         or (s.scope='tenant' and s.role in ('viewer','editor') and p.tenant_id=$1 and s.subject_tenant_id=$1)
       )
       left join ontology_tombstone_preferences tp
         on tp.ontology_id=p.id and tp.tenant_id=$1 and tp.user_id=$2
       where (p.tenant_id=$1 and p.owner_id=$2 and p.deleted_at is null)
          or (p.tenant_id=$1 and p.owner_id=$2 and p.deleted_at is not null and tp.keep_conversations=true)
          or (s.id is not null and (p.deleted_at is null or tp.placeholder_removed_at is null))
          or (s.id is not null and p.deleted_at is not null and tp.placeholder_removed_at is not null and tp.keep_conversations=true)
       order by p.updated_at desc`,
      [tenantId, userId],
    );
    const decisions = new Map<string, AccessibleKnowledgeBaseProject>();
    for (const row of result.rows) {
      const project = toProject(row);
      const role: EffectiveKnowledgeBaseRole = project.tenantId === tenantId && project.ownerId === userId
        ? "owner"
        : row.share_role === "manager" ? "manager" : row.share_role === "editor" ? "editor" : "viewer";
      const source: KnowledgeBaseAccessSource = role === "owner" ? "owner" : row.share_scope === "tenant" ? "tenant" : "member";
      const sharedByUsername = role !== "owner" && row.share_created_by_username ? String(row.share_created_by_username) : undefined;
      const existing = decisions.get(project.id);
      if (!existing || roleRank(role) > roleRank(existing.role) || (role === existing.role && source === "member")) {
        const placeholderRemoved = Boolean(project.deletedAt && row.placeholder_removed_at);
        decisions.set(project.id, { project: { ...withAccess(project, role, source), ownerDisplayName: sharedByUsername, placeholderRemoved }, role, source });
      }
    }
    return [...decisions.values()];
  }
  await hydrateMemory();
  return [...memory.projects.values()].flatMap((project): AccessibleKnowledgeBaseProject[] => {
    const candidates: Array<{ role: EffectiveKnowledgeBaseRole; source: KnowledgeBaseAccessSource; sharedByUsername?: string }> = [];
    if (project.tenantId === tenantId && project.ownerId === userId) {
      if (!project.deletedAt) {
        candidates.push({ role: "owner", source: "owner" });
      } else {
        // owner 删除但保留会话：检查 tombstone 偏好
        const preference = memory.tombstonePreferences.get(`${project.id}\u0000${tenantId}\u0000${userId}`);
        if (preference?.keepConversations) candidates.push({ role: "owner", source: "owner" });
      }
    }
    for (const share of memory.shares.values()) {
      if (!shareApplies(share, tenantId, userId, project)) continue;
      const preference = memory.tombstonePreferences.get(`${project.id}\u0000${tenantId}\u0000${userId}`);
      // 已移除占位且不保留会话 → 完全跳过；已移除占位但保留会话 → 仍返回（带 deletedAt），供侧边栏 session 可见
      if (project.deletedAt && preference?.placeholderRemovedAt && !preference.keepConversations) continue;
      candidates.push({ role: share.role, source: share.scope === "tenant" ? "tenant" : "member", sharedByUsername: share.createdByUsername });
    }
    const decision = candidates.sort((left, right) => roleRank(right.role) - roleRank(left.role) || (left.source === "member" ? -1 : 1))[0];
    if (!decision) return [];
    const ownerDisplayName = decision.role !== "owner" ? decision.sharedByUsername : undefined;
    const preference = memory.tombstonePreferences.get(`${project.id}\u0000${tenantId}\u0000${userId}`);
    const placeholderRemoved = Boolean(project.deletedAt && preference?.placeholderRemovedAt);
    return [{ project: { ...withAccess(project, decision.role, decision.source), ownerDisplayName, placeholderRemoved }, ...decision }];
  }).sort((left, right) => (right.project.updatedAt ?? "").localeCompare(left.project.updatedAt ?? ""));
}

export async function getAccessibleKnowledgeBaseProject(tenantId: string, userId: string, ontologyId: string): Promise<AccessibleKnowledgeBaseProject | null> {
  const decision = (await listAccessibleKnowledgeBaseProjects(tenantId, userId)).find((candidate) => candidate.project.id === ontologyId) ?? null;
  return decision?.project.deletedAt ? null : decision;
}

export async function listKnowledgeBaseShares(tenantId: string, ownerId: string, ontologyId: string): Promise<KnowledgeBaseShare[]> {
  if (!await getProject(tenantId, ownerId, ontologyId)) return [];
  if (pool) {
    const result = await query<Record<string, unknown>>("select * from ontology_shares where ontology_id=$1 order by created_at", [ontologyId]);
    return result.rows.map(toKnowledgeBaseShare);
  }
  await hydrateMemory();
  return [...memory.shares.values()].filter((share) => share.ontologyId === ontologyId).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function upsertKnowledgeBaseShare(input: {
  tenantId: string;
  ownerId: string;
  ontologyId: string;
  scope: KnowledgeBaseShareScope;
  subjectUserId?: string;
  subjectTenantId: string;
  subjectUsername?: string;
  subjectUseremail?: string;
  subjectCompanyname?: string;
  role: KnowledgeBaseRole;
  createdByUserId: string;
  createdByUsername?: string;
}): Promise<KnowledgeBaseShare | null> {
  if (input.scope === "user" && !input.subjectUserId && !input.subjectUseremail) throw new Error("A Member Grant requires a user ID or email");
  if (input.scope === "tenant" && input.subjectTenantId !== input.tenantId) throw new Error("A Tenant Grant must target the Knowledge Base tenant");
  if (input.scope === "tenant" && input.role === "manager") throw new Error("A Tenant Grant cannot grant Manager");
  const project = await getProject(input.tenantId, input.ownerId, input.ontologyId);
  if (!project || project.deletedAt || project.status !== "active") return null;
  const now = new Date().toISOString();
  const candidate: KnowledgeBaseShare = {
    id: randomUUID(), ontologyId: input.ontologyId, scope: input.scope,
    subjectUserId: input.scope === "user" ? input.subjectUserId : undefined,
    subjectTenantId: input.subjectTenantId,
    subjectUsername: input.subjectUsername,
    subjectUseremail: input.subjectUseremail,
    subjectCompanyname: input.subjectCompanyname,
    role: input.role,
    createdByUserId: input.createdByUserId,
    createdByUsername: input.createdByUsername,
    createdAt: now, updatedAt: now,
  };
  if (pool) {
    const result = input.scope === "tenant"
      ? await query<Record<string, unknown>>(
          `insert into ontology_shares (id, ontology_id, scope, subject_tenant_id, role, created_by_user_id, created_by_username)
           values ($1,$2,'tenant',$3,$4,$5,$6)
           on conflict (ontology_id, subject_tenant_id) where scope='tenant' do update
           set role=excluded.role, created_by_user_id=excluded.created_by_user_id,
               created_by_username=excluded.created_by_username, updated_at=now()
           returning *`,
          [candidate.id, candidate.ontologyId, candidate.subjectTenantId, candidate.role, candidate.createdByUserId, candidate.createdByUsername ?? null],
        )
      : candidate.subjectUserId
        ? await query<Record<string, unknown>>(
            `insert into ontology_shares (id, ontology_id, scope, subject_user_id, subject_tenant_id, subject_username, subject_useremail, subject_companyname, role, created_by_user_id, created_by_username)
             values ($1,$2,'user',$3,$4,$5,$6,$7,$8,$9,$10)
             on conflict (ontology_id, subject_user_id, subject_tenant_id) where scope='user' do update
             set role=excluded.role, created_by_user_id=excluded.created_by_user_id,
                 subject_username=excluded.subject_username, subject_useremail=excluded.subject_useremail,
                 subject_companyname=excluded.subject_companyname,
                 created_by_username=excluded.created_by_username,
                 updated_at=now()
             returning *`,
            [candidate.id, candidate.ontologyId, candidate.subjectUserId, candidate.subjectTenantId, candidate.subjectUsername ?? null, candidate.subjectUseremail ?? null, candidate.subjectCompanyname ?? null, candidate.role, candidate.createdByUserId, candidate.createdByUsername ?? null],
          )
        // 外部用户（userId 为空），按邮箱+租户 upsert
        : await query<Record<string, unknown>>(
            `insert into ontology_shares (id, ontology_id, scope, subject_user_id, subject_tenant_id, subject_username, subject_useremail, subject_companyname, role, created_by_user_id, created_by_username)
             values ($1,$2,'user',null,$3,$4,$5,$6,$7,$8,$9)
             on conflict (ontology_id, subject_useremail, subject_tenant_id) where scope='user' and subject_user_id is null and subject_useremail is not null do update
             set role=excluded.role, created_by_user_id=excluded.created_by_user_id,
                 subject_username=excluded.subject_username,
                 subject_companyname=excluded.subject_companyname,
                 created_by_username=excluded.created_by_username,
                 updated_at=now()
             returning *`,
            [candidate.id, candidate.ontologyId, candidate.subjectTenantId, candidate.subjectUsername ?? null, candidate.subjectUseremail ?? null, candidate.subjectCompanyname ?? null, candidate.role, candidate.createdByUserId, candidate.createdByUsername ?? null],
          );
    return toKnowledgeBaseShare(result.rows[0]);
  }
  await hydrateMemory();
  const existing = [...memory.shares.values()].find((share) =>
    share.ontologyId === candidate.ontologyId &&
    share.scope === candidate.scope &&
    (candidate.subjectUserId
      ? share.subjectUserId === candidate.subjectUserId && share.subjectTenantId === candidate.subjectTenantId
      : share.subjectUseremail === candidate.subjectUseremail && share.subjectTenantId === candidate.subjectTenantId),
  );
  const next = existing ? { ...existing, role: candidate.role, createdByUserId: candidate.createdByUserId, updatedAt: now } : candidate;
  memory.shares.set(next.id, next);
  await persistMemory();
  return next;
}

export async function deleteKnowledgeBaseShare(tenantId: string, ownerId: string, ontologyId: string, shareId: string): Promise<boolean> {
  if (!await getProject(tenantId, ownerId, ontologyId)) return false;
  if (pool) return (await query<{ id: string }>("delete from ontology_shares where id=$1 and ontology_id=$2 returning id", [shareId, ontologyId])).rows.length > 0;
  await hydrateMemory();
  const share = memory.shares.get(shareId);
  if (!share || share.ontologyId !== ontologyId) return false;
  memory.shares.delete(shareId);
  await persistMemory();
  return true;
}

function toPendingInvitation(row: Record<string, unknown>): PendingKnowledgeBaseInvitation {
  return {
    id: String(row.id), ontologyId: String(row.ontology_id), email: String(row.email).toLowerCase(),
    role: row.role === "manager" ? "manager" : row.role === "editor" ? "editor" : "viewer",
    tokenHash: String(row.token_hash), createdByUserId: String(row.created_by_user_id),
    deliveryStatus: row.delivery_status === "sent" ? "sent" : row.delivery_status === "failed" ? "failed" : "pending",
    createdAt: new Date(String(row.created_at ?? Date.now())).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? Date.now())).toISOString(),
  };
}

export async function listPendingKnowledgeBaseInvitations(ontologyId: string): Promise<PendingKnowledgeBaseInvitation[]> {
  if (pool) return (await query<Record<string, unknown>>("select * from ontology_pending_invitations where ontology_id=$1 order by created_at", [ontologyId])).rows.map(toPendingInvitation);
  await hydrateMemory();
  return [...memory.pendingInvitations.values()].filter((invitation) => invitation.ontologyId === ontologyId).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function upsertPendingKnowledgeBaseInvitation(input: {
  ontologyId: string;
  email: string;
  role: KnowledgeBaseRole;
  tokenHash: string;
  createdByUserId: string;
}): Promise<PendingKnowledgeBaseInvitation> {
  const now = new Date().toISOString();
  const email = input.email.trim().toLowerCase();
  const candidate: PendingKnowledgeBaseInvitation = {
    id: randomUUID(), ontologyId: input.ontologyId, email, role: input.role,
    tokenHash: input.tokenHash, createdByUserId: input.createdByUserId,
    deliveryStatus: "pending", createdAt: now, updatedAt: now,
  };
  if (pool) {
    const result = await query<Record<string, unknown>>(
      `insert into ontology_pending_invitations (id, ontology_id, email, role, token_hash, created_by_user_id, delivery_status)
       values ($1,$2,$3,$4,$5,$6,'pending')
       on conflict (ontology_id, email) do update
       set role=excluded.role, token_hash=excluded.token_hash, created_by_user_id=excluded.created_by_user_id,
           delivery_status='pending', updated_at=now()
       returning *`,
      [candidate.id, candidate.ontologyId, candidate.email, candidate.role, candidate.tokenHash, candidate.createdByUserId],
    );
    return toPendingInvitation(result.rows[0]);
  }
  await hydrateMemory();
  const existing = [...memory.pendingInvitations.values()].find((invitation) => invitation.ontologyId === input.ontologyId && invitation.email === email);
  const next = existing ? { ...existing, role: input.role, tokenHash: input.tokenHash, createdByUserId: input.createdByUserId, deliveryStatus: "pending" as const, updatedAt: now } : candidate;
  memory.pendingInvitations.set(next.id, next);
  await persistMemory();
  return next;
}

export async function updatePendingInvitationDelivery(invitationId: string, deliveryStatus: PendingKnowledgeBaseInvitation["deliveryStatus"]): Promise<void> {
  if (pool) {
    await query("update ontology_pending_invitations set delivery_status=$2, updated_at=now() where id=$1", [invitationId, deliveryStatus]);
    return;
  }
  await hydrateMemory();
  const invitation = memory.pendingInvitations.get(invitationId);
  if (!invitation) return;
  memory.pendingInvitations.set(invitationId, { ...invitation, deliveryStatus, updatedAt: new Date().toISOString() });
  await persistMemory();
}

export async function findPendingInvitationByTokenHash(tokenHash: string): Promise<PendingKnowledgeBaseInvitation | null> {
  if (pool) {
    const result = await query<Record<string, unknown>>("select * from ontology_pending_invitations where token_hash=$1", [tokenHash]);
    return result.rows[0] ? toPendingInvitation(result.rows[0]) : null;
  }
  await hydrateMemory();
  return [...memory.pendingInvitations.values()].find((invitation) => invitation.tokenHash === tokenHash) ?? null;
}

export async function deletePendingKnowledgeBaseInvitation(ontologyId: string, invitationId: string): Promise<boolean> {
  if (pool) return (await query<{ id: string }>("delete from ontology_pending_invitations where id=$1 and ontology_id=$2 returning id", [invitationId, ontologyId])).rows.length > 0;
  await hydrateMemory();
  const invitation = memory.pendingInvitations.get(invitationId);
  if (!invitation || invitation.ontologyId !== ontologyId) return false;
  memory.pendingInvitations.delete(invitationId);
  await persistMemory();
  return true;
}

function toKnowledgeBaseChangeRecord(row: Record<string, unknown>): KnowledgeBaseChangeRecord {
  return {
    id: String(row.id), ontologyId: String(row.ontology_id), workspaceTenantId: String(row.workspace_tenant_id), workspaceOwnerId: String(row.workspace_owner_id),
    actorTenantId: String(row.actor_tenant_id), actorUserId: String(row.actor_user_id), actorDisplayName: String(row.actor_display_name),
    protocol: row.protocol as KnowledgeBaseChangeRecord["protocol"], authorizationRole: row.authorization_role as EffectiveKnowledgeBaseRole,
    authorizationSource: row.authorization_source as KnowledgeBaseAccessSource, action: String(row.action), outcome: row.outcome as KnowledgeBaseChangeRecord["outcome"],
    correlationId: row.correlation_id ? String(row.correlation_id) : undefined,
    details: row.details && typeof row.details === "object" ? row.details as Record<string, unknown> : undefined,
    createdAt: new Date(String(row.created_at ?? Date.now())).toISOString(),
  };
}

export async function recordKnowledgeBaseChange(input: Omit<KnowledgeBaseChangeRecord, "id" | "createdAt">): Promise<KnowledgeBaseChangeRecord> {
  const record: KnowledgeBaseChangeRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  if (pool) {
    const result = await query<Record<string, unknown>>(
      `insert into ontology_change_records
         (id, ontology_id, workspace_tenant_id, workspace_owner_id, actor_tenant_id, actor_user_id, actor_display_name,
          protocol, authorization_role, authorization_source, action, outcome, correlation_id, details)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [record.id, record.ontologyId, record.workspaceTenantId, record.workspaceOwnerId, record.actorTenantId, record.actorUserId, record.actorDisplayName,
        record.protocol, record.authorizationRole, record.authorizationSource, record.action, record.outcome, record.correlationId ?? null, record.details ?? null],
    );
    return toKnowledgeBaseChangeRecord(result.rows[0]);
  }
  await hydrateMemory();
  memory.changeRecords.push(record);
  await persistMemory();
  return record;
}

export async function listKnowledgeBaseChanges(ontologyId: string): Promise<KnowledgeBaseChangeRecord[]> {
  if (pool) return (await query<Record<string, unknown>>("select * from ontology_change_records where ontology_id=$1 order by created_at desc, id desc", [ontologyId])).rows.map(toKnowledgeBaseChangeRecord);
  await hydrateMemory();
  return memory.changeRecords.filter((record) => record.ontologyId === ontologyId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function toConversationSnapshot(row: Record<string, unknown>): ConversationSnapshotRecord {
  const messages = Array.isArray(row.messages) ? row.messages : [];
  return {
    id: String(row.id), token: String(row.token), sourceSessionId: String(row.source_session_id), sourceOntologyId: String(row.source_ontology_id),
    ownerTenantId: String(row.owner_tenant_id), ownerUserId: String(row.owner_user_id),
    messages: messages.flatMap((message): ConversationSnapshotRecord["messages"] => {
      if (!message || typeof message !== "object") return [];
      const value = message as Record<string, unknown>;
      if ((value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") return [];
      return [{ role: value.role, content: value.content, ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}) }];
    }),
    createdAt: new Date(String(row.created_at ?? Date.now())).toISOString(),
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : undefined,
  };
}

export async function createOrGetConversationSnapshot(input: Omit<ConversationSnapshotRecord, "id" | "createdAt">): Promise<ConversationSnapshotRecord> {
  if (pool) {
    const result = await query<Record<string, unknown>>(
      `insert into ontology_conversation_snapshots
         (id, token, source_session_id, source_ontology_id, owner_tenant_id, owner_user_id, messages)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (source_session_id) do update set source_session_id=excluded.source_session_id
       returning *`,
      [randomUUID(), input.token, input.sourceSessionId, input.sourceOntologyId, input.ownerTenantId, input.ownerUserId, JSON.stringify(input.messages)],
    );
    return toConversationSnapshot(result.rows[0]);
  }
  await hydrateMemory();
  const existing = [...memory.conversationSnapshots.values()].find((snapshot) => snapshot.sourceSessionId === input.sourceSessionId);
  if (existing) return existing;
  const snapshot: ConversationSnapshotRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  memory.conversationSnapshots.set(snapshot.id, snapshot);
  await persistMemory();
  return snapshot;
}

export async function getConversationSnapshotByToken(token: string): Promise<ConversationSnapshotRecord | null> {
  if (pool) {
    const result = await query<Record<string, unknown>>("select * from ontology_conversation_snapshots where token=$1", [token]);
    return result.rows[0] ? toConversationSnapshot(result.rows[0]) : null;
  }
  await hydrateMemory();
  return [...memory.conversationSnapshots.values()].find((snapshot) => snapshot.token === token) ?? null;
}

export async function deleteConversationSnapshotForSession(sourceSessionId: string): Promise<void> {
  if (pool) {
    await query("update ontology_conversation_snapshots set revoked_at=coalesce(revoked_at, now()) where source_session_id=$1", [sourceSessionId]);
    return;
  }
  await hydrateMemory();
  for (const [id, snapshot] of memory.conversationSnapshots.entries()) {
    if (snapshot.sourceSessionId === sourceSessionId) memory.conversationSnapshots.set(id, { ...snapshot, revokedAt: snapshot.revokedAt ?? new Date().toISOString() });
  }
  await persistMemory();
}

export async function listProjectsForReadinessProjection(): Promise<Array<OntologyProject & { tenantId: string; ownerId: string }>> {
  if (pool) {
    const res = await query<Record<string, unknown>>("select * from ontology_projects where deleted_at is null order by updated_at desc");
    return res.rows.map((row) => toProject(row) as OntologyProject & { tenantId: string; ownerId: string });
  }
  await hydrateMemory();
  return [...memory.projects.values()].filter((project) => !project.deletedAt);
}

export async function upsertQueryReadinessProjection(input: Omit<QueryReadinessProjection, "projectedAt">): Promise<QueryReadinessProjection> {
  const projection: QueryReadinessProjection = { ...input, projectedAt: new Date().toISOString() };
  if (pool) {
    const res = await query<Record<string, unknown>>(
      `insert into ontology_query_readiness (ontology_id, tenant_id, owner_id, flow, phase, query_ready, projected_at)
       values ($1,$2,$3,$4,$5,$6,now())
       on conflict (ontology_id) do update
       set tenant_id=excluded.tenant_id, owner_id=excluded.owner_id, flow=excluded.flow, phase=excluded.phase, query_ready=excluded.query_ready, projected_at=now()
       returning ontology_id, tenant_id, owner_id, flow, phase, query_ready, projected_at`,
      [input.ontologyId, input.tenantId, input.ownerId, input.flow, input.phase, input.queryReady],
    );
    const row = res.rows[0];
    return {
      ontologyId: String(row.ontology_id),
      tenantId: String(row.tenant_id),
      ownerId: String(row.owner_id),
      flow: row.flow as JourneyFlow,
      phase: row.phase as JourneyPhase,
      queryReady: Boolean(row.query_ready),
      projectedAt: new Date(String(row.projected_at)).toISOString(),
    };
  }
  await hydrateMemory();
  memory.queryReadiness.set(input.ontologyId, projection);
  await persistMemory();
  return projection;
}

export async function listQueryReadyProjects(input: {
  tenantId: string;
  ownerId: string;
  search: string;
  limit: number;
  after?: QueryReadyProjectCursor;
}): Promise<OntologyProject[]> {
  if (pool) {
    const filters = ["p.tenant_id=$1", "p.owner_id=$2", "r.query_ready=true"];
    const params: unknown[] = [input.tenantId, input.ownerId];
    if (input.search) {
      params.push(`%${input.search}%`);
      filters.push(`(p.name ilike $${params.length} or p.description ilike $${params.length})`);
    }
    if (input.after) {
      params.push(input.after.updatedAt, input.after.ontologyId);
      filters.push(`(p.updated_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }
    const res = await query<Record<string, unknown>>(
      `select p.* from ontology_projects p
       join ontology_query_readiness r on r.ontology_id=p.id
       where ${filters.join(" and ")}
       order by p.updated_at desc, p.id desc
       limit ${input.limit}`,
      params,
    );
    return res.rows.map(toProject);
  }
  await hydrateMemory();
  const search = input.search.toLocaleLowerCase();
  return [...memory.projects.values()]
    .filter((project) => project.tenantId === input.tenantId && project.ownerId === input.ownerId)
    .filter((project) => memory.queryReadiness.get(project.id)?.queryReady === true)
    .filter((project) => !search || `${project.name}\n${project.description}`.toLocaleLowerCase().includes(search))
    .filter((project) => {
      if (!input.after) return true;
      const updatedAt = project.updatedAt ?? "";
      return updatedAt < input.after.updatedAt || (updatedAt === input.after.updatedAt && project.id < input.after.ontologyId);
    })
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || right.id.localeCompare(left.id))
    .slice(0, input.limit);
}

export async function findExternalQueryIdempotency(input: {
  tenantId: string;
  ownerId: string;
  ontologyId: string;
  keyHash: string;
}): Promise<ExternalQueryIdempotencyRecord | null> {
  if (pool) {
    const res = await query<Record<string, unknown>>(
      `select tenant_id, owner_id, ontology_id, idempotency_key_hash, request_fingerprint, conversation_id, status, run_id, answer, created_at, expires_at
       from external_query_idempotency
       where tenant_id=$1 and owner_id=$2 and ontology_id=$3 and idempotency_key_hash=$4 and expires_at > now()`,
      [input.tenantId, input.ownerId, input.ontologyId, input.keyHash],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      tenantId: String(row.tenant_id),
      ownerId: String(row.owner_id),
      ontologyId: String(row.ontology_id),
      keyHash: String(row.idempotency_key_hash),
      requestFingerprint: String(row.request_fingerprint),
      conversationId: String(row.conversation_id),
      status: row.status as ExternalQueryIdempotencyRecord["status"],
      runId: row.run_id ? String(row.run_id) : undefined,
      answer: row.answer ? String(row.answer) : undefined,
      createdAt: new Date(String(row.created_at)).toISOString(),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
    };
  }
  await hydrateMemory();
  const key = externalQueryIdempotencyMemoryKey(input);
  const record = memory.externalQueryIdempotency.get(key) ?? null;
  if (!record) return null;
  if (Date.parse(record.expiresAt) > Date.now()) return record;
  memory.externalQueryIdempotency.delete(key);
  await persistMemory();
  return null;
}

export async function recordExternalQueryIdempotency(input: Omit<ExternalQueryIdempotencyRecord, "createdAt" | "expiresAt" | "status"> & { status?: ExternalQueryIdempotencyRecord["status"] }): Promise<ExternalQueryIdempotencyRecord> {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
  const record: ExternalQueryIdempotencyRecord = {
    ...input,
    status: input.status ?? "completed",
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  if (pool) {
    const res = await query<Record<string, unknown>>(
      `insert into external_query_idempotency
         (tenant_id, owner_id, ontology_id, idempotency_key_hash, request_fingerprint, conversation_id, status, run_id, answer, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       returning tenant_id, owner_id, ontology_id, idempotency_key_hash, request_fingerprint, conversation_id, status, run_id, answer, created_at, expires_at`,
      [record.tenantId, record.ownerId, record.ontologyId, record.keyHash, record.requestFingerprint, record.conversationId, record.status, record.runId ?? null, record.answer ?? null, record.expiresAt],
    );
    const row = res.rows[0];
    return {
      tenantId: String(row.tenant_id),
      ownerId: String(row.owner_id),
      ontologyId: String(row.ontology_id),
      keyHash: String(row.idempotency_key_hash),
      requestFingerprint: String(row.request_fingerprint),
      conversationId: String(row.conversation_id),
      status: row.status as ExternalQueryIdempotencyRecord["status"],
      runId: row.run_id ? String(row.run_id) : undefined,
      answer: row.answer ? String(row.answer) : undefined,
      createdAt: new Date(String(row.created_at)).toISOString(),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
    };
  }
  await hydrateMemory();
  memory.externalQueryIdempotency.set(externalQueryIdempotencyMemoryKey(record), record);
  await persistMemory();
  return record;
}

export async function updateExternalQueryIdempotency(input: {
  tenantId: string;
  ownerId: string;
  ontologyId: string;
  keyHash: string;
  status: ExternalQueryIdempotencyRecord["status"];
  runId?: string;
  answer?: string;
}): Promise<void> {
  if (pool) {
    await query(
      `update external_query_idempotency
       set status=$5, run_id=coalesce($6, run_id), answer=coalesce($7, answer)
       where tenant_id=$1 and owner_id=$2 and ontology_id=$3 and idempotency_key_hash=$4`,
      [input.tenantId, input.ownerId, input.ontologyId, input.keyHash, input.status, input.runId ?? null, input.answer ?? null],
    );
    return;
  }
  await hydrateMemory();
  const key = externalQueryIdempotencyMemoryKey(input);
  const current = memory.externalQueryIdempotency.get(key);
  if (!current) return;
  memory.externalQueryIdempotency.set(key, {
    ...current,
    status: input.status,
    runId: input.runId ?? current.runId,
    answer: input.answer ?? current.answer,
  });
  await persistMemory();
}

export async function deleteExternalQueryIdempotency(input: {
  tenantId: string;
  ownerId: string;
  ontologyId: string;
  keyHash: string;
}): Promise<void> {
  if (pool) {
    await query(
      "delete from external_query_idempotency where tenant_id=$1 and owner_id=$2 and ontology_id=$3 and idempotency_key_hash=$4",
      [input.tenantId, input.ownerId, input.ontologyId, input.keyHash],
    );
    return;
  }
  await hydrateMemory();
  memory.externalQueryIdempotency.delete(externalQueryIdempotencyMemoryKey(input));
  await persistMemory();
}

export async function recordExternalAccessAuditEvent(input: Omit<ExternalAccessAuditEvent, "id" | "createdAt" | "expiresAt">): Promise<ExternalAccessAuditEvent> {
  const createdAt = new Date();
  const event: ExternalAccessAuditEvent = {
    ...input,
    id: randomUUID(),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString(),
  };
  if (pool) {
    const res = await query<Record<string, unknown>>(
      `insert into external_access_audit_events
         (id, request_id, protocol, operation, tenant_id, owner_id, ontology_id,
          workspace_tenant_id, workspace_owner_id, authorization_role, authorization_source,
          idempotency_key_hash, outcome, error_code, status, duration_ms, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       returning *`,
      [event.id, event.requestId, event.protocol, event.operation, event.tenantId, event.ownerId, event.ontologyId ?? null,
        event.workspaceTenantId ?? null, event.workspaceOwnerId ?? null, event.authorizationRole ?? null, event.authorizationSource ?? null,
        event.idempotencyKeyHash ?? null, event.outcome, event.errorCode ?? null, event.status, event.durationMs, event.expiresAt],
    );
    const row = res.rows[0];
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      protocol: row.protocol as ExternalAccessAuditEvent["protocol"],
      operation: row.operation as ExternalAccessAuditEvent["operation"],
      tenantId: String(row.tenant_id),
      ownerId: String(row.owner_id),
      ontologyId: row.ontology_id ? String(row.ontology_id) : undefined,
      workspaceTenantId: row.workspace_tenant_id ? String(row.workspace_tenant_id) : undefined,
      workspaceOwnerId: row.workspace_owner_id ? String(row.workspace_owner_id) : undefined,
      authorizationRole: row.authorization_role ? row.authorization_role as EffectiveKnowledgeBaseRole : undefined,
      authorizationSource: row.authorization_source ? row.authorization_source as KnowledgeBaseAccessSource : undefined,
      idempotencyKeyHash: row.idempotency_key_hash ? String(row.idempotency_key_hash) : undefined,
      outcome: row.outcome as ExternalAccessAuditEvent["outcome"],
      errorCode: row.error_code ? String(row.error_code) : undefined,
      status: Number(row.status),
      durationMs: Number(row.duration_ms),
      createdAt: new Date(String(row.created_at)).toISOString(),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
    };
  }
  await hydrateMemory();
  memory.externalAccessAuditEvents.push(event);
  await persistMemory();
  return event;
}

export async function createProject(input: { tenantId: string; ownerId: string; name: string; description?: string; color?: string; emoji?: string }): Promise<OntologyProject> {
  const now = new Date().toISOString();
  const project: OntologyProject & { tenantId: string; ownerId: string } = {
    id: randomUUID(), tenantId: input.tenantId, ownerId: input.ownerId,
    name: input.name, description: input.description ?? "", pageCount: 1, status: "bootstrapping",
    color: input.color ?? "#8ab4f8", emoji: input.emoji ?? "📚", favorite: false, lastUpdated: now.slice(0, 10), createdAt: now, updatedAt: now,
  };
  if (pool) {
    const res = await query<Record<string, unknown>>(
      "insert into ontology_projects (id, tenant_id, owner_id, name, description, page_count, status, color, emoji) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *",
      [project.id, input.tenantId, input.ownerId, project.name, project.description, project.pageCount, project.status, project.color, project.emoji],
    );
    return toProject(res.rows[0]);
  }
  memory.projects.set(project.id, project);
  await persistMemory();
  return project;
}

export async function getProject(tenantId: string, ownerId: string, id: string): Promise<OntologyProject | null> {
  if (pool) {
    const res = await query<Record<string, unknown>>("select * from ontology_projects where tenant_id=$1 and owner_id=$2 and id=$3", [tenantId, ownerId, id]);
    return res.rows[0] ? toProject(res.rows[0]) : null;
  }
  await hydrateMemory();
  const p = memory.projects.get(id);
  return p && p.tenantId === tenantId && p.ownerId === ownerId ? p : null;
}

export async function getProjectById(id: string): Promise<OntologyProject | null> {
  if (pool) {
    const result = await query<Record<string, unknown>>("select * from ontology_projects where id=$1", [id]);
    return result.rows[0] ? toProject(result.rows[0]) : null;
  }
  await hydrateMemory();
  return memory.projects.get(id) ?? null;
}

export async function updateProject(tenantId: string, ownerId: string, id: string, updates: Partial<Pick<OntologyProject, "name" | "description" | "emoji" | "color" | "status" | "pageCount" | "favorite">>): Promise<OntologyProject | null> {
  if (pool) {
    const current = await getProject(tenantId, ownerId, id);
    if (!current) return null;
    const next = { ...current, ...updates };
    const res = await query<Record<string, unknown>>(
      "update ontology_projects set name=$4, description=$5, emoji=$6, color=$7, status=$8, page_count=$9, favorite=$10, updated_at=now() where tenant_id=$1 and owner_id=$2 and id=$3 returning *",
      [tenantId, ownerId, id, next.name, next.description, next.emoji, next.color, next.status, next.pageCount, Boolean(next.favorite)],
    );
    return res.rows[0] ? toProject(res.rows[0]) : null;
  }
  const current = await getProject(tenantId, ownerId, id) as (OntologyProject & { tenantId: string; ownerId: string }) | null;
  if (!current) return null;
  const next = { ...current, ...updates, updatedAt: new Date().toISOString(), lastUpdated: new Date().toISOString().slice(0, 10) };
  memory.projects.set(id, next);
  if (updates.name !== undefined || updates.color !== undefined) {
    for (const [sessionId, session] of memory.sessions.entries()) {
      if (session.tenantId !== tenantId || session.ownerId !== ownerId || session.ontologyId !== id) continue;
      memory.sessions.set(sessionId, {
        ...session,
        projectName: next.name,
        projectColor: next.color,
      });
    }
  }
  await persistMemory();
  return next;
}

interface PostgresOperationOwnerDeletion {
  scope: OperationDeletionScope;
  lockOwner: (client: pg.PoolClient) => Promise<boolean>;
  deleteOwner: (client: pg.PoolClient) => Promise<void>;
}

async function deletePostgresOperationOwner(
  database: pg.Pool,
  input: PostgresOperationOwnerDeletion,
): Promise<boolean> {
  const client = await database.connect();
  let operationIds: string[] = [];
  try {
    await client.query("begin");
    if (!(await input.lockOwner(client))) {
      await client.query("commit");
      return false;
    }
    operationIds = await deleteScopedOperationRows(client, input.scope);
    await input.deleteOwner(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  await removeOperationRunFilesBestEffort(
    workspacePath(input.scope.tenantId, input.scope.ownerId, input.scope.knowledgeBaseId),
    operationIds,
  );
  return true;
}

export async function softDeleteProject(tenantId: string, ownerId: string, id: string, deletedByUserId: string): Promise<OntologyProject | null> {
  const deletedAt = new Date().toISOString();
  if (pool) {
    const result = await query<Record<string, unknown>>(
      `update ontology_projects
       set deleted_at=coalesce(deleted_at, now()), deleted_by_user_id=$4, updated_at=now()
       where tenant_id=$1 and owner_id=$2 and id=$3
       returning *`,
      [tenantId, ownerId, id, deletedByUserId],
    );
    await query("update ontology_query_readiness set query_ready=false, projected_at=now() where ontology_id=$1", [id]);
    return result.rows[0] ? toProject(result.rows[0]) : null;
  }
  const project = await getProject(tenantId, ownerId, id) as (OntologyProject & { tenantId: string; ownerId: string }) | null;
  if (!project) return null;
  const next = { ...project, deletedAt: project.deletedAt ?? deletedAt, updatedAt: deletedAt, lastUpdated: deletedAt.slice(0, 10) };
  memory.projects.set(id, next);
  const readiness = memory.queryReadiness.get(id);
  if (readiness) memory.queryReadiness.set(id, { ...readiness, queryReady: false, projectedAt: deletedAt });
  await persistMemory();
  return next;
}

export async function setTombstonePreference(input: {
  ontologyId: string;
  tenantId: string;
  userId: string;
  removePlaceholder: boolean;
  keepConversations: boolean;
}): Promise<void> {
  const updatedAt = new Date().toISOString();
  if (pool) {
    await query(
      `insert into ontology_tombstone_preferences
         (ontology_id, tenant_id, user_id, placeholder_removed_at, keep_conversations, updated_at)
       values ($1,$2,$3,$4,$5,now())
       on conflict (ontology_id, tenant_id, user_id) do update
       set placeholder_removed_at=excluded.placeholder_removed_at,
           keep_conversations=excluded.keep_conversations, updated_at=now()`,
      [input.ontologyId, input.tenantId, input.userId, input.removePlaceholder ? updatedAt : null, input.keepConversations],
    );
    return;
  }
  await hydrateMemory();
  memory.tombstonePreferences.set(`${input.ontologyId}\u0000${input.tenantId}\u0000${input.userId}`, {
    ontologyId: input.ontologyId, tenantId: input.tenantId, userId: input.userId,
    placeholderRemovedAt: input.removePlaceholder ? updatedAt : undefined,
    keepConversations: input.keepConversations, updatedAt,
  });
  await persistMemory();
}

/** 查询某用户对已删除知识库的 tombstone 偏好，用于判断是否应保留只读会话 */
export async function getTombstonePreference(ontologyId: string, tenantId: string, userId: string): Promise<{ keepConversations: boolean; placeholderRemovedAt?: string } | null> {
  if (pool) {
    const result = await query<Record<string, unknown>>(
      `select keep_conversations, placeholder_removed_at from ontology_tombstone_preferences where ontology_id=$1 and tenant_id=$2 and user_id=$3`,
      [ontologyId, tenantId, userId],
    );
    if (!result.rows[0]) return null;
    return {
      keepConversations: Boolean(result.rows[0].keep_conversations),
      placeholderRemovedAt: result.rows[0].placeholder_removed_at ? String(result.rows[0].placeholder_removed_at) : undefined,
    };
  }
  await hydrateMemory();
  const pref = memory.tombstonePreferences.get(`${ontologyId}\u0000${tenantId}\u0000${userId}`);
  if (!pref) return null;
  return { keepConversations: pref.keepConversations, placeholderRemovedAt: pref.placeholderRemovedAt };
}

export async function deleteProject(tenantId: string, ownerId: string, id: string): Promise<boolean> {
  if (pool) {
    return deletePostgresOperationOwner(pool, {
      scope: { target: "knowledgeBase", tenantId, ownerId, knowledgeBaseId: id },
      lockOwner: async (client) => {
        const existing = await client.query<{ id: string }>(
          "select id from ontology_projects where tenant_id=$1 and owner_id=$2 and id=$3 for update",
          [tenantId, ownerId, id],
        );
        return existing.rows.length > 0;
      },
      deleteOwner: async (client) => {
        await client.query(
          "delete from ontology_projects where tenant_id=$1 and owner_id=$2 and id=$3",
          [tenantId, ownerId, id],
        );
      },
    });
  }
  const p = await getProject(tenantId, ownerId, id);
  if (!p) return false;
  const sessionIds = [...memory.sessions.values()]
    .filter((session) => session.tenantId === tenantId && session.ownerId === ownerId && session.ontologyId === id)
    .map((session) => session.id);
  memory.projects.delete(id);
  for (const sessionId of sessionIds) {
    memory.sessions.delete(sessionId);
    memory.messages.delete(sessionId);
  }
  memory.events = memory.events.filter((event) => !(event.tenantId === tenantId && event.ontologyId === id));
  memory.queryReadiness.delete(id);
  await persistMemory();
  return true;
}

export async function listSessions(tenantId: string, ownerId: string, ontologyId: string, accessibleProject?: OntologyProject): Promise<OntologySession[]> {
  const project = accessibleProject ?? await getProject(tenantId, ownerId, ontologyId);
  if (!project) return [];
  if (pool) {
    const res = await query<Record<string, unknown>>("select * from ontology_sessions where tenant_id=$1 and owner_id=$2 and ontology_id=$3 order by last_active_at desc, created_at desc", [tenantId, ownerId, ontologyId]);
    return res.rows.map((row) => toSession(row, project));
  }
  await hydrateMemory();
  return [...memory.sessions.values()]
    .filter((s) => s.tenantId === tenantId && s.ownerId === ownerId && s.ontologyId === ontologyId)
    .map((session) => withProjectSessionIdentity(session, project))
    .sort((a, b) => (b.lastActiveAt ?? b.updatedAt) - (a.lastActiveAt ?? a.updatedAt));
}

export async function createSession(
  tenantId: string,
  ownerId: string,
  ontologyId: string,
  preview = "New ontology session",
  origin: OntologySession["origin"] = "workbench",
  accessibleProject?: OntologyProject,
): Promise<OntologySession> {
  const project = accessibleProject ?? await getProject(tenantId, ownerId, ontologyId);
  if (!project) throw new Error("Ontology not found");
  const now = new Date().toISOString();
  const row = { id: randomUUID(), ontology_id: ontologyId, tenant_id: tenantId, owner_id: ownerId, preview, origin, claude_session_id: null, created_at: now, updated_at: now, last_active_at: now };
  if (pool) {
    const res = await query<Record<string, unknown>>("insert into ontology_sessions (id, ontology_id, tenant_id, owner_id, preview, origin, last_active_at) values ($1,$2,$3,$4,$5,$6,now()) returning *", [row.id, ontologyId, tenantId, ownerId, preview, origin]);
    return toSession(res.rows[0], project);
  }
  const session = { ...toSession(row, project), tenantId, ownerId, ontologyId };
  memory.sessions.set(session.id, session);
  memory.messages.set(session.id, []);
  await persistMemory();
  return session;
}

export async function getSession(tenantId: string, ownerId: string, ontologyId: string, sessionId: string, accessibleProject?: OntologyProject): Promise<OntologySession | null> {
  const sessions = await listSessions(tenantId, ownerId, ontologyId, accessibleProject);
  return sessions.find((s) => s.id === sessionId) ?? null;
}

export async function updateSession(
  tenantId: string,
  ownerId: string,
  ontologyId: string,
  sessionId: string,
  updates: Partial<Pick<OntologySession, "preview">>,
  accessibleProject?: OntologyProject,
): Promise<OntologySession | null> {
  const project = accessibleProject ?? await getProject(tenantId, ownerId, ontologyId);
  if (!project) return null;
  const current = await getSession(tenantId, ownerId, ontologyId, sessionId, project);
  if (!current) return null;
  const preview = updates.preview ?? current.preview;
  if (pool) {
    const res = await query<Record<string, unknown>>(
      "update ontology_sessions set preview=$5, updated_at=now() where tenant_id=$1 and owner_id=$2 and ontology_id=$3 and id=$4 returning *",
      [tenantId, ownerId, ontologyId, sessionId, preview],
    );
    return res.rows[0] ? toSession(res.rows[0], project) : null;
  }
  const session = memory.sessions.get(sessionId);
  if (!session || session.tenantId !== tenantId || session.ownerId !== ownerId || session.ontologyId !== ontologyId) return null;
  const updatedAt = Date.now();
  const lastActiveAt = Number(session.lastActiveAt || session.updatedAt || updatedAt);
  const next = { ...session, preview, updatedAt, lastActiveAt, timeAgo: timeAgoFrom(lastActiveAt) };
  memory.sessions.set(sessionId, next);
  await persistMemory();
  return next;
}

export async function deleteSession(tenantId: string, ownerId: string, ontologyId: string, sessionId: string): Promise<boolean> {
  await deleteConversationSnapshotForSession(sessionId);
  if (pool) {
    return deletePostgresOperationOwner(pool, {
      scope: { target: "conversation", tenantId, ownerId, knowledgeBaseId: ontologyId, conversationId: sessionId },
      lockOwner: async (client) => {
        const existing = await client.query<{ id: string }>(
          "select id from ontology_sessions where tenant_id=$1 and owner_id=$2 and ontology_id=$3 and id=$4 for update",
          [tenantId, ownerId, ontologyId, sessionId],
        );
        return existing.rows.length > 0;
      },
      deleteOwner: async (client) => {
        await client.query(
          "delete from ontology_sessions where tenant_id=$1 and owner_id=$2 and ontology_id=$3 and id=$4",
          [tenantId, ownerId, ontologyId, sessionId],
        );
      },
    });
  }
  const session = memory.sessions.get(sessionId);
  if (!session || session.tenantId !== tenantId || session.ownerId !== ownerId || session.ontologyId !== ontologyId) return false;
  memory.sessions.delete(sessionId);
  memory.messages.delete(sessionId);
  memory.events = memory.events.filter((event) => event.sessionId !== sessionId);
  await persistMemory();
  return true;
}

export async function deleteActorSessionsForKnowledgeBase(tenantId: string, ownerId: string, ontologyId: string, accessibleProject?: OntologyProject): Promise<number> {
  const sessions = await listSessions(tenantId, ownerId, ontologyId, accessibleProject);
  let deleted = 0;
  for (const session of sessions) {
    if (await deleteSession(tenantId, ownerId, ontologyId, session.id)) deleted += 1;
  }
  return deleted;
}

export async function appendMessage(ctx: { tenantId: string; ownerId: string; ontologyId: string; sessionId: string }, message: OntologyMessage): Promise<OntologyMessage> {
  const stored = { ...message, id: message.id ?? randomUUID(), ontologyId: ctx.ontologyId, sessionId: ctx.sessionId, createdAt: new Date().toISOString() };
  const userActivity = stored.role === "user";
  if (pool) {
    await query("insert into ontology_messages (id, ontology_id, session_id, tenant_id, owner_id, role, content, parts) values ($1,$2,$3,$4,$5,$6,$7,$8)", [stored.id, ctx.ontologyId, ctx.sessionId, ctx.tenantId, ctx.ownerId, stored.role, stored.content, stored.parts ? JSON.stringify(stored.parts) : null]);
    await (userActivity ? touchSessionUserActivity(ctx) : touchSessionUpdated(ctx));
  } else {
    const arr = memory.messages.get(ctx.sessionId) ?? [];
    arr.push(stored);
    memory.messages.set(ctx.sessionId, arr);
    await (userActivity ? touchSessionUserActivity(ctx) : touchSessionUpdated(ctx));
    await persistMemory();
  }
  return stored;
}

export async function listMessages(ctx: { tenantId: string; ownerId: string; ontologyId: string; sessionId: string }): Promise<OntologyMessage[]> {
  if (pool) {
    const res = await query<Record<string, unknown>>("select * from ontology_messages where tenant_id=$1 and owner_id=$2 and ontology_id=$3 and session_id=$4 order by created_at asc", [ctx.tenantId, ctx.ownerId, ctx.ontologyId, ctx.sessionId]);
    return res.rows.map((r) => ({
      id: String(r.id),
      ontologyId: String(r.ontology_id),
      sessionId: String(r.session_id),
      role: r.role as OntologyMessage["role"],
      content: String(r.content),
      parts: Array.isArray(r.parts) ? r.parts as Record<string, unknown>[] : undefined,
      createdAt: new Date(String(r.created_at)).toISOString(),
    }));
  }
  await hydrateMemory();
  return memory.messages.get(ctx.sessionId) ?? [];
}

export async function updateClaudeSessionId(ctx: { tenantId: string; ontologyId: string; sessionId: string }, claudeSessionId: string): Promise<void> {
  if (pool) {
    await query("update ontology_sessions set claude_session_id=$4 where tenant_id=$1 and ontology_id=$2 and id=$3", [ctx.tenantId, ctx.ontologyId, ctx.sessionId, claudeSessionId]);
  } else {
    const session = memory.sessions.get(ctx.sessionId);
    if (session) memory.sessions.set(ctx.sessionId, { ...session, claudeSessionId });
    await persistMemory();
  }
}

export async function appendRunEvent(event: { tenantId: string; ontologyId: string; sessionId?: string; runId?: string; sequence?: number; event: unknown }): Promise<OntologyRunEventRecord> {
  if (pool) {
    const res = await query<Record<string, unknown>>(
      "insert into ontology_run_events (id, ontology_id, session_id, tenant_id, run_id, sequence, event) values ($1,$2,$3,$4,$5,$6,$7) returning tenant_id, ontology_id, session_id, run_id, sequence, event, created_at",
      [randomUUID(), event.ontologyId, event.sessionId ?? null, event.tenantId, event.runId ?? null, event.sequence ?? null, JSON.stringify(event.event)],
    );
    const row = res.rows[0];
    return {
      tenantId: String(row.tenant_id),
      ontologyId: String(row.ontology_id),
      sessionId: row.session_id ? String(row.session_id) : undefined,
      runId: row.run_id ? String(row.run_id) : undefined,
      sequence: row.sequence === null || row.sequence === undefined ? undefined : Number(row.sequence),
      event: row.event,
      createdAt: new Date(String(row.created_at)).toISOString(),
    };
  }

  const record = { ...event, createdAt: new Date().toISOString() };
  memory.events.push(record);
  await persistMemory();
  return record;
}

export async function listRunEvents(ctx: { tenantId: string; ontologyId: string; sessionId: string; runId?: string; afterSequence?: number }): Promise<OntologyRunEventRecord[]> {
  if (pool) {
    const filters = ["tenant_id=$1", "ontology_id=$2", "session_id=$3"];
    const params: unknown[] = [ctx.tenantId, ctx.ontologyId, ctx.sessionId];
    if (ctx.runId) {
      params.push(ctx.runId);
      filters.push(`run_id=$${params.length}`);
    }
    if (ctx.afterSequence !== undefined) {
      params.push(ctx.afterSequence);
      filters.push(`coalesce(sequence, 0) > $${params.length}`);
    }
    const res = await query<Record<string, unknown>>(
      `select tenant_id, ontology_id, session_id, run_id, sequence, event, created_at
       from ontology_run_events
       where ${filters.join(" and ")}
       order by ${ctx.runId ? "coalesce(sequence, 0) asc, created_at asc" : "created_at asc, coalesce(sequence, 0) asc"}`,
      params,
    );
    return res.rows.map((row) => ({
      tenantId: String(row.tenant_id),
      ontologyId: String(row.ontology_id),
      sessionId: row.session_id ? String(row.session_id) : undefined,
      runId: row.run_id ? String(row.run_id) : undefined,
      sequence: row.sequence === null || row.sequence === undefined ? undefined : Number(row.sequence),
      event: row.event,
      createdAt: new Date(String(row.created_at)).toISOString(),
    }));
  }
  await hydrateMemory();
  return memory.events
    .filter((event) => event.tenantId === ctx.tenantId && event.ontologyId === ctx.ontologyId && event.sessionId === ctx.sessionId)
    .filter((event) => !ctx.runId || event.runId === ctx.runId)
    .filter((event) => ctx.afterSequence === undefined || (event.sequence ?? 0) > ctx.afterSequence)
    .sort((a, b) => ctx.runId
      ? (a.sequence ?? 0) - (b.sequence ?? 0) || a.createdAt.localeCompare(b.createdAt)
      : a.createdAt.localeCompare(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0));
}

export async function getLatestRunStatus(ctx: { tenantId: string; ontologyId: string; sessionId: string }): Promise<OntologyRunStatus> {
  let runId: string | null = null;
  if (pool) {
    const res = await query<{ run_id: string }>(
      `select run_id
       from ontology_run_events
       where tenant_id=$1 and ontology_id=$2 and session_id=$3 and run_id is not null
       order by created_at desc, sequence desc nulls last
       limit 1`,
      [ctx.tenantId, ctx.ontologyId, ctx.sessionId],
    );
    runId = res.rows[0]?.run_id ?? null;
  } else {
    await hydrateMemory();
    runId = [...memory.events]
      .filter((event) => event.tenantId === ctx.tenantId && event.ontologyId === ctx.ontologyId && event.sessionId === ctx.sessionId && event.runId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (b.sequence ?? 0) - (a.sequence ?? 0))[0]?.runId ?? null;
  }

  if (!runId) return { runId: null, active: false, completed: false, eventCount: 0, lastSequence: null, updatedAt: null };

  const events = await listRunEvents({ ...ctx, runId });
  const completed = events.some((record) => isTerminalRunEvent(record.event));
  const last = events[events.length - 1];
  return {
    runId,
    active: !completed,
    completed,
    eventCount: events.length,
    lastSequence: events.reduce<number | null>((max, record) => {
      if (record.sequence === undefined) return max;
      return max === null ? record.sequence : Math.max(max, record.sequence);
    }, null),
    updatedAt: last?.createdAt ?? null,
  };
}

// ─── 外部用户 userId 补全 ──────────────────────────────────────────────────────

/**
 * 用户登录后调用此函数：查找 ontology_shares 表中 subject_user_id 为空、
 * 但 subject_useremail 与当前用户邮箱匹配的记录，补全 userId 和 tenantId。
 * 这完成了"邮箱预先添加外部用户 → 注册/登录后自动激活"的逻辑闭环。
 */
export async function fillMissingShareUserIds(input: {
  userId: string;
  email: string;
  tenantId: string;
  username?: string;
}): Promise<number> {
  const email = input.email.trim().toLowerCase();
  if (!email) return 0;

  if (pool) {
    const result = await query<{ id: string }>(
      `update ontology_shares
       set subject_user_id = $1,
           subject_tenant_id = $2,
           subject_username = coalesce(subject_username, $3),
           updated_at = now()
       where scope = 'user'
         and subject_user_id is null
         and lower(subject_useremail) = $4
       returning id`,
      [input.userId, input.tenantId, input.username ?? null, email],
    );
    return result.rows.length;
  }

  // 内存模式
  await hydrateMemory();
  let count = 0;
  for (const [id, share] of memory.shares.entries()) {
    if (
      share.scope === "user" &&
      !share.subjectUserId &&
      share.subjectUseremail?.toLowerCase() === email
    ) {
      memory.shares.set(id, {
        ...share,
        subjectUserId: input.userId,
        subjectTenantId: input.tenantId,
        subjectUsername: share.subjectUsername ?? input.username,
        updatedAt: new Date().toISOString(),
      });
      count++;
    }
  }
  if (count > 0) await persistMemory();
  return count;
}
