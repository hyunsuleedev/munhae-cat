import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MunhaeError } from "@munhae/domain";
import {
  acquireLock,
  checkpointAndZip,
  createPackageDir,
  importOriginalAsset,
  readManifest,
  releaseLock,
  resolvePackagePath,
  validateManifest,
  verifyProjectAsset,
} from "../src/index.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "munhae-fmt-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("createPackageDir / manifest", () => {
  it("writes a formatVersion 1 manifest with no absolute path", () => {
    const parent = tempDir();
    const { packagePath, manifest } = createPackageDir({
      parentDir: parent,
      title: "훈민정음 문헌 번역",
      projectId: "01900000-0000-7000-8000-000000000001",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    expect(packagePath.endsWith("훈민정음 문헌 번역.munhae")).toBe(true);
    const onDisk = readManifest(packagePath);
    expect(onDisk).toEqual(manifest);
    expect(manifest.format).toBe("io.munhae.project");
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.database).toBe("project.sqlite3");
    expect(manifest.storageMode).toBe("local");
    const raw = readFileSync(join(packagePath, "manifest.json"), "utf8");
    expect(raw).not.toMatch(/\/Users\//);
    expect(raw).not.toMatch(/[A-Z]:\\/);
    expect(JSON.stringify(manifest)).not.toContain(parent);
  });

  it("appends -2 on folder collision and keeps Hangul", () => {
    const parent = tempDir();
    const a = createPackageDir({
      parentDir: parent,
      title: "한글프로젝트",
      projectId: "01900000-0000-7000-8000-000000000002",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    const b = createPackageDir({
      parentDir: parent,
      title: "한글프로젝트",
      projectId: "01900000-0000-7000-8000-000000000003",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    expect(a.packagePath.endsWith("한글프로젝트.munhae")).toBe(true);
    expect(b.packagePath.endsWith("한글프로젝트-2.munhae")).toBe(true);
  });
});

describe("validateManifest", () => {
  it("rejects secret-looking keys", () => {
    expect(() =>
      validateManifest({
        format: "io.munhae.project",
        formatVersion: 1,
        projectId: "01900000-0000-7000-8000-000000000004",
        title: "x",
        storageMode: "local",
        database: "project.sqlite3",
        assetRoot: "assets",
        createdAt: "2026-09-01T12:00:00.000Z",
        minimumAppVersion: "0.1.0",
        apiKey: "sk-secret",
      }),
    ).toThrow(MunhaeError);
  });
});

describe("lock", () => {
  it("throws project_locked when pid is alive and steals a dead pid", () => {
    const parent = tempDir();
    const { packagePath } = createPackageDir({
      parentDir: parent,
      title: "lock-test",
      projectId: "01900000-0000-7000-8000-000000000005",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    acquireLock(packagePath);
    expect(() => acquireLock(packagePath)).toThrow(/project_locked/);
    releaseLock(packagePath);
    writeFileSync(join(packagePath, ".lock"), "99999999\n", "utf8");
    writeFileSync(join(packagePath, ".lock.guard"), "99999999\n", "utf8");
    acquireLock(packagePath);
    expect(existsSync(join(packagePath, ".lock.guard"))).toBe(false);
    releaseLock(packagePath);
  });

  it("does not reclaim malformed or foreign-host locks", () => {
    const parent = tempDir();
    const { packagePath } = createPackageDir({
      parentDir: parent,
      title: "lock-guard",
      projectId: "01900000-0000-7000-8000-000000000009",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    const lock = join(packagePath, ".lock");
    writeFileSync(lock, "not-a-lock\n", "utf8");
    expect(() => acquireLock(packagePath)).toThrow(/owner could not be verified/);
    expect(readFileSync(lock, "utf8")).toBe("not-a-lock\n");

    writeFileSync(lock, `99999999\n${JSON.stringify({
      version: 1,
      pid: 99999999,
      hostname: "another-host.example",
      token: "00000000-0000-4000-8000-000000000009",
      createdAt: "2026-09-01T12:00:00.000Z",
    })}\n`, "utf8");
    expect(() => acquireLock(packagePath)).toThrow(/another-host\.example/);
    expect(readFileSync(lock, "utf8")).toContain("another-host.example");
  });

  it("writes an exclusive owner token and only the owner release removes it", () => {
    const parent = tempDir();
    const { packagePath } = createPackageDir({
      parentDir: parent,
      title: "lock-owner",
      projectId: "01900000-0000-7000-8000-000000000010",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    acquireLock(packagePath);
    const lock = join(packagePath, ".lock");
    const raw = readFileSync(lock, "utf8");
    const record = JSON.parse(raw.trim().split(/\r?\n/).slice(1).join("\n")) as { pid: number; token: string };
    expect(record.pid).toBe(process.pid);
    expect(record.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.parseInt(raw, 10)).toBe(process.pid);
    expect(() => acquireLock(packagePath)).toThrow(/project_locked/);
    expect(readFileSync(lock, "utf8")).toBe(raw);
    releaseLock(packagePath);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("checkpointAndZip", () => {
  it("writes a zip of the package directory", () => {
    const parent = tempDir();
    const { packagePath } = createPackageDir({
      parentDir: parent,
      title: "zip-test",
      projectId: "01900000-0000-7000-8000-000000000006",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    writeFileSync(join(packagePath, "project.sqlite3"), "sqlite-bytes");
    const dest = join(parent, "zip-test.munhaepkg");
    checkpointAndZip(packagePath, dest);
    const bytes = readFileSync(dest);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(bytes.byteLength).toBeGreaterThan(30);
  });

  it.skipIf(process.platform === "win32")("rejects file, directory, excluded-name, and package-root symlinks", () => {
    const parent = tempDir();
    const { packagePath } = createPackageDir({
      parentDir: parent,
      title: "zip-link-guard",
      projectId: "01900000-0000-7000-8000-000000000012",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    writeFileSync(join(packagePath, "project.sqlite3"), "sqlite-bytes");
    const outsideFile = join(parent, "outside-secret.txt");
    const outsideDir = join(parent, "outside-dir");
    writeFileSync(outsideFile, "must-not-leak", "utf8");
    createPackageDir({
      parentDir: outsideDir,
      title: "nested",
      projectId: "01900000-0000-7000-8000-000000000013",
      createdAt: "2026-09-01T12:00:00.000Z",
    });

    const destination = join(parent, "unsafe.munhaepkg");
    const fileLink = join(packagePath, "leak.txt");
    symlinkSync(outsideFile, fileLink);
    expect(() => checkpointAndZip(packagePath, destination)).toThrow(/symbolic links/);
    expect(existsSync(destination)).toBe(false);
    rmSync(fileLink);

    const directoryLink = join(packagePath, "linked-directory");
    symlinkSync(outsideDir, directoryLink);
    expect(() => checkpointAndZip(packagePath, destination)).toThrow(/symbolic links/);
    expect(existsSync(destination)).toBe(false);
    rmSync(directoryLink);

    const excludedLink = join(packagePath, ".lock");
    symlinkSync(outsideFile, excludedLink);
    expect(() => checkpointAndZip(packagePath, destination)).toThrow(/symbolic links/);
    expect(existsSync(destination)).toBe(false);
    rmSync(excludedLink);

    const packageLink = join(parent, "zip-link-root.munhae");
    symlinkSync(packagePath, packageLink);
    expect(() => checkpointAndZip(packageLink, destination)).toThrow(/real directory/);
    expect(existsSync(destination)).toBe(false);
  });
});

describe("portable assets", () => {
  it("copies and deduplicates an original by content hash", () => {
    const parent = tempDir();
    const { packagePath } = createPackageDir({
      parentDir: parent,
      title: "asset-test",
      projectId: "01900000-0000-7000-8000-000000000007",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    const source = join(parent, "원문 사진.png");
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const first = importOriginalAsset({ packagePath, sourcePath: source });
    const second = importOriginalAsset({ packagePath, sourcePath: source });
    expect(second).toEqual(first);
    expect(first.relativePath).toMatch(/^assets\/originals\/[0-9a-f]{16}-원문 사진\.png$/);
    expect(first.mimeType).toBe("image/png");
    expect(existsSync(resolvePackagePath(packagePath, first.relativePath))).toBe(true);
    expect(verifyProjectAsset(packagePath, first)).toEqual({ valid: true, reason: "ok" });
  });

  it("rejects traversal and reports tampered content", () => {
    const parent = tempDir();
    const { packagePath } = createPackageDir({
      parentDir: parent,
      title: "asset-guard",
      projectId: "01900000-0000-7000-8000-000000000008",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    expect(() => resolvePackagePath(packagePath, "../outside.txt")).toThrow(/escapes/);
    expect(() => resolvePackagePath(packagePath, "/tmp/outside.txt")).toThrow(/package-relative/);
    const source = join(parent, "source.txt");
    writeFileSync(source, "original", "utf8");
    const asset = importOriginalAsset({ packagePath, sourcePath: source });
    writeFileSync(resolvePackagePath(packagePath, asset.relativePath), "tampered", "utf8");
    expect(verifyProjectAsset(packagePath, asset)).toEqual({ valid: false, reason: "hash_mismatch" });
  });

  it.skipIf(process.platform === "win32")("does not follow a packaged asset symlink outside the project", () => {
    const parent = tempDir();
    const { packagePath } = createPackageDir({
      parentDir: parent,
      title: "asset-link-guard",
      projectId: "01900000-0000-7000-8000-000000000011",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    const source = join(parent, "outside.png");
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const asset = importOriginalAsset({ packagePath, sourcePath: source });
    const packaged = resolvePackagePath(packagePath, asset.relativePath);
    rmSync(packaged);
    symlinkSync(source, packaged);
    expect(verifyProjectAsset(packagePath, asset)).toEqual({ valid: false, reason: "unsafe_path" });
  });

  it.skipIf(process.platform === "win32")("rejects package-root, manifest, database, and run-path symlink components", () => {
    const parent = tempDir();
    const { packagePath } = createPackageDir({
      parentDir: parent,
      title: "package-link-boundary",
      projectId: "01900000-0000-7000-8000-000000000014",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    const rootLink = join(parent, "linked-root.munhae");
    symlinkSync(packagePath, rootLink);
    expect(() => resolvePackagePath(rootLink, "project.sqlite3")).toThrow(/real directory/);

    const manifestPath = join(packagePath, "manifest.json");
    const manifestJson = readFileSync(manifestPath, "utf8");
    const outsideManifest = join(parent, "outside-manifest.json");
    writeFileSync(outsideManifest, manifestJson, "utf8");
    rmSync(manifestPath);
    symlinkSync(outsideManifest, manifestPath);
    expect(() => readManifest(packagePath)).toThrow(/symbolic links/);
    rmSync(manifestPath);
    writeFileSync(manifestPath, manifestJson, "utf8");

    const outsideDatabase = join(parent, "outside.sqlite3");
    writeFileSync(outsideDatabase, "outside", "utf8");
    const databasePath = join(packagePath, "project.sqlite3");
    symlinkSync(outsideDatabase, databasePath);
    expect(() => resolvePackagePath(packagePath, "project.sqlite3")).toThrow(/symbolic links/);
    rmSync(databasePath);

    const outsideRuns = join(parent, "outside-runs");
    mkdirSync(outsideRuns);
    const runsPath = join(packagePath, "runs");
    symlinkSync(outsideRuns, runsPath);
    expect(() => resolvePackagePath(packagePath, "runs/01900000-0000-7000-8000-000000000014/events.jsonl"))
      .toThrow(/symbolic links/);
    rmSync(runsPath);

    mkdirSync(runsPath);
    const messagePath = join(runsPath, "01900000-0000-7000-8000-000000000014");
    symlinkSync(outsideRuns, messagePath);
    expect(() => resolvePackagePath(packagePath, "runs/01900000-0000-7000-8000-000000000014/events.jsonl"))
      .toThrow(/symbolic links/);
    rmSync(messagePath);
    expect(resolvePackagePath(packagePath, "runs/01900000-0000-7000-8000-000000000014/events.jsonl"))
      .toBe(join(packagePath, "runs", "01900000-0000-7000-8000-000000000014", "events.jsonl"));
  });
});
