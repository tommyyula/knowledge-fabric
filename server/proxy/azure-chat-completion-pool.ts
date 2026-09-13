import { randomUUID } from "node:crypto";

export const DEFAULT_AZURE_URL =
  "https://admin-mb0gbyil-eastus2.cognitiveservices.azure.com/openai/v1/chat/completions";

export class AzureChatCompletionPoolError extends Error {
  readonly status: number;
  readonly errorType: "api_error" | "rate_limit_error";
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    status = 502,
    errorType: "api_error" | "rate_limit_error" = "api_error",
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AzureChatCompletionPoolError";
    this.status = status;
    this.errorType = errorType;
    this.retryAfterMs = retryAfterMs;
  }
}

export class AzureChatCompletionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureChatCompletionConfigurationError";
  }
}

export interface AzureChatCompletionRequest {
  body: Record<string, unknown>;
  stream: boolean;
  signal?: AbortSignal;
}

export interface AzureChatCompletionResponse {
  upstreamId: string;
  response: Response;
}

export interface AzureChatCompletionPool {
  request(
    request: AzureChatCompletionRequest,
  ): Promise<AzureChatCompletionResponse>;
}

export interface AzureChatCompletionPoolOptions {
  environment?: NodeJS.ProcessEnv;
  fetchCompletion?: typeof fetch;
  logger?: {
    info(message: string, details: Record<string, unknown>): void;
    warn(message: string, details: Record<string, unknown>): void;
    error(message: string, details: Record<string, unknown>): void;
  };
  now?: () => number;
  random?: () => number;
}

export function hasAzureChatCompletionConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    environment.AZURE_OPENAI_API_KEY || environment.AZURE_OPENAI_UPSTREAMS,
  );
}

interface AzureUpstreamState {
  id: string;
  url: string;
  apiKey: string;
  weight: number;
  inflight: number;
  currentWeight: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  halfOpenInFlight: boolean;
}

type FailureKind = "rate-limit" | "configuration" | "transient";

interface AttemptFailure {
  status?: number;
  retryable: boolean;
  rateLimited: boolean;
  kind: FailureKind;
  retryAfterMs?: number;
}

function transientFailure(): AttemptFailure {
  return {
    retryable: true,
    rateLimited: false,
    kind: "transient",
  };
}

interface SseObservation {
  visible: boolean;
  embeddedError: boolean;
  terminalWithoutRetry: boolean;
  terminal: boolean;
}

function configurationError(message: string): never {
  throw new AzureChatCompletionConfigurationError(
    `Invalid AZURE_OPENAI_UPSTREAMS: ${message}`,
  );
}

function parseUpstreams(environment: NodeJS.ProcessEnv): AzureUpstreamState[] {
  const configuredPool = environment.AZURE_OPENAI_UPSTREAMS;
  if (configuredPool === undefined) {
    const apiKey = environment.AZURE_OPENAI_API_KEY;
    if (!apiKey) return [];
    return [
      {
        id: "legacy-azure",
        url: environment.AZURE_OPENAI_CHAT_COMPLETIONS_URL ?? DEFAULT_AZURE_URL,
        apiKey,
        weight: 1,
        inflight: 0,
        currentWeight: 0,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        halfOpenInFlight: false,
      },
    ];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configuredPool);
  } catch {
    return configurationError("must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    return configurationError("must be a non-empty array");

  const ids = new Set<string>();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return configurationError(`entry ${index + 1} must be an object`);
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
    const apiKey =
      typeof candidate.apiKey === "string" ? candidate.apiKey.trim() : "";
    const weight = candidate.weight;
    if (!id)
      return configurationError(`entry ${index + 1} requires a non-empty id`);
    if (ids.has(id)) return configurationError("ids must be unique");
    ids.add(id);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return configurationError(`entry ${index + 1} requires an HTTP(S) URL`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
      return configurationError(`entry ${index + 1} requires an HTTP(S) URL`);
    if (!apiKey)
      return configurationError(
        `entry ${index + 1} requires a non-empty apiKey`,
      );
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0)
      return configurationError(
        `entry ${index + 1} requires a positive weight`,
      );
    return {
      id,
      url,
      apiKey,
      weight,
      inflight: 0,
      currentWeight: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      halfOpenInFlight: false,
    };
  });
}

