import { Router } from "express";
import fs from "node:fs/promises";
import { z } from "zod";
import { requireTenantContext } from "../auth/requireTenantContext";
import { asyncRoute } from "../http";
import { listAccessibleKnowledgeBaseProjects } from "../ontologies/repository";
import {
  createResourceFolder,
  createBitbucketRepositoryReference,
  bitbucketRepositoryCacheDirectory,
  getResourceBinding,
  listBitbucketRepositoryCachedFiles,
  readBitbucketRepositoryCachedFile,
  readBitbucketRepositoryReference,
  createResourceUpload,
  createResourceUploadFromFile,
  type ResourceUploadResult,
  deleteResource,
  deleteResourceFolder,
  listAccessibleResourceLibrary,
  readAccessibleResourceObject,
  readFolderArchive,
  renameResource,
  renameResourceFolder,
  ResourceInUseError,
  updateBitbucketRepositoryCacheSummary,
} from "./repository";
import {
  cleanupMultipartUpload,
  isMultipartRequest,
  parseSingleMultipartUpload,
} from "../uploads/multipart";
import { isSystemMetadataUploadPath } from "../uploads/system-files";
import { workspacePath } from "../ontologies/workspace";
import {
  checkoutBitbucketRepositoryCache,
  refreshBitbucketRepositoryCheckout,
} from "../bitbucket/git";
import {
  configureBitbucketConnection,
  disconnectBitbucketConnection,
  getBitbucketConnectionStatus,
  getBitbucketRepository,
  listBitbucketBranches,
  listBitbucketRepositories,
} from "../bitbucket/connection";

export const resourceLibraryRouter = Router();

const folderCreateSchema = z.object({
  name: z.string().trim().min(1).max(180),
  parentId: z.string().trim().min(1).optional(),
});
const folderPatchSchema = z.object({ name: z.string().trim().min(1).max(180) });
const resourceUploadSchema = z
  .object({
    name: z.string().trim().min(1).max(180),
    content: z
      .string()
      .max(32 * 1024 * 1024)
      .optional(),
    contentBase64: z
      .string()
      .max(80 * 1024 * 1024)
      .optional(),
    contentType: z.string().trim().max(120).optional(),
    folder: z.string().trim().min(1).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .refine((body) => Boolean(body.content || body.contentBase64), {
    message: "content or contentBase64 is required",
  });
const resourceMultipartFieldsSchema = z.object({
  name: z.string().trim().min(1).max(180).optional(),
  contentType: z.string().trim().max(120).optional(),
  folder: z.string().trim().min(1).optional(),
  description: z.string().trim().max(500).optional(),
});
const resourcePatchSchema = z.object({
  name: z.string().trim().min(1).max(180).optional(),
  folder: z.string().trim().min(1).nullable().optional(),
});
const repositoryRefreshSchema = z.object({
  ontologyId: z.string().trim().min(1).max(120),
});
const bitbucketConnectionSchema = z.object({
  email: z.string().trim().email().max(320),
  apiToken: z.string().trim().min(1).max(8_000),
});
const bitbucketPathSegmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._-]+$/);
const bitbucketRepositoryReferenceSchema = z.object({
  workspace: bitbucketPathSegmentSchema,
  repoSlug: bitbucketPathSegmentSchema,
  defaultBranch: z.string().trim().min(1).max(255),
});
const bitbucketRepositoryListSchema = z.object({
  query: z.string().trim().max(120).optional(),
});
const bitbucketRepositoryFileSchema = z.object({
  path: z.string().trim().min(1).max(2_000),
});

function uploadBuffer(body: z.infer<typeof resourceUploadSchema>): Buffer {
  if (body.contentBase64) return Buffer.from(body.contentBase64, "base64");
  return Buffer.from(body.content ?? "", "utf8");
}

