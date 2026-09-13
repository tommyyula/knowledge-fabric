import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { JourneyState, OntologyProject, OntologySession, OntologySyncResult } from "@/contracts/ontology";
import { applyTemplateSync, approveAllOntologyReviews, approveOntologyReview, approveOntologyReviewDraft, createOntology, deleteOntology, discardAllOntologyReviews, discardOntologyReview, discardOntologyReviewDraft, generateOntologyGraph, generateOntologyLayerGraph, getJourneyState, getOntologyFile, getOntologyReviewDraft, getOntologyTree, getTemplateSyncStatus, listOntologies, listOntologyRawSources, listPendingOntologyReviews, recoverOntologyReview, updateOntology, uploadOntologyRawSource, type ReviewActionOptions } from "@/services/api/ontology";
import { createOntologySession, deleteOntologySession, getOntologyChatStatus, listOntologyMessages, listOntologySessions, sendOntologyChat, updateOntologySession, type OntologyChatStatus } from "@/services/api/ontology-chat";
import { createResourceFolder, deleteResource, deleteResourceFolder, getResourcePreview, listResourceLibrary, renameResource, uploadResource } from "@/services/api/resource-library";

export function useOntologies() { return useQuery({ queryKey: ["ontologies"], queryFn: listOntologies, retry: 1 }); }
export function useCreateOntology() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createOntology,
    onSuccess: (created) => {
      qc.setQueryData<OntologySession[]>(["ontology-sessions", created.project.id], (prev) => {
        const current = prev ?? [];
        return current.some((item) => item.id === created.session.id) ? current : [created.session, ...current];
      });
      void qc.invalidateQueries({ queryKey: ["ontologies"] });
      void qc.invalidateQueries({ queryKey: ["ontology-sessions", created.project.id] });
    },
  });
}
export function useUpdateOntology() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Parameters<typeof updateOntology>[1] }) => updateOntology(id, updates),
    onSuccess: (_project, vars) => {
      void qc.invalidateQueries({ queryKey: ["ontologies"] });
      void qc.invalidateQueries({ queryKey: ["ontology-sessions", vars.id] });
    },
  });
}
export function useDeleteOntology() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, keepConversationHistory }: { id: string; keepConversationHistory: boolean }) => deleteOntology(id, keepConversationHistory),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["ontologies"] });
      // 保留会话时，重新从后端拉取最新会话列表（后端已软删除，会话仍在）
      if (vars.keepConversationHistory) {
        void qc.invalidateQueries({ queryKey: ["ontology-sessions", vars.id] });
      } else {
        // 不保留时，直接清除缓存，不再请求（后端已删会话）
        qc.removeQueries({ queryKey: ["ontology-sessions", vars.id] });
      }
    },
  });
}
const isBackendId = (id?: string | null) => Boolean(id && !id.startsWith("proj-"));
const sessionLastActiveAt = (session: OntologySession) => session.lastActiveAt ?? session.updatedAt;
export function useOntologyTree(id?: string, scope: "knowledge" | "workspace" = "knowledge") { return useQuery({ queryKey: ["ontology-tree", id, scope], queryFn: () => getOntologyTree(id!, scope), enabled: isBackendId(id), retry: 1 }); }
export function useOntologyFile(id?: string, path?: string | null) { return useQuery({ queryKey: ["ontology-file", id, path], queryFn: () => getOntologyFile(id!, path!), enabled: isBackendId(id) && Boolean(path), retry: 1 }); }
export function useGenerateOntologyGraph() { return useMutation({ mutationFn: generateOntologyGraph }); }
export function useGenerateOntologyLayerGraph() { return useMutation({ mutationFn: generateOntologyLayerGraph }); }
export function useOntologySessions(id?: string) { return useQuery({ queryKey: ["ontology-sessions", id], queryFn: () => listOntologySessions(id!), enabled: isBackendId(id), retry: 1 }); }
export function useAllOntologySessions(projects: readonly OntologyProject[]) {
  const backendProjects = projects.filter((project) => isBackendId(project.id));
  const queries = useQueries({
    queries: backendProjects.map((project) => ({
      queryKey: ["ontology-sessions", project.id],
      queryFn: () => listOntologySessions(project.id),
      retry: 1,
    })),
  });
  const sessions = queries.flatMap((query) => query.data ?? []) as OntologySession[];
  return {
    data: sessions.slice().sort((a, b) => sessionLastActiveAt(b) - sessionLastActiveAt(a)),
    isLoading: queries.some((query) => query.isLoading),
    isError: queries.some((query) => query.isError),
  };
}
export function useCreateOntologySession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createOntologySession,
    onSuccess: (session, id) => {
      qc.setQueryData<ReturnType<typeof listOntologySessions> extends Promise<infer T> ? T : never>(["ontology-sessions", id], (prev) => {
        const current = prev ?? [];
        return current.some((item) => item.id === session.id) ? current : [session, ...current];
      });
      void qc.invalidateQueries({ queryKey: ["ontology-sessions", id] });
    },
  });
}
export function useUpdateOntologySession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ontologyId, sessionId, updates }: { ontologyId: string; sessionId: string; updates: Parameters<typeof updateOntologySession>[2] }) => updateOntologySession(ontologyId, sessionId, updates),
    onSuccess: (_data, vars) => void qc.invalidateQueries({ queryKey: ["ontology-sessions", vars.ontologyId] }),
  });
}
export function useDeleteOntologySession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ontologyId, sessionId }: { ontologyId: string; sessionId: string }) => deleteOntologySession(ontologyId, sessionId),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["ontology-sessions", vars.ontologyId] });
      void qc.removeQueries({ queryKey: ["ontology-messages", vars.ontologyId, vars.sessionId] });
    },
  });
}
export function useOntologyMessages(id?: string, sessionId?: string | null) { return useQuery({ queryKey: ["ontology-messages", id, sessionId], queryFn: () => listOntologyMessages(id!, sessionId!), enabled: isBackendId(id) && Boolean(sessionId), retry: 1, refetchOnMount: "always" }); }
export function useOntologyChatStatus(id?: string, sessionId?: string | null, enabled = true) {
  return useQuery({
    queryKey: ["ontology-chat-status", id, sessionId],
    queryFn: () => getOntologyChatStatus(id!, sessionId!),
    enabled: enabled && isBackendId(id) && Boolean(sessionId),
    retry: 1,
    refetchOnMount: "always",
    refetchInterval: (query) => query.state.data?.active ? 2_000 : false,
  });
}
export function useOntologyChatStatuses(sessions: readonly OntologySession[]) {
  const backendSessions = sessions
    .map((session) => ({
      sessionId: session.id,
      ontologyId: session.ontologyId ?? session.projectId,
    }))
    .filter((session): session is { sessionId: string; ontologyId: string } => isBackendId(session.ontologyId));
  const queries = useQueries({
    queries: backendSessions.map((session) => ({
      queryKey: ["ontology-chat-status", session.ontologyId, session.sessionId],
      queryFn: () => getOntologyChatStatus(session.ontologyId, session.sessionId),
      retry: 1,
      refetchInterval: (query: { state: { data?: OntologyChatStatus } }) => query.state.data?.active ? 3_000 : false,
    })),
  });
  return backendSessions.map((session, index) => ({
    ...session,
    status: queries[index]?.data ?? null,
    isLoading: Boolean(queries[index]?.isLoading),
    isError: Boolean(queries[index]?.isError),
  }));
}
export function useJourneyState(id?: string) {
  return useQuery({
    queryKey: ["journey", id],
    queryFn: () => getJourneyState(id!),
    enabled: isBackendId(id),
    retry: 1,
    refetchInterval: (query) => {
      const state = query.state.data;
      if (!state) return 4_000;
      // Stable state — mutations will push updates directly via setQueryData, no polling needed
      if (state.phase === "ready") return false;
      if (state.phase === "ingest" || state.phase === "verify") return 3_000;
      if (state.phase === "review" && state.verify?.status && state.verify.status !== "done") return 3_000;
      return 5_000;
    },
  });
}

