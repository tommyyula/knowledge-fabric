import { ApiRequestError, apiFetch, apiJson, apiUrl } from "@/lib/api-client";
import type { Resource, ResourceFolder } from "@/mocks/data";

interface ApiData<T> { data: T }

export interface ResourceLibrarySnapshot {
  resources: Resource[];
  folders: ResourceFolder[];
}

export interface ResourcePreview {
  path: string;
  content: string;
  contentType?: string;
}

export interface BitbucketConnectionStatus {
  connected: boolean;
  email?: string;
  accountName?: string;
  updatedAt?: string;
  lastValidatedAt?: string;
}

export interface BitbucketRepository { name: string; slug: string; workspace: string; workspaceName?: string; mainBranch?: string }
export interface BitbucketBranch { name: string }
export interface BitbucketRepositoryFile { path: string; size: number }
export interface BitbucketRepositoryFilePreview { path: string; content: string; contentType: string }

export function isBitbucketConnectionInvalidError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 409;
}

export interface ResourceUploadResult {
  resource?: Resource;
  folder?: ResourceFolder;
  resources: Resource[];
  extracted?: boolean;
}

type ResourceUploadPayload = Resource | {
  resource?: Resource;
  folder?: ResourceFolder;
  resources?: Resource[];
  extracted?: boolean;
};

export async function listResourceLibrary(): Promise<ResourceLibrarySnapshot> {
  return (await apiJson<ApiData<ResourceLibrarySnapshot>>("/api/v1/resource-library")).data;
}

export async function getBitbucketConnection(): Promise<BitbucketConnectionStatus> {
  return (await apiJson<ApiData<BitbucketConnectionStatus>>("/api/v1/resource-library/bitbucket/connection")).data;
}

export async function configureBitbucketConnection(input: { email: string; apiToken: string }): Promise<BitbucketConnectionStatus> {
  return (await apiJson<ApiData<BitbucketConnectionStatus>>("/api/v1/resource-library/bitbucket/connection", {
    method: "PUT",
    body: JSON.stringify(input),
  })).data;
}

export async function disconnectBitbucketConnection(): Promise<void> {
  await apiJson<void>("/api/v1/resource-library/bitbucket/connection", { method: "DELETE" });
}

export async function listBitbucketRepositories(search?: string): Promise<BitbucketRepository[]> {
  const query = search?.trim() ? `?query=${encodeURIComponent(search.trim())}` : "";
  return (await apiJson<ApiData<{ repositories: BitbucketRepository[] }>>(`/api/v1/resource-library/bitbucket/repositories${query}`)).data.repositories;
}

export async function listBitbucketBranches(workspace: string, repoSlug: string): Promise<BitbucketBranch[]> {
  return (await apiJson<ApiData<{ branches: BitbucketBranch[] }>>(`/api/v1/resource-library/bitbucket/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/branches`)).data.branches;
}

export async function importBitbucketRepository(input: { workspace: string; repoSlug: string; defaultBranch: string }): Promise<Resource> {
  return (await apiJson<ApiData<Resource>>("/api/v1/resource-library/bitbucket/repositories", { method: "POST", body: JSON.stringify(input) })).data;
}

export async function listBitbucketRepositoryFiles(id: string): Promise<BitbucketRepositoryFile[]> {
  return (await apiJson<ApiData<{ files: BitbucketRepositoryFile[] }>>(`/api/v1/resource-library/resources/${id}/repository-files`)).data.files;
}

export async function getBitbucketRepositoryFile(id: string, path: string): Promise<BitbucketRepositoryFilePreview> {
  return (await apiJson<ApiData<BitbucketRepositoryFilePreview>>(`/api/v1/resource-library/resources/${id}/repository-file?path=${encodeURIComponent(path)}`)).data;
}

export async function getResourcePreview(id: string): Promise<ResourcePreview> {
  return (await apiJson<ApiData<ResourcePreview>>(`/api/v1/resource-library/resources/${id}/preview`)).data;
}

export async function createResourceFolder(input: { name: string; parentId?: string }): Promise<ResourceFolder> {
  return (await apiJson<ApiData<ResourceFolder>>("/api/v1/resource-library/folders", { method: "POST", body: JSON.stringify(input) })).data;
}

export async function renameResourceFolder(id: string, name: string): Promise<ResourceFolder> {
  return (await apiJson<ApiData<ResourceFolder>>(`/api/v1/resource-library/folders/${id}`, { method: "PATCH", body: JSON.stringify({ name }) })).data;
}

export async function deleteResourceFolder(id: string): Promise<void> {
  await apiJson<void>(`/api/v1/resource-library/folders/${id}`, { method: "DELETE" });
}

export interface ResourceUploadInput {
  name: string;
  file?: File;
  contentBase64?: string;
  contentType?: string;
  folder?: string;
  description?: string;
}

function resourceUploadFormData(input: ResourceUploadInput): FormData {
  if (!input.file) throw new Error("file is required");
  const form = new FormData();
  form.append("file", input.file, input.name || input.file.name);
  form.append("name", input.name || input.file.name);
  if (input.contentType || input.file.type) form.append("contentType", input.contentType || input.file.type);
  if (input.folder) form.append("folder", input.folder);
  if (input.description) form.append("description", input.description);
  return form;
}

function isResourceUploadResource(data: ResourceUploadPayload): data is Resource {
  return typeof (data as Resource).id === "string" && typeof (data as Resource).name === "string" && Array.isArray((data as Resource).linkedOntologies);
}

export async function uploadResource(input: ResourceUploadInput): Promise<ResourceUploadResult> {
  const normalize = (data: ResourceUploadPayload): ResourceUploadResult => {
    if (isResourceUploadResource(data)) return { resource: data, resources: [data] };
    return {
      resource: data.resource,
      folder: data.folder,
      resources: data.resources ?? (data.resource ? [data.resource] : []),
      extracted: data.extracted,
    };
  };

  if (input.file) {
    return normalize((await apiJson<ApiData<ResourceUploadPayload>>("/api/v1/resource-library/resources", { method: "POST", body: resourceUploadFormData(input) })).data);
  }
  return normalize((await apiJson<ApiData<ResourceUploadPayload>>("/api/v1/resource-library/resources", { method: "POST", body: JSON.stringify(input) })).data);
}

export async function renameResource(id: string, name: string): Promise<Resource> {
  return (await apiJson<ApiData<Resource>>(`/api/v1/resource-library/resources/${id}`, { method: "PATCH", body: JSON.stringify({ name }) })).data;
}

export async function deleteResource(id: string): Promise<void> {
  await apiJson<void>(`/api/v1/resource-library/resources/${id}`, { method: "DELETE" });
}

export function resourceDownloadUrl(id: string): string {
  return apiUrl(`/api/v1/resource-library/resources/${id}/download`);
}

export function folderDownloadUrl(id: string): string {
  return apiUrl(`/api/v1/resource-library/folders/${id}/download`);
}

export async function downloadResource(id: string): Promise<void> {
  await downloadFromApi(`/api/v1/resource-library/resources/${id}/download`, `resource-${id}`);
}

export async function downloadFolder(id: string): Promise<void> {
  await downloadFromApi(`/api/v1/resource-library/folders/${id}/download`, `folder-${id}.tar`);
}

async function downloadFromApi(path: string, fallbackName: string): Promise<void> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error((await res.text()) || `Download failed: ${res.status}`);
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/i);
  const name = match?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
