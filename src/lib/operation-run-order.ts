import type { OperationRun } from "@/contracts/ontology";

export function compareOperationRunsNewestFirst(left: OperationRun, right: OperationRun): number {
  const startedAtOrder = right.startedAt.localeCompare(left.startedAt);
  return startedAtOrder || right.id.localeCompare(left.id);
}
