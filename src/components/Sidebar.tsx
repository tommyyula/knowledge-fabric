import { useEffect, useRef, useState, type RefObject } from "react";
import { Session, Project } from "../mocks/data";
import { Locale } from "../i18n";
import { devTenantId, isIamAuthEnabled } from "@/lib/iam";
import { persistAuthToken, refreshTokenFromStorage } from "@/lib/auth-token";
import { ensureFreshAccessToken } from "@/lib/api-client";
import { clearTenantScopedClientState } from "@/lib/tenant-switch";
import { redirectToLogin, redirectToLogout } from "@/services/auth";
import { refreshIamToken, switchIamTenant } from "@/services/api/auth";
import { useUserStore } from "@/stores/useUserStore";
import ConfirmDialog from "./ConfirmDialog";

interface SidebarProps {
  projects: Project[];
  sessions: Session[];
  currentSessionId: string | null;
  currentProject: Project | null;
  collapsed: boolean;
  favorites: Set<string>;
  runningSessionIds?: Set<string>;
  unreadSessionIds?: Set<string>;
  onToggleCollapse: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectProject: (project: Project) => void;
  onNewChat: () => void;
  onViewAllOntologies: () => void;
  onViewResourceLibrary: () => void;
  onViewOperationRuns: () => void;
  onViewAdminData: () => void;
  onToggleFavorite: (projectId: string) => void;
  onRenameSession: (sessionId: string, newName: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onShareSession?: (session: Session) => void;
  onOpenConnectors?: () => void;
  theme: string;
  onToggleTheme: () => void;
  locale: Locale;
  onChangeLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string>) => string;
}

type SessionSidebarStatus = "running" | "unread" | null;

function getSessionSidebarStatus(sessionId: string, runningSessionIds?: Set<string>, unreadSessionIds?: Set<string>): SessionSidebarStatus {
  if (runningSessionIds?.has(sessionId)) return "running";
  if (unreadSessionIds?.has(sessionId)) return "unread";
  return null;
}

function SessionStatusIndicator({ status, label }: { status: Exclude<SessionSidebarStatus, null>; label: string }) {
  return (
    <span className={`sidebar-session-status sidebar-session-status-${status}`} aria-label={label} title={label}>
      <span className={status === "running" ? "sidebar-session-spinner" : "sidebar-session-unread-dot"} />
    </span>
  );
}

