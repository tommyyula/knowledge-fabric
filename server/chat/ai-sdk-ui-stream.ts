import type { JSONValue } from "ai";
import type { UIMessageChunk } from "ai";
import type { OntologyStreamEvent } from "../../src/contracts/ontology";

export type OntologyAiSdkChunk = UIMessageChunk;

export function encodeAiSdkUiChunk(chunk: OntologyAiSdkChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function encodeAiSdkDone(): string {
  return "data: [DONE]\n\n";
}

export function ontologyRunMessageId(runId: string): string {
  return `${runId}:message`;
}

export class OntologyAiSdkStreamProjector {
  private textId: string | null = null;

  constructor(private readonly runId: string) {}

  start(): OntologyAiSdkChunk {
    return { type: "start", messageId: ontologyRunMessageId(this.runId) };
  }

  project(event: OntologyStreamEvent, sequence: number): OntologyAiSdkChunk[] {
    switch (event.type) {
      case "text-delta": {
        const chunks: OntologyAiSdkChunk[] = [];
        if (!this.textId) {
          this.textId = this.chunkId("text", sequence);
          chunks.push({ type: "text-start", id: this.textId });
        }
        chunks.push({ type: "text-delta", id: this.textId, delta: event.delta });
        return chunks;
      }
      case "tool": {
        const toolCallId = this.chunkId("tool", sequence);
        return [
          ...this.closeTextBlock(),
          {
          type: "tool-input-available",
          toolCallId,
          toolName: event.tool,
          input: event.input ?? {},
          providerExecuted: true,
          title: toolTitle(event.tool, event.input),
          providerMetadata: { "claude-code": { rawInput: toJsonValue(event.input ?? {}) } },
          },
        ];
      }
      case "journey-state":
        return [
          {
            type: "data-journey-state",
            id: this.chunkId("journey-state", sequence),
            data: event.state,
            transient: true,
          },
        ];
      case "tree-updated":
        return [
          {
            type: "data-tree-updated",
            id: this.chunkId("tree-updated", sequence),
            data: { ontologyId: event.ontologyId },
            transient: true,
          },
        ];
      case "finish": {
        const chunks: OntologyAiSdkChunk[] = this.closeTextBlock();
        chunks.push({
          type: "data-claude-session",
          id: this.chunkId("claude-session", sequence),
          data: {
            sessionId: event.sessionId,
            claudeSessionId: event.claudeSessionId,
          },
          transient: true,
        });
        chunks.push({ type: "finish", finishReason: "stop" });
        return chunks;
      }
      case "retry":
        return [
          {
            type: "data-retry",
            id: this.chunkId("retry", sequence),
            data: { attempt: event.attempt, maxRetries: event.maxRetries, delayMs: event.delayMs, status: event.status },
            transient: true,
          },
        ];
      case "error":
        return [{ type: "error", errorText: event.error }];
      case "message":
        // The text was already streamed. Persisted message refresh stays server-side.
        return [];
    }
  }

  private chunkId(kind: string, sequence: number): string {
    return `${this.runId}:${sequence}:${kind}`;
  }

  private closeTextBlock(): OntologyAiSdkChunk[] {
    if (!this.textId) return [];
    const id = this.textId;
    this.textId = null;
    return [{ type: "text-end", id }];
  }
}

function toolTitle(toolName: string, input: unknown): string {
  const displayName =
    toolName === "intermediate" ? "[intermediate_answer]" :
    toolName === "deepening" ? "[deepening_queries]" :
    toolName.includes("ontology_update_scenario_cards")
      ? "Update scenario cards" :
    toolName.includes("ontology_instance_gleaning")
      ? "Instance gleaning" :
    toolName.includes("knowledge_update_journey") || toolName.includes("ontology_update_journey")
      ? "Update journey"
      : toolName;
  if (toolName === "intermediate" || toolName === "deepening") {
    const content = firstStringField(input, ["content"]);
    return content ? `${displayName} · ${content.replace(/\s+/g, " ").slice(0, 120)}` : displayName;
  }
  const path = firstStringField(input, ["file_path", "path", "glob", "pattern"]);
  return path ? `${displayName} · ${path}` : displayName;
}

function firstStringField(input: unknown, keys: string[]): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function toJsonValue(value: unknown): JSONValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch {
    return String(value);
  }
}
