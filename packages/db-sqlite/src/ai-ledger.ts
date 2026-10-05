import {
  canonicalJson,
  canonicalJsonHash,
  createId,
  MunhaeError,
  nowIso,
  sha256Hex,
  utf8ByteLength,
  validateTranslationEnvelope,
  type TranslationEnvelope,
  type TranslationEnvelopeValidation,
  type TranslationEnvelopeValidationFinding,
} from "@munhae/domain";
import type { ProjectActors } from "./bootstrap.ts";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { orm } from "./drizzle-db.ts";
import { schema as tables } from "./drizzle-schema.ts";
import type { SqliteDb } from "./sqlite.ts";
import { insertVersionBlocks, loadAnchors, type BlockDraft } from "./translation.ts";

export type TranslationHeadBaseline = {
  translationId: string;
  currentVersionId: string;
  lockVersion: number;
} | null;

export type ReserveTranslationRunInput = {
  documentNodeId: string;
  documentTitle: string;
  agentId: "codex" | "claude" | "antigravity";
  requestedModel: string | null;
  reasoningLevel: string | null;
  serviceTier: string | null;
  runtimeVersion: string | null;
  requestManifestJson: string;
  requestText: string;
  promptContractVersion: string;
};

export type ReservedTranslationRun = {
  messageId: string;
  threadId: string;
  requestArtifactId: string;
  requestHash: string;
};

export type StoreTranslationResponseInput = {
  messageId: string;
  rawResponse: string;
  eventsJsonl: string;
  usage: unknown;
  resolvedModel: string | null;
  runtimeVersion: string | null;
};

export type TranslationRunFailureMetadata = {
  eventsJsonl?: string;
  usage?: unknown;
  resolvedModel?: string | null;
  runtimeVersion?: string | null;
};

export type RecordInvalidTranslationResponseInput = StoreTranslationResponseInput & {
  error: { code: string; message: string };
};

export type ApplyTranslationEnvelopeInput = {
  messageId: string;
  documentNodeId: string;
  anchorSetId: string;
  sourceTextVersionId: string;
  punctuationVersionId: string;
  policyVersionId: string;
  expectedHead: TranslationHeadBaseline;
  rawResponse: string;
};

export type AppliedTranslationEnvelope = {
  messageId: string;
  validation: TranslationEnvelopeValidation;
  version: {
    translationId: string;
    versionId: string;
    validationState: "valid";
  } | null;
  idempotent: boolean;
};

type ArtifactKind = "exact_llm_request" | "llm_response" | "agent_events";

function insertArtifact(
  db: SqliteDb,
  projectId: string,
  kind: ArtifactKind,
  payloadText: string,
  opts: { payloadJson?: string | null; schemaName?: string | null; schemaVersion?: number | null } = {},
): { id: string; rawHash: string; canonicalHash: string } {
  const rawHash = sha256Hex(payloadText);
  let canonicalHash = rawHash;
  // A provider response is evidence: byte-for-byte different payloads must never
  // collapse to an earlier artifact merely because their parsed JSON is equal.
  if (opts.payloadJson && kind !== "llm_response") {
    try {
      canonicalHash = canonicalJsonHash(JSON.parse(opts.payloadJson) as unknown);
    } catch {
      // Invalid provider output is deliberately content-addressed by its exact bytes.
    }
  }
  const existing = orm(db)
    .select({
      id: tables.provenance_artifacts.id,
      raw_sha256: tables.provenance_artifacts.raw_sha256,
    })
    .from(tables.provenance_artifacts)
    .where(
      and(
        eq(tables.provenance_artifacts.project_id, projectId),
        eq(tables.provenance_artifacts.artifact_kind, kind),
        eq(tables.provenance_artifacts.canonical_sha256, canonicalHash),
      ),
    )
    .get();
  if (existing) return { id: existing.id, rawHash, canonicalHash };
  const id = createId();
  orm(db)
    .insert(tables.provenance_artifacts)
    .values({
      id,
      project_id: projectId,
      artifact_kind: kind,
      media_type:
        kind === "agent_events"
          ? "application/x-ndjson"
          : opts.payloadJson
            ? "application/json"
            : "text/plain",
      payload_text: payloadText,
      payload_json: opts.payloadJson ?? null,
      storage_asset_id: null,
      raw_sha256: rawHash,
      canonical_sha256: canonicalHash,
      byte_size: utf8ByteLength(payloadText),
      schema_name: opts.schemaName ?? null,
      schema_version: opts.schemaVersion ?? null,
      classification: "project_private",
      retention_class: "project_history",
      redaction_state: "not_required",
      created_at: nowIso(),
    })
    .run();
  return { id, rawHash, canonicalHash };
}

type StoredTranslationSnapshot = {
  documentNodeId: string;
  sourceTextId: string;
  sourceTextVersionId: string;
  punctuationVersionId: string;
  policyVersionId: string;
  anchorSetId: string;
  targetLocale: string;
  expectedHead: TranslationHeadBaseline;
};

type StoredTranslationManifest = {
  schemaVersion: number;
  taskKind: "translation";
  requestHash: string;
  snapshot: StoredTranslationSnapshot;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MunhaeError("invalid_request_manifest", `request manifest ${key} is missing`);
  }
  return value;
}

function assertOnlyManifestKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const extras = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (extras.length > 0) {
    throw new MunhaeError("invalid_request_manifest", `${label} has unsupported fields: ${extras.join(", ")}`);
  }
}

