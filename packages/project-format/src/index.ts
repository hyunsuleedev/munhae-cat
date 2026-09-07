import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { zipSync } from "fflate";
import { MunhaeError } from "@munhae/domain";

export const PROJECT_FORMAT = "io.munhae.project";
export const PROJECT_FORMAT_VERSION = 1;
export const MINIMUM_APP_VERSION = "0.1.0";

export type ProjectManifest = {
  format: typeof PROJECT_FORMAT;
  formatVersion: typeof PROJECT_FORMAT_VERSION;
  projectId: string;
  title: string;
  storageMode: "local";
  database: "project.sqlite3";
  assetRoot: "assets";
  createdAt: string;
  minimumAppVersion: string;
};

const SECRET_KEY = /^(.*)?(token|apiKey|api_key|authorization|cookie|password|secret|accessKey|refreshToken)(.*)?$/i;

export function sanitizeFolderTitle(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/g, "");
  return cleaned || "untitled";
}

export function createPackageDir(opts: {
  parentDir: string;
  title: string;
  projectId: string;
  createdAt: string;
}): { packagePath: string; manifest: ProjectManifest } {
  mkdirSync(opts.parentDir, { recursive: true });
  const base = sanitizeFolderTitle(opts.title);
  let folder = `${base}.munhae`;
  let n = 2;
  while (existsSync(join(opts.parentDir, folder))) {
    folder = `${base}-${n}.munhae`;
    n += 1;
  }
  const packagePath = join(opts.parentDir, folder);
  mkdirSync(join(packagePath, "assets", "originals"), { recursive: true });
  mkdirSync(join(packagePath, "assets", "derivatives"), { recursive: true });
  mkdirSync(join(packagePath, "indexes"), { recursive: true });

  const manifest: ProjectManifest = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    projectId: opts.projectId,
    title: opts.title,
    storageMode: "local",
    database: "project.sqlite3",
    assetRoot: "assets",
    createdAt: opts.createdAt,
    minimumAppVersion: MINIMUM_APP_VERSION,
  };
  validateManifest(manifest);
  writeFileSync(resolvePackagePath(packagePath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { packagePath, manifest };
}

export function readManifest(packagePath: string): ProjectManifest {
  const manifestPath = resolvePackagePath(packagePath, "manifest.json");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile()) {
    throw new MunhaeError("invalid_manifest", "manifest.json must be a regular file inside the project package");
  }
  const raw = readFileSync(manifestPath, "utf8");
  const json: unknown = JSON.parse(raw);
  return validateManifest(json);
}

export function validateManifest(json: unknown): ProjectManifest {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new MunhaeError("invalid_manifest", "manifest must be an object");
  }
  const rec = json as Record<string, unknown>;
  rejectSecretKeys(rec);
  rejectAbsolutePaths(rec);

  if (rec.format !== PROJECT_FORMAT) {
    throw new MunhaeError("invalid_manifest", `format must be ${PROJECT_FORMAT}`);
  }
  if (rec.formatVersion !== PROJECT_FORMAT_VERSION) {
    throw new MunhaeError("invalid_manifest", "unsupported formatVersion");
  }
  if (typeof rec.projectId !== "string" || rec.projectId.length < 8) {
    throw new MunhaeError("invalid_manifest", "projectId required");
  }
  if (typeof rec.title !== "string" || rec.title.length === 0) {
    throw new MunhaeError("invalid_manifest", "title required");
  }
  if (rec.storageMode !== "local") {
    throw new MunhaeError("invalid_manifest", "storageMode must be local");
  }
  if (rec.database !== "project.sqlite3") {
    throw new MunhaeError("invalid_manifest", "database must be project.sqlite3");
  }
  if (rec.assetRoot !== "assets") {
    throw new MunhaeError("invalid_manifest", "assetRoot must be assets");
  }
  if (typeof rec.createdAt !== "string") {
    throw new MunhaeError("invalid_manifest", "createdAt required");
  }
  if (typeof rec.minimumAppVersion !== "string") {
    throw new MunhaeError("invalid_manifest", "minimumAppVersion required");
  }

  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    projectId: rec.projectId,
    title: rec.title,
    storageMode: "local",
    database: "project.sqlite3",
    assetRoot: "assets",
    createdAt: rec.createdAt,
    minimumAppVersion: rec.minimumAppVersion,
  };
}

