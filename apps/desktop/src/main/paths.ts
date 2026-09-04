import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors";

export const mainDir = dirname(fileURLToPath(import.meta.url));

export function isPathInside(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedRoot === resolvedTarget) return true;
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function realpathIfExists(target: string): string {
  try {
    return existsSync(target) ? realpathSync(target) : resolve(target);
  } catch {
    return resolve(target);
  }
}

/** Prefix + separator check used for asset paths inside the current .munhae package. */
export function isInsidePackageRoot(packageRoot: string, target: string): boolean {
  const root = realpathIfExists(packageRoot);
  const resolved = realpathIfExists(target);
  if (root === resolved) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return resolved.startsWith(prefix);
}

export function preloadScriptPath(): string {
  const dir = join(mainDir, "../preload");
  for (const name of ["index.cjs", "index.js", "index.mjs"] as const) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, "index.cjs");
}

export function rendererDir(): string {
  return resolve(join(mainDir, "../renderer"));
}

export function rendererIndexHtml(): string {
  return join(mainDir, "../renderer/index.html");
}

export function uniquePath(base: string): string {
  if (!existsSync(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new AppError("exists", "대상 경로를 만들 수 없습니다.");
}