function parseTranslationManifest(value: unknown): StoredTranslationManifest {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.taskKind !== "translation") {
    throw new MunhaeError("invalid_request_manifest", "request manifest header is invalid");
  }
  if (!isRecord(value.snapshot)) {
    throw new MunhaeError("invalid_request_manifest", "request manifest snapshot is missing");
  }
  assertOnlyManifestKeys(value, [
    "schemaVersion",
    "taskKind",
    "promptContractVersion",
    "requestHash",
    "snapshot",
    "anchorSetId",
    "sources",
    "selectionOverrides",
  ], "request manifest");
  const rawSnapshot = value.snapshot;
  assertOnlyManifestKeys(rawSnapshot, [
    "documentNodeId",
    "sourceTextId",
    "sourceTextVersionId",
    "punctuationVersionId",
    "policyVersionId",
    "anchorSetId",
    "targetLocale",
    "expectedHead",
  ], "request manifest snapshot");
  const rawHead = rawSnapshot.expectedHead;
  let expectedHead: TranslationHeadBaseline;
  if (rawHead === null) {
    expectedHead = null;
  } else if (isRecord(rawHead) && Number.isInteger(rawHead.lockVersion) && (rawHead.lockVersion as number) >= 1) {
    assertOnlyManifestKeys(rawHead, ["translationId", "currentVersionId", "lockVersion"], "translation head");
    expectedHead = {
      translationId: requireString(rawHead, "translationId"),
      currentVersionId: requireString(rawHead, "currentVersionId"),
      lockVersion: rawHead.lockVersion as number,
    };
  } else {
    throw new MunhaeError("invalid_request_manifest", "request manifest translation head is invalid");
  }
  return {
    schemaVersion: 2,
    taskKind: "translation",
    requestHash: requireString(value, "requestHash"),
    snapshot: {
      documentNodeId: requireString(rawSnapshot, "documentNodeId"),
      sourceTextId: requireString(rawSnapshot, "sourceTextId"),
      sourceTextVersionId: requireString(rawSnapshot, "sourceTextVersionId"),
      punctuationVersionId: requireString(rawSnapshot, "punctuationVersionId"),
      policyVersionId: requireString(rawSnapshot, "policyVersionId"),
      anchorSetId: requireString(rawSnapshot, "anchorSetId"),
      targetLocale: requireString(rawSnapshot, "targetLocale"),
      expectedHead,
    },
  };
}

function requireCanonicalManifest(requestManifestJson: string): { json: string; hash: string; manifest: StoredTranslationManifest } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestManifestJson) as unknown;
  } catch {
    throw new MunhaeError("invalid_request_manifest", "request manifest is not valid JSON");
  }
  const json = canonicalJson(parsed);
  if (json !== requestManifestJson) {
    throw new MunhaeError("invalid_request_manifest", "request manifest must use canonical JSON");
  }
  return { json, hash: sha256Hex(json), manifest: parseTranslationManifest(parsed) };
}

function findOrCreateDocumentThread(
  db: SqliteDb,
  projectId: string,
  documentNodeId: string,
  humanActorId: string,
): string {
  const existing = orm(db)
    .select({ id: tables.chat_threads.id })
    .from(tables.chat_threads)
    .where(
      and(
        eq(tables.chat_threads.project_id, projectId),
        eq(tables.chat_threads.scope_kind, "document_node"),
        eq(tables.chat_threads.scope_id, documentNodeId),
        eq(tables.chat_threads.title, "AI 번역"),
      ),
    )
    .orderBy(tables.chat_threads.created_at)
    .limit(1)
    .get();
  if (existing) return existing.id;
  const id = createId();
  orm(db)
    .insert(tables.chat_threads)
    .values({
      id,
      project_id: projectId,
      title: "AI 번역",
      scope_kind: "document_node",
      scope_id: documentNodeId,
      created_by_actor_id: humanActorId,
      created_at: nowIso(),
    })
    .run();
  return id;
}

export function reserveTranslationRun(
  db: SqliteDb,
  projectId: string,
  actors: ProjectActors,
  input: ReserveTranslationRunInput,
): ReservedTranslationRun {
  return orm(db).transaction(() => {
    const manifest = requireCanonicalManifest(input.requestManifestJson);
    if (
      manifest.manifest.snapshot.documentNodeId !== input.documentNodeId ||
      manifest.manifest.requestHash !== sha256Hex(input.requestText)
    ) {
      throw new MunhaeError("invalid_request_manifest", "request manifest is not bound to this execution request");
    }
    const threadId = findOrCreateDocumentThread(
      db,
      projectId,
      input.documentNodeId,
      actors.humanId,
    );
    const busy = orm(db)
      .select({ id: tables.chat_messages.id })
      .from(tables.chat_messages)
      .where(
        and(
          eq(tables.chat_messages.thread_id, threadId),
          eq(tables.chat_messages.role, "assistant"),
          inArray(tables.chat_messages.state, ["queued", "running", "validating"]),
        ),
      )
      .limit(1)
      .get();
    if (busy) throw new MunhaeError("thread_busy", "이 문서의 AI 실행이 이미 진행 중입니다");

    const artifact = insertArtifact(db, projectId, "exact_llm_request", input.requestText);
    const previous = orm(db)
      .select({ id: tables.chat_messages.id })
      .from(tables.chat_messages)
      .where(eq(tables.chat_messages.thread_id, threadId))
      .orderBy(desc(tables.chat_messages.created_at), desc(sql`rowid`))
      .limit(1)
      .get();
    const now = nowIso();
    const userMessageId = createId();
    orm(db)
      .insert(tables.chat_messages)
      .values({
        id: userMessageId,
        project_id: projectId,
        thread_id: threadId,
        parent_message_id: previous?.id ?? null,
        role: "user",
        actor_id: actors.humanId,
        state: "completed",
        task_kind: "translation_request",
        output_validation_state: "not_applicable",
        completed_at: now,
        created_at: now,
      })
      .run();
    orm(db)
      .insert(tables.chat_message_parts)
      .values({
        id: createId(),
        project_id: projectId,
        message_id: userMessageId,
        ordinal: 1,
        part_kind: "text",
        text_content: "전체 문서 완성 번역 요청",
        structured_json: null,
        artifact_id: null,
      })
      .run();

    const messageId = createId();
    orm(db)
      .insert(tables.chat_messages)
      .values({
        id: messageId,
        project_id: projectId,
        thread_id: threadId,
        parent_message_id: userMessageId,
        role: "assistant",
        actor_id: actors.llmId,
        state: "running",
        agent_id: input.agentId,
        requested_model: input.requestedModel,
        resolved_model: null,
        reasoning_level: input.reasoningLevel,
        service_tier: input.serviceTier,
        runtime_version: input.runtimeVersion,
        task_kind: "translation",
        output_contract: "translation-envelope.v2",
        prompt_contract_version: input.promptContractVersion,
        request_manifest_json: manifest.json,
        request_manifest_hash: manifest.hash,
        request_artifact_id: artifact.id,
        response_artifact_id: null,
        events_artifact_id: null,
        output_validation_state: null,
        usage_json: null,
        error_json: null,
        started_at: now,
        completed_at: null,
        created_at: now,
      })
      .run();
    return {
      messageId,
      threadId,
      requestArtifactId: artifact.id,
      requestHash: artifact.rawHash,
    };
  });
}

