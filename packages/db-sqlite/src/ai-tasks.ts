import {
  canonicalJson,
  createId,
  MunhaeError,
  nowIso,
  sha256Hex,
  utf8ByteLength,
} from "@munhae/domain";
import type { ProjectActors } from "./bootstrap.ts";
import { allRows, getRow, insertRow } from "./rows.ts";
import {
  insertPunctuationVersionWithAnchors,
  prepareStructureSpans,
  validatePunctuationText,
} from "./source-layer.ts";
import type { SqliteDb } from "./sqlite.ts";
import type { DocumentNodeRole, PunctuationStructureMode, VersionUiState } from "./views.ts";

export const PROJECT_CHAT_PROMPT_CONTRACT_VERSION = "munhae.project-chat.v3";
export const PUNCTUATION_SUGGEST_PROMPT_CONTRACT_VERSION = "munhae.punctuation-suggest.v4";
export const AGENT_EMPTY_CWD_HASH = sha256Hex("munhae-agent-empty-cwd.v1");

const PROJECT_CHAT_STABLE_PROMPT = [
  "You are the read-only project chat assistant inside Munhae Studio.",
  "Answer the user's question about the explicitly supplied scope snapshot as concise plain text.",
  "You may use the provider CLI's native tools, web access, and installed skills when useful; decide this yourself.",
  "Do not propose or attempt hidden Munhae database operations, and never claim that Munhae project data was changed.",
  "Separate textual evidence from interpretation and state uncertainty explicitly.",
  "Do not reveal hidden chain-of-thought; provide conclusions and brief supporting evidence only.",
].join("\n");

const PUNCTUATION_STABLE_PROMPT = [
  "You are proposing a Classical Chinese punctuation draft for Munhae Studio.",
  "Return only the complete punctuated text, with no explanation, Markdown fence, label, or preface.",
  "Preserve every non-whitespace source code point in its original order. You may insert punctuation and reformat spaces or line breaks; leading and trailing whitespace need not be copied. Do not change source characters or existing source marks.",
  "Use Munhae's conservative Korean classical-text punctuation style. This is an editorial convention, not a claim that other punctuation styles are incorrect.",
  "The only new marks allowed are ， 。 ㆍ 《 》 〈 〉 and whitespace. Use ， within a sentence and 。 at its end, including questions and rhetorical questions. Do not add question marks, exclamation marks, colons, semicolons, enumeration commas, or quotation marks (such as ? ？ ! ！ : ： ; ； 、 「 」 『 』).",
  "Use ㆍ sparingly between parallel nouns, 《》 for a clearly identified book title, and 〈〉 for a clearly identified chapter title. Do not invent title boundaries when uncertain.",
  "Keep commentary formulas such as 臣謹案 and 今按 intact, followed by a space rather than a colon. Separate commentary paragraphs where justified by the source; preserve verse line structure in poetry mode.",
  "For example, 臣謹案抑何故也 may be punctuated as 臣謹案 抑何故也。 The question's meaning remains in the words; do not add ？.",
  "Existing source marks are exempt from the new-mark restriction: preserve them exactly, including any question marks and ○ or 〇. Never replace 〇 with ○, normalize variant characters, or copy wording from an external edition.",
  "Before returning the text, review clause boundaries, parallel constructions, commentary formulas, quotations, and uncertain readings against the source. Prefer minimal punctuation where interpretation is uncertain. Check source preservation and the allowed new marks again.",
  "You may use the provider CLI's native tools, web access, and installed skills when useful; decide this yourself.",
  "The source-preservation, punctuation style, and text-only output rules above also apply when using installed skills or external references.",
  "This is a proposal: do not attempt to change Munhae app data. The application will validate it and will not confirm it automatically.",
].join("\n");

export const PROJECT_CHAT_STABLE_PROMPT_HASH = sha256Hex(PROJECT_CHAT_STABLE_PROMPT);
export const PUNCTUATION_STABLE_PROMPT_HASH = sha256Hex(PUNCTUATION_STABLE_PROMPT);

type PersistedAgentEventBase = {
  runId?: string;
  agentId?: "codex" | "claude" | "antigravity";
  at?: string;
};

type PersistedStatusPhase = "starting" | "initializing" | "thinking" | "streaming" | "stopping";
type PersistedToolState = "started" | "completed" | "failed";
type PersistedErrorCode =
  | "cli_not_found"
  | "auth_required"
  | "context_too_large"
  | "rate_limited"
  | "upstream_unavailable"
  | "connection_dropped"
  | "session_unavailable"
  | "canceled"
  | "timeout"
  | "invalid_stream"
  | "invalid_envelope"
  | "provider_failed";

export type PersistedAgentEvent = PersistedAgentEventBase & (
  | {
      type: "status";
      phase: PersistedStatusPhase;
      detail?: "provider_session_ready";
    }
  | {
      type: "tool_call";
      state: PersistedToolState;
    }
  | {
      type: "warning";
      code?: "event_log_truncated";
    }
  | {
      type: "error";
      error: {
        code: PersistedErrorCode;
        retryable?: boolean;
      };
    }
);

