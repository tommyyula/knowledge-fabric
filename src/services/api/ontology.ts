import type { BootstrapRawSource, ConversationSnapshot, JourneyState, KnowledgeBaseChangeRecord, KnowledgeBaseShare, KnowledgeBaseShareRole, OntologyFileNode, OntologyProject, OntologySession, OntologySyncResult, PendingKnowledgeBaseInvitation, PendingReviewDraftDetail, PendingReviewDraftSummary, ReviewState, TemplateSyncStatus } from "@/contracts/ontology";
import { apiJson } from "@/lib/api-client";
import type { Locale } from "@/i18n";

interface ApiData<T> { data: T }

export interface ReviewActionOptions {
  sessionId?: string | null;
  locale?: Locale;
}

function reviewActionBody(options?: ReviewActionOptions): string | undefined {
  if (!options?.sessionId && !options?.locale) return undefined;
  return JSON.stringify({
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
  });
}

export async function listOntologies(): Promise<OntologyProject[]> {
  return (await apiJson<ApiData<OntologyProject[]>>("/api/v1/ontologies")).data;
}

export async function getOntology(id: string): Promise<OntologyProject> {
  return (await apiJson<ApiData<OntologyProject>>(`/api/v1/ontologies/${encodeURIComponent(id)}`)).data;
}

export async function createOntology(input: { name: string; description?: string }): Promise<{ project: OntologyProject; session: OntologySession; journeyState: JourneyState }> {
  return (await apiJson<ApiData<{ project: OntologyProject; session: OntologySession; journeyState: JourneyState }>>("/api/v1/ontologies", { method: "POST", body: JSON.stringify(input) })).data;
}

export async function updateOntology(id: string, updates: Partial<OntologyProject>): Promise<OntologyProject> {
  return (await apiJson<ApiData<OntologyProject>>(`/api/v1/ontologies/${id}`, { method: "PATCH", body: JSON.stringify(updates) })).data;
}

export async function deleteOntology(id: string, keepConversationHistory = true): Promise<void> {
  await apiJson<void>(`/api/v1/ontologies/${id}`, { method: "DELETE", body: JSON.stringify({ keepConversationHistory }) });
}

export async function removeDeletedKnowledgeBasePlaceholder(id: string, keepConversationHistory: boolean, removePlaceholder = true): Promise<void> {
  await apiJson<void>(`/api/v1/ontologies/${encodeURIComponent(id)}/tombstone`, { method: "DELETE", body: JSON.stringify({ keepConversationHistory, removePlaceholder }) });
}

export interface KnowledgeBaseSharingState { shares: KnowledgeBaseShare[]; invitations: PendingKnowledgeBaseInvitation[] }
export interface IamShareRecipient { id: string; userName: string; displayName: string; email: string; tenantIds: string[] }

export async function getKnowledgeBaseSharing(id: string): Promise<KnowledgeBaseSharingState> {
  return (await apiJson<ApiData<KnowledgeBaseSharingState>>(`/api/v1/ontologies/${encodeURIComponent(id)}/shares`)).data;
}

export async function findKnowledgeBaseShareRecipient(id: string, identifier: string): Promise<{ kind: "iam"; recipient: IamShareRecipient } | { kind: "invite"; email: string }> {
  return (await apiJson<ApiData<{ kind: "iam"; recipient: IamShareRecipient } | { kind: "invite"; email: string }>>(`/api/v1/ontologies/${encodeURIComponent(id)}/share-recipients?identifier=${encodeURIComponent(identifier)}`)).data;
}

export async function shareKnowledgeBase(id: string, input: { identifier: string; tenantId?: string; role: KnowledgeBaseShareRole }) {
  return (await apiJson<ApiData<unknown>>(`/api/v1/ontologies/${encodeURIComponent(id)}/shares`, { method: "POST", body: JSON.stringify(input) })).data;
}

export async function setKnowledgeBaseTenantShare(id: string, role: "viewer" | "editor" | null): Promise<KnowledgeBaseShare | undefined> {
  return (await apiJson<ApiData<KnowledgeBaseShare> | undefined>(`/api/v1/ontologies/${encodeURIComponent(id)}/shares/tenant`, { method: "PUT", body: JSON.stringify({ role }) }))?.data;
}

export async function revokeKnowledgeBaseShare(id: string, shareId: string): Promise<void> {
  await apiJson<void>(`/api/v1/ontologies/${encodeURIComponent(id)}/shares/${encodeURIComponent(shareId)}`, { method: "DELETE" });
}

