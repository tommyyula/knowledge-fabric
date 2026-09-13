import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function loadLocalEnvFiles(): void {
  for (const filename of [".env", ".env.local", ".env.private"]) {
    const file = path.resolve(process.cwd(), filename);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const raw = trimmed.slice(eq + 1).trim();
      if (process.env[key] !== undefined) continue;
      process.env[key] = raw.replace(/^[ '"]|[ '"]$/g, "").trim();
    }
  }
}

loadLocalEnvFiles();

const generatedProxyToken = process.env.ONTOLOGY_PROXY_TOKEN || randomUUID();

export type DatabaseSslMode = "auto" | "no-verify" | "require" | "disable";

const databaseSslModes = new Set<string>(["auto", "no-verify", "require", "disable"]);
const requestedDatabaseSsl = (process.env.DATABASE_SSL ?? "auto").trim().toLowerCase();
const databaseSsl = (databaseSslModes.has(requestedDatabaseSsl) ? requestedDatabaseSsl : "auto") as DatabaseSslMode;

const dataRoot = path.resolve(process.env.APP_DATA_ROOT ?? process.env.ONTOLOGY_DATA_ROOT ?? "/app/data");
const adminUserIds = new Set(
  (process.env.ONTOLOGY_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

export const env = {
  dataRoot,
  adminUserIds,
  port: Number(process.env.PORT ?? process.env.ONTOLOGY_SERVER_PORT ?? 8787),
  a2aPublicBaseUrl: process.env.A2A_PUBLIC_BASE_URL ?? process.env.APP_URL,
  a2aQueryStartDelayMs: Number(process.env.A2A_QUERY_START_DELAY_MS ?? 0),
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl,
  iamEnabled: process.env.ONTOLOGY_IAM_ENABLED !== undefined ? process.env.ONTOLOGY_IAM_ENABLED === "true" : process.env.VITE_IAM_ENABLED === "true",
  ssoUrl: process.env.SSO_URL ?? process.env.VITE_SSO_URL,
  workspaceRoot: process.env.ONTOLOGY_WORKSPACE_ROOT ?? path.join(dataRoot, "ontology-workspaces"),
  resourceLibraryRoot: process.env.RESOURCE_LIBRARY_ROOT ?? process.env.ONTOLOGY_RESOURCE_LIBRARY_ROOT ?? path.join(dataRoot, "resource-library"),
  bitbucketApiBaseUrl: process.env.BITBUCKET_API_BASE_URL ?? "https://api.bitbucket.org/2.0",
  bitbucketGitBaseUrl: process.env.BITBUCKET_GIT_BASE_URL ?? "https://bitbucket.org",
  claudeConfigRoot: process.env.CLAUDE_CONFIG_ROOT ?? path.join(dataRoot, ".claude"),
  claudeSessionStoreRoot: process.env.CLAUDE_SESSION_STORE_ROOT ?? path.join(dataRoot, "claude-session-store"),
  claudeSessionStore: process.env.CLAUDE_SESSION_STORE === "postgres" ? "postgres" : "file",
  initialWikiSource: process.env.ONTOLOGY_INITIAL_WIKI_SOURCE ?? path.resolve(process.cwd(), "server/templates/knowledge-base"),
  enableClaudeRuntime: process.env.ONTOLOGY_ENABLE_CLAUDE === "true",
  inheritLocalClaudeAuth: process.env.ONTOLOGY_CLAUDE_INHERIT_LOCAL_AUTH !== "false",
  proxyToken: generatedProxyToken,
  allowUnauthenticatedProxy: process.env.ONTOLOGY_PROXY_ALLOW_UNAUTHENTICATED === "true",
  supportEmailApiUrl: process.env.SUPPORT_EMAIL_API_URL ?? "https://marketplace-staging.item.com/api/v1/notification-pushes/send-email",
  supportReportRecipients: process.env.SUPPORT_REPORT_RECIPIENTS ?? "marketplace@item.com",
  supportEmailTimeoutMs: Number(process.env.SUPPORT_EMAIL_TIMEOUT_MS ?? 15_000),
  appRelease: process.env.APP_RELEASE ?? process.env.npm_package_version ?? "unknown",
};