const PERSISTED_STATUS_PHASES: ReadonlySet<string> = new Set([
  "starting",
  "initializing",
  "thinking",
  "streaming",
  "stopping",
]);
const PERSISTED_TOOL_STATES: ReadonlySet<string> = new Set(["started", "completed", "failed"]);
const PERSISTED_ERROR_CODES: ReadonlySet<string> = new Set([
  "cli_not_found",
  "auth_required",
  "context_too_large",
  "rate_limited",
  "upstream_unavailable",
  "connection_dropped",
  "session_unavailable",
  "canceled",
  "timeout",
  "invalid_stream",
  "invalid_envelope",
  "provider_failed",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function persistedAgentEventBase(record: Record<string, unknown>): PersistedAgentEventBase {
  return {
    ...(typeof record.runId === "string" && UUID_PATTERN.test(record.runId)
      ? { runId: record.runId }
      : {}),
    ...(record.agentId === "codex" || record.agentId === "claude" || record.agentId === "antigravity"
      ? { agentId: record.agentId }
      : {}),
    ...(typeof record.at === "string" && ISO_INSTANT_PATTERN.test(record.at)
      ? { at: record.at }
      : {}),
  };
}

/**
 * Rebuild a provider event from a small metadata allowlist before it crosses
 * into a project artifact. Raw text/reasoning deltas and usage are already
 * represented by the response artifact and message metadata, so they are not
 * duplicated in events.jsonl. This accepts a structural event on purpose: the
 * persistence boundary must remain fail-closed for future provider fields.
 */
export function sanitizeAgentEventForPersistence<T extends { type: string }>(
  event: T,
): PersistedAgentEvent | null {
  const record = event as T & Record<string, unknown>;
  const base = persistedAgentEventBase(record);
  if (event.type === "status") {
    if (typeof record.phase !== "string" || !PERSISTED_STATUS_PHASES.has(record.phase)) return null;
    return {
      type: "status",
      ...base,
      phase: record.phase as PersistedStatusPhase,
    };
  }
  if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "usage") {
    return null;
  }
  if (event.type === "tool_call") {
    if (typeof record.state !== "string" || !PERSISTED_TOOL_STATES.has(record.state)) return null;
    return {
      type: "tool_call",
      ...base,
      state: record.state as PersistedToolState,
    };
  }
  if (event.type === "session") {
    return {
      type: "status",
      ...base,
      phase: "initializing",
      detail: "provider_session_ready",
    };
  }
  if (event.type === "warning") {
    return {
      type: "warning",
      ...base,
      ...(record.code === "event_log_truncated" ? { code: record.code } : {}),
    };
  }
  if (event.type === "error") {
    const error = typeof record.error === "object" && record.error !== null
      ? record.error as Record<string, unknown>
      : {};
    return {
      type: "error",
      ...base,
      error: {
        code: typeof error.code === "string" && PERSISTED_ERROR_CODES.has(error.code)
          ? error.code as PersistedErrorCode
          : "provider_failed",
        ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
      },
    };
  }
  return null;
}

export type DocumentChatSnapshot = {
  scopeKind: "document_node";
  documentNodeId: string;
  documentTitle: string;
  sourceTextVersionId: string;
  sourceTextHash: string;
  punctuationVersionId: string | null;
  punctuationHash: string | null;
  translations: Array<{
    stage: string;
    versionId: string;
    contentHash: string;
  }>;
};

export type ProjectOverviewChatSnapshot = {
  scopeKind: "project";
  projectTitle: string;
  documents: Array<{
    documentNodeId: string;
    parentDocumentNodeId: string | null;
    nodeRole: DocumentNodeRole;
    title: string;
    sourceState: VersionUiState;
    punctuationState: VersionUiState;
    translationState: VersionUiState;
  }>;
  enabledProjectContext: Array<{
    contextItemId: string;
    title: string;
    content: string;
    contentHash: string;
    priority: number;
  }>;
};

export type ProjectChatSnapshot = DocumentChatSnapshot | ProjectOverviewChatSnapshot;

export type PunctuationSuggestionSnapshot = {
  documentNodeId: string;
  documentTitle: string;
  sourceTextId: string;
  sourceTextVersionId: string;
  sourceTextHash: string;
  punctuationSetId: string | null;
  currentPunctuationVersionId: string | null;
  currentPunctuationLockVersion: number | null;
  structureMode: PunctuationStructureMode;
};

export type ReserveProjectTaskInput = {
  documentNodeId: string;
  scopeKind: "document_node" | "project";
  scopeId: string;
  taskKind: "chat" | "punctuation_suggest";
  userText: string;
  agentId: "codex" | "claude" | "antigravity";
  requestedModel: string;
  reasoningLevel: string | null;
  serviceTier: string | null;
  runtimeVersion: string | null;
  requestManifestJson: string;
  requestText: string;
  promptContractVersion: string;
  stablePromptHash: string;
};

export type ReservedProjectTaskRun = {
  messageId: string;
  threadId: string;
  requestArtifactId: string;
  requestHash: string;
  resumeCompatible: boolean;
};

export type StoreProjectTaskResponseInput = {
  messageId: string;
  rawResponse: string;
  eventsJsonl: string;
  usage: unknown;
  resolvedModel: string | null;
  runtimeVersion: string | null;
};

export type ProjectTaskFailureMetadata = {
  eventsJsonl?: string;
  usage?: unknown;
  resolvedModel?: string | null;
  runtimeVersion?: string | null;
};

export type PunctuationSuggestionResult = {
  messageId: string;
  validationState: "valid" | "invalid_unapplied";
  applied: boolean;
  punctuationVersionId: string | null;
  anchorSetId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function insertArtifact(
  db: SqliteDb,
  projectId: string,
  kind: "exact_llm_request" | "llm_response" | "agent_events",
  payloadText: string,
): { id: string; rawHash: string } {
  const rawHash = sha256Hex(payloadText);
  const existing = getRow<{ id: string }>(
    db,
    `SELECT id FROM provenance_artifacts
     WHERE project_id = ? AND artifact_kind = ? AND canonical_sha256 = ?`,
    projectId,
    kind,
    rawHash,
  );
  if (existing) return { id: existing.id, rawHash };
  const id = createId();
  insertRow(db, "provenance_artifacts", {
    id,
    project_id: projectId,
    artifact_kind: kind,
    media_type: kind === "agent_events" ? "application/x-ndjson" : "text/plain",
    payload_text: payloadText,
    payload_json: null,
    storage_asset_id: null,
    raw_sha256: rawHash,
    canonical_sha256: rawHash,
    byte_size: utf8ByteLength(payloadText),
    schema_name: null,
    schema_version: null,
    classification: "project_private",
    retention_class: "project_history",
    redaction_state: "not_required",
    created_at: nowIso(),
  });
  return { id, rawHash };
}

function requireCanonicalManifest(
  input: ReserveProjectTaskInput,
): { json: string; hash: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.requestManifestJson) as unknown;
  } catch {
    throw new MunhaeError("invalid_request_manifest", "AI request manifest is not valid JSON");
  }
  const json = canonicalJson(parsed);
  if (json !== input.requestManifestJson || !isRecord(parsed)) {
    throw new MunhaeError("invalid_request_manifest", "AI request manifest must use canonical JSON");
  }
  if (
    parsed.schemaVersion !== 1
    || parsed.taskKind !== input.taskKind
    || parsed.documentNodeId !== input.documentNodeId
    || parsed.scopeKind !== input.scopeKind
    || parsed.scopeId !== input.scopeId
    || parsed.requestHash !== sha256Hex(input.requestText)
    || parsed.promptContractVersion !== input.promptContractVersion
  ) {
    throw new MunhaeError("invalid_request_manifest", "AI request manifest is not bound to this execution");
  }
  return { json, hash: sha256Hex(json) };
}

