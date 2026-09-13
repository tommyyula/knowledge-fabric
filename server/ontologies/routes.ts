import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";
import { lookupIamShareRecipient, requireTenantContext } from "../auth/requireTenantContext";
import { asyncRoute } from "../http";
import { env } from "../env";
import { startAppInitiatedOntologySyncRun, type OntologySyncMode, type OntologySyncRunReference } from "../chat/app-initiated-run";
import { syncClaudeReviewState, type ReviewRecoverySyncContext, type ReviewStateSyncAction, type ReviewStateSyncReason } from "../chat/claude-runner";
import { normalizeUiLocale, type UiLocale } from "../chat/workflow-status-messages";
import { deleteAllResourceBindingsForOntology } from "../resource-library/repository";
import { sendKnowledgeBaseInvite } from "../support/email-client";
import { canManageRole, hasKnowledgeBaseCapability, resolveKnowledgeBaseAccess, type KnowledgeBaseAccess } from "./access";
import {
  createProject,
  createSession,
  deleteActorSessionsForKnowledgeBase,
  deleteKnowledgeBaseShare,
  deletePendingKnowledgeBaseInvitation,
  findPendingInvitationByTokenHash,
  getProjectById,
  getSession,
  listAccessibleKnowledgeBaseProjects,
  listKnowledgeBaseChanges,
  listKnowledgeBaseShares,
  listPendingKnowledgeBaseInvitations,
  recordKnowledgeBaseChange,
  setTombstonePreference,
  softDeleteProject,
  updateClaudeSessionId,
  updatePendingInvitationDelivery,
  updateProject,
  upsertKnowledgeBaseShare,
  upsertPendingKnowledgeBaseInvitation,
  type PendingKnowledgeBaseInvitation,
} from "./repository";
import { applyAllReviewDrafts, applyLatestReviewDraft, applyManagedTemplateSync, applyReviewDraft, completeBootstrap, completeLatestIngestPlan, countMarkdownFiles, createOntologyUpdateMaterials, discardAllReviewDrafts, discardLatestReviewDraft, discardReviewDraft, ensureWorkspace, getManagedTemplateSyncStatus, initialJourneyState, listPendingReviewDrafts, readJourneyState, readReviewDraftDetail, reconcileApprovedReviewSchema, recoverPendingReviewDrafts, releaseWorkflowLock, writeJourneyState } from "./workspace";
import type { JourneyState, OntologyProject, ReviewState } from "../../src/contracts/ontology";

export const ontologiesRouter = Router();

const createSchema = z.object({
  name: z.string().min(1).default("Untitled Knowledge Base"),
  description: z.string().optional(),
  emoji: z.string().optional(),
  color: z.string().optional(),
});
const patchSchema = z.object({ name: z.string().min(1).optional(), description: z.string().optional(), emoji: z.string().optional(), color: z.string().optional(), status: z.enum(["active", "bootstrapping", "empty"]).optional(), pageCount: z.number().int().nonnegative().optional(), favorite: z.boolean().optional() });
const reviewSyncSchema = z.object({
  sessionId: z.string().trim().min(1).max(200).optional(),
  locale: z.enum(["zh", "en", "ja"]).optional(),
});
const shareRoleSchema = z.enum(["viewer", "editor", "manager"]);
const namedShareSchema = z.object({
  identifier: z.string().trim().min(1).max(320),
  tenantId: z.string().trim().min(1).max(200).optional(),
  role: shareRoleSchema,
});
const tenantShareSchema = z.object({ role: z.enum(["viewer", "editor"]).nullable() });
const acceptInvitationSchema = z.object({ token: z.string().trim().min(32).max(500), tenantId: z.string().trim().min(1).max(200) });
const deleteOntologySchema = z.object({ keepConversationHistory: z.boolean().default(true), removePlaceholder: z.boolean().default(true) });

function invitationTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function publicInvitation(invitation: PendingKnowledgeBaseInvitation): Omit<PendingKnowledgeBaseInvitation, "tokenHash"> {
  return {
    id: invitation.id,
    ontologyId: invitation.ontologyId,
    email: invitation.email,
    role: invitation.role,
    createdByUserId: invitation.createdByUserId,
    deliveryStatus: invitation.deliveryStatus,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
  };
}

function requestBaseUrl(req: Parameters<typeof requireTenantContext>[0]): string {
  return `${req.protocol}://${req.get("host")}`;
}

async function recordAccessChange(
  ctx: Awaited<ReturnType<typeof requireTenantContext>>,
  access: KnowledgeBaseAccess,
  action: string,
  outcome: "applied" | "rejected" | "failed" = "applied",
  details?: Record<string, unknown>,
): Promise<void> {
  await recordKnowledgeBaseChange({
    ontologyId: access.project.id,
    workspaceTenantId: access.workspaceTenantId,
    workspaceOwnerId: access.workspaceOwnerId,
    actorTenantId: ctx.tenantId,
    actorUserId: ctx.ownerId,
    actorDisplayName: ctx.user.displayName,
    protocol: "workbench",
    authorizationRole: access.role,
    authorizationSource: access.source,
    action,
    outcome,
    details,
  });
}

