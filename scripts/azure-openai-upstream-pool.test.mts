import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import {
  AzureChatCompletionConfigurationError,
  AzureChatCompletionPoolError,
  DEFAULT_AZURE_URL,
  createAzureChatCompletionPool,
  initializeAzureChatCompletionPool,
} from "../server/proxy/azure-chat-completion-pool.ts";
import { directChatCompletion } from "../server/proxy/direct-completion.ts";
import { env } from "../server/env.ts";
import { anthropicOpenAiProxyRouter } from "../server/proxy/anthropic-openai-proxy.ts";

function visibleSse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;
}

function completedSse(text: string): string {
  return `${visibleSse(text)}data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
}

function failAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(message)), ms),
  );
}

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

async function createProxyServer(context: test.TestContext): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api/proxy", anthropicOpenAiProxyRouter);
  const server = http.createServer(app);
  const baseUrl = await listen(server);
  context.after(() => close(server));
  return baseUrl;
}

test("legacy Azure credentials expose one chat-completion upstream", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const pool = createAzureChatCompletionPool({
    environment: { AZURE_OPENAI_API_KEY: "legacy-secret" },
    fetchCompletion: async (input, init) => {
      requests.push({ input: String(input), init });
      return new Response(completedSse("ok"), { status: 200 });
    },
  });

  const response = await pool.request({
    body: { model: "gpt-test", messages: [] },
    stream: true,
  });

  assert.equal(response.upstreamId, "legacy-azure");
  assert.equal(response.response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.input, DEFAULT_AZURE_URL);
  assert.deepEqual(requests[0]?.init?.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer legacy-secret",
  });
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    model: "gpt-test",
    messages: [],
  });
});

test("an unconfigured Azure pool stays disabled with a safe caller error", async () => {
  const pool = createAzureChatCompletionPool({
    environment: {},
    fetchCompletion: async () => {
      throw new Error("network should not be called");
    },
  });

  await assert.rejects(
    pool.request({ body: { model: "gpt-test" }, stream: true }),
    (error: unknown) => {
      assert(error instanceof AzureChatCompletionPoolError);
      assert.equal(error.status, 503);
      assert.equal(error.message, "Azure OpenAI is not configured");
      return true;
    },
  );
});

test("non-streaming Agent completions use the initialized Azure pool", async (context) => {
  const originalModel = process.env.ONTOLOGY_PROXY_MODEL;
  const originalProvider = process.env.ONTOLOGY_PROXY_PROVIDER;
  const originalPool = process.env.AZURE_OPENAI_UPSTREAMS;
  const originalKey = process.env.AZURE_OPENAI_API_KEY;
  context.after(() => {
    if (originalModel === undefined) delete process.env.ONTOLOGY_PROXY_MODEL;
    else process.env.ONTOLOGY_PROXY_MODEL = originalModel;
    if (originalProvider === undefined)
      delete process.env.ONTOLOGY_PROXY_PROVIDER;
    else process.env.ONTOLOGY_PROXY_PROVIDER = originalProvider;
    if (originalPool === undefined) delete process.env.AZURE_OPENAI_UPSTREAMS;
    else process.env.AZURE_OPENAI_UPSTREAMS = originalPool;
    if (originalKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
    else process.env.AZURE_OPENAI_API_KEY = originalKey;
  });
  delete process.env.ONTOLOGY_PROXY_MODEL;
  process.env.ONTOLOGY_PROXY_PROVIDER = "azure";
  delete process.env.AZURE_OPENAI_API_KEY;
  process.env.AZURE_OPENAI_UPSTREAMS = "configured-at-startup";

  let requestedUrl = "";
  let requestedModel = "";
  initializeAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_API_KEY: "direct-secret",
      AZURE_OPENAI_CHAT_COMPLETIONS_URL:
        "https://direct.example.test/chat/completions",
    },
    fetchCompletion: async (input, init) => {
      requestedUrl = String(input);
      requestedModel =
        (JSON.parse(String(init?.body)) as { model?: string }).model ?? "";
      return Response.json({
        choices: [{ message: { content: "pooled answer" } }],
      });
    },
  });

  assert.equal(await directChatCompletion("hello"), "pooled answer");
  assert.equal(requestedUrl, "https://direct.example.test/chat/completions");
  assert.equal(requestedModel, "gpt-5.4");
});

test("configured Azure upstreams follow equal and weighted capacity at low concurrency", async () => {
  const distribution = async (firstWeight: number, secondWeight: number) => {
    const pool = createAzureChatCompletionPool({
      environment: {
        AZURE_OPENAI_UPSTREAMS: JSON.stringify([
          {
            id: "azure-a",
            url: "https://a.example.test/chat/completions",
            apiKey: "secret-a",
            weight: firstWeight,
          },
          {
            id: "azure-b",
            url: "https://b.example.test/chat/completions",
            apiKey: "secret-b",
            weight: secondWeight,
          },
        ]),
      },
      fetchCompletion: async () => new Response(completedSse("ok")),
    });

    const selected: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const result = await pool.request({
        body: { model: "gpt-test" },
        stream: true,
      });
      selected.push(result.upstreamId);
      await result.response.text();
    }
    return Object.fromEntries(
      [...new Set(selected)].map((id) => [
        id,
        selected.filter((value) => value === id).length,
      ]),
    );
  };

  assert.deepEqual(await distribution(1, 1), {
    "azure-a": 3,
    "azure-b": 3,
  });
  assert.deepEqual(await distribution(2, 1), {
    "azure-a": 4,
    "azure-b": 2,
  });
});

test("configured Azure upstreams prefer lower normalized in-flight load", async () => {
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test/chat/completions",
          apiKey: "secret-a",
          weight: 2,
        },
        {
          id: "azure-b",
          url: "https://b.example.test/chat/completions",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    fetchCompletion: async () => new Response(visibleSse("held open")),
  });

  const first = await pool.request({ body: {}, stream: true });
  const second = await pool.request({ body: {}, stream: true });
  const third = await pool.request({ body: {}, stream: true });

  assert.deepEqual(
    [first.upstreamId, second.upstreamId, third.upstreamId],
    ["azure-a", "azure-b", "azure-a"],
  );
  await Promise.all([
    first.response.body?.cancel(),
    second.response.body?.cancel(),
    third.response.body?.cancel(),
  ]);
});

test("explicit Azure pool configuration is validated without echoing secrets", () => {
  assert.throws(
    () =>
      createAzureChatCompletionPool({
        environment: {
          AZURE_OPENAI_API_KEY: "legacy-must-not-win",
          AZURE_OPENAI_UPSTREAMS: JSON.stringify([
            {
              id: "duplicate",
              url: "https://a.example.test",
              apiKey: "do-not-print-a",
              weight: 1,
            },
            {
              id: "duplicate",
              url: "ftp://b.example.test",
              apiKey: "do-not-print-b",
              weight: 0,
            },
          ]),
        },
      }),
    (error: unknown) => {
      assert(error instanceof AzureChatCompletionConfigurationError);
      assert.match(error.message, /ids must be unique/);
      assert.doesNotMatch(error.message, /do-not-print|legacy-must-not-win/);
      return true;
    },
  );
});

test("a rate-limited non-streaming attempt fails over to a different upstream", async () => {
  const calls: string[] = [];
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test/chat/completions",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test/chat/completions",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    fetchCompletion: async (input) => {
      calls.push(String(input));
      if (calls.length === 1)
        return new Response("sensitive quota details", { status: 429 });
      return Response.json({
        choices: [{ message: { content: "recovered" } }],
      });
    },
  });

  const result = await pool.request({
    body: { model: "gpt-test" },
    stream: false,
  });

  assert.equal(result.upstreamId, "azure-b");
  assert.equal(
    (
      (await result.response.json()) as {
        choices: Array<{ message: { content: string } }>;
      }
    ).choices[0]?.message.content,
    "recovered",
  );
  assert.deepEqual(calls, [
    "https://a.example.test/chat/completions",
    "https://b.example.test/chat/completions",
  ]);
});

test("a stream that ends before visible content fails over without leaking buffered events", async () => {
  const roleOnly = `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`;
  const visible = completedSse("recovered");
  const calls: string[] = [];
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test/chat/completions",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test/chat/completions",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    fetchCompletion: async (input) => {
      calls.push(String(input));
      return new Response(calls.length === 1 ? roleOnly : visible, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const result = await pool.request({
    body: { model: "gpt-test" },
    stream: true,
  });

  assert.equal(result.upstreamId, "azure-b");
  assert.equal(await result.response.text(), visible);
  assert.equal(calls.length, 2);
});

test("a stream failure after visible content is surfaced without failover", async () => {
  const encoder = new TextEncoder();
  let pulls = 0;
  const brokenStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1)
        controller.enqueue(encoder.encode(visibleSse("partial")));
      else controller.error(new Error("stream broke after commitment"));
    },
  });
  let calls = 0;
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    fetchCompletion: async () => {
      calls += 1;
      return new Response(brokenStream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const result = await pool.request({ body: {}, stream: true });

  assert.equal(result.upstreamId, "azure-a");
  await assert.rejects(
    result.response.text(),
    /Azure OpenAI stream failed after response commitment/,
  );
  assert.equal(calls, 1);
});

test("a stream ending after visible content without a terminal event fails safely", async () => {
  const pool = createAzureChatCompletionPool({
    environment: { AZURE_OPENAI_API_KEY: "secret" },
    fetchCompletion: async () => new Response(visibleSse("partial")),
  });

  const result = await pool.request({ body: {}, stream: true });

  await assert.rejects(
    result.response.text(),
    /Azure OpenAI stream failed after response commitment/,
  );
});

test("content-filter termination without content is not replayed", async () => {
  const filtered = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] })}\n\n`;
  let calls = 0;
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    fetchCompletion: async () => {
      calls += 1;
      return new Response(filtered);
    },
  });

  const result = await pool.request({ body: {}, stream: true });

  assert.equal(await result.response.text(), filtered);
  assert.equal(calls, 1);
});

