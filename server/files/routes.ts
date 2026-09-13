import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { requireTenantContext } from "../auth/requireTenantContext";
import { asyncRoute } from "../http";
import { hasKnowledgeBaseCapability, resolveKnowledgeBaseAccess } from "../ontologies/access";
import { CONTENT_ROOT, LEGACY_CONTENT_ROOT, ensureWorkspace, listRawSources, readContentTree, readFile, readWorkspaceTree, refreshRawSourcesInJourney } from "../ontologies/workspace";
import { createResource, createResourceFolder, recordResourceBinding } from "../resource-library/repository";
import { cleanupMultipartUpload, isMultipartRequest, parseSingleMultipartUpload, readMultipartUpload } from "../uploads/multipart";
import { isSystemMetadataUploadPath } from "../uploads/system-files";
import { buildKnowledgeGraph } from "./knowledge-graph";
import { buildOntologyGraph } from "./ontology-graph";
import { writeConvertedUploads, type ConvertedUploadFile } from "./converted-upload-writer";

export const filesRouter = Router();
const uploadSchema = z.object({
  name: z.string().trim().min(1).max(180),
  content: z.string().max(32 * 1024 * 1024).optional(),
  contentBase64: z.string().max(80 * 1024 * 1024).optional(),
  contentType: z.string().max(120).optional(),
  targetDir: z.enum(["raw", "sources"]).default("raw"),
}).refine((body) => Boolean(body.content || body.contentBase64), { message: "content or contentBase64 is required" });
const multipartUploadFieldsSchema = z.object({
  name: z.string().trim().min(1).max(180).optional(),
  contentType: z.string().trim().max(120).optional(),
  targetDir: z.enum(["raw", "sources"]).default("raw"),
});

function uploadBuffer(body: z.infer<typeof uploadSchema>): Buffer {
  if (body.contentBase64) return Buffer.from(body.contentBase64, "base64");
  return Buffer.from(body.content ?? "", "utf-8");
}

function convertedLibraryPath(filePath: string, targetDir: string): string {
  const clean = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const prefix = `${targetDir}/`;
  return clean.startsWith(prefix) ? clean.slice(prefix.length) : clean;
}

async function ignoredUploadResponse(root: string, targetDir: "raw" | "sources", name: string) {
  const journeyState = targetDir === "raw" ? await refreshRawSourcesInJourney(root) : undefined;
  return {
    path: "",
    name,
    size: 0,
    converted: false,
    converter: "text" as const,
    conversionStatus: "not_required" as const,
    files: [],
    ignored: true,
    ...(journeyState ? { journeyState } : {}),
  };
}

async function ensureResourceLibraryFolderPath(
  ctx: { tenantId: string; ownerId: string },
  folderIds: Map<string, string>,
  parts: string[],
): Promise<string | undefined> {
  let parentId: string | undefined;
  let currentPath = "";
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const existing = folderIds.get(currentPath);
    if (existing) {
      parentId = existing;
      continue;
    }
    const folder = await createResourceFolder(ctx.tenantId, ctx.ownerId, {
      name: part,
      ...(parentId ? { parentId } : {}),
    });
    folderIds.set(currentPath, folder.id);
    parentId = folder.id;
  }
  return parentId;
}

async function mirrorConvertedRawUploadsToResourceLibrary(
  ctx: { tenantId: string; ownerId: string },
  ontologyId: string,
  root: string,
  targetDir: "raw" | "sources",
  files: ConvertedUploadFile[],
): Promise<void> {
  if (targetDir !== "raw") return;
  const folderIds = new Map<string, string>();
  for (const file of files) {
    const relativePath = convertedLibraryPath(file.path, targetDir);
    const parts = relativePath.split("/").filter(Boolean);
    const fileName = parts.pop() || file.name || path.posix.basename(file.path);
    if (isSystemMetadataUploadPath(relativePath) || isSystemMetadataUploadPath(fileName)) continue;
    const folder = parts.length ? await ensureResourceLibraryFolderPath(ctx, folderIds, parts) : undefined;
    const content = await readFile(root, file.path);
    const resource = await createResource(ctx.tenantId, ctx.ownerId, {
      name: fileName,
      data: Buffer.from(content, "utf8"),
      ...(folder ? { folder } : {}),
      contentType: "text/markdown; charset=utf-8",
      description: `Converted from ${file.sourceName ?? file.originalName}`,
    });
    await recordResourceBinding(ctx.tenantId, ctx.ownerId, {
      resourceId: resource.id,
      ontologyId,
      rawRoot: file.path,
      rawPaths: [file.path],
    });
  }
}

