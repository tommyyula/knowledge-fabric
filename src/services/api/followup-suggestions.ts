import { apiJson } from "@/lib/api-client";
import type { FollowupSuggestion } from "@/lib/followup-suggestions-store";

interface ApiData<T> {
  data: T;
}

export async function suggestFollowups(input: {
  ontologyId: string;
  sessionId: string;
  clientMessages?: Array<{ role: "user" | "assistant"; content: string; createdAt?: string }>;
}): Promise<FollowupSuggestion[]> {
  const response = await apiJson<ApiData<{ suggestions: FollowupSuggestion[] }>>(
    `/api/v1/ontologies/${input.ontologyId}/sessions/${input.sessionId}/suggestions`,
    {
      method: "POST",
      body: JSON.stringify({ clientMessages: input.clientMessages }),
    },
  );
  return response.data.suggestions;
}