test("malformed non-streaming data fails over but a valid empty completion does not", async () => {
  let malformedCalls = 0;
  const malformedPool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    fetchCompletion: async () => {
      malformedCalls += 1;
      return malformedCalls === 1
        ? new Response("not-json")
        : Response.json({ choices: [{ message: { content: "valid" } }] });
    },
  });
  assert.equal(
    (await malformedPool.request({ body: {}, stream: false })).upstreamId,
    "azure-b",
  );
  assert.equal(malformedCalls, 2);

  let emptyCalls = 0;
  const emptyPool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    fetchCompletion: async () => {
      emptyCalls += 1;
      return Response.json({ choices: [{ message: { content: null } }] });
    },
  });
  const emptyResult = await emptyPool.request({ body: {}, stream: false });
  assert.equal(
    (
      (await emptyResult.response.json()) as {
        choices: Array<{ message: { content: null } }>;
      }
    ).choices[0]?.message.content,
    null,
  );
  assert.equal(emptyCalls, 1);
});

test("a caller request error is returned safely without failover", async () => {
  let calls = 0;
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    fetchCompletion: async () => {
      calls += 1;
      return new Response("secret validation detail", { status: 400 });
    },
  });

  await assert.rejects(
    pool.request({ body: {}, stream: false }),
    (error: unknown) => {
      assert(error instanceof AzureChatCompletionPoolError);
      assert.equal(error.status, 400);
      assert.doesNotMatch(error.message, /secret validation detail/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("all rate-limited upstreams cool down before one real request probes recovery", async () => {
  let now = 0;
  let calls = 0;
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    now: () => now,
    random: () => 0,
    fetchCompletion: async () => {
      calls += 1;
      if (calls <= 2)
        return new Response("limited", {
          status: 429,
          headers: { "retry-after-ms": "30000" },
        });
      return Response.json({
        choices: [{ message: { content: "recovered" } }],
      });
    },
  });

  await assert.rejects(
    pool.request({ body: {}, stream: false }),
    (error: unknown) => {
      assert(error instanceof AzureChatCompletionPoolError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    },
  );
  await assert.rejects(pool.request({ body: {}, stream: false }), {
    status: 429,
  });
  assert.equal(calls, 2);

  now = 30_000;
  const recovered = await pool.request({ body: {}, stream: false });
  assert.match(recovered.upstreamId, /^azure-[ab]$/);
  assert.equal(calls, 3);
});

test("fail-fast retry timing uses the earliest cooling upstream, including the attempted one", async () => {
  let calls = 0;
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    now: () => 0,
    random: () => 0,
    fetchCompletion: async (input) => {
      calls += 1;
      if (calls === 1)
        return Response.json({
          choices: [{ message: { content: "advance selection" } }],
        });
      if (calls === 2)
        return new Response("limited-b", {
          status: 429,
          headers: { "retry-after-ms": "5000" },
        });
      if (calls === 3) return new Response("caller error", { status: 400 });
      assert.equal(String(input), "https://a.example.test");
      return new Response("limited-a", {
        status: 429,
        headers: { "retry-after-ms": "1000" },
      });
    },
  });

  await pool.request({ body: {}, stream: false });
  await assert.rejects(pool.request({ body: {}, stream: false }), {
    status: 400,
  });
  await assert.rejects(
    pool.request({ body: {}, stream: false }),
    (error: unknown) => {
      assert(error instanceof AzureChatCompletionPoolError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 1_000);
      return true;
    },
  );
});

