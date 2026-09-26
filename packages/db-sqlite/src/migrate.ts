import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { MunhaeError, nowIso, sha256Hex } from "@munhae/domain";
import { loadMigrationSql } from "./sql.ts";
import { contextItemContentHash, type ContextItemContent } from "./knowledge-content.ts";
import type { SqliteDb } from "./sqlite.ts";

export const PROJECT_SCHEMA_VERSION = 12;
const PROJECT_BASELINE_NAME = "001_init.sql";
const PROJECT_BASELINE_PATH = "sqlite/001_init.sql";
const PROJECT_MIGRATIONS = [
  PROJECT_BASELINE_NAME,
  "002_full_text_translation.sql",
  "003_context_without_kind.sql",
  "004_review_comments.sql",
  "005_remove_people_places.sql",
  "006_reading_annotations.sql",
  "007_translation_materials.sql",
  "008_term_review.sql",
  "009_comment_references.sql",
  "010_remove_change_summary.sql",
  "011_reading_translation_quote.sql",
  "012_translation_groups.sql",
] as const;

type ProjectMigrationRow = {
  version: number;
  name: string;
  checksum: string;
};

function unsupportedProjectSchema(): MunhaeError {
  return new MunhaeError(
    "unsupported_schema_version",
    "지원하지 않는 프로젝트 스키마입니다. 현재 버전에서 새 프로젝트를 만들어 주세요.",
  );
}

function hasTable(db: SqliteDb, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(name));
}

function assertCurrentProjectBaseline(db: SqliteDb): void {
  if (!hasTable(db, "meta_schema_migrations") || !hasTable(db, "meta_project_state")) {
    throw unsupportedProjectSchema();
  }
  const migrations = db.prepare(
    "SELECT version, name, checksum FROM meta_schema_migrations ORDER BY version",
  ).all() as ProjectMigrationRow[];
  if (
    migrations.length < 1 || migrations.length > PROJECT_MIGRATIONS.length
    || migrations.some((migration, index) =>
      migration.version !== index + 1
      || migration.name !== PROJECT_MIGRATIONS[index]
      || migration.checksum !== sha256Hex(loadMigrationSql(`sqlite/${PROJECT_MIGRATIONS[index]}`)),
    )
  ) {
    throw unsupportedProjectSchema();
  }
  const states = db.prepare("SELECT schema_version FROM meta_project_state").all() as Array<{
    schema_version: number;
  }>;
  if (states.length !== 1 || states[0]?.schema_version !== migrations.length) {
    throw unsupportedProjectSchema();
  }
}

/**
 * Inspect a stable copy so even SQLite's read-side WAL bookkeeping cannot add
 * `-wal`/`-shm` files beside an unsupported project database.
 */
export function assertProjectDbBaseline(filePath: string): void {
  const probeDir = mkdtempSync(join(tmpdir(), "munhae-schema-probe-"));
  const probePath = join(probeDir, basename(filePath));
  let db: Database.Database | null = null;
  try {
    copyFileSync(filePath, probePath);
    const walPath = `${filePath}-wal`;
    if (existsSync(walPath)) {
      copyFileSync(walPath, `${probePath}-wal`);
    }
    db = new Database(probePath, { readonly: true, fileMustExist: true });
    assertCurrentProjectBaseline(db);
  } finally {
    db?.close();
    rmSync(probeDir, { recursive: true, force: true });
  }
}

export function applySqlMigration(
  db: SqliteDb,
  sql: string,
  name: string,
  version: number,
  afterSql?: () => void,
): void {
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
    afterSql?.();
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(`foreign key check failed for ${name}`);
    }
    db.prepare(
      `INSERT INTO meta_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
    ).run(version, name, checksum, nowIso());
  })();
}

export function migrateProjectDb(db: SqliteDb): void {
  const existing = db.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
  ).get();
  if (existing) {
    assertCurrentProjectBaseline(db);
  } else {
  applySqlMigration(
    db,
    loadMigrationSql(PROJECT_BASELINE_PATH),
    PROJECT_BASELINE_NAME,
    1,
  );
  }
  // Rebuild one referenced table with FKs disabled only for this transaction.
  // Every foreign key is checked before committing; existing versions keep IDs.
  db.pragma("foreign_keys = OFF");
  try { applySqlMigration(db, loadMigrationSql("sqlite/002_full_text_translation.sql"), "002_full_text_translation.sql", 2); }
  finally { db.pragma("foreign_keys = ON"); }
  applySqlMigration(
    db,
    loadMigrationSql("sqlite/003_context_without_kind.sql"),
    "003_context_without_kind.sql",
    3,
    () => {
      const rows = db.prepare(
        `SELECT id, scope_id AS scopeId, title, content_md AS contentMd, priority, enabled
         FROM context_items`,
      ).all() as Array<Omit<ContextItemContent, "enabled"> & { id: string; enabled: number }>;
      const update = db.prepare("UPDATE context_items SET content_hash = ? WHERE id = ?");
      for (const row of rows) {
        update.run(contextItemContentHash({ ...row, enabled: row.enabled === 1 }), row.id);
      }
    },
  );
  applySqlMigration(
    db,
    loadMigrationSql("sqlite/004_review_comments.sql"),
    "004_review_comments.sql",
    4,
  );
  applySqlMigration(
    db,
    loadMigrationSql("sqlite/005_remove_people_places.sql"),
    "005_remove_people_places.sql",
    5,
  );
  applySqlMigration(db, loadMigrationSql("sqlite/006_reading_annotations.sql"), "006_reading_annotations.sql", 6);
  applySqlMigration(db, loadMigrationSql("sqlite/007_translation_materials.sql"), "007_translation_materials.sql", 7);
  applySqlMigration(db, loadMigrationSql("sqlite/008_term_review.sql"), "008_term_review.sql", 8);
  applySqlMigration(db, loadMigrationSql("sqlite/009_comment_references.sql"), "009_comment_references.sql", 9);
  applySqlMigration(db, loadMigrationSql("sqlite/010_remove_change_summary.sql"), "010_remove_change_summary.sql", 10);
  applySqlMigration(db, loadMigrationSql("sqlite/011_reading_translation_quote.sql"), "011_reading_translation_quote.sql", 11);
  applySqlMigration(db, loadMigrationSql("sqlite/012_translation_groups.sql"), "012_translation_groups.sql", 12);
}

export function migrateAppDb(db: SqliteDb): void {
  applySqlMigration(db, loadMigrationSql("app/001_init.sql"), "001_init.sql", 1);
}
