import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalJsonHash } from "@munhae/domain";
import { openProject, openSqlite, seedDemoProject } from "../src/index.ts";
import { contextItemContentHash } from "../src/knowledge-content.ts";
import { restoreV4KnowledgeFixture } from "./legacy-knowledge-fixture.ts";
import { withMaterialDefaults } from "./legacy-materials-fixture.ts";

it("upgrades v2 context without classifications, preserving text, scopes, settings and historical requests", () => {
  const parent = mkdtempSync(join(tmpdir(), "munhae-context-upgrade-"));
  const repo = seedDemoProject(parent);
  const path = repo.packagePath;
  const cards = repo.getKnowledge().contextItems.filter((item) => item.source === "context_item");
  repo.setContextItemEnabled({ id: cards[0]!.id, enabled: false, expectedLockVersion: cards[0]!.lockVersion });
  repo.close();
  const dbPath = join(path, "project.sqlite3");
  const db = openSqlite(dbPath);
  try {
    // Legacy archive fixture: the current API only supports deletion.
    const archived = cards[1]!;
    db.prepare(`UPDATE context_items SET archived_at = ?, enabled = 0,
      content_hash = ?, lock_version = lock_version + 1 WHERE id = ?`)
      .run(new Date().toISOString(), contextItemContentHash({ ...archived, enabled: false }), archived.id);
    restoreV4KnowledgeFixture(db);
    // Restore the previous column and migration state to exercise the real upgrade path.
    db.exec(`ALTER TABLE context_items ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'external_evidence';
      DROP TABLE review_comments;
      DELETE FROM meta_schema_migrations WHERE version >= 3;
      UPDATE meta_project_state SET schema_version = 2;`);
    const legacy = db.prepare("SELECT * FROM context_items ORDER BY id").all() as Array<{
      id: string; scope_id: string; title: string; content_md: string;
      priority: number; enabled: number; item_kind: string;
    }>;
    for (const row of legacy) {
      db.prepare("UPDATE context_items SET content_hash = ? WHERE id = ?").run(canonicalJsonHash({
        scopeKind: "document_node", scopeId: row.scope_id, itemKind: row.item_kind,
        title: row.title, contentMd: row.content_md, priority: row.priority, enabled: row.enabled === 1,
      }), row.id);
    }
    const before = db.prepare("SELECT * FROM context_items ORDER BY id").all() as Array<Record<string, unknown>>;
    const messages = db.prepare("SELECT * FROM chat_messages ORDER BY id").all();
    const artifacts = db.prepare("SELECT * FROM provenance_artifacts ORDER BY id").all();
    db.close();

    const reopened = openProject(path);
    try {
      expect(reopened.getKnowledge().contextItems.every((item) => !("itemKind" in item))).toBe(true);
    } finally {
      reopened.close();
    }
    const check = openSqlite(dbPath);
    try {
      expect(check.pragma("table_info(context_items)")).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "item_kind" })]));
      const after = check.prepare("SELECT * FROM context_items ORDER BY id").all();
      expect(after).toEqual(before.map(({ item_kind: _kind, content_hash: _hash, ...row }) => ({
        ...withMaterialDefaults(row),
        content_hash: contextItemContentHash({
          scopeId: row.scope_id as string, title: row.title as string, contentMd: row.content_md as string,
          priority: row.priority as number, enabled: row.enabled === 1,
        }),
      })));
      expect(check.prepare("SELECT * FROM chat_messages ORDER BY id").all()).toEqual(messages);
      expect(check.prepare("SELECT * FROM provenance_artifacts ORDER BY id").all()).toEqual(artifacts);
      expect(check.pragma("foreign_key_check")).toEqual([]);
      expect(check.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(check.prepare("SELECT schema_version FROM meta_project_state").get()).toEqual({ schema_version: 12 });
      const backups = readdirSync(path).filter((name) => name.includes(".before-context-without-kind-"));
      expect(backups).toHaveLength(1);
      const backup = openSqlite(join(path, backups[0]!));
      try {
        expect(backup.prepare("SELECT * FROM context_items ORDER BY id").all()).toEqual(before);
      } finally {
        backup.close();
      }
    } finally {
      check.close();
    }
    const again = openProject(path);
    again.close();
    expect(readdirSync(path).filter((name) => name.includes(".before-context-without-kind-"))).toHaveLength(1);
  } finally {
    if (db.open) db.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
