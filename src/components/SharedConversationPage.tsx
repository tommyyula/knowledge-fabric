import { useEffect, useMemo, useState } from "react";
import { LogIn, BookOpen } from "lucide-react";
import { useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import Markdown from "react-markdown";
import type { ConversationSnapshot, OntologyFileNode, OntologyProject } from "@/contracts/ontology";
import { getOntology, getOntologyTree, getPublicConversationSnapshot } from "@/services/api/ontology";
import { useUserStore } from "@/stores/useUserStore";
import { useTheme } from "@/hooks/useTheme";
import { createT, readUiLocale } from "@/i18n";
import { useOntologies, useAllOntologySessions } from "@/hooks/useOntologies";
import Sidebar from "./Sidebar";

// 是否拥有来源知识库 Editor/Manager 及以上权限
function hasKnowledgePanelAccess(project: OntologyProject | null): boolean {
  if (!project) return false;
  const role = project.accessRole;
  return role === "editor" || role === "manager" || role === "owner";
}

function flatten(nodes: OntologyFileNode[], depth = 0): Array<{ node: OntologyFileNode; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...(node.children ? flatten(node.children, depth + 1) : [])]);
}

// ── 左侧 Sidebar ───────────────────────────────────────────────
// 已登录：用真实数据渲染 Sidebar，导航回调跳转到主应用
// 未登录：骨架 + 底部登录引导卡片
function SharedSidebar({ user }: { user: unknown }) {
  const { theme, toggleTheme } = useTheme();
  const t = useMemo(() => createT(readUiLocale()), []);
  const ontologiesQuery = useOntologies();
  const projects = ontologiesQuery.data ?? [];
  const allSessionsQuery = useAllOntologySessions(projects);
  const sessions = useMemo(
    () => (allSessionsQuery.data ?? []).filter((s) => s.origin !== "external"),
    [allSessionsQuery.data],
  );
  const favorites = useMemo(
    () => new Set(projects.filter((p) => p.favorite).map((p) => p.id)),
    [projects],
  );

  if (user) {
    return (
      <Sidebar
        projects={projects}
        sessions={sessions}
        currentSessionId={null}
        currentProject={null}
        collapsed={false}
        favorites={favorites}
        runningSessionIds={new Set()}
        unreadSessionIds={new Set()}
        onToggleCollapse={() => undefined}
        onSelectSession={(sessionId) => {
          const session = sessions.find((s) => s.id === sessionId);
          const projectId = session?.projectId ?? session?.ontologyId;
          if (projectId) {
            localStorage.setItem("knowledge-fabric.active-chat-state.v1", JSON.stringify({ projectId, sessionId, updatedAt: Date.now() }));
          }
          window.location.href = "/";
        }}
        onSelectProject={(project) => {
          localStorage.setItem("knowledge-fabric.active-chat-state.v1", JSON.stringify({ projectId: project.id, sessionId: null, updatedAt: Date.now() }));
          window.location.href = "/";
        }}
        onNewChat={() => { window.location.href = "/"; }}
        onViewAllOntologies={() => {
          sessionStorage.setItem("knowledge-fabric.navigate-to-page.v1", "my-ontologies");
          window.location.href = "/";
        }}
        onViewResourceLibrary={() => {
          sessionStorage.setItem("knowledge-fabric.navigate-to-page.v1", "resource-library");
          window.location.href = "/";
        }}
        onViewOperationRuns={() => {
          sessionStorage.setItem("knowledge-fabric.navigate-to-page.v1", "operation-runs");
          window.location.href = "/";
        }}
        onViewAdminData={() => {
          sessionStorage.setItem("knowledge-fabric.navigate-to-page.v1", "admin-data");
          window.location.href = "/";
        }}
        onToggleFavorite={() => undefined}
        onRenameSession={() => undefined}
        onDeleteSession={() => undefined}
        theme={theme}
        onToggleTheme={toggleTheme}
        locale={readUiLocale()}
        onChangeLocale={() => undefined}
        t={t}
      />
    );
  }

  return (
    <aside className="sidebar sc-sidebar" aria-label="Conversation navigation">
      <div className="sc-sidebar-brand">Knowledge Fabric</div>
      <div className="sc-sidebar-nav-skeleton" />
      <div className="sc-sidebar-nav-skeleton short" />
      <div className="sc-sidebar-section-label" />
      <div className="sc-sidebar-item-skeleton" />
      <div className="sc-sidebar-item-skeleton" />
      <div className="sc-sidebar-item-skeleton short" />
      <div className="sc-sidebar-item-skeleton" />
      <div className="sc-sidebar-item-skeleton short" />
      <div className="sc-sidebar-login-bar">
        <div className="sc-sidebar-login-content">
          <span className="sc-sidebar-login-title">Continue in Knowledge Fabric</span>
          <span className="sc-sidebar-login-sub">Sign in to create your own workspace.</span>
        </div>
        <a href="/login" className="sc-sidebar-login-btn">
          <LogIn size={14} />
          Sign in
        </a>
      </div>
    </aside>
  );
}

