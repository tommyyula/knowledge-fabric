import { publishConversationSnapshot } from "@/services/api/ontology";

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

export async function publishAndCopyConversationLink(ontologyId: string, sessionId: string): Promise<string> {
  const snapshot = await publishConversationSnapshot(ontologyId, sessionId);
  const link = snapshot.url ?? `${window.location.origin}/share/chat/${encodeURIComponent(snapshot.token)}`;
  await copyText(link);
  return link;
}
