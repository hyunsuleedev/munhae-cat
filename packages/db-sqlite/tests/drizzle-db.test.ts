import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, is, SQL } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { afterEach, expect, it } from "vitest";
import { releaseLock } from "@munhae/project-format";
import { bootstrapEmptyProject } from "../src/bootstrap.ts";
import { orm } from "../src/drizzle-db.ts";
import { schema } from "../src/drizzle-schema.ts";
import { migrateProjectDb } from "../src/migrate.ts";
import { insertSourceLayer } from "../src/source-layer.ts";
import { openSqlite, type SqliteDb } from "../src/sqlite.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function memoryDb(): SqliteDb {
  const db = openSqlite(":memory:");
  cleanup.push(() => db.close());
  migrateProjectDb(db);
  return db;
}

function sourceFixture() {
  const dir = mkdtempSync(join(tmpdir(), "munhae-drizzle-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const boot = bootstrapEmptyProject({ title: "Drizzle transaction", parentDir: dir });
  cleanup.push(() => { boot.db.close(); releaseLock(boot.packagePath); });
  const nodes = schema.document_nodes;
  orm(boot.db).insert(nodes).values({
    id: "master", project_id: boot.projectId, node_role: "container", is_master: 1,
    title: "Master", ordinal: 0, created_at: boot.createdAt, updated_at: boot.createdAt,
  }).run();
  orm(boot.db).insert(nodes).values({
    id: "source", project_id: boot.projectId, parent_node_id: "master", node_role: "source_unit",
    title: "Source", ordinal: 0, created_at: boot.createdAt, updated_at: boot.createdAt,
  }).run();
  return {
    db: boot.db,
    insert: () => insertSourceLayer({
      db: boot.db, projectId: boot.projectId, documentNodeId: "source", name: "原文",
      text: "天地玄黃𠀀", originKind: "manual", policyVersionId: boot.policyVersionId,
      actors: boot.actors, now: boot.createdAt,
    }),
  };
}

it("keeps Drizzle column mappings in agreement with the migrated SQLite schema", () => {
  const db = memoryDb();
  const tables = db.pragma("table_list") as Array<{ schema: string; name: string; type: string }>;
  const normalTables = tables.filter(table =>
    table.schema === "main" && table.type === "table" && !table.name.startsWith("sqlite_"),
  ).map(table => table.name).sort();
  expect(Object.keys(schema).sort()).toEqual(normalTables);

  const dialect = new SQLiteSyncDialect();
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table);
    const native = db.prepare("SELECT * FROM pragma_table_info(?)").all(config.name) as Array<{
      name: string; type: string; notnull: number; pk: number; dflt_value: string | null;
    }>;
    expect(config.columns.map(column => ({
      name: column.name,
      type: column.getSQLType().toUpperCase(),
      notNull: column.notNull,
      default: is(column.default, SQL) ? dialect.sqlToQuery(column.default).sql : column.default ?? null,
    })), config.name).toEqual(native.map(column => ({
      name: column.name,
      type: column.type.toUpperCase(),
      notNull: Boolean(column.notnull || column.pk),
      default: column.dflt_value,
    })));
  }
});

it("rolls back source rows and nested Drizzle work with a native outer transaction", () => {
  const { db, insert } = sourceFixture();
  expect(orm(db)).toBe(orm(db));
  const failure = new Error("cancel save");
  expect(() => db.transaction(() => {
    const source = insert();
    expect(db.prepare("SELECT content_text FROM src_text_versions WHERE id = ?")
      .get(source.sourceVersionId)).toEqual({ content_text: "天地玄黃𠀀" });
    orm(db).transaction(() => {
      orm(db).update(schema.document_nodes).set({ title: "Nested update" })
        .where(eq(schema.document_nodes.id, "source")).run();
    });
    throw failure;
  })()).toThrow(failure);

  expect(orm(db).select().from(schema.src_texts).all()).toEqual([]);
  expect(orm(db).select().from(schema.src_text_versions).all()).toEqual([]);
  expect(orm(db).select().from(schema.src_text_heads).all()).toEqual([]);
  expect(orm(db).select({ title: schema.document_nodes.title }).from(schema.document_nodes)
    .where(eq(schema.document_nodes.id, "source")).get()).toEqual({ title: "Source" });
});

it("isolates a failed nested save and commits native writes with a Drizzle outer transaction", () => {
  const { db, insert } = sourceFixture();
  orm(db).transaction(() => {
    db.prepare("UPDATE document_nodes SET title = ? WHERE id = ?").run("Kept title", "source");
    expect(() => orm(db).transaction(() => {
      insert();
      throw new Error("cancel inner save");
    })).toThrow("cancel inner save");
    expect(db.prepare("SELECT count(*) AS count FROM src_text_versions").get()).toEqual({ count: 0 });
    insert();
  });

  expect(db.prepare("SELECT count(*) AS count FROM src_texts").get()).toEqual({ count: 1 });
  expect(db.prepare("SELECT count(*) AS count FROM src_text_versions").get()).toEqual({ count: 1 });
  expect(db.prepare("SELECT count(*) AS count FROM src_text_heads").get()).toEqual({ count: 1 });
  expect(db.prepare("SELECT title FROM document_nodes WHERE id = ?").get("source"))
    .toEqual({ title: "Kept title" });
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
