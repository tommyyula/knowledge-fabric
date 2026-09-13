let disabledConnectors = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export const connectorStore = {
  getDisabled(): ReadonlySet<string> {
    return disabledConnectors;
  },
  toggle(app: string): boolean {
    const normalized = app.toLowerCase();
    const next = new Set(disabledConnectors);
    if (next.has(normalized)) next.delete(normalized);
    else next.add(normalized);
    disabledConnectors = next;
    emit();
    return next.has(normalized);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
