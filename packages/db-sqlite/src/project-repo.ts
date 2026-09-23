import { and, eq, ne, isNull, inArray, sql, getTableColumns } from "drizzle-orm";
import { orm } from "./drizzle-db.ts";
import { schema as tables } from "./drizzle-schema.ts";
import { moveDocument as moveStoredDocument } from "./document-organization.ts";
import * as commentReferences from "./comment-references.ts";
import { termSource } from "@munhae/domain/term-source";
import * as termReview from "./term-review.ts";
import { searchConcordance, type ConcordanceInput } from "./concordance.ts";
import { buildReviewExport, type ReviewExportInput } from "./review-export.ts";
import * as fullText from "./full-text.ts";
import * as materials from "./materials.ts";
import type { MaterialsView, SetMaterialPreferenceInput, ReuseCommentAsMaterialInput } from "./views.ts";
import * as reviewComments from "./review-comments.ts";
import * as readingAnnotations from "./reading-annotations.ts";
import type { SaveReadingAnnotationInput, ReadingAnnotationCasInput } from "./reading-annotations.ts";
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
import { bootstrapEmptyProject, openProjectDb, loadActors, type ProjectActors } from "./bootstrap.ts";
import { readOnlineRows, hydrateOnlineRows, type OnlineTableData } from "./online-data.ts";
import { seedDemoContents } from "./seed-demo.ts";
import {
  ensureTranslationAnchorsForPunctuationVersion,
  insertPunctuationVersionWithAnchors,
  insertSourceLayer,
  prepareStructureSpans,
  punctuationSpanKind,
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
} from "./knowledge-content.ts";
import {
  deleteContextItem as deleteStoredContextItem,
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
  UpdateContextItemInput,
  UpdateDocumentMetadataInput,
  MoveDocumentInput,
  VersionUiState,
} from "./views.ts";

const TRANSLATION_STAGE = "translation";

export type WorkspaceConfiguration = {
  summary?: ProjectSummary;
  beforeOperation?: (method: string, mutating: boolean) => void;
  onChange?: () => void;
};

type PublicOperation = { [K in keyof ProjectRepo]: ProjectRepo[K] extends (...args: never[]) => unknown ? K : never }[keyof ProjectRepo];
type GuardedOperation = Exclude<PublicOperation, "configureWorkspace" | "close" | "backupTo" | "exportOnlineRows" | "applyOnlineRows">;

// This exhaustive public-method map makes every new operation choose its access
// policy. Reads may update derived FTS/verified_at data, which is not a user edit.
const WORKSPACE_OPERATIONS = {
  setTranslationLanguage: true,
  checkpoint: false,
  getHome: false,
  createDocument: true,
  getEditor: false,
  getChat: false,
  getLatestPunctuationSuggestion: false,
  attachReferenceAsset: true,
  readReferenceAsset: false,
  referenceAssetPath: false,
  saveSourceDraft: true,
  confirmSource: true,
  createPunctuationDraftFromConfirmedSource: true,
  savePunctuationDraft: true,
  confirmPunctuation: true,
  createTranslationDraft: true,
  resetTranslationDraft: true,
  saveTranslationDraft: true,
  confirmTranslation: true,
  reviseTranslation: true,
  mergeBlocks: true,
  splitBlock: true,
  getDocumentHistory: false,
  compareVersions: false,
  createConfirmedExport: false,
  concordance: false,
  createReviewExport: false,
  search: false,
  getTermContext: false,
  getTermReferenceComments: false,
  getTerms: false,
  deleteTerm: true,
  saveTerm: true,
  promoteTerm: true,
  storeTermCandidates: true,
  getKnowledge: false,
  upsertGlossary: true,
  moveDocument: true,
  getDocumentMetadata: false,
  updateDocumentMetadata: true,
  getMaterials: false,
  setMaterialPreference: true,
  reuseCommentAsMaterial: true,
  createContextItem: true,
  updateContextItem: true,
  setContextItemEnabled: true,
  setContextItemPriority: true,
  deleteContextItem: true,
  createUncertainty: true,
  createUncertaintyVersion: true,
  resolveUncertainty: true,
  previewContext: false,
  listReviewComments: false,
  saveSentenceLink: true,
  createReviewComment: true,
  updateReviewComment: true,
  archiveReviewComment: true,
  listReadingAnnotations: false,
  saveReadingAnnotation: true,
  archiveReadingAnnotation: true,
  beginFullTextRun: true,
  finishFullTextRun: true,
  completeFullTextRun: true,
  prepareAlignment: true,
  completeAlignment: true,
  submitAlignment: true,
  checkAlignment: false,
  finishAlignment: true,
  failAlignment: true,
  previewLegacyContext: false,
  beginProjectChatRun: true,
  beginPunctuationSuggestionRun: true,
  completeProjectChatRun: true,
  completePunctuationSuggestionRun: true,
  applyPunctuationSuggestionRun: true,
  failProjectTaskRun: true,
  recordProjectAgentSession: true,
  invalidateProjectAgentSession: true,
  beginTranslationRun: true,
  completeTranslationRun: true,
  recordInvalidTranslationResponse: true,
  failTranslationRun: true,
  recordTranslationAgentSession: true,
} satisfies Record<GuardedOperation, boolean>;

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
  table: "glossary_entries",
  id: string,
): never {
  const target = tables[table];
  const row = orm(db)
    .select({ lock_version: target.lock_version })
    .from(target)
    .where(
      and(
        eq(target.id, id),
        eq(target.project_id, projectId),
        isNull(target.archived_at),
      ),
    )
    .get();
  if (!row) throw new MunhaeError("not_found", "지식 항목을 찾을 수 없습니다");
  throw new MunhaeError("cas_conflict", `지식 항목이 다른 편집에서 변경되었습니다 (현재 lock_version ${row.lock_version})`);
}

function unresolvedStalenessCount() {
  return sql<number>`(SELECT COUNT(*) FROM ${tables.translation_staleness}
    WHERE ${tables.translation_staleness.document_translation_version_id} = ${tables.document_translation_versions.id}
      AND ${tables.translation_staleness.resolved_by_document_translation_version_id} IS NULL)`;
}

export class ProjectRepo {
  readonly packagePath: string;
  readonly projectId: string;
  readonly title: string;
  readonly openedAt: string;
  private readonly db: SqliteDb;
  private readonly actors: ProjectActors;
  private policyVersionId: string;
  private basePolicyVersionId: string;
  private translationLanguage: "ko" | "en" = "ko";
  private closed = false;
  private workspace: WorkspaceConfiguration | null = null;
  private workspaceDepth = 0;
  private workspaceChanged = false;

  constructor(boot: {
    db: SqliteDb;
    packagePath: string;
    projectId: string;
    title: string;
    actors: ProjectActors;
    policyVersionId: string;
  }, options: { onlineCache?: boolean } = {}) {
    this.db = boot.db;
    this.packagePath = boot.packagePath;
    this.projectId = boot.projectId;
    this.title = boot.title;
    this.actors = boot.actors;
    this.policyVersionId = boot.policyVersionId;
    this.basePolicyVersionId = boot.policyVersionId;
    this.openedAt = nowIso();
    if (!options.onlineCache) {
      orm(this.db)
        .update(tables.translation_text_layouts)
        .set({
          alignment_state: "failed",
          alignment_error:
            "앱이 종료되어 연결이 중단되었습니다. 다시 실행할 수 있습니다.",
        })
        .where(eq(tables.translation_text_layouts.alignment_state, "running"))
        .run();
      this.recoverInterruptedTranslationRuns();
      recoverInterruptedProjectTasks(
        this.db,
        this.projectId,
        (messageId) => this.readInterruptedRunEvents(messageId),
      );
    }
  }

  /** Main-owned sync adapter; renderer operations still use the guarded domain methods. */
  exportOnlineRows(): OnlineTableData {
    if (this.closed) throw new MunhaeError("project_closed", "프로젝트가 닫혔습니다");
    return readOnlineRows(this.db);
  }

  applyOnlineRows(rows: OnlineTableData): void {
    if (this.closed) throw new MunhaeError("project_closed", "프로젝트가 닫혔습니다");
    hydrateOnlineRows(this.db, this.projectId, rows);
    Object.assign(this.actors, loadActors(this.db));
    const policy = this.db.prepare(`SELECT heads.current_version_id FROM core_translation_policy_heads heads
      JOIN core_translation_policies policies ON policies.id=heads.policy_id WHERE policies.project_id=? LIMIT 1`).get(this.projectId) as { current_version_id: string } | undefined;
    if (policy) this.basePolicyVersionId = this.policyVersionId = policy.current_version_id;
    const localized = this.db.prepare(`SELECT id FROM core_translation_policy_versions WHERE parent_version_id=? AND target_locale=? ORDER BY version_no DESC LIMIT 1`).get(this.basePolicyVersionId, this.translationLanguage) as { id: string } | undefined;
    if (localized) this.policyVersionId = localized.id;
  }

  configureWorkspace(configuration: WorkspaceConfiguration): void {
    if (!this.workspace) {
      for (const method of Object.keys(WORKSPACE_OPERATIONS) as GuardedOperation[]) {
        const original = this[method];
        Object.defineProperty(this, method, {
          configurable: true,
          value: (...args: unknown[]) => this.workspaceOperation(method, WORKSPACE_OPERATIONS[method], () => Reflect.apply(original, this, args)),
        });
      }
    }
    this.workspace = { ...configuration, summary: configuration.summary ? { ...configuration.summary } : undefined };
  }

  private workspaceOperation<T>(method: string, mutating: boolean, operation: () => T): T {
    this.workspace?.beforeOperation?.(method, mutating);
    const before = mutating ? this.totalChanges() : 0;
    this.workspaceDepth += 1;
    try { return operation(); }
    finally {
      if (mutating && this.totalChanges() !== before) this.workspaceChanged = true;
      this.workspaceDepth -= 1;
      if (!this.workspaceDepth && this.workspaceChanged) {
        this.workspaceChanged = false;
        this.workspace?.onChange?.();
      }
    }
  }

