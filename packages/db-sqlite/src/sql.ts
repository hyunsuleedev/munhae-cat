import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_INIT_SQL,
  CONTEXT_WITHOUT_KIND_SQL,
  FULL_TEXT_SQL,
  PROJECT_INIT_SQL,
  REVIEW_COMMENTS_SQL,
} from "./embedded-sql.ts";

const EMBEDDED: Record<string, string> = {
  "sqlite/001_init.sql": PROJECT_INIT_SQL,
  "app/001_init.sql": APP_INIT_SQL,
  "sqlite/002_full_text_translation.sql": FULL_TEXT_SQL,
  "sqlite/003_context_without_kind.sql": CONTEXT_WITHOUT_KIND_SQL,
  "sqlite/004_review_comments.sql": REVIEW_COMMENTS_SQL,
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
