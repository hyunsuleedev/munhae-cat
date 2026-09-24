import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openProject, openSqlite, seedDemoProject } from "../src/index.ts";
import { restoreV9SummaryFixture } from "./legacy-materials-fixture.ts";

it("removes legacy summaries without a backup and preserves all other version data", () => {
  const root = mkdtempSync(join(tmpdir(), "munhae-remove-summary-"));
  try {
    const seeded = seedDemoProject(root);
    const path = seeded.packagePath;
    seeded.close();
    const db = openSqlite(join(path, "project.sqlite3"));
    const tables = ["src_text_versions", "punctuation_versions"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    restoreV9SummaryFixture(db);
    for (const table of tables) db.exec(`UPDATE ${table} SET change_summary='legacy edit note'`);
    db.close();
    const files = readdirSync(path).filter(name => name.endsWith(".bak"));
    const migrated = openProject(path);
    migrated.close();
    const check = openSqlite(join(path, "project.sqlite3"));
    try {
      tables.forEach((table, index) => {
        expect(check.pragma(`table_info(${table})`)).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "change_summary" })]));
        expect(check.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(before[index]);
      });
      expect(check.prepare("SELECT schema_version FROM meta_project_state").get()).toEqual({ schema_version: 11 });
      expect(check.pragma("foreign_key_check")).toEqual([]);
      expect(check.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(readdirSync(path).filter(name => name.endsWith(".bak"))).toEqual(files);
    } finally { check.close(); }
    const reopened = openProject(path);
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
