import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../env";

export const MAX_QUERY_ATTACHMENTS = 10;
export const MAX_QUERY_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface QueryAttachmentReceipt {
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  processed: false;
}

export interface InlineQueryAttachment {
  raw: string;
  filename?: string;
  mediaType?: string;
}

export interface QueryAttachmentStager {
  stage(taskId: string, attachments: readonly InlineQueryAttachment[]): Promise<QueryAttachmentReceipt[]>;
  cleanup(taskId: string): Promise<void>;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

function safeFilename(value: string | undefined, index: number): string {
  const name = value?.trim() || `attachment-${index + 1}`;
  const stem = name.split(".", 1)[0].toUpperCase();
  if (name.length > 255 || name === "." || name === ".." || path.basename(name) !== name || /[<>:"/\\|?*]/.test(name) || hasControlCharacters(name) || /[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new Error("Query Attachment filename is unsafe");
  }
  return name;
}

function safeMediaType(value: string | undefined): string {
  const mediaType = value?.trim() || "application/octet-stream";
  if (mediaType.length > 255 || hasControlCharacters(mediaType)) throw new Error("Query Attachment media type is invalid");
  return mediaType;
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Query Attachment bytes must be non-empty Base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length) throw new Error("Query Attachment must not be empty");
  return bytes;
}

export class FileQueryAttachmentStager implements QueryAttachmentStager {
  private readonly root: string;

  constructor(root = path.join(env.dataRoot, "a2a-query-attachments")) {
    this.root = root;
  }

  private taskDirectory(taskId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) throw new Error("Invalid A2A Task ID for attachment staging");
    return path.join(this.root, taskId);
  }

  async stage(taskId: string, attachments: readonly InlineQueryAttachment[]): Promise<QueryAttachmentReceipt[]> {
    if (attachments.length > MAX_QUERY_ATTACHMENTS) throw new Error(`At most ${MAX_QUERY_ATTACHMENTS} Query Attachments are allowed`);
    if (!attachments.length) return [];
    const directory = this.taskDirectory(taskId);
    const decoded: Array<{ bytes: Buffer; receipt: QueryAttachmentReceipt }> = [];
    let aggregate = 0;
    try {
      for (const [index, attachment] of attachments.entries()) {
        const bytes = decodeBase64(attachment.raw);
        if (bytes.length > MAX_QUERY_ATTACHMENT_BYTES) throw new Error("A Query Attachment exceeds 50 MB");
        aggregate += bytes.length;
        if (aggregate > MAX_QUERY_ATTACHMENT_BYTES) throw new Error("Query Attachments exceed the 50 MB aggregate limit");
        const name = safeFilename(attachment.filename, index);
        decoded.push({
          bytes,
          receipt: {
            name,
            mediaType: safeMediaType(attachment.mediaType),
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            processed: false,
          },
        });
      }
      await fs.mkdir(this.root, { recursive: true });
      await fs.mkdir(directory, { recursive: false });
      for (const [index, { bytes, receipt }] of decoded.entries()) {
        await fs.writeFile(path.join(directory, `${String(index + 1).padStart(2, "0")}-${receipt.name}`), bytes, { flag: "wx" });
      }
      return decoded.map(({ receipt }) => receipt);
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async cleanup(taskId: string): Promise<void> {
    await fs.rm(this.taskDirectory(taskId), { recursive: true, force: true });
  }

  async cleanupAll(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
