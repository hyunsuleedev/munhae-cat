import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { AppError } from "./errors";
import { isPathInside, uniquePath } from "./paths";

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const MAX_ZIP_BYTES = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED = 1024 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const ZIP64_SENTINEL = 0xffffffff;
const ZIP64_ENTRY_SENTINEL = 0xffff;
const UNIX_FILE_TYPE = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMBOLIC_LINK = 0o120000;

type CenEntry = {
  name: string;
  nameBytes: Buffer;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  externalAttrs: number;
};

type ValidatedEntry = CenEntry & {
  normalizedPath: string;
  portablePathKey: string;
  isDirectory: boolean;
  ignored: boolean;
  dataStart: number;
  dataEnd: number;
  destination: string;
};

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) !== EOCD) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  throw new AppError("invalid_backup", "백업 파일 형식이 올바르지 않습니다.");
}

function decodeName(bytes: Buffer, flags: number): string {
  if (flags & 0x800) return bytes.toString("utf8");
  return bytes.toString("utf8");
}

function readCentralDirectory(buf: Buffer): CenEntry[] {
  const eocd = findEocd(buf);
  const disk = buf.readUInt16LE(eocd + 4);
  const centralDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (
    disk !== 0
    || centralDisk !== 0
    || entriesOnDisk !== total
    || total === ZIP64_ENTRY_SENTINEL
    || cdSize === ZIP64_SENTINEL
    || cdOffset === ZIP64_SENTINEL
  ) {
    throw new AppError("invalid_backup", "이 백업 형식은 지원하지 않습니다.");
  }
  if (total > MAX_ENTRIES) {
    throw new AppError("invalid_backup", "백업 항목이 너무 많습니다.");
  }
  const entries: CenEntry[] = [];
  let offset = cdOffset;
  const cdEnd = cdOffset + cdSize;
  if (!Number.isSafeInteger(cdEnd) || cdOffset > eocd || cdEnd !== eocd) {
    throw new AppError("invalid_backup", "백업 목록이 손상되었습니다.");
  }
  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > cdEnd || buf.readUInt32LE(offset) !== CEN) {
      throw new AppError("invalid_backup", "백업 목록이 손상되었습니다.");
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const crc32 = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const startDisk = buf.readUInt16LE(offset + 34);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localOffset = buf.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const entryEnd = nameStart + nameLen + extraLen + commentLen;
    if (
      entryEnd > cdEnd
      || compressedSize === ZIP64_SENTINEL
      || uncompressedSize === ZIP64_SENTINEL
      || localOffset === ZIP64_SENTINEL
      || startDisk !== 0
      || (method !== 0 && method !== 8)
    ) {
      throw new AppError("invalid_backup", "백업 목록이 손상되었거나 지원하지 않는 형식입니다.");
    }
    const supportedFlags = method === 8 ? 0x0806 : 0x0800;
    if ((flags & ~supportedFlags) !== 0) {
      throw new AppError("invalid_backup", "암호화되거나 지원하지 않는 ZIP 항목입니다.");
    }
    const nameBytes = Buffer.from(buf.subarray(nameStart, nameStart + nameLen));
    const name = decodeName(nameBytes, flags);
    entries.push({
      name,
      nameBytes,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      externalAttrs,
    });
    offset = entryEnd;
  }
  if (offset !== cdEnd) {
    throw new AppError("invalid_backup", "백업 목록이 손상되었습니다.");
  }
  return entries;
}

function normalizedEntryPath(name: string): { path: string; portableKey: string } {
  const trimmed = name.replace(/\\/g, "/").normalize("NFC");
  if (!trimmed || trimmed.includes("\0")) {
    throw new AppError("invalid_backup", "백업 경로가 올바르지 않습니다.");
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) {
    throw new AppError("invalid_backup", "백업 경로가 올바르지 않습니다.");
  }
  const parts = trimmed.split("/").filter((part) => part !== "" && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) {
    throw new AppError("invalid_backup", "백업 경로가 올바르지 않습니다.");
  }
  const path = parts.join("/");
  return { path, portableKey: path.toLowerCase() };
}

