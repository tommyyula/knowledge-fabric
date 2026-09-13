import type { SlashCommandId } from "@/contracts/slash-commands";

type Listener = () => void;

interface ComposerPromptModeState {
  commandId: SlashCommandId | null;
  query: boolean;
  operation: boolean;
}

function stateFor(commandId: SlashCommandId | null): ComposerPromptModeState {
  return {
    commandId,
    query: commandId === "query",
    operation: commandId === "operate",
  };
}

let state: ComposerPromptModeState = stateFor(null);
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

export const composerPromptModeStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get(): ComposerPromptModeState {
    return state;
  },
  enableSlashCommand(commandId: SlashCommandId): void {
    if (state.commandId === commandId) return;
    state = stateFor(commandId);
    emit();
  },
  disableSlashCommand(): void {
    if (!state.commandId) return;
    state = stateFor(null);
    emit();
  },
  enableQuery(): void {
    this.enableSlashCommand("query");
  },
  disableQuery(): void {
    if (state.commandId !== "query") return;
    this.disableSlashCommand();
  },
  enableOperation(): void {
    this.enableSlashCommand("operate");
  },
  disableOperation(): void {
    if (state.commandId !== "operate") return;
    this.disableSlashCommand();
  },
  clear(): void {
    if (!state.commandId) return;
    state = stateFor(null);
    emit();
  },
};