export function storeTranslationResponse(
  db: SqliteDb,
  projectId: string,
  input: StoreTranslationResponseInput,
): { responseArtifactId: string; responseRawHash: string; eventsArtifactId: string | null } {
  return orm(db).transaction(() => {
    const message = orm(db)
      .select({
        id: tables.chat_messages.id,
        response_artifact_id: tables.chat_messages.response_artifact_id,
        events_artifact_id: tables.chat_messages.events_artifact_id,
        usage_json: tables.chat_messages.usage_json,
        resolved_model: tables.chat_messages.resolved_model,
        runtime_version: tables.chat_messages.runtime_version,
        role: tables.chat_messages.role,
        task_kind: tables.chat_messages.task_kind,
        state: tables.chat_messages.state,
        output_contract: tables.chat_messages.output_contract,
      })
      .from(tables.chat_messages)
      .where(
        and(
          eq(tables.chat_messages.id, input.messageId),
          eq(tables.chat_messages.project_id, projectId),
        ),
      )
      .get();
    if (!message || message.role !== "assistant" || message.task_kind !== "translation") {
      throw new MunhaeError("invalid_message", "translation assistant message not found");
    }
    if (message.response_artifact_id) {
      const existing = orm(db)
        .select({
          id: tables.provenance_artifacts.id,
          raw_sha256: tables.provenance_artifacts.raw_sha256,
        })
        .from(tables.provenance_artifacts)
        .where(eq(tables.provenance_artifacts.id, message.response_artifact_id))
        .get();
      if (!existing || existing.raw_sha256 !== sha256Hex(input.rawResponse)) {
        throw new MunhaeError("idempotency_conflict", "assistant message already has a different response");
      }
      if (
        message.state === "completed"
        || message.state === "validating"
        || message.state === "failed"
        || message.state === "canceled"
      ) {
        let eventsArtifactId = message.events_artifact_id;
        if (input.eventsJsonl) {
          if (eventsArtifactId) {
            const priorEvents = orm(db)
              .select({
                artifact_kind: tables.provenance_artifacts.artifact_kind,
                payload_text: tables.provenance_artifacts.payload_text,
              })
              .from(tables.provenance_artifacts)
              .where(
                and(
                  eq(tables.provenance_artifacts.id, eventsArtifactId),
                  eq(tables.provenance_artifacts.project_id, projectId),
                ),
              )
              .get();
            if (
              !priorEvents
              || priorEvents.artifact_kind !== "agent_events"
              || priorEvents.payload_text === null
              || !input.eventsJsonl.startsWith(priorEvents.payload_text)
            ) {
              throw new MunhaeError(
                "idempotency_conflict",
                "final agent events do not extend the stored execution events",
              );
            }
          }
          eventsArtifactId = insertArtifact(db, projectId, "agent_events", input.eventsJsonl).id;
        }
        const usageJson = input.usage === null || input.usage === undefined
          ? null
          : canonicalJson(input.usage);
        if (message.usage_json && usageJson && message.usage_json !== usageJson) {
          throw new MunhaeError("idempotency_conflict", "translation usage metadata already differs");
        }
        if (message.resolved_model && input.resolvedModel && message.resolved_model !== input.resolvedModel) {
          throw new MunhaeError("idempotency_conflict", "translation model metadata already differs");
        }
        if (message.runtime_version && input.runtimeVersion && message.runtime_version !== input.runtimeVersion) {
          throw new MunhaeError("idempotency_conflict", "translation runtime metadata already differs");
        }
        const updated = orm(db)
          .update(tables.chat_messages)
          .set({
            events_artifact_id: eventsArtifactId,
            usage_json: sql`coalesce(${tables.chat_messages.usage_json}, ${usageJson})`,
            resolved_model: sql`coalesce(${tables.chat_messages.resolved_model}, ${input.resolvedModel})`,
            runtime_version: sql`coalesce(${tables.chat_messages.runtime_version}, ${input.runtimeVersion})`,
          })
          .where(
            and(
              eq(tables.chat_messages.id, input.messageId),
              eq(tables.chat_messages.project_id, projectId),
              eq(tables.chat_messages.response_artifact_id, existing.id),
            ),
          )
          .run();
        if (updated.changes !== 1) {
          throw new MunhaeError("invalid_message_state", "translation response metadata changed concurrently");
        }
        return {
          responseArtifactId: existing.id,
          responseRawHash: existing.raw_sha256,
          eventsArtifactId,
        };
      }
    }
    if (message.state === "canceled" || message.state === "failed") {
      throw new MunhaeError("invalid_message_state", `cannot store a response for ${message.state} execution`);
    }
    if (message.state !== "running" && message.state !== "validating") {
      throw new MunhaeError("invalid_message_state", `cannot store a response while execution is ${message.state ?? "unknown"}`);
    }
    let payloadJson: string | null = null;
    try {
      payloadJson = canonicalJson(JSON.parse(input.rawResponse) as unknown);
    } catch {
      payloadJson = null;
    }
    const response = insertArtifact(db, projectId, "llm_response", input.rawResponse, {
      payloadJson,
      schemaName: message.output_contract?.startsWith("translation-text.") ? "translation-text" : message.output_contract === "translation-alignment.v1" ? "translation-alignment" : "translation-envelope",
      schemaVersion: message.output_contract === "translation-text.v1" || message.output_contract === "translation-alignment.v1" ? 1 : 2,
    });
    const events = input.eventsJsonl
      ? insertArtifact(db, projectId, "agent_events", input.eventsJsonl)
      : null;
    const updated = orm(db)
      .update(tables.chat_messages)
      .set({
        state: "validating",
        response_artifact_id: response.id,
        events_artifact_id: events?.id ?? null,
        usage_json:
          input.usage === null || input.usage === undefined
            ? null
            : canonicalJson(input.usage),
        resolved_model: sql`coalesce(${input.resolvedModel}, ${tables.chat_messages.resolved_model})`,
        runtime_version: sql`coalesce(${input.runtimeVersion}, ${tables.chat_messages.runtime_version})`,
        error_json: null,
      })
      .where(
        and(
          eq(tables.chat_messages.id, input.messageId),
          eq(tables.chat_messages.project_id, projectId),
          inArray(tables.chat_messages.state, ["running", "validating"]),
        ),
      )
      .run();
    if (updated.changes !== 1) {
      throw new MunhaeError("invalid_message_state", "translation execution state changed while storing its response");
    }
    return {
      responseArtifactId: response.id,
      responseRawHash: response.rawHash,
      eventsArtifactId: events?.id ?? null,
    };
  });
}

