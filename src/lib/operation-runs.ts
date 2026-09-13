import type { OperationRun } from "@/contracts/ontology";

export function operationRunTitle(run: OperationRun): string {
  const title = run.title?.trim();
  if (title) return title;
  return run.userRequest.replace(/^\s*operate\s*:\s*/i, "").trim() || run.id;
}

export function operationRunStatusKey(run: OperationRun): string {
  if (run.errorCode === "operation_finish_missing") return "operations.status.incomplete";
  if (run.errorCode === "agent_run_failed") return "operations.status.agentFailed";
  return `operations.status.${run.status}`;
}