function entryDest(destDir: string, normalizedPath: string): string {
  const abs = join(destDir, ...normalizedPath.split("/"));
  if (!isPathInside(destDir, abs)) {
    throw new AppError("invalid_backup", "백업 경로가 올바르지 않습니다.");
  }
  return abs;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function isIgnoredMetadata(path: string): boolean {
  return path === "__MACOSX"
    || path.startsWith("__MACOSX/")
    || path === ".DS_Store"
    || path.endsWith("/.DS_Store");
}

function validateEntry(
  buf: Buffer,
  centralDirectoryOffset: number,
  destDir: string,
  entry: CenEntry,
): ValidatedEntry {
  const unixMode = (entry.externalAttrs >>> 16) & 0xffff;
  const unixType = unixMode & UNIX_FILE_TYPE;
  if (unixType === UNIX_SYMBOLIC_LINK) {
    throw new AppError("invalid_backup", "심볼릭 링크가 포함된 백업은 열 수 없습니다.");
  }
  if (unixType !== 0 && unixType !== UNIX_REGULAR_FILE && unixType !== UNIX_DIRECTORY) {
    throw new AppError("invalid_backup", "지원하지 않는 파일 종류가 포함된 백업입니다.");
  }
  const normalized = normalizedEntryPath(entry.name);
  const isDirectory = entry.name.replace(/\\/g, "/").endsWith("/")
    || unixType === UNIX_DIRECTORY
    || (entry.externalAttrs & 0x10) !== 0;
  if (isDirectory && (entry.compressedSize !== 0 || entry.uncompressedSize !== 0 || entry.crc32 !== 0)) {
    throw new AppError("invalid_backup", "백업 디렉터리 항목이 손상되었습니다.");
  }
  if (entry.localOffset + 30 > centralDirectoryOffset || buf.readUInt32LE(entry.localOffset) !== LOC) {
    throw new AppError("invalid_backup", "백업 파일 항목이 손상되었습니다.");
  }
  const localFlags = buf.readUInt16LE(entry.localOffset + 6);
  const localMethod = buf.readUInt16LE(entry.localOffset + 8);
  const localCrc32 = buf.readUInt32LE(entry.localOffset + 14);
  const localCompressedSize = buf.readUInt32LE(entry.localOffset + 18);
  const localUncompressedSize = buf.readUInt32LE(entry.localOffset + 22);
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const nameStart = entry.localOffset + 30;
  const dataStart = nameStart + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (
    localFlags !== entry.flags
    || localMethod !== entry.method
    || localCrc32 !== entry.crc32
    || localCompressedSize !== entry.compressedSize
    || localUncompressedSize !== entry.uncompressedSize
    || dataStart > centralDirectoryOffset
    || dataEnd > centralDirectoryOffset
    || !buf.subarray(nameStart, nameStart + nameLen).equals(entry.nameBytes)
  ) {
    throw new AppError("invalid_backup", "ZIP local/central header가 일치하지 않습니다.");
  }
  return {
    ...entry,
    normalizedPath: normalized.path,
    portablePathKey: normalized.portableKey,
    isDirectory,
    ignored: isIgnoredMetadata(normalized.path),
    dataStart,
    dataEnd,
    destination: entryDest(destDir, normalized.path),
  };
}

function validateUniquePaths(entries: readonly ValidatedEntry[]): void {
  const seen = new Map<string, ValidatedEntry>();
  for (const entry of entries) {
    if (seen.has(entry.portablePathKey)) {
      throw new AppError("invalid_backup", "정규화 후 중복되는 백업 경로가 있습니다.");
    }
    seen.set(entry.portablePathKey, entry);
  }
  const files = new Set(entries.filter((entry) => !entry.isDirectory).map((entry) => entry.portablePathKey));
  for (const entry of entries) {
    const parts = entry.portablePathKey.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      if (files.has(parts.slice(0, length).join("/"))) {
        throw new AppError("invalid_backup", "백업의 파일·디렉터리 경로가 충돌합니다.");
      }
    }
  }
}

export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const archive = await stat(zipPath);
  if (!archive.isFile() || archive.size > MAX_ZIP_BYTES) {
    throw new AppError("backup_too_large", "백업 파일이 너무 큽니다.");
  }
  const buf = await readFile(zipPath);
  if (buf.byteLength > MAX_ZIP_BYTES) {
    throw new AppError("backup_too_large", "백업 파일이 너무 큽니다.");
  }
  const entries = readCentralDirectory(buf);
  const eocd = findEocd(buf);
  const centralDirectoryOffset = buf.readUInt32LE(eocd + 16);
  const validated = entries.map((entry) => validateEntry(buf, centralDirectoryOffset, destDir, entry));
  validateUniquePaths(validated);
  let uncompressedTotal = 0;
  for (const entry of validated) {
    uncompressedTotal += entry.uncompressedSize;
    if (uncompressedTotal > MAX_UNCOMPRESSED) {
      throw new AppError("backup_too_large", "백업 파일이 너무 큽니다.");
    }
  }
  await mkdir(destDir, { recursive: true });
  for (const entry of validated) {
    const compressed = buf.subarray(entry.dataStart, entry.dataEnd);
    let data: Buffer;
    if (entry.method === 0) {
      data = Buffer.from(compressed);
    } else {
      try {
        data = inflateRawSync(compressed, {
          maxOutputLength: Math.max(1, Math.min(entry.uncompressedSize, MAX_UNCOMPRESSED)),
        });
      } catch {
        throw new AppError("invalid_backup", "백업 압축 데이터가 손상되었거나 허용 크기를 넘습니다.");
      }
    }
    if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc32) {
      throw new AppError("invalid_backup", "백업 파일 항목이 손상되었습니다.");
    }
    if (entry.isDirectory || entry.ignored) continue;
    await mkdir(dirname(entry.destination), { recursive: true });
    await writeFile(entry.destination, data, { flag: "wx" });
  }
}

async function findPackageRoot(dir: string): Promise<string> {
  const manifest = join(dir, "manifest.json");
  try {
    const st = await stat(manifest);
    if (st.isFile()) return dir;
  } catch {
    // look one level down
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory() && entry.name !== "__MACOSX");
  if (dirs.length === 1) {
    const nested = join(dir, dirs[0]!.name);
    try {
      const nestedStat = await stat(join(nested, "manifest.json"));
      if (nestedStat.isFile()) return nested;
    } catch {
      // fall through
    }
  }
  throw new AppError("invalid_package", "유효한 .munhae 패키지가 아닙니다.");
}

/** Unzip a .munhaepkg next to the archive, returning the extracted .munhae directory. */
export async function extractMunhaePkg(pkgPath: string): Promise<string> {
  const parent = dirname(pkgPath);
  const baseName = basename(pkgPath).replace(/\.munhaepkg$/i, "") || "munhae-project";
  const tmp = uniquePath(join(parent, `.munhae-import-${process.pid}`));
  try {
    await extractZip(pkgPath, tmp);
    const root = await findPackageRoot(tmp);
    const dest = uniquePath(join(parent, `${baseName}.munhae`));
    await rename(root, dest);
    return dest;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
