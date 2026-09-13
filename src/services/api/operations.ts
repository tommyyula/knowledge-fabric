import type { OperationRun } from "@/contracts/ontology";
import { apiJson } from "@/lib/api-client";

interface ApiData<T> {
  data: T;
}

export interface ListOperationRunsOptions {
  ontologyId?: string;
  sessionId?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

export interface OperationRunPage {
  items: OperationRun[];
  nextCursor?: string;
}

type OperationRunListPayload = OperationRun[] | OperationRunPage;

export async function listOperationRuns(
  options: ListOperationRunsOptions = {},
): Promise<OperationRunPage> {
  const query = new URLSearchParams();
  if (options.ontologyId) query.set("ontologyId", options.ontologyId);
  if (options.sessionId) query.set("sessionId", options.sessionId);
  if (options.search) query.set("search", options.search);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor) query.set("cursor", options.cursor);
  const suffix = query.size ? `?${query.toString()}` : "";
  const payload = (
    await apiJson<ApiData<OperationRunListPayload>>(`/api/v1/operations${suffix}`)
  ).data;
  return Array.isArray(payload) ? { items: payload } : payload;
}

export async function updateOperationRun(
  ontologyId: string,
  operationId: string,
  title: string,
): Promise<OperationRun> {
  return (await apiJson<ApiData<OperationRun>>(`/api/v1/operations/${encodeURIComponent(operationId)}`, {
    method: "PATCH",
    body: JSON.stringify({ ontologyId, title }),
  })).data;
}

export async function deleteOperationRun(ontologyId: string, operationId: string): Promise<void> {
  const query = new URLSearchParams({ ontologyId });
  await apiJson<void>(`/api/v1/operations/${encodeURIComponent(operationId)}?${query.toString()}`, {
    method: "DELETE",
  });
}