const DOCUMENT_CHAT_THREAD_TITLE = "내부 채팅 · 현재 문서";
const PROJECT_CHAT_THREAD_TITLE = "내부 채팅 · 프로젝트 전체";
const PUNCTUATION_TASK_THREAD_TITLE = "AI 표점 제안";

function findOrCreateProjectTaskThread(
  db: SqliteDb,
  projectId: string,
  scopeKind: "document_node" | "project",
  scopeId: string,
  taskKind: "chat" | "punctuation_suggest",
  humanActorId: string,
): string {
  if (scopeKind === "project" && scopeId !== projectId) {
    throw new MunhaeError("invalid_scope", "project chat scope is not bound to the current project");
  }
  if (taskKind === "punctuation_suggest" && scopeKind !== "document_node") {
    throw new MunhaeError("invalid_scope", "punctuation suggestions require a document scope");
  }
  const title = taskKind === "punctuation_suggest"
    ? PUNCTUATION_TASK_THREAD_TITLE
    : scopeKind === "project"
      ? PROJECT_CHAT_THREAD_TITLE
      : DOCUMENT_CHAT_THREAD_TITLE;
  const existing = getRow<{ id: string }>(
    db,
    `SELECT id FROM chat_threads
     WHERE project_id = ? AND scope_kind = ? AND scope_id = ? AND title = ?
     ORDER BY created_at LIMIT 1`,
    projectId,
    scopeKind,
    scopeId,
    title,
  );
  if (existing) return existing.id;
  const id = createId();
  insertRow(db, "chat_threads", {
    id,
    project_id: projectId,
    title,
    scope_kind: scopeKind,
    scope_id: scopeId,
    created_by_actor_id: humanActorId,
    created_at: nowIso(),
  });
  return id;
}

export function reserveProjectTaskRun(
  db: SqliteDb,
  projectId: string,
  actors: ProjectActors,
  input: ReserveProjectTaskInput,
): ReservedProjectTaskRun {
  return db.transaction((): ReservedProjectTaskRun => {
    const manifest = requireCanonicalManifest(input);
    const threadId = findOrCreateProjectTaskThread(
      db,
      projectId,
      input.scopeKind,
      input.scopeId,
      input.taskKind,
      actors.humanId,
    );
    const busy = getRow<{ id: string }>(
      db,
      `SELECT id FROM chat_messages
       WHERE thread_id = ? AND role = 'assistant' AND state IN ('queued', 'running', 'validating')
       LIMIT 1`,
      threadId,
    );
    if (busy) throw new MunhaeError("thread_busy", "이 대화 범위의 AI 실행이 이미 진행 중입니다");

    const previous = getRow<{ id: string }>(
      db,
      `SELECT id FROM chat_messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      threadId,
    );
    let resumeCompatible = false;
    if (input.taskKind === "chat" && previous) {
      const session = getRow<{
        model: string | null;
        cwd_hash: string | null;
        last_message_id: string | null;
        stable_prompt_hash: string | null;
        state: string | null;
      }>(
        db,
        `SELECT model, cwd_hash, last_message_id, stable_prompt_hash, state
         FROM chat_agent_sessions
         WHERE project_id = ? AND thread_id = ? AND agent_id = ?`,
        projectId,
        threadId,
        input.agentId,
      );
      if (
        session?.state === "active"
        && session.model === input.requestedModel
        && session.cwd_hash === AGENT_EMPTY_CWD_HASH
        && session.last_message_id === previous.id
        && session.stable_prompt_hash === input.stablePromptHash
      ) {
        resumeCompatible = true;
      }
    }

    const requestArtifact = insertArtifact(db, projectId, "exact_llm_request", input.requestText);
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
      agent_id: null,
      requested_model: null,
      resolved_model: null,
      reasoning_level: null,
      service_tier: null,
      runtime_version: null,
      task_kind: input.taskKind === "chat" ? "chat_request" : "punctuation_suggest_request",
      output_contract: null,
      prompt_contract_version: null,
      request_manifest_json: null,
      request_manifest_hash: null,
      request_artifact_id: null,
      response_artifact_id: null,
      events_artifact_id: null,
      output_validation_state: "not_applicable",
      usage_json: null,
      error_json: null,
      started_at: now,
      completed_at: now,
      created_at: now,
    });
    insertRow(db, "chat_message_parts", {
      id: createId(),
      project_id: projectId,
      message_id: userMessageId,
      ordinal: 1,
      part_kind: "text",
      text_content: input.userText,
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
      task_kind: input.taskKind,
      output_contract: null,
      prompt_contract_version: input.promptContractVersion,
      request_manifest_json: manifest.json,
      request_manifest_hash: manifest.hash,
      request_artifact_id: requestArtifact.id,
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
      requestArtifactId: requestArtifact.id,
      requestHash: requestArtifact.rawHash,
      resumeCompatible,
    };
  })();
}

export function storeProjectTaskResponse(
  db: SqliteDb,
  projectId: string,
  input: StoreProjectTaskResponseInput,
): { responseArtifactId: string; eventsArtifactId: string | null } {
  return db.transaction(() => {
    const message = getRow<{
      role: string;
      task_kind: string | null;
      state: string | null;
      response_artifact_id: string | null;
      events_artifact_id: string | null;
      response_hash: string | null;
    }>(
      db,
      `SELECT m.role, m.task_kind, m.state, m.response_artifact_id, m.events_artifact_id,
              response.raw_sha256 AS response_hash
       FROM chat_messages m
       LEFT JOIN provenance_artifacts response ON response.id = m.response_artifact_id
       WHERE m.id = ? AND m.project_id = ?`,
      input.messageId,
      projectId,
    );
    if (!message || message.role !== "assistant" || !["chat", "punctuation_suggest"].includes(message.task_kind ?? "")) {
      throw new MunhaeError("invalid_message", "AI task assistant message not found");
    }
    if (message.response_artifact_id) {
      if (message.response_hash !== sha256Hex(input.rawResponse)) {
        throw new MunhaeError("idempotency_conflict", "assistant message already has a different response");
      }
      return {
        responseArtifactId: message.response_artifact_id,
        eventsArtifactId: message.events_artifact_id,
      };
    }
    if (message.state !== "running" && message.state !== "validating") {
      throw new MunhaeError("invalid_message_state", `cannot store a response while execution is ${message.state ?? "unknown"}`);
    }
    const response = insertArtifact(db, projectId, "llm_response", input.rawResponse);
    const events = input.eventsJsonl ? insertArtifact(db, projectId, "agent_events", input.eventsJsonl) : null;
    const updated = db.prepare(
      `UPDATE chat_messages
       SET state = 'validating', response_artifact_id = ?, events_artifact_id = ?, usage_json = ?,
           resolved_model = COALESCE(?, resolved_model), runtime_version = COALESCE(?, runtime_version),
           error_json = NULL
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
      throw new MunhaeError("invalid_message_state", "AI execution state changed while storing its response");
    }
    return { responseArtifactId: response.id, eventsArtifactId: events?.id ?? null };
  })();
}

