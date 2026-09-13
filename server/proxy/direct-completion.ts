import { DEFAULT_OPENAI_URL } from "./anthropic-openai-proxy";
import {
  getAzureChatCompletionPool,
  hasAzureChatCompletionConfiguration,
} from "./azure-chat-completion-pool";

export function resolveAgentProxyModel(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return environment.ONTOLOGY_PROXY_MODEL
    ?? environment.STEWARD_PROXY_MODEL
    ?? (hasAzureChatCompletionConfiguration(environment) ? "gpt-5.4" : undefined);
}

export async function directChatCompletion(prompt: string, options?: { maxTokens?: number; timeoutMs?: number }): Promise<string | null> {
  const model = resolveAgentProxyModel();
  if (!model) return null;

  const provider = process.env.ONTOLOGY_PROXY_PROVIDER ?? process.env.STEWARD_PROXY_PROVIDER ?? "azure";
  if (provider !== "azure" && provider !== "openai") return null;

  try {
    const body = {
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      max_completion_tokens: options?.maxTokens ?? 1024,
    };
    const signal = AbortSignal.timeout(options?.timeoutMs ?? 15000);
    let response: Response;
    if (provider === "azure") {
      response = (await getAzureChatCompletionPool().request({ body, stream: false, signal })).response;
    } else {
      const authSecret = process.env.OPENAI_API_KEY;
      if (!authSecret) return null;
      response = await fetch(process.env.OPENAI_CHAT_COMPLETIONS_URL ?? DEFAULT_OPENAI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authSecret}` },
        body: JSON.stringify(body),
        signal,
      });
    }

    if (!response.ok) {
      console.warn(`[direct-completion] ${provider} request failed with status ${response.status}`);
      return null;
    }

    const json = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = json.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : null;
  } catch (err) {
    console.warn("[direct-completion] request failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
