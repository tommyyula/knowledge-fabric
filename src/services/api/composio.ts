import { apiJson } from "@/lib/api-client";

export interface ComposioConnectionInfo {
  id: string;
  connectionId: string;
  composioUserId: string;
  displayName: string;
  status: string;
  createdAt: string;
}

export interface ComposioApp {
  app: string;
  name: string;
  icon: string;
  logo: string;
  description: string;
  connectorType: string;
  capabilities: string[];
  connected: boolean;
  connectionId: string | null;
  connectionCount: number;
  connections: ComposioConnectionInfo[];
  composioEntityId: string | null;
}

export async function listComposioApps(): Promise<ComposioApp[]> {
  return (await apiJson<{ apps: ComposioApp[] }>("/api/composio/apps")).apps;
}

export async function connectComposioApp(app: string): Promise<{ redirectUrl: string; callbackUrl: string }> {
  return apiJson<{ redirectUrl: string; callbackUrl: string }>("/api/composio/connect", {
    method: "POST",
    body: JSON.stringify({ app, callbackBaseUrl: window.location.origin }),
  });
}

export async function disconnectComposioApp(app: string): Promise<void> {
  await apiJson<void>("/api/composio/disconnect", { method: "POST", body: JSON.stringify({ app }) });
}