export function useTemplateSyncStatus(id?: string) {
  return useQuery({
    queryKey: ["template-sync", id],
    queryFn: () => getTemplateSyncStatus(id!),
    enabled: isBackendId(id),
    retry: 1,
    // The bundled template only changes on deploy; a slow poll + focus refetch is plenty.
    refetchInterval: 60_000,
  });
}

export function useApplyTemplateSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => applyTemplateSync(id),
    onSuccess: (status, id) => {
      qc.setQueryData(["template-sync", id], status);
      void qc.invalidateQueries({ queryKey: ["ontology-tree", id] });
    },
  });
}
export function useOntologyRawSources(id?: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["ontology-raw-sources", id],
    queryFn: () => listOntologyRawSources(id!),
    enabled: isBackendId(id),
    retry: 1,
    refetchInterval: () => {
      const journey = qc.getQueryData<JourneyState>(["journey", id]);
      // Only poll while files are being actively processed
      if (!journey || journey.phase === "bootstrap" || journey.phase === "ingest") return 5_000;
      return false;
    },
  });
}

export function usePendingOntologyReviews(id?: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["pending-reviews", id],
    queryFn: () => listPendingOntologyReviews(id!),
    enabled: isBackendId(id),
    retry: 1,
    refetchInterval: () => {
      const journey = qc.getQueryData<JourneyState>(["journey", id]);
      // Only poll while there may be pending reviews to display
      if (!journey || journey.phase === "review") return 4_000;
      return false;
    },
  });
}

