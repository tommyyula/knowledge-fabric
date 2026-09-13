import fs from "node:fs/promises";
import type pg from "pg";
import { resolveWorkspaceFile } from "../ontologies/workspace";
import { operationWorkspacePaths } from "./model";

interface OperationDeletionBaseScope {
  tenantId: string;
  ownerId: string;
  knowledgeBaseId: string;
}

export type OperationDeletionScope =
  | OperationDeletionBaseScope & { target: "knowledgeBase" }
  | OperationDeletionBaseScope & { target: "conversation"; conversationId: string }
  | OperationDeletionBaseScope & { target: "operation"; operationId: string };

export async function deleteScopedOperationRows(
  client: pg.PoolClient,
  scope: OperationDeletionScope,
): Promise<string[]> {
  const params: unknown[] = [scope.tenantId, scope.ownerId, scope.knowledgeBaseId];
  const filters = ["tenant_id=$1", "owner_id=$2", "knowledge_base_id=$3"];
  if (scope.target === "conversation") {
    params.push(scope.conversationId);
    filters.push(`conversation_id=$${params.length}`);
  }
  if (scope.target === "operation") {
    params.push(scope.operationId);
    filters.push(`id=$${params.length}`);
  }
  const selected = await client.query<{ id: string }>(
    `select id from ontology_operation_runs where ${filters.join(" and ")}`,
    params,
  );
  const operationIds = selected.rows.map((row) => row.id);
  if (!operationIds.length) return [];
  const deleteParams = [scope.tenantId, scope.ownerId, scope.knowledgeBaseId, operationIds];
  await client.query(
    `delete from ontology_operation_logs
     where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3 and operation_id=any($4::text[])`,
    deleteParams,
  );
  await client.query(
    `delete from ontology_operation_artifacts
     where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3 and operation_id=any($4::text[])`,
    deleteParams,
  );
  await client.query(
    `delete from ontology_operation_runs
     where tenant_id=$1 and owner_id=$2 and knowledge_base_id=$3 and id=any($4::text[])`,
    deleteParams,
  );
  return operationIds;
}

export async function removeOperationRunFilesBestEffort(
  workspaceRoot: string,
  operationIds: readonly string[],
): Promise<void> {
  await Promise.all(operationIds.map(async (operationId) => {
    const publicDirectory = resolveWorkspaceFile(
      workspaceRoot,
      operationWorkspacePaths(operationId).publicDirectory,
    );
    await fs.rm(publicDirectory, { recursive: true, force: true }).catch((error) => {
      console.warn(`[operations] failed to remove Operation Run files for ${operationId}:`, error instanceof Error ? error.message : String(error));
    });
  }));
}
