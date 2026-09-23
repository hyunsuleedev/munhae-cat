import { canonicalJson, createId, MunhaeError, nowIso } from "@munhae/domain";
import { allRows, getRow, insertRow } from "./rows.ts";
import { createContextItem } from "./knowledge-ops.ts";
import type { ProjectActors } from "./bootstrap.ts";
import type { SqliteDb } from "./sqlite.ts";
import type { NodeContextView, MaterialOrigin, ReuseCommentAsMaterialInput, UpdateContextItemInput, ContextItemCasInput } from "./views.ts";
type Context = { db: SqliteDb; projectId: string; actors: ProjectActors };
type Row = { id: string; project_id: string; comment_id: string; scope_id: string; title: string; note_md: string; condition_md: string; inherit_to_children: number; enabled: number; priority: number; reviewed_comment_lock_version: number; needs_review: number; origin_json: string; lock_version: number; updated_at: string };
function currentComment(db: SqliteDb, projectId: string, id: string): MaterialOrigin | undefined {
  return getRow<MaterialOrigin>(db, `SELECT c.id AS commentId,c.document_node_id AS documentNodeId,c.translation_version_id AS translationVersionId,
    c.target_kind AS targetKind,c.target_version_id AS targetVersionId,c.codepoint_from AS codepointFrom,c.codepoint_to AS codepointTo,
    c.quote,c.body_md AS bodyMd,c.lock_version AS lockVersion FROM review_comments c JOIN document_nodes n ON n.id=c.document_node_id
    WHERE c.id=? AND c.project_id=? AND c.archived_at IS NULL AND n.archived_at IS NULL`, id, projectId);
}
export function loadCommentReferences(db: SqliteDb, projectId: string): NodeContextView[] {
  return allRows<Row>(db, `SELECT r.* FROM comment_references r JOIN document_nodes n ON n.id=r.scope_id
    WHERE r.project_id=? AND r.archived_at IS NULL AND n.archived_at IS NULL`, projectId).map(row => {
    const live = currentComment(db, projectId, row.comment_id);
    return { id: row.id, source: "comment_reference", scopeKind: "document_node", scopeId: row.scope_id,
      title: row.title, contentMd: row.note_md, conditionMd: row.condition_md, inheritToChildren: !!row.inherit_to_children,
      enabled: !!row.enabled, priority: row.priority, lockVersion: row.lock_version, updatedAt: row.updated_at,
      origin: live ?? JSON.parse(row.origin_json), reference: { commentId: row.comment_id, needsReview: !!row.needs_review,
        sourceChanged: !!live && live.lockVersion !== row.reviewed_comment_lock_version, sourceUnavailable: !live,
        reviewedCommentLockVersion: row.reviewed_comment_lock_version } };
  });
}
export function isCommentReference(db: SqliteDb, projectId: string, id: string): boolean {
  return !!getRow(db, "SELECT id FROM comment_references WHERE id=? AND project_id=? AND archived_at IS NULL", id, projectId);
}
function validate(context: Context, input: ReuseCommentAsMaterialInput | UpdateContextItemInput) {
  if (!input.title.trim() || input.title.length > 500 || typeof input.contentMd !== "string" || input.contentMd.length > 200000
    || (input.conditionMd?.length ?? 0) > 20000 || !Number.isInteger(input.priority) || Math.abs(input.priority)>1000000)
    throw new MunhaeError("invalid_input", "참고 코멘트 제목과 보충 메모를 확인하세요");
  if (!getRow(context.db,"SELECT id FROM document_nodes WHERE id=? AND project_id=? AND archived_at IS NULL",input.scopeId,context.projectId))
    throw new MunhaeError("not_found", "적용할 문서를 찾을 수 없습니다");
}
export function createCommentReference(context: Context, input: ReuseCommentAsMaterialInput): NodeContextView {
  return context.db.transaction(() => {
    validate(context,input);
    const comment = currentComment(context.db,context.projectId,input.commentId);
    if (!comment || comment.lockVersion !== input.expectedCommentLockVersion) throw new MunhaeError("cas_conflict", "원본 코멘트가 변경되거나 삭제되었습니다. 다시 확인하세요");
    const id=createId(), now=nowIso();
    insertRow(context.db,"comment_references",{ id,project_id:context.projectId,comment_id:comment.commentId,scope_id:input.scopeId,
      title:input.title,note_md:input.contentMd,condition_md:input.conditionMd??"",inherit_to_children:input.inheritToChildren?1:0,
      enabled:input.enabled?1:0,priority:input.priority,reviewed_comment_lock_version:comment.lockVersion,needs_review:0,
      origin_json:canonicalJson(comment),lock_version:1,created_at:now,updated_at:now });
    return loadCommentReferences(context.db,context.projectId).find(r=>r.id===id)!;
  })();
}
function requireReference(context: Context,input: ContextItemCasInput): NodeContextView {
  const row=loadCommentReferences(context.db,context.projectId).find(r=>r.id===input.id);
  if(!row || row.lockVersion!==input.expectedLockVersion) throw new MunhaeError("cas_conflict","참고 코멘트 연결이 변경되었습니다");
  return row;
}
export function updateCommentReference(context: Context,input: UpdateContextItemInput): NodeContextView {
  const {db,projectId}=context;
  return db.transaction(()=>{
    validate(context,input);
    const old=requireReference(context,input);
    if(input.keepAsContext) {
      const item=createContextItem(context,{...input,contentMd:input.contentMd.trim()||old.origin!.bodyMd});
      // Keep document-specific inclusion/exclusion when explicitly converting to independent context.
      const prefs=allRows<Record<string,unknown>>(db,"SELECT * FROM material_preferences WHERE project_id=? AND source_kind='comment_reference' AND source_id=?",projectId,input.id);
      for(const pref of prefs) insertRow(db,"material_preferences",{...pref,source_kind:"context_item",source_id:item.id});
      deleteCommentReference(context,input);
      return item;
    }
    if(old.reference!.sourceUnavailable || input.expectedCommentLockVersion !== old.origin!.lockVersion)
      throw new MunhaeError("cas_conflict","원본 코멘트가 변경되거나 삭제되었습니다. 다시 확인하세요");
    db.prepare(`UPDATE comment_references SET scope_id=?,title=?,note_md=?,condition_md=?,inherit_to_children=?,enabled=?,priority=?,
      reviewed_comment_lock_version=?,needs_review=0,origin_json=?,lock_version=lock_version+1,updated_at=? WHERE id=? AND project_id=?`)
      .run(input.scopeId,input.title,input.contentMd,input.conditionMd??"",input.inheritToChildren?1:0,input.enabled?1:0,input.priority,
        old.origin!.lockVersion,canonicalJson(old.origin),nowIso(),input.id,projectId);
    return loadCommentReferences(db,projectId).find(r=>r.id===input.id)!;
  })();
}
export function patchCommentReference(context: Context,input: ContextItemCasInput & {enabled?:boolean;priority?:number}): NodeContextView {
  const old=requireReference(context,input);
  // Toggling a row is not acknowledgment of a changed original or migrated note.
  context.db.prepare("UPDATE comment_references SET enabled=?,priority=?,lock_version=lock_version+1,updated_at=? WHERE id=? AND project_id=? AND lock_version=?")
    .run((input.enabled??old.enabled)?1:0,input.priority??old.priority,nowIso(),input.id,context.projectId,input.expectedLockVersion);
  return loadCommentReferences(context.db,context.projectId).find(r=>r.id===input.id)!;
}
export function deleteCommentReference(context: Context,input: ContextItemCasInput): void {
  context.db.transaction(()=>{
    requireReference(context,input);
    context.db.prepare("DELETE FROM material_preferences WHERE project_id=? AND source_kind='comment_reference' AND source_id=?").run(context.projectId,input.id);
    context.db.prepare("UPDATE comment_references SET archived_at=?,lock_version=lock_version+1 WHERE id=? AND project_id=?").run(nowIso(),input.id,context.projectId);
  })();
}
export const referenceReady = (item: NodeContextView) => !item.reference || !(item.reference.needsReview || item.reference.sourceChanged || item.reference.sourceUnavailable);
export function referencePrompt(item: NodeContextView): string {
  return canonicalJson({ kind:"reference_comment", original:item.origin,
    applicationNote:item.contentMd, conditions:item.conditionMd??"",
    instruction:"원래 구절에 대한 질문·추정·의견입니다. 현재 문서의 확정 사실이나 수정 명령으로 간주하지 말고 적용 조건과 문맥을 대조하세요." });
}