export function useOntologyReviewDraft(id?: string, draftId?: string | null) {
  return useQuery({
    queryKey: ["pending-review-draft", id, draftId],
    queryFn: () => getOntologyReviewDraft(id!, draftId!),
    enabled: isBackendId(id) && Boolean(draftId),
    retry: 1,
  });
}

function invalidateOntologyReviewQueries(qc: ReturnType<typeof useQueryClient>, ontologyId: string) {
  void qc.invalidateQueries({ queryKey: ["journey", ontologyId] });
  void qc.invalidateQueries({ queryKey: ["ontology-tree", ontologyId] });
  void qc.invalidateQueries({ queryKey: ["pending-reviews", ontologyId] });
  void qc.invalidateQueries({ queryKey: ["pending-review-draft", ontologyId] });
  void qc.invalidateQueries({ queryKey: ["ontologies"] });
}

type ReviewMutationInput = string | ({ id: string } & ReviewActionOptions);

function reviewMutationId(input: ReviewMutationInput): string {
  return typeof input === "string" ? input : input.id;
}

function reviewMutationOptions(input: ReviewMutationInput): ReviewActionOptions | undefined {
  return typeof input === "string" ? undefined : { sessionId: input.sessionId, locale: input.locale };
}

function reviewMutationSessionId(input: ReviewMutationInput): string | null | undefined {
  return typeof input === "string" ? undefined : input.sessionId;
}

function updateOntologySyncRunQueries(qc: QueryClient, ontologyId: string, sessionId: string | null | undefined, ontologySync: OntologySyncResult | undefined) {
  if (!sessionId) return;
  if (ontologySync?.status === "started" && ontologySync.runId) {
    const runId = ontologySync.runId;
    qc.setQueryData<OntologyChatStatus>(["ontology-chat-status", ontologyId, sessionId], (previous) => ({
      runId,
      active: true,
      completed: false,
      eventCount: previous?.runId === runId ? previous.eventCount : 0,
      lastSequence: previous?.runId === runId ? previous.lastSequence : null,
      updatedAt: new Date().toISOString(),
      local: previous?.local ?? false,
    }));
  }
  void qc.invalidateQueries({ queryKey: ["ontology-chat-status", ontologyId, sessionId] });
  void qc.invalidateQueries({ queryKey: ["ontology-messages", ontologyId, sessionId] });
}

export function useUploadOntologyRawSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ontologyId, file }: { ontologyId: string; file: File }) => uploadOntologyRawSource(ontologyId, { name: file.name, file, contentType: file.type || undefined }),
    onSuccess: (uploaded, vars) => {
      qc.setQueryData(["journey", vars.ontologyId], uploaded.journeyState);
      void qc.invalidateQueries({ queryKey: ["resource-library"] });
      void qc.invalidateQueries({ queryKey: ["ontology-raw-sources", vars.ontologyId] });
      void qc.invalidateQueries({ queryKey: ["journey", vars.ontologyId] });
      void qc.invalidateQueries({ queryKey: ["ontology-tree", vars.ontologyId, "workspace"] });
    },
  });
}
export function useSendOntologyChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ontologyId, sessionId, message }: { ontologyId: string; sessionId: string; message: string }) => sendOntologyChat(ontologyId, sessionId, message),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["ontology-messages", vars.ontologyId, vars.sessionId] });
      void qc.invalidateQueries({ queryKey: ["ontology-tree", vars.ontologyId] });
      void qc.invalidateQueries({ queryKey: ["journey", vars.ontologyId] });
    },
  });
}

