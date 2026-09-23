import type { SqliteDb } from "../src/sqlite.ts";

export function withMaterialDefaults<T extends object>(row: T) {
  return { ...row, inherit_to_children: 1, condition_md: "", source_comment_id: null, origin_artifact_id: null };
}

/** Remove only the new materials schema when constructing an older test fixture. */
export function restoreV6MaterialsFixture(db: SqliteDb): void {
  db.exec(`DROP TABLE IF EXISTS comment_references; DROP TABLE IF EXISTS term_revisions; DROP TABLE IF EXISTS term_entries;
    DROP TABLE IF EXISTS material_preferences;
    DROP TRIGGER IF EXISTS trg_context_items_origin_insert;
    DROP TRIGGER IF EXISTS trg_context_items_origin_update;
    DROP INDEX IF EXISTS idx_context_items_source_comment;`);
  const columns = (db.pragma("table_info(context_items)") as Array<{ name: string }>).map(column => column.name);
  for (const column of ["inherit_to_children", "condition_md", "source_comment_id", "origin_artifact_id"]) {
    if (columns.includes(column)) db.exec(`ALTER TABLE context_items DROP COLUMN ${column}`);
  }
  restoreV9SummaryFixture(db);
  db.exec("DELETE FROM meta_schema_migrations WHERE version>=7; UPDATE meta_project_state SET schema_version=6");
}

/** Restore removed columns before constructing a pre-v10 fixture. */
export function restoreV9SummaryFixture(db: SqliteDb): void {
  for (const table of ["src_text_versions", "punctuation_versions"]) {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!columns.some(column => column.name === "change_summary")) db.exec(`ALTER TABLE ${table} ADD COLUMN change_summary TEXT`);
  }
  db.exec("DELETE FROM meta_schema_migrations WHERE version=10; UPDATE meta_project_state SET schema_version=9");
}
