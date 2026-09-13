import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "../env";
import { CONTENT_ROOT, LEGACY_CONTENT_ROOT, resolveWorkspaceFile, writeFile } from "../ontologies/workspace";

const execFileAsync = promisify(execFile);

interface KnowledgeGraphNode {
  id: string;
  label: string;
  path: string;
  type: string;
  group: string;
  degree?: number;
}

interface KnowledgeGraphEdge {
  source?: string;
  target?: string;
  from?: string;
  to?: string;
  type: string;
  label?: string;
}

export interface KnowledgeGraphBuildResult {
  graphPath: string;
  htmlPath: string;
  html: string;
  graph: {
    built: string;
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
    stats: {
      nodeCount: number;
      edgeCount: number;
      types: Record<string, number>;
    };
  };
}

interface MarkdownPage {
  id: string;
  path: string;
  label: string;
  type: string;
  group: string;
  content: string;
}

const graphExcludedFilenames = new Set(["index.md", "log.md", "lint-report.md", "overview.md", "glossary.md"]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function contentRootForGraph(root: string): Promise<string> {
  if (await exists(resolveWorkspaceFile(root, CONTENT_ROOT))) return CONTENT_ROOT;
  if (await exists(resolveWorkspaceFile(root, LEGACY_CONTENT_ROOT))) return LEGACY_CONTENT_ROOT;
  return CONTENT_ROOT;
}

function stripFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  if (!content.startsWith("---\n")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: content };
  const raw = content.slice(4, end).trim();
  const frontmatter: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) continue;
    frontmatter[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return { frontmatter, body: content.slice(end + 5) };
}

function pageTitle(filePath: string, content: string, frontmatter: Record<string, string>): string {
  if (frontmatter.title) return frontmatter.title;
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return path.posix.basename(filePath, path.posix.extname(filePath)).replace(/[-_]+/g, " ");
}

function normalizeTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^\.\//, "")
    .replace(/^knowledge\//, "")
    .replace(/^wiki\//, "")
    .replace(/\.md$/i, "")
    .toLowerCase();
}

function labelsForPage(page: MarkdownPage): string[] {
  const withoutRoot = page.path.replace(/^knowledge\//, "").replace(/^wiki\//, "");
  const withoutExt = withoutRoot.replace(/\.md$/i, "");
  const base = path.posix.basename(withoutExt);
  return [page.id, page.path, withoutRoot, withoutExt, base, page.label].map(normalizeTarget);
}

function resolveLink(rawTarget: string, labels: Map<string, string>): string | null {
  const clean = rawTarget.split("#")[0]?.split("|")[0]?.trim() ?? "";
  if (!clean) return null;
  const normalized = normalizeTarget(clean);
  return labels.get(normalized) ?? labels.get(normalizeTarget(path.posix.basename(clean))) ?? null;
}

async function collectMarkdownPages(root: string, contentRoot: string): Promise<MarkdownPage[]> {
  const pages: MarkdownPage[] = [];
  async function visit(relativeDir: string): Promise<void> {
    const absoluteDir = resolveWorkspaceFile(root, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relativePath = path.posix.join(relativeDir.replace(/\\/g, "/"), entry.name);
      if (entry.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      if (graphExcludedFilenames.has(entry.name.toLowerCase())) continue;
      const content = await fs.readFile(resolveWorkspaceFile(root, relativePath), "utf-8");
      const { frontmatter, body } = stripFrontmatter(content);
      const id = relativePath.replace(/^knowledge\//, "").replace(/^wiki\//, "").replace(/\.md$/i, "");
      const parts = id.split("/");
      pages.push({
        id,
        path: relativePath,
        label: pageTitle(relativePath, body, frontmatter),
        type: frontmatter.type || (parts.length > 1 ? parts[0] : "page"),
        group: parts.length > 1 ? parts[0] : "root",
        content,
      });
    }
  }
  await visit(contentRoot);
  return pages.sort((a, b) => a.path.localeCompare(b.path));
}

function buildHtml(projectName: string, graph: KnowledgeGraphBuildResult["graph"]): string {
  const typeEntries = Object.entries(graph.stats.types).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const hubs = [...graph.nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0) || a.label.localeCompare(b.label)).slice(0, 12);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(projectName)} Knowledge Graph</title>
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
:root { color-scheme: light; --ink:#17211b; --muted:#6d756f; --line:#d9ded8; --line-soft:rgba(23,33,27,.08); --paper:#f6f3ec; --panel:#fffdf8; --panel-glass:rgba(255,253,248,.88); --panel-canvas:rgba(255,253,248,.65); --accent:#2f6f4e; --accent-2:#b8792d; --focus:rgba(47,111,78,.13); --shadow:0 24px 80px rgba(23,33,27,.10); --node-fill:#fff; --node-text-stroke:#fffdf8; --edge:#aeb8af; --match:#fff1cc; }
html[data-theme="dark"] { color-scheme: dark; --ink:#e5eaf3; --muted:#9aa5b5; --line:#2d354a; --line-soft:rgba(226,232,240,.10); --paper:#0f1220; --panel:#151a2b; --panel-glass:rgba(21,26,43,.90); --panel-canvas:rgba(21,26,43,.62); --accent:#64a7ff; --accent-2:#f0b35d; --focus:rgba(100,167,255,.18); --shadow:0 24px 80px rgba(0,0,0,.28); --node-fill:#151a2b; --node-text-stroke:#0f1220; --edge:#596277; --match:#3a2f1b; }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; font-family: Charter, Georgia, serif; color:var(--ink); background: var(--paper); }
.shell { display:grid; grid-template-columns: 320px 1fr; min-height:100vh; }
aside { border-right:1px solid var(--line); background:var(--panel-glass); backdrop-filter: blur(16px); padding:28px; overflow:auto; }
main { position:relative; overflow:hidden; padding:28px; }
.title-row { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
h1 { margin:0 0 8px; font-size:30px; letter-spacing:-.04em; line-height:1; }
.theme-toggle { position:relative; flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border:0; border-radius:0; background:transparent; color:var(--ink); cursor:pointer; }
.theme-toggle:hover { color:var(--accent); }
.theme-toggle svg { width:18px; height:18px; pointer-events:none; }
.theme-toggle::after { content:attr(data-tooltip); position:absolute; top:calc(100% + 8px); right:0; padding:6px 8px; border-radius:6px; background:var(--ink); color:var(--panel); font:12px/1 ui-sans-serif,system-ui,sans-serif; white-space:nowrap; opacity:0; transform:translateY(-2px); pointer-events:none; transition:opacity 80ms ease, transform 80ms ease; z-index:40; }
.theme-toggle:hover::after, .theme-toggle:focus-visible::after { opacity:1; transform:translateY(0); }
.meta { color:var(--muted); font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
.stats { display:grid; grid-template-columns: repeat(2,1fr); gap:10px; margin:24px 0; }
.stat { border:1px solid var(--line); border-radius:18px; padding:14px; background:var(--panel); }
.stat strong { display:block; font-size:24px; letter-spacing:-.04em; }
.stat span { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
section { margin-top:24px; }
h2 { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--muted); text-transform:uppercase; letter-spacing:.12em; margin:0 0 12px; }
.chip { display:inline-flex; margin:0 6px 6px 0; padding:7px 10px; border:1px solid var(--line); border-radius:999px; background:var(--panel); font-size:13px; }
.hub { display:grid; grid-template-columns: 1fr auto; gap:12px; padding:10px 0; border-bottom:1px solid var(--line-soft); font-size:14px; }
.hub small { display:block; color:var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow:hidden; text-overflow:ellipsis; }
.controls { display:flex; gap:10px; margin-bottom:18px; }
input { width:min(520px, 100%); border:1px solid var(--line); border-radius:999px; background:var(--panel-glass); color:var(--ink); padding:12px 16px; font:14px ui-monospace, SFMono-Regular, Menlo, monospace; outline:none; }
input:focus { border-color:var(--accent); box-shadow:0 0 0 4px var(--focus); }
.canvas { width:100%; height:calc(100vh - 92px); border:1px solid var(--line); border-radius:28px; background:var(--panel-canvas); box-shadow:var(--shadow); }
.edge { stroke:var(--edge); stroke-width:1.1; opacity:.58; }
.node circle { fill:var(--node-fill); stroke:var(--accent); stroke-width:1.8; filter: drop-shadow(0 8px 10px rgba(0,0,0,.14)); }
.node text { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; fill:var(--ink); paint-order:stroke; stroke:var(--node-text-stroke); stroke-width:4px; stroke-linejoin:round; }
.node.dim, .edge.dim { opacity:.12; }
.node.match circle { fill:var(--match); stroke:var(--accent-2); stroke-width:2.8; }
.empty { padding:48px; color:var(--muted); }
@media (max-width: 900px) { .shell { grid-template-columns: 1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } .canvas { height:70vh; } }
</style>
</head>
<body>
<div class="shell">
  <aside>
    <div class="title-row"><h1>${escapeHtml(projectName)} Graph</h1><button id="theme-toggle" class="theme-toggle" type="button" onclick="toggleGraphTheme()" aria-label="Toggle color mode"></button></div>
    <div class="meta">Built ${escapeHtml(graph.built)}</div>
    <div class="stats">
      <div class="stat"><strong>${graph.stats.nodeCount}</strong><span>nodes</span></div>
      <div class="stat"><strong>${graph.stats.edgeCount}</strong><span>edges</span></div>
    </div>
    <section><h2>Types</h2>${typeEntries.map(([name, count]) => `<span class="chip">${escapeHtml(name)} &middot; ${count}</span>`).join("") || "<p class='meta'>No types found.</p>"}</section>
    <section><h2>Hubs</h2>${hubs.map((node) => `<div class="hub"><div>${escapeHtml(node.label)}<small>${escapeHtml(node.path)}</small></div><strong>${node.degree}</strong></div>`).join("") || "<p class='meta'>No hubs yet.</p>"}</section>
  </aside>
  <main>
    <div class="controls"><input id="search" placeholder="Search nodes..." autocomplete="off" /></div>
    <svg id="graph" class="canvas" viewBox="0 0 1100 760" role="img" aria-label="Knowledge graph visualization"></svg>
  </main>
</div>
<script>
let activeTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
const themeIcons = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.99 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.78 9.79Z"></path></svg>',
};
function setGraphTheme(theme) {
  activeTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', activeTheme);
  const button = document.getElementById('theme-toggle');
  if (button) {
    const next = activeTheme === 'dark' ? 'light' : 'dark';
    button.innerHTML = activeTheme === 'dark' ? themeIcons.sun : themeIcons.moon;
    button.dataset.tooltip = 'Switch to ' + next + ' mode';
    button.setAttribute('aria-label', 'Switch to ' + next + ' mode');
    button.setAttribute('aria-pressed', activeTheme === 'dark' ? 'true' : 'false');
  }
}
function toggleGraphTheme() { setGraphTheme(activeTheme === 'dark' ? 'light' : 'dark'); }
setGraphTheme(activeTheme);
const graph = ${safeJsonForHtml(graph)};
const svg = document.getElementById('graph');
const width = 1100, height = 760, cx = width / 2, cy = height / 2;
const nodes = graph.nodes.map((node, index) => {
  const ring = 170 + (index % 3) * 92;
  const angle = (index / Math.max(graph.nodes.length, 1)) * Math.PI * 2 + (index % 3) * .34;
  return { ...node, x: cx + Math.cos(angle) * ring, y: cy + Math.sin(angle) * ring };
});
const byId = new Map(nodes.map(node => [node.id, node]));
function add(tag, attrs, parent = svg) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  parent.appendChild(el);
  return el;
}
if (!nodes.length) {
  const text = add('text', { x: 80, y: 100, class: 'empty' });
  text.textContent = 'No markdown knowledge pages found.';
} else {
  graph.edges.forEach(edge => {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (!source || !target) return;
    add('line', { x1: source.x, y1: source.y, x2: target.x, y2: target.y, class: 'edge', 'data-source': edge.source, 'data-target': edge.target });
  });
  nodes.forEach(node => {
    const group = add('g', { class: 'node', transform: 'translate(' + node.x + ' ' + node.y + ')', 'data-id': node.id, 'data-label': node.label.toLowerCase(), 'data-path': node.path.toLowerCase() });
    add('circle', { r: Math.max(10, Math.min(28, 10 + node.degree * 3)) }, group);
    const label = add('text', { x: 16, y: 4 }, group);
    label.textContent = node.label.length > 34 ? node.label.slice(0, 31) + '...' : node.label;
    group.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'title')).textContent = node.path + ' - degree ' + node.degree;
  });
}
document.getElementById('search').addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll('.node').forEach((node) => {
    const match = !query || node.dataset.label.includes(query) || node.dataset.path.includes(query);
    node.classList.toggle('dim', Boolean(query && !match));
    node.classList.toggle('match', Boolean(query && match));
  });
  document.querySelectorAll('.edge').forEach((edge) => {
    if (!query) { edge.classList.remove('dim'); return; }
    const source = document.querySelector('.node[data-id="' + CSS.escape(edge.dataset.source) + '"]');
    const target = document.querySelector('.node[data-id="' + CSS.escape(edge.dataset.target) + '"]');
    edge.classList.toggle('dim', !(source?.classList.contains('match') || target?.classList.contains('match')));
  });
});
</script>
</body>
</html>`;
}

async function copyTemplateGraphTool(root: string): Promise<string | null> {
  const workspaceTool = resolveWorkspaceFile(root, "tools/build_graph.py");
  const templateTool = path.resolve(env.initialWikiSource, "tools/build_graph.py");
  if (!(await exists(templateTool))) return null;

  await fs.mkdir(path.dirname(workspaceTool), { recursive: true });
  await fs.copyFile(templateTool, workspaceTool);
  return workspaceTool;
}

function graphStats(graph: { nodes?: KnowledgeGraphNode[]; edges?: KnowledgeGraphEdge[] }) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const degree = new Map<string, number>();
  for (const edge of edges) {
    const source = edge.source ?? edge.from;
    const target = edge.target ?? edge.to;
    if (source) degree.set(source, (degree.get(source) ?? 0) + 1);
    if (target) degree.set(target, (degree.get(target) ?? 0) + 1);
  }
  for (const node of nodes) node.degree = node.degree ?? degree.get(node.id) ?? 0;
  const types = nodes.reduce<Record<string, number>>((acc, node) => {
    const type = node.type || "unknown";
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});
  return { nodeCount: nodes.length, edgeCount: edges.length, types };
}

async function buildKnowledgeGraphWithScript(root: string): Promise<KnowledgeGraphBuildResult | null> {
  const script = await copyTemplateGraphTool(root);
  if (!script) return null;

  const python = process.env.GRAPH_PYTHON ?? process.env.MARKITDOWN_PYTHON ?? "python3";
  await execFileAsync(python, ["tools/build_graph.py", "--no-infer"], {
    cwd: root,
    timeout: Number(process.env.GRAPH_BUILD_TIMEOUT_MS ?? 120_000),
    maxBuffer: 8 * 1024 * 1024,
  });

  const graphPath = "graph/graph.json";
  const htmlPath = "graph/graph.html";
  const graphFile = resolveWorkspaceFile(root, graphPath);
  const htmlFile = resolveWorkspaceFile(root, htmlPath);
  const [rawGraph, html] = await Promise.all([
    fs.readFile(graphFile, "utf-8"),
    fs.readFile(htmlFile, "utf-8"),
  ]);
  const graph = JSON.parse(rawGraph) as KnowledgeGraphBuildResult["graph"];
  graph.stats = graphStats(graph);
  return { graphPath, htmlPath, html, graph };
}

export async function buildKnowledgeGraph(root: string, projectName: string): Promise<KnowledgeGraphBuildResult> {
  const scripted = await buildKnowledgeGraphWithScript(root).catch((error) => {
    console.warn("[knowledge-graph] tools/build_graph.py failed; falling back to TypeScript graph builder.", error instanceof Error ? error.message : error);
    return null;
  });
  if (scripted) return scripted;

  const contentRoot = await contentRootForGraph(root);
  const pages = await collectMarkdownPages(root, contentRoot);
  const labels = new Map<string, string>();
  for (const page of pages) {
    for (const label of labelsForPage(page)) labels.set(label, page.id);
  }

  const edges: KnowledgeGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const page of pages) {
    const matches = page.content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]|\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/g);
    for (const match of matches) {
      const target = resolveLink(match[1] ?? match[2] ?? "", labels);
      if (!target || target === page.id) continue;
      const key = `${page.id}->${target}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ source: page.id, target, type: "EXTRACTED", label: "links_to" });
    }
  }

  const degree = new Map<string, number>();
  for (const edge of edges) {
    if (edge.source) degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    if (edge.target) degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const nodes: KnowledgeGraphNode[] = pages.map((page) => ({
    id: page.id,
    label: page.label,
    path: page.path,
    type: page.type,
    group: page.group,
    degree: degree.get(page.id) ?? 0,
  }));
  const types = nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.type] = (acc[node.type] ?? 0) + 1;
    return acc;
  }, {});
  const graph = {
    built: new Date().toISOString(),
    nodes,
    edges,
    stats: { nodeCount: nodes.length, edgeCount: edges.length, types },
  };
  const html = buildHtml(projectName, graph);
  await writeFile(root, "graph/graph.json", `${JSON.stringify(graph, null, 2)}\n`);
  await writeFile(root, "graph/graph.html", html);
  await fs.appendFile(resolveWorkspaceFile(root, `${contentRoot}/log.md`), `\n\n## ${new Date().toISOString().slice(0, 10)} graph | Knowledge graph rebuilt\n`, "utf-8").catch(async () => {
    await writeFile(root, `${contentRoot}/log.md`, `# Knowledge Log\n\n## ${new Date().toISOString().slice(0, 10)} graph | Knowledge graph rebuilt\n`);
  });
  return { graphPath: "graph/graph.json", htmlPath: "graph/graph.html", html, graph };
}