// ── 右侧知识库面板 ─────────────────────────────────────────────
// 未登录：完全不渲染（需求 4.2：不渲染右侧知识库面板）
// 已登录无权限：显示骨架 + 遮罩
// 已登录有权限：展示真实文件树（只读）
function SharedKnowledgePanel({
  project, tree, user, hasAccess,
}: {
  project: OntologyProject | null;
  tree: OntologyFileNode[];
  user: unknown;
  hasAccess: boolean;
}) {
  // 未登录：不渲染
  if (!user) return null;

  const showMask = !hasAccess;
  return (
    <aside className="sc-knowledge-panel" aria-label="Knowledge base">
      <div className="sc-knowledge-header">
        {project ? (
          <>
            <span className="sc-knowledge-emoji">{project.emoji}</span>
            <span className="sc-knowledge-name">{project.name}</span>
          </>
        ) : (
          <div className="sc-knowledge-name-skeleton" />
        )}
      </div>
      <div className="sc-knowledge-body">
        {project && !showMask ? (
          <>
            <div className="sc-knowledge-section-label">
              <BookOpen size={12} />
              <span>Knowledge files</span>
            </div>
            <div className="sc-knowledge-file-list">
              {flatten(tree)
                .filter(({ node }) => node.type === "file")
                .slice(0, 60)
                .map(({ node, depth }) => (
                  <div className="sc-knowledge-file" style={{ paddingLeft: 12 + depth * 12 }} key={node.path}>
                    {node.name}
                  </div>
                ))}
            </div>
          </>
        ) : (
          <>
            <div className="sc-knowledge-tree-skeleton" />
            <div className="sc-knowledge-tree-skeleton medium" />
            <div className="sc-knowledge-tree-skeleton short" />
            <div className="sc-knowledge-tree-skeleton" />
            <div className="sc-knowledge-tree-skeleton medium" />
          </>
        )}
      </div>
      {showMask && (
        <div className="sc-login-mask" role="complementary">
          <LogIn size={20} className="sc-login-mask-icon" />
          <strong className="sc-login-mask-title">You don't have access to this knowledge base</strong>
        </div>
      )}
    </aside>
  );
}

// ── 消息渲染，完全对齐正常对话样式 ────────────────────────────
function SharedMessage({
  role, content, createdAt, index,
}: {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  index: number;
}) {
  const isUser = role === "user";

  if (isUser) {
    // 完全复刻 aui-user-message-root 布局
    return (
      <div
        className="sc-msg-user-root aui-user-message-root mx-auto grid w-full max-w-[44rem] auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 py-3"
        data-role="user"
        data-index={index}
        style={{ ["--thread-max-width" as string]: "44rem" }}
      >
        <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
          <div className="aui-user-message-content wrap-break-word peer flex flex-col items-start gap-2 rounded-2xl bg-muted px-4 py-2.5 text-foreground empty:hidden">
            <span className="aui-user-text-part">{content}</span>
          </div>
          {createdAt && (
            <time className="sc-message-time" dateTime={createdAt}>
              {new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </time>
          )}
        </div>
      </div>
    );
  }

  // 完全复刻 aui-assistant-message-root 布局，使用 aui-md 样式类渲染 Markdown
  return (
    <div
      className="sc-msg-assistant-root aui-assistant-message-root mx-auto relative w-full max-w-[44rem] py-3"
      data-role="assistant"
      data-index={index}
    >
      <div className="aui-assistant-message-content wrap-break-word px-2 text-foreground leading-relaxed">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            // 完全对齐 markdown-text.tsx 中的 defaultComponents 样式类
            h1: ({ children }) => <h1 className="aui-md-h1 mb-2 scroll-m-20 font-semibold text-base first:mt-0 last:mb-0">{children}</h1>,
            h2: ({ children }) => <h2 className="aui-md-h2 mt-3 mb-1.5 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0">{children}</h2>,
            h3: ({ children }) => <h3 className="aui-md-h3 mt-2.5 mb-1 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0">{children}</h3>,
            h4: ({ children }) => <h4 className="aui-md-h4 mt-2 mb-1 scroll-m-20 font-medium text-sm first:mt-0 last:mb-0">{children}</h4>,
            p: ({ children }) => <p className="aui-md-p my-4 leading-normal first:mt-0 last:mb-0">{children}</p>,
            a: ({ children }) => <span className="aui-md-a text-primary underline underline-offset-2">{children}</span>,
            blockquote: ({ children }) => <blockquote className="aui-md-blockquote my-2.5 border-muted-foreground/30 border-l-2 pl-3 text-muted-foreground italic">{children}</blockquote>,
            ul: ({ children }) => <ul className="aui-md-ul my-2 ml-4 list-disc marker:text-muted-foreground [&>li]:mt-1">{children}</ul>,
            ol: ({ children }) => <ol className="aui-md-ol my-2 ml-4 list-decimal marker:text-muted-foreground [&>li]:mt-1">{children}</ol>,
            li: ({ children }) => <li className="aui-md-li leading-normal">{children}</li>,
            hr: () => <hr className="aui-md-hr my-2 border-muted-foreground/20" />,
            table: ({ children }) => <table className="aui-md-table my-2 w-full border-separate border-spacing-0 overflow-y-auto">{children}</table>,
            th: ({ children }) => <th className="aui-md-th bg-muted px-2 py-1 text-left font-medium first:rounded-tl-lg last:rounded-tr-lg">{children}</th>,
            td: ({ children }) => <td className="aui-md-td border-muted-foreground/20 border-b border-l px-2 py-1 text-left last:border-r">{children}</td>,
            tr: ({ children }) => <tr className="aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-bl-lg [&:last-child>td:last-child]:rounded-br-lg">{children}</tr>,
            pre: ({ children }) => <pre className="aui-md-pre overflow-x-auto rounded-b-lg border border-border/50 border-t-0 bg-muted/30 p-3 text-xs leading-relaxed">{children}</pre>,
            code: ({ children, className }) => {
              const isBlock = Boolean(className);
              if (isBlock) return <code className={className}>{children}</code>;
              return <code className="aui-md-inline-code rounded-md border border-border/50 bg-muted/50 px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>;
            },
            img: () => null,
          }}
        >
          {content}
        </Markdown>
      </div>
      {createdAt && (
        <time className="sc-message-time assistant" dateTime={createdAt}>
          {new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      )}
    </div>
  );
}