function downloadName(name: string): string {
  return name.replace(/["\r\n]/g, "_");
}

function ignoredResourceUploadResult(): ResourceUploadResult {
  return { resources: [], ignored: true };
}

function uploadResultStatus(result: ResourceUploadResult): number {
  return "ignored" in result && result.ignored ? 200 : 201;
}

function isLikelyText(data: Buffer): boolean {
  const sample = data.subarray(0, Math.min(data.byteLength, 4096));
  return !sample.includes(0);
}

function previewContent(resourceName: string, data: Buffer): string {
  if (isLikelyText(data)) return data.toString("utf8").replace(/^\uFEFF/, "");
  return [
    `# ${resourceName}`,
    "",
    "This resource is a binary file and cannot be rendered as text preview.",
    "",
    "Use download to inspect the original file.",
  ].join("\n");
}

async function accessibleOntologyIds(tenantId: string, userId: string): Promise<Set<string>> {
  return new Set((await listAccessibleKnowledgeBaseProjects(tenantId, userId))
    .filter(({ project }) => !project.deletedAt)
    .map(({ project }) => project.id));
}

async function ensureBitbucketRepositoryCache(
  tenantId: string,
  ownerId: string,
  reference: Awaited<ReturnType<typeof readBitbucketRepositoryReference>>,
): Promise<void> {
  if (!reference?.bitbucket) return;
  try {
    await fs.access(
      bitbucketRepositoryCacheDirectory(tenantId, ownerId, reference.id),
    );
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await checkoutBitbucketRepositoryCache({
    tenantId,
    ownerId,
    referenceId: reference.id,
    workspace: reference.bitbucket.workspace,
    repoSlug: reference.bitbucket.repoSlug,
    branch: reference.bitbucket.defaultBranch,
  });
  await updateBitbucketRepositoryCacheSummary(tenantId, ownerId, reference.id);
}

resourceLibraryRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const authorization = req.header("authorization");
    res.json({ data: await listAccessibleResourceLibrary(ctx.tenantId, ctx.ownerId, await accessibleOntologyIds(ctx.tenantId, ctx.ownerId), authorization) });
  }),
);

resourceLibraryRouter.get(
  "/bitbucket/connection",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    res.json({
      data: await getBitbucketConnectionStatus(ctx.tenantId, ctx.ownerId),
    });
  }),
);

resourceLibraryRouter.put(
  "/bitbucket/connection",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const connection = await configureBitbucketConnection(
      ctx.tenantId,
      ctx.ownerId,
      bitbucketConnectionSchema.parse(req.body ?? {}),
    );
    res.json({ data: connection });
  }),
);

resourceLibraryRouter.delete(
  "/bitbucket/connection",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    await disconnectBitbucketConnection(ctx.tenantId, ctx.ownerId);
    res.status(204).send();
  }),
);

resourceLibraryRouter.get(
  "/bitbucket/repositories",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const { query } = bitbucketRepositoryListSchema.parse(req.query);
    res.json({
      data: {
        repositories: await listBitbucketRepositories(
          ctx.tenantId,
          ctx.ownerId,
          query,
        ),
      },
    });
  }),
);

resourceLibraryRouter.get(
  "/bitbucket/repositories/:workspace/:repoSlug/branches",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const workspace = bitbucketPathSegmentSchema.parse(req.params.workspace);
    const repoSlug = bitbucketPathSegmentSchema.parse(req.params.repoSlug);
    res.json({
      data: {
        branches: await listBitbucketBranches(
          ctx.tenantId,
          ctx.ownerId,
          workspace,
          repoSlug,
        ),
      },
    });
  }),
);

resourceLibraryRouter.post(
  "/bitbucket/repositories",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const input = bitbucketRepositoryReferenceSchema.parse(req.body ?? {});
    const repository = await getBitbucketRepository(
      ctx.tenantId,
      ctx.ownerId,
      input.workspace,
      input.repoSlug,
    );
    const resource = await createBitbucketRepositoryReference(
      ctx.tenantId,
      ctx.ownerId,
      {
        name: repository.name,
        workspace: repository.workspace,
        repoSlug: repository.slug,
        defaultBranch: input.defaultBranch,
      },
    );
    try {
      await checkoutBitbucketRepositoryCache({
        tenantId: ctx.tenantId,
        ownerId: ctx.ownerId,
        referenceId: resource.id,
        workspace: repository.workspace,
        repoSlug: repository.slug,
        branch: input.defaultBranch,
      });
      const cached = await updateBitbucketRepositoryCacheSummary(
        ctx.tenantId,
        ctx.ownerId,
        resource.id,
      );
      res.status(201).json({ data: cached ?? resource });
    } catch (error) {
      await deleteResource(ctx.tenantId, ctx.ownerId, resource.id).catch(
        () => undefined,
      );
      throw error;
    }
  }),
);

