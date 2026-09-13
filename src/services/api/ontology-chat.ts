import type { JourneyState, OntologyMessage, OntologySession, OntologyStreamEvent } from "@/contracts/ontology";
import { apiJson, apiUrl, authHeaders, ensureFreshAccessToken } from "@/lib/api-client";
import type { Locale } from "@/i18n";

interface ApiData<T> { data: T }

export interface OntologyChatStatus {
  runId: string | null;
  active: boolean;
  completed: boolean;
  eventCount: number;
  lastSequence: number | null;
  updatedAt: string | null;
  local?: boolean;
}

export async function listOntologySessions(ontologyId: string): Promise<OntologySession[]> {
  return (await apiJson<ApiData<OntologySession[]>>(`/api/v1/ontologies/${ontologyId}/sessions`)).data;
}

export async function createOntologySession(ontologyId: string): Promise<OntologySession> {
  return (await apiJson<ApiData<OntologySession>>(`/api/v1/ontologies/${ontologyId}/sessions`, { method: "POST" })).data;
}

export async function updateOntologySession(ontologyId: string, sessionId: string, updates: Partial<Pick<OntologySession, "preview">>): Promise<OntologySession> {
  return (await apiJson<ApiData<OntologySession>>(`/api/v1/ontologies/${ontologyId}/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify(updates) })).data;
}

export async function deleteOntologySession(ontologyId: string, sessionId: string): Promise<void> {
  await apiJson<void>(`/api/v1/ontologies/${ontologyId}/sessions/${sessionId}`, { method: "DELETE" });
}

export async function listOntologyMessages(ontologyId: string, sessionId: string): Promise<OntologyMessage[]> {
  return (await apiJson<ApiData<OntologyMessage[]>>(`/api/v1/ontologies/${ontologyId}/sessions/${sessionId}/messages`)).data;
}

export async function getOntologyChatStatus(ontologyId: string, sessionId: string): Promise<OntologyChatStatus> {
  return (await apiJson<ApiData<OntologyChatStatus>>(`/api/v1/ontologies/${ontologyId}/sessions/${sessionId}/chat/status`)).data;
}

export async function sendOntologyChat(ontologyId: string, sessionId: string, message: string, locale?: Locale): Promise<{ message: OntologyMessage; events: OntologyStreamEvent[]; journeyState: JourneyState; claudeSessionId: string }> {
  return (await apiJson<ApiData<{ message: OntologyMessage; events: OntologyStreamEvent[]; journeyState: JourneyState; claudeSessionId: string }>>(`/api/v1/ontologies/${ontologyId}/sessions/${sessionId}/chat`, { method: "POST", body: JSON.stringify({ message, locale }) })).data;
}

export async function cancelOntologyChat(ontologyId: string, sessionId: string): Promise<{ cancelled: boolean }> {
  return (await apiJson<ApiData<{ cancelled: boolean }>>(`/api/v1/ontologies/${ontologyId}/sessions/${sessionId}/cancel`, { method: "POST" })).data;
}

function parseSseBlock(block: string): OntologyStreamEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  return JSON.parse(data) as OntologyStreamEvent;
}

export async function sendOntologyChatStream(
  ontologyId: string,
  sessionId: string,
  message: string,
  onEvent: (event: OntologyStreamEvent) => void,
  signal?: AbortSignal,
  locale?: Locale,
): Promise<void> {
  await ensureFreshAccessToken();
  const res = await fetch(apiUrl(`/api/v1/ontologies/${ontologyId}/sessions/${sessionId}/chat`), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ message, stream: true, locale }),
    signal,
  });

  if (res.status === 401) window.dispatchEvent(new Event("auth:logout"));
  if (!res.ok) throw new Error((await res.text()) || `Request failed: ${res.status}`);
  if (!res.body) throw new Error("Streaming response body is unavailable");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = parseSseBlock(block.trim());
      if (event) onEvent(event);
    }
    if (done) break;
  }

  const trailing = parseSseBlock(buffer.trim());
  if (trailing) onEvent(trailing);
}
