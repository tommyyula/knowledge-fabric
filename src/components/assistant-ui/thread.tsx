import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useComposerInput,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownToLineIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BugIcon,
  BookOpenIcon,
  CableIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FileIcon,
  GitBranchIcon,
  FolderIcon,
  LayersIcon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
  TerminalIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { createContext, type FC, type ReactNode, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AttachmentTile, UserMessageAttachments } from "@/components/assistant-ui/attachment";
import { ConnectorDialog } from "@/components/ConnectorDialog";
import CustomScrollIndicator from "@/components/CustomScrollIndicator";
import ResourcePicker, { type ResourcePickerSelection } from "@/components/ResourcePicker";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { isHiddenToolCall } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { filterSystemUploadFiles } from "@/lib/drop-files";
import { connectorStore } from "@/lib/connector-store";
import { composerFileReferencesStore, composerItemOrderStore, type ComposerFileReference } from "@/lib/composer-file-references-store";
import { composerPromptModeStore } from "@/lib/composer-prompt-mode-store";
import { slashCommandById, slashCommandDefinitions, type SlashCommandDefinition } from "@/contracts/slash-commands";
import type { FollowupSuggestion } from "@/lib/followup-suggestions-store";
import { errorMessage, showToast } from "@/lib/toast";
import { parseToolInput, stringifyToolValue, summarizeToolCall } from "@/lib/tool-summary";
import type { Project, Resource, ResourceFolder } from "@/mocks/data";
import { cn } from "@/lib/utils";
import { listComposioApps, type ComposioApp } from "@/services/api/composio";
import { IssueHelpDialog, type IssueReportPayload, type IssueShortcut, type IssueSupportContext } from "@/components/IssueHelpDialog";

interface ThreadOntologyPickerProps {
  projects?: Project[];
  currentProjectId?: string | null;
  onSelectProject?: (project: Project) => void;
  onCreateOntology?: () => void;
  selectedIntent?: "create" | "select";
  resources?: Resource[];
  folders?: ResourceFolder[];
  onUploadResources?: (files: File[]) => Promise<Resource[]>;
  onUploadResourceFolder?: (files: File[]) => Promise<ResourceFolder[]>;
  t?: (key: string, params?: Record<string, string>) => string;
  emptyState?: ReactNode;
  showWelcome?: boolean;
  followupSuggestions?: readonly FollowupSuggestion[];
  onIssueCommand?: (issue: IssueShortcut) => Promise<void> | void;
  issueSupportContext?: IssueSupportContext;
  issueHelpDisabled?: boolean;
  onIssueReport?: (report: IssueReportPayload) => Promise<void> | void;
}

interface ThreadTransientStateProps {
  composerDisabled?: boolean;
  readOnly?: boolean;
  headerSlot?: ReactNode;
  statusSlot?: ReactNode;
}

type IssueHelpContextValue = {
  available: boolean;
  disabled: boolean;
  readOnly: boolean;
  open: () => void;
};

const IssueHelpContext = createContext<IssueHelpContextValue>({
  available: false,
  disabled: false,
  readOnly: false,
  open: () => undefined,
});

export const Thread: FC<{ fillPanel?: boolean; enableConnectors?: boolean } & ThreadOntologyPickerProps & ThreadTransientStateProps> = ({ fillPanel = false, enableConnectors = false, projects = [], currentProjectId, onSelectProject, onCreateOntology, selectedIntent, resources = [], folders = [], onUploadResources, onUploadResourceFolder, t, emptyState, showWelcome = true, followupSuggestions = [], onIssueCommand, issueSupportContext, issueHelpDisabled = false, onIssueReport, composerDisabled = false, readOnly = false, headerSlot, statusSlot }) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [issueHelpOpen, setIssueHelpOpen] = useState(false);
  const issueHelpAvailable = Boolean(onIssueCommand && onIssueReport && issueSupportContext);

  return (
    <IssueHelpContext.Provider value={{ available: issueHelpAvailable, disabled: issueHelpDisabled || composerDisabled, readOnly, open: () => setIssueHelpOpen(true) }}>
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root relative flex h-full flex-col bg-background"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-radius" as string]: "24px",
        ["--composer-padding" as string]: "10px",
      }}
    >
      <ThreadPrimitive.Viewport ref={viewportRef} className="aui-thread-viewport aui-thread-viewport-custom-scroll app-scrollbar relative flex flex-1 flex-col overflow-x-hidden overflow-y-auto scroll-smooth">
        <div className={cn("flex w-full flex-1 flex-col px-4 pt-4", fillPanel ? "" : "mx-auto max-w-(--thread-max-width)")}>
          {headerSlot}
          <AuiIf condition={(s) => s.thread.isEmpty}>
            {emptyState ?? (showWelcome ? <ThreadWelcome projects={projects} currentProjectId={currentProjectId} onSelectProject={onSelectProject} onCreateOntology={onCreateOntology} selectedIntent={selectedIntent} t={t} /> : null)}
          </AuiIf>

          <div data-slot="aui_message-group" className="mb-10 flex flex-col empty:hidden">
            <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
            <ThreadRunningIndicator />
            {statusSlot}
          </div>

          {!readOnly && (
            <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mt-auto flex flex-col gap-4 overflow-visible rounded-t-(--composer-radius) bg-background pb-4 md:pb-6">
              <ThreadScrollToBottom />
              <FollowupSuggestions suggestions={followupSuggestions} />
              <Composer projects={projects} currentProjectId={currentProjectId} onSelectProject={onSelectProject} selectedIntent={selectedIntent} enableConnectors={enableConnectors} resources={resources} folders={folders} onUploadResources={onUploadResources} onUploadResourceFolder={onUploadResourceFolder} t={t} disabled={composerDisabled} />
            </ThreadPrimitive.ViewportFooter>
          )}
        </div>
      </ThreadPrimitive.Viewport>
      <CustomScrollIndicator viewportRef={viewportRef} bottomBoundarySelector=".aui-thread-viewport-footer" />
    </ThreadPrimitive.Root>
    {issueHelpAvailable && onIssueCommand && issueSupportContext && onIssueReport ? createPortal(
      <IssueHelpDialog
        open={issueHelpOpen}
        disabled={issueHelpDisabled || composerDisabled}
        context={issueSupportContext}
        onClose={() => setIssueHelpOpen(false)}
        onConfirm={onIssueCommand}
        onSubmitReport={onIssueReport}
      />,
      document.body,
    ) : null}
    </IssueHelpContext.Provider>
  );
};

