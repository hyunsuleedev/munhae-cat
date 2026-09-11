import type { SqliteDb } from "../src/sqlite.ts";

export function withMaterialDefaults<T extends object>(row: T) {
  return { ...row, inherit_to_children: 1, condition_md: "", source_comment_id: null, origin_artifact_id: null };
}

/** Remove only the new materials schema when constructing an older test fixture. */
export function restoreV6MaterialsFixture(db: SqliteDb): void {
  db.exec(`DROP TABLE IF EXISTS material_preferences;
    DROP TRIGGER IF EXISTS trg_context_items_origin_insert;
    DROP TRIGGER IF EXISTS trg_context_items_origin_update;
    DROP INDEX IF EXISTS idx_context_items_source_comment;`);
  const columns = (db.pragma("table_info(context_items)") as Array<{ name: string }>).map(column => column.name);
  for (const column of ["inherit_to_children", "condition_md", "source_comment_id", "origin_artifact_id"]) {
    if (columns.includes(column)) db.exec(`ALTER TABLE context_items DROP COLUMN ${column}`);
  }
  db.exec("DELETE FROM meta_schema_migrations WHERE version>=7; UPDATE meta_project_state SET schema_version=6");
}
