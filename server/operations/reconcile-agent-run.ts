import type { OperationRunStore, StoredOperationRun } from "./store";

export interface ChatRunCompletionResult {
  cancelled?: boolean;
  error?: string;
}

const OPERATION_OUTCOME_BY_AGENT_OUTCOME = {
  cancelled: {
    status: "cancelled",
    error: "The Agent Run was cancelled before the Operation completed.",
    errorCode: "agent_run_cancelled",
  },
  failed: {
    status: "failed",
    error: "The Agent Run failed before the Operation completed.",
    errorCode: "agent_run_failed",
  },
  completed: {
    status: "failed",
    error: "The Agent Run completed without calling operation_finish.",
    errorCode: "operation_finish_missing",
  },
} as const;

export interface ReconcileOperationRunAfterChatCompletionInput {
  store: OperationRunStore;
  conversationId: string;
  agentRunId: string;
  result: ChatRunCompletionResult;
}

export async function reconcileOperationRunAfterChatCompletion(
  input: ReconcileOperationRunAfterChatCompletionInput,
): Promise<StoredOperationRun | null> {
  const outcomeType = input.result.cancelled ? "cancelled" : input.result.error ? "failed" : "completed";
  const outcome = OPERATION_OUTCOME_BY_AGENT_OUTCOME[outcomeType];
  return input.store.finishFromAgentRun({
    conversationId: input.conversationId,
    agentRunId: input.agentRunId,
    status: outcome.status,
    resultSummary: outcome.error,
    error: outcome.error,
    errorCode: outcome.errorCode,
  });
}
