import fs from "node:fs/promises";
import { Agent, fetch, type Response } from "undici";
import type { z } from "zod";
import { videoSopConfig } from "./config";
import { VideoSopError } from "./errors";
import {
  normalizeSopResult,
  normalizeVideoOperations,
  sopResultSchema,
  videoAnalysisResponseSchema,
  type SopResult,
  type VideoOperation,
} from "./schemas";
import { sopSystemPrompt, sopUserPrompt, videoAnalysisPrompt } from "./prompts";
import { videoSopVideoPath } from "./files";
import type { VideoSopJobRecord } from "./types";

interface CompletionBody {
  model: string;
  messages: unknown[];
  stream: boolean;
  stream_options: { include_usage: boolean };
  response_format: { type: "json_object" };
}

interface CompletionContext {
  jobId: string;
  phase: string;
  attempt: number;
  sourceVideoCount?: number;
  sourceBytes?: number;
}

const MODEL_DEBUG_PREFIX = "[DEBUG-video-sop-model]";
const MODEL_CONNECT_TIMEOUT_MS = 30_000;
const modelDispatchers = new Map<number, Agent>();

function modelDispatcher(timeoutMs: number): Agent {
  const existing = modelDispatchers.get(timeoutMs);
  if (existing) return existing;
  const dispatcher = new Agent({
    connect: { timeout: MODEL_CONNECT_TIMEOUT_MS },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  modelDispatchers.set(timeoutMs, dispatcher);
  return dispatcher;
}

function endpointForLog(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "<invalid DASHSCOPE_BASE_URL>";
  }
}

function errorForLog(error: unknown): Record<string, unknown> {
  const cause = error && typeof error === "object"
    ? (error as { cause?: unknown }).cause
    : undefined;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    ...(cause && typeof cause === "object"
      ? {
          causeName: cause instanceof Error ? cause.name : undefined,
          causeMessage: cause instanceof Error ? cause.message : undefined,
          causeCode: (cause as { code?: unknown }).code,
        }
      : {}),
  };
}

function transportErrorCode(error: unknown): string | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function modelTransportError(error: unknown): VideoSopError {
  switch (transportErrorCode(error)) {
    case "UND_ERR_HEADERS_TIMEOUT":
      return new VideoSopError(
        "MODEL_HEADERS_TIMEOUT",
        "The model did not return response headers before the configured timeout.",
        504,
      );
    case "UND_ERR_BODY_TIMEOUT":
      return new VideoSopError(
        "MODEL_BODY_TIMEOUT",
        "The model response body timed out.",
        504,
      );
    default:
      return new VideoSopError(
        "MODEL_CONNECTION_FAILED",
        "The server could not connect to the configured model endpoint.",
        502,
      );
  }
}

function modelLog(
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, unknown>,
): void {
  console[level](`${MODEL_DEBUG_PREFIX} ${JSON.stringify({ event, ...details })}`);
}

function upstreamRequestId(response: Response): string | undefined {
  return response.headers.get("x-request-id")
    ?? response.headers.get("x-dashscope-request-id")
    ?? response.headers.get("request-id")
    ?? undefined;
}

function responseTextFromJson(value: unknown): string {
  const body = value as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  throw new VideoSopError("EMPTY_MODEL_RESPONSE", "The model returned an empty response.", 502);
}

async function streamedResponseText(response: Response): Promise<string> {
  if (!response.body) throw new VideoSopError("EMPTY_MODEL_RESPONSE", "The model returned an empty response.", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const chunk = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: unknown } }>;
      };
      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content === "string") output += content;
    } catch {
      // Ignore malformed keepalive frames; the final JSON is validated below.
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(consumeLine);
    if (done) break;
  }
  if (buffer) consumeLine(buffer);
  if (!output.trim()) throw new VideoSopError("EMPTY_MODEL_RESPONSE", "The model returned an empty response.", 502);
  return output;
}

async function completionText(
  body: CompletionBody,
  timeoutMs: number,
  signal: AbortSignal,
  context: CompletionContext,
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const endpoint = `${videoSopConfig.baseUrl}/chat/completions`;
  const requestBody = JSON.stringify(body);
  const requestStartedAt = Date.now();

  modelLog("info", "request_started", {
    ...context,
    endpoint: endpointForLog(endpoint),
    model: body.model,
    requestBytes: Buffer.byteLength(requestBody),
    timeoutMs,
  });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${videoSopConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: requestBody,
      signal: controller.signal,
      dispatcher: modelDispatcher(timeoutMs),
    });
    const requestId = upstreamRequestId(response);
    modelLog(response.ok ? "info" : "warn", "response_headers", {
      ...context,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
    });
    if (!response.ok) {
      throw new VideoSopError(
        response.status === 429 ? "MODEL_RATE_LIMITED" : "MODEL_REQUEST_FAILED",
        `The model request failed with status ${response.status}.`,
        502,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    const output = await (contentType.includes("text/event-stream")
      ? streamedResponseText(response)
      : responseTextFromJson(await response.json()));
    modelLog("info", "response_completed", {
      ...context,
      requestId,
      responseChars: output.length,
      elapsedMs: Date.now() - requestStartedAt,
    });
    return output;
  } catch (error) {
    const mappedError =
      error instanceof VideoSopError ? error : modelTransportError(error);
    modelLog("error", "request_failed", {
      ...context,
      elapsedMs: Date.now() - requestStartedAt,
      timedOut,
      parentAborted: signal.aborted,
      mappedCode: timedOut
        ? "MODEL_TIMEOUT"
        : signal.aborted
          ? "CANCELED"
          : mappedError.code,
      ...errorForLog(error),
    });
    if (timedOut) throw new VideoSopError("MODEL_TIMEOUT", "The model request timed out.", 504);
    if (signal.aborted || error instanceof VideoSopError) throw error;
    throw mappedError;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abortFromParent);
  }
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const objectStart = trimmed.indexOf("{");
    const arrayStart = trimmed.indexOf("[");
    const starts = [objectStart, arrayStart].filter((value) => value >= 0);
    const start = starts.length ? Math.min(...starts) : -1;
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("The model response is not valid JSON.");
  }
}