  private totalChanges(): number {
    return orm(this.db).get<{ changes: number }>(
      sql`SELECT total_changes() AS changes`,
    )!.changes;
  }

  setTranslationLanguage(language: "ko" | "en"): void {
    if (language !== "ko" && language !== "en") throw new MunhaeError("invalid_payload", "Unsupported translation language");
    const base = orm(this.db)
      .select({ ...getTableColumns(tables.core_translation_policy_versions) })
      .from(tables.core_translation_policy_versions)
      .where(
        sql`${tables.core_translation_policy_versions.id} = ${this.basePolicyVersionId}`,
      )
      .get()!;
    if (base.target_locale === language) {
      this.policyVersionId = this.basePolicyVersionId;
    } else {
      const existing = orm(this.db)
        .select({ id: tables.core_translation_policy_versions.id })
        .from(tables.core_translation_policy_versions)
        .where(
          sql`${tables.core_translation_policy_versions.parent_version_id} = ${this.basePolicyVersionId} AND ${tables.core_translation_policy_versions.target_locale} = ${language}`,
        )
        .orderBy(sql`${tables.core_translation_policy_versions.version_no} DESC`)
        .limit(1)
        .get();
      if (existing) this.policyVersionId = existing.id;
      else {
        const name = language === "en" ? "English" : "Korean";
        const rules = { ...JSON.parse(String(base.rules_json ?? "{}")), targetLocale: language,
          audience: `${name}-speaking readers and researchers`,
          hanjaPolicy: `Translate terms into ${name}; preserve original Chinese characters in parentheses where useful.` };
        const body = { ...base, content_hash: "", id: createId(), parent_version_id: this.basePolicyVersionId,
          version_no: orm(this.db)
            .select({
              n: sql<number>`MAX(${tables.core_translation_policy_versions.version_no}) + 1`,
            })
            .from(tables.core_translation_policy_versions)
            .where(
              sql`${tables.core_translation_policy_versions.policy_id} = ${base.policy_id}`,
            )
            .get()!.n,
          target_locale: language, audience: rules.audience, hanja_policy: rules.hanjaPolicy,
          style_guide_md: `${String(base.style_guide_md ?? "")}\nTarget language override: produce the complete translation in ${name}. This overrides any language-specific wording above.`,
          rules_json: JSON.stringify(rules), created_at: nowIso() };
        body.content_hash = sha256Hex(canonicalJson(body));
        orm(this.db)
          .insert(tables.core_translation_policy_versions)
          .values(body)
          .run();
        this.policyVersionId = body.id;
      }
    }
    this.translationLanguage = language;
  }

