import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { query, type HookCallback, type McpServerConfig, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { JourneyState, OntologyStreamEvent } from "../../src/contracts/ontology";
import { createComposioClaudeMcpServer, type ComposioRunConnection } from "../composio/claude-agent-tools";
import { env } from "../env";
import { acquireWorkflowLock, appendWikiNote, assertIngestMetaArtifactsForWrite, assertMatchingIngestPlanForDraft, listReviewReadyDraftIds, readActiveReviewDraftContext, readJourneyState, writeJourneyState, type WorkflowLockPhase, type WorkflowLockRecord } from "../ontologies/workspace";
import { directChatCompletion, resolveAgentProxyModel } from "../proxy/direct-completion";
import { createClaudeSessionStore } from "./claude-session-store";
import { createOntologyRuntimeMcpServer } from "./ontology-runtime-tools";
import { bitbucketGitEnvironment, getBitbucketConnectionStatus } from "../bitbucket/connection";
import { classifyRawRepoPath, CODING_REPO_INGEST_SKILL_PATH, commandTextReferencesRawRepos, hasReadCodingRepoIngestSkill as hasReadCodingRepoIngestSkillPath, NON_REPO_CODING_INGEST_GATE_MESSAGE, prepareRepoIngestPrompt, rawRepoRootsFromIngestPlanText, rawRepoRootsFromText, readIngestPlanText, readIngestPlanTextForDraft, REPO_DOCUMENT_INGEST_GATE_MESSAGE, REPO_INGEST_SKILL_GATE_MESSAGE } from "./repo-ingest-routing";

export interface ClaudeRunInput {
  prompt: string;
  cwd: string;
  resume?: string | null;
  tenantId: string;
  ownerId: string;
  userId: string;
  ontologyId: string;
  appSessionId: string;
  runId?: string;
  userRequest: string;
  locale?: "zh" | "en" | "ja";
  composioConnections?: ComposioRunConnection[];
  runTrace?: WorkspaceRunTrace;
  ontologySync?: OntologySyncRunContext;
  readOnly?: boolean;
}

export interface OntologyAgentRunResult {
  events: OntologyStreamEvent[];
  text: string;
  claudeSessionId: string;
  journeyState: JourneyState;
}

export interface OntologyAgentStreamOptions {
  signal?: AbortSignal;
}

export interface OntologySyncRunContext {
  updateId: string;
  materialRoot: string;
}

export type ReviewStateSyncAction = "approved" | "discarded";
export type ReviewStateSyncReason = "normal" | "recovery";

export interface ReviewRecoverySyncContext {
  draftIds?: string[];
  recoveryPath?: string | null;
  manifestPath?: string | null;
}

export interface ClaudeReviewStateSyncInput {
  tenantId: string;
  userId: string;
  cwd: string;
  ontologyId: string;
  appSessionId: string;
  resume: string;
  action: ReviewStateSyncAction;
  reason?: ReviewStateSyncReason;
  recovery?: ReviewRecoverySyncContext;
  locale?: "zh" | "en" | "ja";
  timeoutMs?: number;
}

export interface FollowupSuggestionMessage {
  role: "user" | "assistant" | "agent" | "system";
  content: string;
  parts?: unknown[];
  createdAt?: string;
}

export interface FollowupSuggestionInput {
  tenantId: string;
  userId: string;
  cwd: string;
  messages: FollowupSuggestionMessage[];
  workflowState?: FollowupWorkflowState;
}

export interface FollowupSuggestion {
  prompt: string;
}

export interface FollowupWorkflowState {
  project?: {
    name?: string;
    description?: string;
    pageCount?: number;
    status?: string;
  };
  journey?: {
    mode?: "building" | "manage";
    flow?: "build" | "maintenance";
    phase?: string;
    bootstrapStatus?: string | null;
    awaitingUser?: boolean;
    userDecisionNeeded?: string | null;
    nextExpectedAction?: string | null;
    confirmationPrompt?: string | null;
  };
  ingest?: {
    status?: string | null;
    progress?: number;
    completedBatches?: number;
    totalBatches?: number;
    generatedPagesCount?: number;
  } | null;
  verify?: {
    status?: string;
    questionCount?: number;
    passCount?: number;
    failCount?: number;
    fixedCount?: number;
  } | null;
  review?: {
    status?: string | null;
    draftId?: string;
    fileCount?: number;
    newCount?: number;
    modifiedCount?: number;
  } | null;
}

export interface WorkspaceRunTrace {
  readIngestSkillPaths: Set<string>;
  readOperateSkillPaths: Set<string>;
  readOntologyDistillSkillPaths: Set<string>;
  readEditOntologySkillPaths: Set<string>;
  readOntologyDistillLayerSpecPaths: Set<string>;
  allowedCodingRepoIngestPaths: Set<string>;
  documentRepoIngestPaths: Map<string, string>;
}

export function createWorkspaceRunTrace(): WorkspaceRunTrace {
  return {
    readIngestSkillPaths: new Set(),
    readOperateSkillPaths: new Set(),
    readOntologyDistillSkillPaths: new Set(),
    readEditOntologySkillPaths: new Set(),
    readOntologyDistillLayerSpecPaths: new Set(),
    allowedCodingRepoIngestPaths: new Set(),
    documentRepoIngestPaths: new Map(),
  };
}

function buildClaudeSdkEnv(claudeConfigDir: string, gitEnvironment?: NodeJS.ProcessEnv): Record<string, string> {
  const sdkEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  if (!sdkEnv.SHELL) sdkEnv.SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
  sdkEnv.PATH = sdkEnv.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  sdkEnv.CLAUDE_CONFIG_DIR = claudeConfigDir;
  sdkEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  sdkEnv.IS_SANDBOX = "1";
  if (gitEnvironment) Object.assign(sdkEnv, gitEnvironment);

  const proxyModel = resolveAgentProxyModel();
  if (proxyModel) {
    const proxyProvider = process.env.ONTOLOGY_PROXY_PROVIDER ?? process.env.STEWARD_PROXY_PROVIDER ?? "azure";
    // An ambient Claude Code base URL may point at an unrelated local proxy.
    // Explicit ontology proxy configuration must route through this server.
    const baseUrl = process.env.ONTOLOGY_PROXY_BASE_URL ?? `http://127.0.0.1:${env.port}/api/proxy`;
    sdkEnv.ANTHROPIC_BASE_URL = baseUrl;
    sdkEnv.ANTHROPIC_API_KEY = `proxy:${env.proxyToken}:${proxyProvider}:${proxyModel}`;
    delete sdkEnv.ANTHROPIC_AUTH_TOKEN;
    delete sdkEnv.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (process.env.ANTHROPIC_BASE_URL) {
    sdkEnv.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
    if (process.env.ANTHROPIC_API_KEY) sdkEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (process.env.ANTHROPIC_AUTH_TOKEN) sdkEnv.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    if (process.env.ANTHROPIC_API_KEY) sdkEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (process.env.ANTHROPIC_AUTH_TOKEN) sdkEnv.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  return sdkEnv;
}

async function inheritLocalClaudeAuth(claudeConfigDir: string): Promise<void> {
  if (!env.inheritLocalClaudeAuth) return;
  const localCredentials = path.join(os.homedir(), ".claude", ".credentials.json");
  const scopedCredentials = path.join(claudeConfigDir, ".credentials.json");
  try {
    await fs.access(scopedCredentials);
    return;
  } catch {
    // Copy the host Claude Code login into the scoped config for local development only.
  }
  try {
    await fs.copyFile(localCredentials, scopedCredentials);
  } catch {
    // Let the SDK report the canonical login error if no local credentials exist.
  }
}

function textFromAssistant(message: SDKMessage): string {
  if (message.type !== "assistant") return "";
  const content = message.message.content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    const b = block as { type?: string; text?: string };
    return b.type === "text" ? b.text ?? "" : "";
  }).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function defaultFollowupSuggestions(workflowState?: FollowupWorkflowState): FollowupSuggestion[] {
  const decision = workflowState?.journey?.userDecisionNeeded;
  if (decision === "provide_goal") {
    return [{ prompt: "请引导我明确知识库目标" }, { prompt: "帮我判断适合沉淀哪些内容" }, { prompt: "先给我几个构建目标示例" }];
  }
  if (decision === "upload_source_materials") {
    return [];
  }
  if (decision === "generate_schema") {
    return [{ prompt: "请基于现有材料生成结构" }, { prompt: "请先检查材料是否足够" }, { prompt: "请说明你会怎么设计结构" }];
  }
  if (decision === "confirm_or_adjust_schema") {
    return [{ prompt: "确认这个结构，请开始初始化" }, { prompt: "我想调整目录结构" }, { prompt: "请解释这样分层的原因" }];
  }
  if (decision === "confirm_or_adjust_metadata") {
    return [{ prompt: "确认这些知识库信息" }, { prompt: "请修改知识库名称和描述" }, { prompt: "请把内容语言改为中文" }];
  }
  if (decision === "review_staged_changes") {
    return [];
  }
  return [];
}

export function extractJsonObjectText(text: string): string | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").trim();
  const start = stripped.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i += 1) {
    const char = stripped[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return null;
}

function isDisallowedFollowupSuggestion(prompt: string): boolean {
  const normalized = prompt.toLowerCase().replace(/\s+/g, "");
  if (/[.。…]{3,}$/.test(prompt.trim()) || prompt.includes("...")) return true;
  const exactBlocked = [
    "continue",
    "继续",
    "下一步",
    "whatnext",
  ];
  const containsBlocked = [
    "learnmore",
    "opendetails",
    "viewdetails",
    "了解更多",
    "查看详情",
  ];
  return exactBlocked.includes(normalized) || containsBlocked.some((blocked) => normalized.includes(blocked));
}

function textFromSuggestionMessage(message: FollowupSuggestionMessage): string {
  return message.content || (message.parts ? JSON.stringify(message.parts) : "");
}

function groupConversationTurns(messages: readonly FollowupSuggestionMessage[]): FollowupSuggestionMessage[][] {
  const turns: FollowupSuggestionMessage[][] = [];
  let current: FollowupSuggestionMessage[] = [];
  for (const message of messages) {
    const text = textFromSuggestionMessage(message).trim();
    if (!text) continue;
    const role = message.role === "agent" ? "assistant" : message.role;
    if (role === "user" && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) turns.push(current);
  return turns;
}

function formatMessagesForSuggestions(messages: readonly FollowupSuggestionMessage[]): string {
  const turns = groupConversationTurns(messages).slice(-5);
  if (!turns.length) return "(none)";
  return turns.map((turn, index) => {
    const lines = turn.map((message) => {
      const role = message.role === "agent" ? "assistant" : message.role;
      const time = message.createdAt ?? "unknown-time";
      const text = textFromSuggestionMessage(message).trim().slice(0, 1600);
      return `[${time}] ${role}: ${text}`;
    });
    return [`<turn ${index + 1}>`, ...lines, `</turn ${index + 1}>`].join("\n");
  }).join("\n\n").slice(-12000);
}

function formatWorkflowStateForSuggestions(workflowState: FollowupWorkflowState | undefined): string {
  if (!workflowState) return "(none)";
  return JSON.stringify(workflowState, null, 2).slice(0, 5000);
}

function parseSuggestionOutput(value: unknown): FollowupSuggestion[] | null {
  try {
    const raw = typeof value === "string" ? JSON.parse(extractJsonObjectText(value) ?? value.trim()) : value;
    if (!isRecord(raw) || !Array.isArray(raw.suggestions)) return null;
    return raw.suggestions
      .map((item) => isRecord(item) && typeof item.prompt === "string" ? item.prompt : undefined)
      .filter((prompt): prompt is string => Boolean(prompt?.trim()))
      .map((prompt) => prompt.trim().slice(0, 80))
      .filter((prompt) => !isDisallowedFollowupSuggestion(prompt))
      .slice(0, 3)
      .map((prompt) => ({ prompt }));
  } catch {
    return null;
  }
}

export function cleanSuggestionOutput(value: unknown): FollowupSuggestion[] {
  return parseSuggestionOutput(value) ?? [];
}

export async function generateFollowupSuggestions(input: FollowupSuggestionInput): Promise<FollowupSuggestion[]> {
  const fallback = defaultFollowupSuggestions(input.workflowState);
  if (!env.enableClaudeRuntime) return fallback;

  const prompt = [
    "You are the suggested-action chip generator for Knowledge Fabric.",
    "Your job is NOT to answer the user. Generate 0-3 action chips: complete user prompts that can be auto-sent immediately when clicked.",
    "Each chip should represent what the user may reasonably reply with or ask next after the latest assistant response.",
    "",
    "Product model:",
    "- Knowledge Fabric has two top-level responsibilities: Knowledge Stewardship and Business Operation.",
    "- Knowledge Stewardship covers creating, ingesting, organizing, querying, validating, editing, reviewing, and evolving knowledge and ontology artifacts.",
    "- Business Operation covers executing supported business tasks from existing knowledge, ontology bindings, and available tools.",
    "- The journey state uses flow=build|maintenance and phase=bootstrap|ingest|verify|review|ready.",
    "- Build flow is Bootstrap -> Ingest -> Verify -> Review. Approval transitions the knowledge base to flow=maintenance and phase=ready.",
    "- In maintenance/ready, users can query knowledge, query or update ontology, ingest new material, sync repositories, edit knowledge, revise an active review draft, run challenge checks, generate challenge questions, or ask for supported business operations.",
    "- Knowledge-changing workflows stage drafts under pending_review and use Verify/Review gates before applying. Do not imply direct writes unless the workflow explicitly supports them.",
    "- Review approval/discard is a UI action. Chat chips may help summarize, inspect risk, or request textual adjustments, but must not pretend to approve/discard or click UI buttons.",
    "- Long ingest workflows are supervised by backend continuation. Never suggest continuing the next batch for progress-only messages.",
    "- Slash commands are internal shorthand. Never suggest slash commands.",
    "",
    "Selection rules:",
    "1. Treat chips as auto-send user prompts. Never output labels, fragments, placeholders, or UI-only text.",
    "2. If workflow_state says the assistant is waiting for user confirmation, generate only valid user actions for that pending confirmation.",
    "3. Treat the final assistant message in recent_conversation as the just-completed assistant reply. Based on the natural trajectory of the conversation, suggest what the user may reasonably ask next or reply with after that assistant reply.",
    "4. If the workflow is still running or the assistant message is only progress, return no suggestions unless there is a real user decision.",
    "5. If phase is bootstrap/building, stay inside the current build step. Do not skip ahead.",
    "6. If phase is review, return no suggestions because Review requires explicit UI approval/discard or direct draft inspection.",
    "7. If phase is ready/maintenance, return no suggestions.",
    "8. Prefer action-oriented wording. Chinese chips should usually start with 请, 确认, 我已经, 我想, or 暂时没有 when appropriate.",
    "9. Avoid generic filler: continue, learn more, open details, what next, expand this.",
    "10. Match the language of the latest substantive user message in recent_conversation. If it is Chinese, all prompts must be Chinese.",
    "",
    "Return only JSON, for example: {\"suggestions\":[{\"prompt\":\"请总结这批变更\"}]}",
    "Return {\"suggestions\":[]} when no useful next action should be shown.",
    "Constraints: 0-3 suggestions. Each prompt must be under 60 Chinese characters or 12 English words. No explanations, labels, categories, markdown, ellipses, placeholders, or internal paths unless the user already referenced them.",
    "",
    "<workflow_state>",
    formatWorkflowStateForSuggestions(input.workflowState),
    "</workflow_state>",
    "",
    "<recent_conversation>",
    formatMessagesForSuggestions(input.messages),
    "</recent_conversation>",
  ].join("\n");

  const t0 = Date.now();
  // max_completion_tokens includes reasoning tokens on gpt-5.x models — keep
  // generous headroom or the tiny JSON answer gets starved by hidden reasoning.
  const directText = await directChatCompletion(prompt, { maxTokens: 2000, timeoutMs: 15000 });
  if (directText !== null) {
    console.log("[chat/suggestions] direct-completion ms=" + (Date.now() - t0));
    return parseSuggestionOutput(directText) ?? fallback;
  }

  const claudeConfigDir = path.join(env.claudeConfigRoot, "tenants", input.tenantId, "users", input.userId);
  await fs.mkdir(claudeConfigDir, { recursive: true });
  await inheritLocalClaudeAuth(claudeConfigDir);
  const bitbucket = await getBitbucketConnectionStatus(input.tenantId, input.userId);
  const sdkEnv = buildClaudeSdkEnv(claudeConfigDir, bitbucket.connected ? bitbucketGitEnvironment(input.tenantId, input.userId) : undefined);

  try {
    const sdkQuery = query({
      prompt,
      options: {
        cwd: input.cwd,
        tools: [],
        allowedTools: [],
        disallowedTools: ["Bash"],
        settingSources: ["project"],
        includePartialMessages: false,
        maxTurns: 10,
        env: sdkEnv,
      },
    });

    const textParts: string[] = [];
    for await (const message of sdkQuery) {
      const assistantText = textFromAssistant(message);
      if (assistantText) textParts.push(assistantText);
      if (message.type === "result" && "result" in message && typeof message.result === "string") textParts.push(message.result);
    }

    const suggestions = parseSuggestionOutput(textParts.join("\n"));
    return suggestions ? suggestions : fallback;
  } catch (err) {
    console.warn("[chat/suggestions] LLM suggestion generation failed:", err instanceof Error ? err.message : String(err));
    return fallback;
  }
}

export async function generateSessionTitle(input: {
  userMessage: string;
  assistantMessage: string;
  tenantId: string;
  userId: string;
  cwd: string;
}): Promise<string | null> {
  if (!env.enableClaudeRuntime) return null;

  const prompt = [
    "Generate a short conversation title based on the exchange below.",
    "Rules:",
    "- Under 20 characters (Chinese) or 8 words (English)",
    "- Match the language of the user message",
    "- No quotes, no punctuation, no emoji",
    "- Capture the core intent, not a literal copy of the message",
    "- Output ONLY the title, nothing else",
    "",
    `<user_message>${input.userMessage.slice(0, 300)}</user_message>`,
    `<assistant_response>${input.assistantMessage.slice(0, 500)}</assistant_response>`,
  ].join("\n");

  const t0 = Date.now();
  // Reasoning tokens count against max_completion_tokens — 100 would starve the title.
  const directText = await directChatCompletion(prompt, { maxTokens: 1000, timeoutMs: 10000 });
  if (directText !== null) {
    console.log("[chat/title] direct-completion ms=" + (Date.now() - t0));
    const title = directText.trim().replace(/^["'""'']|["'""'']$/g, "");
    if (title && title.length > 0 && title.length <= 64) return title;
    return null;
  }

  const claudeConfigDir = path.join(env.claudeConfigRoot, "tenants", input.tenantId, "users", input.userId);
  await fs.mkdir(claudeConfigDir, { recursive: true });
  await inheritLocalClaudeAuth(claudeConfigDir);
  const sdkEnv = buildClaudeSdkEnv(claudeConfigDir);

  try {
    const sdkQuery = query({
      prompt,
      options: {
        cwd: input.cwd,
        tools: [],
        allowedTools: [],
        disallowedTools: ["Bash"],
        settingSources: ["project"],
        includePartialMessages: false,
        maxTurns: 10,
        env: sdkEnv,
      },
    });

    const textParts: string[] = [];
    for await (const message of sdkQuery) {
      const t = textFromAssistant(message);
      if (t) textParts.push(t);
      if (message.type === "result" && "result" in message && typeof message.result === "string") {
        textParts.push(message.result);
      }
    }

    const title = textParts.join("").trim().replace(/^["'""'']|["'""'']$/g, "");
    if (title && title.length > 0 && title.length <= 64) return title;
    return null;
  } catch (err) {
    console.warn("[chat/title] AI title generation failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function toolEventsFromAssistant(message: SDKMessage): OntologyStreamEvent[] {
  if (message.type !== "assistant" || !Array.isArray(message.message.content)) return [];
  return message.message.content.flatMap((block: unknown) => {
    const b = block as { type?: string; name?: string; input?: unknown };
    return b.type === "tool_use" ? [{ type: "tool" as const, tool: b.name ?? "tool", input: b.input }] : [];
  });
}

function collectToolPathEntries(toolInput: Record<string, unknown>): Array<{ key: string; value: string }> {
  const paths: Array<{ key: string; value: string }> = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = toolInput[key];
    if (typeof value === "string") paths.push({ key, value });
  }
  return paths;
}

const WORKSPACE_WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);
const WORKSPACE_PATH_TOOLS = new Set(["read", "write", "edit", "multiedit", "notebookedit", "glob", "grep"]);
const DIRECT_KNOWLEDGE_WRITE_TOOLS = new Set(["write", "edit", "multiedit"]);
const JOURNEY_STATE_RELATIVE_PATH = ".runtime/journey-state.json";
const JOURNEY_STATE_WRITE_MESSAGE = "Do not edit .runtime/journey-state.json directly. Use knowledge_update_journey to update the Journey panel state.";
const ONTOLOGY_SCENARIO_CARDS_WRITE_MESSAGE = "Do not edit ontology/artifacts/scenario-cards.json directly. Use ontology_update_scenario_cards to create, reorder, start, or complete ontology scenario cards.";
const ONTOLOGY_INSTANCE_GLEANING_WRITE_MESSAGE = "Do not edit ontology/artifacts/instance-gleaning-state.json directly. Use ontology_instance_gleaning to advance missed-instance extraction passes.";
const INGEST_SKILL_GATE_MESSAGE = "Before creating or editing ingest-plans/*.json, Read skills/single-ingest/SKILL.md, skills/batch-ingest/SKILL.md, or skills/coding-repo-ingest/SKILL.md in this run, then retry.";
const ONTOLOGY_DISTILL_SKILL_GATE_MESSAGE = "Before creating or editing ontology outputs, this session/run must have a recorded Read of exactly skills/ontology-distill/SKILL.md or skills/edit-ontology/SKILL.md. Read one of those files now, then retry. Do not substitute skills/query-ontology/SKILL.md.";
const ONTOLOGY_DISTILL_LAYER_SPEC_GATE_MESSAGE = "Before creating or editing this final ontology YAML in this backend run, Read the matching skills/_shared/ontology-layers/*.md spec, then retry.";
const ONTOLOGY_LAYER_WHOLE_WRITE_MESSAGE = "Do not overwrite existing ontology/*.yaml layer files with whole-file writes. Use Edit or MultiEdit for existing ontology layer updates. Bash may only create a new ontology layer file when it does not already exist.";
const QUERY_SYNTHESIS_DRAFT_WRITE_MESSAGE = "Saved query syntheses must be written with the knowledge_save_synthesis MCP tool. Do not create or edit pending_review/drafts/query-* drafts, meta.json, ingest plans, Verify artifacts, or Review handoffs for query synthesis saves.";
const WORKFLOW_ID_RE = /^[A-Za-z0-9._-]+$/;
const INGEST_PLAN_PATH_RE = /^ingest-plans\/([^/]+)\.json$/;
const INGEST_DRAFT_PATH_RE = /^pending_review\/drafts\/(ingest-[^/]+)(?:\/(.*))?$/;
const ONTOLOGY_LAYER_PATH_RE = /^ontology\/(?:object-model|source-mappings|actions|business-rules|functions)\.yaml$/;
const ONTOLOGY_INSTANCE_PATH_RE = /^ontology\/object-instances\.ya?ml$/;
const ONTOLOGY_SCENARIO_CARDS_PATH = "ontology/artifacts/scenario-cards.json";
const ONTOLOGY_INSTANCE_GLEANING_PATH = "ontology/artifacts/instance-gleaning-state.json";
const ONTOLOGY_EDITING_SKILL_READS_FILE = ".runtime/ontology-editing-skill-reads.json";
const ONTOLOGY_LAYER_SPEC_BY_OUTPUT: Record<string, string> = {
  "ontology/object-model.yaml": "skills/_shared/ontology-layers/object-model.md",
  "ontology/source-mappings.yaml": "skills/_shared/ontology-layers/source-mappings.md",
  "ontology/actions.yaml": "skills/_shared/ontology-layers/actions.md",
  "ontology/business-rules.yaml": "skills/_shared/ontology-layers/business-rules.md",
  "ontology/functions.yaml": "skills/_shared/ontology-layers/functions.md",
};
const INGEST_SKILL_PATHS = new Set([
  "skills/single-ingest/SKILL.md",
  "skills/batch-ingest/SKILL.md",
  CODING_REPO_INGEST_SKILL_PATH,
]);
const OPERATE_SKILL_PATH = "skills/operate/SKILL.md";
const ONTOLOGY_DISTILL_SKILL_PATHS = new Set([
  "skills/ontology-distill/SKILL.md",
]);
const EDIT_ONTOLOGY_SKILL_PATHS = new Set([
  "skills/edit-ontology/SKILL.md",
]);

function relativeWorkspacePath(root: string, resolved: string): string {
  return path.relative(root, resolved).replace(/\\/g, "/");
}

function normalizeToolPath(raw: string): string {
  return raw.replace(/\\/g, "/").trim();
}

function isAbsoluteToolPath(raw: string): boolean {
  return path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(normalizeToolPath(raw));
}

function workspaceRelativeToolPath(raw: string): string | null {
  const toolPath = normalizeToolPath(raw);
  if (!toolPath || toolPath.split("/").includes("..")) return null;
  const normalized = path.posix.normalize(toolPath);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
}

function workspaceRelativePathFromToolPath(root: string, raw: string): string | null {
  const rootResolved = path.resolve(root);
  const resolved = isAbsoluteToolPath(raw) ? path.resolve(raw) : path.resolve(rootResolved, raw);
  const relativePath = relativeWorkspacePath(rootResolved, resolved);
  return workspaceRelativeToolPath(relativePath);
}

function isIngestSkillPath(relativePath: string): boolean {
  return INGEST_SKILL_PATHS.has(path.posix.normalize(relativePath));
}

function isOntologyDistillSkillPath(relativePath: string): boolean {
  return ONTOLOGY_DISTILL_SKILL_PATHS.has(path.posix.normalize(relativePath));
}

function isEditOntologySkillPath(relativePath: string): boolean {
  return EDIT_ONTOLOGY_SKILL_PATHS.has(path.posix.normalize(relativePath));
}

function isOntologyDistillLayerSpecPath(relativePath: string): boolean {
  return Object.values(ONTOLOGY_LAYER_SPEC_BY_OUTPUT).includes(path.posix.normalize(relativePath));
}

function recordIngestSkillRead(root: string, input: Record<string, unknown>, trace?: WorkspaceRunTrace): void {
  if (!trace) return;
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) return;
  const relativePath = workspaceRelativePathFromToolPath(root, filePath);
  if (relativePath && isIngestSkillPath(relativePath)) trace.readIngestSkillPaths.add(relativePath);
}

function recordOperateSkillRead(root: string, input: Record<string, unknown>, trace?: WorkspaceRunTrace): void {
  if (!trace) return;
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) return;
  const relativePath = workspaceRelativePathFromToolPath(root, filePath);
  if (relativePath && path.posix.normalize(relativePath) === OPERATE_SKILL_PATH) trace.readOperateSkillPaths.add(OPERATE_SKILL_PATH);
}

function hasReadIngestSkill(trace?: WorkspaceRunTrace): boolean {
  return Boolean(trace?.readIngestSkillPaths.size);
}

function hasReadCodingRepoIngestSkill(trace?: WorkspaceRunTrace): boolean {
  return hasReadCodingRepoIngestSkillPath(trace?.readIngestSkillPaths);
}

function formatRepoShapeLine(pathValue: string, reason: string): string {
  return `${pathValue}: ${reason}`;
}

function documentRepoGateMessage(items: readonly { path: string; reason: string }[]): string {
  if (!items.length) return REPO_DOCUMENT_INGEST_GATE_MESSAGE;
  return [
    REPO_DOCUMENT_INGEST_GATE_MESSAGE,
    `Backend repo-shape check: ${items.map((item) => formatRepoShapeLine(item.path, item.reason)).join("; ")}.`,
  ].join(" ");
}

function nonRepoCodingSkillMessage(trace?: WorkspaceRunTrace): string {
  const documentPaths = [...(trace?.documentRepoIngestPaths.entries() ?? [])].map(([pathValue, reason]) => formatRepoShapeLine(pathValue, reason));
  if (!documentPaths.length) return NON_REPO_CODING_INGEST_GATE_MESSAGE;
  return `${NON_REPO_CODING_INGEST_GATE_MESSAGE} Backend repo-shape check: ${documentPaths.join("; ")}.`;
}

function recordRepoIngestPreparation(trace: WorkspaceRunTrace, allowedRepoPaths: ReadonlySet<string>, documentRepoPaths: ReadonlyMap<string, { reason: string }>): void {
  for (const repoPath of allowedRepoPaths) trace.allowedCodingRepoIngestPaths.add(repoPath);
  for (const [repoPath, classification] of documentRepoPaths) trace.documentRepoIngestPaths.set(repoPath, classification.reason);
}

function codingRepoSkillReadViolation(relativePath: string, trace?: WorkspaceRunTrace): string | null {
  if (path.posix.normalize(relativePath) !== CODING_REPO_INGEST_SKILL_PATH) return null;
  return trace?.allowedCodingRepoIngestPaths.size ? null : nonRepoCodingSkillMessage(trace);
}

function recordOntologyDistillSkillRead(root: string, input: Record<string, unknown>, trace?: WorkspaceRunTrace): void {
  if (!trace) return;
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) return;
  const relativePath = workspaceRelativePathFromToolPath(root, filePath);
  if (relativePath && isOntologyDistillSkillPath(relativePath)) trace.readOntologyDistillSkillPaths.add(relativePath);
}

function hasReadOntologyDistillSkill(trace?: WorkspaceRunTrace): boolean {
  return Boolean(trace?.readOntologyDistillSkillPaths.size);
}

function recordEditOntologySkillRead(root: string, input: Record<string, unknown>, trace?: WorkspaceRunTrace): void {
  if (!trace) return;
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) return;
  const relativePath = workspaceRelativePathFromToolPath(root, filePath);
  if (relativePath && isEditOntologySkillPath(relativePath)) trace.readEditOntologySkillPaths.add(relativePath);
}

function hasReadOntologyEditingSkill(trace?: WorkspaceRunTrace): boolean {
  return Boolean(hasReadOntologyDistillSkill(trace) || trace?.readEditOntologySkillPaths.size);
}

interface PersistedOntologyEditingSkillReads {
  version: 1;
  sessions: Record<string, {
    updatedAt: string;
    readOntologyDistillSkillPaths: string[];
    readEditOntologySkillPaths: string[];
    runIds?: Record<string, {
      updatedAt: string;
      readOntologyDistillSkillPaths: string[];
      readEditOntologySkillPaths: string[];
    }>;
  }>;
}

function emptyPersistedOntologyEditingSkillReads(): PersistedOntologyEditingSkillReads {
  return { version: 1, sessions: {} };
}

function normalizedStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => path.posix.normalize(item)))]
    : [];
}

