import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProject, openSqlite, sqlitePath, type ProjectRepo } from "../src/index.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "munhae-organize-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  const repo = createProject({ title: "정리 검증", parentDir: path }).handle;
  cleanup.push(() => repo.close());
  const root = repo.getHome().documents.find(doc => doc.isMaster)!;
  const folder = (title: string, parentId = root.id) => repo.createDocument({ title, parentId, nodeRole: "container", originalTitle: null });
  const source = (title: string, parentId: string) => repo.createDocument({ title, parentId, nodeRole: "source_unit", originalTitle: null, sourceText: "天地玄黃。", originKind: "manual" });
  return { repo, root, folder, source };
}
function move(repo: ProjectRepo, id: string, parentId: string, beforeDocumentNodeId: string | null = null) {
  return repo.moveDocument({ documentNodeId: id, parentId, beforeDocumentNodeId, expectedLockVersion: repo.getDocumentMetadata(id).lockVersion });
}
describe("document organization", () => {
  it("reorders without unique-ordinal collisions and rejects stale writes", () => {
    const { repo, root, source } = fixture();
    const a = source("첫 글", root.id), b = source("둘째 글", root.id), c = source("셋째 글", root.id);
    const stale = repo.getDocumentMetadata(a.id).lockVersion;
    move(repo, c.id, root.id, a.id);
    expect(repo.getHome().documents.filter(doc => doc.parentId === root.id).map(doc => doc.id)).toEqual([c.id, a.id, b.id]);
    expect(() => repo.moveDocument({ documentNodeId: a.id, parentId: root.id, beforeDocumentNodeId: null, expectedLockVersion: stale })).toThrow(/다른 창/);
    move(repo, c.id, root.id);
    expect(repo.getHome().documents.filter(doc => doc.parentId === root.id).map(doc => doc.id)).toEqual([a.id, b.id, c.id]);
  });
  it("moves a whole branch, changes inherited metadata, and preserves source content", () => {
    const { repo, folder, source } = fixture();
    const a = folder("기존"), b = folder("새 위치"), branch = folder("권1", a.id), doc = source("서문", branch.id);
    const metadata = repo.getDocumentMetadata(b.id);
    repo.updateDocumentMetadata({ ...metadata, documentNodeId: b.id, authorName: "새 저자", descriptionMd: "새 상위 문맥", expectedLockVersion: metadata.lockVersion });
    const oldContext = repo.createContextItem({ scopeId: a.id, title: "기존 문맥", contentMd: "기존 지침", enabled: true, priority: 0 });
    const newContext = repo.createContextItem({ scopeId: b.id, title: "새 문맥", contentMd: "새 지침", enabled: true, priority: 0 });
    expect(repo.getMaterials(doc.id).resolved?.some(item => item.id === oldContext.id && item.included)).toBe(true);
    const original = repo.getEditor(doc.id);
    move(repo, branch.id, b.id);
    expect(repo.getDocumentMetadata(branch.id).parentId).toBe(b.id);
    expect(repo.getDocumentMetadata(doc.id).parentId).toBe(branch.id);
    expect(repo.getEditor(doc.id).document.authorName).toBe("새 저자");
    expect(repo.getEditor(doc.id).source).toEqual(original.source);
    expect(repo.getMaterials(doc.id).resolved?.some(item => item.id === oldContext.id && item.included)).toBe(false);
    expect(repo.getMaterials(doc.id).resolved?.some(item => item.id === newContext.id && item.included)).toBe(true);
    expect(repo.getMaterials(doc.id).resolved?.some(item => item.id === `document:${b.id}:description` && item.included)).toBe(true);
  });
  it("keeps unique sibling ordinals valid when archived rows occupy positions", () => {
    const { repo, root, folder, source } = fixture();
    const a = source("보존", root.id), archived = folder("보관"), b = source("마지막", root.id);
    const db = openSqlite(sqlitePath(repo.packagePath));
    try {
      db.prepare("UPDATE document_nodes SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), archived.id);
      move(repo, b.id, root.id, a.id);
      expect(repo.getHome().documents.filter(doc => doc.parentId === root.id).map(doc => doc.id)).toEqual([b.id, a.id]);
      expect(() => move(repo, a.id, archived.id)).toThrow(/폴더/);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });
  it("rejects master, cycles, source parents and foreign-project targets without changing the tree", () => {
    const { repo, root, folder, source } = fixture();
    const a = folder("권1"), b = folder("권2", a.id), doc = source("서문", a.id);
    const foreign = fixture();
    const before = repo.getHome().documents;
    expect(() => move(repo, root.id, a.id)).toThrow(/마스터/);
    expect(() => move(repo, a.id, b.id)).toThrow(/하위/);
    expect(() => move(repo, a.id, a.id)).toThrow(/자기/);
    expect(() => move(repo, a.id, doc.id)).toThrow(/폴더/);
    expect(() => move(repo, a.id, foreign.root.id)).toThrow(/폴더/);
    expect(() => move(repo, doc.id, root.id, b.id)).toThrow(/위치/);
    expect(repo.getHome().documents).toEqual(before);
  });
});
