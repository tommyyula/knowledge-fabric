import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Sidebar from "./components/Sidebar";
import OntologyStewardChatPanel, {
  type PendingConversation,
} from "./components/OntologyStewardChatPanel";
import { ConnectorDialog } from "./components/ConnectorDialog";
import KnowledgePanel from "./components/KnowledgePanel";
import JourneyPanel from "./components/JourneyPanel";
import MyOntologiesPage from "./components/MyOntologiesPage";
import ResourceLibraryPage from "./components/ResourceLibraryPage";
import FilePreviewModal from "./components/FilePreviewModal";
import RepositoryPreviewModal from "./components/RepositoryPreviewModal";
import AdminDataPage from "./components/AdminDataPage";
import OperationRunsPage from "./components/OperationRunsPage";
import { useTheme } from "./hooks/useTheme";
import {
  mockFolders,
  mockProjects,
  mockResources,
  mockSessions,
  Project,
  Resource,
  ResourceFolder,
  ResourceType,
  JourneyPhase,
  BootstrapState,
  IngestState,
  VerifyState,
  ReviewState,
  ChatMessage,
  PhasePayload,
  Session,
} from "./mocks/data";
import {
  useAllOntologySessions,
  useApproveAllOntologyReviews,
  useCreateOntology,
  useCreateOntologySession,
  useCreateResourceFolder,
  useDeleteOntology,
  useDeleteOntologySession,
  useDeleteResource,
  useDeleteResourceFolder,
  useJourneyState,
  useOntologies,
  useOntologyChatStatuses,
  useOntologyRawSources,
  useOntologySessions,
  useResourceLibrary,
  useResourcePreview,
  useUpdateOntology,
  useUpdateOntologySession,
  useUploadOntologyRawSource,
  useUploadResource,
} from "./hooks/useOntologies";
import { createT, Locale, persistUiLocale, readUiLocale } from "./i18n";
import type { JourneyFlow, JourneyState, OperationRun } from "@/contracts/ontology";
import type { SlashCommandId } from "@/contracts/slash-commands";
import {
  APP_TOAST_EVENT,
  errorMessage,
  showToast,
  type AppToast,
} from "@/lib/toast";
import { assertUploadBatchWithinLimit } from "@/lib/upload-limits";
import { publishAndCopyConversationLink } from "@/lib/conversation-share";
import { composerFileReferencesStore, type ComposerFileReference } from "@/lib/composer-file-references-store";
import { composerPromptModeStore } from "@/lib/composer-prompt-mode-store";
import {
  downloadFolder,
  downloadResource,
} from "@/services/api/resource-library";
import { useUserStore } from "@/stores/useUserStore";

const initialBootstrap: BootstrapState = {
  name: null,
  description: null,
  pageTypes: [],
  sources: [],
  step: 0,
  totalSteps: 6,
  status: "done",
  awaitingUser: false,
  rawSources: [],
};
const initialIngest: IngestState = {
  files: [],
  generatedPages: [],
  totalBatches: 0,
  completedBatches: 0,
  progress: 0,
  batches: [],
};
const initialVerify: VerifyState = {
  status: "generating",
  questionCount: 0,
  coverage: 0,
  autoFixed: 0,
  needsInput: 0,
  cases: [],
  fixes: [],
};
const initialReview: ReviewState = {
  description: "",
  files: [],
  status: "approved",
};
const emptyResources: Resource[] = [];
const emptyFolders: ResourceFolder[] = [];
const activeChatStateKey = "knowledge-fabric.active-chat-state.v1";
const sidebarSessionRunStateKey =
  "knowledge-fabric.sidebar-session-run-state.v1";

interface ActiveChatState {
  projectId: string | null;
  sessionId: string | null;
  updatedAt: number;
}

interface SidebarSessionRunState {
  readRunIds: Record<string, string>;
  knownRunIds: Record<string, string>;
  activeRunIds: Record<string, string>;
  updatedAt: number;
}

interface ConversationEntryInput {
  message: string;
  backendMessage: string;
  slashCommandId: SlashCommandId | null;
  intent: "create" | "select";
  project: Project | null;
  files: File[];
  resourceIds: string[];
  resourceFolderIds: string[];
  workspaceFiles: string[];
  workspaceReferences: ComposerFileReference[];
}

interface ConversationPreparationContext {
  id: string;
  input: ConversationEntryInput;
  shouldCreate: boolean;
  project: Project | null;
  session: Session | null;
  journeyState: JourneyState | null;
  uploadedPaths: string[];
  uploadedFileCount: number;
}

type DuplicateFolderUploadDecision =
  | { action: "replace" }
  | { action: "copy"; name: string }
  | { action: "cancel" };

type ResourceUploadOptions = {
  onFolderNameResolved?: (input: { originalName: string; resolvedName: string }) => void;
};

interface DuplicateFolderUploadPrompt {
  id: string;
  folderName: string;
  parentName: string;
  incomingCount: number;
  existingCount: number;
  unavailableNames: string[];
}

function conversationEntryId(): string {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createPendingKnowledgeProject(id: string): Project {
  const now = new Date().toISOString();
  return {
    id: `pending-${id}`,
    name: "Untitled Knowledge Base",
    description: "Initialized from the knowledge agent skills workspace.",
    pageCount: 0,
    lastUpdated: "just now",
    status: "bootstrapping",
    color: "#8ab4f8",
    emoji: "\u{1F4DA}",
    createdAt: now,
    updatedAt: now,
  };
}

function emptySidebarSessionRunState(): SidebarSessionRunState {
  return { readRunIds: {}, knownRunIds: {}, activeRunIds: {}, updatedAt: 0 };
}

function readSidebarSessionRunState(): SidebarSessionRunState {
  if (typeof window === "undefined") return emptySidebarSessionRunState();
  try {
    const raw = window.localStorage.getItem(sidebarSessionRunStateKey);
    if (!raw) return emptySidebarSessionRunState();
    const parsed = JSON.parse(raw) as Partial<SidebarSessionRunState>;
    return {
      readRunIds:
        parsed.readRunIds &&
        typeof parsed.readRunIds === "object" &&
        !Array.isArray(parsed.readRunIds)
          ? stringRecord(parsed.readRunIds)
          : {},
      knownRunIds:
        parsed.knownRunIds &&
        typeof parsed.knownRunIds === "object" &&
        !Array.isArray(parsed.knownRunIds)
          ? stringRecord(parsed.knownRunIds)
          : {},
      activeRunIds:
        parsed.activeRunIds &&
        typeof parsed.activeRunIds === "object" &&
        !Array.isArray(parsed.activeRunIds)
          ? stringRecord(parsed.activeRunIds)
          : {},
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return emptySidebarSessionRunState();
  }
}

function writeSidebarSessionRunState(
  state: SidebarSessionRunState,
): SidebarSessionRunState {
  const next = { ...state, updatedAt: Date.now() };
  if (typeof window !== "undefined")
    window.localStorage.setItem(
      sidebarSessionRunStateKey,
      JSON.stringify(next),
    );
  return next;
}

function stringRecord(value: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function sameSidebarSessionRunState(
  left: SidebarSessionRunState,
  right: SidebarSessionRunState,
): boolean {
  return (
    sameStringRecord(left.readRunIds, right.readRunIds) &&
    sameStringRecord(left.knownRunIds, right.knownRunIds) &&
    sameStringRecord(left.activeRunIds, right.activeRunIds)
  );
}

function sameStringRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

function readActiveChatState(): ActiveChatState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(activeChatStateKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveChatState>;
    return {
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function writeActiveChatState(
  updates: Partial<ActiveChatState>,
): ActiveChatState | null {
  if (typeof window === "undefined") return null;
  const current = readActiveChatState();
  const next: ActiveChatState = {
    projectId: updates.projectId ?? null,
    sessionId: updates.sessionId ?? null,
    ...(current ?? {}),
    ...updates,
    updatedAt: Date.now(),
  };
  window.localStorage.setItem(activeChatStateKey, JSON.stringify(next));
  return next;
}

function rememberActiveChatSelection(
  projectId: string,
  sessionId: string,
): ActiveChatState | null {
  return writeActiveChatState({ projectId, sessionId });
}

function clearActiveChatSelection(): ActiveChatState | null {
  return writeActiveChatState({ projectId: null, sessionId: null });
}

const inferResourceType = (name: string): ResourceType => {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext))
    return "image";
  if (["xlsx", "xls", "csv"].includes(ext)) return "spreadsheet";
  if (["pdf", "doc", "docx", "md", "txt"].includes(ext)) return "doc";
  if (["yaml", "yml", "json"].includes(ext)) return "api";
  return "file";
};

function normalizeResourcePreviewPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .trim()
    .toLowerCase();
}

function resourceDisplayPath(
  resource: Resource,
  folderById: Map<string, ResourceFolder>,
): string {
  const segments = [resource.name];
  const seen = new Set<string>();
  let cursor = resource.folder ? folderById.get(resource.folder) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    segments.unshift(cursor.name);
    seen.add(cursor.id);
    cursor = cursor.parentId ? folderById.get(cursor.parentId) : undefined;
  }
  return segments.join("/");
}

function resourceFolderKey(parentId: string | null | undefined, name: string): string {
  return `${parentId ?? "root"}:${name.trim().toLowerCase()}`;
}

function defaultCopyFolderName(name: string, unavailableNames: readonly string[]): string {
  const unavailable = new Set(
    unavailableNames.map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  const baseName = `${name}Copy`;
  if (!unavailable.has(baseName.toLowerCase())) return baseName;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!unavailable.has(candidate.toLowerCase())) return candidate;
  }
  return `${baseName} ${Date.now()}`;
}

