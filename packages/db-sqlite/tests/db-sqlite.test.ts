import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codepointCount, MunhaeError, sha256Hex } from "@munhae/domain";
import { importOriginalAsset } from "@munhae/project-format";
import {
  assertSqliteIntegrity,
  createProject,
  openProject,
  openSqlite,
  seedDemoProject,
  type ProjectRepo,
} from "../src/index.ts";
import { validatePackagedReferenceAsset } from "../src/reference-assets.ts";
import { validateBlocks } from "../src/translation.ts";
import { CONTEXT_WITHOUT_KIND_SQL, FULL_TEXT_SQL, PROJECT_INIT_SQL, REVIEW_COMMENTS_SQL } from "../src/embedded-sql.ts";

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

function expectMunhaeCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`expected MunhaeError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(MunhaeError);
    expect((error as MunhaeError).code).toBe(code);
  }
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
  it("creates a child node with source only until punctuation is explicitly created", () => {
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
      originKind: "paste",
      sourceText: "天地玄黃。宇宙洪荒。",
    });
    expect(child.parentId).toBe(root!.id);
    expect(child.nodeRole).toBe("source_unit");
    expect(child.originalTitle).toBe("序");
    expect(child.sourceState).toBe("draft");
    expect(child.punctuationState).toBe("none");
    expect(handle.getHome().progress.total).toBe(1);
    const editor = handle.getEditor(child.id);
    expect(editor.document.title).toBe("서문");
    expect(editor.document).not.toHaveProperty("structuralKind");
    expect(editor.document).not.toHaveProperty("genre");
    expect(handle.getDocumentMetadata(child.id)).not.toHaveProperty("structuralKind");
    expect(handle.getDocumentMetadata(child.id)).not.toHaveProperty("genre");
    expect(editor.source.contentText).toBe("天地玄黃。宇宙洪荒。");
    expect(editor.punctuation).toBeNull();
    expect(editor.anchors).toEqual([]);
  });

  it("creates a structure-only node without source", () => {
    const { handle } = createProject({ title: "구조", parentDir: tempDir() });
    track(handle);
    const chapter = handle.createDocument({
      title: "해례",
      parentId: handle.getHome().documents[0]!.id,
      nodeRole: "container",
    });
    expect(chapter.nodeRole).toBe("container");
    expect(chapter.sourceState).toBe("none");
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
      originKind: "paste",
      sourceText: "天地玄黃。",
    });

    expect(() =>
      handle.createDocument({
        title: "잘못된 하위 폴더",
        parentId: source.id,
        nodeRole: "container",
      }),
    ).toThrow(/원문 문서 아래에는/);
  });

  it("creates role, master, concurrency, and search constraints directly in the baseline", () => {
    const { handle } = createProject({ title: "fresh baseline", parentDir: tempDir() });
    track(handle);
    const db = openSqlite(join(handle.packagePath, "project.sqlite3"));
    try {
      const documentColumns = (db.pragma("table_info(document_nodes)") as Array<{ name: string }>)
        .map((column) => column.name);
      const contextColumns = (db.pragma("table_info(context_items)") as Array<{ name: string }>)
        .map((column) => column.name);
      expect(documentColumns).toEqual(expect.arrayContaining(["node_role", "is_master", "lock_version"]));
      expect(documentColumns).not.toContain("structural_kind");
      expect(documentColumns).not.toContain("genre");
      expect(contextColumns).toContain("lock_version");
      expect(contextColumns).not.toContain("item_kind");
      expect(db.prepare(
        `SELECT name FROM sqlite_master
         WHERE name IN (
           'search_documents_fts',
           'trg_document_nodes_parent_container_insert',
           'trg_document_nodes_master_delete',
           'trg_context_items_document_scope_insert',
           'trg_uncertainty_versions_owner_insert'
         )
         ORDER BY name`,
      ).all()).toEqual([
        { name: "search_documents_fts" },
        { name: "trg_context_items_document_scope_insert" },
        { name: "trg_document_nodes_master_delete" },
        { name: "trg_document_nodes_parent_container_insert" },
        { name: "trg_uncertainty_versions_owner_insert" },
      ]);

      const master = handle.getHome().documents.find((node) => node.isMaster)!;
      expect(() => db.prepare(`
        INSERT INTO document_nodes
          (id, project_id, parent_node_id, node_role, is_master, title, ordinal, created_at, updated_at)
        VALUES
          ('bad-root', ?, NULL, 'container', 0, '잘못된 루트', 1, ?, ?)
      `).run(handle.projectId, handle.openedAt, handle.openedAt)).toThrow(/inside the project master/);
      expect(() => db.prepare(`
        INSERT INTO src_texts (id, project_id, document_node_id, name, created_at)
        VALUES ('bad-source', ?, ?, '잘못된 원문', ?)
      `).run(handle.projectId, master.id, handle.openedAt)).toThrow(/container nodes cannot contain source text/);
      expect(() => db.prepare(`
        INSERT INTO context_items
          (id, project_id, scope_kind, scope_id, title, content_md, content_hash, created_at, updated_at)
        VALUES
          ('bad-context', ?, 'project', ?, '잘못된 문맥', '내용', 'hash', ?, ?)
      `).run(handle.projectId, handle.projectId, handle.openedAt, handle.openedAt))
        .toThrow(/context items must belong to a document/);
    } finally {
      db.close();
    }
  });
});

describe("create / open", () => {
  it("ships the original baseline and a mirrored full-text upgrade", () => {
    const packageMigrations = new URL("../migrations/sqlite/", import.meta.url);
    const infraMigrations = new URL("../../../infra/migrations/sqlite/", import.meta.url);
    expect(readdirSync(packageMigrations).sort()).toEqual(["001_init.sql", "002_full_text_translation.sql", "003_context_without_kind.sql", "004_review_comments.sql"]);
    expect(readdirSync(infraMigrations).sort()).toEqual(["001_init.sql", "002_full_text_translation.sql", "003_context_without_kind.sql", "004_review_comments.sql"]);
    expect(readFileSync(new URL("001_init.sql", packageMigrations)))
      .toEqual(readFileSync(new URL("001_init.sql", infraMigrations)));
    expect(PROJECT_INIT_SQL).toBe(readFileSync(new URL("001_init.sql", packageMigrations), "utf8"));
    for (const [name, embedded] of [["002_full_text_translation.sql", FULL_TEXT_SQL], ["003_context_without_kind.sql", CONTEXT_WITHOUT_KIND_SQL], ["004_review_comments.sql", REVIEW_COMMENTS_SQL]]) {
      const sql = readFileSync(new URL(name!, packageMigrations), "utf8");
      expect(sql).toBe(readFileSync(new URL(name!, infraMigrations), "utf8"));
      expect(embedded).toBe(sql);
    }
  });

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
      expect(() => assertSqliteIntegrity(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("seeds the current schema with one neutral translation policy", () => {
    const { handle } = createProject({ title: "single policy", parentDir: tempDir() });
    track(handle);
    const db = openSqlite(join(handle.packagePath, "project.sqlite3"));
    try {
      expect(db.prepare(
        `SELECT state.schema_version, version.style_guide_md, version.rules_json
         FROM meta_project_state state
         JOIN core_translation_policy_heads head
         JOIN core_translation_policy_versions version ON version.id = head.current_version_id`,
      ).get()).toEqual({
        schema_version: 4,
        style_guide_md: "현재 문서 전체를 빠짐없이 자연스러운 한국어로 번역한다.",
        rules_json: '{"sourceLanguage":"lzh","targetLocale":"ko","audience":"연구자·일반 독자","hanjaPolicy":"중요 용어는 한국어(漢字)로 병기한다.","supplementPolicy":"원문 밖 보충은 별도 표시한다.","uncertaintyPolicy":"textual uncertainty와 interpretive uncertainty를 분리한다."}',
      });
      const policyColumns = (db.pragma("table_info(core_translation_policy_versions)") as Array<{ name: string }>)
        .map((column) => column.name);
      const translationColumns = (db.pragma("table_info(document_translations)") as Array<{ name: string }>)
        .map((column) => column.name);
      const versionColumns = (db.pragma("table_info(document_translation_versions)") as Array<{ name: string }>)
        .map((column) => column.name);
      const userEditColumns = (db.pragma("table_info(user_edits)") as Array<{ name: string }>)
        .map((column) => column.name);
      const agentSessionColumns = (db.pragma("table_info(chat_agent_sessions)") as Array<{ name: string }>)
        .map((column) => column.name);
      expect(policyColumns).not.toContain("workflow_mode");
      expect(policyColumns).not.toContain("reflection_required");
      expect(translationColumns).not.toContain("stage");
      expect(versionColumns).not.toContain("generation_candidate_key");
      expect(versionColumns).not.toContain("workflow_execution_id");
      expect(userEditColumns).not.toContain("workflow_execution_id");
      expect(agentSessionColumns).not.toContain("native_session_id");
      expect(db.prepare(
        "SELECT version, name FROM meta_schema_migrations ORDER BY version",
      ).all()).toEqual([{ version: 1, name: "001_init.sql" }, { version: 2, name: "002_full_text_translation.sql" }, { version: 3, name: "003_context_without_kind.sql" }, { version: 4, name: "004_review_comments.sql" }]);
      expect(db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reflection_%'",
      ).all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a historical migration chain without writing to the project database", () => {
    const { handle } = createProject({ title: "fresh schema only", parentDir: tempDir() });
    const packagePath = handle.packagePath;
    const projectId = handle.projectId;
    const dbPath = join(packagePath, "project.sqlite3");
    handle.close();

    const db = openSqlite(dbPath);
    try {
      db.prepare("UPDATE meta_project_state SET schema_version = 5").run();
      const insertMigration = db.prepare(
        "INSERT INTO meta_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      );
      for (const version of [5]) {
        insertMigration.run(
          version,
          `00${String(version)}_legacy.sql`,
          `legacy-checksum-${String(version)}`,
          "2026-09-04T00:00:00.000Z",
        );
      }
      const sqliteFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
      expect(sqliteFiles.every((path) => existsSync(path))).toBe(true);
      const before = new Map(sqliteFiles.map((path) => [path, readFileSync(path)]));
      const filesBefore = readdirSync(packagePath).sort();

      expectMunhaeCode(() => openProject(packagePath), "unsupported_schema_version");
      expect(() => openProject(packagePath)).toThrow(/새 프로젝트를 만들어 주세요/);
      expect(existsSync(join(packagePath, ".lock"))).toBe(false);
      expect(existsSync(join(packagePath, ".lock.guard"))).toBe(false);
      for (const path of sqliteFiles) {
        expect(readFileSync(path)).toEqual(before.get(path));
      }
      expect(readdirSync(packagePath).sort()).toEqual(filesBefore);

      expect(
        db.prepare("SELECT id FROM core_projects WHERE id = ?").get(projectId),
      ).toEqual({ id: projectId });
      expect(
        db.prepare("SELECT schema_version FROM meta_project_state").get(),
      ).toEqual({ schema_version: 5 });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM meta_schema_migrations").get(),
      ).toEqual({ count: 5 });
    } finally {
      db.close();
    }
  });

  it("rejects a baseline checksum mismatch with the same fresh-project guidance", () => {
    const { handle } = createProject({ title: "checksum mismatch", parentDir: tempDir() });
    const packagePath = handle.packagePath;
    const dbPath = join(packagePath, "project.sqlite3");
    handle.close();
    const db = openSqlite(dbPath);
    try {
      db.prepare("UPDATE meta_schema_migrations SET checksum = ? WHERE version = 1")
        .run("obsolete-baseline");
    } finally {
      db.close();
    }
    const before = readFileSync(dbPath);
    const filesBefore = readdirSync(packagePath).sort();

    expectMunhaeCode(() => openProject(packagePath), "unsupported_schema_version");
    expect(() => openProject(packagePath)).toThrow(/새 프로젝트를 만들어 주세요/);
    expect(readFileSync(dbPath)).toEqual(before);
    expect(readdirSync(packagePath).sort()).toEqual(filesBefore);
    expect(existsSync(join(packagePath, ".lock"))).toBe(false);
    expect(existsSync(join(packagePath, ".lock.guard"))).toBe(false);
  });

  it("rejects a corrupt SQLite schema during open and releases the project lock", () => {
    const parent = tempDir();
    const { handle } = createProject({ title: "무결성", parentDir: parent });
    const packagePath = handle.packagePath;
    handle.close();
    const db = openSqlite(join(packagePath, "project.sqlite3"));
    db.unsafeMode(true);
    db.exec("PRAGMA writable_schema = ON");
    db.prepare("UPDATE sqlite_master SET rootpage = 999999 WHERE name = ?").run("core_projects");
    db.exec("PRAGMA writable_schema = OFF");
    db.close();

    expectMunhaeCode(() => openProject(packagePath), "sqlite_integrity_failed");
    expect(existsSync(join(packagePath, ".lock"))).toBe(false);
    expect(existsSync(join(packagePath, ".lock.guard"))).toBe(false);
  });
});

describe("source and punctuation versions", () => {
  it("saves and confirms append-only source drafts with source-head CAS", () => {
    const { handle } = createProject({ title: "원문 이력", parentDir: tempDir() });
    const repo = track(handle);
    const document = repo.createDocument({
      title: "원문",
      parentId: null,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "天地玄黃",
    });
    const initial = repo.getEditor(document.id);
    const oldSourceId = initial.source.versionId;

    const saved = repo.saveSourceDraft({
      documentNodeId: document.id,
      contentText: "天地🙂玄黃",
      originKind: "manual",
      changeSummary: "이체자 보완",
      expectedLockVersion: initial.source.lockVersion,
    });
    expect(saved.source).toMatchObject({ versionNo: 2, lockVersion: 2, state: "draft", contentText: "天地🙂玄黃" });
    expect(saved.source.versionId).not.toBe(oldSourceId);
    expect(saved.punctuation).toBeNull();
    expect(repo.getHome().documents.find((item) => item.id === document.id)).toMatchObject({
      sourceState: "draft",
      punctuationState: "none",
    });

    expectMunhaeCode(
      () =>
        repo.saveSourceDraft({
          documentNodeId: document.id,
          contentText: "天地玄黃宇宙",
          originKind: "manual",
          expectedLockVersion: initial.source.lockVersion,
        }),
      "cas_conflict",
    );

    const confirmed = repo.confirmSource({
      documentNodeId: document.id,
      expectedLockVersion: saved.source.lockVersion,
    });
    expect(confirmed.source).toMatchObject({ state: "confirmed", lockVersion: 3, contentText: "天地🙂玄黃" });
    expect(repo.getHome().documents.find((item) => item.id === document.id)?.sourceState).toBe("confirmed");

    const db = openSqlite(join(repo.packagePath, "project.sqlite3"));
    try {
      const versions = db
        .prepare(
          `SELECT id, parent_version_id, version_no, content_text, state
           FROM src_text_versions
           WHERE source_text_id = (SELECT id FROM src_texts WHERE document_node_id = ?)
           ORDER BY version_no`,
        )
        .all(document.id) as Array<{
        id: string;
        parent_version_id: string | null;
        version_no: number;
        content_text: string;
        state: string;
      }>;
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({
        id: oldSourceId,
        parent_version_id: null,
        version_no: 1,
        content_text: "天地玄黃",
        state: "superseded",
      });
      expect(versions[1]).toMatchObject({
        parent_version_id: oldSourceId,
        version_no: 2,
        content_text: "天地🙂玄黃",
        state: "confirmed",
      });
    } finally {
      db.close();
    }
  });

  it("validates punctuation against source code points and builds a new deterministic anchor set", () => {
    const { handle } = createProject({ title: "표점 이력", parentDir: tempDir() });
    const repo = track(handle);
    const document = repo.createDocument({
      title: "표점 원문",
      parentId: null,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "甲🙂乙丙",
    });
    const initial = repo.getEditor(document.id);
    const sourceConfirmed = repo.confirmSource({
      documentNodeId: document.id,
      expectedLockVersion: initial.source.lockVersion,
    });
    expect(sourceConfirmed.punctuation).toBeNull();
    expect(sourceConfirmed.anchors).toEqual([]);
    const punctuationCreated = repo.createPunctuationDraftFromConfirmedSource({
      documentNodeId: document.id,
      structureMode: "prose",
      expectedSourceLockVersion: sourceConfirmed.source.lockVersion,
    });
    expect(punctuationCreated.punctuation).toMatchObject({
      versionNo: 1,
      lockVersion: 1,
      state: "draft",
      punctuatedText: "甲🙂乙丙",
      anchorSetId: null,
    });
    expect(punctuationCreated.anchors).toEqual([]);
    const punctuation = punctuationCreated.punctuation!;

    expectMunhaeCode(() => repo.createPunctuationDraftFromConfirmedSource({
      documentNodeId: document.id,
      structureMode: "prose",
      expectedSourceLockVersion: sourceConfirmed.source.lockVersion,
    }), "punctuation_exists");

    expectMunhaeCode(
      () =>
        repo.savePunctuationDraft({
          documentNodeId: document.id,
          punctuatedText: "甲🙂乙丁。",
          structureMode: "prose",
          expectedLockVersion: punctuation.lockVersion,
        }),
      "punctuation_changes_source",
    );
    expectMunhaeCode(
      () =>
        repo.savePunctuationDraft({
          documentNodeId: document.id,
          punctuatedText: "甲🙂乙。",
          structureMode: "prose",
          expectedLockVersion: punctuation.lockVersion,
        }),
      "punctuation_changes_source",
    );

    const saved = repo.savePunctuationDraft({
      documentNodeId: document.id,
      punctuatedText: "甲🙂，乙。丙！",
      structureMode: "prose",
      changeSummary: "문장 경계 확정",
      expectedLockVersion: punctuation.lockVersion,
    });
    expect(saved.punctuation).toMatchObject({ versionNo: 2, lockVersion: 2, state: "draft", structureMode: "prose" });
    expect(saved.punctuation!.anchorSetId).toBeNull();
    expect(saved.anchors).toEqual([]);
    expect(saved.punctuation!.structureSpans.filter((span) => span.spanKind === "sentence")).toHaveLength(2);

    const confirmed = repo.confirmPunctuation({
      documentNodeId: document.id,
      expectedLockVersion: saved.punctuation!.lockVersion,
    });
    expect(confirmed.punctuation).toMatchObject({ state: "confirmed", lockVersion: 3 });
    expect(confirmed.punctuation!.anchorSetId).toBeTruthy();
    expect(confirmed.anchors).toEqual([
      expect.objectContaining({
        anchorKey: "A001",
        punctuationFrom: 0,
        punctuationTo: 5,
        punctuatedQuote: "甲🙂，乙。",
      }),
      expect.objectContaining({
        anchorKey: "A002",
        punctuationFrom: 5,
        punctuationTo: 7,
        punctuatedQuote: "丙！",
      }),
    ]);

    const db = openSqlite(join(repo.packagePath, "project.sqlite3"));
    try {
      const anchors = db
        .prepare(
          `SELECT anchor_key, source_codepoint_from, source_codepoint_to, source_quote
           FROM translation_anchors WHERE anchor_set_id = ? ORDER BY ordinal`,
        )
        .all(confirmed.punctuation!.anchorSetId) as Array<{
        anchor_key: string;
        source_codepoint_from: number;
        source_codepoint_to: number;
        source_quote: string;
      }>;
      expect(anchors).toEqual([
        { anchor_key: "A001", source_codepoint_from: 0, source_codepoint_to: 3, source_quote: "甲🙂乙" },
        { anchor_key: "A002", source_codepoint_from: 3, source_codepoint_to: 4, source_quote: "丙" },
      ]);
    } finally {
      db.close();
    }
  });

  it("starts a new anchorless punctuation draft after a confirmed source changes and preserves history", () => {
    const { handle } = createProject({ title: "원문 재확정", parentDir: tempDir() });
    const repo = track(handle);
    const document = repo.createDocument({
      title: "원문 변경",
      parentId: null,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "天地玄黃宇宙洪荒",
    });
    let editor = repo.getEditor(document.id);
    editor = repo.confirmSource({
      documentNodeId: document.id,
      expectedLockVersion: editor.source.lockVersion,
    });
    editor = repo.createPunctuationDraftFromConfirmedSource({
      documentNodeId: document.id,
      structureMode: "prose",
      expectedSourceLockVersion: editor.source.lockVersion,
    });
    expect(editor.punctuation).not.toBeNull();
    if (!editor.punctuation) throw new Error("expected initial punctuation draft");
    editor = repo.savePunctuationDraft({
      documentNodeId: document.id,
      punctuatedText: "天地玄黃，宇宙洪荒。",
      structureMode: "prose",
      expectedLockVersion: editor.punctuation.lockVersion,
    });
    expect(editor.punctuation).not.toBeNull();
    if (!editor.punctuation) throw new Error("expected saved punctuation draft");
    editor = repo.confirmPunctuation({
      documentNodeId: document.id,
      expectedLockVersion: editor.punctuation.lockVersion,
    });
    expect(editor.punctuation?.anchorSetId).toBeTruthy();
    if (!editor.punctuation?.anchorSetId) throw new Error("expected confirmed punctuation anchors");
    const oldPunctuationVersionId = editor.punctuation.versionId;
    const oldAnchorSetId = editor.punctuation.anchorSetId;
    const oldAnchorCount = editor.anchors.length;
    editor = repo.createTranslationDraft({
      documentNodeId: document.id,
      expectedSourceLockVersion: editor.source.lockVersion,
      expectedPunctuationLockVersion: editor.punctuation.lockVersion,
    });
    const oldTranslationVersionId = editor.translation?.versionId;
    expect(oldTranslationVersionId).toBeTruthy();

    editor = repo.saveSourceDraft({
      documentNodeId: document.id,
      contentText: "天地玄黃日月盈昃",
      originKind: "manual",
      expectedLockVersion: editor.source.lockVersion,
    });
    expect(editor.punctuation?.state).toBe("superseded");
    expect(editor.translation).toMatchObject({ versionId: oldTranslationVersionId, validationState: "needs_review" });
    editor = repo.confirmSource({
      documentNodeId: document.id,
      expectedLockVersion: editor.source.lockVersion,
    });
    const recreated = repo.createPunctuationDraftFromConfirmedSource({
      documentNodeId: document.id,
      structureMode: "prose",
      expectedSourceLockVersion: editor.source.lockVersion,
    });
    expect(recreated.punctuation).not.toBeNull();
    if (!recreated.punctuation) throw new Error("expected punctuation draft for the new source");
    expect(recreated.punctuation).toMatchObject({
      versionNo: 3,
      state: "draft",
      punctuatedText: recreated.source.contentText,
      anchorSetId: null,
    });
    expect(recreated.punctuation.versionId).not.toBe(oldPunctuationVersionId);
    expect(recreated.anchors).toEqual([]);
    expectMunhaeCode(() => repo.createPunctuationDraftFromConfirmedSource({
      documentNodeId: document.id,
      structureMode: "prose",
      expectedSourceLockVersion: recreated.source.lockVersion,
    }), "punctuation_exists");

    const db = openSqlite(join(repo.packagePath, "project.sqlite3"));
    try {
      const history = db.prepare(
        `SELECT version.parent_version_id, version.source_text_version_id,
                (SELECT COUNT(*) FROM punctuation_sets set_count
                 WHERE set_count.source_text_id = punctuation.source_text_id) AS set_count
         FROM punctuation_versions version
         JOIN punctuation_sets punctuation ON punctuation.id = version.punctuation_set_id
         WHERE version.id = ?`,
      ).get(recreated.punctuation.versionId) as {
        parent_version_id: string;
        source_text_version_id: string;
        set_count: number;
      };
      expect(history).toMatchObject({
        parent_version_id: oldPunctuationVersionId,
        source_text_version_id: recreated.source.versionId,
        set_count: 1,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM translation_anchors WHERE anchor_set_id = ?").get(oldAnchorSetId)).toEqual({
        count: oldAnchorCount,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM document_translation_versions WHERE id = ?").get(oldTranslationVersionId)).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
  });

  it("derives and validates verse-line, couplet, and stanza structure", () => {
    const { handle } = createProject({ title: "운문 구조", parentDir: tempDir() });
    const repo = track(handle);
    const sourceText = "床前明月光\n疑是地上霜\n\n舉頭望明月\n低頭思故鄉";
    const document = repo.createDocument({
      title: "정야사",
      parentId: null,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText,
    });
    const initial = repo.getEditor(document.id);
    expect(initial.punctuation).toBeNull();
    expect(initial.anchors).toEqual([]);

    const sourceConfirmed = repo.confirmSource({
      documentNodeId: document.id,
      expectedLockVersion: initial.source.lockVersion,
    });
    const punctuationCreated = repo.createPunctuationDraftFromConfirmedSource({
      documentNodeId: document.id,
      structureMode: "poetry",
      expectedSourceLockVersion: sourceConfirmed.source.lockVersion,
    });
    expect(punctuationCreated.punctuation).not.toBeNull();
    if (!punctuationCreated.punctuation) throw new Error("expected a poetry punctuation draft");
    const poetryDraft = punctuationCreated.punctuation;
    expect(poetryDraft.structureMode).toBe("poetry");
    expect(poetryDraft.anchorSetId).toBeNull();
    expect(punctuationCreated.anchors).toEqual([]);
    expect(poetryDraft.structureSpans.filter((span) => span.spanKind === "verse_line")).toHaveLength(4);
    expect(poetryDraft.structureSpans.filter((span) => span.spanKind === "couplet")).toHaveLength(2);
    expect(poetryDraft.structureSpans.filter((span) => span.spanKind === "stanza")).toHaveLength(2);
    expectMunhaeCode(
      () =>
        repo.savePunctuationDraft({
          documentNodeId: document.id,
          punctuatedText: sourceText,
          structureMode: "poetry",
          structureSpans: [
            {
              spanKey: "stanza",
              spanKind: "stanza",
              parentSpanKey: "couplet",
              ordinal: 1,
              codepointFrom: 0,
              codepointTo: codepointCount(sourceText),
            },
            {
              spanKey: "couplet",
              spanKind: "couplet",
              parentSpanKey: "stanza",
              ordinal: 1,
              codepointFrom: 0,
              codepointTo: codepointCount(sourceText),
            },
            {
              spanKey: "line",
              spanKind: "verse_line",
              parentSpanKey: "couplet",
              ordinal: 1,
              codepointFrom: 0,
              codepointTo: codepointCount(sourceText),
            },
          ],
          expectedLockVersion: poetryDraft.lockVersion,
        }),
      "invalid_structure",
    );

    const confirmed = repo.confirmPunctuation({
      documentNodeId: document.id,
      expectedLockVersion: poetryDraft.lockVersion,
    });
    expect(confirmed.punctuation).not.toBeNull();
    expect(confirmed.punctuation?.state).toBe("confirmed");
    expect(confirmed.punctuation?.anchorSetId).toBeTruthy();
    expect(confirmed.anchors).toHaveLength(4);
    expect(confirmed.anchors.every((anchor) => anchor.boundaryKind === "verse_line")).toBe(true);
  });

  it("preserves old translations and records unresolved staleness after punctuation changes", () => {
    const { handle } = createProject({ title: "stale dependency", parentDir: tempDir() });
    const repo = track(handle);
    const document = repo.createDocument({
      title: "두 문장",
      parentId: null,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "天地玄黃宇宙洪荒",
    });
    let before = repo.getEditor(document.id);
    before = repo.confirmSource({
      documentNodeId: document.id,
      expectedLockVersion: before.source.lockVersion,
    });
    before = repo.createPunctuationDraftFromConfirmedSource({
      documentNodeId: document.id,
      structureMode: "prose",
      expectedSourceLockVersion: before.source.lockVersion,
    });
    before = repo.savePunctuationDraft({
      documentNodeId: document.id,
      punctuatedText: "天地玄黃。宇宙洪荒。",
      structureMode: "prose",
      expectedLockVersion: before.punctuation!.lockVersion,
    });
    before = repo.confirmPunctuation({
      documentNodeId: document.id,
      expectedLockVersion: before.punctuation!.lockVersion,
    });
    before = repo.createTranslationDraft({
      documentNodeId: document.id,
      expectedSourceLockVersion: before.source.lockVersion,
      expectedPunctuationLockVersion: before.punctuation!.lockVersion,
    });
    const completedBlocks = before.translation!.blocks.map((block, index) => ({
      ...block,
      translation: `번역 ${index + 1}`,
    }));
    before = repo.saveTranslationDraft({
      documentNodeId: document.id,
      textContent: completedBlocks.map((block) => block.translation).join(" "),
      blocks: completedBlocks,
      expectedLockVersion: before.translation!.lockVersion,
    });
    const translation = before.translation!;
    const oldAnchorKeys = before.anchors.map((anchor) => anchor.anchorKey);
    expect(oldAnchorKeys).toEqual(["A001", "A002"]);
    expect(before.punctuation).not.toBeNull();
    if (!before.punctuation) throw new Error("seed fixture requires punctuation");
    const beforePunctuation = before.punctuation;

    const saved = repo.savePunctuationDraft({
      documentNodeId: document.id,
      punctuatedText: "天地玄黃。宇宙，洪荒。",
      structureMode: beforePunctuation.structureMode,
      expectedLockVersion: beforePunctuation.lockVersion,
    });
    expect(saved.punctuation).not.toBeNull();
    if (!saved.punctuation) throw new Error("expected saved punctuation draft");
    expect(saved.punctuation.anchorSetId).toBeNull();
    expect(saved.anchors).toEqual([]);
    expect(saved.translation).toMatchObject({ versionId: translation.versionId, validationState: "needs_review" });
    expect(repo.getHome().documents.find((item) => item.id === document.id)?.translationState).toBe("review");

    const confirmed = repo.confirmPunctuation({
      documentNodeId: document.id,
      expectedLockVersion: saved.punctuation.lockVersion,
    });
    expect(confirmed.punctuation).not.toBeNull();
    if (!confirmed.punctuation) throw new Error("expected confirmed punctuation");
    expect(confirmed.punctuation.anchorSetId).toBeTruthy();
    expect(confirmed.punctuation.anchorSetId).not.toBe(beforePunctuation.anchorSetId);
    // Deterministic keys can be reused by a newly confirmed punctuation version;
    // dependency IDs, not key names or counts, define whether a translation is current.
    expect(confirmed.anchors.map((anchor) => anchor.anchorKey)).toEqual(oldAnchorKeys);
    expectMunhaeCode(
      () =>
        repo.confirmTranslation({
          documentNodeId: document.id,
          expectedLockVersion: translation.lockVersion,
        }),
      "stale_translation",
    );
    expectMunhaeCode(
      () => repo.saveTranslationDraft({
        documentNodeId: document.id,
        textContent: translation.textContent,
        blocks: translation.blocks,
        expectedLockVersion: translation.lockVersion,
      }),
      "stale_translation",
    );
    expectMunhaeCode(
      () => repo.reviseTranslation({
        documentNodeId: document.id,
        expectedLockVersion: translation.lockVersion,
      }),
      "stale_translation",
    );
    expectMunhaeCode(
      () => repo.mergeBlocks({
        documentNodeId: document.id,
        leftBlockKey: translation.blocks[0]!.blockKey,
        rightBlockKey: translation.blocks[1]!.blockKey,
        expectedLockVersion: translation.lockVersion,
      }),
      "stale_translation",
    );
    const splittable = translation.blocks.find((block) => codepointCount(block.translation) > 1)!;
    expectMunhaeCode(
      () => repo.splitBlock({
        documentNodeId: document.id,
        blockKey: splittable.blockKey,
        splitAt: 1,
        expectedLockVersion: translation.lockVersion,
      }),
      "stale_translation",
    );

    expectMunhaeCode(
      () => repo.resetTranslationDraft({
        documentNodeId: document.id,
        expectedSourceLockVersion: confirmed.source.lockVersion,
        expectedPunctuationLockVersion: confirmed.punctuation!.lockVersion,
        expectedTranslationLockVersion: translation.lockVersion + 1,
      }),
      "cas_conflict",
    );
    const reset = repo.resetTranslationDraft({
      documentNodeId: document.id,
      expectedSourceLockVersion: confirmed.source.lockVersion,
      expectedPunctuationLockVersion: confirmed.punctuation!.lockVersion,
      expectedTranslationLockVersion: translation.lockVersion,
    });
    expect(reset.translation).toMatchObject({
      isCurrentDependencies: true,
      state: "draft",
      validationState: "needs_review",
      lockVersion: translation.lockVersion + 1,
    });
    expect(reset.translation?.blocks.map((block) => block.translation)).toEqual(
      reset.anchors.map(() => ""),
    );
    expect(reset.translation?.versionId).not.toBe(translation.versionId);

    const db = openSqlite(join(repo.packagePath, "project.sqlite3"));
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM translation_staleness
           WHERE new_dependency_id = ? AND resolved_by_document_translation_version_id IS NULL`,
        )
        .get(confirmed.punctuation.versionId) as { count: number };
      expect(row.count).toBe(0);
      const historical = db.prepare(
        "SELECT COUNT(*) AS count FROM translation_staleness WHERE new_dependency_id = ?",
      ).get(confirmed.punctuation.versionId) as { count: number };
      expect(historical.count).toBeGreaterThan(0);
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM document_translation_versions WHERE id = ?",
      ).get(translation.versionId)).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});

