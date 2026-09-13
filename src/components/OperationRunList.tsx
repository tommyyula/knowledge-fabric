import { useState } from "react";
import type { OperationRun } from "@/contracts/ontology";
import { operationRunStatusKey, operationRunTitle } from "@/lib/operation-runs";

interface OperationProject {
  id: string;
  name: string;
  emoji?: string;
}

interface OperationRunListProps {
  runs: OperationRun[];
  projects?: readonly OperationProject[];
  loading?: boolean;
  error?: boolean;
  compact?: boolean;
  emptyTitle?: string;
  emptyBody?: string;
  onSelectRun: (run: OperationRun) => void;
  onRenameRun?: (run: OperationRun, title: string) => void;
  onDeleteRun?: (run: OperationRun) => void;
  t: (key: string, params?: Record<string, string>) => string;
}

function formatFullRunTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatContextualRunTime(
  value: string,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;

  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const minute = 60 * 1_000;
  const day = 24 * 60 * minute;

  if (diffMs < minute) return t("common.justNow");
  if (diffMs < day) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diffMs < 2 * day) return t("common.yesterday");

  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return date.toLocaleDateString([], options);
}

export default function OperationRunList({
  runs,
  projects = [],
  loading = false,
  error = false,
  compact = false,
  emptyTitle,
  emptyBody,
  onSelectRun,
  onRenameRun,
  onDeleteRun,
  t,
}: OperationRunListProps) {
  const [menuRunId, setMenuRunId] = useState<string | null>(null);
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const projectById = new Map(projects.map((project) => [project.id, project]));

  if (loading) {
    return (
      <div className="operation-list-state" role="status">
        <span>{t("operations.loading")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="operation-list-state operation-list-state-error" role="alert">
        <strong>{t("operations.unavailableTitle")}</strong>
        <span>{t("operations.unavailableBody")}</span>
      </div>
    );
  }

  if (!runs.length) {
    return (
      <div className="operation-list-state">
        <strong>{emptyTitle ?? t("operations.emptyTitle")}</strong>
        <span>{emptyBody ?? t("operations.emptyBody")}</span>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="operation-run-list compact">
        {runs.map((run) => {
          const editing = editingRunId === run.id;
          return (
            <div
              key={run.id}
              className="operation-run-row operation-run-row-compact chat-hub-item"
              onClick={() => { if (!editing) onSelectRun(run); }}
            >
              <span className="chat-hub-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path d="M3 17V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="m8 9 3 3-3 3m5 0h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              {editing ? (
                <input
                  className="chat-hub-item-title"
                  style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "2px 6px", outline: "none" }}
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.currentTarget.value)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={() => {
                    const next = renameDraft.trim();
                    if (next && next !== operationRunTitle(run)) onRenameRun?.(run, next);
                    setEditingRunId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                    if (event.key === "Escape") setEditingRunId(null);
                  }}
                  autoFocus
                />
              ) : (
                <span className="chat-hub-item-title">{operationRunTitle(run)}</span>
              )}
              <time className="chat-hub-item-time" dateTime={run.startedAt}>
                {formatContextualRunTime(run.startedAt, t)}
              </time>
              {!editing && (onRenameRun || onDeleteRun) ? (
                <div className="chat-hub-item-actions">
                  <button
                    type="button"
                    className="chat-hub-item-more"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuRunId(menuRunId === run.id ? null : run.id);
                    }}
                    aria-label="More options"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                      <circle cx="5" cy="12" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="19" cy="12" r="1.5" />
                    </svg>
                  </button>
                </div>
              ) : null}
              {menuRunId === run.id ? (
                <>
                  <div className="chat-hub-menu-backdrop" onClick={(event) => { event.stopPropagation(); setMenuRunId(null); }} />
                  <div className="chat-hub-menu">
                    <button type="button" className="chat-hub-menu-item" onClick={(event) => {
                      event.stopPropagation();
                      setMenuRunId(null);
                      setRenameDraft(operationRunTitle(run));
                      setEditingRunId(run.id);
                    }}>
                      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      <span>{t("common.rename")}</span>
                    </button>
                    <div className="chat-hub-menu-divider" />
                    <button
                      type="button"
                      className="chat-hub-menu-item chat-hub-menu-item-danger"
                      disabled={run.status === "running"}
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuRunId(null);
                        onDeleteRun?.(run);
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 6h18M8 6V4h8v2M5 6v14a2 2 0 002 2h10a2 2 0 002-2V6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      <span>{t("common.delete")}</span>
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="operation-run-list">
      <div className="operation-run-list-header" aria-hidden="true">
        <span className="operation-run-th-task">{t("operations.task")}</span>
        <span className="operation-run-th-project">{t("operations.knowledgeBase")}</span>
        <span className="operation-run-th-started">{t("operations.startedAt")}</span>
        <span className="operation-run-th-artifacts">{t("operations.artifacts")}</span>
      </div>
      {runs.map((run) => {
        const project = projectById.get(run.ontologyId);
        return (
          <button
            key={run.id}
            type="button"
            className="operation-run-row"
            onClick={() => onSelectRun(run)}
          >
            <span className="operation-run-copy">
              <span className="operation-run-title">{operationRunTitle(run)}</span>
              <span className={`operation-run-status operation-run-status-${run.status}`}>
                {t(operationRunStatusKey(run))}
              </span>
            </span>
            <span className="operation-run-field operation-run-project">{project?.name ?? "-"}</span>
            <time className="operation-run-field operation-run-started" dateTime={run.startedAt}>
              {formatFullRunTime(run.startedAt)}
            </time>
            <span className="operation-run-field operation-run-artifacts">
              {run.artifacts.length
                ? t("operations.artifactCount", { count: String(run.artifacts.length) })
                : "-"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
