export interface FollowupSuggestion {
  prompt: string;
}

export interface FollowupSuggestionsStore {
  readonly scope: string;
  get(): readonly FollowupSuggestion[];
  set(next: readonly FollowupSuggestion[]): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
}

export function createFollowupSuggestionsStore(scope: string): FollowupSuggestionsStore {
  let suggestions: readonly FollowupSuggestion[] = [];
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    scope,
    get() {
      return suggestions;
    },
    set(next) {
      suggestions = next;
      emit();
    },
    clear() {
      suggestions = [];
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