test("only one request probes a half-open upstream while healthy traffic continues", async () => {
  let now = 0;
  let firstA = true;
  let markProbeStarted: (() => void) | undefined;
  const probeStarted = new Promise<void>((resolve) => {
    markProbeStarted = resolve;
  });
  let probeResponseResolve: ((response: Response) => void) | undefined;
  const pendingProbe = new Promise<Response>((resolve) => {
    probeResponseResolve = resolve;
  });
  const calls: string[] = [];
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    now: () => now,
    random: () => 0,
    fetchCompletion: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("a.example") && firstA) {
        firstA = false;
        return new Response("limited", {
          status: 429,
          headers: { "retry-after-ms": "30000" },
        });
      }
      if (url.includes("a.example")) {
        markProbeStarted?.();
        return pendingProbe;
      }
      return Response.json({ choices: [{ message: { content: "healthy" } }] });
    },
  });

  const initial = await pool.request({ body: {}, stream: false });
  assert.equal(initial.upstreamId, "azure-b");
  now = 30_000;

  const probing = pool.request({ body: {}, stream: false });
  await probeStarted;
  const concurrent = await pool.request({ body: {}, stream: false });
  probeResponseResolve?.(
    Response.json({ choices: [{ message: { content: "probe recovered" } }] }),
  );
  const recovered = await probing;

  assert.equal(concurrent.upstreamId, "azure-b");
  assert.equal(recovered.upstreamId, "azure-a");
  assert.deepEqual(calls, [
    "https://a.example.test",
    "https://b.example.test",
    "https://a.example.test",
    "https://b.example.test",
  ]);
});

