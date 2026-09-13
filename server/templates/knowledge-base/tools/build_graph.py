#!/usr/bin/env python3
"""
Build the knowledge graph from knowledge pages.

Usage:
    python tools/build_graph.py               # full rebuild
    python tools/build_graph.py --no-infer    # skip semantic inference (faster)
    python tools/build_graph.py --open        # open graph.html in browser after build

Outputs:
    graph/graph.json    — node/edge data (cached by SHA256)
    graph/graph.html    — interactive vis.js visualization

Edge types:
    EXTRACTED   — explicit [[link]] in a page
    INFERRED    — Claude-detected implicit relationship
    AMBIGUOUS   — low-confidence inferred relationship
"""

import re
import json
import hashlib
import argparse
import statistics
import webbrowser
from pathlib import Path
from datetime import date

import os

try:
    import networkx as nx
    from networkx.algorithms import community as nx_community
    HAS_NETWORKX = True
except ImportError:
    HAS_NETWORKX = False
    print("Warning: networkx not installed. Community detection disabled. Run: pip install networkx")

REPO_ROOT = Path(__file__).parent.parent
KNOWLEDGE_DIR = REPO_ROOT / "knowledge"
GRAPH_DIR = REPO_ROOT / "graph"
GRAPH_JSON = GRAPH_DIR / "graph.json"
GRAPH_HTML = GRAPH_DIR / "graph.html"
CACHE_FILE = GRAPH_DIR / ".cache.json"
INFERRED_EDGES_FILE = GRAPH_DIR / ".inferred_edges.jsonl"
LOG_FILE = KNOWLEDGE_DIR / "log.md"
SCHEMA_FILE = REPO_ROOT / "CLAUDE.md"
GRAPH_EXCLUDED_FILENAMES = {"index.md", "log.md", "lint-report.md", "overview.md", "glossary.md"}

# Node type → color mapping
TYPE_COLORS = {
    "sources": "#4CAF50",
    "business_capabilities": "#2196F3",
    "business_flows": "#FF9800",
    "business_objects": "#9C27B0",
    "interfaces": "#00BCD4",
    "rules": "#F44336",
    "syntheses": "#E91E63",
    "unknown": "#9E9E9E",
}

TYPE_FALLBACK_COLORS = [
    "#4CAF50", "#2196F3", "#FF9800", "#9C27B0", "#00BCD4",
    "#F44336", "#E91E63", "#7E57C2", "#26A69A", "#EF6C00",
    "#5C6BC0", "#66BB6A", "#EC407A", "#78909C",
]

EDGE_COLORS = {
    "EXTRACTED": "#555555",
    "INFERRED": "#FF5722",
    "AMBIGUOUS": "#BDBDBD",
}


def read_file(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def call_llm(prompt: str, model_env: str, default_model: str, max_tokens: int = 4096) -> str:
    try:
        from litellm import completion
    except ImportError:
        print("Error: litellm not installed. Run: pip install litellm")
        import sys
        sys.exit(1)

    model = os.getenv(model_env, default_model)

    kwargs = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}]
    }

    if max_tokens:
        kwargs["max_tokens"] = max_tokens

    response = completion(**kwargs)
    return response.choices[0].message.content


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def all_knowledge_pages() -> list[Path]:
    return [p for p in KNOWLEDGE_DIR.rglob("*.md")
            if p.name not in GRAPH_EXCLUDED_FILENAMES]


def extract_links(content: str) -> list[str]:
    return list(set(re.findall(r'\[\[([^\]]+)\]\]', content)))


def extract_frontmatter_type(content: str) -> str:
    match = re.search(r'^type:\s*(.+?)\s*$', content, re.MULTILINE)
    if not match:
        return ""
    raw = match.group(1).strip()
    if not raw or raw in ("null", "~"):
        return ""
    if raw[0] in ("'", '"') and raw[-1:] == raw[0]:
        return raw[1:-1].strip()
    return raw.split(" #", 1)[0].strip().strip('"\'')


def color_for_type(node_type: str) -> str:
    if node_type in TYPE_COLORS:
        return TYPE_COLORS[node_type]
    digest = int(hashlib.sha256(node_type.encode()).hexdigest()[:8], 16)
    return TYPE_FALLBACK_COLORS[digest % len(TYPE_FALLBACK_COLORS)]


def resolve_node_type(path: Path, content: str) -> str:
    """Resolve node type from frontmatter or directory path."""
    fm_type = extract_frontmatter_type(content)
    if fm_type:
        return fm_type
    # Infer from directory
    rel = path.relative_to(KNOWLEDGE_DIR).parts
    if len(rel) > 1:
        directory = rel[0]
        if directory in TYPE_COLORS:
            return directory
    return fm_type or "unknown"


def page_id(path: Path) -> str:
    return path.relative_to(KNOWLEDGE_DIR).as_posix().replace(".md", "")


def edge_id(src: str, target: str, edge_type: str) -> str:
    return f"{src}->{target}:{edge_type}"


def load_cache() -> dict:
    if CACHE_FILE.exists():
        try:
            return json.loads(CACHE_FILE.read_text())
        except (json.JSONDecodeError, IOError):
            return {}
    return {}


def save_cache(cache: dict):
    GRAPH_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps(cache, indent=2))


def build_nodes(pages: list[Path]) -> list[dict]:
    nodes = []
    for p in pages:
        content = read_file(p)
        node_type = resolve_node_type(p, content)
        title_match = re.search(r'^title:\s*"?([^"\n]+)"?', content, re.MULTILINE)
        label = title_match.group(1).strip() if title_match else p.stem
        body = re.sub(r"^---\n.*?\n---\n?", "", content, flags=re.DOTALL)
        preview_lines = [line.strip() for line in body.splitlines() if line.strip()]
        preview = " ".join(preview_lines[:3])[:220]
        nodes.append({
            "id": page_id(p),
            "label": label,
            "type": node_type,
            "color": color_for_type(node_type),
            "path": str(p.relative_to(REPO_ROOT)),
            "markdown": content,
            "preview": preview,
        })
    return nodes


def build_extracted_edges(pages: list[Path]) -> list[dict]:
    """Pass 1: deterministic [[link]] edges."""
    # Build a map from stem (lower) -> page_id for resolution
    stem_map = {p.stem.lower(): page_id(p) for p in pages}
    edges = []
    seen = set()
    for p in pages:
        content = read_file(p)
        src = page_id(p)
        for link in extract_links(content):
            target = stem_map.get(link.lower())
            if target and target != src:
                key = (src, target)
                if key not in seen:
                    seen.add(key)
                    edges.append({
                        "id": edge_id(src, target, "EXTRACTED"),
                        "from": src,
                        "to": target,
                        "type": "EXTRACTED",
                        "color": EDGE_COLORS["EXTRACTED"],
                        "confidence": 1.0,
                    })
    return edges


