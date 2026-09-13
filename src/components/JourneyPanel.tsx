import React, { useEffect, useMemo, useRef, useState } from "react";
import { BootstrapState, IngestState, VerifyState, ReviewState, ReviewFile, JourneyPhase } from "../mocks/data";
import type { BootstrapRawSource, JourneyFlow } from "@/contracts/ontology";
import { useOntologyFile } from "@/hooks/useOntologies";
import { composerFileReferencesStore } from "@/lib/composer-file-references-store";
import FilePreviewModal from "./FilePreviewModal";

interface JourneyPanelProps {
  flow: JourneyFlow;
  phase: JourneyPhase;
  bootstrapState: BootstrapState;
  ingestState: IngestState;
  verifyState: VerifyState;
  reviewState: ReviewState;
  t: (key: string, params?: Record<string, string>) => string;
  onBootstrapUpdate?: (state: Partial<BootstrapState>) => void;
  onReviewApproveAll?: () => void;
  reviewApproving?: boolean;
  loading?: boolean;
  projectId?: string | null;
}

function stripContentRoot(filePath: string) {
  return filePath.replace(/^knowledge\//, "").replace(/^wiki\//, "");
}

function reviewDraftWorkspacePath(draftId: string | undefined, filePath: string) {
  const normalized = filePath.trim().replace(/^\/+/, "");
  if (!normalized || !draftId || normalized.startsWith("pending_review/drafts/")) return normalized;
  return `pending_review/drafts/${draftId}/${normalized}`;
}

interface RawSourceTreeNode {
  id: string;
  name: string;
  kind: "folder" | "file";
  source?: BootstrapRawSource;
  children: RawSourceTreeNode[];
}

function rawSourceDisplayParts(source: BootstrapRawSource): string[] {
  const sourceName = source.sourceName?.replace(/\\/g, "/");
  if (sourceName?.includes("#")) {
    const [workbook, sheetName] = sourceName.split("#", 2);
    return [...workbook.split("/"), `${sheetName || "Sheet"}.md`].filter(Boolean);
  }
  return (sourceName || source.path.replace(/^raw\//, "")).split("/").filter(Boolean);
}

function buildRawSourceTree(sources: readonly BootstrapRawSource[]): RawSourceTreeNode[] {
  const root: RawSourceTreeNode[] = [];
  const findOrCreate = (siblings: RawSourceTreeNode[], id: string, name: string, kind: RawSourceTreeNode["kind"]) => {
    let node = siblings.find((item) => item.id === id);
    if (!node) {
      node = { id, name, kind, children: [] };
      siblings.push(node);
    }
    return node;
  };

  for (const source of sources) {
    const parts = rawSourceDisplayParts(source);
    let siblings = root;
    let id = "";
    parts.forEach((part, index) => {
      id = id ? `${id}/${part}` : part;
      const isLeaf = index === parts.length - 1;
      const node = findOrCreate(siblings, id, part, isLeaf ? "file" : "folder");
      if (isLeaf) node.source = source;
      siblings = node.children;
    });
  }

  const sortTree = (nodes: RawSourceTreeNode[]) => {
    nodes.sort((a, b) => a.children.length && !b.children.length ? -1 : !a.children.length && b.children.length ? 1 : a.name.localeCompare(b.name));
    nodes.forEach((node) => sortTree(node.children));
    return nodes;
  };
  return sortTree(root);
}

function RawSourceTree({ nodes, depth, onPreview, t }: { nodes: RawSourceTreeNode[]; depth: number; onPreview: (path: string) => void; t: (key: string, params?: Record<string, string>) => string }) {
  return (
    <div className={depth === 0 ? "bootstrap-source-tree" : "bootstrap-source-tree-children"}>
      {nodes.map((node) => (
        <div key={node.id} className="bootstrap-source-tree-node">
          {node.source ? (
            <button type="button" className="bootstrap-source-tree-row is-file" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onPreview(node.source!.path)} title={t("filePreview.previewPath", { path: node.source.path })}>
              <span className="bootstrap-source-name">{node.name}</span>
              <span className="bootstrap-source-status">{node.source.status === "ready" ? t("journey.sourceReady") : node.source.status}</span>
            </button>
          ) : (
            <div className="bootstrap-source-tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
              <span className="bootstrap-source-name">{node.name}</span>
            </div>
          )}
          {node.children.length > 0 && <RawSourceTree nodes={node.children} depth={depth + 1} onPreview={onPreview} t={t} />}
        </div>
      ))}
    </div>
  );
}

type BuildStepKey = "bootstrap" | "ingest" | "verify" | "review";

const buildStepOrder: BuildStepKey[] = ["bootstrap", "ingest", "verify", "review"];

function buildStepIndex(key: BuildStepKey): number {
  return buildStepOrder.indexOf(key);
}

export default function JourneyPanel({ flow, phase, bootstrapState, ingestState, verifyState, reviewState, t, onBootstrapUpdate, onReviewApproveAll, reviewApproving, loading, projectId }: JourneyPanelProps) {
  const phaseSteps: { key: BuildStepKey; label: string }[] = [
    { key: "bootstrap", label: t("journey.bootstrap") },
    { key: "ingest", label: t("journey.ingest") },
    { key: "verify", label: t("journey.verify") },
    { key: "review", label: t("journey.review") },
  ];
  const currentStepKey =
    phase === "ready" ? "review" :
    phase === "review" ? "review" :
    phase === "verify" ? "verify" :
    phase === "ingest" ? "ingest" :
    "bootstrap";
  const currentIdx = Math.max(0, buildStepIndex(currentStepKey));
  const isBuildJourney = flow === "build";
  const isMaintenanceReview = phase === "review" && flow === "maintenance";
  const stepArtifacts = useMemo<Record<BuildStepKey, boolean>>(() => ({
    bootstrap: Boolean(
      bootstrapState.goal?.trim() ||
      bootstrapState.name?.trim() ||
      bootstrapState.description?.trim() ||
      bootstrapState.result ||
      bootstrapState.pageTypes.length ||
      (bootstrapState.rawSources?.length ?? 0)
    ),
    ingest: Boolean(
      ingestState.progress > 0 ||
      ingestState.totalBatches > 0 ||
      ingestState.completedBatches > 0 ||
      ingestState.batches.length ||
      (ingestState.files?.length ?? 0) ||
      (ingestState.generatedPages?.length ?? 0)
    ),
    verify: Boolean(
      verifyState.questionCount > 0 ||
      verifyState.coverage > 0 ||
      verifyState.cases.length ||
      verifyState.fixes.length ||
      verifyState.status !== "generating"
    ),
    review: Boolean(reviewState.description?.trim() || reviewState.draftId || reviewState.files.length),
  }), [bootstrapState.description, bootstrapState.goal, bootstrapState.name, bootstrapState.pageTypes.length, bootstrapState.rawSources, bootstrapState.result, ingestState.batches.length, ingestState.completedBatches, ingestState.files, ingestState.generatedPages, ingestState.progress, ingestState.totalBatches, reviewState.description, reviewState.draftId, reviewState.files.length, verifyState.cases.length, verifyState.coverage, verifyState.fixes.length, verifyState.status, verifyState.questionCount]);
  const previousCurrentStepRef = useRef<BuildStepKey>(currentStepKey);
  const [viewStepKey, setViewStepKey] = useState<BuildStepKey>(currentStepKey);
  const canViewStep = (key: BuildStepKey) => {
    const stepIdx = buildStepIndex(key);
    return stepIdx >= 0 && stepIdx <= currentIdx && (key === currentStepKey || stepArtifacts[key]);
  };

  useEffect(() => {
    const previousCurrentStep = previousCurrentStepRef.current;
    previousCurrentStepRef.current = currentStepKey;
    setViewStepKey((currentView) => {
      const currentViewIdx = buildStepIndex(currentView);
      const canStillView = currentViewIdx >= 0 && currentViewIdx <= currentIdx && (currentView === currentStepKey || stepArtifacts[currentView]);
      if (!canStillView) return currentStepKey;
      if (currentView === previousCurrentStep) return currentStepKey;
      return currentView;
    });
  }, [currentIdx, currentStepKey, stepArtifacts]);

  const displayStepKey = canViewStep(viewStepKey) ? viewStepKey : currentStepKey;

  return (
    <div className={`journey-panel${isMaintenanceReview ? " journey-panel-pr-review" : ""}`}>
      {/* Stepper */}
      {isBuildJourney && <div className="journey-stepper">
        {phaseSteps.map((step, i) => {
          const isClickable = canViewStep(step.key);
          const isViewing = step.key === displayStepKey && isBuildJourney;
          const stepClassName = `journey-step${i <= currentIdx ? " active" : ""}${i === currentIdx ? " current" : ""}${isViewing ? " viewing" : ""}${isClickable ? " clickable" : ""}${i === currentIdx && !isViewing ? " live-indicator" : ""}`;
          const stepContent = (
            <>
              <div className="journey-step-dot">
                {i < currentIdx && <svg viewBox="0 0 24 24" width="10" height="10"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              </div>
              <span className="journey-step-label">{step.label}</span>
            </>
          );
          return (
            <React.Fragment key={step.key}>
              {isClickable ? (
                <button type="button" className={stepClassName} onClick={() => setViewStepKey(step.key)} aria-current={isViewing ? "step" : undefined}>
                  {stepContent}
                </button>
              ) : (
                <div className={stepClassName}>{stepContent}</div>
              )}
              {i < phaseSteps.length - 1 && (
                <div className={`journey-step-line${i < currentIdx ? " active" : i === currentIdx ? " half" : ""}`} />
              )}
            </React.Fragment>
          );
        })}
      </div>}

      <div className="journey-content">
        {displayStepKey === "bootstrap" && <BootstrapView projectId={projectId} state={bootstrapState} onUpdate={onBootstrapUpdate} loading={loading} t={t} />}
        {displayStepKey === "ingest" && <IngestView state={ingestState} t={t} />}
        {displayStepKey === "review" && <ReviewView state={reviewState} isMaintenanceReview={isMaintenanceReview} onApproveAll={onReviewApproveAll} approving={Boolean(reviewApproving)} t={t} />}
        {displayStepKey === "verify" && <VerifyView state={verifyState} t={t} />}
      </div>
    </div>
  );
}

function BootstrapView({ projectId, state, onUpdate, loading, t }: { projectId?: string | null; state: BootstrapState; onUpdate?: (state: Partial<BootstrapState>) => void; loading?: boolean; t: (key: string, params?: Record<string, string>) => string }) {
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [goalDraft, setGoalDraft] = useState(state.goal ?? "");
  const previewQuery = useOntologyFile(projectId ?? undefined, previewPath);

  void onUpdate;
  const statusLabel =
    state.status === "hydrating" ? t("journey.status.hydrating") :
    state.status === "metadata_confirmation" || state.status === "metadata_proposed" ? t("journey.status.metadata") :
    state.status === "schema_confirmation" ? t("journey.status.schemaConfirmation") :
    state.status === "schema_proposed" ? t("journey.status.schemaProposed") :
    state.status === "materials_ready" ? t("journey.status.materialsReady") :
    state.status === "materials_collection" ? t("journey.status.materialsCollection") :
    state.status === "goal_selection" ? t("journey.status.goalSelection") :
    t("journey.status.ready");
  const canAskClaudeToContinue = state.status === "goal_selection" || state.status === "materials_collection" || state.status === "materials_ready";
  const rawSources = state.rawSources ?? [];
  const rawSourceTree = buildRawSourceTree(rawSources);
  const showSchema = state.pageTypes.length > 0 || state.status === "schema_proposed" || state.status === "schema_confirmation" || state.status === "metadata_proposed" || state.status === "metadata_confirmation" || state.status === "hydrating" || state.status === "done";
  const showMaterials = state.status !== "done" && !showSchema;
  const showHero = showSchema || Boolean(state.name || state.description || state.result?.emoji);
  useEffect(() => {
    if (state.goal && state.goal !== goalDraft) setGoalDraft(state.goal);
  }, [goalDraft, state.goal]);

  return (
    <div className={`journey-bootstrap${loading ? " bootstrap-locked" : ""}`}>
      {loading && (
        <div className="bootstrap-loading-indicator">
          <span className="bootstrap-loading-dot" />
          <span className="bootstrap-loading-dot" />
          <span className="bootstrap-loading-dot" />
        </div>
      )}

      {showHero && <div className="bootstrap-hero">
        {state.name ? (
          <h2 className="bootstrap-hero-name">{state.name}</h2>
        ) : (
          <h2 className="bootstrap-hero-name placeholder">{t("journey.newKnowledge")}</h2>
        )}

        {/* Description */}
        {state.description && (
          <p className="bootstrap-hero-desc">{state.description}</p>
        )}
        {state.result?.emoji && <span className="bootstrap-value pending">{state.result.emoji}</span>}
        <span className="bootstrap-value pending">{statusLabel}</span>
      </div>}

      {state.goal && (
        <div className="bootstrap-field">
          <span className="bootstrap-label">{t("journey.goal")}</span>
          <span className="bootstrap-value">{state.goal}</span>
        </div>
      )}

      {showMaterials && (
        <div className="bootstrap-field bootstrap-materials">
          {canAskClaudeToContinue && (
            <div className="bootstrap-goal-inline">
              <span className="bootstrap-label">{t("journey.coverageDomain")}</span>
              <textarea
                className="bootstrap-goal-input"
                value={goalDraft}
                onChange={(event) => setGoalDraft(event.currentTarget.value)}
                placeholder={t("journey.goalPlaceholder")}
                rows={3}
              />
            </div>
          )}
          <span className="bootstrap-label">{t("journey.sourceMaterials")}</span>
          {rawSources.length === 0 ? (
            <span className="bootstrap-value pending">{t("journey.noMaterials")}</span>
          ) : (
            <div className="bootstrap-sources">
              <RawSourceTree nodes={rawSourceTree} depth={0} onPreview={setPreviewPath} t={t} />
            </div>
          )}
        </div>
      )}

      {previewPath && (
        <FilePreviewModal
          t={t}
          path={previewPath}
          content={previewQuery.data?.content}
          loading={previewQuery.isLoading}
          error={previewQuery.isError ? t("journey.fileReadError") : undefined}
          onNavigatePath={setPreviewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}

      {showSchema && <div className="bootstrap-field">
        <span className="bootstrap-label">{t("journey.schema")}</span>
        {state.pageTypes.length === 0 ? (
          <span className="bootstrap-value pending">{t("journey.awaiting")}</span>
        ) : (
          <div className="bootstrap-types">
            {state.pageTypes.map((pt, idx) => (
              <div key={`${pt.name}-${idx}`} className={`bootstrap-type-item${pt.confirmed ? " confirmed" : ""}`}>
                <div className="bootstrap-type-content">
                  <span className="bootstrap-type-name">{pt.name}</span>
                  {pt.description && (
                    <span className="bootstrap-type-desc">{pt.description}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>}
    </div>
  );
}

function IngestView({ state, t }: { state: IngestState; t: (key: string, params?: Record<string, string>) => string }) {
  const batches: IngestState["batches"] = state.batches.length
    ? state.batches
    : (state.files ?? []).map((file, index) => ({
        id: `file-${index + 1}`,
        label: file.path.split("/").pop() || file.path,
        description: file.path,
        fileCount: 1,
        status: file.status === "done" ? "success" as const : file.status === "error" ? "failed" as const : file.status === "processing" ? "processing" as const : "pending" as const,
      }));
  const totalBatches = Math.max(state.totalBatches, batches.length);
  const hasWork = totalBatches > 0 || batches.length > 0;

  // Fake progress for the first "processing" batch to reduce perceived wait time
  const [fakeProgress, setFakeProgress] = useState(0);
  const fakeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasProcessing = batches.some((b) => b.status === "processing");

  useEffect(() => {
    if (hasProcessing) {
      setFakeProgress(0);
      fakeTimerRef.current = setInterval(() => {
        setFakeProgress((prev) => {
          // Slow asymptotic curve: approaches 90% but never reaches it
          const next = prev + (90 - prev) * 0.03;
          return next >= 89 ? 89 : next;
        });
      }, 800);
    } else {
      if (fakeTimerRef.current) clearInterval(fakeTimerRef.current);
      fakeTimerRef.current = null;
      setFakeProgress(0);
    }
    return () => { if (fakeTimerRef.current) clearInterval(fakeTimerRef.current); };
  }, [hasProcessing]);

  return (
    <div className="journey-ingest">
      <div className="journey-section-title">
        <span>{t("journey.ingesting")}</span>
        {hasWork ? (
          <span className="ingest-counter">{state.completedBatches}/{totalBatches} {t("journey.batches")}</span>
        ) : (
          <span className="ingest-counter">{t("journey.preparing")}</span>
        )}
      </div>

      <div className="journey-progress-bar">
        <div className="journey-progress-fill" style={{ width: `${state.progress}%` }} />
      </div>

      <div className="ingest-batch-list">
        {!hasWork && (
          <div className="bootstrap-value pending">{t("journey.ingestPendingDraft")}</div>
        )}
        {batches.map((batch) => (
          <div key={batch.id} className={`ingest-batch-item ${batch.status}`}>
            <span className="ingest-batch-icon">
              {batch.status === "success" && "\u2713"}
              {batch.status === "processing" && "\u25CF"}
              {batch.status === "pending" && "\u25CB"}
              {batch.status === "failed" && "\u2717"}
            </span>
            <div className="ingest-batch-content">
              <span className="ingest-batch-label">{batch.label}</span>
              <span className="ingest-batch-desc">{batch.description}</span>
            </div>
            {batch.status === "processing" ? (
              <span className="ingest-batch-files">{Math.round(fakeProgress)}%</span>
            ) : (
              <span className="ingest-batch-files">{batch.status === "success" ? "100%" : t("journey.fileCount", { count: String(batch.fileCount) })}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function VerifyView({ state, t }: { state: VerifyState; t: (key: string, params?: Record<string, string>) => string }) {
  const passCount = state.passCount ?? state.cases.filter((c) => c.status === "pass" || c.status === "fixed").length;
  const failCount = state.failCount ?? state.cases.filter((c) => c.status === "fail").length;
  const fixedCount = state.fixedCount ?? state.autoFixed ?? state.cases.filter((c) => c.status === "fixed" || c.repaired).length;
  const answeredCount = state.answeredCount ?? state.cases.filter((c) => c.initialAnswer || c.knowledgeAnswer).length;
  const hasRepairActivity = state.status === "fixing" || fixedCount > 0 || state.cases.some((c) => c.status === "fixing" || c.status === "retesting" || c.status === "fixed" || c.repaired);
  const phases = [
    { key: "generating", label: t("journey.generating") },
    { key: "testing", label: t("journey.testing") },
    ...(hasRepairActivity ? [{ key: "fixing", label: t("journey.fixing") }] : []),
    { key: "done", label: t("journey.done") },
  ];
  const currentPhaseKey = state.status === "done" ? "done" : state.status;
  const currentPhaseIdx = Math.max(0, phases.findIndex((p) => p.key === currentPhaseKey));
  const statusIcon = (status: VerifyState["cases"][number]["status"]) => {
    if (status === "pass" || status === "fixed") return "\u2713";
    if (status === "fail") return "\u2717";
    if (status === "warning") return "\u26A0";
    if (status === "fixing" || status === "retesting") return "\u21BB";
    return "\u25CF";
  };
  const referenceText = (value: unknown): string | null => {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join(", ") || null;
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const file = typeof record.file === "string" ? record.file : undefined;
      const cited = typeof record.cited_text === "string" ? record.cited_text : undefined;
      return [file, cited].filter(Boolean).join(" — ") || null;
    }
    return null;
  };

  return (
    <div className="journey-verify">
      <div className="journey-section-title">{t("journey.verification")}</div>

      {/* Phase indicator */}
      <div className="verify-phases">
        {phases.map((p, i) => {
          const completed = i < currentPhaseIdx || (p.key === "done" && state.status === "done");
          return (
            <div key={p.key} className={`verify-phase-item${i <= currentPhaseIdx ? " active" : ""}${i === currentPhaseIdx ? " current" : ""}${completed ? " completed" : ""}`}>
              <span className="verify-phase-dot">
                {completed ? "\u2713" : i === currentPhaseIdx ? "\u25CF" : "\u25CB"}
              </span>
              <span className="verify-phase-label">{p.label}</span>
            </div>
          );
        })}
      </div>

      {/* Phase 1: Generating */}
      {state.status === "generating" && (
        <div className="verify-generating">
          <div className="verify-generating-text">
            <span className="verify-generating-spinner" />
            <span>{t("journey.generatingFromSource")}</span>
          </div>
          {state.questionCount > 0 && (
            <span className="verify-generating-count">{state.questionCount} {t("journey.questions")}</span>
          )}
        </div>
      )}

      {/* Phase 2 & 3: Testing / Fixing */}
      {(state.status === "testing" || state.status === "fixing" || state.status === "done") && (
        <>
          <div className="verify-summary">
            <div className="verify-summary-item">
              <span className="verify-summary-value">{state.questionCount}</span>
              <span className="verify-summary-label">{t("journey.verify.qaGenerated")}</span>
            </div>
            <div className="verify-summary-item">
              <span className="verify-summary-value">{answeredCount}</span>
              <span className="verify-summary-label">{t("journey.verify.answered")}</span>
            </div>
            <div className="verify-summary-item pass">
              <span className="verify-summary-value">{passCount}</span>
              <span className="verify-summary-label">{t("journey.verify.pass")}</span>
            </div>
            <div className="verify-summary-item fail">
              <span className="verify-summary-value">{failCount}</span>
              <span className="verify-summary-label">{t("journey.verify.fail")}</span>
            </div>
          </div>

          <div className="journey-progress-bar">
            <div className="journey-progress-fill" style={{ width: `${state.coverage}%` }} />
          </div>

          <div className="verify-cases">
            {state.cases.map((c) => (
              <details key={c.id ?? c.name} className={`verify-case-item status-${c.status}`}>
                <summary className="verify-case-summary">
                  <span className="verify-case-icon">{statusIcon(c.status)}</span>
                  <span className="verify-case-main">
                    <span className="verify-case-name">{c.question ?? c.name}</span>
                    <span className="verify-case-meta">
                      {c.level && <span>{c.level}</span>}
                      {c.sourceFile && <span>{c.sourceFile}</span>}
                    </span>
                  </span>
                  <span className={`verify-case-status status-${c.status === "fixed" ? "pass" : c.status}`}>{t(`journey.verifyStatus.${c.status === "fixed" ? "pass" : c.status}`)}</span>
                </summary>
                <div className="verify-case-detail">
                  {c.expectedAnswer && (
                    <div className="verify-answer-block">
                      <div className="verify-answer-label">{t("journey.verify.expectedAnswer")}</div>
                      <div className="verify-answer-text">{c.expectedAnswer}</div>
                    </div>
                  )}
                  {c.initialAnswer && (
                    <div className="verify-answer-block">
                      <div className="verify-answer-label">{t("journey.verify.initialAnswer")}</div>
                      <div className="verify-answer-text">{c.initialAnswer}</div>
                    </div>
                  )}
                  {c.knowledgeAnswer && c.knowledgeAnswer !== c.initialAnswer && (
                    <div className="verify-answer-block">
                      <div className="verify-answer-label">{t("journey.verify.finalAnswer")}</div>
                      <div className="verify-answer-text">{c.knowledgeAnswer}</div>
                    </div>
                  )}
                  {referenceText(c.knowledgeReference) && (
                    <div className="verify-answer-block">
                      <div className="verify-answer-label">{t("journey.verify.reference")}</div>
                      <div className="verify-answer-text">{referenceText(c.knowledgeReference)}</div>
                    </div>
                  )}
                  {c.note && (
                    <div className="verify-answer-block">
                      <div className="verify-answer-label">{t("journey.verify.note")}</div>
                      <div className="verify-answer-text">{c.note}</div>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ReviewView({ state, isMaintenanceReview, onApproveAll, approving, t }: { state: ReviewState; isMaintenanceReview: boolean; onApproveAll?: () => void; approving?: boolean; t: (key: string, params?: Record<string, string>) => string }) {
  const [previewFile, setPreviewFile] = useState<{ path: string; content: string } | null>(null);
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const referenceFile = (file: ReviewFile) => {
    composerFileReferencesStore.add({ ref: reviewDraftWorkspacePath(state.draftId, file.path), label: stripContentRoot(file.path) });
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".aui-composer-input")?.focus(), 0);
  };

  const modCount = state.files.filter((f) => f.status === "modified").length;
  const markViewed = (path: string) => {
    setViewedFiles((prev) => new Set(prev).add(path));
  };

  const buildTree = () => {
    const tree: { files: ReviewFile[]; folders: Record<string, ReviewFile[]> } = { files: [], folders: {} };

    state.files.forEach((file) => {
      const parts = stripContentRoot(file.path).split("/");
      if (parts.length === 1) {
        tree.files.push(file);
      } else {
        const folder = parts[0];
        if (!tree.folders[folder]) tree.folders[folder] = [];
        tree.folders[folder].push(file);
      }
    });

    return tree;
  };

  const tree = buildTree();
  const folderNames = Object.keys(tree.folders).sort();
  const showReviewMetadata = isMaintenanceReview;

  return (
    <div className={`journey-review${isMaintenanceReview ? " journey-pr-review" : ""}`}>
      <div className="journey-section-title">
        <span>{isMaintenanceReview ? t("review.prTitle") : t("review.structure")}</span>
        {showReviewMetadata && state.draftId && <span className="review-draft-id">{state.draftId}</span>}
      </div>

      {showReviewMetadata && state.description && (
        <div className="review-summary">
          <p className="review-description">{state.description}</p>
          {state.files.length > 0 && (
            <div className="review-file-count">
              <span>{t("review.filesChanged", { count: String(state.files.length) })}</span>
              <span className="review-count-new">{t("review.newCount", { count: String(state.files.filter((f) => f.status === "new").length) })}</span>
              <span className="review-count-mod">{t("review.modifiedCount", { count: String(modCount) })}</span>
            </div>
          )}
        </div>
      )}

      {isMaintenanceReview && state.files.length > 0 && (
        <div className="review-pr-callout">
          <span>{t("review.prCallout")}</span>
        </div>
      )}

      <div className="review-tree">
        {state.files.length === 0 && (
          <div className="bootstrap-value pending">{t("review.waitingDraft")}</div>
        )}
        {folderNames.map((folder) => (
          <ReviewFolder key={folder} name={folder} files={tree.folders[folder]} draftId={state.draftId} isMaintenanceReview={isMaintenanceReview} onFileClick={(file) => { markViewed(file.path); setPreviewFile({ path: file.path, content: file.content }); }} onReferenceFile={referenceFile} viewedFiles={viewedFiles} t={t} />
        ))}
        {tree.files.map((file) => {
          const referencePath = reviewDraftWorkspacePath(state.draftId, file.path);
          return (
            <div key={file.path} className="review-tree-file" onClick={() => { markViewed(file.path); setPreviewFile({ path: file.path, content: file.content }); }}>
              <svg viewBox="0 0 24 24" width="14" height="14"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M14 2v6h6" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
              <span className="review-tree-filename">{stripContentRoot(file.path)}</span>
              {isMaintenanceReview ? (
                <span className={`review-badge-inline ${file.status === "new" ? "new" : "mod"}`}>{file.status === "new" ? t("review.badgeNew") : t("review.badgeModified")}</span>
              ) : (
                <button type="button" className="review-tree-ref-btn" aria-label={`Reference ${stripContentRoot(file.path)}`} title={`@ ${referencePath}`} onClick={(event) => { event.stopPropagation(); referenceFile(file); }}>@</button>
              )}
            </div>
          );
        })}
      </div>

      {state.files.length > 0 && <div className={`review-confirm-fixed${approving ? " is-approving" : ""}`}>
        {approving && <span className="review-approve-status">{t("review.approveProgress")}</span>}
        <button className="review-btn-approve" disabled={approving} aria-busy={approving} onClick={() => onApproveAll?.()}>
          {approving && <span className="review-approve-spinner" aria-hidden="true" />}
          <span>{approving ? t("review.approving") : t("review.approveAll")}</span>
        </button>
      </div>}

      {/* File Preview Modal */}
      {previewFile && (
        <FilePreviewModal
          path={previewFile.path}
          content={previewFile.content}
          knownPaths={state.files.map((file) => file.path)}
          onNavigatePath={(nextPath) => {
            const nextFile = state.files.find((file) => file.path === nextPath || file.path.endsWith(`/${nextPath}`));
            if (nextFile) setPreviewFile({ path: nextFile.path, content: nextFile.content });
          }}
          onClose={() => setPreviewFile(null)}
          t={t}
        />
      )}
    </div>
  );
}

function ReviewFolder({ name, files, draftId, isMaintenanceReview, onFileClick, onReferenceFile, viewedFiles, t }: { name: string; files: ReviewFile[]; draftId?: string; isMaintenanceReview: boolean; onFileClick: (file: ReviewFile) => void; onReferenceFile: (file: ReviewFile) => void; viewedFiles: Set<string>; t: (key: string, params?: Record<string, string>) => string }) {
  const [expanded, setExpanded] = useState(true);
  void viewedFiles;

  return (
    <div className="review-tree-folder">
      <div className="review-tree-folder-row" onClick={() => setExpanded(!expanded)}>
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        <span className="review-tree-foldername">{name}/</span>
        <span className="review-tree-foldercount">{files.length}</span>
        <svg className={`review-tree-chevron${expanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12">
          <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      {expanded && (
        <div className="review-tree-folder-children">
          {files.map((file) => {
            const filename = file.path.split("/").pop() || file.path;
            const referencePath = reviewDraftWorkspacePath(draftId, file.path);
            return (
              <div key={file.path} className="review-tree-file" onClick={() => onFileClick(file)}>
                <svg viewBox="0 0 24 24" width="14" height="14"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M14 2v6h6" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
                <span className="review-tree-filename">{filename}</span>
                {isMaintenanceReview ? (
                  <span className={`review-badge-inline ${file.status === "new" ? "new" : "mod"}`}>{file.status === "new" ? t("review.badgeNew") : t("review.badgeModified")}</span>
                ) : (
                  <button type="button" className="review-tree-ref-btn" aria-label={`Reference ${filename}`} title={`@ ${referencePath}`} onClick={(event) => { event.stopPropagation(); onReferenceFile(file); }}>@</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
