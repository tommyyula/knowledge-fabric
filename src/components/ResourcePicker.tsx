import { useEffect, useRef, useState, type DragEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Resource, ResourceFolder } from "../mocks/data";
import {
  configureBitbucketConnection,
  getBitbucketConnection,
  importBitbucketRepository,
  isBitbucketConnectionInvalidError,
  listBitbucketBranches,
  listBitbucketRepositories,
  type BitbucketBranch,
  type BitbucketConnectionStatus,
  type BitbucketRepository,
} from "@/services/api/resource-library";
import { filesFromDataTransfer, filterSystemUploadFiles } from "@/lib/drop-files";
import DocumentUploadGuidance from "./DocumentUploadGuidance";
import { ResourceFileIcon, ResourceFolderIcon } from "./resource-icons";
import bitbucketGuideZh from "../assets/bitbucket-credentials-guide/guide.zh.md?raw";
import bitbucketGuideStep0 from "../assets/bitbucket-credentials-guide/step0.png";
import bitbucketGuideStep1 from "../assets/bitbucket-credentials-guide/step1.png";
import bitbucketGuideStep2 from "../assets/bitbucket-credentials-guide/step2.png";
import bitbucketGuideStep3 from "../assets/bitbucket-credentials-guide/step3.png";
import bitbucketGuideStep4 from "../assets/bitbucket-credentials-guide/step4.png";

interface ResourcePickerProps {
  resources: Resource[];
  folders: ResourceFolder[];
  onConfirm: (selected: ResourcePickerSelection[]) => void;
  onUploadFiles: (files: File[]) => Promise<Resource[]> | Resource[];
  onClose: () => void;
  t: (key: string, params?: Record<string, string>) => string;
}

export type ResourcePickerSelection =
  | { type: "resource"; resource: Resource }
  | { type: "folder"; folder: ResourceFolder };

interface PickerFolderProps {
  folder: ResourceFolder;
  childFolders: ResourceFolder[];
  directFiles: Resource[];
  selected: Set<string>;
  allSelected: boolean;
  someSelected: boolean;
  disabled?: boolean;
  onToggleAll: () => void;
  onToggleFile: (id: string) => void;
  isResourceSelected: (resource: Resource) => boolean;
  isResourceDisabled: (resource: Resource) => boolean;
  isFolderSelected: (folder: ResourceFolder) => boolean;
  isFolderDisabled: (folder: ResourceFolder) => boolean;
  onToggleFolder: (folder: ResourceFolder) => void;
  folderChildren: (parentId: string) => ResourceFolder[];
  folderDirectFiles: (folderId: string) => Resource[];
  folderTreeFiles: (folderId: string) => Resource[];
  t: (key: string, params?: Record<string, string>) => string;
}

const resourceSelectionKey = (id: string) => `resource:${id}`;
const folderSelectionKey = (id: string) => `folder:${id}`;

function uploadErrorMessage(error: unknown): string {
  const raw = error instanceof Error && error.message ? error.message : String(error || "Upload failed");
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : "";
    if (message.trim()) return message.trim();
  } catch {
    // Not a JSON error payload.
  }
  return raw;
}