function collectResourceFolderTreeIds(folders: readonly ResourceFolder[], rootFolderId: string): Set<string> {
  const ids = new Set<string>([rootFolderId]);
  const visit = (parentId: string) => {
    folders.forEach((folder) => {
      if (folder.parentId !== parentId || ids.has(folder.id)) return;
      ids.add(folder.id);
      visit(folder.id);
    });
  };
  visit(rootFolderId);
  return ids;
}

function resourceCountInFolderTree(resources: readonly Resource[], folders: readonly ResourceFolder[], rootFolderId: string): number {
  const folderIds = collectResourceFolderTreeIds(folders, rootFolderId);
  return resources.filter((resource) => resource.folder && folderIds.has(resource.folder)).length;
}

function DuplicateFolderUploadDialog({
  prompt,
  t,
  onResolve,
}: {
  prompt: DuplicateFolderUploadPrompt;
  t: (key: string, params?: Record<string, string>) => string;
  onResolve: (decision: DuplicateFolderUploadDecision) => void;
}) {
  const defaultName = defaultCopyFolderName(prompt.folderName, prompt.unavailableNames);
  const [copyName, setCopyName] = useState(defaultName);
  useEffect(() => {
    setCopyName(defaultName);
  }, [defaultName]);
  const trimmedCopyName = copyName.trim();
  const unavailableNames = new Set(prompt.unavailableNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
  const copyNameError = !trimmedCopyName
    ? t("resource.folderConflictNameRequired")
    : trimmedCopyName.length > 180
      ? t("resource.folderConflictNameTooLong")
      : unavailableNames.has(trimmedCopyName.toLowerCase())
        ? t("resource.folderConflictNameExists")
        : null;

  const saveCopy = () => {
    if (copyNameError) return;
    onResolve({ action: "copy", name: trimmedCopyName });
  };

  return (
    <div className="modal-overlay" onClick={() => onResolve({ action: "cancel" })}>
      <div className="modal-dialog duplicate-folder-dialog" role="dialog" aria-modal="true" aria-labelledby="duplicate-folder-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="duplicate-folder-title">{t("resource.folderConflictTitle")}</h2>
        <p className="modal-body-text">{t("resource.folderConflictBody", { name: prompt.folderName })}</p>
        <div className="confirm-dialog-object" title={prompt.folderName}>{prompt.folderName}</div>
        <p className="modal-subtitle">
          {t("resource.folderConflictStats", {
            incoming: String(prompt.incomingCount),
            existing: String(prompt.existingCount),
            parent: prompt.parentName,
          })}
        </p>
        <label className="modal-label" htmlFor={`duplicate-folder-copy-name-${prompt.id}`}>{t("resource.folderConflictCopyNameLabel")}</label>
        <input
          id={`duplicate-folder-copy-name-${prompt.id}`}
          className="modal-input duplicate-folder-input"
          value={copyName}
          maxLength={180}
          onChange={(event) => setCopyName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !copyNameError) saveCopy();
          }}
          autoFocus
        />
        {copyNameError && <div className="duplicate-folder-name-error" role="alert">{copyNameError}</div>}
        <div className="modal-actions duplicate-folder-actions">
          <button className="modal-btn modal-btn-cancel" onClick={(event) => { event.stopPropagation(); onResolve({ action: "cancel" }); }} type="button">{t("common.cancel")}</button>
          <button className="modal-btn modal-btn-danger" onClick={(event) => { event.stopPropagation(); onResolve({ action: "replace" }); }} type="button">{t("resource.folderConflictReplace")}</button>
          <button className="modal-btn modal-btn-primary" onClick={(event) => { event.stopPropagation(); saveCopy(); }} type="button" disabled={Boolean(copyNameError)}>{t("resource.folderConflictSaveCopy")}</button>
        </div>
      </div>
    </div>
  );
}

function withLiveProjectIdentity(
  sessions: readonly Session[],
  projects: readonly Project[],
  t: (key: string, params?: Record<string, string>) => string,
): Session[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  return sessions.map((session) => {
    const project = projectById.get(
      session.projectId ?? session.ontologyId ?? "",
    );
    const updatedAt = Number(session.updatedAt || Date.now());
    const lastActiveAt = Number(session.lastActiveAt || updatedAt);
    const next = {
      ...session,
      updatedAt,
      lastActiveAt,
      timeAgo: formatSessionTime(lastActiveAt, t),
      ...(project
        ? { projectName: project.name, projectColor: project.color }
        : {}),
    };
    if (
      session.projectName === next.projectName &&
      session.projectColor === next.projectColor &&
      session.timeAgo === next.timeAgo &&
      session.updatedAt === next.updatedAt &&
      session.lastActiveAt === next.lastActiveAt
    ) {
      return session;
    }
    return next;
  });
}

function formatSessionTime(
  updatedAt: number,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const date = new Date(updatedAt);
  if (!Number.isFinite(date.getTime())) return "";

  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - updatedAt);
  const minute = 60 * 1000;
  const day = 24 * 60 * minute;

  if (diffMs < minute) return t("common.justNow");
  if (diffMs < day) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diffMs < 2 * day) return t("common.yesterday");

  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return date.toLocaleDateString([], options);
}