def load_checkpoint() -> tuple[list[dict], set[str]]:
    """Load previously inferred edges from JSONL checkpoint file."""
    edges = []
    completed = set()
    if INFERRED_EDGES_FILE.exists():
        for line in INFERRED_EDGES_FILE.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                record = json.loads(line)
                completed.add(record["page_id"])
                for edge in record.get("edges", []):
                    if not isinstance(edge, dict) or "from" not in edge or "to" not in edge:
                        continue
                    rel_type = edge.get("type", "INFERRED")
                    edges.append({
                        "id": edge.get("id", edge_id(edge["from"], edge["to"], rel_type)),
                        "from": edge["from"],
                        "to": edge["to"],
                        "type": rel_type,
                        "title": edge.get("title", edge.get("relationship", "")),
                        "label": edge.get("label", ""),
                        "color": edge.get("color", EDGE_COLORS.get(rel_type, EDGE_COLORS["INFERRED"])),
                        "confidence": float(edge.get("confidence", 0.7)),
                    })
            except (json.JSONDecodeError, KeyError):
                continue
    return edges, completed


def append_checkpoint(page_id_str: str, edges: list[dict]):
    """Append one page's inferred edges to the JSONL checkpoint."""
    GRAPH_DIR.mkdir(parents=True, exist_ok=True)
    record = {"page_id": page_id_str, "edges": edges, "ts": date.today().isoformat()}
    with open(INFERRED_EDGES_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def build_inferred_edges(pages: list[Path], existing_edges: list[dict], cache: dict, resume: bool = True) -> list[dict]:
    """Pass 2: API-inferred semantic relationships with checkpoint/resume."""
    checkpoint_edges, completed_ids = ([], set())
    if resume:
        checkpoint_edges, completed_ids = load_checkpoint()
        if completed_ids:
            print(f"  checkpoint: {len(completed_ids)} pages already done, {len(checkpoint_edges)} edges loaded")

    new_edges = list(checkpoint_edges)

    changed_pages = []
    for p in pages:
        content = read_file(p)
        h = sha256(content)
        pid = page_id(p)
        entry = cache.get(str(p))

        if pid in completed_ids:
            continue

        if isinstance(entry, dict) and entry.get("hash") == h:
            for rel in entry.get("edges", []):
                rel_type = rel.get("type", "INFERRED")
                confidence = float(rel.get("confidence", 0.7))
                new_edges.append({
                    "id": edge_id(pid, rel["to"], rel_type),
                    "from": pid,
                    "to": rel["to"],
                    "type": rel_type,
                    "title": rel.get("relationship", ""),
                    "label": "",
                    "color": EDGE_COLORS.get(rel_type, EDGE_COLORS["INFERRED"]),
                    "confidence": confidence,
                })
        else:
            changed_pages.append(p)

    if not changed_pages:
        print("  no changed pages — skipping semantic inference")
        return new_edges

    total_pages = len(changed_pages)
    already_done = len(completed_ids)
    grand_total = total_pages + already_done
    print(f"  inferring relationships for {total_pages} remaining pages (of {grand_total} total)...")

    # Build a summary of existing nodes for context
    node_list = "\n".join(f"- {page_id(p)} ({extract_frontmatter_type(read_file(p))})" for p in pages)
    existing_edge_summary = "\n".join(
        f"- {e['from']} → {e['to']} (EXTRACTED)" for e in existing_edges[:30]
    )

    for i, p in enumerate(changed_pages, 1):
        full_content = read_file(p)
        content = full_content[:2000]
        src = page_id(p)
        global_idx = already_done + i
        print(f"    [{global_idx}/{grand_total}] Inferring for '{src}'... ", end="", flush=True)

        prompt = f"""Analyze this knowledge page and identify implicit semantic relationships to other pages.

Source page: {src}
Content:
{content}

All available pages:
{node_list}

Already-extracted edges from this page:
{existing_edge_summary}

Return ONLY a JSON object containing an "edges" array of NEW relationships not already captured by explicit [[links]]. The response must be STRICTLY valid JSON formatted exactly like this:
{{
  "edges": [
    {{"to": "page-id", "relationship": "one-line description", "confidence": 0.0-1.0, "type": "INFERRED or AMBIGUOUS"}}
  ]
}}

CRITICAL INSTRUCTION:
YOU MUST RETURN ONLY A RAW JSON STRING BEGINNING WITH {{ AND ENDING WITH }}.
DO NOT OUTPUT BULLET POINTS. DO NOT OUTPUT MARKDOWN LISTS.
ANY CONVERSATIONAL PREAMBLE WILL CAUSE A SYSTEM CRASH.

Rules:
- Only include pages from the available list above
- Confidence >= 0.7 → INFERRED, < 0.7 → AMBIGUOUS
- Do not repeat edges already in the extracted list
- Return {{"edges": []}} if no new relationships found
"""
        page_edges = []
        valid_rels = []
        try:
            raw = call_llm(prompt, "LLM_MODEL_FAST", "claude-3-5-haiku-latest", max_tokens=1024)
            raw = raw.strip()

            match = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", raw)
            if match:
                raw = match.group(0)
            else:
                raw = re.sub(r"^```(?:json)?\s*", "", raw)
                raw = re.sub(r"\s*```$", "", raw)

            inferred = json.loads(raw)
            if isinstance(inferred, dict):
                edges_list = inferred.get("edges", [])
            elif isinstance(inferred, list):
                edges_list = inferred
            else:
                edges_list = []

            for rel in edges_list:
                if isinstance(rel, dict) and "to" in rel:
                    confidence = float(rel.get("confidence", 0.7))
                    rel_type = rel.get("type") or ("INFERRED" if confidence >= 0.7 else "AMBIGUOUS")
                    edge = {
                        "id": edge_id(src, rel["to"], rel_type),
                        "from": src,
                        "to": rel["to"],
                        "type": rel_type,
                        "title": rel.get("relationship", ""),
                        "label": "",
                        "color": EDGE_COLORS.get(rel_type, EDGE_COLORS["INFERRED"]),
                        "confidence": confidence,
                    }
                    page_edges.append(edge)
                    new_edges.append(edge)
                    valid_rels.append({
                        "to": rel["to"],
                        "relationship": rel.get("relationship", ""),
                        "confidence": confidence,
                        "type": rel_type,
                    })

            cache[str(p)] = {
                "hash": sha256(full_content),
                "edges": valid_rels,
            }
            append_checkpoint(src, page_edges)
            print(f"-> Found {len(page_edges)} edges.")
        except (json.JSONDecodeError, TypeError, ValueError) as jde:
            print(f"-> [WARN] Invalid JSON: {str(jde)[:60]}")
        except Exception as e:
            err_msg = str(e).replace('\n', ' ')[:80]
            print(f"-> [ERROR] {err_msg}")

    return new_edges


def deduplicate_edges(edges: list[dict]) -> list[dict]:
    """Merge duplicate and bidirectional edges, keeping highest confidence."""
    best = {}  # (min(a,b), max(a,b)) -> edge
    for e in edges:
        a, b = e["from"], e["to"]
        key = (min(a, b), max(a, b))
        existing = best.get(key)
        if not existing or e.get("confidence", 0) > existing.get("confidence", 0):
            best[key] = e
    deduped = []
    for edge in best.values():
        rel_type = edge.get("type", "INFERRED")
        edge["id"] = edge.get("id", edge_id(edge["from"], edge["to"], rel_type))
        edge["color"] = edge.get("color", EDGE_COLORS.get(rel_type, EDGE_COLORS["INFERRED"]))
        edge["confidence"] = float(edge.get("confidence", 0.7 if rel_type != "EXTRACTED" else 1.0))
        edge.setdefault("title", "")
        edge.setdefault("label", "")
        deduped.append(edge)
    return deduped


def detect_communities(nodes: list[dict], edges: list[dict]) -> dict[str, int]:
    """Assign community IDs to nodes using Louvain algorithm."""
    if not HAS_NETWORKX:
        return {}

    G = nx.Graph()
    for n in nodes:
        G.add_node(n["id"])
    for e in edges:
        G.add_edge(e["from"], e["to"])

    if G.number_of_edges() == 0:
        return {}

    try:
        communities = nx_community.louvain_communities(G, seed=42)
        node_to_community = {}
        for i, comm in enumerate(communities):
            for node in comm:
                node_to_community[node] = i
        return node_to_community
    except Exception:
        return {}


def generate_report(nodes: list[dict], edges: list[dict], communities: dict[str, int]) -> str:
    """Generate a structured graph health report.

    Analyzes the graph for orphan nodes, hub pages (god nodes),
    fragile inter-community bridges, and overall connectivity health.
    """
    today = date.today().isoformat()
    n_nodes = len(nodes)
    n_edges = len(edges)

    if n_nodes == 0:
        return f"# Graph Insights Report — {today}\n\nKnowledge is empty — nothing to report.\n"

    # Build NetworkX graph for analysis
    G = nx.Graph()
    for n in nodes:
        G.add_node(n["id"])
    for e in edges:
        G.add_edge(e["from"], e["to"])

    # --- Metrics ---
    degrees = dict(G.degree())
    edges_per_node = n_edges / n_nodes if n_nodes else 0
    density = nx.density(G)

    # Health rating
    if edges_per_node >= 2.0:
        health = "✅ healthy"
    elif edges_per_node >= 1.0:
        health = "⚠️ warning"
    else:
        health = "🔴 critical"

    # Orphans: degree == 0
    orphans = sorted([n for n, d in degrees.items() if d == 0])
    orphan_count = len(orphans)
    orphan_pct = (orphan_count / n_nodes * 100) if n_nodes else 0

    # God nodes: degree > mean + 2*std
    deg_values = list(degrees.values())
    mean_deg = statistics.mean(deg_values) if deg_values else 0
    std_deg = statistics.stdev(deg_values) if len(deg_values) > 1 else 0
    god_threshold = mean_deg + 2 * std_deg
    god_nodes = sorted(
        [(n, d) for n, d in degrees.items() if d > god_threshold],
        key=lambda x: x[1],
        reverse=True,
    )

    # Community stats
    community_count = len(set(communities.values())) if communities else 0
    comm_members: dict[int, list[str]] = {}
    for node_id, comm_id in communities.items():
        comm_members.setdefault(comm_id, []).append(node_id)

    # Fragile bridges: community pairs connected by exactly 1 edge
    cross_comm_edges: dict[tuple[int, int], list[dict]] = {}
    for e in edges:
        ca = communities.get(e["from"], -1)
        cb = communities.get(e["to"], -1)
        if ca >= 0 and cb >= 0 and ca != cb:
            key = (min(ca, cb), max(ca, cb))
            cross_comm_edges.setdefault(key, []).append(e)
    fragile_bridges = [
        (pair, edge_list[0])
        for pair, edge_list in sorted(cross_comm_edges.items())
        if len(edge_list) == 1
    ]

    # --- Build report ---
    lines = [
        f"# Graph Insights Report — {today}",
        "",
        "## Health Summary",
        f"- **{n_nodes}** nodes, **{n_edges}** edges ({edges_per_node:.2f} edges/node — {health})",
        f"- **{orphan_count}** orphan nodes ({orphan_pct:.1f}%) — target: <10%",
        f"- **{community_count}** communities",
        f"- Link density: {density:.4f}",
        "",
    ]

    # Orphan section
    lines.append(f"## 🔴 Orphan Nodes ({orphan_count} pages, {orphan_pct:.1f}%)")
    if orphans:
        lines.append("These pages have zero graph connections. Consider adding [[links]]:")
        for o in orphans:
            lines.append(f"- `{o}`")
    else:
        lines.append("No orphan nodes — excellent!")
    lines.append("")

    # God nodes section
    lines.append("## 🟡 God Nodes (Hub Pages)")
    if god_nodes:
        lines.append("These nodes carry disproportionate connectivity (degree > μ+2σ). Verify they are comprehensive:")
        lines.append("")
        lines.append("| Node | Degree | % of Edges | Community |")
        lines.append("|---|---|---|---|")
        for node_id, deg in god_nodes:
            edge_pct = (deg / (2 * n_edges) * 100) if n_edges else 0
            comm = communities.get(node_id, -1)
            lines.append(f"| `{node_id}` | {deg} | {edge_pct:.1f}% | {comm} |")
    else:
        lines.append("No god nodes detected — degree distribution is balanced.")
    lines.append("")

    # Fragile bridges section
    lines.append("## 🟡 Fragile Bridges")
    if fragile_bridges:
        lines.append("Community pairs connected by only 1 edge — one deleted link breaks them:")
        for (ca, cb), edge in fragile_bridges:
            lines.append(f"- Community {ca} ↔ Community {cb} via `{edge['from']}` → `{edge['to']}`")
    else:
        lines.append("No fragile bridges — all community connections are redundant.")
    lines.append("")

    # Community overview
    lines.append("## 🟢 Community Overview")
    if comm_members:
        lines.append("")
        lines.append("| Community | Nodes | Key Members |")
        lines.append("|---|---|---|")
        for comm_id in sorted(comm_members.keys()):
            members = comm_members[comm_id]
            # Sort by degree descending to show key members first
            members_sorted = sorted(members, key=lambda m: degrees.get(m, 0), reverse=True)
            key_members = ", ".join(members_sorted[:5])
            if len(members_sorted) > 5:
                key_members += ", …"
            lines.append(f"| {comm_id} | {len(members)} | {key_members} |")
    else:
        lines.append("No communities detected.")
    lines.append("")

    # Suggested actions
    lines.append("## Suggested Actions")
    actions = []
    if orphans:
        actions.append(f"1. Add [[links]] to top orphan pages (highest potential impact: {orphans[0]})")
    if god_nodes:
        actions.append(f"{len(actions)+1}. Review god nodes for stub content vs. genuine hubs")
    if fragile_bridges:
        actions.append(f"{len(actions)+1}. Strengthen fragile bridges with cross-references")
    if not actions:
        actions.append("1. Graph is in good shape — maintain current linking practices")
    lines.extend(actions)
    lines.append("")

    return "\n".join(lines)


COMMUNITY_COLORS = [
    "#E91E63", "#00BCD4", "#8BC34A", "#FF5722", "#673AB7",
    "#FFC107", "#009688", "#F44336", "#3F51B5", "#CDDC39",
]


def render_html(nodes: list[dict], edges: list[dict]) -> str:
    """Generate self-contained vis.js HTML with interactive filtering."""
    nodes_json = json.dumps(nodes, indent=2, ensure_ascii=False)
    edges_json = json.dumps(edges, indent=2, ensure_ascii=False)

    type_counts: dict[str, int] = {}
    for node in nodes:
        node_type = node.get("type") or "unknown"
        type_counts[node_type] = type_counts.get(node_type, 0) + 1

    legend_items = "".join(
        f'<span class="legend-chip" style="--chip-color:{color_for_type(t)};"><span>{t}</span><strong>{count}</strong></span>'
        for t, count in sorted(type_counts.items(), key=lambda item: (-item[1], item[0]))
    )

    node_total = len(nodes)
    edge_total = len(edges)
    type_total = len(type_counts)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>LLM Knowledge — Knowledge Graph</title>
<script>
(function() {{
  const valid = value => value === "dark" || value === "light";
  let theme = valid(window.__KF_INITIAL_THEME__) ? window.__KF_INITIAL_THEME__ : "";
  try {{
    const stored = window.localStorage && window.localStorage.getItem("theme");
    if (!theme && valid(stored)) theme = stored;
  }} catch (error) {{}}
  if (!theme) theme = "dark";
  document.documentElement.setAttribute("data-theme", theme);
}})();
</script>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  :root {{
    color-scheme: light;
    --page-bg: #f4f6f8;
    --graph-bg: radial-gradient(circle at 70% 12%, rgba(255,255,255,0.98) 0, rgba(255,255,255,0.84) 28%, rgba(244,247,250,0.96) 58%, #edf1f5 100%);
    --panel-bg: #ffffff;
    --panel-soft: #fbfcfe;
    --control-bg: #f8fafc;
    --input-bg: #ffffff;
    --text: #17202a;
    --heading: #111827;
    --muted: #64748b;
    --muted-2: #94a3b8;
    --line: #dfe5eb;
    --line-soft: #edf1f5;
    --search-line: #cfd8e3;
    --accent: #2f80ed;
    --accent-weak: rgba(47,128,237,0.14);
    --code-bg: #eef2f7;
    --quote-bg: #f8fafc;
    --quote-text: #334155;
    --shadow: 0 14px 34px rgba(15, 23, 42, 0.14);
    --drawer-shadow: -18px 0 34px rgba(15, 23, 42, 0.16);
    --badge-shadow: 0 10px 24px rgba(15, 23, 42, 0.10);
  }}
  html[data-theme="dark"] {{
    color-scheme: dark;
    --page-bg: #0f1220;
    --graph-bg: radial-gradient(circle at 70% 12%, rgba(37,43,66,0.76) 0, rgba(21,25,42,0.94) 42%, #0f1220 100%);
    --panel-bg: #151a2b;
    --panel-soft: #111626;
    --control-bg: #1b2134;
    --input-bg: #0f1424;
    --text: #e5eaf3;
    --heading: #f8fafc;
    --muted: #9aa5b5;
    --muted-2: #768196;
    --line: #2d354a;
    --line-soft: #242b3d;
    --search-line: #3a455f;
    --accent: #64a7ff;
    --accent-weak: rgba(100,167,255,0.18);
    --code-bg: #20283b;
    --quote-bg: #1a2032;
    --quote-text: #d3dae7;
    --shadow: 0 18px 38px rgba(0, 0, 0, 0.34);
    --drawer-shadow: -18px 0 36px rgba(0, 0, 0, 0.38);
    --badge-shadow: 0 14px 30px rgba(0, 0, 0, 0.26);
  }}
  body {{
    margin: 0; background: var(--page-bg); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--text);
  }}
  #graph {{
    width: 100vw; height: 100vh;
    background: var(--graph-bg);
  }}
  #controls {{
    position: fixed; top: 18px; left: 18px; z-index: 10; width: min(360px, calc(100vw - 36px));
    max-height: calc(100vh - 36px); box-sizing: border-box; overflow: hidden;
    background: var(--panel-bg); border: 1px solid var(--line); border-radius: 8px;
    box-shadow: var(--shadow);
  }}
  .controls-header {{
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    padding: 16px 18px 12px; border-bottom: 1px solid var(--line-soft);
  }}
  .controls-kicker {{
    margin-bottom: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    color: var(--muted); text-transform: uppercase;
  }}
  #controls h3 {{ margin: 0; font-size: 18px; line-height: 1.25; font-weight: 700; color: var(--heading); }}
  .theme-toggle {{
    position: relative; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; padding: 0;
    border: 0; border-radius: 0; background: transparent;
    color: var(--text); cursor: pointer;
  }}
  .theme-toggle:hover {{ color: var(--accent); }}
  .theme-toggle svg {{ width: 18px; height: 18px; pointer-events: none; }}
  .theme-toggle::after {{
    content: attr(data-tooltip); position: absolute; top: calc(100% + 8px); right: 0;
    padding: 6px 8px; border-radius: 6px; background: var(--heading); color: var(--panel-bg);
    font-size: 12px; line-height: 1; white-space: nowrap; opacity: 0; transform: translateY(-2px);
    pointer-events: none; transition: opacity 80ms ease, transform 80ms ease; z-index: 40;
  }}
  .theme-toggle:hover::after, .theme-toggle:focus-visible::after {{ opacity: 1; transform: translateY(0); }}
  .search-row {{ padding: 14px 16px 0; }}
  #search {{
    width: 100%; box-sizing: border-box; padding: 9px 10px; background: var(--input-bg); color: var(--heading);
    border: 1px solid var(--search-line); border-radius: 4px; font-size: 13px; outline: none;
    box-shadow: inset 0 1px 1px rgba(15, 23, 42, 0.03);
  }}
  #search:focus {{ border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }}
  .summary-row {{
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 12px 16px 0;
  }}
  .summary-pill {{
    min-width: 0; padding: 9px 10px; border: 1px solid var(--line); border-radius: 6px;
    background: var(--control-bg); color: var(--muted); font-size: 12px;
  }}
  .summary-pill strong {{ display: block; margin-top: 2px; color: var(--heading); font-size: 16px; line-height: 1.15; }}
  .legend-section {{ padding: 15px 16px 16px; }}
  .legend-title {{ margin-bottom: 8px; color: var(--muted); font-size: 12px; font-weight: 700; }}
  .legend-list {{ display: flex; flex-wrap: wrap; align-items: flex-start; gap: 7px; max-width: 100%; }}
  .legend-chip {{
    display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%;
    padding: 4px 8px; border-radius: 999px; font-size: 12px; line-height: 1.2;
    color: #fff; background: var(--chip-color); overflow-wrap: anywhere; word-break: break-word;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
  }}
  .legend-chip strong {{
    font-size: 11px; line-height: 1; padding: 2px 5px; border-radius: 999px;
    background: rgba(255,255,255,0.22);
  }}
  .controls-hint {{
    margin: 0; padding: 12px 16px 15px; border-top: 1px solid var(--line-soft);
    font-size: 12px; color: var(--muted); line-height: 1.55; background: var(--panel-soft);
  }}
  #drawer {{
    position: fixed; top: 0; right: 0; width: clamp(480px, 33vw, 720px); max-width: 100vw; height: 100vh;
    background: var(--panel-bg); border-left: 1px solid var(--line);
    box-shadow: var(--drawer-shadow); z-index: 20; display: none;
    flex-direction: column;
  }}
  #drawer.open {{ display: flex; }}
  #drawer-header {{
    padding: 18px 18px 12px; border-bottom: 1px solid var(--line-soft); background: var(--panel-soft);
  }}
  #drawer-topline {{
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  }}
  #drawer-title {{ margin: 0; font-size: 20px; line-height: 1.2; color: var(--heading); }}
  #drawer-close {{
    background: transparent; color: var(--muted); border: 0; font-size: 24px; line-height: 1;
    cursor: pointer; padding: 0;
  }}
  #drawer-meta {{ margin-top: 8px; font-size: 12px; color: var(--muted); }}
  #drawer-path {{ margin-top: 6px; font-size: 12px; color: var(--muted-2); word-break: break-all; }}
  #drawer-preview {{
    margin-top: 12px; font-size: 13px; color: var(--text); line-height: 1.6;
  }}
  #drawer-related {{
    padding: 12px 18px 0; font-size: 12px; color: var(--muted);
  }}
  #drawer-related-list {{
    display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;
  }}
  .related-chip {{
    background: var(--control-bg); color: var(--text); border: 1px solid var(--line);
    border-radius: 999px; font-size: 12px; padding: 5px 10px; cursor: pointer;
  }}
  .related-chip:hover {{ border-color: var(--accent); color: var(--accent); background: var(--panel-soft); }}
  #drawer-content {{
    flex: 1; min-height: 0; padding: 14px 18px 18px; overflow: auto;
  }}
  #drawer-markdown {{
    color: var(--text); font-size: 13px; line-height: 1.72;
  }}
  #drawer-markdown h1, #drawer-markdown h2, #drawer-markdown h3,
  #drawer-markdown h4, #drawer-markdown h5, #drawer-markdown h6 {{
    margin: 1.2em 0 0.55em; line-height: 1.3; color: var(--heading);
  }}
  #drawer-markdown h1 {{ font-size: 24px; }}
  #drawer-markdown h2 {{ font-size: 20px; }}
  #drawer-markdown h3 {{ font-size: 17px; }}
  #drawer-markdown p {{ margin: 0 0 0.95em; }}
  #drawer-markdown ul, #drawer-markdown ol {{ margin: 0 0 1em 1.35em; padding: 0; }}
  #drawer-markdown li {{ margin: 0.35em 0; }}
  #drawer-markdown hr {{ border: 0; border-top: 1px solid var(--line); margin: 1.2em 0; }}
  #drawer-markdown blockquote {{
    margin: 0 0 1em; padding: 0.85em 1em; border-left: 3px solid rgba(101, 181, 255, 0.8);
    background: var(--quote-bg); color: var(--quote-text); border-radius: 0 8px 8px 0;
  }}
  #drawer-markdown pre {{
    margin: 0 0 1em; white-space: pre-wrap; word-break: break-word; line-height: 1.55;
    font-size: 12px; color: var(--text); background: var(--quote-bg);
    border: 1px solid var(--line); border-radius: 8px; padding: 16px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }}
  #drawer-markdown code {{
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.92em; background: var(--code-bg); padding: 0.16em 0.38em;
    border-radius: 5px; color: var(--accent);
  }}
  #drawer-markdown pre code {{ background: transparent; padding: 0; color: inherit; border-radius: 0; }}
  #drawer-markdown .wikilink {{ color: var(--accent); font-weight: 600; }}
  @media (max-width: 960px) {{
    #drawer {{ width: 100vw; }}
    #controls {{ top: 12px; left: 12px; width: calc(100vw - 24px); }}
  }}
  #stats {{
    position: fixed; top: 18px; right: 18px; background: var(--panel-bg);
    padding: 9px 13px; border-radius: 8px; font-size: 12px; color: var(--text);
    border: 1px solid var(--line); box-shadow: var(--badge-shadow);
  }}
