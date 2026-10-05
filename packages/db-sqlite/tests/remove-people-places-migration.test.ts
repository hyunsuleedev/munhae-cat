import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalJson, sha256Hex, utf8ByteLength } from "@munhae/domain";
import { openProject, seedDemoProject } from "../src/index.ts";
import { applySqlMigration, migrateProjectDb } from "../src/migrate.ts";
import { insertRow } from "../src/rows.ts";
import { loadMigrationSql } from "../src/sql.ts";
import { assertSqliteIntegrity, openSqlite, type SqliteDb } from "../src/sqlite.ts";
import { restoreV4KnowledgeFixture } from "./legacy-knowledge-fixture.ts";
import { withMaterialDefaults } from "./legacy-materials-fixture.ts";

const dirs: string[] = [];
const databases: SqliteDb[] = [];
const created = "2023-01-02T03:04:05.000Z";
const updated = "2025-06-07T08:09:10.000Z";
const archived = "2025-08-09T10:11:12.000Z";

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function legacyDb(): { db: SqliteDb; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "munhae-remove-people-places-"));
  dirs.push(dir);
  const path = join(dir, "project.sqlite3");
  const db = openSqlite(path);
  databases.push(db);
  for (const [i, name] of ["001_init.sql", "002_full_text_translation.sql", "003_context_without_kind.sql", "004_review_comments.sql"].entries()) {
    if (i === 1) db.pragma("foreign_keys = OFF");
    try { applySqlMigration(db, loadMigrationSql(`sqlite/${name}`), name, i + 1); }
    finally { db.pragma("foreign_keys = ON"); }
  }
  insertRow(db, "core_actors", { id: "creator", actor_kind: "human", display_name: "작성자", created_at: created });
  insertRow(db, "core_actors", { id: "editor", actor_kind: "human", display_name: "수정자", created_at: created });
  return { db, path };
}

function project(db: SqliteDb, id: string, master = true): void {
  insertRow(db, "core_projects", {
    id, title: id, created_by_actor_id: "creator", created_at: created, updated_at: updated,
  });
  // A portable project normally has one meta state. Additional core projects
  // exercise the migration's project scoping without violating that contract.
  if (!db.prepare("SELECT 1 FROM meta_project_state").get()) {
    insertRow(db, "meta_project_state", { project_id: id, schema_version: 4, format_version: 1 });
  }
  if (master) node(db, `${id}-master`, id, null, null, true);
}

function node(db: SqliteDb, id: string, projectId: string, parentId: string | null, authorId: string | null, master = false): void {
  const max = db.prepare("SELECT COALESCE(MAX(ordinal), -1) AS n FROM document_nodes WHERE project_id=? AND parent_node_id IS ?")
    .get(projectId, parentId) as { n: number };
  insertRow(db, "document_nodes", {
    id, project_id: projectId, parent_node_id: parentId, node_role: "container", is_master: master ? 1 : 0,
    title: id, ordinal: max.n + 1, author_person_id: authorId, period_text: "조선 전기",
    date_text: "1446년 9월", description_md: "기존 문서 설명", source_reference: "소장본 A",
    lock_version: 4, created_at: created, updated_at: updated,
  });
}

function person(db: SqliteDb, id: string, projectId: string, archivedAt: string | null = null): void {
  insertRow(db, "persons", {
    id, project_id: projectId, preferred_name: " 같은 이름 ", hanja_name: "𪚥許筠", reading: "허균",
    aliases_json: '[ "蛟山", "名\\n字" ]', description_md: "설명 첫 줄\r\n두 번째 줄\n```json\n{\"원문\":true}",
    date_text: "?–1618 (추정)", content_hash: `original-person-hash:${id}`, lock_version: 7,
    created_by_actor_id: "creator", updated_by_actor_id: "editor", created_at: created,
    updated_at: updated, archived_at: archivedAt,
  });
}

function place(db: SqliteDb, id: string, projectId: string, archivedAt: string | null = null): void {
  insertRow(db, "places", {
    id, project_id: projectId, preferred_name: "中國", hanja_name: null, reading: "중국",
    aliases_json: '{ "legacy": "명" }', place_kind: "country", location_note_md: "위치\n보충",
    description_md: "지역 설명", content_hash: `original-place-hash:${id}`, lock_version: 3,
    created_by_actor_id: "creator", updated_by_actor_id: "editor", created_at: created,
    updated_at: updated, archived_at: archivedAt,
  });
}

