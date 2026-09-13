import { Router, type Request } from "express";
import { z } from "zod";
import { asyncRoute } from "../http";
import { requireTenantContext } from "../auth/requireTenantContext";
import { SUPPORTED_COMPOSIO_APPS, getComposioToolkitSlug, normalizeComposioApp } from "./apps";
import { getComposioClient, isComposioConfigured } from "./client";
import { activateComposioConnection, disconnectComposioConnections, listComposioConnections, saveComposioConnection } from "./connection-store";

export const composioRouter = Router();

const connectSchema = z.object({
  app: z.string().trim().min(1),
  callbackBaseUrl: z.string().trim().url().optional(),
});
const disconnectSchema = z.object({ app: z.string().trim().min(1) });

function connectionPayload(connection: Awaited<ReturnType<typeof listComposioConnections>>[number]) {
  return {
    id: connection.id,
    connectionId: connection.composioConnectionId,
    composioUserId: connection.composioUserId,
    displayName: connection.displayName,
    status: connection.status,
    createdAt: connection.createdAt.toISOString(),
  };
}

function firstForwardedValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.split(",")[0]?.trim() || "";
  return (value || "").split(",")[0]?.trim() || "";
}

function resolveFrontendBaseUrl(req: Request): string {
  const configured = process.env.COMPOSIO_CALLBACK_BASE_URL || process.env.VITE_APP_URL || process.env.APP_URL || "";
  if (configured.trim()) return configured.trim().replace(/\/$/, "");
  const origin = firstForwardedValue(req.headers.origin);
  if (origin) return origin.replace(/\/$/, "");
  const referer = firstForwardedValue(req.headers.referer);
  if (referer) {
    try {
      return new URL(referer).origin.replace(/\/$/, "");
    } catch {
      // Fall through to proxy headers.
    }
  }
  const forwardedHost = firstForwardedValue(req.headers["x-forwarded-host"]);
  const host = forwardedHost || firstForwardedValue(req.headers.host);
  const forwardedProto = firstForwardedValue(req.headers["x-forwarded-proto"]);
  const proto = forwardedProto || req.protocol || "http";
  return host ? `${proto}://${host}`.replace(/\/$/, "") : "http://localhost:8888";
}

function isAllowedCallbackBaseUrl(candidate: string, req: Request): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!req.headers.origin && !req.headers.referer) return true;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") return true;
    const allowed = new Set<string>();
    for (const value of [
      process.env.COMPOSIO_CALLBACK_BASE_URL,
      process.env.VITE_APP_URL,
      process.env.APP_URL,
      firstForwardedValue(req.headers.origin),
      firstForwardedValue(req.headers.referer),
      firstForwardedValue(req.headers["x-forwarded-host"]) ? `${firstForwardedValue(req.headers["x-forwarded-proto"]) || req.protocol || "http"}://${firstForwardedValue(req.headers["x-forwarded-host"])}` : "",
    ]) {
      if (!value) continue;
      try {
        allowed.add(new URL(value).host);
      } catch {
        allowed.add(value.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
      }
    }
    return allowed.has(url.host);
  } catch {
    return false;
  }
}

function resolveCallbackBaseUrl(req: Request, requested?: string): string {
  const configured = process.env.COMPOSIO_CALLBACK_BASE_URL;
  if (configured?.trim()) return configured.trim().replace(/\/$/, "");
  if (requested?.trim() && isAllowedCallbackBaseUrl(requested, req)) return requested.trim().replace(/\/$/, "");
  return resolveFrontendBaseUrl(req);
}

async function resolveAuthConfigId(app: string): Promise<string> {
  const envKey = `COMPOSIO_AUTH_CONFIG_${app.toUpperCase().replace(/-/g, "_")}`;
  const envValue = process.env[envKey];
  if (envValue) return envValue;

  const composio = getComposioClient();
  const toolkit = getComposioToolkitSlug(app);
  const configs = await composio.authConfigs.list({ toolkit });
  const items = (configs?.items ?? []) as Array<{ id: string; isComposioManaged?: boolean }>;
  if (!items.length) throw new Error(`No auth configuration found for ${app}. Configure one in Composio or set ${envKey}.`);
  return items.find((item) => !item.isComposioManaged)?.id ?? items.find((item) => item.isComposioManaged)?.id ?? items[0].id;
}

