import {
  canonicalJson,
  createId,
  MunhaeError,
  nowIso,
  sha256Hex,
  sliceCodepoints,
} from "@munhae/domain";
import { contextItemContentHash, materialOriginFromJson } from "./knowledge-content.ts";
import type { ProjectActors } from "./bootstrap.ts";
import { allRows, getRow, insertRow } from "./rows.ts";
import type { SqliteDb } from "./sqlite.ts";
import type {
  ContextItemCasInput,
  CreateContextItemInput,
  CreateUncertaintyInput,
  CreateUncertaintyVersionInput,
  DocumentMetadataView,
  NodeContextView,
  ResolveUncertaintyInput,
  SetContextItemEnabledInput,
  SetContextItemPriorityInput,
  UncertaintyAnchorInput,
  UncertaintyView,
  UpdateContextItemInput,
  UpdateDocumentMetadataInput,
} from "./views.ts";

type MutableKnowledgeContext = {
  db: SqliteDb;
  projectId: string;
  actors: ProjectActors;
};

function nullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function requireActiveNode(db: SqliteDb, projectId: string, nodeId: string): void {
  const node = getRow<{ id: string }>(
    db,
    `SELECT id FROM document_nodes WHERE id = ? AND project_id = ? AND archived_at IS NULL`,
    nodeId,
    projectId,
  );
  if (!node) throw new MunhaeError("not_found", "문서 node를 찾을 수 없습니다");
}

export function getDocumentMetadata(
  db: SqliteDb,
  projectId: string,
  documentNodeId: string,
): DocumentMetadataView {
  const row = getRow<{
    id: string;
    parent_node_id: string | null;
    node_role: DocumentMetadataView["nodeRole"];
    is_master: number;
    title: string;
    original_title: string | null;
    author_name: string | null;
    language: string | null;
    period_text: string | null;
    date_text: string | null;
    description_md: string | null;
    source_reference: string | null;
    lock_version: number;
    updated_at: string;
  }>(
    db,
    `SELECT node.id, node.parent_node_id, node.node_role, node.is_master,
            node.title, node.original_title,
            node.author_text AS author_name,
            node.language, node.period_text, node.date_text, node.description_md,
            node.source_reference, node.lock_version, node.updated_at
     FROM document_nodes node
     WHERE node.id = ? AND node.project_id = ? AND node.archived_at IS NULL`,
    documentNodeId,
    projectId,
  );
  if (!row) throw new MunhaeError("not_found", "문서 node를 찾을 수 없습니다");
  return {
    id: row.id,
    parentId: row.parent_node_id,
    nodeRole: row.node_role,
    isMaster: row.is_master === 1,
    title: row.title,
    originalTitle: row.original_title,
    authorName: row.author_name,
    language: row.language,
    periodText: row.period_text,
    dateText: row.date_text,
    descriptionMd: row.description_md,
    sourceReference: row.source_reference,
    lockVersion: row.lock_version,
    updatedAt: row.updated_at,
  };
}

export function updateDocumentMetadata(
  context: MutableKnowledgeContext,
  input: UpdateDocumentMetadataInput,
): DocumentMetadataView {
  const { db, projectId } = context;
  return db.transaction(() => {
    if (!input.title.trim()) throw new MunhaeError("invalid_input", "문서 제목이 필요합니다");
    const current = getDocumentMetadata(db, projectId, input.documentNodeId);
    if (current.isMaster && input.title.trim() !== current.title) {
      throw new MunhaeError("immutable_master", "프로젝트 마스터 제목은 프로젝트 설정에서만 바꿀 수 있습니다");
    }
    const info = db.prepare(
      `UPDATE document_nodes
       SET title = @title, original_title = @originalTitle,
           author_text = @authorName, language = @language,
           period_text = @periodText, date_text = @dateText,
           description_md = @descriptionMd, source_reference = @sourceReference,
           lock_version = lock_version + 1, updated_at = @now
       WHERE id = @id AND project_id = @projectId AND archived_at IS NULL
         AND lock_version = @expectedLockVersion`,
    ).run({
      id: input.documentNodeId,
      projectId,
      title: input.title.trim(),
      originalTitle: nullable(input.originalTitle),
      authorName: nullable(input.authorName),
      language: nullable(input.language),
      periodText: nullable(input.periodText),
      dateText: nullable(input.dateText),
      descriptionMd: nullable(input.descriptionMd),
      sourceReference: nullable(input.sourceReference),
      expectedLockVersion: input.expectedLockVersion,
      now: nowIso(),
    });
    if (info.changes !== 1) throw new MunhaeError("cas_conflict", "문서 정보가 다른 창에서 변경되었습니다");
    return getDocumentMetadata(db, projectId, input.documentNodeId);
  })();
}

