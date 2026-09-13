import { useEffect, useMemo, useRef } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import CustomScrollIndicator from "@/components/CustomScrollIndicator";

interface FilePreviewModalProps {
  path: string;
  content?: string;
  loading?: boolean;
  error?: string;
  knownPaths?: string[];
  onNavigatePath?: (path: string) => void;
  onClose: () => void;
  t: (key: string, params?: Record<string, string>) => string;
}

interface PreviewMetadata {
  title: string;
  type: string;
  tags: string[];
  sources: string;
  updated: string;
}

const ROOT_PREFIXES = ["knowledge/", "wiki/", "pending_review/", "raw/", "sources/", "skills/", "tools/"];
const JSON_PREVIEW_FORMAT_MAX_CHARS = 1_000_000;

function cleanPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/").trim();
}

function stripMarkdownTitle(value: string): string {
  return value.replace(/\.mdx?$/i, "").replace(/[-_]+/g, " ").trim();
}

function parseListValue(value: string): string[] {
  const clean = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return clean
    .split(/[,，]/)
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parsePreviewDocument(path: string, content?: string): { metadata: PreviewMetadata; body: string } {
  const fileName = path.split("/").pop() || path;
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let body = content ?? "";

  if (body.startsWith("---")) {
    const lines = body.split(/\r\n|\r|\n/);
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) {
      let currentListKey: string | null = null;
      for (const line of lines.slice(1, end)) {
        const listItem = line.match(/^\s*-\s+(.+)$/);
        if (listItem && currentListKey) {
          lists[currentListKey] = [...(lists[currentListKey] ?? []), listItem[1].trim()];
          continue;
        }
        const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
        if (!pair) continue;
        const key = pair[1].toLowerCase();
        const value = pair[2].trim();
        currentListKey = value ? null : key;
        if (value) values[key] = value.replace(/^['"]|['"]$/g, "");
      }
      body = lines.slice(end + 1).join("\n").trimStart();
    }
  }

  const firstHeading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = values.title || firstHeading || stripMarkdownTitle(fileName);
  if (firstHeading && firstHeading === title) {
    body = body.replace(/^#\s+.+\n+/, "");
  }

  return {
    metadata: {
      title,
      type: values.type || values.kind || (/\.mdx?$/i.test(fileName) ? "Markdown" : "Plain text"),
      tags: lists.tags ?? parseListValue(values.tags ?? ""),
      sources: values.sources || values.source || (lists.sources ?? lists.source ?? []).join(", "),
      updated: values.updated || values.last_updated || values.date || "",
    },
    body,
  };
}

function splitWikiLink(raw: string): { target: string; label: string } {
  const [targetPart, labelPart] = raw.split("|");
  const target = targetPart.trim();
  const label = (labelPart || targetPart).replace(/^#/, "").trim();
  return { target, label };
}

function markdownEscapeLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function transformWikiLinks(content: string): string {
  let fenced = false;
  return content.split(/\r\n|\r|\n/).map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    return line.replace(/\[\[([^\]]+)\]\]/g, (_match, raw: string) => {
      const { target, label } = splitWikiLink(raw);
      if (!target) return _match;
      return `[${markdownEscapeLabel(label || target)}](#wikilink=${encodeURIComponent(target)})`;
    });
  }).join("\n");
}

function markdownCodeFence(language: string, value: string): string {
  const longestFence = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}${language}\n${value.replace(/\s+$/u, "")}\n${fence}`;
}

function looksLikeJsonDocument(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function normalizeJsonPreviewBody(value: string): string {
  const trimmed = value.trim();
  if (!looksLikeJsonDocument(trimmed)) return value;
  if (trimmed.length > JSON_PREVIEW_FORMAT_MAX_CHARS) return markdownCodeFence("json", trimmed);
  try {
    return markdownCodeFence("json", JSON.stringify(JSON.parse(trimmed), null, 2) ?? trimmed);
  } catch {
    return value;
  }
}

function dirname(path: string): string {
  const clean = cleanPath(path);
  const index = clean.lastIndexOf("/");
  return index > 0 ? clean.slice(0, index) : "";
}

function rootDirFor(path: string): string | null {
  const clean = cleanPath(path);
  const knowledgeIndex = clean.indexOf("/knowledge/");
  if (knowledgeIndex >= 0) return clean.slice(0, knowledgeIndex + "/knowledge".length);
  if (clean.startsWith("knowledge/")) return "knowledge";
  const wikiIndex = clean.indexOf("/wiki/");
  if (wikiIndex >= 0) return clean.slice(0, wikiIndex + "/wiki".length);
  if (clean.startsWith("wiki/")) return "wiki";
  return null;
}

function normalizeCandidate(value: string): string {
  const clean = cleanPath(value);
  const parts: string[] = [];
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return "";
    parts.push(part);
  }
  return parts.join("/");
}

function resolveWikiTarget(rawTarget: string, currentPath: string, knownPaths: string[] = []): string | null {
  const targetWithoutAnchor = rawTarget.split("#")[0]?.trim();
  if (!targetWithoutAnchor || /^[a-z][a-z0-9+.-]*:/i.test(targetWithoutAnchor)) return null;
  const withExt = /\.mdx?$/i.test(targetWithoutAnchor) ? targetWithoutAnchor : `${targetWithoutAnchor}.md`;
  const direct = normalizeCandidate(withExt);
  if (!direct) return null;

  const normalizedKnownPaths = knownPaths.map(cleanPath);
  const byExact = normalizedKnownPaths.find((known) => known === direct || known.endsWith(`/${direct}`));
  if (byExact) return byExact;

  const basename = direct.split("/").pop()?.toLowerCase();
  const byBasename = basename ? normalizedKnownPaths.find((known) => known.split("/").pop()?.toLowerCase() === basename) : undefined;
  if (byBasename) return byBasename;

  if (ROOT_PREFIXES.some((prefix) => direct.startsWith(prefix))) return direct;

  const root = rootDirFor(currentPath);
  if (root) return normalizeCandidate(`${root}/${direct}`);

  const sibling = normalizeCandidate(`${dirname(currentPath)}/${direct}`);
  return sibling || direct;
}

export default function FilePreviewModal({ path, content, loading, error, knownPaths, onNavigatePath, onClose, t }: FilePreviewModalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileName = path.split("/").pop() || path;
  const isMarkdown = /\.md(?:x)?$/i.test(fileName);
  const parsed = useMemo(() => parsePreviewDocument(path, content), [content, path]);
  const previewBody = useMemo(() => normalizeJsonPreviewBody(parsed.body || t("filePreview.empty")), [parsed.body, t]);
  const renderedMarkdown = useMemo(() => transformWikiLinks(previewBody), [previewBody]);
  const stats = useMemo(() => {
    const text = previewBody ?? "";
    const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return { lines, words };
  }, [previewBody]);

  const markdownComponents = useMemo<Components>(() => ({
    a: ({ href, children, ...props }) => {
      const internalMarkdownTarget = href?.startsWith("#wikilink=")
        ? decodeURIComponent(href.slice("#wikilink=".length))
        : href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && /\.mdx?(?:#.*)?$/i.test(href)
          ? href
          : null;
      if (internalMarkdownTarget) {
        const rawTarget = internalMarkdownTarget;
        const resolved = resolveWikiTarget(rawTarget, path, knownPaths);
        return (
          <button
            type="button"
            className="file-preview-wikilink"
            title={resolved ?? rawTarget}
            disabled={!resolved || !onNavigatePath}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (resolved) onNavigatePath?.(resolved);
            }}
          >
            {children}
          </button>
        );
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
    },
  }), [knownPaths, onNavigatePath, path]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const metaRows = [
    { label: "title", value: parsed.metadata.title },
    { label: "type", value: parsed.metadata.type, kind: "pill" },
    { label: "tags", value: parsed.metadata.tags, kind: "tags" },
    { label: "sources", value: parsed.metadata.sources || path },
    { label: "updated", value: parsed.metadata.updated || (!loading && !error ? t("filePreview.lines", { count: String(stats.lines) }) : "") },
  ];

  return (
    <div className="file-preview-backdrop" onClick={onClose} role="presentation">
      <div className="file-preview-modal" role="dialog" aria-modal="true" aria-label={t("filePreview.previewPath", { path })} onClick={(event) => event.stopPropagation()}>
        <div className="file-preview-topbar">
          <button className="file-preview-back" onClick={onClose} type="button">← Back</button>
          <button className="file-preview-close" onClick={onClose} aria-label={t("filePreview.close")}>&times;</button>
        </div>
        <div ref={scrollRef} className="file-preview-scroll file-preview-scroll-custom">
          <div className="file-preview-info-card">
            {metaRows.map((row) => (
              <div className="file-preview-info-row" key={row.label}>
                <span className="file-preview-info-label">{row.label}</span>
                <span className="file-preview-info-value">
                  {row.kind === "tags" && Array.isArray(row.value) ? (
                    row.value.length ? row.value.map((tag) => <span className="file-preview-tag" key={tag}>{tag}</span>) : <span className="file-preview-muted">—</span>
                  ) : row.kind === "pill" ? (
                    <span className="file-preview-type-pill">{String(row.value || (isMarkdown ? t("filePreview.markdown") : t("filePreview.plainText")))}</span>
                  ) : (
                    String(row.value || "—")
                  )}
                </span>
              </div>
            ))}
          </div>
          {loading ? (
            <div className="file-preview-skeleton">
              <span />
              <span />
              <span />
              <span />
            </div>
          ) : error ? (
            <div className="file-preview-error">{error}</div>
          ) : !isMarkdown ? (
            <pre className="file-preview-plain">{content || t("filePreview.empty")}</pre>
          ) : (
            <div className="file-preview-markdown">
              <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{renderedMarkdown}</Markdown>
            </div>
          )}
        </div>
        <CustomScrollIndicator viewportRef={scrollRef} className="file-preview-scroll-indicator" />
      </div>
    </div>
  );
}
