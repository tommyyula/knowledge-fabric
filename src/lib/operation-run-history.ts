import type { OperationRun } from "@/contracts/ontology";
import { compareOperationRunsNewestFirst } from "@/lib/operation-run-order";
import type { OperationRunPage } from "@/services/api/operations";

export function mergeOperationRunPages(pages: readonly OperationRunPage[]): OperationRun[] {
  const byId = new Map<string, OperationRun>();
  for (const page of pages) {
    for (const run of page.items) {
      if (!byId.has(run.id)) byId.set(run.id, run);
    }
  }
  return [...byId.values()].sort(compareOperationRunsNewestFirst);
}
