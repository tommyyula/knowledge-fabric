import { useEffect, useMemo, useRef, useState } from "react";
import { diffLines } from "diff";
import { ChevronDown, ChevronUp } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Project, mockOntologyTree, mockOntologyContent, mockQueryResponse, OntologyPage, ReviewState, IngestState, VerifyState, JourneyPhase } from "../mocks/data";
import type { OperationRun, ReviewFile } from "@/contracts/ontology";
import { useOperationRuns } from "@/hooks/useOperations";
import type { Locale } from "@/i18n";
import { operationRunTitle } from "@/lib/operation-runs";
import { useCreateOntologySession, useGenerateOntologyGraph, useGenerateOntologyLayerGraph, useOntologyFile, useOntologyReviewDraft, useOntologyTree, usePendingOntologyReviews, useRecoverOntologyReview } from "@/hooks/useOntologies";
import { useOntologyAssistantRuntime } from "@/hooks/useOntologyAssistantRuntime";
import { cancelOntologyChat } from "@/services/api/ontology-chat";
import CustomScrollIndicator from "@/components/CustomScrollIndicator";
import FilePreviewModal from "./FilePreviewModal";
import OperationRunDetails from "./OperationRunDetails";
import OperationRunPagination from "./OperationRunPagination";

interface KnowledgePanelProps {
  project: Project;
  width?: number;
  reviewState?: ReviewState | null;
  onReviewAction?: (action: "approve" | "discard") => void;
  maintenanceActivity?: {
    phase: JourneyPhase;
    ingest: IngestState;
    verify: VerifyState;
    review: ReviewState;
  };
  reviewGenerationActive?: boolean;
  activeSessionRunning?: boolean;
  activeSessionId?: string | null;
  locale?: Locale;
  onApproveAllReviews?: () => Promise<void> | void;
  approveAllReviewsPending?: boolean;
  operationRun?: OperationRun | null;
  t: (key: string, params?: Record<string, string>) => string;
}

interface QueryMessage {
  role: "user" | "agent";
  content: string;
}

type KnowledgeTab = "explore" | "ask";

interface GraphNode {
  id: string;
  path: string;
  name: string;
  kind: "folder" | "page" | "root";
  group: string;
  childCount: number;
}

interface GraphEdge {
  source: string;
  target: string;
  label: "contains" | "mentions";
}

interface GraphSummary {
  nodes: GraphNode[];
  edges: GraphEdge[];
  pageCount: number;
  folderCount: number;
  categoryCounts: Array<{ name: string; count: number }>;
}

function buildGroundedAskPrompt(question: string) {
  return `Answer this KnowledgePanel Ask question using only files in this ontology workspace root. Read or search the workspace as needed. If the workspace does not contain enough evidence, say what is missing instead of guessing. Cite the workspace paths you used.\n\nQuestion: ${question}`;
}

function cleanPageName(name: string) {
  return name.replace(/\.md$/i, "");
}

function flattenKnowledgeFilePaths(items: OntologyPage[]): string[] {
  const paths: string[] = [];
  const visit = (item: OntologyPage) => {
    if (item.type === "file") paths.push(item.path);
    item.children?.forEach(visit);
  };
  items.forEach(visit);
  return paths;
}