function validateContextInput(input: CreateContextItemInput): void {
  if (!input.title.trim() || !input.contentMd.trim()) {
    throw new MunhaeError("invalid_input", "문맥 카드의 제목·내용이 필요합니다");
  }
  if (!Number.isInteger(input.priority) || Math.abs(input.priority) > 1_000_000) {
    throw new MunhaeError("invalid_input", "문맥 카드 우선순위가 올바르지 않습니다");
  }
  if (input.inheritToChildren !== undefined && typeof input.inheritToChildren !== "boolean")
    throw new MunhaeError("invalid_input", "하위 문서 적용 여부가 올바르지 않습니다");
  if (input.conditionMd !== undefined && (typeof input.conditionMd !== "string" || input.conditionMd.length > 20_000))
    throw new MunhaeError("invalid_input", "적용 조건이 올바르지 않습니다");
}

export function loadContextItem(db: SqliteDb, projectId: string, id: string): NodeContextView {
  const row = getRow<{
    id: string;
    scope_id: string;
    title: string;
    content_md: string;
    priority: number;
    enabled: number;
    lock_version: number;
    updated_at: string;
    inherit_to_children: number;
    condition_md: string;
    origin_json: string | null;
  }>(
    db,
    `SELECT item.id, scope_id, title, content_md, priority, enabled,
            lock_version, updated_at, inherit_to_children, condition_md, artifact.payload_json AS origin_json
     FROM context_items item LEFT JOIN provenance_artifacts artifact ON artifact.id = item.origin_artifact_id
     WHERE item.id = ? AND item.project_id = ? AND item.archived_at IS NULL
       AND scope_kind = 'document_node'`,
    id,
    projectId,
  );
  if (!row) throw new MunhaeError("not_found", "문맥 카드를 찾을 수 없습니다");
  return {
    id: row.id,
    source: "context_item",
    scopeKind: "document_node",
    scopeId: row.scope_id,
    title: row.title,
    contentMd: row.content_md,
    priority: row.priority,
    enabled: row.enabled === 1,
    lockVersion: row.lock_version,
    updatedAt: row.updated_at,
    inheritToChildren: row.inherit_to_children === 1,
    conditionMd: row.condition_md,
    origin: materialOriginFromJson(row.origin_json),
  };
}

export function createContextItem(
  context: MutableKnowledgeContext,
  input: CreateContextItemInput,
): NodeContextView {
  const { db, projectId } = context;
  return db.transaction(() => {
    validateContextInput(input);
    requireActiveNode(db, projectId, input.scopeId);
    const id = createId();
    const now = nowIso();
    insertRow(db, "context_items", {
      id,
      project_id: projectId,
      scope_kind: "document_node",
      scope_id: input.scopeId,
      title: input.title.trim(),
      content_md: input.contentMd,
      priority: input.priority,
      enabled: input.enabled ? 1 : 0,
      inherit_to_children: input.inheritToChildren === false ? 0 : 1,
      condition_md: input.conditionMd?.trim() ?? "",
      content_hash: contextItemContentHash(input),
      lock_version: 1,
      created_at: now,
      updated_at: now,
      archived_at: null,
    });
    return loadContextItem(db, projectId, id);
  })();
}

function requireContextCas(
  db: SqliteDb,
  projectId: string,
  input: ContextItemCasInput,
): NodeContextView {
  const current = loadContextItem(db, projectId, input.id);
  if (current.lockVersion !== input.expectedLockVersion) {
    throw new MunhaeError("cas_conflict", "문맥 카드가 다른 창에서 변경되었습니다");
  }
  return current;
}

