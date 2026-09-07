import { describe, expect, it } from "vitest";
import { MunhaeError } from "@munhae/domain";
import { assertSqliteIntegrity, openSqlite } from "../src/index.ts";

describe("SQLite integrity boundary", () => {
  it("rejects referential-integrity violations as project corruption", () => {
    const db = openSqlite(":memory:");
    try {
      db.exec(`
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent(id)
        );
      `);
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO child (id, parent_id) VALUES (?, ?)").run("child-1", "missing-parent");
      db.pragma("foreign_keys = ON");

      expect(() => assertSqliteIntegrity(db)).toThrowError(MunhaeError);
      try {
        assertSqliteIntegrity(db);
      } catch (error) {
        expect((error as MunhaeError).code).toBe("sqlite_integrity_failed");
        expect((error as Error).message).toContain("foreign key check failed");
      }
    } finally {
      db.close();
    }
  });
});
