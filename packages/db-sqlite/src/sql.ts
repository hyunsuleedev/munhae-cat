import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_INIT_SQL, PROJECT_INIT_SQL, PROJECT_MASTER_CONTAINER_SQL, PROJECT_NODE_ROLES_SQL } from "./embedded-sql.ts";

const EMBEDDED: Record<string, string> = {
  "sqlite/001_init.sql": PROJECT_INIT_SQL,
  "sqlite/002_document_node_roles.sql": PROJECT_NODE_ROLES_SQL,
  "sqlite/003_project_master_container.sql": PROJECT_MASTER_CONTAINER_SQL,
  "app/001_init.sql": APP_INIT_SQL,
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
