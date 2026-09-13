import fs from "node:fs/promises";
import path from "node:path";
import type { BootstrapState, JourneyState } from "../../src/contracts/ontology";
import { CONTENT_ROOT, listRawSources, readJourneyState, writeJourneyState } from "../ontologies/workspace";

export interface BootstrapProjection {
  state: JourneyState;
  hydratingState?: JourneyState;
  result?: BootstrapResult;
  completed: boolean;
  treeUpdated: boolean;
}

export interface BootstrapResult {
  name: string;
  description: string;
  emoji: string;
  content_language?: string;
  knowledge_subdirs: string[];
  wiki_subdirs?: string[];
  naming_conventions: string[];
}

const BOOTSTRAP_TOTAL_STEPS = 6;

const DIRECTORY_DESCRIPTIONS: Record<string, string> = {
  business_capabilities: "What the system can do: functional areas and capabilities",
  business_flows: "End-to-end workflows, trigger conditions, decision logic, and closure steps",
  business_objects: "Core domain entities, data models, and field-level definitions",
  data_tables: "Data table definitions: fields, types, constraints, and table relationships",
  interfaces: "API endpoints, controllers, tools, and external integrations",
  rules: "Business rules: routing, escalation, SLA, priority, and constraints",
  scenarios: "Execution scenarios: triggers, judgement logic, steps, and closure mechanism",
  templates: "Execution templates such as emails and reusable message patterns",
  terminology: "Term mappings from system vocabulary to business meaning",
  glossary: "Shared glossary and terminology mappings",
};

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function normalizeDirName(raw: string): string {
  return raw.trim().replace(/^knowledge\//, "").replace(/^wiki\//, "").replace(/^[-*]\s*/, "").replace(/\/+$/, "");
}

function displayName(dir: string): string {
  return normalizeDirName(dir).replace(/_/g, " ");
}

function pageTypeFromDir(dir: string, confirmed: boolean): BootstrapState["pageTypes"][number] {
  const name = normalizeDirName(dir);
  return {
    name,
    description: DIRECTORY_DESCRIPTIONS[name] ?? `${displayName(name)} knowledge pages`,
    confirmed,
  };
}

const RESERVED_CONTENT_DIRS = new Set(["raw", "knowledge", "wiki", "src", "diff", "sources", "syntheses", "graph", "tools", "skills", "pending_review", "archived"]);

function uniquePageTypes(dirs: string[], confirmed: boolean): BootstrapState["pageTypes"] {
  const seen = new Set<string>();
  return dirs
    .map(normalizeDirName)
    .filter((dir) => dir && !dir.includes("{{") && !dir.includes(" "))
    .filter((dir) => !RESERVED_CONTENT_DIRS.has(dir))
    .filter((dir) => {
      if (seen.has(dir)) return false;
      seen.add(dir);
      return true;
    })
    .map((dir) => pageTypeFromDir(dir, confirmed));
}

function parseBootstrapResultCandidate(value: unknown): BootstrapResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Partial<BootstrapResult>;
  const subdirs = Array.isArray(parsed.knowledge_subdirs) ? parsed.knowledge_subdirs : parsed.wiki_subdirs;
  if (
    typeof parsed.name === "string" &&
    typeof parsed.description === "string" &&
    typeof parsed.emoji === "string" &&
    Array.isArray(subdirs) &&
    Array.isArray(parsed.naming_conventions)
  ) {
    return {
      name: parsed.name,
      description: parsed.description,
      emoji: parsed.emoji,
      content_language: typeof parsed.content_language === "string" ? parsed.content_language : undefined,
      knowledge_subdirs: subdirs.filter((item): item is string => typeof item === "string"),
      wiki_subdirs: parsed.wiki_subdirs?.filter((item): item is string => typeof item === "string"),
      naming_conventions: parsed.naming_conventions.filter((item): item is string => typeof item === "string"),
    };
  }
  return null;
}

function extractBootstrapJson(text: string): BootstrapResult | null {
  const candidates = text.match(/\{[\s\S]*?"(?:knowledge_subdirs|wiki_subdirs)"[\s\S]*?\}/g) ?? [];
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      const result = parseBootstrapResultCandidate(parsed);
      if (result) return result;
    } catch {
      // Continue scanning; streaming output may contain non-JSON braces.
    }
  }
  return null;
}

