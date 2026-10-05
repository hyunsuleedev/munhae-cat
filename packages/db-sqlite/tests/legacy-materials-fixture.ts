import type { SqliteDb } from "../src/sqlite.ts";
import { PROJECT_INIT_SQL, TERM_REVIEW_SQL } from "../src/embedded-sql.ts";

export function withMaterialDefaults<T extends object>(row: T) {
  return { ...row, inherit_to_children: 1, condition_md: "", source_comment_id: null, origin_artifact_id: null };
}

/** Remove only the new materials schema when constructing an older test fixture. */
export function restoreV6MaterialsFixture(db: SqliteDb): void {
  restoreV9SummaryFixture(db);
  db.exec(`DROP TABLE IF EXISTS comment_references; DROP TABLE IF EXISTS term_revisions; DROP TABLE IF EXISTS term_entries;
    DROP TABLE IF EXISTS material_preferences;
    DROP TRIGGER IF EXISTS trg_context_items_origin_insert;
    DROP TRIGGER IF EXISTS trg_context_items_origin_update;
    DROP INDEX IF EXISTS idx_context_items_source_comment;`);
  const columns = (db.pragma("table_info(context_items)") as Array<{ name: string }>).map(column => column.name);
  for (const column of ["inherit_to_children", "condition_md", "source_comment_id", "origin_artifact_id"]) {
    if (columns.includes(column)) db.exec(`ALTER TABLE context_items DROP COLUMN ${column}`);
  }
  db.exec("DELETE FROM meta_schema_migrations WHERE version>=7; UPDATE meta_project_state SET schema_version=6");
}

/** Restore removed columns before constructing a pre-v10 fixture. */
export function restoreV9SummaryFixture(db: SqliteDb): void {
  restoreV10AnnotationFixture(db);
  for (const table of ["src_text_versions", "punctuation_versions"]) {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!columns.some(column => column.name === "change_summary")) db.exec(`ALTER TABLE ${table} ADD COLUMN change_summary TEXT`);
  }
  db.exec("DELETE FROM meta_schema_migrations WHERE version=10; UPDATE meta_project_state SET schema_version=9");
}

/** Drop translation footnotes before constructing a pre-v15 fixture. */
export function restoreV14NotesFixture(db: SqliteDb): void {
  db.exec("DROP TABLE IF EXISTS translation_notes; DELETE FROM meta_schema_migrations WHERE version>=15; UPDATE meta_project_state SET schema_version=14");
}

/** Restore the v12 glossary and term-review tables before constructing a pre-v13 fixture. */
export function restoreV12TermFixture(db: SqliteDb): void {
  restoreV14NotesFixture(db);
  const glossary = PROJECT_INIT_SQL.slice(PROJECT_INIT_SQL.indexOf("CREATE TABLE glossary_entries ("), PROJECT_INIT_SQL.indexOf("CREATE TABLE places ("));
  db.exec(`DROP TRIGGER IF EXISTS trg_term_occurrences_version; DROP TABLE IF EXISTS term_candidates; DROP TABLE IF EXISTS term_occurrences;
    DROP TABLE IF EXISTS document_terms; DROP TABLE IF EXISTS terms;`);
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'glossary_entries'").get()) db.exec(glossary);
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'term_entries'").get()) db.exec(TERM_REVIEW_SQL);
  db.exec("DELETE FROM meta_schema_migrations WHERE version>=13; UPDATE meta_project_state SET schema_version=12");
}

/** Drop the local translation link table before constructing a pre-v11 fixture. */
export function restoreV10AnnotationFixture(db: SqliteDb): void {
  restoreV12TermFixture(db);
  db.exec(`DROP TABLE IF EXISTS translation_content_snapshots;
    DROP TABLE IF EXISTS translation_content_revisions;
    DROP TABLE IF EXISTS translation_content_parts;
    DROP TABLE IF EXISTS translation_group_source_links;
    DROP TABLE IF EXISTS translation_groups;
    DELETE FROM meta_schema_migrations WHERE version=12;`);
  db.exec("DROP TABLE IF EXISTS reading_translation_links");
  db.exec("DELETE FROM meta_schema_migrations WHERE version=11; UPDATE meta_project_state SET schema_version=10");
}
