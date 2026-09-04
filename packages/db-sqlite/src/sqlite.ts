import Database from "better-sqlite3";

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
