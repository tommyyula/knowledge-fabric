export function normalizeUploadPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean).join("/");
}

export function isSystemMetadataUploadPath(value: string | null | undefined): boolean {
  if (!value) return false;
  const parts = normalizeUploadPath(value).split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  const lowerName = name.toLowerCase();
  return parts.includes("__MACOSX")
    || name === ".DS_Store"
    || name.startsWith("._")
    || lowerName === "thumbs.db"
    || lowerName === "desktop.ini";
}
