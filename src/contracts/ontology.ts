export type OntologyProjectStatus = "active" | "bootstrapping" | "empty";
export type KnowledgeBaseShareRole = "viewer" | "editor" | "manager";
export type EffectiveKnowledgeBaseRole = KnowledgeBaseShareRole | "owner";
export type KnowledgeBaseAccessSource = "owner" | "member" | "tenant";

export interface KnowledgeBaseCapabilities {
  use: boolean;
  contribute: boolean;
  review: boolean;
  manageShares: boolean;
  manageManagers: boolean;
  editProfile: boolean;
  delete: boolean;
}

export interface OntologyProject {
  id: string;
  tenantId?: string;
  ownerId?: string;
  name: string;
  description: string;
  pageCount: number;
  lastUpdated: string;
  status: OntologyProjectStatus;
  color: string;
  emoji: string;
  favorite?: boolean;
  createdAt?: string;
  updatedAt?: string;
  accessRole?: EffectiveKnowledgeBaseRole;
  accessSource?: KnowledgeBaseAccessSource;
  capabilities?: KnowledgeBaseCapabilities;
  ownerDisplayName?: string;
  deletedAt?: string;
  placeholderRemoved?: boolean;
}

export interface OntologySession {
  id: string;
  ontologyId?: string;
  projectId?: string;
  projectName: string;
  projectColor: string;
  preview: string;
  /** The channel that created this session. External sessions are retained but omitted from default workbench lists. */
  origin?: "workbench" | "external";
  updatedAt: number;
  lastActiveAt?: number;
  timeAgo: string;
  claudeSessionId?: string | null;
  createdAt?: string;
}

export interface OntologyMessage {
  id?: string;
  sessionId?: string;
  ontologyId?: string;
  role: "user" | "agent" | "assistant" | "system";
  content: string;
  parts?: Record<string, unknown>[];
  createdAt?: string;
  phaseTransition?: JourneyPhase;
  phaseData?: PhasePayload;
}

export interface ConversationSnapshotMessage {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
}

export interface ConversationSnapshot {
  id?: string;
  token: string;
  knowledgeBaseId?: string;
  messages: ConversationSnapshotMessage[];
  createdAt: string;
  url?: string;
}