function insertResponsePart(
  db: SqliteDb,
  projectId: string,
  messageId: string,
  text: string,
  artifactId: string,
  structured: unknown = null,
): void {
  const existing = getRow<{ id: string }>(
    db,
    `SELECT id FROM chat_message_parts WHERE message_id = ? AND ordinal = 1`,
    messageId,
  );
  if (existing) return;
  insertRow(db, "chat_message_parts", {
    id: createId(),
    project_id: projectId,
    message_id: messageId,
    ordinal: 1,
    part_kind: "text",
    text_content: text,
    structured_json: structured === null ? null : canonicalJson(structured),
    artifact_id: artifactId,
  });
}

export function completeProjectChat(
  db: SqliteDb,
  projectId: string,
  messageId: string,
  responseText: string,
): void {
  db.transaction(() => {
    const message = getRow<{
      state: string | null;
      task_kind: string | null;
      response_artifact_id: string | null;
    }>(
      db,
      `SELECT state, task_kind, response_artifact_id FROM chat_messages
       WHERE id = ? AND project_id = ? AND role = 'assistant'`,
      messageId,
      projectId,
    );
    if (!message || message.task_kind !== "chat" || !message.response_artifact_id) {
      throw new MunhaeError("invalid_message", "stored project chat response not found");
    }
    if (message.state === "completed") return;
    if (message.state !== "validating") {
      throw new MunhaeError("invalid_message_state", "project chat response is not ready to complete");
    }
    insertResponsePart(db, projectId, messageId, responseText, message.response_artifact_id);
    db.prepare(
      `UPDATE chat_messages
       SET state = 'completed', output_validation_state = 'not_applicable', error_json = NULL, completed_at = ?
       WHERE id = ? AND project_id = ? AND state = 'validating'`,
    ).run(nowIso(), messageId, projectId);
  })();
}

function parsePunctuationManifest(value: string): PunctuationSuggestionSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new MunhaeError("invalid_request_manifest", "punctuation request manifest is invalid");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.taskKind !== "punctuation_suggest" || !isRecord(parsed.snapshot)) {
    throw new MunhaeError("invalid_request_manifest", "punctuation request manifest header is invalid");
  }
  const snapshot = parsed.snapshot;
  const requiredStrings = [
    "documentNodeId",
    "documentTitle",
    "sourceTextId",
    "sourceTextVersionId",
    "sourceTextHash",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof snapshot[key] !== "string" || !(snapshot[key] as string).length) {
      throw new MunhaeError("invalid_request_manifest", `punctuation request snapshot ${key} is missing`);
    }
  }
  const hasPunctuationBaseline = typeof snapshot.punctuationSetId === "string"
    && snapshot.punctuationSetId.length > 0
    && typeof snapshot.currentPunctuationVersionId === "string"
    && snapshot.currentPunctuationVersionId.length > 0
    && Number.isSafeInteger(snapshot.currentPunctuationLockVersion)
    && (snapshot.currentPunctuationLockVersion as number) >= 1;
  const hasNoPunctuationBaseline = snapshot.punctuationSetId === null
    && snapshot.currentPunctuationVersionId === null
    && snapshot.currentPunctuationLockVersion === null;
  if (!hasPunctuationBaseline && !hasNoPunctuationBaseline) {
    throw new MunhaeError("invalid_request_manifest", "punctuation request baseline is inconsistent");
  }
  if (snapshot.structureMode !== "prose" && snapshot.structureMode !== "poetry") {
    throw new MunhaeError("invalid_request_manifest", "punctuation request structure mode is invalid");
  }
  return snapshot as PunctuationSuggestionSnapshot;
}