export function updateContextItem(
  context: MutableKnowledgeContext,
  input: UpdateContextItemInput,
): NodeContextView {
  const { db, projectId } = context;
  return db.transaction(() => {
    validateContextInput(input);
    const current = requireContextCas(db, projectId, input);
    input = { ...input, inheritToChildren: input.inheritToChildren ?? current.inheritToChildren ?? true,
      conditionMd: input.conditionMd ?? current.conditionMd ?? "" };
    requireActiveNode(db, projectId, input.scopeId);
    const info = db.prepare(
      `UPDATE context_items
       SET scope_id = @scopeId, title = @title,
           content_md = @contentMd, priority = @priority, enabled = @enabled,
           inherit_to_children = @inheritToChildren, condition_md = @conditionMd,
           content_hash = @hash, lock_version = lock_version + 1, updated_at = @now
       WHERE id = @id AND project_id = @projectId AND archived_at IS NULL
         AND lock_version = @expectedLockVersion`,
    ).run({
      id: input.id,
      projectId,
      scopeId: input.scopeId,
      title: input.title.trim(),
      contentMd: input.contentMd,
      priority: input.priority,
      enabled: input.enabled ? 1 : 0,
      inheritToChildren: input.inheritToChildren === false ? 0 : 1,
      conditionMd: input.conditionMd?.trim() ?? "",
      hash: contextItemContentHash(input),
      expectedLockVersion: input.expectedLockVersion,
      now: nowIso(),
    });
    if (info.changes !== 1) throw new MunhaeError("cas_conflict", "문맥 카드가 다른 창에서 변경되었습니다");
    return loadContextItem(db, projectId, input.id);
  })();
}

export function setContextItemEnabled(
  context: MutableKnowledgeContext,
  input: SetContextItemEnabledInput,
): NodeContextView {
  const current = requireContextCas(context.db, context.projectId, input);
  return updateContextItem(context, {
    ...current,
    expectedLockVersion: input.expectedLockVersion,
    enabled: input.enabled,
  });
}

export function setContextItemPriority(
  context: MutableKnowledgeContext,
  input: SetContextItemPriorityInput,
): NodeContextView {
  const current = requireContextCas(context.db, context.projectId, input);
  return updateContextItem(context, {
    ...current,
    expectedLockVersion: input.expectedLockVersion,
    priority: input.priority,
  });
}

export function archiveContextItem(context: MutableKnowledgeContext, input: ContextItemCasInput): void {
  const { db, projectId } = context;
  db.transaction(() => {
    const current = requireContextCas(db, projectId, input);
    const now = nowIso();
    const info = db.prepare(
      `UPDATE context_items
       SET archived_at = ?, enabled = 0, content_hash = ?,
           lock_version = lock_version + 1, updated_at = ?
       WHERE id = ? AND project_id = ? AND archived_at IS NULL AND lock_version = ?`,
    ).run(
      now,
      contextItemContentHash({
        scopeId: current.scopeId,
        title: current.title,
        contentMd: current.contentMd,
        priority: current.priority,
        enabled: false,
        inheritToChildren: current.inheritToChildren,
        conditionMd: current.conditionMd,
      }),
      now,
      input.id,
      projectId,
      input.expectedLockVersion,
    );
    if (info.changes !== 1) throw new MunhaeError("cas_conflict", "문맥 카드가 다른 창에서 변경되었습니다");
  })();
}

type TargetText = { text: string | null; canonicalQuote: string | null };

function loadAnchorTarget(
  db: SqliteDb,
  projectId: string,
  input: UncertaintyAnchorInput,
): TargetText {
  switch (input.targetKind) {
    case "document_node": {
      requireActiveNode(db, projectId, input.targetVersionId);
      return { text: null, canonicalQuote: null };
    }
    case "source_text_version": {
      const row = getRow<{ content_text: string }>(
        db,
        `SELECT content_text FROM src_text_versions WHERE id = ? AND project_id = ?`,
        input.targetVersionId,
        projectId,
      );
      if (!row) throw new MunhaeError("invalid_anchor", "원문 version을 찾을 수 없습니다");
      return { text: row.content_text, canonicalQuote: null };
    }
    case "punctuation_version": {
      const row = getRow<{ punctuated_text: string }>(
        db,
        `SELECT punctuated_text FROM punctuation_versions WHERE id = ? AND project_id = ?`,
        input.targetVersionId,
        projectId,
      );
      if (!row) throw new MunhaeError("invalid_anchor", "표점 version을 찾을 수 없습니다");
      return { text: row.punctuated_text, canonicalQuote: null };
    }
    case "translation_anchor": {
      const row = getRow<{ punctuated_quote: string }>(
        db,
        `SELECT punctuated_quote FROM translation_anchors WHERE id = ? AND project_id = ?`,
        input.targetVersionId,
        projectId,
      );
      if (!row) throw new MunhaeError("invalid_anchor", "번역 앵커를 찾을 수 없습니다");
      return { text: null, canonicalQuote: row.punctuated_quote };
    }
    case "document_translation": {
      const row = getRow<{ id: string }>(
        db,
        `SELECT id FROM document_translations WHERE id = ? AND project_id = ? AND tombstoned_at IS NULL`,
        input.targetVersionId,
        projectId,
      );
      if (!row) throw new MunhaeError("invalid_anchor", "번역 작업을 찾을 수 없습니다");
      return { text: null, canonicalQuote: null };
    }
    case "document_translation_version": {
      const row = getRow<{ text_content: string }>(
        db,
        `SELECT text_content FROM document_translation_versions WHERE id = ? AND project_id = ?`,
        input.targetVersionId,
        projectId,
      );
      if (!row) throw new MunhaeError("invalid_anchor", "번역 version을 찾을 수 없습니다");
      return { text: row.text_content, canonicalQuote: null };
    }
    default:
      throw new MunhaeError("invalid_anchor", "지원하지 않는 불확실성 앵커 종류입니다");
  }
}

