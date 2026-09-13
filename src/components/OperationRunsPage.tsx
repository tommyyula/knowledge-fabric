import { useState } from "react";
import type { OperationRun } from "@/contracts/ontology";
import { useOperationRuns } from "@/hooks/useOperations";
import type { Project } from "@/mocks/data";
import CustomSelect from "@/components/CustomSelect";
import OperationRunList from "@/components/OperationRunList";
import OperationRunPagination from "@/components/OperationRunPagination";

interface OperationRunsPageProps {
  projects: Project[];
  onSelectRun: (run: OperationRun) => void;
  t: (key: string, params?: Record<string, string>) => string;
}

export default function OperationRunsPage({ projects, onSelectRun, t }: OperationRunsPageProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [ontologyId, setOntologyId] = useState("");
  const runsQuery = useOperationRuns({ ontologyId: ontologyId || undefined, search });
  const runs = runsQuery.data ?? [];

  const knowledgeBaseFilter = (
    <CustomSelect
      value={ontologyId || "all"}
      options={[
        { value: "all", label: t("operations.allKnowledgeBases") },
        ...projects.map((project) => ({ value: project.id, label: project.name })),
      ]}
      onChange={(value) => setOntologyId(value === "all" ? "" : value)}
    />
  );

  return (
    <section className="operation-runs-page">
      <div className="operation-runs-main">
        <header className="operation-runs-header">
          <h1>{t("operations.title")}</h1>
        </header>
        <div className={`operation-runs-toolbar rl-toolbar rl-toolbar-filters${searchOpen ? " search-open" : ""}`}>
          {searchOpen ? (
            <div className="search-expansion-layer rl-search-layer">
              <div className="search-expansion-field rl-search-field">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
                  <path d="M21 21l-4.35-4.35" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("operations.searchPlaceholder")}
                  autoFocus
                />
              </div>
              <button
                className="search-expansion-cancel rl-search-cancel"
                type="button"
                onClick={() => {
                  setSearchOpen(false);
                  setSearch("");
                }}
              >
                {t("common.cancel")}
              </button>
              <div className="rl-toolbar-right rl-search-layer-actions">{knowledgeBaseFilter}</div>
            </div>
          ) : (
            <>
              <div className="rl-toolbar-left">
                <button
                  className="rl-toolbar-icon-btn"
                  type="button"
                  onClick={() => setSearchOpen(true)}
                  aria-label={t("operations.search")}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
                    <path d="M21 21l-4.35-4.35" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <div className="rl-toolbar-right">{knowledgeBaseFilter}</div>
            </>
          )}
        </div>
        <OperationRunList
          runs={runs}
          projects={projects}
          loading={runsQuery.isLoading}
          error={runsQuery.isError && !runs.length}
          emptyTitle={search.trim() ? t("operations.noSearchResults") : undefined}
          emptyBody={search.trim() ? t("operations.tryAnotherSearch") : undefined}
          onSelectRun={onSelectRun}
          t={t}
        />
        <OperationRunPagination
          hasItems={runs.length > 0}
          hasNextPage={runsQuery.hasNextPage}
          loadFailed={runsQuery.isFetchNextPageError}
          loading={runsQuery.isFetchingNextPage}
          onLoadMore={() => void runsQuery.fetchNextPage()}
          t={t}
        />
      </div>
    </section>
  );
}