function rejectSecretKeys(value: unknown, path = ""): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => rejectSecretKeys(item, `${path}[${i}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      throw new MunhaeError("invalid_manifest", `secret-looking key is not allowed: ${key}`);
    }
    rejectSecretKeys(child, path ? `${path}.${key}` : key);
  }
}

function rejectAbsolutePaths(value: unknown): void {
  if (typeof value === "string") {
    if (isAbsolutePathLike(value)) {
      throw new MunhaeError("invalid_manifest", "manifest must not contain absolute paths");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(rejectAbsolutePaths);
    return;
  }
  Object.values(value as Record<string, unknown>).forEach(rejectAbsolutePaths);
}

function isAbsolutePathLike(value: string): boolean {
  if (value.startsWith("file:")) return true;
  if (value.startsWith("/") || value.startsWith("\\")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return false;
}

function lockPath(packagePath: string): string {
  return join(packagePath, ".lock");
}

function lockGuardPath(packagePath: string): string {
  return join(packagePath, ".lock.guard");
}

type ProjectLockRecord = {
  version: 1;
  pid: number;
  hostname: string;
  token: string;
  createdAt: string;
};

const ownedLocks = new Map<string, string>();

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}

function parseLockRecord(raw: string): ProjectLockRecord | { pid: number; hostname: string; token: null } | null {
  const trimmed = raw.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    return { pid: Number.parseInt(trimmed, 10), hostname: hostname(), token: null };
  }
  try {
    const lines = trimmed.split(/\r?\n/);
    const legacyPid = /^[0-9]+$/.test(lines[0] ?? "") ? Number.parseInt(lines[0]!, 10) : null;
    const value = JSON.parse(legacyPid === null ? trimmed : lines.slice(1).join("\n")) as Partial<ProjectLockRecord>;
    if (
      value.version === 1 &&
      Number.isInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      (legacyPid === null || value.pid === legacyPid) &&
      typeof value.hostname === "string" &&
      value.hostname.length > 0 &&
      typeof value.token === "string" &&
      value.token.length >= 16 &&
      typeof value.createdAt === "string"
    ) {
      return value as ProjectLockRecord;
    }
  } catch {
    // A malformed lock is deliberately not considered stale: deleting it could
    // admit a second writer while another version of the app owns the project.
  }
  return null;
}

function writeExclusiveLock(file: string, record: ProjectLockRecord): boolean {
  let fd: number | null = null;
  let created = false;
  try {
    fd = openSync(file, "wx", 0o600);
    created = true;
    // Keep a PID-only first line so older Munhae builds parse this as a live
    // lock instead of treating the JSON prefix as an invalid/stale PID.
    writeSync(fd, `${record.pid}\n${JSON.stringify(record)}\n`, undefined, "utf8");
    fsyncSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    if (fd !== null) {
      closeSync(fd);
      fd = null;
    }
    if (created) rmSync(file, { force: true });
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readExistingLock(file: string): { raw: string; record: ReturnType<typeof parseLockRecord> } | null {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new MunhaeError("project_locked", "project_locked: symbolic lock is not safe to reclaim");
    }
    const raw = readFileSync(file, "utf8");
    return { raw, record: parseLockRecord(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function reclaimStaleLock(file: string, raw: string, token: string): boolean {
  const quarantine = `${file}.stale-${token}`;
  try {
    renameSync(file, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const movedRaw = readFileSync(quarantine, "utf8");
  if (movedRaw !== raw) {
    if (!existsSync(file)) renameSync(quarantine, file);
    else rmSync(quarantine, { force: true });
    return false;
  }
  rmSync(quarantine, { force: true });
  return true;
}

function releaseOwnedFile(file: string, token: string): void {
  const existing = readExistingLock(file);
  if (existing?.record?.token === token && existing.record.pid === process.pid && existing.record.hostname === hostname()) {
    rmSync(file, { force: true });
  }
}

function acquireOpenGuard(root: string, record: ProjectLockRecord): void {
  const guard = lockGuardPath(root);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (writeExclusiveLock(guard, record)) return;
    const existing = readExistingLock(guard);
    if (!existing) continue;
    if (!existing.record) {
      throw new MunhaeError("project_locked", "project_locked: open guard owner could not be verified");
    }
    if (existing.record.hostname !== hostname()) {
      throw new MunhaeError("project_locked", `project_locked: project is being opened on ${existing.record.hostname}`);
    }
    if (pidAlive(existing.record.pid)) {
      throw new MunhaeError("project_locked", `project_locked: project is being opened by pid ${existing.record.pid}`);
    }
    reclaimStaleLock(guard, existing.raw, record.token);
  }
  throw new MunhaeError("project_locked", "project_locked: open guard changed while opening the project");
}

export function acquireLock(packagePath: string): void {
  const root = resolve(packagePath);
  const file = lockPath(root);
  const token = randomUUID();
  const record: ProjectLockRecord = {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    token,
    createdAt: new Date().toISOString(),
  };

  acquireOpenGuard(root, record);
  try {
    const existing = readExistingLock(file);
    if (existing) {
      if (!existing.record) {
        throw new MunhaeError("project_locked", "project_locked: lock owner could not be verified");
      }
      if (existing.record.hostname !== hostname()) {
        throw new MunhaeError("project_locked", `project_locked: project is locked on ${existing.record.hostname}`);
      }
      if (pidAlive(existing.record.pid)) {
        throw new MunhaeError("project_locked", `project_locked: project is locked by pid ${existing.record.pid}`);
      }
      if (!reclaimStaleLock(file, existing.raw, token)) {
        throw new MunhaeError("project_locked", "project_locked: lock changed while opening the project");
      }
    }
    if (!writeExclusiveLock(file, record)) {
      throw new MunhaeError("project_locked", "project_locked: another writer acquired the project");
    }
    ownedLocks.set(root, token);
  } finally {
    releaseOwnedFile(lockGuardPath(root), token);
  }
}

export function releaseLock(packagePath: string): void {
  const root = resolve(packagePath);
  const file = lockPath(root);
  const ownedToken = ownedLocks.get(root);
  if (!ownedToken) return;
  if (!existsSync(file)) {
    ownedLocks.delete(root);
    return;
  }
  releaseOwnedFile(file, ownedToken);
  ownedLocks.delete(root);
}

export function checkpointAndZip(packagePath: string, destFile: string): void {
  const root = resolve(packagePath);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new MunhaeError("unsafe_backup_entry", "project backup root must be a real directory");
  }
  const realRoot = realpathSync(root);
  const files: Record<string, Uint8Array> = {};
  collectZipEntries(root, "", files, realRoot);
  const zipped = zipSync(files, { level: 6 });
  writeFileSync(destFile, zipped);
}

export type ImportedProjectAsset = {
  originalFilename: string;
  relativePath: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sanitizeAssetFilename(filename: string): string {
  const extension = extname(filename).toLowerCase();
  const stem = basename(filename, extname(filename))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
  return `${stem || "asset"}${safeExtension}`;
}

/**
 * Copies an external source into the portable package. The hash-prefixed name makes
 * retries idempotent while the returned path remains relative and safe to persist.
 */
export function importOriginalAsset(opts: {
  packagePath: string;
  sourcePath: string;
}): ImportedProjectAsset {
  readManifest(opts.packagePath);
  const sourceStat = statSync(opts.sourcePath);
  if (!sourceStat.isFile()) {
    throw new MunhaeError("invalid_asset", "asset source must be a regular file");
  }
  const originalFilename = basename(opts.sourcePath);
  const sha256 = sha256File(opts.sourcePath);
  const filename = `${sha256.slice(0, 16)}-${sanitizeAssetFilename(originalFilename)}`;
  const relativePath = posix.join("assets", "originals", filename);
  const destination = resolvePackagePath(opts.packagePath, relativePath);
  mkdirSync(join(opts.packagePath, "assets", "originals"), { recursive: true });
  if (!existsSync(destination)) {
    const temporary = `${destination}.${process.pid}.tmp`;
    copyFileSync(opts.sourcePath, temporary);
    if (sha256File(temporary) !== sha256) {
      rmSync(temporary, { force: true });
      throw new MunhaeError("asset_hash_mismatch", "copied asset hash does not match the source");
    }
    try {
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, { force: true });
      if (!existsSync(destination)) throw error;
    }
  } else if (sha256File(destination) !== sha256) {
    throw new MunhaeError("asset_hash_mismatch", "existing packaged asset has different contents");
  }
  return {
    originalFilename,
    relativePath,
    sha256,
    byteSize: sourceStat.size,
    mimeType: MIME_BY_EXTENSION[extname(originalFilename).toLowerCase()] ?? "application/octet-stream",
  };
}

function lstatIfPresent(file: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertRealPathContained(realRoot: string, candidate: string): void {
  const fromRoot = relative(realRoot, realpathSync(candidate));
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolutePathLike(fromRoot)) {
    throw new MunhaeError("invalid_asset_path", "package path resolves outside the project package");
  }
}

/**
 * Resolve a package-relative path without following symbolic links at the
 * package root or at any existing path component. The target may be absent so
 * callers can use the result for a new database, asset, or run-event file.
 */
export function resolvePackagePath(packagePath: string, storedPath: string): string {
  if (!storedPath || isAbsolutePathLike(storedPath) || storedPath.includes("\\")) {
    throw new MunhaeError("invalid_asset_path", "asset path must be package-relative POSIX text");
  }
  const normalized = posix.normalize(storedPath);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== storedPath) {
    throw new MunhaeError("invalid_asset_path", "asset path escapes the project package");
  }
  const root = resolve(packagePath);
  const rootStat = lstatIfPresent(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new MunhaeError("invalid_asset_path", "project package root must be a real directory");
  }
  const absolute = resolve(root, ...normalized.split("/"));
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || resolve(root, fromRoot) !== absolute) {
    throw new MunhaeError("invalid_asset_path", "asset path escapes the project package");
  }
  const realRoot = realpathSync(root);
  assertRealPathContained(realRoot, root);
  let current = root;
  const parts = normalized.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    const currentStat = lstatIfPresent(current);
    if (!currentStat) break;
    if (currentStat.isSymbolicLink()) {
      throw new MunhaeError("invalid_asset_path", "package paths must not contain symbolic links");
    }
    if (index < parts.length - 1 && !currentStat.isDirectory()) {
      throw new MunhaeError("invalid_asset_path", "package path parent must be a directory");
    }
    assertRealPathContained(realRoot, current);
  }
  return absolute;
}

export function readVerifiedProjectAsset(
  packagePath: string,
  asset: Pick<ImportedProjectAsset, "relativePath" | "sha256" | "byteSize">,
): Buffer {
  const absolute = resolvePackagePath(packagePath, asset.relativePath);
  if (!existsSync(absolute)) throw new MunhaeError("asset_unavailable", "project asset is missing");
  const bytes = readFileSync(absolute);
  if (bytes.byteLength !== asset.byteSize) {
    throw new MunhaeError("asset_unavailable", "project asset size does not match its record");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new MunhaeError("asset_unavailable", "project asset hash does not match its record");
  }
  return bytes;
}

export function verifyProjectAsset(
  packagePath: string,
  asset: Pick<ImportedProjectAsset, "relativePath" | "sha256" | "byteSize">,
): { valid: boolean; reason: "ok" | "missing" | "unsafe_path" | "size_mismatch" | "hash_mismatch" } {
  let absolute: string;
  try {
    absolute = resolvePackagePath(packagePath, asset.relativePath);
  } catch {
    return { valid: false, reason: "unsafe_path" };
  }
  if (!existsSync(absolute)) return { valid: false, reason: "missing" };
  const stat = statSync(absolute);
  if (!stat.isFile() || stat.size !== asset.byteSize) return { valid: false, reason: "size_mismatch" };
  if (sha256File(absolute) !== asset.sha256) return { valid: false, reason: "hash_mismatch" };
  return { valid: true, reason: "ok" };
}

function collectZipEntries(
  dir: string,
  prefix: string,
  files: Record<string, Uint8Array>,
  realRoot: string,
): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      throw new MunhaeError("unsafe_backup_entry", "project backups must not contain symbolic links");
    }
    const realEntry = realpathSync(abs);
    const fromRoot = relative(realRoot, realEntry);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolutePathLike(fromRoot)) {
      throw new MunhaeError("unsafe_backup_entry", "project backup entry resolves outside the project package");
    }
    if (
      name === ".lock" ||
      name === ".lock.guard" ||
      name.startsWith(".lock.stale-") ||
      name.startsWith(".lock.guard.stale-") ||
      name.endsWith("-wal") ||
      name.endsWith("-shm")
    ) continue;
    const rel = prefix ? posix.join(prefix, name) : name;
    if (st.isDirectory()) {
      collectZipEntries(abs, rel, files, realRoot);
    } else if (st.isFile()) {
      files[rel.split(sep).join("/")] = new Uint8Array(readFileSync(abs));
    } else {
      throw new MunhaeError("unsafe_backup_entry", "project backups may contain only regular files and directories");
    }
  }
}