test("retry-after-ms wins over Retry-After and missing hints use jittered backoff", async () => {
  const configuredHintPool = createAzureChatCompletionPool({
    environment: { AZURE_OPENAI_API_KEY: "secret" },
    now: () => 0,
    random: () => 0.5,
    fetchCompletion: async () =>
      new Response("limited", {
        status: 429,
        headers: { "retry-after-ms": "1200", "retry-after": "10" },
      }),
  });
  await assert.rejects(
    configuredHintPool.request({ body: {}, stream: false }),
    (error: unknown) => {
      assert(error instanceof AzureChatCompletionPoolError);
      assert.equal(error.retryAfterMs, 1_320);
      return true;
    },
  );

  const fallbackPool = createAzureChatCompletionPool({
    environment: { AZURE_OPENAI_API_KEY: "secret" },
    now: () => 0,
    random: () => 0.5,
    fetchCompletion: async () => new Response("limited", { status: 429 }),
  });
  await assert.rejects(
    fallbackPool.request({ body: {}, stream: false }),
    (error: unknown) => {
      assert(error instanceof AzureChatCompletionPoolError);
      assert.equal(error.retryAfterMs, 33_000);
      return true;
    },
  );
});

test("upstream credential failures use the longer configuration cooldown", async () => {
  let calls = 0;
  const pool = createAzureChatCompletionPool({
    environment: { AZURE_OPENAI_API_KEY: "expired-secret" },
    now: () => 0,
    random: () => 0,
    fetchCompletion: async () => {
      calls += 1;
      return new Response("credential detail", { status: 401 });
    },
  });

  await assert.rejects(pool.request({ body: {}, stream: false }), {
    status: 502,
  });
  await assert.rejects(
    pool.request({ body: {}, stream: false }),
    (error: unknown) => {
      assert(error instanceof AzureChatCompletionPoolError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 5 * 60_000);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("a connection timeout fails over without extending the caller indefinitely", async () => {
  let calls = 0;
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_CONNECT_TIMEOUT_MS: "10",
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    random: () => 0,
    fetchCompletion: async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      }
      return Response.json({
        choices: [{ message: { content: "recovered" } }],
      });
    },
  });

  const result = await Promise.race([
    pool.request({ body: {}, stream: false }),
    failAfter(100, "connection timeout did not fire"),
  ]);

  assert.equal(result.upstreamId, "azure-b");
  assert.equal(calls, 2);
});