function OntologyGroup({ projectName, sessions, currentSessionId, runningSessionIds, unreadSessionIds, onSelectSession, t, sessionMenuId, setSessionMenuId, sessionMenuPos, setSessionMenuPos, editingSessionId, renameDraft, setRenameDraft, renameInputRef, startRenamingSession, cancelRenamingSession, commitRenamingSession, setDeletingSession, onShareSession }: {
  projectName: string;
  sessions: Session[];
  currentSessionId: string | null;
  runningSessionIds?: Set<string>;
  unreadSessionIds?: Set<string>;
  onSelectSession: (id: string) => void;
  t: (key: string, params?: Record<string, string>) => string;
  sessionMenuId: string | null;
  setSessionMenuId: (id: string | null) => void;
  sessionMenuPos: { top: number; left: number };
  setSessionMenuPos: (pos: { top: number; left: number }) => void;
  editingSessionId: string | null;
  renameDraft: string;
  setRenameDraft: (value: string) => void;
  renameInputRef: RefObject<HTMLInputElement | null>;
  startRenamingSession: (session: Session) => void;
  cancelRenamingSession: () => void;
  commitRenamingSession: (session: Session) => void;
  setDeletingSession: (session: Session | null) => void;
  onShareSession?: (session: Session) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="sidebar-group">
      <div className="sidebar-group-label" onClick={() => setExpanded(!expanded)}>
        <span className="sidebar-group-icon" aria-hidden="true">📁</span>
        <span className="sidebar-group-name">{projectName}</span>
        <svg className={`sidebar-group-chevron${expanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </div>
      {expanded && sessions.map((s) => {
        const status = getSessionSidebarStatus(s.id, runningSessionIds, unreadSessionIds);
        return (
          <div
            key={s.id}
            className={`sidebar-item sidebar-recent-item${currentSessionId === s.id ? " active" : ""}${status ? " has-session-status" : ""}`}
            onClick={() => {
              if (editingSessionId !== s.id) onSelectSession(s.id);
            }}
          >
            <div className="sidebar-recent-content">
              {editingSessionId === s.id ? (
                <input
                  ref={renameInputRef}
                  className="sidebar-recent-rename-input"
                  value={renameDraft}
                  aria-label={t("common.rename")}
                  onChange={(event) => setRenameDraft(event.currentTarget.value)}
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onBlur={() => commitRenamingSession(s)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRenamingSession(s);
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRenamingSession();
                    }
                  }}
                />
              ) : (
                <span className="sidebar-recent-title">{s.preview}</span>
              )}
              <span className="sidebar-recent-meta">
                <span className="sidebar-recent-project" />
                <span className="sidebar-recent-time">{s.timeAgo}</span>
              </span>
            </div>
            {status && editingSessionId !== s.id && (
              <SessionStatusIndicator
                status={status}
                label={status === "running" ? t("sidebar.sessionRunning") : t("sidebar.sessionUnread")}
              />
            )}
            {editingSessionId !== s.id && (
              <button
                className="sidebar-session-more"
                onClick={(e) => {
                  e.stopPropagation();
                  if (sessionMenuId === s.id) {
                    setSessionMenuId(null);
                  } else {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setSessionMenuPos({ top: rect.bottom + 4, left: rect.right - 120 });
                    setSessionMenuId(s.id);
                  }
                }}
                aria-label="More options"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <circle cx="5" cy="12" r="1.5"/>
                  <circle cx="12" cy="12" r="1.5"/>
                  <circle cx="19" cy="12" r="1.5"/>
                </svg>
              </button>
            )}
            {sessionMenuId === s.id && (
              <>
                <div className="sidebar-menu-backdrop" onClick={(e) => { e.stopPropagation(); setSessionMenuId(null); }} />
                <div className="sidebar-session-menu" style={{ top: sessionMenuPos.top, left: sessionMenuPos.left }}>
                  {onShareSession && (
                    <button className="sidebar-session-menu-item" onClick={(e) => {
                      e.stopPropagation();
                      setSessionMenuId(null);
                      onShareSession(s);
                    }}>
                      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 12v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8M16 6l-4-4-4 4M12 2v13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      <span>{t("session.share")}</span>
                    </button>
                  )}
                  <button className="sidebar-session-menu-item" onClick={(e) => {
                    e.stopPropagation();
                    startRenamingSession(s);
                  }}>
                    <svg viewBox="0 0 24 24" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    <span>{t("common.rename")}</span>
                  </button>
                  <button className="sidebar-session-menu-item sidebar-session-menu-danger" onClick={(e) => {
                    e.stopPropagation();
                    setSessionMenuId(null);
                    setDeletingSession(s);
                  }}>
                    <svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 6h18M8 6V4h8v2M5 6v14a2 2 0 002 2h10a2 2 0 002-2V6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    <span>{t("common.delete")}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Sidebar({
  projects,
  sessions,
  currentSessionId,
  currentProject,
  collapsed,
  favorites,
  runningSessionIds,
  unreadSessionIds,
  onToggleCollapse,
  onSelectSession,
  onSelectProject,
  onNewChat,
  onViewAllOntologies,
  onViewResourceLibrary,
  onViewOperationRuns,
  onViewAdminData,
  onToggleFavorite,
  onRenameSession,
  onDeleteSession,
  onOpenConnectors,
  onShareSession,
  theme,
  onToggleTheme,
  locale,
  onChangeLocale,
  t,
}: SidebarProps) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userInfo = useUserStore((s) => s.userInfo);
  const isAdmin = userInfo?.isAdmin === true;
  const token = useUserStore((s) => s.tokenobj?.accessToken) ?? localStorage.getItem("access_token");
  const iamEnabled = isIamAuthEnabled();
  const [favoritesExpanded, setFavoritesExpanded] = useState(true);
  const [activityExpanded, setActivityExpanded] = useState(true);
  const [activityGroup, setActivityGroup] = useState<"time" | "ontology">("time");
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [groupMenuPos, setGroupMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const groupMenuBtnRef = useRef<HTMLButtonElement>(null);
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [sessionMenuPos, setSessionMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [deletingSession, setDeletingSession] = useState<Session | null>(null);
  const [langExpanded, setLangExpanded] = useState(false);
  const [tenantExpanded, setTenantExpanded] = useState(false);
  const [switchingTenantId, setSwitchingTenantId] = useState<string | null>(null);
  const [tenantSwitchError, setTenantSwitchError] = useState<string | null>(null);
  const visibleSessions = sessions.filter((session) => session.origin !== "external");

  useEffect(() => {
    if (!editingSessionId) return;
    const input = renameInputRef.current;
    input?.focus();
    input?.select();
  }, [editingSessionId]);

  const startRenamingSession = (session: Session) => {
    setSessionMenuId(null);
    setEditingSessionId(session.id);
    setRenameDraft(session.preview);
  };

  const cancelRenamingSession = () => {
    setEditingSessionId(null);
    setRenameDraft("");
  };

  const commitRenamingSession = (session: Session) => {
    const nextName = renameDraft.trim();
    cancelRenamingSession();
    if (nextName && nextName !== session.preview) onRenameSession(session.id, nextName);
  };

  const languages = [
    { id: "zh" as Locale, label: "中文", flag: "🇨🇳" },
    { id: "ja" as Locale, label: "日本語", flag: "🇯🇵" },
    { id: "en" as Locale, label: "English", flag: "🇺🇸" },
  ];

  const companyNames = new Map<string, string>(
    (userInfo?.companies ?? []).map((company) => [company.companyCode, company.companyName] as const),
  );
  const tenants = (userInfo?.tenants?.length ? userInfo.tenants : iamEnabled ? [] : [devTenantId]).map((id) => ({
    id,
    name: companyNames.get(id) ?? id,
  }));
  const currentTenant = userInfo?.tenantId ?? (iamEnabled ? "" : devTenantId);
  const displayName = userInfo?.name || userInfo?.userName || (iamEnabled ? "IAM user" : "Development User");
  const userName = userInfo?.userName || userInfo?.userId || (iamEnabled ? "Sign in required" : "dev-user");
  const authInitial = (displayName || userName || "U").trim().charAt(0).toUpperCase();

  const switchTenant = async (tenantId: string) => {
    if (!userInfo || tenantId === currentTenant || switchingTenantId) {
      setTenantExpanded(false);
      return;
    }
    setSwitchingTenantId(tenantId);
    setTenantSwitchError(null);
    try {
      await ensureFreshAccessToken();
      await switchIamTenant(tenantId);
      const refreshedToken = await refreshIamToken(refreshTokenFromStorage());
      persistAuthToken(refreshedToken);
      useUserStore.getState().clearUserInfo();
      clearTenantScopedClientState();
      window.location.reload();
    } catch (error) {
      setTenantSwitchError(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingTenantId(null);
    }
  };

  // Show projects that are in favorites set
  const favoriteProjects = projects.filter((p) => favorites.has(p.id));

  if (collapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <button className="sidebar-expand-btn" onClick={onToggleCollapse} aria-label="Expand sidebar">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 12h18M3 6h18M3 18h18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        </button>
        <div className="sidebar-collapsed-nav">
          <button className="sidebar-collapsed-btn" onClick={onNewChat} aria-label="New Chat">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
          <button className="sidebar-collapsed-btn" onClick={onViewAllOntologies} aria-label="My Ontology">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17h1.5"/><path d="M12 22h1.5"/><path d="M12 2h1.5"/><path d="M17.5 22H19a1 1 0 000-1"/><path d="M17.5 2H19a1 1 0 011 1v1.5"/><path d="M20 14v3h-2.5"/><path d="M20 8.5V10"/><path d="M4 10V8.5"/><path d="M4 19.5V14"/><path d="M4 4.5A2.5 2.5 0 016.5 2H8"/><path d="M8 22H6.5a1 1 0 010-5H8"/></svg>
          </button>
          <button className="sidebar-collapsed-btn" onClick={onViewResourceLibrary} aria-label="Resource Library">
            <svg viewBox="0 0 24 24" width="18" height="18"><rect width="20" height="5" x="2" y="3" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 8v11a2 2 0 002 2h2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M20 8v11a2 2 0 01-2 2h-2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M9 15l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M12 12v9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button className="sidebar-collapsed-btn" onClick={onViewOperationRuns} aria-label={t("sidebar.operationRuns")}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
          </button>
          {isAdmin && (
            <button className="sidebar-collapsed-btn" onClick={onViewAdminData} aria-label={t("sidebar.adminData")}>
              <svg viewBox="0 0 24 24" width="18" height="18"><ellipse cx="12" cy="5" rx="8" ry="3" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
            </button>
          )}
        </div>
        <div className="sidebar-collapsed-footer">
          <div className="sidebar-avatar">{authInitial}</div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      {/* Header with title and collapse */}
      <div className="sidebar-title-bar">
        <span className="sidebar-title">{t("sidebar.title")}</span>
        <button className="sidebar-collapse-btn" onClick={onToggleCollapse} aria-label="Collapse sidebar">
          <svg viewBox="0 0 24 24" width="16" height="16"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M9 3v18" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
        </button>
      </div>
      <nav className="sidebar-nav">
        <div className="sidebar-nav-item" onClick={onNewChat}>
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          <span>{t("sidebar.newChat")}</span>
        </div>
        <div className="sidebar-nav-item" onClick={onViewAllOntologies}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17h1.5"/><path d="M12 22h1.5"/><path d="M12 2h1.5"/><path d="M17.5 22H19a1 1 0 000-1"/><path d="M17.5 2H19a1 1 0 011 1v1.5"/><path d="M20 14v3h-2.5"/><path d="M20 8.5V10"/><path d="M4 10V8.5"/><path d="M4 19.5V14"/><path d="M4 4.5A2.5 2.5 0 016.5 2H8"/><path d="M8 22H6.5a1 1 0 010-5H8"/></svg>
          <span>{t("sidebar.myOntology")}</span>
        </div>
        <div className="sidebar-nav-item" onClick={onViewResourceLibrary}>
          <svg viewBox="0 0 24 24" width="16" height="16"><rect width="20" height="5" x="2" y="3" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 8v11a2 2 0 002 2h2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M20 8v11a2 2 0 01-2 2h-2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M9 15l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M12 12v9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span>{t("sidebar.resourceLibrary")}</span>
        </div>
        <div className="sidebar-nav-item" onClick={onViewOperationRuns}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
          <span>{t("sidebar.operationRuns")}</span>
        </div>
        {isAdmin && (
          <div className="sidebar-nav-item" onClick={onViewAdminData}>
            <svg viewBox="0 0 24 24" width="16" height="16"><ellipse cx="12" cy="5" rx="8" ry="3" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
            <span>{t("sidebar.adminData")}</span>
          </div>
        )}
      </nav>

      {/* My Favorites */}
      <div className="sidebar-section">
        <div className="sidebar-section-label" onClick={() => setFavoritesExpanded(!favoritesExpanded)}>
          <span>
            {t("sidebar.myFavorites")}
            <svg className={`sidebar-chevron${favoritesExpanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </span>
        </div>
        {favoritesExpanded && (
          <div className="sidebar-list">
            {favoriteProjects.map((p) => (
              <div
                key={p.id}
                className={`sidebar-item sidebar-onto-item${currentProject?.id === p.id ? " active" : ""}`}
                onClick={() => onSelectProject(p)}
              >
                <span className="sidebar-onto-emoji">{p.emoji}</span>
                <span className="sidebar-onto-name">{p.name}</span>
                <button
                  className="sidebar-fav-remove"
                  onClick={(e) => { e.stopPropagation(); onToggleFavorite(p.id); }}
                  aria-label="Remove from favorites"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Activity */}
      <div className="sidebar-section sidebar-recents">
        <div className="sidebar-section-label">
          <span onClick={() => setActivityExpanded(!activityExpanded)}>
            {activityGroup === "time" ? t("sidebar.recentActivity") : t("sidebar.ontology")}
            <svg className={`sidebar-chevron${activityExpanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </span>
          <div className="sidebar-section-menu-wrapper">
            <button
              className="sidebar-section-toggle"
              ref={groupMenuBtnRef}
              onClick={() => {
                if (!showGroupMenu && groupMenuBtnRef.current) {
                  const rect = groupMenuBtnRef.current.getBoundingClientRect();
                  setGroupMenuPos({ top: rect.bottom + 4, left: rect.right - 150 });
                }
                setShowGroupMenu(!showGroupMenu);
              }}
              aria-label="Organize chats"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <circle cx="5" cy="12" r="1.5"/>
                <circle cx="12" cy="12" r="1.5"/>
                <circle cx="19" cy="12" r="1.5"/>
              </svg>
            </button>
            {showGroupMenu && (
              <>
                <div className="sidebar-menu-backdrop" onClick={() => setShowGroupMenu(false)} />
                <div className="sidebar-group-menu" style={{ top: groupMenuPos.top, left: groupMenuPos.left }}>
                  <div className="sidebar-group-menu-title">{t("sidebar.organize")}</div>
                  <button
                    className={`sidebar-group-menu-item${activityGroup === "time" ? " active" : ""}`}
                    onClick={() => { setActivityGroup("time"); setShowGroupMenu(false); }}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    <span>{t("sidebar.byTime")}</span>
                    {activityGroup === "time" && <span className="sidebar-group-menu-check">&#10003;</span>}
                  </button>
                  <button
                    className={`sidebar-group-menu-item${activityGroup === "ontology" ? " active" : ""}`}
                    onClick={() => { setActivityGroup("ontology"); setShowGroupMenu(false); }}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    <span>{t("sidebar.byOntology")}</span>
                    {activityGroup === "ontology" && <span className="sidebar-group-menu-check">&#10003;</span>}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        {activityExpanded && activityGroup === "time" && (
          <div className="sidebar-list">
            {visibleSessions.length === 0 && (
              <div className="sidebar-empty">{t("common.noActivity")}</div>
            )}
            {visibleSessions.map((s) => {
              const status = getSessionSidebarStatus(s.id, runningSessionIds, unreadSessionIds);
              return (
                <div
                  key={s.id}
                  className={`sidebar-item sidebar-recent-item${currentSessionId === s.id ? " active" : ""}${status ? " has-session-status" : ""}`}
                  onClick={() => {
                    if (editingSessionId !== s.id) onSelectSession(s.id);
                  }}
                >
                  <div className="sidebar-recent-content">
                    {editingSessionId === s.id ? (
                      <input
                        ref={renameInputRef}
                        className="sidebar-recent-rename-input"
                        value={renameDraft}
                        aria-label="Rename conversation"
                        onChange={(event) => setRenameDraft(event.currentTarget.value)}
                        onClick={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                        onBlur={() => commitRenamingSession(s)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitRenamingSession(s);
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            cancelRenamingSession();
                          }
                        }}
                      />
                    ) : (
                      <span className="sidebar-recent-title">{s.preview}</span>
                    )}
                    <span className="sidebar-recent-meta">
                      <span className="sidebar-recent-project">{s.projectName}</span>
                      <span className="sidebar-recent-time">{s.timeAgo}</span>
                    </span>
                  </div>
                  {status && editingSessionId !== s.id && (
                    <SessionStatusIndicator
                      status={status}
                      label={status === "running" ? t("sidebar.sessionRunning") : t("sidebar.sessionUnread")}
                    />
                  )}
                  {editingSessionId !== s.id && (
                    <button
                      className="sidebar-session-more"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (sessionMenuId === s.id) {
                          setSessionMenuId(null);
                        } else {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setSessionMenuPos({ top: rect.bottom + 4, left: rect.right - 120 });
                          setSessionMenuId(s.id);
                        }
                      }}
                      aria-label="More options"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                        <circle cx="5" cy="12" r="1.5"/>
                        <circle cx="12" cy="12" r="1.5"/>
                        <circle cx="19" cy="12" r="1.5"/>
                      </svg>
                    </button>
                  )}
                  {sessionMenuId === s.id && (
                    <>
                      <div className="sidebar-menu-backdrop" onClick={(e) => { e.stopPropagation(); setSessionMenuId(null); }} />
                      <div className="sidebar-session-menu" style={{ top: sessionMenuPos.top, left: sessionMenuPos.left }}>
                        {onShareSession && (
                          <button className="sidebar-session-menu-item" onClick={(e) => {
                            e.stopPropagation();
                            setSessionMenuId(null);
                            onShareSession(s);
                          }}>
                            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 12v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8M16 6l-4-4-4 4M12 2v13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            <span>{t("session.share")}</span>
                          </button>
                        )}
                        <button className="sidebar-session-menu-item" onClick={(e) => {
                          e.stopPropagation();
                          startRenamingSession(s);
                        }}>
                          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          <span>{t("common.rename")}</span>
                        </button>
                        <button className="sidebar-session-menu-item sidebar-session-menu-danger" onClick={(e) => {
                          e.stopPropagation();
                          setSessionMenuId(null);
                          setDeletingSession(s);
                        }}>
                          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 6h18M8 6V4h8v2M5 6v14a2 2 0 002 2h10a2 2 0 002-2V6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          <span>{t("common.delete")}</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {activityExpanded && activityGroup === "ontology" && (
          <div className="sidebar-list">
            {visibleSessions.length === 0 && (
              <div className="sidebar-empty">{t("common.noActivity")}</div>
            )}
            {Object.entries(
              visibleSessions.reduce<Record<string, typeof visibleSessions>>((acc, s) => {
                if (!acc[s.projectName]) acc[s.projectName] = [];
                acc[s.projectName].push(s);
                return acc;
              }, {})
            ).map(([projectName, groupSessions]) => (
              <OntologyGroup
                key={projectName}
                projectName={projectName}
                sessions={groupSessions}
                currentSessionId={currentSessionId}
                runningSessionIds={runningSessionIds}
                unreadSessionIds={unreadSessionIds}
                onSelectSession={onSelectSession}
                t={t}
                sessionMenuId={sessionMenuId}
                setSessionMenuId={setSessionMenuId}
                sessionMenuPos={sessionMenuPos}
                setSessionMenuPos={setSessionMenuPos}
                editingSessionId={editingSessionId}
                renameDraft={renameDraft}
                setRenameDraft={setRenameDraft}
                renameInputRef={renameInputRef}
                startRenamingSession={startRenamingSession}
                cancelRenamingSession={cancelRenamingSession}
                commitRenamingSession={commitRenamingSession}
                setDeletingSession={setDeletingSession}
                onShareSession={onShareSession}
              />
            ))}
          </div>
        )}
      </div>

      {/* User Footer */}
      <div className="sidebar-footer">
        <div className="sidebar-user-trigger" onClick={() => setShowUserMenu(!showUserMenu)}>
          <div className="sidebar-avatar">{authInitial}</div>
          <span className="sidebar-username">{displayName}</span>
        </div>

        {showUserMenu && (
          <>
            <div className="user-menu-backdrop" onClick={() => { setShowUserMenu(false); setLangExpanded(false); setTenantExpanded(false); }} />
            <div className="user-menu">
              <div className="user-menu-header">
                <span className="user-menu-name">{displayName}</span>
                <span className="user-menu-email">{userName}</span>
              </div>

              <div className="user-menu-divider" />

              <div className="user-menu-item" onClick={() => { onToggleTheme(); }}>
                <span className="user-menu-item-icon">{theme === "dark" ? "\u2600" : "\u263E"}</span>
                <span>{theme === "dark" ? t("sidebar.lightMode") : t("sidebar.darkMode")}</span>
              </div>

              <div className="user-menu-item" onClick={() => setLangExpanded(!langExpanded)}>
                <span className="user-menu-item-icon">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
                </span>
                <span>{languages.find((l) => l.id === locale)?.label}</span>
                <svg className={`user-menu-item-chevron${langExpanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              {langExpanded && (
                <div className="user-menu-inline-options">
                  {languages.map((lang) => (
                    <div
                      key={lang.id}
                      className={`user-menu-inline-item${locale === lang.id ? " active" : ""}`}
                      onClick={() => { onChangeLocale(lang.id); setLangExpanded(false); }}
                    >
                      <span>{lang.flag}</span>
                      <span>{lang.label}</span>
                      {locale === lang.id && <span className="user-menu-check">&#10003;</span>}
                    </div>
                  ))}
                </div>
              )}

              <div className="user-menu-item" onClick={() => { setTenantExpanded(!tenantExpanded); setTenantSwitchError(null); }}>
                <span className="user-menu-item-icon">
                  <svg viewBox="0 0 24 24" width="16" height="16"><rect x="3" y="3" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="2"/><rect x="14" y="3" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="2"/><rect x="3" y="14" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="2"/><rect x="14" y="14" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="2"/></svg>
                </span>
                <span>{tenants.find((t) => t.id === currentTenant)?.name ?? "No tenant"}</span>
                <svg className={`user-menu-item-chevron${tenantExpanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              {tenantExpanded && (
                <div className="user-menu-inline-options">
                  {tenants.map((t) => (
                    <div
                      key={t.id}
                      className={`user-menu-inline-item${currentTenant === t.id ? " active" : ""}${switchingTenantId ? " is-disabled" : ""}`}
                      onClick={() => {
                        void switchTenant(t.id);
                      }}
                    >
                      <span>{switchingTenantId === t.id ? "Switching..." : t.name}</span>
                      {currentTenant === t.id && <span className="user-menu-check">&#10003;</span>}
                    </div>
                  ))}
                  {tenantSwitchError && <div className="user-menu-inline-error" role="alert">{tenantSwitchError}</div>}
                </div>
              )}

              {iamEnabled && !token && (
                <div className="user-menu-item" onClick={() => redirectToLogin()}>
                  <span className="user-menu-item-icon">
                    <svg viewBox="0 0 24 24" width="16" height="16"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </span>
                  <span>Sign in with IAM</span>
                </div>
              )}

              <div className="user-menu-item" onClick={() => { setShowUserMenu(false); if (onOpenConnectors) onOpenConnectors(); }}>
                <span className="user-menu-item-icon">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 22v-5M9 8V2M15 8V2M7 8h10v4a5 5 0 01-10 0V8z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </span>
                <span>{t("sidebar.connectors")}</span>
              </div>

              <div className="user-menu-divider" />

              <div className="user-menu-item" onClick={redirectToLogout}>
                <span className="user-menu-item-icon">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </span>
                <span>{t("sidebar.signOut")}</span>
              </div>
            </div>
          </>
          )}
      </div>

      {deletingSession && (
        <ConfirmDialog
          title={t("session.deleteTitle")}
          body={t("session.deleteBody")}
          objectName={deletingSession.preview}
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          onCancel={() => setDeletingSession(null)}
          onConfirm={() => {
            onDeleteSession(deletingSession.id);
            setDeletingSession(null);
          }}
        />
      )}
    </aside>
  );
}
