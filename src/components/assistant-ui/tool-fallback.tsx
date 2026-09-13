/* eslint-disable react-refresh/only-export-components */
import { ChevronDown, ChevronRight, FilePenLine, FileSearch, FolderSearch, Lightbulb, Search, Telescope, Wrench } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { parseToolInput, stringifyToolValue, summarizeToolCall } from "@/lib/tool-summary";
import { cn } from "@/lib/utils";

interface ToolFallbackProps {
  toolName?: string;
  input?: unknown;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
}

const TOOL_LABELS: Record<string, { label: string; icon: ReactNode }> = {
  Read: { label: "Read", icon: <FileSearch className="size-3.5" /> },
  Write: { label: "Write", icon: <FilePenLine className="size-3.5" /> },
  Edit: { label: "Edit", icon: <FilePenLine className="size-3.5" /> },
  MultiEdit: { label: "MultiEdit", icon: <FilePenLine className="size-3.5" /> },
  Glob: { label: "Glob", icon: <FolderSearch className="size-3.5" /> },
  Grep: { label: "Grep", icon: <Search className="size-3.5" /> },
  intermediate: { label: "[intermediate_answer]", icon: <Lightbulb className="size-3.5" /> },
  deepening: { label: "[deepening_queries]", icon: <Telescope className="size-3.5" /> },
};

function displayToolName(toolName: string) {
  if (toolName.includes("ontology_update_scenario_cards")) {
    return "Update scenario cards";
  }
  if (toolName.includes("ontology_instance_gleaning")) {
    return "Instance gleaning";
  }
  if (toolName.includes("knowledge_update_journey") || toolName.includes("ontology_update_journey")) {
    return "Update journey";
  }
  return toolName;
}

export function isHiddenToolCall(toolName?: string) {
  return !toolName || toolName.startsWith("steward_workshop_") || toolName === "suggest_followups";
}

export function ToolFallback({ toolName = "tool", input, args, argsText, result, isError }: ToolFallbackProps) {
  const [expanded, setExpanded] = useState(false);
  const rawInput = argsText ?? stringifyToolValue(input ?? args);
  const parsedArgs = useMemo(() => parseToolInput(rawInput), [rawInput]);
  const config = TOOL_LABELS[toolName] ?? { label: displayToolName(toolName), icon: <Wrench className="size-3.5" /> };
  const summary = summarizeToolCall(toolName, parsedArgs, result);
  const resultText = stringifyToolValue(result);
  const hasDetails = rawInput.trim().length > 0 || resultText.trim().length > 0;

  if (toolName === "intermediate" || toolName === "deepening") {
    return (
      <div className="assistant-tool-card">
        <div className="assistant-tool-card-row">
          <span className="assistant-tool-icon" aria-hidden="true">{config.icon}</span>
          <span className="assistant-tool-name">{config.label}</span>
          <span className="assistant-tool-summary" title={summary}>{summary}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("assistant-tool-card", isError && "assistant-tool-card-error")}>
      <button
        type="button"
        className={cn("assistant-tool-card-row", hasDetails && "assistant-tool-card-row-clickable")}
        onClick={() => hasDetails && setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="assistant-tool-icon" aria-hidden="true">{config.icon}</span>
        <span className="assistant-tool-name">{config.label}</span>
        <span className="assistant-tool-summary" title={summary}>{summary}</span>
        {hasDetails && <span className="assistant-tool-chevron" aria-hidden="true">{expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</span>}
      </button>
      {expanded && hasDetails && (
        <pre className="assistant-tool-details">{[rawInput, resultText && `Result:\n${resultText}`].filter(Boolean).join("\n\n")}</pre>
      )}
    </div>
  );
}
