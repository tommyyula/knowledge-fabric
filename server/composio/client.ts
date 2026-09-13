import { Composio } from "@composio/core";
import { ClaudeAgentSDKProvider } from "@composio/claude-agent-sdk";

let cached: unknown | null = null;

export function isComposioConfigured(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY);
}

export function getComposioClient(): any {
  if (!process.env.COMPOSIO_API_KEY) throw new Error("COMPOSIO_API_KEY is not configured");
  if (!cached) cached = new Composio({ apiKey: process.env.COMPOSIO_API_KEY, provider: new ClaudeAgentSDKProvider() });
  return cached as any;
}
