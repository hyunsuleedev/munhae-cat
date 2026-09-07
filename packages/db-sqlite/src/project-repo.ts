import * as fullText from "./full-text.ts";
import * as reviewComments from "./review-comments.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  codepointCount,
  createId,
  joinBlockTranslations,
  MunhaeError,
  nowIso,
  sha256Hex,
  sliceCodepoints,
  utf8ByteLength,
} from "@munhae/domain";
import { checkpointAndZip, releaseLock, resolvePackagePath } from "@munhae/project-format";
import { bootstrapEmptyProject, openProjectDb, type ProjectActors } from "./bootstrap.ts";
import { allRows, getRow, insertRow } from "./rows.ts";
import { seedDemoContents } from "./seed-demo.ts";
import {
  ensureTranslationAnchorsForPunctuationVersion,
  insertPunctuationVersionWithAnchors,
  insertSourceLayer,
  prepareStructureSpans,
  validatePunctuationText,
} from "./source-layer.ts";
import { assertSqliteIntegrity, type SqliteDb } from "./sqlite.ts";
import {
  casUpdateHead,
  insertVersionBlocks,
  loadAnchors,
  loadBlocks,
  recordValidation,
  validateBlocks,
  type BlockDraft,
  type TranslationVersionRow,
} from "./translation.ts";
import {
  renderTranslationRequest,
  TRANSLATION_PROMPT_CONTRACT_VERSION,
} from "./ai-context.ts";
import {
  applyTranslationEnvelope as applyStoredTranslationEnvelope,
  captureTranslationHead,
  failTranslationRun as markTranslationRunFailed,
  recordInvalidTranslationResponse as storeInvalidTranslationResponse,
  reserveTranslationRun as reserveStoredTranslationRun,
  storeTranslationResponse,
  type RecordInvalidTranslationResponseInput,
  type TranslationRunFailureMetadata,
  upsertAgentSession,
} from "./ai-ledger.ts";
import {
  AGENT_EMPTY_CWD_HASH,
  applyPunctuationSuggestion,
  completePunctuationSuggestion,
  completeProjectChat,
  failProjectTaskRun as markProjectTaskRunFailed,
  invalidateAgentSession as markAgentSessionInvalid,
  PROJECT_CHAT_PROMPT_CONTRACT_VERSION,
  PUNCTUATION_SUGGEST_PROMPT_CONTRACT_VERSION,
  recoverInterruptedProjectTasks,
  revalidateRejectedPunctuationSuggestion,
  renderProjectChatRequest,
  renderPunctuationSuggestionRequest,
  reserveProjectTaskRun,
  storeProjectTaskResponse,
  type ProjectTaskFailureMetadata,
  type ProjectChatSnapshot,
  type PunctuationSuggestionSnapshot,
} from "./ai-tasks.ts";
import {
  attachReferenceAsset as attachStoredReferenceAsset,
  listReferenceAssets,
  readReferenceAsset as readStoredReferenceAsset,
  referenceAssetPath as resolveStoredReferenceAssetPath,
} from "./reference-assets.ts";
import {
  compareDocumentVersions,
  createConfirmedExport,
  loadDocumentHistory,
  searchProject,
  type ConfirmedExportInput,
  type ConfirmedExportPayload,
  type DocumentHistoryView,
  type SearchQueryInput,
  type SearchView,
  type VersionDiffInput,
  type VersionDiffView,
} from "./history-export-search.ts";
import {
  glossaryContentHash,
  glossaryContentJson,
  personContentHash,
  personContentJson,
  placeContentHash,
  placeContentJson,
} from "./knowledge-content.ts";
import {
  archiveContextItem as archiveStoredContextItem,
  assertNoOpenBlockingUncertainty,
  createContextItem as createStoredContextItem,
  createUncertainty as createStoredUncertainty,
  createUncertaintyVersion as createStoredUncertaintyVersion,
  getDocumentMetadata as loadDocumentMetadata,
  loadOpenUncertaintyIdsForDocument,
  loadUncertainties,
  resolveUncertainty as resolveStoredUncertainty,
  setContextItemEnabled as setStoredContextItemEnabled,
  setContextItemPriority as setStoredContextItemPriority,
  updateContextItem as updateStoredContextItem,
  updateDocumentMetadata as updateStoredDocumentMetadata,
} from "./knowledge-ops.ts";
import type {
  BeginProjectChatRunInput,
  BeginPunctuationSuggestionRunInput,
  BeginTranslationRunInput,
  CompleteProjectTaskRunInput,
  CompleteTranslationRunInput,
  CompletedPunctuationSuggestionRun,
  CompletedTranslationRun,
  ContextItemCasInput,
  ConfirmTranslationInput,
  ConfirmPunctuationInput,
  ConfirmSourceInput,
  ContextPreview,
  ContextPreviewInput,
  CreateReviewCommentInput,
  SaveSentenceLinkInput,
  ReviewCommentCasInput,
  UpdateReviewCommentInput,
  CreateContextItemInput,
  CreateDocumentInput,
  CreatePunctuationDraftInput,
  CreateTranslationDraftInput,
  CreateUncertaintyInput,
  CreateUncertaintyVersionInput,
  DocumentMetadataView,
  DocumentNodeRole,
  DocumentListItem,
  EditorView,
  GetProjectChatInput,
  GlossaryEntryView,
  HomeView,
  KnowledgeView,
  MergeBlocksInput,
  NodeContextView,
  PersonView,
  PlaceView,
  PreparedTranslationRun,
  PreparedProjectTaskRun,
  PunctuationSuggestionView,
  PunctuationStructureMode,
  PunctuationStructureSpanInput,
  ProjectSummary,
  ReferenceAssetContent,
  ResetTranslationDraftInput,
  ReviseTranslationInput,
  ResolveUncertaintyInput,
  SavePunctuationDraftInput,
  SaveSourceDraftInput,
  SaveTranslationDraftInput,
  SetContextItemEnabledInput,
  SetContextItemPriorityInput,
  SplitBlockInput,
  UncertaintyView,
  UpsertGlossaryInput,
  UpsertPersonInput,
  UpsertPlaceInput,
  UpdateContextItemInput,
  UpdateDocumentMetadataInput,
  VersionUiState,
} from "./views.ts";

const TRANSLATION_STAGE = "translation";

function translationPolicyRulesForPrompt(raw: string | null): unknown {
  if (!raw) return null;
  return JSON.parse(raw) as unknown;
}

function requirePositiveLockVersion(expected: number): number {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new MunhaeError("invalid_input", "expectedLockVersion은 1 이상의 정수여야 합니다");
  }
  return expected;
}

function requireKnowledgeLock(expected: number | undefined): number {
  if (!Number.isSafeInteger(expected) || (expected ?? 0) < 1) {
    throw new MunhaeError("invalid_input", "기존 지식 항목을 저장하려면 expectedLockVersion이 필요합니다");
  }
  return expected!;
}

function throwKnowledgeCasFailure(
  db: SqliteDb,
  projectId: string,
  table: "glossary_entries" | "persons" | "places",
  id: string,
): never {
  const row = getRow<{ lock_version: number }>(
    db,
    `SELECT lock_version FROM ${table} WHERE id = ? AND project_id = ? AND archived_at IS NULL`,
    id,
    projectId,
  );
  if (!row) throw new MunhaeError("not_found", "지식 항목을 찾을 수 없습니다");
  throw new MunhaeError("cas_conflict", `지식 항목이 다른 편집에서 변경되었습니다 (현재 lock_version ${row.lock_version})`);
}

export class ProjectRepo {
  readonly packagePath: string;
  readonly projectId: string;
  readonly title: string;
  readonly openedAt: string;
  private readonly db: SqliteDb;
  private readonly actors: ProjectActors;
  private readonly policyVersionId: string;
  private closed = false;

  constructor(boot: {
    db: SqliteDb;
    packagePath: string;
    projectId: string;
    title: string;
    actors: ProjectActors;
    policyVersionId: string;
  }) {
    this.db = boot.db;
    this.packagePath = boot.packagePath;
    this.projectId = boot.projectId;
    this.title = boot.title;
    this.actors = boot.actors;
    this.policyVersionId = boot.policyVersionId;
    this.openedAt = nowIso();
    this.db.prepare("UPDATE translation_text_layouts SET alignment_state='failed',alignment_error='앱이 종료되어 연결이 중단되었습니다. 다시 실행할 수 있습니다.' WHERE alignment_state='running'").run();
    this.recoverInterruptedTranslationRuns();
    recoverInterruptedProjectTasks(
      this.db,
      this.projectId,
      (messageId) => this.readInterruptedRunEvents(messageId),
    );
  }

