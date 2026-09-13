import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const smokeRoot = path.join(root, ".tmp");
await mkdir(smokeRoot, { recursive: true });
const dataRoot = await mkdtemp(path.join(smokeRoot, "bbc-data-"));
const gitRoot = await mkdtemp(path.join(smokeRoot, "bbc-git-"));
const appPort = String(20000 + Math.floor(Math.random() * 1000));
const bitbucketPort = String(21000 + Math.floor(Math.random() * 1000));
let bitbucketCredentialsValid = true;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

const bitbucket = createServer((req, res) => {
  const expected = `Basic ${Buffer.from("owner@example.com:valid-token").toString("base64")}`;
  if (!bitbucketCredentialsValid || req.headers.authorization !== expected) {
    res
      .writeHead(401, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { message: "Invalid credentials" } }));
    return;
  }
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host}`)
    .pathname;
  if (pathname === "/2.0/user") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({ uuid: "{owner}", display_name: "Connection Owner" }),
      );
    return;
  }
  if (pathname === "/2.0/user/workspaces") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ values: [{ workspace: { slug: "acme" } }] }));
    return;
  }
  if (pathname === "/2.0/repositories/acme") {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        values: [
          {
            name: "Payments",
            slug: "payments",
            workspace: { slug: "acme", name: "Acme" },
            mainbranch: { name: "main" },
          },
        ],
      }),
    );
    return;
  }
  if (pathname === "/2.0/repositories/acme/payments") {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        name: "Payments",
        slug: "payments",
        workspace: { slug: "acme", name: "Acme" },
        mainbranch: { name: "main" },
      }),
    );
    return;
  }
  if (pathname === "/2.0/repositories/acme/payments/refs/branches") {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        values: [{ name: "main" }, { name: "feature/reconciliation" }],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let logs = "";
let app;
const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function exists(file) {
  return access(file)
    .then(() => true)
    .catch(() => false);
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/healthz`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start\n${logs}`);
}

async function api(pathname, init = {}, userId = "owner") {
  return fetch(`http://127.0.0.1:${appPort}${pathname}`, {
    ...init,
    headers: {
      TenantID: "bitbucket-smoke-tenant",
      "x-user-id": userId,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

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
  await git(source, ["branch", "-M", "feature/reconciliation"]);
  await git(source, ["remote", "add", "origin", pathToFileURL(remote).href]);
  await git(source, ["push", "origin", "feature/reconciliation"]);
  await listen(bitbucket, bitbucketPort);
  app = spawn(
    process.execPath,
    [
      path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
      "server/index.ts",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        APP_DATA_ROOT: dataRoot,
        RESOURCE_LIBRARY_ROOT: dataRoot,
        ONTOLOGY_WORKSPACE_ROOT: path.join(dataRoot, "workspaces"),
        ONTOLOGY_SERVER_PORT: appPort,
        ONTOLOGY_IAM_ENABLED: "false",
        VITE_IAM_ENABLED: "false",
        BITBUCKET_API_BASE_URL: `http://127.0.0.1:${bitbucketPort}/2.0`,
        BITBUCKET_GIT_BASE_URL: pathToFileURL(gitRoot).href,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  app.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  app.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });
  await waitForHealth();

  const initial = await api("/api/v1/resource-library/bitbucket/connection");
  const initialText = await initial.text();
  const initialData = initialText ? JSON.parse(initialText) : null;
  if (!initial.ok || initialData?.data?.connected !== false)
    throw new Error(
      `new users must start disconnected: ${initial.status} ${initialText} ${logs}`,
    );

  const configured = await api(
    "/api/v1/resource-library/bitbucket/connection",
    {
      method: "PUT",
      body: JSON.stringify({
        email: "owner@example.com",
        apiToken: "valid-token",
      }),
    },
  );
  const configuredText = await configured.text();
  if (!configured.ok)
    throw new Error(
      `valid connection configuration failed: ${configured.status} ${configuredText}`,
    );
  if (configuredText.includes("valid-token"))
    throw new Error("connection response exposed the API token");

  const failedReplacement = await api(
    "/api/v1/resource-library/bitbucket/connection",
    {
      method: "PUT",
      body: JSON.stringify({
        email: "owner@example.com",
        apiToken: "invalid-token",
      }),
    },
  );
  if (failedReplacement.status !== 409)
    throw new Error(
      `invalid token expected 409, received ${failedReplacement.status}`,
    );

  const retained = await api("/api/v1/resource-library/bitbucket/connection");
  const retainedData = await retained.json();
  if (
    !retained.ok ||
    retainedData.data?.connected !== true ||
    retainedData.data?.email !== "owner@example.com"
  )
    throw new Error("failed replacement must retain the active connection");

  bitbucketCredentialsValid = false;
  const expiredRepositories = await api(
    "/api/v1/resource-library/bitbucket/repositories",
  );
  if (expiredRepositories.status !== 409)
    throw new Error(
      `expired Bitbucket credentials expected 409, received ${expiredRepositories.status}`,
    );
  bitbucketCredentialsValid = true;

  const repositories = await api(
    "/api/v1/resource-library/bitbucket/repositories",
  );
  const repositoriesData = await repositories.json();
  if (
    !repositories.ok ||
    repositoriesData.data?.repositories?.[0]?.slug !== "payments"
  )
    throw new Error(
      "connected users must be able to browse authorized Bitbucket repositories",
    );

  const branches = await api(
    "/api/v1/resource-library/bitbucket/repositories/acme/payments/branches",
  );
  const branchesData = await branches.json();
  if (
    !branches.ok ||
    !branchesData.data?.branches?.some(
      (branch) => branch.name === "feature/reconciliation",
    )
  )
    throw new Error("users must be able to browse a repository's branches");

  const imported = await api(
    "/api/v1/resource-library/bitbucket/repositories",
    {
      method: "POST",
      body: JSON.stringify({
        workspace: "acme",
        repoSlug: "payments",
        defaultBranch: "feature/reconciliation",
      }),
    },
  );
  const importedData = await imported.json();
  if (
    imported.status !== 201 ||
    importedData.data?.type !== "repo" ||
    importedData.data?.source !== "bitbucket" ||
    importedData.data?.bitbucket?.defaultBranch !== "feature/reconciliation"
  )
    throw new Error(
      "repository import must create a Bitbucket Repository Reference",
    );

  const cache = path.join(
    dataRoot,
    "resource-library",
    "tenants",
    "bitbucket-smoke-tenant",
    "users",
    "owner",
    "repos",
    importedData.data.id,
  );
  if (
    importedData.data.size <= 0 ||
    !(await exists(path.join(cache, "README.md"))) ||
    !(await exists(path.join(cache, ".git")))
  )
    throw new Error(
      "repository import must materialize a Resource Library cache with a size",
    );
  const cachedFiles = await api(
    `/api/v1/resource-library/resources/${importedData.data.id}/repository-files`,
  );
  const cachedFilesData = await cachedFiles.json();
  if (
    !cachedFiles.ok ||
    !cachedFilesData.data?.files?.some((file) => file.path === "README.md")
  )
    throw new Error("Repository Cache files must be browseable");
  const cachedFile = await api(
    `/api/v1/resource-library/resources/${importedData.data.id}/repository-file?path=README.md`,
  );
  const cachedFileData = await cachedFile.json();
  if (!cachedFile.ok || !cachedFileData.data?.content?.includes("Payments"))
    throw new Error("Repository Cache files must be previewable");

  const library = await api("/api/v1/resource-library");
  const libraryData = await library.json();
  if (
    !library.ok ||
    !libraryData.data?.resources?.some(
      (resource) =>
        resource.id === importedData.data.id && resource.source === "bitbucket",
    )
  )
    throw new Error(
      "imported Repository References must appear in the Resource Library without a checkout",
    );

  const ontology = await api("/api/v1/ontologies", {
    method: "POST",
    body: JSON.stringify({ name: "Bitbucket checkout smoke" }),
  });
  const ontologyData = await ontology.json();
  if (
    ontology.status !== 201 ||
    !ontologyData.data?.project?.id ||
    !ontologyData.data?.session?.id
  )
    throw new Error("could not create ontology for repository checkout");
  const { project, session } = ontologyData.data;
  const referenced = await api(
    `/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`,
    {
      method: "POST",
      body: JSON.stringify({
        message: "Use the repository",
        resourceIds: [importedData.data.id],
      }),
    },
  );
  if (!referenced.ok)
    throw new Error(
      `repository reference failed: ${referenced.status} ${await referenced.text()}`,
    );
  const checkout = path.join(
    dataRoot,
    "workspaces",
    "tenants",
    "bitbucket-smoke-tenant",
    "users",
    "owner",
    "ontologies",
    project.id,
    "raw",
    "repos",
    importedData.data.id,
  );
  if (
    !(await exists(path.join(checkout, "README.md"))) ||
    !(await exists(path.join(checkout, ".git")))
  )
    throw new Error(
      "repository reference must materialize a Git checkout in the ontology workspace",
    );
  const repeated = await api(
    `/api/v1/ontologies/${project.id}/sessions/${session.id}/chat`,
    {
      method: "POST",
      body: JSON.stringify({
        message: "Reuse the repository",
        resourceIds: [importedData.data.id],
      }),
    },
  );
  if (!repeated.ok || !(await exists(path.join(checkout, "README.md"))))
    throw new Error("repeated references must reuse the existing checkout");
  await writeFile(path.join(checkout, "README.md"), "# Modified\n", "utf8");
  const dirtyRefresh = await api(
    `/api/v1/resource-library/resources/${importedData.data.id}/refresh`,
    { method: "POST", body: JSON.stringify({ ontologyId: project.id }) },
  );
  const dirtyRefreshBody = await dirtyRefresh.text();
  if (dirtyRefresh.status !== 409)
    throw new Error(
      `dirty checkout refresh expected 409, received ${dirtyRefresh.status}: ${dirtyRefreshBody}\n${logs}`,
    );
  await git(checkout, ["checkout", "--", "README.md"]);
  const refreshed = await api(
    `/api/v1/resource-library/resources/${importedData.data.id}/refresh`,
    { method: "POST", body: JSON.stringify({ ontologyId: project.id }) },
  );
  if (refreshed.status !== 204)
    throw new Error(
      `clean checkout refresh expected 204, received ${refreshed.status}`,
    );
  const disconnectedBeforeDelete = await api(
    "/api/v1/resource-library/bitbucket/connection",
    { method: "DELETE" },
  );
  if (
    disconnectedBeforeDelete.status !== 204 ||
    !(await exists(path.join(checkout, "README.md")))
  )
    throw new Error(
      "disconnecting Bitbucket must preserve existing repository checkouts",
    );
  const deletedReference = await api(
    `/api/v1/resource-library/resources/${importedData.data.id}`,
    { method: "DELETE" },
  );
  if (
    deletedReference.status !== 204 ||
    (await exists(checkout)) ||
    (await exists(cache))
  )
    throw new Error(
      "deleting a Repository Reference must delete its bound checkout",
    );

  const isolated = await api(
    "/api/v1/resource-library/bitbucket/connection",
    {},
    "other-user",
  );
  if (!isolated.ok || (await isolated.json()).data?.connected !== false)
    throw new Error("Bitbucket connections must be user-isolated");

  const finalStatus = await api(
    "/api/v1/resource-library/bitbucket/connection",
  );
  if (!finalStatus.ok || (await finalStatus.json()).data?.connected !== false)
    throw new Error("disconnect must remove the active connection");

  console.log("bitbucket connection smoke passed");
} finally {
  if (app && !app.killed) app.kill();
  await new Promise((resolve) => bitbucket.close(resolve));
  await rm(dataRoot, { recursive: true, force: true });
  await rm(gitRoot, { recursive: true, force: true });
}
