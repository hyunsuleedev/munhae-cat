import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MunhaeError } from "@munhae/domain";
import { codepointCount } from "@munhae/domain";
import {
  applySqlMigration,
  createProject,
  openProject,
  openSqlite,
  seedDemoProject,
  type ProjectRepo,
} from "../src/index.ts";

const dirs: string[] = [];
const repos: ProjectRepo[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "munhae-db-"));
  dirs.push(dir);
  return dir;
}

function track<T extends ProjectRepo>(repo: T): T {
  repos.push(repo);
  return repo;
}

afterEach(() => {
  while (repos.length) {
    const repo = repos.pop();
    try {
      repo?.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("document nodes", () => {
  it("creates a child node with source, punctuation, and anchors", () => {
    const { handle } = createProject({ title: "노드 테스트", parentDir: tempDir() });
    track(handle);
    const root = handle.getHome().documents[0];
    expect(root).toBeTruthy();
    expect(root).toMatchObject({ parentId: null, nodeRole: "container", isMaster: true });
    const child = handle.createDocument({
      title: "서문",
      originalTitle: "序",
      parentId: null,
      nodeRole: "source_unit",
      structuralKind: "section",
      genre: "preface",
      originKind: "paste",
      sourceText: "天地玄黃。宇宙洪荒。",
    });
    expect(child.parentId).toBe(root!.id);
    expect(child.nodeRole).toBe("source_unit");
    expect(child.originalTitle).toBe("序");
    expect(child.sourceState).toBe("draft");
    expect(child.punctuationState).toBe("draft");
    expect(handle.getHome().progress.total).toBe(1);
    const editor = handle.getEditor(child.id);
    expect(editor.document.title).toBe("서문");
    expect(editor.source.contentText).toBe("天地玄黃。宇宙洪荒。");
    expect(editor.punctuation.punctuatedText).toBe("天地玄黃。宇宙洪荒。");
    expect(editor.anchors.map((a) => a.anchorKey)).toEqual(["A001", "A002"]);
  });

  it("creates a structure-only node without source", () => {
    const { handle } = createProject({ title: "구조", parentDir: tempDir() });
    track(handle);
    const chapter = handle.createDocument({
      title: "해례",
      parentId: handle.getHome().documents[0]!.id,
      nodeRole: "container",
      structuralKind: "chapter",
      genre: "prose",
    });
    expect(chapter.nodeRole).toBe("container");
    expect(chapter.sourceState).toBe("none");
    expect(chapter.structuralKind).toBe("chapter");
    expect(handle.getHome().progress.total).toBe(0);
    expect(() => handle.getEditor(chapter.id)).toThrow(/원문/);
  });

  it("rejects children under a source unit", () => {
    const { handle } = createProject({ title: "역할", parentDir: tempDir() });
    track(handle);
    const root = handle.getHome().documents[0]!;
    const source = handle.createDocument({
      title: "원문",
      parentId: root.id,
      nodeRole: "source_unit",
      structuralKind: "item",
      genre: "prose",
      originKind: "paste",
      sourceText: "天地玄黃。",
    });

    expect(() =>
      handle.createDocument({
        title: "잘못된 하위 폴더",
        parentId: source.id,
        nodeRole: "container",
        structuralKind: "section",
        genre: "prose",
      }),
    ).toThrow(/원문 문서 아래에는/);
  });

  it("migrates a legacy source-plus-children node into a container and preserved source unit", () => {
    const db = openSqlite(join(tempDir(), "legacy.sqlite3"));
    const initSql = readFileSync(new URL("../migrations/sqlite/001_init.sql", import.meta.url), "utf8");
    const roleSql = readFileSync(new URL("../migrations/sqlite/002_document_node_roles.sql", import.meta.url), "utf8");
    applySqlMigration(db, initSql, "001_init.sql", 1);
    db.exec(`
      INSERT INTO core_actors (id, actor_kind, display_name, created_at)
      VALUES ('actor', 'human', 'tester', '2026-09-04T00:00:00Z');
      INSERT INTO core_projects (id, title, created_by_actor_id, created_at, updated_at)
      VALUES ('project', 'legacy', 'actor', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');
      INSERT INTO meta_project_state (project_id, schema_version, format_version)
      VALUES ('project', 1, 1);
      INSERT INTO document_nodes (id, project_id, parent_node_id, structural_kind, title, ordinal, created_at, updated_at)
      VALUES
        ('hybrid', 'project', NULL, 'section', '龍飛御天歌 序', 0, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'),
        ('child', 'project', 'hybrid', 'item', '하위 항목', 0, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');
      INSERT INTO src_texts (id, project_id, document_node_id, name, created_at)
      VALUES ('source', 'project', 'hybrid', '원문', '2026-09-04T00:00:00Z');
      INSERT INTO context_items (id, project_id, item_kind, scope_kind, scope_id, title, content_md, content_hash, created_at, updated_at)
      VALUES ('context', 'project', 'note', 'document_node', 'hybrid', '작품 문맥', '문맥 내용', 'hash', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');
    `);

    applySqlMigration(db, roleSql, "002_document_node_roles.sql", 2);
    const nodes = db
      .prepare("SELECT id, parent_node_id, node_role, ordinal FROM document_nodes ORDER BY parent_node_id, ordinal")
      .all() as Array<{ id: string; parent_node_id: string | null; node_role: string; ordinal: number }>;
    const source = nodes.find((node) => node.id === "hybrid")!;
    const wrapper = nodes.find((node) => node.node_role === "container" && node.id !== "child")!;
    const child = nodes.find((node) => node.id === "child")!;
    const context = db.prepare("SELECT scope_id FROM context_items WHERE id = 'context'").get() as { scope_id: string };

    expect(wrapper.parent_node_id).toBeNull();
    expect(source.node_role).toBe("source_unit");
    expect(source.parent_node_id).toBe(wrapper.id);
    expect(source.ordinal).toBe(0);
    expect(child.parent_node_id).toBe(wrapper.id);
    expect(child.ordinal).toBe(1);
    expect(context.scope_id).toBe(wrapper.id);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(() =>
      db.prepare("INSERT INTO src_texts (id, project_id, document_node_id, name, created_at) VALUES (?, ?, ?, ?, ?)").run(
        "bad-source",
        "project",
        wrapper.id,
        "잘못된 원문",
        "2026-09-04T00:00:00Z",
      ),
    ).toThrow(/container nodes cannot contain source text/);
    db.close();
  });

  it("creates one master for legacy roots and moves project context onto it", () => {
    const db = openSqlite(join(tempDir(), "legacy-master.sqlite3"));
    const initSql = readFileSync(new URL("../migrations/sqlite/001_init.sql", import.meta.url), "utf8");
    const roleSql = readFileSync(new URL("../migrations/sqlite/002_document_node_roles.sql", import.meta.url), "utf8");
    const masterSql = readFileSync(new URL("../migrations/sqlite/003_project_master_container.sql", import.meta.url), "utf8");
    applySqlMigration(db, initSql, "001_init.sql", 1);
    db.exec(`
      INSERT INTO core_actors (id, actor_kind, display_name, created_at)
      VALUES ('actor', 'human', 'tester', '2026-09-04T00:00:00Z');
      INSERT INTO core_projects (id, title, created_by_actor_id, created_at, updated_at)
      VALUES ('project', '통합 프로젝트', 'actor', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');
      INSERT INTO meta_project_state (project_id, schema_version, format_version)
      VALUES ('project', 1, 1);
    `);
    applySqlMigration(db, roleSql, "002_document_node_roles.sql", 2);
    db.exec(`
      INSERT INTO document_nodes
        (id, project_id, parent_node_id, structural_kind, node_role, title, ordinal, created_at, updated_at)
      VALUES
        ('folder', 'project', NULL, 'work', 'container', '작품 폴더', 0, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'),
        ('source', 'project', NULL, 'item', 'source_unit', '원문', 1, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');
      INSERT INTO context_items
        (id, project_id, item_kind, scope_kind, scope_id, title, content_md, content_hash, created_at, updated_at)
      VALUES
        ('context', 'project', 'project_brief', 'project', 'project', '프로젝트 문맥', '공통 내용', 'hash', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');
    `);

    applySqlMigration(db, masterSql, "003_project_master_container.sql", 3);
    const nodes = db
      .prepare("SELECT id, parent_node_id, node_role, is_master, title FROM document_nodes ORDER BY ordinal")
      .all() as Array<{
        id: string;
        parent_node_id: string | null;
        node_role: string;
        is_master: number;
        title: string;
      }>;
    const master = nodes.find((node) => node.is_master === 1)!;
    const context = db.prepare("SELECT scope_kind, scope_id FROM context_items WHERE id = 'context'").get() as {
      scope_kind: string;
      scope_id: string;
    };

    expect(master).toMatchObject({ parent_node_id: null, node_role: "container", title: "통합 프로젝트" });
    expect(nodes.filter((node) => node.parent_node_id === null)).toEqual([master]);
    expect(nodes.filter((node) => node.id === "folder" || node.id === "source").every((node) => node.parent_node_id === master.id)).toBe(true);
    expect(context).toEqual({ scope_kind: "document_node", scope_id: master.id });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(() => db.prepare("DELETE FROM document_nodes WHERE id = ?").run(master.id)).toThrow(/master cannot be deleted/);
    expect(() =>
      db.prepare("UPDATE document_nodes SET parent_node_id = 'folder' WHERE id = ?").run(master.id),
    ).toThrow(/project master cannot be moved/);
    expect(() =>
      db.prepare(`
        INSERT INTO context_items
          (id, project_id, item_kind, scope_kind, scope_id, title, content_md, content_hash, created_at, updated_at)
        VALUES
          ('bad-context', 'project', 'note', 'project', 'project', '잘못된 문맥', '내용', 'hash', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')
      `).run(),
    ).toThrow(/context items must belong to a document/);
    db.close();
  });
});

describe("create / open", () => {
  it("creates a project, closes, and reopens the same sqlite with the same projectId/title", () => {
    const parent = tempDir();
    const { handle, summary } = createProject({ title: "테스트 프로젝트", parentDir: parent });
    track(handle);
    expect(summary.title).toBe("테스트 프로젝트");
    expect(summary.storageMode).toBe("local");
    const { projectId, title, packagePath } = handle;
    handle.close();
    const reopened = track(openProject(packagePath));
    expect(reopened.projectId).toBe(projectId);
    expect(reopened.title).toBe(title);
    expect(reopened.getHome().documents[0]?.title).toBe("테스트 프로젝트");
  });

  it("enables foreign_keys on every connection", () => {
    const parent = tempDir();
    const { handle } = createProject({ title: "fk", parentDir: parent });
    track(handle);
    const db = openSqlite(join(handle.packagePath, "project.sqlite3"));
    try {
      expect(Number(db.pragma("foreign_keys", { simple: true }))).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("translation versions", () => {
  it("saves a draft then confirms; editing after confirm creates a new draft without changing confirmed text", () => {
    const repo = track(seedDemoProject(tempDir()));
    const doc = repo.getHome().documents.find((d) => d.originalTitle === "御製序");
    expect(doc).toBeTruthy();
    const id = doc!.id;
    const before = repo.getEditor(id);
    const current = before.candidates.find((c) => c.stage === "literal" && c.isCurrent);
    expect(current).toBeTruthy();
    const saved = repo.saveTranslationDraft({
      documentNodeId: id,
      stage: "literal",
      textContent: current!.textContent,
      blocks: current!.blocks.map((b) => ({
        blockKey: b.blockKey,
        blockKind: b.blockKind,
        translation: b.translation,
        sourceAnchorIds: b.sourceAnchorIds,
      })),
      expectedLockVersion: before.lockVersion,
    });
    const confirmed = repo.confirmTranslation({
      documentNodeId: id,
      stage: "literal",
      expectedLockVersion: saved.lockVersion,
    });
    const confirmedCand = confirmed.candidates.find((c) => c.stage === "literal" && c.isConfirmed);
    expect(confirmedCand?.state).toBe("confirmed");
    const confirmedText = confirmedCand!.textContent;
    const confirmedId = confirmedCand!.versionId;

    const editedBlocks = confirmedCand!.blocks.map((b, i) => ({
      blockKey: b.blockKey,
      blockKind: b.blockKind,
      translation: i === 0 ? `${b.translation} (수정)` : b.translation,
      sourceAnchorIds: b.sourceAnchorIds,
    }));
    const after = repo.saveTranslationDraft({
      documentNodeId: id,
      stage: "literal",
      textContent: editedBlocks.map((b) => b.translation).join(" "),
      blocks: editedBlocks,
      expectedLockVersion: confirmed.lockVersion,
    });
    const still = after.candidates.find((c) => c.versionId === confirmedId);
    expect(still?.textContent).toBe(confirmedText);
    expect(still?.state).toBe("confirmed");
    const newDraft = after.candidates.find((c) => c.stage === "literal" && c.isCurrent);
    expect(newDraft?.versionId).not.toBe(confirmedId);
    expect(newDraft?.state).toBe("draft");
    expect(newDraft?.textContent).toContain("(수정)");
  });

  it("rejects a second save with a stale lock_version", () => {
    const repo = track(seedDemoProject(tempDir()));
    const id = repo.getHome().documents.find((d) => d.originalTitle === "御製序")!.id;
    const editor = repo.getEditor(id);
    const current = editor.candidates.find((c) => c.stage === "literal" && c.isCurrent)!;
    const input = {
      documentNodeId: id,
      stage: "literal",
      textContent: current.textContent,
      blocks: current.blocks.map((b) => ({
        blockKey: b.blockKey,
        blockKind: b.blockKind,
        translation: b.translation,
        sourceAnchorIds: b.sourceAnchorIds,
      })),
      expectedLockVersion: editor.lockVersion,
    };
    repo.saveTranslationDraft(input);
    expect(() => repo.saveTranslationDraft(input)).toThrow(MunhaeError);
    try {
      repo.saveTranslationDraft(input);
    } catch (err) {
      expect((err as MunhaeError).code).toBe("cas_conflict");
    }
  });
});

describe("seed demo", () => {
  it("御製序 editor view has 6 anchors and expected block coverage", () => {
    const repo = track(seedDemoProject(tempDir()));
    const doc = repo.getHome().documents.find((d) => d.originalTitle === "御製序");
    expect(doc).toBeTruthy();
    const editor = repo.getEditor(doc!.id);
    expect(editor.anchors.map((a) => a.anchorKey)).toEqual(["A001", "A002", "A003", "A004", "A005", "A006"]);
    const literal = editor.candidates.find((c) => c.stage === "literal" && c.isCurrent);
    expect(literal?.blocks).toHaveLength(4);
    const covered = new Set(literal!.blocks.flatMap((b) => b.sourceAnchorIds));
    expect([...covered].sort()).toEqual(["A001", "A002", "A003", "A004", "A005", "A006"]);
    const reader = editor.candidates.find((c) => c.stage === "reader" && c.isCurrent);
    expect(reader?.blocks).toHaveLength(2);
  });

  it("merge creates a new version and preserves the previous version", () => {
    const repo = track(seedDemoProject(tempDir()));
    const id = repo.getHome().documents.find((d) => d.originalTitle === "御製序")!.id;
    const before = repo.getEditor(id);
    const current = before.candidates.find((c) => c.stage === "literal" && c.isCurrent)!;
    const prevId = current.versionId;
    const merged = repo.mergeBlocks({
      documentNodeId: id,
      stage: "literal",
      leftBlockKey: "b1",
      rightBlockKey: "b2",
    });
    const next = merged.candidates.find((c) => c.stage === "literal" && c.isCurrent)!;
    expect(next.versionId).not.toBe(prevId);
    expect(next.blocks).toHaveLength(3);
    const preserved = merged.candidates.find((c) => c.versionId === prevId);
    expect(preserved).toBeTruthy();
    expect(preserved!.blocks).toHaveLength(4);
  });

  it("split with a single anchor marks relation_kind partial on both", () => {
    const repo = track(seedDemoProject(tempDir()));
    const id = repo.getHome().documents.find((d) => d.originalTitle === "御製序")!.id;
    const before = repo.getEditor(id);
    const current = before.candidates.find((c) => c.stage === "literal" && c.isCurrent)!;
    const single = current.blocks.find((b) => b.sourceAnchorIds.length === 1);
    expect(single).toBeTruthy();
    const at = Math.max(1, Math.floor(codepointCount(single!.translation) / 2));
    const after = repo.splitBlock({
      documentNodeId: id,
      stage: "literal",
      blockKey: single!.blockKey,
      splitAt: at,
    });
    const next = after.candidates.find((c) => c.stage === "literal" && c.isCurrent)!;
    const parts = next.blocks.filter((b) => b.blockKey.startsWith(single!.blockKey));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const left = next.blocks.find((b) => b.blockKey === `${single!.blockKey}a`);
    const right = next.blocks.find((b) => b.blockKey === `${single!.blockKey}b`);
    expect(left?.relationKinds.every((k) => k === "partial")).toBe(true);
    expect(right?.relationKinds.every((k) => k === "partial")).toBe(true);
    expect(left?.sourceAnchorIds).toEqual(single!.sourceAnchorIds);
    expect(right?.sourceAnchorIds).toEqual(single!.sourceAnchorIds);
  });
});

describe("app db + knowledge", () => {
  it("upserts glossary/person/place and previews context", async () => {
    const { openAppDatabase } = await import("../src/index.ts");
    const repo = track(seedDemoProject(tempDir()));
    const knowledge = repo.getKnowledge();
    expect(knowledge.glossary.some((g) => g.sourceTerm === "文字")).toBe(true);
    expect(knowledge.persons.some((p) => p.preferredName === "世宗")).toBe(true);
    expect(knowledge.places.some((p) => p.preferredName === "中國")).toBe(true);
    const master = repo.getHome().documents.find((document) => document.isMaster)!;
    expect(
      knowledge.contextItems.some(
        (item) => item.title === "창제·반포 배경" && item.scopeKind === "document_node" && item.scopeId === master.id,
      ),
    ).toBe(true);
    expect(knowledge.contextItems.some((item) => item.title === "어제서 번역 지침" && item.scopeKind === "document_node")).toBe(true);
    expect(knowledge.contextItems.some((item) => item.source === "document_description")).toBe(true);
    const id = repo.getHome().documents.find((d) => d.originalTitle === "御製序")!.id;
    const preview = repo.previewContext({ documentNodeId: id, recipe: "two_step" });
    expect(preview.status).toBe("ready");
    expect(preview.characterCount).toBeGreaterThan(0);
    expect(preview.utf8ByteCount).toBeGreaterThan(0);
    expect(preview.required.some((r) => r.kind === "punctuated_source")).toBe(true);
    expect(preview.required.some((r) => r.kind === "output_contract")).toBe(true);
    expect(preview.manifestHash).toMatch(/^[a-f0-9]{64}$/);

    const documentContexts = preview.auxiliary.filter((item) => item.kind === "document_context");
    expect(documentContexts.map((item) => item.reason)).toEqual([
      "current_document_context",
      "ancestor_document_context:1",
    ]);
    const scopedContexts = preview.auxiliary.filter((item) => item.kind === "context_item");
    expect(scopedContexts.map((item) => item.label)).toEqual([
      "어제서 번역 지침",
      "해례본 공통 문체",
      "창제·반포 배경",
    ]);
    expect(scopedContexts.some((item) => item.label === "정인지 서문 전용")).toBe(false);
    expect(repo.getHome().documents.find((document) => document.id === id)?.contextCount).toBe(
      documentContexts.length + scopedContexts.length,
    );
    expect(
      preview.auxiliary
        .filter((item) => item.kind === "uncertainty" && item.reason === "project_uncertainty")
        .every((item) => !item.included),
    ).toBe(true);

    const included = preview.auxiliary.find((item) => item.included);
    expect(included).toBeDefined();
    const excluded = repo.previewContext({
      documentNodeId: id,
      recipe: "two_step",
      selections: [{ id: included!.id, mode: "exclude" }],
    });
    expect(excluded.auxiliary.find((item) => item.id === included!.id)?.included).toBe(false);
    expect(excluded.characterCount).toBeLessThan(preview.characterCount);
    expect(excluded.manifestJson).not.toBe(preview.manifestJson);

    const appDir = tempDir();
    const app = openAppDatabase(appDir);
    app.upsertRecent({
      projectId: repo.projectId,
      displayName: repo.title,
      packagePath: repo.packagePath,
    });
    expect(app.listRecent()[0]?.projectId).toBe(repo.projectId);
    app.setPreference("agentId", "claude");
    expect(app.getPreference("agentId")).toBe("claude");
    app.close();
  });
});

describe("manifest", () => {
  it("has no absolute path", () => {
    const repo = track(seedDemoProject(tempDir()));
    const raw = readFileSync(join(repo.packagePath, "manifest.json"), "utf8");
    expect(raw).not.toMatch(/\/Users\//);
    expect(raw).not.toContain(repo.packagePath);
    const json = JSON.parse(raw) as { database: string; assetRoot: string };
    expect(json.database).toBe("project.sqlite3");
    expect(json.assetRoot).toBe("assets");
  });
});