resourceLibraryRouter.get(
  "/resources/:resourceId/repository-files",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const reference = await readBitbucketRepositoryReference(
      ctx.tenantId,
      ctx.ownerId,
      String(req.params.resourceId),
    );
    if (!reference)
      return void res
        .status(404)
        .json({ error: "Bitbucket repository reference not found" });
    await ensureBitbucketRepositoryCache(ctx.tenantId, ctx.ownerId, reference);
    res.json({
      data: {
        files: await listBitbucketRepositoryCachedFiles(
          ctx.tenantId,
          ctx.ownerId,
          reference.id,
        ),
      },
    });
  }),
);

resourceLibraryRouter.get(
  "/resources/:resourceId/repository-file",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const reference = await readBitbucketRepositoryReference(
      ctx.tenantId,
      ctx.ownerId,
      String(req.params.resourceId),
    );
    if (!reference)
      return void res
        .status(404)
        .json({ error: "Bitbucket repository reference not found" });
    await ensureBitbucketRepositoryCache(ctx.tenantId, ctx.ownerId, reference);
    const file = await readBitbucketRepositoryCachedFile(
      ctx.tenantId,
      ctx.ownerId,
      reference.id,
      bitbucketRepositoryFileSchema.parse(req.query).path,
    );
    if (!file)
      return void res.status(404).json({ error: "Repository file not found" });
    res.json({ data: file });
  }),
);

resourceLibraryRouter.post(
  "/resources/:resourceId/refresh",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const ontologyId = repositoryRefreshSchema.parse(req.body ?? {}).ontologyId;
    const reference = await readBitbucketRepositoryReference(
      ctx.tenantId,
      ctx.ownerId,
      String(req.params.resourceId),
    );
    if (!reference)
      return void res
        .status(404)
        .json({ error: "Bitbucket repository reference not found" });
    const binding = await getResourceBinding(
      ctx.tenantId,
      ctx.ownerId,
      reference.id,
      ontologyId,
    );
    if (!binding)
      return void res
        .status(404)
        .json({ error: "Repository checkout not found for this ontology" });
    await refreshBitbucketRepositoryCheckout({
      tenantId: ctx.tenantId,
      ownerId: ctx.ownerId,
      workspaceRoot: workspacePath(ctx.tenantId, ctx.user.id, ontologyId),
      rawRoot: binding.rawRoot,
    });
    res.status(204).send();
  }),
);

resourceLibraryRouter.post(
  "/folders",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const body = folderCreateSchema.parse(req.body ?? {});
    res.status(201).json({
      data: await createResourceFolder(ctx.tenantId, ctx.ownerId, body),
    });
  }),
);

resourceLibraryRouter.patch(
  "/folders/:folderId",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const folder = await renameResourceFolder(
      ctx.tenantId,
      ctx.ownerId,
      String(req.params.folderId),
      folderPatchSchema.parse(req.body ?? {}).name,
    );
    if (!folder)
      return void res.status(404).json({ error: "Folder not found" });
    res.json({ data: folder });
  }),
);

resourceLibraryRouter.delete(
  "/folders/:folderId",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    let deleted: boolean;
    try {
      deleted = await deleteResourceFolder(ctx.tenantId, ctx.ownerId, String(req.params.folderId));
    } catch (error) {
      if (error instanceof ResourceInUseError) return void res.status(409).json({ error: error.message, ontologyIds: error.ontologyIds });
      throw error;
    }
    res
      .status(deleted ? 204 : 404)
      .send(deleted ? undefined : { error: "Folder not found" });
  }),
);

