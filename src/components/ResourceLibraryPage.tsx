import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Locale } from "@/i18n";
import type { Project, Resource, ResourceFolder } from "../mocks/data";
import CustomSelect from "./CustomSelect";
import ConfirmDialog from "./ConfirmDialog";
import DocumentUploadGuidance from "./DocumentUploadGuidance";
import VideoSopCreatePanel from "./VideoSopCreatePanel";
import VideoSopTasksPanel from "./VideoSopTasksPanel";
import { ResourceFileIcon, ResourceFolderIcon } from "./resource-icons";
import {
  filesFromDataTransfer,
  filterSystemUploadFiles,
} from "@/lib/drop-files";
import { assertUploadBatchWithinLimit } from "@/lib/upload-limits";
import {
  configureBitbucketConnection,
  disconnectBitbucketConnection,
  getBitbucketConnection,
  importBitbucketRepository,
  isBitbucketConnectionInvalidError,
  listBitbucketBranches,
  listBitbucketRepositories,
  type BitbucketBranch,
  type BitbucketConnectionStatus,
  type BitbucketRepository,
} from "@/services/api/resource-library";
import bitbucketGuideEn from "../assets/bitbucket-credentials-guide/guide.en.md?raw";
import bitbucketGuideJa from "../assets/bitbucket-credentials-guide/guide.ja.md?raw";
import bitbucketGuideZh from "../assets/bitbucket-credentials-guide/guide.zh.md?raw";
import bitbucketGuideStep0 from "../assets/bitbucket-credentials-guide/step0.png";
import bitbucketGuideStep1 from "../assets/bitbucket-credentials-guide/step1.png";
import bitbucketGuideStep2 from "../assets/bitbucket-credentials-guide/step2.png";
import bitbucketGuideStep3 from "../assets/bitbucket-credentials-guide/step3.png";
import bitbucketGuideStep4 from "../assets/bitbucket-credentials-guide/step4.png";

interface ResourceLibraryPageProps {
  resources: Resource[];
  folders: ResourceFolder[];
  projects?: Project[];
  onUploadFiles: (
    files: File[],
    folder?: string,
    options?: {
      onFolderNameResolved?: (input: { originalName: string; resolvedName: string }) => void;
    },
  ) => Promise<Resource[]> | Resource[];
  onDeleteResource?: (id: string) => void;
  onDeleteFolder?: (id: string) => void;
  onPreviewResource?: (resource: Resource) => void;
  onDownloadResource?: (resource: Resource) => void;
  onDownloadFolder?: (folder: ResourceFolder) => void;
  onRefreshResourceLibrary?: () => Promise<unknown>;
  locale: Locale;
  t: (key: string, params?: Record<string, string>) => string;
}

type SortKey = "lastSynced" | "name" | "type";
type UploadTaskStatus = "processing" | "finishing" | "failed";
type DeleteTarget =
  | { type: "resource"; resource: Resource }
  | { type: "folder"; folder: ResourceFolder };
type UploadFailure = { message: string; fileCount: number };
type AddResourceSource = "local" | "bitbucket" | "video-sop";

const bitbucketGuideImageUrls: Record<string, string> = {
  "step0.png": bitbucketGuideStep0,
  "step1.png": bitbucketGuideStep1,
  "step2.png": bitbucketGuideStep2,
  "step3.png": bitbucketGuideStep3,
  "step4.png": bitbucketGuideStep4,
};
const bitbucketGuidePreviews: Record<Locale, string> = {
  zh: bitbucketGuideZh,
  en: bitbucketGuideEn,
  ja: bitbucketGuideJa,
};

interface UploadTask {
  id: string;
  kind: "file" | "folder";
  name: string;
  size: number;
  folder?: string;
  status: UploadTaskStatus;
  error?: string;
}

function isMp4File(file: Pick<File, "name">): boolean {
  return /\.mp4$/i.test(file.name.trim());
}

function formatUploadSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function parsedFileSizeBytes(fileSize?: string): number {
  const match = fileSize?.trim().match(/^([\d.]+)\s*(B|KB|MB)$/i);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = match[2].toUpperCase();
  if (unit === "MB") return value * 1024 * 1024;
  if (unit === "KB") return value * 1024;
  return value;
}

function resourceSizeBytes(resource: Resource): number {
  if (typeof resource.size === "number" && Number.isFinite(resource.size))
    return resource.size;
  return parsedFileSizeBytes(resource.fileSize);
}

function parseTimestamp(value?: string): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function resourceUpdatedTimestamp(resource: Resource): number {
  return (
    parseTimestamp(resource.updatedAt) ||
    parseTimestamp(resource.createdAt) ||
    parseTimestamp(resource.lastSynced)
  );
}

function folderOwnUpdatedTimestamp(folder: ResourceFolder): number {
  return parseTimestamp(folder.updatedAt) || parseTimestamp(folder.createdAt);
}

function formatUpdatedTimestamp(timestamp: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function uploadErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error && error.message
      ? error.message
      : String(error || "Upload failed");
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : "";
    if (message.trim()) return message.trim();
  } catch {
    // Not a JSON error payload.
  }
  return raw;
}

function fileRelativePathParts(file: File): string[] {
  return (
    (file as File & { webkitRelativePath?: string }).webkitRelativePath || ""
  )
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
}

function uploadFolderTaskKey(
  parentId: string | undefined,
  name: string,
): string {
  return `${parentId ?? "root"}:${name.trim().toLowerCase()}`;
}

