import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { schema } from "./drizzle-schema.ts";
import type { SqliteDb } from "./sqlite.ts";

export type ProjectDatabase = BetterSQLite3Database<typeof schema>;

const connections = new WeakMap<SqliteDb, ProjectDatabase>();

/** Reuse the native connection so SQL migrations and domain writes share locks and transactions. */
export function orm(db: SqliteDb): ProjectDatabase {
  let connection = connections.get(db);
  if (!connection) {
    connection = drizzle(db, { schema });
    connections.set(db, connection);
  }
  return connection;
}