async function appendContentChangeLog(
  ctx: Awaited<ReturnType<typeof requireTenantContext>>,
  access: KnowledgeBaseAccess,
  action: string,
  summary: string,
  paths: readonly string[],
): Promise<void> {
  const timestamp = new Date().toISOString();
  const safeSummary = summary.replace(/\r?\n/g, " ").trim() || action;
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  const entry = [
    "",
    `## [${timestamp}] ${action} | ${safeSummary}`,
    "",
    `- actorUserId: \`${ctx.ownerId}\``,
    `- actorDisplayName: ${ctx.user.displayName.replace(/\r?\n/g, " ")}`,
    `- actorTenantId: \`${ctx.tenantId}\``,
    `- paths: ${uniquePaths.length ? uniquePaths.map((value) => `\`${value}\``).join(", ") : "(none)"}`,
    "",
  ].join("\n");
  await fs.appendFile(`${access.workspaceRoot}/knowledge/log.md`, entry, "utf8");
}

async function recordReviewChange(
  ctx: Awaited<ReturnType<typeof requireTenantContext>>,
  access: KnowledgeBaseAccess,
  action: "review_approved" | "review_discarded" | "review_recovered",
  summary: string,
  paths: readonly string[],
): Promise<void> {
  await Promise.all([
    recordAccessChange(ctx, access, action, "applied", { summary, paths: [...paths] }),
    appendContentChangeLog(ctx, access, action, summary, paths),
  ]);
}

interface ReviewSyncRequest {
  sessionId?: string;
  locale: UiLocale;
}

type OntologySyncResponse =
  | OntologySyncRunReference
  | { status: "skipped"; reason: "no_material"; includedFiles?: string[]; excludedFiles?: string[] }
  | { status: "failed_to_start"; reason: string; updateId?: string; materialRoot?: string; diffPath?: string; sessionId?: string };

function emptyIngestState(): JourneyState["ingest"] {
  return { files: [], generatedPages: [], totalBatches: 0, completedBatches: 0, progress: 0, batches: [] };
}

function emptyVerifyState(): JourneyState["verify"] {
  return { status: "generating", questionCount: 0, coverage: 0, autoFixed: 0, needsInput: 0, cases: [], fixes: [] };
}

function ontologySyncModeFromApprovalState(state: JourneyState | null): OntologySyncMode {
  return state?.flow === "build" && state.phase === "review" ? "initial_distill" : "incremental_edit";
}

async function ontologySyncModeBeforeApplyingReview(root: string): Promise<OntologySyncMode> {
  const state = await readJourneyState(root).catch((): JourneyState | null => null);
  return ontologySyncModeFromApprovalState(state);
}

function finalizedReviewState(status: "approved" | "discarded"): ReviewState {
  return { description: "", files: [], status };
}

async function finalizeReviewMutation(ctx: Awaited<ReturnType<typeof requireTenantContext>>, access: KnowledgeBaseAccess, root: string, review: ReviewState, status: "approved" | "discarded") {
  void ctx;
  void review;
  await completeBootstrap(root);
  await completeLatestIngestPlan(root);
  const pageCount = await countMarkdownFiles(root);
  await updateProject(access.workspaceTenantId, access.workspaceOwnerId, access.project.id, { pageCount, status: "active" });
  const remainingDrafts = await listPendingReviewDrafts(root);
  if (remainingDrafts.length > 0) {
    return readJourneyState(root).catch(() => initialJourneyState());
  }
  const current = await readJourneyState(root).catch(() => initialJourneyState());
  const state = {
    ...current,
    flow: "maintenance" as const,
    phase: "ready" as const,
    bootstrap: {
      ...current.bootstrap,
      status: "done" as const,
      awaitingUser: false,
      step: current.bootstrap.totalSteps || 6,
      confirmationPrompt: undefined,
    },
    ingest: emptyIngestState(),
    verify: emptyVerifyState(),
    review: finalizedReviewState(status),
    updatedAt: new Date().toISOString(),
  };
  await writeJourneyState(root, state);
  await releaseWorkflowLock(root, undefined, { force: true });
  return state;
}

function shouldSyncReviewFinalized(state: JourneyState, status: ReviewStateSyncAction): boolean {
  return state.phase === "ready" && state.review?.status === status;
}

function reviewSyncRequest(body: unknown, acceptLanguage: string | string[] | undefined): ReviewSyncRequest {
  const parsed = reviewSyncSchema.parse(body ?? {});
  return {
    sessionId: parsed.sessionId,
    locale: normalizeUiLocale(parsed.locale, Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage),
  };
}

async function syncReviewFinalizedToClaudeSession(input: {
  ctx: Awaited<ReturnType<typeof requireTenantContext>>;
  projectId: string;
  root: string;
  state: JourneyState;
  status: ReviewStateSyncAction;
  sync: ReviewSyncRequest;
  reason?: ReviewStateSyncReason;
  recovery?: ReviewRecoverySyncContext;
}): Promise<void> {
  if (!shouldSyncReviewFinalized(input.state, input.status) || !input.sync.sessionId) return;
  const session = await getSession(input.ctx.tenantId, input.ctx.ownerId, input.projectId, input.sync.sessionId);
  if (!session?.claudeSessionId) return;
  try {
    const claudeSessionId = await syncClaudeReviewState({
      tenantId: input.ctx.tenantId,
      userId: input.ctx.user.id,
      cwd: input.root,
      ontologyId: input.projectId,
      appSessionId: session.id,
      resume: session.claudeSessionId,
      action: input.status,
      reason: input.reason,
      recovery: input.recovery,
      locale: input.sync.locale,
    });
    if (claudeSessionId && claudeSessionId !== session.claudeSessionId) {
      await updateClaudeSessionId({ tenantId: input.ctx.tenantId, ontologyId: input.projectId, sessionId: session.id }, claudeSessionId);
    }
  } catch (err) {
    console.warn(`[review-sync] failed to sync ${input.reason ?? "normal"} review finalization into Claude session:`, err instanceof Error ? err.message : String(err));
  }
}

async function startOntologySyncAfterApprovedReview(input: {
  ctx: Awaited<ReturnType<typeof requireTenantContext>>;
  project: OntologyProject;
  root: string;
  reviews: ReviewState[];
  sync: ReviewSyncRequest;
  mode: OntologySyncMode;
}): Promise<OntologySyncResponse> {
  const materials = await createOntologyUpdateMaterials(input.root, input.project.id, input.reviews);
  if (materials.status === "skipped") {
    return {
      status: "skipped",
      reason: "no_material",
      includedFiles: materials.includedFiles,
      excludedFiles: materials.excludedFiles,
    };
  }

  if (!input.sync.sessionId) {
    return {
      status: "failed_to_start",
      reason: "missing_session",
      updateId: materials.updateId,
      materialRoot: materials.materialRoot,
      diffPath: materials.diffPath,
    };
  }

  const session = await getSession(input.ctx.tenantId, input.ctx.ownerId, input.project.id, input.sync.sessionId);
  if (!session) {
    return {
      status: "failed_to_start",
      reason: "session_not_found",
      updateId: materials.updateId,
      materialRoot: materials.materialRoot,
      diffPath: materials.diffPath,
      sessionId: input.sync.sessionId,
    };
  }

  try {
    return await startAppInitiatedOntologySyncRun({
      tenantId: input.ctx.tenantId,
      ownerId: input.ctx.ownerId,
      userId: input.ctx.user.id,
      project: input.project,
      session,
      root: input.root,
      updateId: materials.updateId!,
      materialRoot: materials.materialRoot!,
      diffPath: materials.diffPath,
      locale: input.sync.locale,
      mode: input.mode,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[review-sync] failed to start ontology sync run:", reason);
    return {
      status: "failed_to_start",
      reason,
      updateId: materials.updateId,
      materialRoot: materials.materialRoot,
      diffPath: materials.diffPath,
      sessionId: session.id,
    };
  }
}

function scheduleApprovedReviewSchemaReconciliation(input: {
  project: OntologyProject;
  root: string;
  reviews: ReviewState[];
  reason: string;
}): void {
  void reconcileApprovedReviewSchema(input.root, input.project, input.reviews).then((result) => {
    if (result.status === "ok") {
      console.info(`[review-schema] reconciled schema after ${input.reason}: ${result.addedKnowledgeSubdirs.join(", ")}`);
    }
  }).catch((err) => {
    console.warn(`[review-schema] failed to reconcile schema after ${input.reason}:`, err instanceof Error ? err.message : String(err));
  });
}

async function finalizeReviewMutationAndSync(
  ctx: Awaited<ReturnType<typeof requireTenantContext>>,
  access: KnowledgeBaseAccess,
  root: string,
  review: ReviewState,
  status: ReviewStateSyncAction,
  sync: ReviewSyncRequest,
): Promise<JourneyState> {
  const state = await finalizeReviewMutation(ctx, access, root, review, status);
  await syncReviewFinalizedToClaudeSession({ ctx, projectId: access.project.id, root, state, status, sync });
  return state;
}

async function finalizeApprovedReviewMutationAndStartOntologySync(input: {
  ctx: Awaited<ReturnType<typeof requireTenantContext>>;
  access: KnowledgeBaseAccess;
  root: string;
  review: ReviewState;
  syncReviews: ReviewState[];
  sync: ReviewSyncRequest;
  mode: OntologySyncMode;
}): Promise<{ journeyState: JourneyState; ontologySync: OntologySyncResponse }> {
  const journeyState = await finalizeReviewMutation(input.ctx, input.access, input.root, input.review, "approved");
  const ontologySync = await startOntologySyncAfterApprovedReview({
    ctx: input.ctx,
    project: input.access.project,
    root: input.root,
    reviews: input.syncReviews,
    sync: input.sync,
    mode: input.mode,
  });
  scheduleApprovedReviewSchemaReconciliation({
    project: input.access.project,
    root: input.root,
    reviews: input.syncReviews,
    reason: "approved review",
  });
  return { journeyState, ontologySync };
}

ontologiesRouter.post("/share-invitations/accept", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const body = acceptInvitationSchema.parse(req.body ?? {});
  if (body.tenantId !== ctx.tenantId) return void res.status(403).json({ error: "Switch to the selected Tenant before accepting this invitation" });
  const invitation = await findPendingInvitationByTokenHash(invitationTokenHash(body.token));
  if (!invitation) return void res.status(404).json({ error: "Invitation not found" });
  if (invitation.email !== ctx.user.email.trim().toLowerCase()) return void res.status(403).json({ error: "Invitation email does not match the authenticated user" });
  const project = await getProjectById(invitation.ontologyId);
  if (!project?.tenantId || !project.ownerId || project.deletedAt || project.status !== "active") {
    return void res.status(404).json({ error: "Knowledge Base is unavailable" });
  }
  const share = await upsertKnowledgeBaseShare({
    tenantId: project.tenantId,
    ownerId: project.ownerId,
    ontologyId: project.id,
    scope: "user",
    subjectUserId: ctx.ownerId,
    subjectTenantId: ctx.tenantId,
    role: invitation.role,
    createdByUserId: invitation.createdByUserId,
  });
  if (!share) return void res.status(404).json({ error: "Knowledge Base is unavailable" });
  await deletePendingKnowledgeBaseInvitation(project.id, invitation.id);
  const access = await resolveKnowledgeBaseAccess(ctx, project.id);
  if (access) await recordAccessChange(ctx, access, "invitation_accepted", "applied", { invitationId: invitation.id, role: invitation.role });
  res.json({ data: { share, project: access?.project ?? project } });
}));

ontologiesRouter.get("/", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  res.json({ data: (await listAccessibleKnowledgeBaseProjects(ctx.tenantId, ctx.ownerId)).map((access) => access.project) });
}));

ontologiesRouter.post("/", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const body = createSchema.parse(req.body ?? {});
  let project = await createProject({ tenantId: ctx.tenantId, ownerId: ctx.ownerId, ...body });
  const root = await ensureWorkspace(project, ctx.tenantId, ctx.user.id);
  const pageCount = await countMarkdownFiles(root);
  const journeyState = await readJourneyState(root);
  project = await updateProject(ctx.tenantId, ctx.ownerId, project.id, { pageCount, status: "bootstrapping" }) ?? project;
  const session = await createSession(ctx.tenantId, ctx.ownerId, project.id, "新知识构建", "workbench", project);
  res.status(201).json({ data: { project, session, journeyState } });
}));

ontologiesRouter.get("/:ontologyId/shares", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "manageShares")) return void res.status(404).json({ error: "Ontology not found" });
  const [shares, invitations] = await Promise.all([
    listKnowledgeBaseShares(access.workspaceTenantId, access.workspaceOwnerId, access.project.id),
    listPendingKnowledgeBaseInvitations(access.project.id),
  ]);
  res.json({ data: { shares, invitations: invitations.map(publicInvitation) } });
}));

ontologiesRouter.get("/:ontologyId/share-recipients", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "manageShares")) return void res.status(404).json({ error: "Ontology not found" });
  const identifier = z.string().trim().min(1).max(320).parse(req.query.identifier);
  if (!env.iamEnabled) {
    const email = z.string().email().safeParse(identifier);
    return void res.json({ data: email.success
      ? { kind: "invite", email: email.data.toLowerCase() }
      : { kind: "iam", recipient: { id: identifier, userName: identifier, displayName: identifier, email: `${identifier}@local.dev`, tenantIds: [ctx.tenantId] } } });
  }
  const authorization = req.header("authorization");
  if (!authorization) return void res.status(401).json({ error: "Authentication required" });
  try {
    const recipient = await lookupIamShareRecipient(authorization, identifier);
    res.json({ data: { kind: "iam", recipient } });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
    const email = z.string().email().safeParse(identifier);
    if (status === 404) {
      if (email.success) return void res.json({ data: { kind: "invite", email: email.data.toLowerCase() } });
      // 非邮箱格式且未找到用户：返回特定错误让前端展示友好提示
      return void res.status(404).json({ error: "user_not_found" });
    }
    throw error;
  }
}));

ontologiesRouter.post("/:ontologyId/shares", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "manageShares")) return void res.status(404).json({ error: "Ontology not found" });
  const body = namedShareSchema.parse(req.body ?? {});
  if (!canManageRole(access, body.role)) return void res.status(403).json({ error: "Only the Knowledge Base Owner can grant Manager" });
  let recipient: Awaited<ReturnType<typeof lookupIamShareRecipient>> | null = null;
  let iamLookupFailed = false;

  if (env.iamEnabled) {
    const authorization = req.header("authorization");
    if (!authorization) return void res.status(401).json({ error: "Authentication required" });
    try {
      recipient = await lookupIamShareRecipient(authorization, body.identifier);
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
      if (status === 404) {
        iamLookupFailed = true;
        // 非邮箱格式 → 拒绝，前端展示友好提示
        if (!z.string().email().safeParse(body.identifier).success) {
          return void res.status(404).json({ error: "user_not_found" });
        }
        // 是邮箱格式但 IAM 找不到 → 走外部用户写入
      } else {
        throw error;
      }
    }
  } else if (!z.string().email().safeParse(body.identifier).success) {
    recipient = { id: body.identifier, userName: body.identifier, displayName: body.identifier, email: `${body.identifier}@local.dev`, tenantIds: [body.tenantId ?? ctx.tenantId] };
  }

  if (recipient) {
    // IAM 用户找到：直接使用第一个 tenantId（优先使用 body.tenantId 如果合法），无需前端二次确认
    const tenantId = body.tenantId && recipient.tenantIds.includes(body.tenantId)
      ? body.tenantId
      : recipient.tenantIds[0];
    if (!tenantId) return void res.status(400).json({ error: "Recipient has no associated tenant" });
    if (recipient.id === access.workspaceOwnerId && tenantId === access.workspaceTenantId) return void res.status(400).json({ error: "The Knowledge Base Owner cannot receive a Share Role" });
    const existing = (await listKnowledgeBaseShares(access.workspaceTenantId, access.workspaceOwnerId, access.project.id))
      .find((share) => share.scope === "user" && share.subjectUserId === recipient!.id && share.subjectTenantId === tenantId);
    if (existing?.role === "manager" && access.role !== "owner") return void res.status(403).json({ error: "Only the Knowledge Base Owner can modify Manager access" });
    const companyName = recipient.companies.find((c) => c.companyCode === tenantId)?.companyName ?? tenantId;
    const share = await upsertKnowledgeBaseShare({
      tenantId: access.workspaceTenantId, ownerId: access.workspaceOwnerId, ontologyId: access.project.id,
      scope: "user", subjectUserId: recipient.id, subjectTenantId: tenantId,
      subjectUsername: recipient.userName || recipient.displayName || undefined,
      subjectUseremail: recipient.email || undefined,
      subjectCompanyname: companyName,
      role: body.role, createdByUserId: ctx.ownerId,
      createdByUsername: ctx.user.displayName || undefined,
    });
    if (!share) return void res.status(409).json({ error: "Sharing is available once the Knowledge Base is ready" });
    await recordAccessChange(ctx, access, existing ? "share_role_changed" : "member_shared", "applied", { shareId: share.id, recipientUserId: recipient.id, recipientTenantId: tenantId, role: body.role });
    let notificationStatus: "sent" | "failed" = "sent";
    try {
      await sendKnowledgeBaseInvite({ apiUrl: env.supportEmailApiUrl, timeoutMs: env.supportEmailTimeoutMs, recipient: recipient.email, sharer: ctx.user.displayName, knowledgeBaseName: access.project.name, role: body.role, openUrl: `${requestBaseUrl(req)}/?ontologyId=${encodeURIComponent(access.project.id)}` });
    } catch {
      notificationStatus = "failed";
      await recordAccessChange(ctx, access, "share_notification", "failed", { shareId: share.id, recipientUserId: recipient.id });
    }
    return void res.status(201).json({ data: { kind: "share", share, notificationStatus } });
  }

  // IAM 未找到且是邮箱，或 IAM 未启用且是邮箱：
  const email = z.string().email().parse(body.identifier).toLowerCase();

  if (iamLookupFailed) {
    // 外部用户：写入 ontology_shares，subject_user_id=null，subject_tenant_id=MKT
    const externalTenantId = "MKT";
    const existing = (await listKnowledgeBaseShares(access.workspaceTenantId, access.workspaceOwnerId, access.project.id))
      .find((share) => share.scope === "user" && !share.subjectUserId && share.subjectUseremail === email);
    if (existing?.role === "manager" && access.role !== "owner") {
      return void res.status(403).json({ error: "Only the Knowledge Base Owner can modify Manager access" });
    }
    const share = await upsertKnowledgeBaseShare({
      tenantId: access.workspaceTenantId, ownerId: access.workspaceOwnerId, ontologyId: access.project.id,
      scope: "user", subjectUserId: undefined, subjectTenantId: externalTenantId,
      subjectUsername: email, subjectUseremail: email,
      subjectCompanyname: externalTenantId,
      role: body.role, createdByUserId: ctx.ownerId,
      createdByUsername: ctx.user.displayName || undefined,
    });
    if (!share) return void res.status(409).json({ error: "Sharing is available once the Knowledge Base is ready" });
    await recordAccessChange(ctx, access, existing ? "share_role_changed" : "external_member_shared", "applied", { shareId: share.id, email, role: body.role });
    let notificationStatus: "sent" | "failed" = "sent";
    try {
      await sendKnowledgeBaseInvite({ apiUrl: env.supportEmailApiUrl, timeoutMs: env.supportEmailTimeoutMs, recipient: email, sharer: ctx.user.displayName, knowledgeBaseName: access.project.name, role: body.role, openUrl: `${requestBaseUrl(req)}/?ontologyId=${encodeURIComponent(access.project.id)}` });
    } catch {
      notificationStatus = "failed";
    }
    return void res.status(201).json({ data: { kind: "share", share, notificationStatus } });
  }

  // IAM 未启用的邮箱走原有邀请流程
  const existingInvitation = (await listPendingKnowledgeBaseInvitations(access.project.id))
    .find((candidate) => candidate.email === email);
  if (existingInvitation?.role === "manager" && access.role !== "owner") {
    return void res.status(403).json({ error: "Only the Knowledge Base Owner can modify a Manager invitation" });
  }
  const token = randomBytes(32).toString("base64url");
  const invitation = await upsertPendingKnowledgeBaseInvitation({ ontologyId: access.project.id, email, role: body.role, tokenHash: invitationTokenHash(token), createdByUserId: ctx.ownerId });
  let notificationStatus: "sent" | "failed" = "sent";
  try {
    await sendKnowledgeBaseInvite({ apiUrl: env.supportEmailApiUrl, timeoutMs: env.supportEmailTimeoutMs, recipient: email, sharer: ctx.user.displayName, knowledgeBaseName: access.project.name, role: body.role, openUrl: `${requestBaseUrl(req)}/share/invite?token=${encodeURIComponent(token)}` });
    await updatePendingInvitationDelivery(invitation.id, "sent");
  } catch {
    notificationStatus = "failed";
    await updatePendingInvitationDelivery(invitation.id, "failed");
  }
  await recordAccessChange(ctx, access, "invitation_created", "applied", { invitationId: invitation.id, email, role: body.role, notificationStatus });
  res.status(201).json({ data: { kind: "invitation", invitation: publicInvitation({ ...invitation, deliveryStatus: notificationStatus }), notificationStatus } });
}));

ontologiesRouter.put("/:ontologyId/shares/tenant", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "manageShares")) return void res.status(404).json({ error: "Ontology not found" });
  const body = tenantShareSchema.parse(req.body ?? {});
  const existing = (await listKnowledgeBaseShares(access.workspaceTenantId, access.workspaceOwnerId, access.project.id)).find((share) => share.scope === "tenant");
  if (body.role === null) {
    if (existing) await deleteKnowledgeBaseShare(access.workspaceTenantId, access.workspaceOwnerId, access.project.id, existing.id);
    await recordAccessChange(ctx, access, "tenant_share_removed");
    return void res.status(204).send();
  }
  const share = await upsertKnowledgeBaseShare({ tenantId: access.workspaceTenantId, ownerId: access.workspaceOwnerId, ontologyId: access.project.id, scope: "tenant", subjectTenantId: access.workspaceTenantId, role: body.role, createdByUserId: ctx.ownerId, createdByUsername: ctx.user.displayName || undefined });
  if (!share) return void res.status(409).json({ error: "Sharing is available once the Knowledge Base is ready" });
  await recordAccessChange(ctx, access, "tenant_share_changed", "applied", { shareId: share.id, role: body.role });
  res.json({ data: share });
}));

ontologiesRouter.delete("/:ontologyId/shares/:shareId", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "manageShares")) return void res.status(404).json({ error: "Ontology not found" });
  const share = (await listKnowledgeBaseShares(access.workspaceTenantId, access.workspaceOwnerId, access.project.id)).find((candidate) => candidate.id === String(req.params.shareId));
  if (!share) return void res.status(404).json({ error: "Share not found" });
  if (share.role === "manager" && access.role !== "owner") return void res.status(403).json({ error: "Only the Knowledge Base Owner can revoke Manager access" });
  await deleteKnowledgeBaseShare(access.workspaceTenantId, access.workspaceOwnerId, access.project.id, share.id);
  await recordAccessChange(ctx, access, "member_share_revoked", "applied", { shareId: share.id, role: share.role });
  res.status(204).send();
}));

ontologiesRouter.delete("/:ontologyId/invitations/:invitationId", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "manageShares")) return void res.status(404).json({ error: "Ontology not found" });
  const invitation = (await listPendingKnowledgeBaseInvitations(access.project.id)).find((candidate) => candidate.id === String(req.params.invitationId));
  if (!invitation) return void res.status(404).json({ error: "Invitation not found" });
  if (invitation.role === "manager" && access.role !== "owner") return void res.status(403).json({ error: "Only the Knowledge Base Owner can revoke a Manager invitation" });
  await deletePendingKnowledgeBaseInvitation(access.project.id, invitation.id);
  await recordAccessChange(ctx, access, "invitation_revoked", "applied", { invitationId: invitation.id });
  res.status(204).send();
}));

ontologiesRouter.get("/:ontologyId/changes", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "review")) return void res.status(404).json({ error: "Ontology not found" });
  const records = await listKnowledgeBaseChanges(access.project.id);
  const data = access.role === "owner" || access.role === "manager"
    ? records
    : records.filter((record) => !record.action.includes("share") && !record.action.includes("invitation"));
  res.json({ data });
}));

ontologiesRouter.get("/:ontologyId", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access) return void res.status(404).json({ error: "Ontology not found" });
  res.json({ data: access.project });
}));

ontologiesRouter.patch("/:ontologyId", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "editProfile")) return void res.status(404).json({ error: "Ontology not found" });
  const project = await updateProject(access.workspaceTenantId, access.workspaceOwnerId, access.project.id, patchSchema.parse(req.body ?? {}));
  if (!project) return void res.status(404).json({ error: "Ontology not found" });
  await recordAccessChange(ctx, access, "profile_updated", "applied", { fields: Object.keys(req.body ?? {}) });
  res.json({ data: project });
}));

ontologiesRouter.delete("/:ontologyId", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "delete")) return void res.status(404).send({ error: "Ontology not found" });
  const body = deleteOntologySchema.parse(req.body ?? {});
  await recordAccessChange(ctx, access, "knowledge_base_deleted", "applied", { keepConversationHistory: body.keepConversationHistory });
  const deleted = await softDeleteProject(access.workspaceTenantId, access.workspaceOwnerId, access.project.id, ctx.ownerId);
  if (!deleted) return void res.status(404).send({ error: "Ontology not found" });
  await Promise.all([
    deleteAllResourceBindingsForOntology(access.project.id),
    setTombstonePreference({ ontologyId: access.project.id, tenantId: ctx.tenantId, userId: ctx.ownerId, removePlaceholder: true, keepConversations: body.keepConversationHistory }).catch((error) => {
        console.warn(`[ontologies] failed to remove Knowledge Base workspace ${access.project.id}:`, error instanceof Error ? error.message : String(error));
      }),
    body.keepConversationHistory ? Promise.resolve(0) : deleteActorSessionsForKnowledgeBase(ctx.tenantId, ctx.ownerId, access.project.id, access.project),
  ]);
  res.status(204).send();
}));

ontologiesRouter.delete("/:ontologyId/tombstone", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const body = deleteOntologySchema.parse(req.body ?? {});
  const candidate = (await listAccessibleKnowledgeBaseProjects(ctx.tenantId, ctx.ownerId)).find((item) => item.project.id === String(req.params.ontologyId));
  if (!candidate?.project.deletedAt || candidate.role === "owner") return void res.status(404).json({ error: "Deleted shared Knowledge Base not found" });
  await setTombstonePreference({ ontologyId: candidate.project.id, tenantId: ctx.tenantId, userId: ctx.ownerId, removePlaceholder: body.removePlaceholder, keepConversations: body.keepConversationHistory });
  if (!body.keepConversationHistory) await deleteActorSessionsForKnowledgeBase(ctx.tenantId, ctx.ownerId, candidate.project.id, candidate.project);
  res.status(204).send();
}));

ontologiesRouter.get("/:ontologyId/journey", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access) return void res.status(404).json({ error: "Ontology not found" });
  const state = await readJourneyState(access.workspaceRoot);
  if (!hasKnowledgeBaseCapability(access, "review")) {
    const emptyState = initialJourneyState();
    return void res.json({
      data: {
        ...state,
        bootstrap: { ...state.bootstrap, rawSources: [] },
        ingest: emptyState.ingest,
        verify: emptyState.verify,
        review: undefined,
      },
    });
  }
  res.json({ data: state });
}));

ontologiesRouter.get("/:ontologyId/template-sync", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access) return void res.status(404).json({ error: "Ontology not found" });
  const status = await getManagedTemplateSyncStatus(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  res.json({ data: status });
}));

ontologiesRouter.post("/:ontologyId/template-sync", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "contribute")) return void res.status(404).json({ error: "Ontology not found" });
  const status = await applyManagedTemplateSync(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  await recordAccessChange(ctx, access, "template_synced");
  res.json({ data: status });
}));

ontologiesRouter.get("/:ontologyId/reviews/pending", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "review")) return void res.status(404).json({ error: "Ontology not found" });
  res.json({ data: { drafts: await listPendingReviewDrafts(access.workspaceRoot) } });
}));

ontologiesRouter.get("/:ontologyId/reviews/:draftId", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "review")) return void res.status(404).json({ error: "Ontology not found" });
  const detail = await readReviewDraftDetail(access.workspaceRoot, String(req.params.draftId));
  if (!detail) return void res.status(404).json({ error: "Pending review draft not found" });
  res.json({ data: detail });
}));

ontologiesRouter.post("/:ontologyId/reviews/approve-all", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const sync = reviewSyncRequest(req.body, req.headers["accept-language"]);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "review")) return void res.status(404).json({ error: "Ontology not found" });
  const root = await ensureWorkspace(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  const ontologySyncMode = await ontologySyncModeBeforeApplyingReview(root);
  const reviews = await applyAllReviewDrafts(root);
  if (!reviews.length) return void res.status(404).json({ error: "No pending review draft found" });
  const review: ReviewState = { description: `Approved ${reviews.length} pending review draft${reviews.length === 1 ? "" : "s"}.`, files: reviews.flatMap((item) => item.files), status: "approved" };
  const journeyState = await finalizeReviewMutation(ctx, access, root, review, "approved");
  await recordReviewChange(ctx, access, "review_approved", review.description, review.files.map((file) => file.path));
  const ontologySync = await startOntologySyncAfterApprovedReview({ ctx, project: access.project, root, reviews, sync, mode: ontologySyncMode });
  res.json({ data: { reviews, journeyState, ontologySync } });
}));

ontologiesRouter.post("/:ontologyId/reviews/discard-all", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const sync = reviewSyncRequest(req.body, req.headers["accept-language"]);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "review")) return void res.status(404).json({ error: "Ontology not found" });
  const root = await ensureWorkspace(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  const pendingDrafts = await listPendingReviewDrafts(root);
  const pendingPaths = (await Promise.all(pendingDrafts.map((draft) => readReviewDraftDetail(root, draft.draftId))))
    .flatMap((draft) => draft?.files.map((file) => file.path) ?? []);
  const drafts = await discardAllReviewDrafts(root);
  const review: ReviewState = { description: "", files: [], status: "discarded" };
  const journeyState = await finalizeReviewMutationAndSync(ctx, access, root, review, "discarded", sync);
  await recordReviewChange(ctx, access, "review_discarded", `Discarded ${drafts.length} pending review draft(s).`, pendingPaths);
  res.json({ data: { discarded: drafts, journeyState } });
}));

ontologiesRouter.post("/:ontologyId/reviews/recover", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const sync = reviewSyncRequest(req.body, req.headers["accept-language"]);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "review")) return void res.status(404).json({ error: "Ontology not found" });
  const root = await ensureWorkspace(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  const recovery = await recoverPendingReviewDrafts(root);
  const review: ReviewState = {
    description: recovery.recovered.length
      ? `Recovered and discarded ${recovery.recovered.length} pending review draft${recovery.recovered.length === 1 ? "" : "s"}.`
      : "No pending review draft found.",
    files: [],
    status: "discarded",
  };
  const journeyState = await finalizeReviewMutation(ctx, access, root, review, "discarded");
  await recordReviewChange(ctx, access, "review_recovered", review.description, []);
  if (recovery.recovered.length > 0) {
    await syncReviewFinalizedToClaudeSession({
      ctx,
      projectId: access.project.id,
      root,
      state: journeyState,
      status: "discarded",
      sync,
      reason: "recovery",
      recovery: {
        draftIds: recovery.archive?.draftIds ?? recovery.recovered.map((item) => item.draftId),
        recoveryPath: recovery.archive?.recoveryPath ?? null,
        manifestPath: recovery.archive?.manifestPath ?? null,
      },
    });
  }
  res.json({ data: { ...recovery, journeyState } });
}));

ontologiesRouter.post("/:ontologyId/reviews/:draftId/approve", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const sync = reviewSyncRequest(req.body, req.headers["accept-language"]);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "review")) return void res.status(404).json({ error: "Ontology not found" });
  const root = await ensureWorkspace(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  const ontologySyncMode = await ontologySyncModeBeforeApplyingReview(root);
  const review = await applyReviewDraft(root, String(req.params.draftId));
  if (!review) return void res.status(404).json({ error: "Pending review draft not found" });
  const { journeyState, ontologySync } = await finalizeApprovedReviewMutationAndStartOntologySync({ ctx, access, root, review, syncReviews: [review], sync, mode: ontologySyncMode });
  await recordReviewChange(ctx, access, "review_approved", review.description, review.files.map((file) => file.path));
  res.json({ data: { review, journeyState, ontologySync } });
}));

ontologiesRouter.post("/:ontologyId/reviews/:draftId/discard", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const sync = reviewSyncRequest(req.body, req.headers["accept-language"]);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "review")) return void res.status(404).json({ error: "Ontology not found" });
  const root = await ensureWorkspace(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  const review = await discardReviewDraft(root, String(req.params.draftId));
  if (!review) return void res.status(404).json({ error: "Pending review draft not found" });
  const journeyState = await finalizeReviewMutationAndSync(ctx, access, root, review, "discarded", sync);
  await recordReviewChange(ctx, access, "review_discarded", review.description || `Discarded draft ${String(req.params.draftId)}.`, review.files.map((file) => file.path));
  res.json({ data: { review, journeyState } });
}));

ontologiesRouter.post("/:ontologyId/review/approve", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const sync = reviewSyncRequest(req.body, req.headers["accept-language"]);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "review")) return void res.status(404).json({ error: "Ontology not found" });
  const root = await ensureWorkspace(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  const ontologySyncMode = await ontologySyncModeBeforeApplyingReview(root);
  const review = await applyLatestReviewDraft(root);
  if (!review) return void res.status(404).json({ error: "No pending review draft found" });
  const { journeyState, ontologySync } = await finalizeApprovedReviewMutationAndStartOntologySync({ ctx, access, root, review, syncReviews: [review], sync, mode: ontologySyncMode });
  await recordReviewChange(ctx, access, "review_approved", review.description, review.files.map((file) => file.path));
  res.json({ data: { review, journeyState, ontologySync } });
}));

ontologiesRouter.post("/:ontologyId/review/discard", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const sync = reviewSyncRequest(req.body, req.headers["accept-language"]);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "review")) return void res.status(404).json({ error: "Ontology not found" });
  const root = await ensureWorkspace(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  const review = await discardLatestReviewDraft(root);
  if (!review) return void res.status(404).json({ error: "No pending review draft found" });
  const state = await finalizeReviewMutationAndSync(ctx, access, root, review, "discarded", sync);
  await recordReviewChange(ctx, access, "review_discarded", review.description || "Discarded latest review draft.", review.files.map((file) => file.path));
  res.json({ data: { review, journeyState: state } });
}));
