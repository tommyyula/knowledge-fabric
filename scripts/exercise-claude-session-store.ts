import { createPostgresClaudeSessionStore } from "../server/chat/claude-session-store";

const [tenantId, ontologyId, appSessionId] = process.argv.slice(2);
if (!tenantId || !ontologyId || !appSessionId) {
  throw new Error("Usage: tsx scripts/exercise-claude-session-store.ts <tenantId> <ontologyId> <appSessionId>");
}

const store = createPostgresClaudeSessionStore({ tenantId, ontologyId, appSessionId });
const projectKey = `${tenantId}:${ontologyId}:${appSessionId}`;
const key = { projectKey, sessionId: "sdk-smoke-session", subpath: undefined };
const subkey = { projectKey, sessionId: "sdk-smoke-session", subpath: "summary" };

await store.append(key, [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hello from postgres smoke" }] } } as never]);
await store.append(key, [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello from store" }] } } as never]);
await store.append(subkey, [{ type: "summary", summary: "smoke subkey" } as never]);

const loaded = await store.load(key);
const sessions = await store.listSessions(projectKey);
const subkeys = await store.listSubkeys({ projectKey, sessionId: "sdk-smoke-session" });

if (!loaded || loaded.length < 2) throw new Error(`Expected at least 2 loaded entries, got ${loaded?.length ?? 0}`);
if (!sessions.some((session) => session.sessionId === "sdk-smoke-session")) throw new Error("Session store listSessions missed sdk-smoke-session");
if (!subkeys.includes("summary")) throw new Error("Session store listSubkeys missed summary");

await store.delete(key);
const afterDelete = await store.load(key);
if (afterDelete && afterDelete.length > 0) throw new Error("Session store delete did not remove entries");

console.log("claude session store postgres exercise ok");
