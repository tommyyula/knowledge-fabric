import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

test("video SOP model request does not inherit the global fetch header timeout", async (context) => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "knowledge-fabric-video-sop-"),
  );
  process.env.APP_DATA_ROOT = dataRoot;
  process.env.DASHSCOPE_API_KEY = "test-key";
  process.env.DASHSCOPE_VL_MODEL = "test-model";
  process.env.VIDEO_SOP_ANALYSIS_TIMEOUT_MS = "500";

  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the complete request before simulating slow model inference.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              content: JSON.stringify({
                operations: [
                  {
                    seq: 1,
                    screen: 0,
                    systemPath: "Test",
                    operation: "Verify timeout handling",
                    startSecond: 0,
                    endSecond: 1,
                  },
                ],
              }),
            },
          },
        ],
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  const upstreamBaseUrl = await listen(upstream);
  process.env.DASHSCOPE_BASE_URL = `${upstreamBaseUrl}/compatible-mode/v1`;

  const originalFetch = globalThis.fetch;
  let globalFetchCalls = 0;
  globalThis.fetch = (() => {
    globalFetchCalls += 1;
    const cause = Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    return Promise.reject(new TypeError("fetch failed", { cause }));
  }) as typeof fetch;
  context.after(async () => {
    globalThis.fetch = originalFetch;
    await close(upstream);
    await rm(dataRoot, { recursive: true, force: true });
  });

  const jobId = "vsj-timeout-regression";
  const videoPath = path.join(
    dataRoot,
    "video-sop",
    "jobs",
    "tenant-a",
    "user-a",
    jobId,
    "0.mp4",
  );
  await mkdir(path.dirname(videoPath), { recursive: true });
  await writeFile(videoPath, Buffer.from("test-video"));

  const { analyzeVideoSopOperations } =
    await import("../server/video-sop/model.ts");
  const now = new Date().toISOString();
  const operations = await analyzeVideoSopOperations(
    {
      id: jobId,
      tenantId: "tenant-a",
      ownerId: "user-a",
      status: "analyzing_video",
      videos: [{ name: "test.mp4", size: 10, screen: 0 }],
      videoNames: ["test.mp4"],
      videoCount: 1,
      totalBytes: 10,
      language: "en",
      createdAt: now,
      updatedAt: now,
      expiresAt: now,
    },
    new AbortController().signal,
  );

  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.operation, "Verify timeout handling");
  assert.equal(globalFetchCalls, 0);
});
