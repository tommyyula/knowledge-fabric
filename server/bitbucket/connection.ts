import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../env";
import { resourceLibraryUserDirectory } from "../resource-library/repository";

interface StoredBitbucketConnection {
  email: string;
  apiToken: string;
  accountName?: string;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string;
}

const bitbucketGitTokenUsername = "x-bitbucket-api-token-auth";

export interface BitbucketConnectionStatus {
  connected: boolean;
  email?: string;
  accountName?: string;
  updatedAt?: string;
  lastValidatedAt?: string;
}

export interface BitbucketRepository {
  name: string;
  slug: string;
  workspace: string;
  workspaceName?: string;
  mainBranch?: string;
}

export interface BitbucketBranch {
  name: string;
}

export class BitbucketConnectionError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "BitbucketConnectionError";
  }
}

function integrationDirectory(tenantId: string, ownerId: string): string {
  return path.join(
    resourceLibraryUserDirectory(tenantId, ownerId),
    "integrations",
  );
}

function connectionFile(tenantId: string, ownerId: string): string {
  return path.join(integrationDirectory(tenantId, ownerId), "bitbucket.json");
}

function gitHomeDirectory(tenantId: string, ownerId: string): string {
  return path.join(integrationDirectory(tenantId, ownerId), "bitbucket-git");
}