filesRouter.get("/:ontologyId/tree", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access) return void res.status(404).json({ error: "Ontology not found" });
  const root = await ensureWorkspace(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  const scope = typeof req.query.scope === "string" ? req.query.scope : "knowledge";
  if (scope === "workspace" && !hasKnowledgeBaseCapability(access, "contribute")) return void res.status(403).json({ error: "Viewer access is limited to published knowledge" });
  res.json({ data: scope === "workspace" ? await readWorkspaceTree(root) : await readContentTree(root) });
}));

filesRouter.get("/:ontologyId/raw", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access) return void res.status(404).json({ error: "Ontology not found" });
  const root = await ensureWorkspace(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  res.json({ data: await listRawSources(root) });
}));

filesRouter.post("/:ontologyId/raw", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "contribute")) return void res.status(404).json({ error: "Ontology not found" });
  const project = access.project;
  if (isMultipartRequest(req)) {
    const upload = await parseSingleMultipartUpload(req);
    try {
      const fields = multipartUploadFieldsSchema.parse({ ...upload.fields, targetDir: "raw" });
      const root = await ensureWorkspace(project, access.workspaceTenantId, access.workspaceOwnerId);
      const uploadName = fields.name || upload.name;
      if (upload.ignored || isSystemMetadataUploadPath(upload.name) || isSystemMetadataUploadPath(uploadName)) {
        res.status(200).json({ data: await ignoredUploadResponse(root, "raw", uploadName) });
        return;
      }
      const files = await writeConvertedUploads(root, "raw", {
        name: uploadName,
        data: await readMultipartUpload(upload),
        contentType: fields.contentType || upload.contentType,
      });
      await mirrorConvertedRawUploadsToResourceLibrary(ctx, project.id, root, "raw", files);
      const first = files[0];
      if (!first) {
        res.status(200).json({ data: await ignoredUploadResponse(root, "raw", uploadName) });
        return;
      }
      const journeyState = await refreshRawSourcesInJourney(root);
      res.status(201).json({ data: { ...first, files, journeyState } });
      return;
    } finally {
      await cleanupMultipartUpload(upload);
    }
  }
  const body = uploadSchema.parse({ ...(req.body ?? {}), targetDir: "raw" });
  const root = await ensureWorkspace(project, access.workspaceTenantId, access.workspaceOwnerId);
  if (isSystemMetadataUploadPath(body.name)) {
    res.status(200).json({ data: await ignoredUploadResponse(root, "raw", body.name) });
    return;
  }
  const data = uploadBuffer(body);
  const files = await writeConvertedUploads(root, "raw", { name: body.name, data, fallbackText: body.content, contentType: body.contentType });
  await mirrorConvertedRawUploadsToResourceLibrary(ctx, project.id, root, "raw", files);
  const first = files[0];
  if (!first) {
    res.status(200).json({ data: await ignoredUploadResponse(root, "raw", body.name) });
    return;
  }
  const journeyState = await refreshRawSourcesInJourney(root);
  res.status(201).json({ data: { ...first, files, journeyState } });
}));

filesRouter.get("/:ontologyId/files", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access) return void res.status(404).json({ error: "Ontology not found" });
  const requestedPath = typeof req.query.path === "string" ? req.query.path : "CLAUDE.md";
  const root = await ensureWorkspace(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  const canReadWorkspace = hasKnowledgeBaseCapability(access, "contribute");
  const candidates = new Set<string>(canReadWorkspace ? [requestedPath] : []);
  if (requestedPath.startsWith(`${LEGACY_CONTENT_ROOT}/`)) {
    candidates.add(`${CONTENT_ROOT}/${requestedPath.slice(LEGACY_CONTENT_ROOT.length + 1)}`);
  } else if (requestedPath.startsWith(`${CONTENT_ROOT}/`)) {
    if (canReadWorkspace) candidates.add(`${LEGACY_CONTENT_ROOT}/${requestedPath.slice(CONTENT_ROOT.length + 1)}`);
  } else {
    candidates.add(`${CONTENT_ROOT}/${requestedPath}`);
    if (canReadWorkspace) candidates.add(`${LEGACY_CONTENT_ROOT}/${requestedPath}`);
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const content = await readFile(root, candidate);
      return void res.json({ data: { path: candidate, content } });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}));

