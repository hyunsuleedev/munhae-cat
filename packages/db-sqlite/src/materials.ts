import { canonicalJson, createId, MunhaeError, nowIso, sha256Hex, utf8ByteLength } from "@munhae/domain";
import type { ProjectActors } from "./bootstrap.ts";
import { createContextItem, loadContextItem } from "./knowledge-ops.ts";
import { materialOriginFromJson } from "./knowledge-content.ts";
import { allRows, getRow, insertRow } from "./rows.ts";
import type { SqliteDb } from "./sqlite.ts";
import type {
  MaterialCommentView, MaterialOrigin, MaterialPreferenceView, MaterialsView,
  NodeContextView, ResolvedMaterialView, ReuseCommentAsMaterialInput, SetMaterialPreferenceInput,
} from "./views.ts";

type Context = { db: SqliteDb; projectId: string; actors: ProjectActors };
type Node = { id: string; parentId: string | null };
const nodes = (db: SqliteDb, projectId: string) => allRows<Node>(db,
  "SELECT id, parent_node_id AS parentId FROM document_nodes WHERE project_id=? AND archived_at IS NULL", projectId);
function lineage(db: SqliteDb, projectId: string, documentNodeId: string): string[] {
  const available = new Map(nodes(db, projectId).map(node => [node.id, node]));
  if (!available.has(documentNodeId)) throw new MunhaeError("not_found", "문서를 찾을 수 없습니다");
  const result: string[] = [];
  let current: string | null = documentNodeId;
  while (current && available.has(current) && !result.includes(current)) {
    result.push(current); current = available.get(current)!.parentId;
  }
  return result;
}

export function materialSourceId(item: NodeContextView): string {
  return item.source === "document_description" ? item.scopeId : item.id;
}

