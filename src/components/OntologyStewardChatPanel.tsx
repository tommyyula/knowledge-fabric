import { useChat } from "@ai-sdk/react";
import { AssistantRuntimeProvider, useExternalMessageConverter, useExternalStoreRuntime, type AttachmentAdapter, type CompleteAttachment, type PendingAttachment, type ThreadMessageLike } from "@assistant-ui/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import { Database, ArchiveX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import FilePreviewModal from "@/components/FilePreviewModal";
import OperationRunList from "@/components/OperationRunList";
import OperationRunPagination from "@/components/OperationRunPagination";
import { TemplateSyncBanner } from "@/components/TemplateSyncBanner";
import { Thread } from "@/components/assistant-ui/thread";
import type { ChatMessage, Project, Resource, ResourceFolder } from "@/mocks/data";
import type { OntologyFileNode, OntologyMessage, OntologySession, OperationRun } from "@/contracts/ontology";
import { useDeleteOperationRun, useOperationRuns, useUpdateOperationRun } from "@/hooks/useOperations";
import { useOntologyChatStatus, useOntologyFile, useOntologyMessages, useOntologyTree } from "@/hooks/useOntologies";
import { apiUrl, authHeaders } from "@/lib/api-client";
import { composerFileReferencesStore, type ComposerFileReference } from "@/lib/composer-file-references-store";
import { composerPromptModeStore } from "@/lib/composer-prompt-mode-store";
import { connectorStore } from "@/lib/connector-store";
import { createFollowupSuggestionsStore, type FollowupSuggestion } from "@/lib/followup-suggestions-store";
import { createReconnectFetchController } from "@/lib/reconnect-fetch-controller";
import { ResilientWebSpeechDictationAdapter } from "@/lib/resilient-web-speech-dictation";
import { errorMessage, showToast } from "@/lib/toast";
import { publishAndCopyConversationLink } from "@/lib/conversation-share";
import { assertUploadBatchWithinLimit } from "@/lib/upload-limits";
import { suggestFollowups } from "@/services/api/followup-suggestions";
import { cancelOntologyChat, type OntologyChatStatus } from "@/services/api/ontology-chat";
import { uploadOntologyFile } from "@/services/api/ontology";
import { submitTechnicalIssueReport } from "@/services/api/support";
import type { Locale } from "@/i18n";
import type { IssueReportPayload, IssueShortcut } from "@/components/IssueHelpDialog";
import type { SlashCommandId } from "@/contracts/slash-commands";

export interface PendingConversation {
  id: string;
  kind: "knowledge" | "session";
  project: Project;
  message: string;
  files: File[];
  workspaceFiles: string[];
  workspaceReferences: ComposerFileReference[];
  resourceIds: string[];
  resourceFolderIds: string[];
  status: "creating" | "uploading" | "failed";
  startedAt: number;
  error?: string;
}

export interface SendWithoutSessionInput {
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
}

interface BeforeSendInput {
  message: string;
  backendMessage?: string;
  slashCommandId?: SlashCommandId | null;
  resourceIds?: string[];
  resourceFolderIds?: string[];
  workspaceFiles?: string[];
  workspaceReferences?: ComposerFileReference[];
}

interface OntologyStewardChatPanelProps {
  project: Project | null;
  projects: Project[];
  currentSessionId: string | null;
  onNewOntology: () => void;
  onSendWithoutSession: (input: SendWithoutSessionInput) => Promise<void>;
  sessions?: OntologySession[];
  onSelectSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onSelectOperationRun?: (run: OperationRun) => void;
  onSelectProject?: (project: Project) => void;
  pendingInitialMessage?: string | null;
  pendingInitialBackendMessage?: string | null;
  pendingInitialSlashCommandId?: SlashCommandId | null;
  pendingInitialFiles?: File[];
  pendingInitialWorkspaceFiles?: string[];
  pendingInitialWorkspaceReferences?: ComposerFileReference[];
  pendingInitialResourceIds?: string[];
  pendingInitialResourceFolderIds?: string[];
  pendingConversation?: PendingConversation | null;
  onRetryPendingConversation?: () => void;
  onPendingInitialMessageConsumed?: () => void;
  knowledgeOpen: boolean;
  backendUnavailable?: boolean;
  onPhaseUpdate?: (message: ChatMessage) => void;
  resources?: Resource[];
  folders?: ResourceFolder[];
  onUploadResources?: (files: File[]) => Promise<Resource[]>;
  onUploadResourceFolder?: (files: File[]) => Promise<ResourceFolder[]>;
  locale?: Locale;
  t?: (key: string, params?: Record<string, string>) => string;
}

type UiPart = UIMessage["parts"][number] & Record<string, unknown>;
type TimestampedUIMessage = UIMessage & {
  createdAt?: Date | string;
  metadata?: {
    custom?: Record<string, unknown>;
  };
};
const RESOURCE_REPOSITORY_MEDIA_TYPE = "application/x-resource-repository";

function flattenOntologyFilePaths(items: OntologyFileNode[] | undefined): string[] {
  const paths: string[] = [];
  const visit = (item: OntologyFileNode) => {
    if (item.type === "file") paths.push(item.path);
    item.children?.forEach(visit);
  };
  items?.forEach(visit);
  return paths;
}

const CONVERSATION_TIMESTAMP_GAP_MS = 60 * 60 * 1000;

function parseMessageDate(value: unknown): Date | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function uiMessageTimestamp(message: UIMessage): Date | undefined {
  const timestamped = message as TimestampedUIMessage;
  return parseMessageDate(timestamped.createdAt) ?? parseMessageDate(timestamped.metadata?.custom?.createdAt);
}

function timestampMetadata(createdAt: Date, metadata?: TimestampedUIMessage["metadata"]): ThreadMessageLike["metadata"] {
  return {
    ...metadata,
    custom: {
      ...(metadata?.custom ?? {}),
      createdAt: createdAt.toISOString(),
    },
  };
}

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function shouldShowConversationTimestamp(current: Date, previous: Date | null): boolean {
  if (!previous) return true;
  if (!sameLocalDay(current, previous)) return true;
  return current.getTime() - previous.getTime() >= CONVERSATION_TIMESTAMP_GAP_MS;
}

function formatConversationTimestamp(date: Date): string {
  const now = new Date();
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (sameLocalDay(date, now)) return `Today ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameLocalDay(date, yesterday)) return `Yesterday ${time}`;

  if (date.getFullYear() === now.getFullYear()) {
    return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
  }
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ${time}`;
}

function withTimestampDividerMessages(messages: UIMessage[]): UIMessage[] {
  const result: UIMessage[] = [];
  let previousTimestamp: Date | null = null;

  for (const message of messages) {
    const createdAt = uiMessageTimestamp(message);
    if (createdAt && shouldShowConversationTimestamp(createdAt, previousTimestamp)) {
      const label = formatConversationTimestamp(createdAt);
      result.push({
        id: `timestamp-${message.id}-${createdAt.getTime()}`,
        role: "system",
        parts: [{ type: "text", text: label }],
        createdAt,
        metadata: timestampMetadata(createdAt, { custom: { timestampDivider: true, label } }),
      } as UIMessage);
    }
    result.push(message);
    if (createdAt) previousTimestamp = createdAt;
  }

  return result;
}

function toUiMessages(messages: OntologyMessage[]): UIMessage[] {
  return messages.map((message, index) => {
    const createdAt = parseMessageDate(message.createdAt);
    return {
      id: message.id ?? `restored-${index}`,
      role: message.role === "system" ? "system" : message.role === "user" ? "user" : "assistant",
      parts: message.parts?.length ? message.parts as UIMessage["parts"] : [{ type: "text", text: message.content }],
      ...(createdAt ? { createdAt, metadata: timestampMetadata(createdAt) } : {}),
    } as UIMessage;
  });
}

function textFromParts(parts: readonly unknown[] | undefined): string {
  return (parts ?? [])
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("\n")
    .trim();
}

function runCursorFromDataPart(part: { type?: unknown; data?: unknown }): { runId: string; sequence: number } | null {
  if (part.type !== "data-run-event" || !part.data || typeof part.data !== "object" || Array.isArray(part.data)) return null;
  const data = part.data as Record<string, unknown>;
  return typeof data.runId === "string" && typeof data.sequence === "number"
    ? { runId: data.runId, sequence: data.sequence }
    : null;
}

function retryNoticeFromDataPart(part: { type?: unknown; data?: unknown }): { attempt: number; maxRetries: number; delayMs: number } | null {
  if (part.type !== "data-retry" || !part.data || typeof part.data !== "object" || Array.isArray(part.data)) return null;
  const data = part.data as Record<string, unknown>;
  return typeof data.attempt === "number" && typeof data.maxRetries === "number"
    ? { attempt: data.attempt, maxRetries: data.maxRetries, delayMs: typeof data.delayMs === "number" ? data.delayMs : 0 }
    : null;
}

