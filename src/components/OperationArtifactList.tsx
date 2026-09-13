import { useState, type ReactNode } from "react";
import { Download } from "lucide-react";
import type { OperationArtifact } from "@/contracts/ontology";

export interface OperationOutputFile extends OperationArtifact {
  content?: string;
  displayPath?: string;
}

interface OperationOutputDirectory {
  kind: "directory";
  name: string;
  path: string;
  children: OperationOutputNode[];
}

interface OperationOutputFileNode {
  kind: "file";
  name: string;
  path: string;
  file: OperationOutputFile;
}

type OperationOutputNode = OperationOutputDirectory | OperationOutputFileNode;

interface OperationArtifactListProps {
  artifacts: OperationOutputFile[];
  downloadingPath?: string | null;
  onPreview: (artifact: OperationOutputFile) => void;
  onDownload: (artifact: OperationOutputFile) => void;
  t: (key: string, params?: Record<string, string>) => string;
}

const TEXT_ARTIFACT_EXTENSIONS = new Set([
  "csv",
  "json",
  "log",
  "md",
  "sql",
  "text",
  "tsv",
  "txt",
  "yaml",
  "yml",
]);

function artifactName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function artifactExtension(path: string): string {
  const name = artifactName(path);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "file";
}

function canPreviewOperationArtifact(path: string): boolean {
  return TEXT_ARTIFACT_EXTENSIONS.has(artifactExtension(path));
}

function buildOutputTree(files: OperationOutputFile[]): OperationOutputNode[] {
  const root: OperationOutputDirectory = { kind: "directory", name: "", path: "", children: [] };

  for (const file of files) {
    const parts = (file.displayPath || artifactName(file.path))
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..");
    const fileName = parts.pop() || artifactName(file.path);
    let parent = root;

    for (const part of parts) {
      const directoryPath = parent.path ? `${parent.path}/${part}` : part;
      let directory = parent.children.find(
        (node): node is OperationOutputDirectory => node.kind === "directory" && node.name === part,
      );
      if (!directory) {
        directory = { kind: "directory", name: part, path: directoryPath, children: [] };
        parent.children.push(directory);
      }
      parent = directory;
    }

    parent.children.push({
      kind: "file",
      name: fileName,
      path: parent.path ? `${parent.path}/${fileName}` : fileName,
      file,
    });
  }

  const sortNodes = (nodes: OperationOutputNode[]) => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    nodes.forEach((node) => { if (node.kind === "directory") sortNodes(node.children); });
  };
  sortNodes(root.children);
  return root.children;
}

export default function OperationArtifactList({
  artifacts,
  downloadingPath,
  onPreview,
  onDownload,
  t,
}: OperationArtifactListProps) {
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set());

  if (!artifacts.length) {
    return <div className="operation-artifacts-empty">{t("operations.noArtifacts")}</div>;
  }

  const renderNode = (node: OperationOutputNode, depth = 0): ReactNode => {
    const paddingLeft = 30 + depth * 16;
    if (node.kind === "directory") {
      const expanded = !collapsedDirectories.has(node.path);
      return (
        <div key={`directory:${node.path}`}>
          <div
            className="knowledge-tree-item knowledge-tree-dir operation-output-folder"
            style={{ paddingLeft }}
            onClick={() => {
              setCollapsedDirectories((current) => {
                const next = new Set(current);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              });
            }}
          >
            <svg className="knowledge-tree-folder-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="knowledge-tree-name">{node.name}</span>
            <svg className={`knowledge-tree-chevron${expanded ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          {expanded ? node.children.map((child) => renderNode(child, depth + 1)) : null}
        </div>
      );
    }

    const artifact = node.file;
    const previewable = canPreviewOperationArtifact(artifact.path);
    return (
      <div
        className={`knowledge-tree-item knowledge-tree-file operation-output-file${previewable ? "" : " preview-unavailable"}`}
        key={`file:${artifact.path}`}
        style={{ paddingLeft }}
        role={previewable ? "button" : undefined}
        tabIndex={previewable ? 0 : undefined}
        title={artifact.description ? `${artifact.path}\n${artifact.description}` : artifact.path}
        onClick={() => { if (previewable) onPreview(artifact); }}
        onKeyDown={(event) => {
          if (previewable && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onPreview(artifact);
          }
        }}
      >
        <svg className="knowledge-tree-file-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M14 2v6h6" fill="none" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
        <span className="knowledge-tree-name">{node.name}</span>
        <button
          type="button"
          className="knowledge-tree-ref-btn operation-output-download"
          onClick={(event) => { event.stopPropagation(); onDownload(artifact); }}
          disabled={!previewable || downloadingPath === artifact.path}
          title={previewable ? t("operations.downloadArtifact") : t("operations.downloadUnavailable")}
          aria-label={t("operations.downloadArtifact")}
        >
          <Download size={13} />
        </button>
      </div>
    );
  };

  const tree = buildOutputTree(artifacts);

  return (
    <div className="operation-artifact-list">
      {tree.map((node) => renderNode(node))}
    </div>
  );
}