function recordPunctuationStaleness(
  db: SqliteDb,
  projectId: string,
  documentNodeId: string,
  punctuationVersionId: string,
): void {
  const versions = allRows<{ id: string; old_dependency_id: string }>(
    db,
    `SELECT v.id, v.punctuation_version_id AS old_dependency_id
     FROM document_translation_versions v
     JOIN document_translations t ON t.id = v.document_translation_id
     WHERE t.document_node_id = ? AND t.project_id = ? AND v.punctuation_version_id <> ?`,
    documentNodeId,
    projectId,
    punctuationVersionId,
  );
  const detectedAt = nowIso();
  for (const version of versions) {
    const existing = getRow<{ id: string }>(
      db,
      `SELECT id FROM translation_staleness
       WHERE document_translation_version_id = ? AND cause_kind = 'punctuation_changed'
         AND new_dependency_id = ? AND resolved_by_document_translation_version_id IS NULL`,
      version.id,
      punctuationVersionId,
    );
    if (existing) continue;
    insertRow(db, "translation_staleness", {
      id: createId(),
      project_id: projectId,
      document_translation_version_id: version.id,
      cause_kind: "punctuation_changed",
      old_dependency_id: version.old_dependency_id,
      new_dependency_id: punctuationVersionId,
      detected_at: detectedAt,
      resolved_by_document_translation_version_id: null,
    });
  }
}

function validatePunctuationProposal(
  sourceText: string,
  responseText: string,
  structureMode: PunctuationStructureMode,
  promptContractVersion: string | null,
): void {
  const sourceMap = validatePunctuationText(sourceText, responseText);
  // v3 introduced this style; later whitespace fixes must not relax its marks.
  if (promptContractVersion === "munhae.punctuation-suggest.v3"
    || promptContractVersion === PUNCTUATION_SUGGEST_PROMPT_CONTRACT_VERSION) {
    for (const codepoint of sourceMap.insertedCodepoints) {
      if (!/^[，。ㆍ《》〈〉\p{White_Space}]$/u.test(codepoint)) {
        throw new MunhaeError(
          "punctuation_style_mismatch",
          `보수적 표점 형식에 없는 부호 '${codepoint}'가 추가되었습니다. ，。 중심으로 다시 생성하세요`,
        );
      }
    }
  }
  prepareStructureSpans(responseText, structureMode);
}

/** Repair old false rejections against their own source snapshot, without applying them. */
export function revalidateRejectedPunctuationSuggestion(db: SqliteDb, projectId: string, messageId: string): boolean {
  return db.transaction(() => {
    const message = getRow<{
      request_manifest_json: string;
      request_manifest_hash: string;
      prompt_contract_version: string | null;
      response_text: string;
      response_hash: string;
      text_content: string;
      structured_json: string | null;
      error_json: string | null;
    }>(db, `SELECT m.request_manifest_json, m.request_manifest_hash, m.prompt_contract_version,
                   response.payload_text AS response_text, response.raw_sha256 AS response_hash,
                   part.text_content, part.structured_json, m.error_json
            FROM chat_messages m
            JOIN provenance_artifacts response ON response.id = m.response_artifact_id AND response.project_id = m.project_id
            JOIN chat_message_parts part ON part.message_id = m.id AND part.project_id = m.project_id AND part.ordinal = 1
            WHERE m.id = ? AND m.project_id = ? AND m.role = 'assistant'
              AND m.task_kind = 'punctuation_suggest' AND m.state = 'completed'
              AND m.output_validation_state = 'invalid_unapplied'`, messageId, projectId);
    if (!message || typeof message.response_text !== "string" || !message.request_manifest_json
      || message.text_content !== message.response_text
      || sha256Hex(message.response_text) !== message.response_hash
      || sha256Hex(message.request_manifest_json) !== message.request_manifest_hash) return false;
    try {
      const snapshot = parsePunctuationManifest(message.request_manifest_json);
      const source = getRow<{ content_text: string; content_hash: string }>(db,
        `SELECT content_text, content_hash FROM src_text_versions
         WHERE id = ? AND source_text_id = ? AND project_id = ?`,
        snapshot.sourceTextVersionId, snapshot.sourceTextId, projectId);
      if (!source || source.content_hash !== snapshot.sourceTextHash || sha256Hex(source.content_text) !== snapshot.sourceTextHash) return false;
      validatePunctuationProposal(source.content_text, message.response_text, snapshot.structureMode, message.prompt_contract_version);
    } catch {
      return false;
    }
    const previousResult = JSON.parse(message.structured_json ?? "{}");
    if (previousResult?.applied || previousResult?.punctuationVersionId) return false;
    db.prepare(`UPDATE chat_message_parts SET structured_json = ?
                WHERE project_id = ? AND message_id = ? AND ordinal = 1`).run(canonicalJson({
      validationState: "valid", applied: false, punctuationVersionId: null, anchorSetId: null,
      revalidation: {
        validator: "punctuation-whitespace.v1", at: nowIso(), previousResult,
        previousError: JSON.parse(message.error_json ?? "null"),
      },
    }), projectId, messageId);
    db.prepare(`UPDATE chat_messages SET output_validation_state = 'valid', error_json = NULL
                WHERE id = ? AND project_id = ? AND state = 'completed' AND output_validation_state = 'invalid_unapplied'`)
      .run(messageId, projectId);
    return true;
  })();
}

function markInvalidPunctuationResponse(
  db: SqliteDb,
  projectId: string,
  messageId: string,
  rawResponse: string,
  responseArtifactId: string,
  error: unknown,
): PunctuationSuggestionResult {
  const detail = error instanceof Error ? error.message : "표점 제안을 검증할 수 없습니다";
  insertResponsePart(db, projectId, messageId, rawResponse, responseArtifactId, {
    validationState: "invalid_unapplied",
    message: detail,
  });
  db.prepare(
    `UPDATE chat_messages
     SET state = 'completed', output_validation_state = 'invalid_unapplied', error_json = ?, completed_at = ?
     WHERE id = ? AND project_id = ? AND state = 'validating'`,
  ).run(canonicalJson({ code: "invalid_punctuation_suggestion", message: detail }), nowIso(), messageId, projectId);
  return {
    messageId,
    validationState: "invalid_unapplied",
    applied: false,
    punctuationVersionId: null,
    anchorSetId: null,
  };
}