  private summary(): ProjectSummary {
    return {
      projectId: this.projectId,
      title: this.title,
      packagePath: this.packagePath,
      storageMode: "local",
      openedAt: this.openedAt,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    releaseLock(this.packagePath);
  }

  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  backupTo(destFile: string): void {
    assertSqliteIntegrity(this.db);
    // A held WAL reader can prevent checkpointing without throwing. SQLite's
    // snapshot includes committed WAL pages independently of other readers.
    const staging = mkdtempSync(join(tmpdir(), "munhae-backup-"));
    try {
      const snapshotPath = join(staging, "project.sqlite3");
      this.db.prepare("VACUUM INTO ?").run(snapshotPath);
      checkpointAndZip(this.packagePath, destFile, {
        databaseSnapshot: readFileSync(snapshotPath),
      });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  getHome(): HomeView {
    const documents = this.listDocuments();
    const target = documents.filter((d) => d.nodeRole === "source_unit");
    const progress = {
      total: target.length,
      sourceConfirmed: target.filter((d) => d.sourceState === "confirmed").length,
      punctuationConfirmed: target.filter((d) => d.punctuationState === "confirmed").length,
      translationDraft: target.filter((d) => d.translationState === "draft" || d.translationState === "review").length,
      translationConfirmed: target.filter((d) => d.translationState === "confirmed").length,
    };
    const uncertainties = loadUncertainties(this.db, this.projectId)
      .filter((uncertainty) => uncertainty.state === "open")
      .map((uncertainty) => ({
        id: uncertainty.id,
        label: uncertainty.statementMd,
        category: uncertainty.category,
        locator: uncertainty.locator,
      }));

    const recent = allRows<{
      title: string;
      version_no: number;
      state: string;
      validation_state: string;
      origin_kind: string;
      created_at: string;
    }>(
      this.db,
      `SELECT n.title, v.version_no, v.state, v.validation_state, v.origin_kind, v.created_at
       FROM document_translation_versions v
       JOIN document_translations t ON t.id = v.document_translation_id
       JOIN document_nodes n ON n.id = t.document_node_id
       WHERE v.project_id = ?
       ORDER BY v.created_at DESC
       LIMIT 8`,
      this.projectId,
    ).map((r) => {
      let tag = "번역안";
      if (r.state === "confirmed") tag = "확정";
      else if (r.validation_state === "needs_review") tag = "재검토";
      const summary =
        r.state === "confirmed"
          ? `번역안 v${r.version_no} 확정`
          : r.origin_kind === "ai"
            ? `AI 제안 수신 — 번역안 v${r.version_no}`
            : `번역 블록 수정 → 번역안 v${r.version_no}`;
      return { title: r.title, summary, when: r.created_at, tag };
    });

    return {
      project: this.summary(),
      documents,
      progress,
      uncertainties,
      recent,
      agents: [],
    };
  }

  createDocument(input: CreateDocumentInput): DocumentListItem {
    return this.db.transaction(() => {
      const sourceText = input.nodeRole === "source_unit" ? input.sourceText.replace(/^\uFEFF/, "") : "";
      if (input.nodeRole === "source_unit" && !sourceText.trim()) {
        throw new MunhaeError("invalid_input", "원문 문서에는 원문 내용이 필요합니다");
      }
      const id = createId();
      const now = nowIso();
      const master = getRow<{ id: string }>(
        this.db,
        `SELECT id FROM document_nodes WHERE project_id = ? AND is_master = 1 AND archived_at IS NULL`,
        this.projectId,
      );
      if (!master) throw new MunhaeError("invalid_project", "프로젝트 마스터 폴더가 없습니다");
      const parentId = input.parentId ?? master.id;
      let ordinal = 0;
      if (parentId) {
        const parent = getRow<{ id: string; node_role: DocumentNodeRole }>(
          this.db,
          `SELECT id, node_role FROM document_nodes WHERE id = ? AND project_id = ?`,
          parentId,
          this.projectId,
        );
        if (!parent) throw new MunhaeError("not_found", "parent document not found");
        if (parent.node_role !== "container") {
          throw new MunhaeError("invalid_parent", "원문 문서 아래에는 하위 항목을 만들 수 없습니다");
        }
        const row = getRow<{ m: number | null }>(
          this.db,
          `SELECT MAX(ordinal) AS m FROM document_nodes WHERE project_id = ? AND parent_node_id = ?`,
          this.projectId,
          parentId,
        );
        ordinal = (row?.m ?? -1) + 1;
      }
      insertRow(this.db, "document_nodes", {
        id,
        project_id: this.projectId,
        parent_node_id: parentId,
        node_role: input.nodeRole,
        is_master: 0,
        title: input.title,
        original_title: input.originalTitle?.trim() || null,
        ordinal,
        author_person_id: null,
        language: null,
        period_text: null,
        date_text: null,
        description_md: null,
        source_reference: null,
        created_at: now,
        updated_at: now,
        archived_at: null,
      });
      if (input.nodeRole === "source_unit") {
        insertSourceLayer({
          db: this.db,
          projectId: this.projectId,
          documentNodeId: id,
          name: input.originalTitle?.trim() || input.title,
          text: sourceText,
          originKind: input.originKind,
          policyVersionId: this.policyVersionId,
          actors: this.actors,
          now,
          structureMode: "prose",
        });
      }
      const item = this.listDocuments().find((d) => d.id === id);
      if (!item) throw new MunhaeError("internal", "document insert failed");
      return item;
    })();
  }

  getEditor(documentNodeId: string): EditorView {
    const node = getRow<{
      id: string;
      title: string;
      original_title: string | null;
      node_role: DocumentNodeRole;
      author_person_id: string | null;
      language: string | null;
      period_text: string | null;
      date_text: string | null;
      source_reference: string | null;
      parent_node_id: string | null;
    }>(this.db, `SELECT * FROM document_nodes WHERE id = ? AND project_id = ?`, documentNodeId, this.projectId);
    if (!node) throw new MunhaeError("not_found", "document not found");
    if (node.node_role !== "source_unit") {
      throw new MunhaeError("not_ready", "목차 폴더에는 원문·표점안이 없습니다");
    }

    const inherited = this.inheritMetadata(node);
    const source = getRow<{
      version_id: string;
      version_no: number;
      lock_version: number;
      state: EditorView["source"]["state"];
      content_text: string;
      source_text_id: string;
    }>(
      this.db,
      `SELECT v.id AS version_id, v.version_no, h.lock_version, v.state, v.content_text,
              t.id AS source_text_id
       FROM src_texts t
       JOIN src_text_heads h ON h.source_text_id = t.id
       JOIN src_text_versions v ON v.id = h.current_version_id
       WHERE t.document_node_id = ? AND t.tombstoned_at IS NULL
       LIMIT 1`,
      documentNodeId,
    );
    if (!source) throw new MunhaeError("not_ready", "이 문서에는 원문이 없습니다");

    const punc = getRow<{
      version_id: string;
      version_no: number;
      lock_version: number;
      state: NonNullable<EditorView["punctuation"]>["state"];
      punctuated_text: string;
      structure_json: string | null;
      source_text_version_id: string;
      set_id: string;
    }>(
      this.db,
      `SELECT v.id AS version_id, v.version_no, h.lock_version, v.state, v.punctuated_text,
              v.structure_json, v.source_text_version_id, s.id AS set_id
       FROM punctuation_sets s
       JOIN punctuation_heads h ON h.punctuation_set_id = s.id
       JOIN punctuation_versions v ON v.id = h.current_version_id
       WHERE s.source_text_id = ?
       LIMIT 1`,
      source.source_text_id,
    );

    const anchorSet = punc ? getRow<{ id: string }>(
      this.db,
      `SELECT id FROM translation_anchor_sets
       WHERE document_node_id = ? AND punctuation_version_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      documentNodeId,
      punc.version_id,
    ) : undefined;

    const structureSpans = punc ? allRows<{
      id: string;
      span_kind: NonNullable<EditorView["punctuation"]>["structureSpans"][number]["spanKind"];
      parent_span_id: string | null;
      ordinal: number;
      codepoint_from: number;
      codepoint_to: number;
      quote: string;
      label: string | null;
    }>(
      this.db,
      `SELECT id, span_kind, parent_span_id, ordinal, codepoint_from, codepoint_to, quote, label
       FROM punctuation_structure_spans
       WHERE punctuation_version_id = ?
       ORDER BY codepoint_from, codepoint_to DESC, ordinal`,
      punc?.version_id ?? "",
    ) : [];

    const anchors = anchorSet ? allRows<{
      anchor_key: string;
      ordinal: number;
      boundary_kind: string;
      punctuation_codepoint_from: number;
      punctuation_codepoint_to: number;
      punctuated_quote: string;
    }>(
      this.db,
      `SELECT a.anchor_key, a.ordinal, a.boundary_kind, a.punctuation_codepoint_from,
              a.punctuation_codepoint_to, a.punctuated_quote
       FROM translation_anchors a
       WHERE a.anchor_set_id = ?
       ORDER BY a.ordinal`,
      anchorSet?.id ?? "",
    ) : [];

    const punctuationState: NonNullable<EditorView["punctuation"]>["state"] | null = punc
      ? (punc.source_text_version_id === source.version_id ? punc.state : "superseded")
      : null;
    const translationRow = getRow<TranslationVersionRow & {
      lock_version: number;
      unresolved_staleness: number;
    }>(
      this.db,
      `SELECT v.id, v.version_no, v.state, v.validation_state, v.text_content, v.origin_kind,
              v.parent_version_id, v.source_text_version_id, v.punctuation_version_id,
              v.translation_anchor_set_id, v.translation_policy_version_id, h.lock_version,
              (SELECT COUNT(*) FROM translation_staleness st
               WHERE st.document_translation_version_id = v.id
                 AND st.resolved_by_document_translation_version_id IS NULL) AS unresolved_staleness
       FROM document_translations t
       JOIN document_translation_heads h ON h.document_translation_id = t.id
       JOIN document_translation_versions v ON v.id = h.current_version_id
       WHERE t.document_node_id = ? AND t.project_id = ?
         AND t.tombstoned_at IS NULL
       LIMIT 1`,
      documentNodeId,
      this.projectId,
    );
    const textLayout = translationRow ? fullText.loadTextLayout(this.fullTextContext(), translationRow.id) : null;
    const translation: EditorView["translation"] = translationRow ? {
      versionId: translationRow.id,
      versionNo: translationRow.version_no,
      state: translationRow.state,
      validationState: translationRow.unresolved_staleness > 0 ? "needs_review" : translationRow.validation_state,
      textContent: translationRow.text_content,
      originKind: translationRow.origin_kind,
      ...(textLayout ? { textLayout } : {}),
      isCurrentDependencies: textLayout
        ? translationRow.source_text_version_id === source.version_id && (!translationRow.punctuation_version_id || (translationRow.punctuation_version_id === punc?.version_id && punctuationState === "confirmed"))
        : punctuationState === "confirmed" &&
        translationRow.unresolved_staleness === 0 &&
        translationRow.source_text_version_id === source.version_id &&
        translationRow.punctuation_version_id === punc?.version_id &&
        translationRow.translation_anchor_set_id === anchorSet?.id,
      lockVersion: translationRow.lock_version,
      blocks: loadBlocks(this.db, translationRow.id),
    } : null;
    const chat = this.loadChat({ documentNodeId, scopeKind: "document_node" });

    return {
      project: this.summary(),
      document: {
        id: node.id,
        title: node.title,
        originalTitle: node.original_title,
        nodeRole: node.node_role,
        authorName: inherited.authorName,
        periodText: inherited.periodText,
        dateText: node.date_text,
        language: inherited.language,
        sourceReference: inherited.sourceReference,
      },
      referenceAssets: listReferenceAssets({
        db: this.db,
        packagePath: this.packagePath,
        projectId: this.projectId,
        documentNodeId,
      }),
      source: {
        versionId: source.version_id,
        versionNo: source.version_no,
        lockVersion: source.lock_version,
        state: source.state,
        contentText: source.content_text,
      },
      punctuation: punc && punctuationState ? {
        versionId: punc.version_id,
        versionNo: punc.version_no,
        lockVersion: punc.lock_version,
        // A punctuation version is inseparable from its exact source version.
        // Keep the immutable historical row as-is, but expose a stale current
        // pointer as superseded so the editor cannot pass the translation gate.
        state: punctuationState,
        punctuatedText: punc.punctuated_text,
        structureMode: structureModeFromJson(punc.structure_json, structureSpans),
        structureSpans: structureSpans.map((span) => ({
          id: span.id,
          spanKind: span.span_kind,
          parentSpanId: span.parent_span_id,
          ordinal: span.ordinal,
          codepointFrom: span.codepoint_from,
          codepointTo: span.codepoint_to,
          quote: span.quote,
          label: span.label,
        })),
        anchorSetId: anchorSet?.id ?? null,
      } : null,
      anchors: anchors.map((a) => ({
        anchorKey: a.anchor_key,
        ordinal: a.ordinal,
        boundaryKind: a.boundary_kind,
        punctuationFrom: a.punctuation_codepoint_from,
        punctuationTo: a.punctuation_codepoint_to,
        punctuatedQuote: a.punctuated_quote,
      })),
      translation,
      chat,
    };
  }

  getChat(input: GetProjectChatInput): EditorView["chat"] {
    const node = getRow<{ id: string; node_role: DocumentNodeRole }>(
      this.db,
      `SELECT id, node_role FROM document_nodes WHERE id = ? AND project_id = ? AND archived_at IS NULL`,
      input.documentNodeId,
      this.projectId,
    );
    if (!node || node.node_role !== "source_unit") throw new MunhaeError("not_found", "document not found");
    return this.loadChat(input);
  }

  getLatestPunctuationSuggestion(documentNodeId: string): PunctuationSuggestionView | null {
    const row = getRow<{
      id: string;
      agent_id: string;
      text_content: string;
      output_validation_state: string | null;
      structured_json: string | null;
      created_at: string;
    }>(
      this.db,
      `SELECT m.id, m.agent_id, part.text_content, m.output_validation_state,
              part.structured_json, m.created_at
       FROM chat_threads thread
       JOIN chat_messages m ON m.thread_id = thread.id
       JOIN chat_message_parts part ON part.message_id = m.id AND part.ordinal = 1
       WHERE thread.project_id = ? AND thread.scope_kind = 'document_node' AND thread.scope_id = ?
         AND m.role = 'assistant' AND m.task_kind = 'punctuation_suggest' AND m.state = 'completed'
       ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
      this.projectId,
      documentNodeId,
    );
    if (!row || (row.agent_id !== "codex" && row.agent_id !== "claude" && row.agent_id !== "antigravity")) return null;
    if (row.output_validation_state === "invalid_unapplied"
      && revalidateRejectedPunctuationSuggestion(this.db, this.projectId, row.id)) {
      return this.getLatestPunctuationSuggestion(documentNodeId);
    }
    let structured: Record<string, unknown> = {};
    if (row.structured_json) {
      try {
        const parsed = JSON.parse(row.structured_json) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          structured = parsed as Record<string, unknown>;
        }
      } catch {
        // Valid JSON is enforced by SQLite; retain a defensive empty fallback.
      }
    }
    const punctuationVersionId = typeof structured.punctuationVersionId === "string"
      ? structured.punctuationVersionId
      : null;
    const anchorSetId = typeof structured.anchorSetId === "string" ? structured.anchorSetId : null;
    return {
      messageId: row.id,
      documentNodeId,
      agentId: row.agent_id,
      responseText: row.text_content,
      createdAt: row.created_at,
      validationState: row.output_validation_state === "valid" ? "valid" : "invalid_unapplied",
      validationError: row.output_validation_state !== "valid" && typeof structured.message === "string" ? structured.message : null,
      applied: structured.applied === true || !!punctuationVersionId,
      punctuationVersionId,
      anchorSetId,
    };
  }

  attachReferenceAsset(documentNodeId: string, sourcePath: string): EditorView {
    attachStoredReferenceAsset({
      db: this.db,
      packagePath: this.packagePath,
      projectId: this.projectId,
      documentNodeId,
      sourcePath,
      actorId: this.actors.humanId,
    });
    return this.getEditor(documentNodeId);
  }

  readReferenceAsset(documentNodeId: string, assetId: string): ReferenceAssetContent {
    return readStoredReferenceAsset({
      db: this.db,
      packagePath: this.packagePath,
      projectId: this.projectId,
      documentNodeId,
      assetId,
    });
  }

  referenceAssetPath(documentNodeId: string, assetId: string): string {
    return resolveStoredReferenceAssetPath({
      db: this.db,
      packagePath: this.packagePath,
      projectId: this.projectId,
      documentNodeId,
      assetId,
    });
  }

  saveSourceDraft(input: SaveSourceDraftInput): EditorView {
    const contentText = input.contentText.replace(/^\uFEFF/, "");
    if (!contentText.trim()) throw new MunhaeError("empty_source", "원문이 비어 있습니다");
    this.db.transaction(() => {
      const ctx = this.requireSource(input.documentNodeId);
      if (ctx.currentState === "draft") {
        this.db.prepare(`UPDATE src_text_versions SET state = 'superseded' WHERE id = ?`).run(ctx.currentVersionId);
      }
      const now = nowIso();
      const versionId = createId();
      insertRow(this.db, "src_text_versions", {
        id: versionId,
        project_id: this.projectId,
        source_text_id: ctx.sourceTextId,
        parent_version_id: ctx.currentVersionId,
        version_no: ctx.currentVersionNo + 1,
        content_text: contentText,
        origin_kind: input.originKind,
        source_asset_id: null,
        page_from: null,
        page_to: null,
        locator_text: null,
        change_summary: input.changeSummary?.trim() || null,
        state: "draft",
        content_hash: sha256Hex(contentText),
        created_by_actor_id: this.actors.humanId,
        created_at: now,
      });
      this.casSourceHead(ctx.sourceTextId, input.expectedLockVersion, versionId);
      this.recordTranslationStaleness(input.documentNodeId, "source_text_changed", versionId, "source_text_version_id");
    })();
    return this.getEditor(input.documentNodeId);
  }

  confirmSource(input: ConfirmSourceInput): EditorView {
    this.db.transaction(() => {
      const ctx = this.requireSource(input.documentNodeId);
      if (ctx.currentState === "confirmed") {
        throw new MunhaeError("already_confirmed", "이미 확정된 원문안입니다");
      }
      this.db.prepare(`UPDATE src_text_versions SET state = 'confirmed' WHERE id = ?`).run(ctx.currentVersionId);
      this.casSourceHead(ctx.sourceTextId, input.expectedLockVersion, ctx.currentVersionId, ctx.currentVersionId);
    })();
    return this.getEditor(input.documentNodeId);
  }

  createPunctuationDraftFromConfirmedSource(input: CreatePunctuationDraftInput): EditorView {
    this.db.transaction(() => {
      const source = this.requireSource(input.documentNodeId);
      if (source.lockVersion !== input.expectedSourceLockVersion) {
        throw new MunhaeError("cas_conflict", "원문안이 다른 편집에서 변경되었습니다");
      }
      if (source.currentState !== "confirmed" || source.confirmedVersionId !== source.currentVersionId) {
        throw new MunhaeError("source_not_confirmed", "현재 원문안을 확정한 뒤 표점 원문을 만들 수 있습니다");
      }
      const existing = getRow<{
        punctuation_set_id: string;
        current_version_id: string;
        lock_version: number;
        version_no: number;
        state: PunctuationCtx["currentState"];
        source_text_version_id: string;
      }>(
        this.db,
        `SELECT punctuation.id AS punctuation_set_id, head.current_version_id, head.lock_version,
                version.version_no, version.state, version.source_text_version_id
         FROM punctuation_sets punctuation
         JOIN punctuation_heads head ON head.punctuation_set_id = punctuation.id
         JOIN punctuation_versions version ON version.id = head.current_version_id
         WHERE punctuation.project_id = ? AND punctuation.source_text_id = ? AND punctuation.status = 'active'
         ORDER BY punctuation.created_at LIMIT 1`,
        this.projectId,
        source.sourceTextId,
      );
      if (existing?.source_text_version_id === source.currentVersionId) {
        throw new MunhaeError("punctuation_exists", "현재 원문에 대한 표점 작업안이 이미 있습니다");
      }

      const node = getRow<{ title: string; original_title: string | null }>(
        this.db,
        `SELECT title, original_title FROM document_nodes WHERE id = ? AND project_id = ?`,
        input.documentNodeId,
        this.projectId,
      );
      if (!node) throw new MunhaeError("not_found", "document not found");
      const now = nowIso();
      const punctuationSetId = existing?.punctuation_set_id ?? createId();
      if (!existing) {
        insertRow(this.db, "punctuation_sets", {
          id: punctuationSetId,
          project_id: this.projectId,
          source_text_id: source.sourceTextId,
          name: `${node.original_title?.trim() || node.title} 표점`,
          policy_version_id: this.policyVersionId,
          status: "active",
          created_at: now,
        });
      } else if (existing.state === "draft") {
        this.db.prepare(`UPDATE punctuation_versions SET state = 'superseded' WHERE id = ?`).run(
          existing.current_version_id,
        );
      }
      const created = insertPunctuationVersionWithAnchors({
        db: this.db,
        projectId: this.projectId,
        documentNodeId: input.documentNodeId,
        sourceTextId: source.sourceTextId,
        sourceVersionId: source.currentVersionId,
        sourceText: source.currentContentText,
        sourceContentHash: source.currentContentHash,
        punctuationSetId,
        parentVersionId: existing?.current_version_id ?? null,
        versionNo: (existing?.version_no ?? 0) + 1,
        punctuatedText: source.currentContentText,
        structureMode: input.structureMode,
        changeSummary: "확정 원문에서 표점 작업안 생성",
        actorId: this.actors.humanId,
        anchorActorId: this.actors.systemId,
        createAnchors: false,
        now,
      });
      if (!existing) {
        insertRow(this.db, "punctuation_heads", {
          project_id: this.projectId,
          punctuation_set_id: punctuationSetId,
          current_version_id: created.punctuationVersionId,
          confirmed_version_id: null,
          lock_version: 1,
          updated_at: now,
        });
      } else {
        this.casPunctuationHead(
          punctuationSetId,
          existing.lock_version,
          created.punctuationVersionId,
        );
      }
    })();
    return this.getEditor(input.documentNodeId);
  }

  savePunctuationDraft(input: SavePunctuationDraftInput): EditorView {
    this.db.transaction(() => {
      const source = this.requireSource(input.documentNodeId);
      if (source.currentState !== "confirmed" || source.confirmedVersionId !== source.currentVersionId) {
        throw new MunhaeError("source_not_confirmed", "현재 원문안을 확정해야 표점 작업안을 저장할 수 있습니다");
      }
      const punctuation = this.requirePunctuation(input.documentNodeId);
      if (punctuation.currentState === "draft") {
        this.db.prepare(`UPDATE punctuation_versions SET state = 'superseded' WHERE id = ?`).run(
          punctuation.currentVersionId,
        );
      }
      const now = nowIso();
      const created = insertPunctuationVersionWithAnchors({
        db: this.db,
        projectId: this.projectId,
        documentNodeId: input.documentNodeId,
        sourceTextId: source.sourceTextId,
        sourceVersionId: source.currentVersionId,
        sourceText: source.currentContentText,
        sourceContentHash: source.currentContentHash,
        punctuationSetId: punctuation.punctuationSetId,
        parentVersionId: punctuation.currentVersionId,
        versionNo: punctuation.currentVersionNo + 1,
        punctuatedText: input.punctuatedText.replace(/^\uFEFF/, ""),
        structureMode: input.structureMode,
        structureSpans: input.structureSpans,
        changeSummary: input.changeSummary,
        actorId: this.actors.humanId,
        anchorActorId: this.actors.systemId,
        createAnchors: false,
        now,
      });
      this.casPunctuationHead(
        punctuation.punctuationSetId,
        input.expectedLockVersion,
        created.punctuationVersionId,
      );
      this.recordTranslationStaleness(
        input.documentNodeId,
        "punctuation_changed",
        created.punctuationVersionId,
        "punctuation_version_id",
      );
    })();
    return this.getEditor(input.documentNodeId);
  }

  confirmPunctuation(input: ConfirmPunctuationInput): EditorView {
    this.db.transaction(() => {
      const source = this.requireSource(input.documentNodeId);
      const punctuation = this.requirePunctuation(input.documentNodeId);
      if (source.currentState !== "confirmed") {
        throw new MunhaeError("source_not_confirmed", "현재 원문안을 먼저 확정해야 표점안을 확정할 수 있습니다");
      }
      if (punctuation.currentState === "confirmed") {
        throw new MunhaeError("already_confirmed", "이미 확정된 표점안입니다");
      }
      if (punctuation.sourceVersionId !== source.currentVersionId) {
        throw new MunhaeError("stale_punctuation", "현재 원문안에서 새 표점안을 저장한 뒤 확정해야 합니다");
      }
      validatePunctuationText(source.currentContentText, punctuation.currentPunctuatedText);
      const storedSpans = this.loadStructureSpanInputs(punctuation.currentVersionId);
      prepareStructureSpans(
        punctuation.currentPunctuatedText,
        punctuation.structureMode,
        storedSpans,
      );
      ensureTranslationAnchorsForPunctuationVersion({
        db: this.db,
        projectId: this.projectId,
        documentNodeId: input.documentNodeId,
        punctuationVersionId: punctuation.currentVersionId,
        anchorActorId: this.actors.systemId,
        now: nowIso(),
      });
      this.validateStoredAnchorSet(input.documentNodeId, punctuation.currentVersionId);
      this.db.prepare(`UPDATE punctuation_versions SET state = 'confirmed' WHERE id = ?`).run(
        punctuation.currentVersionId,
      );
      this.casPunctuationHead(
        punctuation.punctuationSetId,
        input.expectedLockVersion,
        punctuation.currentVersionId,
        punctuation.currentVersionId,
      );
    })();
    return this.getEditor(input.documentNodeId);
  }

  createTranslationDraft(input: CreateTranslationDraftInput): EditorView {
    if (input.fullText) {
      fullText.createTextDraft(this.fullTextContext(),input.documentNodeId,input.expectedSourceLockVersion);
      return this.getEditor(input.documentNodeId);
    }
    if (
      !Number.isSafeInteger(input.expectedSourceLockVersion) ||
      input.expectedSourceLockVersion < 1 ||
      !Number.isSafeInteger(input.expectedPunctuationLockVersion) ||
      input.expectedPunctuationLockVersion < 1
    ) {
      throw new MunhaeError("invalid_input", "원문·표점 잠금 버전이 필요합니다");
    }

    this.db.transaction(() => {
      const source = this.requireSource(input.documentNodeId);
      const punctuation = this.requirePunctuation(input.documentNodeId);
      if (
        source.lockVersion !== input.expectedSourceLockVersion ||
        punctuation.lockVersion !== input.expectedPunctuationLockVersion
      ) {
        throw new MunhaeError("cas_conflict", "원문 또는 표점안이 다른 편집에서 변경되었습니다");
      }
      if (source.currentState !== "confirmed" || punctuation.currentState !== "confirmed") {
        throw new MunhaeError("not_confirmed", "원문안과 표점안을 확정해야 첫 번역안을 만들 수 있습니다");
      }
      if (punctuation.sourceVersionId !== source.currentVersionId) {
        throw new MunhaeError("stale_punctuation", "현재 원문에서 표점안을 다시 저장하고 확정해야 합니다");
      }
      this.validateStoredAnchorSet(input.documentNodeId, punctuation.currentVersionId);
      const anchorSet = getRow<{ id: string }>(
        this.db,
        `SELECT id FROM translation_anchor_sets
         WHERE document_node_id = ? AND source_text_version_id = ? AND punctuation_version_id = ?
         ORDER BY created_at DESC LIMIT 1`,
        input.documentNodeId,
        source.currentVersionId,
        punctuation.currentVersionId,
      );
      if (!anchorSet) throw new MunhaeError("not_ready", "현재 표점안의 번역 앵커가 없습니다");

      const policy = getRow<{ target_locale: string }>(
        this.db,
        `SELECT target_locale FROM core_translation_policy_versions WHERE id = ?`,
        this.policyVersionId,
      );
      if (!policy) throw new MunhaeError("not_ready", "현재 번역 원칙을 찾을 수 없습니다");
      const existing = getRow<{ id: string }>(
        this.db,
        `SELECT id FROM document_translations
         WHERE project_id = ? AND source_text_id = ? AND target_locale = ?`,
        this.projectId,
        source.sourceTextId,
        policy.target_locale,
      );
      if (existing) {
        throw new MunhaeError("already_exists", "이 번역 단계에는 이미 번역안이 있습니다");
      }

      const anchors = allRows<{
        id: string;
        anchor_key: string;
        ordinal: number;
        required: number;
        boundary_kind: string;
      }>(
        this.db,
        `SELECT id, anchor_key, ordinal, required, boundary_kind
         FROM translation_anchors WHERE anchor_set_id = ? ORDER BY ordinal`,
        anchorSet.id,
      );
      if (!anchors.length) throw new MunhaeError("not_ready", "현재 표점안의 번역 앵커가 비어 있습니다");
      const drafts: BlockDraft[] = anchors.map((anchor, index) => ({
        blockKey: `B${String(index + 1).padStart(3, "0")}`,
        blockKind: anchor.boundary_kind,
        translation: "",
        sourceAnchorIds: [anchor.anchor_key],
      }));
      const { findings, validationState } = validateBlocks(drafts, anchors);
      const translationId = createId();
      const versionId = createId();
      const createdAt = nowIso();
      const text = joinBlockTranslations(drafts.map((draft) => draft.translation));

      insertRow(this.db, "document_translations", {
        id: translationId,
        project_id: this.projectId,
        document_node_id: input.documentNodeId,
        source_text_id: source.sourceTextId,
        target_locale: policy.target_locale,
        created_at: createdAt,
        tombstoned_at: null,
      });
      insertRow(this.db, "document_translation_versions", {
        id: versionId,
        project_id: this.projectId,
        document_translation_id: translationId,
        parent_version_id: null,
        version_no: 1,
        source_text_version_id: source.currentVersionId,
        punctuation_version_id: punctuation.currentVersionId,
        translation_anchor_set_id: anchorSet.id,
        translation_policy_version_id: this.policyVersionId,
        text_content: text,
        origin_kind: "human",
        generated_by_message_id: null,
        validation_state: validationState,
        needs_review: validationState === "needs_review" ? 1 : 0,
        state: "draft",
        content_hash: sha256Hex(text),
        created_by_actor_id: this.actors.humanId,
        created_at: createdAt,
      });
      insertVersionBlocks(this.db, this.projectId, versionId, drafts, anchors, validationState);
      recordValidation(this.db, this.projectId, versionId, findings, validationState);
      insertRow(this.db, "document_translation_heads", {
        project_id: this.projectId,
        document_translation_id: translationId,
        current_version_id: versionId,
        confirmed_version_id: null,
        lock_version: 1,
        updated_at: createdAt,
      });
      insertRow(this.db, "user_edits", {
        id: createId(),
        project_id: this.projectId,
        document_translation_id: translationId,
        base_document_translation_version_id: null,
        result_document_translation_version_id: versionId,
        base_translation_block_id: null,
        target_codepoint_from: null,
        target_codepoint_to: null,
        base_artifact_id: null,
        result_artifact_id: null,
        patch_artifact_id: null,
        patch_format: null,
        edit_kind: "create_draft",
        reason: null,
        actor_id: this.actors.humanId,
        client_version: null,
        created_at: createdAt,
      });
    })();
    return this.getEditor(input.documentNodeId);
  }

  resetTranslationDraft(input: ResetTranslationDraftInput): EditorView {
    if (input.fullText) {
      fullText.createTextDraft(this.fullTextContext(),input.documentNodeId,input.expectedSourceLockVersion,input.expectedTranslationLockVersion);
      return this.getEditor(input.documentNodeId);
    }
    const expectedSourceLockVersion = requirePositiveLockVersion(input.expectedSourceLockVersion);
    const expectedPunctuationLockVersion = requirePositiveLockVersion(input.expectedPunctuationLockVersion);
    const expectedTranslationLockVersion = requirePositiveLockVersion(input.expectedTranslationLockVersion);
    this.db.transaction(() => {
      const ctx = this.requireTranslation(input.documentNodeId);
      if (
        ctx.sourceLockVersion !== expectedSourceLockVersion ||
        ctx.puncLockVersion !== expectedPunctuationLockVersion
      ) {
        throw new MunhaeError("cas_conflict", "원문 또는 표점안이 다른 편집에서 변경되었습니다");
      }
      const current = this.requireCurrentVersion(ctx.translationId);
      if (this.translationVersionMatchesCurrentDependencies(current, ctx)) {
        throw new MunhaeError("already_exists", "번역안이 이미 현재 원문과 분절을 사용하고 있습니다");
      }
      const anchors = loadAnchors(this.db, ctx.anchorSetId);
      const blocks: BlockDraft[] = anchors.map((anchor, index) => ({
        blockKey: `B${String(index + 1).padStart(3, "0")}`,
        blockKind: anchor.boundary_kind,
        translation: "",
        sourceAnchorIds: [anchor.anchor_key],
      }));
      this.insertDraftFromBlocks(ctx, blocks, {
        expectedLock: expectedTranslationLockVersion,
        originKind: "human",
        parentId: current.id,
        editKind: "reset_to_current_anchors",
        allowStaleParent: true,
      });
    })();
    return this.getEditor(input.documentNodeId);
  }

  saveTranslationDraft(input: SaveTranslationDraftInput): EditorView {
    if (this.getEditor(input.documentNodeId).translation?.textLayout) {
      fullText.saveText(this.fullTextContext(), input.documentNodeId, input.textContent ?? "", requirePositiveLockVersion(input.expectedLockVersion));
      return this.getEditor(input.documentNodeId);
    }
    const expectedLockVersion = requirePositiveLockVersion(input.expectedLockVersion);
    this.writeTranslation(input.documentNodeId, input.blocks, {
      expectedLockVersion,
      originKind: "human",
      editKind: "save_draft",
      expectedTextContent: input.textContent,
    });
    return this.getEditor(input.documentNodeId);
  }

  confirmTranslation(input: ConfirmTranslationInput): EditorView {
    if (this.getEditor(input.documentNodeId).translation?.textLayout) {
      assertNoOpenBlockingUncertainty(this.db, this.projectId, input.documentNodeId);
      fullText.confirmText(this.fullTextContext(), input.documentNodeId, requirePositiveLockVersion(input.expectedLockVersion));
      return this.getEditor(input.documentNodeId);
    }
    const expectedLockVersion = requirePositiveLockVersion(input.expectedLockVersion);
    this.db.transaction(() => {
      const ctx = this.requireTranslation(input.documentNodeId);
      const current = this.requireCurrentVersion(ctx.translationId);
      this.assertCurrentTranslationDependencies(current, ctx);
      if (current.state === "confirmed") {
        throw new MunhaeError("already_confirmed", "이미 확정된 번역안입니다");
      }
      if (current.validation_state !== "valid") {
        throw new MunhaeError("needs_review", "재검토가 필요한 번역안은 확정할 수 없습니다");
      }
      assertNoOpenBlockingUncertainty(this.db, this.projectId, input.documentNodeId);
      this.db
        .prepare(`UPDATE document_translation_versions SET state = 'confirmed' WHERE id = ?`)
        .run(current.id);
      casUpdateHead(this.db, ctx.translationId, expectedLockVersion, {
        currentVersionId: current.id,
        confirmedVersionId: current.id,
      });
    })();
    return this.getEditor(input.documentNodeId);
  }

  reviseTranslation(input: ReviseTranslationInput): EditorView {
    const editor = this.getEditor(input.documentNodeId);
    if (editor.translation?.textLayout) {
      fullText.saveText(this.fullTextContext(), input.documentNodeId, editor.translation.textContent, requirePositiveLockVersion(input.expectedLockVersion));
      return this.getEditor(input.documentNodeId);
    }
    const expectedLockVersion = requirePositiveLockVersion(input.expectedLockVersion);
    this.db.transaction(() => {
      const ctx = this.requireTranslation(input.documentNodeId);
      const current = this.requireCurrentVersion(ctx.translationId);
      this.assertCurrentTranslationDependencies(current, ctx);
      const blocks = loadBlocks(this.db, current.id);
      this.insertDraftFromBlocks(ctx, blocks, {
        expectedLock: expectedLockVersion,
        originKind: "human",
        parentId: current.id,
        editKind: "revise",
      });
    })();
    return this.getEditor(input.documentNodeId);
  }

  mergeBlocks(input: MergeBlocksInput): EditorView {
    const expectedLockVersion = requirePositiveLockVersion(input.expectedLockVersion);
    this.db.transaction(() => {
      const ctx = this.requireTranslation(input.documentNodeId);
      const current = this.requireCurrentVersion(ctx.translationId);
      this.assertCurrentTranslationDependencies(current, ctx);
      const blocks = loadBlocks(this.db, current.id);
      const leftIdx = blocks.findIndex((b) => b.blockKey === input.leftBlockKey);
      const rightIdx = blocks.findIndex((b) => b.blockKey === input.rightBlockKey);
      if (leftIdx < 0 || rightIdx < 0 || rightIdx !== leftIdx + 1) {
        throw new MunhaeError("invalid_blocks", "합칠 블록이 인접하지 않습니다");
      }
      const left = blocks[leftIdx]!;
      const right = blocks[rightIdx]!;
      const merged: BlockDraft = {
        blockKey: left.blockKey,
        blockKind: left.blockKind,
        translation: `${left.translation} ${right.translation}`,
        sourceAnchorIds: uniqueKeep(left.sourceAnchorIds.concat(right.sourceAnchorIds)),
        relationKinds: undefined,
      };
      const next = [...blocks.slice(0, leftIdx), merged, ...blocks.slice(rightIdx + 1)];
      this.insertDraftFromBlocks(ctx, next, {
        expectedLock: expectedLockVersion,
        originKind: "human",
        parentId: current.id,
        editKind: "merge_blocks",
      });
    })();
    return this.getEditor(input.documentNodeId);
  }

  splitBlock(input: SplitBlockInput): EditorView {
    const expectedLockVersion = requirePositiveLockVersion(input.expectedLockVersion);
    this.db.transaction(() => {
      const ctx = this.requireTranslation(input.documentNodeId);
      const current = this.requireCurrentVersion(ctx.translationId);
      this.assertCurrentTranslationDependencies(current, ctx);
      const blocks = loadBlocks(this.db, current.id);
      const idx = blocks.findIndex((b) => b.blockKey === input.blockKey);
      const target = blocks[idx];
      if (!target) throw new MunhaeError("invalid_blocks", "나눌 블록을 찾을 수 없습니다");
      const len = codepointCount(target.translation);
      if (!Number.isInteger(input.splitAt) || input.splitAt <= 0 || input.splitAt >= len) {
        throw new MunhaeError("invalid_split", "나눌 위치는 블록 안의 Unicode code-point 경계여야 합니다");
      }
      const leftText = sliceCodepoints(target.translation, 0, input.splitAt).trim();
      const rightText = sliceCodepoints(target.translation, input.splitAt, len).trim();
      if (!leftText || !rightText) {
        throw new MunhaeError("invalid_split", "나눈 두 번역 블록은 모두 내용이 있어야 합니다");
      }
      const uniqueAnchors = uniqueKeep(target.sourceAnchorIds);
      let left: BlockDraft;
      let right: BlockDraft;
      if (uniqueAnchors.length <= 1) {
        if (input.anchorSplitAt !== undefined) {
          throw new MunhaeError("invalid_anchor_split", "단일 앵커 블록에는 앵커 분할 경계를 지정할 수 없습니다");
        }
        const key = uniqueAnchors[0] ? [uniqueAnchors[0]] : [];
        left = {
          blockKey: `${target.blockKey}a`,
          blockKind: target.blockKind,
          translation: leftText,
          sourceAnchorIds: key,
          relationKinds: key.map(() => "partial"),
        };
        right = {
          blockKey: `${target.blockKey}b`,
          blockKind: target.blockKind,
          translation: rightText,
          sourceAnchorIds: key,
          relationKinds: key.map(() => "partial"),
        };
      } else {
        const proportional = Math.round((uniqueAnchors.length * input.splitAt) / len);
        const anchorSplitAt = input.anchorSplitAt ?? Math.max(1, Math.min(uniqueAnchors.length - 1, proportional));
        if (!Number.isInteger(anchorSplitAt) || anchorSplitAt <= 0 || anchorSplitAt >= uniqueAnchors.length) {
          throw new MunhaeError(
            "invalid_anchor_split",
            "앵커 분할 위치는 sourceAnchorIds 배열 안의 경계여야 합니다",
          );
        }
        left = {
          blockKey: `${target.blockKey}a`,
          blockKind: target.blockKind,
          translation: leftText,
          sourceAnchorIds: uniqueAnchors.slice(0, anchorSplitAt),
        };
        right = {
          blockKey: `${target.blockKey}b`,
          blockKind: target.blockKind,
          translation: rightText,
          sourceAnchorIds: uniqueAnchors.slice(anchorSplitAt),
        };
      }
      const next = [...blocks.slice(0, idx), left, right, ...blocks.slice(idx + 1)];
      this.insertDraftFromBlocks(ctx, next, {
        expectedLock: expectedLockVersion,
        originKind: "human",
        parentId: current.id,
        editKind: "split_block",
      });
    })();
    return this.getEditor(input.documentNodeId);
  }

  getDocumentHistory(documentNodeId: string): DocumentHistoryView {
    return loadDocumentHistory(this.db, this.projectId, documentNodeId);
  }

  compareVersions(input: VersionDiffInput): VersionDiffView {
    return compareDocumentVersions(this.db, this.projectId, input);
  }

  createConfirmedExport(input: ConfirmedExportInput): ConfirmedExportPayload {
    return createConfirmedExport(this.db, this.projectId, input);
  }

  search(input: SearchQueryInput): SearchView {
    return searchProject(this.db, this.projectId, input);
  }

  getKnowledge(): KnowledgeView {
    const glossary = allRows<{
      id: string;
      source_term: string;
      target_term: string;
      target_locale: string;
      term_kind: string;
      reading: string | null;
      note_md: string | null;
      usage_status: GlossaryEntryView["usageStatus"];
      content_hash: string;
      lock_version: number;
    }>(
      this.db,
      `SELECT id, source_term, target_term, target_locale, term_kind, reading, note_md, usage_status,
              content_hash, lock_version
       FROM glossary_entries WHERE project_id = ? AND archived_at IS NULL
       ORDER BY source_term, usage_status`,
      this.projectId,
    ).map((g) => ({
      id: g.id,
      contentHash: g.content_hash,
      lockVersion: g.lock_version,
      sourceTerm: g.source_term,
      targetTerm: g.target_term,
      targetLocale: g.target_locale,
      termKind: g.term_kind,
      reading: g.reading,
      noteMd: g.note_md,
      usageStatus: g.usage_status,
    }));

    const persons: PersonView[] = allRows<{
      id: string;
      preferred_name: string;
      hanja_name: string | null;
      reading: string | null;
      aliases_json: string;
      description_md: string | null;
      date_text: string | null;
      content_hash: string;
      lock_version: number;
    }>(
      this.db,
      `SELECT id, preferred_name, hanja_name, reading, aliases_json, description_md, date_text,
              content_hash, lock_version
       FROM persons WHERE project_id = ? AND archived_at IS NULL ORDER BY preferred_name`,
      this.projectId,
    ).map((p) => ({
      id: p.id,
      contentHash: p.content_hash,
      lockVersion: p.lock_version,
      preferredName: p.preferred_name,
      hanjaName: p.hanja_name,
      reading: p.reading,
      aliases: JSON.parse(p.aliases_json) as string[],
      descriptionMd: p.description_md,
      dateText: p.date_text,
    }));

    const places: PlaceView[] = allRows<{
      id: string;
      preferred_name: string;
      hanja_name: string | null;
      reading: string | null;
      aliases_json: string;
      place_kind: string | null;
      location_note_md: string | null;
      description_md: string | null;
      content_hash: string;
      lock_version: number;
    }>(
      this.db,
      `SELECT id, preferred_name, hanja_name, reading, aliases_json, place_kind, location_note_md,
              description_md, content_hash, lock_version
       FROM places WHERE project_id = ? AND archived_at IS NULL ORDER BY preferred_name`,
      this.projectId,
    ).map((p) => ({
      id: p.id,
      contentHash: p.content_hash,
      lockVersion: p.lock_version,
      preferredName: p.preferred_name,
      hanjaName: p.hanja_name,
      reading: p.reading,
      aliases: JSON.parse(p.aliases_json) as string[],
      placeKind: p.place_kind,
      locationNoteMd: p.location_note_md,
      descriptionMd: p.description_md,
    }));

    const uncertainties = loadUncertainties(this.db, this.projectId);

    const contextItems: NodeContextView[] = allRows<{
      id: string;
      scope_id: string;
      title: string;
      content_md: string;
      priority: number;
      enabled: number;
      lock_version: number;
      updated_at: string;
    }>(
      this.db,
      `SELECT id, scope_id, title, content_md, priority, enabled, lock_version, updated_at
       FROM context_items
       WHERE project_id = ? AND archived_at IS NULL
         AND scope_kind = 'document_node' AND scope_id IS NOT NULL`,
      this.projectId,
    ).map((item) => ({
      id: item.id,
      source: "context_item",
      scopeKind: "document_node",
      scopeId: item.scope_id,
      title: item.title,
      contentMd: item.content_md,
      priority: item.priority,
      enabled: item.enabled === 1,
      lockVersion: item.lock_version,
      updatedAt: item.updated_at,
    }));
    const descriptions = allRows<{
      id: string;
      title: string;
      original_title: string | null;
      description_md: string;
      lock_version: number;
      updated_at: string;
    }>(
      this.db,
      `SELECT id, title, original_title, description_md, lock_version, updated_at
       FROM document_nodes
       WHERE project_id = ? AND archived_at IS NULL AND trim(COALESCE(description_md, '')) <> ''`,
      this.projectId,
    ).map<NodeContextView>((node) => ({
      id: `document:${node.id}:description`,
      source: "document_description",
      scopeKind: "document_node",
      scopeId: node.id,
      title: `문서 설명 · ${node.original_title || node.title}`,
      contentMd: node.description_md,
      priority: 0,
      enabled: true,
      lockVersion: node.lock_version,
      updatedAt: node.updated_at,
    }));

    contextItems.push(...descriptions);
    contextItems.sort((a, b) => b.priority - a.priority || a.updatedAt.localeCompare(b.updatedAt));

    return { glossary, persons, places, uncertainties, contextItems };
  }

  upsertGlossary(entry: UpsertGlossaryInput): GlossaryEntryView {
    const now = nowIso();
    const id = entry.id ?? createId();
    const hash = glossaryContentHash(entry);
    if (entry.id) {
      const info = this.db
        .prepare(
          `UPDATE glossary_entries SET source_term=@sourceTerm, target_term=@targetTerm, target_locale=@targetLocale,
           term_kind=@termKind, reading=@reading, note_md=@noteMd, usage_status=@usageStatus,
           content_hash=@hash, lock_version=lock_version+1, updated_by_actor_id=@actor, updated_at=@now
           WHERE id=@id AND project_id=@projectId AND archived_at IS NULL AND lock_version=@lock`,
        )
        .run({
          id,
          projectId: this.projectId,
          lock: requireKnowledgeLock(entry.expectedLockVersion),
          sourceTerm: entry.sourceTerm,
          targetTerm: entry.targetTerm,
          targetLocale: entry.targetLocale,
          termKind: entry.termKind,
          reading: entry.reading,
          noteMd: entry.noteMd,
          usageStatus: entry.usageStatus,
          hash,
          actor: this.actors.humanId,
          now,
        });
      if (info.changes !== 1) throwKnowledgeCasFailure(this.db, this.projectId, "glossary_entries", id);
    } else {
      insertRow(this.db, "glossary_entries", {
        id,
        project_id: this.projectId,
        source_term: entry.sourceTerm,
        target_locale: entry.targetLocale,
        target_term: entry.targetTerm,
        term_kind: entry.termKind,
        reading: entry.reading,
        note_md: entry.noteMd,
        usage_status: entry.usageStatus,
        content_hash: hash,
        lock_version: 1,
        created_by_actor_id: this.actors.humanId,
        updated_by_actor_id: this.actors.humanId,
        created_at: now,
        updated_at: now,
        archived_at: null,
      });
    }
    const row = this.getKnowledge().glossary.find((g) => g.id === id);
    if (!row) throw new MunhaeError("internal", "glossary upsert failed");
    return row;
  }

  upsertPerson(person: UpsertPersonInput): PersonView {
    const now = nowIso();
    const id = person.id ?? createId();
    const hash = personContentHash(person);
    if (person.id) {
      const info = this.db
        .prepare(
          `UPDATE persons SET preferred_name=@preferredName, hanja_name=@hanjaName, reading=@reading,
           aliases_json=@aliases, description_md=@descriptionMd, date_text=@dateText,
           content_hash=@hash, lock_version=lock_version+1, updated_by_actor_id=@actor, updated_at=@now
           WHERE id=@id AND project_id=@projectId AND archived_at IS NULL AND lock_version=@lock`,
        )
        .run({
          id,
          projectId: this.projectId,
          lock: requireKnowledgeLock(person.expectedLockVersion),
          preferredName: person.preferredName,
          hanjaName: person.hanjaName,
          reading: person.reading,
          aliases: JSON.stringify(person.aliases),
          descriptionMd: person.descriptionMd,
          dateText: person.dateText,
          hash,
          actor: this.actors.humanId,
          now,
        });
      if (info.changes !== 1) throwKnowledgeCasFailure(this.db, this.projectId, "persons", id);
    } else {
      insertRow(this.db, "persons", {
        id,
        project_id: this.projectId,
        preferred_name: person.preferredName,
        hanja_name: person.hanjaName,
        reading: person.reading,
        aliases_json: JSON.stringify(person.aliases),
        description_md: person.descriptionMd,
        date_text: person.dateText,
        content_hash: hash,
        lock_version: 1,
        created_by_actor_id: this.actors.humanId,
        updated_by_actor_id: this.actors.humanId,
        created_at: now,
        updated_at: now,
        archived_at: null,
      });
    }
    const row = this.getKnowledge().persons.find((p) => p.id === id);
    if (!row) throw new MunhaeError("internal", "person upsert failed");
    return row;
  }

  upsertPlace(place: UpsertPlaceInput): PlaceView {
    const now = nowIso();
    const id = place.id ?? createId();
    const hash = placeContentHash(place);
    if (place.id) {
      const info = this.db
        .prepare(
          `UPDATE places SET preferred_name=@preferredName, hanja_name=@hanjaName, reading=@reading,
           aliases_json=@aliases, place_kind=@placeKind, location_note_md=@locationNoteMd,
           description_md=@descriptionMd, content_hash=@hash, lock_version=lock_version+1,
           updated_by_actor_id=@actor, updated_at=@now
           WHERE id=@id AND project_id=@projectId AND archived_at IS NULL AND lock_version=@lock`,
        )
        .run({
          id,
          projectId: this.projectId,
          lock: requireKnowledgeLock(place.expectedLockVersion),
          preferredName: place.preferredName,
          hanjaName: place.hanjaName,
          reading: place.reading,
          aliases: JSON.stringify(place.aliases),
          placeKind: place.placeKind,
          locationNoteMd: place.locationNoteMd,
          descriptionMd: place.descriptionMd,
          hash,
          actor: this.actors.humanId,
          now,
        });
      if (info.changes !== 1) throwKnowledgeCasFailure(this.db, this.projectId, "places", id);
    } else {
      insertRow(this.db, "places", {
        id,
        project_id: this.projectId,
        preferred_name: place.preferredName,
        hanja_name: place.hanjaName,
        reading: place.reading,
        aliases_json: JSON.stringify(place.aliases),
        place_kind: place.placeKind,
        location_note_md: place.locationNoteMd,
        description_md: place.descriptionMd,
        content_hash: hash,
        lock_version: 1,
        created_by_actor_id: this.actors.humanId,
        updated_by_actor_id: this.actors.humanId,
        created_at: now,
        updated_at: now,
        archived_at: null,
      });
    }
    const row = this.getKnowledge().places.find((p) => p.id === id);
    if (!row) throw new MunhaeError("internal", "place upsert failed");
    return row;
  }

  getDocumentMetadata(documentNodeId: string): DocumentMetadataView {
    return loadDocumentMetadata(this.db, this.projectId, documentNodeId);
  }

  updateDocumentMetadata(input: UpdateDocumentMetadataInput): DocumentMetadataView {
    return updateStoredDocumentMetadata(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  createContextItem(input: CreateContextItemInput): NodeContextView {
    return createStoredContextItem(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  updateContextItem(input: UpdateContextItemInput): NodeContextView {
    return updateStoredContextItem(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  setContextItemEnabled(input: SetContextItemEnabledInput): NodeContextView {
    return setStoredContextItemEnabled(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  setContextItemPriority(input: SetContextItemPriorityInput): NodeContextView {
    return setStoredContextItemPriority(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  archiveContextItem(input: ContextItemCasInput): void {
    archiveStoredContextItem(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  createUncertainty(input: CreateUncertaintyInput): UncertaintyView {
    return createStoredUncertainty(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  createUncertaintyVersion(input: CreateUncertaintyVersionInput): UncertaintyView {
    return createStoredUncertaintyVersion(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  resolveUncertainty(input: ResolveUncertaintyInput): UncertaintyView {
    return resolveStoredUncertainty(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  private fullTextContext() {
    return { db:this.db, actors:this.actors, policyVersionId:this.policyVersionId, projectId:this.projectId,
      getEditor:(id:string)=>this.getEditor(id), getHome:()=>this.getHome(), getKnowledge:()=>this.getKnowledge() };
  }

  previewContext(input: ContextPreviewInput): fullText.FullTextPreview { return fullText.previewText(this.fullTextContext(), input); }

  listReviewComments(documentNodeId: string) { return reviewComments.listReviewComments(this.fullTextContext(), documentNodeId); }
  saveSentenceLink(input: SaveSentenceLinkInput): EditorView {
    fullText.saveSentenceLink(this.fullTextContext(), input);
    return this.getEditor(input.documentNodeId);
  }
  createReviewComment(input: CreateReviewCommentInput) { return reviewComments.createReviewComment(this.fullTextContext(), input); }
  updateReviewComment(input: UpdateReviewCommentInput) { return reviewComments.updateReviewComment(this.fullTextContext(), input); }
  archiveReviewComment(input: ReviewCommentCasInput) { reviewComments.archiveReviewComment(this.fullTextContext(), input); }

  beginFullTextRun(input: BeginTranslationRunInput & {alignmentVersionId?:string}) { return fullText.beginText(this.fullTextContext(), input); }
  finishFullTextRun(input: CompleteTranslationRunInput) { fullText.finishTextRun(this.fullTextContext(),input); }
  completeFullTextRun(input: CompleteTranslationRunInput) { return fullText.completeText(this.fullTextContext(), input); }
  prepareAlignment(versionId: string) { return fullText.alignmentRequest(this.fullTextContext(), versionId); }
  completeAlignment(versionId: string, raw: string) { return fullText.completeAlignment(this.fullTextContext(), versionId, raw); }
  failAlignment(versionId: string, message: string) { fullText.failAlignment(this.fullTextContext(), versionId, message); }

  previewLegacyContext(input: ContextPreviewInput): ContextPreview {
    const { documentNodeId } = input;
    const editor = this.getEditor(documentNodeId);
    const currentPunctuation = editor.punctuation;
    if (
      editor.source.state !== "confirmed"
      || !currentPunctuation
      || currentPunctuation.state !== "confirmed"
      || !currentPunctuation.anchorSetId
      || editor.anchors.length === 0
    ) {
      throw new MunhaeError("not_ready", "표점 원문을 확정하고 생성된 분절을 검토한 뒤 AI 번역을 실행할 수 있습니다");
    }
    const policy = getRow<{
      id: string;
      version_no: number;
      content_hash: string;
      target_locale: string;
      audience: string | null;
      style_guide_md: string | null;
      hanja_policy: string | null;
      supplement_policy: string | null;
      uncertainty_policy: string | null;
      rules_json: string | null;
    }>(
      this.db,
      `SELECT v.id, v.version_no, v.content_hash, v.target_locale, v.audience,
              v.style_guide_md, v.hanja_policy,
              v.supplement_policy, v.uncertainty_policy, v.rules_json
       FROM core_translation_policy_versions v WHERE v.id = ?`,
      this.policyVersionId,
    );
    if (!policy) throw new MunhaeError("not_ready", "현재 번역 원칙을 찾을 수 없습니다");
    const punctuated = currentPunctuation.punctuatedText;
    const anchorSet = getRow<{ id: string; anchor_set_hash: string; source_text_version_id: string }>(
      this.db,
      `SELECT id, anchor_set_hash, source_text_version_id FROM translation_anchor_sets
       WHERE document_node_id = ? AND punctuation_version_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      documentNodeId,
      currentPunctuation.versionId,
    );
    if (!anchorSet) throw new MunhaeError("not_ready", "이 표점안에는 번역 앵커가 없습니다");
    if (anchorSet.source_text_version_id !== editor.source.versionId) {
      throw new MunhaeError("stale_punctuation", "현재 원문안에서 새 표점안을 저장한 뒤 AI 실행을 준비해야 합니다");
    }
    this.validateStoredAnchorSet(documentNodeId, currentPunctuation.versionId);
    const requestAnchors = allRows<{
      anchor_key: string;
      ordinal: number;
      boundary_kind: string;
      punctuation_codepoint_from: number;
      punctuation_codepoint_to: number;
      punctuated_quote_hash: string;
      required: number;
    }>(
      this.db,
      `SELECT anchor_key, ordinal, boundary_kind, punctuation_codepoint_from,
              punctuation_codepoint_to, punctuated_quote_hash, required
       FROM translation_anchors WHERE anchor_set_id = ? ORDER BY ordinal`,
      anchorSet.id,
    ).map((anchor) => ({
      anchorKey: anchor.anchor_key,
      ordinal: anchor.ordinal,
      boundaryKind: anchor.boundary_kind,
      punctuationFrom: anchor.punctuation_codepoint_from,
      punctuationTo: anchor.punctuation_codepoint_to,
      required: anchor.required === 1,
      quoteHash: anchor.punctuated_quote_hash,
    }));
    if (requestAnchors.length === 0) throw new MunhaeError("not_ready", "이 표점안에는 번역 앵커가 없습니다");
    const anchorManifest = canonicalJson({
      anchorSetId: anchorSet.id,
      anchors: requestAnchors.map((anchor) => ({
        anchorKey: anchor.anchorKey,
        ordinal: anchor.ordinal,
        boundaryKind: anchor.boundaryKind,
        required: anchor.required,
        punctuationFrom: anchor.punctuationFrom,
        punctuationTo: anchor.punctuationTo,
        quoteHash: anchor.quoteHash,
      })),
    });
    const policyText = canonicalJson({
      targetLocale: policy.target_locale,
      audience: policy.audience,
      hanjaPolicy: policy.hanja_policy,
      supplementPolicy: policy.supplement_policy,
      uncertaintyPolicy: policy.uncertainty_policy,
      styleGuide: policy.style_guide_md,
      rules: translationPolicyRulesForPrompt(policy.rules_json),
    });
    const required: ContextPreview["required"] = [
      {
        kind: "punctuated_source",
        label: "전체 표점 원문",
        version: currentPunctuation.versionId,
        hash: sha256Hex(punctuated),
        chars: codepointCount(punctuated),
        content: punctuated,
      },
      {
        kind: "anchor_manifest",
        label: "번역 앵커 명세",
        hash: sha256Hex(anchorManifest),
        chars: codepointCount(anchorManifest),
        content: anchorManifest,
      },
      {
        kind: "translation_policy",
        label: "번역 원칙",
        version: policy.id,
        hash: sha256Hex(policyText),
        chars: codepointCount(policyText),
        content: policyText,
      },
    ];

    const knowledge = this.getKnowledge();
    const source = editor.source.contentText;
    type AuxCandidate = ContextPreview["auxiliary"][number];
    const auxiliary: AuxCandidate[] = [];
    const selectionById = new Map(input.selections?.map((selection) => [selection.id, selection.mode]));
    const addAuxiliary = (item: Omit<AuxCandidate, "included" | "selection" | "hash">): void => {
      const mode = selectionById.get(item.id) ?? "auto";
      const included = mode === "pin" || (mode === "auto" && item.defaultIncluded);
      auxiliary.push({ ...item, selection: mode, included, hash: sha256Hex(item.content) });
    };

    const metadataContent = canonicalJson({
      title: editor.document.title,
      originalTitle: editor.document.originalTitle,
      authorName: editor.document.authorName,
      periodText: editor.document.periodText,
      dateText: editor.document.dateText,
      language: editor.document.language,
      sourceReference: editor.document.sourceReference,
      sourceVersionId: editor.source.versionId,
      sourceHash: sha256Hex(source),
    });
    addAuxiliary({
      id: `document:${documentNodeId}:metadata`,
      kind: "document_metadata",
      label: "문서 정보",
      reason: "current_document",
      defaultIncluded: true,
      chars: codepointCount(metadataContent),
      content: metadataContent,
    });
    const lineage = this.documentLineage(documentNodeId);
    const distanceByNodeId = new Map(lineage.map((node) => [node.id, node.distance]));
    for (const node of lineage) {
      if (!node.descriptionMd?.trim()) continue;
      addAuxiliary({
        id: `document:${node.id}:description`,
        kind: "document_context",
        label: `문서 설명 · ${node.originalTitle || node.title}`,
        reason: node.distance === 0 ? "current_document_context" : `ancestor_document_context:${node.distance}`,
        defaultIncluded: true,
        chars: codepointCount(node.descriptionMd),
        content: node.descriptionMd,
      });
    }
    for (const g of knowledge.glossary) {
      const hit = source.includes(g.sourceTerm);
      const content = glossaryContentJson(g);
      addAuxiliary({
        id: g.id,
        kind: "glossary",
        label: `${g.sourceTerm} → ${g.targetTerm}`,
        reason: hit ? "exact_match" : "project_glossary",
        defaultIncluded: hit,
        chars: codepointCount(content),
        content,
      });
    }
    for (const p of knowledge.persons) {
      const names = [p.preferredName, p.hanjaName, ...p.aliases].filter(Boolean) as string[];
      const hit = names.some((n) => source.includes(n) || (editor.document.authorName ?? "").includes(n));
      const content = personContentJson(p);
      addAuxiliary({
        id: p.id,
        kind: "person",
        label: p.preferredName,
        reason: hit ? "exact_match" : "project_person",
        defaultIncluded: hit,
        chars: codepointCount(content),
        content,
      });
    }
    for (const p of knowledge.places) {
      const names = [p.preferredName, p.hanjaName, ...p.aliases].filter(Boolean) as string[];
      const hit = names.some((n) => source.includes(n) || punctuated.includes(n));
      const content = placeContentJson(p);
      addAuxiliary({
        id: p.id,
        kind: "place",
        label: p.preferredName,
        reason: hit ? "exact_match" : "project_place",
        defaultIncluded: hit,
        chars: codepointCount(content),
        content,
      });
    }
    const relatedUncertaintyIds = new Set(
      loadOpenUncertaintyIdsForDocument(this.db, this.projectId, documentNodeId),
    );
    for (const u of knowledge.uncertainties.filter((x) => x.state === "open")) {
      const content = canonicalJson(u);
      const related = relatedUncertaintyIds.has(u.id);
      addAuxiliary({
        id: u.id,
        kind: "uncertainty",
        label: u.statementMd,
        reason: related ? "related_uncertainty" : "project_uncertainty",
        defaultIncluded: related,
        chars: codepointCount(content),
        content,
      });
    }
    const items = allRows<{
      id: string;
      title: string;
      content_md: string;
      enabled: number;
      priority: number;
      scope_kind: string | null;
      scope_id: string | null;
      updated_at: string;
    }>(
      this.db,
      `SELECT id, title, content_md, enabled, priority, scope_kind, scope_id, updated_at
       FROM context_items WHERE project_id = ? AND archived_at IS NULL`,
      this.projectId,
    )
      .map((item) => {
        const nodeDistance = item.scope_kind === "document_node" && item.scope_id
          ? distanceByNodeId.get(item.scope_id)
          : undefined;
        if (nodeDistance === undefined) return null;
        return {
          ...item,
          scopeDistance: nodeDistance,
          reason:
            nodeDistance === 0
              ? "current_document_context"
              : `ancestor_document_context:${nodeDistance}`,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort(
        (a, b) =>
          a.scopeDistance - b.scopeDistance ||
          b.priority - a.priority ||
          a.updated_at.localeCompare(b.updated_at) ||
          a.title.localeCompare(b.title, "ko"),
      );
    for (const it of items) {
      addAuxiliary({
        id: it.id,
        kind: "context_item",
        label: it.title,
        reason: it.reason,
        defaultIncluded: it.enabled === 1,
        chars: codepointCount(it.content_md),
        content: it.content_md,
      });
    }

    // Translation memory is derived directly from immutable confirmed heads;
    // drafts/rejected versions are never eligible and no duplicate context row
    // is materialized.  The current document's confirmed head is included by
    // default as an exact revision baseline.  Other project examples remain
    // visible in the preview and require an explicit pin, avoiding an
    // unbounded implicit prompt as the project grows.
    const confirmedTranslations = allRows<{
      document_node_id: string;
      document_title: string;
      original_title: string | null;
      stage: string;
      version_id: string;
      version_hash: string;
      text_content: string;
      punctuation_version_id: string;
      punctuation_hash: string;
      punctuated_text: string;
    }>(
      this.db,
      `SELECT translation.document_node_id,
              node.title AS document_title,
              node.original_title,
              'translation' AS stage,
              version.id AS version_id,
              version.content_hash AS version_hash,
              version.text_content,
              punctuation.id AS punctuation_version_id,
              punctuation.content_hash AS punctuation_hash,
              punctuation.punctuated_text
       FROM document_translation_heads head
       JOIN document_translation_versions version
         ON version.id = head.confirmed_version_id
        AND version.state = 'confirmed'
       JOIN document_translations translation
         ON translation.id = head.document_translation_id
        AND translation.project_id = version.project_id
        AND translation.tombstoned_at IS NULL
       JOIN document_nodes node
         ON node.id = translation.document_node_id
        AND node.project_id = translation.project_id
        AND node.archived_at IS NULL
       JOIN punctuation_versions punctuation
         ON punctuation.id = version.punctuation_version_id
        AND punctuation.project_id = version.project_id
       WHERE version.project_id = ?
       ORDER BY CASE WHEN translation.document_node_id = ? THEN 0 ELSE 1 END,
                node.title, version.version_no`,
      this.projectId,
      documentNodeId,
    );
    for (const confirmed of confirmedTranslations) {
      const samePunctuation =
        confirmed.document_node_id === documentNodeId
        && confirmed.punctuation_version_id === currentPunctuation.versionId;
      const blocks = loadBlocks(this.db, confirmed.version_id).map((block) => ({
        blockKey: block.blockKey,
        blockKind: block.blockKind,
        translation: block.translation,
        sourceAnchorIds: block.sourceAnchorIds,
      }));
      const content = canonicalJson({
        document: {
          id: confirmed.document_node_id,
          title: confirmed.original_title || confirmed.document_title,
        },
        source: {
          punctuationVersionId: confirmed.punctuation_version_id,
          contentHash: confirmed.punctuation_hash,
          // The target's complete punctuation text is already a required
          // section and must not be repeated in the same request.
          ...(samePunctuation ? {} : { text: confirmed.punctuated_text }),
        },
        translation: {
          versionId: confirmed.version_id,
          contentHash: confirmed.version_hash,
          text: confirmed.text_content,
          blocks,
        },
      });
      const currentDocument = confirmed.document_node_id === documentNodeId;
      addAuxiliary({
        id: `confirmed-translation:${confirmed.version_id}`,
        kind: "confirmed_translation",
        label: `확정 번역 · ${confirmed.original_title || confirmed.document_title}`,
        reason: currentDocument
          ? "current_document_confirmed_translation"
          : "project_confirmed_translation",
        defaultIncluded: currentDocument,
        chars: codepointCount(content),
        content,
      });
    }

    const selectedAuxiliary = auxiliary.filter((item) => item.included);
    const rendered = renderTranslationRequest({
      documentTitle: editor.document.originalTitle || editor.document.title,
      anchorSetId: anchorSet.id,
      punctuatedText: punctuated,
      anchors: requestAnchors,
      policyText,
      metadataText: "",
      auxiliary: selectedAuxiliary.map((item) => ({
        id: item.id,
        kind: item.kind,
        label: item.label,
        content: item.content,
        hash: item.hash,
        reason: item.reason,
        selection: item.selection,
      })),
    });
    required.push({
      kind: "output_contract",
      label: "응답 형식 · 완성 번역 1개",
      version: "translation-envelope.v2",
      hash: sha256Hex(rendered.outputSchemaJson),
      chars: codepointCount(rendered.outputSchemaJson),
      content: rendered.outputSchemaJson,
    });
    const sourceSnapshot = getRow<{ source_text_id: string }>(
      this.db,
      `SELECT sv.source_text_id
       FROM src_text_versions sv
       WHERE sv.id = ? AND sv.project_id = ?`,
      editor.source.versionId,
      this.projectId,
    );
    if (!sourceSnapshot) throw new MunhaeError("not_ready", "현재 원문 snapshot을 찾을 수 없습니다");
    const expectedHead = captureTranslationHead(
      this.db,
      this.projectId,
      sourceSnapshot.source_text_id,
      policy.target_locale,
    );
    const snapshot = {
      documentNodeId,
      sourceTextId: sourceSnapshot.source_text_id,
      sourceTextVersionId: editor.source.versionId,
      punctuationVersionId: currentPunctuation.versionId,
      policyVersionId: policy.id,
      anchorSetId: anchorSet.id,
      targetLocale: policy.target_locale,
      expectedHead,
    };
    const manifest = {
      schemaVersion: 2,
      taskKind: "translation",
      promptContractVersion: rendered.promptContractVersion,
      requestHash: rendered.requestHash,
      snapshot,
      anchorSetId: anchorSet.id,
      sources: [
        ...required.map((r, i) => ({
          ordinal: i + 1,
          kind: r.kind,
          hash: r.hash,
          versionId: r.version,
          reason: "required",
        })),
        ...selectedAuxiliary.map((a, i) => ({
          ordinal: required.length + i + 1,
          kind: a.kind,
          id: a.id,
          hash: a.hash,
          reason: a.reason,
          selection: a.selection,
        })),
      ],
      selectionOverrides: auxiliary
        .filter((a) => a.selection !== "auto")
        .map((a) => ({ id: a.id, mode: a.selection })),
    };
    const manifestJson = canonicalJson(manifest);
    return {
      characterCount: rendered.characterCount,
      utf8ByteCount: rendered.utf8ByteCount,
      manifestHash: sha256Hex(manifestJson),
      requestHash: rendered.requestHash,
      requestText: rendered.requestText,
      promptContractVersion: rendered.promptContractVersion,
      required,
      auxiliary,
      status: "ready",
      manifestJson,
      snapshot,
    };
  }

  beginProjectChatRun(input: BeginProjectChatRunInput): PreparedProjectTaskRun {
    const question = input.question.trim();
    if (!question) throw new MunhaeError("invalid_input", "채팅 질문을 입력하세요");
    const editor = this.getEditor(input.documentNodeId);
    const scopeId = input.scopeKind === "project" ? this.projectId : editor.document.id;
    let snapshot: ProjectChatSnapshot;
    let rendered: ReturnType<typeof renderProjectChatRequest>;
    if (input.scopeKind === "project") {
      const master = getRow<{ id: string }>(
        this.db,
        `SELECT id FROM document_nodes
         WHERE project_id = ? AND is_master = 1 AND archived_at IS NULL`,
        this.projectId,
      );
      if (!master) throw new MunhaeError("invalid_project", "프로젝트 마스터 폴더가 없습니다");
      const enabledProjectContext = allRows<{
        id: string;
        title: string;
        content_md: string;
        content_hash: string;
        priority: number;
      }>(
        this.db,
        `SELECT id, title, content_md, content_hash, priority
         FROM context_items
         WHERE project_id = ? AND scope_kind = 'document_node' AND scope_id = ?
           AND enabled = 1 AND archived_at IS NULL
         ORDER BY priority DESC, updated_at, title`,
        this.projectId,
        master.id,
      ).map((item) => ({
        contextItemId: item.id,
        title: item.title,
        content: item.content_md,
        contentHash: item.content_hash,
        priority: item.priority,
      }));
      snapshot = {
        scopeKind: "project",
        projectTitle: editor.project.title,
        documents: this.listDocuments().map((document) => ({
          documentNodeId: document.id,
          parentDocumentNodeId: document.parentId,
          nodeRole: document.nodeRole,
          title: document.originalTitle || document.title,
          sourceState: document.sourceState,
          punctuationState: document.punctuationState,
          translationState: document.translationState,
        })),
        enabledProjectContext,
      };
      rendered = renderProjectChatRequest({ snapshot, question });
    } else {
      const source = getRow<{ content_hash: string }>(
        this.db,
        `SELECT content_hash FROM src_text_versions WHERE id = ? AND project_id = ?`,
        editor.source.versionId,
        this.projectId,
      );
      const punctuation = editor.punctuation ? getRow<{ content_hash: string }>(
        this.db,
        `SELECT content_hash FROM punctuation_versions WHERE id = ? AND project_id = ?`,
        editor.punctuation.versionId,
        this.projectId,
      ) : null;
      if (!source || (editor.punctuation && !punctuation)) {
        throw new MunhaeError("not_ready", "현재 문서 snapshot을 찾을 수 없습니다");
      }
      const currentTranslation = editor.translation?.isCurrentDependencies ? editor.translation : null;
      snapshot = {
        scopeKind: "document_node",
        documentNodeId: editor.document.id,
        documentTitle: editor.document.originalTitle || editor.document.title,
        sourceTextVersionId: editor.source.versionId,
        sourceTextHash: source.content_hash,
        punctuationVersionId: editor.punctuation?.versionId ?? null,
        punctuationHash: punctuation?.content_hash ?? null,
        translations: currentTranslation ? [{
          stage: TRANSLATION_STAGE,
          versionId: currentTranslation.versionId,
          contentHash: sha256Hex(currentTranslation.textContent),
        }] : [],
      };
      rendered = renderProjectChatRequest({
        snapshot,
        sourceText: editor.source.contentText,
        punctuatedText: editor.punctuation?.punctuatedText ?? "",
        currentTranslations: currentTranslation ? [{
          stage: TRANSLATION_STAGE,
          text: currentTranslation.textContent,
        }] : [],
        question,
      });
    }
    const requestHash = sha256Hex(rendered.requestText);
    const manifestJson = canonicalJson({
      schemaVersion: 1,
      taskKind: "chat",
      documentNodeId: editor.document.id,
      scopeKind: input.scopeKind,
      scopeId,
      promptContractVersion: PROJECT_CHAT_PROMPT_CONTRACT_VERSION,
      requestHash,
      snapshot,
      questionHash: sha256Hex(question),
    });
    const reserved = reserveProjectTaskRun(this.db, this.projectId, this.actors, {
      documentNodeId: editor.document.id,
      scopeKind: input.scopeKind,
      scopeId,
      taskKind: "chat",
      userText: question,
      agentId: input.agentId,
      requestedModel: input.requestedModel,
      reasoningLevel: input.reasoningLevel,
      serviceTier: input.serviceTier,
      runtimeVersion: input.runtimeVersion,
      requestManifestJson: manifestJson,
      requestText: rendered.requestText,
      promptContractVersion: PROJECT_CHAT_PROMPT_CONTRACT_VERSION,
      stablePromptHash: rendered.stablePromptHash,
    });
    return {
      ...reserved,
      requestText: rendered.requestText,
      promptContractVersion: PROJECT_CHAT_PROMPT_CONTRACT_VERSION,
      stablePromptHash: rendered.stablePromptHash,
      requestedModel: input.requestedModel,
    };
  }

  beginPunctuationSuggestionRun(input: BeginPunctuationSuggestionRunInput): PreparedProjectTaskRun {
    const editor = this.getEditor(input.documentNodeId);
    if (editor.source.state !== "confirmed") {
      throw new MunhaeError("source_not_confirmed", "원문안을 먼저 확정해야 AI 표점을 제안할 수 있습니다");
    }
    const source = this.requireSource(input.documentNodeId);
    if (source.currentVersionId !== editor.source.versionId) {
      throw new MunhaeError("stale_request", "현재 원문 snapshot이 바뀌었습니다");
    }
    const snapshot: PunctuationSuggestionSnapshot = {
      documentNodeId: editor.document.id,
      documentTitle: editor.document.originalTitle || editor.document.title,
      sourceTextId: source.sourceTextId,
      sourceTextVersionId: source.currentVersionId,
      sourceTextHash: source.currentContentHash,
      punctuationSetId: editor.punctuation ? this.requirePunctuation(input.documentNodeId).punctuationSetId : null,
      currentPunctuationVersionId: editor.punctuation?.versionId ?? null,
      currentPunctuationLockVersion: editor.punctuation?.lockVersion ?? null,
      structureMode: input.structureMode,
    };
    const rendered = renderPunctuationSuggestionRequest({
      snapshot,
      sourceText: source.currentContentText,
    });
    const requestHash = sha256Hex(rendered.requestText);
    const manifestJson = canonicalJson({
      schemaVersion: 1,
      taskKind: "punctuation_suggest",
      documentNodeId: editor.document.id,
      scopeKind: "document_node",
      scopeId: editor.document.id,
      promptContractVersion: PUNCTUATION_SUGGEST_PROMPT_CONTRACT_VERSION,
      requestHash,
      snapshot,
    });
    const reserved = reserveProjectTaskRun(this.db, this.projectId, this.actors, {
      documentNodeId: editor.document.id,
      scopeKind: "document_node",
      scopeId: editor.document.id,
      taskKind: "punctuation_suggest",
      userText: `${input.structureMode === "poetry" ? "운문" : "산문"} 표점·구조안 제안`,
      agentId: input.agentId,
      requestedModel: input.requestedModel,
      reasoningLevel: input.reasoningLevel,
      serviceTier: input.serviceTier,
      runtimeVersion: input.runtimeVersion,
      requestManifestJson: manifestJson,
      requestText: rendered.requestText,
      promptContractVersion: PUNCTUATION_SUGGEST_PROMPT_CONTRACT_VERSION,
      stablePromptHash: rendered.stablePromptHash,
    });
    return {
      ...reserved,
      requestText: rendered.requestText,
      promptContractVersion: PUNCTUATION_SUGGEST_PROMPT_CONTRACT_VERSION,
      stablePromptHash: rendered.stablePromptHash,
      requestedModel: input.requestedModel,
    };
  }

  completeProjectChatRun(input: CompleteProjectTaskRunInput): void {
    storeProjectTaskResponse(this.db, this.projectId, input);
    completeProjectChat(this.db, this.projectId, input.messageId, input.rawResponse);
  }

  completePunctuationSuggestionRun(input: CompleteProjectTaskRunInput): CompletedPunctuationSuggestionRun {
    storeProjectTaskResponse(this.db, this.projectId, input);
    return completePunctuationSuggestion(this.db, this.projectId, input.messageId, input.rawResponse);
  }

  applyPunctuationSuggestionRun(messageId: string): CompletedPunctuationSuggestionRun {
    return applyPunctuationSuggestion(this.db, this.projectId, this.actors, messageId);
  }

  failProjectTaskRun(
    messageId: string,
    error: { code: string; message: string },
    metadata: ProjectTaskFailureMetadata = {},
  ): void {
    markProjectTaskRunFailed(this.db, this.projectId, messageId, error, metadata);
  }

  recordProjectAgentSession(input: {
    messageId: string;
    threadId: string;
    agentId: "codex" | "claude" | "antigravity";
    requestedModel: string;
    stablePromptHash: string;
  }): void {
    upsertAgentSession(this.db, {
      projectId: this.projectId,
      threadId: input.threadId,
      agentId: input.agentId,
      model: input.requestedModel,
      cwdHash: AGENT_EMPTY_CWD_HASH,
      messageId: input.messageId,
      stablePromptHash: input.stablePromptHash,
    });
  }

  invalidateProjectAgentSession(input: {
    threadId: string;
    agentId: "codex" | "claude" | "antigravity";
  }): void {
    markAgentSessionInvalid(this.db, this.projectId, input.threadId, input.agentId);
  }

  beginTranslationRun(input: BeginTranslationRunInput): PreparedTranslationRun {
    const preview = this.previewLegacyContext(input);
    const reserved = reserveStoredTranslationRun(this.db, this.projectId, this.actors, {
      documentNodeId: input.documentNodeId,
      documentTitle: this.getEditor(input.documentNodeId).document.title,
      agentId: input.agentId,
      requestedModel: input.requestedModel,
      reasoningLevel: input.reasoningLevel,
      serviceTier: input.serviceTier,
      runtimeVersion: input.runtimeVersion,
      requestManifestJson: preview.manifestJson,
      requestText: preview.requestText,
      promptContractVersion: preview.promptContractVersion,
    });
    if (reserved.requestHash !== preview.requestHash) {
      markTranslationRunFailed(this.db, this.projectId, reserved.messageId, {
        code: "request_hash_mismatch",
        message: "저장된 AI 요청과 실행 요청의 hash가 일치하지 않습니다",
      });
      throw new MunhaeError("request_hash_mismatch", "저장된 AI 요청과 실행 요청의 hash가 일치하지 않습니다");
    }
    return {
      ...reserved,
      requestText: preview.requestText,
      requestHash: preview.requestHash,
      promptContractVersion: TRANSLATION_PROMPT_CONTRACT_VERSION,
      snapshot: preview.snapshot,
    };
  }

  completeTranslationRun(input: CompleteTranslationRunInput): CompletedTranslationRun {
    storeTranslationResponse(this.db, this.projectId, input);
    try {
      const message = getRow<{ request_manifest_json: string | null }>(
        this.db,
        `SELECT request_manifest_json FROM chat_messages
         WHERE id = ? AND project_id = ? AND role = 'assistant' AND task_kind = 'translation'`,
        input.messageId,
        this.projectId,
      );
      if (!message?.request_manifest_json) {
        throw new MunhaeError("invalid_request_manifest", "AI 실행 snapshot을 찾을 수 없습니다");
      }
      const parsed = JSON.parse(message.request_manifest_json) as { snapshot?: PreparedTranslationRun["snapshot"] };
      const snapshot = parsed.snapshot;
      if (!snapshot || snapshot.documentNodeId.length === 0 || snapshot.anchorSetId.length === 0) {
        throw new MunhaeError("invalid_request_manifest", "AI 실행 snapshot이 올바르지 않습니다");
      }
      const applied = applyStoredTranslationEnvelope(this.db, this.projectId, this.actors, {
        messageId: input.messageId,
        documentNodeId: snapshot.documentNodeId,
        anchorSetId: snapshot.anchorSetId,
        sourceTextVersionId: snapshot.sourceTextVersionId,
        punctuationVersionId: snapshot.punctuationVersionId,
        policyVersionId: snapshot.policyVersionId,
        expectedHead: snapshot.expectedHead,
        rawResponse: input.rawResponse,
      });
      return {
        messageId: applied.messageId,
        validationState: applied.validation.state,
        fatalFindings: applied.validation.fatalFindings.length,
        recoverableFindings: applied.validation.recoverableFindings.length,
        version: applied.version,
        idempotent: applied.idempotent,
      };
    } catch (error) {
      markTranslationRunFailed(this.db, this.projectId, input.messageId, {
        code:
          typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
            ? error.code
            : "apply_failed",
        message: error instanceof Error ? error.message : "AI 번역 결과를 적용하지 못했습니다",
      });
      throw error;
    }
  }

  recordInvalidTranslationResponse(input: RecordInvalidTranslationResponseInput): void {
    storeInvalidTranslationResponse(this.db, this.projectId, input);
  }

  failTranslationRun(
    messageId: string,
    error: { code: string; message: string },
    metadata: TranslationRunFailureMetadata = {},
  ): void {
    markTranslationRunFailed(this.db, this.projectId, messageId, error, metadata);
  }

  recordTranslationAgentSession(input: {
    messageId: string;
    threadId: string;
    agentId: "codex" | "claude" | "antigravity";
    model: string | null;
    stablePromptHash: string;
  }): void {
    upsertAgentSession(this.db, {
      projectId: this.projectId,
      threadId: input.threadId,
      agentId: input.agentId,
      model: input.model,
      cwdHash: sha256Hex("munhae-agent-empty-cwd.v1"),
      messageId: input.messageId,
      stablePromptHash: input.stablePromptHash,
    });
  }

  private recoverInterruptedTranslationRuns(): void {
    const rows = allRows<{ id: string }>(
      this.db,
      `SELECT id FROM chat_messages
       WHERE project_id = ? AND role = 'assistant' AND task_kind = 'translation'
         AND state IN ('queued', 'running', 'validating')`,
      this.projectId,
    );
    for (const row of rows) {
      markTranslationRunFailed(
        this.db,
        this.projectId,
        row.id,
        { code: "interrupted", message: "앱이 종료되어 AI 실행이 중단되었습니다" },
        { eventsJsonl: this.readInterruptedRunEvents(row.id) },
      );
    }
  }

  private readInterruptedRunEvents(messageId: string): string | undefined {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) {
      return undefined;
    }
    try {
      const eventFile = resolvePackagePath(this.packagePath, `runs/${messageId}/events.jsonl`);
      if (existsSync(eventFile)) return readFileSync(eventFile, "utf8");
    } catch {
      // Recovery must still release the serialized thread if evidence is unreadable.
    }
    return undefined;
  }

  private requireSource(documentNodeId: string): SourceCtx {
    const row = getRow<{
      source_text_id: string;
      current_version_id: string;
      confirmed_version_id: string | null;
      lock_version: number;
      version_no: number;
      state: SourceCtx["currentState"];
      content_text: string;
      content_hash: string;
    }>(
      this.db,
      `SELECT t.id AS source_text_id, h.current_version_id, h.confirmed_version_id, h.lock_version,
              v.version_no, v.state, v.content_text, v.content_hash
       FROM src_texts t
       JOIN document_nodes n ON n.id = t.document_node_id
       JOIN src_text_heads h ON h.source_text_id = t.id
       JOIN src_text_versions v ON v.id = h.current_version_id
       WHERE t.document_node_id = ? AND t.project_id = ? AND t.tombstoned_at IS NULL
         AND n.node_role = 'source_unit'
       LIMIT 1`,
      documentNodeId,
      this.projectId,
    );
    if (!row) throw new MunhaeError("not_ready", "이 문서에는 원문이 없습니다");
    return {
      sourceTextId: row.source_text_id,
      currentVersionId: row.current_version_id,
      confirmedVersionId: row.confirmed_version_id,
      lockVersion: row.lock_version,
      currentVersionNo: row.version_no,
      currentState: row.state,
      currentContentText: row.content_text,
      currentContentHash: row.content_hash,
    };
  }

  private requirePunctuation(documentNodeId: string): PunctuationCtx {
    const row = getRow<{
      punctuation_set_id: string;
      current_version_id: string;
      confirmed_version_id: string | null;
      lock_version: number;
      version_no: number;
      state: PunctuationCtx["currentState"];
      punctuated_text: string;
      structure_json: string | null;
      source_text_version_id: string;
    }>(
      this.db,
      `SELECT s.id AS punctuation_set_id, h.current_version_id, h.confirmed_version_id, h.lock_version,
              v.version_no, v.state, v.punctuated_text, v.structure_json, v.source_text_version_id
       FROM src_texts t
       JOIN punctuation_sets s ON s.source_text_id = t.id
       JOIN punctuation_heads h ON h.punctuation_set_id = s.id
       JOIN punctuation_versions v ON v.id = h.current_version_id
       WHERE t.document_node_id = ? AND t.project_id = ? AND t.tombstoned_at IS NULL
         AND s.status = 'active'
       ORDER BY s.created_at
       LIMIT 1`,
      documentNodeId,
      this.projectId,
    );
    if (!row) throw new MunhaeError("not_ready", "이 문서에는 표점안이 없습니다");
    return {
      punctuationSetId: row.punctuation_set_id,
      currentVersionId: row.current_version_id,
      confirmedVersionId: row.confirmed_version_id,
      lockVersion: row.lock_version,
      currentVersionNo: row.version_no,
      currentState: row.state,
      currentPunctuatedText: row.punctuated_text,
      sourceVersionId: row.source_text_version_id,
      structureMode: structureModeFromJson(row.structure_json),
    };
  }

  private casSourceHead(
    sourceTextId: string,
    expectedLockVersion: number,
    currentVersionId: string,
    confirmedVersionId?: string | null,
  ): void {
    const info = this.db
      .prepare(
        `UPDATE src_text_heads
         SET current_version_id = @current,
             confirmed_version_id = CASE WHEN @setConfirmed = 1 THEN @confirmed ELSE confirmed_version_id END,
             lock_version = lock_version + 1,
             updated_at = @now
         WHERE source_text_id = @id AND project_id = @projectId AND lock_version = @lock`,
      )
      .run({
        current: currentVersionId,
        confirmed: confirmedVersionId ?? null,
        setConfirmed: confirmedVersionId !== undefined ? 1 : 0,
        now: nowIso(),
        id: sourceTextId,
        projectId: this.projectId,
        lock: expectedLockVersion,
      });
    if (info.changes !== 1) throw new MunhaeError("cas_conflict", "stale source lock_version");
  }

  private casPunctuationHead(
    punctuationSetId: string,
    expectedLockVersion: number,
    currentVersionId: string,
    confirmedVersionId?: string | null,
  ): void {
    const info = this.db
      .prepare(
        `UPDATE punctuation_heads
         SET current_version_id = @current,
             confirmed_version_id = CASE WHEN @setConfirmed = 1 THEN @confirmed ELSE confirmed_version_id END,
             lock_version = lock_version + 1,
             updated_at = @now
         WHERE punctuation_set_id = @id AND project_id = @projectId AND lock_version = @lock`,
      )
      .run({
        current: currentVersionId,
        confirmed: confirmedVersionId ?? null,
        setConfirmed: confirmedVersionId !== undefined ? 1 : 0,
        now: nowIso(),
        id: punctuationSetId,
        projectId: this.projectId,
        lock: expectedLockVersion,
      });
    if (info.changes !== 1) throw new MunhaeError("cas_conflict", "stale punctuation lock_version");
  }

  private loadStructureSpanInputs(punctuationVersionId: string): PunctuationStructureSpanInput[] {
    return allRows<{
      id: string;
      span_kind: PunctuationStructureSpanInput["spanKind"];
      parent_span_id: string | null;
      ordinal: number;
      codepoint_from: number;
      codepoint_to: number;
      label: string | null;
    }>(
      this.db,
      `SELECT id, span_kind, parent_span_id, ordinal, codepoint_from, codepoint_to, label
       FROM punctuation_structure_spans
       WHERE punctuation_version_id = ?`,
      punctuationVersionId,
    ).map((span) => ({
      spanKey: span.id,
      spanKind: span.span_kind,
      parentSpanKey: span.parent_span_id,
      ordinal: span.ordinal,
      codepointFrom: span.codepoint_from,
      codepointTo: span.codepoint_to,
      label: span.label,
    }));
  }

  private validateStoredAnchorSet(documentNodeId: string, punctuationVersionId: string): void {
    const dependency = getRow<{
      anchor_set_id: string;
      source_text_version_id: string;
      source_text: string;
      punctuated_text: string;
      set_source_version_id: string;
    }>(
      this.db,
      `SELECT s.id AS anchor_set_id, p.source_text_version_id, src.content_text AS source_text,
              p.punctuated_text, s.source_text_version_id AS set_source_version_id
       FROM translation_anchor_sets s
       JOIN punctuation_versions p ON p.id = s.punctuation_version_id
       JOIN src_text_versions src ON src.id = p.source_text_version_id
       WHERE s.document_node_id = ? AND s.punctuation_version_id = ?
       ORDER BY s.created_at DESC LIMIT 1`,
      documentNodeId,
      punctuationVersionId,
    );
    if (!dependency || dependency.source_text_version_id !== dependency.set_source_version_id) {
      throw new MunhaeError("invalid_anchor_set", "표점안과 일치하는 번역 앵커 집합이 없습니다");
    }
    const anchors = allRows<{
      id: string;
      anchor_key: string;
      ordinal: number;
      boundary_kind: string;
      punctuation_codepoint_from: number;
      punctuation_codepoint_to: number;
      punctuated_quote: string;
      punctuated_quote_hash: string;
      source_codepoint_from: number;
      source_codepoint_to: number;
      source_quote: string;
      source_quote_hash: string;
      required: number;
    }>(
      this.db,
      `SELECT * FROM translation_anchors WHERE anchor_set_id = ? ORDER BY ordinal`,
      dependency.anchor_set_id,
    );
    if (!anchors.length) throw new MunhaeError("invalid_anchor_set", "번역 앵커가 비어 있습니다");
    let punctuationCursor = 0;
    let sourceCursor = 0;
    anchors.forEach((anchor, index) => {
      if (anchor.anchor_key !== `A${String(index + 1).padStart(3, "0")}` || anchor.ordinal !== index + 1) {
        throw new MunhaeError("invalid_anchor_set", "번역 앵커 key 또는 ordinal이 결정론적 순서와 다릅니다");
      }
      const punctuatedQuote = sliceCodepoints(
        dependency.punctuated_text,
        anchor.punctuation_codepoint_from,
        anchor.punctuation_codepoint_to,
      );
      const sourceQuote = sliceCodepoints(
        dependency.source_text,
        anchor.source_codepoint_from,
        anchor.source_codepoint_to,
      );
      if (
        anchor.required !== 1 ||
        anchor.punctuation_codepoint_from !== punctuationCursor ||
        anchor.source_codepoint_from !== sourceCursor ||
        punctuatedQuote !== anchor.punctuated_quote ||
        sha256Hex(punctuatedQuote) !== anchor.punctuated_quote_hash ||
        sourceQuote !== anchor.source_quote ||
        sha256Hex(sourceQuote) !== anchor.source_quote_hash
      ) {
        throw new MunhaeError("invalid_anchor_set", `번역 앵커 ${anchor.anchor_key}의 범위 또는 hash가 잘못되었습니다`);
      }
      const exactSpan = getRow<{ n: number }>(
        this.db,
        `SELECT COUNT(*) AS n
         FROM translation_anchor_structure_spans bridge
         JOIN punctuation_structure_spans span ON span.id = bridge.punctuation_structure_span_id
         WHERE bridge.anchor_id = ? AND span.punctuation_version_id = ?
           AND span.span_kind = ? AND span.codepoint_from = ? AND span.codepoint_to = ?`,
        anchor.id,
        punctuationVersionId,
        anchor.boundary_kind,
        anchor.punctuation_codepoint_from,
        anchor.punctuation_codepoint_to,
      );
      if (exactSpan?.n !== 1) {
        throw new MunhaeError("invalid_anchor_set", `번역 앵커 ${anchor.anchor_key}의 논리 구조 연결이 잘못되었습니다`);
      }
      punctuationCursor = anchor.punctuation_codepoint_to;
      sourceCursor = anchor.source_codepoint_to;
    });
    if (
      punctuationCursor !== codepointCount(dependency.punctuated_text) ||
      sourceCursor !== codepointCount(dependency.source_text)
    ) {
      throw new MunhaeError("invalid_anchor_set", "required 번역 앵커가 원문 전체를 덮지 않습니다");
    }
  }

  private recordTranslationStaleness(
    documentNodeId: string,
    causeKind: "source_text_changed" | "punctuation_changed",
    newDependencyId: string,
    dependencyColumn: "source_text_version_id" | "punctuation_version_id",
  ): void {
    const versions = allRows<{ id: string; old_dependency_id: string }>(
      this.db,
      `SELECT v.id, v.${dependencyColumn} AS old_dependency_id
       FROM document_translation_versions v
       JOIN document_translations t ON t.id = v.document_translation_id
       WHERE t.document_node_id = ? AND t.project_id = ? AND v.${dependencyColumn} <> ?`,
      documentNodeId,
      this.projectId,
      newDependencyId,
    );
    const detectedAt = nowIso();
    for (const version of versions) {
      const existing = getRow<{ id: string }>(
        this.db,
        `SELECT id FROM translation_staleness
         WHERE document_translation_version_id = ? AND cause_kind = ?
           AND new_dependency_id = ? AND resolved_by_document_translation_version_id IS NULL`,
        version.id,
        causeKind,
        newDependencyId,
      );
      if (existing) continue;
      insertRow(this.db, "translation_staleness", {
        id: createId(),
        project_id: this.projectId,
        document_translation_version_id: version.id,
        cause_kind: causeKind,
        old_dependency_id: version.old_dependency_id,
        new_dependency_id: newDependencyId,
        detected_at: detectedAt,
        resolved_by_document_translation_version_id: null,
      });
    }
  }

  private writeTranslation(
    documentNodeId: string,
    blocks: BlockDraft[],
    opts: {
      expectedLockVersion: number;
      originKind: string;
      editKind: string;
      expectedTextContent?: string;
    },
  ): void {
    this.db.transaction(() => {
      const ctx = this.requireTranslation(documentNodeId);
      const current = this.requireCurrentVersion(ctx.translationId);
      this.assertCurrentTranslationDependencies(current, ctx);
      const assembled = joinBlockTranslations(blocks.map((block) => block.translation));
      if (opts.expectedTextContent !== undefined && opts.expectedTextContent !== assembled) {
        throw new MunhaeError("translation_text_mismatch", "전체 번역문과 번역 블록 내용이 일치하지 않습니다");
      }
      this.insertDraftFromBlocks(ctx, blocks, {
        expectedLock: opts.expectedLockVersion,
        originKind: opts.originKind,
        parentId: current.id,
        editKind: opts.editKind,
      });
    })();
  }

  private insertDraftFromBlocks(
    ctx: StageCtx,
    blocksIn: Array<{
      blockKey: string;
      blockKind: string;
      translation: string;
      sourceAnchorIds: string[];
      relationKinds?: string[];
    }>,
    opts: {
      expectedLock: number;
      originKind: string;
      parentId: string;
      editKind: string;
      allowStaleParent?: boolean;
    },
  ): void {
    const parent = this.requireCurrentVersion(ctx.translationId);
    if (parent.id !== opts.parentId) {
      throw new MunhaeError("cas_conflict", "번역안의 현재 버전이 바뀌었습니다");
    }
    if (!opts.allowStaleParent) this.assertCurrentTranslationDependencies(parent, ctx);
    if (parent.state === "draft") {
      this.db.prepare(`UPDATE document_translation_versions SET state = 'superseded' WHERE id = ?`).run(parent.id);
    }
    const anchors = loadAnchors(this.db, ctx.anchorSetId);
    const drafts: BlockDraft[] = blocksIn.map((b) => ({
      blockKey: b.blockKey,
      blockKind: b.blockKind,
      translation: b.translation,
      sourceAnchorIds: b.sourceAnchorIds,
      relationKinds: b.relationKinds,
    }));
    const { findings, validationState } = validateBlocks(drafts, anchors);
    const versionId = createId();
    const now = nowIso();
    const text = joinBlockTranslations(drafts.map((b) => b.translation));
    insertRow(this.db, "document_translation_versions", {
      id: versionId,
      project_id: this.projectId,
      document_translation_id: ctx.translationId,
      parent_version_id: opts.parentId,
      source_text_version_id: ctx.sourceVersionId,
      punctuation_version_id: ctx.puncVersionId,
      translation_anchor_set_id: ctx.anchorSetId,
      translation_policy_version_id: ctx.policyVersionId,
      text_content: text,
      origin_kind: opts.originKind,
      generated_by_message_id: null,
      validation_state: validationState,
      needs_review: validationState === "needs_review" ? 1 : 0,
      state: "draft",
      content_hash: sha256Hex(text),
      created_by_actor_id: this.actors.humanId,
      created_at: now,
      version_no: parent.version_no + 1,
    });
    insertVersionBlocks(this.db, this.projectId, versionId, drafts, anchors, validationState);
    recordValidation(this.db, this.projectId, versionId, findings, validationState);
    casUpdateHead(this.db, ctx.translationId, opts.expectedLock, { currentVersionId: versionId });
    this.db
      .prepare(
        `UPDATE translation_staleness
         SET resolved_by_document_translation_version_id = ?
         WHERE resolved_by_document_translation_version_id IS NULL
           AND document_translation_version_id IN (
             SELECT id FROM document_translation_versions WHERE document_translation_id = ?
           )`,
      )
      .run(versionId, ctx.translationId);
    insertRow(this.db, "user_edits", {
      id: createId(),
      project_id: this.projectId,
      document_translation_id: ctx.translationId,
      base_document_translation_version_id: opts.parentId,
      result_document_translation_version_id: versionId,
      edit_kind: opts.editKind,
      actor_id: this.actors.humanId,
      created_at: now,
    });
  }

  private requireTranslation(documentNodeId: string): StageCtx {
    const row = getRow<{
      translation_id: string;
      lock_version: number;
    }>(
      this.db,
      `SELECT t.id AS translation_id, h.lock_version
       FROM document_translations t
       JOIN document_translation_heads h ON h.document_translation_id = t.id
       WHERE t.document_node_id = ? AND t.project_id = ? AND t.tombstoned_at IS NULL`,
      documentNodeId,
      this.projectId,
    );
    if (!row) throw new MunhaeError("not_found", "translation not found");
    const source = this.requireSource(documentNodeId);
    const punctuation = this.requirePunctuation(documentNodeId);
    if (source.currentState !== "confirmed" || punctuation.currentState !== "confirmed") {
      throw new MunhaeError("not_confirmed", "원문안과 표점안을 확정해야 번역안을 편집할 수 있습니다");
    }
    if (punctuation.sourceVersionId !== source.currentVersionId) {
      throw new MunhaeError("stale_punctuation", "현재 원문안에서 새 표점안을 저장해야 번역안을 편집할 수 있습니다");
    }
    const anchorSet = getRow<{ id: string }>(
      this.db,
      `SELECT id FROM translation_anchor_sets
       WHERE document_node_id = ? AND source_text_version_id = ? AND punctuation_version_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      documentNodeId,
      source.currentVersionId,
      punctuation.currentVersionId,
    );
    if (!anchorSet) throw new MunhaeError("not_ready", "현재 표점안의 번역 앵커가 없습니다");
    this.validateStoredAnchorSet(documentNodeId, punctuation.currentVersionId);
    return {
      translationId: row.translation_id,
      lockVersion: row.lock_version,
      sourceVersionId: source.currentVersionId,
      puncVersionId: punctuation.currentVersionId,
      anchorSetId: anchorSet.id,
      policyVersionId: this.policyVersionId,
      sourceLockVersion: source.lockVersion,
      puncLockVersion: punctuation.lockVersion,
    };
  }

  private translationVersionMatchesCurrentDependencies(
    version: TranslationVersionRow & { id: string },
    ctx: StageCtx,
  ): boolean {
    if (
      version.source_text_version_id !== ctx.sourceVersionId ||
      version.punctuation_version_id !== ctx.puncVersionId ||
      version.translation_anchor_set_id !== ctx.anchorSetId
    ) {
      return false;
    }
    const stale = getRow<{ n: number }>(
      this.db,
      `SELECT COUNT(*) AS n FROM translation_staleness
       WHERE document_translation_version_id = ?
         AND resolved_by_document_translation_version_id IS NULL`,
      version.id,
    );
    return (stale?.n ?? 0) === 0;
  }

  private assertCurrentTranslationDependencies(
    version: TranslationVersionRow & { id: string },
    ctx: StageCtx,
  ): void {
    if (!this.translationVersionMatchesCurrentDependencies(version, ctx)) {
      throw new MunhaeError(
        "stale_translation",
        "현재 원문·표점·분절과 맞지 않는 번역안입니다. 현재 분절로 빈 번역안을 다시 만드세요",
      );
    }
  }

  private requireCurrentVersion(translationId: string): TranslationVersionRow & { id: string } {
    const row = getRow<TranslationVersionRow>(
      this.db,
      `SELECT v.id, v.version_no, v.state, v.validation_state, v.text_content, v.origin_kind, v.parent_version_id,
              v.source_text_version_id, v.punctuation_version_id, v.translation_anchor_set_id, v.translation_policy_version_id
       FROM document_translation_heads h
       JOIN document_translation_versions v ON v.id = h.current_version_id
       WHERE h.document_translation_id = ?`,
      translationId,
    );
    if (!row) throw new MunhaeError("not_found", "current translation version missing");
    return row;
  }

  private insertSource(
    nodeId: string,
    name: string,
    text: string,
    originKind: "paste" | "manual" | "import",
    confirmed: boolean,
    now: string,
  ): void {
    const sourceTextId = createId();
    const versionId = createId();
    insertRow(this.db, "src_texts", {
      id: sourceTextId,
      project_id: this.projectId,
      document_node_id: nodeId,
      name,
      status: "active",
      created_at: now,
      tombstoned_at: null,
    });
    insertRow(this.db, "src_text_versions", {
      id: versionId,
      project_id: this.projectId,
      source_text_id: sourceTextId,
      parent_version_id: null,
      version_no: 1,
      content_text: text,
      origin_kind: originKind,
      source_asset_id: null,
      change_summary: null,
      state: confirmed ? "confirmed" : "draft",
      content_hash: sha256Hex(text),
      created_by_actor_id: this.actors.humanId,
      created_at: now,
    });
    insertRow(this.db, "src_text_heads", {
      project_id: this.projectId,
      source_text_id: sourceTextId,
      current_version_id: versionId,
      confirmed_version_id: confirmed ? versionId : null,
      lock_version: 1,
      updated_at: now,
    });
  }

  private listDocuments(): DocumentListItem[] {
    const nodes = allRows<{
      id: string;
      parent_node_id: string | null;
      node_role: DocumentNodeRole;
      is_master: number;
      title: string;
      original_title: string | null;
      ordinal: number;
    }>(
      this.db,
      `SELECT id, parent_node_id, node_role, is_master, title, original_title, ordinal
       FROM document_nodes WHERE project_id = ? AND archived_at IS NULL
       ORDER BY ordinal`,
      this.projectId,
    );
    const byParent = new Map<string | null, typeof nodes>();
    for (const n of nodes) {
      const key = n.parent_node_id;
      const list = byParent.get(key) ?? [];
      list.push(n);
      byParent.set(key, list);
    }
    const directContextCounts = new Map<string, number>();
    for (const row of allRows<{ scope_kind: string | null; scope_id: string | null; n: number }>(
      this.db,
      `SELECT scope_kind, scope_id, COUNT(*) AS n
       FROM context_items
       WHERE project_id = ? AND archived_at IS NULL
       GROUP BY scope_kind, scope_id`,
      this.projectId,
    )) {
      if (row.scope_kind === "document_node" && row.scope_id) {
        directContextCounts.set(row.scope_id, (directContextCounts.get(row.scope_id) ?? 0) + row.n);
      }
    }
    for (const row of allRows<{ id: string }>(
      this.db,
      `SELECT id FROM document_nodes
       WHERE project_id = ? AND archived_at IS NULL AND trim(COALESCE(description_md, '')) <> ''`,
      this.projectId,
    )) {
      directContextCounts.set(row.id, (directContextCounts.get(row.id) ?? 0) + 1);
    }
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const effectiveContextCount = (nodeId: string): number => {
      let count = 0;
      let current = nodeById.get(nodeId);
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        count += directContextCounts.get(current.id) ?? 0;
        current = current.parent_node_id ? nodeById.get(current.parent_node_id) : undefined;
      }
      return count;
    };
    const ordered: Array<(typeof nodes)[number] & { depth: number }> = [];
    const walk = (parent: string | null, depth: number) => {
      const kids = (byParent.get(parent) ?? []).slice().sort((a, b) => a.ordinal - b.ordinal);
      for (const k of kids) {
        ordered.push({ ...k, depth });
        walk(k.id, depth + 1);
      }
    };
    walk(null, 0);

    const uncCounts = new Map(
      ordered.map((node) => [
        node.id,
        loadOpenUncertaintyIdsForDocument(this.db, this.projectId, node.id).length,
      ]),
    );

    return ordered.map((n) => ({
      id: n.id,
      parentId: n.parent_node_id,
      depth: n.depth,
      nodeRole: n.node_role,
      isMaster: n.is_master === 1,
      title: n.title,
      originalTitle: n.original_title,
      ordinal: n.ordinal,
      sourceState: this.sourceUi(n.id),
      punctuationState: this.puncUi(n.id),
      translationState: this.translationUi(n.id),
      uncertaintyCount: uncCounts.get(n.id) ?? 0,
      contextCount: effectiveContextCount(n.id),
    }));
  }

  private sourceUi(nodeId: string): VersionUiState {
    const row = getRow<{ state: string }>(
      this.db,
      `SELECT v.state
       FROM src_texts t
       JOIN src_text_heads h ON h.source_text_id = t.id
       JOIN src_text_versions v ON v.id = h.current_version_id
       WHERE t.document_node_id = ? LIMIT 1`,
      nodeId,
    );
    if (!row) return "none";
    if (row.state === "confirmed") return "confirmed";
    return "draft";
  }

  private puncUi(nodeId: string): VersionUiState {
    const row = getRow<{ state: string; punctuation_source_version_id: string; source_version_id: string }>(
      this.db,
      `SELECT v.state, v.source_text_version_id AS punctuation_source_version_id,
              source_head.current_version_id AS source_version_id
       FROM src_texts t
       JOIN src_text_heads source_head ON source_head.source_text_id = t.id
       JOIN punctuation_sets s ON s.source_text_id = t.id
       JOIN punctuation_heads h ON h.punctuation_set_id = s.id
       JOIN punctuation_versions v ON v.id = h.current_version_id
       WHERE t.document_node_id = ? LIMIT 1`,
      nodeId,
    );
    if (!row) return "none";
    if (row.state === "confirmed" && row.punctuation_source_version_id === row.source_version_id) return "confirmed";
    return "draft";
  }

  private translationUi(nodeId: string): VersionUiState {
    const rows = allRows<{ state: string; validation_state: string; confirmed: string | null; stale: number }>(
      this.db,
      `SELECT v.state, v.validation_state, h.confirmed_version_id AS confirmed,
              (SELECT COUNT(*) FROM translation_staleness st WHERE st.document_translation_version_id = v.id AND st.resolved_by_document_translation_version_id IS NULL) AS stale
       FROM document_translations t
       JOIN document_translation_heads h ON h.document_translation_id = t.id
       JOIN document_translation_versions v ON v.id = h.current_version_id
       WHERE t.document_node_id = ? AND t.tombstoned_at IS NULL`,
      nodeId,
    );
    if (!rows.length) return "none";
    if (rows.some((r) => r.validation_state === "needs_review" || r.stale > 0)) return "review";
    if (rows.some((r) => r.confirmed && r.state === "confirmed")) return "confirmed";
    return "draft";
  }

  private inheritMetadata(node: {
    author_person_id: string | null;
    language: string | null;
    period_text: string | null;
    source_reference: string | null;
    parent_node_id: string | null;
  }): { authorName: string | null; language: string | null; periodText: string | null; sourceReference: string | null } {
    let authorId = node.author_person_id;
    let language = node.language;
    let periodText = node.period_text;
    let sourceReference = node.source_reference;
    let parentId = node.parent_node_id;
    while (parentId && (!authorId || !language || !periodText || !sourceReference)) {
      const p = getRow<{
        author_person_id: string | null;
        language: string | null;
        period_text: string | null;
        source_reference: string | null;
        parent_node_id: string | null;
      }>(
        this.db,
        `SELECT author_person_id, language, period_text, source_reference, parent_node_id FROM document_nodes WHERE id = ?`,
        parentId,
      );
      if (!p) break;
      authorId ??= p.author_person_id;
      language ??= p.language;
      periodText ??= p.period_text;
      sourceReference ??= p.source_reference;
      parentId = p.parent_node_id;
    }
    let authorName: string | null = null;
    if (authorId) {
      const person = getRow<{ preferred_name: string }>(this.db, `SELECT preferred_name FROM persons WHERE id = ?`, authorId);
      authorName = person?.preferred_name ?? null;
    }
    return { authorName, language, periodText, sourceReference };
  }

  private documentLineage(documentNodeId: string): Array<{
    id: string;
    title: string;
    originalTitle: string | null;
    descriptionMd: string | null;
    distance: number;
  }> {
    type LineageRow = {
      id: string;
      parent_node_id: string | null;
      title: string;
      original_title: string | null;
      description_md: string | null;
    };
    const lineage: Array<{
      id: string;
      title: string;
      originalTitle: string | null;
      descriptionMd: string | null;
      distance: number;
    }> = [];
    const seen = new Set<string>();
    let id: string | null = documentNodeId;
    let distance = 0;
    while (id && !seen.has(id)) {
      seen.add(id);
      const node: LineageRow | undefined = getRow<LineageRow>(
        this.db,
        `SELECT id, parent_node_id, title, original_title, description_md
         FROM document_nodes WHERE id = ? AND project_id = ? AND archived_at IS NULL`,
        id,
        this.projectId,
      );
      if (!node) break;
      lineage.push({
        id: node.id,
        title: node.title,
        originalTitle: node.original_title,
        descriptionMd: node.description_md,
        distance,
      });
      id = node.parent_node_id;
      distance += 1;
    }
    return lineage;
  }

  private loadChat(input: GetProjectChatInput): EditorView["chat"] {
    const scopeId = input.scopeKind === "project" ? this.projectId : input.documentNodeId;
    return allRows<{ role: "user" | "assistant"; text: string; created_at: string; agent_id: string | null }>(
      this.db,
      `SELECT m.role, COALESCE(p.text_content, '') AS text, m.created_at, m.agent_id
       FROM chat_threads t
       JOIN chat_messages m ON m.thread_id = t.id
       JOIN chat_message_parts p ON p.message_id = m.id AND p.ordinal = 1
       WHERE t.project_id = ? AND t.scope_kind = ? AND t.scope_id = ?
         AND m.state = 'completed'
         AND (
           (m.role = 'user' AND m.task_kind = 'chat_request')
           OR (m.role = 'assistant' AND m.task_kind = 'chat')
         )
       ORDER BY m.created_at, m.rowid`,
      this.projectId,
      input.scopeKind,
      scopeId,
    ).map((r) => ({
      role: r.role,
      text: r.text,
      createdAt: r.created_at,
      meta: r.agent_id ?? undefined,
    }));
  }
}

type StageCtx = {
  translationId: string;
  lockVersion: number;
  sourceLockVersion: number;
  puncLockVersion: number;
  sourceVersionId: string;
  puncVersionId: string;
  anchorSetId: string;
  policyVersionId: string;
};

type SourceCtx = {
  sourceTextId: string;
  currentVersionId: string;
  confirmedVersionId: string | null;
  lockVersion: number;
  currentVersionNo: number;
  currentState: "draft" | "confirmed" | "rejected" | "superseded";
  currentContentText: string;
  currentContentHash: string;
};

type PunctuationCtx = {
  punctuationSetId: string;
  currentVersionId: string;
  confirmedVersionId: string | null;
  lockVersion: number;
  currentVersionNo: number;
  currentState: "draft" | "confirmed" | "rejected" | "superseded";
  currentPunctuatedText: string;
  sourceVersionId: string;
  structureMode: PunctuationStructureMode;
};

function uniqueKeep(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function structureModeFromJson(
  structureJson: string | null,
  spans?: Array<{ span_kind?: string; spanKind?: string }>,
): PunctuationStructureMode {
  if (structureJson) {
    try {
      const value = JSON.parse(structureJson) as { mode?: unknown; kind?: unknown };
      if (value.mode === "poetry" || value.kind === "poetry") return "poetry";
      if (value.mode === "prose" || value.kind === "prose") return "prose";
    } catch {
      // The migration guarantees valid JSON; fall through for legacy rows.
    }
  }
  return spans?.some((span) => (span.span_kind ?? span.spanKind) === "verse_line") ? "poetry" : "prose";
}

export function createProject(opts: {
  title: string;
  parentDir: string;
  actorDisplayName?: string;
}): { handle: ProjectRepo; summary: ProjectSummary } {
  const boot = bootstrapEmptyProject(opts);
  const now = boot.createdAt;
  const rootId = createId();
  insertRow(boot.db, "document_nodes", {
    id: rootId,
    project_id: boot.projectId,
    parent_node_id: null,
    node_role: "container",
    is_master: 1,
    title: opts.title,
    original_title: null,
    ordinal: 0,
    author_person_id: null,
    language: "lzh",
    period_text: null,
    date_text: null,
    description_md: null,
    source_reference: null,
    created_at: now,
    updated_at: now,
    archived_at: null,
  });
  insertRow(boot.db, "core_project_settings", {
    project_id: boot.projectId,
    active_document_node_id: rootId,
    autosave_interval_ms: 3000,
    ai_data_policy_json: JSON.stringify({ storePrompts: false }),
    settings_json: JSON.stringify({}),
    lock_version: 1,
  });
  const handle = new ProjectRepo(boot);
  return {
    handle,
    summary: {
      projectId: handle.projectId,
      title: handle.title,
      packagePath: handle.packagePath,
      storageMode: "local",
      openedAt: handle.openedAt,
    },
  };
}

export function openProject(packagePath: string): ProjectRepo {
  return new ProjectRepo(openProjectDb(packagePath));
}

export function seedDemoProject(parentDir: string): ProjectRepo {
  const boot = bootstrapEmptyProject({
    title: "훈민정음 문헌 번역",
    parentDir,
    actorDisplayName: "로컬 사용자",
  });
  try {
    boot.db.transaction(() => seedDemoContents(boot))();
  } catch (err) {
    boot.db.close();
    releaseLock(boot.packagePath);
    throw err;
  }
  return new ProjectRepo(boot);
}

export function sqlitePath(packagePath: string): string {
  return resolvePackagePath(packagePath, "project.sqlite3");
}