export interface KnowledgeBaseShare {
  id: string;
  ontologyId: string;
  scope: "user" | "tenant";
  subjectUserId?: string;
  subjectTenantId: string;
  subjectUsername?: string;
  subjectUseremail?: string;
  subjectCompanyname?: string;
  role: KnowledgeBaseShareRole;
  createdByUserId: string;
  createdByUsername?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingKnowledgeBaseInvitation {
  id: string;
  ontologyId: string;
  email: string;
  role: KnowledgeBaseShareRole;
  deliveryStatus: "pending" | "sent" | "failed";
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseChangeRecord {
  id: string;
  ontologyId: string;
  actorTenantId: string;
  actorUserId: string;
  actorDisplayName: string;
  protocol: "workbench" | "rest" | "mcp" | "a2a";
  authorizationRole: EffectiveKnowledgeBaseRole;
  authorizationSource: KnowledgeBaseAccessSource;
  action: string;
  outcome: "applied" | "rejected" | "failed";
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface OntologyFileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: OntologyFileNode[];
}

export type JourneyPhase = "bootstrap" | "ingest" | "review" | "verify" | "ready";
export type JourneyFlow = "build" | "maintenance";

export interface BootstrapRawSource {
  path: string;
  name: string;
  size: number;
  mimeType?: string;
  status: "uploaded" | "unsupported_for_schema" | "ready";
  uploadedAt: string;
  originalPath?: string;
  originalName?: string;
  sourceName?: string;
  conversionStatus?: "converted" | "not_required" | "failed";
  conversionError?: string;
  extractionReportPath?: string;
  lossRisk?: "low" | "medium" | "high";
  extractionWarnings?: string[];
}

export interface BootstrapState {
  name: string | null;
  description: string | null;
  pageTypes: { name: string; description?: string; confirmed: boolean }[];
  sources: string[];
  step: number;
  totalSteps: number;
  status?: "goal_selection" | "materials_collection" | "materials_ready" | "schema_proposed" | "schema_confirmation" | "metadata_proposed" | "metadata_confirmation" | "hydrating" | "done";
  awaitingUser?: boolean;
  confirmationPrompt?: string;
  goal?: string;
  rawSources?: BootstrapRawSource[];
  skippedMaterials?: boolean;
  result?: {
    name: string;
    description: string;
    emoji: string;
    content_language?: string;
    knowledge_subdirs: string[];
    wiki_subdirs?: string[];
    naming_conventions: string[];
  };
}

export interface IngestFile {
  path: string;
  status: "pending" | "processing" | "done" | "error";
}

export interface IngestBatch {
  id: string;
  label: string;
  description: string;
  fileCount: number;
  status: "pending" | "processing" | "success" | "failed";
  files?: string[];
}

export interface IngestState {
  files?: IngestFile[];
  generatedPages?: string[];
  totalBatches: number;
  completedBatches: number;
  progress: number;
  batches: IngestBatch[];
  planId?: string;
  targetDirectory?: string;
  status?: "in_progress" | "completed" | "pending" | "failed";
}

export interface VerifyCase {
  id?: string;
  name: string;
  status: "queued" | "running" | "pass" | "fail" | "warning" | "fixing" | "retesting" | "fixed";
  level?: string;
  question?: string;
  expectedAnswer?: string;
  sourceFile?: string;
  initialAnswer?: string;
  knowledgeAnswer?: string;
  knowledgeReference?: unknown;
  note?: string;
  repaired?: boolean;
}

export interface VerifyState {
  status: "generating" | "testing" | "fixing" | "done";
  questionCount: number;
  coverage: number;
  autoFixed: number;
  needsInput: number;
  cases: VerifyCase[];
  fixes: string[];
  passCount?: number;
  failCount?: number;
  fixedCount?: number;
  answeredCount?: number;
  planId?: string;
  draftId?: string;
  artifactBase?: string;
  artifactUpdatedAt?: string;
}

export interface JourneyState {
  flow: JourneyFlow;
  phase: JourneyPhase;
  bootstrap: BootstrapState;
  ingest: IngestState;
  verify: VerifyState;
  review?: ReviewState;
  updatedAt: string;
}

export interface ReviewFile {
  path: string;
  status: "new" | "modified";
  content: string;
  oldContent?: string;
}

export interface ReviewState {
  description: string;
  files: ReviewFile[];
  status?: "pending" | "approved" | "discarded";
  draftId?: string;
}

export type OntologySyncStatus = "started" | "skipped" | "failed_to_start";

export interface OntologySyncResult {
  status: OntologySyncStatus;
  updateId?: string;
  materialRoot?: string;
  diffPath?: string;
  sessionId?: string;
  runId?: string;
  reason?: string;
  includedFiles?: string[];
  excludedFiles?: string[];
}

export interface PendingReviewDraftSummary {
  draftId: string;
  operation: string;
  description: string;
  updatedAt: string;
  fileCount: number;
  newCount: number;
  modifiedCount: number;
  canApprove: boolean;
  gateReason: "no_draft" | "verify_missing" | "verify_in_progress" | "verify_failed" | "verify_passed" | "manual_review" | "empty_draft";
  gateMessage: string;
  verifyCommand?: string;
}

export interface PendingReviewDraftDetail extends PendingReviewDraftSummary {
  files: ReviewFile[];
}

export type PhasePayload =
  | { type: "bootstrap"; state: Partial<BootstrapState> }
  | { type: "ingest"; state: Partial<IngestState> }
  | { type: "review"; state: Partial<ReviewState> }
  | { type: "verify"; state: Partial<VerifyState> };

export type OntologyStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool"; tool: string; input?: unknown }
  | { type: "message"; message: OntologyMessage }
  | { type: "journey-state"; state: JourneyState }
  | { type: "tree-updated"; ontologyId: string }
  | { type: "finish"; sessionId: string; claudeSessionId?: string | null }
  /** The upstream model call failed with a retryable error and the SDK is backing off before the next attempt. */
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number; status: number | null }
  | { type: "error"; error: string };

export type OperationStatus = "running" | "succeeded" | "failed" | "cancelled";
export type OperationErrorCode = "agent_run_cancelled" | "agent_run_failed" | "operation_finish_missing";

export interface OperationLogEntry {
  at: string;
  summary: string;
  path?: string;
}

export interface OperationArtifact {
  path: string;
  description?: string;
}

export interface OperationRun {
  id: string;
  ontologyId: string;
  sessionId: string;
  userRequest: string;
  status: OperationStatus;
  title?: string;
  logs: OperationLogEntry[];
  artifacts: OperationArtifact[];
  resultSummary?: string;
  reportPath?: string;
  error?: string;
  errorCode?: OperationErrorCode;
  startedAt: string;
  finishedAt?: string;
}

export interface TemplateSyncStatus {
  status: "up_to_date" | "update_available" | "uninitialized" | "pending_variables" | "blocked";
  /** True only when the bundled template version changed since the last sync (drives the manual Sync button). */
  updateAvailable: boolean;
  syncedAt?: string;
  reason?: string;
}
