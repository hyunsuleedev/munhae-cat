import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
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
  writeFileSync(join(packagePath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { packagePath, manifest };
}

export function readManifest(packagePath: string): ProjectManifest {
  const raw = readFileSync(join(packagePath, "manifest.json"), "utf8");
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

export function acquireLock(packagePath: string): void {
  const file = lockPath(packagePath);
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (pidAlive(pid)) {
      throw new MunhaeError("project_locked", `project_locked: project is locked by pid ${pid}`);
    }
  }
  writeFileSync(file, `${process.pid}\n`, "utf8");
}

export function releaseLock(packagePath: string): void {
  const file = lockPath(packagePath);
  if (!existsSync(file)) return;
  const raw = readFileSync(file, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  if (pid === process.pid || !pidAlive(pid)) {
    rmSync(file, { force: true });
  }
}

export function checkpointAndZip(packagePath: string, destFile: string): void {
  const files: Record<string, Uint8Array> = {};
  collectZipEntries(packagePath, "", files);
  const zipped = zipSync(files, { level: 6 });
  writeFileSync(destFile, zipped);
}

function collectZipEntries(dir: string, prefix: string, files: Record<string, Uint8Array>): void {
  for (const name of readdirSync(dir)) {
    if (name === ".lock" || name.endsWith("-wal") || name.endsWith("-shm")) continue;
    const abs = join(dir, name);
    const rel = prefix ? posix.join(prefix, name) : name;
    const st = statSync(abs);
    if (st.isDirectory()) {
      collectZipEntries(abs, rel, files);
    } else {
      files[rel.split(sep).join("/")] = new Uint8Array(readFileSync(abs));
    }
  }
}