export async function revokeKnowledgeBaseInvitation(id: string, invitationId: string): Promise<void> {
  await apiJson<void>(`/api/v1/ontologies/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" });
}

export async function acceptKnowledgeBaseInvitation(token: string, tenantId: string): Promise<{ project: OntologyProject }> {
  return (await apiJson<ApiData<{ project: OntologyProject }>>(`/api/v1/ontologies/share-invitations/accept`, { method: "POST", body: JSON.stringify({ token, tenantId }) })).data;
}

export async function listKnowledgeBaseChanges(id: string): Promise<KnowledgeBaseChangeRecord[]> {
  return (await apiJson<ApiData<KnowledgeBaseChangeRecord[]>>(`/api/v1/ontologies/${encodeURIComponent(id)}/changes`)).data;
}

export async function publishConversationSnapshot(ontologyId: string, sessionId: string): Promise<ConversationSnapshot> {
  return (await apiJson<ApiData<ConversationSnapshot>>(`/api/v1/ontologies/${encodeURIComponent(ontologyId)}/sessions/${encodeURIComponent(sessionId)}/share`, { method: "POST" })).data;
}

export async function getPublicConversationSnapshot(token: string): Promise<ConversationSnapshot> {
  return (await apiJson<ApiData<ConversationSnapshot>>(`/api/v1/ontologies/public/conversations/${encodeURIComponent(token)}`)).data;
}

export async function getOntologyTree(id: string, scope: "knowledge" | "workspace" = "knowledge"): Promise<OntologyFileNode[]> {
  const suffix = scope === "workspace" ? "?scope=workspace" : "";
  return (await apiJson<ApiData<OntologyFileNode[]>>(`/api/v1/ontologies/${id}/tree${suffix}`)).data;
}

export async function getTemplateSyncStatus(id: string): Promise<TemplateSyncStatus> {
  return (await apiJson<ApiData<TemplateSyncStatus>>(`/api/v1/ontologies/${id}/template-sync`)).data;
}

export async function applyTemplateSync(id: string): Promise<TemplateSyncStatus> {
  return (await apiJson<ApiData<TemplateSyncStatus>>(`/api/v1/ontologies/${id}/template-sync`, { method: "POST" })).data;
}

export async function getOntologyFile(id: string, path: string): Promise<{ path: string; content: string }> {
  return (await apiJson<ApiData<{ path: string; content: string }>>(`/api/v1/ontologies/${id}/files?path=${encodeURIComponent(path)}`)).data;
}

export async function generateOntologyGraph(id: string): Promise<{ graphPath: string; htmlPath: string; html: string; stats: { nodeCount: number; edgeCount: number; types: Record<string, number> } }> {
  return (await apiJson<ApiData<{ graphPath: string; htmlPath: string; html: string; stats: { nodeCount: number; edgeCount: number; types: Record<string, number> } }>>(`/api/v1/ontologies/${id}/graph`, { method: "POST" })).data;
}

export async function generateOntologyLayerGraph(id: string): Promise<{ graphPath: string; htmlPath: string; html: string; stats: { nodeCount: number; edgeCount: number; types: Record<string, number> } }> {
  return (await apiJson<ApiData<{ graphPath: string; htmlPath: string; html: string; stats: { nodeCount: number; edgeCount: number; types: Record<string, number> } }>>(`/api/v1/ontologies/${id}/ontology-graph`, { method: "POST" })).data;
}

export interface OntologyUploadInput {
  name: string;
  file?: File;
  content?: string;
  contentBase64?: string;
  contentType?: string;
  targetDir?: "raw" | "sources";
}

export interface OntologyUploadResult {
  path: string;
  name: string;
  size: number;
  converted?: boolean;
  converter?: "markitdown" | "text" | "pdftotext" | "vision" | "json";
  sourceName?: string;
  originalPath?: string;
  originalName?: string;
  conversionStatus?: "converted" | "not_required" | "failed";
  conversionError?: string;
  files?: Array<{
    path: string;
    name: string;
    size: number;
    converted?: boolean;
    converter?: "markitdown" | "text" | "pdftotext" | "vision" | "json";
    sourceName?: string;
    originalPath?: string;
    originalName?: string;
    conversionStatus?: "converted" | "not_required" | "failed";
    conversionError?: string;
    extractionReportPath?: string;
    lossRisk?: "low" | "medium" | "high";
    extractionWarnings?: string[];
  }>;
  journeyState?: JourneyState;
}

export async function uploadOntologyFile(id: string, input: OntologyUploadInput): Promise<OntologyUploadResult> {
  if (input.file) {
    const form = new FormData();
    form.append("file", input.file, input.name || input.file.name);
    form.append("name", input.name || input.file.name);
    if (input.contentType || input.file.type) form.append("contentType", input.contentType || input.file.type);
    if (input.targetDir) form.append("targetDir", input.targetDir);
    return (await apiJson<ApiData<OntologyUploadResult>>(`/api/v1/ontologies/${id}/files`, { method: "POST", body: form })).data;
  }
  return (await apiJson<ApiData<OntologyUploadResult>>(`/api/v1/ontologies/${id}/files`, { method: "POST", body: JSON.stringify(input) })).data;
}

export async function getJourneyState(id: string): Promise<JourneyState> {
  return (await apiJson<ApiData<JourneyState>>(`/api/v1/ontologies/${id}/journey`)).data;
}

export async function listOntologyRawSources(id: string): Promise<BootstrapRawSource[]> {
  return (await apiJson<ApiData<BootstrapRawSource[]>>(`/api/v1/ontologies/${id}/raw`)).data;
}

export async function uploadOntologyRawSource(id: string, input: Pick<OntologyUploadInput, "name" | "file" | "content" | "contentBase64" | "contentType">): Promise<OntologyUploadResult & { journeyState: JourneyState }> {
  if (input.file) {
    const form = new FormData();
    form.append("file", input.file, input.name || input.file.name);
    form.append("name", input.name || input.file.name);
    if (input.contentType || input.file.type) form.append("contentType", input.contentType || input.file.type);
    return (await apiJson<ApiData<OntologyUploadResult & { journeyState: JourneyState }>>(`/api/v1/ontologies/${id}/raw`, { method: "POST", body: form })).data;
  }
  return (await apiJson<ApiData<OntologyUploadResult & { journeyState: JourneyState }>>(`/api/v1/ontologies/${id}/raw`, { method: "POST", body: JSON.stringify(input) })).data;
}

export async function approveOntologyReview(id: string, options?: ReviewActionOptions): Promise<{ review: ReviewState; journeyState: JourneyState; ontologySync?: OntologySyncResult }> {
  return (await apiJson<ApiData<{ review: ReviewState; journeyState: JourneyState; ontologySync?: OntologySyncResult }>>(`/api/v1/ontologies/${id}/review/approve`, { method: "POST", body: reviewActionBody(options) })).data;
}

export async function discardOntologyReview(id: string, options?: ReviewActionOptions): Promise<{ review: ReviewState; journeyState: JourneyState }> {
  return (await apiJson<ApiData<{ review: ReviewState; journeyState: JourneyState }>>(`/api/v1/ontologies/${id}/review/discard`, { method: "POST", body: reviewActionBody(options) })).data;
}

export async function listPendingOntologyReviews(id: string): Promise<PendingReviewDraftSummary[]> {
  return (await apiJson<ApiData<{ drafts: PendingReviewDraftSummary[] }>>(`/api/v1/ontologies/${id}/reviews/pending`)).data.drafts;
}

export async function getOntologyReviewDraft(id: string, draftId: string): Promise<PendingReviewDraftDetail> {
  return (await apiJson<ApiData<PendingReviewDraftDetail>>(`/api/v1/ontologies/${id}/reviews/${encodeURIComponent(draftId)}`)).data;
}

export async function approveOntologyReviewDraft(id: string, draftId: string, options?: ReviewActionOptions): Promise<{ review: ReviewState; journeyState: JourneyState; ontologySync?: OntologySyncResult }> {
  return (await apiJson<ApiData<{ review: ReviewState; journeyState: JourneyState; ontologySync?: OntologySyncResult }>>(`/api/v1/ontologies/${id}/reviews/${encodeURIComponent(draftId)}/approve`, { method: "POST", body: reviewActionBody(options) })).data;
}

export async function discardOntologyReviewDraft(id: string, draftId: string, options?: ReviewActionOptions): Promise<{ review: ReviewState; journeyState: JourneyState }> {
  return (await apiJson<ApiData<{ review: ReviewState; journeyState: JourneyState }>>(`/api/v1/ontologies/${id}/reviews/${encodeURIComponent(draftId)}/discard`, { method: "POST", body: reviewActionBody(options) })).data;
}

export async function approveAllOntologyReviews(id: string, options?: ReviewActionOptions): Promise<{ reviews: ReviewState[]; journeyState: JourneyState; ontologySync?: OntologySyncResult }> {
  return (await apiJson<ApiData<{ reviews: ReviewState[]; journeyState: JourneyState; ontologySync?: OntologySyncResult }>>(`/api/v1/ontologies/${id}/reviews/approve-all`, { method: "POST", body: reviewActionBody(options) })).data;
}

export async function discardAllOntologyReviews(id: string, options?: ReviewActionOptions): Promise<{ discarded: PendingReviewDraftSummary[]; journeyState: JourneyState }> {
  return (await apiJson<ApiData<{ discarded: PendingReviewDraftSummary[]; journeyState: JourneyState }>>(`/api/v1/ontologies/${id}/reviews/discard-all`, { method: "POST", body: reviewActionBody(options) })).data;
}

export async function recoverOntologyReview(id: string, options?: ReviewActionOptions): Promise<{ recovered: PendingReviewDraftSummary[]; archive: { recoveryId: string; recoveryPath: string; manifestPath: string; createdAt: string; draftIds: string[]; archivedDrafts: string[]; archivedIngestPlans: string[]; archivedVerifyArtifacts: string[] } | null; journeyState: JourneyState }> {
  return (await apiJson<ApiData<{ recovered: PendingReviewDraftSummary[]; archive: { recoveryId: string; recoveryPath: string; manifestPath: string; createdAt: string; draftIds: string[]; archivedDrafts: string[]; archivedIngestPlans: string[]; archivedVerifyArtifacts: string[] } | null; journeyState: JourneyState }>>(`/api/v1/ontologies/${id}/reviews/recover`, { method: "POST", body: reviewActionBody(options) })).data;
}