describe("translation versions", () => {
  it("treats coverage as AI/user judgment while retaining block-local structural checks", () => {
    const anchors = [
      { id: "anchor-1", anchor_key: "A001", ordinal: 1, required: 1, boundary_kind: "sentence" },
      { id: "anchor-2", anchor_key: "A002", ordinal: 2, required: 1, boundary_kind: "sentence" },
    ];
    expect(validateBlocks([
      { blockKey: "b1", blockKind: "paragraph", translation: "첫 블록", sourceAnchorIds: ["A001"] },
      { blockKey: "b2", blockKind: "paragraph", translation: "둘째 블록", sourceAnchorIds: ["A001"] },
    ], anchors)).toEqual({ findings: [], validationState: "valid" });
    expect(validateBlocks([
      { blockKey: "b1", blockKind: "paragraph", translation: "번역", sourceAnchorIds: [] },
    ], anchors)).toMatchObject({ findings: ["empty_block"], validationState: "needs_review" });
    expect(validateBlocks([
      { blockKey: "b1", blockKind: "paragraph", translation: "번역", sourceAnchorIds: ["A001", "A001"] },
    ], anchors)).toMatchObject({ findings: ["duplicate_anchor"], validationState: "needs_review" });
  });

  it("creates the first human draft only from confirmed source and punctuation with CAS", () => {
    const { handle } = createProject({ title: "사람 번역", parentDir: tempDir() });
    const repo = track(handle);
    const document = repo.createDocument({
      title: "서문",
      originalTitle: "序",
      parentId: null,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "天地玄黃。宇宙洪荒。",
    });
    let editor = repo.getEditor(document.id);
    editor = repo.confirmSource({
      documentNodeId: document.id,
      expectedLockVersion: editor.source.lockVersion,
    });
    editor = repo.createPunctuationDraftFromConfirmedSource({
      documentNodeId: document.id,
      structureMode: "prose",
      expectedSourceLockVersion: editor.source.lockVersion,
    });
    expect(editor.punctuation).not.toBeNull();
    if (!editor.punctuation) throw new Error("expected punctuation draft");
    editor = repo.confirmPunctuation({
      documentNodeId: document.id,
      expectedLockVersion: editor.punctuation.lockVersion,
    });
    expect(editor.punctuation).not.toBeNull();
    if (!editor.punctuation) throw new Error("expected confirmed punctuation");
    const confirmedPunctuation = editor.punctuation;
    expect(confirmedPunctuation.anchorSetId).toBeTruthy();
    expect(editor.translation).toBeNull();

    expectMunhaeCode(
      () => repo.createTranslationDraft({
        documentNodeId: document.id,
        expectedSourceLockVersion: editor.source.lockVersion - 1,
        expectedPunctuationLockVersion: confirmedPunctuation.lockVersion,
      }),
      "cas_conflict",
    );

    const created = repo.createTranslationDraft({
      documentNodeId: document.id,
      expectedSourceLockVersion: editor.source.lockVersion,
      expectedPunctuationLockVersion: confirmedPunctuation.lockVersion,
    });
    const draft = created.translation;
    expect(draft).toMatchObject({
      versionNo: 1,
      state: "draft",
      validationState: "needs_review",
      originKind: "human",
      lockVersion: 1,
    });
    expect(draft?.blocks.map((block) => block.blockKey)).toEqual(["B001", "B002"]);
    expect(draft?.blocks.map((block) => block.sourceAnchorIds)).toEqual([["A001"], ["A002"]]);
    expect(repo.getHome().documents.find((item) => item.id === document.id)?.translationState).toBe("review");
    expectMunhaeCode(
      () => repo.createTranslationDraft({
        documentNodeId: document.id,
        expectedSourceLockVersion: editor.source.lockVersion,
        expectedPunctuationLockVersion: confirmedPunctuation.lockVersion,
      }),
      "already_exists",
    );

    const container = repo.getHome().documents.find((item) => item.isMaster)!;
    expectMunhaeCode(
      () => repo.createTranslationDraft({
        documentNodeId: container.id,
        expectedSourceLockVersion: 1,
        expectedPunctuationLockVersion: 1,
      }),
      "not_ready",
    );
  });

  it("saves a draft then confirms; editing after confirm creates a new draft without changing confirmed text", () => {
    const repo = track(seedDemoProject(tempDir()));
    const doc = repo.getHome().documents.find((d) => d.originalTitle === "御製序");
    expect(doc).toBeTruthy();
    const id = doc!.id;
    const before = repo.getEditor(id);
    const current = before.translation;
    expect(current).toBeTruthy();
    const saved = repo.saveTranslationDraft({
      documentNodeId: id,
      textContent: current!.textContent,
      blocks: current!.blocks.map((b) => ({
        blockKey: b.blockKey,
        blockKind: b.blockKind,
        translation: b.translation,
        sourceAnchorIds: b.sourceAnchorIds,
      })),
      expectedLockVersion: current!.lockVersion,
    });
    const savedCurrent = saved.translation!;
    const confirmed = repo.confirmTranslation({
      documentNodeId: id,
      expectedLockVersion: savedCurrent.lockVersion,
    });
    const confirmedCand = confirmed.translation;
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
      textContent: editedBlocks.map((b) => b.translation).join(" "),
      blocks: editedBlocks,
      expectedLockVersion: confirmedCand!.lockVersion,
    });
    const confirmedHistory = repo.getDocumentHistory(id).entries.find((entry) => entry.versionId === confirmedId);
    expect(confirmedHistory?.contentText).toBe(confirmedText);
    expect(confirmedHistory?.state).toBe("confirmed");
    const newDraft = after.translation;
    expect(newDraft?.versionId).not.toBe(confirmedId);
    expect(newDraft?.state).toBe("draft");
    expect(newDraft?.textContent).toContain("(수정)");
  });

  it("rejects a second save with a stale lock_version", () => {
    const repo = track(seedDemoProject(tempDir()));
    const id = repo.getHome().documents.find((d) => d.originalTitle === "御製序")!.id;
    const editor = repo.getEditor(id);
    const current = editor.translation!;
    const input = {
      documentNodeId: id,
      textContent: current.textContent,
      blocks: current.blocks.map((b) => ({
        blockKey: b.blockKey,
        blockKind: b.blockKind,
        translation: b.translation,
        sourceAnchorIds: b.sourceAnchorIds,
      })),
      expectedLockVersion: current.lockVersion,
    };
    repo.saveTranslationDraft(input);
    expect(() => repo.saveTranslationDraft(input)).toThrow(MunhaeError);
    try {
      repo.saveTranslationDraft(input);
    } catch (err) {
      expect((err as MunhaeError).code).toBe("cas_conflict");
    }
  });

  it("requires caller-provided CAS when revising the single translation", () => {
    const repo = track(seedDemoProject(tempDir()));
    const id = repo.getHome().documents.find((item) => item.originalTitle === "御製序")!.id;
    const before = repo.getEditor(id);
    const translation = before.translation!;
    const revised = repo.reviseTranslation({
      documentNodeId: id,
      expectedLockVersion: translation.lockVersion,
    });
    expect(revised.translation?.lockVersion).toBe(translation.lockVersion + 1);
    expect(revised.translation?.versionId).not.toBe(translation.versionId);
    expectMunhaeCode(
      () => repo.reviseTranslation({ documentNodeId: id, expectedLockVersion: translation.lockVersion }),
      "cas_conflict",
    );
  });

  it("allows a user-reviewed draft to reorder and non-contiguously group complete anchor coverage", () => {
    const repo = track(seedDemoProject(tempDir()));
    const id = repo.getHome().documents.find((item) => item.originalTitle === "御製序")!.id;
    const before = repo.getEditor(id);
    const current = before.translation!;
    const anchorKeys = before.anchors.map((anchor) => anchor.anchorKey);
    expect(anchorKeys).toEqual(["A001", "A002", "A003", "A004", "A005", "A006"]);
    const blocks = [
      {
        blockKey: "reviewed-1",
        blockKind: "paragraph",
        translation: "첫 번째 자연스러운 번역 블록",
        sourceAnchorIds: [anchorKeys[5]!, anchorKeys[0]!],
      },
      {
        blockKey: "reviewed-2",
        blockKind: "paragraph",
        translation: "두 번째 자연스러운 번역 블록",
        sourceAnchorIds: [anchorKeys[2]!, anchorKeys[4]!],
      },
      {
        blockKey: "reviewed-3",
        blockKind: "paragraph",
        translation: "세 번째 자연스러운 번역 블록",
        sourceAnchorIds: [anchorKeys[1]!, anchorKeys[3]!],
      },
    ];

    const saved = repo.saveTranslationDraft({
      documentNodeId: id,
      textContent: blocks.map((block) => block.translation).join(" "),
      blocks,
      expectedLockVersion: current.lockVersion,
    });

    expect(saved.translation?.validationState).toBe("valid");
    expect(saved.translation?.blocks.map((block) => block.sourceAnchorIds)).toEqual(
      blocks.map((block) => block.sourceAnchorIds),
    );
    const confirmed = repo.confirmTranslation({
      documentNodeId: id,
      expectedLockVersion: saved.translation!.lockVersion,
    });
    expect(confirmed.translation).toMatchObject({ state: "confirmed", validationState: "valid" });
  });

  it("allows user review to confirm omitted and cross-block reused anchor mappings", () => {
    const repo = track(seedDemoProject(tempDir()));
    const id = repo.getHome().documents.find((item) => item.originalTitle === "御製序")!.id;
    const before = repo.getEditor(id);
    const current = before.translation!;
    const anchorKeys = before.anchors.map((anchor) => anchor.anchorKey);
    const blocks = [
      {
        blockKey: "reviewed-flex-1",
        blockKind: "paragraph",
        translation: "첫 번째 번역 블록",
        sourceAnchorIds: [anchorKeys[0]!],
      },
      {
        blockKey: "reviewed-flex-2",
        blockKind: "paragraph",
        translation: "두 번째 번역 블록",
        sourceAnchorIds: [anchorKeys[2]!],
      },
      {
        blockKey: "reviewed-flex-3",
        blockKind: "paragraph",
        translation: "세 번째 번역 블록",
        sourceAnchorIds: [anchorKeys[0]!],
      },
    ];

    const saved = repo.saveTranslationDraft({
      documentNodeId: id,
      textContent: blocks.map((block) => block.translation).join(" "),
      blocks,
      expectedLockVersion: current.lockVersion,
    });

    expect(saved.translation?.validationState).toBe("valid");
    expect(saved.translation?.blocks.map((block) => block.sourceAnchorIds)).toEqual(
      blocks.map((block) => block.sourceAnchorIds),
    );
    expect(saved.translation?.blocks.map((block) => block.relationKinds)).toEqual([
      ["partial"],
      ["full"],
      ["partial"],
    ]);
    expect(saved.translation?.blocks.flatMap((block) => block.sourceAnchorIds)).not.toContain(anchorKeys[1]);

    const confirmed = repo.confirmTranslation({
      documentNodeId: id,
      expectedLockVersion: saved.translation!.lockVersion,
    });
    expect(confirmed.translation).toMatchObject({ state: "confirmed", validationState: "valid" });
  });
});

