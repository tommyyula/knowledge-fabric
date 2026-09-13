import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExtractedZipEntry {
  name: string;
  path: string;
  size: number;
}

export interface ExtractedZip {
  entries: ExtractedZipEntry[];
  tempRoot: string;
}

export interface ExtractZipOptions {
  pythonCommand?: string;
  timeoutMs?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
  supportedExtensions?: Set<string>;
  tempPrefix?: string;
}

export async function cleanupExtractedZip(zip: ExtractedZip | null | undefined): Promise<void> {
  if (!zip?.tempRoot) return;
  await fs.rm(zip.tempRoot, { recursive: true, force: true }).catch(() => undefined);
}

export async function extractZipEntries(name: string, data: Buffer, options: ExtractZipOptions = {}): Promise<ExtractedZip> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), options.tempPrefix ?? "knowledge-fabric-zip-"));
  const zipPath = path.join(tmpDir, path.basename(name));
  const outDir = path.join(tmpDir, "extracted");
  await fs.writeFile(zipPath, data);

  try {
    const python = options.pythonCommand ?? process.env.MARKITDOWN_PYTHON ?? "python3";
    const supportedExtensions = options.supportedExtensions
      ? JSON.stringify(Array.from(options.supportedExtensions).map((ext) => ext.toLowerCase()))
      : "";
    const script = [
      "import json, os, pathlib, re, shutil, sys, zipfile",
      "zip_path, out_dir, supported_json = sys.argv[1], sys.argv[2], sys.argv[3]",
      `max_entries = int(os.environ.get('KF_ZIP_MAX_ENTRIES', '${options.maxEntries ?? 10000}'))`,
      `max_total_bytes = int(os.environ.get('KF_ZIP_MAX_TOTAL_BYTES', '${options.maxTotalBytes ?? 512 * 1024 * 1024}'))`,
      "supported_exts = set(json.loads(supported_json)) if supported_json else None",
      "def decode_zip_name(value):",
      "    try:",
      "        raw_bytes = value.encode('cp437')",
      "    except UnicodeEncodeError:",
      "        return value",
      "    try:",
      "        utf8_candidate = raw_bytes.decode('utf-8')",
      "        if utf8_candidate:",
      "            return utf8_candidate",
      "    except UnicodeDecodeError:",
      "        pass",
      "    mojibake_chars = set('鍦烘櫙涓氬姟璇箟閭妯澘鏌琛屼负瑙勮寖璺ㄧ郴缁熸煡笌鏅鸿兘闂瓟鈺暶溝兠宦暎毛')",
      "    def score(candidate, enc):",
      "        cjk = sum(1 for ch in candidate if '\\u4e00' <= ch <= '\\u9fff')",
      "        ascii_count = sum(1 for ch in candidate if ch.isascii() and (ch.isalnum() or ch in '._- /()#'))",
      "        private = sum(1 for ch in candidate if '\\ue000' <= ch <= '\\uf8ff')",
      "        box = sum(1 for ch in candidate if '\\u2500' <= ch <= '\\u257f')",
      "        suspicious = sum(1 for ch in candidate if ch in mojibake_chars)",
      "        bonus = 4 if enc == 'utf-8' else 0",
      "        return cjk * 3 + ascii_count * 0.1 + bonus - suspicious * 8 - private * 20 - box * 12 - candidate.count('\\ufffd') * 20",
      "    best = value",
      "    best_score = score(value, 'zipfile')",
      "    for enc in ('utf-8', 'gb18030', 'gbk', 'big5'):",
      "        try:",
      "            candidate = raw_bytes.decode(enc)",
      "        except UnicodeDecodeError:",
      "            continue",
      "        candidate_score = score(candidate, enc)",
      "        if candidate_score > best_score:",
      "            best, best_score = candidate, candidate_score",
      "    return best",
      "def safe_part(part):",
      "    return re.sub(r'[^\\w.\\- ()]', '_', part, flags=re.UNICODE).strip(' .') or 'file'",
      "def unique_dest(path):",
      "    if not path.exists():",
      "        return path",
      "    stem, suffix = path.stem, path.suffix",
      "    for idx in range(2, 1000):",
      "        candidate = path.with_name(f'{stem}-{idx}{suffix}')",
      "        if not candidate.exists():",
      "            return candidate",
      "    raise RuntimeError(f'too many duplicate zip entries for {path.name}')",
      "entries = []",
      "total = 0",
      "with zipfile.ZipFile(zip_path) as archive:",
      "    for info in archive.infolist():",
      "        if info.is_dir():",
      "            continue",
      "        raw = decode_zip_name(info.filename).replace('\\\\', '/')",
      "        parts = [safe_part(p) for p in pathlib.PurePosixPath(raw).parts if p not in ('', '.', '..') and p != '__MACOSX' and not p.startswith('.')]",
      "        if not parts:",
      "            continue",
      "        suffix = pathlib.PurePosixPath('/'.join(parts)).suffix.lower()",
      "        if supported_exts is not None and suffix not in supported_exts:",
      "            continue",
      "        total += info.file_size",
      "        if len(entries) >= max_entries or total > max_total_bytes:",
      "            raise RuntimeError('zip upload exceeds configured entry or size limits')",
      "        dest = unique_dest(pathlib.Path(out_dir).joinpath(*parts))",
      "        parent = pathlib.Path(out_dir)",
      "        conflict = False",
      "        for part in dest.relative_to(out_dir).parts[:-1]:",
      "            parent = parent / part",
      "            if parent.exists() and not parent.is_dir():",
      "                conflict = True",
      "                break",
      "        if conflict:",
      "            continue",
      "        dest.parent.mkdir(parents=True, exist_ok=True)",
      "        with archive.open(info) as src, open(dest, 'wb') as dst:",
      "            shutil.copyfileobj(src, dst)",
      "        rel = '/'.join(dest.relative_to(out_dir).parts)",
      "        entries.append({'name': rel, 'path': str(dest), 'size': info.file_size})",
      "print(json.dumps(entries))",
    ].join("\n");

    const { stdout } = await execFileAsync(python, ["-c", script, zipPath, outDir, supportedExtensions], {
      timeout: options.timeoutMs ?? Number(process.env.KF_ZIP_TIMEOUT_MS ?? 30_000),
      maxBuffer: 2 * 1024 * 1024,
    });
    const entries = JSON.parse(stdout) as ExtractedZipEntry[];
    if (!entries.length) {
      await cleanupExtractedZip({ entries, tempRoot: tmpDir });
      return { entries: [], tempRoot: "" };
    }
    return { entries, tempRoot: tmpDir };
  } catch (error) {
    await cleanupExtractedZip({ entries: [], tempRoot: tmpDir });
    throw error;
  }
}
