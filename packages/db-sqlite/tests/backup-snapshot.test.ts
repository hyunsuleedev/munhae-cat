import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractZip } from "../../../apps/desktop/src/main/zip.ts";
import { createProject, openProject, openSqlite, sqlitePath, type ProjectRepo, type SqliteDb } from "../src/index.ts";

const roots: string[] = [];
const repos: ProjectRepo[] = [];
const readers: SqliteDb[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "munhae-backup-snapshot-"));
  roots.push(root);
  const repo = createProject({ parentDir: root, title: "백업 ' 검증" }).handle;
  repos.push(repo);
  const createDocument = (title: string) => repo.createDocument({
    title, nodeRole: "source_unit", sourceText: title, originKind: "paste", parentId: null,
  });
  return { root, repo, createDocument };
}

afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const repo of repos.splice(0)) repo.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("consistent project backup", () => {
  it("restores the latest committed documents while another reader holds an older WAL snapshot", async () => {
    const { root, repo, createDocument } = fixture();
    createDocument("기존 문서");
    repo.checkpoint();
    const reader = openSqlite(sqlitePath(repo.packagePath));
    readers.push(reader);
    reader.exec("BEGIN");
    const originalCount = reader.prepare("SELECT count(*) AS n FROM document_nodes").get();
    createDocument("백업 직전 저장");
    writeFileSync(join(repo.packagePath, "assets", "originals", "evidence.txt"), "첨부 근거");

    const backup = join(root, "최신 백업.munhaepkg");
    repo.backupTo(backup);
    // The backup neither relies on nor closes the concurrent reader's snapshot.
    expect(reader.prepare("SELECT count(*) AS n FROM document_nodes").get()).toEqual(originalCount);
    const restoredPath = join(root, "restored.munhae");
    await extractZip(backup, restoredPath);
    expect(existsSync(join(restoredPath, "project.sqlite3-wal"))).toBe(false);
    expect(readFileSync(join(restoredPath, "assets", "originals", "evidence.txt"), "utf8")).toBe("첨부 근거");
    const restored = openProject(restoredPath);
    repos.push(restored);
    expect(restored.getHome().documents.filter(doc => doc.nodeRole === "source_unit").map(doc => doc.title).sort())
      .toEqual(["기존 문서", "백업 직전 저장"].sort());
  });

  it.skipIf(process.platform === "win32")("preserves an existing backup if an unsafe asset aborts the new archive", () => {
    const { root, repo, createDocument } = fixture();
    createDocument("보존할 문서");
    const backup = join(root, "existing.munhaepkg");
    repo.backupTo(backup);
    const previous = readFileSync(backup);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "외부 파일");
    symlinkSync(outside, join(repo.packagePath, "unsafe-link.txt"));
    expect(() => repo.backupTo(backup)).toThrow(/symbolic links/);
    expect(readFileSync(backup)).toEqual(previous);
  });
});