function prepareUncertaintyAnchors(
  db: SqliteDb,
  projectId: string,
  anchors: UncertaintyAnchorInput[],
): Array<Required<Pick<UncertaintyAnchorInput, "targetKind" | "targetVersionId">> & {
  codepointFrom: number | null;
  codepointTo: number | null;
  quote: string | null;
}> {
  const seen = new Set<string>();
  return anchors.map((input) => {
    const target = loadAnchorTarget(db, projectId, input);
    const from = input.codepointFrom ?? null;
    const to = input.codepointTo ?? null;
    if ((from === null) !== (to === null) || (from !== null && (from < 0 || to! <= from))) {
      throw new MunhaeError("invalid_anchor", "불확실성 앵커의 code-point 범위가 올바르지 않습니다");
    }
    let quote = nullable(input.quote);
    if (from !== null) {
      if (target.text === null) {
        throw new MunhaeError("invalid_anchor", "범위 앵커는 텍스트 version을 가리켜야 합니다");
      }
      if (to! > Array.from(target.text).length) {
        throw new MunhaeError("invalid_anchor", "불확실성 앵커 범위가 대상 텍스트를 벗어났습니다");
      }
      const exact = sliceCodepoints(target.text, from, to!);
      if (!exact || (quote !== null && quote !== exact)) {
        throw new MunhaeError("invalid_anchor", "불확실성 앵커의 quote가 지정한 범위와 일치하지 않습니다");
      }
      quote = exact;
    } else if (quote === null && target.canonicalQuote) {
      quote = target.canonicalQuote;
    }
    const key = canonicalJson({ targetKind: input.targetKind, targetVersionId: input.targetVersionId, from, to });
    if (seen.has(key)) throw new MunhaeError("invalid_anchor", "같은 불확실성 앵커가 중복되었습니다");
    seen.add(key);
    return {
      targetKind: input.targetKind,
      targetVersionId: input.targetVersionId,
      codepointFrom: from,
      codepointTo: to,
      quote,
    };
  });
}

