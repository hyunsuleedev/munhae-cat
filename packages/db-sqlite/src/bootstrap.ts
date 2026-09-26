import { existsSync } from "node:fs";
import {
  canonicalJsonHash,
  createId,
  MunhaeError,
  nowIso,
  sha256Hex,
} from "@munhae/domain";
import {
  acquireLock,
  createPackageDir,
  readManifest,
  releaseLock,
  resolvePackagePath,
} from "@munhae/project-format";
import {
  assertProjectDbBaseline,
  migrateProjectDb,
  PROJECT_SCHEMA_VERSION,
} from "./migrate.ts";
import { eq } from "drizzle-orm";
import { orm } from "./drizzle-db.ts";
import { schema } from "./drizzle-schema.ts";
import { assertSqliteIntegrity, openSqlite, type SqliteDb } from "./sqlite.ts";

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
  projectId?: string;
}): BootstrappedProject {
  const projectId = opts.projectId ?? createId();
  const createdAt = nowIso();
  const { packagePath } = createPackageDir({
    parentDir: opts.parentDir,
    title: opts.title,
    projectId,
    createdAt,
  });
  acquireLock(packagePath);
  const dbPath = resolvePackagePath(packagePath, "project.sqlite3");
  let db: SqliteDb | null = null;
  try {
    db = openSqlite(dbPath);
    migrateProjectDb(db);
    assertSqliteIntegrity(db);
    const seeded = seedCore(db, {
      projectId,
      title: opts.title,
      createdAt,
      actorDisplayName: opts.actorDisplayName ?? "로컬 사용자",
    });
    assertSqliteIntegrity(db);
    return { db, packagePath, projectId, title: opts.title, createdAt, ...seeded };
  } catch (err) {
    db?.close();
    releaseLock(packagePath);
    throw err;
  }
}

export function openProjectDb(packagePath: string): BootstrappedProject {
  const manifest = readManifest(packagePath);
  const dbPath = resolvePackagePath(packagePath, manifest.database);
  if (!existsSync(dbPath)) {
    throw new MunhaeError("missing_database", "project.sqlite3 is missing");
  }
  acquireLock(packagePath);
  let db: SqliteDb | null = null;
  try {
    assertProjectDbBaseline(dbPath);
    db = openSqlite(dbPath);
    const migration = db.prepare("SELECT max(version) AS version FROM meta_schema_migrations").get() as {version:number};
    // Retain backups for older translation/schema upgrades. The v4 knowledge
    // removal intentionally discards person/place data without an archive.
    const upgrade = migration.version === 1 ? "full-text" : migration.version === 2 ? "context-without-kind" : migration.version === 3 ? "review-comments" : migration.version === 5 ? "reading-annotations" : migration.version === 6 ? "translation-materials" : migration.version === 7 ? "term-review" : migration.version === 8 ? "comment-references" : migration.version === 10 ? "reading-translation-quote" : migration.version === 11 ? "translation-groups" : null;
    if (migration.version < PROJECT_SCHEMA_VERSION && upgrade) {
      const backupPath = `${dbPath}.before-${upgrade}-${Date.now()}.bak`;
      db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    }
    migrateProjectDb(db);

    assertSqliteIntegrity(db);
    const project = orm(db).select({
      id: schema.core_projects.id,
      title: schema.core_projects.title,
      created_at: schema.core_projects.created_at,
    }).from(schema.core_projects).where(eq(schema.core_projects.id, manifest.projectId)).get();
    if (!project) throw new MunhaeError("invalid_project", "core_projects row missing");
    const actors = loadActors(db);
    const heads = schema.core_translation_policy_heads;
    const policies = schema.core_translation_policies;
    const policy = orm(db).select({ policy_id: heads.policy_id, current_version_id: heads.current_version_id })
      .from(heads).innerJoin(policies, eq(policies.id, heads.policy_id))
      .where(eq(policies.project_id, project.id)).limit(1).get();
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
    db?.close();
    releaseLock(packagePath);
    const code = typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
    const message = err instanceof Error ? err.message : "";
    if (
      !(err instanceof MunhaeError) &&
      (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB" || /malformed database|disk image is malformed/i.test(message))
    ) {
      throw new MunhaeError("sqlite_integrity_failed", `SQLite integrity check failed: ${message || code}`);
    }
    throw err;
  }
}

export function loadActors(db: SqliteDb): ProjectActors {
  const rows = orm(db).select({ id: schema.core_actors.id, actor_kind: schema.core_actors.actor_kind })
    .from(schema.core_actors).all();
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
  orm(db).insert(schema.core_actors).values({
    id: systemId,
    actor_kind: "system",
    display_name: "Munhae Studio",
    subject_uri: "munhae:system",
    metadata_json: null,
    created_at: opts.createdAt,
  }).run();
  orm(db).insert(schema.core_actors).values({
    id: humanId,
    actor_kind: "human",
    display_name: opts.actorDisplayName,
    subject_uri: "munhae:local-user",
    metadata_json: null,
    created_at: opts.createdAt,
  }).run();
  orm(db).insert(schema.core_actors).values({
    id: llmId,
    actor_kind: "llm",
    display_name: "Claude",
    subject_uri: "munhae:agent:claude",
    metadata_json: null,
    created_at: opts.createdAt,
  }).run();

  orm(db).insert(schema.core_projects).values({
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
  }).run();

  orm(db).insert(schema.meta_project_state).values({
    project_id: opts.projectId,
    schema_version: PROJECT_SCHEMA_VERSION,
    format_version: 1,
    last_compacted_at: null,
    integrity_hash: sha256Hex(opts.projectId),
  }).run();

  const policyId = createId();
  const policyVersionId = createId();
  const policyBody = {
    sourceLanguage: "lzh",
    targetLocale: "ko",
    audience: "연구자·일반 독자",
    hanjaPolicy: "중요 용어는 한국어(漢字)로 병기한다.",
    supplementPolicy: "원문 밖 보충은 별도 표시한다.",
    uncertaintyPolicy: "textual uncertainty와 interpretive uncertainty를 분리한다.",
  };
  orm(db).insert(schema.core_translation_policies).values({
    id: policyId,
    project_id: opts.projectId,
    name: "기본 번역 원칙",
    created_at: opts.createdAt,
  }).run();
  orm(db).insert(schema.core_translation_policy_versions).values({
    id: policyVersionId,
    policy_id: policyId,
    parent_version_id: null,
    version_no: 1,
    source_language: policyBody.sourceLanguage,
    target_locale: policyBody.targetLocale,
    audience: policyBody.audience,
    hanja_policy: policyBody.hanjaPolicy,
    supplement_policy: policyBody.supplementPolicy,
    uncertainty_policy: policyBody.uncertaintyPolicy,
    style_guide_md: "현재 문서 전체를 빠짐없이 자연스러운 한국어로 번역한다.",
    rules_json: JSON.stringify(policyBody),
    state: "confirmed",
    content_hash: canonicalJsonHash(policyBody),
    created_by_actor_id: humanId,
    created_at: opts.createdAt,
  }).run();
  orm(db).insert(schema.core_translation_policy_heads).values({
    policy_id: policyId,
    current_version_id: policyVersionId,
    confirmed_version_id: policyVersionId,
    lock_version: 1,
    updated_at: opts.createdAt,
  }).run();

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
