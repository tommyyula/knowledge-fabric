import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type CapturedRequest = {
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function captureBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("user can email a scoped Technical Issue Report with the latest conversation attached", async (context) => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "knowledge-fabric-support-report-"),
  );
  process.env.APP_DATA_ROOT = dataRoot;
  process.env.ONTOLOGY_IAM_ENABLED = "false";
  process.env.DATABASE_URL = "";

  const captured: CapturedRequest[] = [];
  let emailStatus = 200;
  let emailDelayMs = 0;
  const emailServer = http.createServer(async (request, response) => {
    captured.push({
      headers: request.headers,
      body: await captureBody(request),
    });
    if (emailDelayMs)
      await new Promise((resolve) => setTimeout(resolve, emailDelayMs));
    response.writeHead(emailStatus, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: true }));
  });
  const emailBaseUrl = await listen(emailServer);
  context.after(() => close(emailServer));

  const [
    { default: express },
    { createSupportRouter },
    { errorHandler },
    repository,
    workspace,
  ] = await Promise.all([
    import("express"),
    import("../server/support/routes.ts"),
    import("../server/http.ts"),
    import("../server/ontologies/repository.ts"),
    import("../server/ontologies/workspace.ts"),
  ]);

  const project = await repository.createProject({
    tenantId: "tenant-a",
    ownerId: "user-a",
    name: "Supportable Knowledge",
  });
  const session = await repository.createSession(
    "tenant-a",
    "user-a",
    project.id,
    "Broken review flow",
  );
  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      repository.appendMessage(
        {
          tenantId: "tenant-a",
          ownerId: "user-a",
          ontologyId: project.id,
          sessionId: session.id,
        },
        {
          role: index % 2 === 0 ? "user" : "assistant",
          content:
            index === 0
              ? "too-old-marker"
              : index === 23
                ? `token=conversation-secret ${"x".repeat(6_000)}`
                : index === 24
                  ? "latest <message>"
                  : `message-${index}`,
        },
      ),
    ),
  );
  const journeyState = workspace.initialJourneyState();
  journeyState.phase = "review";
  journeyState.review = {
    description: "Pending review",
    status: "pending",
    draftId: "draft-7",
    files: [],
  };
  await workspace.writeJourneyState(
    workspace.workspacePath("tenant-a", "user-a", project.id),
    journeyState,
  );
  await repository.appendRunEvent({
    tenantId: "tenant-a",
    ontologyId: project.id,
    sessionId: session.id,
    runId: "run-latest",
    sequence: 1,
    event: {
      type: "tool",
      tool: "Read",
      input: { path: "E:\\private\\secret.md", token: "must-not-leak" },
    },
  });
  await repository.appendRunEvent({
    tenantId: "tenant-a",
    ontologyId: project.id,
    sessionId: session.id,
    runId: "run-latest",
    sequence: 2,
    event: {
      type: "error",
      error: [
        "Read failed at E:\\private\\secret.md token=must-not-leak",
        "Workspace path /srv/knowledge-fabric/private/secret.md",
        '{"token":"quoted-secret","password":"quoted-password"}',
        "Cookie: session=cookie-secret",
        "Authorization: Basic dXNlcjpwYXNzd29yZA==",
        "eyJaaaaaaaaaaa.bbbbbbbbbbb.ccccccccccc",
        "AKIAABCDEFGHIJKLMNOP",
        "sk-proj-abcdefghijklmnopqrstuv",
        "xoxb-1234567890-abcdefghijklmnop",
        "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
      ].join("\n"),
    },
  });

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

  const requestBody = {
    reportRequestId: "4f2e33f0-6f8f-41c7-8746-1479eabf5588",
    ontologyId: project.id,
    sessionId: session.id,
    clientContext: {
      pageUrl: "https://knowledge.example.test/chat?access_token=client-secret",
      userAgent: "Support Browser/1.0",
      locale: "zh-CN",
      timeZone: "Asia/Shanghai",
      appRelease: "test-release",
    },
  };
  const submit = (body: unknown = requestBody) =>
    fetch(`${appBaseUrl}/api/v1/support/issue-reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        TenantID: "tenant-a",
        "x-user-id": "user-a",
      },
      body: JSON.stringify(body),
    });

  const response = await submit();

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    data: {
      reportRequestId: "4f2e33f0-6f8f-41c7-8746-1479eabf5588",
      status: "sent",
    },
  });
  const persistedIdempotency = await readFile(
    path.join(dataRoot, "support-report-idempotency.json"),
    "utf8",
  );
  assert.match(
    persistedIdempotency,
    /4f2e33f0-6f8f-41c7-8746-1479eabf5588/,
  );
  assert.doesNotMatch(
    persistedIdempotency,
    /Supportable Knowledge|latest <message>|marketplace@item\.com|must-not-leak/,
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers["time-zone"], "Asia/Shanghai");
  assert.match(
    captured[0].headers["content-type"] ?? "",
    /^multipart\/form-data; boundary=/,
  );

  const multipart = captured[0].body.toString("utf8");
  const title = multipart.match(/name="Title"\r\n\r\n([^\r\n]*)/)?.[1];
  assert.equal(
    title,
    "[Knowledge Fabric][Technical Issue Report][4f2e33f0-6f8f-41c7-8746-1479eabf5588] Supportable Knowledge",
  );
  assert.match(multipart, /name="Emails\[0\]"\r\n\r\nmarketplace@item\.com/);
  assert.match(
    multipart,
    /name="attachments"; filename="knowledge-fabric-issue-report-4f2e33f0-6f8f-41c7-8746-1479eabf5588\.html"/,
  );
  assert.match(multipart, /Supportable Knowledge/);
  assert.match(multipart, /Broken review flow/);
  assert.match(multipart, /latest &lt;message&gt;/);
  assert.doesNotMatch(multipart, /too-old-marker/);
  assert.match(multipart, /Support Browser\/1\.0/);
  assert.match(multipart, /knowledge\.example\.test/);
  assert.match(multipart, /Client application release/);
  assert.match(multipart, /Server application release/);
  assert.match(multipart, /Run diagnostics/);
  assert.match(multipart, /run-latest/);
  assert.match(multipart, /Failed/);
  assert.match(multipart, /review/);
  assert.match(multipart, /Read/);
  assert.doesNotMatch(
    multipart,
    /must-not-leak|quoted-secret|quoted-password|cookie-secret|dXNlcjpwYXNzd29yZA|eyJaaaaaaaaaaa|AKIAABCDEFGHIJKLMNOP|sk-proj-abcdefghijklmnopqrstuv|xoxb-1234567890-abcdefghijklmnop|private-key-material/,
  );
  assert.doesNotMatch(multipart, /E:\\private/);
  assert.doesNotMatch(multipart, /\/srv\/knowledge-fabric/);
  assert.doesNotMatch(multipart, /conversation-secret|client-secret/);
  assert.match(multipart, /\[truncated\]/);

  const replay = await submit();
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    data: {
      reportRequestId: "4f2e33f0-6f8f-41c7-8746-1479eabf5588",
      status: "sent",
      replayed: true,
    },
  });
  assert.equal(captured.length, 1);

  const conflict = await submit({
    ...requestBody,
    clientContext: {
      ...requestBody.clientContext,
      pageUrl: "https://different.example.test",
    },
  });
  assert.equal(conflict.status, 409);
  assert.equal(captured.length, 1);

  const untrusted = await submit({
    ...requestBody,
    reportRequestId: "abdd8eca-4925-4ca4-b15f-8c4e23d9cfea",
    recipients: ["attacker@example.test"],
    conversation: "caller supplied transcript",
  });
  assert.equal(untrusted.status, 400);
  assert.equal(captured.length, 1);

  const wrongUser = await fetch(`${appBaseUrl}/api/v1/support/issue-reports`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      TenantID: "tenant-a",
      "x-user-id": "user-b",
    },
    body: JSON.stringify({
      ...requestBody,
      reportRequestId: "553dbd9d-d67c-412d-8805-0d59b9c2d594",
    }),
  });
  assert.equal(wrongUser.status, 404);
  assert.equal(captured.length, 1);

  const retryBody = {
    ...requestBody,
    reportRequestId: "df0a0a30-6bf5-4072-a16b-8359bdbec7ca",
  };
  emailStatus = 503;
  const failed = await submit(retryBody);
  assert.equal(failed.status, 502);
  emailStatus = 200;
  const retried = await submit(retryBody);
  assert.equal(retried.status, 201);
  assert.equal(captured.length, 3);

  const concurrentBody = {
    ...requestBody,
    reportRequestId: "2a58c5be-0bdc-4b2b-881c-eab81542668e",
  };
  emailDelayMs = 50;
  const concurrent = await Promise.all([
    submit(concurrentBody),
    submit(concurrentBody),
  ]);
  assert.deepEqual(concurrent.map((item) => item.status).sort(), [201, 202]);
  assert.equal(captured.length, 4);

  emailDelayMs = 0;
  const expiringBody = {
    ...requestBody,
    reportRequestId: "1103bc0c-ad52-49f3-882d-f91e720f45cd",
  };
  const beforeExpiry = await submit(expiringBody);
  assert.equal(beforeExpiry.status, 201);
  const withinWindow = await submit(expiringBody);
  assert.equal(withinWindow.status, 200);
  assert.equal(captured.length, 5);
  clock = new Date("2026-08-07T00:00:00.001Z");
  const afterExpiry = await submit(expiringBody);
  assert.equal(afterExpiry.status, 201);
  assert.equal(captured.length, 6);
  const afterExpiryReplay = await submit(expiringBody);
  assert.equal(afterExpiryReplay.status, 200);
  assert.equal(captured.length, 6);

  const configuredApp = express();
  configuredApp.use(express.json());
  configuredApp.use(
    "/api/v1/support",
    createSupportRouter({
      emailApiUrl: `${emailBaseUrl}/api/v1/notification-pushes/send-email`,
      recipients: "support-one@example.test, support-two@example.test",
      now: () => clock,
    }),
  );
  configuredApp.use(errorHandler);
  const configuredServer = http.createServer(configuredApp);
  const configuredBaseUrl = await listen(configuredServer);
  context.after(() => close(configuredServer));
  const configuredRecipientResponse = await fetch(
    `${configuredBaseUrl}/api/v1/support/issue-reports`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        TenantID: "tenant-a",
        "x-user-id": "user-a",
      },
      body: JSON.stringify({
        ...requestBody,
        reportRequestId: "7be17808-2303-4a45-b48e-8488ee9ba6cf",
      }),
    },
  );
  assert.equal(configuredRecipientResponse.status, 201);
  const configuredMultipart = captured.at(-1)?.body.toString("utf8") ?? "";
  assert.match(
    configuredMultipart,
    /name="Emails\[0\]"\r\n\r\nsupport-one@example\.test/,
  );
  assert.match(
    configuredMultipart,
    /name="Emails\[1\]"\r\n\r\nsupport-two@example\.test/,
  );

  const timeoutApp = express();
  timeoutApp.use(express.json());
  timeoutApp.use(
    "/api/v1/support",
    createSupportRouter({
      emailApiUrl: `${emailBaseUrl}/api/v1/notification-pushes/send-email`,
      timeoutMs: 10,
      now: () => clock,
    }),
  );
  timeoutApp.use(errorHandler);
  const timeoutServer = http.createServer(timeoutApp);
  const timeoutBaseUrl = await listen(timeoutServer);
  context.after(() => close(timeoutServer));
  emailDelayMs = 100;
  const deliveriesBeforeTimeout = captured.length;
  const timedOut = await fetch(
    `${timeoutBaseUrl}/api/v1/support/issue-reports`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        TenantID: "tenant-a",
        "x-user-id": "user-a",
      },
      body: JSON.stringify({
        ...requestBody,
        reportRequestId: "17219625-a73d-4210-a9c7-df8c5c3c8f80",
      }),
    },
  );
  assert.equal(timedOut.status, 202);
  assert.deepEqual(await timedOut.json(), {
    data: {
      reportRequestId: "17219625-a73d-4210-a9c7-df8c5c3c8f80",
      status: "delivery_unknown",
    },
  });
  const retryAfterUnknownDelivery = await fetch(
    `${timeoutBaseUrl}/api/v1/support/issue-reports`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        TenantID: "tenant-a",
        "x-user-id": "user-a",
      },
      body: JSON.stringify({
        ...requestBody,
        reportRequestId: "17219625-a73d-4210-a9c7-df8c5c3c8f80",
      }),
    },
  );
  assert.equal(retryAfterUnknownDelivery.status, 202);
  assert.deepEqual(await retryAfterUnknownDelivery.json(), {
    data: {
      reportRequestId: "17219625-a73d-4210-a9c7-df8c5c3c8f80",
      status: "delivery_unknown",
    },
  });
  assert.equal(captured.length, deliveriesBeforeTimeout + 1);
});

test("Run event details are constrained to the captured status cutoff", async () => {
  const { eventsWithinRunSnapshot } = await import(
    "../server/support/report-builder.ts"
  );
  const captured = eventsWithinRunSnapshot(
    {
      runId: "run-snapshot",
      active: true,
      completed: false,
      eventCount: 1,
      lastSequence: 1,
      updatedAt: "2026-08-06T00:00:01.000Z",
    },
    [
      {
        tenantId: "tenant-a",
        ontologyId: "kb-a",
        sessionId: "session-a",
        runId: "run-snapshot",
        sequence: 1,
        event: { type: "tool", tool: "Read" },
        createdAt: "2026-08-06T00:00:01.000Z",
      },
      {
        tenantId: "tenant-a",
        ontologyId: "kb-a",
        sessionId: "session-a",
        runId: "run-snapshot",
        sequence: 2,
        event: { type: "error", error: "arrived later" },
        createdAt: "2026-08-06T00:00:02.000Z",
      },
    ],
  );
  assert.deepEqual(
    captured.map((event) => event.sequence),
    [1],
  );
});

test("email transport distinguishes unsent connection failures from ambiguous failures", async () => {
  const { deliveryOutcomeForFetchError } = await import(
    "../server/support/email-client.ts"
  );
  assert.equal(
    deliveryOutcomeForFetchError({ cause: { code: "ECONNREFUSED" } }),
    "rejected",
  );
  assert.equal(
    deliveryOutcomeForFetchError({ name: "TimeoutError" }),
    "unknown",
  );
  assert.equal(
    deliveryOutcomeForFetchError({ errors: [{ code: "ENOTFOUND" }] }),
    "rejected",
  );
});

test("report builder labels missing, active, and completed Run state", async () => {
  const { buildCoreReport } = await import(
    "../server/support/report-builder.ts"
  );
  const base = {
    reportRequestId: "17ec7385-e0ad-48f4-8224-2a2b821c6acb",
    submittedAt: "2026-08-06T00:00:00.000Z",
    tenantId: "tenant-a",
    user: { id: "user-a", displayName: "User A", email: "a@example.test" },
    project: { id: "kb-a", name: "KB A", status: "active" },
    session: { id: "session-a", preview: "Session A" },
    messages: [],
    appRelease: "test",
    journeyState: null,
    runEvents: [],
  };
  const missing = buildCoreReport({
    ...base,
    runStatus: {
      runId: null,
      active: false,
      completed: false,
      eventCount: 0,
      lastSequence: null,
      updatedAt: null,
    },
  });
  assert.match(missing, /Journey state<\/th><td>Unavailable/);
  assert.match(missing, /Run state<\/th><td>Unavailable/);

  const active = buildCoreReport({
    ...base,
    runStatus: {
      runId: "run-active",
      active: true,
      completed: false,
      eventCount: 1,
      lastSequence: 1,
      updatedAt: "2026-08-06T00:00:01.000Z",
    },
    runEvents: [
      {
        tenantId: "tenant-a",
        ontologyId: "kb-a",
        sessionId: "session-a",
        runId: "run-active",
        sequence: 1,
        event: { type: "tool", tool: "Read" },
        createdAt: "2026-08-06T00:00:01.000Z",
      },
    ],
  });
  assert.match(active, /Run state<\/th><td>Active/);

  const completed = buildCoreReport({
    ...base,
    runStatus: {
      runId: "run-completed",
      active: false,
      completed: true,
      eventCount: 1,
      lastSequence: 1,
      updatedAt: "2026-08-06T00:00:01.000Z",
    },
  });
  assert.match(completed, /Run state<\/th><td>Completed/);
});

test("frontend submission resolves only after a sent response", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dispatchEvent: () => true },
  });
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage)
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  });

  const responses = [
    new Response(
      JSON.stringify({
        data: { reportRequestId: "frontend-report", status: "sent" },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    ),
    new Response(
      JSON.stringify({
        data: {
          reportRequestId: "frontend-report",
          status: "delivery_unknown",
        },
      }),
      { status: 202, headers: { "content-type": "application/json" } },
    ),
  ];
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    const response = responses.shift();
    assert(response);
    return response;
  };

  const { createServer } = await import("vite");
  const vite = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  context.after(() => vite.close());
  const service = (await vite.ssrLoadModule(
    "/src/services/api/support.ts",
  )) as typeof import("../src/services/api/support.ts");
  const request = {
    reportRequestId: "44d824f7-8a2e-42fc-8c1e-f3a9eb206afd",
    ontologyId: "kb-a",
    sessionId: "session-a",
  };
  await service.submitTechnicalIssueReport(request);
  assert.match(requests[0]?.input ?? "", /\/api\/v1\/support\/issue-reports$/);
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), request);
  await assert.rejects(
    service.submitTechnicalIssueReport(request),
    /delivery outcome is unknown/,
  );
});
