import { readFileSync } from "node:fs";
import { canonicalJsonHash } from "@munhae/domain";
import type { SqliteDb } from "../src/sqlite.ts";
import { restoreV6MaterialsFixture } from "./legacy-materials-fixture.ts";

/** Reconstruct the v4 knowledge schema before an older-version upgrade test. */
export function restoreV4KnowledgeFixture(db: SqliteDb): void {
  restoreV6MaterialsFixture(db);
  db.exec("DROP TABLE IF EXISTS reading_annotations");
  const baseline = readFileSync(new URL("../migrations/sqlite/001_init.sql", import.meta.url), "utf8");
  for (const table of ["persons", "places"]) {
    const sql = baseline.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\) STRICT;`))?.[0];
    if (!sql) throw new Error(`Missing legacy ${table} schema`);
    db.exec(sql);
  }
  db.exec("DROP INDEX IF EXISTS idx_document_nodes_author; ALTER TABLE document_nodes ADD COLUMN author_person_id TEXT REFERENCES persons(id)");
  const authors = db.prepare(`SELECT n.id, n.project_id, n.author_text, n.created_at, n.updated_at,
    p.created_by_actor_id FROM document_nodes n JOIN core_projects p ON p.id=n.project_id
    WHERE n.author_text IS NOT NULL`).all() as Array<{
      id: string; project_id: string; author_text: string; created_at: string;
      updated_at: string; created_by_actor_id: string;
    }>;
  const personIds = new Map<string, string>();
  for (const author of authors) {
    const key = JSON.stringify([author.project_id, author.author_text]);
    let personId = personIds.get(key);
    if (!personId) {
      personId = `legacy-author-${author.id}`;
      personIds.set(key, personId);
      const content = { preferredName: author.author_text, hanjaName: null, reading: null,
        aliases: [], descriptionMd: null, dateText: null };
      db.prepare(`INSERT INTO persons (id,project_id,preferred_name,content_hash,
        created_by_actor_id,updated_by_actor_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(personId, author.project_id, author.author_text,
          canonicalJsonHash(content), author.created_by_actor_id, author.created_by_actor_id,
          author.created_at, author.updated_at);
    }
    db.prepare("UPDATE document_nodes SET author_person_id=? WHERE id=?").run(personId, author.id);
  }
  db.exec(`ALTER TABLE document_nodes DROP COLUMN author_text;
    CREATE INDEX idx_document_nodes_author ON document_nodes(project_id,author_person_id) WHERE author_person_id IS NOT NULL;
    DELETE FROM meta_schema_migrations WHERE version >= 5;
    UPDATE meta_project_state SET schema_version=4;`);
}
