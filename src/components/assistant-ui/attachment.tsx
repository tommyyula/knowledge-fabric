import { type FC, useEffect, useState } from "react";
import { AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import {
  FileArchiveIcon,
  FileCodeIcon,
  FolderIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileTypeIcon,
  GitBranchIcon,
  PresentationIcon,
  PlusIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

interface LegacyAttachmentProps {
  name: string;
  onRemove?: () => void;
}

export function Attachment({ name, onRemove }: LegacyAttachmentProps) {
  return (
    <div className="chat-attached-chip">
      <span>{name}</span>
      {onRemove && <button className="chat-attached-remove" onClick={onRemove}>&times;</button>}
    </div>
  );
}

function useFileSrc(file: File | undefined) {
  const [src, setSrc] = useState<string | undefined>();
  useEffect(() => {
    if (!file) {
      setSrc(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setSrc(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return src;
}

function useAttachmentSrc() {
  const file = useAuiState((s) => s.attachment.type === "image" ? s.attachment.file : undefined);
  const image = useAuiState((s) => s.attachment.type === "image" ? s.attachment.content?.find((item) => item.type === "image") : undefined);
  return useFileSrc(file) ?? image?.image;
}

interface AttachmentKindMeta {
  kind: string;
  label: string;
  Icon: LucideIcon;
}

interface MessageFilePart {
  type: string;
  filename?: string;
  name?: string;
  url?: string;
  mediaType?: string;
  mimeType?: string;
  contentType?: string;
  providerMetadata?: {
    workspace?: { path?: string; label?: string; kind?: "file" | "folder" };
    resource?: {
      id?: string;
      name?: string;
      type?: string;
      source?: string;
      bitbucket?: { workspace?: string; repoSlug?: string; defaultBranch?: string };
    };
    resourceFolder?: { id?: string; name?: string };
    optimistic?: { status?: string; statusLabel?: string };
    contentType?: string;
  };
}

function fileExtension(name: string): string {
  const clean = name.split(/[?#]/, 1)[0]?.trim().toLowerCase() ?? "";
  const ext = clean.includes(".") ? clean.split(".").pop() : "";
  return ext ?? "";
}

function attachmentKind(name: string, contentType: string | undefined, isImage: boolean): AttachmentKindMeta {
  const ext = fileExtension(name);
  const mediaType = contentType?.toLowerCase() ?? "";
  if (mediaType === "application/x-resource-repository") {
    return { kind: "repo", label: "Repository", Icon: GitBranchIcon };
  }
  if (isImage || mediaType.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"].includes(ext)) {
    return { kind: "image", label: "Image", Icon: FileImageIcon };
  }
  if (["xls", "xlsx", "xlsm", "csv", "tsv", "numbers"].includes(ext) || mediaType.includes("spreadsheet") || mediaType.includes("csv")) {
    return { kind: "spreadsheet", label: "Spreadsheet", Icon: FileSpreadsheetIcon };
  }
  if (["doc", "docx", "rtf", "odt", "pages"].includes(ext) || mediaType.includes("word") || mediaType.includes("document")) {
    return { kind: "document", label: "Document", Icon: FileTextIcon };
  }
  if (ext === "pdf" || mediaType === "application/pdf") {
    return { kind: "pdf", label: "PDF", Icon: FileTextIcon };
  }
  if (["ppt", "pptx", "key", "odp"].includes(ext) || mediaType.includes("presentation")) {
    return { kind: "presentation", label: "Presentation", Icon: PresentationIcon };
  }
  if (["zip", "rar", "7z", "tar", "gz", "tgz"].includes(ext) || mediaType.includes("zip") || mediaType.includes("compressed")) {
    return { kind: "archive", label: "Archive", Icon: FileArchiveIcon };
  }
  if (["json", "yaml", "yml", "xml"].includes(ext) || mediaType.includes("json") || mediaType.includes("xml")) {
    return { kind: "data", label: "Data", Icon: FileTypeIcon };
  }
  if (["js", "jsx", "ts", "tsx", "py", "java", "go", "rs", "rb", "php", "css", "html", "sql", "sh"].includes(ext)) {
    return { kind: "code", label: "Code", Icon: FileCodeIcon };
  }
  if (["md", "txt", "log"].includes(ext) || mediaType.startsWith("text/")) {
    return { kind: "text", label: "Text", Icon: FileTextIcon };
  }
  return { kind: "file", label: ext ? ext.toUpperCase() : "File", Icon: FileTextIcon };
}

export const AttachmentTile: FC = () => {
  const src = useAttachmentSrc();
  const name = useAuiState((s) => s.attachment.name);
  const isComposer = useAuiState((s) => (s.attachment as { source?: string }).source !== "message");
  const isImage = useAuiState((s) => s.attachment.type === "image");
  const contentType = useAuiState((s) => (s.attachment as { contentType?: string; file?: File }).contentType ?? (s.attachment as { file?: File }).file?.type);
  const kind = attachmentKind(name, contentType, isImage);
  const Icon = kind.Icon;

  return (
    <AttachmentPrimitive.Root
      className={cn(
        isComposer ? "aui-composer-attachment-root" : "aui-message-attachment-root",
        `aui-attachment-kind-${kind.kind}`,
        !isComposer && isImage && "aui-attachment-root-image",
      )}
    >
      <div className={cn("aui-composer-attachment-card", !isComposer && "aui-message-attachment-card")} title={name}>
        <div className="aui-composer-attachment-icon" aria-hidden="true">
          {isImage && src && !isComposer ? <img src={src} alt="" /> : <Icon />}
        </div>
        <div className="aui-composer-attachment-body">
          <div className="aui-composer-attachment-name">{name}</div>
          <div className="aui-composer-attachment-type">{kind.label}</div>
        </div>
        {isComposer ? (
          <AttachmentPrimitive.Remove render={<TooltipIconButton tooltip="Remove file" className="aui-composer-attachment-remove" />}>
            <XIcon />
          </AttachmentPrimitive.Remove>
        ) : null}
      </div>
    </AttachmentPrimitive.Root>
  );
};

const MessageFileAttachmentCard: FC<{ part: MessageFilePart }> = ({ part }) => {
  const optimistic = part.providerMetadata?.optimistic;
  const processing = optimistic?.status === "processing";
  const statusLabel = optimistic?.statusLabel || "Uploading and processing...";

  if (part.providerMetadata?.resourceFolder) {
    const name = part.providerMetadata.resourceFolder.name || part.filename || part.name || "Resource folder";
    return (
      <div className="aui-message-attachment-root aui-attachment-kind-folder" aria-busy={processing || undefined}>
        <div className={cn("aui-composer-attachment-card aui-message-attachment-card", processing && "is-processing")} title={processing ? `${name} · ${statusLabel}` : name}>
          <div className="aui-composer-attachment-icon" aria-hidden="true">
            <FolderIcon />
            {processing ? <span className="aui-message-attachment-spinner" /> : null}
          </div>
          <div className="aui-composer-attachment-body">
            <div className="aui-composer-attachment-name">{name}</div>
            <div className="aui-composer-attachment-type">{processing ? statusLabel : "Folder"}</div>
            {processing ? <span className="aui-message-attachment-progress" aria-hidden="true"><span /></span> : null}
          </div>
        </div>
      </div>
    );
  }

  const workspace = part.providerMetadata?.workspace;
  const resource = part.providerMetadata?.resource;
  const isWorkspaceFolder = workspace?.kind === "folder" || part.mediaType === "application/x-workspace-folder";
  const isRepository = resource?.type === "repo" || resource?.source === "bitbucket" || Boolean(resource?.bitbucket) || part.mediaType === "application/x-resource-repository";
  const name = workspace?.label || resource?.name || part.filename || part.name || workspace?.path?.split("/").pop() || "Resource file";
  const title = workspace?.path ?? name;
  if (isWorkspaceFolder) {
    return (
      <div className="aui-message-attachment-root aui-attachment-kind-folder" aria-busy={processing || undefined}>
        <div className={cn("aui-composer-attachment-card aui-message-attachment-card", processing && "is-processing")} title={processing ? `${title} · ${statusLabel}` : title}>
          <div className="aui-composer-attachment-icon" aria-hidden="true">
            <FolderIcon />
            {processing ? <span className="aui-message-attachment-spinner" /> : null}
          </div>
          <div className="aui-composer-attachment-body">
            <div className="aui-composer-attachment-name">{name}</div>
            <div className="aui-composer-attachment-type">{processing ? statusLabel : "Folder"}</div>
            {processing ? <span className="aui-message-attachment-progress" aria-hidden="true"><span /></span> : null}
          </div>
        </div>
      </div>
    );
  }
  const contentType = isRepository ? "application/x-resource-repository" : part.contentType || part.mediaType || part.mimeType || part.providerMetadata?.contentType;
  const isImage = Boolean(contentType?.toLowerCase().startsWith("image/"));
  const kind = attachmentKind(name, contentType, isImage);
  const Icon = kind.Icon;

  return (
    <div className={cn("aui-message-attachment-root", `aui-attachment-kind-${kind.kind}`)} aria-busy={processing || undefined}>
      <div className={cn("aui-composer-attachment-card aui-message-attachment-card", processing && "is-processing")} title={processing ? `${title} · ${statusLabel}` : title}>
        <div className="aui-composer-attachment-icon" aria-hidden="true">
          {isImage && part.url ? <img src={part.url} alt="" /> : <Icon />}
          {processing ? <span className="aui-message-attachment-spinner" /> : null}
        </div>
        <div className="aui-composer-attachment-body">
          <div className="aui-composer-attachment-name">{name}</div>
          <div className="aui-composer-attachment-type">{processing ? statusLabel : kind.label}</div>
          {processing ? <span className="aui-message-attachment-progress" aria-hidden="true"><span /></span> : null}
        </div>
      </div>
    </div>
  );
};

export const UserMessageAttachments: FC = () => (
  <div className="aui-user-message-attachments">
    <MessagePrimitive.Parts>
      {({ part }) => (part.type === "file" ? <MessageFileAttachmentCard part={part as MessageFilePart} /> : null)}
    </MessagePrimitive.Parts>
  </div>
);

export const ComposerAttachments: FC = () => (
  <div className="aui-composer-attachments flex w-full flex-row items-start gap-2 overflow-x-auto empty:hidden">
    <ComposerPrimitive.Attachments>{() => <AttachmentTile />}</ComposerPrimitive.Attachments>
  </div>
);

export const ComposerAddAttachment: FC = () => (
  <ComposerPrimitive.AddAttachment render={<TooltipIconButton tooltip="Add attachment" className="aui-composer-add-attachment size-8 rounded-full text-muted-foreground hover:text-foreground" aria-label="Add attachment" />}>
    <PlusIcon className="size-5" />
  </ComposerPrimitive.AddAttachment>
);