const OPEN_COMPOSER_KNOWLEDGE_PICKER_EVENT = "composer:open-knowledge-picker";
const OPEN_COMPOSER_ADD_MENU_EVENT = "composer:open-add-menu";

type ComposerKnowledgePickerMode = "select" | "query" | "operation";

const openComposerKnowledgePicker = (mode: ComposerKnowledgePickerMode = "select") => {
  window.dispatchEvent(new CustomEvent(OPEN_COMPOSER_KNOWLEDGE_PICKER_EVENT, { detail: { mode } }));
  window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".aui-composer-input")?.focus(), 0);
};

function referenceLabel(reference: ComposerFileReference): string {
  const ref = reference.ref;
  if (reference.label) return reference.label;
  if (ref.startsWith("resource-folder:")) return "Folder";
  if (ref.startsWith("resource:")) return "Resource";
  return ref.split("/").pop() || ref;
}

function referenceIsFolder(reference: ComposerFileReference): boolean {
  return reference.kind === "folder" || reference.ref.startsWith("resource-folder:") || reference.ref.startsWith("resource-folder-upload:");
}

function referenceIsRepository(reference: ComposerFileReference): boolean {
  return reference.resourceType === "repo" || reference.source === "bitbucket";
}

function referenceIsUploading(reference: ComposerFileReference): boolean {
  return reference.status === "uploading" || reference.ref.startsWith("resource-folder-upload:");
}

function folderUploadLabels(files: readonly File[]): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const relativePath = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const root = relativePath.includes("/") ? relativePath.split("/").filter(Boolean)[0] : "";
    const label = root || file.name || "Folder";
    if (seen.has(label)) continue;
    seen.add(label);
    roots.push(label);
  }
  return roots.length ? roots : ["Folder"];
}

