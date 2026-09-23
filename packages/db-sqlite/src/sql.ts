import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REMOVE_CHANGE_SUMMARY_SQL,
  TERM_REVIEW_SQL,
  COMMENT_REFERENCES_SQL,
  APP_INIT_SQL,
  CONTEXT_WITHOUT_KIND_SQL,
  FULL_TEXT_SQL,
  REMOVE_PEOPLE_PLACES_SQL,
  READING_ANNOTATIONS_SQL,
  TRANSLATION_MATERIALS_SQL,
  PROJECT_INIT_SQL,
  REVIEW_COMMENTS_SQL,
} from "./embedded-sql.ts";

const EMBEDDED: Record<string, string> = {
  "sqlite/010_remove_change_summary.sql": REMOVE_CHANGE_SUMMARY_SQL,
  "sqlite/008_term_review.sql": TERM_REVIEW_SQL,
  "sqlite/009_comment_references.sql": COMMENT_REFERENCES_SQL,
  "sqlite/001_init.sql": PROJECT_INIT_SQL,
  "app/001_init.sql": APP_INIT_SQL,
  "sqlite/002_full_text_translation.sql": FULL_TEXT_SQL,
  "sqlite/003_context_without_kind.sql": CONTEXT_WITHOUT_KIND_SQL,
  "sqlite/004_review_comments.sql": REVIEW_COMMENTS_SQL,
  "sqlite/005_remove_people_places.sql": REMOVE_PEOPLE_PLACES_SQL,
  "sqlite/006_reading_annotations.sql": READING_ANNOTATIONS_SQL,
  "sqlite/007_translation_materials.sql": TRANSLATION_MATERIALS_SQL,
};

function migrationCandidates(rel: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "../migrations", rel),
    join(here, "../../../infra/migrations", rel),
    join(process.cwd(), "infra/migrations", rel),
    join(process.cwd(), "../../infra/migrations", rel),
  ];
}

export function loadMigrationSql(rel: string): string {
  const embedded = EMBEDDED[rel];
  if (embedded) return embedded;
  const tried = migrationCandidates(rel);
  for (const p of tried) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`migration SQL not found: ${rel} (searched ${tried.join(", ")})`);
}