function numberBodyField(body: Record<string, unknown> | undefined, field: string): number {
  const value = body?.[field];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function stringBodyField(body: Record<string, unknown> | undefined, field: string): string | null {
  const value = body?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uploadedAttachmentFileParts(attachments: readonly CompleteAttachment[]): FileUIPart[] {
  return attachments.map((attachment) => ({
    type: "file",
    mediaType: attachment.contentType || "application/octet-stream",
    filename: attachment.name,
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(attachment.name)}`,
    providerMetadata: { uploaded: { name: attachment.name } },
  }));
}

function uploadedFileParts(files: readonly File[]): FileUIPart[] {
  return files.map((file) => ({
    type: "file",
    mediaType: file.type || "application/octet-stream",
    filename: file.name,
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(file.name)}`,
    providerMetadata: { uploaded: { name: file.name } },
  }));
}

function withOptimisticProcessing(part: FileUIPart, statusLabel: string): FileUIPart {
  return {
    ...part,
    providerMetadata: {
      ...(part.providerMetadata ?? {}),
      optimistic: { status: "processing", statusLabel },
    },
  };
}

function optimisticUserMessage(input: { id: string; text: string; attachments: readonly CompleteAttachment[]; referenceParts: readonly FileUIPart[]; statusLabel: string }): UIMessage {
  const createdAt = new Date();
  const parts: UIMessage["parts"] = [];
  if (input.text) parts.push({ type: "text", text: input.text });
  parts.push(...input.referenceParts.map((part) => withOptimisticProcessing(part, input.statusLabel)));
  parts.push(...uploadedAttachmentFileParts(input.attachments).map((part) => withOptimisticProcessing(part, input.statusLabel)));
  return { id: input.id, role: "user", parts, createdAt, metadata: timestampMetadata(createdAt) } as UIMessage;
}

function resourceIdsFromText(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/@resource:([A-Za-z0-9_-]+)/g)).map((match) => match[1]).filter(Boolean)));
}