function insertUncertaintyVersion(
  context: MutableKnowledgeContext,
  uncertaintyId: string,
  parentVersionId: string | null,
  versionNo: number,
  input: CreateUncertaintyInput,
): string {
  if (!input.statementMd.trim() || !input.severity.trim() || input.anchors.length === 0) {
    throw new MunhaeError("invalid_input", "불확실성의 진술·심각도·대상 앵커가 필요합니다");
  }
  if (input.options.some((option) => !option.label.trim())) {
    throw new MunhaeError("invalid_input", "불확실성 선택지 label이 비어 있습니다");
  }
  const anchors = prepareUncertaintyAnchors(context.db, context.projectId, input.anchors);
  const versionId = createId();
  const content = {
    statementMd: input.statementMd.trim(),
    rationaleMd: nullable(input.rationaleMd),
    confidenceLabel: nullable(input.confidenceLabel),
    options: input.options.map((option, index) => ({
      label: option.label.trim(),
      interpretationMd: nullable(option.interpretationMd),
      ordinal: index + 1,
    })),
    anchors,
  };
  insertRow(context.db, "uncertainty_versions", {
    id: versionId,
    project_id: context.projectId,
    uncertainty_id: uncertaintyId,
    parent_version_id: parentVersionId,
    version_no: versionNo,
    statement_md: content.statementMd,
    rationale_md: content.rationaleMd,
    confidence_label: content.confidenceLabel,
    content_hash: sha256Hex(canonicalJson(content)),
    created_by_actor_id: context.actors.humanId,
    created_at: nowIso(),
  });
  content.options.forEach((option) => {
    insertRow(context.db, "uncertainty_options", {
      id: createId(),
      project_id: context.projectId,
      uncertainty_version_id: versionId,
      label: option.label,
      interpretation_md: option.interpretationMd,
      ordinal: option.ordinal,
    });
  });
  anchors.forEach((anchor) => {
    insertRow(context.db, "uncertainty_anchors", {
      id: createId(),
      project_id: context.projectId,
      uncertainty_version_id: versionId,
      target_kind: anchor.targetKind,
      target_version_id: anchor.targetVersionId,
      codepoint_from: anchor.codepointFrom,
      codepoint_to: anchor.codepointTo,
      quote: anchor.quote,
      quote_hash: anchor.quote === null ? null : sha256Hex(anchor.quote),
    });
  });
  return versionId;
}

export function createUncertainty(
  context: MutableKnowledgeContext,
  input: CreateUncertaintyInput,
): UncertaintyView {
  return context.db.transaction(() => {
    const uncertaintyId = createId();
    insertRow(context.db, "uncertainties", {
      id: uncertaintyId,
      project_id: context.projectId,
      category: input.category,
      severity: input.severity.trim(),
      blocking: input.blocking ? 1 : 0,
      state: "open",
      created_at: nowIso(),
    });
    insertUncertaintyVersion(context, uncertaintyId, null, 1, input);
    return loadUncertainty(context.db, context.projectId, uncertaintyId);
  })();
}

export function createUncertaintyVersion(
  context: MutableKnowledgeContext,
  input: CreateUncertaintyVersionInput,
): UncertaintyView {
  return context.db.transaction(() => {
    const current = getRow<{ version_id: string; version_no: number; state: string }>(
      context.db,
      `SELECT version.id AS version_id, version.version_no, uncertainty.state
       FROM uncertainties uncertainty
       JOIN uncertainty_versions version ON version.uncertainty_id = uncertainty.id
       WHERE uncertainty.id = ? AND uncertainty.project_id = ?
       ORDER BY version.version_no DESC LIMIT 1`,
      input.uncertaintyId,
      context.projectId,
    );
    if (!current) throw new MunhaeError("not_found", "불확실성을 찾을 수 없습니다");
    if (current.state !== "open") throw new MunhaeError("already_resolved", "해결된 불확실성은 수정할 수 없습니다");
    if (current.version_id !== input.expectedVersionId) {
      throw new MunhaeError("cas_conflict", "불확실성이 다른 창에서 변경되었습니다");
    }
    const updated = context.db.prepare(
      `UPDATE uncertainties SET category = ?, severity = ?, blocking = ?
       WHERE id = ? AND project_id = ? AND state = 'open'`,
    ).run(input.category, input.severity.trim(), input.blocking ? 1 : 0, input.uncertaintyId, context.projectId);
    if (updated.changes !== 1) throw new MunhaeError("cas_conflict", "불확실성이 다른 창에서 변경되었습니다");
    insertUncertaintyVersion(context, input.uncertaintyId, current.version_id, current.version_no + 1, input);
    return loadUncertainty(context.db, context.projectId, input.uncertaintyId);
  })();
}

export function resolveUncertainty(
  context: MutableKnowledgeContext,
  input: ResolveUncertaintyInput,
): UncertaintyView {
  return context.db.transaction(() => {
    const current = getRow<{ version_id: string; state: string }>(
      context.db,
      `SELECT version.id AS version_id, uncertainty.state
       FROM uncertainties uncertainty
       JOIN uncertainty_versions version ON version.uncertainty_id = uncertainty.id
       WHERE uncertainty.id = ? AND uncertainty.project_id = ?
       ORDER BY version.version_no DESC LIMIT 1`,
      input.uncertaintyId,
      context.projectId,
    );
    if (!current) throw new MunhaeError("not_found", "불확실성을 찾을 수 없습니다");
    if (current.version_id !== input.expectedVersionId) {
      throw new MunhaeError("cas_conflict", "불확실성이 다른 창에서 변경되었습니다");
    }
    if (current.state !== "open") throw new MunhaeError("already_resolved", "이미 해결된 불확실성입니다");
    const info = context.db.prepare(
      `UPDATE uncertainties SET state = 'resolved'
       WHERE id = ? AND project_id = ? AND state = 'open'`,
    ).run(input.uncertaintyId, context.projectId);
    if (info.changes !== 1) throw new MunhaeError("cas_conflict", "불확실성이 다른 창에서 변경되었습니다");
    return loadUncertainty(context.db, context.projectId, input.uncertaintyId);
  })();
}

