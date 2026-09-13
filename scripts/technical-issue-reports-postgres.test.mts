import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test(
  "PostgreSQL suppresses duplicate Technical Issue Report delivery",
  { skip: process.env.RUN_SUPPORT_REPORT_POSTGRES_TEST !== "true" },
  async (context) => {
    assert(
      process.env.DATABASE_URL,
      "DATABASE_URL is required for the PostgreSQL Technical Issue Report test",
    );
    process.env.ONTOLOGY_IAM_ENABLED = "false";

    let deliveries = 0;
    let emailStatus = 200;
    let emailDelayMs = 0;
    const emailServer = http.createServer(async (_request, response) => {
      deliveries += 1;
      if (emailDelayMs)
        await new Promise((resolve) => setTimeout(resolve, emailDelayMs));
      response.writeHead(emailStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true }));
    });
    const emailBaseUrl = await listen(emailServer);
    context.after(() => close(emailServer));

    const [
      { default: express },
      { ensureMigrations },
      { createSupportRouter },
      { errorHandler },
      repository,
    ] = await Promise.all([
      import("express"),
      import("../server/db/migrations.ts"),
      import("../server/support/routes.ts"),
      import("../server/http.ts"),
      import("../server/ontologies/repository.ts"),
    ]);
    await ensureMigrations();

    const project = await repository.createProject({
      tenantId: "support-report-postgres-test",
      ownerId: "support-report-postgres-test",
      name: "PostgreSQL support report test",
    });
    context.after(() =>
      repository.deleteProject(
        "support-report-postgres-test",
        "support-report-postgres-test",
        project.id,
      ),
    );
    const session = await repository.createSession(
      "support-report-postgres-test",
      "support-report-postgres-test",
      project.id,
      "PostgreSQL duplicate delivery",
    );

    const app = express();
    let clock = new Date("2026-08-06T00:00:00.000Z");
    app.use(express.json());
    app.use(
      "/api/v1/support",
      createSupportRouter({
        emailApiUrl: `${emailBaseUrl}/api/v1/notification-pushes/send-email`,
        now: () => clock,
      }),
    );
    app.use(errorHandler);
    const appServer = http.createServer(app);
    const appBaseUrl = await listen(appServer);
    context.after(() => close(appServer));

    const request = {
      reportRequestId: crypto.randomUUID(),
      ontologyId: project.id,
      sessionId: session.id,
    };
    const submit = (body: unknown = request) =>
      fetch(`${appBaseUrl}/api/v1/support/issue-reports`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          TenantID: "support-report-postgres-test",
          "x-user-id": "support-report-postgres-test",
        },
        body: JSON.stringify(body),
      });

    const first = await submit();
    const replay = await submit();
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(deliveries, 1);

    const conflict = await submit({
      ...request,
      clientContext: { locale: "zh-CN" },
    });
    assert.equal(conflict.status, 409);
    assert.equal(deliveries, 1);

    emailDelayMs = 50;
    const concurrentRequest = {
      ...request,
      reportRequestId: crypto.randomUUID(),
    };
    const concurrent = await Promise.all([
      submit(concurrentRequest),
      submit(concurrentRequest),
    ]);
    assert.deepEqual(concurrent.map((item) => item.status).sort(), [201, 202]);
    assert.equal(deliveries, 2);

    emailDelayMs = 0;
    emailStatus = 503;
    const retryRequest = {
      ...request,
      reportRequestId: crypto.randomUUID(),
    };
    assert.equal((await submit(retryRequest)).status, 502);
    emailStatus = 200;
    assert.equal((await submit(retryRequest)).status, 201);
    assert.equal(deliveries, 4);

    const expiryRequest = {
      ...request,
      reportRequestId: crypto.randomUUID(),
    };
    assert.equal((await submit(expiryRequest)).status, 201);
    assert.equal((await submit(expiryRequest)).status, 200);
    assert.equal(deliveries, 5);
    clock = new Date("2026-08-07T00:00:00.001Z");
    assert.equal((await submit(expiryRequest)).status, 201);
    assert.equal(deliveries, 6);
  },
);
