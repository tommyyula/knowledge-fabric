export type FileWithRelativePath = File & { webkitRelativePath?: string };

type WebkitFileSystemEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
};

type WebkitFileSystemFileEntry = WebkitFileSystemEntry & {
  isFile: true;
  file: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
};

type WebkitFileSystemDirectoryEntry = WebkitFileSystemEntry & {
  isDirectory: true;
  createReader: () => {
    readEntries: (success: (entries: WebkitFileSystemEntry[]) => void, failure?: (error: DOMException) => void) => void;
  };
};

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => WebkitFileSystemEntry | null;
  getAsEntry?: () => WebkitFileSystemEntry | null;
};

function normalizeUploadPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean).join("/");
}

export function shouldIgnoreSystemUploadFile(file: File): boolean {
  const relativePath = normalizeUploadPath((file as FileWithRelativePath).webkitRelativePath || file.name);
  const parts = relativePath.split("/").filter(Boolean);
  const name = parts[parts.length - 1] || file.name;
  const lowerName = name.toLowerCase();
  return parts.includes("__MACOSX")
    || name === ".DS_Store"
    || name.startsWith("._")
    || lowerName === "thumbs.db"
    || lowerName === "desktop.ini";
}

export function filterSystemUploadFiles(files: FileList | readonly File[]): File[] {
  return Array.from(files).filter((file) => !shouldIgnoreSystemUploadFile(file));
}

function fileWithRelativePath(file: File, relativePath: string): FileWithRelativePath {
  const normalized = normalizeUploadPath(relativePath);
  if (!normalized || normalized === file.name) return file;
  try {
    Object.defineProperty(file, "webkitRelativePath", { value: normalized, configurable: true });
    return file as FileWithRelativePath;
  } catch {
    const cloned = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
    Object.defineProperty(cloned, "webkitRelativePath", { value: normalized, configurable: true });
    return cloned as FileWithRelativePath;
  }
}

function getDataTransferEntry(item: DataTransferItem): WebkitFileSystemEntry | null {
  const withEntry = item as DataTransferItemWithEntry;
  return withEntry.webkitGetAsEntry?.() ?? withEntry.getAsEntry?.() ?? null;
}

function readFileEntry(entry: WebkitFileSystemFileEntry, relativePath: string): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file((file) => resolve(fileWithRelativePath(file, relativePath)), reject);
  });
}

function readDirectoryEntries(entry: WebkitFileSystemDirectoryEntry): Promise<WebkitFileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: WebkitFileSystemEntry[] = [];

  return new Promise((resolve, reject) => {
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

async function readEntryFiles(entry: WebkitFileSystemEntry, parentPath = ""): Promise<File[]> {
  const relativePath = normalizeUploadPath(parentPath ? `${parentPath}/${entry.name}` : entry.name);
  if (entry.isFile) return [await readFileEntry(entry as WebkitFileSystemFileEntry, relativePath)];
  if (!entry.isDirectory) return [];

  const children = await readDirectoryEntries(entry as WebkitFileSystemDirectoryEntry);
  const nested = await Promise.all(children.map((child) => readEntryFiles(child, relativePath)));
  return nested.flat();
}

export async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map(getDataTransferEntry)
    .filter((entry): entry is WebkitFileSystemEntry => Boolean(entry));

  if (entries.length > 0) {
    const nested = await Promise.all(entries.map((entry) => readEntryFiles(entry)));
    const files = filterSystemUploadFiles(nested.flat());
    if (files.length > 0) return files;
  }

  return filterSystemUploadFiles(dataTransfer.files);
}