function loadUncertainty(db: SqliteDb, projectId: string, uncertaintyId: string): UncertaintyView {
  const row = getRow<{
    id: string;
    version_id: string;
    version_no: number;
    category: UncertaintyView["category"];
    severity: string;
    blocking: number;
    state: UncertaintyView["state"];
    statement_md: string;
    rationale_md: string | null;
    confidence_label: string | null;
  }>(
    db,
    `SELECT uncertainty.id, version.id AS version_id, version.version_no,
            uncertainty.category, uncertainty.severity, uncertainty.blocking,
            uncertainty.state, version.statement_md, version.rationale_md,
            version.confidence_label
     FROM uncertainties uncertainty
     JOIN uncertainty_versions version ON version.uncertainty_id = uncertainty.id
     WHERE uncertainty.id = ? AND uncertainty.project_id = ?
     ORDER BY version.version_no DESC LIMIT 1`,
    uncertaintyId,
    projectId,
  );
  if (!row) throw new MunhaeError("not_found", "불확실성을 찾을 수 없습니다");
  const options = allRows<{
    id: string;
    label: string;
    interpretation_md: string | null;
    ordinal: number;
  }>(
    db,
    `SELECT id, label, interpretation_md, ordinal FROM uncertainty_options
     WHERE uncertainty_version_id = ? AND project_id = ? ORDER BY ordinal`,
    row.version_id,
    projectId,
  ).map((option) => ({
    id: option.id,
    label: option.label,
    interpretationMd: option.interpretation_md,
    ordinal: option.ordinal,
  }));
  const anchors = allRows<{
    id: string;
    target_kind: UncertaintyView["anchors"][number]["targetKind"];
    target_version_id: string;
    codepoint_from: number | null;
    codepoint_to: number | null;
    quote: string | null;
  }>(
    db,
    `SELECT id, target_kind, target_version_id, codepoint_from, codepoint_to, quote
     FROM uncertainty_anchors WHERE uncertainty_version_id = ? AND project_id = ?
     ORDER BY rowid`,
    row.version_id,
    projectId,
  ).map((anchor) => ({
    id: anchor.id,
    targetKind: anchor.target_kind,
    targetVersionId: anchor.target_version_id,
    codepointFrom: anchor.codepoint_from,
    codepointTo: anchor.codepoint_to,
    quote: anchor.quote,
  }));
  return {
    id: row.id,
    versionId: row.version_id,
    versionNo: row.version_no,
    category: row.category,
    severity: row.severity,
    blocking: row.blocking === 1,
    state: row.state,
    statementMd: row.statement_md,
    rationaleMd: row.rationale_md,
    confidenceLabel: row.confidence_label,
    options,
    anchors,
    locator: anchors.map((anchor) => anchor.quote).find((quote): quote is string => Boolean(quote)) ?? "",
  };
}

export function loadUncertainties(db: SqliteDb, projectId: string): UncertaintyView[] {
  const rows = allRows<{ id: string }>(
    db,
    `SELECT id FROM uncertainties WHERE project_id = ? ORDER BY created_at`,
    projectId,
  );
  return rows.map((row) => loadUncertainty(db, projectId, row.id));
}

