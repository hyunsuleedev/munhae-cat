import { loadContent, projectContent } from "./translation-content.ts";
import { getTableColumns } from "drizzle-orm";
import { MunhaeError } from "@munhae/domain";
import { schema } from "./drizzle-schema.ts";
import { assertSqliteIntegrity, type SqliteDb } from "./sqlite.ts";

export type OnlineRow = Record<string, string | number | null>;
export type OnlineTableData = Record<string, OnlineRow[]>;
export type OnlineRowChange = { table: string; key: OnlineRow; before: OnlineRow | null; after: OnlineRow | null };
export type OnlineTableMetadata = { name: string; columns: string[]; primaryKey: string[] };
// reading_translation_links is display-only local research state; the v10 online row protocol does not carry it.
const EXCLUDED = new Set(["meta_schema_migrations", "meta_project_state", "chat_agent_sessions", "reading_translation_links", "translation_groups", "translation_group_source_links", "translation_content_parts", "translation_content_revisions", "translation_content_snapshots"]);
const COMPOSITE_KEYS: Record<string, string[]> = {
  material_preferences: ["project_id", "document_node_id", "source_kind", "source_id"],
  src_node_assets: ["document_node_id", "asset_id", "ordinal"],
  translation_anchor_structure_spans: ["anchor_id", "punctuation_structure_span_id"],
  translation_block_anchors: ["translation_block_id", "translation_anchor_id"],
};

/** Same migrated v10 physical columns used by the PostgreSQL row protocol. */
export const ONLINE_TABLE_METADATA: readonly OnlineTableMetadata[] = Object.entries(schema)
  .filter(([name]) => !EXCLUDED.has(name)).map(([name, table]) => {
    const columns = Object.values(getTableColumns(table));
    const primaryKey = COMPOSITE_KEYS[name] ?? columns.filter(column => column.primary).map(column => column.name);
    if (!primaryKey.length) throw new Error(`Missing online row key for ${name}`);
    return { name, columns: columns.map(column => column.name), primaryKey };
  });
const METADATA = new Map(ONLINE_TABLE_METADATA.map(table => [table.name, table]));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const invalid = (message: string): never => { throw new MunhaeError("invalid_online_rows", message); };
const conflict = (): never => { throw new MunhaeError("online_row_conflict", "온라인 행이 이전 버전과 일치하지 않습니다"); };

function metadata(name: string): OnlineTableMetadata { return METADATA.get(name) ?? invalid(`알 수 없는 온라인 테이블: ${name}`); }
function assertRow(table: OnlineTableMetadata, row: OnlineRow): void {
  if (!row || typeof row !== "object" || Array.isArray(row)
    || Object.keys(row).length !== table.columns.length
    || table.columns.some(column => !Object.hasOwn(row, column)
      || !(row[column] === null || typeof row[column] === "string" || typeof row[column] === "number" && Number.isFinite(row[column])))) {
    invalid(`온라인 행 형식이 올바르지 않습니다: ${table.name}`);
  }
}
function rowKey(table: OnlineTableMetadata, row: OnlineRow): string {
  if (table.primaryKey.some(column => row[column] == null)) invalid(`온라인 행 키가 없습니다: ${table.name}`);
  return JSON.stringify(table.primaryKey.map(column => row[column]));
}
function sameRow(table: OnlineTableMetadata, a: OnlineRow, b: OnlineRow): boolean {
  return table.columns.every(column => a[column] === b[column]);
}
function tableRows(table: OnlineTableMetadata, rows: OnlineRow[]): Map<string, OnlineRow> {
  if (!Array.isArray(rows)) invalid(`온라인 테이블이 없습니다: ${table.name}`);
  const result = new Map<string, OnlineRow>();
  for (const row of rows) {
    assertRow(table, row);
    const key = rowKey(table, row);
    if (result.has(key)) invalid(`온라인 행 키가 중복됩니다: ${table.name}`);
    result.set(key, row);
  }
  return result;
}
function validateTables(tables: OnlineTableData): void {
  if (!tables || typeof tables !== "object" || Array.isArray(tables)
    || Object.keys(tables).length !== ONLINE_TABLE_METADATA.length
    || Object.keys(tables).some(name => !METADATA.has(name))) invalid("온라인 테이블 목록이 일치하지 않습니다");
  for (const table of ONLINE_TABLE_METADATA) tableRows(table, tables[table.name]!);
}

export function diffOnlineRows(before: OnlineTableData, after: OnlineTableData): OnlineRowChange[] {
  validateTables(before); validateTables(after);
  const changes: OnlineRowChange[] = [];
  for (const table of ONLINE_TABLE_METADATA) {
    const previous = tableRows(table, before[table.name]!), next = tableRows(table, after[table.name]!);
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      const oldRow = previous.get(id) ?? null, newRow = next.get(id) ?? null;
      if (oldRow && newRow && sameRow(table, oldRow, newRow)) continue;
      const key = Object.fromEntries(table.primaryKey.map(column => [column, (newRow ?? oldRow)![column]!])) as OnlineRow;
      changes.push({ table: table.name, key, before: oldRow ? { ...oldRow } : null, after: newRow ? { ...newRow } : null });
    }
  }
  return changes;
}