function parsedPunctuationResult(
  messageId: string,
  validationState: string | null,
  structuredJson: string | null,
): PunctuationSuggestionResult {
  const structured = structuredJson ? JSON.parse(structuredJson) as Record<string, unknown> : {};
  return {
    messageId,
    validationState: validationState === "valid" ? "valid" : "invalid_unapplied",
    applied: structured.applied === true || typeof structured.punctuationVersionId === "string",
    punctuationVersionId: typeof structured.punctuationVersionId === "string" ? structured.punctuationVersionId : null,
    anchorSetId: typeof structured.anchorSetId === "string" ? structured.anchorSetId : null,
  };
}

export function completePunctuationSuggestion(
  db: SqliteDb,
  projectId: string,
  messageId: string,
  rawResponse: string,
): PunctuationSuggestionResult {
  return db.transaction((): PunctuationSuggestionResult => {
    const message = getRow<{
      state: string | null;
      task_kind: string | null;
      prompt_contract_version: string | null;
      request_manifest_json: string | null;
      response_artifact_id: string | null;
      response_hash: string | null;
      output_validation_state: string | null;
      structured_json: string | null;
    }>(
      db,
      `SELECT m.state, m.task_kind, m.prompt_contract_version, m.request_manifest_json, m.response_artifact_id,
              response.raw_sha256 AS response_hash, m.output_validation_state,
              part.structured_json
       FROM chat_messages m
       LEFT JOIN provenance_artifacts response ON response.id = m.response_artifact_id
       LEFT JOIN chat_message_parts part ON part.message_id = m.id AND part.ordinal = 1
       WHERE m.id = ? AND m.project_id = ? AND m.role = 'assistant'`,
      messageId,
      projectId,
    );
    if (!message || message.task_kind !== "punctuation_suggest" || !message.request_manifest_json || !message.response_artifact_id) {
      throw new MunhaeError("invalid_message", "stored punctuation suggestion response not found");
    }
    if (message.response_hash !== sha256Hex(rawResponse)) {
      throw new MunhaeError("idempotency_conflict", "punctuation response bytes do not match the stored artifact");
    }
    if (message.state === "completed") {
      return parsedPunctuationResult(messageId, message.output_validation_state, message.structured_json);
    }
    if (message.state !== "validating") {
      throw new MunhaeError("invalid_message_state", "punctuation response is not ready to complete");
    }
    const snapshot = parsePunctuationManifest(message.request_manifest_json);
    const source = getRow<{
      source_text_id: string;
      source_hash: string;
      source_text: string;
    }>(
      db,
      `SELECT source.source_text_id, source.content_hash AS source_hash, source.content_text AS source_text
       FROM src_text_versions source
       WHERE source.id = ? AND source.project_id = ?`,
      snapshot.sourceTextVersionId,
      projectId,
    );
    if (
      !source
      || source.source_text_id !== snapshot.sourceTextId
      || source.source_hash !== snapshot.sourceTextHash
    ) {
      throw new MunhaeError("invalid_dependency", "표점 제안 원문의 snapshot을 찾을 수 없습니다");
    }
    try {
      validatePunctuationProposal(source.source_text, rawResponse, snapshot.structureMode, message.prompt_contract_version);
    } catch (error) {
      return markInvalidPunctuationResponse(
        db,
        projectId,
        messageId,
        rawResponse,
        message.response_artifact_id,
        error,
      );
    }
    insertResponsePart(db, projectId, messageId, rawResponse, message.response_artifact_id, {
      validationState: "valid",
      applied: false,
      punctuationVersionId: null,
      anchorSetId: null,
    });
    const updated = db.prepare(
      `UPDATE chat_messages
       SET state = 'completed', output_validation_state = 'valid', error_json = NULL, completed_at = ?
       WHERE id = ? AND project_id = ? AND state = 'validating'`,
    ).run(nowIso(), messageId, projectId);
    if (updated.changes !== 1) {
      throw new MunhaeError("invalid_message_state", "punctuation response changed while completing");
    }
    return {
      messageId,
      validationState: "valid",
      applied: false,
      punctuationVersionId: null,
      anchorSetId: null,
    };
  })();
}

