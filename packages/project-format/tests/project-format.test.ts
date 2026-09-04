import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MunhaeError } from "@munhae/domain";
import {
  acquireLock,
  checkpointAndZip,
  createPackageDir,
  readManifest,
  releaseLock,
  validateManifest,
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
    acquireLock(packagePath);
    releaseLock(packagePath);
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
});
