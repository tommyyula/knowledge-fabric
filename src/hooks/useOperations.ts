import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { mergeOperationRunPages } from "@/lib/operation-run-history";
import { deleteOperationRun, listOperationRuns, updateOperationRun } from "@/services/api/operations";

export function useOperationRuns(options: {
  ontologyId?: string;
  sessionId?: string;
  search?: string;
  enabled?: boolean;
} = {}) {
  const { ontologyId, sessionId, search, enabled = true } = options;
  const normalizedSearch = search?.trim() || undefined;
  return useInfiniteQuery({
    queryKey: ["operation-runs", ontologyId ?? "all", sessionId ?? "all", normalizedSearch ?? ""],
    queryFn: ({ pageParam }) => listOperationRuns({
      ontologyId,
      sessionId,
      search: normalizedSearch,
      limit: 50,
      cursor: pageParam || undefined,
    }),
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: (data) => mergeOperationRunPages(data.pages),
    enabled,
    retry: 1,
    refetchInterval: (query) => {
      const data = query.state.data as { pages?: Array<{ items: Array<{ status: string }> }> } | undefined;
      return data?.pages?.some((page) => page.items.some((run) => run.status === "running")) ? 3_000 : false;
    },
  });
}

export function useUpdateOperationRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ontologyId, operationId, title }: { ontologyId: string; operationId: string; title: string }) =>
      updateOperationRun(ontologyId, operationId, title),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["operation-runs"] }),
  });
}

export function useDeleteOperationRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ontologyId, operationId }: { ontologyId: string; operationId: string }) =>
      deleteOperationRun(ontologyId, operationId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["operation-runs"] }),
  });
}
