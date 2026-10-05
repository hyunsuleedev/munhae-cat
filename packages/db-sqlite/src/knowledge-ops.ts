import {
  createId,
  MunhaeError,
  nowIso,
} from "@munhae/domain";
import { contextItemContentHash, materialOriginFromJson } from "./knowledge-content.ts";
import type { ProjectActors } from "./bootstrap.ts";
import { orm } from "./drizzle-db.ts";
import { getRow, insertRow } from "./rows.ts";
import type { SqliteDb } from "./sqlite.ts";
import type {
  ContextItemCasInput,
  CreateContextItemInput,
  DocumentMetadataView,
  NodeContextView,
  SetContextItemEnabledInput,
  SetContextItemPriorityInput,
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

export function deleteContextItem(context: MutableKnowledgeContext, input: ContextItemCasInput): void {
  const { db, projectId } = context;
  db.transaction(() => {
    requireContextCas(db, projectId, input);
    // Remove live references, while retaining immutable request/origin snapshots.
    db.prepare(`DELETE FROM material_preferences
      WHERE project_id = ? AND source_kind = 'context_item' AND source_id = ?`)
      .run(projectId, input.id);
    const info = db.prepare(
      `DELETE FROM context_items
       WHERE id = ? AND project_id = ? AND archived_at IS NULL AND lock_version = ?`,
    ).run(input.id, projectId, input.expectedLockVersion);
    if (info.changes !== 1) throw new MunhaeError("cas_conflict", "문맥 카드가 다른 창에서 변경되었습니다");
  })();
}