/**
 * Preserve a provider result that cannot be accepted as a domain command.
 * This terminal state deliberately stores the raw evidence while skipping all
 * translation-head mutations.
 */
export function recordInvalidTranslationResponse(
  db: SqliteDb,
  projectId: string,
  input: RecordInvalidTranslationResponseInput,
): { responseArtifactId: string; responseRawHash: string; eventsArtifactId: string | null } {
  return orm(db).transaction(() => {
    const stored = storeTranslationResponse(db, projectId, input);
    const current = orm(db)
      .select({
        state: tables.chat_messages.state,
        output_validation_state: tables.chat_messages.output_validation_state,
      })
      .from(tables.chat_messages)
      .where(
        and(
          eq(tables.chat_messages.id, input.messageId),
          eq(tables.chat_messages.project_id, projectId),
          eq(tables.chat_messages.role, "assistant"),
          eq(tables.chat_messages.task_kind, "translation"),
        ),
      )
      .get();
    if (
      (current?.state === "completed" && current.output_validation_state === "invalid_unapplied")
      || current?.state === "failed"
      || current?.state === "canceled"
    ) {
      return stored;
    }
    if (current?.state !== "validating") {
      throw new MunhaeError(
        "invalid_message_state",
        `cannot reject a translation response while execution is ${current?.state ?? "unknown"}`,
      );
    }
    const updated = orm(db)
      .update(tables.chat_messages)
      .set({
        state: "completed",
        output_validation_state: "invalid_unapplied",
        error_json: canonicalJson({
          code: input.error.code,
          message: input.error.message.slice(0, 800),
        }),
        completed_at: nowIso(),
      })
      .where(
        and(
          eq(tables.chat_messages.id, input.messageId),
          eq(tables.chat_messages.project_id, projectId),
          eq(tables.chat_messages.role, "assistant"),
          eq(tables.chat_messages.task_kind, "translation"),
          eq(tables.chat_messages.state, "validating"),
        ),
      )
      .run();
    if (updated.changes !== 1) {
      throw new MunhaeError("invalid_message_state", "translation execution changed while rejecting its response");
    }
    return stored;
  });
}