async function readBootstrapResultFile(root: string): Promise<BootstrapResult | null> {
  const raw = await fs.readFile(path.join(root, "bootstrap-result.json"), "utf-8").catch(() => "");
  if (!raw.trim()) return null;
  try {
    return parseBootstrapResultCandidate(JSON.parse(raw));
  } catch {
    return null;
  }
}

function extractSchemaDirs(text: string): string[] {
  const result = extractBootstrapJson(text);
  if (result) return result.knowledge_subdirs;

  const dirs: string[] = [];
  const lines = text.split(/\r?\n/);
  let inContentTree = false;
  for (const line of lines) {
    if (/^\s*(?:knowledge|wiki)\/\s*$/.test(line)) {
      inContentTree = true;
      continue;
    }
    if (!inContentTree) continue;
    const match = line.match(/^\s{0,8}([A-Za-z][A-Za-z0-9_-]*)\/\s*(?:#.*)?$/);
    if (match?.[1]) {
      dirs.push(match[1]);
      continue;
    }
    if (line.trim() && !line.includes("#")) inContentTree = false;
  }
  if (dirs.length) return dirs;

  const schemaSection = text.match(/(?:schema|目录结构|推荐目录|最终推荐)[\s\S]{0,3000}/i)?.[0] ?? text;
  const inlineDirs = [...schemaSection.matchAll(/`([A-Za-z][A-Za-z0-9_-]*)\/`/g)]
    .map((match) => match[1])
    .filter((dir): dir is string => Boolean(dir));
  return inlineDirs;
}


function looksLikeMetadataProposal(text: string): boolean {
  const normalized = text.toLowerCase();
  const hasName = /(?:^|\n)\s*(?:[-*]\s*)?(?:name|wiki name|名称|名字)\s*[:：]/i.test(text);
  const hasDescription = /(?:^|\n)\s*(?:[-*]\s*)?(?:description|描述|用途)\s*[:：]/i.test(text);
  const hasEmoji = /(?:^|\n)\s*(?:[-*]\s*)?(?:emoji|图标|表情)\s*[:：]/i.test(text);
  const hasNaming = /(?:naming conventions?|命名规范|命名约定|content language|内容语言)/i.test(text);
  const asksConfirmation = /(确认|confirm|没问题|可以吗|是否|approve|对齐|需要修改|调整)/i.test(text);
  return asksConfirmation && (hasName || normalized.includes("wiki name") || normalized.includes("knowledge base name")) && (hasDescription || hasEmoji || hasNaming);
}

function looksLikeGoalSelection(text: string): boolean {
  return /(purpose|目标|用途|领域|类型|Product|Platform|Project|Personal|运营手册|知识库|wiki)/i.test(text);
}

function inferStep(text: string, result: BootstrapResult | null, pageTypeCount: number, currentStepFallback = 1): number {
  if (result) return 5;
  if (looksLikeMetadataProposal(text)) return 4;
  if (/(确认|confirm|alignment|missing|调整|可以吗|是否|没问题|approve|对齐|需要修改|结构.*(?:可以|确认|调整|修改)|目录.*(?:可以|确认|调整|修改))/i.test(text) && pageTypeCount > 0) return 3;
  if (pageTypeCount > 0) return 3;
  if (looksLikeGoalSelection(text)) return 1;
  return currentStepFallback;
}

function bootstrapStatusRank(status: BootstrapState["status"]): number {
  switch (status) {
    case "done": return 6;
    case "hydrating": return 5;
    case "metadata_confirmation": return 4;
    case "metadata_proposed": return 4;
    case "schema_confirmation": return 3;
    case "schema_proposed": return 3;
    case "materials_ready": return 2;
    case "materials_collection": return 2;
    case "goal_selection": return 1;
    default: return 0;
  }
}

function preserveForwardStatus(current: BootstrapState, candidate: BootstrapState["status"]): BootstrapState["status"] {
  if (!current.status) return candidate;
  return bootstrapStatusRank(candidate) < bootstrapStatusRank(current.status) ? current.status : candidate;
}

function withBootstrapState(current: JourneyState, assistantText: string, bootstrapActive: boolean, fileResult?: BootstrapResult | null): BootstrapProjection | null {
  const result = fileResult ?? extractBootstrapJson(assistantText);
  const metadataProposal = looksLikeMetadataProposal(assistantText);
  const schemaDirs = extractSchemaDirs(assistantText);
  const parsedPageTypes = uniquePageTypes(result?.knowledge_subdirs ?? schemaDirs, Boolean(result));
  const pageTypes = metadataProposal && !result ? [] : parsedPageTypes;
  if (!bootstrapActive && !result && current.phase !== "bootstrap") return null;

  const hasProjectionSignal = Boolean(result || parsedPageTypes.length || metadataProposal || looksLikeGoalSelection(assistantText));
  if (!hasProjectionSignal) return null;

  const step = inferStep(assistantText, result, pageTypes.length, current.bootstrap.step || 1);
  const candidateStatus: BootstrapState["status"] =
    result ? "hydrating" :
    metadataProposal ? "metadata_confirmation" :
    step >= 3 ? "schema_confirmation" :
    pageTypes.length ? "schema_proposed" :
    "goal_selection";
  const status = preserveForwardStatus(current.bootstrap, candidateStatus);
  const nextStep = Math.max(step, current.bootstrap.step || 1, status === "metadata_proposed" || status === "metadata_confirmation" ? 4 : 0);
  const awaitingUser = !result && (status === "goal_selection" || status === "schema_confirmation" || status === "metadata_proposed" || status === "metadata_confirmation");
  const bootstrap: BootstrapState = {
    ...current.bootstrap,
    name: result?.name ?? current.bootstrap.name,
    description: result?.description ?? current.bootstrap.description,
    pageTypes: pageTypes.length ? pageTypes : current.bootstrap.pageTypes.map((pageType) => ({ ...pageType, confirmed: status === "schema_confirmation" || status === "metadata_confirmation" ? pageType.confirmed : false })),
    sources: current.bootstrap.sources,
    step: nextStep,
    totalSteps: BOOTSTRAP_TOTAL_STEPS,
    status,
    awaitingUser,
    confirmationPrompt: status === "metadata_confirmation" || status === "metadata_proposed" ? "Review the proposed knowledge metadata. Confirm it or describe what to adjust." : status === "schema_confirmation" ? "Review the proposed structure. Confirm it or describe what to adjust." : undefined,
    result: result ?? current.bootstrap.result,
  };

  const hydratingState: JourneyState | undefined = result ? {
    ...current,
    flow: "build",
    phase: "bootstrap",
    bootstrap,
    updatedAt: new Date().toISOString(),
  } : undefined;
  const readyState: JourneyState = result ? {
    ...current,
    flow: "maintenance",
    phase: "ready",
    bootstrap: {
      ...bootstrap,
      pageTypes: bootstrap.pageTypes.map((pageType) => ({ ...pageType, confirmed: true })),
      status: "done",
      awaitingUser: false,
      step: BOOTSTRAP_TOTAL_STEPS,
    },
    updatedAt: new Date().toISOString(),
  } : {
    ...current,
    flow: "build",
    phase: "bootstrap",
    bootstrap,
    updatedAt: new Date().toISOString(),
  };

  return {
    state: readyState,
    hydratingState,
    result: result ?? undefined,
    completed: Boolean(result),
    treeUpdated: Boolean(result),
  };
}

function pageFormatFor(result: BootstrapResult): string {
  const typeValues = ["sources", ...result.knowledge_subdirs.map(normalizeDirName), "syntheses"].join(" | ");
  return [
    "Every knowledge page uses this frontmatter:",
    "",
    "```yaml",
    "---",
    'title: "Page Title"',
    `type: ${typeValues}`,
    "tags: []",
    "sources: []",
    "last_updated: YYYY-MM-DD",
    "---",
    "```",
    "",
    "Use `[[PageName]]` wikilinks to link to other knowledge pages.",
  ].join("\n");
}

function subdirListFor(result: BootstrapResult): string {
  return result.knowledge_subdirs
    .map((dir) => {
      const name = normalizeDirName(dir);
      return `- \`${CONTENT_ROOT}/${name}/\` - ${DIRECTORY_DESCRIPTIONS[name] ?? `${displayName(name)} pages`}`;
    })
    .join("\n");
}

function indexSectionsFor(result: BootstrapResult): string {
  return result.knowledge_subdirs
    .map((dir) => {
      const name = normalizeDirName(dir);
      const title = displayName(name).replace(/\b\w/g, (char) => char.toUpperCase());
      return `## ${title}\n- Add ${displayName(name)} pages under \`${CONTENT_ROOT}/${name}/\`.`;
    })
    .join("\n\n");
}

async function hydrateBootstrap(root: string, result: BootstrapResult): Promise<void> {
  const claudePath = path.join(root, "CLAUDE.md");
  let claude = await fs.readFile(claudePath, "utf-8").catch(() => "");
  if (claude) {
    const normalizedSubdirs = result.knowledge_subdirs.map(normalizeDirName);
    const subdirList = subdirListFor(result);
    claude = claude
      .replace(/^#\s+.*(?:Ontology|Knowledge Base)? Agent\s*$/m, `# ${result.name} Knowledge Base Agent`)
      .replace(/\{\{KNOWLEDGE_NAME\}\}/g, result.name)
      .replace(/\{\{KNOWLEDGE_DESCRIPTION\}\}/g, result.description)
      .replace(/\{\{KNOWLEDGE_SUBDIRS\}\}/g, normalizedSubdirs.map((dir) => `${dir}/`).join("\n  "))
      .replace(/\{\{KNOWLEDGE_SUBDIRS_TYPES\}\}/g, normalizedSubdirs.join(" | "))
      .replace(/\{\{KNOWLEDGE_NAMING_CONVENTIONS\}\}/g, result.naming_conventions.join("\n"))
      .replace(/\{\{KNOWLEDGE_INDEX_SECTIONS\}\}/g, indexSectionsFor(result))
      .replace(/\{\{KNOWLEDGE_SUBDIRS_LIST\}\}/g, subdirList)
      .replace(/\{\{WIKI_NAME\}\}/g, result.name)
      .replace(/\{\{WIKI_DESCRIPTION\}\}/g, result.description)
      .replace(/\{\{WIKI_SUBDIRS\}\}/g, normalizedSubdirs.map((dir) => `${dir}/`).join("\n  "))
      .replace(/\{\{WIKI_SUBDIRS_TYPES\}\}/g, normalizedSubdirs.join(" | "))
      .replace(/\{\{WIKI_NAMING_CONVENTIONS\}\}/g, result.naming_conventions.join("\n"))
      .replace(/\{\{WIKI_INDEX_SECTIONS\}\}/g, indexSectionsFor(result))
      .replace(/\{\{WIKI_PAGE_FORMAT\}\}/g, pageFormatFor(result))
      .replace(/\{\{WIKI_SUBDIRS_LIST\}\}/g, subdirList)
      .replace(/\{\{CONTENT_LANGUAGE\}\}/g, result.content_language ?? "the user's primary language");
    await fs.writeFile(claudePath, claude, "utf-8");
  }

  for (const relative of ["AGENTS.md", "skills/single-ingest/SKILL.md", "skills/batch-ingest/SKILL.md", "skills/coding-repo-ingest/SKILL.md", "skills/verify/SKILL.md"]) {
    const file = path.join(root, relative);
    let content = await fs.readFile(file, "utf-8").catch(() => "");
    if (!content) continue;
    const normalizedSubdirs = result.knowledge_subdirs.map(normalizeDirName);
    content = content
      .replace(/\{\{KNOWLEDGE_NAME\}\}/g, result.name)
      .replace(/\{\{KNOWLEDGE_DESCRIPTION\}\}/g, result.description)
      .replace(/\{\{KNOWLEDGE_SUBDIRS\}\}/g, normalizedSubdirs.map((dir) => `${dir}/`).join("\n  "))
      .replace(/\{\{KNOWLEDGE_SUBDIRS_TYPES\}\}/g, normalizedSubdirs.join(" | "))
      .replace(/\{\{KNOWLEDGE_NAMING_CONVENTIONS\}\}/g, result.naming_conventions.join("\n"))
      .replace(/\{\{KNOWLEDGE_INDEX_SECTIONS\}\}/g, indexSectionsFor(result))
      .replace(/\{\{KNOWLEDGE_SUBDIRS_LIST\}\}/g, subdirListFor(result))
      .replace(/\{\{WIKI_NAME\}\}/g, result.name)
      .replace(/\{\{WIKI_DESCRIPTION\}\}/g, result.description)
      .replace(/\{\{WIKI_SUBDIRS\}\}/g, normalizedSubdirs.map((dir) => `${dir}/`).join("\n  "))
      .replace(/\{\{WIKI_SUBDIRS_TYPES\}\}/g, normalizedSubdirs.join(" | "))
      .replace(/\{\{WIKI_NAMING_CONVENTIONS\}\}/g, result.naming_conventions.join("\n"))
      .replace(/\{\{WIKI_INDEX_SECTIONS\}\}/g, indexSectionsFor(result))
      .replace(/\{\{WIKI_SUBDIRS_LIST\}\}/g, subdirListFor(result))
      .replace(/\{\{CONTENT_LANGUAGE\}\}/g, result.content_language ?? "the user's primary language");
    await fs.writeFile(file, content, "utf-8");
  }

  await fs.mkdir(path.join(root, CONTENT_ROOT), { recursive: true });
  const indexPath = path.join(root, CONTENT_ROOT, "index.md");
  const index = `# ${result.name}\n\n${result.description}\n\n## Overview\n- [Overview](overview.md) - living synthesis\n\n## Glossary\n- [Glossary](glossary.md) - domain terminology\n\n## Sources\n- Add source summaries under \`sources/\`.\n\n${indexSectionsFor(result)}\n\n## Syntheses\n- Add saved query answers under \`syntheses/\`.\n`;
  await writeFileIfMissing(indexPath, index);
  await writeFileIfMissing(path.join(root, CONTENT_ROOT, "overview.md"), `# Overview\n\n${result.description}\n`);
  await writeFileIfMissing(path.join(root, CONTENT_ROOT, "log.md"), "# Knowledge Log\n");
  await writeFileIfMissing(path.join(root, CONTENT_ROOT, "glossary.md"), "# Glossary\n");
  await fs.mkdir(path.join(root, CONTENT_ROOT, "sources"), { recursive: true });
  await fs.mkdir(path.join(root, CONTENT_ROOT, "syntheses"), { recursive: true });
  for (const dir of result.knowledge_subdirs) {
    await fs.mkdir(path.join(root, CONTENT_ROOT, normalizeDirName(dir)), { recursive: true });
  }
}

async function writeFileIfMissing(file: string, content: string): Promise<void> {
  try {
    await fs.writeFile(file, content, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return;
    throw error;
  }
}

export async function ensureBootstrapHydrated(root: string, fallbackResult?: BootstrapResult | null): Promise<BootstrapResult | null> {
  const result = fallbackResult ?? await readBootstrapResultFile(root);
  if (!result) return null;
  const baselineFiles = ["index.md", "overview.md", "glossary.md", "log.md"];
  const hasBaseline = await Promise.all(baselineFiles.map((file) => exists(path.join(root, CONTENT_ROOT, file))));
  if (!hasBaseline.every(Boolean)) await hydrateBootstrap(root, result);
  return result;
}

export async function projectBootstrapJourney(root: string, assistantText: string): Promise<BootstrapProjection | null> {
  const current = await readJourneyState(root);
  if (current.bootstrap.status === "done") return null;
  const bootstrapActive = await exists(path.join(root, "BOOTSTRAP.md"));
  const fileResult = await readBootstrapResultFile(root);
  const projection = withBootstrapState(current, assistantText, bootstrapActive, fileResult);
  if (!projection) return null;
  if (projection.hydratingState) await writeJourneyState(root, projection.hydratingState);
  if (projection.result) {
    await ensureBootstrapHydrated(root, projection.result);
    const rawSources = await listRawSources(root);
    if (rawSources.length) {
      projection.state = {
        ...projection.state,
        flow: "build",
        phase: "ingest",
        bootstrap: {
          ...projection.state.bootstrap,
          rawSources,
          status: "done",
          awaitingUser: false,
          step: 5,
        },
        ingest: {
          ...projection.state.ingest,
          files: [],
          totalBatches: 0,
          completedBatches: 0,
          progress: 0,
          batches: [],
        },
        updatedAt: new Date().toISOString(),
      };
    }
  }
  await writeJourneyState(root, projection.state);
  return projection;
}

export async function bootstrapAwareInitialJourneyState(root: string): Promise<JourneyState> {
  if (!await exists(path.join(root, "BOOTSTRAP.md"))) return readJourneyState(root);
  const current = await readJourneyState(root);
  if (current.bootstrap.status === "done") return current;
  if (current.phase !== "bootstrap" && current.phase !== "ready") return current;
  return {
    ...current,
    flow: "build",
    phase: "bootstrap",
    bootstrap: { ...current.bootstrap, step: current.bootstrap.step || 1, totalSteps: BOOTSTRAP_TOTAL_STEPS, status: current.bootstrap.status ?? "goal_selection", awaitingUser: current.bootstrap.awaitingUser ?? true },
    updatedAt: new Date().toISOString(),
  };
}
