import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const port = 23000 + Math.floor(Math.random() * 1000);
const apiBaseUrl = `http://127.0.0.1:${port}/2.0`;
const dataRoot = await mkdtemp(
  path.join(tmpdir(), "bitbucket-repository-list-"),
);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

const server = createServer((request, response) => {
  const requestUrl = new URL(
    request.url ?? "/",
    `http://${request.headers.host}`,
  );
  if (requestUrl.pathname === "/2.0/user") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ display_name: "Connection Owner" }));
    return;
  }
  if (requestUrl.pathname === "/2.0/user/workspaces") {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        values: [{ workspace: { slug: "acme" } }],
      }),
    );
    return;
  }
  if (requestUrl.pathname === "/2.0/repositories/acme") {
    if (requestUrl.searchParams.get("q") !== 'name~"pay"') {
      response.writeHead(400).end("repository search query was not forwarded");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
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
  if (requestUrl.pathname !== "/2.0/repositories") {
    response.writeHead(404).end();
    return;
  }
  if (requestUrl.searchParams.has("role")) {
    response.writeHead(410, { "content-type": "application/json" }).end(
      JSON.stringify({
        error: { message: "CHANGE-2770 - Functionality has been deprecated" },
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(
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
});

try {
  await listen(server);
  process.env.BITBUCKET_API_BASE_URL = apiBaseUrl;
  process.env.APP_DATA_ROOT = dataRoot;
  process.env.RESOURCE_LIBRARY_ROOT = dataRoot;
  const { configureBitbucketConnection, listBitbucketRepositories } =
    await import("../server/bitbucket/connection.ts");
  const tenantId = `repository-list-smoke-${process.pid}`;
  const ownerId = "owner";
  await configureBitbucketConnection(tenantId, ownerId, {
    email: "owner@example.com",
    apiToken: "valid-token",
  });
  const gitConfig = await readFile(
    path.join(
      dataRoot,
      "resource-library",
      "tenants",
      tenantId,
      "users",
      ownerId,
      "integrations",
      "bitbucket-git",
      ".gitconfig",
    ),
    "utf8",
  );
  if (!gitConfig.includes("\thelper =\n\thelper = store")) {
    throw new Error(
      "Bitbucket Git config must clear system credential helpers before enabling the user-scoped store",
    );
  }
  if (!gitConfig.includes("[core]\n\tlongpaths = true")) {
    throw new Error(
      "Bitbucket Git config must enable long paths for Windows checkouts",
    );
  }
  const repositories = await listBitbucketRepositories(
    tenantId,
    ownerId,
    "pay",
  );
  if (repositories.length !== 1 || repositories[0]?.slug !== "payments") {
    throw new Error(
      `expected the authorized repository list, received: ${JSON.stringify(repositories)}`,
    );
  }
  console.log("bitbucket repository list smoke passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(dataRoot, { recursive: true, force: true });
}
