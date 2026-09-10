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
import { allRows, getRow, insertRow } from "./rows.ts";
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
  const existing = getRow<{ id: string; raw_sha256: string }>(
    db,
    `SELECT id, raw_sha256 FROM provenance_artifacts
     WHERE project_id = ? AND artifact_kind = ? AND canonical_sha256 = ?`,
    projectId,
    kind,
    canonicalHash,
  );
  if (existing) return { id: existing.id, rawHash, canonicalHash };
  const id = createId();
  insertRow(db, "provenance_artifacts", {
    id,
    project_id: projectId,
    artifact_kind: kind,
    media_type: kind === "agent_events" ? "application/x-ndjson" : opts.payloadJson ? "application/json" : "text/plain",
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
  });
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
  const existing = getRow<{ id: string }>(
    db,
    `SELECT id FROM chat_threads
     WHERE project_id = ? AND scope_kind = 'document_node' AND scope_id = ? AND title = 'AI 번역'
     ORDER BY created_at LIMIT 1`,
    projectId,
    documentNodeId,
  );
  if (existing) return existing.id;
  const id = createId();
  insertRow(db, "chat_threads", {
    id,
    project_id: projectId,
    title: "AI 번역",
    scope_kind: "document_node",
    scope_id: documentNodeId,
    created_by_actor_id: humanActorId,
    created_at: nowIso(),
  });
  return id;
}