function rows(db: SqliteDb, table: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Array<Record<string, unknown>>;
}

function legacyState(db: SqliteDb) {
  return {
    persons: rows(db, "persons"), places: rows(db, "places"), nodes: rows(db, "document_nodes"),
    cards: rows(db, "context_items"), artifacts: rows(db, "provenance_artifacts"),
    glossary: rows(db, "glossary_entries"), messages: rows(db, "chat_messages"),
    migrations: db.prepare("SELECT * FROM meta_schema_migrations ORDER BY version").all(),
    schema: db.prepare("SELECT * FROM meta_project_state").all(),
  };
}

it("deletes active and archived people/places without creating copies, preserving document metadata and other records", () => {
  const { db, path } = legacyDb();
  project(db, "p1"); project(db, "p2"); project(db, "p3", false);
  db.prepare("UPDATE core_projects SET status='archived', archived_at=? WHERE id='p2'").run(archived);
  person(db, "p1-person", "p1"); person(db, "p1-archived-person", "p1", archived);
  place(db, "p1-place", "p1"); place(db, "p1-archived-place", "p1", archived);
  person(db, "shared-id", "p1"); place(db, "shared-id", "p1");
  person(db, "p2-person", "p2"); place(db, "p2-place", "p2");
  person(db, "no-master-person", "p3");
  node(db, "parent", "p1", "p1-master", "p1-person");
  node(db, "child", "p1", "parent", null);
  node(db, "archived-author-doc", "p1", "p1-master", "p1-archived-person");
  db.prepare("UPDATE document_nodes SET archived_at=? WHERE id='archived-author-doc'").run(archived);
  node(db, "other-author", "p2", "p2-master", "p2-person");
  insertRow(db, "context_items", {
    id: "shared-id", project_id: "p1", scope_kind: "document_node", scope_id: "p1-master",
    title: "기존 문맥", content_md: "기존 문맥은 그대로 둔다.", content_hash: "original-context-hash",
    lock_version: 9, created_at: created, updated_at: updated,
  });
  insertRow(db, "glossary_entries", {
    id: "glossary", project_id: "p1", source_term: "太守", target_locale: "ko", target_term: "태수",
    term_kind: "office", usage_status: "preferred", note_md: "기존 용어 설명", content_hash: "original-glossary-hash",
    lock_version: 5, created_by_actor_id: "creator", updated_by_actor_id: "editor", created_at: created, updated_at: updated,
  });
  const oldRequest = canonicalJson({ sources: [{ id: "p1-person", kind: "person", hash: "old-hash" }], text: "기존 요청" });
  insertRow(db, "provenance_artifacts", {
    id: "old-request", project_id: "p1", artifact_kind: "exact_llm_request", payload_text: oldRequest,
    raw_sha256: sha256Hex(oldRequest), canonical_sha256: sha256Hex(oldRequest), byte_size: utf8ByteLength(oldRequest), created_at: created,
  });
  insertRow(db, "chat_threads", { id: "thread", project_id: "p1", created_by_actor_id: "creator", created_at: created });
  insertRow(db, "chat_messages", {
    id: "message", project_id: "p1", thread_id: "thread", role: "assistant", actor_id: "creator",
    request_manifest_json: oldRequest, request_artifact_id: "old-request", created_at: created,
  });
  const before = legacyState(db);
  migrateProjectDb(db);

  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('persons','places')").all()).toEqual([]);
  expect((db.pragma("table_info(document_nodes)") as Array<{ name: string }>).map((column) => column.name))
    .not.toContain("author_person_id");
  expect(rows(db, "document_nodes")).toEqual(before.nodes.map(({ author_person_id, ...old }) => ({
    ...old, author_text: author_person_id === null ? null : before.persons.find((person) => person.id === author_person_id)!.preferred_name,
  })));
  expect(rows(db, "context_items")).toEqual(before.cards.map(withMaterialDefaults));
  expect(rows(db, "provenance_artifacts")).toEqual(before.artifacts);
  // v13 later discards the legacy glossary by product decision.
  expect(before.glossary).toHaveLength(1);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='glossary_entries'").get()).toBeUndefined();
  expect(rows(db, "chat_messages")).toEqual(before.messages);
  expect(db.prepare("SELECT schema_version FROM meta_project_state").get()).toEqual({ schema_version: 18 });
  assertSqliteIntegrity(db);

  const after = {
    nodes: rows(db, "document_nodes"), cards: rows(db, "context_items"), artifacts: rows(db, "provenance_artifacts"),
    migrations: db.prepare("SELECT * FROM meta_schema_migrations ORDER BY version").all(),
  };
  db.close();
  const reopened = openSqlite(path); databases.push(reopened);
  migrateProjectDb(reopened);
  expect({
    nodes: rows(reopened, "document_nodes"), cards: rows(reopened, "context_items"), artifacts: rows(reopened, "provenance_artifacts"),
    migrations: reopened.prepare("SELECT * FROM meta_schema_migrations ORDER BY version").all(),
  }).toEqual(after);
  assertSqliteIntegrity(reopened);
  expect(() => reopened.prepare("UPDATE document_nodes SET is_master=0 WHERE id='p1-master'").run()).toThrow(/project master/);
});