function assertSnapshotDependencies(
  db: SqliteDb,
  projectId: string,
  input: ApplyTranslationEnvelopeInput,
): { sourceTextId: string; targetLocale: string } {
  const row = orm(db)
    .select({
      source_text_id: tables.src_text_versions.source_text_id,
      target_locale: tables.core_translation_policy_versions.target_locale,
    })
    .from(tables.translation_anchor_sets)
    .innerJoin(
      tables.src_text_versions,
      eq(
        tables.src_text_versions.id,
        tables.translation_anchor_sets.source_text_version_id,
      ),
    )
    .innerJoin(
      tables.src_text_heads,
      and(
        eq(
          tables.src_text_heads.source_text_id,
          tables.src_text_versions.source_text_id,
        ),
        eq(
          tables.src_text_heads.project_id,
          tables.translation_anchor_sets.project_id,
        ),
        eq(
          tables.src_text_heads.current_version_id,
          tables.translation_anchor_sets.source_text_version_id,
        ),
      ),
    )
    .innerJoin(
      tables.punctuation_versions,
      eq(
        tables.punctuation_versions.id,
        tables.translation_anchor_sets.punctuation_version_id,
      ),
    )
    .innerJoin(
      tables.punctuation_heads,
      and(
        eq(
          tables.punctuation_heads.punctuation_set_id,
          tables.punctuation_versions.punctuation_set_id,
        ),
        eq(
          tables.punctuation_heads.project_id,
          tables.translation_anchor_sets.project_id,
        ),
        eq(
          tables.punctuation_heads.current_version_id,
          tables.translation_anchor_sets.punctuation_version_id,
        ),
      ),
    )
    .innerJoin(
      tables.core_translation_policy_versions,
      eq(tables.core_translation_policy_versions.id, input.policyVersionId),
    )
    .innerJoin(
      tables.core_translation_policies,
      and(
        eq(
          tables.core_translation_policies.id,
          tables.core_translation_policy_versions.policy_id,
        ),
        eq(
          tables.core_translation_policies.project_id,
          tables.translation_anchor_sets.project_id,
        ),
      ),
    )
    .where(
      and(
        eq(tables.translation_anchor_sets.id, input.anchorSetId),
        eq(tables.translation_anchor_sets.project_id, projectId),
        eq(tables.translation_anchor_sets.document_node_id, input.documentNodeId),
        eq(
          tables.translation_anchor_sets.source_text_version_id,
          input.sourceTextVersionId,
        ),
        eq(
          tables.translation_anchor_sets.punctuation_version_id,
          input.punctuationVersionId,
        ),
        eq(
          tables.punctuation_versions.source_text_version_id,
          tables.translation_anchor_sets.source_text_version_id,
        ),
        eq(tables.core_translation_policy_versions.id, input.policyVersionId),
      ),
    )
    .get();
  if (!row) {
    throw new MunhaeError(
      "stale_request",
      "AI 실행 중 원문 또는 표점안이 바뀌어 이 결과를 현재 번역안으로 적용할 수 없습니다",
    );
  }
  return { sourceTextId: row.source_text_id, targetLocale: row.target_locale };
}

function validateMessageResponse(
  db: SqliteDb,
  projectId: string,
  messageId: string,
  rawResponse: string,
): void {
  const row = orm(db)
    .select({
      role: tables.chat_messages.role,
      task_kind: tables.chat_messages.task_kind,
      response_artifact_id: tables.chat_messages.response_artifact_id,
      raw_sha256: tables.provenance_artifacts.raw_sha256,
    })
    .from(tables.chat_messages)
    .leftJoin(
      tables.provenance_artifacts,
      eq(
        tables.provenance_artifacts.id,
        tables.chat_messages.response_artifact_id,
      ),
    )
    .where(
      and(
        eq(tables.chat_messages.id, messageId),
        eq(tables.chat_messages.project_id, projectId),
      ),
    )
    .get();
  if (!row || row.role !== "assistant" || row.task_kind !== "translation" || !row.response_artifact_id) {
    throw new MunhaeError("invalid_message", "stored translation response not found");
  }
  if (row.raw_sha256 !== sha256Hex(rawResponse)) {
    throw new MunhaeError("idempotency_conflict", "response bytes do not match the assistant message artifact");
  }
}

function requireBoundManifestForApply(
  db: SqliteDb,
  projectId: string,
  input: ApplyTranslationEnvelopeInput,
): StoredTranslationSnapshot {
  const row = orm(db)
    .select({
      state: tables.chat_messages.state,
      request_manifest_json: tables.chat_messages.request_manifest_json,
      request_manifest_hash: tables.chat_messages.request_manifest_hash,
      request_raw_hash: tables.provenance_artifacts.raw_sha256,
      scope_kind: tables.chat_threads.scope_kind,
      scope_id: tables.chat_threads.scope_id,
    })
    .from(tables.chat_messages)
    .innerJoin(
      tables.chat_threads,
      and(
        eq(tables.chat_threads.id, tables.chat_messages.thread_id),
        eq(tables.chat_threads.project_id, tables.chat_messages.project_id),
      ),
    )
    .leftJoin(
      tables.provenance_artifacts,
      eq(
        tables.provenance_artifacts.id,
        tables.chat_messages.request_artifact_id,
      ),
    )
    .where(
      and(
        eq(tables.chat_messages.id, input.messageId),
        eq(tables.chat_messages.project_id, projectId),
        eq(tables.chat_messages.role, "assistant"),
        eq(tables.chat_messages.task_kind, "translation"),
      ),
    )
    .get();
  if (!row?.request_manifest_json) {
    throw new MunhaeError("invalid_message", "translation request manifest not found");
  }
  if (row.state !== "validating" && row.state !== "completed") {
    throw new MunhaeError("invalid_message_state", `cannot apply a response while execution is ${row.state ?? "unknown"}`);
  }
  const stored = requireCanonicalManifest(row.request_manifest_json);
  if (row.request_manifest_hash !== stored.hash || row.request_raw_hash !== stored.manifest.requestHash) {
    throw new MunhaeError("request_hash_mismatch", "translation request provenance hash is inconsistent");
  }
  const snapshot = stored.manifest.snapshot;
  if (row.scope_kind !== "document_node" || row.scope_id !== snapshot.documentNodeId) {
    throw new MunhaeError("invalid_request_manifest", "translation thread scope does not match the request snapshot");
  }
  if (
    snapshot.documentNodeId !== input.documentNodeId ||
    snapshot.anchorSetId !== input.anchorSetId ||
    snapshot.sourceTextVersionId !== input.sourceTextVersionId ||
    snapshot.punctuationVersionId !== input.punctuationVersionId ||
    snapshot.policyVersionId !== input.policyVersionId ||
    canonicalJson(snapshot.expectedHead) !== canonicalJson(input.expectedHead)
  ) {
    throw new MunhaeError("stale_request", "apply input does not match the immutable AI request snapshot");
  }
  return snapshot;
}

