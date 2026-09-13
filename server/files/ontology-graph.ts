import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "../env";
import { resolveWorkspaceFile } from "../ontologies/workspace";

const execFileAsync = promisify(execFile);

interface OntologyGraphNode {
  id: string;
  label?: string;
  group?: string;
  layer?: string;
}

interface OntologyGraphEdge {
  id?: string;
  from?: string;
  to?: string;
  type?: string;
  label?: string;
}

interface OntologyGraphFile {
  nodes?: OntologyGraphNode[];
  edges?: OntologyGraphEdge[];
  summary?: {
    node_count?: number;
    edge_count?: number;
    groups?: Record<string, number>;
  };
}

export interface OntologyGraphBuildResult {
  graphPath: string;
  htmlPath: string;
  html: string;
  graph: {
    nodes: OntologyGraphNode[];
    edges: OntologyGraphEdge[];
    summary?: OntologyGraphFile["summary"];
    stats: {
      nodeCount: number;
      edgeCount: number;
      types: Record<string, number>;
    };
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function copyTemplateOntologyGraphTool(root: string): Promise<string> {
  const workspaceTool = resolveWorkspaceFile(root, "tools/build_ontology_graph.py");
  const templateTool = path.resolve(env.initialWikiSource, "tools/build_ontology_graph.py");
  if (!(await exists(templateTool))) {
    throw new Error("Ontology graph tool is not available in the knowledge-base template.");
  }

  await fs.mkdir(path.dirname(workspaceTool), { recursive: true });
  await fs.copyFile(templateTool, workspaceTool);
  return workspaceTool;
}

function ontologyGraphStats(graph: OntologyGraphFile) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const groups = graph.summary?.groups;
  const types = groups && Object.keys(groups).length
    ? groups
    : nodes.reduce<Record<string, number>>((acc, node) => {
        const type = node.group || node.layer || "unknown";
        acc[type] = (acc[type] ?? 0) + 1;
        return acc;
      }, {});
  return {
    nodeCount: graph.summary?.node_count ?? nodes.length,
    edgeCount: graph.summary?.edge_count ?? edges.length,
    types,
  };
}

export async function buildOntologyGraph(root: string): Promise<OntologyGraphBuildResult> {
  await copyTemplateOntologyGraphTool(root);
  const python = process.env.GRAPH_PYTHON ?? process.env.MARKITDOWN_PYTHON ?? "python3";

  await execFileAsync(python, ["tools/build_ontology_graph.py"], {
    cwd: root,
    timeout: Number(process.env.ONTOLOGY_GRAPH_BUILD_TIMEOUT_MS ?? process.env.GRAPH_BUILD_TIMEOUT_MS ?? 120_000),
    maxBuffer: 8 * 1024 * 1024,
  });

  const graphPath = "graph/ontology-graph.json";
  const htmlPath = "graph/ontology-graph.html";
  const graphFile = resolveWorkspaceFile(root, graphPath);
  const htmlFile = resolveWorkspaceFile(root, htmlPath);
  const [rawGraph, html] = await Promise.all([
    fs.readFile(graphFile, "utf-8"),
    fs.readFile(htmlFile, "utf-8"),
  ]);
  const parsed = JSON.parse(rawGraph) as OntologyGraphFile;
  const graph = {
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    summary: parsed.summary,
    stats: ontologyGraphStats(parsed),
  };
  return { graphPath, htmlPath, html, graph };
}
