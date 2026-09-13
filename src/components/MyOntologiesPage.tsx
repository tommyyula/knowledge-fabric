import { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArchiveX, Earth, LayoutGrid, List, Plus, Search, Share2, Users } from "lucide-react";
import { Project } from "../mocks/data";
import CustomSelect from "./CustomSelect";
import PermissionDialog from "./PermissionDialog";
import { removeDeletedKnowledgeBasePlaceholder } from "@/services/api/ontology";

interface MyOntologiesPageProps {
  projects: Project[];
  favorites: Set<string>;
  onOpenProject: (project: Project) => void;
  onToggleFavorite: (projectId: string) => void;
  onNewOntology: () => void;
  onDeleteProject: (projectId: string, keepConversationHistory: boolean) => void;
  onEditProject: (projectId: string, updates: { emoji?: string; name?: string; description?: string }) => void;
  t: (key: string, params?: Record<string, string>) => string;
}

type KnowledgeTab = "all" | "active" | "designing";
type KnowledgeViewMode = "grid" | "list";
type KnowledgeSortKey = "recent" | "name";
type SharingTooltip = { label: string; x: number; y: number };

function projectUpdatedTime(project: Project): number {
  const value = project.updatedAt ?? project.lastUpdated;
  const time = value ? Date.parse(value) : 0;
  return Number.isFinite(time) ? time : 0;
}