function envelopeDrafts(
  envelope: TranslationEnvelope,
  knownAnchors: Set<string>,
): BlockDraft[] {
  return envelope.blocks.map((block) => {
    const keys = new Set<string>();
    return {
      blockKey: block.blockKey,
      blockKind: block.blockKind,
      translation: block.translation,
      // Unknown and duplicate same-block links cannot become foreign keys. Cross-block
      // reuse is a valid AI-authored mapping and must be preserved as separate relations.
      sourceAnchorIds: block.sourceAnchorIds.filter((key) => {
        if (!knownAnchors.has(key) || keys.has(key)) return false;
        keys.add(key);
        return true;
      }),
    };
  });
}

function recordEnvelopeValidation(
  db: SqliteDb,
  projectId: string,
  messageId: string,
  versionId: string,
  findings: TranslationEnvelopeValidationFinding[],
  validationState: "valid",
  anchorIds: Map<string, string>,
): void {
  const validationId = createId();
  orm(db)
    .insert(tables.document_translation_validations)
    .values({
      id: validationId,
      project_id: projectId,
      document_translation_version_id: versionId,
      source_message_id: messageId,
      validator_version: "translation-envelope.v2",
      result: validationState,
      needs_review: 0,
      summary_json: canonicalJson({ findings }),
      validated_at: nowIso(),
    })
    .run();
  for (const item of findings) {
    orm(db)
      .insert(tables.document_translation_validation_findings)
      .values({
        id: createId(),
        project_id: projectId,
        validation_id: validationId,
        finding_kind: item.kind,
        severity: item.severity,
        block_key: item.blockKey,
        anchor_id: item.anchorKey ? (anchorIds.get(item.anchorKey) ?? null) : null,
        details_json: canonicalJson(item),
      })
      .run();
  }
}

function existingGeneratedVersions(
  db: SqliteDb,
  messageId: string,
): Array<{
  translationId: string;
  versionId: string;
  validationState: "valid" | "needs_review";
}> {
  return orm(db)
    .select({
      translation_id:
        tables.document_translation_versions.document_translation_id,
      version_id: tables.document_translation_versions.id,
      validation_state: tables.document_translation_versions.validation_state,
    })
    .from(tables.document_translation_versions)
    .where(
      eq(tables.document_translation_versions.generated_by_message_id, messageId),
    )
    .orderBy(tables.document_translation_versions.created_at)
    .all().map((row) => ({
    translationId: row.translation_id,
    versionId: row.version_id,
    validationState: row.validation_state,
  }));
}