test("a first-content timeout fails over before committing the downstream stream", async () => {
  let calls = 0;
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_FIRST_CONTENT_TIMEOUT_MS: "10",
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    random: () => 0,
    fetchCompletion: async () => {
      calls += 1;
      if (calls === 1) return new Response(new ReadableStream<Uint8Array>());
      return new Response(completedSse("recovered"));
    },
  });

  const result = await Promise.race([
    pool.request({ body: {}, stream: true }),
    failAfter(100, "first-content timeout did not fire"),
  ]);

  assert.equal(result.upstreamId, "azure-b");
  assert.equal(await result.response.text(), completedSse("recovered"));
  assert.equal(calls, 2);
});

test("an idle timeout after commitment errors the stream without failover", async () => {
  const encoder = new TextEncoder();
  let pulls = 0;
  const idleStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1)
        controller.enqueue(encoder.encode(visibleSse("partial")));
    },
  });
  let calls = 0;
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_STREAM_IDLE_TIMEOUT_MS: "10",
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    fetchCompletion: async () => {
      calls += 1;
      return new Response(idleStream);
    },
  });

  const result = await pool.request({ body: {}, stream: true });
  await assert.rejects(
    Promise.race([
      result.response.text(),
      failAfter(100, "idle timeout did not fire"),
    ]),
    /Azure OpenAI stream failed after response commitment/,
  );
  assert.equal(calls, 1);
});

test("caller cancellation aborts the active stream without cooling the upstream", async () => {
  const encoder = new TextEncoder();
  let calls = 0;
  const controller = new AbortController();
  const pool = createAzureChatCompletionPool({
    environment: { AZURE_OPENAI_API_KEY: "secret" },
    fetchCompletion: async (_input, init) => {
      calls += 1;
      if (calls > 1)
        return Response.json({
          choices: [{ message: { content: "next request works" } }],
        });
      let pulls = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            init?.signal?.addEventListener(
              "abort",
              () => streamController.error(init.signal?.reason),
              { once: true },
            );
          },
          pull(streamController) {
            pulls += 1;
            if (pulls === 1)
              streamController.enqueue(encoder.encode(visibleSse("partial")));
          },
        }),
      );
    },
  });

  const active = await pool.request({
    body: {},
    stream: true,
    signal: controller.signal,
  });
  const body = active.response.text();
  controller.abort(new Error("caller disconnected"));
  await assert.rejects(
    body,
    /Azure OpenAI stream failed after response commitment/,
  );

  const next = await pool.request({ body: {}, stream: false });
  assert.equal(
    (
      (await next.response.json()) as {
        choices: Array<{ message: { content: string } }>;
      }
    ).choices[0]?.message.content,
    "next request works",
  );
  assert.equal(calls, 2);
});

test("the Anthropic proxy routes sequential requests by configured weight", async (context) => {
  const selectedUrls: string[] = [];
  initializeAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 2,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    fetchCompletion: async (input) => {
      selectedUrls.push(String(input));
      return new Response(completedSse("weighted reply"));
    },
  });
  const baseUrl = await createProxyServer(context);

  for (let requestNumber = 0; requestNumber < 6; requestNumber += 1) {
    const response = await fetch(`${baseUrl}/api/proxy/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": `proxy:${env.proxyToken}:azure:gpt-test`,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: message_stop/);
  }

  assert.equal(
    selectedUrls.filter((url) => url === "https://a.example.test").length,
    4,
  );
  assert.equal(
    selectedUrls.filter((url) => url === "https://b.example.test").length,
    2,
  );
});

test("the Anthropic proxy emits one safe error for a committed Azure stream failure", async (context) => {
  const encoder = new TextEncoder();
  let calls = 0;
  initializeAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://private-a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    fetchCompletion: async () => {
      calls += 1;
      let pulls = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(encoder.encode(visibleSse("partial reply")));
            } else {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ error: { message: "private failure at https://private-a.example.test using secret-a" } })}\n\n`,
                ),
              );
              controller.close();
            }
          },
        }),
      );
    },
  });
  const baseUrl = await createProxyServer(context);

  const response = await fetch(`${baseUrl}/api/proxy/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": `proxy:${env.proxyToken}:azure:gpt-test`,
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.match(body, /partial reply/);
  assert.equal(body.match(/event: error/g)?.length, 1);
  assert.doesNotMatch(body, /event: message_stop/);
  assert.doesNotMatch(body, /private-a|secret-a|private failure/);
});

test("the Anthropic proxy emits only the recovered Azure stream", async (context) => {
  let calls = 0;
  initializeAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    random: () => 0,
    fetchCompletion: async () => {
      calls += 1;
      return new Response(
        calls === 1
          ? `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`
          : completedSse("recovered once"),
      );
    },
  });
  const baseUrl = await createProxyServer(context);

  const response = await fetch(`${baseUrl}/api/proxy/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": `proxy:${env.proxyToken}:azure:gpt-test`,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100,
    }),
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(body.match(/recovered once/g)?.length, 1);
  assert.match(body, /event: message_start/);
  assert.match(body, /event: message_stop/);
});

