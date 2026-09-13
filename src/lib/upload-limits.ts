export const MAX_UPLOAD_FILE_BYTES = 500 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function assertUploadBatchWithinLimit(files: readonly File[]): void {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= MAX_UPLOAD_FILE_BYTES) return;
  throw new Error(`Selected files total ${formatBytes(total)}; maximum upload size is ${formatBytes(MAX_UPLOAD_FILE_BYTES)}.`);
}
