import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJsonHash,
  createId,
  MunhaeError,
  nowIso,
  sha256Hex,
} from "@munhae/domain";
import { acquireLock, createPackageDir, readManifest, releaseLock } from "@munhae/project-format";
import { migrateProjectDb } from "./migrate.ts";
import { getRow, insertRow } from "./rows.ts";
import { openSqlite, type SqliteDb } from "./sqlite.ts";

export type ProjectActors = {
  humanId: string;
  systemId: string;
  llmId: string;
};

export type BootstrappedProject = {
  db: SqliteDb;
  packagePath: string;
  projectId: string;
  title: string;
  actors: ProjectActors;
  policyId: string;
  policyVersionId: string;
  createdAt: string;
};

export function bootstrapEmptyProject(opts: {
  title: string;
  parentDir: string;
  actorDisplayName?: string;
}): BootstrappedProject {
  const projectId = createId();
  const createdAt = nowIso();
  const { packagePath } = createPackageDir({
    parentDir: opts.parentDir,
    title: opts.title,
    projectId,
    createdAt,
  });
  acquireLock(packagePath);
  const dbPath = join(packagePath, "project.sqlite3");
  const db = openSqlite(dbPath);
  try {
    migrateProjectDb(db);
    const seeded = seedCore(db, {
      projectId,
      title: opts.title,
      createdAt,
      actorDisplayName: opts.actorDisplayName ?? "로컬 사용자",
    });
    return { db, packagePath, projectId, title: opts.title, createdAt, ...seeded };
  } catch (err) {
    db.close();
    releaseLock(packagePath);
    throw err;
  }
}

export function openProjectDb(packagePath: string): BootstrappedProject {
  const manifest = readManifest(packagePath);
  const dbPath = join(packagePath, manifest.database);
  if (!existsSync(dbPath)) {
    throw new MunhaeError("missing_database", "project.sqlite3 is missing");
  }
  acquireLock(packagePath);
  const db = openSqlite(dbPath);
  try {
    migrateProjectDb(db);
    const project = getRow<{ id: string; title: string; created_at: string }>(
      db,
      `SELECT id, title, created_at FROM core_projects WHERE id = ?`,
      manifest.projectId,
    );
    if (!project) throw new MunhaeError("invalid_project", "core_projects row missing");
    const actors = loadActors(db);
    const policy = getRow<{ policy_id: string; current_version_id: string }>(
      db,
      `SELECT h.policy_id, h.current_version_id
       FROM core_translation_policy_heads h
       JOIN core_translation_policies p ON p.id = h.policy_id
       WHERE p.project_id = ?
       LIMIT 1`,
      project.id,
    );
    if (!policy) throw new MunhaeError("invalid_project", "translation policy missing");
    return {
      db,
      packagePath,
      projectId: project.id,
      title: project.title,
      createdAt: project.created_at,
      actors,
      policyId: policy.policy_id,
      policyVersionId: policy.current_version_id,
    };
  } catch (err) {
    db.close();
    releaseLock(packagePath);
    throw err;
  }
}

export function loadActors(db: SqliteDb): ProjectActors {
  const rows = db.prepare(`SELECT id, actor_kind FROM core_actors`).all() as Array<{
    id: string;
    actor_kind: string;
  }>;
  const human = rows.find((r) => r.actor_kind === "human");
  const system = rows.find((r) => r.actor_kind === "system");
  const llm = rows.find((r) => r.actor_kind === "llm");
  if (!human || !system || !llm) throw new MunhaeError("invalid_project", "required actors missing");
  return { humanId: human.id, systemId: system.id, llmId: llm.id };
}

function seedCore(
  db: SqliteDb,
  opts: { projectId: string; title: string; createdAt: string; actorDisplayName: string },
): { actors: ProjectActors; policyId: string; policyVersionId: string } {
  const humanId = createId();
  const systemId = createId();
  const llmId = createId();
  insertRow(db, "core_actors", {
    id: systemId,
    actor_kind: "system",
    display_name: "Munhae Studio",
    subject_uri: "munhae:system",
    metadata_json: null,
    created_at: opts.createdAt,
  });
  insertRow(db, "core_actors", {
    id: humanId,
    actor_kind: "human",
    display_name: opts.actorDisplayName,
    subject_uri: "munhae:local-user",
    metadata_json: null,
    created_at: opts.createdAt,
  });
  insertRow(db, "core_actors", {
    id: llmId,
    actor_kind: "llm",
    display_name: "Claude",
    subject_uri: "munhae:agent:claude",
    metadata_json: null,
    created_at: opts.createdAt,
  });

  insertRow(db, "core_projects", {
    id: opts.projectId,
    title: opts.title,
    slug: slugify(opts.title),
    description: null,
    default_target_locale: "ko",
    status: "active",
    created_by_actor_id: humanId,
    created_at: opts.createdAt,
    updated_at: opts.createdAt,
    archived_at: null,
  });

  insertRow(db, "meta_project_state", {
    project_id: opts.projectId,
    schema_version: 3,
    format_version: 1,
    last_compacted_at: null,
    integrity_hash: sha256Hex(opts.projectId),
  });

  const policyId = createId();
  const policyVersionId = createId();
  const policyBody = {
    sourceLanguage: "lzh",
    targetLocale: "ko",
    audience: "연구자·일반 독자",
    workflowMode: "two_step",
    reflectionRequired: true,
    hanjaPolicy: "중요 용어는 한국어(漢字)로 병기한다.",
    supplementPolicy: "원문 밖 보충은 별도 표시한다.",
    uncertaintyPolicy: "textual uncertainty와 interpretive uncertainty를 분리한다.",
  };
  insertRow(db, "core_translation_policies", {
    id: policyId,
    project_id: opts.projectId,
    name: "two_step + Reflection",
    created_at: opts.createdAt,
  });
  insertRow(db, "core_translation_policy_versions", {
    id: policyVersionId,
    policy_id: policyId,
    parent_version_id: null,
    version_no: 1,
    source_language: policyBody.sourceLanguage,
    target_locale: policyBody.targetLocale,
    audience: policyBody.audience,
    workflow_mode: policyBody.workflowMode,
    reflection_required: 1,
    hanja_policy: policyBody.hanjaPolicy,
    supplement_policy: policyBody.supplementPolicy,
    uncertainty_policy: policyBody.uncertaintyPolicy,
    style_guide_md: "직역안과 독자안을 함께 작성하고 Reflection을 남긴다.",
    rules_json: JSON.stringify(policyBody),
    state: "confirmed",
    content_hash: canonicalJsonHash(policyBody),
    created_by_actor_id: humanId,
    created_at: opts.createdAt,
  });
  insertRow(db, "core_translation_policy_heads", {
    policy_id: policyId,
    current_version_id: policyVersionId,
    confirmed_version_id: policyVersionId,
    lock_version: 1,
    updated_at: opts.createdAt,
  });

  return {
    actors: { humanId, systemId, llmId },
    policyId,
    policyVersionId,
  };
}

function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return ascii || "project";
}
