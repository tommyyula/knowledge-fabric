import {
  ArchiveIcon,
  Code2Icon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  PresentationIcon,
  type LucideIcon,
} from "lucide-react";

interface DocumentUploadGuidanceProps {
  t: (key: string, params?: Record<string, string>) => string;
  variant?: "full" | "compact";
}

export default function DocumentUploadGuidance({ t, variant = "full" }: DocumentUploadGuidanceProps) {
  const formats: Array<{ key: string; Icon: LucideIcon }> = [
    { key: "uploadLimits.formatDocs", Icon: FileTextIcon },
    { key: "uploadLimits.formatSlides", Icon: PresentationIcon },
    { key: "uploadLimits.formatSheets", Icon: FileSpreadsheetIcon },
    { key: "uploadLimits.formatCode", Icon: Code2Icon },
    { key: "uploadLimits.formatImages", Icon: FileImageIcon },
    { key: "uploadLimits.formatArchive", Icon: ArchiveIcon },
  ];
  const limits = [
    ["uploadLimits.totalLabel", "uploadLimits.totalValue"],
    ["uploadLimits.pdfLabel", "uploadLimits.pdfValue"],
    ["uploadLimits.presentationLabel", "uploadLimits.presentationValue"],
    ["uploadLimits.wordLabel", "uploadLimits.wordValue"],
    ["uploadLimits.imageLabel", "uploadLimits.imageValue"],
    ["uploadLimits.timeoutLabel", "uploadLimits.timeoutValue"],
  ];

  if (variant === "compact") {
    return (
      <div
        className="upload-guidance-compact"
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          aria-describedby="upload-guidance-compact-tooltip"
          className="upload-guidance-compact-trigger"
          type="button"
        >
          {t("uploadLimits.supportedLabel")}
        </button>
        <div
          className="upload-guidance-compact-tooltip"
          id="upload-guidance-compact-tooltip"
          role="tooltip"
        >
          <div className="upload-guidance-compact-title">{t("uploadLimits.title")}</div>
          <div className="upload-guidance-compact-formats">
            {formats.map(({ key, Icon }) => (
              <span key={key} className="upload-guidance-compact-format">
                <Icon />
                <span>{t(key)}</span>
              </span>
            ))}
          </div>
          <div className="upload-guidance-compact-limits">
            {limits.map(([labelKey, valueKey]) => (
              <div key={labelKey} className="upload-guidance-compact-limit">
                <span>{t(labelKey)}</span>
                <strong>{t(valueKey)}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="upload-guidance" aria-label={t("uploadLimits.title")}>
      <div className="upload-guidance-format-row" aria-label={t("uploadLimits.supportedLabel")}>
        {formats.map(({ key, Icon }) => (
          <span key={key} className="upload-guidance-chip">
            <Icon />
            <span>{t(key)}</span>
          </span>
        ))}
      </div>
      <div className="upload-guidance-limit-grid" aria-label={t("uploadLimits.limitsLabel")}>
        {limits.map(([labelKey, valueKey]) => (
          <div key={labelKey} className="upload-guidance-limit">
            <span className="upload-guidance-limit-label">{t(labelKey)}</span>
            <span className="upload-guidance-limit-value">{t(valueKey)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
