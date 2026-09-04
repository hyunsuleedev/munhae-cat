import { nowIso, sha256Hex } from "@munhae/domain";
import { loadMigrationSql } from "./sql.ts";
import type { SqliteDb } from "./sqlite.ts";

export function applySqlMigration(db: SqliteDb, sql: string, name: string, version: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const checksum = sha256Hex(sql);
  const existing = db
    .prepare(`SELECT checksum FROM meta_schema_migrations WHERE version = ?`)
    .get(version) as { checksum: string } | undefined;
  if (existing) {
    if (existing.checksum !== checksum) {
      throw new Error(`migration checksum mismatch for ${name}`);
    }
    return;
  }
  db.transaction(() => {
    db.exec(sql);
    db.prepare(
      `INSERT INTO meta_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
    ).run(version, name, checksum, nowIso());
  })();
}

export function migrateProjectDb(db: SqliteDb): void {
  applySqlMigration(db, loadMigrationSql("sqlite/001_init.sql"), "001_init.sql", 1);
  applySqlMigration(
    db,
    loadMigrationSql("sqlite/002_document_node_roles.sql"),
    "002_document_node_roles.sql",
    2,
  );
  applySqlMigration(
    db,
    loadMigrationSql("sqlite/003_project_master_container.sql"),
    "003_project_master_container.sql",
    3,
  );
}

export function migrateAppDb(db: SqliteDb): void {
  applySqlMigration(db, loadMigrationSql("app/001_init.sql"), "001_init.sql", 1);
}