function normalizePersistedOntologyEditingSkillReads(value: unknown): PersistedOntologyEditingSkillReads {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.sessions)) return emptyPersistedOntologyEditingSkillReads();
  const sessions: PersistedOntologyEditingSkillReads["sessions"] = {};
  for (const [sessionId, rawSession] of Object.entries(value.sessions)) {
    if (!sessionId || !isRecord(rawSession)) continue;
    const runIds: NonNullable<PersistedOntologyEditingSkillReads["sessions"][string]["runIds"]> = {};
    if (isRecord(rawSession.runIds)) {
      for (const [runId, rawRun] of Object.entries(rawSession.runIds)) {
        if (!runId || !isRecord(rawRun)) continue;
        runIds[runId] = {
          updatedAt: typeof rawRun.updatedAt === "string" ? rawRun.updatedAt : "",
          readOntologyDistillSkillPaths: normalizedStringArray(rawRun.readOntologyDistillSkillPaths),
          readEditOntologySkillPaths: normalizedStringArray(rawRun.readEditOntologySkillPaths),
        };
      }
    }
    sessions[sessionId] = {
      updatedAt: typeof rawSession.updatedAt === "string" ? rawSession.updatedAt : "",
      readOntologyDistillSkillPaths: normalizedStringArray(rawSession.readOntologyDistillSkillPaths),
      readEditOntologySkillPaths: normalizedStringArray(rawSession.readEditOntologySkillPaths),
      ...(Object.keys(runIds).length ? { runIds } : {}),
    };
  }
  return { version: 1, sessions };
}