it("does not copy a person's name from a different project into document metadata", () => {
  const { db } = legacyDb(); project(db, "p1"); project(db, "p2"); person(db, "foreign", "p2");
  node(db, "wrong-author", "p1", "p1-master", "foreign");
  migrateProjectDb(db);
  expect(db.prepare("SELECT author_text FROM document_nodes WHERE id='wrong-author'").get()).toEqual({ author_text: null });
  expect(rows(db, "context_items")).toEqual([]);
  expect(rows(db, "provenance_artifacts")).toEqual([]);
  assertSqliteIntegrity(db);
});

it("opens a v4 project without a backup or copied knowledge and remains stable on reopening", () => {
  const parent = mkdtempSync(join(tmpdir(), "munhae-v4-no-backup-"));
  dirs.push(parent);
  const repo = seedDemoProject(parent);
  const { packagePath, projectId } = repo;
  repo.close();
  const path = join(packagePath, "project.sqlite3");
  const db = openSqlite(path); databases.push(db);
  restoreV4KnowledgeFixture(db);
  const { created_by_actor_id: actorId } = db.prepare("SELECT created_by_actor_id FROM core_projects WHERE id=?")
    .get(projectId) as { created_by_actor_id: string };
  insertRow(db, "places", {
    id: "discarded-place", project_id: projectId, preferred_name: "中國",
    description_md: "이 기록을 문맥이나 별도 원본으로 복사하지 않는다.",
    content_hash: "legacy-place-hash", created_by_actor_id: actorId, updated_by_actor_id: actorId,
    created_at: created, updated_at: updated,
  });
  expect(rows(db, "persons").length).toBeGreaterThan(0);
  const before = { cards: rows(db, "context_items"), artifacts: rows(db, "provenance_artifacts") };
  expect(before.cards.length).toBeGreaterThan(0);
  expect(before.artifacts).toEqual([]);
  db.close();
  expect(readdirSync(packagePath).filter((name) => name.endsWith(".bak"))).toEqual([]);

  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = openProject(packagePath);
    try { expect(reopened.projectId).toBe(projectId); }
    finally { reopened.close(); }
    expect(readdirSync(packagePath).filter((name) => name.endsWith(".bak"))).toEqual([]);
    const check = openSqlite(path); databases.push(check);
    try {
      expect(check.prepare("SELECT schema_version FROM meta_project_state").get()).toEqual({ schema_version: 18 });
      expect(check.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('persons','places')").all()).toEqual([]);
      expect({ cards: rows(check, "context_items"), artifacts: rows(check, "provenance_artifacts") })
        .toEqual({ ...before, cards: before.cards.map(withMaterialDefaults) });
      assertSqliteIntegrity(check);
    } finally { check.close(); }
  }
});

it("rolls back earlier DDL and author updates when a later schema statement fails", () => {
  const { db } = legacyDb(); project(db, "p1"); person(db, "first", "p1");
  node(db, "author-doc", "p1", "p1-master", "first");
  db.exec("DROP INDEX idx_document_nodes_author");
  const before = legacyState(db);
  expect(() => migrateProjectDb(db)).toThrow(/no such index/);
  expect(legacyState(db)).toEqual(before);
  expect((db.pragma("table_info(document_nodes)") as Array<{ name: string }>).map((column) => column.name)).not.toContain("author_text");
});
