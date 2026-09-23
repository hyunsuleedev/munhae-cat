import {
  canonicalJson,
  createId,
  MunhaeError,
  nowIso,
  sha256Hex,
  utf8ByteLength,
} from "@munhae/domain";
import type { ProjectActors } from "./bootstrap.ts";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { orm } from "./drizzle-db.ts";
import { schema } from "./drizzle-schema.ts";
import {
  insertPunctuationVersionWithAnchors,
  prepareStructureSpans,
  validatePunctuationText,
} from "./source-layer.ts";
import type { SqliteDb } from "./sqlite.ts";
import type { DocumentNodeRole, PunctuationStructureMode, VersionUiState } from "./views.ts";

const {
  provenance_artifacts: artifacts,
  chat_threads: threads,
  chat_messages: messages,
  chat_message_parts: parts,
  chat_agent_sessions: sessions,
  src_texts: sources,
  src_text_heads: sourceHeads,
  src_text_versions: sourceVersions,
  punctuation_sets: punctuationSets,
  punctuation_heads: punctuationHeads,
  punctuation_versions: punctuationVersions,
  document_translations: translations,
  document_translation_versions: translationVersions,
  translation_staleness: staleness,
  core_translation_policies: policies,
  core_translation_policy_heads: policyHeads,
  core_translation_policy_versions: policyVersions,
} = schema;

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
  referenceComments?: Array<{ referenceId: string; title: string; content: string; contentHash: string; priority: number }>;
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
  const existing = orm(db).select({ id: artifacts.id }).from(artifacts).where(and(
    eq(artifacts.project_id, projectId), eq(artifacts.artifact_kind, kind), eq(artifacts.canonical_sha256, rawHash),
  )).get();
  if (existing) return { id: existing.id, rawHash };
  const id = createId();
  orm(db).insert(schema.provenance_artifacts).values({
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
  }).run();
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
  const existing = orm(db).select({ id: threads.id }).from(threads).where(and(
    eq(threads.project_id, projectId), eq(threads.scope_kind, scopeKind), eq(threads.scope_id, scopeId), eq(threads.title, title),
  )).orderBy(asc(threads.created_at)).limit(1).get();
  if (existing) return existing.id;
  const id = createId();
  orm(db).insert(schema.chat_threads).values({
    id,
    project_id: projectId,
    title,
    scope_kind: scopeKind,
    scope_id: scopeId,
    created_by_actor_id: humanActorId,
    created_at: nowIso(),
  }).run();
  return id;
}