  private summary(): ProjectSummary {
    if (this.workspace?.summary) return { ...this.workspace.summary };
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

    const recent = orm(this.db)
      .select({
        title: tables.document_nodes.title,
        version_no: tables.document_translation_versions.version_no,
        state: tables.document_translation_versions.state,
        validation_state: tables.document_translation_versions.validation_state,
        origin_kind: tables.document_translation_versions.origin_kind,
        created_at: tables.document_translation_versions.created_at,
      })
      .from(tables.document_translation_versions)
      .innerJoin(
        tables.document_translations,
        sql`${tables.document_translations.id} = ${tables.document_translation_versions.document_translation_id}`,
      )
      .innerJoin(
        tables.document_nodes,
        sql`${tables.document_nodes.id} = ${tables.document_translations.document_node_id}`,
      )
      .where(
        sql`${tables.document_translation_versions.project_id} = ${this.projectId}`,
      )
      .orderBy(sql`${tables.document_translation_versions.created_at} DESC`)
      .limit(8)
      .all().map((r) => {
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
    return orm(this.db).transaction(() => {
      const sourceText = input.nodeRole === "source_unit" ? input.sourceText.replace(/^\uFEFF/, "") : "";
      if (input.nodeRole === "source_unit" && !sourceText.trim()) {
        throw new MunhaeError("invalid_input", "원문 문서에는 원문 내용이 필요합니다");
      }
      const id = createId();
      const now = nowIso();
      const master = orm(this.db)
        .select({ id: tables.document_nodes.id })
        .from(tables.document_nodes)
        .where(
          sql`${tables.document_nodes.project_id} = ${this.projectId} AND ${tables.document_nodes.is_master} = 1 AND ${tables.document_nodes.archived_at} IS NULL`,
        )
        .get();
      if (!master) throw new MunhaeError("invalid_project", "프로젝트 마스터 폴더가 없습니다");
      const parentId = input.parentId ?? master.id;
      let ordinal = 0;
      if (parentId) {
        const parent = orm(this.db)
          .select({
            id: tables.document_nodes.id,
            node_role: tables.document_nodes.node_role,
          })
          .from(tables.document_nodes)
          .where(
            sql`${tables.document_nodes.id} = ${parentId} AND ${tables.document_nodes.project_id} = ${this.projectId}`,
          )
          .get();
        if (!parent) throw new MunhaeError("not_found", "parent document not found");
        if (parent.node_role !== "container") {
          throw new MunhaeError("invalid_parent", "원문 문서 아래에는 하위 항목을 만들 수 없습니다");
        }
        const row = orm(this.db)
          .select({ m: sql<number | null>`MAX(${tables.document_nodes.ordinal})` })
          .from(tables.document_nodes)
          .where(
            sql`${tables.document_nodes.project_id} = ${this.projectId} AND ${tables.document_nodes.parent_node_id} = ${parentId}`,
          )
          .get();
        ordinal = (row?.m ?? -1) + 1;
      }
      orm(this.db)
        .insert(tables.document_nodes)
        .values({
          id,
          project_id: this.projectId,
          parent_node_id: parentId,
          node_role: input.nodeRole,
          is_master: 0,
          title: input.title,
          original_title: input.originalTitle?.trim() || null,
          ordinal,
          author_text: null,
          language: null,
          period_text: null,
          date_text: null,
          description_md: null,
          source_reference: null,
          created_at: now,
          updated_at: now,
          archived_at: null,
        })
        .run();
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
    });
  }

  getEditor(documentNodeId: string): EditorView {
    const node = orm(this.db)
      .select({ ...getTableColumns(tables.document_nodes) })
      .from(tables.document_nodes)
      .where(
        sql`${tables.document_nodes.id} = ${documentNodeId} AND ${tables.document_nodes.project_id} = ${this.projectId}`,
      )
      .get();
    if (!node) throw new MunhaeError("not_found", "document not found");
    if (node.node_role !== "source_unit") {
      throw new MunhaeError("not_ready", "목차 폴더에는 원문·표점안이 없습니다");
    }

    const inherited = this.inheritMetadata(node);
    const source = orm(this.db)
      .select({
        version_id: tables.src_text_versions.id,
        version_no: tables.src_text_versions.version_no,
        lock_version: tables.src_text_heads.lock_version,
        state: tables.src_text_versions.state,
        content_text: tables.src_text_versions.content_text,
        source_text_id: tables.src_texts.id,
      })
      .from(tables.src_texts)
      .innerJoin(
        tables.src_text_heads,
        sql`${tables.src_text_heads.source_text_id} = ${tables.src_texts.id}`,
      )
      .innerJoin(
        tables.src_text_versions,
        sql`${tables.src_text_versions.id} = ${tables.src_text_heads.current_version_id}`,
      )
      .where(
        sql`${tables.src_texts.document_node_id} = ${documentNodeId} AND ${tables.src_texts.tombstoned_at} IS NULL`,
      )
      .limit(1)
      .get();
    if (!source) throw new MunhaeError("not_ready", "이 문서에는 원문이 없습니다");

    const punc = orm(this.db)
      .select({
        version_id: tables.punctuation_versions.id,
        version_no: tables.punctuation_versions.version_no,
        lock_version: tables.punctuation_heads.lock_version,
        state: tables.punctuation_versions.state,
        punctuated_text: tables.punctuation_versions.punctuated_text,
        structure_json: tables.punctuation_versions.structure_json,
        source_text_version_id: tables.punctuation_versions.source_text_version_id,
        set_id: tables.punctuation_sets.id,
      })
      .from(tables.punctuation_sets)
      .innerJoin(
        tables.punctuation_heads,
        sql`${tables.punctuation_heads.punctuation_set_id} = ${tables.punctuation_sets.id}`,
      )
      .innerJoin(
        tables.punctuation_versions,
        sql`${tables.punctuation_versions.id} = ${tables.punctuation_heads.current_version_id}`,
      )
      .where(
        sql`${tables.punctuation_sets.source_text_id} = ${source.source_text_id}`,
      )
      .limit(1)
      .get();

    const anchorSet = punc ? orm(this.db)
      .select({ id: tables.translation_anchor_sets.id })
      .from(tables.translation_anchor_sets)
      .where(
        sql`${tables.translation_anchor_sets.document_node_id} = ${documentNodeId} AND ${tables.translation_anchor_sets.punctuation_version_id} = ${punc.version_id}`,
      )
      .orderBy(sql`${tables.translation_anchor_sets.created_at} DESC`)
      .limit(1)
      .get() : undefined;

    const structureSpans = punc ? orm(this.db)
      .select({
        id: tables.punctuation_structure_spans.id,
        span_kind: tables.punctuation_structure_spans.span_kind,
        parent_span_id: tables.punctuation_structure_spans.parent_span_id,
        ordinal: tables.punctuation_structure_spans.ordinal,
        codepoint_from: tables.punctuation_structure_spans.codepoint_from,
        codepoint_to: tables.punctuation_structure_spans.codepoint_to,
        quote: tables.punctuation_structure_spans.quote,
        label: tables.punctuation_structure_spans.label,
      })
      .from(tables.punctuation_structure_spans)
      .where(
        sql`${tables.punctuation_structure_spans.punctuation_version_id} = ${punc?.version_id ?? ""}`,
      )
      .orderBy(
        sql`${tables.punctuation_structure_spans.codepoint_from}, ${tables.punctuation_structure_spans.codepoint_to} DESC, ${tables.punctuation_structure_spans.ordinal}`,
      )
      .all() : [];

    const anchors = anchorSet ? orm(this.db)
      .select({
        anchor_key: tables.translation_anchors.anchor_key,
        ordinal: tables.translation_anchors.ordinal,
        boundary_kind: tables.translation_anchors.boundary_kind,
        punctuation_codepoint_from:
          tables.translation_anchors.punctuation_codepoint_from,
        punctuation_codepoint_to:
          tables.translation_anchors.punctuation_codepoint_to,
        punctuated_quote: tables.translation_anchors.punctuated_quote,
      })
      .from(tables.translation_anchors)
      .where(
        sql`${tables.translation_anchors.anchor_set_id} = ${anchorSet?.id ?? ""}`,
      )
      .orderBy(sql`${tables.translation_anchors.ordinal}`)
      .all() : [];

    const punctuationState: NonNullable<EditorView["punctuation"]>["state"] | null = punc
      ? (punc.source_text_version_id === source.version_id ? punc.state : "superseded")
      : null;
    const translationRow = orm(this.db)
      .select({
        ...getTableColumns(tables.document_translation_versions),
        lock_version: tables.document_translation_heads.lock_version,
        unresolved_staleness: unresolvedStalenessCount(),
      })
      .from(tables.document_translations)
      .innerJoin(
        tables.document_translation_heads,
        eq(
          tables.document_translation_heads.document_translation_id,
          tables.document_translations.id,
        ),
      )
      .innerJoin(
        tables.document_translation_versions,
        eq(
          tables.document_translation_versions.id,
          tables.document_translation_heads.current_version_id,
        ),
      )
      .where(
        and(
          eq(tables.document_translations.document_node_id, documentNodeId),
          eq(tables.document_translations.project_id, this.projectId),
          eq(tables.document_translations.target_locale, this.translationLanguage),
          isNull(tables.document_translations.tombstoned_at),
        ),
      )
      .limit(1)
      .get();
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
          spanKind: punctuationSpanKind(span.span_kind),
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
    const node = orm(this.db)
      .select({
        id: tables.document_nodes.id,
        node_role: tables.document_nodes.node_role,
      })
      .from(tables.document_nodes)
      .where(
        sql`${tables.document_nodes.id} = ${input.documentNodeId} AND ${tables.document_nodes.project_id} = ${this.projectId} AND ${tables.document_nodes.archived_at} IS NULL`,
      )
      .get();
    if (!node || node.node_role !== "source_unit") throw new MunhaeError("not_found", "document not found");
    return this.loadChat(input);
  }

  getLatestPunctuationSuggestion(documentNodeId: string): PunctuationSuggestionView | null {
    const row = orm(this.db)
      .select({
        id: tables.chat_messages.id,
        agent_id: tables.chat_messages.agent_id,
        text_content: tables.chat_message_parts.text_content,
        output_validation_state: tables.chat_messages.output_validation_state,
        structured_json: tables.chat_message_parts.structured_json,
        created_at: tables.chat_messages.created_at,
      })
      .from(tables.chat_threads)
      .innerJoin(
        tables.chat_messages,
        sql`${tables.chat_messages.thread_id} = ${tables.chat_threads.id}`,
      )
      .innerJoin(
        tables.chat_message_parts,
        sql`${tables.chat_message_parts.message_id} = ${tables.chat_messages.id} AND ${tables.chat_message_parts.ordinal} = 1`,
      )
      .where(
        sql`${tables.chat_threads.project_id} = ${this.projectId} AND ${tables.chat_threads.scope_kind} = 'document_node' AND ${tables.chat_threads.scope_id} = ${documentNodeId} AND ${tables.chat_messages.role} = 'assistant' AND ${tables.chat_messages.task_kind} = 'punctuation_suggest' AND ${tables.chat_messages.state} = 'completed'`,
      )
      .orderBy(
        sql`${tables.chat_messages.created_at} DESC, ${tables.chat_messages}.rowid DESC`,
      )
      .limit(1)
      .get();
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
      responseText: row.text_content ?? "",
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
    orm(this.db).transaction(() => {
      const ctx = this.requireSource(input.documentNodeId);
      if (ctx.currentState === "draft") {
        orm(this.db)
          .update(tables.src_text_versions)
          .set({ state: "superseded" })
          .where(eq(tables.src_text_versions.id, ctx.currentVersionId))
          .run();
      }
      const now = nowIso();
      const versionId = createId();
      orm(this.db)
        .insert(tables.src_text_versions)
        .values({
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
          state: "draft",
          content_hash: sha256Hex(contentText),
          created_by_actor_id: this.actors.humanId,
          created_at: now,
        })
        .run();
      this.casSourceHead(ctx.sourceTextId, input.expectedLockVersion, versionId);
      this.recordTranslationStaleness(input.documentNodeId, "source_text_changed", versionId, "source_text_version_id");
    });
    return this.getEditor(input.documentNodeId);
  }

  confirmSource(input: ConfirmSourceInput): EditorView {
    orm(this.db).transaction(() => {
      const ctx = this.requireSource(input.documentNodeId);
      if (ctx.currentState === "confirmed") {
        throw new MunhaeError("already_confirmed", "이미 확정된 원문안입니다");
      }
      orm(this.db)
        .update(tables.src_text_versions)
        .set({ state: "confirmed" })
        .where(eq(tables.src_text_versions.id, ctx.currentVersionId))
        .run();
      this.casSourceHead(ctx.sourceTextId, input.expectedLockVersion, ctx.currentVersionId, ctx.currentVersionId);
    });
    return this.getEditor(input.documentNodeId);
  }

  createPunctuationDraftFromConfirmedSource(input: CreatePunctuationDraftInput): EditorView {
    orm(this.db).transaction(() => {
      const source = this.requireSource(input.documentNodeId);
      if (source.lockVersion !== input.expectedSourceLockVersion) {
        throw new MunhaeError("cas_conflict", "원문안이 다른 편집에서 변경되었습니다");
      }
      if (source.currentState !== "confirmed" || source.confirmedVersionId !== source.currentVersionId) {
        throw new MunhaeError("source_not_confirmed", "현재 원문안을 확정한 뒤 표점 원문을 만들 수 있습니다");
      }
      const existing = orm(this.db)
        .select({
          punctuation_set_id: tables.punctuation_sets.id,
          current_version_id: tables.punctuation_heads.current_version_id,
          lock_version: tables.punctuation_heads.lock_version,
          version_no: tables.punctuation_versions.version_no,
          state: tables.punctuation_versions.state,
          source_text_version_id: tables.punctuation_versions.source_text_version_id,
        })
        .from(tables.punctuation_sets)
        .innerJoin(
          tables.punctuation_heads,
          sql`${tables.punctuation_heads.punctuation_set_id} = ${tables.punctuation_sets.id}`,
        )
        .innerJoin(
          tables.punctuation_versions,
          sql`${tables.punctuation_versions.id} = ${tables.punctuation_heads.current_version_id}`,
        )
        .where(
          sql`${tables.punctuation_sets.project_id} = ${this.projectId} AND ${tables.punctuation_sets.source_text_id} = ${source.sourceTextId} AND ${tables.punctuation_sets.status} = 'active'`,
        )
        .orderBy(sql`${tables.punctuation_sets.created_at}`)
        .limit(1)
        .get();
      if (existing?.source_text_version_id === source.currentVersionId) {
        throw new MunhaeError("punctuation_exists", "현재 원문에 대한 표점 작업안이 이미 있습니다");
      }

      const node = orm(this.db)
        .select({
          title: tables.document_nodes.title,
          original_title: tables.document_nodes.original_title,
        })
        .from(tables.document_nodes)
        .where(
          sql`${tables.document_nodes.id} = ${input.documentNodeId} AND ${tables.document_nodes.project_id} = ${this.projectId}`,
        )
        .get();
      if (!node) throw new MunhaeError("not_found", "document not found");
      const now = nowIso();
      const punctuationSetId = existing?.punctuation_set_id ?? createId();
      if (!existing) {
        orm(this.db)
          .insert(tables.punctuation_sets)
          .values({
            id: punctuationSetId,
            project_id: this.projectId,
            source_text_id: source.sourceTextId,
            name: `${node.original_title?.trim() || node.title} 표점`,
            policy_version_id: this.policyVersionId,
            status: "active",
            created_at: now,
          })
          .run();
      } else if (existing.state === "draft") {
        orm(this.db)
          .update(tables.punctuation_versions)
          .set({ state: "superseded" })
          .where(eq(tables.punctuation_versions.id, existing.current_version_id))
          .run();
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
        actorId: this.actors.humanId,
        anchorActorId: this.actors.systemId,
        createAnchors: false,
        now,
      });
      if (!existing) {
        orm(this.db)
          .insert(tables.punctuation_heads)
          .values({
            project_id: this.projectId,
            punctuation_set_id: punctuationSetId,
            current_version_id: created.punctuationVersionId,
            confirmed_version_id: null,
            lock_version: 1,
            updated_at: now,
          })
          .run();
      } else {
        this.casPunctuationHead(
          punctuationSetId,
          existing.lock_version,
          created.punctuationVersionId,
        );
      }
    });
    return this.getEditor(input.documentNodeId);
  }

  savePunctuationDraft(input: SavePunctuationDraftInput): EditorView {
    orm(this.db).transaction(() => {
      const source = this.requireSource(input.documentNodeId);
      if (source.currentState !== "confirmed" || source.confirmedVersionId !== source.currentVersionId) {
        throw new MunhaeError("source_not_confirmed", "현재 원문안을 확정해야 표점 작업안을 저장할 수 있습니다");
      }
      const punctuation = this.requirePunctuation(input.documentNodeId);
      if (punctuation.currentState === "draft") {
        orm(this.db)
          .update(tables.punctuation_versions)
          .set({ state: "superseded" })
          .where(eq(tables.punctuation_versions.id, punctuation.currentVersionId))
          .run();
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
    });
    return this.getEditor(input.documentNodeId);
  }

  confirmPunctuation(input: ConfirmPunctuationInput): EditorView {
    orm(this.db).transaction(() => {
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
      orm(this.db)
        .update(tables.punctuation_versions)
        .set({ state: "confirmed" })
        .where(eq(tables.punctuation_versions.id, punctuation.currentVersionId))
        .run();
      this.casPunctuationHead(
        punctuation.punctuationSetId,
        input.expectedLockVersion,
        punctuation.currentVersionId,
        punctuation.currentVersionId,
      );
    });
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

    orm(this.db).transaction(() => {
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
      const anchorSet = orm(this.db)
        .select({ id: tables.translation_anchor_sets.id })
        .from(tables.translation_anchor_sets)
        .where(
          sql`${tables.translation_anchor_sets.document_node_id} = ${input.documentNodeId} AND ${tables.translation_anchor_sets.source_text_version_id} = ${source.currentVersionId} AND ${tables.translation_anchor_sets.punctuation_version_id} = ${punctuation.currentVersionId}`,
        )
        .orderBy(sql`${tables.translation_anchor_sets.created_at} DESC`)
        .limit(1)
        .get();
      if (!anchorSet) throw new MunhaeError("not_ready", "현재 표점안의 번역 앵커가 없습니다");

      const policy = orm(this.db)
        .select({
          target_locale: tables.core_translation_policy_versions.target_locale,
        })
        .from(tables.core_translation_policy_versions)
        .where(
          sql`${tables.core_translation_policy_versions.id} = ${this.policyVersionId}`,
        )
        .get();
      if (!policy) throw new MunhaeError("not_ready", "현재 번역 원칙을 찾을 수 없습니다");
      const existing = orm(this.db)
        .select({ id: tables.document_translations.id })
        .from(tables.document_translations)
        .where(
          sql`${tables.document_translations.project_id} = ${this.projectId} AND ${tables.document_translations.source_text_id} = ${source.sourceTextId} AND ${tables.document_translations.target_locale} = ${policy.target_locale}`,
        )
        .get();
      if (existing) {
        throw new MunhaeError("already_exists", "이 번역 단계에는 이미 번역안이 있습니다");
      }

      const anchors = orm(this.db)
        .select({
          id: tables.translation_anchors.id,
          anchor_key: tables.translation_anchors.anchor_key,
          ordinal: tables.translation_anchors.ordinal,
          required: tables.translation_anchors.required,
          boundary_kind: tables.translation_anchors.boundary_kind,
        })
        .from(tables.translation_anchors)
        .where(sql`${tables.translation_anchors.anchor_set_id} = ${anchorSet.id}`)
        .orderBy(sql`${tables.translation_anchors.ordinal}`)
        .all();
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

      orm(this.db)
        .insert(tables.document_translations)
        .values({
          id: translationId,
          project_id: this.projectId,
          document_node_id: input.documentNodeId,
          source_text_id: source.sourceTextId,
          target_locale: policy.target_locale,
          created_at: createdAt,
          tombstoned_at: null,
        })
        .run();
      orm(this.db)
        .insert(tables.document_translation_versions)
        .values({
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
        })
        .run();
      insertVersionBlocks(this.db, this.projectId, versionId, drafts, anchors, validationState);
      recordValidation(this.db, this.projectId, versionId, findings, validationState);
      orm(this.db)
        .insert(tables.document_translation_heads)
        .values({
          project_id: this.projectId,
          document_translation_id: translationId,
          current_version_id: versionId,
          confirmed_version_id: null,
          lock_version: 1,
          updated_at: createdAt,
        })
        .run();
      orm(this.db)
        .insert(tables.user_edits)
        .values({
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
        })
        .run();
    });
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
    orm(this.db).transaction(() => {
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
    });
    return this.getEditor(input.documentNodeId);
  }

  saveTranslationDraft(input: SaveTranslationDraftInput): EditorView {
    if (this.getEditor(input.documentNodeId).translation?.textLayout) {
      fullText.saveText(this.fullTextContext(), input.documentNodeId, input.textContent ?? "", requirePositiveLockVersion(input.expectedLockVersion), input.textGroups);
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
    orm(this.db).transaction(() => {
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
      orm(this.db)
        .update(tables.document_translation_versions)
        .set({ state: "confirmed" })
        .where(eq(tables.document_translation_versions.id, current.id))
        .run();
      casUpdateHead(this.db, ctx.translationId, expectedLockVersion, {
        currentVersionId: current.id,
        confirmedVersionId: current.id,
      });
    });
    return this.getEditor(input.documentNodeId);
  }

  reviseTranslation(input: ReviseTranslationInput): EditorView {
    const editor = this.getEditor(input.documentNodeId);
    if (editor.translation?.textLayout) {
      fullText.saveText(this.fullTextContext(), input.documentNodeId, editor.translation.textContent, requirePositiveLockVersion(input.expectedLockVersion));
      return this.getEditor(input.documentNodeId);
    }
    const expectedLockVersion = requirePositiveLockVersion(input.expectedLockVersion);
    orm(this.db).transaction(() => {
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
    });
    return this.getEditor(input.documentNodeId);
  }

  mergeBlocks(input: MergeBlocksInput): EditorView {
    const expectedLockVersion = requirePositiveLockVersion(input.expectedLockVersion);
    orm(this.db).transaction(() => {
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
    });
    return this.getEditor(input.documentNodeId);
  }

  splitBlock(input: SplitBlockInput): EditorView {
    const expectedLockVersion = requirePositiveLockVersion(input.expectedLockVersion);
    orm(this.db).transaction(() => {
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
    });
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

  concordance(input: ConcordanceInput) { return searchConcordance(this.db, this.projectId, input); }

  createReviewExport(input: ReviewExportInput) { return buildReviewExport(this.db, this.projectId, input); }

  search(input: SearchQueryInput): SearchView {
    return searchProject(this.db, this.projectId, input);
  }

  getTermContext(documentId: string) {
    this.getEditor(documentId);
    return materials.resolveMaterials(this.db, this.projectId, documentId)
      .filter(item => item.included && item.source !== "comment_reference")
      .map(item => ({ id: item.id, title: item.title, scopeId: item.scopeId,
        reason: item.reason, content: materials.materialPromptContent(item) }));
  }

  getTermReferenceComments(documentId: string) {
    this.getEditor(documentId);
    return materials.resolveMaterials(this.db, this.projectId, documentId)
      .filter(item => item.included && item.source === "comment_reference")
      .map(item => ({ id: item.id, title: item.title, content: materials.materialPromptContent(item) }));
  }

  getTerms(documentId?: string): termReview.TermEntry[] {
    if (documentId) this.getEditor(documentId);
    return termReview.listTerms(this.db, this.projectId, documentId);
  }
  deleteTerm(input: { id: string; expectedLockVersion: number }): void {
    termReview.deleteDocumentTerm(this.db, this.projectId, input);
  }

  saveTerm(input: termReview.SaveTermInput): termReview.TermEntry {
    const editor = input.documentId ? this.getEditor(input.documentId) : null;
    return termReview.saveTerm(this.db, this.projectId, input, editor ? termSource(editor) : undefined);
  }
  promoteTerm(input: termReview.SaveTermInput): termReview.TermEntry {
    if (!input.id || !input.documentId) throw new MunhaeError("invalid_input", "저장된 문서 용어를 선택하세요.");
    return orm(this.db).transaction(() => {
      const local = this.saveTerm(input);
      const common = this.saveTerm({ ...input, id: undefined, expectedLockVersion: undefined, documentId: null, parentTermId: null, sourceVersion: null, quotes: [], contextNote: null, status: "draft" });
      return this.saveTerm({ ...input, expectedLockVersion: local.lockVersion, parentTermId: common.id });
    });
  }
  storeTermCandidates(documentId: string, sourceVersion: string, candidates: Array<termReview.TermContent & { quotes: string[] }>, generation: NonNullable<termReview.TermEntry["generation"]>): termReview.TermEntry[] {
    const editor = this.getEditor(documentId);
    return orm(this.db).transaction(() => candidates.map(candidate => termReview.saveTerm(this.db, this.projectId,
      { ...candidate, documentId, sourceVersion, status: "draft" }, termSource(editor), generation)));
  }

  getKnowledge(): KnowledgeView {
    const glossary = orm(this.db)
      .select({
        id: tables.glossary_entries.id,
        source_term: tables.glossary_entries.source_term,
        target_term: tables.glossary_entries.target_term,
        target_locale: tables.glossary_entries.target_locale,
        term_kind: tables.glossary_entries.term_kind,
        reading: tables.glossary_entries.reading,
        note_md: tables.glossary_entries.note_md,
        usage_status: tables.glossary_entries.usage_status,
        content_hash: tables.glossary_entries.content_hash,
        lock_version: tables.glossary_entries.lock_version,
      })
      .from(tables.glossary_entries)
      .where(
        sql`${tables.glossary_entries.project_id} = ${this.projectId} AND ${tables.glossary_entries.archived_at} IS NULL`,
      )
      .orderBy(
        sql`${tables.glossary_entries.source_term}, ${tables.glossary_entries.usage_status}`,
      )
      .all().map((g) => ({
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

    const uncertainties = loadUncertainties(this.db, this.projectId);

    const contextItems = materials.loadMaterialItems(this.db, this.projectId);

    return { glossary, uncertainties, contextItems };
  }

  upsertGlossary(entry: UpsertGlossaryInput): GlossaryEntryView {
    const now = nowIso();
    const id = entry.id ?? createId();
    const hash = glossaryContentHash(entry);
    const termKind = tables.glossary_entries.term_kind.enumValues.find(value => value === entry.termKind);
    if (!termKind) throw new MunhaeError("invalid_input", "올바른 용어 종류가 아닙니다");
    if (entry.id) {
      const info = orm(this.db)
        .update(tables.glossary_entries)
        .set({
          source_term: entry.sourceTerm,
          target_term: entry.targetTerm,
          target_locale: entry.targetLocale,
          term_kind: termKind,
          reading: entry.reading,
          note_md: entry.noteMd,
          usage_status: entry.usageStatus,
          content_hash: hash,
          lock_version: sql`${tables.glossary_entries.lock_version} + 1`,
          updated_by_actor_id: this.actors.humanId,
          updated_at: now,
        })
        .where(
          and(
            eq(tables.glossary_entries.id, id),
            eq(tables.glossary_entries.project_id, this.projectId),
            isNull(tables.glossary_entries.archived_at),
            eq(
              tables.glossary_entries.lock_version,
              requireKnowledgeLock(entry.expectedLockVersion),
            ),
          ),
        )
        .run();
      if (info.changes !== 1) throwKnowledgeCasFailure(this.db, this.projectId, "glossary_entries", id);
    } else {
      orm(this.db)
        .insert(tables.glossary_entries)
        .values({
          id,
          project_id: this.projectId,
          source_term: entry.sourceTerm,
          target_locale: entry.targetLocale,
          target_term: entry.targetTerm,
          term_kind: termKind,
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
        })
        .run();
    }
    const row = this.getKnowledge().glossary.find((g) => g.id === id);
    if (!row) throw new MunhaeError("internal", "glossary upsert failed");
    return row;
  }

  moveDocument(input: MoveDocumentInput): DocumentMetadataView {
    moveStoredDocument(this.db, this.projectId, input);
    return this.getDocumentMetadata(input.documentNodeId);
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

  getMaterials(documentNodeId?: string): MaterialsView {
    return materials.getMaterials({ db: this.db, projectId: this.projectId, actors: this.actors }, documentNodeId);
  }

  setMaterialPreference(input: SetMaterialPreferenceInput): void {
    materials.setMaterialPreference({ db: this.db, projectId: this.projectId, actors: this.actors }, input);
  }

  reuseCommentAsMaterial(input: ReuseCommentAsMaterialInput): NodeContextView {
    return materials.reuseCommentAsMaterial({ db: this.db, projectId: this.projectId, actors: this.actors }, input);
  }

  createContextItem(input: CreateContextItemInput): NodeContextView {
    return createStoredContextItem(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  updateContextItem(input: UpdateContextItemInput): NodeContextView {
    if (commentReferences.isCommentReference(this.db, this.projectId, input.id)) return commentReferences.updateCommentReference({ db: this.db, projectId: this.projectId, actors: this.actors }, input);
    return updateStoredContextItem(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  setContextItemEnabled(input: SetContextItemEnabledInput): NodeContextView {
    if (commentReferences.isCommentReference(this.db, this.projectId, input.id)) return commentReferences.patchCommentReference({ db: this.db, projectId: this.projectId, actors: this.actors }, input);
    return setStoredContextItemEnabled(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  setContextItemPriority(input: SetContextItemPriorityInput): NodeContextView {
    if (commentReferences.isCommentReference(this.db, this.projectId, input.id)) return commentReferences.patchCommentReference({ db: this.db, projectId: this.projectId, actors: this.actors }, input);
    return setStoredContextItemPriority(
      { db: this.db, projectId: this.projectId, actors: this.actors },
      input,
    );
  }

  deleteContextItem(input: ContextItemCasInput): void {
    if (commentReferences.isCommentReference(this.db, this.projectId, input.id)) return commentReferences.deleteCommentReference({ db: this.db, projectId: this.projectId, actors: this.actors }, input);
    deleteStoredContextItem(
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
  listReadingAnnotations(documentNodeId: string) { return readingAnnotations.listReadingAnnotations(this.fullTextContext(), documentNodeId); }
  saveReadingAnnotation(input: SaveReadingAnnotationInput) { return readingAnnotations.saveReadingAnnotation(this.fullTextContext(), input); }
  archiveReadingAnnotation(input: ReadingAnnotationCasInput) { readingAnnotations.archiveReadingAnnotation(this.fullTextContext(), input); }

  beginFullTextRun(input: BeginTranslationRunInput & {alignmentVersionId?:string}) { return fullText.beginText(this.fullTextContext(), input); }
  finishFullTextRun(input: CompleteTranslationRunInput) { fullText.finishTextRun(this.fullTextContext(),input); }
  completeFullTextRun(input: CompleteTranslationRunInput) { return fullText.completeText(this.fullTextContext(), input); }
  prepareAlignment(versionId: string) { return fullText.alignmentRequest(this.fullTextContext(), versionId); }
  completeAlignment(versionId: string, raw: string) { return fullText.completeAlignment(this.fullTextContext(), versionId, raw); }
  submitAlignment(versionId: string, raw: string) { return fullText.completeAlignment(this.fullTextContext(), versionId, raw, true); }
  checkAlignment(versionId: string) { return fullText.checkAlignment(this.fullTextContext(), versionId); }
  finishAlignment(versionId: string, input: fullText.AlignmentFinishInput) { return fullText.finishAlignment(this.fullTextContext(), versionId, input); }
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
    const policy = orm(this.db)
      .select({
        id: tables.core_translation_policy_versions.id,
        version_no: tables.core_translation_policy_versions.version_no,
        content_hash: tables.core_translation_policy_versions.content_hash,
        target_locale: tables.core_translation_policy_versions.target_locale,
        audience: tables.core_translation_policy_versions.audience,
        style_guide_md: tables.core_translation_policy_versions.style_guide_md,
        hanja_policy: tables.core_translation_policy_versions.hanja_policy,
        supplement_policy:
          tables.core_translation_policy_versions.supplement_policy,
        uncertainty_policy:
          tables.core_translation_policy_versions.uncertainty_policy,
        rules_json: tables.core_translation_policy_versions.rules_json,
      })
      .from(tables.core_translation_policy_versions)
      .where(
        sql`${tables.core_translation_policy_versions.id} = ${this.policyVersionId}`,
      )
      .get();
    if (!policy) throw new MunhaeError("not_ready", "현재 번역 원칙을 찾을 수 없습니다");
    const punctuated = currentPunctuation.punctuatedText;
    const anchorSet = orm(this.db)
      .select({
        id: tables.translation_anchor_sets.id,
        anchor_set_hash: tables.translation_anchor_sets.anchor_set_hash,
        source_text_version_id:
          tables.translation_anchor_sets.source_text_version_id,
      })
      .from(tables.translation_anchor_sets)
      .where(
        sql`${tables.translation_anchor_sets.document_node_id} = ${documentNodeId} AND ${tables.translation_anchor_sets.punctuation_version_id} = ${currentPunctuation.versionId}`,
      )
      .orderBy(sql`${tables.translation_anchor_sets.created_at} DESC`)
      .limit(1)
      .get();
    if (!anchorSet) throw new MunhaeError("not_ready", "이 표점안에는 번역 앵커가 없습니다");
    if (anchorSet.source_text_version_id !== editor.source.versionId) {
      throw new MunhaeError("stale_punctuation", "현재 원문안에서 새 표점안을 저장한 뒤 AI 실행을 준비해야 합니다");
    }
    this.validateStoredAnchorSet(documentNodeId, currentPunctuation.versionId);
    const requestAnchors = orm(this.db)
      .select({
        anchor_key: tables.translation_anchors.anchor_key,
        ordinal: tables.translation_anchors.ordinal,
        boundary_kind: tables.translation_anchors.boundary_kind,
        punctuation_codepoint_from:
          tables.translation_anchors.punctuation_codepoint_from,
        punctuation_codepoint_to:
          tables.translation_anchors.punctuation_codepoint_to,
        punctuated_quote_hash: tables.translation_anchors.punctuated_quote_hash,
        required: tables.translation_anchors.required,
      })
      .from(tables.translation_anchors)
      .where(sql`${tables.translation_anchors.anchor_set_id} = ${anchorSet.id}`)
      .orderBy(sql`${tables.translation_anchors.ordinal}`)
      .all().map((anchor) => ({
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
    for (const item of materials.resolveMaterials(this.db, this.projectId, documentNodeId)) {
      const content = materials.materialPromptContent(item);
      addAuxiliary({ id: item.id, kind: item.source === "comment_reference" ? "reference_comment" : item.source === "document_description" ? "document_context" : "context_item",
        label: item.title, reason: item.reason === "selected" ? "selected_document_context" : item.reason === "current" ? "current_document_context" : `ancestor_document_context:${distanceByNodeId.get(item.scopeId)}`,
        defaultIncluded: item.included, chars: codepointCount(content), content,
        material: { scopeId: item.scopeId, inheritToChildren: item.inheritToChildren !== false, lockVersion: item.lockVersion, origin: item.origin ?? null } });
      if (item.excluded || !commentReferences.referenceReady(item)) auxiliary[auxiliary.length - 1]!.included = false;
    }
    const pastComments = materials.referenceComments(this.db, this.projectId, input.referenceCommentIds);
    for (const comment of pastComments) {
      const content = canonicalJson({ instruction: "과거 원문 구절의 검토 사례입니다. 현재 문맥에 적용되는지 확인하고 질문을 확정 사실로 바꾸지 마세요.", comment });
      addAuxiliary({ id: `reference-comment:${comment.id}`, kind: "reference_comment", label: "과거 구절의 검토 사례", reason: "selected_comment_reference", defaultIncluded: true, chars: codepointCount(content), content });
    }

    // Translation memory is derived directly from immutable confirmed heads;
    // drafts/rejected versions are never eligible and no duplicate context row
    // is materialized.  The current document's confirmed head is included by
    // default as an exact revision baseline.  Other project examples remain
    // visible in the preview and require an explicit pin, avoiding an
    // unbounded implicit prompt as the project grows.
    const confirmedTranslations = orm(this.db)
      .select({
        document_node_id: tables.document_translations.document_node_id,
        document_title: tables.document_nodes.title,
        original_title: tables.document_nodes.original_title,
        stage: sql<string>`'translation'`,
        version_id: tables.document_translation_versions.id,
        version_hash: tables.document_translation_versions.content_hash,
        text_content: tables.document_translation_versions.text_content,
        punctuation_version_id: tables.punctuation_versions.id,
        punctuation_hash: tables.punctuation_versions.content_hash,
        punctuated_text: tables.punctuation_versions.punctuated_text,
      })
      .from(tables.document_translation_heads)
      .innerJoin(
        tables.document_translation_versions,
        sql`${tables.document_translation_versions.id} = ${tables.document_translation_heads.confirmed_version_id} AND ${tables.document_translation_versions.state} = 'confirmed'`,
      )
      .innerJoin(
        tables.document_translations,
        sql`${tables.document_translations.id} = ${tables.document_translation_heads.document_translation_id} AND ${tables.document_translations.project_id} = ${tables.document_translation_versions.project_id} AND ${tables.document_translations.tombstoned_at} IS NULL`,
      )
      .innerJoin(
        tables.document_nodes,
        sql`${tables.document_nodes.id} = ${tables.document_translations.document_node_id} AND ${tables.document_nodes.project_id} = ${tables.document_translations.project_id} AND ${tables.document_nodes.archived_at} IS NULL`,
      )
      .innerJoin(
        tables.punctuation_versions,
        sql`${tables.punctuation_versions.id} = ${tables.document_translation_versions.punctuation_version_id} AND ${tables.punctuation_versions.project_id} = ${tables.document_translation_versions.project_id}`,
      )
      .where(
        sql`${tables.document_translation_versions.project_id} = ${this.projectId}`,
      )
      .orderBy(
        sql`CASE WHEN ${tables.document_translations.document_node_id} = ${documentNodeId} THEN 0 ELSE 1 END, ${tables.document_nodes.title}, ${tables.document_translation_versions.version_no}`,
      )
      .all();
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
    const sourceSnapshot = orm(this.db)
      .select({ source_text_id: tables.src_text_versions.source_text_id })
      .from(tables.src_text_versions)
      .where(
        sql`${tables.src_text_versions.id} = ${editor.source.versionId} AND ${tables.src_text_versions.project_id} = ${this.projectId}`,
      )
      .get();
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
      const master = orm(this.db)
        .select({ id: tables.document_nodes.id })
        .from(tables.document_nodes)
        .where(
          sql`${tables.document_nodes.project_id} = ${this.projectId} AND ${tables.document_nodes.is_master} = 1 AND ${tables.document_nodes.archived_at} IS NULL`,
        )
        .get();
      if (!master) throw new MunhaeError("invalid_project", "프로젝트 마스터 폴더가 없습니다");
      const includedMaterials = materials.resolveMaterials(this.db, this.projectId, master.id).filter(item => item.included);
      const referenceComments = includedMaterials.filter(item => item.source === "comment_reference").map(item => {
        const content = materials.materialPromptContent(item);
        return { referenceId: item.id, title: item.title, content, contentHash: sha256Hex(content), priority: item.priority };
      });
      const enabledProjectContext = includedMaterials
        .filter(item => item.source !== "comment_reference").map(item => {
          const content = materials.materialPromptContent(item);
          return { contextItemId: item.id, title: item.title, content,
            contentHash: sha256Hex(content), priority: item.priority };
        });
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
        referenceComments,
      };
      rendered = renderProjectChatRequest({ snapshot, question });
    } else {
      const source = orm(this.db)
        .select({ content_hash: tables.src_text_versions.content_hash })
        .from(tables.src_text_versions)
        .where(
          sql`${tables.src_text_versions.id} = ${editor.source.versionId} AND ${tables.src_text_versions.project_id} = ${this.projectId}`,
        )
        .get();
      const punctuation = editor.punctuation ? orm(this.db)
        .select({ content_hash: tables.punctuation_versions.content_hash })
        .from(tables.punctuation_versions)
        .where(
          sql`${tables.punctuation_versions.id} = ${editor.punctuation.versionId} AND ${tables.punctuation_versions.project_id} = ${this.projectId}`,
        )
        .get() : null;
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
      const message = orm(this.db)
        .select({ request_manifest_json: tables.chat_messages.request_manifest_json })
        .from(tables.chat_messages)
        .where(
          sql`${tables.chat_messages.id} = ${input.messageId} AND ${tables.chat_messages.project_id} = ${this.projectId} AND ${tables.chat_messages.role} = 'assistant' AND ${tables.chat_messages.task_kind} = 'translation'`,
        )
        .get();
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
    const rows = orm(this.db)
      .select({ id: tables.chat_messages.id })
      .from(tables.chat_messages)
      .where(
        sql`${tables.chat_messages.project_id} = ${this.projectId} AND ${tables.chat_messages.role} = 'assistant' AND ${tables.chat_messages.task_kind} = 'translation' AND ${tables.chat_messages.state} IN ('queued', 'running', 'validating')`,
      )
      .all();
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
    const row = orm(this.db)
      .select({
        source_text_id: tables.src_texts.id,
        current_version_id: tables.src_text_heads.current_version_id,
        confirmed_version_id: tables.src_text_heads.confirmed_version_id,
        lock_version: tables.src_text_heads.lock_version,
        version_no: tables.src_text_versions.version_no,
        state: tables.src_text_versions.state,
        content_text: tables.src_text_versions.content_text,
        content_hash: tables.src_text_versions.content_hash,
      })
      .from(tables.src_texts)
      .innerJoin(
        tables.document_nodes,
        sql`${tables.document_nodes.id} = ${tables.src_texts.document_node_id}`,
      )
      .innerJoin(
        tables.src_text_heads,
        sql`${tables.src_text_heads.source_text_id} = ${tables.src_texts.id}`,
      )
      .innerJoin(
        tables.src_text_versions,
        sql`${tables.src_text_versions.id} = ${tables.src_text_heads.current_version_id}`,
      )
      .where(
        sql`${tables.src_texts.document_node_id} = ${documentNodeId} AND ${tables.src_texts.project_id} = ${this.projectId} AND ${tables.src_texts.tombstoned_at} IS NULL AND ${tables.document_nodes.node_role} = 'source_unit'`,
      )
      .limit(1)
      .get();
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
    const row = orm(this.db)
      .select({
        punctuation_set_id: tables.punctuation_sets.id,
        current_version_id: tables.punctuation_heads.current_version_id,
        confirmed_version_id: tables.punctuation_heads.confirmed_version_id,
        lock_version: tables.punctuation_heads.lock_version,
        version_no: tables.punctuation_versions.version_no,
        state: tables.punctuation_versions.state,
        punctuated_text: tables.punctuation_versions.punctuated_text,
        structure_json: tables.punctuation_versions.structure_json,
        source_text_version_id: tables.punctuation_versions.source_text_version_id,
      })
      .from(tables.src_texts)
      .innerJoin(
        tables.punctuation_sets,
        sql`${tables.punctuation_sets.source_text_id} = ${tables.src_texts.id}`,
      )
      .innerJoin(
        tables.punctuation_heads,
        sql`${tables.punctuation_heads.punctuation_set_id} = ${tables.punctuation_sets.id}`,
      )
      .innerJoin(
        tables.punctuation_versions,
        sql`${tables.punctuation_versions.id} = ${tables.punctuation_heads.current_version_id}`,
      )
      .where(
        sql`${tables.src_texts.document_node_id} = ${documentNodeId} AND ${tables.src_texts.project_id} = ${this.projectId} AND ${tables.src_texts.tombstoned_at} IS NULL AND ${tables.punctuation_sets.status} = 'active'`,
      )
      .orderBy(sql`${tables.punctuation_sets.created_at}`)
      .limit(1)
      .get();
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
    const head = tables.src_text_heads;
    const info = orm(this.db)
      .update(head)
      .set({
        current_version_id: currentVersionId,
        // Keep this column in SET even when unchanged: UPDATE OF triggers validate it.
        confirmed_version_id:
          confirmedVersionId === undefined
            ? head.confirmed_version_id
            : confirmedVersionId,
        lock_version: sql`${head.lock_version} + 1`,
        updated_at: nowIso(),
      })
      .where(
        and(
          eq(head.source_text_id, sourceTextId),
          eq(head.project_id, this.projectId),
          eq(head.lock_version, expectedLockVersion),
        ),
      )
      .run();
    if (info.changes !== 1) throw new MunhaeError("cas_conflict", "stale source lock_version");
  }

  private casPunctuationHead(
    punctuationSetId: string,
    expectedLockVersion: number,
    currentVersionId: string,
    confirmedVersionId?: string | null,
  ): void {
    const head = tables.punctuation_heads;
    const info = orm(this.db)
      .update(head)
      .set({
        current_version_id: currentVersionId,
        // Keep this column in SET even when unchanged: UPDATE OF triggers validate it.
        confirmed_version_id:
          confirmedVersionId === undefined
            ? head.confirmed_version_id
            : confirmedVersionId,
        lock_version: sql`${head.lock_version} + 1`,
        updated_at: nowIso(),
      })
      .where(
        and(
          eq(head.punctuation_set_id, punctuationSetId),
          eq(head.project_id, this.projectId),
          eq(head.lock_version, expectedLockVersion),
        ),
      )
      .run();
    if (info.changes !== 1) throw new MunhaeError("cas_conflict", "stale punctuation lock_version");
  }

  private loadStructureSpanInputs(punctuationVersionId: string): PunctuationStructureSpanInput[] {
    return orm(this.db)
      .select({
        id: tables.punctuation_structure_spans.id,
        span_kind: tables.punctuation_structure_spans.span_kind,
        parent_span_id: tables.punctuation_structure_spans.parent_span_id,
        ordinal: tables.punctuation_structure_spans.ordinal,
        codepoint_from: tables.punctuation_structure_spans.codepoint_from,
        codepoint_to: tables.punctuation_structure_spans.codepoint_to,
        label: tables.punctuation_structure_spans.label,
      })
      .from(tables.punctuation_structure_spans)
      .where(
        sql`${tables.punctuation_structure_spans.punctuation_version_id} = ${punctuationVersionId}`,
      )
      .all().map((span) => ({
      spanKey: span.id,
      spanKind: punctuationSpanKind(span.span_kind),
      parentSpanKey: span.parent_span_id,
      ordinal: span.ordinal,
      codepointFrom: span.codepoint_from,
      codepointTo: span.codepoint_to,
      label: span.label,
    }));
  }

  private validateStoredAnchorSet(documentNodeId: string, punctuationVersionId: string): void {
    const dependency = orm(this.db)
      .select({
        anchor_set_id: tables.translation_anchor_sets.id,
        source_text_version_id: tables.punctuation_versions.source_text_version_id,
        source_text: tables.src_text_versions.content_text,
        punctuated_text: tables.punctuation_versions.punctuated_text,
        set_source_version_id:
          tables.translation_anchor_sets.source_text_version_id,
      })
      .from(tables.translation_anchor_sets)
      .innerJoin(
        tables.punctuation_versions,
        sql`${tables.punctuation_versions.id} = ${tables.translation_anchor_sets.punctuation_version_id}`,
      )
      .innerJoin(
        tables.src_text_versions,
        sql`${tables.src_text_versions.id} = ${tables.punctuation_versions.source_text_version_id}`,
      )
      .where(
        sql`${tables.translation_anchor_sets.document_node_id} = ${documentNodeId} AND ${tables.translation_anchor_sets.punctuation_version_id} = ${punctuationVersionId}`,
      )
      .orderBy(sql`${tables.translation_anchor_sets.created_at} DESC`)
      .limit(1)
      .get();
    if (!dependency || dependency.source_text_version_id !== dependency.set_source_version_id) {
      throw new MunhaeError("invalid_anchor_set", "표점안과 일치하는 번역 앵커 집합이 없습니다");
    }
    const anchors = orm(this.db)
      .select({ ...getTableColumns(tables.translation_anchors) })
      .from(tables.translation_anchors)
      .where(
        sql`${tables.translation_anchors.anchor_set_id} = ${dependency.anchor_set_id}`,
      )
      .orderBy(sql`${tables.translation_anchors.ordinal}`)
      .all();
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
      const exactSpan = orm(this.db)
        .select({ n: sql<number>`COUNT(*)` })
        .from(tables.translation_anchor_structure_spans)
        .innerJoin(
          tables.punctuation_structure_spans,
          sql`${tables.punctuation_structure_spans.id} = ${tables.translation_anchor_structure_spans.punctuation_structure_span_id}`,
        )
        .where(
          sql`${tables.translation_anchor_structure_spans.anchor_id} = ${anchor.id} AND ${tables.punctuation_structure_spans.punctuation_version_id} = ${punctuationVersionId} AND ${tables.punctuation_structure_spans.span_kind} = ${anchor.boundary_kind} AND ${tables.punctuation_structure_spans.codepoint_from} = ${anchor.punctuation_codepoint_from} AND ${tables.punctuation_structure_spans.codepoint_to} = ${anchor.punctuation_codepoint_to}`,
        )
        .get();
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
    const dependency = tables.document_translation_versions[dependencyColumn];
    const versions = orm(this.db)
      .select({
        id: tables.document_translation_versions.id,
        old_dependency_id: dependency,
      })
      .from(tables.document_translation_versions)
      .innerJoin(
        tables.document_translations,
        eq(
          tables.document_translations.id,
          tables.document_translation_versions.document_translation_id,
        ),
      )
      .where(
        and(
          eq(tables.document_translations.document_node_id, documentNodeId),
          eq(tables.document_translations.project_id, this.projectId),
          ne(dependency, newDependencyId),
        ),
      )
      .all();
    const detectedAt = nowIso();
    for (const version of versions) {
      const existing = orm(this.db)
        .select({ id: tables.translation_staleness.id })
        .from(tables.translation_staleness)
        .where(
          sql`${tables.translation_staleness.document_translation_version_id} = ${version.id} AND ${tables.translation_staleness.cause_kind} = ${causeKind} AND ${tables.translation_staleness.new_dependency_id} = ${newDependencyId} AND ${tables.translation_staleness.resolved_by_document_translation_version_id} IS NULL`,
        )
        .get();
      if (existing) continue;
      orm(this.db)
        .insert(tables.translation_staleness)
        .values({
          id: createId(),
          project_id: this.projectId,
          document_translation_version_id: version.id,
          cause_kind: causeKind,
          old_dependency_id: version.old_dependency_id,
          new_dependency_id: newDependencyId,
          detected_at: detectedAt,
          resolved_by_document_translation_version_id: null,
        })
        .run();
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
    orm(this.db).transaction(() => {
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
    });
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
      orm(this.db)
        .update(tables.document_translation_versions)
        .set({ state: "superseded" })
        .where(eq(tables.document_translation_versions.id, parent.id))
        .run();
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
    orm(this.db)
      .insert(tables.document_translation_versions)
      .values({
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
      })
      .run();
    insertVersionBlocks(this.db, this.projectId, versionId, drafts, anchors, validationState);
    recordValidation(this.db, this.projectId, versionId, findings, validationState);
    casUpdateHead(this.db, ctx.translationId, opts.expectedLock, { currentVersionId: versionId });
    orm(this.db)
      .update(tables.translation_staleness)
      .set({
        resolved_by_document_translation_version_id: versionId,
      })
      .where(
        and(
          isNull(
            tables.translation_staleness
              .resolved_by_document_translation_version_id,
          ),
          inArray(
            tables.translation_staleness.document_translation_version_id,
            orm(this.db)
              .select({ id: tables.document_translation_versions.id })
              .from(tables.document_translation_versions)
              .where(
                eq(
                  tables.document_translation_versions.document_translation_id,
                  ctx.translationId,
                ),
              ),
          ),
        ),
      )
      .run();
    orm(this.db)
      .insert(tables.user_edits)
      .values({
        id: createId(),
        project_id: this.projectId,
        document_translation_id: ctx.translationId,
        base_document_translation_version_id: opts.parentId,
        result_document_translation_version_id: versionId,
        edit_kind: opts.editKind,
        actor_id: this.actors.humanId,
        created_at: now,
      })
      .run();
  }

  private requireTranslation(documentNodeId: string): StageCtx {
    const row = orm(this.db)
      .select({
        translation_id: tables.document_translations.id,
        lock_version: tables.document_translation_heads.lock_version,
      })
      .from(tables.document_translations)
      .innerJoin(
        tables.document_translation_heads,
        sql`${tables.document_translation_heads.document_translation_id} = ${tables.document_translations.id}`,
      )
      .where(
        sql`${tables.document_translations.document_node_id} = ${documentNodeId} AND ${tables.document_translations.project_id} = ${this.projectId} AND ${tables.document_translations.target_locale} = ${this.translationLanguage} AND ${tables.document_translations.tombstoned_at} IS NULL`,
      )
      .get();
    if (!row) throw new MunhaeError("not_found", "translation not found");
    const source = this.requireSource(documentNodeId);
    const punctuation = this.requirePunctuation(documentNodeId);
    if (source.currentState !== "confirmed" || punctuation.currentState !== "confirmed") {
      throw new MunhaeError("not_confirmed", "원문안과 표점안을 확정해야 번역안을 편집할 수 있습니다");
    }
    if (punctuation.sourceVersionId !== source.currentVersionId) {
      throw new MunhaeError("stale_punctuation", "현재 원문안에서 새 표점안을 저장해야 번역안을 편집할 수 있습니다");
    }
    const anchorSet = orm(this.db)
      .select({ id: tables.translation_anchor_sets.id })
      .from(tables.translation_anchor_sets)
      .where(
        sql`${tables.translation_anchor_sets.document_node_id} = ${documentNodeId} AND ${tables.translation_anchor_sets.source_text_version_id} = ${source.currentVersionId} AND ${tables.translation_anchor_sets.punctuation_version_id} = ${punctuation.currentVersionId}`,
      )
      .orderBy(sql`${tables.translation_anchor_sets.created_at} DESC`)
      .limit(1)
      .get();
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
    const stale = orm(this.db)
      .select({ n: sql<number>`COUNT(*)` })
      .from(tables.translation_staleness)
      .where(
        sql`${tables.translation_staleness.document_translation_version_id} = ${version.id} AND ${tables.translation_staleness.resolved_by_document_translation_version_id} IS NULL`,
      )
      .get();
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
    const row = orm(this.db)
      .select({
        id: tables.document_translation_versions.id,
        version_no: tables.document_translation_versions.version_no,
        state: tables.document_translation_versions.state,
        validation_state: tables.document_translation_versions.validation_state,
        text_content: tables.document_translation_versions.text_content,
        origin_kind: tables.document_translation_versions.origin_kind,
        parent_version_id: tables.document_translation_versions.parent_version_id,
        source_text_version_id:
          tables.document_translation_versions.source_text_version_id,
        punctuation_version_id:
          tables.document_translation_versions.punctuation_version_id,
        translation_anchor_set_id:
          tables.document_translation_versions.translation_anchor_set_id,
        translation_policy_version_id:
          tables.document_translation_versions.translation_policy_version_id,
      })
      .from(tables.document_translation_heads)
      .innerJoin(
        tables.document_translation_versions,
        sql`${tables.document_translation_versions.id} = ${tables.document_translation_heads.current_version_id}`,
      )
      .where(
        sql`${tables.document_translation_heads.document_translation_id} = ${translationId}`,
      )
      .get();
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
    orm(this.db)
      .insert(tables.src_texts)
      .values({
        id: sourceTextId,
        project_id: this.projectId,
        document_node_id: nodeId,
        name,
        status: "active",
        created_at: now,
        tombstoned_at: null,
      })
      .run();
    orm(this.db)
      .insert(tables.src_text_versions)
      .values({
        id: versionId,
        project_id: this.projectId,
        source_text_id: sourceTextId,
        parent_version_id: null,
        version_no: 1,
        content_text: text,
        origin_kind: originKind,
        source_asset_id: null,
        state: confirmed ? "confirmed" : "draft",
        content_hash: sha256Hex(text),
        created_by_actor_id: this.actors.humanId,
        created_at: now,
      })
      .run();
    orm(this.db)
      .insert(tables.src_text_heads)
      .values({
        project_id: this.projectId,
        source_text_id: sourceTextId,
        current_version_id: versionId,
        confirmed_version_id: confirmed ? versionId : null,
        lock_version: 1,
        updated_at: now,
      })
      .run();
  }

  private listDocuments(): DocumentListItem[] {
    const nodes = orm(this.db)
      .select({
        id: tables.document_nodes.id,
        parent_node_id: tables.document_nodes.parent_node_id,
        node_role: tables.document_nodes.node_role,
        is_master: tables.document_nodes.is_master,
        title: tables.document_nodes.title,
        original_title: tables.document_nodes.original_title,
        ordinal: tables.document_nodes.ordinal,
      })
      .from(tables.document_nodes)
      .where(
        sql`${tables.document_nodes.project_id} = ${this.projectId} AND ${tables.document_nodes.archived_at} IS NULL`,
      )
      .orderBy(sql`${tables.document_nodes.ordinal}`)
      .all();
    const byParent = new Map<string | null, typeof nodes>();
    for (const n of nodes) {
      const key = n.parent_node_id;
      const list = byParent.get(key) ?? [];
      list.push(n);
      byParent.set(key, list);
    }
    const directContextCounts = new Map<string, number>();
    for (const row of orm(this.db)
      .select({
        scope_kind: tables.context_items.scope_kind,
        scope_id: tables.context_items.scope_id,
        n: sql<number>`COUNT(*)`,
      })
      .from(tables.context_items)
      .where(
        sql`${tables.context_items.project_id} = ${this.projectId} AND ${tables.context_items.archived_at} IS NULL`,
      )
      .groupBy(tables.context_items.scope_kind, tables.context_items.scope_id)
      .all()) {
      if (row.scope_kind === "document_node" && row.scope_id) {
        directContextCounts.set(row.scope_id, (directContextCounts.get(row.scope_id) ?? 0) + row.n);
      }
    }
    for (const row of orm(this.db)
      .select({ id: tables.document_nodes.id })
      .from(tables.document_nodes)
      .where(
        sql`${tables.document_nodes.project_id} = ${this.projectId} AND ${tables.document_nodes.archived_at} IS NULL AND trim(COALESCE(${tables.document_nodes.description_md}, '')) <> ''`,
      )
      .all()) {
      directContextCounts.set(row.id, (directContextCounts.get(row.id) ?? 0) + 1);
    }
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const materialItems = materials.loadMaterialItems(this.db, this.projectId);
    const materialPreferences = materials.loadMaterialPreferences(this.db, this.projectId);
    const effectiveContextCount = (nodeId: string): number =>
      materials.resolveMaterials(this.db, this.projectId, nodeId, materialItems, materialPreferences).filter(item => item.included).length;
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
    const row = orm(this.db)
      .select({ state: tables.src_text_versions.state })
      .from(tables.src_texts)
      .innerJoin(
        tables.src_text_heads,
        sql`${tables.src_text_heads.source_text_id} = ${tables.src_texts.id}`,
      )
      .innerJoin(
        tables.src_text_versions,
        sql`${tables.src_text_versions.id} = ${tables.src_text_heads.current_version_id}`,
      )
      .where(sql`${tables.src_texts.document_node_id} = ${nodeId}`)
      .limit(1)
      .get();
    if (!row) return "none";
    if (row.state === "confirmed") return "confirmed";
    return "draft";
  }

  private puncUi(nodeId: string): VersionUiState {
    const row = orm(this.db)
      .select({
        state: tables.punctuation_versions.state,
        punctuation_source_version_id:
          tables.punctuation_versions.source_text_version_id,
        source_version_id: tables.src_text_heads.current_version_id,
      })
      .from(tables.src_texts)
      .innerJoin(
        tables.src_text_heads,
        sql`${tables.src_text_heads.source_text_id} = ${tables.src_texts.id}`,
      )
      .innerJoin(
        tables.punctuation_sets,
        sql`${tables.punctuation_sets.source_text_id} = ${tables.src_texts.id}`,
      )
      .innerJoin(
        tables.punctuation_heads,
        sql`${tables.punctuation_heads.punctuation_set_id} = ${tables.punctuation_sets.id}`,
      )
      .innerJoin(
        tables.punctuation_versions,
        sql`${tables.punctuation_versions.id} = ${tables.punctuation_heads.current_version_id}`,
      )
      .where(sql`${tables.src_texts.document_node_id} = ${nodeId}`)
      .limit(1)
      .get();
    if (!row) return "none";
    if (row.state === "confirmed" && row.punctuation_source_version_id === row.source_version_id) return "confirmed";
    return "draft";
  }

  private translationUi(nodeId: string): VersionUiState {
    const rows = orm(this.db)
      .select({
        state: tables.document_translation_versions.state,
        validation_state: tables.document_translation_versions.validation_state,
        confirmed: tables.document_translation_heads.confirmed_version_id,
        stale: unresolvedStalenessCount(),
      })
      .from(tables.document_translations)
      .innerJoin(
        tables.document_translation_heads,
        eq(
          tables.document_translation_heads.document_translation_id,
          tables.document_translations.id,
        ),
      )
      .innerJoin(
        tables.document_translation_versions,
        eq(
          tables.document_translation_versions.id,
          tables.document_translation_heads.current_version_id,
        ),
      )
      .where(
        and(
          eq(tables.document_translations.document_node_id, nodeId),
          eq(tables.document_translations.target_locale, this.translationLanguage),
          isNull(tables.document_translations.tombstoned_at),
        ),
      )
      .all();
    if (!rows.length) return "none";
    if (rows.some((r) => r.validation_state === "needs_review" || r.stale > 0)) return "review";
    if (rows.some((r) => r.confirmed && r.state === "confirmed")) return "confirmed";
    return "draft";
  }

  private inheritMetadata(node: {
    author_text: string | null;
    language: string | null;
    period_text: string | null;
    source_reference: string | null;
    parent_node_id: string | null;
  }): { authorName: string | null; language: string | null; periodText: string | null; sourceReference: string | null } {
    let authorName = node.author_text;
    let language = node.language;
    let periodText = node.period_text;
    let sourceReference = node.source_reference;
    let parentId = node.parent_node_id;
    while (parentId && (!authorName || !language || !periodText || !sourceReference)) {
      const p = orm(this.db)
        .select({
          author_text: tables.document_nodes.author_text,
          language: tables.document_nodes.language,
          period_text: tables.document_nodes.period_text,
          source_reference: tables.document_nodes.source_reference,
          parent_node_id: tables.document_nodes.parent_node_id,
        })
        .from(tables.document_nodes)
        .where(sql`${tables.document_nodes.id} = ${parentId}`)
        .get();
      if (!p) break;
      authorName ??= p.author_text;
      language ??= p.language;
      periodText ??= p.period_text;
      sourceReference ??= p.source_reference;
      parentId = p.parent_node_id;
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
      const node: LineageRow | undefined = orm(this.db)
        .select({
          id: tables.document_nodes.id,
          parent_node_id: tables.document_nodes.parent_node_id,
          title: tables.document_nodes.title,
          original_title: tables.document_nodes.original_title,
          description_md: tables.document_nodes.description_md,
        })
        .from(tables.document_nodes)
        .where(
          sql`${tables.document_nodes.id} = ${id} AND ${tables.document_nodes.project_id} = ${this.projectId} AND ${tables.document_nodes.archived_at} IS NULL`,
        )
        .get();
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
    return orm(this.db)
      .select({
        role: tables.chat_messages.role,
        text: sql<string>`COALESCE(${tables.chat_message_parts.text_content}, '')`,
        created_at: tables.chat_messages.created_at,
        agent_id: tables.chat_messages.agent_id,
      })
      .from(tables.chat_threads)
      .innerJoin(
        tables.chat_messages,
        sql`${tables.chat_messages.thread_id} = ${tables.chat_threads.id}`,
      )
      .innerJoin(
        tables.chat_message_parts,
        sql`${tables.chat_message_parts.message_id} = ${tables.chat_messages.id} AND ${tables.chat_message_parts.ordinal} = 1`,
      )
      .where(
        sql`${tables.chat_threads.project_id} = ${this.projectId} AND ${tables.chat_threads.scope_kind} = ${input.scopeKind} AND ${tables.chat_threads.scope_id} = ${scopeId} AND ${tables.chat_messages.state} = 'completed' AND ( (${tables.chat_messages.role} = 'user' AND ${tables.chat_messages.task_kind} = 'chat_request') OR (${tables.chat_messages.role} = 'assistant' AND ${tables.chat_messages.task_kind} = 'chat') )`,
      )
      .orderBy(
        sql`${tables.chat_messages.created_at}, ${tables.chat_messages}.rowid`,
      )
      .all().map((r) => ({
      role: r.role === "user" ? "user" : "assistant",
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
  projectId?: string;
}): { handle: ProjectRepo; summary: ProjectSummary } {
  const boot = bootstrapEmptyProject(opts);
  const now = boot.createdAt;
  const rootId = createId();
  orm(boot.db)
    .insert(tables.document_nodes)
    .values({
      id: rootId,
      project_id: boot.projectId,
      parent_node_id: null,
      node_role: "container",
      is_master: 1,
      title: opts.title,
      original_title: null,
      ordinal: 0,
      author_text: null,
      language: "lzh",
      period_text: null,
      date_text: null,
      description_md: null,
      source_reference: null,
      created_at: now,
      updated_at: now,
      archived_at: null,
    })
    .run();
  orm(boot.db)
    .insert(tables.core_project_settings)
    .values({
      project_id: boot.projectId,
      active_document_node_id: rootId,
      autosave_interval_ms: 3000,
      ai_data_policy_json: JSON.stringify({ storePrompts: false }),
      settings_json: JSON.stringify({}),
      lock_version: 1,
    })
    .run();
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

export function openProject(packagePath: string, options: { onlineCache?: boolean } = {}): ProjectRepo {
  return new ProjectRepo(openProjectDb(packagePath), options);
}

/** Build an account-scoped disposable cache while retaining the server's project identity. */
export function openOnlineCache(opts: { parentDir: string; title: string; projectId: string; tables: OnlineTableData }): ProjectRepo {
  const { handle } = createProject({ parentDir: opts.parentDir, title: opts.title, projectId: opts.projectId });
  try { handle.applyOnlineRows(opts.tables); return handle; }
  catch (error) { const path = handle.packagePath; handle.close(); rmSync(path, { recursive: true, force: true }); throw error; }
}

export function seedDemoProject(parentDir: string): ProjectRepo {
  const boot = bootstrapEmptyProject({
    title: "훈민정음 문헌 번역",
    parentDir,
    actorDisplayName: "로컬 사용자",
  });
  try {
    orm(boot.db).transaction(() => seedDemoContents(boot));
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