</style>
</head>
<body>
<div id="controls">
  <div class="controls-header">
    <div>
      <div class="controls-kicker">Knowledge workspace</div>
      <h3>Knowledge Graph</h3>
    </div>
    <button id="theme-toggle" class="theme-toggle" type="button" onclick="toggleGraphTheme()" aria-label="Toggle color mode"></button>
  </div>
  <div class="search-row">
    <input id="search" type="text" placeholder="Search nodes..." oninput="searchNodes(this.value)">
  </div>
  <div class="summary-row">
    <div class="summary-pill">Nodes<strong>{node_total}</strong></div>
    <div class="summary-pill">Relationships<strong>{edge_total}</strong></div>
  </div>
  <div class="legend-section">
    <div class="legend-title">Node types ({type_total})</div>
    <div class="legend-list">{legend_items}</div>
  </div>
  <p class="controls-hint">Click a node to inspect its markdown and directly connected pages.</p>
</div>
<div id="graph"></div>
<aside id="drawer">
  <div id="drawer-header">
    <div id="drawer-topline">
      <h2 id="drawer-title"></h2>
      <button id="drawer-close" onclick="clearSelection()" aria-label="Close drawer">×</button>
    </div>
    <div id="drawer-meta"></div>
    <div id="drawer-path"></div>
    <div id="drawer-preview"></div>
  </div>
  <div id="drawer-related">
    Related nodes
    <div id="drawer-related-list"></div>
  </div>
  <div id="drawer-content">
    <div id="drawer-markdown"></div>
  </div>