function resourceFolderIdsFromText(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/@resource-folder:([A-Za-z0-9_-]+)/g)).map((match) => match[1]).filter(Boolean)));
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function stripResourceTokens(text: string): string {
  return text
    .replace(/@resource-folder:[A-Za-z0-9_-]+/g, "")
    .replace(/@resource:[A-Za-z0-9_-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resourceIdsFromReferences(references: readonly ComposerFileReference[]): string[] {
  return uniqueStrings(references
    .map((reference) => reference.ref.startsWith("resource:") ? reference.ref.slice("resource:".length) : "")
    .filter(Boolean));
}

function resourceFolderIdsFromReferences(references: readonly ComposerFileReference[]): string[] {
  return uniqueStrings(references
    .map((reference) => reference.ref.startsWith("resource-folder:") ? reference.ref.slice("resource-folder:".length) : "")
    .filter(Boolean));
}

function isWorkspaceReferencePath(ref: string): boolean {
  return !ref.startsWith("resource:") && !ref.startsWith("resource-folder:") && !ref.startsWith("resource-folder-upload:") && !ref.includes("://") && !ref.includes("..");
}

function workspaceFilesFromReferences(references: readonly ComposerFileReference[]): string[] {
  return uniqueStrings(references
    .map((reference) => reference.ref)
    .filter(isWorkspaceReferencePath));
}

function referenceLabel(reference: ComposerFileReference): string {
  return reference.label || reference.ref.split("/").pop() || reference.ref;
}

function workspaceReferenceFromPath(filePath: string): ComposerFileReference {
  return { ref: filePath, label: filePath.split("/").pop() ?? filePath };
}

function mergeWorkspaceReferences(
  references: readonly ComposerFileReference[],
  paths: readonly string[],
): ComposerFileReference[] {
  const byPath = new Map<string, ComposerFileReference>();
  for (const reference of references) {
    if (!isWorkspaceReferencePath(reference.ref)) continue;
    if (!byPath.has(reference.ref)) byPath.set(reference.ref, reference);
  }
  for (const filePath of paths) {
    if (!isWorkspaceReferencePath(filePath) || byPath.has(filePath)) continue;
    byPath.set(filePath, workspaceReferenceFromPath(filePath));
  }
  return Array.from(byPath.values());
}

function isRepositoryResource(resource: Resource | undefined, reference?: ComposerFileReference): boolean {
  return resource?.type === "repo" || resource?.source === "bitbucket" || Boolean(resource?.bitbucket) || reference?.resourceType === "repo" || reference?.source === "bitbucket";
}

function workspaceReferenceFileParts(references: readonly ComposerFileReference[]): FileUIPart[] {
  const byPath = new Map<string, ComposerFileReference>();
  for (const reference of references) {
    if (!isWorkspaceReferencePath(reference.ref)) continue;
    byPath.set(reference.ref, reference);
  }
  return Array.from(byPath.values()).map((reference) => ({
    type: "file",
    mediaType: reference.kind === "folder" ? "application/x-workspace-folder" : "text/markdown",
    filename: referenceLabel(reference),
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(reference.ref)}`,
    providerMetadata: { workspace: { path: reference.ref, label: referenceLabel(reference), ...(reference.kind ? { kind: reference.kind } : {}) } },
  }));
}

function resourceFileParts(resources: readonly Resource[], ids: readonly string[], references: readonly ComposerFileReference[] = []): FileUIPart[] {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const referenceById = new Map(references
    .filter((reference) => reference.ref.startsWith("resource:"))
    .map((reference) => [reference.ref.slice("resource:".length), reference]));
  return ids.map((id) => {
    const resource = byId.get(id);
    const reference = referenceById.get(id);
    const label = resource?.name ?? reference?.label ?? id;
    const isRepository = isRepositoryResource(resource, reference);
    return {
      type: "file",
      mediaType: isRepository ? RESOURCE_REPOSITORY_MEDIA_TYPE : "text/plain",
      filename: label,
      url: `data:text/plain;charset=utf-8,${encodeURIComponent(`resource:${id}`)}`,
      providerMetadata: {
        resource: {
          id,
          name: label,
          ...(resource?.type ? { type: resource.type } : reference?.resourceType ? { type: reference.resourceType } : {}),
          ...(resource?.source ? { source: resource.source } : reference?.source ? { source: reference.source } : {}),
          ...(resource?.bitbucket ? { bitbucket: resource.bitbucket } : {}),
        },
      },
    };
  });
}

function resourceFolderFileParts(folders: readonly ResourceFolder[], ids: readonly string[], references: readonly ComposerFileReference[] = []): FileUIPart[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const labelById = new Map(references
    .filter((reference) => reference.ref.startsWith("resource-folder:"))
    .map((reference) => [reference.ref.slice("resource-folder:".length), reference.label]));
  return ids.map((id) => {
    const folder = byId.get(id);
    const label = folder?.name ?? labelById.get(id) ?? id;
    return {
      type: "file",
      mediaType: "application/x-resource-folder",
      filename: label,
      url: `data:text/plain;charset=utf-8,${encodeURIComponent(`resource-folder:${id}`)}`,
      providerMetadata: { resourceFolder: { id, name: label } },
    };
  });
}

function optimisticInitialUserMessage(input: {
  id: string;
  text: string;
  files: readonly File[];
  workspaceFiles: readonly string[];
  workspaceReferences: readonly ComposerFileReference[];
  resourceIds: readonly string[];
  resourceFolderIds: readonly string[];
  resources: readonly Resource[];
  folders: readonly ResourceFolder[];
  createdAt: Date;
  statusLabel: string;
}): UIMessage {
  const attachmentNames = new Set(input.files.map((file) => file.name));
  const workspaceReferences = mergeWorkspaceReferences(input.workspaceReferences, input.workspaceFiles)
    .filter((reference) => !attachmentNames.has(reference.ref.split("/").pop() ?? reference.ref));
  const attachmentParts = uploadedFileParts(input.files).map((part) => ({
    ...part,
    providerMetadata: {
      ...(part.providerMetadata ?? {}),
      optimistic: { status: "processing", statusLabel: input.statusLabel },
    },
  }));
  const parts: UIMessage["parts"] = [
    { type: "text", text: input.text },
    ...workspaceReferenceFileParts(workspaceReferences),
    ...resourceFileParts(input.resources, input.resourceIds),
    ...resourceFolderFileParts(input.folders, input.resourceFolderIds),
    ...attachmentParts,
  ];
  return {
    id: input.id,
    role: "user",
    parts,
    createdAt: input.createdAt,
    metadata: timestampMetadata(input.createdAt),
  } as UIMessage;
}

const ontologyAttachmentAdapter: AttachmentAdapter = {
  accept: ".pdf,.txt,.md,.csv,.json,.yaml,.yml,.png,.jpg,.jpeg,.gif,.webp,.zip,.msg,.xlsx,.xls,.docx",
  async add({ file }): Promise<PendingAttachment> {
    return {
      id: `${file.name}-${file.lastModified}-${file.size}`,
      type: file.type.startsWith("image/") ? "image" : "document",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  },
  async send(attachment): Promise<CompleteAttachment> {
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{ type: "text", text: `📎 ${attachment.name}` }],
    };
  },
  async remove() {
    // Files are uploaded to the ontology workspace only when the user sends.
  },
};

function attachmentsFromMessage(message: unknown): readonly CompleteAttachment[] {
  if (!message || typeof message !== "object") return [];
  const attachments = (message as { attachments?: unknown }).attachments;
  return Array.isArray(attachments) ? attachments as CompleteAttachment[] : [];
}

async function uploadMessageAttachments(ontologyId: string, attachments: readonly CompleteAttachment[]): Promise<string[]> {
  const uploadedPaths: string[] = [];
  assertUploadBatchWithinLimit(attachments.map((attachment) => attachment.file).filter((file): file is File => Boolean(file)));
  for (const attachment of attachments) {
    const file = attachment.file;
    if (!file) continue;
    const uploaded = await uploadOntologyFile(ontologyId, { name: file.name, file, contentType: file.type || undefined, targetDir: "raw" });
    uploadedPaths.push(...(uploaded.files?.map((item) => item.path) ?? [uploaded.path]));
  }
  return uploadedPaths;
}

function mentionedWorkspaceFiles(text: string): string[] {
  const files = new Set<string>();
  for (const match of text.matchAll(/(^|\s)@([^\s]+)/g)) {
    const ref = match[2]?.trim().replace(/^["']|["']$/g, "");
    if (!ref || ref.includes("://") || ref.includes("..")) continue;
    if (/\.[A-Za-z0-9]{1,8}$/.test(ref)) files.add(ref);
  }
  return Array.from(files);
}

function toolNameFromPart(part: UiPart): string {
  if (typeof part.toolName === "string") return part.toolName;
  return typeof part.type === "string" && part.type.startsWith("tool-") ? part.type.slice(5) : "tool";
}

// journeyStateToPhaseMessage disabled — stream-based journey updates replaced by polling
// function journeyStateToPhaseMessage(state: JourneyState): ChatMessage {
//   const phaseData: PhasePayload | undefined =
//     state.phase === "bootstrap" ? { type: "bootstrap", state: state.bootstrap } :
//     state.phase === "ingest" ? { type: "ingest", state: state.ingest } :
//     state.phase === "verify" ? { type: "verify", state: state.verify } :
//     state.phase === "review" && state.review ? { type: "review", state: state.review } :
//     undefined;
//
//   return {
//     id: `journey-${state.updatedAt}`,
//     role: "agent",
//     content: "Journey state updated",
//     phaseTransition: state.phase,
//     ...(phaseData ? { phaseData } : {}),
//   } as ChatMessage;
// }

function chatAuthHeaders(): Record<string, string> {
  const headers = new Headers(authHeaders());
  headers.delete("Content-Type");
  return Object.fromEntries(headers.entries());
}

function generateClientMessageId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRunning(status: ReturnType<typeof useChat>["status"]): boolean {
  return status === "streaming" || status === "submitted";
}

function messagesForSuggestions(messages: UIMessage[]) {
  return messages.slice(-12).map((message) => ({
    role: message.role === "user" ? "user" as const : "assistant" as const,
    content: textFromParts(message.parts as readonly unknown[]).slice(0, 1600),
    createdAt: uiMessageTimestamp(message)?.toISOString(),
  })).filter((message) => message.content.trim());
}

function convertUiMessage(message: UIMessage): ThreadMessageLike {
  type ThreadContentPart = NonNullable<ThreadMessageLike["content"]> extends readonly (infer Part)[] ? Part : never;
  const content: ThreadContentPart[] = [];
  const createdAt = uiMessageTimestamp(message);

  for (const part of message.parts as UiPart[]) {
    const record = part as UiPart;
    if (record.type === "text") {
      const text = typeof record.text === "string" ? record.text : "";
      if (text) content.push({ type: "text", text } as ThreadContentPart);
      continue;
    }
    if (record.type === "file") {
      content.push(record as ThreadContentPart);
      continue;
    }
    if (typeof record.type === "string" && (record.type === "dynamic-tool" || record.type.startsWith("tool-"))) {
      const input = record.input ?? record.rawInput ?? {};
      const output = record.output ?? record.errorText;
      content.push({
        type: "tool-call",
        toolCallId: String(record.toolCallId ?? `${message.id}-${record.type}`),
        toolName: toolNameFromPart(record),
        argsText: input !== undefined ? JSON.stringify(input, null, 2) : "",
        args: input && typeof input === "object" ? input as Record<string, unknown> : {},
        result: output,
        isError: Boolean(record.errorText),
      } as ThreadContentPart);
    }
  }

  return {
    role: message.role as "user" | "assistant" | "system",
    id: message.id,
    content: content.length ? content : "",
    ...(createdAt ? {
      createdAt,
      metadata: timestampMetadata(createdAt, (message as TimestampedUIMessage).metadata),
    } : {}),
  };
}

function messageHasFileParts(message: UIMessage): boolean {
  return message.parts.some((part) => part.type === "file");
}

function mergeOptimisticMessages(messages: UIMessage[], optimisticMessages: UIMessage[]): UIMessage[] {
  if (!optimisticMessages.length) return messages;
  const merged = [...messages];

  for (const optimistic of optimisticMessages) {
    if (optimistic.role !== "user") {
      merged.push(optimistic);
      continue;
    }

    const optimisticText = textFromParts(optimistic.parts as readonly unknown[]);
    const sameRichMessageIndex = [...merged].reverse().findIndex((message) =>
      message.role === "user" &&
      textFromParts(message.parts as readonly unknown[]) === optimisticText &&
      messageHasFileParts(message)
    );
    if (sameRichMessageIndex >= 0) continue;

    const replaceFromEndIndex = [...merged].reverse().findIndex((message) =>
      message.role === "user" &&
      textFromParts(message.parts as readonly unknown[]) === optimisticText &&
      !messageHasFileParts(message)
    );
    if (replaceFromEndIndex >= 0) {
      merged[merged.length - 1 - replaceFromEndIndex] = optimistic;
    } else {
      merged.push(optimistic);
    }
  }

  return merged;
}


function OntologyAssistantRuntime({
  ontologyId,
  sessionId,
  knowledgeOpen,
  readOnly = false,
  onBeforeSend,
  pendingInitialMessage,
  pendingInitialBackendMessage,
  pendingInitialSlashCommandId,
  pendingInitialFiles = [],
  pendingInitialWorkspaceFiles = [],
  pendingInitialWorkspaceReferences = [],
  pendingInitialResourceIds = [],
  pendingInitialResourceFolderIds = [],
  onPendingInitialMessageConsumed,
  resources,
  folders,
  locale = "zh",
  t,
  children,
}: {
  ontologyId: string;
  sessionId: string;
  knowledgeOpen: boolean;
  readOnly?: boolean;
  onPhaseUpdate?: (message: ChatMessage) => void;
  onBeforeSend?: (input: BeforeSendInput) => Promise<boolean>;
  pendingInitialMessage?: string | null;
  pendingInitialBackendMessage?: string | null;
  pendingInitialSlashCommandId?: SlashCommandId | null;
  pendingInitialFiles?: File[];
  pendingInitialWorkspaceFiles?: string[];
  pendingInitialWorkspaceReferences?: ComposerFileReference[];
  pendingInitialResourceIds?: string[];
  pendingInitialResourceFolderIds?: string[];
  onPendingInitialMessageConsumed?: () => void;
  resources: Resource[];
  folders: ResourceFolder[];
  locale?: Locale;
  t?: (key: string, params?: Record<string, string>) => string;
  children: (input: {
    followupSuggestions: readonly FollowupSuggestion[];
    onIssueCommand: (issue: IssueShortcut) => Promise<void>;
    onIssueReport: (report: IssueReportPayload) => Promise<void>;
    issueSupportContext: { ontologyId: string; sessionId: string };
    issueHelpDisabled: boolean;
  }) => React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const historyQuery = useOntologyMessages(ontologyId, sessionId);
  const chatStatusQuery = useOntologyChatStatus(ontologyId, sessionId, !readOnly);
  const suggestionRequestRef = useRef(0);
  const wasRunningRef = useRef(false);
  const chatRunningRef = useRef(false);
  const pendingInitialSendInFlightRef = useRef(false);
  const pendingInitialHistoryLockedRef = useRef(false);
  const cancelledRef = useRef(false);
  const lastSuggestedMessageRef = useRef<string | null>(null);
  const currentRunKeyRef = useRef<string | null>(null);
  const resumedRunKeyRef = useRef<string | null>(null);
  const resumeInFlightRunKeyRef = useRef<string | null>(null);
  const resumeAttemptRef = useRef(0);
  const runtimeScopeRef = useRef<string | null>(null);
  const resumeHistoryLockedRef = useRef(false);
  const activeRunHistoryHydratedRef = useRef(false);
  const activeRunHistoryBaselineRef = useRef(0);
  const lastRunSequenceRef = useRef(0);
  const dictationAdapter = useMemo(() => new ResilientWebSpeechDictationAdapter(), []);
  const reconnectFetch = useMemo(() => createReconnectFetchController(), []);
  const followupSuggestionScope = `${ontologyId}:${sessionId}`;
  const followupSuggestionsStore = useMemo(() => createFollowupSuggestionsStore(followupSuggestionScope), [followupSuggestionScope]);
  const followupSuggestions = useSyncExternalStore(followupSuggestionsStore.subscribe, followupSuggestionsStore.get, followupSuggestionsStore.get);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const pendingInitialOptimisticMessage = useMemo(() => {
    const text = pendingInitialMessage?.trim();
    if (!text) return null;
    return optimisticInitialUserMessage({
      id: `pending-initial-${sessionId}`,
      text,
      files: pendingInitialFiles,
      workspaceFiles: pendingInitialWorkspaceFiles,
      workspaceReferences: pendingInitialWorkspaceReferences,
      resourceIds: pendingInitialResourceIds,
      resourceFolderIds: pendingInitialResourceFolderIds,
      resources,
      folders,
      createdAt: new Date(),
      statusLabel: t?.("chat.attachmentParsing") ?? "Parsing...",
    });
  }, [folders, pendingInitialFiles, pendingInitialMessage, pendingInitialResourceFolderIds, pendingInitialResourceIds, pendingInitialWorkspaceFiles, pendingInitialWorkspaceReferences, resources, sessionId, t]);
  const [optimisticMessages, setOptimisticMessages] = useState<UIMessage[]>(() => pendingInitialOptimisticMessage ? [pendingInitialOptimisticMessage] : []);

  const clearFollowupSuggestions = useCallback(() => {
    suggestionRequestRef.current += 1;
    followupSuggestionsStore.clear();
  }, [followupSuggestionsStore]);

  const resetRunResumeState = useCallback(() => {
    resumeAttemptRef.current += 1;
    reconnectFetch.abort();
    currentRunKeyRef.current = null;
    resumedRunKeyRef.current = null;
    resumeInFlightRunKeyRef.current = null;
    resumeHistoryLockedRef.current = false;
    activeRunHistoryHydratedRef.current = false;
    activeRunHistoryBaselineRef.current = 0;
    lastRunSequenceRef.current = 0;
  }, [reconnectFetch]);

  const invalidateWorkspaceViewQueries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["ontologies"] });
    void queryClient.invalidateQueries({ queryKey: ["ontology-tree", ontologyId] });
    void queryClient.invalidateQueries({ queryKey: ["journey", ontologyId] });
    void queryClient.invalidateQueries({ queryKey: ["pending-reviews", ontologyId] });
    void queryClient.invalidateQueries({ queryKey: ["pending-review-draft", ontologyId] });
  }, [ontologyId, queryClient]);

  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({
    api: apiUrl(`/api/v1/ontologies/${ontologyId}/sessions/${sessionId}/chat`),
    headers: chatAuthHeaders,
    fetch: reconnectFetch.fetch,
    prepareReconnectToStreamRequest: ({ headers, body }) => {
      const query = new URLSearchParams({ format: "ai-sdk" });
      const runId = stringBodyField(body, "runId");
      const after = numberBodyField(body, "after");
      if (runId) query.set("runId", runId);
      if (after > 0) query.set("after", String(after));
      return {
        api: apiUrl(`/api/v1/ontologies/${ontologyId}/sessions/${sessionId}/chat/stream?${query.toString()}`),
        headers,
      };
    },
    body: () => ({
      sessionId,
      clientMessageId: generateClientMessageId(),
      panelState: { status: knowledgeOpen ? "open" : "closed" },
      disabledConnectors: Array.from(connectorStore.getDisabled()),
      stream: true,
      streamFormat: "ai-sdk",
      locale,
    }),
  }), [knowledgeOpen, locale, ontologyId, reconnectFetch, sessionId]);

  const chat = useChat<UIMessage>({
    id: `${ontologyId}:${sessionId}`,
    transport,
    resume: false,
    experimental_throttle: 25,
    onData: (part) => {
      const cursor = runCursorFromDataPart(part);
      if (cursor) {
        const runKey = `${ontologyId}:${sessionId}:${cursor.runId}`;
        if (currentRunKeyRef.current !== runKey) {
          currentRunKeyRef.current = runKey;
          lastRunSequenceRef.current = 0;
        }
        lastRunSequenceRef.current = Math.max(lastRunSequenceRef.current, cursor.sequence);
        return;
      }
      // data-journey-state disabled — rely on useJourneyState polling to avoid panel flickering
      if (part.type === "data-tree-updated") {
        invalidateWorkspaceViewQueries();
      }
      const retry = retryNoticeFromDataPart(part);
      if (retry) {
        showToast({
          type: "info",
          message: t?.("chat.upstreamRetrying", { attempt: String(retry.attempt), maxRetries: String(retry.maxRetries) })
            ?? `Model service unavailable, retrying (${retry.attempt}/${retry.maxRetries})...`,
          durationMs: Math.min(Math.max(retry.delayMs, 3000), 10000),
        });
      }
    },
    // The AI SDK reports a mid-stream `error` chunk through onError and then ends the stream
    // normally, so without this handler an upstream failure is silently discarded: the composer
    // returns to idle and the user is left staring at a turn that produced nothing.
    onError: (error) => {
      const detail = errorMessage(error);
      const message = t?.("chat.turnFailed", { error: detail }) ?? `This turn failed: ${detail}`;
      setRuntimeError(message);
      showToast({ type: "error", message, durationMs: 8000 });
      resumeInFlightRunKeyRef.current = null;
      resumeHistoryLockedRef.current = false;
      void queryClient.invalidateQueries({ queryKey: ["ontology-messages", ontologyId, sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["ontology-chat-status", ontologyId, sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["operation-runs"] });
    },
    onFinish: () => {
      if (currentRunKeyRef.current) resumedRunKeyRef.current = currentRunKeyRef.current;
      resumeInFlightRunKeyRef.current = null;
      resumeHistoryLockedRef.current = false;
      void queryClient.invalidateQueries({ queryKey: ["ontology-messages", ontologyId, sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["ontology-sessions", ontologyId] });
      invalidateWorkspaceViewQueries();
      void queryClient.invalidateQueries({ queryKey: ["ontology-chat-status", ontologyId, sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["operation-runs"] });
    },
  });
  const activeRunId = chatStatusQuery.data?.active && chatStatusQuery.data.runId ? chatStatusQuery.data.runId : null;

  useEffect(() => {
    const scope = `${ontologyId}:${sessionId}`;
    if (runtimeScopeRef.current === scope) return;
    runtimeScopeRef.current = scope;
    clearFollowupSuggestions();
    wasRunningRef.current = false;
    chatRunningRef.current = false;
    lastSuggestedMessageRef.current = null;
    currentRunKeyRef.current = null;
    resumedRunKeyRef.current = null;
    resumeInFlightRunKeyRef.current = null;
    resumeHistoryLockedRef.current = false;
    activeRunHistoryHydratedRef.current = false;
    activeRunHistoryBaselineRef.current = 0;
    lastRunSequenceRef.current = 0;
    setRuntimeError(null);
    setOptimisticMessages(pendingInitialOptimisticMessage ? [pendingInitialOptimisticMessage] : []);
  }, [clearFollowupSuggestions, ontologyId, pendingInitialOptimisticMessage, sessionId]);

  useEffect(() => () => {
    suggestionRequestRef.current += 1;
    followupSuggestionsStore.clear();
    resumeAttemptRef.current += 1;
    reconnectFetch.abort();
    resumeInFlightRunKeyRef.current = null;
    resumedRunKeyRef.current = null;
    resumeHistoryLockedRef.current = false;
  }, [followupSuggestionsStore, ontologyId, reconnectFetch, sessionId]);

  useEffect(() => {
    chatRunningRef.current = isRunning(chat.status);
  }, [chat.status]);

  useEffect(() => {
    if (!activeRunId && !isRunning(chat.status)) {
      resumeHistoryLockedRef.current = false;
      activeRunHistoryHydratedRef.current = false;
      activeRunHistoryBaselineRef.current = 0;
    }
  }, [activeRunId, chat.status]);

  useEffect(() => {
    if (!activeRunId) return;
    const runKey = `${ontologyId}:${sessionId}:${activeRunId}`;
    if (currentRunKeyRef.current !== runKey) {
      lastRunSequenceRef.current = 0;
      resumedRunKeyRef.current = null;
      resumeInFlightRunKeyRef.current = null;
      activeRunHistoryHydratedRef.current = false;
      activeRunHistoryBaselineRef.current = chat.messages.length > 0 ? historyQuery.dataUpdatedAt : 0;
    }
    currentRunKeyRef.current = runKey;
  }, [activeRunId, chat.messages.length, historyQuery.dataUpdatedAt, ontologyId, sessionId]);

  useEffect(() => {
    const running = isRunning(chat.status);
    if (running) {
      wasRunningRef.current = true;
      return;
    }
    if (!wasRunningRef.current || chat.status === "error") return;
    wasRunningRef.current = false;

    const lastAssistant = [...chat.messages].reverse().find((message) => message.role === "assistant");
    if (!lastAssistant) return;

    const assistantText = textFromParts(lastAssistant.parts as readonly unknown[]);
    const suggestionKey = `${ontologyId}:${sessionId}:${lastAssistant.id}:${assistantText.slice(-160)}`;
    if (lastSuggestedMessageRef.current === suggestionKey) return;
    lastSuggestedMessageRef.current = suggestionKey;

    const requestId = suggestionRequestRef.current + 1;
    suggestionRequestRef.current = requestId;
    void suggestFollowups({
      ontologyId,
      sessionId,
      clientMessages: messagesForSuggestions(chat.messages),
    }).then((suggestions) => {
      if (suggestionRequestRef.current === requestId) followupSuggestionsStore.set(suggestions);
    }).catch(() => {
      if (suggestionRequestRef.current === requestId) followupSuggestionsStore.clear();
    });
  }, [chat.messages, chat.status, followupSuggestionsStore, ontologyId, sessionId]);

  useEffect(() => {
    if (historyQuery.isFetching || resumeHistoryLockedRef.current || chatRunningRef.current || isRunning(chat.status) || pendingInitialSendInFlightRef.current || pendingInitialHistoryLockedRef.current) return;
    if (activeRunId && activeRunHistoryHydratedRef.current) return;
    if (activeRunId && chat.messages.length > 0 && historyQuery.dataUpdatedAt <= activeRunHistoryBaselineRef.current) return;
    if (historyQuery.data) {
      chat.setMessages(toUiMessages(historyQuery.data));
      activeRunHistoryHydratedRef.current = Boolean(activeRunId);
      setOptimisticMessages([]);
    }
    // chat is the stable AI SDK helper object for this runtime instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, chat.messages.length, chat.status, historyQuery.data, historyQuery.dataUpdatedAt, historyQuery.isFetching]);

  useEffect(() => {
    if (!activeRunId || historyQuery.isLoading || historyQuery.isFetching || chatStatusQuery.isLoading || chatStatusQuery.isFetching) return;
    if (pendingInitialSendInFlightRef.current || pendingInitialHistoryLockedRef.current || isRunning(chat.status)) return;
    if (!activeRunHistoryHydratedRef.current && chat.messages.length > 0) return;
    const runKey = `${ontologyId}:${sessionId}:${activeRunId}`;
    if (resumedRunKeyRef.current === runKey || resumeInFlightRunKeyRef.current === runKey) return;

    let started = false;
    const timer = window.setTimeout(() => {
      started = true;
      if (chatRunningRef.current || resumedRunKeyRef.current === runKey || resumeInFlightRunKeyRef.current === runKey) return;
      const attempt = resumeAttemptRef.current + 1;
      resumeAttemptRef.current = attempt;
      resumeInFlightRunKeyRef.current = runKey;
      resumeHistoryLockedRef.current = true;
      void (async () => {
        try {
          await chat.resumeStream({ body: { runId: activeRunId, after: lastRunSequenceRef.current, locale } });
        } catch (error) {
          if (resumeAttemptRef.current !== attempt) return;
          const message = errorMessage(error);
          setRuntimeError(message);
          showToast({ type: "error", message, durationMs: 5000 });
        } finally {
          if (resumeAttemptRef.current === attempt) {
            resumedRunKeyRef.current = runKey;
            if (resumeInFlightRunKeyRef.current === runKey) resumeInFlightRunKeyRef.current = null;
          }
        }
      })();
    }, 0);

    return () => {
      if (!started) window.clearTimeout(timer);
    };
    // chat is scoped to ontologyId/sessionId; active run resume must run once per run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, chat.status, chatStatusQuery.isFetching, chatStatusQuery.isLoading, historyQuery.isFetching, historyQuery.isLoading, locale, ontologyId, sessionId]);

  const sentPendingMessageRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingInitialMessage?.trim()) sentPendingMessageRef.current = null;
  }, [pendingInitialMessage]);

  useEffect(() => {
    const text = pendingInitialMessage?.trim();
    const key = text ? `${ontologyId}:${sessionId}:${text}` : null;
    if (!text || !key || sentPendingMessageRef.current === key) return;
    if (historyQuery.isLoading || chatStatusQuery.isLoading) return;

    const hasPersistedUserMessage = historyQuery.data?.some((message) => message.role === "user") ?? false;
    if (chatStatusQuery.data?.active || hasPersistedUserMessage) {
      sentPendingMessageRef.current = key;
      onPendingInitialMessageConsumed?.();
      return;
    }

    sentPendingMessageRef.current = key;
    pendingInitialSendInFlightRef.current = true;
    pendingInitialHistoryLockedRef.current = true;
    onPendingInitialMessageConsumed?.();
    clearFollowupSuggestions();
    resetRunResumeState();
    const explicitBackendText = pendingInitialBackendMessage?.trim() || undefined;
    const promptMode = composerPromptModeStore.get();
    const slashCommandId = explicitBackendText ? undefined : pendingInitialSlashCommandId ?? promptMode.commandId ?? undefined;
    const pendingWorkspaceFiles = uniqueStrings([...pendingInitialWorkspaceFiles, ...mentionedWorkspaceFiles(text)]);
    const pendingWorkspaceReferences = mergeWorkspaceReferences(pendingInitialWorkspaceReferences, pendingWorkspaceFiles);
    const pendingReferenceParts = [
      ...workspaceReferenceFileParts(pendingWorkspaceReferences),
      ...resourceFileParts(resources, pendingInitialResourceIds),
      ...resourceFolderFileParts(folders, pendingInitialResourceFolderIds),
    ];
    void (async () => {
      try {
        await chat.sendMessage({ text, files: [...pendingReferenceParts, ...uploadedFileParts(pendingInitialFiles)] }, {
          body: {
            workspaceFiles: pendingWorkspaceFiles,
            workspaceReferences: pendingWorkspaceFiles,
            resourceIds: pendingInitialResourceIds,
            resourceFolderIds: pendingInitialResourceFolderIds,
            backendMessage: explicitBackendText,
            slashCommandId,
            locale,
          },
        });
        const refreshedHistory = await historyQuery.refetch();
        if (refreshedHistory.data) chat.setMessages(toUiMessages(refreshedHistory.data));
      } catch (error) {
        const message = errorMessage(error);
        setRuntimeError(message);
        showToast({ type: "error", message, durationMs: 5000 });
      } finally {
        pendingInitialSendInFlightRef.current = false;
        pendingInitialHistoryLockedRef.current = false;
      }
    })();
    // chat is scoped to ontologyId/sessionId; pending sends must run once per remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatStatusQuery.data?.active, chatStatusQuery.isLoading, historyQuery.data, historyQuery.isLoading, locale, ontologyId, onPendingInitialMessageConsumed, pendingInitialBackendMessage, pendingInitialFiles, pendingInitialMessage, pendingInitialResourceFolderIds, pendingInitialResourceIds, pendingInitialSlashCommandId, pendingInitialWorkspaceFiles, pendingInitialWorkspaceReferences, sessionId]);

  const displayMessages = useMemo(() => mergeOptimisticMessages(chat.messages, optimisticMessages), [chat.messages, optimisticMessages]);
  const displayMessagesWithTimeDividers = useMemo(() => withTimestampDividerMessages(displayMessages), [displayMessages]);

  const threadMessages = useExternalMessageConverter({
    callback: convertUiMessage,
    messages: displayMessagesWithTimeDividers,
    isRunning: isRunning(chat.status) || optimisticMessages.length > 0,
    metadata: chat.error || runtimeError ? { error: chat.error ? errorMessage(chat.error) : runtimeError || "Network error" } : undefined,
  });

  const runtime = useExternalStoreRuntime({
    isRunning: isRunning(chat.status) || optimisticMessages.length > 0,
    isLoading: historyQuery.isLoading,
    messages: threadMessages,
    onNew: async (message) => {
      clearFollowupSuggestions();
      setRuntimeError(null);
      cancelledRef.current = false;
      try {
        const text = textFromParts(message.content).trim();
        const visibleText = stripResourceTokens(text);
        if (!visibleText) return;
        const selectedReferences = composerFileReferencesStore.get();
        const selectedWorkspaceFiles = workspaceFilesFromReferences(selectedReferences);
        const referencedWorkspaceFiles = uniqueStrings([...selectedWorkspaceFiles, ...mentionedWorkspaceFiles(visibleText)]);
        const referencedWorkspaceReferences = mergeWorkspaceReferences(selectedReferences, referencedWorkspaceFiles);
        const resourceIds = uniqueStrings([...resourceIdsFromText(text), ...resourceIdsFromReferences(selectedReferences)]);
        const resourceFolderIds = uniqueStrings([...resourceFolderIdsFromText(text), ...resourceFolderIdsFromReferences(selectedReferences)]);
        const attachments = attachmentsFromMessage(message);
        const referenceParts = [
          ...workspaceReferenceFileParts(referencedWorkspaceReferences),
          ...resourceFileParts(resources, resourceIds, selectedReferences),
          ...resourceFolderFileParts(folders, resourceFolderIds, selectedReferences),
        ];
        const optimisticId = `optimistic-${generateClientMessageId()}`;
        if (visibleText || attachments.length || referenceParts.length) {
          setOptimisticMessages((prev) => [...prev, optimisticUserMessage({
            id: optimisticId,
            text: visibleText,
            attachments,
            referenceParts,
            statusLabel: t?.("resource.uploadProcessing") ?? t?.("chat.attachmentParsing") ?? "Uploading and processing...",
          })]);
        }
        const uploadedPaths = await uploadMessageAttachments(ontologyId, attachments);
        if (attachments.length) {
          void queryClient.invalidateQueries({ queryKey: ["resource-library"] });
        }
        const slashCommandId = composerPromptModeStore.get().commandId ?? undefined;
        if (!visibleText) {
          setOptimisticMessages((prev) => prev.filter((item) => item.id !== optimisticId));
          return;
        }
        composerFileReferencesStore.clear();
        composerPromptModeStore.clear();
        if (await onBeforeSend?.({ message: visibleText, slashCommandId, resourceIds, resourceFolderIds, workspaceFiles: uniqueStrings([...uploadedPaths, ...referencedWorkspaceFiles]), workspaceReferences: referencedWorkspaceReferences })) {
          setOptimisticMessages((prev) => prev.filter((item) => item.id !== optimisticId));
          return;
        }
        resetRunResumeState();
        const sendPromise = chat.sendMessage({ text: visibleText, files: [...referenceParts, ...uploadedAttachmentFileParts(attachments)] }, {
          body: {
            workspaceFiles: uniqueStrings([...uploadedPaths, ...referencedWorkspaceFiles]),
            workspaceReferences: referencedWorkspaceFiles,
            resourceIds,
            resourceFolderIds,
            slashCommandId,
            locale,
          },
        });
        await sendPromise;
        const refreshedHistory = await historyQuery.refetch();
        if (refreshedHistory.data) chat.setMessages(toUiMessages(refreshedHistory.data));
        setOptimisticMessages((prev) => prev.filter((item) => item.id !== optimisticId));
      } catch (error) {
        if (cancelledRef.current) {
          setOptimisticMessages([]);
          setRuntimeError(null);
          return;
        }
        setOptimisticMessages([]);
        const message = errorMessage(error);
        setRuntimeError(message);
        showToast({ type: "error", message: t?.("journey.uploadFailed", { error: message }) ?? `Upload failed: ${message}`, durationMs: 5000 });
      }
    },
    onEdit: async (message) => {
      clearFollowupSuggestions();
      const text = textFromParts(message.content).trim();
      const rawMessage = message as unknown as { id?: unknown };
      const messageId = typeof rawMessage.id === "string" ? rawMessage.id : undefined;
      if (text) {
        resetRunResumeState();
        await chat.sendMessage({ text, ...(messageId ? { messageId } : {}) }, { body: { locale } });
      }
    },
    onCancel: async () => {
      cancelledRef.current = true;
      setRuntimeError(null);
      setOptimisticMessages([]);
      clearFollowupSuggestions();
      pendingInitialSendInFlightRef.current = false;
      pendingInitialHistoryLockedRef.current = false;
      resetRunResumeState();
      void Promise.resolve(chat.stop()).catch(() => undefined);
      void queryClient.cancelQueries({ queryKey: ["ontology-chat-status", ontologyId, sessionId] });
      queryClient.setQueryData<OntologyChatStatus>(["ontology-chat-status", ontologyId, sessionId], (status) => status
        ? { ...status, active: false, completed: true, local: false }
        : status);
      void cancelOntologyChat(ontologyId, sessionId)
        .catch(() => undefined)
        .finally(() => {
          void queryClient.invalidateQueries({ queryKey: ["ontology-chat-status", ontologyId, sessionId] });
          void queryClient.invalidateQueries({ queryKey: ["ontology-messages", ontologyId, sessionId] });
        });
    },
    adapters: {
      dictation: dictationAdapter,
      attachments: ontologyAttachmentAdapter,
    },
    unstable_capabilities: { copy: true },
  });

  const sendIssueCommand = useCallback(async (issue: IssueShortcut) => {
    if (isRunning(chat.status)) return;
    clearFollowupSuggestions();
    setRuntimeError(null);
    resetRunResumeState();
    await chat.sendMessage({ text: issue.command }, { body: { backendMessage: issue.command } });
    const refreshedHistory = await historyQuery.refetch();
    if (refreshedHistory.data) chat.setMessages(toUiMessages(refreshedHistory.data));
  }, [chat, clearFollowupSuggestions, historyQuery, resetRunResumeState]);

  const issueSupportContext = useMemo(() => ({
    ontologyId,
    sessionId,
  }), [ontologyId, sessionId]);

  const submitIssueReport = useCallback(async (report: IssueReportPayload) => {
    await submitTechnicalIssueReport(report);
  }, []);

  return <AssistantRuntimeProvider runtime={runtime}>{children({ followupSuggestions, onIssueCommand: sendIssueCommand, onIssueReport: submitIssueReport, issueSupportContext, issueHelpDisabled: isRunning(chat.status) })}</AssistantRuntimeProvider>;
}

function focusComposer() {
  window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".aui-composer-input")?.focus(), 0);
}

function KnowledgeConversations({ project, sessions, onSelectSession, onRenameSession, onDeleteSession, onSelectOperationRun, t }: { project: Project; sessions: OntologySession[]; onSelectSession?: (sessionId: string) => void; onRenameSession?: (sessionId: string, newName: string) => void; onDeleteSession?: (sessionId: string) => void; onSelectOperationRun?: (run: OperationRun) => void; t?: (key: string, params?: Record<string, string>) => string }) {
  const [recordType, setRecordType] = useState<"conversations" | "operations">("conversations");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const projectSessions = useMemo(() => sessions
    .filter((session) =>
      (session.ontologyId ?? session.projectId) === project.id &&
      session.origin !== "external",
    ), [project.id, sessions]);
  const query = search.trim().toLowerCase();
  const filtered = query
    ? projectSessions.filter((session) => session.preview.toLowerCase().includes(query))
    : projectSessions;
  const operationRunsQuery = useOperationRuns({
    ontologyId: project.id,
    search: recordType === "operations" ? search : undefined,
    enabled: recordType === "operations" && !project.id.startsWith("proj-"),
  });
  const updateOperationRun = useUpdateOperationRun();
  const deleteOperationRun = useDeleteOperationRun();
  const operationRuns = operationRunsQuery.data ?? [];
  const translate = t ?? ((key: string) => key);

  return (
    <div className="chat-hub aui-knowledge-conversations">
      <div className={`chat-hub-header${searchOpen ? " search-open" : ""}`}>
        {searchOpen ? (
          <div className="search-expansion-layer chat-hub-search-layer aui-knowledge-conversations-search">
            <div className="search-expansion-field chat-hub-search-field">
              <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              <input
                autoFocus
                type="text"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder={recordType === "operations" ? translate("operations.search") : (t?.("common.search") ?? "Search")}
              />
            </div>
            <button
              type="button"
              className="search-expansion-cancel chat-hub-search-cancel"
              onClick={() => {
                setSearch("");
                setSearchOpen(false);
              }}
              aria-label="Close search"
            >
              {t?.("common.cancel") ?? "Cancel"}
            </button>
          </div>
        ) : (
          <>
            <div className="chat-hub-record-tabs" role="tablist" aria-label={translate("operations.knowledgeTabs")}>
              <button type="button" role="tab" aria-selected={recordType === "conversations"} className={recordType === "conversations" ? "active" : ""} onClick={() => setRecordType("conversations")}>
                {translate("chat.conversations")}
              </button>
              <button type="button" role="tab" aria-selected={recordType === "operations"} className={recordType === "operations" ? "active" : ""} onClick={() => { setSearch(""); setSearchOpen(false); setRecordType("operations"); }}>
                {translate("operations.title")}
              </button>
            </div>
            <button
              type="button"
              className="chat-hub-search-btn"
              onClick={() => setSearchOpen(true)}
              aria-label={recordType === "operations" ? translate("operations.search") : "Search conversations"}
            >
              <svg viewBox="0 0 24 24" width="17" height="17"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
          </>
        )}
      </div>
      <div className="chat-hub-list-container">
        {recordType === "operations" ? (
          <>
            <OperationRunList
              runs={operationRuns}
              projects={[project]}
              loading={operationRunsQuery.isLoading}
              error={project.id.startsWith("proj-") || (operationRunsQuery.isError && !operationRuns.length)}
              compact
              emptyTitle={query ? translate("operations.noSearchResults") : undefined}
              emptyBody={query ? translate("operations.tryAnotherSearch") : undefined}
              onSelectRun={(run) => onSelectOperationRun?.(run)}
              onRenameRun={(run, title) => {
                void updateOperationRun.mutateAsync({ ontologyId: run.ontologyId, operationId: run.id, title }).catch(() => undefined);
              }}
              onDeleteRun={(run) => {
                void deleteOperationRun.mutateAsync({ ontologyId: run.ontologyId, operationId: run.id }).catch(() => undefined);
              }}
              t={translate}
            />
            <OperationRunPagination
              hasItems={operationRuns.length > 0}
              hasNextPage={operationRunsQuery.hasNextPage}
              loadFailed={operationRunsQuery.isFetchNextPageError}
              loading={operationRunsQuery.isFetchingNextPage}
              onLoadMore={() => void operationRunsQuery.fetchNextPage()}
              t={translate}
            />
          </>
        ) : filtered.length === 0 ? (
          <div className="chat-hub-empty">
            <p>{projectSessions.length === 0 ? (t?.("chat.noConversations") ?? "No conversations yet.") : (t?.("chat.noMatchingConversations") ?? "No matching conversations.")}</p>
          </div>
        ) : (
          <div className="chat-hub-list">
            {filtered.map((session) => (
              <div
                key={session.id}
                className="chat-hub-item aui-knowledge-conversation-item"
                onClick={() => {
                  if (editingSessionId !== session.id) {
                    composerFileReferencesStore.clear();
                    composerPromptModeStore.clear();
                    onSelectSession?.(session.id);
                  }
                }}
              >
                <div className="chat-hub-item-icon">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
                {editingSessionId === session.id ? (
                  <input
                    className="chat-hub-item-title"
                    style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "2px 6px", outline: "none" }}
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.currentTarget.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => {
                      const next = renameDraft.trim();
                      if (next && next !== session.preview) onRenameSession?.(session.id, next);
                      setEditingSessionId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                      if (e.key === "Escape") { setEditingSessionId(null); }
                    }}
                    autoFocus
                  />
                ) : (
                  <span className="chat-hub-item-title">{session.preview}</span>
                )}
                <span className="chat-hub-item-time">{session.timeAgo}</span>
                {editingSessionId !== session.id && (
                  <div className="chat-hub-item-actions">
                    <button
                      type="button"
                      className="chat-hub-item-more"
                      onClick={(e) => { e.stopPropagation(); setMenuSessionId(menuSessionId === session.id ? null : session.id); }}
                      aria-label="More options"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                        <circle cx="5" cy="12" r="1.5"/>
                        <circle cx="12" cy="12" r="1.5"/>
                        <circle cx="19" cy="12" r="1.5"/>
                      </svg>
                    </button>
                  </div>
                )}
                {menuSessionId === session.id && (
                  <>
                    <div className="chat-hub-menu-backdrop" onClick={(e) => { e.stopPropagation(); setMenuSessionId(null); }} />
                    <div className="chat-hub-menu">
                      <button type="button" className="chat-hub-menu-item" onClick={(e) => {
                        e.stopPropagation();
                        setMenuSessionId(null);
                        void publishAndCopyConversationLink(project.id, session.id)
                          .then(() => showToast({ type: "success", message: t?.("session.shareSuccess") ?? "Public conversation link copied" }))
                          .catch((reason) => showToast({ type: "error", message: errorMessage(reason) }));
                      }}>
                        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 12v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8M16 6l-4-4-4 4M12 2v13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        <span>{t?.("session.share") ?? "Share conversation"}</span>
                      </button>
                      <button type="button" className="chat-hub-menu-item" onClick={(e) => {
                        e.stopPropagation();
                        setMenuSessionId(null);
                        setRenameDraft(session.preview);
                        setEditingSessionId(session.id);
                      }}>
                        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        <span>{t?.("common.rename") ?? "Rename"}</span>
                      </button>
                      <div className="chat-hub-menu-divider" />
                      <button type="button" className="chat-hub-menu-item chat-hub-menu-item-danger" onClick={(e) => {
                        e.stopPropagation();
                        setMenuSessionId(null);
                        onDeleteSession?.(session.id);
                      }}>
                        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 6h18M8 6V4h8v2M5 6v14a2 2 0 002 2h10a2 2 0 002-2V6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        <span>{t?.("common.delete") ?? "Delete"}</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="chat-hub-suggestions aui-knowledge-conversations-actions">
        <button
          type="button"
          className="chat-suggestion"
          onClick={() => {
            composerPromptModeStore.enableQuery();
            focusComposer();
          }}
        >
          {t?.("chat.askQuestion") ?? "向知识提问"}
        </button>
        <button
          type="button"
          className="chat-suggestion"
          onClick={() => {
            composerPromptModeStore.enableOperation();
            focusComposer();
          }}
        >
          {translate("chat.executeTask")}
        </button>
        <button
          type="button"
          className="chat-suggestion"
          onClick={() => {
            composerPromptModeStore.clear();
            window.dispatchEvent(new CustomEvent("composer:open-add-menu"));
            focusComposer();
          }}
        >
          {t?.("chat.ingestDocument") ?? "导入新文档到知识"}
        </button>
      </div>
    </div>
  );
}

function PendingOntologyRuntime({
  projects,
  currentProject,
  sessions,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onSelectOperationRun,
  selectedIntent,
  selectedProject,
  onCreateDraft,
  onSelectDraftProject,
  onSendWithoutSession,
  resources,
  folders,
  onUploadResources,
  onUploadResourceFolder,
  t,
}: {
  projects: Project[];
  currentProject: Project | null;
  sessions: OntologySession[];
  onSelectSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onSelectOperationRun?: (run: OperationRun) => void;
  selectedIntent: "create" | "select";
  selectedProject: Project | null;
  onCreateDraft: () => void;
  onSelectDraftProject: (project: Project) => void;
  onSendWithoutSession: OntologyStewardChatPanelProps["onSendWithoutSession"];
  resources: Resource[];
  folders: ResourceFolder[];
  onUploadResources?: (files: File[]) => Promise<Resource[]>;
  onUploadResourceFolder?: (files: File[]) => Promise<ResourceFolder[]>;
  t?: (key: string, params?: Record<string, string>) => string;
}) {
  const [isPreparing, setIsPreparing] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<UIMessage[]>([]);
  const conversationsPanel = selectedIntent === "select" && selectedProject ? (
    <KnowledgeConversations
      project={selectedProject}
      sessions={sessions}
      onSelectSession={onSelectSession}
      onRenameSession={onRenameSession}
      onDeleteSession={onDeleteSession}
      onSelectOperationRun={onSelectOperationRun}
      t={t}
    />
  ) : null;
  const pendingMessages = useExternalMessageConverter({
    callback: convertUiMessage,
    messages: optimisticMessages,
    isRunning: isPreparing || optimisticMessages.length > 0,
  });
  const runtime = useExternalStoreRuntime({
    isRunning: isPreparing || optimisticMessages.length > 0,
    isLoading: false,
    messages: pendingMessages,
    onNew: async (message: ThreadMessageLike) => {
      const attachments = attachmentsFromMessage(message);
      const files = attachments.map((attachment) => attachment.file).filter((file): file is File => Boolean(file));
      const rawText = textFromParts(Array.isArray(message.content) ? message.content : []).trim();
      const references = composerFileReferencesStore.get();
      const resourceIds = uniqueStrings([...resourceIdsFromText(rawText), ...resourceIdsFromReferences(references)]);
      const resourceFolderIds = uniqueStrings([...resourceFolderIdsFromText(rawText), ...resourceFolderIdsFromReferences(references)]);
      const text = stripResourceTokens(rawText);
      const workspaceFiles = uniqueStrings([...workspaceFilesFromReferences(references), ...mentionedWorkspaceFiles(text)]);
      const workspaceReferences = mergeWorkspaceReferences(references, workspaceFiles);
      if (!text || isPreparing) return;
      setIsPreparing(true);
      const referenceParts = [
        ...workspaceReferenceFileParts(workspaceReferences),
        ...resourceFileParts(resources, resourceIds, references),
        ...resourceFolderFileParts(folders, resourceFolderIds, references),
      ];
      const optimisticId = `optimistic-${generateClientMessageId()}`;
      if (text || attachments.length || referenceParts.length) {
        setOptimisticMessages((prev) => [...prev, optimisticUserMessage({
          id: optimisticId,
          text,
          attachments,
          referenceParts,
          statusLabel: t?.("resource.uploadProcessing") ?? "Uploading and processing...",
        })]);
      }
      try {
        const slashCommandId = composerPromptModeStore.get().commandId ?? undefined;
        composerFileReferencesStore.clear();
        composerPromptModeStore.clear();
        await onSendWithoutSession({
          message: text,
          slashCommandId,
          intent: selectedIntent,
          project: selectedIntent === "select" ? selectedProject ?? currentProject : null,
          files,
          resourceIds,
          resourceFolderIds,
          workspaceFiles,
          workspaceReferences,
        });
      } catch (error) {
        const message = errorMessage(error);
        showToast({ type: "error", message: t?.("journey.uploadFailed", { error: message }) ?? `Upload failed: ${message}`, durationMs: 5000 });
      } finally {
        setOptimisticMessages((prev) => prev.filter((item) => item.id !== optimisticId));
        setIsPreparing(false);
      }
    },
    adapters: {
      attachments: ontologyAttachmentAdapter,
    },
    unstable_capabilities: { copy: true },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        fillPanel
        projects={projects}
        currentProjectId={selectedProject?.id ?? currentProject?.id ?? null}
        selectedIntent={selectedIntent}
        emptyState={conversationsPanel ?? undefined}
        showWelcome={!conversationsPanel}
        onCreateOntology={onCreateDraft}
        onSelectProject={onSelectDraftProject}
        enableConnectors
        resources={resources}
        folders={folders}
        onUploadResources={onUploadResources}
        onUploadResourceFolder={onUploadResourceFolder}
        t={t}
      />
    </AssistantRuntimeProvider>
  );
}

function PendingConversationRuntime({
  pending,
  projects,
  resources,
  folders,
  onRetry,
  t,
}: {
  pending: PendingConversation;
  projects: Project[];
  resources: Resource[];
  folders: ResourceFolder[];
  onRetry?: () => void;
  t?: (key: string, params?: Record<string, string>) => string;
}) {
  const statusLabel = pending.status === "uploading"
    ? t?.("chat.preparingAttachments") ?? "Uploading and preparing attachments..."
    : pending.kind === "knowledge"
      ? t?.("chat.preparingKnowledge") ?? "Preparing the knowledge base..."
      : t?.("chat.preparingConversation") ?? "Preparing the conversation...";
  const message = useMemo(() => optimisticInitialUserMessage({
    id: `pending-${pending.id}`,
    text: pending.message,
    files: pending.files,
    workspaceFiles: pending.workspaceFiles,
    workspaceReferences: pending.workspaceReferences,
    resourceIds: pending.resourceIds,
    resourceFolderIds: pending.resourceFolderIds,
    resources,
    folders,
    createdAt: new Date(pending.startedAt),
    statusLabel,
  }), [folders, pending, resources, statusLabel]);
  const convertedMessages = useExternalMessageConverter({
    callback: convertUiMessage,
    messages: [message],
    isRunning: false,
  });
  const runtime = useExternalStoreRuntime({
    isRunning: false,
    isLoading: false,
    messages: convertedMessages,
    onNew: async () => undefined,
    unstable_capabilities: { copy: true },
  });
  const statusState = pending.status === "failed" ? (
    <div className="steward-chat-error flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-start" role="alert">
      <div className="flex min-w-0 flex-col gap-1">
        <strong className="text-foreground">{t?.("chat.preparationFailed") ?? "Unable to create the conversation"}</strong>
        <span className="break-words text-muted-foreground">{pending.error || t?.("chat.preparationFailedHint") || "Your message is still here. Try again to continue."}</span>
      </div>
      <button className="steward-primary-btn shrink-0" type="button" onClick={onRetry} disabled={!onRetry}>
        {t?.("common.retry") ?? "Retry"}
      </button>
    </div>
  ) : (
    <div className="mx-auto flex w-full max-w-(--thread-max-width) items-center gap-2.5 px-2 py-3" role="status" aria-live="polite">
      <span className="aui-typing-indicator" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="text-xs font-medium text-muted-foreground">{statusLabel}</span>
    </div>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        fillPanel
        showWelcome={false}
        composerDisabled
        statusSlot={statusState}
        projects={projects}
        currentProjectId={pending.project.id}
        selectedIntent="select"
        resources={resources}
        folders={folders}
        t={t}
      />
    </AssistantRuntimeProvider>
  );
}

function StewardChatHeader({
  project,
}: {
  project: Project;
}) {
  return (
    <header className="chat-header steward-chat-header">
      <div className="chat-header-info">
        <div className="chat-project-name">
          <span>{project.emoji}</span>
          <span>{project.name}</span>
        </div>
      </div>
    </header>
  );
}

export default function OntologyStewardChatPanel({
  project,
  projects,
  currentSessionId,
  onNewOntology,
  onSendWithoutSession,
  sessions = [],
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onSelectOperationRun,
  onSelectProject,
  pendingInitialMessage,
  pendingInitialBackendMessage,
  pendingInitialSlashCommandId,
  pendingInitialFiles = [],
  pendingInitialWorkspaceFiles = [],
  pendingInitialWorkspaceReferences = [],
  pendingInitialResourceIds = [],
  pendingInitialResourceFolderIds = [],
  pendingConversation,
  onRetryPendingConversation,
  onPendingInitialMessageConsumed,
  knowledgeOpen,
  backendUnavailable = false,
  onPhaseUpdate,
  resources = [],
  folders = [],
  onUploadResources,
  onUploadResourceFolder,
  locale = "zh",
  t,
}: OntologyStewardChatPanelProps) {
  const ontologyId = project?.id ?? "";
  const sessionId = currentSessionId ?? "";
  const isDeletedKnowledge = Boolean(project?.deletedAt);  const [selectedIntent, setSelectedIntent] = useState<"create" | "select">("select");
  const [selectedProject, setSelectedProject] = useState<Project | null>(project);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const previewQuery = useOntologyFile(ontologyId || undefined, previewPath);
  const previewTreeQuery = useOntologyTree(ontologyId || undefined);
  const previewKnownPaths = useMemo(() => flattenOntologyFilePaths(previewTreeQuery.data), [previewTreeQuery.data]);

  const prevProjectIdRef = useRef<string | null | undefined>(project?.id);
  useEffect(() => {
    const prev = prevProjectIdRef.current;
    prevProjectIdRef.current = project?.id;
    // Only clear composer state when switching between projects, not on initial selection
    if (prev != null && prev !== project?.id) {
      composerFileReferencesStore.clear();
      composerPromptModeStore.clear();
      setSelectedIntent("select");
      setPreviewPath(null);
    }
  }, [project?.id]);

  useEffect(() => {
    setSelectedProject(project);
  }, [project]);

  useEffect(() => {
    const handlePreview = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: unknown }>).detail;
      const path = typeof detail?.path === "string" ? detail.path.trim() : "";
      if (!path) return;
      if (!project) {
        showToast({ type: "error", message: t?.("filePreview.noProject") ?? "Select a knowledge base before previewing files.", durationMs: 3000 });
        return;
      }
      setPreviewPath(path);
    };
    window.addEventListener("ontology:preview-workspace-file", handlePreview);
    return () => window.removeEventListener("ontology:preview-workspace-file", handlePreview);
  }, [project, t]);

  const handleSelectDraftProject = useCallback((nextProject: Project) => {
    setSelectedIntent("select");
    setSelectedProject(nextProject);
    onSelectProject?.(nextProject);
  }, [onSelectProject]);

  const handleBeforeSend = useCallback(async (input: BeforeSendInput) => {
    const shouldCreate = selectedIntent === "create";
    const shouldSwitchProject = selectedIntent === "select" && selectedProject && selectedProject.id !== project?.id;
    if (!shouldCreate && !shouldSwitchProject) return false;
    await onSendWithoutSession({
      message: input.message,
      backendMessage: input.backendMessage ?? input.message,
      slashCommandId: input.slashCommandId,
      intent: selectedIntent,
      project: selectedIntent === "select" ? selectedProject : null,
      resourceIds: input.resourceIds,
      resourceFolderIds: input.resourceFolderIds,
      workspaceFiles: input.workspaceFiles,
      workspaceReferences: input.workspaceReferences,
    });
    return true;
  }, [onSendWithoutSession, project?.id, selectedIntent, selectedProject]);

  if (backendUnavailable) {
    return (
      <section className="chat-panel steward-chat-panel">
        <div className="steward-empty-state">
          <Database className="size-8" />
          <h2>Backend unavailable</h2>
          <p>Start `pnpm dev:server` on port 8787, then refresh the studio.</p>
        </div>
      </section>
    );
  }

  if ((!project || !sessionId) && pendingConversation) {
    return (
      <section className="chat-panel steward-chat-panel" aria-busy={pendingConversation.status !== "failed"}>
        <StewardChatHeader
          project={pendingConversation.project}
        />
        <div className="steward-thread-host">
          <PendingConversationRuntime
            pending={pendingConversation}
            projects={projects}
            resources={resources}
            folders={folders}
            onRetry={onRetryPendingConversation}
            t={t}
          />
        </div>
      </section>
    );
  }

  if (!project || !sessionId) {
    const headerProject = selectedIntent === "select" && selectedProject ? selectedProject : project;
    return (
      <section className="chat-panel steward-chat-panel">
        {headerProject ? (
          <StewardChatHeader
            project={headerProject}
          />
        ) : null}
        <div className="steward-thread-host">
          <PendingOntologyRuntime
            projects={projects}
            currentProject={project}
            sessions={sessions}
            onSelectSession={onSelectSession}
            onRenameSession={onRenameSession}
            onDeleteSession={onDeleteSession}
            onSelectOperationRun={onSelectOperationRun}
            selectedIntent={project ? selectedIntent : selectedIntent === "select" && selectedProject ? "select" : "create"}
            selectedProject={selectedProject}
            onCreateDraft={onNewOntology}
            onSelectDraftProject={handleSelectDraftProject}
            onSendWithoutSession={onSendWithoutSession}
            resources={resources}
            folders={folders}
            onUploadResources={onUploadResources}
            onUploadResourceFolder={onUploadResourceFolder}
            t={t}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="chat-panel steward-chat-panel">
      <StewardChatHeader
        project={project}
      />
      <TemplateSyncBanner ontologyId={project?.deletedAt ? undefined : ontologyId} t={t} />
      <div className="steward-thread-host">
        <OntologyAssistantRuntime
          ontologyId={ontologyId}
          sessionId={sessionId}
          knowledgeOpen={knowledgeOpen}
          readOnly={Boolean(project?.deletedAt)}
          onPhaseUpdate={onPhaseUpdate}
          onBeforeSend={handleBeforeSend}
          pendingInitialMessage={pendingInitialMessage}
          pendingInitialBackendMessage={pendingInitialBackendMessage}
          pendingInitialSlashCommandId={pendingInitialSlashCommandId}
          pendingInitialFiles={pendingInitialFiles}
          pendingInitialWorkspaceFiles={pendingInitialWorkspaceFiles}
          pendingInitialWorkspaceReferences={pendingInitialWorkspaceReferences}
          pendingInitialResourceIds={pendingInitialResourceIds}
          pendingInitialResourceFolderIds={pendingInitialResourceFolderIds}
          onPendingInitialMessageConsumed={onPendingInitialMessageConsumed}
          resources={resources}
          folders={folders}
          locale={locale}
          t={t}
        >
          {({ followupSuggestions, onIssueCommand, onIssueReport, issueSupportContext, issueHelpDisabled }) => <Thread
            fillPanel
            enableConnectors
            projects={projects}
            currentProjectId={selectedProject?.id ?? project.id}
            selectedIntent={selectedIntent}
            onCreateOntology={onNewOntology}
            onSelectProject={handleSelectDraftProject}
            resources={resources}
            folders={folders}
            onUploadResources={onUploadResources}
            onUploadResourceFolder={onUploadResourceFolder}
            followupSuggestions={followupSuggestions}
            onIssueCommand={onIssueCommand}
            onIssueReport={onIssueReport}
            issueSupportContext={issueSupportContext}
            issueHelpDisabled={issueHelpDisabled}
            readOnly={isDeletedKnowledge}
            headerSlot={isDeletedKnowledge ? (
              <div className="deleted-knowledge-notice" role="status" style={{ maxWidth: "44rem", width: "100%", alignSelf: "center" }}>
                <span className="deleted-knowledge-notice-icon"><ArchiveX size={18} /></span>
                <div>
                  <div className="deleted-knowledge-notice-title">
                    <strong>{t?.("knowledge.deletedTitle") ?? "知识库已删除"}</strong>
                    <small>{t?.("knowledge.readOnly") ?? "只读"}</small>
                  </div>
                  <span>{t?.("knowledge.deletedConversationHint") ?? "此对话作为只读记录保留，无法继续问答或访问原知识库。"}</span>
                </div>
              </div>
            ) : undefined}
            t={t}
          />}
        </OntologyAssistantRuntime>
      </div>
      {previewPath && (
        <FilePreviewModal
          path={previewQuery.data?.path ?? previewPath}
          content={previewQuery.data?.content}
          loading={previewQuery.isLoading}
          error={previewQuery.error ? errorMessage(previewQuery.error) : undefined}
          knownPaths={previewKnownPaths}
          onNavigatePath={setPreviewPath}
          onClose={() => setPreviewPath(null)}
          t={t ?? ((key, params) => params?.path ?? params?.count ?? key)}
        />
      )}
    </section>
  );
}
