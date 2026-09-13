import { apiFetch, apiJson } from "@/lib/api-client";

export type AdminDataEntryType = "directory" | "file" | "symlink" | "other";
export type AdminDataPreviewType = "text" | "image" | "pdf" | null;

export interface AdminDataEntry {
  name: string;
  path: string;
  type: AdminDataEntryType;
  size: number | null;
  modifiedAt: string;
  previewType: AdminDataPreviewType;
}

export interface AdminDataDirectory {
  root: string;
  path: string;
  entries: AdminDataEntry[];
}

export interface AdminDataTextPreview {
  path: string;
  content: string;
  contentType: string;
}

interface ApiData<T> {
  data: T;
}

interface AdminDataUpload {
  file: File;
  relativePath: string;
}

function adminDataUrl(action: string, path: string): string {
  const params = new URLSearchParams({ path });
  return `/api/v1/admin/data/${action}?${params.toString()}`;
}

export async function listAdminData(path = ""): Promise<AdminDataDirectory> {
  return (
    await apiJson<ApiData<AdminDataDirectory>>(adminDataUrl("entries", path))
  ).data;
}

export async function getAdminDataTextPreview(
  path: string,
): Promise<AdminDataTextPreview> {
  return (
    await apiJson<ApiData<AdminDataTextPreview>>(adminDataUrl("preview", path))
  ).data;
}

export async function getAdminDataContent(path: string): Promise<Blob> {
  const response = await apiFetch(adminDataUrl("content", path));
  if (!response.ok)
    throw new Error(
      (await response.text()) || `Preview failed: ${response.status}`,
    );
  return response.blob();
}

export async function downloadAdminData(
  path: string,
  fallbackName: string,
): Promise<void> {
  const response = await apiFetch(adminDataUrl("download", path));
  if (!response.ok)
    throw new Error(
      (await response.text()) || `Download failed: ${response.status}`,
    );
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const basicName = disposition.match(/filename="([^"]+)"/i)?.[1];
  const name = encodedName
    ? decodeURIComponent(encodedName)
    : (basicName ?? fallbackName);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function uploadAdminData(
  path: string,
  uploads: readonly AdminDataUpload[],
): Promise<number> {
  const body = new FormData();
  for (const upload of uploads) {
    body.append("files", upload.file, upload.relativePath);
  }
  const response = await apiFetch(adminDataUrl("uploads", path), {
    method: "POST",
    body,
  });
  if (!response.ok)
    throw new Error(
      (await response.text()) || `Upload failed: ${response.status}`,
    );
  return ((await response.json()) as ApiData<{ uploaded: number }>).data
    .uploaded;
}

export async function deleteAdminData(path: string): Promise<void> {
  await apiJson<void>("/api/v1/admin/data/entries", {
    method: "DELETE",
    body: JSON.stringify({ path }),
  });
}