export function reserveTranslationRun(
  db: SqliteDb,
  projectId: string,
  actors: ProjectActors,
  input: ReserveTranslationRunInput,
): ReservedTranslationRun {
  return db.transaction(() => {
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
    const busy = getRow<{ id: string }>(
      db,
      `SELECT id FROM chat_messages
       WHERE thread_id = ? AND role = 'assistant' AND state IN ('queued', 'running', 'validating')
       LIMIT 1`,
      threadId,
    );
    if (busy) throw new MunhaeError("thread_busy", "이 문서의 AI 실행이 이미 진행 중입니다");

    const artifact = insertArtifact(db, projectId, "exact_llm_request", input.requestText);
    const previous = getRow<{ id: string }>(
      db,
      `SELECT id FROM chat_messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      threadId,
    );
    const now = nowIso();
    const userMessageId = createId();
    insertRow(db, "chat_messages", {
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
    });
    insertRow(db, "chat_message_parts", {
      id: createId(),
      project_id: projectId,
      message_id: userMessageId,
      ordinal: 1,
      part_kind: "text",
      text_content: "전체 문서 완성 번역 요청",
      structured_json: null,
      artifact_id: null,
    });

    const messageId = createId();
    insertRow(db, "chat_messages", {
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
    });
    return {
      messageId,
      threadId,
      requestArtifactId: artifact.id,
      requestHash: artifact.rawHash,
    };
  })();
}

export function storeTranslationResponse(
  db: SqliteDb,
  projectId: string,
  input: StoreTranslationResponseInput,
): { responseArtifactId: string; responseRawHash: string; eventsArtifactId: string | null } {
  return db.transaction(() => {
    const message = getRow<{
      id: string;
      response_artifact_id: string | null;
      events_artifact_id: string | null;
      usage_json: string | null;
      resolved_model: string | null;
      runtime_version: string | null;
      role: string;
      task_kind: string | null;
      output_contract: string | null;
      state: string | null;
    }>(
      db,
      `SELECT id, response_artifact_id, events_artifact_id, usage_json,
              resolved_model, runtime_version, role, task_kind, state, output_contract
       FROM chat_messages WHERE id = ? AND project_id = ?`,
      input.messageId,
      projectId,
    );
    if (!message || message.role !== "assistant" || message.task_kind !== "translation") {
      throw new MunhaeError("invalid_message", "translation assistant message not found");
    }
    if (message.response_artifact_id) {
      const existing = getRow<{ id: string; raw_sha256: string }>(
        db,
        `SELECT id, raw_sha256 FROM provenance_artifacts WHERE id = ?`,
        message.response_artifact_id,
      );
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
            const priorEvents = getRow<{ artifact_kind: string; payload_text: string | null }>(
              db,
              `SELECT artifact_kind, payload_text FROM provenance_artifacts
               WHERE id = ? AND project_id = ?`,
              eventsArtifactId,
              projectId,
            );
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
        const updated = db.prepare(
          `UPDATE chat_messages
           SET events_artifact_id = ?, usage_json = COALESCE(usage_json, ?),
               resolved_model = COALESCE(resolved_model, ?),
               runtime_version = COALESCE(runtime_version, ?)
           WHERE id = ? AND project_id = ? AND response_artifact_id = ?`,
        ).run(
          eventsArtifactId,
          usageJson,
          input.resolvedModel,
          input.runtimeVersion,
          input.messageId,
          projectId,
          existing.id,
        );
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
      schemaName: message.output_contract === "translation-text.v1" ? "translation-text" : message.output_contract === "translation-alignment.v1" ? "translation-alignment" : "translation-envelope",
      schemaVersion: message.output_contract === "translation-text.v1" || message.output_contract === "translation-alignment.v1" ? 1 : 2,
    });
    const events = input.eventsJsonl
      ? insertArtifact(db, projectId, "agent_events", input.eventsJsonl)
      : null;
    const updated = db.prepare(
      `UPDATE chat_messages
       SET state = 'validating', response_artifact_id = ?, events_artifact_id = ?,
           usage_json = ?, resolved_model = COALESCE(?, resolved_model),
           runtime_version = COALESCE(?, runtime_version), error_json = NULL
       WHERE id = ? AND project_id = ? AND state IN ('running', 'validating')`,
    ).run(
      response.id,
      events?.id ?? null,
      input.usage === null || input.usage === undefined ? null : canonicalJson(input.usage),
      input.resolvedModel,
      input.runtimeVersion,
      input.messageId,
      projectId,
    );
    if (updated.changes !== 1) {
      throw new MunhaeError("invalid_message_state", "translation execution state changed while storing its response");
    }
    return {
      responseArtifactId: response.id,
      responseRawHash: response.rawHash,
      eventsArtifactId: events?.id ?? null,
    };
  })();
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
  return db.transaction(() => {
    const stored = storeTranslationResponse(db, projectId, input);
    const current = getRow<{ state: string | null; output_validation_state: string | null }>(
      db,
      `SELECT state, output_validation_state FROM chat_messages
       WHERE id = ? AND project_id = ? AND role = 'assistant' AND task_kind = 'translation'`,
      input.messageId,
      projectId,
    );
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
    const updated = db.prepare(
      `UPDATE chat_messages
       SET state = 'completed', output_validation_state = 'invalid_unapplied',
           error_json = ?, completed_at = ?
       WHERE id = ? AND project_id = ? AND role = 'assistant' AND task_kind = 'translation'
         AND state = 'validating'`,
    ).run(
      canonicalJson({
        code: input.error.code,
        message: input.error.message.slice(0, 800),
      }),
      nowIso(),
      input.messageId,
      projectId,
    );
    if (updated.changes !== 1) {
      throw new MunhaeError("invalid_message_state", "translation execution changed while rejecting its response");
    }
    return stored;
  })();
}

function assertSnapshotDependencies(
  db: SqliteDb,
  projectId: string,
  input: ApplyTranslationEnvelopeInput,
): { sourceTextId: string; targetLocale: string } {
  const row = getRow<{ source_text_id: string; target_locale: string }>(
    db,
    `SELECT sv.source_text_id, policy_version.target_locale
     FROM translation_anchor_sets a
     JOIN src_text_versions sv ON sv.id = a.source_text_version_id
     JOIN src_text_heads source_head
       ON source_head.source_text_id = sv.source_text_id
      AND source_head.project_id = a.project_id
      AND source_head.current_version_id = a.source_text_version_id
     JOIN punctuation_versions pv ON pv.id = a.punctuation_version_id
     JOIN punctuation_heads punctuation_head
       ON punctuation_head.punctuation_set_id = pv.punctuation_set_id
      AND punctuation_head.project_id = a.project_id
      AND punctuation_head.current_version_id = a.punctuation_version_id
     JOIN core_translation_policy_versions policy_version ON policy_version.id = ?
     JOIN core_translation_policies policy
       ON policy.id = policy_version.policy_id AND policy.project_id = a.project_id
     WHERE a.id = ? AND a.project_id = ? AND a.document_node_id = ?
       AND a.source_text_version_id = ? AND a.punctuation_version_id = ?
       AND pv.source_text_version_id = a.source_text_version_id
       AND policy_version.id = ?`,
    input.policyVersionId,
    input.anchorSetId,
    projectId,
    input.documentNodeId,
    input.sourceTextVersionId,
    input.punctuationVersionId,
    input.policyVersionId,
  );
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
  const row = getRow<{
    role: string;
    task_kind: string | null;
    response_artifact_id: string | null;
    raw_sha256: string | null;
  }>(
    db,
    `SELECT m.role, m.task_kind, m.response_artifact_id, a.raw_sha256
     FROM chat_messages m
     LEFT JOIN provenance_artifacts a ON a.id = m.response_artifact_id
     WHERE m.id = ? AND m.project_id = ?`,
    messageId,
    projectId,
  );
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
  const row = getRow<{
    state: string | null;
    request_manifest_json: string | null;
    request_manifest_hash: string | null;
    request_raw_hash: string | null;
    scope_kind: string | null;
    scope_id: string | null;
  }>(
    db,
    `SELECT m.state, m.request_manifest_json, m.request_manifest_hash,
            request.raw_sha256 AS request_raw_hash, t.scope_kind, t.scope_id
     FROM chat_messages m
     JOIN chat_threads t ON t.id = m.thread_id AND t.project_id = m.project_id
     LEFT JOIN provenance_artifacts request ON request.id = m.request_artifact_id
     WHERE m.id = ? AND m.project_id = ? AND m.role = 'assistant'
       AND m.task_kind = 'translation'`,
    input.messageId,
    projectId,
  );
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
  insertRow(db, "document_translation_validations", {
    id: validationId,
    project_id: projectId,
    document_translation_version_id: versionId,
    source_message_id: messageId,
    validator_version: "translation-envelope.v2",
    result: validationState,
    needs_review: 0,
    summary_json: canonicalJson({ findings }),
    validated_at: nowIso(),
  });
  for (const item of findings) {
    insertRow(db, "document_translation_validation_findings", {
      id: createId(),
      project_id: projectId,
      validation_id: validationId,
      finding_kind: item.kind,
      severity: item.severity,
      block_key: item.blockKey,
      anchor_id: item.anchorKey ? anchorIds.get(item.anchorKey) ?? null : null,
      details_json: canonicalJson(item),
    });
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
  return allRows<{
    translation_id: string;
    version_id: string;
    validation_state: "valid" | "needs_review";
  }>(
    db,
    `SELECT v.document_translation_id AS translation_id,
            v.id AS version_id, v.validation_state
     FROM document_translation_versions v
     WHERE v.generated_by_message_id = ?
     ORDER BY v.created_at`,
    messageId,
  ).map((row) => ({
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
    db.prepare(
      `UPDATE chat_messages
       SET state = 'completed', output_validation_state = 'invalid_unapplied',
           error_json = ?, completed_at = ?
       WHERE id = ? AND project_id = ?`,
    ).run(
      canonicalJson({
        code: "invalid_envelope",
        findings: [...validation.fatalFindings, ...validation.recoverableFindings],
      }),
      nowIso(),
      input.messageId,
      projectId,
    );
    return { messageId: input.messageId, validation, version: null, idempotent: false };
  }
  const envelope = validation.envelope;

  return db.transaction(() => {
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
    let translation = getRow<{ id: string }>(
      db,
      `SELECT id FROM document_translations
       WHERE project_id = ? AND source_text_id = ? AND target_locale = ? AND tombstoned_at IS NULL`,
      projectId,
      snapshot.sourceTextId,
      snapshot.targetLocale,
    );
    if (!translation) {
      if (baseline !== null) throw new MunhaeError("cas_conflict", "translation head disappeared");
      translation = { id: createId() };
      insertRow(db, "document_translations", {
        id: translation.id,
        project_id: projectId,
        document_node_id: input.documentNodeId,
        source_text_id: snapshot.sourceTextId,
        target_locale: snapshot.targetLocale,
        created_at: nowIso(),
        tombstoned_at: null,
      });
    } else if (baseline === null || baseline.translationId !== translation.id) {
      throw new MunhaeError("cas_conflict", "translation aggregate changed while AI was running");
    }

    const head = getRow<{
      current_version_id: string;
      confirmed_version_id: string | null;
      lock_version: number;
    }>(db, `SELECT current_version_id, confirmed_version_id, lock_version FROM document_translation_heads WHERE document_translation_id = ?`, translation.id);
    if (baseline) {
      if (!head || head.current_version_id !== baseline.currentVersionId || head.lock_version !== baseline.lockVersion) {
        throw new MunhaeError("cas_conflict", "translation was edited while AI was running");
      }
    } else if (head) {
      throw new MunhaeError("cas_conflict", "translation head appeared while AI was running");
    }

    const versionNo =
      (getRow<{ value: number | null }>(
        db,
        `SELECT MAX(version_no) AS value FROM document_translation_versions WHERE document_translation_id = ?`,
        translation.id,
      )?.value ?? 0) + 1;
    const validationState = "valid" as const;
    const drafts = envelopeDrafts(envelope, knownAnchors);
    const text = drafts.map((block) => block.translation).join(" ");
    const versionId = createId();
    const now = nowIso();
    insertRow(db, "document_translation_versions", {
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
    });
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
      const update = db.prepare(
        `UPDATE document_translation_heads
         SET current_version_id = ?, lock_version = lock_version + 1, updated_at = ?
         WHERE document_translation_id = ? AND current_version_id = ? AND lock_version = ?`,
      ).run(versionId, now, translation.id, baseline?.currentVersionId, baseline?.lockVersion);
      if (update.changes !== 1) throw new MunhaeError("cas_conflict", "stale translation head");
      db.prepare(
        `UPDATE document_translation_versions SET state = 'superseded'
         WHERE id = ? AND state = 'draft'`,
      ).run(head.current_version_id);
    } else {
      insertRow(db, "document_translation_heads", {
        project_id: projectId,
        document_translation_id: translation.id,
        current_version_id: versionId,
        confirmed_version_id: null,
        lock_version: 1,
        updated_at: now,
      });
    }
    db.prepare(
      `UPDATE translation_staleness
       SET resolved_by_document_translation_version_id = ?
       WHERE resolved_by_document_translation_version_id IS NULL
         AND document_translation_version_id IN (
           SELECT id FROM document_translation_versions WHERE document_translation_id = ?
         )`,
    ).run(versionId, translation.id);

    const existingPart = getRow<{ id: string }>(
      db,
      `SELECT id FROM chat_message_parts WHERE message_id = ? AND ordinal = 1`,
      input.messageId,
    );
    if (!existingPart) {
      insertRow(db, "chat_message_parts", {
        id: createId(),
        project_id: projectId,
        message_id: input.messageId,
        ordinal: 1,
        part_kind: "translation_envelope",
        text_content: envelope.blocks.map((block) => block.translation).join(" "),
        structured_json: canonicalJson(envelope),
        artifact_id: getRow<{ response_artifact_id: string }>(
          db,
          `SELECT response_artifact_id FROM chat_messages WHERE id = ?`,
          input.messageId,
        )?.response_artifact_id ?? null,
      });
    }
    db.prepare(
      `UPDATE chat_messages
       SET state = 'completed', output_validation_state = ?, error_json = NULL, completed_at = ?
       WHERE id = ? AND project_id = ?`,
    ).run(validation.state, nowIso(), input.messageId, projectId);
    return {
      messageId: input.messageId,
      validation,
      version: { translationId: translation.id, versionId, validationState },
      idempotent: false,
    };
  })();
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
  db.transaction(() => {
    const current = getRow<{ state: string | null; events_artifact_id: string | null }>(
      db,
      `SELECT state, events_artifact_id FROM chat_messages
       WHERE id = ? AND project_id = ? AND role = 'assistant' AND task_kind = 'translation'`,
      messageId,
      projectId,
    );
    if (!current) throw new MunhaeError("invalid_message", "translation assistant message not found");
    if (current.state === "completed" || current.state === "failed" || current.state === "canceled") return;
    if (current.state !== "queued" && current.state !== "running" && current.state !== "validating") {
      throw new MunhaeError("invalid_message_state", `cannot fail a translation while execution is ${current.state ?? "unknown"}`);
    }
    const events = metadata.eventsJsonl && !current.events_artifact_id
      ? insertArtifact(db, projectId, "agent_events", metadata.eventsJsonl)
      : null;
    const state = error.code === "canceled" ? "canceled" : "failed";
    const updated = db.prepare(
      `UPDATE chat_messages
       SET state = ?, error_json = ?, completed_at = ?,
           events_artifact_id = COALESCE(events_artifact_id, ?),
           usage_json = COALESCE(usage_json, ?),
           resolved_model = COALESCE(resolved_model, ?),
           runtime_version = COALESCE(runtime_version, ?)
       WHERE id = ? AND project_id = ? AND role = 'assistant' AND task_kind = 'translation'
         AND state IN ('queued', 'running', 'validating')`,
    ).run(
      state,
      canonicalJson({ code: error.code, message: error.message.slice(0, 800) }),
      nowIso(),
      events?.id ?? null,
      metadata.usage === null || metadata.usage === undefined ? null : canonicalJson(metadata.usage),
      metadata.resolvedModel ?? null,
      metadata.runtimeVersion ?? null,
      messageId,
      projectId,
    );
    if (updated.changes !== 1) {
      throw new MunhaeError("invalid_message_state", "translation execution state changed while recording failure");
    }
  })();
}

export function captureTranslationHead(
  db: SqliteDb,
  projectId: string,
  sourceTextId: string,
  targetLocale: string,
): TranslationHeadBaseline {
  const row = getRow<{
    translation_id: string;
    current_version_id: string;
    lock_version: number;
  }>(
    db,
    `SELECT t.id AS translation_id, h.current_version_id, h.lock_version
     FROM document_translations t
     JOIN document_translation_heads h ON h.document_translation_id = t.id
     WHERE t.project_id = ? AND t.source_text_id = ? AND t.target_locale = ?
       AND t.tombstoned_at IS NULL`,
    projectId,
    sourceTextId,
    targetLocale,
  );
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
  const bound = getRow<{ id: string }>(
    db,
    `SELECT m.id
     FROM chat_messages m
     JOIN chat_threads t ON t.id = m.thread_id AND t.project_id = m.project_id
     WHERE m.id = ? AND m.project_id = ? AND m.thread_id = ?
       AND m.role = 'assistant' AND m.agent_id = ?`,
    input.messageId,
    input.projectId,
    input.threadId,
    input.agentId,
  );
  if (!bound) throw new MunhaeError("invalid_session", "agent session is not bound to the assistant message");
  db.prepare(
    `INSERT INTO chat_agent_sessions
       (project_id, thread_id, agent_id, model, cwd_hash,
        last_message_id, stable_prompt_hash, state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT(thread_id, agent_id) DO UPDATE SET
       model = excluded.model,
       cwd_hash = excluded.cwd_hash,
       last_message_id = excluded.last_message_id,
       stable_prompt_hash = excluded.stable_prompt_hash,
       state = 'active', updated_at = excluded.updated_at`,
  ).run(
    input.projectId,
    input.threadId,
    input.agentId,
    input.model,
    input.cwdHash,
    input.messageId,
    input.stablePromptHash,
    nowIso(),
  );
}
