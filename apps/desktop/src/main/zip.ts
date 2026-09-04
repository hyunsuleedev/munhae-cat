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

type CenEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  externalAttrs: number;
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
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || total === 0xffff || cdOffset === 0xffffffff) {
    throw new AppError("invalid_backup", "이 백업 형식은 지원하지 않습니다.");
  }
  if (total > MAX_ENTRIES) {
    throw new AppError("invalid_backup", "백업 항목이 너무 많습니다.");
  }
  const entries: CenEntry[] = [];
  let offset = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > cdEnd || buf.readUInt32LE(offset) !== CEN) {
      throw new AppError("invalid_backup", "백업 목록이 손상되었습니다.");
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localOffset = buf.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = decodeName(buf.subarray(nameStart, nameStart + nameLen), flags);
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset, externalAttrs });
    offset = nameStart + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryDest(destDir: string, name: string): string {
  const trimmed = name.replace(/\\/g, "/");
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) {
    throw new AppError("invalid_backup", "백업 경로가 올바르지 않습니다.");
  }
  const parts = trimmed.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new AppError("invalid_backup", "백업 경로가 올바르지 않습니다.");
  }
  const abs = join(destDir, ...parts);
  if (!isPathInside(destDir, abs)) {
    throw new AppError("invalid_backup", "백업 경로가 올바르지 않습니다.");
  }
  return abs;
}

export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const buf = await readFile(zipPath);
  if (buf.byteLength > MAX_ZIP_BYTES) {
    throw new AppError("backup_too_large", "백업 파일이 너무 큽니다.");
  }
  await mkdir(destDir, { recursive: true });
  const entries = readCentralDirectory(buf);
  let uncompressedTotal = 0;
  for (const entry of entries) {
    const unixMode = (entry.externalAttrs >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new AppError("invalid_backup", "심볼릭 링크가 포함된 백업은 열 수 없습니다.");
    }
    const normalized = entry.name.replace(/\\/g, "/");
    if (
      normalized.endsWith("/") ||
      normalized.startsWith("__MACOSX/") ||
      normalized.includes("/__MACOSX/") ||
      normalized.endsWith("/.DS_Store") ||
      normalized === ".DS_Store"
    ) {
      continue;
    }
    uncompressedTotal += entry.uncompressedSize;
    if (uncompressedTotal > MAX_UNCOMPRESSED) {
      throw new AppError("backup_too_large", "백업 파일이 너무 큽니다.");
    }
    const dest = entryDest(destDir, entry.name);
    if (buf.readUInt32LE(entry.localOffset) !== LOC) {
      throw new AppError("invalid_backup", "백업 파일 항목이 손상되었습니다.");
    }
    const nameLen = buf.readUInt16LE(entry.localOffset + 26);
    const extraLen = buf.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buf.length) {
      throw new AppError("invalid_backup", "백업 파일 항목이 손상되었습니다.");
    }
    const compressed = buf.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (entry.method === 0) {
      data = compressed;
    } else if (entry.method === 8) {
      data = inflateRawSync(compressed);
    } else {
      throw new AppError("invalid_backup", "지원하지 않는 압축 방식입니다.");
    }
    if (data.length !== entry.uncompressedSize) {
      throw new AppError("invalid_backup", "백업 파일 항목이 손상되었습니다.");
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data);
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
