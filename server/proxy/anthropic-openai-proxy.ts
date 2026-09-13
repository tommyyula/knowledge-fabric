import { randomUUID } from "node:crypto";
import { Router } from "express";
import { env } from "../env";
import {
  AzureChatCompletionPoolError,
  getAzureChatCompletionPool,
} from "./azure-chat-completion-pool";

export const DEFAULT_OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export const anthropicOpenAiProxyRouter = Router();

function parseProxyKey(apiKey: string): { ok: true; provider: "azure" | "openai"; model: string } | { ok: false; error: string } {
  if (!apiKey.startsWith("proxy:")) return { ok: false, error: "Proxy API key must use proxy:<token>:<provider>:<model>" };
  const parts = apiKey.slice(6).split(":");

  if (parts[0] === env.proxyToken) {
    const maybeProvider = parts[1];
    if (maybeProvider !== "azure" && maybeProvider !== "openai") return { ok: false, error: "Proxy provider must be azure or openai" };
    const model = parts.slice(2).join(":") || "gpt-5.4";
    return { ok: true, provider: maybeProvider, model };
  }

  if (env.allowUnauthenticatedProxy) {
    const maybeProvider = parts[0];
    if (maybeProvider === "azure" || maybeProvider === "openai") return { ok: true, provider: maybeProvider, model: parts.slice(1).join(":") || "gpt-5.4" };
  }

  return { ok: false, error: "Invalid ontology proxy token" };
}

function transformRequest(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];

  if (body.system) {
    let systemText = "";
    if (typeof body.system === "string") systemText = body.system;
    else if (Array.isArray(body.system)) {
      systemText = (body.system as Array<{ type?: string; text?: string }>)
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text)
        .join("\n\n");
    }
    if (systemText) messages.push({ role: "system", content: systemText });
  }

  for (const msg of (body.messages as Array<Record<string, unknown>>) ?? []) {
    const role = msg.role as string;
    if (role === "user") {
      if (typeof msg.content === "string") messages.push({ role: "user", content: msg.content });
      else if (Array.isArray(msg.content)) {
        const parts = msg.content as Array<Record<string, unknown>>;
        for (const part of parts) {
          if (part.type !== "tool_result") continue;
          const output = typeof part.content === "string"
            ? part.content
            : Array.isArray(part.content)
              ? (part.content as Array<{ type?: string; text?: string }>).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n")
              : JSON.stringify(part.content ?? "");
          messages.push({ role: "tool", tool_call_id: part.tool_use_id, content: output || "(empty)" });
        }
        const textParts = parts.filter((part) => part.type === "text" && part.text);
        if (textParts.length) messages.push({ role: "user", content: textParts.map((part) => part.text).join("\n") });
      }
    } else if (role === "assistant") {
      if (typeof msg.content === "string") messages.push({ role: "assistant", content: msg.content });
      else if (Array.isArray(msg.content)) {
        const parts = msg.content as Array<Record<string, unknown>>;
        const textParts = parts.filter((part) => part.type === "text" && part.text);
        const toolUses = parts.filter((part) => part.type === "tool_use");
        const assistantMsg: Record<string, unknown> = { role: "assistant", content: textParts.map((part) => part.text).join("\n") || null };
        if (toolUses.length) {
          assistantMsg.tool_calls = toolUses.map((tool) => ({
            id: tool.id,
            type: "function",
            function: { name: tool.name, arguments: typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input ?? {}) },
          }));
        }
        messages.push(assistantMsg);
      }
    }
  }

  const tools = ((body.tools as Array<Record<string, unknown>>) ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.input_schema ?? { type: "object", properties: {}, required: [] },
    },
  }));

  const result: Record<string, unknown> = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools.length) result.tools = tools;
  if (body.max_tokens) result.max_completion_tokens = body.max_tokens;
  return result;
}

function encodeAnthropicEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function pipeOpenAiAsAnthropic(fetchResponse: Response, provider: string, model: string, write: (chunk: string) => void): Promise<void> {
  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  let hasStarted = false;
  let textBlockIndex = -1;
  let contentIndex = 0;
  const toolCallBlocks = new Map<number, { anthropicIndex: number }>();
  let buffer = "";
  let isClosed = false;
  let finalInputTokens = 0;
  let finalOutputTokens = 0;
  let emittedContent = false;
  let finishReason: string | null = null;
  let upstreamError: Record<string, unknown> | null = null;

  const emit = (event: string, data: unknown) => { if (!isClosed) write(encodeAnthropicEvent(event, data)); };
  const ensureStarted = () => {
    if (hasStarted) return;
    hasStarted = true;
    emit("message_start", {
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
  };
  const closeTextBlock = () => {
    if (textBlockIndex >= 0) {
      emit("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
      textBlockIndex = -1;
    }
  };
  const describeUpstreamError = (error: Record<string, unknown> | null): string | null => {
    if (!error) return null;
    const details = [
      typeof error.message === "string" ? error.message : null,
      typeof error.code === "string" ? `code=${error.code}` : null,
      typeof error.type === "string" ? `type=${error.type}` : null,
    ].filter((detail): detail is string => detail !== null);
    return details.join(", ") || "upstream error";
  };

  const processChunk = (chunk: Record<string, unknown>) => {
    // Capture usage from any chunk that has it (Azure sends it in the final choices:[] chunk)
    const chunkUsage = chunk.usage as Record<string, number | null> | undefined;
    if (chunkUsage && chunkUsage.prompt_tokens != null) {
      finalInputTokens = (chunkUsage.prompt_tokens as number) ?? finalInputTokens;
      finalOutputTokens = (chunkUsage.completion_tokens as number) ?? finalOutputTokens;
    }

    if (chunk.error && typeof chunk.error === "object") upstreamError = chunk.error as Record<string, unknown>;

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    // The usage-only chunk arrives AFTER the finish_reason chunk (choices is empty).
    // We've already emitted message_delta/message_stop at that point, so just capture usage above and return.
    if (!choices?.length) return;
    const choice = choices[0];
    const delta = choice.delta as Record<string, unknown> | undefined;
    const chunkFinishReason = choice.finish_reason as string | null | undefined;
    if (!delta && !chunkFinishReason) return;
    ensureStarted();

    if (typeof delta?.content === "string" && delta.content.length > 0) {
      if (textBlockIndex < 0) {
        textBlockIndex = contentIndex++;
        emit("content_block_start", { type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } });
      }
      emittedContent = true;
      emit("content_block_delta", { type: "content_block_delta", index: textBlockIndex, delta: { type: "text_delta", text: delta.content } });
    }

    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
        const oaiIndex = Number(tc.index ?? 0);
        const fn = tc.function as Record<string, unknown> | undefined;
        if (tc.id) {
          emittedContent = true;
          closeTextBlock();
          const anthropicIndex = contentIndex++;
          toolCallBlocks.set(oaiIndex, { anthropicIndex });
          emit("content_block_start", { type: "content_block_start", index: anthropicIndex, content_block: { type: "tool_use", id: tc.id, name: fn?.name ?? "", input: {} } });
        }
        if (typeof fn?.arguments === "string" && fn.arguments.length > 0) {
          const block = toolCallBlocks.get(oaiIndex);
          if (block) emit("content_block_delta", { type: "content_block_delta", index: block.anthropicIndex, delta: { type: "input_json_delta", partial_json: fn.arguments } });
        }
      }
    }

    if (chunkFinishReason) {
      finishReason = chunkFinishReason;
      closeTextBlock();
      for (const [, block] of toolCallBlocks) emit("content_block_stop", { type: "content_block_stop", index: block.anthropicIndex });
      toolCallBlocks.clear();
      // Don't emit message_delta yet — defer until we've seen the usage chunk or stream ends
      deferredFinishReason = chunkFinishReason;
    }
  };

  let deferredFinishReason: string | null = null;

  const flushFinish = () => {
    if (!deferredFinishReason || isClosed) return;
    ensureStarted();
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: deferredFinishReason === "tool_calls" ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { input_tokens: finalInputTokens, output_tokens: finalOutputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    emit("message_stop", { type: "message_stop" });
    isClosed = true;
  };

  const reader = fetchResponse.body?.getReader();
  if (!reader) throw new Error("Upstream response body is empty");
  const decoder = new TextDecoder();
  let streamFailed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { processChunk(JSON.parse(data) as Record<string, unknown>); } catch { /* ignore malformed upstream SSE chunks */ }
      }
    }

    const trailing = buffer.trim();
    if (trailing.startsWith("data:")) {
      const data = trailing.slice(5).trim();
      if (data && data !== "[DONE]") {
        try { processChunk(JSON.parse(data) as Record<string, unknown>); } catch { /* ignore malformed upstream SSE chunks */ }
      }
    }
  } catch (error) {
    streamFailed = true;
    throw error;
  } finally {
    if (!streamFailed) {
      if (emittedContent) {
        if (finishReason === "content_filter" || finishReason === "length") {
          console.warn("[proxy] degraded completion", { provider, model, finish_reason: finishReason, input_tokens: finalInputTokens, output_tokens: finalOutputTokens });
        }
        // Flush deferred finish (with usage from the trailing chunk if available)
        flushFinish();
        if (!isClosed) {
          ensureStarted();
          closeTextBlock();
          emit("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: finalInputTokens, output_tokens: finalOutputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
          emit("message_stop", { type: "message_stop" });
        }
      } else {
        const reason = describeUpstreamError(upstreamError)
          ?? `no content returned (finish_reason=${finishReason ?? "unknown"})`;
        console.error("[proxy] empty completion", {
          provider,
          model,
          finish_reason: finishReason,
          input_tokens: finalInputTokens,
          output_tokens: finalOutputTokens,
          upstream_error: upstreamError,
        });
        const message = `Upstream ${provider}/${model} returned no content — ${reason}. Likely an Azure content filter or the reasoning model exhausting max_completion_tokens (prompt=${finalInputTokens}, completion=${finalOutputTokens} tokens).`;
        emit("error", { type: "error", error: { type: "api_error", message } });
        isClosed = true;
      }
    }
  }
}