function Checkbox({ checked, indeterminate }: { checked: boolean; indeterminate?: boolean }) {
  if (checked) {
    return (
      <svg viewBox="0 0 24 24" width="15" height="15">
        <rect x="3" y="3" width="18" height="18" rx="3" fill="var(--accent)" stroke="var(--accent)" strokeWidth="2"/>
        <path d="M7 13l3 3 7-7" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (indeterminate) {
    return (
      <svg viewBox="0 0 24 24" width="15" height="15">
        <rect x="3" y="3" width="18" height="18" rx="3" fill="var(--accent)" stroke="var(--accent)" strokeWidth="2"/>
        <path d="M7 12h10" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"/>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="var(--text-tertiary)" strokeWidth="2"/>
    </svg>
  );
}

function ResourceRow({ resource, selected, disabled = false, onToggle, t }: {
  resource: Resource;
  selected: boolean;
  disabled?: boolean;
  onToggle: (id: string) => void;
  t: (key: string, params?: Record<string, string>) => string;
}) {
  const isRepository = resource.type === "repo" || resource.source === "bitbucket";
  return (
    <div
      className={`resource-picker-item${isRepository ? " is-repository" : ""}${selected ? " selected" : ""}${disabled ? " disabled" : ""}`}
      onClick={() => { if (!disabled) onToggle(resource.id); }}
    >
      <span className="resource-picker-checkbox">
        <Checkbox checked={selected} />
      </span>
      <span className="resource-picker-item-icon">
        <ResourceFileIcon name={resource.name} type={resource.type} />
      </span>
      <span className="resource-picker-item-name">{resource.name}</span>
      {resource.linkedOntologies.length === 0 && (
        <span className="resource-picker-item-unlinked">{t("picker.unlinked")}</span>
      )}
    </div>
  );
}

function PickerFolder({
  folder,
  childFolders,
  directFiles,
  selected,
  allSelected,
  someSelected,
  disabled = false,
  onToggleAll,
  onToggleFile,
  isResourceSelected,
  isResourceDisabled,
  isFolderSelected,
  isFolderDisabled,
  onToggleFolder,
  folderChildren,
  folderDirectFiles,
  folderTreeFiles,
  t,
}: PickerFolderProps) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = childFolders.length > 0 || directFiles.length > 0;
  const hasSelectedDescendantFolder = (folderId: string): boolean => (
    folderChildren(folderId).some((child) => selected.has(folderSelectionKey(child.id)) || hasSelectedDescendantFolder(child.id))
  );

  return (
    <div className="resource-picker-folder-group">
      <div className={`resource-picker-item resource-picker-folder-row${allSelected ? " selected" : ""}${disabled ? " disabled" : ""}`}>
        <span className="resource-picker-checkbox" onClick={(e) => { e.stopPropagation(); if (!disabled) onToggleAll(); }}>
          <Checkbox checked={allSelected} indeterminate={someSelected} />
        </span>
        <span className="resource-picker-item-icon" onClick={() => setExpanded(!expanded)}>
          <ResourceFolderIcon />
        </span>
        <span className="resource-picker-item-name" onClick={() => setExpanded(!expanded)}>{folder.name}</span>
        <svg className={`resource-picker-folder-chevron${expanded ? " open" : ""}`} onClick={() => setExpanded(!expanded)} viewBox="0 0 24 24" width="12" height="12"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </div>
      {expanded && hasChildren && (
        <div className="resource-picker-folder-children">
          {childFolders.map((child) => {
            const childTreeFiles = folderTreeFiles(child.id);
            const childAllSelected = isFolderSelected(child);
            const childSomeSelected = !childAllSelected && (
              childTreeFiles.some((resource) => selected.has(resourceSelectionKey(resource.id))) ||
              hasSelectedDescendantFolder(child.id)
            );
            const childDisabled = disabled || isFolderDisabled(child);
            return (
              <PickerFolder
                key={child.id}
                folder={child}
                childFolders={folderChildren(child.id)}
                directFiles={folderDirectFiles(child.id)}
                selected={selected}
                allSelected={childAllSelected}
                someSelected={childSomeSelected}
                disabled={childDisabled}
                onToggleAll={() => onToggleFolder(child)}
                onToggleFile={onToggleFile}
                isResourceSelected={isResourceSelected}
                isResourceDisabled={isResourceDisabled}
                isFolderSelected={isFolderSelected}
                isFolderDisabled={isFolderDisabled}
                onToggleFolder={onToggleFolder}
                folderChildren={folderChildren}
                folderDirectFiles={folderDirectFiles}
                folderTreeFiles={folderTreeFiles}
                t={t}
              />
            );
          })}
          {directFiles.map((resource) => (
            <ResourceRow
              key={resource.id}
              resource={resource}
              selected={isResourceSelected(resource)}
              disabled={disabled || isResourceDisabled(resource)}
              onToggle={onToggleFile}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ResourcePicker({ resources, folders, onConfirm, onUploadFiles, onClose, t }: ResourcePickerProps) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [localResources, setLocalResources] = useState<Resource[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showUnlinkedOnly, setShowUnlinkedOnly] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Block document-level drag events outside ResourcePicker to prevent ComposerPrimitive.AttachmentDropzone from receiving drops
  useEffect(() => {
    const blockDrag = (e: globalThis.DragEvent) => {
      // Allow events inside ResourcePicker
      if (pickerRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("dragenter", blockDrag, true);
    document.addEventListener("dragover", blockDrag, true);
    document.addEventListener("drop", blockDrag, true);
    return () => {
      document.removeEventListener("dragenter", blockDrag, true);
      document.removeEventListener("dragover", blockDrag, true);
      document.removeEventListener("drop", blockDrag, true);
    };
  }, []);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showBitbucketImport, setShowBitbucketImport] = useState(false);
  const [bitbucketConnection, setBitbucketConnection] = useState<BitbucketConnectionStatus | null>(null);
  const [bitbucketEmail, setBitbucketEmail] = useState("");
  const [bitbucketToken, setBitbucketToken] = useState("");
  const [bitbucketRepositories, setBitbucketRepositories] = useState<BitbucketRepository[]>([]);
  const [bitbucketRepositoriesLoading, setBitbucketRepositoriesLoading] = useState(false);
  const [bitbucketBranches, setBitbucketBranches] = useState<BitbucketBranch[]>([]);
  const [bitbucketRepository, setBitbucketRepository] = useState<BitbucketRepository | null>(null);
  const [bitbucketBranch, setBitbucketBranch] = useState("");
  const [bitbucketBusy, setBitbucketBusy] = useState(false);
  const [bitbucketImporting, setBitbucketImporting] = useState(false);
  const [bitbucketError, setBitbucketError] = useState<string | null>(null);
  const [bitbucketRepositorySearch, setBitbucketRepositorySearch] = useState("");
  const [bitbucketRepositoryOpen, setBitbucketRepositoryOpen] = useState(false);
  const [bitbucketBranchOpen, setBitbucketBranchOpen] = useState(false);
  const [showBitbucketGuide, setShowBitbucketGuide] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allResources = [
    ...localResources.filter((resource) => !resources.some((item) => item.id === resource.id)),
    ...resources,
  ];
  const resourceById = new Map(allResources.map((resource) => [resource.id, resource]));
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));

  const folderChildren = (parentId: string | null): ResourceFolder[] => (
    folders.filter((folder) => parentId ? folder.parentId === parentId : !folder.parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
  );

  const folderDirectFiles = (folderId: string): Resource[] => (
    allResources.filter((resource) => resource.folder === folderId).sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? b.lastSynced ?? "") - Date.parse(a.updatedAt ?? a.createdAt ?? a.lastSynced ?? ""))
  );

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

  const folderTreeFiles = (folderId: string): Resource[] => {
    const folderIds = new Set([folderId, ...descendantFolderIds(folderId)]);
    return allResources.filter((resource) => resource.folder && folderIds.has(resource.folder));
  };

  const ancestorFolderIds = (folderId: string | undefined): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    let cursor = folderId ? folderById.get(folderId) : undefined;
    while (cursor && !seen.has(cursor.id)) {
      ids.push(cursor.id);
      seen.add(cursor.id);
      cursor = cursor.parentId ? folderById.get(cursor.parentId) : undefined;
    }
    return ids;
  };

  const selectedDescendantFolderExists = (folderId: string): boolean => (
    descendantFolderIds(folderId).some((id) => selected.has(folderSelectionKey(id)))
  );

  const isFolderDisabled = (folder: ResourceFolder): boolean => (
    ancestorFolderIds(folder.parentId).some((id) => selected.has(folderSelectionKey(id)))
  );

  const isFolderSelected = (folder: ResourceFolder): boolean => (
    selected.has(folderSelectionKey(folder.id)) || isFolderDisabled(folder)
  );

  const isResourceDisabled = (resource: Resource): boolean => (
    ancestorFolderIds(resource.folder).some((id) => selected.has(folderSelectionKey(id)))
  );

  const isResourceSelected = (resource: Resource): boolean => (
    selected.has(resourceSelectionKey(resource.id)) || isResourceDisabled(resource)
  );

  const rootFiles = allResources.filter((resource) => !resource.folder).sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? b.lastSynced ?? "") - Date.parse(a.updatedAt ?? a.createdAt ?? a.lastSynced ?? ""));
  const searchLower = search.toLowerCase();

  const matchesSearch = (resource: Resource): boolean => (
    resource.name.toLowerCase().includes(searchLower)
  );

  const folderMatchesSearch = (folder: ResourceFolder): boolean => (
    search ? folder.name.toLowerCase().includes(searchLower) : false
  );

  const matchesUnlinked = (resource: Resource): boolean => (
    (resource.linkedOntologies?.length ?? 0) === 0
  );

  const filterFile = (resource: Resource): boolean => {
    if (showUnlinkedOnly && !matchesUnlinked(resource)) return false;
    if (search && !matchesSearch(resource)) return false;
    return true;
  };

  const filteredDirectFiles = (folderId: string): Resource[] => {
    const folder = folderById.get(folderId);
    if (folder && folderMatchesSearch(folder)) {
      return showUnlinkedOnly ? folderDirectFiles(folderId).filter(matchesUnlinked) : folderDirectFiles(folderId);
    }
    return folderDirectFiles(folderId).filter(filterFile);
  };

  const filteredFolderHasContent = (folderId: string): boolean => {
    const folder = folderById.get(folderId);
    if (folder && folderMatchesSearch(folder)) return true;
    if (folderDirectFiles(folderId).some(filterFile)) return true;
    return folderChildren(folderId).some((child) => filteredFolderHasContent(child.id));
  };

  const filteredRootFiles = rootFiles.filter(filterFile);
  const hasFilter = Boolean(search) || showUnlinkedOnly;

  const toggleResource = (id: string) => {
    const resource = resourceById.get(id);
    if (!resource || isResourceDisabled(resource)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const key = resourceSelectionKey(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleFolder = (folder: ResourceFolder) => {
    if (isFolderDisabled(folder)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const key = folderSelectionKey(folder.id);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }
      next.add(key);
      descendantFolderIds(folder.id).forEach((id) => next.delete(folderSelectionKey(id)));
      folderTreeFiles(folder.id).forEach((resource) => next.delete(resourceSelectionKey(resource.id)));
      return next;
    });
  };

  const processFiles = async (files: FileList | File[]) => {
    const selectedFiles = filterSystemUploadFiles(files);
    if (selectedFiles.length === 0) return;
    setUploadError(null);
    setUploading(true);
    try {
      const uploaded = await onUploadFiles(selectedFiles);
      setLocalResources((prev) => {
        const existing = new Set([...prev, ...resources].map((resource) => resource.id));
        return [...uploaded.filter((resource) => !existing.has(resource.id)), ...prev];
      });
      setSelected((prev) => {
        const next = new Set(prev);
        uploaded.forEach((resource) => {
          if (!isResourceDisabled(resource)) next.add(resourceSelectionKey(resource.id));
        });
        return next;
      });
      // Scroll to the top of the list to show newly uploaded resources
      window.setTimeout(() => {
        listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      }, 50);
    } catch (error) {
      setUploadError(uploadErrorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const droppedFiles = await filesFromDataTransfer(e.dataTransfer);
    if (droppedFiles.length > 0) await processFiles(droppedFiles);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) void processFiles(files);
    e.target.value = "";
  };

  const handleConfirm = () => {
    const selections = Array.from(selected).flatMap((key): ResourcePickerSelection[] => {
      if (key.startsWith("resource:")) {
        const resource = resourceById.get(key.slice("resource:".length));
        return resource ? [{ type: "resource", resource }] : [];
      }
      if (key.startsWith("folder:")) {
        const folder = folderById.get(key.slice("folder:".length));
        return folder ? [{ type: "folder", folder }] : [];
      }
      return [];
    });
    onConfirm(selections);
  };

  useEffect(() => {
    if (!showBitbucketImport) return;
    let active = true;
    setBitbucketBusy(true);
    setBitbucketRepositoriesLoading(true);
    setBitbucketError(null);
    const timer = window.setTimeout(() => {
      void getBitbucketConnection().then(async (connection) => {
        if (!active) return;
        setBitbucketConnection(connection);
        setBitbucketEmail(connection.email ?? "");
        if (connection.connected) {
          const repositories = await listBitbucketRepositories(bitbucketRepositorySearch);
          if (active) setBitbucketRepositories(repositories);
        }
      }).catch((error: unknown) => {
        if (!active) return;
        if (isBitbucketConnectionInvalidError(error)) {
          setBitbucketConnection((connection) => ({ ...connection, connected: false }));
          setBitbucketError(t("resource.bitbucketConnectionInvalid"));
          return;
        }
        setBitbucketError(uploadErrorMessage(error));
      }).finally(() => {
        if (active) {
          setBitbucketBusy(false);
          setBitbucketRepositoriesLoading(false);
        }
      });
    }, bitbucketRepositorySearch.trim() ? 300 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [showBitbucketImport, bitbucketRepositorySearch, t]);

  const connectBitbucket = async () => {
    setBitbucketBusy(true); setBitbucketRepositoriesLoading(true); setBitbucketError(null);
    try {
      const connection = await configureBitbucketConnection({ email: bitbucketEmail, apiToken: bitbucketToken });
      setBitbucketConnection(connection); setBitbucketToken("");
      setBitbucketRepositories(await listBitbucketRepositories());
    } catch (error) {
      if (isBitbucketConnectionInvalidError(error)) {
        setBitbucketConnection((connection) => ({ ...connection, connected: false }));
        setBitbucketError(t("resource.bitbucketConnectionInvalid"));
      } else {
        setBitbucketError(uploadErrorMessage(error));
      }
    } finally {
      setBitbucketBusy(false); setBitbucketRepositoriesLoading(false);
    }
  };

  const selectBitbucketRepository = async (value: string) => {
    const repository = bitbucketRepositories.find((item) => `${item.workspace}/${item.slug}` === value) ?? null;
    setBitbucketRepository(repository); setBitbucketBranch(""); setBitbucketBranches([]);
    if (!repository) return;
    try {
      const branches = await listBitbucketBranches(repository.workspace, repository.slug);
      setBitbucketBranches(branches);
      setBitbucketBranch(branches.find((branch) => branch.name === repository.mainBranch)?.name ?? branches[0]?.name ?? "");
    } catch (error) {
      if (isBitbucketConnectionInvalidError(error)) {
        setBitbucketConnection((connection) => ({ ...connection, connected: false }));
        setBitbucketError(t("resource.bitbucketConnectionInvalid"));
      } else {
        setBitbucketError(uploadErrorMessage(error));
      }
    }
  };

  const visibleBitbucketRepositories = bitbucketRepositories;

  const addBitbucketRepository = async () => {
    if (!bitbucketRepository || !bitbucketBranch) return;
    if (allResources.some((resource) => resource.source === "bitbucket" && resource.bitbucket?.workspace === bitbucketRepository.workspace && resource.bitbucket.repoSlug === bitbucketRepository.slug)) {
      setBitbucketError(t("resource.bitbucketRepositoryExists"));
      return;
    }
    setBitbucketImporting(true); setBitbucketError(null);
    try {
      const imported = await importBitbucketRepository({ workspace: bitbucketRepository.workspace, repoSlug: bitbucketRepository.slug, defaultBranch: bitbucketBranch });
      setLocalResources((prev) => [imported, ...prev.filter((resource) => resource.id !== imported.id)]);
      setSelected((prev) => new Set(prev).add(resourceSelectionKey(imported.id)));
      setShowBitbucketImport(false);
    } catch (error) {
      if (isBitbucketConnectionInvalidError(error)) {
        setBitbucketConnection((connection) => ({ ...connection, connected: false }));
        setBitbucketError(t("resource.bitbucketConnectionInvalid"));
      } else {
        setBitbucketError(uploadErrorMessage(error));
      }
    } finally { setBitbucketImporting(false); }
  };

  if (showBitbucketImport) return (
    <div className="resource-picker-backdrop" onClick={onClose}><div className="resource-picker" onClick={(event) => event.stopPropagation()}>
      <div className="resource-picker-header resource-picker-header-with-tabs"><span className="resource-picker-title">{t("picker.title")}</span><button className="resource-picker-close" onClick={onClose}>&times;</button></div>
      <div className="resource-picker-source-tabs" role="tablist"><button type="button" role="tab" aria-selected={false} onClick={() => setShowBitbucketImport(false)}>{t("resource.bitbucketLocalSource")}</button><button type="button" className="active" role="tab" aria-selected>{t("resource.bitbucketRepositorySource")}</button></div>
      <div className="resource-picker-bitbucket">
        {bitbucketImporting ? <div className="rl-bitbucket-progress"><span className="rl-connecting-spinner" /><h2>{t("resource.bitbucketImportingTitle")}</h2><p>{t("resource.bitbucketImportingHint")}</p></div> : bitbucketBusy && !bitbucketConnection ? <p>{t("resource.bitbucketCheckingConnection")}</p> : bitbucketBusy && !bitbucketConnection?.connected ? <div className="rl-bitbucket-progress"><span className="rl-connecting-spinner" /><h2>{t("resource.bitbucketConnectingTitle")}</h2><p>{t("resource.bitbucketConnectingHint")}</p></div> : !bitbucketConnection?.connected ? <><p className="resource-picker-bitbucket-intro">{t("resource.bitbucketIntroduction")} <button className="rl-bitbucket-text-button" type="button" onClick={() => setShowBitbucketGuide(true)}>{t("resource.bitbucketGuide")}</button></p><label><span>{t("resource.bitbucketEmail")}</span><input type="email" value={bitbucketEmail} onChange={(event) => setBitbucketEmail(event.target.value)} /></label><label><span>{t("resource.bitbucketToken")}</span><input type="password" value={bitbucketToken} onChange={(event) => setBitbucketToken(event.target.value)} /></label><button className="modal-btn modal-btn-primary" type="button" disabled={bitbucketBusy || !bitbucketEmail.trim() || !bitbucketToken.trim()} onClick={() => void connectBitbucket()}>{t("resource.bitbucketConnection")}</button></> : <><div className="rl-bitbucket-account"><span className="rl-bitbucket-connected-badge"><i aria-hidden="true" />{t("resource.bitbucketConnected", { email: bitbucketConnection.email ?? "" })}</span></div><label className="rl-bitbucket-repository-picker"><span>{t("resource.bitbucketRepository")}</span><div className="rl-bitbucket-repository-control"><button className="rl-bitbucket-repository-trigger" type="button" aria-haspopup="listbox" aria-expanded={bitbucketRepositoryOpen} onClick={() => setBitbucketRepositoryOpen((open) => !open)}>{bitbucketRepository ? `${bitbucketRepository.workspace}/${bitbucketRepository.name}` : bitbucketRepositoriesLoading ? t("resource.bitbucketRepositorySearching") : t("resource.bitbucketRepositorySelect")}</button>{bitbucketRepositoryOpen ? <div className="rl-bitbucket-repository-menu"><input type="search" autoFocus value={bitbucketRepositorySearch} onChange={(event) => setBitbucketRepositorySearch(event.target.value)} placeholder={t("resource.bitbucketRepositorySearchPlaceholder")} aria-label={t("resource.bitbucketRepositorySearchAria")} /><div className="rl-bitbucket-repository-options" role="listbox">{bitbucketRepositoriesLoading ? <p role="status">{t("resource.bitbucketRepositorySearching")}</p> : visibleBitbucketRepositories.length ? visibleBitbucketRepositories.map((repository) => <button key={`${repository.workspace}/${repository.slug}`} type="button" role="option" aria-selected={bitbucketRepository?.workspace === repository.workspace && bitbucketRepository.slug === repository.slug} onClick={() => { void selectBitbucketRepository(`${repository.workspace}/${repository.slug}`); setBitbucketRepositoryOpen(false); }}><span>{repository.name}</span><small>{repository.workspace}</small></button>) : <p>{t("resource.bitbucketRepositoryEmpty")}</p>}</div></div> : null}</div></label>{bitbucketRepository ? <label className="rl-bitbucket-repository-picker"><span>{t("resource.bitbucketImportBranch")}</span><div className="rl-bitbucket-repository-control"><button className="rl-bitbucket-repository-trigger" type="button" onClick={() => setBitbucketBranchOpen((open) => !open)}>{bitbucketBranch}</button>{bitbucketBranchOpen ? <div className="rl-bitbucket-repository-menu"><div className="rl-bitbucket-repository-options">{bitbucketBranches.map((branch) => <button key={branch.name} type="button" onClick={() => { setBitbucketBranch(branch.name); setBitbucketBranchOpen(false); }}><span>{branch.name}</span></button>)}</div></div> : null}</div></label> : null}<button className="modal-btn modal-btn-primary" type="button" disabled={bitbucketBusy || !bitbucketRepository || !bitbucketBranch} onClick={() => void addBitbucketRepository()}>{t("resource.bitbucketImport")}</button></>}
        {bitbucketError ? <p className="bitbucket-connection-error" role="alert">{bitbucketError}</p> : null}
      </div>
      {showBitbucketGuide ? <div className="modal-overlay" onClick={() => setShowBitbucketGuide(false)}><div className="modal-dialog bitbucket-guide-dialog" onClick={(event) => event.stopPropagation()}><div className="bitbucket-guide-header"><h2>{t("resource.bitbucketGuide")}</h2><button className="resource-picker-close" onClick={() => setShowBitbucketGuide(false)}>&times;</button></div><div className="bitbucket-guide-content"><Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ src, alt }) => <img src={({ "step0.png": bitbucketGuideStep0, "step1.png": bitbucketGuideStep1, "step2.png": bitbucketGuideStep2, "step3.png": bitbucketGuideStep3, "step4.png": bitbucketGuideStep4 }[src ?? ""] ?? src)} alt={alt ?? ""} /> }}>{bitbucketGuideZh}</Markdown></div></div></div> : null}
    </div></div>
  );


  return (
    <div ref={pickerRef} className="resource-picker-backdrop" onClick={onClose} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <div className="resource-picker" onClick={(e) => e.stopPropagation()}>
        <div className="resource-picker-header resource-picker-header-with-tabs">
          <span className="resource-picker-title">{t("picker.title")}</span>
          <button className="resource-picker-close" onClick={onClose}>&times;</button>
        </div>
        <div className="resource-picker-source-tabs" role="tablist"><button type="button" className="active" role="tab" aria-selected>{t("resource.bitbucketLocalSource")}</button><button type="button" role="tab" aria-selected={false} onClick={() => setShowBitbucketImport(true)}>{t("resource.bitbucketRepositorySource")}</button></div>

        <div
          className={`resource-picker-dropzone${dragging ? " dragging" : ""}${uploading ? " uploading" : ""}`}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          {uploading ? (
            <>
              <span className="resource-picker-uploading-spinner" />
              <span className="resource-picker-dropzone-text">{t("resource.uploading")}</span>
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                <path d="M7 10l5-5 5 5"/>
                <path d="M12 5v12"/>
              </svg>
              <span className="resource-picker-dropzone-text">{t("picker.dropText")}</span>
              <div className="resource-picker-dropzone-actions">
                <button type="button" className="resource-picker-dropzone-action" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>
                  {t("plus.uploadFile")}
                </button>
                <button type="button" className="resource-picker-dropzone-action" onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click(); }}>
                  {t("plus.uploadFolder")}
                </button>
              </div>
              <DocumentUploadGuidance t={t} variant="compact" />
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFileChange}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          />
        </div>
        {uploadError && (
          <div className="resource-picker-upload-error" role="alert">
            <div className="resource-picker-upload-error-header">
              <span>{t("resource.uploadFailureTitle")}</span>
              <button type="button" onClick={() => setUploadError(null)} aria-label={t("resource.dismissUpload")}>&times;</button>
            </div>
            <p>{uploadError}</p>
          </div>
        )}

        {allResources.length > 0 && (
          <div className="resource-picker-toolbar">
            <div className="resource-picker-search">
              <svg viewBox="0 0 24 24" width="13" height="13"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("resource.search")}
              />
            </div>
            <button
              className={`resource-picker-filter-btn${showUnlinkedOnly ? " active" : ""}`}
              onClick={() => setShowUnlinkedOnly(!showUnlinkedOnly)}
            >
              {t("picker.unlinked")}
            </button>
          </div>
        )}

        <div className="resource-picker-list" ref={listRef}>
          {(hasFilter ? folderChildren(null).filter((f) => filteredFolderHasContent(f.id)) : folderChildren(null)).map((folder) => {
            const folderFiles = folderTreeFiles(folder.id);
            const allSelected = isFolderSelected(folder);
            const someSelected = !allSelected && (
              folderFiles.some((resource) => selected.has(resourceSelectionKey(resource.id))) ||
              selectedDescendantFolderExists(folder.id)
            );
            return (
              <PickerFolder
                key={folder.id}
                folder={folder}
                childFolders={hasFilter ? folderChildren(folder.id).filter((c) => filteredFolderHasContent(c.id)) : folderChildren(folder.id)}
                directFiles={hasFilter ? filteredDirectFiles(folder.id) : folderDirectFiles(folder.id)}
                selected={selected}
                allSelected={allSelected}
                someSelected={someSelected}
                disabled={isFolderDisabled(folder)}
                onToggleAll={() => toggleFolder(folder)}
                onToggleFile={toggleResource}
                isResourceSelected={isResourceSelected}
                isResourceDisabled={isResourceDisabled}
                isFolderSelected={isFolderSelected}
                isFolderDisabled={isFolderDisabled}
                onToggleFolder={toggleFolder}
                folderChildren={(parentId) => hasFilter ? folderChildren(parentId).filter((c) => filteredFolderHasContent(c.id)) : folderChildren(parentId)}
                folderDirectFiles={(fId) => hasFilter ? filteredDirectFiles(fId) : folderDirectFiles(fId)}
                folderTreeFiles={folderTreeFiles}
                t={t}
              />
            );
          })}

          {(hasFilter ? filteredRootFiles : rootFiles).map((resource) => (
            <ResourceRow
              key={resource.id}
              resource={resource}
              selected={isResourceSelected(resource)}
              disabled={isResourceDisabled(resource)}
              onToggle={toggleResource}
              t={t}
            />
          ))}

          {(hasFilter ? filteredRootFiles.length === 0 && folderChildren(null).filter((f) => filteredFolderHasContent(f.id)).length === 0 : rootFiles.length === 0 && folderChildren(null).length === 0) && (
            <div className="resource-picker-empty">
              {allResources.length === 0 ? "No resources yet. Upload files above." : "No matching resources."}
            </div>
          )}
        </div>

        <div className="resource-picker-footer">
          <button
            className="resource-picker-confirm"
            onClick={handleConfirm}
            disabled={selected.size === 0}
          >
            {t("picker.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
