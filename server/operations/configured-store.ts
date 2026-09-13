import { pool } from "../db/client";
import { createOperationRunStore } from "./store";
import type { OperationRunStoreContext } from "./store";

export function createConfiguredOperationRunStore(context: OperationRunStoreContext) {
  return createOperationRunStore(context, pool);
}