resourceLibraryRouter.get(
  "/folders/:folderId/download",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const archive = await readFolderArchive(
      ctx.tenantId,
      ctx.ownerId,
      String(req.params.folderId),
    );
    if (!archive)
      return void res.status(404).json({ error: "Folder not found" });
    res.header("Content-Type", "application/x-tar");
    res.header(
      "Content-Disposition",
      `attachment; filename="${downloadName(archive.name)}"`,
    );
    res.send(archive.data);
  }),
);

resourceLibraryRouter.post(
  "/resources",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    if (isMultipartRequest(req)) {
      const upload = await parseSingleMultipartUpload(req);
      try {
        const fields = resourceMultipartFieldsSchema.parse(upload.fields);
        const uploadName = fields.name || upload.name;
        if (
          upload.ignored ||
          isSystemMetadataUploadPath(upload.name) ||
          isSystemMetadataUploadPath(uploadName)
        ) {
          res.status(200).json({ data: ignoredResourceUploadResult() });
          return;
        }
        const resource = await createResourceUploadFromFile(
          ctx.tenantId,
          ctx.ownerId,
          {
            name: uploadName,
            filePath: upload.path,
            size: upload.size,
            folder: fields.folder,
            contentType: fields.contentType || upload.contentType,
            description: fields.description,
          },
        );
        res.status(uploadResultStatus(resource)).json({ data: resource });
        return;
      } finally {
        await cleanupMultipartUpload(upload);
      }
    }
    const body = resourceUploadSchema.parse(req.body ?? {});
    if (isSystemMetadataUploadPath(body.name)) {
      res.status(200).json({ data: ignoredResourceUploadResult() });
      return;
    }
    const resource = await createResourceUpload(ctx.tenantId, ctx.ownerId, {
      name: body.name,
      data: uploadBuffer(body),
      folder: body.folder,
      contentType: body.contentType,
      description: body.description,
    });
    res.status(uploadResultStatus(resource)).json({ data: resource });
  }),
);

resourceLibraryRouter.patch(
  "/resources/:resourceId",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const resource = await renameResource(
      ctx.tenantId,
      ctx.ownerId,
      String(req.params.resourceId),
      resourcePatchSchema.parse(req.body ?? {}),
    );
    if (!resource)
      return void res.status(404).json({ error: "Resource not found" });
    res.json({ data: resource });
  }),
);

resourceLibraryRouter.delete(
  "/resources/:resourceId",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    let deleted: boolean;
    try {
      deleted = await deleteResource(ctx.tenantId, ctx.ownerId, String(req.params.resourceId));
    } catch (error) {
      if (error instanceof ResourceInUseError) return void res.status(409).json({ error: error.message, ontologyIds: error.ontologyIds });
      throw error;
    }
    res
      .status(deleted ? 204 : 404)
      .send(deleted ? undefined : { error: "Resource not found" });
  }),
);

resourceLibraryRouter.get(
  "/resources/:resourceId/preview",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const object = await readAccessibleResourceObject(
      ctx.tenantId,
      ctx.ownerId,
      String(req.params.resourceId),
      await accessibleOntologyIds(ctx.tenantId, ctx.ownerId),
    );
    if (!object)
      return void res.status(404).json({ error: "Resource not found" });
    res.json({
      data: {
        path: object.resource.name,
        content: previewContent(object.resource.name, object.data),
        contentType: isLikelyText(object.data)
          ? object.resource.contentType
          : "text/markdown; charset=utf-8",
      },
    });
  }),
);

resourceLibraryRouter.get(
  "/resources/:resourceId/download",
  asyncRoute(async (req, res) => {
    const ctx = await requireTenantContext(req);
    const object = await readAccessibleResourceObject(
      ctx.tenantId,
      ctx.ownerId,
      String(req.params.resourceId),
      await accessibleOntologyIds(ctx.tenantId, ctx.ownerId),
    );
    if (!object)
      return void res.status(404).json({ error: "Resource not found" });
    res.header(
      "Content-Type",
      object.resource.contentType || "application/octet-stream",
    );
    res.header(
      "Content-Disposition",
      `attachment; filename="${downloadName(object.resource.name)}"`,
    );
    res.send(object.data);
  }),
);
