import type { SqliteDb } from "./sqlite.ts";

export function insertRow(db: SqliteDb, table: string, row: Record<string, unknown>): void {
  const entries = Object.entries(row).filter(([, v]) => v !== undefined);
  const keys = entries.map(([k]) => k);
  const placeholders = keys.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`).run(
    ...entries.map(([, v]) => v as string | number | bigint | Buffer | null),
  );
}

export function getRow<T>(db: SqliteDb, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function allRows<T>(db: SqliteDb, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}