function sameSessionList(
  left: readonly Session[],
  right: readonly Session[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((session, index) => {
    const other = right[index];
    return (
      Boolean(other) &&
      session.id === other.id &&
      session.projectName === other.projectName &&
      session.projectColor === other.projectColor &&
      session.preview === other.preview &&
      session.origin === other.origin &&
      session.updatedAt === other.updatedAt &&
      session.lastActiveAt === other.lastActiveAt &&
      session.timeAgo === other.timeAgo
    );
  });
}

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const isAdmin = useUserStore((state) => state.userInfo?.isAdmin === true);
  const ontologiesQuery = useOntologies();
  const createOntology = useCreateOntology();
  const createOntologySession = useCreateOntologySession();
  const updateOntology = useUpdateOntology();
  const deleteOntology = useDeleteOntology();
  const updateOntologySession = useUpdateOntologySession();
  const deleteOntologySession = useDeleteOntologySession();
  const uploadRawSource = useUploadOntologyRawSource();
  const resourceLibraryQuery = useResourceLibrary();
  const uploadResource = useUploadResource();
  const createResourceFolder = useCreateResourceFolder();
  const deleteResource = useDeleteResource();
  const deleteResourceFolder = useDeleteResourceFolder();
  const approveAllReviews = useApproveAllOntologyReviews();
  const [locale, setLocale] = useState<Locale>(readUiLocale);
  const t = useMemo(() => createT(locale), [locale]);

  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const currentProjectId = currentProject?.id;
  const activeProjectId = currentProject?.deletedAt ? undefined : currentProject?.id;
  const sessionsQuery = useOntologySessions(currentProject?.id);
  const allSessionsQuery = useAllOntologySessions(projects);
  const journeyQuery = useJourneyState(activeProjectId);
  const rawSourcesQuery = useOntologyRawSources(activeProjectId);
  const allowMockFallback =
    import.meta.env.VITE_ENABLE_MOCK_FALLBACK === "true";
  const usingMockProjects = allowMockFallback && ontologiesQuery.isError;
  const [freshSession, setFreshSession] = useState<Session | null>(null);
  const activeChatStateRef = useRef<ActiveChatState | null>(
    readActiveChatState(),
  );
  const getActiveChatState = useCallback(() => {
    const state = activeChatStateRef.current ?? readActiveChatState();
    activeChatStateRef.current = state;
    return state;
  }, []);
  const currentProjectSessions = useMemo(() => {
    const sessions =
      usingMockProjects || currentProject?.id.startsWith("proj-")
        ? mockSessions.filter(
            (s) =>
              !currentProject ||
              s.projectId === currentProject.id ||
              s.ontologyId === currentProject.id,
          )
        : (sessionsQuery.data ?? []);
    const freshProjectId = freshSession?.projectId ?? freshSession?.ontologyId;
    const sessionsWithFresh =
      freshSession &&
      currentProject?.id === freshProjectId &&
      !sessions.some((session) => session.id === freshSession.id)
        ? [freshSession, ...sessions]
        : sessions;
    return withLiveProjectIdentity(sessionsWithFresh, projects, t)
      .filter((session) => session.origin !== "external");
  }, [
    currentProject,
    freshSession,
    projects,
    sessionsQuery.data,
    t,
    usingMockProjects,
  ]);
  const rawRecentSessions = useMemo(
    () =>
      withLiveProjectIdentity(
        usingMockProjects ? mockSessions : allSessionsQuery.data,
        projects,
        t,
      ).filter((session) => session.origin !== "external"),
    [allSessionsQuery.data, projects, t, usingMockProjects],
  );
  const [visibleRecentSessions, setVisibleRecentSessions] = useState<Session[]>(
    [],
  );
  useEffect(() => {
    if (
      !usingMockProjects &&
      allSessionsQuery.isLoading &&
      rawRecentSessions.length === 0
    )
      return;
    setVisibleRecentSessions((previous) => {
      return sameSessionList(previous, rawRecentSessions)
        ? previous
        : rawRecentSessions;
    });
  }, [allSessionsQuery.isLoading, rawRecentSessions, usingMockProjects]);
  const recentSessions = useMemo(() => {
    if (visibleRecentSessions.length || rawRecentSessions.length === 0)
      return visibleRecentSessions;
    return rawRecentSessions;
  }, [rawRecentSessions, visibleRecentSessions]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (
      freshSession &&
      sessionsQuery.data?.some((session) => session.id === freshSession.id)
    )
      setFreshSession(null);
  }, [freshSession, sessionsQuery.data]);
  const [draftSessionProjectId, setDraftSessionProjectId] = useState<
    string | null
  >(null);
  const sidebarSessions = recentSessions;
  const sidebarChatStatuses = useOntologyChatStatuses(
    usingMockProjects ? [] : sidebarSessions,
  );
  const sidebarChatStatusSignature = useMemo(
    () =>
      sidebarChatStatuses
        .map(
          (item) =>
            `${item.sessionId}:${item.status?.runId ?? ""}:${item.status?.active ? "1" : "0"}:${item.status?.completed ? "1" : "0"}`,
        )
        .join("|"),
    [sidebarChatStatuses],
  );
  const currentProjectRunActive = useMemo(
    () =>
      Boolean(
        currentProjectId &&
        sidebarChatStatuses.some(
          (item) => item.ontologyId === currentProjectId && item.status?.active,
        ),
      ),
    [currentProjectId, sidebarChatStatuses],
  );
  const currentSessionRunActive = useMemo(
    () =>
      Boolean(
        currentSessionId &&
        sidebarChatStatuses.some(
          (item) => item.sessionId === currentSessionId && item.status?.active,
        ),
      ),
    [currentSessionId, sidebarChatStatuses],
  );
  const [sidebarSessionRunState, setSidebarSessionRunState] =
    useState<SidebarSessionRunState>(readSidebarSessionRunState);
  const [knowledgePanelOpen, setKnowledgePanelOpen] = useState(true);
  const [knowledgePanelWidth, setKnowledgePanelWidth] = useState(400);
  const [activePage, setActivePage] = useState<
    | "chat"
    | "my-ontologies"
    | "resource-library"
    | "operation-runs"
    | "admin-data"
    | "review"
    | "reports"
  >(() => {
    // 先尝试 sessionStorage（从分享页跳转过来时写入）
    try {
      const stored = sessionStorage.getItem("knowledge-fabric.navigate-to-page.v1");
      if (stored) {
        sessionStorage.removeItem("knowledge-fabric.navigate-to-page.v1");
        const valid = ["chat", "my-ontologies", "resource-library", "operation-runs", "admin-data", "review", "reports"];
        if (valid.includes(stored)) return stored as "chat" | "my-ontologies" | "resource-library" | "operation-runs" | "admin-data" | "review" | "reports";
      }
    } catch { /* ignore */ }
    return "chat";
  });
  const [favorites, setFavorites] = useState<Set<string>>(
    new Set(["proj-marketplace", "proj-infra"]),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [connectorDialogOpen, setConnectorDialogOpen] = useState(false);
  const [toasts, setToasts] = useState<AppToast[]>([]);
  const [resourcePreviewId, setResourcePreviewId] = useState<string | null>(
    null,
  );
  const [selectedOperationRun, setSelectedOperationRun] =
    useState<OperationRun | null>(null);
  useEffect(() => {
    const onToast = (event: Event) => {
      const toast = (event as CustomEvent<AppToast>).detail;
      if (!toast) return;
      setToasts((prev) => [...prev, toast].slice(-4));
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== toast.id));
      }, toast.durationMs);
    };
    window.addEventListener(APP_TOAST_EVENT, onToast);
    return () => window.removeEventListener(APP_TOAST_EVENT, onToast);
  }, []);
  const [fallbackResources, setFallbackResources] =
    useState<Resource[]>(mockResources);
  const [fallbackFolders, setFallbackFolders] =
    useState<ResourceFolder[]>(mockFolders);
  const [chatKey, setChatKey] = useState(0);
  const [pendingInitialMessage, setPendingInitialMessage] = useState<
    string | null
  >(null);
  const [pendingInitialBackendMessage, setPendingInitialBackendMessage] =
    useState<string | null>(null);
  const [pendingInitialSlashCommandId, setPendingInitialSlashCommandId] =
    useState<SlashCommandId | null>(null);
  const [pendingInitialFiles, setPendingInitialFiles] = useState<File[]>([]);
  const [pendingInitialWorkspaceFiles, setPendingInitialWorkspaceFiles] =
    useState<string[]>([]);
  const [
    pendingInitialWorkspaceReferences,
    setPendingInitialWorkspaceReferences,
  ] = useState<ComposerFileReference[]>([]);
  const [pendingInitialResourceIds, setPendingInitialResourceIds] = useState<
    string[]
  >([]);
  const [pendingInitialResourceFolderIds, setPendingInitialResourceFolderIds] =
    useState<string[]>([]);
  const [pendingConversation, setPendingConversation] =
    useState<PendingConversation | null>(null);
  const [duplicateFolderPrompt, setDuplicateFolderPrompt] = useState<DuplicateFolderUploadPrompt | null>(null);
  const resizingRef = useRef(false);
  const conversationPreparationRef =
    useRef<ConversationPreparationContext | null>(null);
  const conversationPreparationAttemptRef = useRef(0);
  const conversationEntryInFlightRef = useRef(false);
  const initialProjectSelectedRef = useRef(false);

  const [journeyPhase, setJourneyPhase] = useState<JourneyPhase | null>(null);
  const [journeyFlow, setJourneyFlow] = useState<JourneyFlow>("maintenance");
  const [journeyProjectId, setJourneyProjectId] = useState<string | null>(null);
  const [bootstrapState, setBootstrapState] =
    useState<BootstrapState>(initialBootstrap);
  const [ingestState, setIngestState] = useState<IngestState>(initialIngest);
  const [verifyState, setVerifyState] = useState<VerifyState>(initialVerify);
  const [reviewState, setReviewState] = useState<ReviewState>(initialReview);

// 1. 基础依赖状态与派生条件
    const resourceLibraryUnavailable =
        resourceLibraryQuery.isError ||
        (ontologiesQuery.isError && allowMockFallback);

// 2. 核心数据源（资源与文件夹）
    const resources = useMemo(
        () =>
            resourceLibraryUnavailable
                ? fallbackResources
                : (resourceLibraryQuery.data?.resources ?? emptyResources),
        [
            fallbackResources,
            resourceLibraryQuery.data?.resources,
            resourceLibraryUnavailable,
        ],
    );

    const folders = useMemo(
        () =>
            resourceLibraryUnavailable
                ? fallbackFolders
                : (resourceLibraryQuery.data?.folders ?? emptyFolders),
        [
            fallbackFolders,
            resourceLibraryQuery.data?.folders,
            resourceLibraryUnavailable,
        ],
    );

// 3. 文件夹索引 Map (其他派生逻辑依赖此项)
    const resourceFolderById = useMemo(
        () => new Map(folders.map((folder) => [folder.id, folder])),
        [folders],
    );

// 4. Resource Preview 相关派生状态与 Query
    const resourcePreviewQuery = useResourcePreview(
        resourceLibraryUnavailable ? null : resourcePreviewId,
    );

    const resourcePreviewResource = useMemo(
        () =>
            resources.find((resource) => resource.id === resourcePreviewId) ?? null,
        [resourcePreviewId, resources],
    );

    const resourcePreviewPaths = useMemo(
        () =>
            resources.map((resource) =>
                resourceDisplayPath(resource, resourceFolderById),
            ),
        [resourceFolderById, resources],
    );

    const resourcePreviewPathById = useMemo(() => {
        const byPath = new Map<string, string>();
        for (const resource of resources) {
            const displayPath = resourceDisplayPath(resource, resourceFolderById);
            byPath.set(normalizeResourcePreviewPath(displayPath), resource.id);
            byPath.set(normalizeResourcePreviewPath(resource.name), resource.id);
        }
        return byPath;
    }, [resourceFolderById, resources]);

