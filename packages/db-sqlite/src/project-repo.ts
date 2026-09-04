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
import { checkpointAndZip, releaseLock } from "@munhae/project-format";
import { bootstrapEmptyProject, openProjectDb, type ProjectActors } from "./bootstrap.ts";
import { allRows, getRow, insertRow } from "./rows.ts";
import { seedDemoContents } from "./seed-demo.ts";
import { insertSourceLayer } from "./source-layer.ts";
import type { SqliteDb } from "./sqlite.ts";
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
import type {
  ConfirmTranslationInput,
  ContextPreview,
  ContextPreviewInput,
  CreateDocumentInput,
  DocumentGenre,
  DocumentKind,
  DocumentNodeRole,
  DocumentListItem,
  EditorView,
  GlossaryEntryView,
  HomeView,
  KnowledgeView,
  MergeBlocksInput,
  NodeContextView,
  PersonView,
  PlaceView,
  ProjectSummary,
  SaveTranslationDraftInput,
  SplitBlockInput,
  VersionUiState,
} from "./views.ts";

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
    this.checkpoint();
    checkpointAndZip(this.packagePath, destFile);
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
    const uncertainties = allRows<{
      id: string;
      statement_md: string;
      category: string;
      quote: string | null;
    }>(
      this.db,
      `SELECT u.id, uv.statement_md, u.category, ua.quote
       FROM uncertainties u
       JOIN uncertainty_versions uv ON uv.uncertainty_id = u.id
       LEFT JOIN uncertainty_anchors ua ON ua.uncertainty_version_id = uv.id
       WHERE u.project_id = ? AND u.state = 'open'
       GROUP BY u.id
       ORDER BY u.created_at`,
      this.projectId,
    ).map((u) => ({
      id: u.id,
      label: u.statement_md,
      category: u.category,
      locator: u.quote ?? "",
    }));

    const locators = allRows<{ id: string; locator: string }>(
      this.db,
      `SELECT u.id,
              COALESCE(
                (SELECT quote FROM uncertainty_anchors WHERE uncertainty_version_id = uv.id LIMIT 1),
                ''
              ) AS locator
       FROM uncertainties u
       JOIN uncertainty_versions uv ON uv.uncertainty_id = u.id
       WHERE u.project_id = ? AND u.state = 'open'`,
      this.projectId,
    );
    const locById = new Map(locators.map((r) => [r.id, r.locator]));
    for (const u of uncertainties) {
      const extra = locById.get(u.id);
      if (extra && !u.locator) u.locator = extra;
    }
    const homeLoc: Record<string, string> = {
      "U-01": "御製序 · A002",
      "U-02": "御製序 · A003",
      "U-03": "鄭麟趾 序",
    };
    for (const u of uncertainties) {
      const key = Object.keys(homeLoc).find((k) => u.label.startsWith(k));
      if (key) u.locator = homeLoc[key] ?? u.locator;
    }

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
        structural_kind: input.structuralKind,
        node_role: input.nodeRole,
        is_master: 0,
        title: input.title,
        original_title: input.originalTitle?.trim() || null,
        ordinal,
        genre: input.genre,
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
      structural_kind: DocumentKind;
      genre: DocumentGenre | null;
      author_person_id: string | null;
      language: string | null;
      period_text: string | null;
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
      state: EditorView["source"]["state"];
      content_text: string;
      source_text_id: string;
    }>(
      this.db,
      `SELECT v.id AS version_id, v.version_no, v.state, v.content_text, t.id AS source_text_id
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
      state: EditorView["punctuation"]["state"];
      punctuated_text: string;
      set_id: string;
    }>(
      this.db,
      `SELECT v.id AS version_id, v.version_no, v.state, v.punctuated_text, s.id AS set_id
       FROM punctuation_sets s
       JOIN punctuation_heads h ON h.punctuation_set_id = s.id
       JOIN punctuation_versions v ON v.id = h.current_version_id
       WHERE s.source_text_id = ?
       LIMIT 1`,
      source.source_text_id,
    );
    if (!punc) throw new MunhaeError("not_ready", "이 문서에는 표점안이 없습니다");

    const anchors = allRows<{
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
       JOIN translation_anchor_sets s ON s.id = a.anchor_set_id
       WHERE s.punctuation_version_id = ? AND s.document_node_id = ?
       ORDER BY a.ordinal`,
      punc.version_id,
      documentNodeId,
    );

    const translations = allRows<{
      id: string;
      stage: string;
      current_version_id: string;
      confirmed_version_id: string | null;
      lock_version: number;
    }>(
      this.db,
      `SELECT t.id, t.stage, h.current_version_id, h.confirmed_version_id, h.lock_version
       FROM document_translations t
       JOIN document_translation_heads h ON h.document_translation_id = t.id
       WHERE t.document_node_id = ? AND t.tombstoned_at IS NULL
       ORDER BY t.stage`,
      documentNodeId,
    );

    const candidates: EditorView["candidates"] = [];
    let activeStage = translations[0]?.stage ?? "literal";
    let lockVersion = translations[0]?.lock_version ?? 1;
    const literal = translations.find((t) => t.stage === "literal");
    if (literal) {
      activeStage = "literal";
      lockVersion = literal.lock_version;
    }

    for (const tr of translations) {
      const versions = allRows<TranslationVersionRow>(
        this.db,
        `SELECT id, version_no, state, validation_state, text_content, origin_kind, parent_version_id,
                source_text_version_id, punctuation_version_id, translation_anchor_set_id, translation_policy_version_id
         FROM document_translation_versions
         WHERE document_translation_id = ?
         ORDER BY version_no DESC`,
        tr.id,
      );
      for (const v of versions) {
        candidates.push({
          stage: tr.stage,
          candidateKey: tr.stage,
          versionId: v.id,
          versionNo: v.version_no,
          state: v.state,
          validationState: v.validation_state,
          textContent: v.text_content,
          originKind: v.origin_kind,
          isCurrent: v.id === tr.current_version_id,
          isConfirmed: v.id === tr.confirmed_version_id,
          blocks: loadBlocks(this.db, v.id),
        });
      }
    }

    const reflection = this.loadReflection(candidates.filter((c) => c.isCurrent).map((c) => c.versionId));
    const chat = this.loadChat(documentNodeId);

    return {
      project: this.summary(),
      document: {
        id: node.id,
        title: node.title,
        originalTitle: node.original_title,
        nodeRole: node.node_role,
        structuralKind: node.structural_kind,
        genre: node.genre,
        authorName: inherited.authorName,
        periodText: inherited.periodText,
        language: inherited.language,
        sourceReference: inherited.sourceReference,
      },
      source: {
        versionId: source.version_id,
        versionNo: source.version_no,
        state: source.state,
        contentText: source.content_text,
      },
      punctuation: {
        versionId: punc.version_id,
        versionNo: punc.version_no,
        state: punc.state,
        punctuatedText: punc.punctuated_text,
      },
      anchors: anchors.map((a) => ({
        anchorKey: a.anchor_key,
        ordinal: a.ordinal,
        boundaryKind: a.boundary_kind,
        punctuationFrom: a.punctuation_codepoint_from,
        punctuationTo: a.punctuation_codepoint_to,
        punctuatedQuote: a.punctuated_quote,
      })),
      candidates,
      activeStage,
      lockVersion,
      reflection,
      chat,
    };
  }

  saveTranslationDraft(input: SaveTranslationDraftInput): EditorView {
    this.writeTranslation(input.documentNodeId, input.stage, input.blocks, {
      expectedLockVersion: input.expectedLockVersion,
      originKind: "human",
      editKind: "save_draft",
    });
    return this.getEditor(input.documentNodeId);
  }

  confirmTranslation(input: ConfirmTranslationInput): EditorView {
    this.db.transaction(() => {
      const ctx = this.requireStage(input.documentNodeId, input.stage);
      const current = this.requireCurrentVersion(ctx.translationId);
      if (current.state === "confirmed") {
        throw new MunhaeError("already_confirmed", "이미 확정된 번역안입니다");
      }
      if (current.validation_state !== "valid") {
        throw new MunhaeError("needs_review", "재검토가 필요한 번역안은 확정할 수 없습니다");
      }
      this.db
        .prepare(`UPDATE document_translation_versions SET state = 'confirmed' WHERE id = ?`)
        .run(current.id);
      casUpdateHead(this.db, ctx.translationId, input.expectedLockVersion, {
        currentVersionId: current.id,
        confirmedVersionId: current.id,
      });
    })();
    return this.getEditor(input.documentNodeId);
  }

  reviseTranslation(documentNodeId: string, stage: string): EditorView {
    this.db.transaction(() => {
      const ctx = this.requireStage(documentNodeId, stage);
      const current = this.requireCurrentVersion(ctx.translationId);
      const blocks = loadBlocks(this.db, current.id);
      this.insertDraftFromBlocks(ctx, blocks, {
        expectedLock: ctx.lockVersion,
        originKind: "human",
        parentId: current.id,
        editKind: "revise",
      });
    })();
    return this.getEditor(documentNodeId);
  }

  mergeBlocks(input: MergeBlocksInput): EditorView {
    this.db.transaction(() => {
      const ctx = this.requireStage(input.documentNodeId, input.stage);
      const current = this.requireCurrentVersion(ctx.translationId);
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
        expectedLock: input.expectedLockVersion ?? ctx.lockVersion,
        originKind: "human",
        parentId: current.id,
        editKind: "merge_blocks",
      });
    })();
    return this.getEditor(input.documentNodeId);
  }

  splitBlock(input: SplitBlockInput): EditorView {
    this.db.transaction(() => {
      const ctx = this.requireStage(input.documentNodeId, input.stage);
      const current = this.requireCurrentVersion(ctx.translationId);
      const blocks = loadBlocks(this.db, current.id);
      const idx = blocks.findIndex((b) => b.blockKey === input.blockKey);
      const target = blocks[idx];
      if (!target) throw new MunhaeError("invalid_blocks", "나눌 블록을 찾을 수 없습니다");
      const len = codepointCount(target.translation);
      if (input.splitAt <= 0 || input.splitAt >= len) {
        throw new MunhaeError("invalid_split", "나눌 위치가 블록 범위 밖입니다");
      }
      const leftText = sliceCodepoints(target.translation, 0, input.splitAt).trim();
      const rightText = sliceCodepoints(target.translation, input.splitAt, len).trim();
      const uniqueAnchors = uniqueKeep(target.sourceAnchorIds);
      let left: BlockDraft;
      let right: BlockDraft;
      if (uniqueAnchors.length <= 1) {
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
        const mid = Math.max(1, Math.floor(uniqueAnchors.length / 2));
        left = {
          blockKey: `${target.blockKey}a`,
          blockKind: target.blockKind,
          translation: leftText,
          sourceAnchorIds: uniqueAnchors.slice(0, mid),
        };
        right = {
          blockKey: `${target.blockKey}b`,
          blockKind: target.blockKind,
          translation: rightText,
          sourceAnchorIds: uniqueAnchors.slice(mid),
        };
      }
      const next = [...blocks.slice(0, idx), left, right, ...blocks.slice(idx + 1)];
      this.insertDraftFromBlocks(ctx, next, {
        expectedLock: input.expectedLockVersion ?? ctx.lockVersion,
        originKind: "human",
        parentId: current.id,
        editKind: "split_block",
      });
    })();
    return this.getEditor(input.documentNodeId);
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
    }>(
      this.db,
      `SELECT id, source_term, target_term, target_locale, term_kind, reading, note_md, usage_status
       FROM glossary_entries WHERE project_id = ? AND archived_at IS NULL
       ORDER BY source_term, usage_status`,
      this.projectId,
    ).map((g) => ({
      id: g.id,
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
    }>(
      this.db,
      `SELECT id, preferred_name, hanja_name, reading, aliases_json, description_md, date_text
       FROM persons WHERE project_id = ? AND archived_at IS NULL ORDER BY preferred_name`,
      this.projectId,
    ).map((p) => ({
      id: p.id,
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
    }>(
      this.db,
      `SELECT id, preferred_name, hanja_name, reading, aliases_json, place_kind, location_note_md, description_md
       FROM places WHERE project_id = ? AND archived_at IS NULL ORDER BY preferred_name`,
      this.projectId,
    ).map((p) => ({
      id: p.id,
      preferredName: p.preferred_name,
      hanjaName: p.hanja_name,
      reading: p.reading,
      aliases: JSON.parse(p.aliases_json) as string[],
      placeKind: p.place_kind,
      locationNoteMd: p.location_note_md,
      descriptionMd: p.description_md,
    }));

    const uncertainties = allRows<{
      id: string;
      category: "textual" | "interpretive" | "identification";
      severity: string;
      blocking: number;
      state: string;
      statement_md: string;
      quote: string | null;
    }>(
      this.db,
      `SELECT u.id, u.category, u.severity, u.blocking, u.state, uv.statement_md,
              (SELECT quote FROM uncertainty_anchors WHERE uncertainty_version_id = uv.id LIMIT 1) AS quote
       FROM uncertainties u
       JOIN uncertainty_versions uv ON uv.uncertainty_id = u.id
       WHERE u.project_id = ?
       ORDER BY u.created_at`,
      this.projectId,
    ).map((u) => ({
      id: u.id,
      category: u.category,
      severity: u.severity,
      blocking: u.blocking === 1,
      state: u.state,
      statementMd: u.statement_md,
      locator: u.quote ?? "",
    }));

    const contextItems: NodeContextView[] = allRows<{
      id: string;
      item_kind: string;
      scope_id: string;
      title: string;
      content_md: string;
      priority: number;
      enabled: number;
      updated_at: string;
    }>(
      this.db,
      `SELECT id, item_kind, scope_id, title, content_md, priority, enabled, updated_at
       FROM context_items
       WHERE project_id = ? AND archived_at IS NULL
         AND scope_kind = 'document_node' AND scope_id IS NOT NULL`,
      this.projectId,
    ).map((item) => ({
      id: item.id,
      source: "context_item",
      itemKind: item.item_kind,
      scopeKind: "document_node",
      scopeId: item.scope_id,
      title: item.title,
      contentMd: item.content_md,
      priority: item.priority,
      enabled: item.enabled === 1,
      updatedAt: item.updated_at,
    }));
    const descriptions = allRows<{
      id: string;
      title: string;
      original_title: string | null;
      description_md: string;
      updated_at: string;
    }>(
      this.db,
      `SELECT id, title, original_title, description_md, updated_at
       FROM document_nodes
       WHERE project_id = ? AND archived_at IS NULL AND trim(COALESCE(description_md, '')) <> ''`,
      this.projectId,
    ).map<NodeContextView>((node) => ({
      id: `document:${node.id}:description`,
      source: "document_description",
      itemKind: "document_description",
      scopeKind: "document_node",
      scopeId: node.id,
      title: `문서 설명 · ${node.original_title || node.title}`,
      contentMd: node.description_md,
      priority: 0,
      enabled: true,
      updatedAt: node.updated_at,
    }));

    contextItems.push(...descriptions);
    contextItems.sort((a, b) => b.priority - a.priority || a.updatedAt.localeCompare(b.updatedAt));

    return { glossary, persons, places, uncertainties, contextItems };
  }

  upsertGlossary(entry: Omit<GlossaryEntryView, "id"> & { id?: string }): GlossaryEntryView {
    const now = nowIso();
    const id = entry.id ?? createId();
    const existing = entry.id
      ? getRow<{ id: string; lock_version: number }>(
          this.db,
          `SELECT id, lock_version FROM glossary_entries WHERE id = ?`,
          entry.id,
        )
      : undefined;
    const hash = sha256Hex(`${entry.sourceTerm}|${entry.targetTerm}|${entry.usageStatus}|${entry.termKind}`);
    if (existing) {
      this.db
        .prepare(
          `UPDATE glossary_entries SET source_term=@sourceTerm, target_term=@targetTerm, target_locale=@targetLocale,
           term_kind=@termKind, reading=@reading, note_md=@noteMd, usage_status=@usageStatus,
           content_hash=@hash, lock_version=lock_version+1, updated_by_actor_id=@actor, updated_at=@now
           WHERE id=@id`,
        )
        .run({
          id: existing.id,
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
    const row = this.getKnowledge().glossary.find((g) => g.id === id || (g.sourceTerm === entry.sourceTerm && g.targetTerm === entry.targetTerm));
    if (!row) throw new MunhaeError("internal", "glossary upsert failed");
    return row;
  }

  upsertPerson(person: Omit<PersonView, "id"> & { id?: string }): PersonView {
    const now = nowIso();
    const id = person.id ?? createId();
    const hash = sha256Hex(`${person.preferredName}|${person.hanjaName ?? ""}`);
    const existing = person.id
      ? getRow<{ id: string }>(this.db, `SELECT id FROM persons WHERE id = ?`, person.id)
      : undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE persons SET preferred_name=@preferredName, hanja_name=@hanjaName, reading=@reading,
           aliases_json=@aliases, description_md=@descriptionMd, date_text=@dateText,
           content_hash=@hash, lock_version=lock_version+1, updated_by_actor_id=@actor, updated_at=@now
           WHERE id=@id`,
        )
        .run({
          id,
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

  upsertPlace(place: Omit<PlaceView, "id"> & { id?: string }): PlaceView {
    const now = nowIso();
    const id = place.id ?? createId();
    const hash = sha256Hex(`${place.preferredName}|${place.hanjaName ?? ""}`);
    const existing = place.id
      ? getRow<{ id: string }>(this.db, `SELECT id FROM places WHERE id = ?`, place.id)
      : undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE places SET preferred_name=@preferredName, hanja_name=@hanjaName, reading=@reading,
           aliases_json=@aliases, place_kind=@placeKind, location_note_md=@locationNoteMd,
           description_md=@descriptionMd, content_hash=@hash, lock_version=lock_version+1,
           updated_by_actor_id=@actor, updated_at=@now
           WHERE id=@id`,
        )
        .run({
          id,
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

  previewContext(input: ContextPreviewInput): ContextPreview {
    const { documentNodeId, recipe } = input;
    const editor = this.getEditor(documentNodeId);
    const policy = getRow<{
      id: string;
      version_no: number;
      content_hash: string;
      style_guide_md: string | null;
      hanja_policy: string | null;
    }>(
      this.db,
      `SELECT v.id, v.version_no, v.content_hash, v.style_guide_md, v.hanja_policy
       FROM core_translation_policy_versions v WHERE v.id = ?`,
      this.policyVersionId,
    );
    const punctuated = editor.punctuation.punctuatedText;
    const anchorSet = getRow<{ id: string; anchor_set_hash: string }>(
      this.db,
      `SELECT id, anchor_set_hash FROM translation_anchor_sets
       WHERE document_node_id = ? AND punctuation_version_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      documentNodeId,
      editor.punctuation.versionId,
    );
    if (!anchorSet) throw new MunhaeError("not_ready", "이 표점안에는 번역 앵커가 없습니다");
    const anchorManifest = canonicalJson({
      anchorSetId: anchorSet.id,
      anchors: editor.anchors.map((a) => ({
        anchorKey: a.anchorKey,
        ordinal: a.ordinal,
        boundaryKind: a.boundaryKind,
        from: a.punctuationFrom,
        to: a.punctuationTo,
      })),
    });
    const policyText = [policy?.hanja_policy, policy?.style_guide_md].filter(Boolean).join("\n");
    const candidateStages = recipe === "three_step" ? ["shin", "dal", "a"] : ["literal", "reader"];
    const outputContract = canonicalJson({
      name: "translation-envelope.v1",
      schemaVersion: 1,
      anchorSetId: anchorSet.id,
      requiredCandidateStages: candidateStages,
      responseShape: {
        schemaVersion: 1,
        anchorSetId: "string",
        candidates: [{ candidateKey: "string", stage: "string", blocks: [{ blockKey: "string", sourceAnchorIds: ["string"], blockKind: "string", translation: "string" }] }],
        reflection: { summary: "string", findings: [] },
      },
    });
    const required = [
      {
        kind: "punctuated_source",
        label: "표점 원문",
        version: editor.punctuation.versionId,
        hash: sha256Hex(punctuated),
        chars: codepointCount(punctuated),
      },
      {
        kind: "anchor_manifest",
        label: "번역 앵커",
        hash: sha256Hex(anchorManifest),
        chars: codepointCount(anchorManifest),
      },
      {
        kind: "translation_policy",
        label: "번역 원칙",
        version: policy?.id,
        hash: policy?.content_hash,
        chars: codepointCount(policyText),
      },
      {
        kind: "output_contract",
        label: `응답 형식 · ${recipe === "three_step" ? "信·達·雅" : "직역안·독자안"}`,
        version: "translation-envelope.v1",
        hash: sha256Hex(outputContract),
        chars: codepointCount(outputContract),
      },
    ];

    const knowledge = this.getKnowledge();
    const source = editor.source.contentText;
    type AuxCandidate = ContextPreview["auxiliary"][number] & { content: string };
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
      structuralKind: editor.document.structuralKind,
      genre: editor.document.genre,
      authorName: editor.document.authorName,
      periodText: editor.document.periodText,
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
      const content = canonicalJson(g);
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
      const content = canonicalJson(p);
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
      const content = canonicalJson(p);
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
      allRows<{ id: string }>(
        this.db,
        `SELECT DISTINCT u.id
         FROM uncertainties u
         JOIN uncertainty_versions uv ON uv.uncertainty_id = u.id
         JOIN uncertainty_anchors ua ON ua.uncertainty_version_id = uv.id
         LEFT JOIN translation_anchors a
           ON ua.target_kind = 'translation_anchor' AND a.id = ua.target_version_id
         LEFT JOIN translation_anchor_sets s ON s.id = a.anchor_set_id
         WHERE u.project_id = ? AND u.state = 'open'
           AND ((ua.target_kind = 'document_node' AND ua.target_version_id = ?)
             OR (ua.target_kind = 'translation_anchor' AND s.document_node_id = ?))`,
        this.projectId,
        documentNodeId,
        documentNodeId,
      ).map((row) => row.id),
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

    const parts = [punctuated, anchorManifest, policyText, outputContract, ...auxiliary.filter((a) => a.included).map((a) => a.content)];
    const assembled = parts.join("\n\n");
    const manifest = {
      schemaVersion: 1,
      taskKind: "translation",
      recipe,
      anchorSetId: anchorSet.id,
      sources: [
        ...required.map((r, i) => ({
          ordinal: i + 1,
          kind: r.kind,
          hash: r.hash,
          versionId: r.version,
          reason: "required",
        })),
        ...auxiliary.filter((a) => a.included).map((a, i) => ({
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
      characterCount: codepointCount(assembled),
      utf8ByteCount: utf8ByteLength(assembled),
      manifestHash: sha256Hex(manifestJson),
      required,
      auxiliary: auxiliary.map(({ content: _content, ...item }) => item),
      status: "ready",
      manifestJson,
    };
  }

  private writeTranslation(
    documentNodeId: string,
    stage: string,
    blocks: BlockDraft[],
    opts: { expectedLockVersion?: number; originKind: string; editKind: string },
  ): void {
    this.db.transaction(() => {
      const ctx = this.requireStage(documentNodeId, stage);
      const current = this.requireCurrentVersion(ctx.translationId);
      this.insertDraftFromBlocks(ctx, blocks, {
        expectedLock: opts.expectedLockVersion ?? ctx.lockVersion,
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
    opts: { expectedLock: number; originKind: string; parentId: string; editKind: string },
  ): void {
    const parent = this.requireCurrentVersion(ctx.translationId);
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
      workflow_execution_id: null,
      generated_by_message_id: null,
      generation_candidate_key: null,
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

  private requireStage(documentNodeId: string, stage: string): StageCtx {
    const row = getRow<{
      translation_id: string;
      lock_version: number;
      current_version_id: string;
      source_text_version_id: string;
      punctuation_version_id: string;
      translation_anchor_set_id: string;
      translation_policy_version_id: string;
    }>(
      this.db,
      `SELECT t.id AS translation_id, h.lock_version, h.current_version_id,
              v.source_text_version_id, v.punctuation_version_id, v.translation_anchor_set_id,
              v.translation_policy_version_id
       FROM document_translations t
       JOIN document_translation_heads h ON h.document_translation_id = t.id
       JOIN document_translation_versions v ON v.id = h.current_version_id
       WHERE t.document_node_id = ? AND t.stage = ? AND t.tombstoned_at IS NULL`,
      documentNodeId,
      stage,
    );
    if (!row) throw new MunhaeError("not_found", `translation stage ${stage} not found`);
    return {
      translationId: row.translation_id,
      lockVersion: row.lock_version,
      sourceVersionId: row.source_text_version_id,
      puncVersionId: row.punctuation_version_id,
      anchorSetId: row.translation_anchor_set_id,
      policyVersionId: row.translation_policy_version_id,
    };
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
      structural_kind: DocumentKind;
      genre: DocumentGenre | null;
      title: string;
      original_title: string | null;
      ordinal: number;
    }>(
      this.db,
      `SELECT id, parent_node_id, node_role, is_master, structural_kind, genre, title, original_title, ordinal
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

    const uncCounts = new Map<string, number>();
    const uncRows = allRows<{ node_id: string; n: number }>(
      this.db,
      `SELECT s.document_node_id AS node_id, COUNT(DISTINCT u.id) AS n
       FROM uncertainties u
       JOIN uncertainty_versions uv ON uv.uncertainty_id = u.id
       JOIN uncertainty_anchors ua ON ua.uncertainty_version_id = uv.id
       JOIN translation_anchors a ON a.id = ua.target_version_id
       JOIN translation_anchor_sets s ON s.id = a.anchor_set_id
       WHERE u.project_id = ? AND u.state = 'open' AND ua.target_kind = 'translation_anchor'
       GROUP BY s.document_node_id`,
      this.projectId,
    );
    for (const r of uncRows) uncCounts.set(r.node_id, r.n);
    const uncNodeRows = allRows<{ node_id: string; n: number }>(
      this.db,
      `SELECT ua.target_version_id AS node_id, COUNT(DISTINCT u.id) AS n
       FROM uncertainties u
       JOIN uncertainty_versions uv ON uv.uncertainty_id = u.id
       JOIN uncertainty_anchors ua ON ua.uncertainty_version_id = uv.id
       WHERE u.project_id = ? AND u.state = 'open' AND ua.target_kind = 'document_node'
       GROUP BY ua.target_version_id`,
      this.projectId,
    );
    for (const r of uncNodeRows) uncCounts.set(r.node_id, (uncCounts.get(r.node_id) ?? 0) + r.n);

    return ordered.map((n) => ({
      id: n.id,
      parentId: n.parent_node_id,
      depth: n.depth,
      nodeRole: n.node_role,
      isMaster: n.is_master === 1,
      structuralKind: n.structural_kind,
      genre: n.genre,
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
    const row = getRow<{ state: string; confirmed: string | null }>(
      this.db,
      `SELECT v.state, h.confirmed_version_id AS confirmed
       FROM src_texts t
       JOIN src_text_heads h ON h.source_text_id = t.id
       JOIN src_text_versions v ON v.id = h.current_version_id
       WHERE t.document_node_id = ? LIMIT 1`,
      nodeId,
    );
    if (!row) return "none";
    if (row.confirmed) return "confirmed";
    if (row.state === "draft") return "draft";
    return "draft";
  }

  private puncUi(nodeId: string): VersionUiState {
    const row = getRow<{ state: string; confirmed: string | null }>(
      this.db,
      `SELECT v.state, h.confirmed_version_id AS confirmed
       FROM src_texts t
       JOIN punctuation_sets s ON s.source_text_id = t.id
       JOIN punctuation_heads h ON h.punctuation_set_id = s.id
       JOIN punctuation_versions v ON v.id = h.current_version_id
       WHERE t.document_node_id = ? LIMIT 1`,
      nodeId,
    );
    if (!row) return "none";
    if (row.confirmed) return "confirmed";
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

  private loadReflection(versionIds: string[]): EditorView["reflection"] {
    if (!versionIds.length) return null;
    const placeholders = versionIds.map(() => "?").join(",");
    const report = getRow<{ id: string; summary_md: string }>(
      this.db,
      `SELECT r.id, r.summary_md
       FROM reflection_reports r
       JOIN reflection_report_translation_versions l ON l.report_id = r.id
       WHERE l.document_translation_version_id IN (${placeholders})
       ORDER BY r.created_at DESC
       LIMIT 1`,
      ...versionIds,
    );
    if (!report) return null;
    const findings = allRows<{
      finding_kind: string;
      severity: string;
      explanation_md: string;
      document_translation_version_id: string | null;
      id: string;
    }>(
      this.db,
      `SELECT id, finding_kind, severity, explanation_md, document_translation_version_id
       FROM reflection_findings WHERE report_id = ?`,
      report.id,
    );
    return {
      summary: report.summary_md,
      findings: findings.map((f) => {
        const keys = allRows<{ anchor_key: string }>(
          this.db,
          `SELECT a.anchor_key FROM reflection_finding_anchors rfa
           JOIN translation_anchors a ON a.id = rfa.translation_anchor_id
           WHERE rfa.finding_id = ? ORDER BY rfa.ordinal`,
          f.id,
        ).map((r) => r.anchor_key);
        let candidateKey: string | null = null;
        if (f.document_translation_version_id) {
          const st = getRow<{ stage: string }>(
            this.db,
            `SELECT t.stage FROM document_translation_versions v
             JOIN document_translations t ON t.id = v.document_translation_id
             WHERE v.id = ?`,
            f.document_translation_version_id,
          );
          candidateKey = st?.stage ?? null;
        }
        return {
          findingKind: f.finding_kind,
          severity: f.severity,
          message: f.explanation_md,
          sourceAnchorIds: keys,
          candidateKey,
        };
      }),
    };
  }

  private loadChat(documentNodeId: string): EditorView["chat"] {
    return allRows<{ role: "user" | "assistant"; text: string; created_at: string; agent_id: string | null }>(
      this.db,
      `SELECT m.role, COALESCE(p.text_content, '') AS text, m.created_at, m.agent_id
       FROM chat_threads t
       JOIN chat_messages m ON m.thread_id = t.id
       LEFT JOIN chat_message_parts p ON p.message_id = m.id AND p.ordinal = 1
       WHERE t.project_id = ? AND t.scope_id = ?
       ORDER BY m.created_at`,
      this.projectId,
      documentNodeId,
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
  sourceVersionId: string;
  puncVersionId: string;
  anchorSetId: string;
  policyVersionId: string;
};

function uniqueKeep(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
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
    structural_kind: "collection",
    node_role: "container",
    is_master: 1,
    title: opts.title,
    original_title: null,
    ordinal: 0,
    genre: null,
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
  return join(packagePath, "project.sqlite3");
}
