import { useEffect, useState } from "react";
import type { OperationRun } from "@/contracts/ontology";
import { useOntologyFile } from "@/hooks/useOntologies";
import { getOntologyFile } from "@/services/api/ontology";
import { errorMessage, showToast } from "@/lib/toast";
import { operationRunStatusKey, operationRunTitle } from "@/lib/operation-runs";
import FilePreviewModal from "@/components/FilePreviewModal";
import OperationArtifactList, { type OperationOutputFile } from "@/components/OperationArtifactList";

interface OperationRunDetailsProps {
  run: OperationRun;
  t: (key: string, params?: Record<string, string>) => string;
}

function downloadName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || "artifact.txt";
}

function outputDisplayPath(run: OperationRun, path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const operationRoot = `operations/${run.id}/`;
  return normalized.startsWith(operationRoot) ? normalized.slice(operationRoot.length) : normalized;
}

function operationOutputFiles(run: OperationRun): OperationOutputFile[] {
  const files: OperationOutputFile[] = [];
  const seen = new Set<string>();
  const add = (file: OperationOutputFile) => {
    if (seen.has(file.path)) return;
    seen.add(file.path);
    files.push(file);
  };

  if (run.reportPath) {
    add({
      path: run.reportPath,
      description: run.artifacts.find((artifact) => artifact.path === run.reportPath)?.description,
      displayPath: outputDisplayPath(run, run.reportPath),
    });
  }
  run.artifacts.forEach((artifact) => add({
    ...artifact,
    displayPath: outputDisplayPath(run, artifact.path),
  }));

  if (!run.reportPath && (run.resultSummary || run.error)) {
    const body = run.error || run.resultSummary || "";
    add({
      path: `operations/${run.id}/result.md`,
      displayPath: "result.md",
      description: operationRunTitle(run),
      content: `# ${operationRunTitle(run)}\n\n${body}`,
    });
  }

  return files;
}

export default function OperationRunDetails({ run, t }: OperationRunDetailsProps) {
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const outputFiles = operationOutputFiles(run);
  const previewFile = outputFiles.find((file) => file.path === previewPath) ?? null;
  const previewQuery = useOntologyFile(run.ontologyId, previewFile?.content === undefined ? previewPath : null);

  useEffect(() => {
    setPreviewPath(null);
    setDownloadingPath(null);
  }, [run.id]);

  const previewArtifact = (artifact: OperationOutputFile) => {
    setPreviewPath(artifact.path);
  };

  const downloadArtifact = async (artifact: OperationOutputFile) => {
    setDownloadingPath(artifact.path);
    try {
      const file = artifact.content === undefined
        ? await getOntologyFile(run.ontologyId, artifact.path)
        : { path: artifact.path, content: artifact.content };
      const blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName(file.path || artifact.path);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      showToast({ type: "error", message: t("operations.downloadFailed", { error: errorMessage(error) }) });
    } finally {
      setDownloadingPath(null);
    }
  };

  return (
    <div className="operation-run-detail operation-output-tree">
      <div className="operation-run-outcome">
        <span className={`operation-run-status operation-run-status-${run.status}`}>
          {t(operationRunStatusKey(run))}
        </span>
        {run.error ? <span className="operation-run-outcome-message">{run.error}</span> : null}
      </div>
      <OperationArtifactList
        artifacts={outputFiles}
        downloadingPath={downloadingPath}
        onPreview={previewArtifact}
        onDownload={(artifact) => void downloadArtifact(artifact)}
        t={t}
      />

      {previewPath ? (
        <FilePreviewModal
          path={previewQuery.data?.path ?? previewPath}
          content={previewFile?.content ?? previewQuery.data?.content}
          loading={previewFile?.content === undefined && previewQuery.isLoading}
          error={previewFile?.content === undefined && previewQuery.error ? errorMessage(previewQuery.error) : undefined}
          knownPaths={outputFiles.map((artifact) => artifact.path)}
          onNavigatePath={setPreviewPath}
          onClose={() => setPreviewPath(null)}
          t={t}
        />
      ) : null}
    </div>
  );
}