function normalizeKnowledgePath(path: string) {
  return path.replace(/^knowledge\//, "").replace(/^wiki\//, "").replace(/^\.\//, "");
}

function buildGraphSummary(items: OntologyPage[], projectName: string): GraphSummary {
  const rootId = "__root__";
  const nodes: GraphNode[] = [{ id: rootId, path: "", name: projectName, kind: "root", group: "workspace", childCount: items.length }];
  const edges: GraphEdge[] = [];
  const fileNodes: GraphNode[] = [];
  const categoryCounts = new Map<string, number>();
  const nodeByLabel = new Map<string, string>();

  const rememberLabel = (label: string, id: string) => {
    nodeByLabel.set(label.toLowerCase(), id);
    nodeByLabel.set(cleanPageName(label).toLowerCase(), id);
  };

  const visit = (item: OntologyPage, parentId: string, group = "root") => {
    const id = normalizeKnowledgePath(item.path);
    const nextGroup = item.type === "dir" ? item.name : group;
    const childCount = item.children?.length ?? 0;
    const node: GraphNode = {
      id,
      path: item.path,
      name: item.type === "file" ? cleanPageName(item.name) : item.name,
      kind: item.type === "dir" ? "folder" : "page",
      group: nextGroup,
      childCount,
    };

    nodes.push(node);
    edges.push({ source: parentId, target: id, label: "contains" });
    categoryCounts.set(nextGroup, (categoryCounts.get(nextGroup) ?? 0) + (item.type === "file" ? 1 : 0));
    rememberLabel(item.name, id);
    rememberLabel(id, id);

    if (item.type === "file") {
      fileNodes.push(node);
      return;
    }

    item.children?.forEach((child) => visit(child, id, nextGroup));
  };

  items.forEach((item) => visit(item, rootId));

  fileNodes.forEach((node) => {
    const content = mockOntologyContent[node.id];
    if (!content) return;

    for (const match of content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]|\[[^\]]+\]\(([^)]+\.md)\)/g)) {
      const rawTarget = normalizeKnowledgePath(match[1] ?? match[2] ?? "");
      const target = nodeByLabel.get(rawTarget.toLowerCase()) ?? nodeByLabel.get(cleanPageName(rawTarget.split("/").pop() ?? rawTarget).toLowerCase());
      if (target && target !== node.id && !edges.some((edge) => edge.source === node.id && edge.target === target && edge.label === "mentions")) {
        edges.push({ source: node.id, target, label: "mentions" });
      }
    }
  });

  return {
    nodes,
    edges,
    pageCount: fileNodes.length,
    folderCount: nodes.filter((node) => node.kind === "folder").length,
    categoryCounts: Array.from(categoryCounts.entries())
      .filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type GraphTheme = "dark" | "light";

function currentGraphTheme(): GraphTheme {
  const stored = window.localStorage.getItem("theme");
  return stored === "light" || stored === "dark" ? stored : "dark";
}

function injectGraphInitialTheme(html: string) {
  const script = `<script>window.__KF_INITIAL_THEME__=${JSON.stringify(currentGraphTheme())};</script>`;
  return /<head[\s>]/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${script}`) : `${script}${html}`;
}

function graphLoadingHtml(title: string, message: string) {
  const theme = currentGraphTheme();
  const dark = theme === "dark";
  const background = dark ? "#0f1220" : "#f7f8fb";
  const color = dark ? "#eef2f7" : "#1f2933";
  return `<!doctype html><title>${escapeHtml(title)}</title><body style="font-family:system-ui;padding:32px;background:${background};color:${color}">${escapeHtml(message)}</body>`;
}

function graphSummaryHtml(projectName: string, summary: GraphSummary) {
  const nodes = summary.nodes.filter((node) => node.kind !== "root");
  const edges = summary.edges.filter((edge) => edge.source !== "__root__");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(projectName)} Graph</title>
<script>
(function() {
  const valid = value => value === "dark" || value === "light";
  let theme = valid(window.__KF_INITIAL_THEME__) ? window.__KF_INITIAL_THEME__ : "";
  try {
    const stored = window.localStorage && window.localStorage.getItem("theme");
    if (!theme && valid(stored)) theme = stored;
  } catch (error) {}
  if (!theme) theme = "dark";
  document.documentElement.setAttribute("data-theme", theme);
})();
</script>
<style>
:root{color-scheme:light;--bg:#f7f3ea;--text:#17211b;--muted:#6d756f;--line:#d9ded8;--panel:#fffdf8;--node:#fff;--shadow:0 8px 24px rgba(23,33,27,.08);--accent:#2f6f4e}
html[data-theme="dark"]{color-scheme:dark;--bg:#0f1220;--text:#e5eaf3;--muted:#9aa5b5;--line:#2d354a;--panel:#151a2b;--node:#1b2134;--shadow:0 8px 24px rgba(0,0,0,.22);--accent:#64a7ff}
body{margin:0;min-height:100vh;font-family:Georgia,serif;color:var(--text);background:var(--bg)}
.shell{display:grid;grid-template-columns:300px 1fr;min-height:100vh}.side{padding:28px;background:var(--panel);border-right:1px solid var(--line)}.title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.theme-toggle{position:relative;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid var(--line);border-radius:999px;background:var(--node);color:var(--text);cursor:pointer}.theme-toggle:hover{border-color:var(--accent);color:var(--accent)}.theme-toggle svg{width:16px;height:16px;pointer-events:none}.theme-toggle::after{content:attr(data-tooltip);position:absolute;top:calc(100% + 8px);right:0;padding:6px 8px;border-radius:6px;background:var(--text);color:var(--panel);font:12px/1 system-ui;white-space:nowrap;opacity:0;transform:translateY(-2px);pointer-events:none;transition:opacity 80ms ease,transform 80ms ease;z-index:40}.theme-toggle:hover::after,.theme-toggle:focus-visible::after{opacity:1;transform:translateY(0)}.stat{display:inline-grid;margin:14px 10px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}.stat b{font-size:24px}.canvas{margin:28px;border:1px solid var(--line);border-radius:28px;background:var(--panel);min-height:calc(100vh - 56px);padding:28px}.node{display:inline-flex;align-items:center;margin:8px;padding:10px 12px;border:1px solid var(--line);border-radius:999px;background:var(--node);box-shadow:var(--shadow);font:13px ui-monospace,monospace}.edge{margin:8px 0;color:var(--muted);font:13px ui-monospace,monospace}@media(max-width:800px){.shell{grid-template-columns:1fr}.side{border-right:0;border-bottom:1px solid var(--line)}}
</style>
</head>
<body><div class="shell"><aside class="side"><div class="title-row"><h1>${escapeHtml(projectName)} Graph</h1><button id="theme-toggle" class="theme-toggle" type="button" onclick="toggleGraphTheme()" aria-label="Toggle color mode"></button></div><p>Local preview generated from the current panel tree.</p><span class="stat"><b>${summary.pageCount}</b>pages</span><span class="stat"><b>${edges.length}</b>links</span></aside><main class="canvas"><h2>Nodes</h2>${nodes.map((node) => `<span class="node">${escapeHtml(node.name)}</span>`).join("") || "<p>No pages found.</p>"}<h2>Edges</h2>${edges.map((edge) => `<div class="edge">${escapeHtml(edge.source)} -&gt; ${escapeHtml(edge.target)}</div>`).join("") || "<p>No relationships found.</p>"}</main></div><script>let activeTheme=document.documentElement.getAttribute('data-theme')==='light'?'light':'dark';const themeIcons={sun:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>',moon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.99 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.78 9.79Z"></path></svg>'};function setGraphTheme(theme){activeTheme=theme==='light'?'light':'dark';document.documentElement.setAttribute('data-theme',activeTheme);const button=document.getElementById('theme-toggle');if(button){const next=activeTheme==='dark'?'light':'dark';button.innerHTML=activeTheme==='dark'?themeIcons.sun:themeIcons.moon;button.dataset.tooltip='Switch to '+next+' mode';button.setAttribute('aria-label','Switch to '+next+' mode');button.setAttribute('aria-pressed',activeTheme==='dark'?'true':'false');}}function toggleGraphTheme(){setGraphTheme(activeTheme==='dark'?'light':'dark');}setGraphTheme(activeTheme);</script></body></html>`;
}

function openGraphHtml(html: string, pendingWindow: Window | null) {
  const themedHtml = injectGraphInitialTheme(html);
  const blobUrl = URL.createObjectURL(new Blob([themedHtml], { type: "text/html;charset=utf-8" }));
  if (pendingWindow && !pendingWindow.closed) {
    pendingWindow.location.href = blobUrl;
  } else {
    window.open(blobUrl, "_blank", "noopener,noreferrer");
  }
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

function stripKnowledgeRoot(path: string) {
  return path.replace(/^knowledge\//, "").replace(/^wiki\//, "");
}

interface ReviewTreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children: ReviewTreeNode[];
  file?: ReviewFile;
}

function sortReviewTree(nodes: ReviewTreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  nodes.forEach((node) => sortReviewTree(node.children));
}

function buildReviewFileTree(files: ReviewFile[]): ReviewTreeNode[] {
  const root: ReviewTreeNode[] = [];
  const dirs = new Map<string, ReviewTreeNode>();

  for (const file of files) {
    const relativeParts = stripKnowledgeRoot(file.path).split("/").filter(Boolean);
    if (!relativeParts.length) continue;

    let siblings = root;
    let parentPath = "knowledge";
    relativeParts.forEach((part, index) => {
      const isFile = index === relativeParts.length - 1;
      const path = isFile ? file.path : `${parentPath}/${part}`;

      if (isFile) {
        siblings.push({ name: part, path, type: "file", children: [], file });
        return;
      }

      let dir = dirs.get(path);
      if (!dir) {
        dir = { name: part, path, type: "dir", children: [] };
        dirs.set(path, dir);
        siblings.push(dir);
      }
      siblings = dir.children;
      parentPath = path;
    });
  }

  sortReviewTree(root);
  return root;
}

function cleanWorkspaceReferencePath(filePath: string) {
  return filePath.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function knowledgeReferencePath(filePath: string) {
  const clean = cleanWorkspaceReferencePath(filePath);
  if (!clean || clean === "knowledge" || clean.startsWith("knowledge/")) return clean;
  return `knowledge/${clean}`;
}

function draftKnowledgeReferencePath(draftId: string, filePath: string) {
  return `pending_review/drafts/${draftId}/${knowledgeReferencePath(filePath)}`;
}

function basename(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function operationLabel(operation: string) {
  if (operation === "ingest") return "INGEST";
  if (operation === "knowledge-edit") return "EDIT";
  return operation.toUpperCase();
}

function formatOperationRunTime(
  value: string,
  t: (key: string, params?: Record<string, string>) => string,
) {
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

interface DiffLine {
  type: "context" | "added" | "removed";
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface CollapsedDiffBlock {
  type: "collapsed";
  id: string;
  lines: DiffLine[];
  position: "above" | "below" | "both";
}

interface CollapsedDiffExpansion {
  head: number;
  tail: number;
  all?: boolean;
}

type DiffRow = DiffLine | CollapsedDiffBlock;

const DIFF_CONTEXT_LINES = 10;
const DIFF_EXPAND_CHUNK_LINES = 10;

function splitDiffLines(value: string | undefined) {
  if (!value) return [];
  return value.replace(/\r\n/g, "\n").split("\n");
}

function splitDiffChunkLines(value: string) {
  if (!value) return [];
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (value.endsWith("\n")) lines.pop();
  return lines;
}

function buildLineDiff(oldContent: string | undefined, newContent: string): DiffLine[] {
  const diff: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const part of diffLines(oldContent ?? "", newContent)) {
    const lines = splitDiffChunkLines(part.value);
    for (const text of lines) {
      if (part.added) {
        diff.push({ type: "added", newLine, text });
        newLine += 1;
      } else if (part.removed) {
        diff.push({ type: "removed", oldLine, text });
        oldLine += 1;
      } else {
        diff.push({ type: "context", oldLine, newLine, text });
        oldLine += 1;
        newLine += 1;
      }
    }
  }

  return diff;
}

function visibleCollapsedDiffLines(lines: DiffLine[], expansion?: CollapsedDiffExpansion) {
  if (expansion?.all) return { before: lines, hidden: [], after: [] };
  const head = Math.min(expansion?.head ?? 0, lines.length);
  const tail = Math.min(expansion?.tail ?? 0, Math.max(0, lines.length - head));
  return {
    before: lines.slice(0, head),
    hidden: lines.slice(head, lines.length - tail),
    after: tail ? lines.slice(lines.length - tail) : [],
  };
}

function buildDiffRows(lines: DiffLine[], expanded: Record<string, CollapsedDiffExpansion>): DiffRow[] {
  if (!lines.some((line) => line.type !== "context")) return lines;

  const rows: DiffRow[] = [];
  let index = 0;
  let collapsedIndex = 0;

  const pushCollapsed = (hiddenLines: DiffLine[], position: CollapsedDiffBlock["position"]) => {
    if (!hiddenLines.length) return;
    const id = `collapsed-${collapsedIndex}`;
    collapsedIndex += 1;
    const visible = visibleCollapsedDiffLines(hiddenLines, expanded[id]);
    rows.push(...visible.before);
    if (visible.hidden.length) rows.push({ type: "collapsed", id, lines: visible.hidden, position });
    rows.push(...visible.after);
  };

  while (index < lines.length) {
    const line = lines[index];
    if (line.type !== "context") {
      rows.push(line);
      index += 1;
      continue;
    }

    const start = index;
    while (index < lines.length && lines[index].type === "context") index += 1;
    const run = lines.slice(start, index);

    if (run.length <= DIFF_CONTEXT_LINES * 2) {
      rows.push(...run);
    } else if (start === 0) {
      pushCollapsed(run.slice(0, -DIFF_CONTEXT_LINES), "above");
      rows.push(...run.slice(-DIFF_CONTEXT_LINES));
    } else if (index === lines.length) {
      rows.push(...run.slice(0, DIFF_CONTEXT_LINES));
      pushCollapsed(run.slice(DIFF_CONTEXT_LINES), "below");
    } else {
      rows.push(...run.slice(0, DIFF_CONTEXT_LINES));
      pushCollapsed(run.slice(DIFF_CONTEXT_LINES, -DIFF_CONTEXT_LINES), "both");
      rows.push(...run.slice(-DIFF_CONTEXT_LINES));
    }
  }

  return rows;
}

function MarkdownDiffView({ file, t }: { file: ReviewFile; t: (key: string, params?: Record<string, string>) => string }) {
  const [expanded, setExpanded] = useState<Record<string, CollapsedDiffExpansion>>({});
  const lines = useMemo(() => buildLineDiff(file.oldContent, file.content), [file.oldContent, file.content]);
  const rows = useMemo(() => buildDiffRows(lines, expanded), [lines, expanded]);
  useEffect(() => {
    setExpanded({});
  }, [file.path, file.oldContent, file.content]);

  const expandBlock = (id: string, mode: "head" | "tail", all = false) => {
    setExpanded((current) => {
      const block = current[id] ?? { head: 0, tail: 0 };
      if (all) return { ...current, [id]: { head: 0, tail: 0, all: true } };
      return {
        ...current,
        [id]: {
          ...block,
          [mode]: block[mode] + DIFF_EXPAND_CHUNK_LINES,
        },
      };
    });
  };

  const renderFoldButton = (row: CollapsedDiffBlock, direction: "above" | "below") => {
    const mode = direction === "above" ? "tail" : "head";
    const tooltip = direction === "above" ? "show more lines above" : "show more lines below";
    return (
      <button
        type="button"
        className="pending-review-diff-fold-button"
        onClick={(event) => expandBlock(row.id, mode, event.shiftKey)}
        title={tooltip}
        data-tooltip={tooltip}
        aria-label={tooltip}
      >
        {direction === "above"
          ? <ChevronUp size={13} strokeWidth={2.2} />
          : <ChevronDown size={13} strokeWidth={2.2} />}
      </button>
    );
  };

  return (
    <div className="pending-review-diff" aria-label={`Diff ${file.path}`}>
      {rows.map((row, index) => {
        if (row.type === "collapsed") {
          return (
            <div key={`${row.id}-${index}`} className="pending-review-diff-line collapsed">
              <span className="pending-review-diff-fold-controls">
                {(row.position === "above" || row.position === "both") && renderFoldButton(row, "above")}
                {(row.position === "below" || row.position === "both") && renderFoldButton(row, "below")}
              </span>
              <span className="pending-review-diff-collapse">
                <span>{t("review.diffHiddenLines", { count: String(row.lines.length) })}</span>
              </span>
            </div>
          );
        }
        return (
          <div key={`${index}-${row.type}`} className={`pending-review-diff-line ${row.type}`}>
            <span className="pending-review-diff-num old">{row.oldLine ?? ""}</span>
            <span className="pending-review-diff-num new">{row.newLine ?? ""}</span>
            <span className="pending-review-diff-sign">{row.type === "added" ? "+" : row.type === "removed" ? "-" : " "}</span>
            <span className="pending-review-diff-text">{row.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

function ReviewDiffPreviewModal({ file, path, onReference, onClose, t }: { file: ReviewFile; path: string; onReference: () => void; onClose: () => void; t: (key: string, params?: Record<string, string>) => string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const status = file.status === "new" ? t("review.badgeNew") : t("review.badgeModified");
  const lineCount = String(splitDiffLines(file.content).length);
  const rows = [
    { label: "title", value: basename(file.path) },
    { label: "status", value: status },
    { label: "source", value: path },
    { label: "updated", value: t("filePreview.lines", { count: lineCount }) },
  ];

  return (
    <div className="file-preview-backdrop" onClick={onClose} role="presentation">
      <div className="file-preview-modal review-diff-preview-modal" role="dialog" aria-modal="true" aria-label={t("filePreview.previewPath", { path })} onClick={(event) => event.stopPropagation()}>
        <div className="file-preview-topbar">
          <button className="file-preview-back" onClick={onClose} type="button">← Back</button>
          <div className="file-preview-actions">
            <button
              className="pending-review-reference-file"
              onClick={() => {
                onReference();
                onClose();
              }}
              type="button"
            >
              {t("review.referenceThisFile")}
            </button>
            <button className="file-preview-close" onClick={onClose} aria-label={t("filePreview.close")}>&times;</button>
          </div>
        </div>
        <div ref={scrollRef} className="file-preview-scroll file-preview-scroll-custom review-diff-preview-scroll">
          <div className="file-preview-info-card">
            {rows.map((row) => (
              <div className="file-preview-info-row" key={row.label}>
                <span className="file-preview-info-label">{row.label}</span>
                <span className="file-preview-info-value">{row.value}</span>
              </div>
            ))}
          </div>
          <MarkdownDiffView file={file} t={t} />
        </div>
        <CustomScrollIndicator viewportRef={scrollRef} className="file-preview-scroll-indicator" />
      </div>
    </div>
  );
}

export default function KnowledgePanel({ project, width, maintenanceActivity, reviewGenerationActive = false, activeSessionRunning = false, activeSessionId, locale, onApproveAllReviews, approveAllReviewsPending = false, operationRun, t }: KnowledgePanelProps) {
  // viewer 角色（tenant 或 user 范围均适用）不显示"待写入变更"和"运行记录"
  const isViewer = project.accessRole === "viewer";
  const [activeTab, setActiveTab] = useState<KnowledgeTab>("explore");
  const [browseExpanded, setBrowseExpanded] = useState(true);
  const [operationRunsExpanded, setOperationRunsExpanded] = useState(false);
  const [expandedOperationId, setExpandedOperationId] = useState<string | null>(null);
  const [knownOperationRuns, setKnownOperationRuns] = useState<OperationRun[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({ business_objects: true });
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [pendingReviewExpanded, setPendingReviewExpanded] = useState(false);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [selectedReviewFilePath, setSelectedReviewFilePath] = useState<string | null>(null);
  const [reviewActionError, setReviewActionError] = useState<string | null>(null);
  const [queryMessages, setQueryMessages] = useState<QueryMessage[]>([]);
  const [queryInput, setQueryInput] = useState("");
  const [queryLoading, setQueryLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [askSessionId, setAskSessionId] = useState<string | null>(null);
  const queryBottomRef = useRef<HTMLDivElement>(null);
  const askAbortRef = useRef<AbortController | null>(null);
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const operationSectionRef = useRef<HTMLElement>(null);
  const isBackendProject = !project.id.startsWith("proj-");
  const activeProjectId = isBackendProject && !project.deletedAt ? project.id : undefined;
  const operationRunsQuery = useOperationRuns({
    ontologyId: project.id,
    enabled: isBackendProject && !project.deletedAt,
  });
  const treeQuery = useOntologyTree(activeProjectId, "knowledge");
  const fileQuery = useOntologyFile(activeProjectId, previewPath);
  const pendingReviewsQuery = usePendingOntologyReviews(activeProjectId);
  const reviewDraftQuery = useOntologyReviewDraft(project.id, pendingReviewExpanded ? selectedDraftId : null);
  const createSession = useCreateOntologySession();
  const generateGraph = useGenerateOntologyGraph();
  const generateOntologyLayerGraph = useGenerateOntologyLayerGraph();
  const recoverReview = useRecoverOntologyReview();
  const runtime = useOntologyAssistantRuntime();
  const refetchReviewDraft = reviewDraftQuery.refetch;
  const pendingDrafts = useMemo(() => pendingReviewsQuery.data ?? [], [pendingReviewsQuery.data]);
  const pendingDraftCount = pendingDrafts.length;
  const selectedDraftSummary = useMemo(
    () => pendingDrafts.find((draft) => draft.draftId === selectedDraftId) ?? null,
    [pendingDrafts, selectedDraftId],
  );
  const selectedDraftSignature = selectedDraftSummary
    ? [
      selectedDraftSummary.draftId,
      selectedDraftSummary.updatedAt,
      selectedDraftSummary.fileCount,
      selectedDraftSummary.newCount,
      selectedDraftSummary.modifiedCount,
      selectedDraftSummary.canApprove,
      selectedDraftSummary.gateReason,
    ].join("|")
    : "";
  const hasReadyPendingDraft = pendingDrafts.some((draft) => draft.canApprove);
  const hasBlockedPendingDraft = pendingDrafts.some((draft) => !draft.canApprove);
  const maintenancePhase = maintenanceActivity?.phase;
  const maintenanceRunActive = Boolean(reviewGenerationActive && maintenanceActivity);
  const pendingReviewGenerating = pendingDraftCount > 0 && maintenanceRunActive && maintenancePhase !== "ready";
  const pendingReviewWaitingForVerify = pendingDraftCount > 0 && !pendingReviewGenerating && !hasReadyPendingDraft && hasBlockedPendingDraft;
  const pendingReviewLocked = pendingReviewGenerating || pendingReviewWaitingForVerify;
  const recoverableRuntimeWithoutDraft = pendingDraftCount === 0 && Boolean(maintenanceActivity && maintenancePhase !== "ready");
  const canRecoverPendingReview = pendingDrafts.length > 0 || recoverableRuntimeWithoutDraft;
  const recoveryBusy = recoverReview.isPending;
  const pendingReviewBusy = approveAllReviewsPending || recoverReview.isPending;
  const reviewDraftDetail = reviewDraftQuery.data;
  const reviewFileTree = useMemo(() => buildReviewFileTree(reviewDraftDetail?.files ?? []), [reviewDraftDetail?.files]);
  const previewReviewFile = reviewDraftDetail && previewPath
    ? reviewDraftDetail.files.find((file) => draftKnowledgeReferencePath(reviewDraftDetail.draftId, file.path) === previewPath) ?? null
    : null;
  const allPendingReviewApproveBlocked = !onApproveAllReviews || !pendingDrafts.length || pendingDrafts.some((draft) => !draft.canApprove) || pendingReviewBusy || pendingReviewLocked;
  const knowledgeBaseOperationRuns = useMemo(
    () => {
      const runs = operationRunsQuery.data ?? knownOperationRuns;
      return runs
        .filter((run) => run.ontologyId === project.id)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    },
    [knownOperationRuns, operationRunsQuery.data, project.id],
  );

  useEffect(() => {
    queryBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [queryMessages, queryLoading]);

  useEffect(() => {
    setPendingReviewExpanded(pendingDraftCount > 0 || recoverableRuntimeWithoutDraft);
  }, [pendingDraftCount, recoverableRuntimeWithoutDraft]);

  useEffect(() => {
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    setBrowseExpanded(true);
    setAskSessionId(null);
    setQueryInput("");
    setQueryMessages([]);
    setQueryLoading(false);
    setActiveTab("explore");
    setPreviewPath(null);
    setSelectedDraftId(null);
    setSelectedReviewFilePath(null);
    setReviewActionError(null);
    setKnownOperationRuns([]);
    setOperationRunsExpanded(false);
    setExpandedOperationId(null);
  }, [project.id]);

  useEffect(() => {
    if (!operationRun) return;
    setKnownOperationRuns((current) => [
      operationRun,
      ...current.filter((run) => run.id !== operationRun.id),
    ]);
    setOperationRunsExpanded(true);
    setExpandedOperationId(operationRun.id);
    setBrowseExpanded(false);
    setActiveTab("explore");
    window.requestAnimationFrame(() => {
      operationSectionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, [operationRun]);

  useEffect(() => {
    setExpandedOperationId((current) =>
      current && knowledgeBaseOperationRuns.some((run) => run.id === current)
        ? current
        : null,
    );
  }, [knowledgeBaseOperationRuns]);

  useEffect(() => {
    if (!pendingDrafts.length) {
      setSelectedDraftId(null);
      setSelectedReviewFilePath(null);
      return;
    }
    if (!selectedDraftId || !pendingDrafts.some((draft) => draft.draftId === selectedDraftId)) {
      setSelectedDraftId(pendingDrafts[0].draftId);
      setSelectedReviewFilePath(null);
    }
  }, [pendingDrafts, selectedDraftId]);

  useEffect(() => {
    const files = reviewDraftQuery.data?.files ?? [];
    if (!pendingReviewExpanded || !files.length) return;
    if (!selectedReviewFilePath || !files.some((file) => file.path === selectedReviewFilePath)) {
      setSelectedReviewFilePath(files[0].path);
    }
  }, [reviewDraftQuery.data?.files, pendingReviewExpanded, selectedReviewFilePath]);

  useEffect(() => {
    if (!pendingReviewExpanded || !selectedDraftId || !selectedDraftSignature) return;
    void refetchReviewDraft();
  }, [pendingReviewExpanded, refetchReviewDraft, selectedDraftId, selectedDraftSignature]);

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const openPage = (path: string) => {
    setPreviewPath(path);
  };

  const referenceFile = (item: OntologyPage) => {
    window.dispatchEvent(new CustomEvent("insertFileReference", { detail: { filename: item.name, path: knowledgeReferencePath(item.path), kind: "file" } }));
  };

  const referenceFolder = (item: OntologyPage) => {
    window.dispatchEvent(new CustomEvent("insertFileReference", { detail: { filename: `${item.name}/`, path: knowledgeReferencePath(item.path), kind: "folder" } }));
  };

  const referenceReviewFile = (file: ReviewFile) => {
    if (!reviewDraftDetail) return;
    window.dispatchEvent(new CustomEvent("insertFileReference", {
      detail: {
        filename: basename(file.path),
        path: draftKnowledgeReferencePath(reviewDraftDetail.draftId, file.path),
        kind: "file",
      },
    }));
  };

  const referenceReviewFolder = (node: ReviewTreeNode) => {
    if (!reviewDraftDetail) return;
    window.dispatchEvent(new CustomEvent("insertFileReference", {
      detail: {
        filename: `${node.name}/`,
        path: draftKnowledgeReferencePath(reviewDraftDetail.draftId, node.path),
        kind: "folder",
      },
    }));
  };

  const renderTreeItem = (item: OntologyPage, depth = 0) => {
    const isMarkdownPage = /\.md$/i.test(item.name) || /\.md$/i.test(item.path);
    if (item.type === "dir" && !isMarkdownPage) {
      const isExpanded = expandedDirs[item.path] ?? false;
      return (
        <div key={item.path}>
          <div
            className="knowledge-tree-item knowledge-tree-dir"
            style={{ paddingLeft: `${12 + depth * 16}px` }}
            onClick={() => toggleDir(item.path)}
          >
            <svg className="knowledge-tree-folder-icon" viewBox="0 0 24 24" width="14" height="14">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="knowledge-tree-name">{item.name}</span>
            <button
              type="button"
              className="knowledge-tree-ref-btn"
              onClick={(event) => {
                event.stopPropagation();
                referenceFolder(item);
              }}
              aria-label={`Reference folder ${knowledgeReferencePath(item.path)} in chat`}
              title={`@ ${knowledgeReferencePath(item.path)}`}
            >
              @
            </button>
            <svg className={`knowledge-tree-chevron${isExpanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12">
              <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          {isExpanded && item.children?.map((child) => renderTreeItem(child, depth + 1))}
        </div>
      );
    }
    return (
      <div
        key={item.path}
        className={`knowledge-tree-item knowledge-tree-file${previewPath === item.path ? " active" : ""}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => openPage(item.path)}
      >
        <svg className="knowledge-tree-file-icon" viewBox="0 0 24 24" width="14" height="14">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" fill="none" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M14 2v6h6" fill="none" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
        <span className="knowledge-tree-name">{item.name}</span>
        <button type="button" className="knowledge-tree-ref-btn" onClick={(e) => { e.stopPropagation(); referenceFile(item); }} aria-label="Reference in chat">@</button>
      </div>
    );
  };

  const renderReviewTreeNode = (node: ReviewTreeNode, depth = 0) => {
    if (node.type === "dir") {
      const key = `review:${selectedDraftId ?? "draft"}:${node.path}`;
      const isExpanded = expandedDirs[key] ?? true;
      const draftFolderPath = reviewDraftDetail ? draftKnowledgeReferencePath(reviewDraftDetail.draftId, node.path) : node.path;
      return (
        <div key={node.path}>
          <div
            className="knowledge-tree-item knowledge-tree-dir knowledge-panel-review-tree-item"
            style={{ paddingLeft: `${12 + depth * 16}px` }}
            onClick={() => toggleDir(key)}
          >
            <svg className="knowledge-tree-folder-icon" viewBox="0 0 24 24" width="14" height="14">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="knowledge-tree-name">{node.name}</span>
            <button
              type="button"
              className="knowledge-tree-ref-btn"
              onClick={(event) => {
                event.stopPropagation();
                referenceReviewFolder(node);
              }}
              aria-label={`Reference draft folder ${draftFolderPath} in chat`}
              title={`@ ${draftFolderPath}`}
            >
              @
            </button>
            <svg className={`knowledge-tree-chevron${isExpanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12">
              <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          {isExpanded && node.children.map((child) => renderReviewTreeNode(child, depth + 1))}
        </div>
      );
    }

    if (!node.file || !reviewDraftDetail) return null;
    const previewDraftPath = draftKnowledgeReferencePath(reviewDraftDetail.draftId, node.file.path);
    const isActive = selectedReviewFilePath === node.file.path;
    return (
      <div
        key={node.path}
        className={`knowledge-tree-item knowledge-tree-file knowledge-panel-review-tree-item${isActive ? " active" : ""}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => {
          setSelectedReviewFilePath(node.file?.path ?? null);
          setPreviewPath(previewDraftPath);
        }}
      >
        <svg className="knowledge-tree-file-icon" viewBox="0 0 24 24" width="14" height="14">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" fill="none" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M14 2v6h6" fill="none" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
        <span className="knowledge-tree-name" title={node.file.path}>{node.name}</span>
        <span className={`review-badge-inline ${node.file.status === "new" ? "new" : "mod"}`}>{node.file.status === "new" ? t("review.badgeNew") : t("review.badgeModified")}</span>
        <button type="button" className="knowledge-tree-ref-btn" onClick={(e) => { e.stopPropagation(); referenceReviewFile(node.file!); }} aria-label="Reference draft file in chat">@</button>
      </div>
    );
  };

  const sendQuery = async () => {
    const q = queryInput.trim();
    if (!q || queryLoading) return;

    setActiveTab("ask");
    setQueryInput("");
    setQueryMessages((prev) => [...prev, { role: "user", content: q }]);
    setQueryLoading(true);

    if (!isBackendProject) {
      window.setTimeout(() => {
        setQueryMessages((prev) => [...prev, { role: "agent", content: mockQueryResponse }]);
        setQueryLoading(false);
      }, 1000);
      return;
    }

    const assistantIndexRef = { current: -1 };
    const controller = new AbortController();
    askAbortRef.current = controller;

    try {
      const sessionId = askSessionId ?? (await createSession.mutateAsync(project.id)).id;
      if (!askSessionId) setAskSessionId(sessionId);

      await runtime.send({
        ontologyId: project.id,
        sessionId,
        message: buildGroundedAskPrompt(q),
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "text-delta") {
            setQueryMessages((prev) => {
              if (assistantIndexRef.current < 0) {
                assistantIndexRef.current = prev.length;
                return [...prev, { role: "agent", content: event.delta }];
              }
              return prev.map((msg, idx) => idx === assistantIndexRef.current ? { ...msg, content: msg.content + event.delta } : msg);
            });
          }
          if (event.type === "message" && assistantIndexRef.current < 0) {
            setQueryMessages((prev) => [...prev, { role: "agent", content: event.message.content }]);
          }
          if (event.type === "error") {
            setQueryMessages((prev) => [...prev, { role: "agent", content: `Backend ask failed: ${event.error}` }]);
          }
        },
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setQueryMessages((prev) => [...prev, { role: "agent", content: `Backend ask failed: ${err instanceof Error ? err.message : String(err)}` }]);
      }
    } finally {
      if (askAbortRef.current === controller) askAbortRef.current = null;
      setQueryLoading(false);
    }
  };

  const clearQuery = () => {
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    setAskSessionId(null);
    setQueryMessages([]);
    setQueryLoading(false);
  };

  const tree = isBackendProject ? treeQuery.data ?? [] : mockOntologyTree;
  const pageContent = previewPath
    ? fileQuery.data?.content ?? (!isBackendProject ? mockOntologyContent[previewPath.replace(/^knowledge\//, "").replace(/^wiki\//, "")] : undefined) ?? "This page has no content yet."
    : undefined;
  const previewKnownPaths = flattenKnowledgeFilePaths(tree);
  const graphSummary = buildGraphSummary(tree, project.name);

  const openFullGraph = async () => {
    if (generateGraph.isPending) return;
    setGraphError(null);

    const pendingWindow = window.open("about:blank", "_blank");
    pendingWindow?.document.write(graphLoadingHtml("Building graph...", "Building knowledge graph..."));
    if (pendingWindow) pendingWindow.opener = null;

    try {
      const html = isBackendProject
        ? (await generateGraph.mutateAsync(project.id)).html
        : graphSummaryHtml(project.name, graphSummary);
      openGraphHtml(html, pendingWindow);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setGraphError(message);
      if (pendingWindow && !pendingWindow.closed) {
        pendingWindow.document.body.innerHTML = `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;color:#8b2d23">${escapeHtml(message)}</pre>`;
      }
    }
  };

  const openOntologyLayerGraph = async () => {
    if (generateOntologyLayerGraph.isPending) return;
    setGraphError(null);

    const pendingWindow = window.open("about:blank", "_blank");
    pendingWindow?.document.write(graphLoadingHtml("Building ontology graph...", "Building ontology graph..."));
    if (pendingWindow) pendingWindow.opener = null;

    try {
      const html = isBackendProject
        ? (await generateOntologyLayerGraph.mutateAsync(project.id)).html
        : graphSummaryHtml(`${project.name} Ontology`, graphSummary);
      openGraphHtml(html, pendingWindow);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setGraphError(message);
      if (pendingWindow && !pendingWindow.closed) {
        pendingWindow.document.body.innerHTML = `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;color:#8b2d23">${escapeHtml(message)}</pre>`;
      }
    }
  };

  const runReviewAction = async (action: () => Promise<unknown>) => {
    setReviewActionError(null);
    try {
      await action();
    } catch (err) {
      setReviewActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const approveAllPendingReviews = () => {
    if (!onApproveAllReviews) return;
    void runReviewAction(() => Promise.resolve(onApproveAllReviews()));
  };

  const recoverPendingReviews = () => {
    void runReviewAction(async () => {
      if (activeSessionId) await cancelOntologyChat(project.id, activeSessionId).catch(() => undefined);
      await recoverReview.mutateAsync({ id: project.id, sessionId: activeSessionId, locale });
    });
  };

  if (project.deletedAt) {
    return (
      <aside className="knowledge-panel knowledge-artifacts-panel knowledge-panel-deleted" style={width ? { width, minWidth: width } : undefined}>
        <div className="knowledge-panel-deleted-state" role="status">
          <strong>{t("knowledge.deletedTitle")}</strong>
          <span>{t("knowledge.deletedPanelHint")}</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="knowledge-panel knowledge-artifacts-panel" style={width ? { width, minWidth: width } : undefined}>
      <div className="knowledge-panel-body" ref={panelBodyRef}>
        {activeTab === "ask" ? (
          <div className="knowledge-ask-view" style={{ height: "100%" }}>
            <div className="knowledge-ask-messages">
              {queryMessages.length === 0 ? (
                <div className="knowledge-ask-empty">
                  <p>Ask this knowledge base</p>
                  <span>{isBackendProject ? "Answers stream from the backend and stay grounded in the knowledge workspace." : "Mock projects use the prototype answer fallback."}</span>
                </div>
              ) : (
                queryMessages.map((msg, i) => (
                  <div key={i} className={`knowledge-ask-msg-${msg.role}`}>
                    {msg.role === "user" ? (
                      <div className="knowledge-ask-user-bubble">{msg.content}</div>
                    ) : (
                      <div className="knowledge-ask-agent-content"><Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown></div>
                    )}
                  </div>
                ))
              )}
              {queryLoading && <div className="loading-dots"><span className="loading-dot"/><span className="loading-dot"/><span className="loading-dot"/></div>}
              <div ref={queryBottomRef} />
            </div>
            <div className="knowledge-ask-input-area">
              <button className="knowledge-ask-clear" onClick={clearQuery} disabled={queryMessages.length === 0 && !queryLoading} aria-label="Clear ask chat">
                <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              <div className="knowledge-ask-input-bar">
                <input
                  value={queryInput}
                  onChange={(e) => setQueryInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendQuery(); }}
                  placeholder="Ask about this knowledge base..."
                  disabled={queryLoading}
                />
                {queryLoading ? (
                  <button className="stop-btn" aria-label="Stop ask stream" onClick={() => askAbortRef.current?.abort()}><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
                ) : (
                  <button className="send-btn" onClick={() => void sendQuery()} disabled={!queryInput.trim()} aria-label="Send ask question"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="knowledge-panel-sections">
            <section className="knowledge-panel-section knowledge-panel-browse-section" aria-label={t("panel.explore")}>
              <div className="knowledge-panel-section-header">
                <button
                  type="button"
                  className="knowledge-panel-section-toggle"
                  onClick={() => setBrowseExpanded((open) => !open)}
                  aria-expanded={browseExpanded}
                >
                  <span className="knowledge-panel-section-toggle-title">
                    <svg className={`knowledge-tree-chevron${browseExpanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12">
                      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    {t("panel.explore")}
                  </span>
                </button>
                <div className="knowledge-panel-actions">
                  <button
                    className="knowledge-panel-graph-link"
                    onClick={() => void openFullGraph()}
                    title={t("panel.graph")}
                    disabled={generateGraph.isPending}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    {generateGraph.isPending ? "Building..." : t("panel.graph")}
                  </button>
                  <button
                    className="knowledge-panel-graph-link"
                    onClick={() => void openOntologyLayerGraph()}
                    title={t("panel.ontologyGraph")}
                    disabled={generateOntologyLayerGraph.isPending}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m10.586 5.414-5.172 5.172" />
                      <path d="m18.586 13.414-5.172 5.172" />
                      <path d="M6 12h12" />
                      <circle cx="12" cy="20" r="2" />
                      <circle cx="12" cy="4" r="2" />
                      <circle cx="20" cy="12" r="2" />
                      <circle cx="4" cy="12" r="2" />
                    </svg>
                    {generateOntologyLayerGraph.isPending ? "Building..." : t("panel.ontologyGraph")}
                  </button>
                </div>
              </div>
              {browseExpanded && (
                <div className="knowledge-panel-section-content">
                  <div className="knowledge-tree-header">
                    <span>{project.name}</span>
                  </div>
                  {graphError && <div className="sidebar-empty">Graph build failed: {graphError}</div>}
                  {treeQuery.isLoading ? <div className="sidebar-empty">Loading knowledge...</div> : tree.map((item) => renderTreeItem(item))}
                </div>
              )}
            </section>

            {isBackendProject && !isViewer && (
              <section className="knowledge-panel-section knowledge-panel-review-section" aria-label={t("review.pendingTitle")}>
                <button
                  type="button"
                  className="knowledge-panel-section-toggle"
                  onClick={() => setPendingReviewExpanded((open) => !open)}
                  aria-expanded={pendingReviewExpanded}
                >
                  <span className="knowledge-panel-section-toggle-title">
                    <svg className={`knowledge-tree-chevron${pendingReviewExpanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12">
                      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    {t("review.pendingTitle")}
                  </span>
                  <span className="knowledge-panel-section-toggle-meta">{pendingDraftCount}</span>
                </button>

                {pendingReviewExpanded && (
                  <div className="knowledge-panel-review-content">
                    {pendingDrafts.length > 1 && (
                      <div className="knowledge-panel-review-draft-list" aria-label={t("review.pendingRecords")}>
                        {pendingDrafts.map((draft) => (
                          <button
                            key={draft.draftId}
                            type="button"
                            className={`knowledge-panel-review-draft${draft.draftId === selectedDraftId ? " active" : ""}${draft.canApprove ? "" : " blocked"}`}
                            onClick={() => {
                              setSelectedDraftId(draft.draftId);
                              setSelectedReviewFilePath(null);
                              setReviewActionError(null);
                            }}
                          >
                            <span>{operationLabel(draft.operation)}</span>
                            <span>{draft.fileCount}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    {pendingDraftCount === 0 ? (
                      <>
                        <div className="pending-review-empty">{t("review.noPendingChanges")}</div>
                        {recoverableRuntimeWithoutDraft && (
                          <div className="knowledge-panel-review-actions-row">
                            <button className="pending-review-discard-all" disabled={!canRecoverPendingReview || pendingReviewBusy} onClick={recoverPendingReviews}>
                              {recoveryBusy
                                ? t("review.recovering")
                                : activeSessionRunning
                                  ? t("review.cancelAndRecover")
                                  : t("review.recover")}
                            </button>
                          </div>
                        )}
                      </>
                    ) : reviewDraftQuery.isLoading ? (
                      <div className="pending-review-empty">{t("review.loadingDraft")}</div>
                    ) : reviewDraftDetail ? (
                      <>
                        <div className="knowledge-panel-review-summary">
                          <div className="knowledge-panel-review-description" title={reviewDraftDetail.description}>
                            {reviewDraftDetail.description}
                          </div>
                          <div className="knowledge-panel-review-metrics">
                            <span>{t("journey.fileCount", { count: String(reviewDraftDetail.fileCount) })}</span>
                            <span>{t("review.newCount", { count: String(reviewDraftDetail.newCount) })}</span>
                            <span>{t("review.modifiedCount", { count: String(reviewDraftDetail.modifiedCount) })}</span>
                          </div>
                        </div>

                        <div className="knowledge-panel-review-actions-row">
                          <button className="pending-review-discard-all" disabled={!canRecoverPendingReview || pendingReviewBusy} onClick={recoverPendingReviews}>
                            {recoveryBusy
                              ? t("review.recovering")
                              : activeSessionRunning
                                ? t("review.cancelAndRecover")
                                : t("review.recover")}
                          </button>
                          <button className="pending-review-approve-all" disabled={allPendingReviewApproveBlocked} onClick={approveAllPendingReviews}>
                            {approveAllReviewsPending ? t("review.approving") : t("review.approveAll")}
                          </button>
                        </div>

                        <div className="knowledge-panel-review-root">
                          {reviewFileTree.length ? reviewFileTree.map((node) => renderReviewTreeNode(node)) : <div className="pending-review-empty">{t("review.noFiles")}</div>}
                        </div>
                      </>
                    ) : (
                      <div className="pending-review-empty">{t("review.noDraftSelected")}</div>
                    )}

                    {reviewActionError && <div className="pending-review-error" role="alert">{reviewActionError}</div>}
                  </div>
                )}
              </section>
            )}

            {!isViewer && (
            <section
              ref={operationSectionRef}
              className="knowledge-panel-section knowledge-panel-operation-section"
              aria-label={t("operations.title")}
            >
              <button
                type="button"
                className="knowledge-panel-section-toggle"
                onClick={() => setOperationRunsExpanded((open) => !open)}
                aria-expanded={operationRunsExpanded}
              >
                <span className="knowledge-panel-section-toggle-title">
                  <svg className={`knowledge-tree-chevron${operationRunsExpanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12">
                    <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  {t("operations.title")}
                </span>
                <span className="knowledge-panel-section-toggle-meta">{knowledgeBaseOperationRuns.length}</span>
              </button>

              {operationRunsExpanded ? (
                <div className="knowledge-panel-operation-content">
                  {operationRunsQuery.isLoading && !knowledgeBaseOperationRuns.length ? (
                    <div className="knowledge-panel-operation-empty">{t("operations.loading")}</div>
                  ) : operationRunsQuery.isError && !knowledgeBaseOperationRuns.length ? (
                    <div className="knowledge-panel-operation-empty">{t("operations.unavailableTitle")}</div>
                  ) : knowledgeBaseOperationRuns.length ? (
                    <>
                      {knowledgeBaseOperationRuns.map((run) => {
                        const expanded = expandedOperationId === run.id;
                        return (
                      <div
                        key={run.id}
                        className={`knowledge-panel-operation-record${expanded ? " expanded" : ""}`}
                        data-operation-id={run.id}
                      >
                        <button
                          type="button"
                          className="knowledge-panel-operation-record-toggle"
                          onClick={() => setExpandedOperationId((current) => current === run.id ? null : run.id)}
                          aria-expanded={expanded}
                        >
                          <span className="knowledge-panel-operation-record-copy">
                            <svg className="knowledge-tree-folder-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                            <span className="knowledge-panel-operation-record-title">{operationRunTitle(run)}</span>
                          </span>
                          <span className="knowledge-panel-operation-record-meta">
                            <time dateTime={run.startedAt}>{formatOperationRunTime(run.startedAt, t)}</time>
                            <svg className={`knowledge-tree-chevron${expanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                              <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </span>
                        </button>
                        {expanded ? (
                          <div className="knowledge-panel-operation-detail">
                            <OperationRunDetails run={run} t={t} />
                          </div>
                        ) : null}
                      </div>
                        );
                      })}
                      <OperationRunPagination
                        hasItems
                        hasNextPage={operationRunsQuery.hasNextPage}
                        loadFailed={operationRunsQuery.isFetchNextPageError}
                        loading={operationRunsQuery.isFetchingNextPage}
                        onLoadMore={() => void operationRunsQuery.fetchNextPage()}
                        t={t}
                      />
                    </>
                  ) : (
                    <div className="knowledge-panel-operation-empty">{t("operations.emptyTitle")}</div>
                  )}
                </div>
              ) : null}
            </section>
            )}
          </div>
        )}
      </div>
      <CustomScrollIndicator viewportRef={panelBodyRef} />

      {previewPath && previewReviewFile ? (
        <ReviewDiffPreviewModal
          t={t}
          path={previewPath}
          file={previewReviewFile}
          onReference={() => referenceReviewFile(previewReviewFile)}
          onClose={() => setPreviewPath(null)}
        />
      ) : previewPath ? (
        <FilePreviewModal
          t={t}
          path={previewPath}
          content={pageContent}
          loading={isBackendProject ? fileQuery.isLoading : false}
          error={isBackendProject && fileQuery.isError ? t("journey.fileReadError") : undefined}
          knownPaths={previewKnownPaths}
          onNavigatePath={setPreviewPath}
          onClose={() => setPreviewPath(null)}
        />
      ) : null}
    </aside>
  );
}