composioRouter.get("/apps", asyncRoute(async (req, res) => {
  if (!isComposioConfigured()) return void res.status(503).json({ error: "Composio is not configured", apps: [] });

  const ctx = await requireTenantContext(req);
  const connections = await listComposioConnections(ctx.tenantId, ctx.user.id);
  const byApp = new Map<string, ReturnType<typeof connectionPayload>[]>();
  for (const connection of connections) {
    const items = byApp.get(connection.app) ?? [];
    items.push(connectionPayload(connection));
    byApp.set(connection.app, items);
  }

  const apps = SUPPORTED_COMPOSIO_APPS.map((app) => {
    const connectionsForApp = byApp.get(app.app) ?? [];
    return {
      ...app,
      connected: connectionsForApp.length > 0,
      connectionId: connectionsForApp[0]?.connectionId ?? null,
      connectionCount: connectionsForApp.length,
      connections: connectionsForApp,
      composioEntityId: connectionsForApp[0]?.composioUserId ?? null,
    };
  });

  res.json({ apps });
}));

composioRouter.post("/connect", asyncRoute(async (req, res) => {
  if (!isComposioConfigured()) return void res.status(503).json({ error: "Composio is not configured. Set COMPOSIO_API_KEY in environment." });

  const ctx = await requireTenantContext(req);
  const body = connectSchema.parse(req.body ?? {});
  const app = normalizeComposioApp(body.app);
  const authConfigId = await resolveAuthConfigId(app);
  const callbackUrl = `${resolveCallbackBaseUrl(req, body.callbackBaseUrl)}/api/composio/callback`;
  const entityId = `${ctx.tenantId}__${ctx.user.id}`;
  const composio = getComposioClient();
  const request = await composio.connectedAccounts.link(entityId, authConfigId, {
    callbackUrl,
    allowMultiple: true,
    alias: `${app}-${Date.now()}`,
  });

  if (!request.redirectUrl) return void res.status(502).json({ error: "No redirect URL received from Composio" });

  await saveComposioConnection({ tenantId: ctx.tenantId, userId: ctx.user.id, app, composioConnectionId: request.id, authConfigId, status: "pending" });
  res.json({ redirectUrl: request.redirectUrl, callbackUrl });
}));

composioRouter.post("/disconnect", asyncRoute(async (req, res) => {
  if (!isComposioConfigured()) return void res.status(503).json({ error: "Composio is not configured" });

  const ctx = await requireTenantContext(req);
  const app = normalizeComposioApp(disconnectSchema.parse(req.body ?? {}).app);
  const deleted = await disconnectComposioConnections(ctx.tenantId, ctx.user.id, app);
  const composio = getComposioClient();
  for (const connection of deleted) {
    try {
      await composio.connectedAccounts.delete(connection.composioConnectionId);
    } catch (err) {
      console.warn(`[composio/disconnect] Remote disconnect failed for ${connection.composioConnectionId}:`, err instanceof Error ? err.message : err);
    }
  }
  res.json({ success: true, app, disconnected: deleted.length });
}));

composioRouter.get("/callback", asyncRoute(async (req, res) => {
  const connectedAccountId = typeof req.query.connectedAccountId === "string"
    ? req.query.connectedAccountId
    : typeof req.query.connected_account_id === "string"
      ? req.query.connected_account_id
      : typeof req.query.id === "string"
        ? req.query.id
        : "";
  const error = typeof req.query.error === "string" ? req.query.error : typeof req.query.error_message === "string" ? req.query.error_message : "";

  if (connectedAccountId) await activateComposioConnection(connectedAccountId);

  const success = Boolean(connectedAccountId) && !error;
  res.type("html").send(`<!doctype html><html><body><script>
    if (window.opener) window.opener.postMessage({ type: 'composio-oauth-callback', success: ${JSON.stringify(success)}, error: ${JSON.stringify(error || null)} }, '*');
    window.close();
  </script>${success ? "Connection complete" : `Connection failed: ${error || "missing connected account"}`}</body></html>`);
}));