async function validatedCompletion<T>(input: {
  body: CompletionBody;
  timeoutMs: number;
  signal: AbortSignal;
  schema: z.ZodType<T>;
  phase: string;
  jobId: string;
  sourceVideoCount?: number;
  sourceBytes?: number;
}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = await completionText(input.body, input.timeoutMs, input.signal, {
        jobId: input.jobId,
        phase: input.phase,
        attempt: attempt + 1,
        ...(input.sourceVideoCount === undefined
          ? {}
          : { sourceVideoCount: input.sourceVideoCount }),
        ...(input.sourceBytes === undefined ? {} : { sourceBytes: input.sourceBytes }),
      });
      return input.schema.parse(parseJsonText(text));
    } catch (error) {
      if (input.signal.aborted) throw error;
      if (!(error instanceof VideoSopError)) {
        modelLog("warn", "response_validation_failed", {
          jobId: input.jobId,
          phase: input.phase,
          attempt: attempt + 1,
          ...errorForLog(error),
        });
      }
      lastError = error;
    }
  }
  if (lastError instanceof VideoSopError) throw lastError;
  throw new VideoSopError(
    "INVALID_MODEL_JSON",
    `The ${input.phase} model returned invalid structured JSON after retrying.`,
    502,
  );
}

export async function analyzeVideoSopOperations(
  job: VideoSopJobRecord,
  signal: AbortSignal,
): Promise<VideoOperation[]> {
  const content = await Promise.all(
    job.videos.map(async (video) => {
      const data = await fs.readFile(
        videoSopVideoPath(job.tenantId, job.ownerId, job.id, video.screen),
      );
      return {
        type: "video_url",
        video_url: { url: `data:video/mp4;base64,${data.toString("base64")}` },
      };
    }),
  );
  const body: CompletionBody = {
    model: videoSopConfig.visionModel,
    messages: [
      {
        role: "user",
        content: [
          ...content,
          { type: "text", text: videoAnalysisPrompt(job.videoNames) },
        ],
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: "json_object" },
  };
  const boundedAnalysisSchema = videoAnalysisResponseSchema.refine((value) => {
    const operations = Array.isArray(value) ? value : value.operations;
    return operations.every((operation) => operation.screen < job.videoCount);
  }, "The model returned an invalid screen index.");
  const response = await validatedCompletion({
    body,
    timeoutMs: videoSopConfig.analysisTimeoutMs,
    signal,
    schema: boundedAnalysisSchema,
    phase: "video analysis",
    jobId: job.id,
    sourceVideoCount: job.videoCount,
    sourceBytes: job.totalBytes,
  });
  return normalizeVideoOperations(response, job.videoCount);
}

export async function generateVideoSopResult(
  job: VideoSopJobRecord,
  operations: VideoOperation[],
  signal: AbortSignal,
): Promise<SopResult> {
  if (
    job.ticketId &&
    !JSON.stringify(operations).toLocaleLowerCase().includes(job.ticketId.toLocaleLowerCase())
  ) {
    throw new VideoSopError(
      "TICKET_NOT_FOUND",
      `Ticket ${job.ticketId} was not found in the analyzed video operations.`,
      422,
    );
  }
  const body: CompletionBody = {
    model: videoSopConfig.sopModel,
    messages: [
      {
        role: "system",
        content: sopSystemPrompt({ language: job.language, ticketId: job.ticketId }),
      },
      {
        role: "user",
        content: sopUserPrompt(JSON.stringify(operations)),
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: "json_object" },
  };
  const result = await validatedCompletion({
    body,
    timeoutMs: videoSopConfig.sopTimeoutMs,
    signal,
    schema: sopResultSchema,
    phase: "SOP generation",
    jobId: job.id,
  });
  return normalizeSopResult({
    ...result,
    ticketId: job.ticketId ?? result.ticketId,
    ticketInference: job.ticketId ? "provided" : result.ticketInference,
  });
}