anthropicOpenAiProxyRouter.post("/v1/messages", async (req, res) => {
  const apiKey = String(req.header("x-api-key") ?? req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const parsedKey = parseProxyKey(apiKey);
  if (!parsedKey.ok) {
    res.status(401).json({ type: "error", error: { type: "authentication_error", message: parsedKey.error } });
    return;
  }
  const { provider, model } = parsedKey;
  const requestBody = transformRequest(req.body as Record<string, unknown>, model);
  const upstreamAbort = new AbortController();
  const abortUpstream = () => {
    if (!res.writableEnded) upstreamAbort.abort(new Error("proxy client disconnected"));
  };
  const cleanupAbortListeners = () => {
    req.removeListener("aborted", abortUpstream);
    res.removeListener("close", abortUpstream);
  };
  req.once("aborted", abortUpstream);
  res.once("close", abortUpstream);
  res.once("finish", cleanupAbortListeners);

  let fetchResponse: Response;
  try {
    if (provider === "azure") {
      const result = await getAzureChatCompletionPool().request({ body: requestBody, stream: true, signal: upstreamAbort.signal });
      fetchResponse = result.response;
    } else {
      const authSecret = process.env.OPENAI_API_KEY;
      if (!authSecret) {
        res.status(500).json({ type: "error", error: { type: "api_error", message: "OPENAI_API_KEY not configured" } });
        return;
      }
      fetchResponse = await fetch(process.env.OPENAI_CHAT_COMPLETIONS_URL ?? DEFAULT_OPENAI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authSecret}` },
        body: JSON.stringify(requestBody),
        signal: upstreamAbort.signal,
      });
    }
  } catch (err) {
    if (err instanceof AzureChatCompletionPoolError) {
      if (err.retryAfterMs !== undefined) res.setHeader("Retry-After", String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
      res.status(err.status).json({ type: "error", error: { type: err.errorType, message: err.message } });
      return;
    }
    res.status(502).json({ type: "error", error: { type: "api_error", message: `[${provider}] fetch failed: ${err instanceof Error ? err.message : String(err)}` } });
    return;
  }

  if (!fetchResponse.ok) {
    const errText = await fetchResponse.text();
    console.error("[proxy] upstream non-ok", { provider, model, status: fetchResponse.status, body: errText.slice(0, 500) });
    res.status(fetchResponse.status).json({ type: "error", error: { type: "api_error", message: `[${provider}] error ${fetchResponse.status}: ${errText.slice(0, 500)}` } });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  try {
    await pipeOpenAiAsAnthropic(fetchResponse, provider, model, (chunk) => res.write(chunk));
  } catch (err) {
    const message = provider === "azure"
      ? "Azure OpenAI stream failed after response commitment"
      : err instanceof Error ? err.message : String(err);
    console.error("[proxy] stream translation failed", { provider, model, error: message });
    res.write(encodeAnthropicEvent("error", { type: "error", error: { type: "api_error", message } }));
  } finally {
    res.end();
  }
});