export default function MyOntologiesPage({ projects, favorites, onOpenProject, onToggleFavorite, onNewOntology, onDeleteProject, onEditProject, t }: MyOntologiesPageProps) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [sharingProject, setSharingProject] = useState<Project | null>(null);
  const [sharingTooltip, setSharingTooltip] = useState<SharingTooltip | null>(null);
  const [keepConversationHistory, setKeepConversationHistory] = useState(true);
  const [deletedSharedProject, setDeletedSharedProject] = useState<Project | null>(null);
  const [deletedSharedStep, setDeletedSharedStep] = useState<"choice" | "history">("choice");
  const [activeTab, setActiveTab] = useState<KnowledgeTab>("all");
  const [viewMode, setViewMode] = useState<KnowledgeViewMode>("grid");
  const [sortKey, setSortKey] = useState<KnowledgeSortKey>("recent");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editEmoji, setEditEmoji] = useState("");
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return [...projects]
      .filter((project) => {
        if (activeTab === "active") return project.status === "active";
        if (activeTab === "designing") return project.status !== "active";
        return true;
      })
      .filter((project) => !query || project.name.toLowerCase().includes(query))
      .sort((a, b) => {
        if (sortKey === "name") return a.name.localeCompare(b.name);
        return projectUpdatedTime(b) - projectUpdatedTime(a) || a.name.localeCompare(b.name);
      });
  }, [activeTab, projects, searchQuery, sortKey]);
  // "我的知识" 不展示被删除的（owner 自己删除且保留历史时后端仍会返回 deletedAt，此处过滤掉）
  const ownedProjects = filteredProjects.filter((project) => (project.accessRole ?? "owner") === "owner" && !project.deletedAt);
  // "与我共享" 才需要展示被删除的占位（deletedAt 非空）；已移除占位但保留历史的（placeholderRemoved=true）不在此区域展示，但 session 仍由侧边栏保留
  const sharedProjects = filteredProjects.filter((project) => (project.accessRole ?? "owner") !== "owner" && !project.placeholderRemoved);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
      }
    };
    if (menuOpenId) {
      document.addEventListener("mousedown", handleClick);
    }
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpenId]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [searchOpen]);

  const handleEditOpen = (p: Project) => {
    setEditingProject(p);
    setEditEmoji(p.emoji);
    setEditName(p.name);
    setEditDesc(p.description);
    setMenuOpenId(null);
  };

  const handleEditSave = () => {
    if (editingProject) {
      onEditProject(editingProject.id, { emoji: editEmoji, name: editName, description: editDesc });
    }
    setEditingProject(null);
  };

  const handleDeleteConfirm = () => {
    if (deletingProject) {
      onDeleteProject(deletingProject.id, keepConversationHistory);
    }
    setDeletingProject(null);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

  const emojiOptions = ["\u{1F6D2}", "\u{1F528}", "\u{1F4DA}", "\u{1F9EA}", "\u{1F680}", "\u{1F4A1}", "\u{1F3AF}", "\u{1F4CA}", "\u{1F527}", "\u{1F310}", "\u{1F4DD}", "\u26A1", "\u{1F3A8}", "\u{1F3D7}", "\u{1F4E6}", "\u{1F52C}"];

  const renderProjectMenu = (p: Project) => {
    const isOwner = (p.accessRole ?? "owner") === "owner";
    const canManageShares = p.capabilities?.manageShares ?? isOwner;
    if (!isOwner && !canManageShares) return null;
    return (
    <div className="ontology-card-menu-wrapper" ref={menuOpenId === p.id ? menuRef : undefined}>
      <button
        className="ontology-card-menu-btn"
        onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === p.id ? null : p.id); }}
        aria-label="More options"
        type="button"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <circle cx="12" cy="5" r="1.5"/>
          <circle cx="12" cy="12" r="1.5"/>
          <circle cx="12" cy="19" r="1.5"/>
        </svg>
      </button>
      {menuOpenId === p.id && (
        <div className="ontology-card-dropdown">
          {canManageShares && <button className="ontology-card-dropdown-item" disabled={p.status !== "active"} onClick={(e) => { e.stopPropagation(); setSharingProject(p); setMenuOpenId(null); }} type="button"><Share2 size={14} />Permission</button>}
          {isOwner && <button className="ontology-card-dropdown-item" onClick={(e) => { e.stopPropagation(); handleEditOpen(p); }} type="button">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            Edit Profile
          </button>}
          {isOwner && <button className="ontology-card-dropdown-item ontology-card-dropdown-danger" onClick={(e) => { e.stopPropagation(); setKeepConversationHistory(true); setDeletingProject(p); setMenuOpenId(null); }} type="button">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
            Delete
          </button>}
        </div>
      )}
    </div>
  );
  };

  const renderFavoriteButton = (p: Project) => (
    <button
      className={`ontology-card-fav${favorites.has(p.id) ? " active" : ""}`}
      onClick={(e) => { e.stopPropagation(); onToggleFavorite(p.id); }}
      aria-label={favorites.has(p.id) ? "Remove from favorites" : "Add to favorites"}
      type="button"
    >
      {favorites.has(p.id) ? (
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      )}
    </button>
  );

  const renderSharingIndicator = (p: Project) => {
    const isOwnerShared = (p.accessRole ?? "owner") === "owner";
    const isRecipient = (p.accessRole ?? "owner") !== "owner";
    if (!isRecipient) return null; // 自有卡片不显示共享图标（如需显示已共享给他人可扩展）
    const roleLabel = p.accessRole === "manager" ? t("permission.role.manager") : p.accessRole === "editor" ? t("permission.role.editor") : t("permission.role.viewer");
    const label = p.ownerDisplayName
      ? `${roleLabel} · 由 ${p.ownerDisplayName} 共享`
      : roleLabel;
    const SharingIcon = isOwnerShared ? Users : Earth;
    return (
      <span
        className="knowledge-sharing-indicator"
        aria-label={label}
        onMouseEnter={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setSharingTooltip({ label, x: rect.left + rect.width / 2, y: rect.top });
        }}
        onMouseLeave={() => setSharingTooltip(null)}
      >
        <SharingIcon size={16} strokeWidth={2} />
      </span>
    );
  };

  const renderProjectCard = (p: Project) => {
    const isShared = (p.accessRole ?? "owner") !== "owner";
    const isDeletedShared = Boolean(p.deletedAt) && isShared;

    return (
          <div
            key={p.id}
            className={`ontology-card${isDeletedShared ? " ontology-card-deleted" : ""}${isShared ? " ontology-card-has-sharing" : ""}`}
            onClick={() => isDeletedShared ? (setDeletedSharedProject(p), setDeletedSharedStep("choice")) : onOpenProject(p)}
          >
            {!isDeletedShared && renderProjectMenu(p)}

            <div className="ontology-card-emoji">{p.emoji}</div>
            <div className="ontology-card-info">
              <span className="ontology-card-name">{p.name}</span>
              {isDeletedShared ? (
                <div className="ontology-card-deleted-row">
                  <span className="ontology-card-deleted-status"><ArchiveX size={13} />{t("knowledge.deletedByOwner")}</span>
                  <span className="ontology-card-deleted-icon"><ArchiveX size={17} /></span>
                </div>
              ) : (
                <>
                  <p className="ontology-card-desc">{p.description}</p>
                  <div className="ontology-card-meta-row">
                    <span className="ontology-card-meta">{p.lastUpdated}</span>
                    {renderFavoriteButton(p)}
                  </div>
                </>
              )}
            </div>
            {!isDeletedShared && renderSharingIndicator(p)}
          </div>
    );
  };

  const renderProjectRow = (p: Project) => {
    const isShared = (p.accessRole ?? "owner") !== "owner";
    const isDeletedShared = Boolean(p.deletedAt) && isShared;
    return (
      <div
        key={p.id}
        className={`ontology-list-row${isDeletedShared ? " ontology-list-row-deleted" : ""}`}
        onClick={() => isDeletedShared ? (setDeletedSharedProject(p), setDeletedSharedStep("choice")) : onOpenProject(p)}
      >
        <div className="ontology-list-emoji">{p.emoji}</div>
        <div className="ontology-list-info">
          <span className="ontology-card-name">{p.name}</span>
          {isDeletedShared
            ? <span className="ontology-list-deleted-status"><ArchiveX size={13} />{t("knowledge.deletedByOwner")}</span>
            : <p className="ontology-card-desc">{p.description}</p>
          }
        </div>
        {!isDeletedShared && <span className="ontology-list-meta">{p.lastUpdated}</span>}
        <div className="ontology-list-actions">
          {isDeletedShared
            ? <ArchiveX size={16} />
            : <>{renderSharingIndicator(p)}{renderFavoriteButton(p)}{renderProjectMenu(p)}</>
          }
        </div>
      </div>
    );
  };

  const renderViewToggle = () => (
    <div className="my-knowledge-view-toggle" role="group" aria-label={t("myOntology.viewMode")}>
      <button
        className={`my-knowledge-view-button${viewMode === "grid" ? " active" : ""}`}
        onClick={() => setViewMode("grid")}
        aria-label={t("myOntology.gridView")}
        aria-pressed={viewMode === "grid"}
        title={t("myOntology.gridView")}
        type="button"
      >
        <LayoutGrid size={18} strokeWidth={2.1} />
      </button>
      <button
        className={`my-knowledge-view-button${viewMode === "list" ? " active" : ""}`}
        onClick={() => setViewMode("list")}
        aria-label={t("myOntology.listView")}
        aria-pressed={viewMode === "list"}
        title={t("myOntology.listView")}
        type="button"
      >
        <List size={19} strokeWidth={2.2} />
      </button>
    </div>
  );

  return (
    <div className="my-ontologies-page">
      <div className="my-ontologies-header">
        <h1>{t("myOntology.title")}</h1>
      </div>
      <div className={`my-knowledge-toolbar${searchOpen ? " search-open" : ""}`}>
        {searchOpen ? (
          <div className="my-knowledge-search-layer">
            <div className="my-knowledge-search-field">
              <Search size={20} strokeWidth={2.2} />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeSearch();
                }}
                placeholder={t("myOntology.searchPlaceholder")}
              />
            </div>
            <button className="my-knowledge-search-cancel" onClick={closeSearch} type="button">
              {t("common.cancel")}
            </button>
            {renderViewToggle()}
          </div>
        ) : (
          <>
            <div className="my-knowledge-tabs" aria-label={t("myOntology.tabs")}>
              <button
                className={`my-knowledge-tab${activeTab === "all" ? " active" : ""}`}
                onClick={() => setActiveTab("all")}
                type="button"
              >
                {t("myOntology.tabAll")}
              </button>
              <button
                className={`my-knowledge-tab${activeTab === "active" ? " active" : ""}`}
                onClick={() => setActiveTab("active")}
                type="button"
              >
                {t("myOntology.tabActive")}
              </button>
              <button
                className={`my-knowledge-tab${activeTab === "designing" ? " active" : ""}`}
                onClick={() => setActiveTab("designing")}
                type="button"
              >
                {t("myOntology.tabDesigning")}
              </button>
            </div>
            <div className="my-knowledge-actions">
              <button className="my-knowledge-icon-circle" onClick={() => setSearchOpen(true)} aria-label={t("common.search")} type="button">
                <Search size={19} strokeWidth={2.25} />
              </button>
              {renderViewToggle()}
              <CustomSelect
                value={sortKey}
                options={[
                  { value: "recent", label: t("myOntology.sortRecent") },
                  { value: "name", label: t("myOntology.sortName") },
                ]}
                onChange={(value) => setSortKey(value as KnowledgeSortKey)}
                className="my-knowledge-sort-select"
              />
              <button className="my-knowledge-create" onClick={onNewOntology} type="button">
                <Plus size={18} strokeWidth={2.2} />
                <span>{t("myOntology.createNew")}</span>
              </button>
            </div>
          </>
        )}
      </div>
      <div className="knowledge-collection">
      <section><div className="knowledge-collection-heading"><h2>{t("myOntology.createdByMe")}</h2><span>{ownedProjects.length} {t("myOntology.createdByMeDesc")}</span></div>{viewMode === "grid" ? (
        <div className="my-ontologies-grid">
          {!searchQuery.trim() && (
            <div className="ontology-card ontology-card-new" onClick={onNewOntology}>
              <div className="ontology-card-new-icon">
                <Plus size={24} strokeWidth={2.2} />
              </div>
              <span className="ontology-card-name">{t("myOntology.createCard")}</span>
            </div>
          )}
          {ownedProjects.map(renderProjectCard)}
          {searchQuery.trim() && ownedProjects.length === 0 && (
            <div className="my-ontologies-empty">{t("myOntology.noSearchResults")}</div>
          )}
        </div>
      ) : (
        <div className="my-ontologies-list">
          {ownedProjects.map(renderProjectRow)}
          {searchQuery.trim() && ownedProjects.length === 0 && (
            <div className="my-ontologies-empty">{t("myOntology.noSearchResults")}</div>
          )}
        </div>
      )}</section>
      {sharedProjects.length > 0 && <section><div className="knowledge-collection-heading"><h2>{t("myOntology.sharedWithMe")}</h2><span>{t("myOntology.sharedWithMeDesc")}</span></div>{viewMode === "grid" ? <div className="my-ontologies-grid">{sharedProjects.map(renderProjectCard)}</div> : <div className="my-ontologies-list">{sharedProjects.map(renderProjectRow)}</div>}</section>}
      </div>

      {/* Edit Profile Modal */}
      {editingProject && (
        <div className="modal-overlay" onClick={() => setEditingProject(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Edit Profile</h2>
            <p className="modal-subtitle">Update the icon, name and description for this knowledge.</p>

            <label className="modal-label">Icon</label>
            <div className="emoji-picker">
              {emojiOptions.map((em) => (
                <button
                  key={em}
                  className={`emoji-option${editEmoji === em ? " selected" : ""}`}
                  onClick={() => setEditEmoji(em)}
                  type="button"
                >
                  {em}
                </button>
              ))}
            </div>

            <label className="modal-label">Name</label>
            <input
              className="modal-input"
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              maxLength={40}
            />

            <label className="modal-label">Short Description</label>
            <textarea
              className="modal-textarea"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              rows={3}
              maxLength={120}
            />

            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setEditingProject(null)}>Cancel</button>
              <button className="modal-btn modal-btn-primary" onClick={handleEditSave}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingProject && (
        <div className="modal-overlay" onClick={() => setDeletingProject(null)}>
          <div className="modal-dialog knowledge-delete-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="knowledge-delete-heading">
              <span><AlertTriangle size={20} /></span>
              <div>
                <h2>{t("knowledge.deleteTitle")}</h2>
                <p>{t("knowledge.deleteBody", { name: `${deletingProject.emoji} ${deletingProject.name}` })}</p>
              </div>
            </div>
            <div className="knowledge-delete-impact">
              <strong>{t("knowledge.deleteImpactTitle")}</strong>
              <ul>
                <li>{t("knowledge.deleteImpactAccess")}</li>
                <li>{t("knowledge.deleteImpactWrites")}</li>
                <li>{t("knowledge.deleteImpactResources")}</li>
              </ul>
              <small>{t("knowledge.deleteConfirm")}</small>
            </div>
            <label className="knowledge-delete-history-choice">
              <input type="checkbox" checked={keepConversationHistory} onChange={(event) => setKeepConversationHistory(event.target.checked)} />
              <span><strong>{t("knowledge.keepOwnHistory")}</strong><small>{t("knowledge.keepOwnHistoryHint")}</small></span>
            </label>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setDeletingProject(null)} type="button">{t("common.cancel")}</button>
              <button className="modal-btn modal-btn-danger" onClick={handleDeleteConfirm} type="button">{t("common.delete")}</button>
            </div>
          </div>
        </div>
      )}

      {sharingProject && <PermissionDialog project={sharingProject} onClose={() => setSharingProject(null)} t={t} />}
      {deletedSharedProject && (
        <div className="modal-overlay" onClick={() => setDeletedSharedProject(null)}>
          <div className="modal-dialog knowledge-delete-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="knowledge-delete-heading">
              <span><AlertTriangle size={20} /></span>
              <div>
                <h2>{t("knowledge.deletedTitle")}</h2>
                <p>{t("knowledge.deletedDesc")}</p>
              </div>
            </div>
            {deletedSharedStep === "choice" ? (
              <>
                <label className="knowledge-delete-history-choice" onClick={() => { void removeDeletedKnowledgeBasePlaceholder(deletedSharedProject.id, true, false).then(() => window.location.reload()); }}>
                  <span>
                    <strong>{t("knowledge.keepRecord")}</strong>
                    <small>{t("knowledge.keepRecordHint")}</small>
                  </span>
                </label>
                <label className="knowledge-delete-history-choice" onClick={() => setDeletedSharedStep("history")}>
                  <span>
                    <strong>{t("knowledge.removeRecord")}</strong>
                    <small>{t("knowledge.removeRecordHint")}</small>
                  </span>
                </label>
                <div className="modal-actions">
                  <button className="modal-btn modal-btn-cancel" onClick={() => setDeletedSharedProject(null)} type="button">{t("common.cancel")}</button>
                </div>
              </>
            ) : (
              <>
                <div className="knowledge-delete-impact">
                  <strong>{t("knowledge.chooseHistoryTitle")}</strong>
                  <small>{t("knowledge.chooseHistoryDesc")}</small>
                </div>
                <div className="modal-actions">
                  <button className="modal-btn modal-btn-cancel" onClick={() => setDeletedSharedStep("choice")} type="button">{t("common.back")}</button>
                  <button className="modal-btn modal-btn-cancel" onClick={() => { void removeDeletedKnowledgeBasePlaceholder(deletedSharedProject.id, true).then(() => window.location.reload()); }} type="button">{t("knowledge.keepHistory")}</button>
                  <button className="modal-btn modal-btn-danger" onClick={() => { void removeDeletedKnowledgeBasePlaceholder(deletedSharedProject.id, false).then(() => window.location.reload()); }} type="button">{t("knowledge.deleteHistory")}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {sharingTooltip && createPortal(
        <div className="knowledge-sharing-tooltip" role="tooltip" style={{ left: sharingTooltip.x, top: sharingTooltip.y }}>
          {sharingTooltip.label}
        </div>,
        document.body,
      )}

    </div>
  );
}