/** Pure, strict old-row CAS application; neither input object is mutated. */
export function applyOnlineRowChanges(state: OnlineTableData, changes: OnlineRowChange[]): OnlineTableData {
  validateTables(state);
  const maps = new Map(ONLINE_TABLE_METADATA.map(table => [table.name, tableRows(table, state[table.name]!)]));
  for (const change of changes) {
    const table = metadata(change.table);
    if (!change.key || Object.keys(change.key).length !== table.primaryKey.length
      || Object.keys(change.key).some(column => !table.primaryKey.includes(column)) || (!change.before && !change.after)) invalid("온라인 변경 키가 올바르지 않습니다");
    const id = rowKey(table, change.key), rows = maps.get(table.name)!;
    if (change.before) { assertRow(table, change.before); if (rowKey(table, change.before) !== id) invalid("온라인 이전 행 키가 다릅니다"); }
    if (change.after) { assertRow(table, change.after); if (rowKey(table, change.after) !== id) invalid("온라인 새 행 키가 다릅니다"); }
    const current = rows.get(id);
    if (change.before ? !current || !sameRow(table, current, change.before) : Boolean(current)) conflict();
    if (change.after) rows.set(id, { ...change.after }); else rows.delete(id);
  }
  return Object.fromEntries([...maps].map(([name, rows]) => [name, [...rows.values()].map(row => ({ ...row }))]));
}

export function isOnlineAssetPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("assets/") && !value.includes("\\")
    && !/[\x00-\x1f]/.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function normalizeRow(table: string, source: OnlineRow): OnlineRow | null {
  const row = { ...source };
  if (table === "core_project_settings") row.active_document_node_id = null;
  if (table === "src_asset_locations") {
    if (!isOnlineAssetPath(row.relative_path)) return null;
    row.verified_at = null;
    row.state = "present";
  }
  if (table === "src_assets" && typeof row.source_uri === "string"
    && (/^(?:file:|\/|~\/|[A-Za-z]:[\\/])/.test(row.source_uri))) row.source_uri = null;
  return row;
}

/** Export only portable domain records. No SQLite bytes, local CLI sessions or FTS. */
export function readOnlineRows(db: SqliteDb): OnlineTableData {
  return Object.fromEntries(ONLINE_TABLE_METADATA.map(table => {
    const rows = db.prepare(`SELECT ${table.columns.map(quote).join(",")} FROM ${quote(table.name)}`).all() as OnlineRow[];
    if (table.name === "translation_text_layouts") for (const row of rows) {
      const content = loadContent(db, String(row.version_id));
      if (content && row.alignment_state !== "running") {
        const projected = projectContent(content, { state: "ready", error: null });
        row.sentences_json = JSON.stringify(projected.sentences); row.links_json = JSON.stringify(projected.links);
      }
    }
    return [table.name, rows.flatMap(row => { const normalized = normalizeRow(table.name, row); return normalized ? [normalized] : []; })];
  }));
}

/** Replace a disposable cache from authorized server rows, retaining the SAME DB handle.
 * Server-side authorization/invariants remain authoritative. Triggers are restored
 * within this transaction, and any invalid FK/check/type rolls the whole import back. */
export function hydrateOnlineRows(db: SqliteDb, projectId: string, tables: OnlineTableData): void {
  validateTables(tables);
  if (tables.core_projects!.length !== 1 || tables.core_projects![0]!.id !== projectId
    || ONLINE_TABLE_METADATA.some(table => table.columns.includes("project_id") && tables[table.name]!.some(row => row.project_id !== projectId))) {
    invalid("온라인 프로젝트 행의 소유 프로젝트가 일치하지 않습니다");
  }
  if (["human", "system", "llm"].some(kind => !tables.core_actors!.some(actor => actor.actor_kind === kind))
    || !tables.core_translation_policy_heads!.length || tables.core_project_settings!.length !== 1) invalid("온라인 프로젝트의 필수 설정이 없습니다");
  for (const row of tables.src_asset_locations!) if (!isOnlineAssetPath(row.relative_path)) invalid("온라인 첨부 경로가 올바르지 않습니다");
  const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND sql IS NOT NULL").all() as { name: string; sql: string }[];
  const sessions = db.prepare("SELECT * FROM chat_agent_sessions").all() as OnlineRow[];
  const active = db.prepare("SELECT active_document_node_id FROM core_project_settings WHERE project_id=?").get(projectId) as { active_document_node_id: string | null } | undefined;
  const verified = new Map((db.prepare("SELECT * FROM src_asset_locations").all() as OnlineRow[]).map(row => [row.id, row]));
  db.transaction(() => {
    db.pragma("defer_foreign_keys = ON");
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    db.exec("DELETE FROM chat_agent_sessions");
    // The server protocol owns its legacy projection; local entity caches are rebuilt on local editing.
    for (const name of ["translation_content_snapshots", "translation_content_revisions", "translation_content_parts", "translation_group_source_links", "translation_groups"]) db.exec(`DELETE FROM ${quote(name)}`);
    for (const table of ONLINE_TABLE_METADATA) db.exec(`DELETE FROM ${quote(table.name)}`);
    for (const table of ONLINE_TABLE_METADATA) {
      const insert = db.prepare(`INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`);
      for (const input of tables[table.name]!) {
        const row = { ...input };
        if (table.name === "core_project_settings") row.active_document_node_id = tables.document_nodes!.some(node => node.id === active?.active_document_node_id) ? active!.active_document_node_id : null;
        if (table.name === "src_asset_locations") {
          const local = verified.get(row.id);
          row.verified_at = local && local.asset_id === row.asset_id && local.relative_path === row.relative_path ? local.verified_at! : null;
          row.state = local && local.asset_id === row.asset_id && local.relative_path === row.relative_path ? local.state! : "present";
        }
        insert.run(...table.columns.map(column => row[column]!));
      }
    }
    for (const row of sessions) {
      if (row.project_id !== projectId || !tables.chat_threads!.some(thread => thread.id === row.thread_id)
        || row.last_message_id != null && !tables.chat_messages!.some(message => message.id === row.last_message_id)) continue;
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO chat_agent_sessions (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(column => row[column]!));
    }
    for (const trigger of triggers) db.exec(trigger.sql);
    assertSqliteIntegrity(db);
  })();
}