export function reserveProjectTaskRun(
  db: SqliteDb,
  projectId: string,
  actors: ProjectActors,
  input: ReserveProjectTaskInput,
): ReservedProjectTaskRun {
  return orm(db).transaction((): ReservedProjectTaskRun => {
    const manifest = requireCanonicalManifest(input);
    const threadId = findOrCreateProjectTaskThread(
      db,
      projectId,
      input.scopeKind,
      input.scopeId,
      input.taskKind,
      actors.humanId,
    );
    const busy = orm(db).select({ id: messages.id }).from(messages).where(and(
      eq(messages.thread_id, threadId), eq(messages.role, "assistant"), inArray(messages.state, ["queued", "running", "validating"]),
    )).limit(1).get();
    if (busy) throw new MunhaeError("thread_busy", "이 대화 범위의 AI 실행이 이미 진행 중입니다");

    const previous = orm(db).select({ id: messages.id }).from(messages).where(eq(messages.thread_id, threadId))
      .orderBy(desc(messages.created_at), sql`rowid DESC`).limit(1).get();
    let resumeCompatible = false;
    if (input.taskKind === "chat" && previous) {
      const session = orm(db).select().from(sessions).where(and(
        eq(sessions.project_id, projectId), eq(sessions.thread_id, threadId), eq(sessions.agent_id, input.agentId),
      )).get();
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
    orm(db).insert(schema.chat_messages).values({
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
    }).run();
    orm(db).insert(schema.chat_message_parts).values({
      id: createId(),
      project_id: projectId,
      message_id: userMessageId,
      ordinal: 1,
      part_kind: "text",
      text_content: input.userText,
      structured_json: null,
      artifact_id: null,
    }).run();

    const messageId = createId();
    orm(db).insert(schema.chat_messages).values({
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
    }).run();
    return {
      messageId,
      threadId,
      requestArtifactId: requestArtifact.id,
      requestHash: requestArtifact.rawHash,
      resumeCompatible,
    };
  });
}

export function storeProjectTaskResponse(
  db: SqliteDb,
  projectId: string,
  input: StoreProjectTaskResponseInput,
): { responseArtifactId: string; eventsArtifactId: string | null } {
  return orm(db).transaction(() => {
    const message = orm(db).select({
      role: messages.role, task_kind: messages.task_kind, state: messages.state,
      response_artifact_id: messages.response_artifact_id, events_artifact_id: messages.events_artifact_id,
      response_hash: artifacts.raw_sha256,
    }).from(messages).leftJoin(artifacts, eq(artifacts.id, messages.response_artifact_id))
      .where(and(eq(messages.id, input.messageId), eq(messages.project_id, projectId))).get();
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
    const updated = orm(db).update(messages).set({
      state: "validating", response_artifact_id: response.id, events_artifact_id: events?.id ?? null,
      usage_json: input.usage === null || input.usage === undefined ? null : canonicalJson(input.usage),
      resolved_model: sql`coalesce(${input.resolvedModel}, ${messages.resolved_model})`,
      runtime_version: sql`coalesce(${input.runtimeVersion}, ${messages.runtime_version})`,
      error_json: null,
    }).where(and(eq(messages.id, input.messageId), eq(messages.project_id, projectId),
      inArray(messages.state, ["running", "validating"]))).run();
    if (updated.changes !== 1) {
      throw new MunhaeError("invalid_message_state", "AI execution state changed while storing its response");
    }
    return { responseArtifactId: response.id, eventsArtifactId: events?.id ?? null };
  });
}

function insertResponsePart(
  db: SqliteDb,
  projectId: string,
  messageId: string,
  text: string,
  artifactId: string,
  structured: unknown = null,
): void {
  const existing = orm(db).select({ id: parts.id }).from(parts)
    .where(and(eq(parts.message_id, messageId), eq(parts.ordinal, 1))).get();
  if (existing) return;
  orm(db).insert(schema.chat_message_parts).values({
    id: createId(),
    project_id: projectId,
    message_id: messageId,
    ordinal: 1,
    part_kind: "text",
    text_content: text,
    structured_json: structured === null ? null : canonicalJson(structured),
    artifact_id: artifactId,
  }).run();
}

export function completeProjectChat(
  db: SqliteDb,
  projectId: string,
  messageId: string,
  responseText: string,
): void {
  orm(db).transaction(() => {
    const message = orm(db).select().from(messages).where(and(
      eq(messages.id, messageId), eq(messages.project_id, projectId), eq(messages.role, "assistant"),
    )).get();
    if (!message || message.task_kind !== "chat" || !message.response_artifact_id) {
      throw new MunhaeError("invalid_message", "stored project chat response not found");
    }
    if (message.state === "completed") return;
    if (message.state !== "validating") {
      throw new MunhaeError("invalid_message_state", "project chat response is not ready to complete");
    }
    insertResponsePart(db, projectId, messageId, responseText, message.response_artifact_id);
    orm(db).update(messages).set({
      state: "completed", output_validation_state: "not_applicable", error_json: null, completed_at: nowIso(),
    }).where(and(eq(messages.id, messageId), eq(messages.project_id, projectId), eq(messages.state, "validating"))).run();
  });
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
  const versions = orm(db).select({ id: translationVersions.id, old_dependency_id: translationVersions.punctuation_version_id })
    .from(translationVersions).innerJoin(translations, eq(translations.id, translationVersions.document_translation_id))
    .where(and(eq(translations.document_node_id, documentNodeId), eq(translations.project_id, projectId),
      ne(translationVersions.punctuation_version_id, punctuationVersionId))).all();
  const detectedAt = nowIso();
  for (const version of versions) {
    const existing = orm(db).select({ id: staleness.id }).from(staleness).where(and(
      eq(staleness.document_translation_version_id, version.id), eq(staleness.cause_kind, "punctuation_changed"),
      eq(staleness.new_dependency_id, punctuationVersionId), isNull(staleness.resolved_by_document_translation_version_id),
    )).get();
    if (existing) continue;
    orm(db).insert(schema.translation_staleness).values({
      id: createId(),
      project_id: projectId,
      document_translation_version_id: version.id,
      cause_kind: "punctuation_changed",
      old_dependency_id: version.old_dependency_id,
      new_dependency_id: punctuationVersionId,
      detected_at: detectedAt,
      resolved_by_document_translation_version_id: null,
    }).run();
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
  return orm(db).transaction(() => {
    const message = orm(db).select({
      request_manifest_json: messages.request_manifest_json, request_manifest_hash: messages.request_manifest_hash,
      prompt_contract_version: messages.prompt_contract_version, response_text: artifacts.payload_text,
      response_hash: artifacts.raw_sha256, text_content: parts.text_content,
      structured_json: parts.structured_json, error_json: messages.error_json,
    }).from(messages)
      .innerJoin(artifacts, and(eq(artifacts.id, messages.response_artifact_id), eq(artifacts.project_id, messages.project_id)))
      .innerJoin(parts, and(eq(parts.message_id, messages.id), eq(parts.project_id, messages.project_id), eq(parts.ordinal, 1)))
      .where(and(eq(messages.id, messageId), eq(messages.project_id, projectId), eq(messages.role, "assistant"),
        eq(messages.task_kind, "punctuation_suggest"), eq(messages.state, "completed"),
        eq(messages.output_validation_state, "invalid_unapplied"))).get();
    if (!message || typeof message.response_text !== "string" || !message.request_manifest_json
      || message.text_content !== message.response_text
      || sha256Hex(message.response_text) !== message.response_hash
      || sha256Hex(message.request_manifest_json) !== message.request_manifest_hash) return false;
    try {
      const snapshot = parsePunctuationManifest(message.request_manifest_json);
      const source = orm(db).select({ content_text: sourceVersions.content_text, content_hash: sourceVersions.content_hash })
        .from(sourceVersions).where(and(eq(sourceVersions.id, snapshot.sourceTextVersionId),
          eq(sourceVersions.source_text_id, snapshot.sourceTextId), eq(sourceVersions.project_id, projectId))).get();
      if (!source || source.content_hash !== snapshot.sourceTextHash || sha256Hex(source.content_text) !== snapshot.sourceTextHash) return false;
      validatePunctuationProposal(source.content_text, message.response_text, snapshot.structureMode, message.prompt_contract_version);
    } catch {
      return false;
    }
    const previousResult = JSON.parse(message.structured_json ?? "{}");
    if (previousResult?.applied || previousResult?.punctuationVersionId) return false;
    orm(db).update(parts).set({ structured_json: canonicalJson({
      validationState: "valid", applied: false, punctuationVersionId: null, anchorSetId: null,
      revalidation: {
        validator: "punctuation-whitespace.v1", at: nowIso(), previousResult,
        previousError: JSON.parse(message.error_json ?? "null"),
      },
    }) }).where(and(eq(parts.project_id, projectId), eq(parts.message_id, messageId), eq(parts.ordinal, 1))).run();
    orm(db).update(messages).set({ output_validation_state: "valid", error_json: null })
      .where(and(eq(messages.id, messageId), eq(messages.project_id, projectId), eq(messages.state, "completed"),
        eq(messages.output_validation_state, "invalid_unapplied"))).run();
    return true;
  });
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
  orm(db).update(messages).set({
    state: "completed", output_validation_state: "invalid_unapplied",
    error_json: canonicalJson({ code: "invalid_punctuation_suggestion", message: detail }), completed_at: nowIso(),
  }).where(and(eq(messages.id, messageId), eq(messages.project_id, projectId), eq(messages.state, "validating"))).run();
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
  return orm(db).transaction((): PunctuationSuggestionResult => {
    const message = orm(db).select({
      state: messages.state, task_kind: messages.task_kind, prompt_contract_version: messages.prompt_contract_version,
      request_manifest_json: messages.request_manifest_json, response_artifact_id: messages.response_artifact_id,
      response_hash: artifacts.raw_sha256, output_validation_state: messages.output_validation_state,
      structured_json: parts.structured_json,
    }).from(messages).leftJoin(artifacts, eq(artifacts.id, messages.response_artifact_id))
      .leftJoin(parts, and(eq(parts.message_id, messages.id), eq(parts.ordinal, 1)))
      .where(and(eq(messages.id, messageId), eq(messages.project_id, projectId), eq(messages.role, "assistant"))).get();
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
    const source = orm(db).select({ source_text_id: sourceVersions.source_text_id, source_hash: sourceVersions.content_hash,
      source_text: sourceVersions.content_text }).from(sourceVersions)
      .where(and(eq(sourceVersions.id, snapshot.sourceTextVersionId), eq(sourceVersions.project_id, projectId))).get();
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
    const updated = orm(db).update(messages).set({
      state: "completed", output_validation_state: "valid", error_json: null, completed_at: nowIso(),
    }).where(and(eq(messages.id, messageId), eq(messages.project_id, projectId), eq(messages.state, "validating"))).run();
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
  });
}

export function applyPunctuationSuggestion(
  db: SqliteDb,
  projectId: string,
  actors: ProjectActors,
  messageId: string,
): PunctuationSuggestionResult {
  return orm(db).transaction((): PunctuationSuggestionResult => {
    revalidateRejectedPunctuationSuggestion(db, projectId, messageId);
    const message = orm(db).select({
      state: messages.state, task_kind: messages.task_kind, request_manifest_json: messages.request_manifest_json,
      response_artifact_id: messages.response_artifact_id, response_text: artifacts.payload_text,
      response_hash: artifacts.raw_sha256, output_validation_state: messages.output_validation_state,
      structured_json: parts.structured_json,
    }).from(messages).leftJoin(artifacts, eq(artifacts.id, messages.response_artifact_id))
      .leftJoin(parts, and(eq(parts.message_id, messages.id), eq(parts.ordinal, 1)))
      .where(and(eq(messages.id, messageId), eq(messages.project_id, projectId), eq(messages.role, "assistant"))).get();
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
    const current = orm(db).select({
      source_text_id: sources.id, source_version_id: sourceVersions.id, source_hash: sourceVersions.content_hash,
      source_state: sourceVersions.state, source_text: sourceVersions.content_text,
      punctuation_set_id: punctuationSets.id, punctuation_version_id: punctuationVersions.id,
      punctuation_state: punctuationVersions.state, punctuation_version_no: punctuationVersions.version_no,
      punctuation_lock_version: punctuationHeads.lock_version,
    }).from(sources).innerJoin(sourceHeads, eq(sourceHeads.source_text_id, sources.id))
      .innerJoin(sourceVersions, eq(sourceVersions.id, sourceHeads.current_version_id))
      .leftJoin(punctuationSets, and(eq(punctuationSets.source_text_id, sources.id), eq(punctuationSets.status, "active")))
      .leftJoin(punctuationHeads, eq(punctuationHeads.punctuation_set_id, punctuationSets.id))
      .leftJoin(punctuationVersions, eq(punctuationVersions.id, punctuationHeads.current_version_id))
      .where(and(eq(sources.project_id, projectId), eq(sources.document_node_id, snapshot.documentNodeId), isNull(sources.tombstoned_at)))
      .orderBy(asc(punctuationSets.created_at)).limit(1).get();
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
      const policy = orm(db).select({ id: policyVersions.id }).from(policies)
        .innerJoin(policyHeads, eq(policyHeads.policy_id, policies.id))
        .innerJoin(policyVersions, eq(policyVersions.id, policyHeads.current_version_id))
        .where(eq(policies.project_id, projectId)).orderBy(asc(policies.created_at)).limit(1).get();
      if (!policy) throw new MunhaeError("not_ready", "현재 번역 원칙을 찾을 수 없습니다");
      orm(db).insert(schema.punctuation_sets).values({
        id: punctuationSetId,
        project_id: projectId,
        source_text_id: current.source_text_id,
        name: `${snapshot.documentTitle} 표점`,
        policy_version_id: policy.id,
        status: "active",
        created_at: nowIso(),
      }).run();
    }
    if (!punctuationSetId) {
      throw new MunhaeError("stale_request", "AI 실행 중 표점 작업 상태가 바뀌었습니다");
    }
    if (current.punctuation_state === "draft" && current.punctuation_version_id) {
      orm(db).update(punctuationVersions).set({ state: "superseded" })
        .where(eq(punctuationVersions.id, current.punctuation_version_id)).run();
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
      actorId: actors.llmId,
      anchorActorId: actors.systemId,
      originKind: "ai",
      createAnchors: false,
      now: nowIso(),
    });
    if (creatingInitialDraft) {
      orm(db).insert(schema.punctuation_heads).values({
        project_id: projectId,
        punctuation_set_id: punctuationSetId,
        current_version_id: created.punctuationVersionId,
        confirmed_version_id: null,
        lock_version: 1,
        updated_at: nowIso(),
      }).run();
    } else {
      const updated = orm(db).update(punctuationHeads).set({
        current_version_id: created.punctuationVersionId, lock_version: sql`${punctuationHeads.lock_version} + 1`, updated_at: nowIso(),
      }).where(and(eq(punctuationHeads.project_id, projectId), eq(punctuationHeads.punctuation_set_id, punctuationSetId),
        eq(punctuationHeads.lock_version, snapshot.currentPunctuationLockVersion!))).run();
      if (updated.changes !== 1) throw new MunhaeError("cas_conflict", "stale punctuation lock_version");
    }
    recordPunctuationStaleness(db, projectId, snapshot.documentNodeId, created.punctuationVersionId);
    const partUpdated = orm(db).update(parts).set({ structured_json: canonicalJson({
      ...JSON.parse(message.structured_json ?? "{}"),
      validationState: "valid", applied: true, punctuationVersionId: created.punctuationVersionId, anchorSetId: null,
    }) }).where(and(eq(parts.project_id, projectId), eq(parts.message_id, messageId), eq(parts.ordinal, 1))).run();
    if (partUpdated.changes !== 1) throw new MunhaeError("invalid_message", "표점 제안 part를 찾을 수 없습니다");
    return {
      messageId,
      validationState: "valid",
      applied: true,
      punctuationVersionId: created.punctuationVersionId,
      anchorSetId: null,
    };
  });
}

