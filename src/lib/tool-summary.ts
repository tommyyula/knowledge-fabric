export type ParsedToolInput = Record<string, unknown> | null;

const WORKSPACE_PREFIX_PATTERN = /(?:[A-Za-z]:)?\/[^\s"'`]*?\/ontologies\/[^/\s"'`]+\/?/g;

export function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseToolInput(value: string): ParsedToolInput {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function compactWorkspacePath(value: string): string {
  let matchedWorkspacePath = false;
  const compacted = value
    .replace(/\\/g, "/")
    .replace(WORKSPACE_PREFIX_PATTERN, () => {
      matchedWorkspacePath = true;
      return "";
    })
    .replace(/(^|\s)\.\/+/g, "$1")
    .trim();
  if (!compacted && matchedWorkspacePath) return ".";
  return compacted || value.trim();
}

function compactSummary(value: string): string {
  return compactWorkspacePath(value).replace(/\s+/g, " ").trim();
}

function firstString(args: ParsedToolInput, keys: string[]): string | null {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function joinUnique(values: Array<string | null | undefined>): string | null {
  const seen = new Set<string>();
  const parts = values
    .map((value) => value ? compactSummary(value) : "")
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  return parts.length ? parts.join(" · ") : null;
}

function collectStringValues(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStringValues(item, output));
    return output;
  }
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) => collectStringValues(item, output));
  }
  return output;
}

function extractResultPaths(...values: unknown[]): string[] {
  const rawStrings = values.flatMap((value) => {
    if (typeof value !== "string") return collectStringValues(value);
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      return collectStringValues(JSON.parse(trimmed) as unknown);
    } catch {
      return [trimmed];
    }
  });
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of rawStrings) {
    for (const line of raw.split(/\r\n|\r|\n|,/)) {
      const path = compactSummary(line.replace(/^[-*]\s+/, "").replace(/^["'`]+|["'`]+$/g, ""));
      if (!path || path === "." || path.includes("{") || path.includes("}") || !path.includes("/")) continue;
      if (!/\.(md|mdx|json|ya?ml|txt|csv|ts|tsx|js|py|sh)$/i.test(path) && !/\/SKILL\.md$/i.test(path)) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function journeySummary(args: ParsedToolInput): string | null {
  return joinUnique([
    firstString(args, ["status"]),
    firstString(args, ["bootstrap_step"]),
    firstString(args, ["build_phase"]),
    firstString(args, ["claude_workflow"]),
  ]);
}

export function summarizeToolCall(toolName: string | undefined, args: ParsedToolInput, result?: unknown, output?: unknown, errorText?: string): string {
  const name = toolName ?? "tool";
  if (name.includes("knowledge_update_journey") || name.includes("ontology_update_journey")) {
    return journeySummary(args) ?? "updating journey";
  }
  if (name.includes("ontology_update_scenario_cards")) {
    return joinUnique([firstString(args, ["operation"]), firstString(args, ["scenario_id"])]) ?? "updating scenario cards";
  }
  if (name.includes("ontology_instance_gleaning")) {
    return joinUnique([firstString(args, ["operation"]), firstString(args, ["scenario_id"])]) ?? "running instance gleaning";
  }

  if (name === "Read" || name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") {
    const path = firstString(args, ["file_path", "path", "notebook_path"]);
    if (path) return compactSummary(path);
    const edits = args?.edits;
    if (Array.isArray(edits)) return `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
  }

  if (name === "Glob") {
    const resultPaths = extractResultPaths(result, output);
    if (resultPaths.length) return resultPaths.join(" · ");
    const summary = joinUnique([firstString(args, ["glob", "pattern"]), firstString(args, ["path"])]);
    if (summary) return summary;
  }

  if (name === "Grep") {
    const summary = joinUnique([firstString(args, ["pattern", "query"]), firstString(args, ["path", "glob"])]);
    if (summary) return summary;
  }

  if (name === "Bash" || name === "PowerShell") {
    const command = firstString(args, ["command", "cmd"]);
    if (command) return compactSummary(command);
  }

  const path = firstString(args, ["file_path", "path", "notebook_path", "glob", "pattern", "query", "command", "cmd"]);
  if (path) return compactSummary(path);
  const content = firstString(args, ["content"]);
  if (content) return compactSummary(content);
  const edits = args?.edits;
  if (Array.isArray(edits)) return `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
  if (errorText) return compactSummary(errorText);
  if (result !== undefined || output !== undefined) return "completed";
  const keys = args ? Object.keys(args) : [];
  return keys.length ? keys.slice(0, 3).join(" · ") : "running tool";
}
