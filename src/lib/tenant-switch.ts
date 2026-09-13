const tenantScopedStorageKeys = [
  "knowledge-fabric.active-chat-state.v1",
  "knowledge-fabric.sidebar-session-run-state.v1",
] as const;

/** Removes selections and polling metadata that are valid only for one tenant. */
export function clearTenantScopedClientState(): void {
  for (const key of tenantScopedStorageKeys) localStorage.removeItem(key);
}