function responseFromReader(
  response: Response,
  initialText: string,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  release: () => void,
  onSuccess: () => void,
  onFailure: () => void,
  onCancel: () => void,
  idleTimeoutMs: number,
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let initial =
    initialText.length > 0 ? encoder.encode(initialText) : undefined;
  let terminal = observeSse(initialText).terminal;
  const lastInitialNewline = initialText.lastIndexOf("\n");
  let inspectionBuffer =
    lastInitialNewline >= 0
      ? initialText.slice(lastInitialNewline + 1)
      : initialText;
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (initial) {
        controller.enqueue(initial);
        initial = undefined;
        return;
      }
      try {
        const chunk = await readWithTimeout(
          reader,
          idleTimeoutMs,
          "Azure OpenAI stream became idle",
        );
        if (chunk.done) {
          inspectionBuffer += decoder.decode();
          const observation = observeSse(inspectionBuffer);
          terminal ||= observation.terminal;
          if (observation.embeddedError || !terminal) {
            throw new Error(
              "Azure OpenAI stream failed after response commitment",
            );
          }
          releaseOnce();
          onSuccess();
          controller.close();
        } else {
          inspectionBuffer += decoder.decode(chunk.value, { stream: true });
          const lastNewline = inspectionBuffer.lastIndexOf("\n");
          if (lastNewline >= 0) {
            const completeLines = inspectionBuffer.slice(0, lastNewline + 1);
            inspectionBuffer = inspectionBuffer.slice(lastNewline + 1);
            const observation = observeSse(completeLines);
            if (observation.embeddedError) {
              throw new Error(
                "Azure OpenAI stream failed after response commitment",
              );
            }
            terminal ||= observation.terminal;
          }
          controller.enqueue(chunk.value);
        }
      } catch {
        const safeError = new Error(
          "Azure OpenAI stream failed after response commitment",
        );
        try {
          await reader.cancel(safeError);
        } catch {
          /* the upstream stream has already failed */
        }
        releaseOnce();
        onFailure();
        controller.error(safeError);
      }
    },
    async cancel(reason) {
      releaseOnce();
      onCancel();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  message: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function observeSse(buffer: string): SseObservation {
  const observation: SseObservation = {
    visible: false,
    embeddedError: false,
    terminalWithoutRetry: false,
    terminal: false,
  };
  for (const line of buffer.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      observation.terminal = true;
      continue;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (chunk.error && typeof chunk.error === "object")
      observation.embeddedError = true;
    const choices = chunk.choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const choice = choices[0];
    if (!choice || typeof choice !== "object") continue;
    const delta = (choice as { delta?: unknown }).delta;
    if (delta && typeof delta === "object") {
      const content = (delta as { content?: unknown }).content;
      if (typeof content === "string" && content.length > 0)
        observation.visible = true;
      const toolCalls = (delta as { tool_calls?: unknown }).tool_calls;
      if (
        Array.isArray(toolCalls) &&
        toolCalls.some(
          (call) =>
            call &&
            typeof call === "object" &&
            Boolean((call as { id?: unknown }).id),
        )
      ) {
        observation.visible = true;
      }
    }
    const finishReason = (choice as { finish_reason?: unknown }).finish_reason;
    if (typeof finishReason === "string") observation.terminal = true;
    if (finishReason === "content_filter" || finishReason === "length")
      observation.terminalWithoutRetry = true;
  }
  return observation;
}

async function prepareStreamingResponse(
  response: Response,
  release: () => void,
  onSuccess: () => void,
  onCommittedFailure: () => void,
  onCancel: () => void,
  maxBufferBytes: number,
  firstContentTimeoutMs: number,
  idleTimeoutMs: number,
): Promise<Response | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    release();
    return null;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalWithoutRetry = false;
  const firstContentDeadline = Date.now() + firstContentTimeoutMs;
  try {
    while (true) {
      const remaining = Math.max(1, firstContentDeadline - Date.now());
      const chunk = await readWithTimeout(
        reader,
        remaining,
        "Azure OpenAI produced no content before the deadline",
      );
      if (chunk.done) {
        buffer += decoder.decode();
        release();
        if (terminalWithoutRetry) {
          onSuccess();
          return responseFromText(response, buffer);
        }
        return null;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > maxBufferBytes) {
        await reader.cancel("pre-commit SSE buffer limit exceeded");
        release();
        return null;
      }
      const observation = observeSse(buffer);
      if (observation.embeddedError) {
        await reader.cancel("embedded upstream error");
        release();
        return null;
      }
      terminalWithoutRetry ||= observation.terminalWithoutRetry;
      if (observation.visible || terminalWithoutRetry) {
        return responseFromReader(
          response,
          buffer,
          reader,
          release,
          onSuccess,
          onCommittedFailure,
          onCancel,
          idleTimeoutMs,
        );
      }
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      /* the upstream stream has already failed */
    }
    release();
    return null;
  }
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

function failureKindForStatus(status: number): FailureKind {
  if (status === 429) return "rate-limit";
  if (status === 401 || status === 403 || status === 404)
    return "configuration";
  return "transient";
}

function retryAfterFromHeaders(
  headers: Headers,
  now: number,
): number | undefined {
  const retryAfterMsHeader = headers.get("retry-after-ms");
  if (retryAfterMsHeader !== null) {
    const retryAfterMs = Number(retryAfterMsHeader);
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs;
  }
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function positiveNumber(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  if (environment[name] === undefined) return fallback;
  const value = Number(environment[name]);
  if (!Number.isFinite(value) || value <= 0)
    throw new AzureChatCompletionConfigurationError(
      `Invalid ${name}: must be a positive number`,
    );
  return value;
}

interface AttemptAbortScope {
  signal: AbortSignal;
  clearConnectionTimer(): void;
  dispose(): void;
}

function createAttemptAbortScope(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): AttemptAbortScope {
  const controller = new AbortController();
  const abortFromParent = () =>
    controller.abort(parent?.reason ?? new Error("request cancelled"));
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    controller.abort(new Error("Azure OpenAI connection timed out"));
  }, timeoutMs);
  const clearConnectionTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    signal: controller.signal,
    clearConnectionTimer,
    dispose() {
      clearConnectionTimer();
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function responseFromText(response: Response, text: string): Response {
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isValidNonStreamingCompletion(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const first = choices[0];
  return Boolean(
    first &&
    typeof first === "object" &&
    (first as { message?: unknown }).message &&
    typeof (first as { message?: unknown }).message === "object",
  );
}

export function createAzureChatCompletionPool(
  options: AzureChatCompletionPoolOptions = {},
): AzureChatCompletionPool {
  const environment = options.environment ?? process.env;
  const fetchCompletion = options.fetchCompletion ?? fetch;
  const logger = options.logger;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const upstreams = parseUpstreams(environment);
  const connectionTimeoutMs = positiveNumber(
    environment,
    "AZURE_OPENAI_CONNECT_TIMEOUT_MS",
    90_000,
  );
  const firstContentTimeoutMs = positiveNumber(
    environment,
    "AZURE_OPENAI_FIRST_CONTENT_TIMEOUT_MS",
    120_000,
  );
  const streamIdleTimeoutMs = positiveNumber(
    environment,
    "AZURE_OPENAI_STREAM_IDLE_TIMEOUT_MS",
    120_000,
  );
  const transientBaseCooldownMs = positiveNumber(
    environment,
    "AZURE_OPENAI_TRANSIENT_BASE_COOLDOWN_MS",
    5_000,
  );
  const transientMaxCooldownMs = positiveNumber(
    environment,
    "AZURE_OPENAI_TRANSIENT_MAX_COOLDOWN_MS",
    60_000,
  );
  const rateLimitBaseCooldownMs = positiveNumber(
    environment,
    "AZURE_OPENAI_RATE_LIMIT_BASE_COOLDOWN_MS",
    30_000,
  );
  const rateLimitMaxCooldownMs = positiveNumber(
    environment,
    "AZURE_OPENAI_RATE_LIMIT_MAX_COOLDOWN_MS",
    5 * 60_000,
  );
  const configurationBaseCooldownMs = positiveNumber(
    environment,
    "AZURE_OPENAI_CONFIGURATION_BASE_COOLDOWN_MS",
    5 * 60_000,
  );
  const configurationMaxCooldownMs = positiveNumber(
    environment,
    "AZURE_OPENAI_CONFIGURATION_MAX_COOLDOWN_MS",
    30 * 60_000,
  );
  const jitterRatio =
    environment.AZURE_OPENAI_COOLDOWN_JITTER_RATIO === undefined
      ? 0.2
      : Number(environment.AZURE_OPENAI_COOLDOWN_JITTER_RATIO);
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new AzureChatCompletionConfigurationError(
      "Invalid AZURE_OPENAI_COOLDOWN_JITTER_RATIO: must be between 0 and 1",
    );
  }
  const configuredMaxAttempts =
    environment.AZURE_OPENAI_MAX_ATTEMPTS === undefined
      ? 2
      : Number(environment.AZURE_OPENAI_MAX_ATTEMPTS);
  if (!Number.isInteger(configuredMaxAttempts) || configuredMaxAttempts <= 0) {
    throw new AzureChatCompletionConfigurationError(
      "Invalid AZURE_OPENAI_MAX_ATTEMPTS: must be a positive integer",
    );
  }
  const maxAttempts = Math.min(configuredMaxAttempts, upstreams.length);
  const maxPrecommitBufferBytes =
    environment.AZURE_OPENAI_PRECOMMIT_BUFFER_BYTES === undefined
      ? 256 * 1024
      : Number(environment.AZURE_OPENAI_PRECOMMIT_BUFFER_BYTES);
  if (
    !Number.isInteger(maxPrecommitBufferBytes) ||
    maxPrecommitBufferBytes <= 0
  ) {
    throw new AzureChatCompletionConfigurationError(
      "Invalid AZURE_OPENAI_PRECOMMIT_BUFFER_BYTES: must be a positive integer",
    );
  }

  const recordSuccess = (upstream: AzureUpstreamState): boolean => {
    const recovered = upstream.consecutiveFailures > 0;
    upstream.consecutiveFailures = 0;
    upstream.cooldownUntil = 0;
    upstream.halfOpenInFlight = false;
    return recovered;
  };

  const clearProbe = (upstream: AzureUpstreamState) => {
    upstream.halfOpenInFlight = false;
  };

  const recordFailure = (
    upstream: AzureUpstreamState,
    failure: AttemptFailure,
  ): number => {
    upstream.consecutiveFailures += 1;
    upstream.halfOpenInFlight = false;
    const [base, maximum] =
      failure.kind === "rate-limit"
        ? [rateLimitBaseCooldownMs, rateLimitMaxCooldownMs]
        : failure.kind === "configuration"
          ? [configurationBaseCooldownMs, configurationMaxCooldownMs]
          : [transientBaseCooldownMs, transientMaxCooldownMs];
    const exponential = Math.min(
      maximum,
      base * 2 ** Math.min(10, upstream.consecutiveFailures - 1),
    );
    const requested = failure.retryAfterMs ?? exponential;
    const duration = Math.max(
      1,
      Math.min(maximum, Math.ceil(requested * (1 + random() * jitterRatio))),
    );
    upstream.cooldownUntil = now() + duration;
    return duration;
  };

  const selectUpstream = (excluded: Set<string>): AzureUpstreamState => {
    if (upstreams.length === 0)
      throw new AzureChatCompletionPoolError(
        "Azure OpenAI is not configured",
        503,
      );
    const timestamp = now();
    const available = upstreams.filter(
      (upstream) => !excluded.has(upstream.id),
    );
    const recovery = available.filter(
      (upstream) =>
        upstream.consecutiveFailures > 0 &&
        upstream.cooldownUntil <= timestamp &&
        !upstream.halfOpenInFlight,
    );
    const healthy = available.filter(
      (upstream) => upstream.consecutiveFailures === 0,
    );
    const eligible = recovery.length > 0 ? recovery : healthy;
    if (eligible.length === 0) {
      const futureCooldowns = upstreams
        .filter((upstream) => upstream.cooldownUntil > timestamp)
        .map((upstream) => upstream.cooldownUntil - timestamp);
      const retryAfterMs =
        futureCooldowns.length > 0 ? Math.min(...futureCooldowns) : 1_000;
      throw new AzureChatCompletionPoolError(
        "Azure OpenAI upstreams are cooling down",
        429,
        "rate_limit_error",
        retryAfterMs,
      );
    }
    const minimumLoad = Math.min(
      ...eligible.map((upstream) => upstream.inflight / upstream.weight),
    );
    const candidates = eligible.filter(
      (upstream) => upstream.inflight / upstream.weight === minimumLoad,
    );
    const totalWeight = candidates.reduce(
      (sum, upstream) => sum + upstream.weight,
      0,
    );
    for (const candidate of candidates)
      candidate.currentWeight += candidate.weight;
    const selected = candidates.reduce((best, candidate) =>
      candidate.currentWeight > best.currentWeight ? candidate : best,
    );
    selected.currentWeight -= totalWeight;
    if (selected.consecutiveFailures > 0) selected.halfOpenInFlight = true;
    return selected;
  };

  return {
    async request(request) {
      if (upstreams.length === 0)
        throw new AzureChatCompletionPoolError(
          "Azure OpenAI is not configured",
          503,
        );
      const requestId = randomUUID();
      const model =
        typeof request.body.model === "string" ? request.body.model : "unknown";
      const attempted = new Set<string>();
      const failures: AttemptFailure[] = [];
      const throwIfCancelled = (upstream: AzureUpstreamState) => {
        if (!request.signal?.aborted) return;
        clearProbe(upstream);
        throw new AzureChatCompletionPoolError(
          "Azure OpenAI request was cancelled",
          499,
        );
      };
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        let upstream: AzureUpstreamState;
        try {
          upstream = selectUpstream(attempted);
        } catch (error) {
          if (error instanceof AzureChatCompletionPoolError) {
            logger?.error("[azure-pool] no upstream available", {
              requestId,
              model,
              status: error.status,
              retryAfterMs: error.retryAfterMs,
            });
          }
          throw error;
        }
        attempted.add(upstream.id);
        upstream.inflight += 1;
        const attemptStartedAt = now();
        if (upstream.consecutiveFailures > 0 && upstream.halfOpenInFlight) {
          logger?.info("[azure-pool] probing upstream", {
            requestId,
            upstreamId: upstream.id,
            attempt: attempt + 1,
            model,
            circuitState: "half-open",
          });
        }
        const failAttempt = (
          failure: AttemptFailure,
          failoverReason: string,
        ) => {
          failures.push(failure);
          const cooldownMs = recordFailure(upstream, failure);
          logger?.warn("[azure-pool] attempt failed", {
            requestId,
            upstreamId: upstream.id,
            attempt: attempt + 1,
            model,
            status: failure.status,
            latencyMs: Math.max(0, now() - attemptStartedAt),
            failoverReason,
            circuitState: "cooling",
            cooldownMs,
          });
        };
        const succeedAttempt = () => {
          if (!recordSuccess(upstream)) return;
          logger?.info("[azure-pool] upstream recovered", {
            requestId,
            upstreamId: upstream.id,
            attempt: attempt + 1,
            model,
            latencyMs: Math.max(0, now() - attemptStartedAt),
            circuitState: "healthy",
          });
        };
        const abortScope = createAttemptAbortScope(
          request.signal,
          connectionTimeoutMs,
        );
        const releaseAttempt = () => {
          upstream.inflight -= 1;
          abortScope.dispose();
        };
        let response: Response;
        try {
          response = await fetchCompletion(upstream.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${upstream.apiKey}`,
            },
            body: JSON.stringify(request.body),
            signal: abortScope.signal,
          });
        } catch {
          releaseAttempt();
          throwIfCancelled(upstream);
          failAttempt(transientFailure(), "network_or_connection_timeout");
          continue;
        }
        abortScope.clearConnectionTimer();

        if (!response.ok) {
          const retryAfterMs =
            response.status === 429
              ? retryAfterFromHeaders(response.headers, now())
              : undefined;
          let upstreamBody = "";
          try {
            upstreamBody = await response.text();
          } catch {
            /* ignore read errors */
          }
          logger?.error("[azure-pool] upstream error response", {
            requestId,
            upstreamId: upstream.id,
            attempt: attempt + 1,
            model,
            status: response.status,
            statusText: response.statusText,
            body: upstreamBody.slice(0, 1000),
          });
          releaseAttempt();
          const failure: AttemptFailure = {
            status: response.status,
            retryable: isRetryableStatus(response.status),
            rateLimited: response.status === 429,
            kind: failureKindForStatus(response.status),
            retryAfterMs,
          };
          if (!failure.retryable) {
            clearProbe(upstream);
            throw new AzureChatCompletionPoolError(
              `Azure OpenAI rejected the request (status=${response.status}): ${upstreamBody.slice(0, 500)}`,
              response.status,
            );
          }
          failAttempt(failure, `http_${response.status}`);
          continue;
        }

        if (request.stream) {
          const prepared = await prepareStreamingResponse(
            response,
            releaseAttempt,
            succeedAttempt,
            () => {
              if (request.signal?.aborted) clearProbe(upstream);
              else failAttempt(transientFailure(), "stream_after_commit");
            },
            () => clearProbe(upstream),
            maxPrecommitBufferBytes,
            firstContentTimeoutMs,
            streamIdleTimeoutMs,
          );
          if (prepared) return { upstreamId: upstream.id, response: prepared };
          throwIfCancelled(upstream);
          failAttempt(transientFailure(), "stream_before_commit");
          continue;
        }

        let text: string;
        try {
          text = await response.text();
        } catch {
          releaseAttempt();
          throwIfCancelled(upstream);
          failAttempt(transientFailure(), "response_read_failed");
          continue;
        }
        releaseAttempt();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          failAttempt(transientFailure(), "malformed_json");
          continue;
        }
        if (!isValidNonStreamingCompletion(json)) {
          failAttempt(transientFailure(), "invalid_completion");
          continue;
        }
        succeedAttempt();
        return {
          upstreamId: upstream.id,
          response: responseFromText(response, text),
        };
      }

      if (
        failures.length > 0 &&
        failures.every((failure) => failure.rateLimited)
      ) {
        const retryAfterMs = Math.max(
          1,
          Math.min(
            ...upstreams.map((upstream) =>
              Math.max(0, upstream.cooldownUntil - now()),
            ),
          ),
        );
        logger?.error("[azure-pool] all attempts exhausted", {
          requestId,
          model,
          status: 429,
          retryAfterMs,
        });
        throw new AzureChatCompletionPoolError(
          "Azure OpenAI upstreams are rate limited",
          429,
          "rate_limit_error",
          retryAfterMs,
        );
      }
      const failureSummary = failures.map((f) => `status=${f.status ?? "network"}`).join(", ");
      logger?.error("[azure-pool] all attempts exhausted", {
        requestId,
        model,
        status: 502,
        attempts: failures.length,
        failures: failures.map((f) => ({ status: f.status, kind: f.kind })),
      });
      throw new AzureChatCompletionPoolError(`Azure OpenAI request failed after ${failures.length} attempt(s): ${failureSummary}`);
    },
  };
}

let defaultPool: AzureChatCompletionPool | undefined;

export function initializeAzureChatCompletionPool(
  options: AzureChatCompletionPoolOptions = {},
): AzureChatCompletionPool {
  defaultPool = createAzureChatCompletionPool({
    ...options,
    logger: options.logger ?? console,
  });
  return defaultPool;
}

export function getAzureChatCompletionPool(): AzureChatCompletionPool {
  return defaultPool ?? initializeAzureChatCompletionPool();
}
