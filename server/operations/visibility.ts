import type { OperationRun } from "../../src/contracts/ontology";
import type { StoredOperationRun } from "./store";

export function toPublicOperationRun(run: StoredOperationRun): OperationRun {
  const { tenantId, ownerId, agentRunId, ...publicRun } = run;
  void tenantId;
  void ownerId;
  void agentRunId;
  return publicRun;
}
