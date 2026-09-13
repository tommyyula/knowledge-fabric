import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { getComposioClient, isComposioConfigured } from "./client";
import { getComposioToolkitSlug } from "./apps";

export interface ComposioRunConnection {
  app: string;
  composioConnectionId: string;
  composioUserId: string;
}

const COMPOSIO_META_TOOL_NAMES = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL"]);

export async function createComposioClaudeMcpServer(userId: string, connections: readonly ComposioRunConnection[]) {
  if (!isComposioConfigured() || connections.length === 0) return null;

  const connectedAccounts: Record<string, string[]> = {};
  for (const connection of connections) {
    const toolkit = getComposioToolkitSlug(connection.app);
    connectedAccounts[toolkit] = [...(connectedAccounts[toolkit] ?? []), connection.composioConnectionId];
  }

  const toolkits = Object.keys(connectedAccounts);
  if (!toolkits.length) return null;

  const composio = getComposioClient();
  const sessionUserId = connections[0]?.composioUserId || userId;
  const session = await composio.create(sessionUserId, {
    connectedAccounts,
    multiAccount: {
      enable: true,
      maxAccountsPerToolkit: 10,
      requireExplicitSelection: false,
    },
  });
  const tools = (await session.tools()).filter((tool: { name?: string }) => COMPOSIO_META_TOOL_NAMES.has(String(tool.name)));

  if (!Array.isArray(tools) || tools.length === 0) return null;
  return createSdkMcpServer({
    name: "composio",
    version: "1.0.0",
    instructions: [
      "Use Composio only for the user's connected external apps in this ontology chat session.",
      "First call COMPOSIO_SEARCH_TOOLS to discover the correct external-app action, then call COMPOSIO_MULTI_EXECUTE_TOOL to execute it.",
      "Do not request new connector authorization from inside the chat; the user manages connections in the connector panel.",
    ].join("\n"),
    tools,
  });
}