// 5. 重复文件夹上传决策弹窗逻辑 (Duplicate Folder Resolver)
    const duplicateFolderResolverRef = useRef<((decision: DuplicateFolderUploadDecision) => void) | null>(null);

    const requestDuplicateFolderDecision = useCallback(
        (input: Omit<DuplicateFolderUploadPrompt, "id">): Promise<DuplicateFolderUploadDecision> =>
            new Promise((resolve) => {
                duplicateFolderResolverRef.current = resolve;
                setDuplicateFolderPrompt({
                    ...input,
                    id: `duplicate-folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                });
            }),
        [],
    );

    const resolveDuplicateFolderPrompt = useCallback(
        (decision: DuplicateFolderUploadDecision) => {
            const resolve = duplicateFolderResolverRef.current;
            duplicateFolderResolverRef.current = null;
            setDuplicateFolderPrompt(null);
            resolve?.(decision);
        },
        [],
    );
  const resourcePreviewDisplayPath = resourcePreviewResource
    ? resourceDisplayPath(resourcePreviewResource, resourceFolderById)
    : (resourcePreviewQuery.data?.path ?? "");
  const resourcePreviewError = resourceLibraryUnavailable
    ? t("filePreview.resourceUnavailable")
    : resourcePreviewQuery.error instanceof Error
      ? resourcePreviewQuery.error.message
      : undefined;
  const handleNavigateResourcePreview = useCallback(
    (targetPath: string) => {
      const withoutAnchor = targetPath.split("#")[0] ?? targetPath;
      const normalized = normalizeResourcePreviewPath(withoutAnchor);
      const withMarkdownExt = /\.mdx?$/i.test(normalized)
        ? normalized
        : `${normalized}.md`;
      const candidates = [
        normalized,
        withMarkdownExt,
        normalized.split("/").pop() ?? "",
        withMarkdownExt.split("/").pop() ?? "",
      ].filter(Boolean);
      const targetId = candidates
        .map((candidate) => resourcePreviewPathById.get(candidate))
        .find(Boolean);
      if (targetId) setResourcePreviewId(targetId);
    },
    [resourcePreviewPathById],
  );

  useEffect(() => {
    if (ontologiesQuery.data) {
      const storedProjectId = getActiveChatState()?.projectId;
      const initialProject =
        ontologiesQuery.data.find(
          (project) => project.id === storedProjectId,
        ) ??
        ontologiesQuery.data[0] ??
        null;
      const shouldSelectInitialProject =
        !initialProjectSelectedRef.current && Boolean(initialProject);
      if (shouldSelectInitialProject) initialProjectSelectedRef.current = true;
      setProjects(ontologiesQuery.data);
      setFavorites(
        new Set(
          ontologiesQuery.data
            .filter((project) => project.favorite)
            .map((project) => project.id),
        ),
      );
      setCurrentProject((prev) => {
        if (prev)
          return ontologiesQuery.data.find((p) => p.id === prev.id) ?? null;
        if (shouldSelectInitialProject) return initialProject;
        return null;
      });
      if (ontologiesQuery.data.length === 0) {
        setCurrentSessionId(null);
        setDraftSessionProjectId(null);
      }
    } else if (ontologiesQuery.isError) {
      if (allowMockFallback) {
        const storedProjectId = getActiveChatState()?.projectId;
        const initialProject =
          mockProjects.find((project) => project.id === storedProjectId) ??
          mockProjects[0] ??
          null;
        const shouldSelectInitialProject =
          !initialProjectSelectedRef.current && Boolean(initialProject);
        if (shouldSelectInitialProject)
          initialProjectSelectedRef.current = true;
        setProjects(mockProjects);
        setCurrentProject((prev) => {
          if (prev?.id.startsWith("proj-")) return prev;
          if (shouldSelectInitialProject) return initialProject;
          return null;
        });
        setCurrentSessionId(
          (prev) => prev ?? getActiveChatState()?.sessionId ?? "s1",
        );
      } else {
        setProjects([]);
        setCurrentProject(null);
        setCurrentSessionId(null);
        setDraftSessionProjectId(null);
        setDraftSessionProjectId(null);
      }
    }
  }, [
    ontologiesQuery.data,
    ontologiesQuery.isError,
    allowMockFallback,
    getActiveChatState,
  ]);

  useEffect(() => {
    if (!currentProject || usingMockProjects) return;
    if (sessionsQuery.isLoading) return;
    const isDraftSessionProject = draftSessionProjectId === currentProject.id;
    const belongsToCurrentProject = currentProjectSessions.some(
      (session) => session.id === currentSessionId,
    );
    if (currentSessionId && !belongsToCurrentProject) {
      setCurrentSessionId(null);
      return;
    }
    const storedState = getActiveChatState();
    const storedSessionId =
      storedState?.projectId === currentProject.id
        ? storedState.sessionId
        : null;
    const storedSession =
      !isDraftSessionProject && storedSessionId
        ? currentProjectSessions.find(
            (session) => session.id === storedSessionId,
          )
        : null;
    if (!currentSessionId && storedSession) {
      setCurrentSessionId(storedSession.id);
      return;
    }
    if (
      !currentSessionId &&
      !isDraftSessionProject &&
      currentProjectSessions[0]
    ) {
      setCurrentSessionId(currentProjectSessions[0].id);
    }
  }, [
    currentProject,
    currentProjectSessions,
    currentSessionId,
    draftSessionProjectId,
    getActiveChatState,
    sessionsQuery.isLoading,
    usingMockProjects,
  ]);

  useEffect(() => {
    if (!currentProject || !currentSessionId) return;
    const belongsToCurrentProject =
      usingMockProjects ||
      currentProjectSessions.some((session) => session.id === currentSessionId);
    if (!belongsToCurrentProject) return;
    activeChatStateRef.current =
      rememberActiveChatSelection(currentProject.id, currentSessionId) ??
      activeChatStateRef.current;
  }, [
    currentProject,
    currentProjectSessions,
    currentSessionId,
    usingMockProjects,
  ]);

  useEffect(() => {
    if (usingMockProjects) return;
    if (sidebarSessions.length === 0) return;
    const statusBySessionId = new Map(
      sidebarChatStatuses.map((item) => [item.sessionId, item.status]),
    );
    const visibleSessionIds = new Set(
      sidebarSessions.map((session) => session.id),
    );
    setSidebarSessionRunState((previous) => {
      const next: SidebarSessionRunState = {
        readRunIds: { ...previous.readRunIds },
        knownRunIds: { ...previous.knownRunIds },
        activeRunIds: { ...previous.activeRunIds },
        updatedAt: previous.updatedAt,
      };

      for (const key of Object.keys(next.readRunIds))
        if (!visibleSessionIds.has(key)) delete next.readRunIds[key];
      for (const key of Object.keys(next.knownRunIds))
        if (!visibleSessionIds.has(key)) delete next.knownRunIds[key];
      for (const key of Object.keys(next.activeRunIds))
        if (!visibleSessionIds.has(key)) delete next.activeRunIds[key];

      for (const session of sidebarSessions) {
        const status = statusBySessionId.get(session.id);
        const runId = status?.runId;
        if (!runId) {
          delete next.activeRunIds[session.id];
          continue;
        }

        const hadKnownRun = Boolean(next.knownRunIds[session.id]);
        if (status.active) {
          next.knownRunIds[session.id] = runId;
          next.activeRunIds[session.id] = runId;
          continue;
        }

        if (status.completed) {
          const wasObservedActive = next.activeRunIds[session.id] === runId;
          next.knownRunIds[session.id] = runId;
          delete next.activeRunIds[session.id];
          if (
            session.id === currentSessionId ||
            (!hadKnownRun && !wasObservedActive)
          ) {
            next.readRunIds[session.id] = runId;
          }
        }
      }

      return sameSidebarSessionRunState(previous, next)
        ? previous
        : writeSidebarSessionRunState(next);
    });
  }, [
    currentSessionId,
    sidebarChatStatusSignature,
    sidebarChatStatuses,
    sidebarSessions,
    usingMockProjects,
  ]);

  const runningSessionIds = useMemo(
    () =>
      new Set(
        sidebarChatStatuses
          .filter(
            (item) =>
              item.sessionId !== currentSessionId &&
              Boolean(item.status?.active),
          )
          .map((item) => item.sessionId),
      ),
    [currentSessionId, sidebarChatStatuses],
  );

  const unreadSessionIds = useMemo(
    () =>
      new Set(
        sidebarChatStatuses
          .filter((item) => {
            const runId = item.status?.runId;
            return Boolean(
              item.sessionId !== currentSessionId &&
              runId &&
              item.status?.completed &&
              sidebarSessionRunState.knownRunIds[item.sessionId] === runId &&
              sidebarSessionRunState.readRunIds[item.sessionId] !== runId,
            );
          })
          .map((item) => item.sessionId),
      ),
    [currentSessionId, sidebarChatStatuses, sidebarSessionRunState],
  );

  const markSidebarSessionRead = useCallback(
    (sessionId: string) => {
      const status = sidebarChatStatuses.find(
        (item) => item.sessionId === sessionId,
      )?.status;
      const runId = status?.runId;
      if (!runId || !status?.completed) return;
      setSidebarSessionRunState((previous) => {
        if (previous.readRunIds[sessionId] === runId) return previous;
        return writeSidebarSessionRunState({
          readRunIds: { ...previous.readRunIds, [sessionId]: runId },
          knownRunIds: { ...previous.knownRunIds, [sessionId]: runId },
          activeRunIds: { ...previous.activeRunIds },
          updatedAt: previous.updatedAt,
        });
      });
    },
    [sidebarChatStatuses],
  );

  useEffect(() => {
    const state = journeyQuery.data;
    if (!state || !currentProject) return;
    setJourneyProjectId(currentProject.id);
    setJourneyFlow(state.flow);
    setJourneyPhase(state.phase);
    setBootstrapState(state.bootstrap);
    setIngestState(state.ingest);
    setVerifyState(state.verify);
    setReviewState(state.review ?? initialReview);
  }, [currentProject, journeyQuery.data]);

  const toggleFavorite = (projectId: string) => {
    const nextFavorite = !favorites.has(projectId);
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    setProjects((prev) =>
      prev.map((project) =>
        project.id === projectId
          ? { ...project, favorite: nextFavorite }
          : project,
      ),
    );
    if (currentProject?.id === projectId)
      setCurrentProject((prev) =>
        prev ? { ...prev, favorite: nextFavorite } : prev,
      );
    if (!projectId.startsWith("proj-")) {
      void updateOntology
        .mutateAsync({ id: projectId, updates: { favorite: nextFavorite } })
        .catch(() => {
          setFavorites((prev) => {
            const reverted = new Set(prev);
            if (nextFavorite) reverted.delete(projectId);
            else reverted.add(projectId);
            return reverted;
          });
          setProjects((prev) =>
            prev.map((project) =>
              project.id === projectId
                ? { ...project, favorite: !nextFavorite }
                : project,
            ),
          );
          if (currentProject?.id === projectId)
            setCurrentProject((prev) =>
              prev ? { ...prev, favorite: !nextFavorite } : prev,
            );
        });
    }
  };

  const handleDeleteProject = async (projectId: string, keepConversationHistory = true) => {
    if (!projectId.startsWith("proj-"))
      await deleteOntology.mutateAsync({ id: projectId, keepConversationHistory }).catch(() => undefined);
    if (keepConversationHistory) {
      // 保留会话时，将项目标记为已删除（deletedAt），而不是直接从列表移除。
      // 这样 useAllOntologySessions 仍会订阅该项目的会话缓存，侧边栏会话不会消失。
      const deletedAt = new Date().toISOString();
      setProjects((prev) => prev.map((p) => p.id === projectId ? { ...p, deletedAt } : p));
    } else {
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
    }
    setFavorites((prev) => {
      const next = new Set(prev);
      next.delete(projectId);
      return next;
    });
    if (currentProject?.id === projectId) {
      setCurrentProject(null);
      setDraftSessionProjectId(null);
    }
  };

  const handleEditProject = async (
    projectId: string,
    updates: { emoji?: string; name?: string; description?: string },
  ) => {
    if (!projectId.startsWith("proj-"))
      await updateOntology
        .mutateAsync({ id: projectId, updates })
        .catch(() => undefined);
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? { ...p, ...updates } : p)),
    );
    if (currentProject?.id === projectId)
      setCurrentProject((prev) => (prev ? { ...prev, ...updates } : prev));
  };

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const startX = e.clientX;
      const startWidth = knowledgePanelWidth;
      const onMouseMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        setKnowledgePanelWidth(
          Math.min(Math.max(startWidth + startX - ev.clientX, 280), 700),
        );
      };
      const onMouseUp = () => {
        resizingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [knowledgePanelWidth],
  );

  const resetJourneyState = (flow: JourneyFlow = "maintenance") => {
    setJourneyProjectId(null);
    setJourneyFlow(flow);
    setJourneyPhase(null);
    setBootstrapState(initialBootstrap);
    setIngestState(initialIngest);
    setVerifyState(initialVerify);
    setReviewState(initialReview);
  };

  const applyJourneyState = useCallback(
    (state: JourneyState, projectId: string) => {
      setJourneyProjectId(projectId);
      setJourneyFlow(state.flow);
      setJourneyPhase(state.phase);
      setBootstrapState(state.bootstrap);
      setIngestState(state.ingest);
      setVerifyState(state.verify);
      setReviewState(state.review ?? initialReview);
    },
    [],
  );

  const cancelConversationPreparation = () => {
    conversationPreparationAttemptRef.current += 1;
    conversationEntryInFlightRef.current = false;
    conversationPreparationRef.current = null;
    setPendingConversation(null);
  };

  const clearPendingInitialMessage = useCallback(() => {
    setPendingInitialMessage(null);
    setPendingInitialBackendMessage(null);
    setPendingInitialSlashCommandId(null);
    setPendingInitialFiles([]);
    setPendingInitialWorkspaceFiles([]);
    setPendingInitialWorkspaceReferences([]);
    setPendingInitialResourceIds([]);
    setPendingInitialResourceFolderIds([]);
  }, []);

  const beginBlankChatSession = (flow: JourneyFlow = "maintenance") => {
    cancelConversationPreparation();
    setActivePage("chat");
    resetJourneyState(flow);
    setCurrentProject(null);
    setCurrentSessionId(null);
    setFreshSession(null);
    activeChatStateRef.current =
      clearActiveChatSelection() ?? activeChatStateRef.current;
    setDraftSessionProjectId(null);
    clearPendingInitialMessage();
    setKnowledgePanelOpen(false);
    setChatKey((k) => k + 1);
  };

  const prepareConversation = async (
    input: ConversationEntryInput,
    existingContext?: ConversationPreparationContext,
  ): Promise<void> => {
    if (conversationEntryInFlightRef.current) return;
    const shouldCreate =
      input.intent === "create" ||
      !input.project ||
      input.project.id.startsWith("proj-");
    const context = existingContext ?? {
      id: conversationEntryId(),
      input,
      shouldCreate,
      project: shouldCreate ? null : input.project,
      session: null,
      journeyState: null,
      uploadedPaths: [],
      uploadedFileCount: 0,
    };
    const attempt = conversationPreparationAttemptRef.current + 1;
    conversationPreparationAttemptRef.current = attempt;
    conversationPreparationRef.current = context;
    conversationEntryInFlightRef.current = true;

    if (!existingContext) {
      setActivePage("chat");
      resetJourneyState(shouldCreate ? "build" : "maintenance");
      setCurrentProject(shouldCreate ? null : input.project);
      setCurrentSessionId(null);
      setFreshSession(null);
      activeChatStateRef.current =
        clearActiveChatSelection() ?? activeChatStateRef.current;
      setDraftSessionProjectId(
        shouldCreate ? null : (input.project?.id ?? null),
      );
      clearPendingInitialMessage();
      setKnowledgePanelOpen(false);
      setChatKey((k) => k + 1);
    }

    const displayProject =
      context.project ?? createPendingKnowledgeProject(context.id);
    setPendingConversation({
      id: context.id,
      kind: context.shouldCreate ? "knowledge" : "session",
      project: displayProject,
      message: input.message,
      files: input.files,
      workspaceFiles: input.workspaceFiles,
      workspaceReferences: input.workspaceReferences,
      resourceIds: input.resourceIds,
      resourceFolderIds: input.resourceFolderIds,
      status:
        context.project && input.files.length > context.uploadedFileCount
          ? "uploading"
          : "creating",
      startedAt: Date.now(),
    });

    const isCurrentAttempt = () =>
      conversationPreparationAttemptRef.current === attempt &&
      conversationPreparationRef.current === context;

    try {
      if (!context.session) {
        if (context.shouldCreate) {
          const created = await createOntology.mutateAsync({
            name: "Untitled Knowledge Base",
            description:
              "Initialized from the knowledge agent skills workspace.",
          });
          if (!isCurrentAttempt()) return;
          context.project = created.project;
          context.session = created.session;
          context.journeyState = created.journeyState;
        } else {
          if (!context.project) throw new Error("Knowledge base is required");
          context.session = await createOntologySession.mutateAsync(
            context.project.id,
          );
          if (!isCurrentAttempt()) return;
        }
      }

      if (!context.project || !context.session)
        throw new Error("Conversation creation did not return a session");
      setPendingConversation((previous) =>
        previous?.id === context.id
          ? {
              ...previous,
              project: context.project!,
              status:
                input.files.length > context.uploadedFileCount
                  ? "uploading"
                  : "creating",
              error: undefined,
            }
          : previous,
      );

      while (context.uploadedFileCount < input.files.length) {
        const file = input.files[context.uploadedFileCount];
        if (!file) break;
        const uploaded = await uploadRawSource.mutateAsync({
          ontologyId: context.project.id,
          file,
        });
        if (!isCurrentAttempt()) return;
        context.journeyState = uploaded.journeyState;
        context.uploadedPaths.push(
          ...(uploaded.files?.map((item) => item.path) ?? [uploaded.path]),
        );
        context.uploadedFileCount += 1;
      }

      if (!isCurrentAttempt()) return;
      const project = context.project;
      const session = context.session;
      setPendingInitialMessage(input.message);
      setPendingInitialBackendMessage(
        input.backendMessage === input.message ? null : input.backendMessage,
      );
      setPendingInitialSlashCommandId(input.slashCommandId);
      setPendingInitialFiles(input.files);
      setPendingInitialWorkspaceFiles(
        Array.from(
          new Set([...input.workspaceFiles, ...context.uploadedPaths]),
        ),
      );
      setPendingInitialWorkspaceReferences(input.workspaceReferences);
      setPendingInitialResourceIds(input.resourceIds);
      setPendingInitialResourceFolderIds(input.resourceFolderIds);
      if (context.shouldCreate)
        setProjects((prev) => [
          project,
          ...prev.filter((item) => item.id !== project.id),
        ]);
      setFreshSession(session);
      setCurrentProject(project);
      setCurrentSessionId(session.id);
      activeChatStateRef.current =
        writeActiveChatState({
          projectId: project.id,
          sessionId: session.id,
        }) ?? activeChatStateRef.current;
      setDraftSessionProjectId(null);
      if (context.journeyState)
        applyJourneyState(context.journeyState, project.id);
      else if (project.status !== "bootstrapping") {
        setJourneyProjectId(project.id);
        setJourneyFlow("maintenance");
        setJourneyPhase("ready");
      }
      setKnowledgePanelOpen(true);
      setChatKey((k) => k + 1);
      conversationPreparationRef.current = null;
    } catch (error) {
      if (!isCurrentAttempt()) return;
      setPendingConversation((previous) =>
        previous?.id === context.id
          ? {
              ...previous,
              project: context.project ?? previous.project,
              status: "failed",
              error: errorMessage(error),
            }
          : previous,
      );
    } finally {
      if (conversationPreparationAttemptRef.current === attempt)
        conversationEntryInFlightRef.current = false;
    }
  };

  const handleNewOntology = () => {
    void prepareConversation({
      message: t("chat.createNewKnowledgePrompt"),
      backendMessage: t("chat.createNewKnowledgePrompt"),
      slashCommandId: null,
      intent: "create",
      project: null,
      files: [],
      resourceIds: [],
      resourceFolderIds: [],
      workspaceFiles: [],
      workspaceReferences: [],
    });
  };

  const handleRetryPendingConversation = () => {
    const context = conversationPreparationRef.current;
    if (!context || conversationEntryInFlightRef.current) return;
    void prepareConversation(context.input, context);
  };

  const handleNewChatSession = () => {
    beginBlankChatSession();
  };

  const handleSendWithoutSession = async (input: {
    message: string;
    backendMessage?: string;
    slashCommandId?: SlashCommandId | null;
    intent: "create" | "select";
    project?: Project | null;
    files?: File[];
    resourceIds?: string[];
    resourceFolderIds?: string[];
    workspaceFiles?: string[];
    workspaceReferences?: ComposerFileReference[];
  }) => {
    const message = input.message.trim();
    if (!message || conversationEntryInFlightRef.current) return;
    const backendMessage = input.backendMessage?.trim() || message;
    const files = input.files ?? [];
    const resourceIds = input.resourceIds ?? [];
    const resourceFolderIds = input.resourceFolderIds ?? [];
    const workspaceFiles = input.workspaceFiles ?? [];
    const workspaceReferences = input.workspaceReferences ?? [];
    assertUploadBatchWithinLimit(files);
    await prepareConversation({
      message,
      backendMessage,
      slashCommandId: input.slashCommandId ?? null,
      intent: input.intent,
      project: input.project ?? null,
      files,
      resourceIds,
      resourceFolderIds,
      workspaceFiles,
      workspaceReferences,
    });
  };

  const handleSelectSession = (sessionId: string) => {
    cancelConversationPreparation();
    clearPendingInitialMessage();
    setFreshSession(null);
    markSidebarSessionRead(sessionId);
    setChatKey((k) => k + 1);
    setDraftSessionProjectId(null);
    setCurrentSessionId(sessionId);
    const session =
      sidebarSessions.find((s) => s.id === sessionId) ??
      mockSessions.find((s) => s.id === sessionId);
    const projectId =
      session?.projectId ?? session?.ontologyId ?? currentProject?.id;
    if (projectId) {
      activeChatStateRef.current =
        writeActiveChatState({
          projectId,
          sessionId,
        }) ?? activeChatStateRef.current;
    }
    if (session) {
      const proj = projects.find(
        (p) => p.id === (session.projectId ?? session.ontologyId),
      );
      if (proj) {
        if (proj.id !== currentProject?.id)
          resetJourneyState(
            proj.status === "bootstrapping" ? "build" : "maintenance",
          );
        setCurrentProject(proj);
      }
    }
  };

  const handleRenameSession = async (sessionId: string, preview: string) => {
    const session =
      sidebarSessions.find((s) => s.id === sessionId) ??
      currentProjectSessions.find((s) => s.id === sessionId);
    const ontologyId =
      session?.ontologyId ?? session?.projectId ?? currentProject?.id;
    if (!ontologyId || ontologyId.startsWith("proj-")) return;
    await updateOntologySession
      .mutateAsync({ ontologyId, sessionId, updates: { preview } })
      .catch(() => undefined);
  };

  const handleDeleteSession = async (sessionId: string) => {
    const session =
      sidebarSessions.find((s) => s.id === sessionId) ??
      currentProjectSessions.find((s) => s.id === sessionId);
    const ontologyId =
      session?.ontologyId ?? session?.projectId ?? currentProject?.id;
    if (!ontologyId || ontologyId.startsWith("proj-")) return;
    await deleteOntologySession
      .mutateAsync({ ontologyId, sessionId })
      .catch(() => undefined);
    if (currentSessionId === sessionId) {
      setCurrentSessionId(
        currentProjectSessions.find((s) => s.id !== sessionId)?.id ?? null,
      );
    }
  };

  const handleShareSession = (session: Session) => {
    const ontologyId = session.ontologyId ?? session.projectId;
    if (!ontologyId || ontologyId.startsWith("proj-")) return;
    void publishAndCopyConversationLink(ontologyId, session.id)
      .then(() => showToast({ type: "success", message: t("session.shareSuccess") ?? "Public conversation link copied" }))
      .catch((reason) => showToast({ type: "error", message: errorMessage(reason) }));
  };

  const handlePhaseUpdate = useCallback(
    (msg: ChatMessage) => {
      if (msg.phaseTransition) {
        setJourneyPhase(msg.phaseTransition);
        if (!knowledgePanelOpen) setKnowledgePanelOpen(true);
      }
      if (msg.phaseData) {
        const payload = msg.phaseData as PhasePayload;
        if (payload.type === "bootstrap")
          setBootstrapState((prev) => ({ ...prev, ...payload.state }));
        else if (payload.type === "ingest")
          setIngestState((prev) => ({ ...prev, ...payload.state }));
        else if (payload.type === "verify")
          setVerifyState((prev) => ({ ...prev, ...payload.state }));
        else if (payload.type === "review")
          setReviewState((prev) => ({ ...prev, ...payload.state }));
      }
    },
    [knowledgePanelOpen],
  );

  const handleChatPhaseUpdate = useCallback(
    (msg: ChatMessage) => {
      handlePhaseUpdate(msg);
    },
    [handlePhaseUpdate],
  );

  const localResourceFromFile = useCallback(
    (file: File, folder?: string): Resource => {
      const now = new Date().toISOString();
      return {
        id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: file.name,
        type: inferResourceType(file.name),
        description: t("common.uploadedFile"),
        lastSynced: now,
        status: "unused",
        linkedOntologies: [],
        size: file.size,
        source: "upload",
        fileSize:
          file.size > 1024 * 1024
            ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
            : `${Math.round(file.size / 1024)} KB`,
        createdAt: now,
        updatedAt: now,
        ...(folder ? { folder } : {}),
      };
    },
    [t],
  );

  const fileDirectoryParts = (file: File): string[] => {
    const relativePath = (
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || ""
    )
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    if (!relativePath || !relativePath.includes("/")) return [];
    const parts = relativePath.split("/").filter(Boolean);
    parts.pop();
    return parts;
  };

  const handleUploadResourcesDetailed = useCallback(
    async (
      files: File[],
      folder?: string,
      options?: ResourceUploadOptions,
    ): Promise<{ resources: Resource[]; rootFolders: ResourceFolder[] }> => {
      if (!files.length) return { resources: [], rootFolders: [] };
      assertUploadBatchWithinLimit(files);
      const folderCache = new Map<string, ResourceFolder>();
      const  rememberFolder = (item: ResourceFolder) =>
        folderCache.set(resourceFolderKey(item.parentId, item.name), item);
      folders.forEach(rememberFolder);
      const rootFolders = new Map<string, ResourceFolder>();const rootFileCounts = new Map<string, number>();
    const plannedFolderKeys = new Set<string>();
    const rootNameOverrides = new Map<string, string>();
    const replacementFolderIds = new Set<string>();

    files.forEach((file) => {
      const rootName = fileDirectoryParts(file)[0];
      if (!rootName) return;
      rootFileCounts.set(rootName, (rootFileCounts.get(rootName) ?? 0) + 1);
    });

    const parentName = folder ? folders.find((item) => item.id === folder)?.name ?? t("resource.unknownFolder") : t("resource.rootLocation");
    const unavailableFolderNames = (parentId: string | undefined): string[] => {
      const names = Array.from(folderCache.values())
        .filter((item) => (item.parentId ?? undefined) === parentId)
        .map((item) => item.name);
      for (const key of plannedFolderKeys) {
        const [parentKey, ...nameParts] = key.split(":");
        if ((parentId ?? "root") === parentKey) names.push(nameParts.join(":"));
      }
      return names;
    };

    for (const [rootName, incomingCount] of rootFileCounts) {
      const key = resourceFolderKey(folder, rootName);
      const existing = folderCache.get(key);
      if (!existing) continue;
      const decision = await requestDuplicateFolderDecision({
        folderName: rootName,
        parentName,
        incomingCount,
        existingCount: resourceCountInFolderTree(resources, folders, existing.id),
        unavailableNames: unavailableFolderNames(folder),
      });
      if (decision.action === "cancel") return { resources: [], rootFolders: [] };
      if (decision.action === "copy") {
        plannedFolderKeys.add(resourceFolderKey(folder, decision.name));
        rootNameOverrides.set(key, decision.name);
        options?.onFolderNameResolved?.({ originalName: rootName, resolvedName: decision.name });
      }
      if (decision.action === "replace") replacementFolderIds.add(existing.id);
    }
    const replacementTreeIds = new Set<string>();
    replacementFolderIds.forEach((folderId) => {
      collectResourceFolderTreeIds(folders, folderId).forEach((id) => replacementTreeIds.add(id));
    });

    if (replacementTreeIds.size > 0) {
      if (resourceLibraryUnavailable) {
        setFallbackFolders((prev) => prev.filter((item) => !replacementTreeIds.has(item.id)));
        setFallbackResources((prev) => prev.filter((resource) => !resource.folder || !replacementTreeIds.has(resource.folder)));
      } else {
        for (const folderId of replacementFolderIds) {
          await deleteResourceFolder.mutateAsync(folderId);
        }
      }
      for (const [key, item] of folderCache) {
        if (replacementTreeIds.has(item.id)) folderCache.delete(key);
      }
    }

      const createUploadFolder = async (
        name: string,
        parentId: string | undefined,
      ): Promise<ResourceFolder> => {
        const key = resourceFolderKey(parentId, name);
        const existing = folderCache.get(key);
        if (existing) return existing;
        const createdAt = new Date().toISOString();
        const created = resourceLibraryUnavailable
          ? {
              id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              name,
              createdAt,
              updatedAt: createdAt,
              ...(parentId ? { parentId } : {}),
            }
          : await createResourceFolder.mutateAsync({
              name,
              ...(parentId ? { parentId } : {}),
            });
        rememberFolder(created);
        if (resourceLibraryUnavailable)
          setFallbackFolders((prev) => [created, ...prev]);
        return created;
      };

      const ensureUploadFolderPath = async (
        parts: string[],
      ): Promise<string | undefined> => {
        if (!parts.length) return folder;
        const effectiveParts = [...parts];
      const rootOverride = rootNameOverrides.get(resourceFolderKey(folder, effectiveParts[0]));
      if (rootOverride) effectiveParts[0] = rootOverride;let parentId = folder;
        for (const [index, part] of effectiveParts.entries()) {
          const next = await createUploadFolder(part, parentId);
          if (index === 0) rootFolders.set(next.id, next);
          parentId = next.id;
        }
        return parentId;
      };

      if (resourceLibraryUnavailable) {
        const uploaded: Resource[] = [];
        for (const file of files) {
          const targetFolder = await ensureUploadFolderPath(
            fileDirectoryParts(file),
          );
          uploaded.push(localResourceFromFile(file, targetFolder));
        }
        setFallbackResources((prev) => [...uploaded, ...prev]);
        return {
          resources: uploaded,
          rootFolders: Array.from(rootFolders.values()),
        };
      }
      const uploaded: Resource[] = [];
      for (const file of files) {
        const targetFolder = await ensureUploadFolderPath(
          fileDirectoryParts(file),
        );
        const result = await uploadResource.mutateAsync({
          name: file.name,
          file,
          contentType: file.type || undefined,
          folder: targetFolder,
          description: t("common.uploadedFile"),
        });
        uploaded.push(...result.resources);
      }
      return {
        resources: uploaded,
        rootFolders: Array.from(rootFolders.values()),
      };
    },
    [
      createResourceFolder,
     deleteResourceFolder, folders,
      localResourceFromFile,
     requestDuplicateFolderDecision, resourceLibraryUnavailable,
     resources, t,
      uploadResource,
    ],
  );

  const handleUploadResources = useCallback(
    async (files: File[], folder?: string, options?: ResourceUploadOptions): Promise<Resource[]> =>
      (await handleUploadResourcesDetailed(files, folder, options)).resources,
    [handleUploadResourcesDetailed],
  );

  const handleUploadResourceFolders = useCallback(
    async (files: File[]): Promise<ResourceFolder[]> =>
      (await handleUploadResourcesDetailed(files)).rootFolders,
    [handleUploadResourcesDetailed],
  );

  const handleDeleteResource = useCallback(
    (id: string) => {
      if (resourceLibraryUnavailable) {
        setFallbackResources((prev) =>
          prev.filter((resource) => resource.id !== id),
        );
        return;
      }
      void deleteResource.mutateAsync(id);
    },
    [deleteResource, resourceLibraryUnavailable],
  );

  const handleDeleteFolder = useCallback(
    (id: string) => {
      if (resourceLibraryUnavailable) {
        const folderIds = new Set<string>([id]);
        const visit = (parentId: string) => {
          fallbackFolders.forEach((folder) => {
            if (folder.parentId !== parentId || folderIds.has(folder.id))
              return;
            folderIds.add(folder.id);
            visit(folder.id);
          });
        };
        visit(id);
        setFallbackFolders((prev) =>
          prev.filter((folder) => !folderIds.has(folder.id)),
        );
        setFallbackResources((prev) =>
          prev.filter(
            (resource) => !resource.folder || !folderIds.has(resource.folder),
          ),
        );
        return;
      }
      void deleteResourceFolder.mutateAsync(id);
    },
    [deleteResourceFolder, fallbackFolders, resourceLibraryUnavailable],
  );

  const handleDownloadResource = useCallback(
    (resource: Resource) => {
      if (resourceLibraryUnavailable) return;
      void downloadResource(resource.id);
    },
    [resourceLibraryUnavailable],
  );

  const handleDownloadFolder = useCallback(
    (folder: ResourceFolder) => {
      if (resourceLibraryUnavailable) return;
      void downloadFolder(folder.id);
    },
    [resourceLibraryUnavailable],
  );

  const handleReviewApproveAll = useCallback(async () => {
    if (!currentProject || currentProject.id.startsWith("proj-")) return;
    try {
      const fallbackSession = sidebarSessions.find((session) => (session.projectId ?? session.ontologyId) === currentProject.id)
        ?? sidebarSessions.find((session) => session.projectName === currentProject.name);
      let sessionId = currentSessionId ?? currentProjectSessions[0]?.id ?? fallbackSession?.id ?? null;
      if (!sessionId) {
        const session = await createOntologySession.mutateAsync(currentProject.id);
        sessionId = session.id;
      }
      if (!currentSessionId) setCurrentSessionId(sessionId);

      const approved = await approveAllReviews.mutateAsync({ id: currentProject.id, sessionId, locale });
      applyJourneyState(approved.journeyState, currentProject.id);
      setProjects((prev) =>
        prev.map((project) =>
          project.id === currentProject.id
            ? { ...project, status: "active" }
            : project,
        ),
      );
      setCurrentProject((prev) =>
        prev?.id === currentProject.id ? { ...prev, status: "active" } : prev,
      );

      setActivePage("chat");
      setKnowledgePanelOpen(true);
      setDraftSessionProjectId(null);
      clearPendingInitialMessage();
      setPendingInitialFiles([]);
      setPendingInitialWorkspaceFiles([]);
      setPendingInitialWorkspaceReferences([]);
      setPendingInitialResourceIds([]);
      setPendingInitialResourceFolderIds([]);
      const ontologySync = approved.ontologySync;
      const toastMessage =
        ontologySync?.status === "started"
          ? t("review.ontologySyncStarted")
          : ontologySync?.status === "skipped"
            ? t("review.ontologySyncSkippedNoMaterial")
            : ontologySync?.status === "failed_to_start"
              ? t("review.ontologySyncFailedToStart")
              : t("review.readyHandoff");
      showToast({
        type: ontologySync?.status === "failed_to_start" ? "error" : "info",
        message: toastMessage,
        durationMs: 6000,
      });
    } catch (error) {
      showToast({ type: "error", message: errorMessage(error) });
    }
  }, [
    applyJourneyState,
    approveAllReviews,
    clearPendingInitialMessage,
    createOntologySession,
    currentProject,
    currentProjectSessions,
    currentSessionId,
    locale,
    sidebarSessions,
    t,
  ]);

  const handleOpenOntologyDraft = (project: Project) => {
    cancelConversationPreparation();
    clearPendingInitialMessage();
    setFreshSession(null);
    if (project.id !== currentProject?.id)
      resetJourneyState(
        project.status === "bootstrapping" ? "build" : "maintenance",
      );
    setCurrentProject(project);
    setCurrentSessionId(null);
    setDraftSessionProjectId(project.id);
    clearPendingInitialMessage();
    setChatKey((k) => k + 1);
    setActivePage("chat");
    setKnowledgePanelOpen(true);
    setSelectedOperationRun(null);
  };

  const handleSelectOperationRun = (run: OperationRun) => {
    const project = projects.find((item) => item.id === run.ontologyId);
    if (!project) return;
    cancelConversationPreparation();
    clearPendingInitialMessage();
    composerFileReferencesStore.clear();
    composerPromptModeStore.clear();
    setFreshSession(null);
    if (project.id !== currentProject?.id) {
      resetJourneyState(project.status === "bootstrapping" ? "build" : "maintenance");
    }
    setCurrentProject(project);
    setCurrentSessionId(run.sessionId);
    setDraftSessionProjectId(null);
    setSelectedOperationRun(run);
    setKnowledgePanelOpen(true);
    setChatKey((key) => key + 1);
    setActivePage("chat");
  };

  const currentJourneyLoaded = Boolean(
    currentProject && journeyProjectId === currentProject.id && journeyPhase,
  );
  const currentProjectIsBackend = Boolean(
    currentProject && !currentProject.id.startsWith("proj-"),
  );
  const currentProjectIsBootstrapping =
    currentProject?.status === "bootstrapping";
  const showWorkflowLoading = Boolean(
    currentProjectIsBootstrapping &&
    currentProjectIsBackend &&
    !currentJourneyLoaded,
  );
  const showWorkflowPanel = Boolean(
    showWorkflowLoading ||
    (currentJourneyLoaded &&
      journeyFlow === "build" &&
      journeyPhase !== "ready") ||
    (currentProjectIsBootstrapping && !currentProjectIsBackend),
  );
  const knowledgePanelToggleLabel = knowledgePanelOpen ? t("panel.collapseArtifacts") : t("panel.expandArtifacts");
  const knowledgePanelCollapsedLabel = showWorkflowPanel ? t("chat.designArtifacts") : t("chat.ontologyArtifacts");
  const liveBootstrapState = useMemo(
    () => ({
      ...bootstrapState,
      rawSources: currentJourneyLoaded
        ? (rawSourcesQuery.data ?? bootstrapState.rawSources)
        : bootstrapState.rawSources,
    }),
    [bootstrapState, currentJourneyLoaded, rawSourcesQuery.data],
  );

  return (
    <div className="app-layout">
      <Sidebar
        projects={projects}
        sessions={sidebarSessions}
        currentSessionId={currentSessionId}
        currentProject={currentProject}
        collapsed={sidebarCollapsed}
        runningSessionIds={runningSessionIds}
        unreadSessionIds={unreadSessionIds}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        onSelectSession={(id) => {
          handleSelectSession(id);
          setSelectedOperationRun(null);
          setActivePage("chat");
        }}
        onSelectProject={handleOpenOntologyDraft}
        onNewChat={handleNewChatSession}
        favorites={favorites}
        onViewAllOntologies={() => {
          cancelConversationPreparation();
          setActivePage("my-ontologies");
        }}
        onViewResourceLibrary={() => {
          cancelConversationPreparation();
          setActivePage("resource-library");
        }}
        onViewOperationRuns={() => {
          cancelConversationPreparation();
          setActivePage("operation-runs");
        }}
        onViewAdminData={() => {
          cancelConversationPreparation();
          setActivePage("admin-data");
        }}
        onToggleFavorite={toggleFavorite}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        onShareSession={handleShareSession}
        onOpenConnectors={() => setConnectorDialogOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        locale={locale}
        onChangeLocale={(nextLocale) => {
          persistUiLocale(nextLocale);
          setLocale(nextLocale);
        }}
        t={t}
      />
      <main className="main-content">
        {activePage === "chat" && (
          <OntologyStewardChatPanel
            key={chatKey}
            project={currentProject}
            projects={projects}
            currentSessionId={currentSessionId}
            onNewOntology={handleNewOntology}
            onSendWithoutSession={handleSendWithoutSession}
            sessions={sidebarSessions}
            onSelectSession={(sessionId) => {
              handleSelectSession(sessionId);
              setSelectedOperationRun(null);
              setActivePage("chat");
            }}
            onSelectOperationRun={handleSelectOperationRun}
            onRenameSession={handleRenameSession}
            onDeleteSession={handleDeleteSession}
            onSelectProject={(proj) => {
              cancelConversationPreparation();
              clearPendingInitialMessage();
              setFreshSession(null);
              setCurrentProject(proj);
              setCurrentSessionId(null);
              setDraftSessionProjectId(proj.id);
              setKnowledgePanelOpen(true);
              setSelectedOperationRun(null);
            }}
            pendingInitialMessage={pendingInitialMessage}
            pendingInitialBackendMessage={pendingInitialBackendMessage}
            pendingInitialSlashCommandId={pendingInitialSlashCommandId}
            pendingInitialFiles={pendingInitialFiles}
            pendingInitialWorkspaceFiles={pendingInitialWorkspaceFiles}
            pendingInitialWorkspaceReferences={pendingInitialWorkspaceReferences}
            pendingInitialResourceIds={pendingInitialResourceIds}
            pendingInitialResourceFolderIds={pendingInitialResourceFolderIds}
            pendingConversation={pendingConversation}
            onRetryPendingConversation={handleRetryPendingConversation}
            onPendingInitialMessageConsumed={() => {
              clearPendingInitialMessage();
              setPendingConversation(null);
            }}
            backendUnavailable={ontologiesQuery.isError && !allowMockFallback}
            knowledgeOpen={knowledgePanelOpen}
            onPhaseUpdate={handleChatPhaseUpdate}
            resources={resources}
            folders={folders}
            onUploadResources={handleUploadResources}
            onUploadResourceFolder={handleUploadResourceFolders}
            locale={locale}
            t={t}
          />
        )}
        {activePage === "my-ontologies" && (
          <MyOntologiesPage
            projects={projects}
            favorites={favorites}
            onOpenProject={handleOpenOntologyDraft}
            onToggleFavorite={toggleFavorite}
            onNewOntology={handleNewOntology}
            onDeleteProject={handleDeleteProject}
            onEditProject={handleEditProject}
            t={t}
          />
        )}
        {activePage === "resource-library" && (
          <ResourceLibraryPage
            resources={resources}
            folders={folders}
            projects={projects}
            onUploadFiles={handleUploadResources}
            onDeleteResource={handleDeleteResource}
            onDeleteFolder={handleDeleteFolder}
            onPreviewResource={(resource) => setResourcePreviewId(resource.id)}
            onDownloadResource={handleDownloadResource}
            onDownloadFolder={handleDownloadFolder}
            onRefreshResourceLibrary={() => resourceLibraryQuery.refetch()}
            locale={locale}
            t={t}
          />
        )}
        {activePage === "operation-runs" && (
          <OperationRunsPage
            projects={projects}
            onSelectRun={handleSelectOperationRun}
            t={t}
          />
        )}
        {activePage === "admin-data" && isAdmin && <AdminDataPage t={t} />}
        {activePage === "review" && (
          <div className="placeholder-page">
            <h2>Pending Review</h2>
            <p>3 changes awaiting your review.</p>
          </div>
        )}
        {activePage === "reports" && (
          <div className="placeholder-page">
            <h2>Reports</h2>
            <p>Lint and audit reports will appear here.</p>
          </div>
        )}
      </main>
      <ConnectorDialog
        open={connectorDialogOpen}
        onOpenChange={setConnectorDialogOpen}
        t={t}
      />
      {duplicateFolderPrompt && (
        <DuplicateFolderUploadDialog
          prompt={duplicateFolderPrompt}
          t={t}
          onResolve={resolveDuplicateFolderPrompt}
        />
      )}
      {activePage === "resource-library" &&
        resourcePreviewId &&
        (resourcePreviewResource?.source === "bitbucket" ? (
          <RepositoryPreviewModal
            resourceId={resourcePreviewResource.id}
            repositoryName={resourcePreviewResource.name}
            onClose={() => setResourcePreviewId(null)}
          />
        ) : (
          <FilePreviewModal
            path={
              resourcePreviewDisplayPath ||
              resourcePreviewQuery.data?.path ||
              "resource"
            }
            content={resourcePreviewQuery.data?.content}
            loading={
              !resourceLibraryUnavailable && resourcePreviewQuery.isLoading
            }
            error={resourcePreviewError}
            knownPaths={resourcePreviewPaths}
            onNavigatePath={handleNavigateResourcePreview}
            onClose={() => setResourcePreviewId(null)}
            t={t}
          />
        ))}
      <div className="app-toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`app-toast app-toast-${toast.type}`}
            role={toast.type === "error" ? "alert" : "status"}
          >
            {toast.message}
          </div>
        ))}
      </div>
      {currentProject && activePage === "chat" && (
        <>
          <button
            type="button"
            className={`knowledge-panel-edge-toggle${knowledgePanelOpen ? " open" : " collapsed"}`}
            onClick={() => setKnowledgePanelOpen((open) => !open)}
            aria-label={knowledgePanelToggleLabel}
            title={knowledgePanelToggleLabel}
          >
            {knowledgePanelOpen ? (
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M9 3v18" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            ) : showWorkflowPanel ? (
              <>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>
                <span>{knowledgePanelCollapsedLabel}</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9.5 8h5"/><path d="M9.5 12H16"/><path d="M9.5 16H14"/></svg>
                <span>{knowledgePanelCollapsedLabel}</span>
              </>
            )}
          </button>
          {knowledgePanelOpen && (
            <>
              <div
            className="knowledge-panel-resize-handle"
            onMouseDown={handleResizeStart}
          />
          {showWorkflowPanel ? (
            <aside
              className="knowledge-panel"
              style={{
                width: knowledgePanelWidth,
                minWidth: knowledgePanelWidth,
                  }}
            >
              <div className="knowledge-panel-header">
                <span className="knowledge-panel-title">
                  {t("panel.buildingOntology")}
                </span>

              </div>
              {showWorkflowLoading ? (
                <div className="journey-state-placeholder" role="status">
                  <div className="journey-state-placeholder-title">
                    {journeyQuery.isError
                      ? t("journey.loadStateFailed")
                      : t("journey.loadingState")}
                  </div>
                  {!journeyQuery.isError && (
                    <div className="journey-state-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                </div>
              ) : (
                <JourneyPanel
                  flow={journeyFlow}
                  phase={journeyPhase ?? "bootstrap"}
                  projectId={currentProject.id}
                  bootstrapState={liveBootstrapState}
                  ingestState={ingestState}
                  verifyState={verifyState}
                  reviewState={reviewState}
                  t={t}
                  onReviewApproveAll={handleReviewApproveAll}
                  reviewApproving={approveAllReviews.isPending}
                />
              )}
            </aside>
          ) : (
            <KnowledgePanel
              project={currentProject}
              width={knowledgePanelWidth}
              reviewState={reviewState}
              maintenanceActivity={
                currentJourneyLoaded &&
                journeyFlow === "maintenance" &&
                journeyPhase !== "ready"
                  ? {
                      phase: journeyPhase ?? "ready",
                      ingest: ingestState,
                      verify: verifyState,
                      review: reviewState,
                    }
                  : undefined
              }
              reviewGenerationActive={currentProjectRunActive}
              activeSessionId={currentSessionId}
              activeSessionRunning={currentSessionRunActive}
              locale={locale}
              onApproveAllReviews={handleReviewApproveAll}
              approveAllReviewsPending={approveAllReviews.isPending}
              operationRun={selectedOperationRun}
              t={t}
            />
          )}
            </>
          )}
        </>
      )}
    </div>
  );
}