</aside>
<div id="stats"></div>
<script>
const originalNodes = {nodes_json};
const originalEdges = {edges_json}.map(edge => ({{
  ...edge,
  id: edge.id || `${{edge.from}}->${{edge.to}}:${{edge.type || "INFERRED"}}`,
}}));
const nodes = new vis.DataSet(originalNodes);
const edges = new vis.DataSet(originalEdges);
const adjacency = new Map();
const searchInput = document.getElementById("search");
const stats = document.getElementById("stats");
const nodeMap = new Map(originalNodes.map(node => [node.id, node]));
let activeNodeId = null;
let activeTheme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";

function graphPalette() {{
  const dark = activeTheme === "dark";
  return {{
    nodeLabel: dark ? "#f8fafc" : "#17202a",
    nodeLabelMuted: dark ? "rgba(226,232,240,0.56)" : "rgba(15,23,42,0.36)",
    nodeLabelHidden: dark ? "rgba(226,232,240,0.10)" : "rgba(15,23,42,0.08)",
    nodeLabelStroke: dark ? "#0f1220" : "#ffffff",
    nodeMutedAlpha: dark ? 0.24 : 0.14,
    nodeHiddenAlpha: dark ? 0.07 : 0.05,
    nodeBorderMutedAlpha: dark ? 0.38 : 0.22,
    nodeBorderHiddenAlpha: dark ? 0.12 : 0.08,
    edgeFadedAlpha: dark ? 0.18 : 0.08,
  }};
}}