async function readPersistedOntologyEditingSkillReads(root: string): Promise<PersistedOntologyEditingSkillReads> {
  try {
    const raw = await fs.readFile(path.join(root, ONTOLOGY_EDITING_SKILL_READS_FILE), "utf-8");
    return normalizePersistedOntologyEditingSkillReads(JSON.parse(raw));
  } catch {
    return emptyPersistedOntologyEditingSkillReads();
  }
}

async function writePersistedOntologyEditingSkillReads(root: string, value: PersistedOntologyEditingSkillReads): Promise<void> {
  const file = path.join(root, ONTOLOGY_EDITING_SKILL_READS_FILE);
  const tmp = path.join(path.dirname(file), `.ontology-editing-skill-reads-${randomUUID()}.tmp`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, file);
}

function ontologyEditingSkillReadKind(relativePath: string): "distill" | "edit" | null {
  if (isOntologyDistillSkillPath(relativePath)) return "distill";
  if (isEditOntologySkillPath(relativePath)) return "edit";
  return null;
}

async function persistOntologyEditingSkillRead(root: string, input: Record<string, unknown>, context?: WorkspaceRunContext): Promise<void> {
  if (!context?.sessionId) return;
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) return;
  const relativePath = workspaceRelativePathFromToolPath(root, filePath);
  if (!relativePath) return;
  const kind = ontologyEditingSkillReadKind(relativePath);
  if (!kind) return;

  const normalized = path.posix.normalize(relativePath);
  const current = await readPersistedOntologyEditingSkillReads(root);
  const now = new Date().toISOString();
  const existingSession = current.sessions[context.sessionId] ?? {
    updatedAt: now,
    readOntologyDistillSkillPaths: [],
    readEditOntologySkillPaths: [],
    runIds: {},
  };
  const session = {
    ...existingSession,
    updatedAt: now,
    readOntologyDistillSkillPaths: [...existingSession.readOntologyDistillSkillPaths],
    readEditOntologySkillPaths: [...existingSession.readEditOntologySkillPaths],
    runIds: { ...(existingSession.runIds ?? {}) },
  };
  const sessionPaths = kind === "distill" ? session.readOntologyDistillSkillPaths : session.readEditOntologySkillPaths;
  if (!sessionPaths.includes(normalized)) sessionPaths.push(normalized);

  if (context.runId) {
    const existingRun = session.runIds[context.runId] ?? {
      updatedAt: now,
      readOntologyDistillSkillPaths: [],
      readEditOntologySkillPaths: [],
    };
    const run = {
      ...existingRun,
      updatedAt: now,
      readOntologyDistillSkillPaths: [...existingRun.readOntologyDistillSkillPaths],
      readEditOntologySkillPaths: [...existingRun.readEditOntologySkillPaths],
    };
    const runPaths = kind === "distill" ? run.readOntologyDistillSkillPaths : run.readEditOntologySkillPaths;
    if (!runPaths.includes(normalized)) runPaths.push(normalized);
    session.runIds[context.runId] = run;
  }

  current.sessions[context.sessionId] = session;
  await writePersistedOntologyEditingSkillReads(root, current);
}

async function hasPersistedOntologyEditingSkillRead(root: string, context?: WorkspaceRunContext): Promise<boolean> {
  if (!context?.sessionId) return false;
  const current = await readPersistedOntologyEditingSkillReads(root);
  const session = current.sessions[context.sessionId];
  if (!session) return false;
  if (session.readOntologyDistillSkillPaths.length || session.readEditOntologySkillPaths.length) return true;
  const run = context.runId ? session.runIds?.[context.runId] : null;
  return Boolean(run?.readOntologyDistillSkillPaths.length || run?.readEditOntologySkillPaths.length);
}

async function hasReadOntologyEditingSkillForGate(root: string, context: WorkspaceRunContext | undefined, trace?: WorkspaceRunTrace): Promise<boolean> {
  return hasReadOntologyEditingSkill(trace) || await hasPersistedOntologyEditingSkillRead(root, context);
}

function recordOntologyDistillLayerSpecRead(root: string, input: Record<string, unknown>, trace?: WorkspaceRunTrace): void {
  if (!trace) return;
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) return;
  const relativePath = workspaceRelativePathFromToolPath(root, filePath);
  if (relativePath && isOntologyDistillLayerSpecPath(relativePath)) trace.readOntologyDistillLayerSpecPaths.add(path.posix.normalize(relativePath));
}

function hasReadOntologyDistillLayerSpec(relativePath: string, trace?: WorkspaceRunTrace): boolean {
  const requiredSpec = ONTOLOGY_LAYER_SPEC_BY_OUTPUT[path.posix.normalize(relativePath)];
  if (!requiredSpec) return true;
  return Boolean(trace?.readOntologyDistillLayerSpecPaths.has(requiredSpec));
}

function isRootKnowledgePath(relativePath: string): boolean {
  return relativePath === "knowledge" || relativePath.startsWith("knowledge/");
}

function isOntologyUpdateMaterialsPath(relativePath: string): boolean {
  const normalized = path.posix.normalize(relativePath);
  return normalized === "ontology-update-materials" || normalized.startsWith("ontology-update-materials/");
}

function isAllowedOntologySyncMaterialPath(relativePath: string, context?: WorkspaceRunContext): boolean {
  const materialRoot = context?.ontologySync?.materialRoot;
  if (!materialRoot) return false;
  const normalized = path.posix.normalize(relativePath);
  const root = path.posix.normalize(materialRoot);
  return normalized === root || normalized.startsWith(`${root}/`);
}

