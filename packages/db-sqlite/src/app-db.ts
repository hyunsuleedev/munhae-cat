import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createId, nowIso } from "@munhae/domain";
import { migrateAppDb } from "./migrate.ts";
import { allRows, getRow } from "./rows.ts";
import { assertSqliteIntegrity, openSqlite, type SqliteDb } from "./sqlite.ts";
import type { RecentProject } from "./views.ts";

export type OpenAppDb = (userDataDir: string) => AppDb;

export type RuntimeSessionKey = {
  providerKind: "codex" | "claude" | "antigravity";
  projectId: string;
  threadId: string;
};

export class AppDb {
  constructor(private readonly db: SqliteDb) {}

  listRecent(): RecentProject[] {
    const rows = allRows<{
      project_id: string;
      display_name: string;
      package_path: string;
      last_opened_at: string;
      missing_at: string | null;
    }>(
      this.db,
      `SELECT project_id, display_name, package_path, last_opened_at, missing_at
       FROM app_recent_projects
       ORDER BY last_opened_at DESC`,
    );
    return rows.map((r) => ({
      projectId: r.project_id,
      displayName: r.display_name,
      packagePath: r.package_path,
      lastOpenedAt: r.last_opened_at,
      missing: r.missing_at != null,
    }));
  }

  upsertRecent(row: { projectId: string; displayName: string; packagePath: string }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO app_recent_projects (project_id, display_name, package_path, last_opened_at, missing_at)
         VALUES (@projectId, @displayName, @packagePath, @now, NULL)
         ON CONFLICT(project_id) DO UPDATE SET
           display_name = excluded.display_name,
           package_path = excluded.package_path,
           last_opened_at = excluded.last_opened_at,
           missing_at = NULL`,
      )
      .run({ ...row, now });
  }

  markMissing(packagePath: string): void {
    this.db
      .prepare(`UPDATE app_recent_projects SET missing_at = ? WHERE package_path = ?`)
      .run(nowIso(), packagePath);
  }

  getPreference(key: string): unknown {
    const row = getRow<{ value_json: string }>(this.db, `SELECT value_json FROM app_preferences WHERE key = ?`, key);
    if (!row) return undefined;
    return JSON.parse(row.value_json) as unknown;
  }

  setPreference(key: string, value: unknown): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO app_preferences (id, key, value_json, updated_at)
         VALUES (@id, @key, @value, @now)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run({ id: createId(), key, value: JSON.stringify(value), now });
  }

  getRuntimeSessionRef(key: RuntimeSessionKey): string | null {
    const row = getRow<{ provider_session_ref: string | null }>(
      this.db,
      `SELECT provider_session_ref FROM app_runtime_sessions
       WHERE provider_kind = ? AND project_id = ? AND thread_id = ?
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      key.providerKind,
      key.projectId,
      key.threadId,
    );
    return row?.provider_session_ref?.trim() || null;
  }

  setRuntimeSessionRef(key: RuntimeSessionKey, providerSessionRef: string): void {
    const ref = providerSessionRef.trim();
    if (!ref) throw new Error("provider session ref is required");
    this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM app_runtime_sessions
         WHERE provider_kind = ? AND project_id = ? AND thread_id = ?`,
      ).run(key.providerKind, key.projectId, key.threadId);
      this.db.prepare(
        `INSERT INTO app_runtime_sessions
           (id, provider_kind, project_id, thread_id, provider_session_ref, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(createId(), key.providerKind, key.projectId, key.threadId, ref, nowIso());
    })();
  }

  clearRuntimeSession(key: RuntimeSessionKey): void {
    this.db.prepare(
      `DELETE FROM app_runtime_sessions
       WHERE provider_kind = ? AND project_id = ? AND thread_id = ?`,
    ).run(key.providerKind, key.projectId, key.threadId);
  }

  close(): void {
    this.db.close();
  }
}

export const openAppDatabase: OpenAppDb = (userDataDir: string): AppDb => {
  mkdirSync(userDataDir, { recursive: true });
  const db = openSqlite(join(userDataDir, "app.sqlite3"));
  try {
    assertSqliteIntegrity(db);
    migrateAppDb(db);
    assertSqliteIntegrity(db);
    return new AppDb(db);
  } catch (error) {
    db.close();
    throw error;
  }
};