// ── 主页面 ────────────────────────────────────────────────────
export default function SharedConversationPage() {
  const { token = "" } = useParams();
  const user = useUserStore((state) => state.userInfo);
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [project, setProject] = useState<OntologyProject | null>(null);
  const [tree, setTree] = useState<OntologyFileNode[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPublicConversationSnapshot(token)
      .then((value) => {
        if (cancelled) return;
        setSnapshot(value);
        if (user && value.knowledgeBaseId) {
          getOntology(value.knowledgeBaseId)
            .then((kb) => {
              if (cancelled) return;
              setProject(kb);
              if (hasKnowledgePanelAccess(kb)) {
                return getOntologyTree(kb.id).then((nodes) => { if (!cancelled) setTree(nodes); });
              }
            })
            .catch(() => undefined);
        }
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, user]);

  if (error) {
    return (
      <main className="sc-status-page">
        <h1 className="sc-status-title">
          {error.includes("no longer") ? "This shared conversation is no longer available" : "Shared conversation not found"}
        </h1>
        <p className="sc-status-desc">The original conversation may have been deleted or the link has expired.</p>
      </main>
    );
  }

  if (loading || !snapshot) {
    return (
      <div className="app-layout">
        <SharedSidebar user={user} />
        <main className="main-content sc-main-loading">
          <div className="sc-loading-thread">
            <div className="sc-loading-bubble assistant" />
            <div className="sc-loading-bubble user" />
            <div className="sc-loading-bubble assistant" />
          </div>
        </main>
        <SharedKnowledgePanel project={null} tree={[]} user={user} hasAccess={false} />
      </div>
    );
  }

  const hasAccess = hasKnowledgePanelAccess(project);

  return (
    <div className="app-layout">
      <SharedSidebar user={user} />

      <main className="main-content sc-main">
        {/* Header：复用 chat-header */}
        <header className="chat-header">
          <div className="chat-header-info">
            {project && (
              <span className="chat-project-name">{project.emoji} {project.name}</span>
            )}
            {!project && snapshot && (
              <span className="chat-project-name">Shared conversation</span>
            )}
          </div>
          <div className="chat-header-actions">
            <span className="sc-readonly-badge">Read only</span>
          </div>
        </header>

        {/* 消息列表：复用 chat-messages，使用 steward-thread-host 继承完整线程样式 */}
        <div
          className="chat-messages steward-thread-host sc-thread"
          role="log"
          aria-label="Shared conversation"
          style={{ ["--thread-max-width" as string]: "44rem" }}
        >
          <div className="sc-snapshot-banner">
            A permanent snapshot shared by its creator
          </div>

          {snapshot.messages.map((message, index) => (
            <SharedMessage
              key={`${message.createdAt ?? "msg"}-${index}`}
              role={message.role}
              content={message.content}
              createdAt={message.createdAt}
              index={index}
            />
          ))}
        </div>

        {/* 底部登录引导已移除，见左侧 Sidebar */}
      </main>

      <SharedKnowledgePanel project={project} tree={tree} user={user} hasAccess={hasAccess} />
    </div>
  );
}