function applyTranslationEnvelopeInternal(
  db: SqliteDb,
  projectId: string,
  actors: ProjectActors,
  input: ApplyTranslationEnvelopeInput,
): AppliedTranslationEnvelope {
  const boundSnapshot = requireBoundManifestForApply(db, projectId, input);
  validateMessageResponse(db, projectId, input.messageId, input.rawResponse);
  const anchors = loadAnchors(db, input.anchorSetId);
  const validation = validateTranslationEnvelope(input.rawResponse, {
    anchorSetId: input.anchorSetId,
    anchors: anchors.map((anchor) => ({
      anchorKey: anchor.anchor_key,
      ordinal: anchor.ordinal,
      required: anchor.required === 1,
    })),
  });
  if (validation.state !== "valid" || !validation.envelope) {
    orm(db)
      .update(tables.chat_messages)
      .set({
        state: "completed",
        output_validation_state: "invalid_unapplied",
        error_json: canonicalJson({
          code: "invalid_envelope",
          findings: [
            ...validation.fatalFindings,
            ...validation.recoverableFindings,
          ],
        }),
        completed_at: nowIso(),
      })
      .where(
        and(
          eq(tables.chat_messages.id, input.messageId),
          eq(tables.chat_messages.project_id, projectId),
        ),
      )
      .run();
    return { messageId: input.messageId, validation, version: null, idempotent: false };
  }
  const envelope = validation.envelope;

  return orm(db).transaction(() => {
    validateMessageResponse(db, projectId, input.messageId, input.rawResponse);
    const existing = existingGeneratedVersions(db, input.messageId);
    if (existing.length > 0) {
      const version = existing[0];
      if (
        existing.length !== 1 ||
        !version ||
        version.validationState !== "valid"
      ) {
        throw new MunhaeError("idempotency_conflict", "assistant message does not have one complete translation application");
      }
      return {
        messageId: input.messageId,
        validation,
        version: {
          translationId: version.translationId,
          versionId: version.versionId,
          validationState: "valid" as const,
        },
        idempotent: true,
      };
    }

    const snapshot = assertSnapshotDependencies(db, projectId, input);
    if (snapshot.sourceTextId !== boundSnapshot.sourceTextId || snapshot.targetLocale !== boundSnapshot.targetLocale) {
      throw new MunhaeError("stale_request", "source text or target locale no longer matches the AI request snapshot");
    }
    const knownAnchors = new Set(anchors.map((anchor) => anchor.anchor_key));
    const anchorIds = new Map(anchors.map((anchor) => [anchor.anchor_key, anchor.id]));
    const baseline = input.expectedHead;
    let translation = orm(db)
      .select({ id: tables.document_translations.id })
      .from(tables.document_translations)
      .where(
        and(
          eq(tables.document_translations.project_id, projectId),
          eq(tables.document_translations.source_text_id, snapshot.sourceTextId),
          eq(tables.document_translations.target_locale, snapshot.targetLocale),
          isNull(tables.document_translations.tombstoned_at),
        ),
      )
      .get();
    if (!translation) {
      if (baseline !== null) throw new MunhaeError("cas_conflict", "translation head disappeared");
      translation = { id: createId() };
      orm(db)
        .insert(tables.document_translations)
        .values({
          id: translation.id,
          project_id: projectId,
          document_node_id: input.documentNodeId,
          source_text_id: snapshot.sourceTextId,
          target_locale: snapshot.targetLocale,
          created_at: nowIso(),
          tombstoned_at: null,
        })
        .run();
    } else if (baseline === null || baseline.translationId !== translation.id) {
      throw new MunhaeError("cas_conflict", "translation aggregate changed while AI was running");
    }

    const head = orm(db)
      .select({
        current_version_id: tables.document_translation_heads.current_version_id,
        confirmed_version_id:
          tables.document_translation_heads.confirmed_version_id,
        lock_version: tables.document_translation_heads.lock_version,
      })
      .from(tables.document_translation_heads)
      .where(
        eq(
          tables.document_translation_heads.document_translation_id,
          translation.id,
        ),
      )
      .get();
    if (baseline) {
      if (!head || head.current_version_id !== baseline.currentVersionId || head.lock_version !== baseline.lockVersion) {
        throw new MunhaeError("cas_conflict", "translation was edited while AI was running");
      }
    } else if (head) {
      throw new MunhaeError("cas_conflict", "translation head appeared while AI was running");
    }

    const versionNo =
      (orm(db)
        .select({
          value: sql<number | null>`max(${tables.document_translation_versions.version_no})`,
        })
        .from(tables.document_translation_versions)
        .where(
          eq(
            tables.document_translation_versions.document_translation_id,
            translation.id,
          ),
        )
        .get()?.value ?? 0) + 1;
    const validationState = "valid" as const;
    const drafts = envelopeDrafts(envelope, knownAnchors);
    const text = drafts.map((block) => block.translation).join(" ");
    const versionId = createId();
    const now = nowIso();
    orm(db)
      .insert(tables.document_translation_versions)
      .values({
        id: versionId,
        project_id: projectId,
        document_translation_id: translation.id,
        parent_version_id: head?.current_version_id ?? null,
        version_no: versionNo,
        source_text_version_id: input.sourceTextVersionId,
        punctuation_version_id: input.punctuationVersionId,
        translation_anchor_set_id: input.anchorSetId,
        translation_policy_version_id: input.policyVersionId,
        text_content: text,
        origin_kind: "ai",
        generated_by_message_id: input.messageId,
        validation_state: validationState,
        needs_review: 0,
        state: "draft",
        content_hash: sha256Hex(text),
        created_by_actor_id: actors.llmId,
        created_at: now,
      })
      .run();
    insertVersionBlocks(db, projectId, versionId, drafts, anchors, validationState);
    recordEnvelopeValidation(
      db,
      projectId,
      input.messageId,
      versionId,
      validation.recoverableFindings,
      validationState,
      anchorIds,
    );
    if (head) {
      const update = orm(db)
        .update(tables.document_translation_heads)
        .set({
          current_version_id: versionId,
          lock_version: sql`${tables.document_translation_heads.lock_version} + 1`,
          updated_at: now,
        })
        .where(
          and(
            eq(
              tables.document_translation_heads.document_translation_id,
              translation.id,
            ),
            eq(
              tables.document_translation_heads.current_version_id,
              baseline!.currentVersionId,
            ),
            eq(tables.document_translation_heads.lock_version, baseline!.lockVersion),
          ),
        )
        .run();
      if (update.changes !== 1) throw new MunhaeError("cas_conflict", "stale translation head");
      orm(db)
        .update(tables.document_translation_versions)
        .set({
          state: "superseded",
        })
        .where(
          and(
            eq(tables.document_translation_versions.id, head.current_version_id),
            eq(tables.document_translation_versions.state, "draft"),
          ),
        )
        .run();
    } else {
      orm(db)
        .insert(tables.document_translation_heads)
        .values({
          project_id: projectId,
          document_translation_id: translation.id,
          current_version_id: versionId,
          confirmed_version_id: null,
          lock_version: 1,
          updated_at: now,
        })
        .run();
    }
    orm(db)
      .update(tables.translation_staleness)
      .set({ resolved_by_document_translation_version_id: versionId })
      .where(
        and(
          isNull(
            tables.translation_staleness
              .resolved_by_document_translation_version_id,
          ),
          inArray(
            tables.translation_staleness.document_translation_version_id,
            orm(db)
              .select({ id: tables.document_translation_versions.id })
              .from(tables.document_translation_versions)
              .where(
                eq(
                  tables.document_translation_versions.document_translation_id,
                  translation.id,
                ),
              ),
          ),
        ),
      )
      .run();

    const existingPart = orm(db)
      .select({ id: tables.chat_message_parts.id })
      .from(tables.chat_message_parts)
      .where(
        and(
          eq(tables.chat_message_parts.message_id, input.messageId),
          eq(tables.chat_message_parts.ordinal, 1),
        ),
      )
      .get();
    if (!existingPart) {
      orm(db)
        .insert(tables.chat_message_parts)
        .values({
          id: createId(),
          project_id: projectId,
          message_id: input.messageId,
          ordinal: 1,
          part_kind: "translation_envelope",
          text_content: envelope.blocks.map((block) => block.translation).join(" "),
          structured_json: canonicalJson(envelope),
          artifact_id:
            orm(db)
              .select({
                response_artifact_id: tables.chat_messages.response_artifact_id,
              })
              .from(tables.chat_messages)
              .where(eq(tables.chat_messages.id, input.messageId))
              .get()?.response_artifact_id ?? null,
        })
        .run();
    }
    orm(db)
      .update(tables.chat_messages)
      .set({
        state: "completed",
        output_validation_state: validation.state,
        error_json: null,
        completed_at: nowIso(),
      })
      .where(
        and(
          eq(tables.chat_messages.id, input.messageId),
          eq(tables.chat_messages.project_id, projectId),
        ),
      )
      .run();
    return {
      messageId: input.messageId,
      validation,
      version: { translationId: translation.id, versionId, validationState },
      idempotent: false,
    };
  });
}

