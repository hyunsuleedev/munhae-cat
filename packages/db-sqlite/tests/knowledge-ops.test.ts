import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MunhaeError } from "@munhae/domain";
import { createProject, openProject, openSqlite, seedDemoProject, sqlitePath, type ProjectRepo } from "../src/index.ts";
import { PROJECT_INIT_SQL } from "../src/embedded-sql.ts";

const dirs: string[] = [];
const repos: ProjectRepo[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "munhae-knowledge-"));
  dirs.push(dir);
  return dir;
}

function track(repo: ProjectRepo): ProjectRepo {
  repos.push(repo);
  return repo;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(MunhaeError);
    expect((error as MunhaeError).code).toBe(code);
  }
}

afterEach(() => {
  while (repos.length > 0) {
    try {
      repos.pop()?.close();
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("document metadata and context cards", () => {
  it("updates metadata with CAS and inherits only the designated parent fields", () => {
    const repo = track(createProject({ title: "문서 정보", parentDir: tempDir() }).handle);
    const root = repo.getHome().documents.find((item) => item.isMaster)!;
    const rootMetadata = repo.getDocumentMetadata(root.id);
    const updatedRoot = repo.updateDocumentMetadata({
      documentNodeId: root.id,
      title: rootMetadata.title,
      originalTitle: "文解集",
      authorName: "  허균  ",
      language: "lzh",
      periodText: "조선 중기",
      dateText: "1446",
      descriptionMd: "프로젝트 공통 설명",
      sourceReference: "소장본 A",
      expectedLockVersion: rootMetadata.lockVersion,
    });
    expect(updatedRoot.lockVersion).toBe(rootMetadata.lockVersion + 1);
    expect(updatedRoot.authorName).toBe("허균");

    const child = repo.createDocument({
      title: "서문",
      originalTitle: "序",
      parentId: root.id,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "天地玄黃。",
    });
    const editor = repo.getEditor(child.id);
    expect(editor.document).toMatchObject({
      authorName: "허균",
      language: "lzh",
      periodText: "조선 중기",
      dateText: null,
      sourceReference: "소장본 A",
    });

    const childMetadata = repo.getDocumentMetadata(child.id);
    expect(childMetadata.authorName).toBeNull();
    const overridden = repo.updateDocumentMetadata({
      ...childMetadata,
      documentNodeId: child.id,
      authorName: "別人",
      periodText: "별도 시대",
      dateText: "1600년경",
      expectedLockVersion: childMetadata.lockVersion,
    });
    expect(repo.getEditor(child.id).document).toMatchObject({
      authorName: "別人", periodText: "별도 시대", dateText: "1600년경", sourceReference: "소장본 A",
    });
    repo.updateDocumentMetadata({ ...overridden, documentNodeId: child.id, authorName: "  ", expectedLockVersion: overridden.lockVersion });
    expect(repo.getDocumentMetadata(child.id).authorName).toBeNull();
    expect(repo.getEditor(child.id).document).toMatchObject({ authorName: "허균", dateText: "1600년경" });

    expectCode(
      () => repo.updateDocumentMetadata({ ...updatedRoot, documentNodeId: root.id, expectedLockVersion: rootMetadata.lockVersion }),
      "cas_conflict",
    );
  });

  it("creates, edits, toggles, reprioritizes, and deletes context cards with CAS", () => {
    const repo = track(createProject({ title: "문맥", parentDir: tempDir() }).handle);
    const root = repo.getHome().documents.find((item) => item.isMaster)!;
    const child = repo.createDocument({
      title: "원문",
      parentId: root.id,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "天地玄黃。",
    });
    let editor = repo.getEditor(child.id);
    editor = repo.confirmSource({
      documentNodeId: child.id,
      expectedLockVersion: editor.source.lockVersion,
    });
    editor = repo.createPunctuationDraftFromConfirmedSource({
      documentNodeId: child.id,
      structureMode: "prose",
      expectedSourceLockVersion: editor.source.lockVersion,
    });
    if (!editor.punctuation) throw new Error("expected punctuation draft");
    editor = repo.confirmPunctuation({
      documentNodeId: child.id,
      expectedLockVersion: editor.punctuation.lockVersion,
    });
    expect(editor.punctuation?.state).toBe("confirmed");
    expect(editor.anchors.length).toBeGreaterThan(0);
    const ancestor = repo.createContextItem({
      scopeId: root.id,

      title: "공통 문맥",
      contentMd: "프로젝트 전체 문맥",
      priority: 999,
      enabled: true,
    });
    const direct = repo.createContextItem({
      scopeId: child.id,

      title: "현재 문서",
      contentMd: "현재 문서 문맥",
      priority: -10,
      enabled: true,
    });
    const order = repo.previewContext({ documentNodeId: child.id }).auxiliary
      .filter((item) => item.kind === "context_item")
      .map((item) => item.id);
    expect(order).toEqual([direct.id, ancestor.id]);

    const edited = repo.updateContextItem({
      id: direct.id,
      scopeId: child.id,

      title: "근거",
      contentMd: "교감 근거",
      priority: 4,
      enabled: true,
      expectedLockVersion: direct.lockVersion,
    });
    const disabled = repo.setContextItemEnabled({
      id: edited.id,
      enabled: false,
      expectedLockVersion: edited.lockVersion,
    });
    expect(disabled.enabled).toBe(false);
    expect(
      repo.previewContext({ documentNodeId: child.id }).auxiliary.find((item) => item.id === direct.id),
    ).toMatchObject({ included: false, defaultIncluded: false });
    expectCode(
      () => repo.setContextItemPriority({ id: direct.id, priority: 8, expectedLockVersion: edited.lockVersion }),
      "cas_conflict",
    );
    const prioritized = repo.setContextItemPriority({
      id: disabled.id,
      priority: 8,
      expectedLockVersion: disabled.lockVersion,
    });
    repo.deleteContextItem({ id: prioritized.id, expectedLockVersion: prioritized.lockVersion });
    expect(repo.getKnowledge().contextItems.some((item) => item.id === direct.id)).toBe(false);
    expectCode(
      () => repo.deleteContextItem({ id: ancestor.id, expectedLockVersion: ancestor.lockVersion + 1 }),
      "cas_conflict",
    );
  });
});

describe("uncertainty removal", () => {
  it("drops the uncertainty tables with their rows when a v17 project opens", () => {
    const created = createProject({ title: "불확실성 제거", parentDir: tempDir() }).handle;
    const path = created.packagePath;
    created.close();
    const db = openSqlite(sqlitePath(path));
    try {
      const tables = PROJECT_INIT_SQL.match(/CREATE TABLE uncertaint\w* \([\s\S]*?\) STRICT;/g)!;
      expect(tables).toHaveLength(4);
      const project = db.prepare("SELECT id FROM core_projects").get() as { id: string };
      const actor = db.prepare("SELECT id FROM core_actors LIMIT 1").get() as { id: string };
      db.exec(`${tables.join("\n")}
        DELETE FROM meta_schema_migrations WHERE version >= 18; UPDATE meta_project_state SET schema_version = 17;`);
      db.prepare("INSERT INTO uncertainties VALUES ('u1', ?, 'textual', 'minor', 0, 'open', '2026-09-01T00:00:00.000Z')").run(project.id);
      db.prepare("INSERT INTO uncertainty_versions VALUES ('v1', ?, 'u1', NULL, 1, '판독', NULL, NULL, 'hash', ?, '2026-09-01T00:00:00.000Z')").run(project.id, actor.id);
    } finally { db.close(); }

    track(openProject(path));
    const check = openSqlite(sqlitePath(path));
    try {
      expect(check.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%uncertaint%'").all()).toEqual([]);
      expect(check.prepare("SELECT schema_version FROM meta_project_state").get()).toEqual({ schema_version: 18 });
    } finally { check.close(); }
  });
});

describe("home activity", () => {
  it("reports each source's current translation version and latest text activity", () => {
    const repo = track(seedDemoProject(tempDir()));
    const before = repo.getHome();
    const sources = before.documents.filter((item) => item.nodeRole === "source_unit");
    expect(before.activity.map((item) => item.documentId)).toEqual(sources.map((item) => item.id));
    for (const source of sources) {
      expect(before.activity.find((item) => item.documentId === source.id)!.translationVersion)
        .toBe(repo.getEditor(source.id).translation?.versionNo ?? null);
    }

    const document = sources.find((item) => item.originalTitle === "御製序")!;
    const editor = repo.getEditor(document.id);
    const quote = Array.from(editor.translation!.textContent).slice(0, 2).join("");
    const comment = repo.createReviewComment({
      documentNodeId: document.id,
      translationVersionId: editor.translation!.versionId,
      targetKind: "translation",
      targetVersionId: editor.translation!.versionId,
      codepointFrom: 0,
      codepointTo: 2,
      quote,
      bodyMd: "홈 여백에 보일 코멘트",
    });
    const source = repo.getEditor(document.id).source;
    repo.saveSourceDraft({ documentNodeId: document.id, contentText: `${source.contentText}。`, originKind: "manual", expectedLockVersion: source.lockVersion });

    const after = repo.getHome();
    const previous = before.activity.find((item) => item.documentId === document.id)!;
    const entry = after.activity.find((item) => item.documentId === document.id)!;
    expect(entry.lastActivityAt).not.toBeNull();
    expect(entry.lastActivityAt! >= (previous.lastActivityAt ?? "")).toBe(true);
    expect(entry.lastActivityAt! >= comment.updatedAt).toBe(true);
    expect(entry.commentCount).toBe(previous.commentCount + 1);
    expect(entry.recentComments[0]).toEqual({ id: comment.id, quote, bodyMd: "홈 여백에 보일 코멘트", updatedAt: comment.updatedAt });
    expect(entry.recentComments.length).toBeLessThanOrEqual(2);
  });
});