const themeIcons = {{
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.99 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.78 9.79Z"></path></svg>',
}};

function setGraphTheme(theme, options = {{}}) {{
  activeTheme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", activeTheme);
  const button = document.getElementById("theme-toggle");
  if (button) {{
    const next = activeTheme === "dark" ? "light" : "dark";
    button.innerHTML = activeTheme === "dark" ? themeIcons.sun : themeIcons.moon;
    button.dataset.tooltip = `Switch to ${{next}} mode`;
    button.setAttribute("aria-label", `Switch to ${{next}} mode`);
    button.setAttribute("aria-pressed", activeTheme === "dark" ? "true" : "false");
  }}
  if (options.updateGraph !== false) applyFilters(searchInput.value, activeNodeId);
}}

function toggleGraphTheme() {{
  setGraphTheme(activeTheme === "dark" ? "light" : "dark");
}}

function hexToRgba(color, alpha) {{
  if (!color) {{
    const fallback = activeTheme === "dark" ? "226, 232, 240" : "15, 23, 42";
    return `rgba(${{fallback}}, ${{alpha}})`;
  }}
  const normalized = color.replace("#", "");
  const value = normalized.length === 3
    ? normalized.split("").map(ch => ch + ch).join("")
    : normalized;
  const intValue = Number.parseInt(value, 16);
  const r = (intValue >> 16) & 255;
  const g = (intValue >> 8) & 255;
  const b = intValue & 255;
  return `rgba(${{r}}, ${{g}}, ${{b}}, ${{alpha}})`;
}}