export function failProjectTaskRun(
  db: SqliteDb,
  projectId: string,
  messageId: string,
  error: { code: string; message: string },
  metadata: ProjectTaskFailureMetadata = {},
): void {
  orm(db).transaction(() => {
    const current = orm(db).select({ state: messages.state, events_artifact_id: messages.events_artifact_id }).from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.project_id, projectId), eq(messages.role, "assistant"),
        inArray(messages.task_kind, ["chat", "punctuation_suggest"]))).get();
    if (!current) throw new MunhaeError("invalid_message", "AI task assistant message not found");
    if (["completed", "failed", "canceled"].includes(current.state ?? "")) return;
    const events = metadata.eventsJsonl && !current.events_artifact_id
      ? insertArtifact(db, projectId, "agent_events", metadata.eventsJsonl)
      : null;
    const state = error.code === "canceled" ? "canceled" : "failed";
    const updated = orm(db).update(messages).set({
      state, error_json: canonicalJson({ code: error.code, message: error.message.slice(0, 800) }), completed_at: nowIso(),
      events_artifact_id: sql`coalesce(${messages.events_artifact_id}, ${events?.id ?? null})`,
      usage_json: sql`coalesce(${messages.usage_json}, ${metadata.usage === null || metadata.usage === undefined ? null : canonicalJson(metadata.usage)})`,
      resolved_model: sql`coalesce(${messages.resolved_model}, ${metadata.resolvedModel ?? null})`,
      runtime_version: sql`coalesce(${messages.runtime_version}, ${metadata.runtimeVersion ?? null})`,
    }).where(and(eq(messages.id, messageId), eq(messages.project_id, projectId),
      inArray(messages.state, ["queued", "running", "validating"]))).run();
    if (updated.changes !== 1) {
      throw new MunhaeError("invalid_message_state", "AI task state changed while recording failure");
    }
  });
}

export function invalidateAgentSession(
  db: SqliteDb,
  projectId: string,
  threadId: string,
  agentId: "codex" | "claude" | "antigravity",
): void {
  orm(db).update(sessions).set({ state: "invalid", updated_at: nowIso() })
    .where(and(eq(sessions.project_id, projectId), eq(sessions.thread_id, threadId), eq(sessions.agent_id, agentId))).run();
}

export function recoverInterruptedProjectTasks(
  db: SqliteDb,
  projectId: string,
  loadEventsJsonl?: (messageId: string) => string | undefined,
): void {
  const rows = orm(db).select({ id: messages.id }).from(messages).where(and(
    eq(messages.project_id, projectId), eq(messages.role, "assistant"),
    inArray(messages.task_kind, ["chat", "punctuation_suggest"]), inArray(messages.state, ["queued", "running", "validating"]),
  )).all();
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
      "[REFERENCE COMMENTS: questions and uncertainty are not established facts]",
      input.snapshot.referenceComments?.length ? canonicalJson(input.snapshot.referenceComments) : "(none)",
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
