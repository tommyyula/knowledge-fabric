import {
  FileArchiveIcon,
  FileCodeIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileTypeIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  PresentationIcon,
  type LucideIcon,
} from "lucide-react";
import type { ResourceType } from "@/mocks/data";

interface ResourceIconMeta {
  kind: string;
  Icon: LucideIcon;
}

function fileExtension(name: string): string {
  const clean = name.split(/[?#]/, 1)[0]?.trim().toLowerCase() ?? "";
  const ext = clean.includes(".") ? clean.split(".").pop() : "";
  return ext ?? "";
}

function resourceIconMeta(name: string, type?: ResourceType): ResourceIconMeta {
  const ext = fileExtension(name);
  if (type === "website") return { kind: "website", Icon: GlobeIcon };
  if (type === "image" || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"].includes(ext)) return { kind: "image", Icon: FileImageIcon };
  if (type === "spreadsheet" || ["xls", "xlsx", "xlsm", "csv", "tsv", "numbers"].includes(ext)) return { kind: "spreadsheet", Icon: FileSpreadsheetIcon };
  if (["doc", "docx", "rtf", "odt", "pages"].includes(ext)) return { kind: "document", Icon: FileTextIcon };
  if (ext === "pdf") return { kind: "pdf", Icon: FileTextIcon };
  if (["ppt", "pptx", "key", "odp"].includes(ext)) return { kind: "presentation", Icon: PresentationIcon };
  if (["zip", "rar", "7z", "tar", "gz", "tgz"].includes(ext)) return { kind: "archive", Icon: FileArchiveIcon };
  if (type === "api" || ["json", "yaml", "yml", "xml"].includes(ext)) return { kind: "data", Icon: FileTypeIcon };
  if (type === "repo") return { kind: "repo", Icon: GitBranchIcon };
  if (["js", "jsx", "ts", "tsx", "py", "java", "go", "rs", "rb", "php", "css", "html", "sql", "sh"].includes(ext)) return { kind: "code", Icon: FileCodeIcon };
  if (type === "doc" || ["md", "txt", "log"].includes(ext)) return { kind: "text", Icon: FileTextIcon };
  return { kind: "file", Icon: FileTextIcon };
}

export function ResourceFileIcon({ name, type }: { name: string; type?: ResourceType }) {
  const { kind, Icon } = resourceIconMeta(name, type);
  return <Icon className={`resource-kind-icon resource-kind-${kind}`} aria-hidden="true" />;
}

export function ResourceFolderIcon() {
  return <FolderIcon className="resource-kind-icon resource-kind-folder" aria-hidden="true" />;
}