function escapeHtml(text) {{
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}}

function stripFrontmatter(markdown) {{
  return (markdown || "").replace(/^---\\n[\\s\\S]*?\\n---\\n?/, "");
}}

function renderInlineMarkdown(text) {{
  let html = escapeHtml(text);
  html = html.replace(/\\[\\[([^\\]]+)\\]\\]/g, '<span class="wikilink">[[$1]]</span>');
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
  html = html.replace(/\\*([^*]+)\\*/g, "<em>$1</em>");
  return html;
}}

function renderMarkdown(markdown) {{
  const lines = stripFrontmatter(markdown).split(/\\r?\\n/);
  const html = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];
  let inCodeBlock = false;
  let codeLines = [];

  function flushParagraph() {{
    if (!paragraph.length) return;
    html.push(`<p>${{renderInlineMarkdown(paragraph.join(" "))}}</p>`);
    paragraph = [];
  }}

  function flushList() {{
    if (!listType || !listItems.length) return;
    const items = listItems.map(item => `<li>${{renderInlineMarkdown(item)}}</li>`).join("");
    html.push(`<${{listType}}>${{items}}</${{listType}}>`);
    listType = null;
    listItems = [];
  }}

  function flushQuote() {{
    if (!quoteLines.length) return;
    html.push(`<blockquote>${{quoteLines.map(line => renderInlineMarkdown(line)).join("<br>")}}</blockquote>`);
    quoteLines = [];
  }}

  function flushCode() {{
    if (!codeLines.length) {{
      html.push("<pre><code></code></pre>");
      return;
    }}
    html.push(`<pre><code>${{escapeHtml(codeLines.join("\\n"))}}</code></pre>`);
    codeLines = [];
  }}

  for (const rawLine of lines) {{
    const line = rawLine.replace(/\\t/g, "    ");
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {{
      flushParagraph();
      flushList();
      flushQuote();
      if (inCodeBlock) {{
        flushCode();
        inCodeBlock = false;
      }} else {{
        inCodeBlock = true;
      }}
      continue;
    }}

    if (inCodeBlock) {{
      codeLines.push(rawLine);
      continue;
    }}

    if (!trimmed) {{
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }}

    const headingMatch = trimmed.match(/^(#{1,6})\\s+(.+)$/);
    if (headingMatch) {{
      flushParagraph();
      flushList();
      flushQuote();
      const level = headingMatch[1].length;
      html.push(`<h${{level}}>${{renderInlineMarkdown(headingMatch[2])}}</h${{level}}>`);
      continue;
    }}

    if (/^(-{3,}|\\*{3,})$/.test(trimmed)) {{
      flushParagraph();
      flushList();
      flushQuote();
      html.push("<hr>");
      continue;
    }}

    const quoteMatch = trimmed.match(/^>\\s?(.*)$/);
    if (quoteMatch) {{
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }}
    flushQuote();

    const unorderedMatch = trimmed.match(/^[-*]\\s+(.+)$/);
    if (unorderedMatch) {{
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(unorderedMatch[1]);
      continue;
    }}

    const orderedMatch = trimmed.match(/^\\d+\\.\\s+(.+)$/);
    if (orderedMatch) {{
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(orderedMatch[1]);
      continue;
    }}

    flushList();
    paragraph.push(trimmed);
  }}

  if (inCodeBlock) flushCode();
  flushParagraph();
  flushList();
  flushQuote();
  return html.join("");
}}

function rebuildAdjacency(filteredEdges) {{
  adjacency.clear();
  for (const node of originalNodes) {{
    adjacency.set(node.id, new Set());
  }}
  for (const edge of filteredEdges) {{
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
  }}
}}

function searchNodes(q) {{
  applyFilters(q, activeNodeId);
}}

function clearSelection() {{
  activeNodeId = null;
  closeDrawer();
  applyFilters(searchInput.value, null);
}}

function closeDrawer() {{
  document.getElementById("drawer").classList.remove("open");
}}

function openDrawer(node, relatedIds) {{
  document.getElementById("drawer").classList.add("open");
  document.getElementById("drawer-title").textContent = node.label;
  const communityText = Number.isInteger(node.group) && node.group >= 0 ? ` · community ${{node.group}}` : "";
  document.getElementById("drawer-meta").textContent = `${{node.type}}${{communityText}}`;
  document.getElementById("drawer-path").textContent = node.path;
  document.getElementById("drawer-preview").textContent = node.preview || "";
  document.getElementById("drawer-markdown").innerHTML = renderMarkdown(node.markdown || "");

  const relatedList = document.getElementById("drawer-related-list");
  relatedList.innerHTML = "";
  const relatedNodes = originalNodes
    .filter(item => relatedIds.has(item.id) && item.id !== node.id)
    .sort((a, b) => a.label.localeCompare(b.label));

  if (relatedNodes.length === 0) {{
    const empty = document.createElement("span");
    empty.textContent = "No directly connected nodes";
    relatedList.appendChild(empty);
    return;
  }}

  for (const related of relatedNodes) {{
    const chip = document.createElement("button");
    chip.className = "related-chip";
    chip.textContent = related.label;
    chip.onclick = () => focusNode(related.id);
    relatedList.appendChild(chip);
  }}
}}

function applyFilters(query = searchInput.value, selectedNodeId = activeNodeId) {{
  const lower = (query || "").trim().toLowerCase();
  const filteredEdges = originalEdges;
  rebuildAdjacency(filteredEdges);

  const relatedIds = selectedNodeId
    ? new Set([selectedNodeId, ...(adjacency.get(selectedNodeId) || [])])
    : null;
  const filteredNodeIds = new Set();
  for (const edge of filteredEdges) {{
    filteredNodeIds.add(edge.from);
    filteredNodeIds.add(edge.to);
  }}
  const hasRelationships = filteredEdges.length > 0;
  const palette = graphPalette();

  let visibleNodeCount = 0;
  const nodeUpdates = originalNodes.map(node => {{
    const matchesSearch = !lower || node.label.toLowerCase().includes(lower);
    const isActive = selectedNodeId === node.id;
    const isConnected = filteredNodeIds.has(node.id);
    const isRelated = !relatedIds || relatedIds.has(node.id);
    const hidden = !selectedNodeId && !lower && hasRelationships && !isConnected;
    const emphasized = matchesSearch && isRelated && (isConnected || !hasRelationships || !!lower || isActive);

    if (!hidden) {{
      visibleNodeCount += 1;
    }}

    return {{
      id: node.id,
      hidden,
      color: {{
        background: emphasized ? node.color : hexToRgba(node.color, hidden ? palette.nodeHiddenAlpha : palette.nodeMutedAlpha),
        border: emphasized ? hexToRgba(node.color, 0.96) : hexToRgba(node.color, hidden ? palette.nodeBorderHiddenAlpha : palette.nodeBorderMutedAlpha),
        highlight: {{ background: node.color, border: hexToRgba(node.color, 1) }},
        hover: {{ background: node.color, border: hexToRgba(node.color, 1) }},
      }},
      font: {{
        color: emphasized ? palette.nodeLabel : hidden ? palette.nodeLabelHidden : palette.nodeLabelMuted,
        strokeWidth: 4,
        strokeColor: palette.nodeLabelStroke,
      }},
      borderWidth: isActive ? 5 : 2,
      size: isActive ? 18 : 12,
    }};
  }});

  const edgeUpdates = originalEdges.map(edge => {{
    const matchesSearch = !lower
      || nodeMap.get(edge.from)?.label.toLowerCase().includes(lower)
      || nodeMap.get(edge.to)?.label.toLowerCase().includes(lower);
    const isRelated = !relatedIds || relatedIds.has(edge.from) || relatedIds.has(edge.to);
    const touchesActive = !!selectedNodeId && (edge.from === selectedNodeId || edge.to === selectedNodeId);
    const emphasized = matchesSearch && isRelated;

    return {{
      id: edge.id,
      hidden: false,
      width: touchesActive ? 2.8 : emphasized ? 1.2 : 0.6,
      color: emphasized ? edge.color : hexToRgba(edge.color, palette.edgeFadedAlpha),
    }};
  }});

  nodes.update(nodeUpdates);
  edges.update(edgeUpdates);

  if (selectedNodeId) {{
    const activeNode = nodeMap.get(selectedNodeId);
    if (activeNode) {{
      openDrawer(activeNode, relatedIds || new Set([selectedNodeId]));
    }}
  }}

  const focusSuffix = selectedNodeId && nodeMap.get(selectedNodeId)
    ? ` · focused: ${{nodeMap.get(selectedNodeId).label}}`
    : "";
  stats.textContent = `${{visibleNodeCount}} nodes · ${{filteredEdges.length}} relationships${{focusSuffix}}`;
}}

const container = document.getElementById("graph");
const network = new vis.Network(container, {{ nodes, edges }}, {{
  nodes: {{
    shape: "dot",
    size: 10,
    font: {{ color: graphPalette().nodeLabel, size: 12, strokeWidth: 4, strokeColor: graphPalette().nodeLabelStroke }},
    borderWidth: 1.5,
    scaling: {{ label: {{ drawThreshold: 9, maxVisible: 18 }} }},
  }},
  edges: {{
    width: 0.8,
    smooth: {{ type: "continuous" }},
    arrows: {{ to: {{ enabled: true, scaleFactor: 0.4 }} }},
    color: {{ inherit: false }},
    hoverWidth: 2,
  }},
  physics: {{
    stabilization: {{ iterations: 200, updateInterval: 25 }},
    barnesHut: {{ gravitationalConstant: -3000, springLength: 200, springConstant: 0.02, damping: 0.12 }},
  }},
  interaction: {{ hover: true, tooltipDelay: 150, hideEdgesOnDrag: true, hideEdgesOnZoom: true }},
}});
setGraphTheme(activeTheme, {{ updateGraph: false }});

function focusNode(nodeId) {{
  activeNodeId = nodeId;
  applyFilters(searchInput.value, nodeId);
  const node = nodeMap.get(nodeId) || nodes.get(nodeId);
  const relatedIds = new Set([nodeId, ...(adjacency.get(nodeId) || [])]);
  openDrawer(node, relatedIds);
  network.focus(nodeId, {{
    scale: 1.1,
    animation: {{ duration: 300, easingFunction: "easeInOutQuad" }},
  }});
}}

network.on("click", params => {{
  if (params.nodes.length > 0) {{
    focusNode(params.nodes[0]);
  }} else {{
    clearSelection();
  }}
}});

applyFilters();
</script>
</body>
</html>"""


def append_log(entry: str):
    log_path = KNOWLEDGE_DIR / "log.md"
    entry_text = entry.strip()
    if not log_path.exists():
        log_path.write_text(
            "# Knowledge Log\n\n"
            "> Records important additions, revisions, and clarifications in the project knowledge layer. Maintained in append-only mode for agent and human traceability.\n\n"
            f"{entry_text}\n",
            encoding="utf-8",
        )
        return

    existing = read_file(log_path).rstrip()
    if not existing:
        existing = (
            "# Knowledge Log\n\n"
            "> Records important additions, revisions, and clarifications in the project knowledge layer. Maintained in append-only mode for agent and human traceability."
        )
    log_path.write_text(existing + "\n\n" + entry_text + "\n", encoding="utf-8")


def build_graph(infer: bool = True, open_browser: bool = False, clean: bool = False,
                report: bool = False, save: bool = False):
    pages = all_knowledge_pages()
    today = date.today().isoformat()

    if not pages:
        print("Knowledge is empty. Ingest some sources first.")
        return

    print(f"Building graph from {len(pages)} knowledge pages...")
    GRAPH_DIR.mkdir(parents=True, exist_ok=True)

    # Clean checkpoint if requested
    if clean and INFERRED_EDGES_FILE.exists():
        INFERRED_EDGES_FILE.unlink()
        print("  cleaned: removed inference checkpoint")

    cache = load_cache()

    # Pass 1: extracted edges
    print("  Pass 1: extracting [[links]]...")
    nodes = build_nodes(pages)
    edges = build_extracted_edges(pages)
    print(f"  → {len(edges)} extracted edges")

    # Pass 2: inferred edges
    if infer:
        print("  Pass 2: inferring semantic relationships...")
        inferred = build_inferred_edges(pages, edges, cache, resume=not clean)
        edges.extend(inferred)
        print(f"  → {len(inferred)} inferred edges")
        save_cache(cache)

    # Deduplicate edges
    before_dedup = len(edges)
    edges = deduplicate_edges(edges)
    if before_dedup != len(edges):
        print(f"  dedup: {before_dedup} → {len(edges)} edges")

    # Community detection
    print("  Running Louvain community detection...")
    communities = detect_communities(nodes, edges)
    for node in nodes:
        comm_id = communities.get(node["id"], -1)
        if comm_id >= 0:
            node["color"] = COMMUNITY_COLORS[comm_id % len(COMMUNITY_COLORS)]
        node["group"] = comm_id

    # Save graph.json
    graph_data = {"nodes": nodes, "edges": edges, "built": today}
    GRAPH_JSON.write_text(json.dumps(graph_data, indent=2, ensure_ascii=False))
    print(f"  saved: graph/graph.json  ({len(nodes)} nodes, {len(edges)} edges)")

    # Save graph.html
    html = render_html(nodes, edges)
    GRAPH_HTML.write_text(html, encoding="utf-8")
    print(f"  saved: graph/graph.html")

    n_ext = len([e for e in edges if e['type']=='EXTRACTED'])
    n_inf = len([e for e in edges if e['type'] in ('INFERRED', 'AMBIGUOUS')])
    append_log(f"## [{today}] graph | Knowledge graph rebuilt\n\n{len(nodes)} nodes, {len(edges)} edges ({n_ext} extracted, {n_inf} inferred).")

    # Generate health report
    if report:
        if not HAS_NETWORKX:
            print("Warning: networkx not installed. Cannot generate report.")
        else:
            report_text = generate_report(nodes, edges, communities)
            print("\n" + report_text)
            if save:
                report_path = GRAPH_DIR / "graph-report.md"
                report_path.write_text(report_text, encoding="utf-8")
                print(f"  saved: {report_path.relative_to(REPO_ROOT)}")
            append_log(f"## [{today}] report | Graph health report generated\n\n{len(nodes)} nodes analyzed.")

    if open_browser:
        webbrowser.open(f"file://{GRAPH_HTML.resolve()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build LLM Knowledge graph")
    parser.add_argument("--no-infer", action="store_true", help="Skip semantic inference (faster)")
    parser.add_argument("--open", action="store_true", help="Open graph.html in browser")
    parser.add_argument("--clean", action="store_true", help="Delete checkpoint and force full re-inference")
    parser.add_argument("--report", action="store_true", help="Generate graph health report")
    parser.add_argument("--save", action="store_true", help="Save report to graph/graph-report.md")
    args = parser.parse_args()
    build_graph(infer=not args.no_infer, open_browser=args.open, clean=args.clean,
                report=args.report, save=args.save)