describe("seed demo", () => {
  it("御製序 editor view has 6 anchors and expected block coverage", () => {
    const repo = track(seedDemoProject(tempDir()));
    const doc = repo.getHome().documents.find((d) => d.originalTitle === "御製序");
    expect(doc).toBeTruthy();
    const editor = repo.getEditor(doc!.id);
    expect(editor.anchors.map((a) => a.anchorKey)).toEqual(["A001", "A002", "A003", "A004", "A005", "A006"]);
    const translation = editor.translation;
    expect(translation?.blocks).toHaveLength(4);
    const covered = new Set(translation!.blocks.flatMap((b) => b.sourceAnchorIds));
    expect([...covered].sort()).toEqual(["A001", "A002", "A003", "A004", "A005", "A006"]);
    const db = openSqlite(join(repo.packagePath, "project.sqlite3"));
    try {
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM document_translations WHERE document_node_id = ?",
      ).get(doc!.id)).toEqual({ count: 1 });
      expect(db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reflection_%'",
      ).all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("merge creates a new version and preserves the previous version", () => {
    const repo = track(seedDemoProject(tempDir()));
    const id = repo.getHome().documents.find((d) => d.originalTitle === "御製序")!.id;
    const before = repo.getEditor(id);
    const current = before.translation!;
    const prevId = current.versionId;
    const merged = repo.mergeBlocks({
      documentNodeId: id,
      leftBlockKey: "b1",
      rightBlockKey: "b2",
      expectedLockVersion: current.lockVersion,
    });
    const next = merged.translation!;
    expect(next.versionId).not.toBe(prevId);
    expect(next.blocks).toHaveLength(3);
    const preserved = repo.getDocumentHistory(id).entries.find((entry) => entry.versionId === prevId);
    expect(preserved).toBeTruthy();
    expect(preserved!.blocks).toHaveLength(4);
  });

  it("requires an explicit current translation lock for save, merge, and split", () => {
    const repo = track(seedDemoProject(tempDir()));
    const id = repo.getHome().documents.find((d) => d.originalTitle === "御製序")!.id;
    const before = repo.getEditor(id);
    const original = before.translation!;
    const saved = repo.saveTranslationDraft({
      documentNodeId: id,
      textContent: original.textContent,
      blocks: original.blocks,
      expectedLockVersion: original.lockVersion,
    });
    const current = saved.translation!;
    expect(current.lockVersion).toBe(original.lockVersion + 1);

    expectMunhaeCode(
      () => repo.saveTranslationDraft({
        documentNodeId: id,
        textContent: current.textContent,
        blocks: current.blocks,
        expectedLockVersion: original.lockVersion,
      }),
      "cas_conflict",
    );
    expectMunhaeCode(
      () => repo.mergeBlocks({
        documentNodeId: id,
        leftBlockKey: current.blocks[0]!.blockKey,
        rightBlockKey: current.blocks[1]!.blockKey,
        expectedLockVersion: original.lockVersion,
      }),
      "cas_conflict",
    );
    const splittable = current.blocks.find((block) => codepointCount(block.translation) > 1)!;
    expectMunhaeCode(
      () => repo.splitBlock({
        documentNodeId: id,
        blockKey: splittable.blockKey,
        splitAt: 1,
        expectedLockVersion: original.lockVersion,
      }),
      "cas_conflict",
    );
    expectMunhaeCode(
      () => repo.saveTranslationDraft({
        documentNodeId: id,
        textContent: current.textContent,
        blocks: current.blocks,
        expectedLockVersion: 0,
      }),
      "invalid_input",
    );
    expect(repo.getEditor(id).translation?.versionId).toBe(current.versionId);
  });

  it("split with a single anchor marks relation_kind partial on both", () => {
    const repo = track(seedDemoProject(tempDir()));
    const id = repo.getHome().documents.find((d) => d.originalTitle === "御製序")!.id;
    const before = repo.getEditor(id);
    const current = before.translation!;
    const single = current.blocks.find((b) => b.sourceAnchorIds.length === 1);
    expect(single).toBeTruthy();
    const at = Math.max(1, Math.floor(codepointCount(single!.translation) / 2));
    const after = repo.splitBlock({
      documentNodeId: id,
      blockKey: single!.blockKey,
      splitAt: at,
      expectedLockVersion: current.lockVersion,
    });
    const next = after.translation!;
    const parts = next.blocks.filter((b) => b.blockKey.startsWith(single!.blockKey));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const left = next.blocks.find((b) => b.blockKey === `${single!.blockKey}a`);
    const right = next.blocks.find((b) => b.blockKey === `${single!.blockKey}b`);
    expect(left?.relationKinds.every((k) => k === "partial")).toBe(true);
    expect(right?.relationKinds.every((k) => k === "partial")).toBe(true);
    expect(left?.sourceAnchorIds).toEqual(single!.sourceAnchorIds);
    expect(right?.sourceAnchorIds).toEqual(single!.sourceAnchorIds);

    const resaved = repo.saveTranslationDraft({
      documentNodeId: id,
      textContent: next.blocks.map((block) => block.translation).join(" "),
      blocks: next.blocks.map((block) => ({
        blockKey: block.blockKey,
        blockKind: block.blockKind,
        translation: block.translation,
        sourceAnchorIds: [...block.sourceAnchorIds],
        relationKinds: [...block.relationKinds],
      })),
      expectedLockVersion: next.lockVersion,
    });
    const roundTripped = resaved.translation!;
    expect(roundTripped.validationState).toBe("valid");
    expect(roundTripped.blocks.find((b) => b.blockKey === `${single!.blockKey}a`)?.relationKinds).toEqual(["partial"]);
    expect(roundTripped.blocks.find((b) => b.blockKey === `${single!.blockKey}b`)?.relationKinds).toEqual(["partial"]);
  });

  it("splits Unicode text and multi-anchor ownership at explicit boundaries", () => {
    const repo = track(seedDemoProject(tempDir()));
    const id = repo.getHome().documents.find((item) => item.originalTitle === "御製序")!.id;
    const before = repo.getEditor(id);
    const current = before.translation!;
    const multi = current.blocks.find((block) => block.sourceAnchorIds.length > 1)!;
    const changedBlocks = current.blocks.map((block) => ({
      ...block,
      translation: block.blockKey === multi.blockKey ? `🙂${block.translation}` : block.translation,
    }));
    const saved = repo.saveTranslationDraft({
      documentNodeId: id,
      textContent: changedBlocks.map((block) => block.translation).join(" "),
      blocks: changedBlocks,
      expectedLockVersion: current.lockVersion,
    });
    const savedCurrent = saved.translation!;
    expectMunhaeCode(
      () =>
        repo.splitBlock({
          documentNodeId: id,
          blockKey: multi.blockKey,
          splitAt: 1,
          anchorSplitAt: multi.sourceAnchorIds.length,
          expectedLockVersion: savedCurrent.lockVersion,
        }),
      "invalid_anchor_split",
    );

    const split = repo.splitBlock({
      documentNodeId: id,
      blockKey: multi.blockKey,
      splitAt: 1,
      anchorSplitAt: 1,
      expectedLockVersion: savedCurrent.lockVersion,
    });
    const next = split.translation!;
    expect(next.blocks.find((block) => block.blockKey === `${multi.blockKey}a`)).toMatchObject({
      translation: "🙂",
      sourceAnchorIds: multi.sourceAnchorIds.slice(0, 1),
    });
    expect(next.blocks.find((block) => block.blockKey === `${multi.blockKey}b`)).toMatchObject({
      translation: multi.translation,
      sourceAnchorIds: multi.sourceAnchorIds.slice(1),
    });
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
    const preview = repo.previewLegacyContext({ documentNodeId: id });
    const metadata = JSON.parse(preview.auxiliary.find((item) => item.kind === "document_metadata")!.content);
    expect(metadata).not.toHaveProperty("structuralKind");
    expect(metadata).not.toHaveProperty("genre");
    expect(preview.status).toBe("ready");
    expect(preview.characterCount).toBeGreaterThan(0);
    expect(preview.utf8ByteCount).toBeGreaterThan(0);
    expect(preview.required.some((r) => r.kind === "punctuated_source")).toBe(true);
    expect(preview.required.some((r) => r.kind === "output_contract")).toBe(true);
    expect(preview.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.manifestHash).toBe(sha256Hex(preview.manifestJson));
    expect(preview.requestHash).toBe(sha256Hex(preview.requestText));
    expect(preview.characterCount).toBe(codepointCount(preview.requestText));
    expect(preview.utf8ByteCount).toBe(Buffer.byteLength(preview.requestText, "utf8"));
    for (const item of [...preview.required, ...preview.auxiliary]) {
      expect(item.hash).toBe(sha256Hex(item.content));
      expect(item.chars).toBe(codepointCount(item.content));
    }
    expect(preview.required.find((item) => item.kind === "punctuated_source")?.content).toBe(
      repo.getEditor(id).punctuation?.punctuatedText,
    );
    expect(() => JSON.parse(preview.required.find((item) => item.kind === "anchor_manifest")!.content)).not.toThrow();
    expect(() => JSON.parse(preview.required.find((item) => item.kind === "translation_policy")!.content)).not.toThrow();
    expect(() => JSON.parse(preview.required.find((item) => item.kind === "output_contract")!.content)).not.toThrow();

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
    const confirmedExamples = preview.auxiliary.filter((item) => item.kind === "confirmed_translation");
    expect(confirmedExamples.length).toBeGreaterThan(0);
    expect(confirmedExamples.every((item) => item.reason === "project_confirmed_translation")).toBe(true);
    expect(confirmedExamples.every((item) => !item.included)).toBe(true);
    const pinnedConfirmed = repo.previewLegacyContext({
      documentNodeId: id,
      selections: [{ id: confirmedExamples[0]!.id, mode: "pin" }],
    });
    expect(pinnedConfirmed.auxiliary.find((item) => item.id === confirmedExamples[0]!.id)?.included).toBe(true);
    expect(pinnedConfirmed.requestText).toContain('"translation"');
    expect(pinnedConfirmed.requestHash).not.toBe(preview.requestHash);
    expect(pinnedConfirmed.requestText).not.toBe(preview.requestText);

    const included = preview.auxiliary.find((item) => item.included);
    expect(included).toBeDefined();
    const excluded = repo.previewLegacyContext({
      documentNodeId: id,
      selections: [{ id: included!.id, mode: "exclude" }],
    });
    expect(excluded.auxiliary.find((item) => item.id === included!.id)?.included).toBe(false);
    expect(excluded.auxiliary.find((item) => item.id === included!.id)?.content).toBe(included!.content);
    expect(excluded.characterCount).toBeLessThan(preview.characterCount);
    expect(excluded.requestHash).not.toBe(preview.requestHash);
    expect(excluded.requestText).not.toBe(preview.requestText);
    expect(excluded.requestText).not.toContain(`id=${included!.id};`);
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

  it.skipIf(process.platform === "win32")("refuses to open a project.sqlite3 symlink outside the package", () => {
    const repo = track(seedDemoProject(tempDir()));
    const packagePath = repo.packagePath;
    const packagedDatabase = join(packagePath, "project.sqlite3");
    const outsideDatabase = join(packagePath, "..", "outside-project.sqlite3");
    repo.close();
    renameSync(packagedDatabase, outsideDatabase);
    const before = readFileSync(outsideDatabase);
    symlinkSync(outsideDatabase, packagedDatabase);

    expectMunhaeCode(() => openProject(packagePath), "invalid_asset_path");
    expect(readFileSync(outsideDatabase)).toEqual(before);
  });
});

describe("reference assets", () => {
  it("revalidates copied bytes and removes a raced invalid package file before DB insertion", () => {
    const parent = tempDir();
    const { handle } = createProject({ title: "참고 자료 복사 검증", parentDir: parent });
    const repo = track(handle);
    const source = join(parent, "교체될-원본.png");
    const validPng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("copy-race-fixture"),
    ]);
    writeFileSync(source, validPng);
    const imported = importOriginalAsset({ packagePath: repo.packagePath, sourcePath: source });
    const copiedPath = join(repo.packagePath, imported.relativePath);

    // Model the external-file selection/copy race at the exact post-copy
    // boundary: even a same-size payload with a valid PNG signature must still
    // match the hash calculated for the bytes that were imported.
    const differentValidPng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(validPng.byteLength - 8, 0x41),
    ]);
    writeFileSync(copiedPath, differentValidPng);
    expectMunhaeCode(
      () => validatePackagedReferenceAsset(repo.packagePath, imported, {
        mimeType: "image/png",
        byteSize: validPng.byteLength,
      }),
      "invalid_asset",
    );
    expect(existsSync(copiedPath)).toBe(false);
    const db = openSqlite(join(repo.packagePath, "project.sqlite3"));
    try {
      expect((db.prepare("SELECT COUNT(*) AS n FROM src_assets").get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM src_asset_locations").get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM src_node_assets").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rolls back asset rows and removes an unreferenced copy when attachment fails", () => {
    const parent = tempDir();
    const { handle } = createProject({ title: "참고 자료 실패 정리", parentDir: parent });
    const repo = track(handle);
    const document = repo.createDocument({
      title: "원문",
      parentId: null,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "天地。",
    });
    const source = join(parent, "실패.png");
    writeFileSync(source, Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("transaction-failure-fixture"),
    ]));

    const ledger = openSqlite(join(repo.packagePath, "project.sqlite3"));
    ledger.exec(`
      CREATE TRIGGER fail_reference_link
      BEFORE INSERT ON src_node_assets
      BEGIN
        SELECT RAISE(ABORT, 'forced reference link failure');
      END;
    `);
    ledger.close();

    expect(() => repo.attachReferenceAsset(document.id, source)).toThrow(/forced reference link failure/);
    const db = openSqlite(join(repo.packagePath, "project.sqlite3"));
    try {
      expect((db.prepare("SELECT COUNT(*) AS n FROM src_assets").get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM src_asset_locations").get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM src_node_assets").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
    expect(readdirSync(join(repo.packagePath, "assets", "originals"))).toEqual([]);
  });

  it("records a portable image, verifies its hash, and scopes reads to the linked document", () => {
    const parent = tempDir();
    const { handle } = createProject({ title: "참고 자료", parentDir: parent });
    const repo = track(handle);
    const root = repo.getHome().documents.find((item) => item.isMaster)!;
    const document = repo.createDocument({
      title: "원문",
      parentId: root.id,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "天地。",
    });
    const other = repo.createDocument({
      title: "다른 원문",
      parentId: root.id,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "玄黃。",
    });
    const source = join(parent, "원본.png");
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("portable-reference"),
    ]);
    writeFileSync(source, png);

    const attached = repo.attachReferenceAsset(document.id, source);
    expect(attached.referenceAssets).toHaveLength(1);
    expect(attached.referenceAssets[0]).toMatchObject({
      assetKind: "image",
      originalFilename: "원본.png",
      mimeType: "image/png",
      state: "present",
      ordinal: 0,
    });
    const assetId = attached.referenceAssets[0]!.id;
    expect(Buffer.from(repo.readReferenceAsset(document.id, assetId).base64, "base64")).toEqual(png);
    expectMunhaeCode(() => repo.readReferenceAsset(other.id, assetId), "not_found");
    const ledger = openSqlite(join(repo.packagePath, "project.sqlite3"));
    try {
      const location = ledger.prepare(
        `SELECT l.relative_path, COUNT(na.asset_id) AS links
         FROM src_asset_locations l
         JOIN src_node_assets na ON na.asset_id = l.asset_id
         WHERE l.asset_id = ? GROUP BY l.relative_path`,
      ).get(assetId) as { relative_path: string; links: number };
      expect(location.relative_path).toMatch(/^assets\/originals\//);
      expect(location.relative_path).not.toContain(repo.packagePath);
      expect(location.links).toBe(1);
    } finally {
      ledger.close();
    }

    // Retrying the same attachment reuses both the content-addressed file and node link.
    expect(repo.attachReferenceAsset(document.id, source).referenceAssets).toHaveLength(1);
    const originals = join(repo.packagePath, "assets", "originals");
    expect(readdirSync(originals)).toHaveLength(1);
    const packaged = join(originals, readdirSync(originals)[0]!);
    writeFileSync(packaged, Buffer.alloc(png.byteLength, 1));
    expect(repo.getEditor(document.id).referenceAssets[0]?.state).toBe("hash_mismatch");
    expectMunhaeCode(() => repo.readReferenceAsset(document.id, assetId), "asset_unavailable");

    // Restoring the content and moving the whole package keeps the relative link valid.
    writeFileSync(packaged, png);
    const oldPackage = repo.packagePath;
    repo.close();
    const movedPackage = join(parent, "이동된 프로젝트.munhae");
    renameSync(oldPackage, movedPackage);
    const reopened = track(openProject(movedPackage));
    expect(reopened.getEditor(document.id).referenceAssets[0]?.state).toBe("present");
    expect(Buffer.from(reopened.readReferenceAsset(document.id, assetId).base64, "base64")).toEqual(png);
  });

  it("rejects disguised and unsupported attachments before recording them", () => {
    const { handle } = createProject({ title: "파일 검증", parentDir: tempDir() });
    const repo = track(handle);
    const document = repo.createDocument({
      title: "원문",
      parentId: null,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "天地。",
    });
    const disguised = join(tempDir(), "가짜.png");
    writeFileSync(disguised, "<html>not an image</html>", "utf8");
    expectMunhaeCode(() => repo.attachReferenceAsset(document.id, disguised), "invalid_asset");
    expect(repo.getEditor(document.id).referenceAssets).toEqual([]);

    const pdf = join(tempDir(), "판본.pdf");
    writeFileSync(pdf, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n", "utf8");
    const attached = repo.attachReferenceAsset(document.id, pdf);
    expect(attached.referenceAssets[0]).toMatchObject({
      assetKind: "pdf",
      mimeType: "application/pdf",
      originalFilename: "판본.pdf",
      state: "present",
    });
  });
});
