import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const dataRoot = await mkdtemp(path.join(tmpdir(), "bitbucket-cache-data-"));
const gitRoot = await mkdtemp(path.join(tmpdir(), "bitbucket-cache-git-"));
const port = 24000 + Math.floor(Math.random() * 1000);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

function gitCredential(command, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["credential", command], {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git credential fill failed: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

function gitCredentialFill(env) {
  return gitCredential("fill", env, "protocol=https\nhost=bitbucket.org\n\n");
}

const bitbucket = createServer((request, response) => {
  if (
    new URL(request.url ?? "/", `http://${request.headers.host}`).pathname ===
    "/2.0/user"
  ) {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ display_name: "Connection Owner" }));
    return;
  }
  response.writeHead(404).end();
});

try {
  const remote = path.join(gitRoot, "acme", "payments.git");
  const source = path.join(gitRoot, "source");
  await mkdir(path.dirname(remote), { recursive: true });
  await git(gitRoot, ["init", "--bare", remote]);
  await mkdir(source, { recursive: true });
  await git(source, ["init"]);
  await writeFile(path.join(source, "README.md"), "# Payments\n", "utf8");
  await git(source, ["add", "README.md"]);
  await git(source, [
    "-c",
    "user.name=Smoke",
    "-c",
    "user.email=smoke@example.com",
    "commit",
    "-m",
    "seed",
  ]);
  await git(source, ["branch", "-M", "main"]);
  await git(source, ["remote", "add", "origin", pathToFileURL(remote).href]);
  await git(source, ["push", "origin", "main"]);
  await listen(bitbucket);

  process.env.APP_DATA_ROOT = dataRoot;
  process.env.RESOURCE_LIBRARY_ROOT = dataRoot;
  process.env.BITBUCKET_API_BASE_URL = `http://127.0.0.1:${port}/2.0`;
  process.env.BITBUCKET_GIT_BASE_URL = pathToFileURL(gitRoot).href;
  const { bitbucketGitEnvironment, configureBitbucketConnection } =
    await import("../server/bitbucket/connection.ts");
  const { checkoutBitbucketRepositoryCache } =
    await import("../server/bitbucket/git.ts");
  const tenantId = `cache-concurrency-${process.pid}`;
  const ownerId = "owner";
  const referenceId = `r-${randomUUID()}`;
  await configureBitbucketConnection(tenantId, ownerId, {
    email: "owner@example.com",
    apiToken: "valid-token",
  });
  const gitEnvironment = {
    ...bitbucketGitEnvironment(tenantId, ownerId),
    HOME: path.join(dataRoot, "unrelated-home"),
    USERPROFILE: path.join(dataRoot, "unrelated-home"),
  };
  const credentials = await gitCredentialFill(gitEnvironment);
  if (
    !credentials.includes("username=x-bitbucket-api-token-auth\n") ||
    !credentials.includes("password=valid-token\n")
  )
    throw new Error(
      "Git must resolve Bitbucket credentials from the user-scoped credential file",
    );
  await gitCredential(
    "reject",
    gitEnvironment,
    "protocol=https\nhost=bitbucket.org\nusername=x-bitbucket-api-token-auth\npassword=valid-token\n\n",
  );
  const credentialsAfterReject = await gitCredentialFill(gitEnvironment);
  if (
    !credentialsAfterReject.includes("username=x-bitbucket-api-token-auth\n") ||
    !credentialsAfterReject.includes("password=valid-token\n")
  )
    throw new Error(
      "Git credential rejection must not delete the configured token",
    );
  const input = {
    tenantId,
    ownerId,
    referenceId,
    workspace: "acme",
    repoSlug: "payments",
    branch: "main",
  };
  const results = await Promise.allSettled([
    checkoutBitbucketRepositoryCache(input),
    checkoutBitbucketRepositoryCache(input),
  ]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) throw failures[0].reason;
  const cache = results[0].value;
  await access(path.join(cache, "README.md"));

  const originalRename = fs.rename;
  let forcedRenameFailure = true;
  fs.rename = async (...args) => {
    if (forcedRenameFailure) {
      forcedRenameFailure = false;
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
        code: "EPERM",
      });
    }
    return originalRename(...args);
  };
  try {
    const retryCache = await checkoutBitbucketRepositoryCache({
      ...input,
      referenceId: `r-${randomUUID()}`,
    });
    await access(path.join(retryCache, "README.md"));
    if (!forcedRenameFailure)
      throw new Error(
        "Repository Cache creation must not rename a Git directory",
      );
  } finally {
    fs.rename = originalRename;
  }

  let missingBranchError = "";
  try {
    await checkoutBitbucketRepositoryCache({
      ...input,
      referenceId: `r-${randomUUID()}`,
      branch: "missing-branch",
    });
  } catch (error) {
    missingBranchError = error instanceof Error ? error.message : String(error);
  }
  if (
    !missingBranchError.includes(
      "Git fetch failed: fatal: couldn't find remote ref missing-branch",
    )
  )
    throw new Error(
      `Git failures must expose a safe upstream diagnostic, received: ${missingBranchError}`,
    );
  console.log("bitbucket cache concurrency smoke passed");
} finally {
  await new Promise((resolve) => bitbucket.close(resolve));
  await rm(dataRoot, { recursive: true, force: true });
  await rm(gitRoot, { recursive: true, force: true });
}