export function loadMaterialItems(db: SqliteDb, projectId: string): NodeContextView[] {
  const items = allRows<{
    id: string; scope_id: string; title: string; content_md: string; priority: number;
    enabled: number; lock_version: number; updated_at: string; inherit_to_children: number;
    condition_md: string; origin_json: string | null;
  }>(db, `SELECT item.id, scope_id, item.title, content_md, priority, enabled,
      item.lock_version, item.updated_at, inherit_to_children, condition_md, artifact.payload_json AS origin_json
    FROM context_items item JOIN document_nodes owner ON owner.id=item.scope_id AND owner.project_id=item.project_id
    LEFT JOIN provenance_artifacts artifact ON artifact.id=item.origin_artifact_id
    WHERE item.project_id=? AND item.archived_at IS NULL AND owner.archived_at IS NULL
      AND item.scope_kind='document_node'`, projectId).map<NodeContextView>(row => ({
    id: row.id, source: "context_item", scopeKind: "document_node", scopeId: row.scope_id,
    title: row.title, contentMd: row.content_md, priority: row.priority, enabled: row.enabled === 1,
    lockVersion: row.lock_version, updatedAt: row.updated_at, inheritToChildren: row.inherit_to_children === 1,
    conditionMd: row.condition_md, origin: materialOriginFromJson(row.origin_json),
  }));
  const descriptions = allRows<{
    id: string; title: string; original_title: string | null; description_md: string;
    lock_version: number; updated_at: string;
  }>(db, `SELECT id,title,original_title,description_md,lock_version,updated_at FROM document_nodes
    WHERE project_id=? AND archived_at IS NULL AND trim(COALESCE(description_md,''))<>''`, projectId)
    .map<NodeContextView>(node => ({
      id: `document:${node.id}:description`, source: "document_description", scopeKind: "document_node",
      scopeId: node.id, title: `문서 설명 · ${node.original_title || node.title}`, contentMd: node.description_md,
      priority: 0, enabled: true, lockVersion: node.lock_version, updatedAt: node.updated_at,
      inheritToChildren: true, conditionMd: "", origin: null,
    }));
  return [...items, ...descriptions].sort((a, b) => b.priority - a.priority || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
}

export function loadMaterialPreferences(db: SqliteDb, projectId: string): MaterialPreferenceView[] {
  return allRows<{
    documentNodeId: string; source: MaterialPreferenceView["source"]; sourceId: string;
    referenced: number; excluded: number; lockVersion: number;
  }>(db, `SELECT preference.document_node_id AS documentNodeId, source_kind AS source, source_id AS sourceId,
      referenced, excluded, preference.lock_version AS lockVersion
    FROM material_preferences preference JOIN document_nodes target ON target.id=preference.document_node_id
    WHERE preference.project_id=? AND target.project_id=preference.project_id AND target.archived_at IS NULL
    ORDER BY preference.document_node_id,source_kind,source_id`, projectId)
    .map(row => ({ ...row, referenced: row.referenced === 1, excluded: row.excluded === 1,
      mode: row.excluded ? "exclude" : "include" }));
}

export function resolveMaterials(db: SqliteDb, projectId: string, documentNodeId: string,
  items = loadMaterialItems(db, projectId), preferences = loadMaterialPreferences(db, projectId)): ResolvedMaterialView[] {
  const ancestors = lineage(db, projectId, documentNodeId);
  const result: ResolvedMaterialView[] = [];
  for (const item of items) {
    const preference = preferences.find(p => p.documentNodeId === documentNodeId && p.source === item.source && p.sourceId === materialSourceId(item));
    const distance = ancestors.indexOf(item.scopeId);
    const reason = distance === 0 ? "current" : distance > 0 && item.inheritToChildren !== false ? "ancestor" : preference?.referenced ? "selected" : null;
    if (reason) result.push({ ...item, reason, referenced: preference?.referenced ?? false, excluded: preference?.excluded ?? false,
      included: !preference?.excluded && (item.enabled || preference?.mode === "include") });
  }
  return result.sort((a, b) => {
    const distance = (item: ResolvedMaterialView) => item.reason === "selected" ? Number.MAX_SAFE_INTEGER : ancestors.indexOf(item.scopeId);
    return distance(a) - distance(b) || b.priority - a.priority || a.id.localeCompare(b.id);
  });
}

export function listMaterialComments(db: SqliteDb, projectId: string): MaterialCommentView[] {
  const linked = allRows<{ source_comment_id: string; id: string }>(db,
    "SELECT id,source_comment_id FROM context_items WHERE project_id=? AND source_comment_id IS NOT NULL AND archived_at IS NULL", projectId);
  return allRows<Omit<MaterialCommentView, "materialIds">>(db, `SELECT comment.id,
      document_node_id AS documentNodeId, translation_version_id AS translationVersionId,
      target_kind AS targetKind,target_version_id AS targetVersionId,codepoint_from AS codepointFrom,
      codepoint_to AS codepointTo,quote,body_md AS bodyMd,comment.lock_version AS lockVersion,
      comment.created_at AS createdAt,comment.updated_at AS updatedAt,actor.display_name AS authorName
    FROM review_comments comment JOIN document_nodes node ON node.id=comment.document_node_id
    JOIN core_actors actor ON actor.id=comment.created_by_actor_id
    WHERE comment.project_id=? AND comment.archived_at IS NULL AND node.archived_at IS NULL
      AND node.project_id=comment.project_id ORDER BY comment.created_at,comment.id`, projectId)
    .map(comment => ({ ...comment, materialIds: linked.filter(item => item.source_comment_id === comment.id).map(item => item.id) }));
}

export function getMaterials(context: Context, documentNodeId?: string): MaterialsView {
  const { db, projectId } = context;
  const items = loadMaterialItems(db, projectId), preferences = loadMaterialPreferences(db, projectId);
  return { items, preferences, comments: listMaterialComments(db, projectId),
    ...(documentNodeId ? { documentNodeId, resolved: resolveMaterials(db, projectId, documentNodeId, items, preferences) } : {}) };
}

export function setMaterialPreference(context: Context, input: SetMaterialPreferenceInput): void {
  const { db, projectId, actors } = context;
  if (!["context_item", "document_description"].includes(input.source) || !["include", "exclude", "reset"].includes(input.mode))
    throw new MunhaeError("invalid_input", "자료 선택이 올바르지 않습니다");
  db.transaction(() => {
    const ancestors = lineage(db, projectId, input.documentNodeId);
    const item = loadMaterialItems(db, projectId).find(item => item.source === input.source && materialSourceId(item) === input.sourceId);
    if (!item) throw new MunhaeError("not_found", "참고 자료를 찾을 수 없습니다");
    const current = getRow<{ referenced: number; excluded: number; lock_version: number }>(db,
      "SELECT referenced,excluded,lock_version FROM material_preferences WHERE project_id=? AND document_node_id=? AND source_kind=? AND source_id=?",
      projectId, input.documentNodeId, input.source, input.sourceId);
    if (input.expectedLockVersion !== undefined && input.expectedLockVersion !== (current?.lock_version ?? 0))
      throw new MunhaeError("cas_conflict", "자료 선택이 변경되었습니다. 다시 불러오세요");
    if (input.mode === "reset") {
      db.prepare("DELETE FROM material_preferences WHERE project_id=? AND document_node_id=? AND source_kind=? AND source_id=?")
        .run(projectId, input.documentNodeId, input.source, input.sourceId);
      return;
    }
    const natural = item.scopeId === input.documentNodeId || item.inheritToChildren !== false && ancestors.includes(item.scopeId);
    const referenced = Boolean(current?.referenced) || input.mode === "include" && !natural;
    const now = nowIso();
    db.prepare(`INSERT INTO material_preferences
      (project_id,document_node_id,source_kind,source_id,referenced,excluded,lock_version,created_by_actor_id,updated_by_actor_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,?,?,?,?) ON CONFLICT(project_id,document_node_id,source_kind,source_id)
      DO UPDATE SET referenced=excluded.referenced,excluded=excluded.excluded,lock_version=material_preferences.lock_version+1,
        updated_by_actor_id=excluded.updated_by_actor_id,updated_at=excluded.updated_at`)
      .run(projectId,input.documentNodeId,input.source,input.sourceId,referenced ? 1 : 0,input.mode === "exclude" ? 1 : 0,actors.humanId,actors.humanId,now,now);
  })();
}

export function reuseCommentAsMaterial(context: Context, input: ReuseCommentAsMaterialInput): NodeContextView {
  const { db, projectId } = context;
  return db.transaction(() => {
    const comment = listMaterialComments(db, projectId).find(comment => comment.id === input.commentId);
    if (!comment) throw new MunhaeError("not_found", "코멘트를 찾을 수 없습니다");
    if (comment.lockVersion !== input.expectedCommentLockVersion)
      throw new MunhaeError("cas_conflict", "원본 코멘트가 변경되었습니다. 확인 후 다시 저장하세요");
    const origin: MaterialOrigin = { commentId: comment.id, documentNodeId: comment.documentNodeId,
      translationVersionId: comment.translationVersionId, targetKind: comment.targetKind, targetVersionId: comment.targetVersionId,
      codepointFrom: comment.codepointFrom, codepointTo: comment.codepointTo, quote: comment.quote,
      bodyMd: comment.bodyMd, lockVersion: comment.lockVersion };
    const payload = canonicalJson(origin);
    const existing = getRow<{ id: string }>(db, "SELECT id FROM provenance_artifacts WHERE project_id=? AND artifact_kind='material_comment_origin' AND canonical_sha256=?", projectId, sha256Hex(payload));
    const artifactId = existing?.id ?? createId();
    const item = createContextItem(context, input);
    if (!existing) insertRow(db, "provenance_artifacts", { id: artifactId, project_id: projectId, artifact_kind: "material_comment_origin",
      media_type: "application/json", payload_json: payload, raw_sha256: sha256Hex(payload), canonical_sha256: sha256Hex(payload),
      byte_size: utf8ByteLength(payload), created_at: nowIso() });
    db.prepare("UPDATE context_items SET source_comment_id=?,origin_artifact_id=? WHERE id=? AND project_id=?")
      .run(comment.id, artifactId, item.id, projectId);
    return loadContextItem(db, projectId, item.id);
  })();
}

/** A selected past comment is an example tied to its original text, not a current revision command. */
export function referenceComments(db: SqliteDb, projectId: string, ids: string[] | undefined): MaterialCommentView[] {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id || id.length > 100))
    throw new MunhaeError("invalid_input", "참고할 코멘트 선택이 올바르지 않습니다");
  const available = new Map(listMaterialComments(db, projectId).map(comment => [comment.id, comment]));
  return ids.map(id => {
    const comment = available.get(id);
    if (!comment) throw new MunhaeError("stale_request", "삭제되었거나 다른 프로젝트의 코멘트가 포함되어 있습니다");
    return comment;
  });
}

export function materialPromptContent(item: NodeContextView): string {
  return [item.contentMd, item.conditionMd?.trim() ? `적용 조건·예외: ${item.conditionMd.trim()}` : "",
    item.origin ? `근거 코멘트의 원래 구절: ${item.origin.quote}\n이 판단은 위 구절에서 나온 것입니다. 현재 문서에도 적용되는지 문맥을 확인하세요.` : ""]
    .filter(Boolean).join("\n\n");
}