export function useApproveOntologyReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewMutationInput) => approveOntologyReview(reviewMutationId(input), reviewMutationOptions(input)),
    onSuccess: (data, input) => {
      const ontologyId = reviewMutationId(input);
      invalidateOntologyReviewQueries(qc, ontologyId);
      updateOntologySyncRunQueries(qc, ontologyId, reviewMutationSessionId(input), data.ontologySync);
    },
  });
}

export function useDiscardOntologyReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewMutationInput) => discardOntologyReview(reviewMutationId(input), reviewMutationOptions(input)),
    onSuccess: (_data, input) => {
      invalidateOntologyReviewQueries(qc, reviewMutationId(input));
    },
  });
}

export function useApproveOntologyReviewDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, draftId, sessionId, locale }: { id: string; draftId: string } & ReviewActionOptions) => approveOntologyReviewDraft(id, draftId, { sessionId, locale }),
    onSuccess: (data, vars) => {
      invalidateOntologyReviewQueries(qc, vars.id);
      updateOntologySyncRunQueries(qc, vars.id, vars.sessionId, data.ontologySync);
    },
  });
}

export function useDiscardOntologyReviewDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, draftId, sessionId, locale }: { id: string; draftId: string } & ReviewActionOptions) => discardOntologyReviewDraft(id, draftId, { sessionId, locale }),
    onSuccess: (_data, vars) => invalidateOntologyReviewQueries(qc, vars.id),
  });
}

export function useApproveAllOntologyReviews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewMutationInput) => approveAllOntologyReviews(reviewMutationId(input), reviewMutationOptions(input)),
    onSuccess: (data, input) => {
      const ontologyId = reviewMutationId(input);
      qc.setQueryData(["journey", ontologyId], data.journeyState);
      qc.setQueryData(["pending-reviews", ontologyId], []);
      void qc.removeQueries({ queryKey: ["pending-review-draft", ontologyId] });
      invalidateOntologyReviewQueries(qc, ontologyId);
      updateOntologySyncRunQueries(qc, ontologyId, reviewMutationSessionId(input), data.ontologySync);
    },
  });
}

export function useDiscardAllOntologyReviews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewMutationInput) => discardAllOntologyReviews(reviewMutationId(input), reviewMutationOptions(input)),
    onSuccess: (_data, input) => invalidateOntologyReviewQueries(qc, reviewMutationId(input)),
  });
}

export function useRecoverOntologyReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewMutationInput) => recoverOntologyReview(reviewMutationId(input), reviewMutationOptions(input)),
    onSuccess: (_data, input) => {
      const ontologyId = reviewMutationId(input);
      invalidateOntologyReviewQueries(qc, ontologyId);
      const sessionId = typeof input === "string" ? undefined : input.sessionId;
      if (sessionId) {
        void qc.invalidateQueries({ queryKey: ["ontology-chat-status", ontologyId, sessionId] });
        void qc.invalidateQueries({ queryKey: ["ontology-messages", ontologyId, sessionId] });
      }
    },
  });
}

export function useResourceLibrary() {
  return useQuery({ queryKey: ["resource-library"], queryFn: listResourceLibrary, retry: 1 });
}

export function useResourcePreview(id?: string | null) {
  return useQuery({
    queryKey: ["resource-preview", id],
    queryFn: () => getResourcePreview(id!),
    enabled: Boolean(id),
    retry: 1,
  });
}

export function useCreateResourceFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createResourceFolder,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["resource-library"] }),
  });
}

export function useUploadResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: uploadResource,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["resource-library"] }),
  });
}

export function useRenameResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameResource(id, name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["resource-library"] }),
  });
}

export function useDeleteResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteResource,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["resource-library"] }),
  });
}

export function useDeleteResourceFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteResourceFolder,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["resource-library"] }),
  });
}