function credentialFileForGit(home: string): string {
  return path.join(home, ".git-credentials").split(path.sep).join("/");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function readOnlyCredentialHelper(credentialFile: string): string {
  return `!f() { if [ "$1" = get ]; then git credential-store --file=${shellSingleQuote(credentialFile)} get; fi; }; f`;
}

function gitConfigValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function publicStatus(
  connection: StoredBitbucketConnection | null,
): BitbucketConnectionStatus {
  if (!connection) return { connected: false };
  return {
    connected: true,
    email: connection.email,
    ...(connection.accountName ? { accountName: connection.accountName } : {}),
    updatedAt: connection.updatedAt,
    lastValidatedAt: connection.lastValidatedAt,
  };
}

async function readConnection(
  tenantId: string,
  ownerId: string,
): Promise<StoredBitbucketConnection | null> {
  try {
    const value = JSON.parse(
      await fs.readFile(connectionFile(tenantId, ownerId), "utf8"),
    ) as Partial<StoredBitbucketConnection>;
    if (
      typeof value.email !== "string" ||
      typeof value.apiToken !== "string" ||
      !value.email ||
      !value.apiToken
    )
      return null;
    return {
      email: value.email,
      apiToken: value.apiToken,
      ...(typeof value.accountName === "string" && value.accountName
        ? { accountName: value.accountName }
        : {}),
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
      lastValidatedAt:
        typeof value.lastValidatedAt === "string" ? value.lastValidatedAt : "",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeConnection(
  tenantId: string,
  ownerId: string,
  connection: StoredBitbucketConnection,
): Promise<void> {
  const dir = integrationDirectory(tenantId, ownerId);
  const file = connectionFile(tenantId, ownerId);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(
      temporary,
      `${JSON.stringify(connection, null, 2)}\n`,
      "utf8",
    );
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function configureGitHome(
  tenantId: string,
  ownerId: string,
  input: Pick<StoredBitbucketConnection, "email" | "apiToken">,
): Promise<void> {
  const home = gitHomeDirectory(tenantId, ownerId);
  const credentialFile = path.join(home, ".git-credentials");
  const credentialStore = credentialFileForGit(home);
  const credentials = `https://${bitbucketGitTokenUsername}:${encodeURIComponent(input.apiToken)}@bitbucket.org\n`;
  const credentialHelper = readOnlyCredentialHelper(credentialStore);
  const gitConfig = [
    "[credential]",
    "\thelper =",
    `\thelper = "${gitConfigValue(credentialHelper)}"`,
    "[core]",
    "\tlongpaths = true",
    '[url "https://bitbucket.org/"]',
    "\tinsteadOf = git@bitbucket.org:",
    "",
  ].join("\n");
  await fs.mkdir(home, { recursive: true });
  await Promise.all([
    fs.writeFile(credentialFile, credentials, "utf8"),
    fs.writeFile(path.join(home, ".gitconfig"), gitConfig, "utf8"),
  ]);
}

function apiUrl(pathname: string): string {
  return `${env.bitbucketApiBaseUrl.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
}

function bitbucketErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
  )
    return (error as { message: string }).message;
  return fallback;
}

async function validateCredentials(
  email: string,
  apiToken: string,
): Promise<{ accountName?: string }> {
  const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64")}`;
  let response: Response;
  try {
    response = await fetch(apiUrl("user"), {
      headers: { authorization, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BitbucketConnectionError(
      `Bitbucket credential validation failed: ${message}`,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    display_name?: unknown;
    nickname?: unknown;
  } | null;
  if (!response.ok) {
    const detail = bitbucketErrorMessage(
      body,
      "Bitbucket rejected the supplied credentials",
    );
    throw new BitbucketConnectionError(
      detail,
      response.status === 401 || response.status === 403 ? 409 : 502,
    );
  }
  const accountName =
    typeof body?.display_name === "string"
      ? body.display_name
      : typeof body?.nickname === "string"
        ? body.nickname
        : undefined;
  return { ...(accountName ? { accountName } : {}) };
}

async function requireConnection(
  tenantId: string,
  ownerId: string,
): Promise<StoredBitbucketConnection> {
  const connection = await readConnection(tenantId, ownerId);
  if (!connection)
    throw new BitbucketConnectionError(
      "Configure a Bitbucket Cloud connection before accessing repositories",
      409,
    );
  return connection;
}

async function getBitbucketJson(
  tenantId: string,
  ownerId: string,
  pathname: string,
): Promise<unknown> {
  const connection = await requireConnection(tenantId, ownerId);
  const authorization = `Basic ${Buffer.from(`${connection.email}:${connection.apiToken}`, "utf8").toString("base64")}`;
  let response: Response;
  try {
    response = await fetch(apiUrl(pathname), {
      headers: { authorization, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new BitbucketConnectionError(
      `Bitbucket request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = bitbucketErrorMessage(
      body,
      "Bitbucket rejected the request",
    );
    throw new BitbucketConnectionError(
      detail,
      response.status === 401 || response.status === 403
        ? 409
        : response.status === 404
          ? 404
          : 502,
    );
  }
  return body;
}

export async function getBitbucketConnectionStatus(
  tenantId: string,
  ownerId: string,
): Promise<BitbucketConnectionStatus> {
  return publicStatus(await readConnection(tenantId, ownerId));
}

export async function configureBitbucketConnection(
  tenantId: string,
  ownerId: string,
  input: { email: string; apiToken: string },
): Promise<BitbucketConnectionStatus> {
  const email = input.email.trim();
  const apiToken = input.apiToken.trim();
  const validated = await validateCredentials(email, apiToken);
  const existing = await readConnection(tenantId, ownerId);
  const now = new Date().toISOString();
  const connection: StoredBitbucketConnection = {
    email,
    apiToken,
    ...validated,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastValidatedAt: now,
  };
  await configureGitHome(tenantId, ownerId, connection);
  await writeConnection(tenantId, ownerId, connection);
  return publicStatus(connection);
}

export async function disconnectBitbucketConnection(
  tenantId: string,
  ownerId: string,
): Promise<void> {
  await Promise.all([
    fs.rm(connectionFile(tenantId, ownerId), { force: true }),
    fs.rm(gitHomeDirectory(tenantId, ownerId), {
      recursive: true,
      force: true,
    }),
  ]);
}

export async function listBitbucketRepositories(
  tenantId: string,
  ownerId: string,
  search?: string,
): Promise<BitbucketRepository[]> {
  const workspaceBody = (await getBitbucketJson(
    tenantId,
    ownerId,
    "user/workspaces?pagelen=100",
  )) as { values?: unknown[] };
  const workspaces = (workspaceBody.values ?? []).flatMap((item): string[] => {
    if (!item || typeof item !== "object") return [];
    const slug = (item as { workspace?: { slug?: unknown } }).workspace?.slug;
    return typeof slug === "string" && slug ? [slug] : [];
  });
  const repositoryBodies = await Promise.all(
    workspaces.map((workspace) => {
      const keyword = search?.trim();
      const query = keyword
        ? `&q=${encodeURIComponent(`name~"${keyword.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)}`
        : "";
      return getBitbucketJson(
        tenantId,
        ownerId,
        `repositories/${encodeURIComponent(workspace)}?pagelen=100${query}`,
      ) as Promise<{ values?: unknown[] }>;
    }),
  );
  return repositoryBodies
    .flatMap((body) => body.values ?? [])
    .flatMap((item): BitbucketRepository[] => {
      if (!item || typeof item !== "object") return [];
      const value = item as {
        name?: unknown;
        slug?: unknown;
        workspace?: { slug?: unknown; name?: unknown };
        mainbranch?: { name?: unknown };
      };
      if (
        typeof value.name !== "string" ||
        typeof value.slug !== "string" ||
        typeof value.workspace?.slug !== "string"
      )
        return [];
      return [
        {
          name: value.name,
          slug: value.slug,
          workspace: value.workspace.slug,
          ...(typeof value.workspace.name === "string"
            ? { workspaceName: value.workspace.name }
            : {}),
          ...(typeof value.mainbranch?.name === "string"
            ? { mainBranch: value.mainbranch.name }
            : {}),
        },
      ];
    });
}

export async function listBitbucketBranches(
  tenantId: string,
  ownerId: string,
  workspace: string,
  repoSlug: string,
): Promise<BitbucketBranch[]> {
  const body = (await getBitbucketJson(
    tenantId,
    ownerId,
    `repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/refs/branches?pagelen=100`,
  )) as { values?: unknown[] };
  return (body.values ?? []).flatMap((item): BitbucketBranch[] =>
    item &&
    typeof item === "object" &&
    typeof (item as { name?: unknown }).name === "string"
      ? [{ name: (item as { name: string }).name }]
      : [],
  );
}

export async function getBitbucketRepository(
  tenantId: string,
  ownerId: string,
  workspace: string,
  repoSlug: string,
): Promise<BitbucketRepository> {
  const body = (await getBitbucketJson(
    tenantId,
    ownerId,
    `repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`,
  )) as {
    name?: unknown;
    slug?: unknown;
    workspace?: { slug?: unknown; name?: unknown };
    mainbranch?: { name?: unknown };
  };
  if (
    typeof body.name !== "string" ||
    typeof body.slug !== "string" ||
    typeof body.workspace?.slug !== "string"
  )
    throw new BitbucketConnectionError(
      "Bitbucket returned an invalid repository response",
    );
  return {
    name: body.name,
    slug: body.slug,
    workspace: body.workspace.slug,
    ...(typeof body.workspace.name === "string"
      ? { workspaceName: body.workspace.name }
      : {}),
    ...(typeof body.mainbranch?.name === "string"
      ? { mainBranch: body.mainbranch.name }
      : {}),
  };
}

export function bitbucketGitHome(tenantId: string, ownerId: string): string {
  return gitHomeDirectory(tenantId, ownerId);
}

export function bitbucketGitEnvironment(
  tenantId: string,
  ownerId: string,
): NodeJS.ProcessEnv {
  const home = bitbucketGitHome(tenantId, ownerId);
  const credentialHelper = readOnlyCredentialHelper(credentialFileForGit(home));
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: credentialHelper,
    GIT_TERMINAL_PROMPT: "0",
  };
}