function ontologySyncMaterialViolation(relativePath: string, context?: WorkspaceRunContext): string | null {
  if (!context?.ontologySync || !isOntologyUpdateMaterialsPath(relativePath)) return null;
  if (isAllowedOntologySyncMaterialPath(relativePath, context)) return null;
  return [
    `This ontology sync run is bound to: ${context.ontologySync.materialRoot}/`,
    "Use only files under that directory for this run.",
  ].join(" ");
}

function commandReferencesOntologyUpdateMaterials(command: string): boolean {
  return /(?:^|[\s"'`=;|&()<>])ontology-update-materials(?:\/|[\s"'`;|&()<>]|$)/.test(command.replace(/\\/g, "/"));
}

function commandReferencesAllowedOntologySyncMaterials(command: string, context?: WorkspaceRunContext): boolean {
  const materialRoot = context?.ontologySync?.materialRoot;
  if (!materialRoot) return false;
  const normalized = command.replace(/\\/g, "/");
  const escaped = materialRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s"'\\\`=;|&()<>])${escaped}(?:/|[\\s"'\\\`;|&()<>]|$)`).test(normalized);
}

function ontologyUpdateMaterialRootsFromCommand(command: string): string[] {
  const roots = new Set<string>();
  const normalized = command.replace(/\\/g, "/");
  const re = /(?:^|[\s"'`=;|&()<>])(ontology-update-materials\/[^/\s"'`;|&()<>]+)/g;
  for (const match of normalized.matchAll(re)) roots.add(path.posix.normalize(match[1]));
  return [...roots];
}

function ontologySyncMaterialBashViolation(command: string, context?: WorkspaceRunContext): string | null {
  if (!context?.ontologySync || !commandReferencesOntologyUpdateMaterials(command)) return null;
  const materialRoot = path.posix.normalize(context.ontologySync.materialRoot);
  const referencedRoots = ontologyUpdateMaterialRootsFromCommand(command);
  if (!referencedRoots.length || referencedRoots.some((root) => root !== materialRoot) || !commandReferencesAllowedOntologySyncMaterials(command, context)) {
    return [
      `This ontology sync run is bound to: ${context.ontologySync.materialRoot}/`,
      "Use only files under that directory for this run.",
    ].join(" ");
  }
  if (commandHasWriteIntent(command)) return "Do not modify ontology-update-materials/. Read the current run material package only.";
  return null;
}

function isJourneyStatePath(relativePath: string): boolean {
  return relativePath === JOURNEY_STATE_RELATIVE_PATH;
}

function isOntologyDistillOutputPath(relativePath: string): boolean {
  const normalized = path.posix.normalize(relativePath);
  return ONTOLOGY_LAYER_PATH_RE.test(normalized) ||
    ONTOLOGY_INSTANCE_PATH_RE.test(normalized) ||
    normalized === ONTOLOGY_SCENARIO_CARDS_PATH;
}

type IngestDraftWriteKind = "content" | "meta" | "other";

interface IngestDraftWriteTarget {
  draftId: string;
  kind: IngestDraftWriteKind;
}

function ingestDraftWriteTargetFromPath(relativePath: string): IngestDraftWriteTarget | null {
  const match = INGEST_DRAFT_PATH_RE.exec(path.posix.normalize(relativePath));
  if (!match) return null;
  const draftId = match[1];
  const rest = (match[2] ?? "").replace(/\/+$/, "");
  if (rest === "meta.json") return { draftId, kind: "meta" };
  if (rest === "knowledge" || rest.startsWith("knowledge/")) return { draftId, kind: "content" };
  return { draftId, kind: "other" };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function repoIngestDraftSkillGateViolation(root: string, draftId: string, trace?: WorkspaceRunTrace): Promise<string | null> {
  const planText = await readIngestPlanTextForDraft(root, draftId);
  const repoRoots = rawRepoRootsFromIngestPlanText(planText);
  if (!repoRoots.length) return hasReadCodingRepoIngestSkill(trace) ? nonRepoCodingSkillMessage(trace) : null;
  const classifications = (await Promise.all(repoRoots.map((repoRoot) => classifyRawRepoPath(root, repoRoot))))
    .filter((item): item is NonNullable<Awaited<ReturnType<typeof classifyRawRepoPath>>> => Boolean(item));
  const documentRepos = classifications.filter((item) => !item.isCodeRepo);
  if (documentRepos.length) return documentRepoGateMessage(documentRepos);
  return hasReadCodingRepoIngestSkill(trace) ? null : REPO_INGEST_SKILL_GATE_MESSAGE;
}

async function ingestDraftWriteGateViolation(root: string, relativePath: string, trace?: WorkspaceRunTrace): Promise<string | null> {
  const target = ingestDraftWriteTargetFromPath(relativePath);
  if (!target) return null;
  const repoGateMessage = await repoIngestDraftSkillGateViolation(root, target.draftId, trace);
  if (repoGateMessage) return repoGateMessage;
  try {
    if (target.kind === "content") await assertMatchingIngestPlanForDraft(root, target.draftId);
    if (target.kind === "meta") await assertIngestMetaArtifactsForWrite(root, target.draftId);
    return null;
  } catch (err) {
    return errorText(err);
  }
}

function reviewLockMessage(reviewReadyDraftIds: readonly string[]): string {
  const ids = reviewReadyDraftIds.length ? reviewReadyDraftIds.join(", ") : "unknown";
  return [
    `Review-ready drafts already exist: ${ids}.`,
    "Do not create a new draft or new/unrelated ingest plan.",
    "Do not use an existing Review draft as the target for a new ingest or formal knowledge edit.",
    "Only edit an existing pending_review/drafts/... path if the user explicitly asked to revise that Review draft.",
    "Otherwise ask the user to approve or discard all pending Review drafts first.",
  ].join(" ");
}

function reviewDraftIdFromPath(relativePath: string): string | null {
  const match = /^pending_review\/drafts\/([^/]+)(?:\/|$)/.exec(relativePath);
  return match?.[1] ?? null;
}

async function readExistingIngestPlanDraftId(root: string, relativePath: string): Promise<string | null> {
  if (!INGEST_PLAN_PATH_RE.test(relativePath)) return null;
  try {
    const raw = await fs.readFile(path.join(root, relativePath), "utf8");
    const parsed = JSON.parse(raw) as { draft_id?: unknown; draftId?: unknown };
    const draftId = parsed.draft_id ?? parsed.draftId;
    return typeof draftId === "string" && draftId.trim() ? draftId.trim() : null;
  } catch {
    return null;
  }
}

function workflowIdError(value: unknown, label: string): string | null {
  if (typeof value !== "string" || !value.trim()) return `${label} is required and must be a non-empty string.`;
  if (value !== value.trim()) return `${label} must not contain leading or trailing whitespace.`;
  if (!WORKFLOW_ID_RE.test(value)) return `${label} may only contain letters, numbers, dots, underscores, and dashes.`;
  if (value === "." || value === ".." || value.includes("..")) return `${label} cannot contain parent path segments.`;
  return null;
}

function validateIngestPlanWrite(relativePath: string, input: Record<string, unknown>): string | null {
  const pathMatch = INGEST_PLAN_PATH_RE.exec(relativePath);
  if (!pathMatch) return null;

  const filePlanId = pathMatch[1];
  const filePlanIdError = workflowIdError(filePlanId, "ingest plan filename");
  if (filePlanIdError) return `Invalid ingest plan: ${filePlanIdError}`;

  if (typeof input.content !== "string") return null;

  let parsed: { plan_id?: unknown; draft_id?: unknown; draftId?: unknown };
  try {
    parsed = JSON.parse(input.content) as { plan_id?: unknown; draft_id?: unknown; draftId?: unknown };
  } catch {
    return "Invalid ingest plan: ingest-plans/*.json must be valid JSON.";
  }

  const planId = parsed.plan_id;
  const draftId = parsed.draft_id ?? parsed.draftId;
  const planIdError = workflowIdError(planId, "plan_id");
  if (planIdError) return `Invalid ingest plan: ${planIdError}`;
  const draftIdError = workflowIdError(draftId, "draft_id");
  if (draftIdError) return `Invalid ingest plan: ${draftIdError}`;

  const planIdValue = planId as string;
  const draftIdValue = draftId as string;

  if (planIdValue !== filePlanId) {
    return `Invalid ingest plan: file path must be ingest-plans/${planIdValue}.json to match plan_id.`;
  }
  if (draftIdValue !== `ingest-${planIdValue}`) {
    return "Invalid ingest plan: draft_id must equal ingest-<plan_id>.";
  }
  return null;
}

function isTerminalIngestBatchStatus(status: string): boolean {
  return ["success", "completed", "done", "failed", "error"].includes(status);
}

function validateIngestPlanCompletionState(relativePath: string, content: string): string | null {
  if (!INGEST_PLAN_PATH_RE.test(relativePath)) return null;
  let parsed: { status?: unknown; batches?: unknown };
  try {
    parsed = JSON.parse(content) as { status?: unknown; batches?: unknown };
  } catch {
    return "Invalid ingest plan: ingest-plans/*.json must be valid JSON.";
  }

  if (String(parsed.status ?? "").toLowerCase() !== "completed") return null;
  if (!Array.isArray(parsed.batches)) return null;

  const pendingBatches = parsed.batches.flatMap((batch, index) => {
    const record = isRecord(batch) ? batch : {};
    const status = String(record.status ?? "pending").toLowerCase();
    if (isTerminalIngestBatchStatus(status)) return [];
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `batch-${index + 1}`;
    return [`${id}=${status}`];
  });
  if (!pendingBatches.length) return null;

  return [
    `Invalid ingest plan: status cannot be completed while batches are still pending: ${pendingBatches.join(", ")}.`,
    "Continue the first pending batch, mark each processed batch as success or failed, then set the top-level plan status to completed.",
  ].join(" ");
}

function applyTextReplacement(content: string, input: Record<string, unknown>): string | null {
  const oldString = typeof input.old_string === "string" ? input.old_string : null;
  const newString = typeof input.new_string === "string" ? input.new_string : null;
  if (oldString === null || newString === null || oldString === "") return null;
  if (!content.includes(oldString)) return null;
  if (input.replace_all === true) return content.split(oldString).join(newString);
  const index = content.indexOf(oldString);
  return `${content.slice(0, index)}${newString}${content.slice(index + oldString.length)}`;
}

async function candidateContentAfterWorkspaceWrite(root: string, relativePath: string, toolName: string, input: Record<string, unknown>): Promise<string | null> {
  if (toolName === "write") return typeof input.content === "string" ? input.content : null;
  if (toolName !== "edit" && toolName !== "multiedit") return null;

  let current: string;
  try {
    current = await fs.readFile(path.join(root, relativePath), "utf-8");
  } catch {
    return null;
  }

  if (toolName === "edit") return applyTextReplacement(current, input);
  const edits = Array.isArray(input.edits) ? input.edits : null;
  if (!edits) return null;
  let next = current;
  for (const edit of edits) {
    if (!isRecord(edit)) return null;
    const applied = applyTextReplacement(next, edit);
    if (applied === null) return null;
    next = applied;
  }
  return next;
}

async function repoIngestPlanToolWriteGateViolation(root: string, relativePath: string, toolName: string, input: Record<string, unknown>, trace?: WorkspaceRunTrace): Promise<string | null> {
  if (!INGEST_PLAN_PATH_RE.test(relativePath)) return null;
  const candidateContent = await candidateContentAfterWorkspaceWrite(root, relativePath, toolName, input);
  const planText = candidateContent ?? await readIngestPlanText(root, relativePath);
  const repoRoots = rawRepoRootsFromIngestPlanText(planText);
  if (!repoRoots.length) return hasReadCodingRepoIngestSkill(trace) ? nonRepoCodingSkillMessage(trace) : null;
  const classifications = (await Promise.all(repoRoots.map((repoRoot) => classifyRawRepoPath(root, repoRoot))))
    .filter((item): item is NonNullable<Awaited<ReturnType<typeof classifyRawRepoPath>>> => Boolean(item));
  const documentRepos = classifications.filter((item) => !item.isCodeRepo);
  if (documentRepos.length) return documentRepoGateMessage(documentRepos);
  return hasReadCodingRepoIngestSkill(trace) ? null : REPO_INGEST_SKILL_GATE_MESSAGE;
}

async function validateIngestPlanToolWrite(root: string, relativePath: string, toolName: string, input: Record<string, unknown>): Promise<string | null> {
  const message = validateIngestPlanWrite(relativePath, input);
  if (message) return message;
  const candidateContent = await candidateContentAfterWorkspaceWrite(root, relativePath, toolName, input);
  return candidateContent ? validateIngestPlanCompletionState(relativePath, candidateContent) : null;
}

async function ontologyLayerWriteGateViolation(relativePath: string, trace?: WorkspaceRunTrace): Promise<string | null> {
  if (!ONTOLOGY_LAYER_PATH_RE.test(relativePath)) return null;
  if (trace?.readEditOntologySkillPaths.size) return null;
  if (!hasReadOntologyDistillLayerSpec(relativePath, trace)) return ONTOLOGY_DISTILL_LAYER_SPEC_GATE_MESSAGE;
  return null;
}

async function ontologyLayerWholeWriteViolation(root: string, relativePath: string, toolName: string): Promise<string | null> {
  if (toolName !== "write") return null;
  if (!ONTOLOGY_LAYER_PATH_RE.test(relativePath)) return null;
  try {
    await fs.access(path.resolve(root, relativePath));
    return ONTOLOGY_LAYER_WHOLE_WRITE_MESSAGE;
  } catch {
    return null;
  }
}

async function ontologyLayerBashExistingWriteViolation(root: string, command: string): Promise<string | null> {
  const layerPaths = ontologyLayerWritePathsFromCommand(command);
  for (const layerPath of layerPaths) {
    try {
      await fs.access(path.resolve(root, layerPath));
      return ONTOLOGY_LAYER_WHOLE_WRITE_MESSAGE;
    } catch {
      continue;
    }
  }
  return null;
}

const INCOMPLETE_INGEST_META_MESSAGE = [
  "Blocked: this ingest draft looks incomplete and is not ready for Review.",
  "",
  "The meta.json you are trying to write declares an ingest operation, but its affected files only include source or root summary files such as knowledge/sources/*, knowledge/index.md, knowledge/overview.md, knowledge/glossary.md, knowledge/log.md, or knowledge/syntheses/*. This usually means the ingest extraction did not fully process the source material.",
  "",
  "Do not create a new ingest plan or a new sibling draft. Continue in the same draft.",
  "",
  "Re-read the active ingest plan and follow the owning ingest skill from the current workspace state. Re-process the planned source files and revise the existing draft content as needed. After the draft has been corrected, rerun Verify for this same draft. Only after Verify passes, write meta.json again.",
].join("\n");

function normalizeDraftMetaPath(value: string): string | null {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/").trim());
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function draftMetaPathArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeDraftMetaPath(item))
    .filter((item): item is string => Boolean(item));
}

function isNonSubstantiveIngestKnowledgePath(relativePath: string): boolean {
  return relativePath === "knowledge/index.md" ||
    relativePath === "knowledge/overview.md" ||
    relativePath === "knowledge/log.md" ||
    relativePath === "knowledge/glossary.md" ||
    relativePath.startsWith("knowledge/sources/") ||
    relativePath.startsWith("knowledge/syntheses/");
}

function hasSubstantiveIngestKnowledgePath(paths: readonly string[]): boolean {
  return paths.some((item) => item.startsWith("knowledge/") && item.toLowerCase().endsWith(".md") && !isNonSubstantiveIngestKnowledgePath(item));
}

function ingestMetaSubstantiveKnowledgeViolation(relativePath: string, input: Record<string, unknown>): string | null {
  const target = ingestDraftWriteTargetFromPath(relativePath);
  if (target?.kind !== "meta") return null;
  if (typeof input.content !== "string") return null;

  let parsed: { operation?: unknown; affected_files?: unknown; new_files?: unknown; modified_files?: unknown };
  try {
    parsed = JSON.parse(input.content) as { operation?: unknown; affected_files?: unknown; new_files?: unknown; modified_files?: unknown };
  } catch {
    return null;
  }

  if (parsed.operation !== "ingest") return null;
  const affectedFiles = [
    ...draftMetaPathArray(parsed.affected_files),
    ...draftMetaPathArray(parsed.new_files),
    ...draftMetaPathArray(parsed.modified_files),
  ];
  return hasSubstantiveIngestKnowledgePath([...new Set(affectedFiles)]) ? null : INCOMPLETE_INGEST_META_MESSAGE;
}

async function isExistingReviewReadyIngestPlan(root: string, relativePath: string, reviewReadyDraftIds: readonly string[]): Promise<boolean> {
  const draftId = await readExistingIngestPlanDraftId(root, relativePath);
  return Boolean(draftId && reviewReadyDraftIds.includes(draftId));
}

async function reviewLockPathViolation(root: string, relativePath: string, reviewReadyDraftIds: readonly string[]): Promise<string | null> {
  if (relativePath === "pending_review/drafts" || relativePath.startsWith("pending_review/drafts/")) {
    const draftId = reviewDraftIdFromPath(relativePath);
    if (!draftId || !reviewReadyDraftIds.includes(draftId)) return reviewLockMessage(reviewReadyDraftIds);
    return null;
  }
  if (relativePath === "ingest-plans" || relativePath.startsWith("ingest-plans/")) {
    if (await isExistingReviewReadyIngestPlan(root, relativePath, reviewReadyDraftIds)) return null;
    return reviewLockMessage(reviewReadyDraftIds);
  }
  if (isRootKnowledgePath(relativePath)) return reviewLockMessage(reviewReadyDraftIds);
  return null;
}

function isPendingReviewDraftPath(relativePath: string): boolean {
  const normalized = path.posix.normalize(relativePath);
  return normalized === "pending_review/drafts" || normalized.startsWith("pending_review/drafts/");
}

function isQuerySynthesisDraftPath(relativePath: string): boolean {
  const normalized = path.posix.normalize(relativePath);
  return normalized === "pending_review/drafts/query-" || normalized.startsWith("pending_review/drafts/query-");
}

const BASH_WRITE_INTENT_RE = /(?:^|[\s;|&])(?:cp|mv|rm|mkdir|touch|tee)\b|(?:^|[\s;|&])sed\s+-i\b|(?:^|[\s;|&])perl\s+-i\b|>|>>|\.write_text\s*\(|\.write_bytes\s*\(|\.write\s*\(|open\s*\([^)]*["']w|fs\.writeFile|writeFileSync|json\.dump\s*\(|\.mkdir\s*\(/i;

function commandHasWriteIntent(command: string): boolean {
  return BASH_WRITE_INTENT_RE.test(command);
}

function commandReferencesJourneyState(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  return /(^|[\s"'`(=])(?:\.\/)?\.runtime\/journey-state\.json(?=$|[\s"'`),;|&<>])/.test(normalized) ||
    (/journey-state\.json/.test(normalized) && /\.runtime/.test(normalized));
}

function commandReferencesIngestPlans(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  return /(^|[\s"'`(=])ingest-plans(?:\/|["'`)]|$)/.test(normalized) || /Path\(\s*["']ingest-plans["']\s*\)/.test(normalized);
}

function commandMayCompleteIngestPlan(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  return /["']status["']\s*:\s*["']completed["']/i.test(normalized) ||
    /(?:\bstatus|\.status|\[['"]status['"]\])\s*=\s*["']completed["']/i.test(normalized);
}

function ontologyLayerWritePathsFromCommand(command: string): string[] {
  const normalized = command.replace(/\\/g, "/");
  const paths = new Set<string>();
  const layerPath = String.raw`(ontology\/(?:object-model|source-mappings|actions|business-rules|permissions|functions)\.yaml)`;
  const patterns = [
    new RegExp(String.raw`(?:>|>>)\s*["']?${layerPath}\b`, "g"),
    new RegExp(String.raw`(?:^|[\s;|&])tee\s+["']?${layerPath}\b`, "g"),
    new RegExp(String.raw`Path\(\s*["']${layerPath}["']\s*\)\.write(?:_text|_bytes)?\s*\(`, "g"),
    new RegExp(String.raw`open\(\s*["']${layerPath}["'][^)]*["']w`, "g"),
    new RegExp(String.raw`writeFileSync\(\s*["']${layerPath}["']`, "g"),
    new RegExp(String.raw`fs\.writeFile\(\s*["']${layerPath}["']`, "g"),
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized))) paths.add(match[1]);
  }
  if (commandHasWriteIntent(normalized)) {
    const anyLayerPath = new RegExp(layerPath, "g");
    let match: RegExpExecArray | null;
    while ((match = anyLayerPath.exec(normalized))) paths.add(match[1]);
  }
  return [...paths];
}

function commandWritesOntologyLayer(command: string): boolean {
  return ontologyLayerWritePathsFromCommand(command).length > 0;
}

function ontologyInstanceWritePathsFromCommand(command: string): string[] {
  const normalized = command.replace(/\\/g, "/");
  const paths = new Set<string>();
  const instancePath = String.raw`(ontology\/object-instances\.ya?ml)`;
  const patterns = [
    new RegExp(String.raw`(?:>|>>)\s*["']?${instancePath}\b`, "g"),
    new RegExp(String.raw`(?:^|[\s;|&])tee\s+["']?${instancePath}\b`, "g"),
    new RegExp(String.raw`Path\(\s*["']${instancePath}["']\s*\)\.write(?:_text|_bytes)?\s*\(`, "g"),
    new RegExp(String.raw`open\(\s*["']${instancePath}["'][^)]*["']w`, "g"),
    new RegExp(String.raw`writeFileSync\(\s*["']${instancePath}["']`, "g"),
    new RegExp(String.raw`fs\.writeFile\(\s*["']${instancePath}["']`, "g"),
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized))) paths.add(match[1]);
  }
  return [...paths];
}

function commandWritesOntologyInstance(command: string): boolean {
  return ontologyInstanceWritePathsFromCommand(command).length > 0;
}

function commandWritesOntologyScenarioCards(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  if (!commandHasWriteIntent(normalized)) return false;
  return /(^|[\s"'`(=])(?:\.\/|\/[^\s"'`),;|&<>]+\/)?ontology\/artifacts\/scenario-cards\.json(?=$|[\s"'`),;|&<>])/.test(normalized) ||
    /Path\(\s*["'][^"']*ontology\/artifacts\/scenario-cards\.json["']\s*\)/.test(normalized);
}

function commandWritesOntologyInstanceGleaningState(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  if (!commandHasWriteIntent(normalized)) return false;
  return /(^|[\s"'`(=])(?:\.\/|\/[^\s"'`),;|&<>]+\/)?ontology\/artifacts\/instance-gleaning-state\.json(?=$|[\s"'`),;|&<>])/.test(normalized) ||
    /Path\(\s*["'][^"']*ontology\/artifacts\/instance-gleaning-state\.json["']\s*\)/.test(normalized);
}

function ingestPlanPathsFromCommand(command: string): string[] {
  const normalized = command.replace(/\\/g, "/");
  const paths = new Set<string>();
  const re = /ingest-plans\/([^\s"'`<>|;&]+\.json)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized))) paths.add(`ingest-plans/${match[1]}`);
  return [...paths];
}

async function repoIngestPlanBashGateViolation(root: string, command: string, trace?: WorkspaceRunTrace): Promise<string | null> {
  if (!commandHasWriteIntent(command) || !commandReferencesIngestPlans(command)) return null;
  const repoRoots = new Set<string>();
  if (commandTextReferencesRawRepos(command)) {
    for (const repoRoot of rawRepoRootsFromText(command)) repoRoots.add(repoRoot);
  }
  for (const planPath of ingestPlanPathsFromCommand(command)) {
    const planText = await readIngestPlanText(root, planPath);
    for (const repoRoot of rawRepoRootsFromIngestPlanText(planText)) repoRoots.add(repoRoot);
  }
  if (!repoRoots.size) return hasReadCodingRepoIngestSkill(trace) ? nonRepoCodingSkillMessage(trace) : null;
  const classifications = (await Promise.all([...repoRoots].map((repoRoot) => classifyRawRepoPath(root, repoRoot))))
    .filter((item): item is NonNullable<Awaited<ReturnType<typeof classifyRawRepoPath>>> => Boolean(item));
  const documentRepos = classifications.filter((item) => !item.isCodeRepo);
  if (documentRepos.length) return documentRepoGateMessage(documentRepos);
  return hasReadCodingRepoIngestSkill(trace) ? null : REPO_INGEST_SKILL_GATE_MESSAGE;
}

function commandReferencesReviewDrafts(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  return /pending_review\/drafts/.test(normalized);
}

function commandReferencesQuerySynthesisDraft(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  return /pending_review\/drafts\/query-[^/\s"'`<>|;&)]*/.test(normalized);
}

function commandReferencesRootKnowledge(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  return /Path\(\s*["']knowledge(?:\/|["'])/.test(normalized) ||
    /open\(\s*["']knowledge\//.test(normalized) ||
    /(?:>|>>)\s*["']?knowledge\//.test(normalized) ||
    /(?:^|[\s;|&])(?:cp|mv|rm|mkdir|touch|tee|cat)\b[^\n;|&]*\s["']?knowledge\//.test(normalized);
}

function commandReferencesVerifyArtifacts(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  return /(^|[\s"'`(=])verify(?:\/|["'`)]|$)/.test(normalized) || /Path\(\s*["']verify["']\s*\)/.test(normalized);
}

function canBypassWorkflowLockForPendingReviewDraftCommand(command: string): boolean {
  if (!commandHasWriteIntent(command)) return false;
  if (!commandReferencesReviewDrafts(command)) return false;
  if (commandReferencesRootKnowledge(command)) return false;
  if (commandReferencesIngestPlans(command)) return false;
  if (commandReferencesVerifyArtifacts(command)) return false;
  return true;
}

function reviewDraftIdsFromCommand(command: string): string[] {
  const normalized = command.replace(/\\/g, "/");
  const ids = new Set<string>();
  const re = /pending_review\/drafts\/([^/\s"'`]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized))) ids.add(match[1]);
  return [...ids];
}

function expectedIngestPlanPathForDraft(draftId: string): string {
  return draftId.startsWith("ingest-")
    ? `ingest-plans/${draftId.slice("ingest-".length)}.json`
    : "the matching ingest plan";
}

function siblingDraftWriteMessage(activeDraft: { draftId: string; draftPath: string }, attemptedDraftId: string): string {
  const base = [
    `An existing draft is already active at ${activeDraft.draftPath}.`,
    `Do not create or edit sibling draft ${attemptedDraftId}.`,
    "Only edit the existing draft if the user explicitly asked to revise that draft.",
    "Do not use an existing draft as the target for a new ingest or formal knowledge edit.",
  ];
  if (activeDraft.draftId.startsWith("ingest-") && attemptedDraftId.startsWith("ingest-")) {
    base.push(
      `Continue the existing ingest workflow first for ${activeDraft.draftId}:`,
      `- Re-read ${expectedIngestPlanPathForDraft(activeDraft.draftId)}.`,
      `- Keep writing only under ${activeDraft.draftPath}/knowledge/.`,
      "- Finish Verify and Review for the existing draft before starting another ingest.",
    );
  } else {
    base.push("If this is new ingest or formal knowledge edit work, stop and ask the user to approve or discard pending Review drafts first.");
  }
  return base.join(" ");
}

function siblingDraftFromCommand(activeDraft: { draftId: string; draftPath: string } | null, command: string): string | null {
  if (!activeDraft || !commandHasWriteIntent(command) || !commandReferencesReviewDrafts(command)) return null;
  const siblingId = reviewDraftIdsFromCommand(command).find((draftId) => draftId !== activeDraft.draftId);
  return siblingId ? siblingDraftWriteMessage(activeDraft, siblingId) : null;
}

function commandTargetsOnlyReviewReadyDrafts(command: string, reviewReadyDraftIds: readonly string[]): boolean {
  const draftIds = reviewDraftIdsFromCommand(command);
  return Boolean(draftIds.length) && draftIds.every((draftId) => reviewReadyDraftIds.includes(draftId));
}

function commandReferencesIngestDraft(command: string): boolean {
  return /pending_review\/drafts\/ingest-/.test(command.replace(/\\/g, "/"));
}

function ingestDraftWriteTargetsFromCommand(command: string): IngestDraftWriteTarget[] {
  const normalized = command.replace(/\\/g, "/");
  const targets = new Map<string, IngestDraftWriteTarget>();
  const re = /pending_review\/drafts\/(ingest-[^/\s"'`<>|;&)]+)(?:\/([^\s"'`<>|;&)]*))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized))) {
    const relativePath = `pending_review/drafts/${match[1]}${match[2] ? `/${match[2]}` : ""}`;
    const target = ingestDraftWriteTargetFromPath(relativePath);
    if (target) targets.set(`${target.draftId}:${target.kind}`, target);
  }
  return [...targets.values()];
}

async function ingestDraftBashGateViolation(root: string, command: string, trace?: WorkspaceRunTrace): Promise<string | null> {
  if (!commandHasWriteIntent(command) || !commandReferencesIngestDraft(command)) return null;
  const targets = ingestDraftWriteTargetsFromCommand(command);
  let checked = false;
  for (const target of targets) {
    if (target.kind !== "content" && target.kind !== "meta") continue;
    checked = true;
    const repoGateMessage = await repoIngestDraftSkillGateViolation(root, target.draftId, trace);
    if (repoGateMessage) return repoGateMessage;
    try {
      if (target.kind === "content") await assertMatchingIngestPlanForDraft(root, target.draftId);
      if (target.kind === "meta") await assertIngestMetaArtifactsForWrite(root, target.draftId);
    } catch (err) {
      return errorText(err);
    }
  }
  if (checked) return null;
  return "Bash write commands touching pending_review/drafts/ingest-* must use an explicit pending_review/drafts/ingest-*/knowledge/... or pending_review/drafts/ingest-*/meta.json path so the ingest gate can validate it. Use Write/Edit or an explicit workspace-relative path.";
}

async function commandReferencesOnlyReviewReadyIngestPlans(root: string, command: string, reviewReadyDraftIds: readonly string[]): Promise<boolean> {
  const planPaths = ingestPlanPathsFromCommand(command);
  if (!planPaths.length) return false;
  const allowed = await Promise.all(planPaths.map((planPath) => isExistingReviewReadyIngestPlan(root, planPath, reviewReadyDraftIds)));
  return allowed.every(Boolean);
}

async function reviewLockBashViolation(root: string, command: string, reviewReadyDraftIds: readonly string[]): Promise<string | null> {
  if (!commandHasWriteIntent(command)) return null;
  if (commandReferencesRootKnowledge(command)) return reviewLockMessage(reviewReadyDraftIds);
  if (commandReferencesIngestPlans(command) && !(await commandReferencesOnlyReviewReadyIngestPlans(root, command, reviewReadyDraftIds))) {
    return reviewLockMessage(reviewReadyDraftIds);
  }
  if (!commandReferencesReviewDrafts(command)) return null;
  const draftIds = reviewDraftIdsFromCommand(command);
  if (!draftIds.length) return reviewLockMessage(reviewReadyDraftIds);
  return draftIds.every((draftId) => reviewReadyDraftIds.includes(draftId)) ? null : reviewLockMessage(reviewReadyDraftIds);
}

function commandReferencesWorkspaceAbsolutePath(command: string, workspaceRoots: string[]): boolean {
  const normalizedCommand = command.replace(/\\/g, "/");
  const roots = [
    env.workspaceRoot,
    ...workspaceRoots,
  ].map((root) => path.resolve(root).replace(/\\/g, "/"));
  return roots.some((root) => normalizedCommand.includes(root)) ||
    /(^|[\s"'`=])\/[^\s"'`]*ontology-workspaces\//.test(normalizedCommand);
}

interface WorkspaceToolUseValidation {
  message?: string;
  updatedInput?: Record<string, unknown>;
}

interface WorkspaceRunContext {
  tenantId: string;
  ownerId: string;
  ontologyId: string;
  sessionId: string;
  runId?: string;
  userRequest: string;
  locale?: "zh" | "en" | "ja";
  ontologySync?: OntologySyncRunContext;
}

function workflowLockConflictMessage(lock: WorkflowLockRecord | null, locale: WorkspaceRunContext["locale"]): string {
  const holder = lock?.sessionId ? ` (${lock.sessionId})` : "";
  switch (locale) {
    case "en":
      return `This knowledge base is already running a write workflow in another session${holder}. Wait for the current Review to be approved or discarded before starting another ingest or edit.`;
    case "ja":
      return `このナレッジベースでは別のセッション${holder}で書き込みワークフローが実行中です。現在の Review を承認または破棄してから、別のインポートや編集を開始してください。`;
    default:
      return `当前知识库正在另一个会话${holder}中执行写入工作流。请先完成当前 Review 的 approve 或 discard，再开始新的导入或编辑。`;
  }
}

async function ensureWorkflowWriteLock(root: string, context: WorkspaceRunContext | undefined, phase: WorkflowLockPhase): Promise<string | null> {
  if (!context?.runId) return null;
  const result = await acquireWorkflowLock(root, {
    ontologyId: context.ontologyId,
    sessionId: context.sessionId,
    runId: context.runId,
    workflow: "ingest",
    phase,
  });
  return result.acquired ? null : workflowLockConflictMessage(result.lock, context.locale);
}

function workflowWritePhaseFromRelativePath(relativePath: string): WorkflowLockPhase | null {
  const ingestDraftTarget = ingestDraftWriteTargetFromPath(relativePath);
  if (ingestDraftTarget?.kind === "content") return "ingest";
  if (ingestDraftTarget?.kind === "meta") return "review";
  if (relativePath === "ingest-plans" || relativePath.startsWith("ingest-plans/")) return "ingest";
  if (relativePath === "verify" || relativePath.startsWith("verify/")) return "verify";
  if (relativePath === "pending_review/drafts" || relativePath.startsWith("pending_review/drafts/")) return "review";
  return null;
}

function workflowWritePhaseFromCommand(command: string): WorkflowLockPhase | null {
  if (!commandHasWriteIntent(command)) return null;
  const normalized = command.replace(/\\/g, "/");
  const ingestDraftTargets = ingestDraftWriteTargetsFromCommand(normalized);
  if (ingestDraftTargets.some((target) => target.kind === "meta")) return "review";
  if (ingestDraftTargets.some((target) => target.kind === "content")) return "ingest";
  if (commandReferencesIngestPlans(normalized)) return "ingest";
  if (commandReferencesVerifyArtifacts(normalized)) return "verify";
  if (commandReferencesReviewDrafts(normalized)) return "review";
  return null;
}

export async function validateWorkspaceToolUse(root: string, toolName: string, input: Record<string, unknown>, context?: WorkspaceRunContext, trace?: WorkspaceRunTrace): Promise<WorkspaceToolUseValidation | null> {
  const normalizedToolName = toolName.toLowerCase();
  const rootResolved = path.resolve(root);
  const canonicalRoot = await fs.realpath(rootResolved).catch(() => rootResolved);
  if (
    normalizedToolName === "agent" &&
    input.subagent_type !== "knowledge-qa-batch"
  ) {
    return {
      message: "Sub-agents are disabled in this workspace. Continue the workflow in the main agent. Only knowledge-qa-batch is allowed for Verify.",
    };
  }
  if (
    normalizedToolName === "agent" &&
    input.subagent_type === "knowledge-qa-batch" &&
    (input.isolation === "worktree" || input.isolation === "remote")
  ) {
    return {
      message: [
        "knowledge-qa-batch must run in the current ontology workspace cwd.",
        "Do not set Agent isolation to worktree or remote.",
        "Re-run the knowledge-qa-batch Agent without isolation, using workspace-relative verify/... and pending_review/... paths.",
      ].join(" "),
    };
  }
  if (normalizedToolName === "bash" && typeof input.command === "string" && commandReferencesWorkspaceAbsolutePath(input.command, [rootResolved, canonicalRoot])) {
    return { message: "Bash commands must use workspace-relative paths when touching ontology workspace files. Do not use /app/data/... or ontology-workspaces absolute paths." };
  }
  if (normalizedToolName === "bash" && typeof input.command === "string") {
    const materialMessage = ontologySyncMaterialBashViolation(input.command, context);
    if (materialMessage) return { message: materialMessage };
  }
  if (normalizedToolName === "bash" && typeof input.command === "string" && commandHasWriteIntent(input.command) && commandReferencesJourneyState(input.command)) {
    return { message: JOURNEY_STATE_WRITE_MESSAGE };
  }
  if (normalizedToolName === "bash" && typeof input.command === "string") {
    const repoGateMessage = await repoIngestPlanBashGateViolation(rootResolved, input.command, trace);
    if (repoGateMessage) return { message: repoGateMessage };
  }
  if (
    normalizedToolName === "bash" &&
    typeof input.command === "string" &&
    commandHasWriteIntent(input.command) &&
    commandReferencesIngestPlans(input.command) &&
    !hasReadIngestSkill(trace)
  ) {
    return { message: INGEST_SKILL_GATE_MESSAGE };
  }
  if (
    normalizedToolName === "bash" &&
    typeof input.command === "string" &&
    commandHasWriteIntent(input.command) &&
    commandReferencesIngestPlans(input.command) &&
    commandMayCompleteIngestPlan(input.command)
  ) {
    return {
      message: [
        "Do not use Bash to mark ingest-plans/*.json as completed.",
        "Use Write/Edit/MultiEdit so the ingest plan gate can verify that every batch is success or failed before the top-level plan status becomes completed.",
      ].join(" "),
    };
  }
  if (
    normalizedToolName === "bash" &&
    typeof input.command === "string" &&
    commandWritesOntologyScenarioCards(input.command)
  ) {
    return { message: ONTOLOGY_SCENARIO_CARDS_WRITE_MESSAGE };
  }
  if (
    normalizedToolName === "bash" &&
    typeof input.command === "string" &&
    commandWritesOntologyInstanceGleaningState(input.command)
  ) {
    return { message: ONTOLOGY_INSTANCE_GLEANING_WRITE_MESSAGE };
  }
  if (
    normalizedToolName === "bash" &&
    typeof input.command === "string" &&
    (commandWritesOntologyLayer(input.command) || commandWritesOntologyInstance(input.command) || commandWritesOntologyScenarioCards(input.command)) &&
    !(await hasReadOntologyEditingSkillForGate(rootResolved, context, trace))
  ) {
    return { message: ONTOLOGY_DISTILL_SKILL_GATE_MESSAGE };
  }
  if (
    normalizedToolName === "bash" &&
    typeof input.command === "string" &&
    commandWritesOntologyLayer(input.command)
  ) {
    const message = await ontologyLayerBashExistingWriteViolation(rootResolved, input.command);
    if (message) return { message };
  }
  if (
    normalizedToolName === "bash" &&
    typeof input.command === "string" &&
    commandWritesOntologyLayer(input.command)
  ) {
    const layerPaths = ontologyLayerWritePathsFromCommand(input.command);
    for (const layerPath of layerPaths) {
      const message = await ontologyLayerWriteGateViolation(layerPath, trace);
      if (message) return { message };
    }
  }
  const reviewReadyDraftIds = WORKSPACE_WRITE_TOOLS.has(normalizedToolName) || normalizedToolName === "bash"
    ? await listReviewReadyDraftIds(rootResolved).catch(() => [])
    : [];
  const reviewLocked = reviewReadyDraftIds.length > 0;
  const bypassPendingReviewDraftBash = normalizedToolName === "bash" && typeof input.command === "string" &&
    reviewLocked &&
    canBypassWorkflowLockForPendingReviewDraftCommand(input.command) &&
    commandTargetsOnlyReviewReadyDrafts(input.command, reviewReadyDraftIds);
  if (
    normalizedToolName === "bash" &&
    typeof input.command === "string" &&
    commandHasWriteIntent(input.command) &&
    commandReferencesQuerySynthesisDraft(input.command)
  ) {
    return { message: QUERY_SYNTHESIS_DRAFT_WRITE_MESSAGE };
  }
  const activeDraft = WORKSPACE_WRITE_TOOLS.has(normalizedToolName) ||
    (normalizedToolName === "bash" && typeof input.command === "string" && commandHasWriteIntent(input.command) && commandReferencesReviewDrafts(input.command))
    ? await readActiveReviewDraftContext(rootResolved).catch(() => null)
    : null;
  if (normalizedToolName === "bash" && typeof input.command === "string") {
    const message = siblingDraftFromCommand(activeDraft, input.command);
    if (message) return { message };
  }
  if (normalizedToolName === "bash" && typeof input.command === "string") {
    if (!bypassPendingReviewDraftBash) {
      const message = await ingestDraftBashGateViolation(rootResolved, input.command, trace);
      if (message) return { message };
    }
  }
  if (normalizedToolName === "bash" && typeof input.command === "string") {
    const phase = workflowWritePhaseFromCommand(input.command);
    if (phase && !bypassPendingReviewDraftBash) {
      const lockMessage = await ensureWorkflowWriteLock(rootResolved, context, phase);
      if (lockMessage) return { message: lockMessage };
    }
  }
  if (reviewLocked && normalizedToolName === "bash" && typeof input.command === "string") {
    const message = await reviewLockBashViolation(rootResolved, input.command, reviewReadyDraftIds);
    if (message) return { message };
  }
  let updatedInput: Record<string, unknown> | null = null;
  for (const { key, value: raw } of collectToolPathEntries(input)) {
    const rawIsAbsolute = isAbsoluteToolPath(raw);
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName) && !rawIsAbsolute) {
      if (!workspaceRelativeToolPath(raw)) return { message: `${toolName} path escapes ontology workspace: ${raw}` };
    }
    const resolved = rawIsAbsolute ? path.resolve(raw) : path.resolve(rootResolved, raw);
    const comparisonPath = resolved === rootResolved || resolved.startsWith(`${rootResolved}${path.sep}`)
      ? path.join(canonicalRoot, path.relative(rootResolved, resolved))
      : resolved;
    if (comparisonPath !== canonicalRoot && !comparisonPath.startsWith(`${canonicalRoot}${path.sep}`)) {
      return { message: `${toolName} path is outside the current ontology workspace cwd: ${raw}. Use only workspace-relative paths inside the current cwd, such as verify/..., pending_review/..., knowledge/..., raw/....` };
    }
    const relativePath = relativeWorkspacePath(canonicalRoot, comparisonPath);
    const materialMessage = ontologySyncMaterialViolation(relativePath, context);
    if (materialMessage) return { message: materialMessage };
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName) && isOntologyUpdateMaterialsPath(relativePath)) {
      return { message: "Do not modify ontology-update-materials/. Read the current run material package only." };
    }
    if (normalizedToolName === "read") {
      const message = codingRepoSkillReadViolation(relativePath, trace);
      if (message) return { message };
    }
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName) && isQuerySynthesisDraftPath(relativePath)) {
      return { message: QUERY_SYNTHESIS_DRAFT_WRITE_MESSAGE };
    }
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName) && INGEST_PLAN_PATH_RE.test(relativePath) && !hasReadIngestSkill(trace)) {
      const repoGateMessage = await repoIngestPlanToolWriteGateViolation(rootResolved, relativePath, normalizedToolName, input, trace);
      if (repoGateMessage) return { message: repoGateMessage };
      return { message: INGEST_SKILL_GATE_MESSAGE };
    }
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName) && INGEST_PLAN_PATH_RE.test(relativePath)) {
      const repoGateMessage = await repoIngestPlanToolWriteGateViolation(rootResolved, relativePath, normalizedToolName, input, trace);
      if (repoGateMessage) return { message: repoGateMessage };
    }
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName) && path.posix.normalize(relativePath) === ONTOLOGY_SCENARIO_CARDS_PATH) {
      return { message: ONTOLOGY_SCENARIO_CARDS_WRITE_MESSAGE };
    }
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName) && path.posix.normalize(relativePath) === ONTOLOGY_INSTANCE_GLEANING_PATH) {
      return { message: ONTOLOGY_INSTANCE_GLEANING_WRITE_MESSAGE };
    }
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName) && isOntologyDistillOutputPath(relativePath) && !(await hasReadOntologyEditingSkillForGate(rootResolved, context, trace))) {
      return { message: ONTOLOGY_DISTILL_SKILL_GATE_MESSAGE };
    }
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName) && ONTOLOGY_LAYER_PATH_RE.test(relativePath)) {
      const wholeWriteMessage = await ontologyLayerWholeWriteViolation(rootResolved, relativePath, normalizedToolName);
      if (wholeWriteMessage) return { message: wholeWriteMessage };
      const message = await ontologyLayerWriteGateViolation(relativePath, trace);
      if (message) return { message };
    }
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName)) {
      const message = await ingestDraftWriteGateViolation(rootResolved, relativePath, trace);
      if (message) return { message };
    }
    if (normalizedToolName === "write") {
      const message = ingestMetaSubstantiveKnowledgeViolation(relativePath, input);
      if (message) return { message };
    }
    const workflowPhase = WORKSPACE_WRITE_TOOLS.has(normalizedToolName) ? workflowWritePhaseFromRelativePath(relativePath) : null;
    if (workflowPhase) {
      const bypassWorkflowLock = isPendingReviewDraftPath(relativePath);
      if (!bypassWorkflowLock) {
        const lockMessage = await ensureWorkflowWriteLock(rootResolved, context, workflowPhase);
        if (lockMessage) return { message: lockMessage };
      }
    }
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName)) {
      const ingestPlanMessage = await validateIngestPlanToolWrite(rootResolved, relativePath, normalizedToolName, input);
      if (ingestPlanMessage) return { message: ingestPlanMessage };
    }
    if (DIRECT_KNOWLEDGE_WRITE_TOOLS.has(normalizedToolName) && isRootKnowledgePath(relativePath)) {
      return { message: "Direct writes to knowledge/ are not allowed. Read and follow skills/knowledge-edit/SKILL.md." };
    }
    if (WORKSPACE_WRITE_TOOLS.has(normalizedToolName) && isJourneyStatePath(relativePath)) {
      return { message: JOURNEY_STATE_WRITE_MESSAGE };
    }
    if (reviewLocked && WORKSPACE_WRITE_TOOLS.has(normalizedToolName)) {
      const message = await reviewLockPathViolation(rootResolved, relativePath, reviewReadyDraftIds);
      if (message) return { message };
    }
    if (WORKSPACE_PATH_TOOLS.has(normalizedToolName) && rawIsAbsolute) {
      updatedInput ??= { ...input };
      updatedInput[key] = relativePath || ".";
    }
    const draftMatch = /^pending_review\/drafts\/([^/]+)(?:\/|$)/.exec(relativePath);
    if (activeDraft && draftMatch && draftMatch[1] !== activeDraft.draftId) {
      return {
        message: siblingDraftWriteMessage(activeDraft, draftMatch[1]),
      };
    }
  }
  return updatedInput ? { updatedInput } : null;
}

function createWorkspacePreToolUseHook(cwd: string, context: WorkspaceRunContext, trace: WorkspaceRunTrace): HookCallback {
  const root = path.resolve(cwd);
  return async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") return { continue: true };
    const input = isRecord(hookInput.tool_input) ? hookInput.tool_input : {};
    const validation = await validateWorkspaceToolUse(root, hookInput.tool_name, input, context, trace);
    if (!validation) return { continue: true };
    if (validation.updatedInput) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: validation.updatedInput,
        },
      };
    }
    const message = validation.message ?? "Tool use is not allowed in this ontology workspace.";
    return {
      continue: false,
      stopReason: message,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    };
  };
}

function createWorkspacePostToolUseHook(cwd: string, context: WorkspaceRunContext, trace: WorkspaceRunTrace): HookCallback {
  const root = path.resolve(cwd);
  return async (hookInput) => {
    if (hookInput.hook_event_name !== "PostToolUse") return { continue: true };
    if (hookInput.tool_name.toLowerCase() !== "read") return { continue: true };
    const input = isRecord(hookInput.tool_input) ? hookInput.tool_input : {};
    recordIngestSkillRead(root, input, trace);
    recordOperateSkillRead(root, input, trace);
    recordOntologyDistillSkillRead(root, input, trace);
    recordEditOntologySkillRead(root, input, trace);
    recordOntologyDistillLayerSpecRead(root, input, trace);
    await persistOntologyEditingSkillRead(root, input, context);
    return { continue: true };
  };
}

function* textChunks(text: string): Generator<string> {
  const parts = text.match(/(.|\n){1,120}/g) ?? [text];
  for (const part of parts) yield part;
}

function reviewRecoverySyncPrompt(locale: ClaudeReviewStateSyncInput["locale"], recovery?: ReviewRecoverySyncContext): string {
  const draftIds = (recovery?.draftIds ?? []).filter(Boolean);
  const draftList = draftIds.length ? draftIds.map((draftId) => `- ${draftId}`).join("\n") : "- Unknown recovered draft";
  const archiveLine = recovery?.recoveryPath ? `\nArchived recovery path: ${recovery.recoveryPath}` : "";
  const manifestLine = recovery?.manifestPath ? `\nRecovery manifest: ${recovery.manifestPath}` : "";

  switch (locale) {
    case "en":
      return [
        "I just used the app's Review recovery action to cancel and discard the current abnormal pending Review state.",
        "The backend has archived and discarded the recovered Review draft artifacts, marked review as discarded, and released the workflow lock.",
        "These drafts are no longer pending Review and were not approved into the knowledge base:",
        draftList,
        archiveLine.trim(),
        manifestLine.trim(),
        "Please update your session state: do not continue the previous ingest, verify, or review flow, and do not say the old draft is still waiting for approval.",
        "If I ask to import the same material again, re-check the current workspace state instead of relying on the old pending-review memory.",
        "Briefly reply that you understand and are ready for the next task.",
      ].filter(Boolean).join("\n");
    case "ja":
      return [
        "アプリの Review 復旧操作で、現在の異常な Review 待ち状態をキャンセルして破棄しました。",
        "バックエンドは復旧対象の Review draft artifacts をアーカイブして破棄し、review を discarded にし、workflow lock を解除しました。",
        "以下の draft はもう Review 待ちではなく、知識ベースへ承認・書き込みされていません:",
        draftList,
        archiveLine.trim(),
        manifestLine.trim(),
        "セッション状態を更新してください。前回の ingest、verify、review フローを継続せず、古い draft がまだ承認待ちだとは言わないでください。",
        "同じ資料の導入を再度依頼された場合は、古い Review 待ちの記憶に頼らず、現在の workspace 状態を確認してください。",
        "理解したことと、次のタスクを受け取る準備ができていることだけを簡単に返してください。",
      ].filter(Boolean).join("\n");
    default:
      return [
        "我刚才在应用的 Review 面板执行了恢复操作：取消并放弃当前异常的待审核状态。",
        "后端已经归档并丢弃这些恢复出来的 Review 草稿产物，将 review 标记为 discarded，并释放了 workflow lock。",
        "以下 draft 已不再处于待审核状态，也没有被用户批准写入知识库：",
        draftList,
        archiveLine.trim(),
        manifestLine.trim(),
        "请更新你对当前会话的状态：不要继续上一轮 ingest、verify 或 review 流程，也不要再说旧草稿仍在等待审核。",
        "如果我再次要求导入同一批资料，请重新基于当前 workspace 状态判断，不要依赖旧的 pending review 记忆。",
        "你只要简单回复一下你已经知道了，并且准备好接收新任务就好了。",
      ].filter(Boolean).join("\n");
  }
}

function reviewStateSyncPrompt(action: ReviewStateSyncAction, locale: ClaudeReviewStateSyncInput["locale"], input?: Pick<ClaudeReviewStateSyncInput, "reason" | "recovery">): string {
  if (input?.reason === "recovery" && action === "discarded") {
    return reviewRecoverySyncPrompt(locale, input.recovery);
  }
  switch (locale) {
    case "en":
      return action === "approved"
        ? "I have approved all current pending review changes in the app, so this round is finished. Please wait for my next task. Just briefly reply that you understand and are ready for the next task."
        : "I have discarded all current pending review changes in the app, so this round is finished. Please wait for my next task. Just briefly reply that you understand and are ready for the next task.";
    case "ja":
      return action === "approved"
        ? "アプリで現在のレビュー待ち変更をすべて承認しました。このラウンドは終了です。次のタスクまで待っていてください。理解したことと、次のタスクを受け取る準備ができていることだけを簡単に返してください。"
        : "アプリで現在のレビュー待ち変更をすべて破棄しました。このラウンドは終了です。次のタスクまで待っていてください。理解したことと、次のタスクを受け取る準備ができていることだけを簡単に返してください。";
    default:
      return action === "approved"
        ? "我已经在应用里同意了当前所有待审核变更，这一轮已经结束了。接下来请等我的新任务，你只要简单回复一下你已经知道了，并且准备好接收新任务就好了。"
        : "我已经在应用里丢弃了当前所有待审核变更，这一轮已经结束了。接下来请等我的新任务，你只要简单回复一下你已经知道了，并且准备好接收新任务就好了。";
  }
}

export async function syncClaudeReviewState(input: ClaudeReviewStateSyncInput): Promise<string | null> {
  if (!env.enableClaudeRuntime || !input.resume) return null;

  const claudeConfigDir = path.join(env.claudeConfigRoot, "tenants", input.tenantId, "users", input.userId);
  await fs.mkdir(claudeConfigDir, { recursive: true });
  await inheritLocalClaudeAuth(claudeConfigDir);
  const sdkEnv = buildClaudeSdkEnv(claudeConfigDir);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(new Error("Claude review state sync timed out")), input.timeoutMs ?? 8_000);
  let claudeSessionId = input.resume;

  try {
    const sdkQuery = query({
      prompt: reviewStateSyncPrompt(input.action, input.locale, input),
      options: {
        cwd: input.cwd,
        resume: input.resume,
        abortController,
        sessionStore: createClaudeSessionStore({ tenantId: input.tenantId, ontologyId: input.ontologyId, appSessionId: input.appSessionId }),
        sessionStoreFlush: "eager",
        settingSources: ["project"],
        tools: [],
        allowedTools: [],
        disallowedTools: ["Agent", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "LSP", "mcp__*"],
        includePartialMessages: false,
        maxTurns: 3,
        env: sdkEnv,
      },
    });

    for await (const message of sdkQuery) {
      if ("session_id" in message && typeof message.session_id === "string") claudeSessionId = message.session_id;
    }

    console.log(`[chat/review-sync] synced review ${input.action}${input.reason ? `/${input.reason}` : ""} state into claude session appSessionId=${input.appSessionId}`);
    return claudeSessionId;
  } finally {
    clearTimeout(timeout);
  }
}

async function* fallbackStream(input: ClaudeRunInput): AsyncGenerator<OntologyStreamEvent> {
  const claudeSessionId = input.resume ?? `local-${randomUUID()}`;
  const text = input.ontologySync
    ? `Ontology sync was queued for material package ${input.ontologySync.materialRoot}.\n\nThis development fallback keeps the API/session/workspace path active. Set ONTOLOGY_ENABLE_CLAUDE=true with Claude credentials to execute the same workspace through Claude Agent SDK.`
    : `I updated the ontology workspace for: "${input.prompt}".\n\nThis development fallback keeps the API/session/workspace path active. Set ONTOLOGY_ENABLE_CLAUDE=true with Claude credentials to execute the same workspace through Claude Agent SDK.`;
  if (!input.ontologySync && !input.readOnly) await appendWikiNote(input.cwd, input.prompt, text);
  for (const delta of textChunks(text)) yield { type: "text-delta", delta };

  const current = await readJourneyState(input.cwd);
  const journeyState: JourneyState = input.readOnly ? current : {
    ...current,
    flow: "maintenance",
    phase: "ready",
    bootstrap: { ...current.bootstrap, name: current.bootstrap.name ?? "Ontology", status: "done", awaitingUser: false, step: current.bootstrap.totalSteps },
    ingest: { ...current.ingest, progress: 100, generatedPages: [...new Set([...(current.ingest.generatedPages ?? []), "index.md"])] },
    verify: { ...current.verify, coverage: Math.max(current.verify.coverage, 80) },
    updatedAt: new Date().toISOString(),
  };
  if (!input.readOnly) await writeJourneyState(input.cwd, journeyState);
  yield { type: "journey-state", state: journeyState };
  yield { type: "tree-updated", ontologyId: input.ontologyId };
  yield { type: "finish", sessionId: input.appSessionId, claudeSessionId };
}

export async function* streamOntologyAgent(input: ClaudeRunInput, streamOptions: OntologyAgentStreamOptions = {}): AsyncGenerator<OntologyStreamEvent> {
  if (!env.enableClaudeRuntime) {
    yield* fallbackStream(input);
    return;
  }

  const claudeConfigDir = path.join(env.claudeConfigRoot, "tenants", input.tenantId, "users", input.userId);
  await fs.mkdir(claudeConfigDir, { recursive: true });
  await inheritLocalClaudeAuth(claudeConfigDir);
  const bitbucket = await getBitbucketConnectionStatus(input.tenantId, input.userId);
  const sdkEnv = buildClaudeSdkEnv(claudeConfigDir, bitbucket.connected ? bitbucketGitEnvironment(input.tenantId, input.userId) : undefined);
  let claudeSessionId = input.resume ?? "";
  const abortController = new AbortController();
  const abort = () => abortController.abort(streamOptions.signal?.reason);
  if (streamOptions.signal?.aborted) abort();
  else streamOptions.signal?.addEventListener("abort", abort, { once: true });

  try {
    const composioMcpServer = await createComposioClaudeMcpServer(input.userId, input.composioConnections ?? []);
    const runContext: WorkspaceRunContext = {
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      ontologyId: input.ontologyId,
      sessionId: input.appSessionId,
      runId: input.runId,
      userRequest: input.userRequest,
      locale: input.locale,
      ontologySync: input.ontologySync,
    };
    const runTrace = input.runTrace ?? createWorkspaceRunTrace();
    const repoPrepared = await prepareRepoIngestPrompt(input.cwd, input.prompt);
    recordRepoIngestPreparation(runTrace, repoPrepared.allowedRepoPaths, repoPrepared.documentRepoPaths);
    const mcpServers: Record<string, McpServerConfig> = {};
    if (!input.readOnly) {
      mcpServers.knowledge_runtime = createOntologyRuntimeMcpServer(input.cwd, { ...runContext, runTrace });
      if (composioMcpServer) mcpServers.composio = composioMcpServer;
    }
    const tools = input.readOnly ? ["Read", "Glob", "Grep"] : ["Agent", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "LSP"];
    const allowedTools = input.readOnly ? tools : [...tools, "mcp__composio__*", "mcp__knowledge_runtime__*"];
    const sdkQuery = query({
      prompt: repoPrepared.prompt,
      options: {
        cwd: input.cwd,
        resume: input.resume ?? undefined,
        abortController,
        sessionStore: createClaudeSessionStore({ tenantId: input.tenantId, ontologyId: input.ontologyId, appSessionId: input.appSessionId }),
        sessionStoreFlush: "eager",
        settingSources: ["project"],
        tools,
        allowedTools,
        disallowedTools: input.readOnly ? ["Agent", "Write", "Edit", "MultiEdit", "Bash", "LSP", "mcp__*"] : undefined,
        mcpServers,
        permissionMode: input.readOnly ? "default" : "acceptEdits",
        hooks: {
          PreToolUse: [{ hooks: [createWorkspacePreToolUseHook(input.cwd, runContext, runTrace)] }],
          PostToolUse: [{ hooks: [createWorkspacePostToolUseHook(input.cwd, runContext, runTrace)] }],
        },
        includePartialMessages: true,
        maxTurns: 200,
        env: sdkEnv,
      },
    });

    let emittedText = false;
    let lastJourneyUpdatedAt = (await readJourneyState(input.cwd)).updatedAt;
    let hasPendingJourneyRefresh = false;
    for await (const message of sdkQuery) {
      if ("session_id" in message && typeof message.session_id === "string") claudeSessionId = message.session_id;
      // The SDK reports every backoff before it happens. Without this the whole retry window is
      // indistinguishable from a hang, both in the logs and in the UI.
      if (message.type === "system" && message.subtype === "api_retry") {
        console.warn("[chat] upstream api retry", {
          runId: input.runId,
          attempt: message.attempt,
          maxRetries: message.max_retries,
          delayMs: message.retry_delay_ms,
          status: message.error_status,
        });
        yield {
          type: "retry",
          attempt: message.attempt,
          maxRetries: message.max_retries,
          delayMs: message.retry_delay_ms,
          status: message.error_status,
        };
        continue;
      }
      const toolEvents = toolEventsFromAssistant(message);
      if (toolEvents.length) hasPendingJourneyRefresh = true;
      for (const event of toolEvents) yield event;
      if (message.type === "stream_event") {
        const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          emittedText = true;
          yield { type: "text-delta", delta: event.delta.text };
        }
      }
      const assistantText = textFromAssistant(message);
      if (assistantText && !emittedText) {
        emittedText = true;
        for (const delta of textChunks(assistantText)) yield { type: "text-delta", delta };
      }
      if (message.type === "result" && message.subtype === "success" && message.result && !emittedText) {
        emittedText = true;
        for (const delta of textChunks(message.result)) yield { type: "text-delta", delta };
      }
      // Partial assistant messages can arrive at token granularity. Projecting the
      // workspace for each one recursively scans raw/, which blocks the stream for
      // large Knowledge Bases. A tool-result is the next point at which workspace
      // state may have changed, so refresh there instead.
      if (hasPendingJourneyRefresh && message.type === "user" && message.parent_tool_use_id) {
        hasPendingJourneyRefresh = false;
        const currentJourneyState = await readJourneyState(input.cwd);
        if (currentJourneyState.updatedAt !== lastJourneyUpdatedAt) {
          lastJourneyUpdatedAt = currentJourneyState.updatedAt;
          yield { type: "journey-state", state: currentJourneyState };
        }
      }
    }

    const journeyState = await readJourneyState(input.cwd);
    yield { type: "journey-state", state: journeyState };
    yield { type: "tree-updated", ontologyId: input.ontologyId };
    yield { type: "finish", sessionId: input.appSessionId, claudeSessionId: claudeSessionId || `sdk-${randomUUID()}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Claude Agent SDK execution failed: ${message}`);
  } finally {
    streamOptions.signal?.removeEventListener("abort", abort);
  }
}

export async function runOntologyAgent(input: ClaudeRunInput): Promise<OntologyAgentRunResult> {
  const events: OntologyStreamEvent[] = [];
  const textParts: string[] = [];
  let claudeSessionId = input.resume ?? "";
  let journeyState: JourneyState | null = null;

  for await (const event of streamOntologyAgent(input)) {
    events.push(event);
    if (event.type === "text-delta") textParts.push(event.delta);
    if (event.type === "finish" && event.claudeSessionId) claudeSessionId = event.claudeSessionId;
    if (event.type === "journey-state") journeyState = event.state;
  }

  return {
    events,
    text: textParts.join("") || "Done.",
    claudeSessionId: claudeSessionId || `local-${randomUUID()}`,
    journeyState: journeyState ?? await readJourneyState(input.cwd),
  };
}