export function applyTranslationEnvelope(
  db: SqliteDb,
  projectId: string,
  actors: ProjectActors,
  input: ApplyTranslationEnvelopeInput,
): AppliedTranslationEnvelope {
  try {
    return applyTranslationEnvelopeInternal(db, projectId, actors, input);
  } catch (error) {
    failTranslationRun(db, projectId, input.messageId, {
      code:
        typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          ? error.code
          : "apply_failed",
      message: error instanceof Error ? error.message : "translation envelope apply failed",
    });
    throw error;
  }
}

export function failTranslationRun(
  db: SqliteDb,
  projectId: string,
  messageId: string,
  error: { code: string; message: string },
  metadata: TranslationRunFailureMetadata = {},
): void {
  orm(db).transaction(() => {
    const current = orm(db)
      .select({
        state: tables.chat_messages.state,
        events_artifact_id: tables.chat_messages.events_artifact_id,
      })
      .from(tables.chat_messages)
      .where(
        and(
          eq(tables.chat_messages.id, messageId),
          eq(tables.chat_messages.project_id, projectId),
          eq(tables.chat_messages.role, "assistant"),
          eq(tables.chat_messages.task_kind, "translation"),
        ),
      )
      .get();
    if (!current) throw new MunhaeError("invalid_message", "translation assistant message not found");
    if (current.state === "completed" || current.state === "failed" || current.state === "canceled") return;
    if (current.state !== "queued" && current.state !== "running" && current.state !== "validating") {
      throw new MunhaeError("invalid_message_state", `cannot fail a translation while execution is ${current.state ?? "unknown"}`);
    }
    const events = metadata.eventsJsonl && !current.events_artifact_id
      ? insertArtifact(db, projectId, "agent_events", metadata.eventsJsonl)
      : null;
    const state = error.code === "canceled" ? "canceled" : "failed";
    const updated = orm(db)
      .update(tables.chat_messages)
      .set({
        state: state,
        error_json: canonicalJson({
          code: error.code,
          message: error.message.slice(0, 800),
        }),
        completed_at: nowIso(),
        events_artifact_id: sql`coalesce(${tables.chat_messages.events_artifact_id}, ${events?.id ?? null})`,
        usage_json: sql`coalesce(${tables.chat_messages.usage_json}, ${metadata.usage === null || metadata.usage === undefined ? null : canonicalJson(metadata.usage)})`,
        resolved_model: sql`coalesce(${tables.chat_messages.resolved_model}, ${metadata.resolvedModel ?? null})`,
        runtime_version: sql`coalesce(${tables.chat_messages.runtime_version}, ${metadata.runtimeVersion ?? null})`,
      })
      .where(
        and(
          eq(tables.chat_messages.id, messageId),
          eq(tables.chat_messages.project_id, projectId),
          eq(tables.chat_messages.role, "assistant"),
          eq(tables.chat_messages.task_kind, "translation"),
          inArray(tables.chat_messages.state, ["queued", "running", "validating"]),
        ),
      )
      .run();
    if (updated.changes !== 1) {
      throw new MunhaeError("invalid_message_state", "translation execution state changed while recording failure");
    }
  });
}

export function captureTranslationHead(
  db: SqliteDb,
  projectId: string,
  sourceTextId: string,
  targetLocale: string,
): TranslationHeadBaseline {
  const row = orm(db)
    .select({
      translation_id: tables.document_translations.id,
      current_version_id: tables.document_translation_heads.current_version_id,
      lock_version: tables.document_translation_heads.lock_version,
    })
    .from(tables.document_translations)
    .innerJoin(
      tables.document_translation_heads,
      eq(
        tables.document_translation_heads.document_translation_id,
        tables.document_translations.id,
      ),
    )
    .where(
      and(
        eq(tables.document_translations.project_id, projectId),
        eq(tables.document_translations.source_text_id, sourceTextId),
        eq(tables.document_translations.target_locale, targetLocale),
        isNull(tables.document_translations.tombstoned_at),
      ),
    )
    .get();
  return row
    ? {
        translationId: row.translation_id,
        currentVersionId: row.current_version_id,
        lockVersion: row.lock_version,
      }
    : null;
}

export function upsertAgentSession(
  db: SqliteDb,
  input: {
    projectId: string;
    threadId: string;
    agentId: "codex" | "claude" | "antigravity";
    model: string | null;
    cwdHash: string;
    messageId: string;
    stablePromptHash: string;
  },
): void {
  const bound = orm(db)
    .select({ id: tables.chat_messages.id })
    .from(tables.chat_messages)
    .innerJoin(
      tables.chat_threads,
      and(
        eq(tables.chat_threads.id, tables.chat_messages.thread_id),
        eq(tables.chat_threads.project_id, tables.chat_messages.project_id),
      ),
    )
    .where(
      and(
        eq(tables.chat_messages.id, input.messageId),
        eq(tables.chat_messages.project_id, input.projectId),
        eq(tables.chat_messages.thread_id, input.threadId),
        eq(tables.chat_messages.role, "assistant"),
        eq(tables.chat_messages.agent_id, input.agentId),
      ),
    )
    .get();
  if (!bound) throw new MunhaeError("invalid_session", "agent session is not bound to the assistant message");
  const now = nowIso();
  orm(db)
    .insert(tables.chat_agent_sessions)
    .values({
      project_id: input.projectId,
      thread_id: input.threadId,
      agent_id: input.agentId,
      model: input.model,
      cwd_hash: input.cwdHash,
      last_message_id: input.messageId,
      stable_prompt_hash: input.stablePromptHash,
      state: "active",
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        tables.chat_agent_sessions.thread_id,
        tables.chat_agent_sessions.agent_id,
      ],
      set: {
        model: input.model,
        cwd_hash: input.cwdHash,
        last_message_id: input.messageId,
        stable_prompt_hash: input.stablePromptHash,
        state: "active",
        updated_at: now,
      },
    })
    .run();
}