export default function ResourceLibraryPage({
  resources,
  folders,
  projects = [],
  onUploadFiles,
  onDeleteResource,
  onDeleteFolder,
  onPreviewResource,
  onDownloadResource,
  onDownloadFolder,
  onRefreshResourceLibrary,
  locale,
  t,
}: ResourceLibraryPageProps) {
  const bitbucketText = {
    localSource: t("resource.bitbucketLocalSource"),
    repositorySource: t("resource.bitbucketRepositorySource"),
    introduction: t("resource.bitbucketIntroduction"),
    readOnly: t("resource.bitbucketReadOnly"),
    manageConnection: t("resource.bitbucketManageConnection"),
    returnToRepositories: t("resource.bitbucketReturnToRepositories"),
    importBranch: t("resource.bitbucketImportBranch"),
    branchHint: t("resource.bitbucketBranchHint"),
    importHint: t("resource.bitbucketImportHint"),
    importingTitle: t("resource.bitbucketImportingTitle"),
    importingHint: t("resource.bitbucketImportingHint"),
    successTitle: t("resource.bitbucketSuccessTitle"),
    successBody: t("resource.bitbucketSuccessBody"),
    viewRepository: t("resource.bitbucketViewRepository"),
    done: t("resource.bitbucketDone"),
    sourceLabel: t("resource.bitbucketSourceLabel"),
    sync: t("resource.bitbucketSync"),
    repositorySearch: t("resource.bitbucketRepositorySearchAria"),
    repositoryEmpty: t("resource.bitbucketRepositoryEmpty"),
    connectTitle: t("resource.bitbucketConnectTitle"),
    checkingConnection: t("resource.bitbucketCheckingConnection"),
    connectionUpdated: t("resource.bitbucketConnectionUpdated"),
    disconnectQuestion: t("resource.bitbucketDisconnectQuestion"),
    confirmDisconnect: t("resource.bitbucketConfirmDisconnect"),
    keepConnection: t("resource.bitbucketKeepConnection"),
  };
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("lastSynced");
  const [ontologyFilter, setOntologyFilter] = useState<string>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [addResourceSource, setAddResourceSource] = useState<AddResourceSource>("local");
  const [dragging, setDragging] = useState(false);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [uploadFailure, setUploadFailure] = useState<UploadFailure | null>(
    null,
  );
  const [videoSopRefreshKey, setVideoSopRefreshKey] = useState(0);
  const [localUploadedResources, setLocalUploadedResources] = useState<
    Resource[]
  >([]);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [bitbucketConnectionSettings, setBitbucketConnectionSettings] = useState(false);
  const [bitbucketConnectionLoading, setBitbucketConnectionLoading] = useState(false);
  const [bitbucketConnectionUpdated, setBitbucketConnectionUpdated] = useState(false);
  const [bitbucketDisconnectConfirming, setBitbucketDisconnectConfirming] = useState(false);
  const [showBitbucketGuide, setShowBitbucketGuide] = useState(false);
  const [bitbucketConnection, setBitbucketConnection] =
    useState<BitbucketConnectionStatus | null>(null);
  const [bitbucketEmail, setBitbucketEmail] = useState("");
  const [bitbucketToken, setBitbucketToken] = useState("");
  const [bitbucketError, setBitbucketError] = useState<string | null>(null);
  const [bitbucketSaving, setBitbucketSaving] = useState(false);
  const [showBitbucketImport, setShowBitbucketImport] = useState(false);
  const [bitbucketRepositories, setBitbucketRepositories] = useState<
    BitbucketRepository[]
  >([]);
  const [bitbucketRepositorySearch, setBitbucketRepositorySearch] =
    useState("");
  const [bitbucketRepositoryPickerOpen, setBitbucketRepositoryPickerOpen] =
    useState(false);
  const [bitbucketBranchPickerOpen, setBitbucketBranchPickerOpen] = useState(false);
  const [bitbucketRepositoriesLoading, setBitbucketRepositoriesLoading] =
    useState(false);
  const [bitbucketBranches, setBitbucketBranches] = useState<BitbucketBranch[]>(
    [],
  );
  const [selectedRepository, setSelectedRepository] =
    useState<BitbucketRepository | null>(null);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [bitbucketImportError, setBitbucketImportError] = useState<
    string | null
  >(null);
  const [bitbucketImportReceipt, setBitbucketImportReceipt] = useState<Resource | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const uploadTaskTimersRef = useRef<number[]>([]);
  const isRoot = currentFolder === null;
  const currentFolderObj = currentFolder
    ? folders.find((f) => f.id === currentFolder)
    : null;
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const mergedResources = [
    ...localUploadedResources.filter(
      (resource) => !resourceIds.has(resource.id),
    ),
    ...resources,
  ];
  const ontologyLabelById = new Map(
    projects.map((project) => [project.id, project.name]),
  );
  const ontologyLabel = (id: string): string => ontologyLabelById.get(id) || id;
  const bindingIdsForResources = (items: readonly Resource[]): string[] =>
    Array.from(
      new Set(
        items.flatMap((resource) => resource.linkedOntologies.filter(Boolean)),
      ),
    ).sort((left, right) =>
      ontologyLabel(left).localeCompare(ontologyLabel(right)),
    );
  const resourceBindingIds = (resource: Resource): string[] =>
    bindingIdsForResources([resource]);
  const allOntologies = bindingIdsForResources(mergedResources);
  const refreshAfterVideoSop = useCallback(() => {
    void onRefreshResourceLibrary?.();
  }, [onRefreshResourceLibrary]);

  useEffect(() => {
    if (!(showUploadModal && addResourceSource === "bitbucket")) return;
    let active = true;
    setBitbucketConnection(null);
    setBitbucketError(null);
    setBitbucketConnectionLoading(true);
    void getBitbucketConnection()
      .then((connection) => {
        if (!active) return;
        setBitbucketConnection(connection);
        setBitbucketEmail(connection.email ?? "");
      })
      .catch((error: unknown) => {
        if (active) setBitbucketError(uploadErrorMessage(error));
      })
      .finally(() => {
        if (active) setBitbucketConnectionLoading(false);
      });
    return () => {
      active = false;
    };
  }, [addResourceSource, showUploadModal]);

  useEffect(() => {
    if (!bitbucketConnectionUpdated) return;
    const timer = window.setTimeout(() => setBitbucketConnectionUpdated(false), 3_500);
    return () => window.clearTimeout(timer);
  }, [bitbucketConnectionUpdated]);

  useEffect(() => {
    if (!showBitbucketImport && !(showUploadModal && addResourceSource === "bitbucket" && bitbucketConnection?.connected)) return;
    setBitbucketRepositorySearch("");
    setBitbucketRepositories([]);
    setBitbucketRepositoryPickerOpen(false);
    setBitbucketBranchPickerOpen(false);
    setSelectedRepository(null);
    setSelectedBranch("");
    setBitbucketBranches([]);
  }, [addResourceSource, bitbucketConnection?.connected, showBitbucketImport, showUploadModal]);

  useEffect(() => {
    if (!showBitbucketImport && !(showUploadModal && addResourceSource === "bitbucket" && bitbucketConnection?.connected)) return;
    let active = true;
    setBitbucketImportError(null);
    setBitbucketRepositoriesLoading(true);
    const timer = window.setTimeout(
      () => {
        void getBitbucketConnection()
          .then(async (connection) => {
            if (!connection.connected)
              throw new Error(t("resource.bitbucketImportNeedsConnection"));
            return listBitbucketRepositories(bitbucketRepositorySearch);
          })
          .then((repositories) => {
            if (active) setBitbucketRepositories(repositories);
          })
          .catch((error: unknown) => {
            if (!active) return;
            if (isBitbucketConnectionInvalidError(error)) {
              setBitbucketConnectionSettings(true);
              setBitbucketDisconnectConfirming(false);
              setBitbucketError(t("resource.bitbucketConnectionInvalid"));
              setBitbucketImportError(null);
              return;
            }
            setBitbucketImportError(uploadErrorMessage(error));
          })
          .finally(() => {
            if (active) setBitbucketRepositoriesLoading(false);
          });
      },
      bitbucketRepositorySearch.trim() ? 300 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [addResourceSource, bitbucketConnection?.connected, bitbucketRepositorySearch, showBitbucketImport, showUploadModal, t]);

  const chooseBitbucketRepository = async (repository: BitbucketRepository) => {
    setSelectedRepository(repository);
    setSelectedBranch("");
    setBitbucketBranches([]);
    setBitbucketImportError(null);
    try {
      const branches = await listBitbucketBranches(
        repository.workspace,
        repository.slug,
      );
      setBitbucketBranches(branches);
      setSelectedBranch(
        branches.find((branch) => branch.name === repository.mainBranch)
          ?.name ??
          branches[0]?.name ??
          "",
      );
    } catch (error) {
      if (isBitbucketConnectionInvalidError(error)) {
        setBitbucketConnectionSettings(true);
        setBitbucketDisconnectConfirming(false);
        setBitbucketError(t("resource.bitbucketConnectionInvalid"));
        setBitbucketImportError(null);
      } else {
        setBitbucketImportError(uploadErrorMessage(error));
      }
    }
  };

  const saveBitbucketRepositoryReference = async () => {
    if (!selectedRepository || !selectedBranch) return;
    if (mergedResources.some((resource) => resource.source === "bitbucket" && resource.bitbucket?.workspace === selectedRepository.workspace && resource.bitbucket.repoSlug === selectedRepository.slug)) {
      setBitbucketImportError(t("resource.bitbucketRepositoryExists"));
      return;
    }
    setBitbucketSaving(true);
    setBitbucketImportError(null);
    try {
      const imported = await importBitbucketRepository({
        workspace: selectedRepository.workspace,
        repoSlug: selectedRepository.slug,
        defaultBranch: selectedBranch,
      });
      await onRefreshResourceLibrary?.();
      if (showUploadModal) setBitbucketImportReceipt(imported);
      else setShowBitbucketImport(false);
    } catch (error) {
      if (isBitbucketConnectionInvalidError(error)) {
        setBitbucketConnectionSettings(true);
        setBitbucketDisconnectConfirming(false);
        setBitbucketError(t("resource.bitbucketConnectionInvalid"));
        setBitbucketImportError(null);
      } else {
        setBitbucketImportError(uploadErrorMessage(error));
      }
    } finally {
      setBitbucketSaving(false);
    }
  };

  const saveBitbucketConnection = async () => {
    setBitbucketSaving(true);
    setBitbucketError(null);
    try {
      const connection = await configureBitbucketConnection({
        email: bitbucketEmail,
        apiToken: bitbucketToken,
      });
      setBitbucketConnection(connection);
      setBitbucketToken("");
      if (bitbucketConnectionSettings) {
        setBitbucketConnectionUpdated(true);
        setBitbucketConnectionSettings(false);
      }
    } catch (error) {
      setBitbucketError(uploadErrorMessage(error));
    } finally {
      setBitbucketSaving(false);
    }
  };

  const disconnectBitbucket = async () => {
    setBitbucketSaving(true);
    setBitbucketError(null);
    try {
      await disconnectBitbucketConnection();
      setBitbucketConnection({ connected: false });
      setBitbucketEmail("");
      setBitbucketToken("");
      setBitbucketConnectionSettings(false);
      setBitbucketDisconnectConfirming(false);
    } catch (error) {
      setBitbucketError(uploadErrorMessage(error));
    } finally {
      setBitbucketSaving(false);
    }
  };

  const descendantFolderIds = (folderId: string): string[] => {
    const ids: string[] = [];
    const visit = (parentId: string) => {
      for (const folder of folders) {
        if (folder.parentId !== parentId) continue;
        ids.push(folder.id);
        visit(folder.id);
      }
    };
    visit(folderId);
    return ids;
  };

  const resourcesInFolderTree = (folderId: string): Resource[] => {
    const folderIds = new Set([folderId, ...descendantFolderIds(folderId)]);
    return mergedResources.filter(
      (resource) => resource.folder && folderIds.has(resource.folder),
    );
  };

  const currentFiles = mergedResources
    .filter((r) => {
      if (isRoot) return !r.folder;
      return r.folder === currentFolder;
    })
    .filter((r) => {
      if (
        ontologyFilter !== "all" &&
        !r.linkedOntologies.includes(ontologyFilter)
      )
        return false;
      if (search && !r.name.toLowerCase().includes(search.toLowerCase()))
        return false;
      return true;
    });

  const sorted = [...currentFiles].sort((a, b) => {
    if (sortKey === "name") return a.name.localeCompare(b.name);
    if (sortKey === "type") return a.type.localeCompare(b.type);
    return (
      resourceUpdatedTimestamp(b) - resourceUpdatedTimestamp(a) ||
      a.name.localeCompare(b.name)
    );
  });

  const activeUploadFolderKeys = new Set(
    uploadTasks
      .filter((task) => task.kind === "folder" && task.status !== "failed")
      .map((task) => uploadFolderTaskKey(task.folder, task.name)),
  );

  const folderUpdatedTimestamp = (folder: ResourceFolder): number =>
    Math.max(
      folderOwnUpdatedTimestamp(folder),
      ...resourcesInFolderTree(folder.id).map(resourceUpdatedTimestamp),
    );

  const visibleFolders = folders
    .filter((folder) => {
      if (isRoot ? folder.parentId : folder.parentId !== currentFolder)
        return false;
      if (
        activeUploadFolderKeys.has(
          uploadFolderTaskKey(folder.parentId, folder.name),
        )
      )
        return false;
      const folderResources = resourcesInFolderTree(folder.id);
      if (
        ontologyFilter !== "all" &&
        !folderResources.some((resource) =>
          resource.linkedOntologies.includes(ontologyFilter),
        )
      )
        return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          folder.name.toLowerCase().includes(q) ||
          folderResources.some((resource) =>
            resource.name.toLowerCase().includes(q),
          )
        );
      }
      return true;
    })
    .sort((a, b) => {
      if (sortKey === "lastSynced")
        return (
          folderUpdatedTimestamp(b) - folderUpdatedTimestamp(a) ||
          a.name.localeCompare(b.name)
        );
      return a.name.localeCompare(b.name);
    });

  const folderTrail = (folderId: string): ResourceFolder[] => {
    const trail: ResourceFolder[] = [];
    const seen = new Set<string>();
    let cursor = folderById.get(folderId);
    while (cursor && !seen.has(cursor.id)) {
      trail.unshift(cursor);
      seen.add(cursor.id);
      cursor = cursor.parentId ? folderById.get(cursor.parentId) : undefined;
    }
    return trail;
  };

  const folderTreeSize = (folderId: string): number =>
    resourcesInFolderTree(folderId).reduce(
      (total, resource) => total + resourceSizeBytes(resource),
      0,
    );

  const folderBindingIds = (folderId: string): string[] =>
    bindingIdsForResources(resourcesInFolderTree(folderId));
  const visibleUploadTasks = uploadTasks.filter(
    (task) => (task.folder ?? null) === currentFolder,
  );

  useEffect(
    () => () => {
      uploadTaskTimersRef.current.forEach((timer) =>
        window.clearTimeout(timer),
      );
      uploadTaskTimersRef.current = [];
    },
    [],
  );

  useEffect(() => {
    if (resources.length === 0 || localUploadedResources.length === 0) return;
    const liveIds = new Set(resources.map((resource) => resource.id));
    setLocalUploadedResources((prev) =>
      prev.filter((resource) => !liveIds.has(resource.id)),
    );
  }, [localUploadedResources.length, resources]);

  const uploadTasksForFiles = (
    files: File[],
    folder: string | undefined,
    startedAt: number,
  ): UploadTask[] => {
    const directoryTasks = new Map<string, UploadTask>();
    const fileTasks: UploadTask[] = [];

    files.forEach((file, index) => {
      const pathParts = fileRelativePathParts(file);
      if (pathParts.length > 1) {
        const rootName = pathParts[0];
        const key = uploadFolderTaskKey(folder, rootName);
        const existing = directoryTasks.get(key);
        if (existing) {
          existing.size += file.size;
          return;
        }
        directoryTasks.set(key, {
          id: `resource-upload-folder-${startedAt}-${index}-${Math.random().toString(36).slice(2, 7)}`,
          kind: "folder",
          name: rootName,
          size: file.size,
          folder,
          status: "processing",
        });
        return;
      }

      fileTasks.push({
        id: `resource-upload-${startedAt}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        kind: "file",
        name: file.name,
        size: file.size,
        folder,
        status: "processing",
      });
    });

    return [...directoryTasks.values(), ...fileTasks];
  };

  const handleUpload = async (files: FileList | File[]) => {
    const selectedFiles = filterSystemUploadFiles(files);
    if (selectedFiles.length === 0) return;

    if (selectedFiles.some(isMp4File)) {
      setUploadFailure({
        message: t("resource.videoSopDedicatedUpload"),
        fileCount: selectedFiles.length,
      });
      return;
    }

    try {
      assertUploadBatchWithinLimit(selectedFiles);
    } catch (error) {
      setUploadFailure({
        message: uploadErrorMessage(error),
        fileCount: selectedFiles.length,
      });
      return;
    }

    const folder = currentFolder || undefined;
    const startedAt = Date.now();
    const tasks = uploadTasksForFiles(selectedFiles, folder, startedAt);
    const taskIds = new Set(tasks.map((task) => task.id));
    setUploadTasks((prev) => [...tasks, ...prev]);
    setShowUploadModal(false);

    try {
      const uploaded = await onUploadFiles(selectedFiles, folder, {
        onFolderNameResolved: ({ originalName, resolvedName }) => {
          setUploadTasks((prev) => prev.map((task) => (
            taskIds.has(task.id) && task.kind === "folder" && task.name === originalName
              ? { ...task, name: resolvedName }
              : task
          )));
        },
      });
      if (uploaded.length > 0) {
        setLocalUploadedResources((prev) => {
          const existing = new Set(
            [...prev, ...resources].map((resource) => resource.id),
          );
          return [
            ...uploaded.filter((resource) => !existing.has(resource.id)),
            ...prev,
          ];
        });
      }
      const hasVisibleUploadedResource = uploaded.some(
        (resource) => (resource.folder ?? null) === (folder ?? null),
      );
      if (hasVisibleUploadedResource) {
        setUploadTasks((prev) => prev.filter((task) => !taskIds.has(task.id)));
      } else {
        setUploadTasks((prev) =>
          prev.map((task) =>
            taskIds.has(task.id)
              ? { ...task, status: "finishing", error: undefined }
              : task,
          ),
        );
        const timer = window.setTimeout(() => {
          setUploadTasks((prev) =>
            prev.filter((task) => !taskIds.has(task.id)),
          );
        }, 1200);
        uploadTaskTimersRef.current.push(timer);
      }
    } catch (error) {
      const message = uploadErrorMessage(error);
      setUploadTasks((prev) =>
        prev.map((task) =>
          taskIds.has(task.id)
            ? { ...task, status: "failed", error: message }
            : task,
        ),
      );
      setUploadFailure({ message, fileCount: selectedFiles.length });
    }
  };

  const openAddResource = () => {
    setAddResourceSource("local");
    setBitbucketImportReceipt(null);
    setBitbucketConnectionSettings(false);
    setBitbucketConnectionUpdated(false);
    setBitbucketDisconnectConfirming(false);
    setShowUploadModal(true);
  };

  const closeModal = () => {
    setShowUploadModal(false);
    setBitbucketImportReceipt(null);
    setBitbucketConnectionSettings(false);
    setBitbucketConnectionUpdated(false);
    setBitbucketDisconnectConfirming(false);
  };

  const handleDropUpload = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const droppedFiles = await filesFromDataTransfer(event.dataTransfer);
    await handleUpload(droppedFiles);
  };

  const removeUploadTask = (id: string) => {
    setUploadTasks((prev) => prev.filter((task) => task.id !== id));
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    if (deleteTarget.type === "resource")
      onDeleteResource?.(deleteTarget.resource.id);
    else onDeleteFolder?.(deleteTarget.folder.id);
    setDeleteTarget(null);
  };

  const renderBindingSet = (ontologyIds: string[]) => {
    const labels = ontologyIds.map(ontologyLabel);
    if (labels.length === 0) {
      return (
        <div className="rl-binding-set empty">
          <span className="rl-binding-empty">{t("resource.unlinked")}</span>
        </div>
      );
    }
    const visibleLabels = labels.slice(0, 2);
    const hiddenCount = labels.length - visibleLabels.length;
    return (
      <div className="rl-binding-set" title={labels.join(", ")}>
        {visibleLabels.map((label) => (
          <span key={label} className="rl-binding-pill">
            {label}
          </span>
        ))}
        {hiddenCount > 0 && (
          <span className="rl-binding-more">+{hiddenCount}</span>
        )}
      </div>
    );
  };

  const renderFileRow = (r: Resource) => {
    const bindings = resourceBindingIds(r);
    const updatedTime = formatUpdatedTimestamp(resourceUpdatedTimestamp(r));
    const isBitbucketRepository = r.source === "bitbucket";
    const isRepository = r.type === "repo" || isBitbucketRepository;
    return (
      <div
        key={r.id}
        className={`rl-item${isRepository ? " is-repository" : ""}`}
        onClick={() => onPreviewResource?.(r)}
      >
        <div className="rl-item-icon">
          <ResourceFileIcon name={r.name} type={r.type} />
        </div>
        <div className="rl-item-content">
          <span className="rl-item-name">{r.name}</span>
          {r.uploaderUserId ? <span className="rl-resource-uploader">Uploaded by {r.uploaderUserId}{r.uploaderTenantId ? ` · ${r.uploaderTenantId}` : ""}</span> : null}
          {isBitbucketRepository ? <span className="rl-repository-source-label">{bitbucketText.sourceLabel}{r.description ? ` · ${r.description.replace("Bitbucket repository · ", "")}` : ""}</span> : null}
        </div>
        <div className="rl-item-binding">{renderBindingSet(bindings)}</div>
        <span className="rl-item-size">{r.fileSize || ""}</span>
        <span className="rl-item-time" title={updatedTime}>
          {updatedTime || r.lastSynced}
        </span>
        <div className="rl-item-actions">
          <button
            className="rl-action-btn"
            aria-label="Download"
            onClick={(e) => {
              e.stopPropagation();
              onDownloadResource?.(r);
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path
                d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {!r.shared && <button
            className="rl-action-btn rl-action-danger"
            aria-label="Delete"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteTarget({ type: "resource", resource: r });
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path
                d="M3 6h18M8 6V4h8v2M5 6v14a2 2 0 002 2h10a2 2 0 002-2V6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>}
        </div>
      </div>
    );
  };

  const renderFolderRow = (folder: ResourceFolder) => {
    const bindings = folderBindingIds(folder.id);
    const updatedTime = formatUpdatedTimestamp(folderUpdatedTimestamp(folder));
    return (
      <div
        key={folder.id}
        className="rl-item rl-item-folder"
        onClick={() => setCurrentFolder(folder.id)}
      >
        <div className="rl-item-icon">
          <ResourceFolderIcon />
        </div>
        <div className="rl-item-content">
          <span className="rl-item-name">{folder.name}</span>
        </div>
        <div className="rl-item-binding">{renderBindingSet(bindings)}</div>
        <span className="rl-item-size">
          {formatUploadSize(folderTreeSize(folder.id))}
        </span>
        <span className="rl-item-time" title={updatedTime}>
          {updatedTime}
        </span>
        <div className="rl-item-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="rl-action-btn"
            aria-label="Download"
            onClick={() => onDownloadFolder?.(folder)}
          >
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path
                d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="rl-action-btn rl-action-danger"
            aria-label="Delete"
            onClick={() => setDeleteTarget({ type: "folder", folder })}
          >
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path
                d="M3 6h18M8 6V4h8v2M5 6v14a2 2 0 002 2h10a2 2 0 002-2V6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  const renderUploadTaskRow = (task: UploadTask) => {
    const isFailed = task.status === "failed";
    const statusText = isFailed
      ? t("resource.uploadFailed", { error: task.error || "" })
      : task.status === "finishing"
        ? t("resource.uploadFinishing")
        : t("resource.uploadProcessing");

    return (
      <div
        key={task.id}
        className={`rl-item rl-upload-task ${task.status}`}
        role={isFailed ? "alert" : "status"}
      >
        <div className="rl-item-icon">
          {task.kind === "folder" ? (
            <ResourceFolderIcon />
          ) : (
            <ResourceFileIcon name={task.name} type="file" />
          )}
        </div>
        <div className="rl-item-content">
          <span className="rl-item-name">{task.name}</span>
          <span className="rl-upload-task-status" title={statusText}>
            {statusText}
          </span>
          {!isFailed && (
            <span className="rl-upload-progress" aria-hidden="true">
              <span className="rl-upload-progress-fill" />
            </span>
          )}
        </div>
        <div className="rl-item-binding rl-binding-placeholder" />
        <span className="rl-item-size">{formatUploadSize(task.size)}</span>
        <span className="rl-item-time">
          {isFailed ? t("resource.uploadNeedsAttention") : t("common.justNow")}
        </span>
        <div className="rl-item-actions">
          {isFailed ? (
            <button
              className="rl-action-btn"
              aria-label={t("resource.dismissUpload")}
              onClick={() => removeUploadTask(task.id)}
            >
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path
                  d="M18 6L6 18M6 6l12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          ) : (
            <span className="rl-upload-spinner" aria-hidden="true" />
          )}
        </div>
      </div>
    );
  };

  const renderOntologyFilterControl = () => {
    if (allOntologies.length === 0) return null;
    return (
      <CustomSelect
        value={ontologyFilter}
        options={[
          { value: "all", label: t("resource.allFiles") },
          ...allOntologies.map((o) => ({ value: o, label: ontologyLabel(o) })),
        ]}
        onChange={(v) => setOntologyFilter(v)}
        className={`rl-filter-select${ontologyFilter !== "all" ? " filter-active" : ""}`}
        iconOnly={
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path
              d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        }
      />
    );
  };

  const renderToolbarActions = (className = "rl-toolbar-right") => (
    <div className={className}>
      {renderOntologyFilterControl()}
      <CustomSelect
        value={sortKey}
        options={[
          { value: "lastSynced", label: t("resource.updatedTime") },
          { value: "name", label: t("resource.name") },
          { value: "type", label: t("resource.type") },
        ]}
        onChange={(v) => setSortKey(v as SortKey)}
        iconOnly={
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path
              d="M3 6h18M6 12h12M9 18h6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        }
      />
      <button
        className="rl-toolbar-icon-btn"
        onClick={openAddResource}
        aria-label="Upload"
      >
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path
            d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5-5 5 5M12 5v12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );

  return (
    <div className="resource-library-page">
      <div className="resource-library-main">
        {/* Header */}
        <div className="rl-header">
          <h1>{t("resource.title")}</h1>
        </div>

        {/* Toolbar */}
        <div
          className={`rl-toolbar rl-toolbar-filters${searchOpen ? " search-open" : ""}`}
        >
          {searchOpen ? (
            <div className="search-expansion-layer rl-search-layer">
              <div className="search-expansion-field rl-search-field">
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <circle
                    cx="11"
                    cy="11"
                    r="8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M21 21l-4.35-4.35"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("common.search")}
                  autoFocus
                />
              </div>
              <button
                className="search-expansion-cancel rl-search-cancel"
                onClick={() => {
                  setSearchOpen(false);
                  setSearch("");
                }}
                type="button"
              >
                {t("common.cancel")}
              </button>
              {renderToolbarActions("rl-toolbar-right rl-search-layer-actions")}
            </div>
          ) : (
            <>
              <div className="rl-toolbar-left">
                {isRoot ? null : (
                  <div className="rl-breadcrumb">
                    <span
                      className="rl-breadcrumb-item"
                      onClick={() => setCurrentFolder(null)}
                    >
                      {t("resource.allFiles")}
                    </span>
                    {currentFolder &&
                      folderTrail(currentFolder).map((folder, index, trail) => (
                        <span className="rl-breadcrumb-segment" key={folder.id}>
                          <svg viewBox="0 0 24 24" width="12" height="12">
                            <path
                              d="M9 18l6-6-6-6"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          {index === trail.length - 1 ? (
                            <span className="rl-breadcrumb-current">
                              {folder.name}
                            </span>
                          ) : (
                            <span
                              className="rl-breadcrumb-item"
                              onClick={() => setCurrentFolder(folder.id)}
                            >
                              {folder.name}
                            </span>
                          )}
                        </span>
                      ))}
                    {!currentFolderObj && (
                      <span className="rl-breadcrumb-current">
                        {currentFolder}
                      </span>
                    )}
                  </div>
                )}
                <button
                  className="rl-toolbar-icon-btn"
                  onClick={() => setSearchOpen(true)}
                  aria-label="Search"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16">
                    <circle
                      cx="11"
                      cy="11"
                      r="8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                    <path
                      d="M21 21l-4.35-4.35"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
              {renderToolbarActions()}
            </>
          )}
        </div>

        <VideoSopTasksPanel
          folderId={currentFolder || undefined}
          refreshKey={videoSopRefreshKey}
          t={t}
          onResourceCreated={refreshAfterVideoSop}
        />

        {/* Table container with border */}
        <div className="rl-table-container">
          {/* Table header */}
          <div className="rl-table-header">
            <span className="rl-th-name">{t("resource.file")}</span>
            <span className="rl-th-binding">
              {t("resource.boundKnowledge")}
            </span>
            <span className="rl-th-size">{t("resource.size")}</span>
            <span className="rl-th-time">{t("resource.updated")}</span>
            <span className="rl-th-actions">{t("resource.actions")}</span>
          </div>

          {/* File list */}
          <div className="rl-list">
            {/* Upload tasks */}
            {visibleUploadTasks.map((task) => renderUploadTaskRow(task))}

            {/* Folders */}
            {visibleFolders.map((folder) => renderFolderRow(folder))}

            {/* Files */}
            {sorted.map((r) => renderFileRow(r))}

            {sorted.length === 0 &&
              visibleFolders.length === 0 &&
              visibleUploadTasks.length === 0 &&
              folders.length === 0 && (
                <div className="rl-empty">{t("resource.empty")}</div>
              )}
            {sorted.length === 0 &&
              visibleFolders.length === 0 &&
              visibleUploadTasks.length === 0 &&
              !isRoot && (
                <div className="rl-empty">{t("resource.folderEmpty")}</div>
              )}
          </div>
        </div>
      </div>

      {/* Add Resource Modal */}
      {showUploadModal && (
        <div className="resource-picker-backdrop" onClick={closeModal}>
          <div className="rl-add-modal" onClick={(e) => e.stopPropagation()}>
            <div className="rl-add-modal-header">
              <span className="rl-add-modal-title">
                {t("resource.addResource")}
              </span>
              <button className="resource-picker-close" onClick={closeModal}>
                &times;
              </button>
            </div>

            <div className="rl-add-modal-tabs" role="tablist" aria-label="\u8d44\u6599\u6765\u6e90">
              <button className={`rl-add-tab${addResourceSource === "local" ? " active" : ""}`} type="button" role="tab" aria-selected={addResourceSource === "local"} onClick={() => { setAddResourceSource("local"); setBitbucketImportReceipt(null); setBitbucketConnectionSettings(false); setBitbucketDisconnectConfirming(false); }}>
                {bitbucketText.localSource}
              </button>
              <button className={`rl-add-tab${addResourceSource === "bitbucket" ? " active" : ""}`} type="button" role="tab" aria-selected={addResourceSource === "bitbucket"} onClick={() => { setAddResourceSource("bitbucket"); setBitbucketImportReceipt(null); setBitbucketConnectionSettings(false); setBitbucketDisconnectConfirming(false); }}>
                {bitbucketText.repositorySource}
              </button>
              <button className={`rl-add-tab${addResourceSource === "video-sop" ? " active" : ""}`} type="button" role="tab" aria-selected={addResourceSource === "video-sop"} onClick={() => { setAddResourceSource("video-sop"); setBitbucketImportReceipt(null); setBitbucketConnectionSettings(false); setBitbucketDisconnectConfirming(false); }}>
                {t("videoSop.tab")}
              </button>
            </div>

            {addResourceSource === "local" ? <div className="rl-add-modal-body">
              <div
                className={`resource-picker-dropzone${dragging ? " dragging" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  void handleDropUpload(e);
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="28"
                  height="28"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <path d="M7 10l5-5 5 5" />
                  <path d="M12 5v12" />
                </svg>
                <span className="resource-picker-dropzone-text">
                  {t("resource.dropText")}
                </span>
                <div className="resource-picker-dropzone-actions">
                  <button
                    type="button"
                    className="resource-picker-dropzone-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                  >
                    {t("plus.uploadFile")}
                  </button>
                  <button
                    type="button"
                    className="resource-picker-dropzone-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      folderInputRef.current?.click();
                    }}
                  >
                    {t("plus.uploadFolder")}
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    if (e.target.files) void handleUpload(e.target.files);
                    e.target.value = "";
                  }}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    if (e.target.files) void handleUpload(e.target.files);
                    e.target.value = "";
                  }}
                  {...({ webkitdirectory: "", directory: "" } as Record<
                    string,
                    string
                  >)}
                />
              </div>
              <DocumentUploadGuidance t={t} />
            </div> : addResourceSource === "video-sop" ? <div className="rl-add-modal-body rl-video-sop-source-body">
              <VideoSopCreatePanel
                folderId={currentFolder || undefined}
                folderName={currentFolderObj?.name || t("resource.rootLocation")}
                locale={locale}
                t={t}
                onSubmitted={() => {
                  setVideoSopRefreshKey((value) => value + 1);
                  setShowUploadModal(false);
                }}
              />
            </div> : <div className="rl-add-modal-body rl-bitbucket-source-body">
              {bitbucketImportReceipt ? (
                <div className="rl-bitbucket-receipt">
                  <span className="rl-bitbucket-receipt-icon">✓</span>
                  <h2>{bitbucketText.successTitle}</h2>
                  <p>{bitbucketImportReceipt.name} · {bitbucketImportReceipt.description}</p>
                  <p>{bitbucketText.successBody}</p>
                  <div className="rl-bitbucket-receipt-actions">
                    <button className="modal-btn modal-btn-cancel" type="button" onClick={closeModal}>{bitbucketText.done}</button>
                    <button className="modal-btn modal-btn-primary" type="button" onClick={() => { onPreviewResource?.(bitbucketImportReceipt); closeModal(); }}>{bitbucketText.viewRepository}</button>
                  </div>
                </div>
              ) : bitbucketConnectionLoading ? (
                <div className="rl-bitbucket-progress"><span className="rl-connecting-spinner" aria-hidden="true" /><h2>{bitbucketText.checkingConnection}</h2></div>
              ) : !bitbucketConnection?.connected ? (
                <div className="rl-bitbucket-connect-flow">
                  <div className="rl-bitbucket-settings-heading"><h2>{bitbucketText.connectTitle}</h2><p>{bitbucketText.introduction}</p></div>
                  <label><span>{t("resource.bitbucketEmail")}</span><input type="email" value={bitbucketEmail} onChange={(event) => setBitbucketEmail(event.target.value)} autoComplete="username" /></label>
                  <label><span>{t("resource.bitbucketToken")}</span><input type="password" value={bitbucketToken} onChange={(event) => setBitbucketToken(event.target.value)} autoComplete="new-password" /></label>
                  <p className="rl-bitbucket-security-note">{bitbucketText.readOnly}</p>
                  <div className="rl-bitbucket-inline-actions">
                    <button className="rl-bitbucket-text-button" type="button" onClick={() => setShowBitbucketGuide(true)}>{t("resource.bitbucketGuide")}</button>
                    <button className="modal-btn modal-btn-primary" type="button" onClick={() => void saveBitbucketConnection()} disabled={bitbucketSaving || !bitbucketEmail.trim() || !bitbucketToken.trim()}>{bitbucketSaving ? t("resource.bitbucketSaving") : t("resource.bitbucketConnection")}</button>
                  </div>
                  {bitbucketError ? <p className="bitbucket-connection-error" role="alert">{bitbucketError}</p> : null}
                </div>
              ) : bitbucketConnectionSettings ? (
                <div className="rl-bitbucket-connect-flow rl-bitbucket-settings-flow">
                  <div className="rl-bitbucket-account"><span className="rl-bitbucket-connected-badge"><i aria-hidden="true" />{t("resource.bitbucketConnected", { email: bitbucketConnection.email ?? "" })}</span><button className="rl-bitbucket-text-button" type="button" onClick={() => setBitbucketConnectionSettings(false)}>{bitbucketText.returnToRepositories}</button></div>
                  <label><span>{t("resource.bitbucketEmail")}</span><input type="email" value={bitbucketEmail} onChange={(event) => setBitbucketEmail(event.target.value)} autoComplete="username" /></label>
                  <label><span>{t("resource.bitbucketToken")}</span><input type="password" value={bitbucketToken} onChange={(event) => setBitbucketToken(event.target.value)} autoComplete="new-password" placeholder={t("resource.bitbucketTokenReplace")} /></label>
                  <div className="rl-bitbucket-token-help"><p className="rl-bitbucket-security-note">{bitbucketText.readOnly}</p><button className="rl-bitbucket-text-button" type="button" onClick={() => setShowBitbucketGuide(true)}>{t("resource.bitbucketGuide")}</button></div>
                  {bitbucketError ? <p className="bitbucket-connection-error" role="alert">{bitbucketError}</p> : null}
                  <div className="rl-bitbucket-settings-actions">{bitbucketDisconnectConfirming ? <div className="rl-bitbucket-inline-confirmation"><span>{bitbucketText.disconnectQuestion}</span><button className="rl-bitbucket-text-button" type="button" onClick={() => setBitbucketDisconnectConfirming(false)} disabled={bitbucketSaving}>{bitbucketText.keepConnection}</button><button className="rl-bitbucket-danger-link" type="button" onClick={() => void disconnectBitbucket()} disabled={bitbucketSaving}>{bitbucketText.confirmDisconnect}</button></div> : <button className="rl-bitbucket-danger-link" type="button" onClick={() => setBitbucketDisconnectConfirming(true)} disabled={bitbucketSaving}>{t("resource.bitbucketDisconnect")}</button>}<span /><button className="modal-btn modal-btn-primary" type="button" onClick={() => void saveBitbucketConnection()} disabled={bitbucketSaving || !bitbucketEmail.trim() || !bitbucketToken.trim()}>{bitbucketSaving ? t("resource.bitbucketSaving") : t("resource.bitbucketSave")}</button></div>
                </div>
              ) : bitbucketSaving && selectedRepository ? (
                <div className="rl-bitbucket-progress"><span className="rl-connecting-spinner" aria-hidden="true" /><h2>{bitbucketText.importingTitle}</h2><p>{bitbucketText.importingHint}</p></div>
              ) : (
                <div className="rl-bitbucket-import-flow">
                  <div className="rl-bitbucket-account"><span className="rl-bitbucket-connected-badge"><i aria-hidden="true" />{t("resource.bitbucketConnected", { email: bitbucketConnection.email ?? "" })}</span><button className="rl-bitbucket-text-button" type="button" onClick={() => setBitbucketConnectionSettings(true)}>{bitbucketText.manageConnection}</button></div>
                  {bitbucketConnectionUpdated ? <p className="rl-bitbucket-connection-updated" role="status">{bitbucketText.connectionUpdated}</p> : null}
                  <label className="rl-bitbucket-repository-picker"><span>{t("resource.bitbucketRepository")}</span><div className="rl-bitbucket-repository-control"><button className="rl-bitbucket-repository-trigger" type="button" aria-haspopup="listbox" aria-expanded={bitbucketRepositoryPickerOpen} onClick={() => setBitbucketRepositoryPickerOpen((open) => !open)}>{selectedRepository ? `${selectedRepository.workspace}/${selectedRepository.name}` : bitbucketRepositoriesLoading ? t("resource.bitbucketRepositorySearching") : t("resource.bitbucketRepositorySelect")}<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>{bitbucketRepositoryPickerOpen ? <div className="rl-bitbucket-repository-menu"><input type="search" autoFocus value={bitbucketRepositorySearch} onChange={(event) => setBitbucketRepositorySearch(event.target.value)} placeholder={t("resource.bitbucketRepositorySearchPlaceholder")} aria-label={bitbucketText.repositorySearch} /><div className="rl-bitbucket-repository-options" role="listbox">{bitbucketRepositoriesLoading ? <p>{t("resource.bitbucketRepositorySearching")}</p> : bitbucketRepositories.length ? bitbucketRepositories.map((repository) => <button key={`${repository.workspace}/${repository.slug}`} type="button" role="option" aria-selected={selectedRepository?.workspace === repository.workspace && selectedRepository.slug === repository.slug} onClick={() => { setBitbucketRepositoryPickerOpen(false); setBitbucketRepositorySearch(""); void chooseBitbucketRepository(repository); }}><span>{repository.name}</span><small>{repository.workspace}</small></button>) : <p>{bitbucketText.repositoryEmpty}</p>}</div></div> : null}</div></label>
                  {selectedRepository ? <><label className="rl-bitbucket-repository-picker"><span>{bitbucketText.importBranch}</span><div className="rl-bitbucket-repository-control"><button className="rl-bitbucket-repository-trigger" type="button" aria-haspopup="listbox" aria-expanded={bitbucketBranchPickerOpen} onClick={() => setBitbucketBranchPickerOpen((open) => !open)}>{selectedBranch || t("resource.bitbucketBranchSelect")}<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>{bitbucketBranchPickerOpen ? <div className="rl-bitbucket-repository-menu"><div className="rl-bitbucket-repository-options" role="listbox">{bitbucketBranches.map((branch) => <button key={branch.name} type="button" role="option" aria-selected={selectedBranch === branch.name} onClick={() => { setSelectedBranch(branch.name); setBitbucketBranchPickerOpen(false); }}><span>{branch.name}</span></button>)}</div></div> : null}</div><small>{bitbucketText.branchHint}</small></label><p className="rl-bitbucket-import-hint">{bitbucketText.importHint}</p><div className="rl-bitbucket-inline-actions"><span /><button className="modal-btn modal-btn-primary" type="button" disabled={!selectedBranch} onClick={() => void saveBitbucketRepositoryReference()}>{t("resource.bitbucketImport")}</button></div></> : null}
                  {bitbucketImportError ? <p className="bitbucket-connection-error" role="alert">{bitbucketImportError}</p> : null}
                </div>
              )}
            </div>}
          </div>
        </div>
      )}
      {showBitbucketGuide && (
        <div
          className="modal-overlay"
          onClick={() => setShowBitbucketGuide(false)}
        >
          <div
            className="modal-dialog bitbucket-guide-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bitbucket-guide-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="bitbucket-guide-header">
              <h2 id="bitbucket-guide-title">{t("resource.bitbucketGuide")}</h2>
              <button
                className="resource-picker-close"
                type="button"
                onClick={() => setShowBitbucketGuide(false)}
                aria-label={t("common.cancel")}
              >
                &times;
              </button>
            </div>
            <div className="bitbucket-guide-content">
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  ),
                  img: ({ src, alt }) => (
                    <img
                      src={bitbucketGuideImageUrls[src ?? ""] ?? src}
                      alt={alt ?? ""}
                    />
                  ),
                }}
              >
                {bitbucketGuidePreviews[locale]}
              </Markdown>
            </div>
            <div className="modal-actions bitbucket-guide-actions">
              <button
                className="modal-btn modal-btn-primary"
                type="button"
                onClick={() => setShowBitbucketGuide(false)}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
      {showBitbucketImport && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!bitbucketSaving) setShowBitbucketImport(false);
          }}
        >
          <div
            className="modal-dialog bitbucket-connection-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bitbucket-import-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="bitbucket-connection-header">
              <h2 id="bitbucket-import-title">
                {t("resource.bitbucketImport")}
              </h2>
              <button
                className="resource-picker-close"
                type="button"
                onClick={() => setShowBitbucketImport(false)}
                disabled={bitbucketSaving}
              >
                &times;
              </button>
            </div>
            {bitbucketImportError ? (
              <p className="bitbucket-connection-error" role="alert">
                {bitbucketImportError}
              </p>
            ) : (
              <div className="bitbucket-import-grid">
                <label>
                  <span>{t("resource.bitbucketRepositorySearch")}</span>
                  <input
                    type="search"
                    value={bitbucketRepositorySearch}
                    onChange={(event) => {
                      setBitbucketRepositorySearch(event.target.value);
                      setSelectedRepository(null);
                      setSelectedBranch("");
                      setBitbucketBranches([]);
                    }}
                    placeholder={t(
                      "resource.bitbucketRepositorySearchPlaceholder",
                    )}
                    disabled={bitbucketSaving}
                  />
                </label>
                <label>
                  <span>{t("resource.bitbucketRepository")}</span>
                  <select
                    value={
                      selectedRepository
                        ? `${selectedRepository.workspace}/${selectedRepository.slug}`
                        : ""
                    }
                    onChange={(event) => {
                      const repository = bitbucketRepositories.find(
                        (item) =>
                          `${item.workspace}/${item.slug}` ===
                          event.target.value,
                      );
                      if (repository)
                        void chooseBitbucketRepository(repository);
                    }}
                    disabled={bitbucketRepositoriesLoading || bitbucketSaving}
                  >
                    <option value="">
                      {bitbucketRepositoriesLoading
                        ? t("resource.bitbucketRepositorySearching")
                        : t("resource.bitbucketRepositorySelect")}
                    </option>
                    {bitbucketRepositories.map((repository) => (
                      <option
                        key={`${repository.workspace}/${repository.slug}`}
                        value={`${repository.workspace}/${repository.slug}`}
                      >
                        {repository.workspace}/{repository.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("resource.bitbucketBranch")}</span>
                  <select
                    value={selectedBranch}
                    disabled={!selectedRepository || bitbucketSaving}
                    onChange={(event) => setSelectedBranch(event.target.value)}
                  >
                    <option value="">
                      {t("resource.bitbucketBranchSelect")}
                    </option>
                    {bitbucketBranches.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <div className="modal-actions">
              <button
                className="modal-btn modal-btn-cancel"
                type="button"
                onClick={() => setShowBitbucketImport(false)}
                disabled={bitbucketSaving}
              >
                {t("common.cancel")}
              </button>
              <button
                className="modal-btn modal-btn-primary"
                type="button"
                disabled={
                  !selectedRepository || !selectedBranch || bitbucketSaving
                }
                onClick={() => void saveBitbucketRepositoryReference()}
              >
                {bitbucketSaving ? (
                  <>
                    <span
                      className="rl-connecting-spinner"
                      aria-hidden="true"
                    />
                    {t("resource.bitbucketImporting")}
                  </>
                ) : (
                  t("resource.bitbucketImport")
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      {uploadFailure && (
        <div className="modal-overlay" onClick={() => setUploadFailure(null)}>
          <div
            className="modal-dialog upload-failure-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="upload-failure-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="upload-failure-title">
              {t("resource.uploadFailureTitle")}
            </h2>
            <p className="modal-body-text">
              {t("resource.uploadFailureBody", {
                count: String(uploadFailure.fileCount),
              })}
            </p>
            <pre className="upload-failure-detail">{uploadFailure.message}</pre>
            <div className="modal-actions">
              <button
                className="modal-btn modal-btn-primary"
                onClick={() => setUploadFailure(null)}
                type="button"
              >
                {t("common.ok")}
              </button>
            </div>
          </div>
        </div>
      )}
      {deleteTarget && (
        <ConfirmDialog
          title={
            deleteTarget.type === "resource"
              ? t("resource.deleteFileTitle")
              : t("resource.deleteFolderTitle")
          }
          body={
            deleteTarget.type === "resource"
              ? t("resource.deleteFileBody")
              : t("resource.deleteFolderBody")
          }
          objectName={
            deleteTarget.type === "resource"
              ? deleteTarget.resource.name
              : deleteTarget.folder.name
          }
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
