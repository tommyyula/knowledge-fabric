import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FileText, Folder } from "lucide-react";
import {
  getBitbucketRepositoryFile,
  listBitbucketRepositoryFiles,
  type BitbucketRepositoryFile,
  type BitbucketRepositoryFilePreview,
} from "@/services/api/resource-library";

interface RepositoryPreviewModalProps {
  resourceId: string;
  repositoryName: string;
  onClose: () => void;
}

interface RepositoryDirectory {
  name: string;
  path: string;
  directories: Map<string, RepositoryDirectory>;
  files: BitbucketRepositoryFile[];
}

function preferredFile(files: BitbucketRepositoryFile[]): string | null {
  return (
    files.find((file) => /^readme(?:\.md)?$/i.test(file.path))?.path ??
    files[0]?.path ??
    null
  );
}

function directoryPathsForFile(filePath: string | null): string[] {
  if (!filePath) return [];
  const parts = filePath.split("/").filter(Boolean);
  parts.pop();
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function repositoryTree(files: BitbucketRepositoryFile[]): RepositoryDirectory {
  const root: RepositoryDirectory = {
    name: "",
    path: "",
    directories: new Map(),
    files: [],
  };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    const filename = parts.pop();
    if (!filename) continue;
    let current = root;
    for (const directoryName of parts) {
      let directory = current.directories.get(directoryName);
      if (!directory) {
        const directoryPath = current.path
          ? `${current.path}/${directoryName}`
          : directoryName;
        directory = {
          name: directoryName,
          path: directoryPath,
          directories: new Map(),
          files: [],
        };
        current.directories.set(directoryName, directory);
      }
      current = directory;
    }
    current.files.push(file);
  }
  return root;
}

function RepositoryTree({
  directory,
  depth,
  expandedDirectories,
  selectedPath,
  onToggleDirectory,
  onSelectFile,
}: {
  directory: RepositoryDirectory;
  depth: number;
  expandedDirectories: Set<string>;
  selectedPath: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const directories = [...directory.directories.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files = [...directory.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  return (
    <ul className="repository-tree-level" role={depth === 0 ? "tree" : "group"}>
      {directories.map((child) => {
        const expanded = expandedDirectories.has(child.path);
        return (
          <li key={child.path} role="treeitem" aria-expanded={expanded}>
            <button
              className="repository-tree-node repository-tree-directory"
              type="button"
              style={{ paddingInlineStart: `${12 + depth * 16}px` }}
              onClick={() => onToggleDirectory(child.path)}
            >
              <span className="repository-tree-disclosure" aria-hidden="true">
                <ChevronRight
                  size={14}
                  className={expanded ? "expanded" : undefined}
                />
              </span>
              <Folder
                className="repository-tree-folder"
                size={14}
                aria-hidden="true"
              />
              <span>{child.name}</span>
            </button>
            {expanded && (
              <RepositoryTree
                directory={child}
                depth={depth + 1}
                expandedDirectories={expandedDirectories}
                selectedPath={selectedPath}
                onToggleDirectory={onToggleDirectory}
                onSelectFile={onSelectFile}
              />
            )}
          </li>
        );
      })}
      {files.map((file) => (
        <li
          key={file.path}
          role="treeitem"
          aria-selected={file.path === selectedPath}
        >
          <button
            className={`repository-tree-node repository-tree-file${file.path === selectedPath ? " selected" : ""}`}
            type="button"
            style={{ paddingInlineStart: `${30 + depth * 16}px` }}
            onClick={() => onSelectFile(file.path)}
            title={file.path}
          >
            <FileText
              className="repository-tree-file-mark"
              size={13}
              aria-hidden="true"
            />
            <span>{file.path.split("/").at(-1)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function RepositoryPreviewModal({
  resourceId,
  repositoryName,
  onClose,
}: RepositoryPreviewModalProps) {
  const [files, setFiles] = useState<BitbucketRepositoryFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(
    new Set(),
  );
  const [preview, setPreview] = useState<BitbucketRepositoryFilePreview | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const tree = useMemo(() => repositoryTree(files), [files]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void listBitbucketRepositoryFiles(resourceId)
      .then((nextFiles) => {
        if (!active) return;
        const nextSelectedPath = preferredFile(nextFiles);
        setFiles(nextFiles);
        setSelectedPath(nextSelectedPath);
        setExpandedDirectories(
          new Set(directoryPathsForFile(nextSelectedPath)),
        );
      })
      .catch((requestError: unknown) => {
        if (active)
          setError(
            requestError instanceof Error
              ? requestError.message
              : String(requestError),
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [resourceId]);

  useEffect(() => {
    if (!selectedPath) return;
    let active = true;
    setPreview(null);
    setError(null);
    void getBitbucketRepositoryFile(resourceId, selectedPath)
      .then((nextPreview) => {
        if (active) setPreview(nextPreview);
      })
      .catch((requestError: unknown) => {
        if (active)
          setError(
            requestError instanceof Error
              ? requestError.message
              : String(requestError),
          );
      });
    return () => {
      active = false;
    };
  }, [resourceId, selectedPath]);

  const toggleDirectory = (path: string) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectFile = (path: string) => {
    setSelectedPath(path);
    setExpandedDirectories((current) => {
      const next = new Set(current);
      for (const directoryPath of directoryPathsForFile(path))
        next.add(directoryPath);
      return next;
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-dialog repository-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${repositoryName} repository preview`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="repository-preview-header">
          <div>
            <span className="repository-preview-eyebrow">REPOSITORY</span>
            <h2>{repositoryName}</h2>
          </div>
          <button
            className="resource-picker-close"
            type="button"
            onClick={onClose}
            aria-label="Close repository preview"
          >
            &times;
          </button>
        </div>
        {error ? (
          <p className="bitbucket-connection-error" role="alert">
            {error}
          </p>
        ) : (
          <div className="repository-preview-content">
            <aside
              className="repository-preview-files"
              aria-label="Repository files"
            >
              <div className="repository-tree-title">FILES</div>
              {loading ? (
                <span className="repository-tree-loading">Loading files…</span>
              ) : files.length ? (
                <RepositoryTree
                  directory={tree}
                  depth={0}
                  expandedDirectories={expandedDirectories}
                  selectedPath={selectedPath}
                  onToggleDirectory={toggleDirectory}
                  onSelectFile={selectFile}
                />
              ) : (
                <span className="repository-tree-loading">
                  This repository has no files.
                </span>
              )}
            </aside>
            <section className="repository-preview-file-content">
              <div className="repository-preview-path">
                {selectedPath ?? "Select a file"}
              </div>
              <pre>
                {preview?.content ??
                  (selectedPath
                    ? "Loading preview…"
                    : "Select a file from the tree.")}
              </pre>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