test("the Anthropic proxy returns a safe retry window when every Azure upstream is limited", async (context) => {
  initializeAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    random: () => 0,
    fetchCompletion: async () =>
      new Response("private quota detail", {
        status: 429,
        headers: { "retry-after-ms": "2500" },
      }),
  });
  const baseUrl = await createProxyServer(context);

  const response = await fetch(`${baseUrl}/api/proxy/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": `proxy:${env.proxyToken}:azure:gpt-test`,
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  const body = (await response.json()) as {
    error?: { type?: string; message?: string };
  };

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3");
  assert.equal(body.error?.type, "rate_limit_error");
  assert.doesNotMatch(
    body.error?.message ?? "",
    /private quota detail|azure-a|azure-b/,
  );
});

test("failure diagnostics are structured and exclude credentials and completion content", async () => {
  const warnings: Array<{ message: string; details: Record<string, unknown> }> =
    [];
  const pool = createAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://private-a.example.test",
          apiKey: "super-secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://private-b.example.test",
          apiKey: "super-secret-b",
          weight: 1,
        },
      ]),
    },
    logger: {
      info() {},
      error() {},
      warn(message, details) {
        warnings.push({ message, details });
      },
    },
    random: () => 0,
    fetchCompletion: async (_input, init) =>
      String(_input).includes("private-a")
        ? new Response("private Azure body", { status: 429 })
        : Response.json({
            choices: [{ message: { content: "private completion" } }],
          }),
  });

  await pool.request({
    body: {
      model: "gpt-test",
      messages: [{ role: "user", content: "private prompt" }],
    },
    stream: false,
  });

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.message, "[azure-pool] attempt failed");
  assert.equal(warnings[0]?.details.upstreamId, "azure-a");
  assert.equal(warnings[0]?.details.attempt, 1);
  assert.equal(warnings[0]?.details.model, "gpt-test");
  assert.equal(warnings[0]?.details.status, 429);
  assert.equal(warnings[0]?.details.circuitState, "cooling");
  assert.equal(typeof warnings[0]?.details.requestId, "string");
  assert.equal(typeof warnings[0]?.details.latencyMs, "number");
  assert.doesNotMatch(
    JSON.stringify(warnings),
    /super-secret|private-a\.example|private-b\.example|private Azure body|private prompt|private completion/,
  );
});

test("non-streaming failover stays inside the caller's total timeout budget", async (context) => {
  const originalModel = process.env.ONTOLOGY_PROXY_MODEL;
  const originalProvider = process.env.ONTOLOGY_PROXY_PROVIDER;
  context.after(() => {
    if (originalModel === undefined) delete process.env.ONTOLOGY_PROXY_MODEL;
    else process.env.ONTOLOGY_PROXY_MODEL = originalModel;
    if (originalProvider === undefined)
      delete process.env.ONTOLOGY_PROXY_PROVIDER;
    else process.env.ONTOLOGY_PROXY_PROVIDER = originalProvider;
  });
  process.env.ONTOLOGY_PROXY_MODEL = "gpt-test";
  process.env.ONTOLOGY_PROXY_PROVIDER = "azure";
  let calls = 0;
  initializeAzureChatCompletionPool({
    environment: {
      AZURE_OPENAI_UPSTREAMS: JSON.stringify([
        {
          id: "azure-a",
          url: "https://a.example.test",
          apiKey: "secret-a",
          weight: 1,
        },
        {
          id: "azure-b",
          url: "https://b.example.test",
          apiKey: "secret-b",
          weight: 1,
        },
      ]),
    },
    logger: { info() {}, warn() {}, error() {} },
    fetchCompletion: async (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    },
  });

  const startedAt = Date.now();
  assert.equal(await directChatCompletion("hello", { timeoutMs: 20 }), null);
  assert(Date.now() - startedAt < 100);
  assert.equal(calls, 1);
});
