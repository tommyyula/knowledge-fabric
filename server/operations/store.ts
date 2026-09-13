import type { OperationErrorCode, OperationRun, OperationStatus } from "../../src/contracts/ontology";
import type pg from "pg";
import { PostgresOperationRunStore } from "./postgres-store";
import { FileOperationRunStore } from "./repository";

export interface StoredOperationRun extends OperationRun {
  tenantId: string;
  ownerId: string;
  agentRunId?: string;
}

export interface StartOperationRunInput {
  conversationId: string;
  agentRunId: string;
  userRequest: string;
  title?: string;
  now?: Date;
}

export interface AppendOperationLogInput {
  operationId: string;
  summary: string;
  path?: string;
  artifact?: boolean;
  artifactDescription?: string;
}

export interface FinishOperationRunInput {
  operationId: string;
  status: Exclude<OperationStatus, "running">;
  resultSummary: string;
  reportMarkdown?: string;
  error?: string;
  errorCode?: OperationErrorCode;
}

export interface FinishOperationRunFromAgentInput {
  conversationId: string;
  agentRunId: string;
  status: "failed" | "cancelled";
  resultSummary: string;
  error: string;
  errorCode: OperationErrorCode;
}

export interface OperationRunCreateResult {
  run: StoredOperationRun;
  reportPath: string;
  artifactsDir: string;
}

export interface ListOperationRunsOptions {
  conversationId?: string;
  search?: string;
  limit?: number;
  cursor?: OperationRunCursor;
}

export interface OperationRunCursor {
  startedAt: string;
  id: string;
}

export interface OperationRunStoreContext {
  workspaceRoot: string;
  tenantId: string;
  ownerId: string;
  knowledgeBaseId: string;
}

export interface OperationRunStore {
  create(input: StartOperationRunInput): Promise<OperationRunCreateResult>;
  read(operationId: string): Promise<StoredOperationRun>;
  list(options?: ListOperationRunsOptions): Promise<StoredOperationRun[]>;
  updateTitle(operationId: string, title: string): Promise<StoredOperationRun>;
  delete(operationId: string): Promise<void>;
  appendLog(input: AppendOperationLogInput): Promise<StoredOperationRun>;
  finish(input: FinishOperationRunInput): Promise<StoredOperationRun>;
  finishFromAgentRun(input: FinishOperationRunFromAgentInput): Promise<StoredOperationRun | null>;
}

export type OperationRunDatabase = Pick<pg.Pool, "connect" | "query">;

export type OperationRunStoreFactory = (context: OperationRunStoreContext) => OperationRunStore;

export function createOperationRunStore(
  context: OperationRunStoreContext,
  database: OperationRunDatabase | null,
): OperationRunStore {
  if (database) return new PostgresOperationRunStore(context, database);
  return new FileOperationRunStore(context);
}