filesRouter.post("/:ontologyId/graph", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "contribute")) return void res.status(404).json({ error: "Ontology not found" });
  const project = access.project;
  const root = await ensureWorkspace(project, access.workspaceTenantId, access.workspaceOwnerId);
  const result = await buildKnowledgeGraph(root, project.name);
  res.status(201).json({
    data: {
      graphPath: result.graphPath,
      htmlPath: result.htmlPath,
      html: result.html,
      stats: result.graph.stats,
    },
  });
}));

filesRouter.post("/:ontologyId/ontology-graph", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "contribute")) return void res.status(404).json({ error: "Ontology not found" });
  const root = await ensureWorkspace(access.project, access.workspaceTenantId, access.workspaceOwnerId);
  const result = await buildOntologyGraph(root);
  res.status(201).json({
    data: {
      graphPath: result.graphPath,
      htmlPath: result.htmlPath,
      html: result.html,
      stats: result.graph.stats,
    },
  });
}));

filesRouter.post("/:ontologyId/files", asyncRoute(async (req, res) => {
  const ctx = await requireTenantContext(req);
  const access = await resolveKnowledgeBaseAccess(ctx, String(req.params.ontologyId));
  if (!access || !hasKnowledgeBaseCapability(access, "contribute")) return void res.status(404).json({ error: "Ontology not found" });
  const project = access.project;
  if (isMultipartRequest(req)) {
    const upload = await parseSingleMultipartUpload(req);
    try {
      const fields = multipartUploadFieldsSchema.parse(upload.fields);
      const root = await ensureWorkspace(project, access.workspaceTenantId, access.workspaceOwnerId);
      const uploadName = fields.name || upload.name;
      if (upload.ignored || isSystemMetadataUploadPath(upload.name) || isSystemMetadataUploadPath(uploadName)) {
        res.status(200).json({ data: await ignoredUploadResponse(root, fields.targetDir, uploadName) });
        return;
      }
      const files = await writeConvertedUploads(root, fields.targetDir, {
        name: uploadName,
        data: await readMultipartUpload(upload),
        contentType: fields.contentType || upload.contentType,
      });
      await mirrorConvertedRawUploadsToResourceLibrary(ctx, project.id, root, fields.targetDir, files);
      const first = files[0];
      if (!first) {
        res.status(200).json({ data: await ignoredUploadResponse(root, fields.targetDir, uploadName) });
        return;
      }
      const journeyState = fields.targetDir === "raw" ? await refreshRawSourcesInJourney(root) : undefined;
      res.status(201).json({ data: { ...first, files, journeyState } });
      return;
    } finally {
      await cleanupMultipartUpload(upload);
    }
  }
  const body = uploadSchema.parse(req.body ?? {});
  const root = await ensureWorkspace(project, access.workspaceTenantId, access.workspaceOwnerId);
  if (isSystemMetadataUploadPath(body.name)) {
    res.status(200).json({ data: await ignoredUploadResponse(root, body.targetDir, body.name) });
    return;
  }
  const data = uploadBuffer(body);
  const files = await writeConvertedUploads(root, body.targetDir, { name: body.name, data, fallbackText: body.content, contentType: body.contentType });
  await mirrorConvertedRawUploadsToResourceLibrary(ctx, project.id, root, body.targetDir, files);
  const first = files[0];
  if (!first) {
    res.status(200).json({ data: await ignoredUploadResponse(root, body.targetDir, body.name) });
    return;
  }
  const journeyState = body.targetDir === "raw" ? await refreshRawSourcesInJourney(root) : undefined;
  res.status(201).json({ data: { ...first, files, journeyState } });
}));
