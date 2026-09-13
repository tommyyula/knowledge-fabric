import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { bitbucketGitEnvironment } from "./connection";
import { env } from "../env";
import { resourceLibraryUserDirectory } from "../resource-library/repository";

const execFileAsync = promisify(execFile);
const repositoryCacheCheckouts = new Map<string, Promise<string>>();
const renameRetryDelaysMs = [50, 150, 300, 600];
const gitMaterializationTimeoutMs = 180_000;
const gitCommandTimeoutMs = 30_000;

export class BitbucketCheckoutError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "BitbucketCheckoutError";
  }
}

function repositoryUrl(workspace: string, repoSlug: string): string {
  return `${env.bitbucketGitBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}.git`;
}

function redactGitDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s@]+:[^/\s@]+@/g, "https://***:***@")
    .replace(/(authorization:\s*basic\s+)[^\s]+/gi, "$1***")
    .trim()
    .slice(0, 2_000);
}

function gitTimeoutMs(args: readonly string[]): number {
  return args[0] === "fetch" || args[0] === "checkout"
    ? gitMaterializationTimeoutMs
    : gitCommandTimeoutMs;
}

async function gitOutput(
  tenantId: string,
  ownerId: string,
  cwd: string,
  args: string[],
): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: bitbucketGitEnvironment(tenantId, ownerId),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: gitTimeoutMs(args),
    });
    return result.stdout;
  } catch (error) {
    const result = error as NodeJS.ErrnoException & {
      stderr?: unknown;
      killed?: unknown;
      signal?: unknown;
    };
    const stderr =
      typeof result.stderr === "string"
        ? redactGitDiagnostic(result.stderr)
        : "";
    const timedOut = result.killed === true || result.signal === "SIGTERM";
    const detail = timedOut
      ? `timed out after ${gitTimeoutMs(args) / 1_000} seconds${stderr ? `: ${stderr}` : ""}`
      : stderr || "Git command failed without diagnostic output";
    throw new BitbucketCheckoutError(`Git ${args[0]} failed: ${detail}`);
  }
}

async function git(
  tenantId: string,
  ownerId: string,
  cwd: string,
  args: string[],
): Promise<void> {
  await gitOutput(tenantId, ownerId, cwd, args);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function moveCompletedCheckout(
  temporary: string,
  destination: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temporary, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") throw error;
      const destinationExists = await fs
        .access(destination)
        .then(() => true)
        .catch((accessError: unknown) => {
          if ((accessError as NodeJS.ErrnoException).code === "ENOENT")
            return false;
          throw accessError;
        });
      if (destinationExists) {
        await fs.access(path.join(destination, ".git"));
        return;
      }
      const delay = renameRetryDelaysMs[attempt];
      if (delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

async function checkoutIntoDirectory(input: {
  tenantId: string;
  ownerId: string;
  destination: string;
  temporary?: string;
  workspace: string;
  repoSlug: string;
  branch: string;
}): Promise<void> {
  const checkoutDirectory = input.temporary ?? input.destination;
  try {
    await fs.mkdir(path.dirname(checkoutDirectory), { recursive: true });
    await fs
      .access(input.destination)
      .then(() => {
        throw new BitbucketCheckoutError(
          "Repository checkout destination already exists",
          409,
        );
      })
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    await fs.mkdir(checkoutDirectory, { recursive: true });
    await git(input.tenantId, input.ownerId, checkoutDirectory, ["init"]);
    await git(input.tenantId, input.ownerId, checkoutDirectory, [
      "remote",
      "add",
      "origin",
      repositoryUrl(input.workspace, input.repoSlug),
    ]);
    await git(input.tenantId, input.ownerId, checkoutDirectory, [
      "fetch",
      "--depth",
      "1",
      "origin",
      input.branch,
    ]);
    await git(input.tenantId, input.ownerId, checkoutDirectory, [
      "checkout",
      "-B",
      input.branch,
      "FETCH_HEAD",
    ]);
    if (input.temporary)
      await moveCompletedCheckout(input.temporary, input.destination);
  } catch (error) {
    await fs
      .rm(checkoutDirectory, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
}

export async function checkoutBitbucketRepository(input: {
  tenantId: string;
  ownerId: string;
  workspaceRoot: string;
  referenceId: string;
  workspace: string;
  repoSlug: string;
  branch: string;
}): Promise<{ rawRoot: string; rawPaths: string[] }> {
  const rawRoot = path.posix.join("raw", "repos", input.referenceId);
  const destination = path.join(input.workspaceRoot, ...rawRoot.split("/"));
  const temporary = path.join(
    input.workspaceRoot,
    "raw",
    "repos",
    `.tmp-${randomUUID().slice(0, 8)}`,
  );
  await checkoutIntoDirectory({ ...input, destination, temporary });
  return { rawRoot, rawPaths: [rawRoot] };
}

export async function checkoutBitbucketRepositoryCache(input: {
  tenantId: string;
  ownerId: string;
  referenceId: string;
  workspace: string;
  repoSlug: string;
  branch: string;
}): Promise<string> {
  const cacheRoot = path.join(
    resourceLibraryUserDirectory(input.tenantId, input.ownerId),
    "repos",
  );
  const destination = path.join(cacheRoot, input.referenceId);
  const existing = repositoryCacheCheckouts.get(destination);
  if (existing) return existing;

  const checkout = (async (): Promise<string> => {
    await checkoutIntoDirectory({ ...input, destination });
    return destination;
  })();
  repositoryCacheCheckouts.set(destination, checkout);
  try {
    return await checkout;
  } finally {
    if (repositoryCacheCheckouts.get(destination) === checkout)
      repositoryCacheCheckouts.delete(destination);
  }
}

export async function refreshBitbucketRepositoryCheckout(input: {
  tenantId: string;
  ownerId: string;
  workspaceRoot: string;
  rawRoot: string;
}): Promise<void> {
  const checkout = path.join(input.workspaceRoot, ...input.rawRoot.split("/"));
  const dirty = await gitOutput(input.tenantId, input.ownerId, checkout, [
    "status",
    "--porcelain",
  ]);
  if (dirty.trim())
    throw new BitbucketCheckoutError(
      "Repository checkout has uncommitted changes",
      409,
    );
  const branch = (
    await gitOutput(input.tenantId, input.ownerId, checkout, [
      "branch",
      "--show-current",
    ])
  ).trim();
  if (!branch)
    throw new BitbucketCheckoutError(
      "Repository checkout is detached and cannot be refreshed",
      409,
    );
  await git(input.tenantId, input.ownerId, checkout, [
    "fetch",
    "origin",
    branch,
  ]);
  await git(input.tenantId, input.ownerId, checkout, [
    "merge",
    "--ff-only",
    "FETCH_HEAD",
  ]);
}