export function loadOpenUncertaintyIdsForDocument(
  db: SqliteDb,
  projectId: string,
  documentNodeId: string,
  options: { blockingOnly?: boolean } = {},
): string[] {
  const blockingClause = options.blockingOnly ? "AND uncertainty.blocking = 1" : "";
  return allRows<{ id: string }>(
    db,
    `WITH RECURSIVE lineage(id, parent_node_id) AS (
       SELECT id, parent_node_id
       FROM document_nodes
       WHERE id = ? AND project_id = ? AND archived_at IS NULL
       UNION ALL
       SELECT parent.id, parent.parent_node_id
       FROM document_nodes parent
       JOIN lineage child ON child.parent_node_id = parent.id
       WHERE parent.project_id = ? AND parent.archived_at IS NULL
     ), latest AS (
       SELECT version.id
       FROM uncertainty_versions version
       WHERE version.project_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM uncertainty_versions newer
           WHERE newer.uncertainty_id = version.uncertainty_id
             AND newer.version_no > version.version_no
         )
     )
     SELECT DISTINCT uncertainty.id
     FROM uncertainties uncertainty
     JOIN latest ON 1 = 1
     JOIN uncertainty_versions version
       ON version.id = latest.id AND version.uncertainty_id = uncertainty.id
     JOIN uncertainty_anchors anchor ON anchor.uncertainty_version_id = version.id
     WHERE uncertainty.project_id = ? AND uncertainty.state = 'open'
       ${blockingClause}
       AND (
         (anchor.target_kind = 'document_node' AND anchor.target_version_id IN (SELECT id FROM lineage))
         OR (anchor.target_kind = 'source_text_version' AND EXISTS (
           SELECT 1 FROM src_text_versions source_version
           JOIN src_texts source ON source.id = source_version.source_text_id
           JOIN src_text_heads source_head
             ON source_head.source_text_id = source.id
            AND source_head.current_version_id = source_version.id
           WHERE source_version.id = anchor.target_version_id AND source.document_node_id = ?
         ))
         OR (anchor.target_kind = 'punctuation_version' AND EXISTS (
           SELECT 1 FROM punctuation_versions punctuation_version
           JOIN punctuation_sets punctuation ON punctuation.id = punctuation_version.punctuation_set_id
           JOIN punctuation_heads punctuation_head
             ON punctuation_head.punctuation_set_id = punctuation.id
            AND punctuation_head.current_version_id = punctuation_version.id
           JOIN src_texts source ON source.id = punctuation.source_text_id
           WHERE punctuation_version.id = anchor.target_version_id AND source.document_node_id = ?
         ))
         OR (anchor.target_kind = 'translation_anchor' AND EXISTS (
           SELECT 1 FROM translation_anchors translation_anchor
           JOIN translation_anchor_sets anchor_set ON anchor_set.id = translation_anchor.anchor_set_id
           JOIN src_text_versions source_version ON source_version.id = anchor_set.source_text_version_id
           JOIN src_text_heads source_head
             ON source_head.source_text_id = source_version.source_text_id
            AND source_head.current_version_id = anchor_set.source_text_version_id
           JOIN punctuation_versions punctuation_version ON punctuation_version.id = anchor_set.punctuation_version_id
           JOIN punctuation_heads punctuation_head
             ON punctuation_head.punctuation_set_id = punctuation_version.punctuation_set_id
            AND punctuation_head.current_version_id = anchor_set.punctuation_version_id
           WHERE translation_anchor.id = anchor.target_version_id AND anchor_set.document_node_id = ?
         ))
         OR (anchor.target_kind = 'document_translation' AND EXISTS (
           SELECT 1 FROM document_translations translation
           WHERE translation.id = anchor.target_version_id AND translation.document_node_id = ?
         ))
         OR (anchor.target_kind = 'document_translation_version' AND EXISTS (
           SELECT 1 FROM document_translation_versions translation_version
           JOIN document_translations translation ON translation.id = translation_version.document_translation_id
           JOIN document_translation_heads translation_head
             ON translation_head.document_translation_id = translation.id
            AND translation_head.current_version_id = translation_version.id
           WHERE translation_version.id = anchor.target_version_id AND translation.document_node_id = ?
         ))
       )`,
    documentNodeId,
    projectId,
    projectId,
    projectId,
    projectId,
    documentNodeId,
    documentNodeId,
    documentNodeId,
    documentNodeId,
    documentNodeId,
  ).map((row) => row.id);
}

export function assertNoOpenBlockingUncertainty(
  db: SqliteDb,
  projectId: string,
  documentNodeId: string,
): void {
  const ids = loadOpenUncertaintyIdsForDocument(db, projectId, documentNodeId, { blockingOnly: true });
  if (ids.length > 0) {
    throw new MunhaeError(
      "open_blocking_uncertainty",
      `이 문서에 해결되지 않은 확정 차단 불확실성이 ${ids.length}건 있습니다`,
    );
  }
}