export function applyPunctuationSuggestion(
  db: SqliteDb,
  projectId: string,
  actors: ProjectActors,
  messageId: string,
): PunctuationSuggestionResult {
  return db.transaction((): PunctuationSuggestionResult => {
    revalidateRejectedPunctuationSuggestion(db, projectId, messageId);
    const message = getRow<{
      state: string | null;
      task_kind: string | null;
      request_manifest_json: string | null;
      response_artifact_id: string | null;
      response_text: string | null;
      response_hash: string | null;
      output_validation_state: string | null;
      structured_json: string | null;
    }>(
      db,
      `SELECT m.state, m.task_kind, m.request_manifest_json, m.response_artifact_id,
              response.payload_text AS response_text, response.raw_sha256 AS response_hash,
              m.output_validation_state, part.structured_json
       FROM chat_messages m
       LEFT JOIN provenance_artifacts response ON response.id = m.response_artifact_id
       LEFT JOIN chat_message_parts part ON part.message_id = m.id AND part.ordinal = 1
       WHERE m.id = ? AND m.project_id = ? AND m.role = 'assistant'`,
      messageId,
      projectId,
    );
    if (
      !message
      || message.task_kind !== "punctuation_suggest"
      || message.state !== "completed"
      || message.output_validation_state !== "valid"
      || !message.request_manifest_json
      || !message.response_artifact_id
      || message.response_text === null
      || message.response_hash !== sha256Hex(message.response_text)
    ) {
      throw new MunhaeError("invalid_punctuation_suggestion", "적용할 수 있는 검증된 표점 제안이 아닙니다");
    }
    const prior = parsedPunctuationResult(messageId, message.output_validation_state, message.structured_json);
    if (prior.applied) return prior;
    const rawResponse = message.response_text;
    const snapshot = parsePunctuationManifest(message.request_manifest_json);
    const current = getRow<{
      source_text_id: string;
      source_version_id: string;
      source_hash: string;
      source_state: string;
      source_text: string;
      punctuation_set_id: string | null;
      punctuation_version_id: string | null;
      punctuation_state: string | null;
      punctuation_version_no: number | null;
      punctuation_lock_version: number | null;
    }>(
      db,
      `SELECT source.id AS source_text_id, source_version.id AS source_version_id,
              source_version.content_hash AS source_hash, source_version.state AS source_state,
              source_version.content_text AS source_text,
              punctuation.id AS punctuation_set_id, punctuation_version.id AS punctuation_version_id,
              punctuation_version.state AS punctuation_state,
              punctuation_version.version_no AS punctuation_version_no,
              punctuation_head.lock_version AS punctuation_lock_version
       FROM src_texts source
       JOIN src_text_heads source_head ON source_head.source_text_id = source.id
       JOIN src_text_versions source_version ON source_version.id = source_head.current_version_id
       LEFT JOIN punctuation_sets punctuation ON punctuation.source_text_id = source.id AND punctuation.status = 'active'
       LEFT JOIN punctuation_heads punctuation_head ON punctuation_head.punctuation_set_id = punctuation.id
       LEFT JOIN punctuation_versions punctuation_version ON punctuation_version.id = punctuation_head.current_version_id
       WHERE source.project_id = ? AND source.document_node_id = ? AND source.tombstoned_at IS NULL
       ORDER BY punctuation.created_at LIMIT 1`,
      projectId,
      snapshot.documentNodeId,
    );
    if (
      !current
      || current.source_state !== "confirmed"
      || current.source_text_id !== snapshot.sourceTextId
      || current.source_version_id !== snapshot.sourceTextVersionId
      || current.source_hash !== snapshot.sourceTextHash
      || current.punctuation_set_id !== snapshot.punctuationSetId
      || current.punctuation_version_id !== snapshot.currentPunctuationVersionId
      || current.punctuation_lock_version !== snapshot.currentPunctuationLockVersion
    ) {
      throw new MunhaeError("stale_request", "AI 실행 중 원문 또는 표점안이 바뀌어 제안을 적용할 수 없습니다");
    }

    validatePunctuationText(current.source_text, rawResponse);
    prepareStructureSpans(rawResponse, snapshot.structureMode);
    const creatingInitialDraft = snapshot.punctuationSetId === null;
    let punctuationSetId = current.punctuation_set_id;
    if (creatingInitialDraft) {
      punctuationSetId = createId();
      const policy = getRow<{ id: string }>(
        db,
        `SELECT version.id
         FROM core_translation_policies policy
         JOIN core_translation_policy_heads head ON head.policy_id = policy.id
         JOIN core_translation_policy_versions version ON version.id = head.current_version_id
         WHERE policy.project_id = ?
         ORDER BY policy.created_at LIMIT 1`,
        projectId,
      );
      if (!policy) throw new MunhaeError("not_ready", "현재 번역 원칙을 찾을 수 없습니다");
      insertRow(db, "punctuation_sets", {
        id: punctuationSetId,
        project_id: projectId,
        source_text_id: current.source_text_id,
        name: `${snapshot.documentTitle} 표점`,
        policy_version_id: policy.id,
        status: "active",
        created_at: nowIso(),
      });
    }
    if (!punctuationSetId) {
      throw new MunhaeError("stale_request", "AI 실행 중 표점 작업 상태가 바뀌었습니다");
    }
    if (current.punctuation_state === "draft" && current.punctuation_version_id) {
      db.prepare(`UPDATE punctuation_versions SET state = 'superseded' WHERE id = ?`).run(current.punctuation_version_id);
    }
    const created = insertPunctuationVersionWithAnchors({
      db,
      projectId,
      documentNodeId: snapshot.documentNodeId,
      sourceTextId: current.source_text_id,
      sourceVersionId: current.source_version_id,
      sourceText: current.source_text,
      sourceContentHash: current.source_hash,
      punctuationSetId,
      parentVersionId: current.punctuation_version_id,
      versionNo: (current.punctuation_version_no ?? 0) + 1,
      punctuatedText: rawResponse,
      structureMode: snapshot.structureMode,
      changeSummary: "AI 표점 제안",
      actorId: actors.llmId,
      anchorActorId: actors.systemId,
      originKind: "ai",
      createAnchors: false,
      now: nowIso(),
    });
    if (creatingInitialDraft) {
      insertRow(db, "punctuation_heads", {
        project_id: projectId,
        punctuation_set_id: punctuationSetId,
        current_version_id: created.punctuationVersionId,
        confirmed_version_id: null,
        lock_version: 1,
        updated_at: nowIso(),
      });
    } else {
      const updated = db.prepare(
        `UPDATE punctuation_heads
         SET current_version_id = ?, lock_version = lock_version + 1, updated_at = ?
         WHERE project_id = ? AND punctuation_set_id = ? AND lock_version = ?`,
      ).run(
        created.punctuationVersionId,
        nowIso(),
        projectId,
        punctuationSetId,
        snapshot.currentPunctuationLockVersion,
      );
      if (updated.changes !== 1) throw new MunhaeError("cas_conflict", "stale punctuation lock_version");
    }
    recordPunctuationStaleness(db, projectId, snapshot.documentNodeId, created.punctuationVersionId);
    const partUpdated = db.prepare(
      `UPDATE chat_message_parts SET structured_json = ?
       WHERE project_id = ? AND message_id = ? AND ordinal = 1`,
    ).run(canonicalJson({
      ...JSON.parse(message.structured_json ?? "{}"),
      validationState: "valid",
      applied: true,
      punctuationVersionId: created.punctuationVersionId,
      anchorSetId: null,
    }), projectId, messageId);
    if (partUpdated.changes !== 1) throw new MunhaeError("invalid_message", "표점 제안 part를 찾을 수 없습니다");
    return {
      messageId,
      validationState: "valid",
      applied: true,
      punctuationVersionId: created.punctuationVersionId,
      anchorSetId: null,
    };
  })();
}