function folderUploadRef(): string {
  return `resource-folder-upload:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type ComposerAttachmentOrderItem = {
  id: string;
  index: number;
};

type ComposerSelectionItem =
  | { type: "reference"; key: string; order: number; reference: ComposerFileReference }
  | { type: "attachment"; key: string; order: number; index: number };

const composerAttachmentComponents = {
  Attachment: AttachmentTile,
  Document: AttachmentTile,
  File: AttachmentTile,
  Image: AttachmentTile,
};
const directoryInputAttributes = { webkitdirectory: "", directory: "" } as Record<string, string>;

const ComposerPromptModeChip: FC<{
  command: SlashCommandDefinition;
  removeLabel: string;
  onRemove: () => void;
}> = ({ command, removeLabel, onRemove }) => (
  <span className="aui-composer-reference-chip aui-composer-reference-chip-query" title={`/${command.command}`}>
    <span className="aui-composer-reference-icon"><TerminalIcon className="size-3" /></span>
    <span className="aui-composer-reference-name">{command.command}</span>
    <button
      type="button"
      className="aui-composer-reference-remove"
      aria-label={removeLabel}
      onMouseDown={(event) => {
        event.preventDefault();
        onRemove();
      }}
    >
      <XIcon className="size-3" />
    </button>
  </span>
);

const ComposerSelectionStrip: FC<{ references: readonly ComposerFileReference[]; commandId: ReturnType<typeof composerPromptModeStore.get>["commandId"]; t: (key: string, params?: Record<string, string>) => string }> = ({ references, commandId, t }) => {
  const attachmentsSignature = useAuiState((state) => JSON.stringify(state.composer.attachments.map((attachment, index) => [attachment.id, index])));
  const attachments = useMemo<ComposerAttachmentOrderItem[]>(() => {
    const parsed = JSON.parse(attachmentsSignature) as [string, number][];
    return parsed.map(([id, index]) => ({ id, index }));
  }, [attachmentsSignature]);
  const items = useMemo<ComposerSelectionItem[]>(() => {
    const referenceItems = references.map((reference): ComposerSelectionItem => ({
      type: "reference",
      key: `reference:${reference.ref}`,
      order: reference.order ?? Number.MAX_SAFE_INTEGER,
      reference,
    }));
    const attachmentItems = attachments.map((attachment): ComposerSelectionItem => ({
      type: "attachment",
      key: `attachment:${attachment.id}`,
      order: composerItemOrderStore.ensureAttachment(attachment.id),
      index: attachment.index,
    }));
    return [...referenceItems, ...attachmentItems].sort((left, right) => left.order - right.order);
  }, [attachments, references]);
  const activeSlashCommand = slashCommandById(commandId);

  if (!activeSlashCommand && items.length === 0) return null;

  return (
    <div className="aui-composer-reference-strip" aria-label="Referenced files">
      {activeSlashCommand && (
        <ComposerPromptModeChip
          command={activeSlashCommand}
          removeLabel={t("slash.removeCommand", { command: activeSlashCommand.command })}
          onRemove={() => composerPromptModeStore.disableSlashCommand()}
        />
      )}
      {items.map((item) => {
        if (item.type === "attachment") {
          return <ComposerPrimitive.AttachmentByIndex key={item.key} index={item.index} components={composerAttachmentComponents} />;
        }
        const { reference } = item;
        const isRepository = referenceIsRepository(reference);
        const ReferenceIcon = referenceIsFolder(reference) ? FolderIcon : isRepository ? GitBranchIcon : FileIcon;
        const uploading = referenceIsUploading(reference);
        return (
          <span key={item.key} className={cn("aui-composer-reference-chip", isRepository && "aui-composer-reference-chip-repo", uploading && "is-loading")} title={reference.ref} aria-busy={uploading || undefined}>
            <span className="aui-composer-reference-icon"><ReferenceIcon className="size-3.5" /></span>
            <span className="aui-composer-reference-name">{referenceLabel(reference)}</span>
            {uploading ? <span className="aui-composer-reference-spinner" aria-hidden="true" /> : null}
            <button
              type="button"
              className="aui-composer-reference-remove"
              aria-label={`Remove ${referenceLabel(reference)}`}
              onMouseDown={(event) => {
                event.preventDefault();
                composerFileReferencesStore.remove(reference.ref);
              }}
            >
              <XIcon className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
};

function removeTrailingMentionFragment(text: string): string {
  return text.replace(/(^|\s)@[^\s@]*$/, (_match, prefix: string) => prefix).replace(/[ \t]+$/, "");
}

function slashCommandQueryFromText(text: string): string | null {
  const match = text.match(/(^|\n)\/([A-Za-z0-9_-]*)$/);
  return match ? match[2] ?? "" : null;
}

function removeTrailingSlashCommandFragment(text: string): string {
  return text.replace(/(^|\n)\/[A-Za-z0-9_-]*$/, (_match, prefix: string) => prefix).replace(/[ \t]+$/, "");
}

function slashCommandSearchText(command: SlashCommandDefinition, t: (key: string) => string): string {
  return `${command.command} ${t(command.labelKey)} ${t(command.descriptionKey)}`.toLowerCase();
}

const SlashCommandMenu: FC<{
  commands: readonly SlashCommandDefinition[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (command: SlashCommandDefinition) => void;
  t: (key: string) => string;
}> = ({ commands, activeIndex, onActiveIndexChange, onSelect, t }) => (
  <div className="aui-slash-command-menu app-scrollbar" role="listbox" aria-label={t("slash.menuLabel")}>
    {commands.map((command, index) => (
      <button
        key={command.id}
        type="button"
        role="option"
        aria-selected={index === activeIndex}
        className={cn("aui-slash-command-item", index === activeIndex && "active")}
        onMouseEnter={() => onActiveIndexChange(index)}
        onMouseDown={(event) => {
          event.preventDefault();
          onSelect(command);
        }}
      >
        <span className="aui-slash-command-name">/{command.command}</span>
        <span className="aui-slash-command-description">{t(command.descriptionKey)}</span>
      </button>
    ))}
  </div>
);

const ThreadWelcome: FC<ThreadOntologyPickerProps> = ({ onCreateOntology, t = (key) => key }) => (
  <div className="aui-thread-welcome-root chat-welcome mx-auto my-auto w-full max-w-(--thread-max-width)">
    <h1>{t("chat.welcome.title")}</h1>
    <p>{t("chat.welcome.subtitle")}</p>
    <div className="chat-suggestions">
      <button type="button" className="chat-suggestion" onClick={onCreateOntology}>
        {t("chat.createNew")}
      </button>
      <button type="button" className="chat-suggestion" onClick={() => openComposerKnowledgePicker("query")}>
        {t("chat.askAboutOntology")}
      </button>
      <button type="button" className="chat-suggestion" onClick={() => openComposerKnowledgePicker("operation")}>
        {t("chat.executeTask")}
      </button>
      <button type="button" className="chat-suggestion" onClick={() => openComposerKnowledgePicker("select")}>
        {t("chat.ingestResources")}
      </button>
    </div>
  </div>
);

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  if (isEditing) return <EditComposer />;
  if (role === "system") return <SystemTimestampMessage />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
};

const SystemTimestampMessage: FC = () => {
  const label = useAuiState((s) => {
    const parts = (s.message as unknown as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
    return parts.find((part) => part.type === "text" && typeof part.text === "string")?.text ?? "";
  });
  if (!label) return null;
  return (
    <MessagePrimitive.Root className="aui-message-time-divider" role="separator" aria-label={label}>
      {label}
    </MessagePrimitive.Root>
  );
};

const ThreadScrollToBottom: FC = () => (
  <ThreadPrimitive.ScrollToBottom render={<TooltipIconButton tooltip="Scroll to bottom" className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible" />}>
    <ArrowDownIcon />
  </ThreadPrimitive.ScrollToBottom>
);

const FollowupSuggestions: FC<{ suggestions: readonly FollowupSuggestion[] }> = ({ suggestions }) => {
  if (!suggestions.length) return null;

  return (
    <div className="steward-suggestions mx-auto w-full max-w-(--thread-max-width) px-2 pb-3" aria-label="Suggested actions">
      {suggestions.map((suggestion, index) => (
        <div key={`${suggestion.prompt}-${index}`} className="steward-suggestion-wrap" style={{ ["--suggestion-index" as string]: index }}>
          <ThreadPrimitive.Suggestion prompt={suggestion.prompt} method="replace" autoSend className="steward-suggestion-pill">
            {suggestion.prompt}
          </ThreadPrimitive.Suggestion>
        </div>
      ))}
    </div>
  );
};

const Composer: FC<ThreadOntologyPickerProps & { enableConnectors?: boolean; disabled?: boolean }> = ({ projects = [], currentProjectId, onSelectProject, enableConnectors = false, resources = [], folders = [], onUploadResources, onUploadResourceFolder, t = (key) => key, disabled = false }) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<ComposerKnowledgePickerMode>("select");
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [resourcePickerOpen, setResourcePickerOpen] = useState(false);
  const [slashMenuActiveIndex, setSlashMenuActiveIndex] = useState(0);
  const [slashMenuDismissedFor, setSlashMenuDismissedFor] = useState<string | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const pickerPopoverRef = useRef<HTMLDivElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const composer = unstable_useComposerInput();
  const resourceQuery = composer.value.match(/(^|\s)@([^\s@]*)$/)?.[2] ?? null;
  const resourceMatches = resourceQuery === null ? [] : resources
    .filter((resource) => resource.name.toLowerCase().includes(resourceQuery.toLowerCase()))
    .slice(0, 6);
  const references = useSyncExternalStore(composerFileReferencesStore.subscribe, composerFileReferencesStore.get, composerFileReferencesStore.get);
  const promptMode = useSyncExternalStore(composerPromptModeStore.subscribe, composerPromptModeStore.get, composerPromptModeStore.get);
  const activeProject = currentProjectId ? projects.find((project) => project.id === currentProjectId) : undefined;
  const hasComposerText = composer.value.trim().length > 0;
  const hasUploadingReferences = references.some(referenceIsUploading);
  const slashCommandQuery = slashMenuDismissedFor === composer.value ? null : slashCommandQueryFromText(composer.value);
  const slashCommandMatches = useMemo(() => {
    if (slashCommandQuery === null) return [];
    const normalizedQuery = slashCommandQuery.trim().toLowerCase();
    if (!normalizedQuery) return slashCommandDefinitions;
    return slashCommandDefinitions.filter((command) => slashCommandSearchText(command, t).includes(normalizedQuery));
  }, [slashCommandQuery, t]);
  const slashMenuOpen = slashCommandQuery !== null && slashCommandMatches.length > 0 && !disabled;
  const canSend = hasComposerText && !hasUploadingReferences && slashCommandQuery === null;

  const insertResourceToken = (resource: Resource) => {
    composerFileReferencesStore.add({ ref: `resource:${resource.id}`, label: resource.name, resourceType: resource.type, source: resource.source });
    composer.setText(removeTrailingMentionFragment(composer.value));
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".aui-composer-input")?.focus(), 0);
  };

  const selectSlashCommand = (command: SlashCommandDefinition) => {
    composerPromptModeStore.enableSlashCommand(command.id);
    composer.setText(removeTrailingSlashCommandFragment(composer.value));
    setSlashMenuDismissedFor(null);
    setAttachmentMenuOpen(false);
    setPickerOpen(false);
    window.setTimeout(() => {
      const input = document.querySelector<HTMLTextAreaElement>(".aui-composer-input");
      input?.focus();
      if (input) input.selectionStart = input.selectionEnd = input.value.length;
    }, 0);
  };

  const handleUploadFolder = async (files: File[]) => {
    if (!files.length || !onUploadResourceFolder) return;
    const pendingRefs = folderUploadLabels(files).map((label) => {
      const ref = folderUploadRef();
      composerFileReferencesStore.add({ ref, label, status: "uploading" });
      return ref;
    });
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".aui-composer-input")?.focus(), 0);
    try {
      const uploadedFolders = await onUploadResourceFolder(files);
      uploadedFolders.forEach((folder) => {
        const pendingRef = pendingRefs.shift();
        const nextReference = { ref: `resource-folder:${folder.id}`, label: folder.name };
        if (pendingRef) {
          if (composerFileReferencesStore.get().some((reference) => reference.ref === pendingRef)) {
            composerFileReferencesStore.replace(pendingRef, nextReference);
          }
          return;
        }
        composerFileReferencesStore.add(nextReference);
      });
      pendingRefs.forEach((ref) => composerFileReferencesStore.remove(ref));
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".aui-composer-input")?.focus(), 0);
    } catch (error) {
      pendingRefs.forEach((ref) => composerFileReferencesStore.remove(ref));
      showToast({ type: "error", message: errorMessage(error), durationMs: 5000 });
    }
  };

  useEffect(() => {
    const openPicker = (event: Event) => {
      const mode = (event as CustomEvent<{ mode?: ComposerKnowledgePickerMode }>).detail?.mode ?? "select";
      setPickerMode(mode);
      setResourcePickerOpen(false);
      setAttachmentMenuOpen(false);
      setPickerOpen(true);
    };
    window.addEventListener(OPEN_COMPOSER_KNOWLEDGE_PICKER_EVENT, openPicker);
    return () => window.removeEventListener(OPEN_COMPOSER_KNOWLEDGE_PICKER_EVENT, openPicker);
  }, []);

  useEffect(() => {
    const openAddMenu = () => {
      setPickerOpen(false);
      setResourcePickerOpen(false);
      setAttachmentMenuOpen(true);
    };
    window.addEventListener(OPEN_COMPOSER_ADD_MENU_EVENT, openAddMenu);
    return () => window.removeEventListener(OPEN_COMPOSER_ADD_MENU_EVENT, openAddMenu);
  }, []);

  useEffect(() => {
    if (!pickerOpen && !attachmentMenuOpen && !slashMenuOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (pickerTriggerRef.current?.contains(target) || pickerPopoverRef.current?.contains(target)) return;
      if (attachmentMenuRef.current?.contains(target)) return;
      const slashMenuElement = document.querySelector(".aui-slash-command-menu");
      const composerInput = document.querySelector(".aui-composer-input");
      if (slashMenuOpen && (slashMenuElement?.contains(target) || composerInput?.contains(target))) return;
      if (slashMenuOpen) setSlashMenuDismissedFor(composer.value);
      setPickerOpen(false);
      setAttachmentMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (slashMenuOpen) setSlashMenuDismissedFor(composer.value);
        setPickerOpen(false);
        setAttachmentMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [attachmentMenuOpen, composer.value, pickerOpen, slashMenuOpen]);

  useEffect(() => {
    setSlashMenuActiveIndex(0);
  }, [slashCommandQuery, slashCommandMatches.length]);

  return (
  <ComposerPrimitive.Root className={cn("aui-composer-root relative mx-auto flex w-full max-w-(--thread-max-width) flex-col", disabled && "pointer-events-none opacity-60")} aria-disabled={disabled || undefined} inert={disabled || undefined}>
    <FileReferenceBridge />
    <input
      ref={folderInputRef}
      type="file"
      multiple
      style={{ display: "none" }}
      onChange={(event) => {
        const selectedFiles = filterSystemUploadFiles(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        void handleUploadFolder(selectedFiles);
      }}
      {...directoryInputAttributes}
    />
    <ComposerPrimitive.AttachmentDropzone
      disabled={disabled || resourcePickerOpen}
      render={<div data-slot="composer-shell" className="aui-composer-shell flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-background p-(--composer-padding) transition-shadow" />}
    >
      <ComposerSelectionStrip references={references} commandId={promptMode.commandId} t={t} />
      <ComposerPrimitive.Input
        placeholder={disabled ? t("chat.preparingConversation") : t("chat.composerPlaceholder")}
        className="aui-composer-input max-h-32 min-h-10 w-full resize-none bg-transparent px-1.75 py-1 text-sm outline-none placeholder:text-muted-foreground/80"
        rows={1}
        autoFocus={!disabled}
        disabled={disabled}
        aria-label="Message input"
        onKeyDown={(event) => {
          if (slashCommandQuery !== null) {
            if (event.key === "ArrowDown" && slashCommandMatches.length > 0) {
              event.preventDefault();
              setSlashMenuActiveIndex((index) => (index + 1) % slashCommandMatches.length);
              return;
            }
            if (event.key === "ArrowUp" && slashCommandMatches.length > 0) {
              event.preventDefault();
              setSlashMenuActiveIndex((index) => (index - 1 + slashCommandMatches.length) % slashCommandMatches.length);
              return;
            }
            if ((event.key === "Enter" || event.key === "Tab") && slashMenuOpen) {
              event.preventDefault();
              event.stopPropagation();
              const command = slashCommandMatches[slashMenuActiveIndex] ?? slashCommandMatches[0];
              if (command) selectSlashCommand(command);
              return;
            }
            if (event.key === " " && slashCommandQuery) {
              const command = slashCommandDefinitions.find((item) => item.command === slashCommandQuery.toLowerCase());
              if (command) {
                event.preventDefault();
                event.stopPropagation();
                selectSlashCommand(command);
                return;
              }
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setSlashMenuDismissedFor(composer.value);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
          }
          if (event.key !== "Enter" || event.shiftKey || (hasComposerText && !hasUploadingReferences)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      {slashMenuOpen && (
        <SlashCommandMenu
          commands={slashCommandMatches}
          activeIndex={slashMenuActiveIndex}
          onActiveIndexChange={setSlashMenuActiveIndex}
          onSelect={selectSlashCommand}
          t={t}
        />
      )}
      {resourceMatches.length > 0 && (
        <div className="aui-resource-quick-picker" role="listbox" aria-label="Resource Library suggestions">
          {resourceMatches.map((resource) => (
            <button
              key={resource.id}
              type="button"
              className="aui-resource-quick-item"
              onMouseDown={(event) => {
                event.preventDefault();
                insertResourceToken(resource);
              }}
            >
              <span className="aui-resource-quick-name">{resource.name}</span>
              <span className="aui-resource-quick-meta">{resource.fileSize || resource.type}</span>
            </button>
          ))}
        </div>
      )}
      <ComposerPrimitive.DictationTranscript className="px-1.75 text-xs text-muted-foreground" />
      <div className="aui-composer-action-wrapper relative flex items-center justify-between gap-1">
        <div className="flex items-center gap-1">
          <div className="relative" ref={attachmentMenuRef}>
            <button
              type="button"
              className={cn("steward-action-icon aui-composer-add-menu-trigger", attachmentMenuOpen && "active")}
              title="Add"
              aria-label="Add"
              aria-expanded={attachmentMenuOpen}
              onClick={() => {
                setPickerOpen(false);
                setResourcePickerOpen(false);
                setAttachmentMenuOpen((open) => !open);
              }}
            >
              <PlusIcon className="size-5" />
            </button>
            {attachmentMenuOpen && (
              <div className="aui-composer-add-menu">
                <ComposerPrimitive.AddAttachment
                  render={(
                    <button
                      type="button"
                      className="aui-composer-add-menu-item"
                      onClick={() => setAttachmentMenuOpen(false)}
                    />
                  )}
                >
                  <PaperclipIcon className="size-4" />
                  <span>{t("plus.uploadFile")}</span>
                </ComposerPrimitive.AddAttachment>
                {onUploadResourceFolder ? (
                  <button
                    type="button"
                    className="aui-composer-add-menu-item"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setAttachmentMenuOpen(false);
                      folderInputRef.current?.click();
                    }}
                  >
                    <FolderIcon className="size-4" />
                    <span>{t("plus.uploadFolder")}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="aui-composer-add-menu-item"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setAttachmentMenuOpen(false);
                    setPickerOpen(false);
                    setResourcePickerOpen(true);
                  }}
                >
                  <UploadIcon className="size-4" />
                  <span>{t("plus.fromResourceLib")}</span>
                </button>
              </div>
            )}
          </div>
          {enableConnectors ? <ConnectorButton t={t} /> : null}
          <button ref={pickerTriggerRef} type="button" className={cn("aui-composer-knowledge-trigger", activeProject && "has-project")} title={t("knowledgePicker.title")} aria-label={t("knowledgePicker.title")} onClick={() => { setPickerMode("select"); setAttachmentMenuOpen(false); setPickerOpen((open) => !open); }}>
            {activeProject ? (
              <>
                <span className="aui-composer-knowledge-emoji">{activeProject.emoji}</span>
                <span className="aui-composer-knowledge-name">{activeProject.name}</span>
              </>
            ) : (
              <BookOpenIcon className="size-4" />
            )}
          </button>
        </div>
        {pickerOpen && (
          <div ref={pickerPopoverRef} className="aui-composer-ontology-picker-popover">
            <OntologyPickerPanel projects={projects} currentProjectId={currentProjectId} onSelectProject={(project) => { onSelectProject?.(project); if (pickerMode === "query") { composerPromptModeStore.enableQuery(); } else if (pickerMode === "operation") { composerPromptModeStore.enableOperation(); } else { composerPromptModeStore.clear(); window.dispatchEvent(new CustomEvent("composer:open-add-menu")); } setPickerOpen(false); }} t={t} />
          </div>
        )}
        {resourcePickerOpen && createPortal(
          <ResourcePicker
            resources={resources}
            folders={folders}
            onConfirm={(selected) => {
              selected.forEach((selection: ResourcePickerSelection) => {
                if (selection.type === "folder") {
                  composerFileReferencesStore.add({ ref: `resource-folder:${selection.folder.id}`, label: selection.folder.name });
                  return;
                }
                composerFileReferencesStore.add({ ref: `resource:${selection.resource.id}`, label: selection.resource.name, resourceType: selection.resource.type, source: selection.resource.source });
              });
              window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".aui-composer-input")?.focus(), 0);
              setResourcePickerOpen(false);
            }}
            onUploadFiles={async (files) => onUploadResources ? onUploadResources(files) : []}
            onClose={() => setResourcePickerOpen(false)}
            t={t}
          />,
          document.body,
        )}
        <div className="flex items-center gap-1">
          {disabled ? (
            <TooltipIconButton tooltip={t("chat.preparingConversation")} className="aui-composer-send size-8 rounded-full" disabled>
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </TooltipIconButton>
          ) : (
            <>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate render={<TooltipIconButton tooltip="Voice input" type="button" className="aui-composer-dictate size-8 rounded-full text-muted-foreground hover:text-foreground" aria-label="Start voice input" />}>
              <MicIcon className="size-4" />
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation render={<TooltipIconButton tooltip="Stop voice input" type="button" className="aui-composer-stop-dictation size-8 rounded-full text-destructive hover:text-destructive/80 animate-pulse" aria-label="Stop voice input" />}>
              <SquareIcon className="size-3 fill-current" />
            </ComposerPrimitive.StopDictation>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send render={<TooltipIconButton tooltip="Send" className={cn("aui-composer-send size-8 rounded-full", canSend && "is-ready")} disabled={!canSend} />}>
            <ArrowUpIcon className="aui-composer-send-icon size-4" />
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel render={<Button type="button" variant="default" size="icon" className="aui-composer-cancel size-8 rounded-full" aria-label="Stop generating" />}>
            <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
          </ComposerPrimitive.Cancel>
        </AuiIf>
            </>
          )}
        </div>
      </div>
      </ComposerPrimitive.AttachmentDropzone>
  </ComposerPrimitive.Root>
);
};

const FileReferenceBridge: FC = () => {
  const composer = unstable_useComposerInput();
  const composerRef = useRef(composer);

  useEffect(() => {
    composerRef.current = composer;
  }, [composer]);

  useEffect(() => {
    const insertReference = (event: Event) => {
      const detail = (event as CustomEvent<{ filename?: string; path?: string; kind?: ComposerFileReference["kind"] }>).detail ?? {};
      const ref = detail.path || detail.filename;
      if (!ref) return;
      const current = composerRef.current.value;
      composerFileReferencesStore.add({ ref, label: detail.filename, kind: detail.kind });
      composerRef.current.setText(removeTrailingMentionFragment(current));
      window.setTimeout(() => {
        const input = document.querySelector<HTMLTextAreaElement>(".aui-composer-input");
        input?.focus();
        if (input) input.selectionStart = input.selectionEnd = input.value.length;
      }, 0);
    };

    window.addEventListener("insertFileReference", insertReference);
    return () => window.removeEventListener("insertFileReference", insertReference);
  }, []);

  return null;
};

const ConnectorButton: FC<{ t?: (key: string, params?: Record<string, string>) => string }> = ({ t = (key) => key }) => {
  const [apps, setApps] = useState<ComposioApp[]>([]);
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [disabled, setDisabled] = useState(connectorStore.getDisabled());
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    try {
      setApps(await listComposioApps());
    } catch {
      setApps([]);
    }
  };

  useEffect(() => {
    void refresh();
    return connectorStore.subscribe(() => setDisabled(connectorStore.getDisabled()));
  }, []);

  useEffect(() => {
    if (!dialogOpen) void refresh();
  }, [dialogOpen]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const connected = apps.filter((app) => app.connected);
  const enabledCount = connected.filter((app) => !disabled.has(app.app.toLowerCase())).length;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className={cn("steward-action-icon", open && "active")}
        aria-label="Connectors"
        title={enabledCount > 0 ? `${enabledCount} connector${enabledCount === 1 ? "" : "s"} enabled` : "Connectors"}
        onClick={() => setOpen((value) => !value)}
      >
        <CableIcon />
      </button>
      {open ? (
        <div className="aui-composer-connectors-popover app-scrollbar">
          <div className="connector-popover-title">{t("connector.title")}</div>
          {connected.length ? connected.map((app) => {
            const appDisabled = disabled.has(app.app.toLowerCase());
            return (
              <div key={app.app} className="chat-connector-item">
                <span className="chat-connector-item-icon">
                  {app.logo ? <img src={app.logo} alt="" className="size-4 rounded-sm" /> : <CableIcon className="size-4" />}
                </span>
                <span className="chat-connector-item-name">{app.name}</span>
                <label className="chat-connector-toggle" aria-label={`${app.name} connector`}>
                  <input type="checkbox" checked={!appDisabled} onChange={() => connectorStore.toggle(app.app)} />
                  <span className="chat-connector-toggle-track" />
                </label>
              </div>
            );
          }) : <div className="connector-popover-empty">{t("connector.noApps")}</div>}
          <div className="chat-connector-divider" />
          <button type="button" className="chat-connector-manage" onClick={() => { setDialogOpen(true); setOpen(false); }}>
            {t("connector.manage")}
          </button>
        </div>
      ) : null}
      {dialogOpen ? createPortal(<ConnectorDialog open={dialogOpen} onOpenChange={setDialogOpen} t={t} />, document.body) : null}
    </div>
  );
};

const OntologyPickerPanel: FC<ThreadOntologyPickerProps> = ({ projects = [], currentProjectId, onSelectProject, t = (key) => key }) => (
  <div className="aui-ontology-picker-panel">
    <div className="aui-ontology-picker-title">{t("knowledgePicker.title")}</div>
    {projects.length === 0 ? (
      <div className="aui-ontology-picker-empty">{t("knowledgePicker.empty")}</div>
    ) : projects.map((project) => (
      <button
        key={project.id}
        type="button"
        className={cn("aui-ontology-picker-item", currentProjectId === project.id && "active")}
        onClick={() => onSelectProject?.(project)}
      >
        <span className="aui-ontology-picker-emoji">{project.emoji}</span>
        <span className="aui-ontology-picker-copy">
          <span className="aui-ontology-picker-name">{project.name}</span>
          <span className="aui-ontology-picker-desc">{project.description || t("knowledgePicker.descriptionFallback")}</span>
        </span>
      </button>
    ))}
  </div>
);

const MessageError: FC = () => (
  <MessagePrimitive.Error>
    <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
      <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
    </ErrorPrimitive.Root>
  </MessagePrimitive.Error>
);

type AssistantToolPart = {
  type?: string;
  toolName?: string;
  input?: unknown;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  output?: unknown;
  errorText?: string;
  isError?: boolean;
  toolUI?: ReactNode;
};

const ASSISTANT_TOOL_CONFIG: Record<string, { label: string; emoji: string }> = {
  Read: { label: "Read", emoji: "📄" },
  Write: { label: "Write", emoji: "📝" },
  Edit: { label: "Edit", emoji: "✏️" },
  MultiEdit: { label: "MultiEdit", emoji: "✏️" },
  Glob: { label: "Glob", emoji: "📂" },
  Grep: { label: "Grep", emoji: "🔎" },
  Bash: { label: "Bash", emoji: "🔨" },
  Task: { label: "Agent", emoji: "🤖" },
  Agent: { label: "Agent", emoji: "🤖" },
  intermediate: { label: "[intermediate_answer]", emoji: "💡" },
  deepening: { label: "[deepening_queries]", emoji: "🔭" },
};
const MAX_ASSISTANT_ACTIVITY_SUMMARY_LENGTH = 160;

function displayAssistantToolName(toolName: string) {
  if (toolName.includes("ontology_update_scenario_cards")) {
    return "Update scenario cards";
  }
  if (toolName.includes("ontology_instance_gleaning")) {
    return "Instance gleaning";
  }
  if (toolName.includes("knowledge_update_journey") || toolName.includes("ontology_update_journey")) {
    return "Update journey";
  }
  if (toolName.startsWith("mcp__")) {
    const [, server, name] = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__([^_].*)$/) ?? [];
    return name ? `${server.replace(/_/g, " ")} · ${name.replace(/_/g, " ")}` : toolName.replace(/^mcp__/, "").replace(/_/g, " ");
  }
  return toolName;
}

function summarizeAssistantTool(part: AssistantToolPart) {
  const rawInput = part.argsText ?? stringifyToolValue(part.input ?? part.args);
  const parsed = parseToolInput(rawInput);
  return summarizeToolCall(part.toolName, parsed, part.result, part.output, part.errorText);
}

function truncateAssistantActivitySummary(summary: string): string {
  if (summary.length <= MAX_ASSISTANT_ACTIVITY_SUMMARY_LENGTH) return summary;
  return `${summary.slice(0, MAX_ASSISTANT_ACTIVITY_SUMMARY_LENGTH).trimEnd()}...`;
}

function assistantToolConfig(toolName = "tool") {
  return ASSISTANT_TOOL_CONFIG[toolName] ?? {
    label: displayAssistantToolName(toolName),
    emoji: toolName.toLowerCase().includes("agent") ? "🤖" : "🔧",
  };
}

const AssistantActivity: FC<{ parts: AssistantToolPart[]; running: boolean; isLast: boolean }> = ({ parts, running, isLast }) => {
  const shouldOpen = running && isLast;
  const [open, setOpen] = useState(shouldOpen);

  useEffect(() => {
    setOpen(shouldOpen);
  }, [shouldOpen, parts.length]);

  if (!parts.length) return null;

  return (
    <div className="assistant-activity">
      <button type="button" className="assistant-activity-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <LayersIcon className="size-3.5" />
        <span>{shouldOpen ? `Working (${parts.length} steps)...` : `${parts.length} steps`}</span>
        <ChevronDownIcon className={cn("assistant-activity-chevron size-3.5", open && "open")} />
      </button>
      {open && (
        <div className="assistant-activity-items">
          {parts.map((part, index) => {
            const config = assistantToolConfig(part.toolName);
            const summary = summarizeAssistantTool(part);
            const displaySummary = truncateAssistantActivitySummary(summary);
            const isTagged = part.toolName === "intermediate" || part.toolName === "deepening";
            return (
              <div key={`${part.toolName ?? "tool"}-${index}`} className={cn("assistant-activity-item", part.isError && "error", isTagged && "tagged")}>
                <span className="assistant-activity-item-icon" aria-hidden="true">{part.isError ? "⚠️" : config.emoji}</span>
                {isTagged ? (
                  <span className="assistant-activity-item-text" title={summary}>
                    <span className="assistant-activity-item-tag">{config.label}</span>
                    {displaySummary ? " " : ""}{displaySummary}
                  </span>
                ) : (
                  <>
                    <span className="assistant-activity-item-name">{config.label}</span>
                    <span className="assistant-activity-item-text" title={summary}>{displaySummary}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const AssistantMessageBody: FC = () => {
  const parts = useAuiState((s) => s.message.parts) as unknown as AssistantToolPart[];
  const running = useAuiState((s) => s.thread.isRunning);
  const isLast = useAuiState((s) => s.message.isLast);
  const toolParts = useMemo(
    () => parts.filter((part) => part.type === "tool-call" && !isHiddenToolCall(part.toolName)),
    [parts],
  );

  return (
    <>
      <AssistantActivity parts={toolParts} running={running} isLast={isLast} />
      <MessagePrimitive.Parts>
        {({ part }) => {
          if (part.type === "text") return <MarkdownText />;
          return null;
        }}
      </MessagePrimitive.Parts>
      {running && isLast ? <TypingIndicator /> : null}
      <MessageError />
    </>
  );
};

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="aui-assistant-message-root fade-in slide-in-from-bottom-1 relative mx-auto w-full max-w-(--thread-max-width) animate-in py-3 duration-150" data-role="assistant">
    <div className="aui-assistant-message-content wrap-break-word px-2 text-foreground leading-relaxed">
      <AssistantMessageBody />
    </div>
    <div className="aui-assistant-message-footer mt-1 ml-2 flex min-h-6 items-center">
      <AssistantActionBar />
    </div>
  </MessagePrimitive.Root>
);

const AssistantActionBar: FC = () => {
  const issueHelp = useContext(IssueHelpContext);
  if (issueHelp.readOnly) return null;
  return (
    <ActionBarPrimitive.Root className="aui-assistant-action-bar-root col-start-3 row-start-2 -ml-1 flex gap-1 text-muted-foreground">
      <ActionBarPrimitive.Copy render={<TooltipIconButton tooltip="Copy" />}>
        <AuiIf condition={(s) => s.message.isCopied}><CheckIcon /></AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}><CopyIcon /></AuiIf>
      </ActionBarPrimitive.Copy>
      <AssistantSaveMarkdownButton />
      {issueHelp.available ? (
        <TooltipIconButton
          tooltip={issueHelp.disabled ? "助手正在运行" : "遇到问题？"}
          className="aui-assistant-issue-help"
          aria-label="遇到问题？"
          disabled={issueHelp.disabled}
          onClick={issueHelp.open}
        >
          <BugIcon />
        </TooltipIconButton>
      ) : null}
    </ActionBarPrimitive.Root>
  );
};

function markdownTextFromAssistantParts(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: string; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function markdownDownloadFilename(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
  return `agent-reply-${timestamp}.md`;
}

function downloadMarkdownFile(markdown: string): void {
  const blob = new Blob([markdown.endsWith("\n") ? markdown : `${markdown}\n`], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = markdownDownloadFilename();
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const AssistantSaveMarkdownButton: FC = () => {
  const [saved, setSaved] = useState(false);
  const markdown = useAuiState((s) => markdownTextFromAssistantParts((s.message.parts ?? []) as readonly unknown[]));
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
  }, []);

  const handleSave = () => {
    if (!markdown) return;
    try {
      downloadMarkdownFile(markdown);
      setSaved(true);
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => setSaved(false), 1200);
    } catch (error) {
      showToast({ type: "error", message: `Save failed: ${errorMessage(error)}`, durationMs: 4000 });
    }
  };

  return (
    <TooltipIconButton tooltip={saved ? "Saved" : "Save as Markdown"} className="aui-assistant-save-markdown" disabled={!markdown} onClick={handleSave}>
      {saved ? <CheckIcon /> : <ArrowDownToLineIcon />}
    </TooltipIconButton>
  );
};

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="aui-user-message-root fade-in slide-in-from-bottom-1 mx-auto grid w-full max-w-(--thread-max-width) animate-in auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 py-3 duration-150 [&:where(>*)]:col-start-2" data-role="user">
    <UserMessageAttachments />
    <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
      <div className="aui-user-message-content wrap-break-word peer flex flex-col items-start gap-2 rounded-2xl bg-muted px-4 py-2.5 text-foreground empty:hidden">
        <MessagePrimitive.Parts>
          {({ part }) => {
            if (part.type === "text") return <span className="aui-user-text-part">{part.text}</span>;
            return null;
          }}
        </MessagePrimitive.Parts>
      </div>
      <div className="aui-user-action-bar-wrapper mt-1 flex justify-end peer-empty:hidden">
        <UserActionBar />
      </div>
    </div>
  </MessagePrimitive.Root>
);

const UserActionBar: FC = () => (
  <ActionBarPrimitive.Root className="aui-user-action-bar-root flex items-center justify-end gap-1">
    <UserCopyButton />
  </ActionBarPrimitive.Root>
);

function copyTextFromUserParts(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as {
        type?: string;
        text?: unknown;
        filename?: unknown;
        providerMetadata?: {
          workspace?: { path?: string; label?: string };
          optimistic?: { statusLabel?: string };
        };
      };
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "file") {
        const workspace = record.providerMetadata?.workspace;
        return workspace?.path || workspace?.label || (typeof record.filename === "string" ? record.filename : "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

const UserCopyButton: FC = () => {
  const [copied, setCopied] = useState(false);
  const copyText = useAuiState((s) => copyTextFromUserParts((s.message.parts ?? []) as readonly unknown[]));
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  const handleCopy = async () => {
    if (!copyText) return;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(copyText);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = copyText;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <TooltipIconButton tooltip={copied ? "Copied" : "Copy"} className="aui-user-action-copy" disabled={!copyText} onClick={handleCopy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </TooltipIconButton>
  );
};

const TypingIndicator: FC = () => (
  <div className="aui-typing-indicator" aria-label="Assistant is typing" role="status">
    <span />
    <span />
    <span />
  </div>
);

const ThreadRunningIndicator: FC = () => {
  const show = useAuiState((s) => {
    if (!s.thread.isRunning) return false;
    const messages = s.thread.messages;
    const last = messages[messages.length - 1];
    return last?.role !== "assistant";
  });

  if (!show) return null;
  return (
    <div className="aui-assistant-message-root aui-running-placeholder relative mx-auto w-full max-w-(--thread-max-width) py-3" data-role="assistant">
      <div className="aui-assistant-message-content px-2">
        <TypingIndicator />
      </div>
    </div>
  );
};

const EditComposer: FC = () => (
  <MessagePrimitive.Root className="aui-edit-composer-wrapper mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 py-3">
    <ComposerPrimitive.Root className="aui-edit-composer-root ml-auto flex w-full max-w-[85%] flex-col rounded-2xl bg-muted">
      <ComposerPrimitive.Input className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent p-4 text-foreground text-sm outline-none" autoFocus />
      <div className="aui-edit-composer-footer mx-3 mb-3 flex items-center gap-2 self-end">
        <ComposerPrimitive.Cancel render={<Button variant="ghost" size="sm" />}>Cancel</ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send render={<Button size="sm" />}>Update</ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  </MessagePrimitive.Root>
);

export interface OntologyThreadMessage {
  role: "user" | "agent" | "tool";
  content: string;
  toolName?: string;
}

export function OntologyThread(props: {
  messages?: OntologyThreadMessage[];
  loading?: boolean;
  welcome?: React.ReactNode;
  bottomRef?: React.RefObject<HTMLDivElement | null>;
}) {
  void props;
  return <Thread fillPanel />;
}
