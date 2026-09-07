import Database from "better-sqlite3";
import { MunhaeError } from "@munhae/domain";

export type SqliteDb = InstanceType<typeof Database>;

export function openSqlite(filePath: string): SqliteDb {
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const fk = db.pragma("foreign_keys", { simple: true });
  if (Number(fk) !== 1) throw new Error("foreign_keys off");
  return db;
}

export function assertSqliteIntegrity(db: SqliteDb): void {
  let rows: Array<Record<string, unknown>>;
  let foreignKeyRows: Array<Record<string, unknown>>;
  try {
    rows = db.pragma("integrity_check") as Array<Record<string, unknown>>;
    foreignKeyRows = db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  } catch (error) {
    throw new MunhaeError(
      "sqlite_integrity_failed",
      error instanceof Error ? `SQLite integrity check failed: ${error.message}` : "SQLite integrity check failed",
    );
  }
  const messages = rows.flatMap((row) => Object.values(row)).map(String);
  if (messages.length !== 1 || messages[0] !== "ok") {
    throw new MunhaeError(
      "sqlite_integrity_failed",
      `SQLite integrity check failed: ${messages.slice(0, 8).join("; ") || "unknown error"}`,
    );
  }
  if (foreignKeyRows.length > 0) {
    const tables = [...new Set(foreignKeyRows
      .map((row) => typeof row.table === "string" ? row.table : null)
      .filter((table): table is string => Boolean(table)))]
      .slice(0, 8);
    throw new MunhaeError(
      "sqlite_integrity_failed",
      `SQLite foreign key check failed: ${foreignKeyRows.length} violation(s)${tables.length ? ` in ${tables.join(", ")}` : ""}`,
    );
  }
}