export function failProjectTaskRun(
  db: SqliteDb,
  projectId: string,
  messageId: string,
  error: { code: string; message: string },
  metadata: ProjectTaskFailureMetadata = {},
): void {
  db.transaction(() => {
    const current = getRow<{ state: string | null; events_artifact_id: string | null }>(
      db,
      `SELECT state, events_artifact_id FROM chat_messages
       WHERE id = ? AND project_id = ? AND role = 'assistant'
         AND task_kind IN ('chat', 'punctuation_suggest')`,
      messageId,
      projectId,
    );
    if (!current) throw new MunhaeError("invalid_message", "AI task assistant message not found");
    if (["completed", "failed", "canceled"].includes(current.state ?? "")) return;
    const events = metadata.eventsJsonl && !current.events_artifact_id
      ? insertArtifact(db, projectId, "agent_events", metadata.eventsJsonl)
      : null;
    const state = error.code === "canceled" ? "canceled" : "failed";
    const updated = db.prepare(
      `UPDATE chat_messages
       SET state = ?, error_json = ?, completed_at = ?, events_artifact_id = COALESCE(events_artifact_id, ?),
           usage_json = COALESCE(usage_json, ?), resolved_model = COALESCE(resolved_model, ?),
           runtime_version = COALESCE(runtime_version, ?)
       WHERE id = ? AND project_id = ? AND state IN ('queued', 'running', 'validating')`,
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
      throw new MunhaeError("invalid_message_state", "AI task state changed while recording failure");
    }
  })();
}

export function invalidateAgentSession(
  db: SqliteDb,
  projectId: string,
  threadId: string,
  agentId: "codex" | "claude" | "antigravity",
): void {
  db.prepare(
    `UPDATE chat_agent_sessions SET state = 'invalid', updated_at = ?
     WHERE project_id = ? AND thread_id = ? AND agent_id = ?`,
  ).run(nowIso(), projectId, threadId, agentId);
}

export function recoverInterruptedProjectTasks(
  db: SqliteDb,
  projectId: string,
  loadEventsJsonl?: (messageId: string) => string | undefined,
): void {
  const rows = allRows<{ id: string }>(
    db,
    `SELECT id FROM chat_messages
     WHERE project_id = ? AND role = 'assistant'
       AND task_kind IN ('chat', 'punctuation_suggest')
       AND state IN ('queued', 'running', 'validating')`,
    projectId,
  );
  for (const row of rows) {
    let eventsJsonl: string | undefined;
    try {
      eventsJsonl = loadEventsJsonl?.(row.id);
    } catch {
      // Recovery must still release the serialized thread if evidence is unreadable.
    }
    failProjectTaskRun(db, projectId, row.id, {
      code: "interrupted",
      message: "앱이 종료되어 AI 실행이 중단되었습니다",
    }, { eventsJsonl });
  }
}

export function renderProjectChatRequest(input: (
  | {
      snapshot: DocumentChatSnapshot;
      sourceText: string;
      punctuatedText: string;
      currentTranslations: Array<{ stage: string; text: string }>;
      question: string;
    }
  | {
      snapshot: ProjectOverviewChatSnapshot;
      question: string;
    }
)): { requestText: string; stablePromptHash: string } {
  if (input.snapshot.scopeKind === "project") {
    const requestText = [
      PROJECT_CHAT_STABLE_PROMPT,
      "",
      "[SCOPE project]",
      "This project overview intentionally contains no document source, punctuation, or translation bodies.",
      `[PROJECT ${input.snapshot.projectTitle}]`,
      "",
      "[DOCUMENT LIST AND WORKFLOW STATUS]",
      canonicalJson(input.snapshot.documents),
      "",
      "[ENABLED CONTEXT INHERITED FROM PROJECT MASTER]",
      input.snapshot.enabledProjectContext.length
        ? canonicalJson(input.snapshot.enabledProjectContext)
        : "(none)",
      "",
      "[USER QUESTION]",
      input.question,
    ].join("\n");
    return { requestText, stablePromptHash: PROJECT_CHAT_STABLE_PROMPT_HASH };
  }
  if (!("sourceText" in input)) {
    throw new MunhaeError("invalid_scope", "document chat content is missing");
  }
  const translations = input.currentTranslations.length
    ? input.currentTranslations.map((item) => `[${item.stage}]\n${item.text}`).join("\n\n")
    : "(no current translation draft)";
  const punctuationSection = input.snapshot.punctuationVersionId && input.snapshot.punctuationHash
    ? [
        `[PUNCTUATION version=${input.snapshot.punctuationVersionId} hash=${input.snapshot.punctuationHash}]`,
        input.punctuatedText,
      ]
    : ["[PUNCTUATION not_created]", "(The source has not reached the punctuation stage.)"];
  const requestText = [
    PROJECT_CHAT_STABLE_PROMPT,
    "",
    "[SCOPE document_node]",
    `[DOCUMENT ${input.snapshot.documentTitle}]`,
    `[SOURCE version=${input.snapshot.sourceTextVersionId} hash=${input.snapshot.sourceTextHash}]`,
    input.sourceText,
    "",
    ...punctuationSection,
    "",
    "[CURRENT TRANSLATIONS]",
    translations,
    "",
    "[USER QUESTION]",
    input.question,
  ].join("\n");
  return { requestText, stablePromptHash: PROJECT_CHAT_STABLE_PROMPT_HASH };
}

export function renderPunctuationSuggestionRequest(input: {
  snapshot: PunctuationSuggestionSnapshot;
  sourceText: string;
}): { requestText: string; stablePromptHash: string } {
  const requestText = [
    PUNCTUATION_STABLE_PROMPT,
    "",
    `[DOCUMENT ${input.snapshot.documentTitle}]`,
    `[STRUCTURE MODE ${input.snapshot.structureMode}]`,
    `[SOURCE version=${input.snapshot.sourceTextVersionId} hash=${input.snapshot.sourceTextHash}]`,
    input.sourceText,
  ].join("\n");
  return { requestText, stablePromptHash: PUNCTUATION_STABLE_PROMPT_HASH };
}
