import { createId, MunhaeError, nowIso, sliceCodepoints, codepointCount } from "@munhae/domain";
import type { ProjectActors } from "./bootstrap.ts";
import type { ProjectRepo } from "./project-repo.ts";
import { allRows, getRow, insertRow } from "./rows.ts";
import type { SqliteDb } from "./sqlite.ts";
import type { CreateReviewCommentInput, ReviewCommentCasInput, ReviewCommentView, UpdateReviewCommentInput } from "./views.ts";

type Context = Pick<ProjectRepo, "getEditor" | "projectId"> & { db: SqliteDb; actors: ProjectActors };
const columns = `id, document_node_id AS documentNodeId, translation_version_id AS translationVersionId,
  target_kind AS targetKind, target_version_id AS targetVersionId, codepoint_from AS codepointFrom,
  codepoint_to AS codepointTo, quote, body_md AS bodyMd, lock_version AS lockVersion,
  created_at AS createdAt, updated_at AS updatedAt`;

function activeDocument(repo: Context, id: string): void {
  if (!getRow(repo.db, "SELECT id FROM document_nodes WHERE id=? AND project_id=? AND archived_at IS NULL", id, repo.projectId))
    throw new MunhaeError("not_found", "문서를 찾을 수 없습니다");
}

function body(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 20_000)
    throw new MunhaeError("invalid_submission", "코멘트 내용을 입력하세요");
  return value.trim();
}

function comment(repo: Context, id: string): ReviewCommentView {
  const row = getRow<ReviewCommentView>(repo.db,
    `SELECT ${columns} FROM review_comments WHERE id=? AND project_id=? AND archived_at IS NULL`, id, repo.projectId);
  if (!row) throw new MunhaeError("not_found", "코멘트를 찾을 수 없습니다");
  activeDocument(repo, row.documentNodeId);
  return row;
}

export function listReviewComments(repo: Context, documentNodeId: string): ReviewCommentView[] {
  activeDocument(repo, documentNodeId);
  return allRows(repo.db, `SELECT ${columns} FROM review_comments
    WHERE project_id=? AND document_node_id=? AND archived_at IS NULL ORDER BY created_at, id`, repo.projectId, documentNodeId);
}

export function createReviewComment(repo: Context, input: CreateReviewCommentInput): ReviewCommentView {
  return repo.db.transaction(() => {
    activeDocument(repo, input.documentNodeId);
    const editor = repo.getEditor(input.documentNodeId);
    if (!editor.translation || editor.translation.versionId !== input.translationVersionId || !editor.translation.isCurrentDependencies)
      throw new MunhaeError("stale_request", "원문 또는 번역이 변경되었습니다. 현재 번역에서 범위를 다시 선택하세요");
    if (input.targetKind !== "source" && input.targetKind !== "translation")
      throw new MunhaeError("invalid_submission", "코멘트 대상이 올바르지 않습니다");
    const targetVersionId = input.targetKind === "source" ? editor.source.versionId : editor.translation.versionId;
    const text = input.targetKind === "source" ? editor.source.contentText : editor.translation.textContent;
    if (input.targetVersionId !== targetVersionId)
      throw new MunhaeError("stale_request", "선택한 내용의 버전이 변경되었습니다");
    if (!Number.isSafeInteger(input.codepointFrom) || !Number.isSafeInteger(input.codepointTo)
      || input.codepointFrom < 0 || input.codepointTo <= input.codepointFrom || input.codepointTo > 20_000_000 || input.codepointTo > codepointCount(text)
      || typeof input.quote !== "string" || !input.quote.trim() || input.quote.length > 100_000
      || sliceCodepoints(text, input.codepointFrom, input.codepointTo) !== input.quote)
      throw new MunhaeError("invalid_submission", "선택 범위와 원문 인용이 일치하지 않습니다");
    const id = createId(), now = nowIso();
    insertRow(repo.db, "review_comments", {
      id, project_id: repo.projectId, document_node_id: input.documentNodeId,
      translation_version_id: input.translationVersionId, target_kind: input.targetKind,
      target_version_id: targetVersionId, codepoint_from: input.codepointFrom, codepoint_to: input.codepointTo,
      quote: input.quote, body_md: body(input.bodyMd), lock_version: 1,
      created_by_actor_id: repo.actors.humanId, updated_by_actor_id: repo.actors.humanId,
      created_at: now, updated_at: now,
    });
    return comment(repo, id);
  })();
}

export function updateReviewComment(repo: Context, input: UpdateReviewCommentInput): ReviewCommentView {
  return repo.db.transaction(() => {
    comment(repo, input.id);
    const result = repo.db.prepare(`UPDATE review_comments SET body_md=?, lock_version=lock_version+1,
      updated_by_actor_id=?, updated_at=? WHERE id=? AND project_id=? AND lock_version=? AND archived_at IS NULL`)
      .run(body(input.bodyMd), repo.actors.humanId, nowIso(), input.id, repo.projectId, input.expectedLockVersion);
    if (result.changes !== 1) throw new MunhaeError("cas_conflict", "코멘트가 변경되었습니다. 다시 불러오세요");
    return comment(repo, input.id);
  })();
}

export function archiveReviewComment(repo: Context, input: ReviewCommentCasInput): void {
  repo.db.transaction(() => {
    comment(repo, input.id);
    const now = nowIso();
    const result = repo.db.prepare(`UPDATE review_comments SET archived_at=?, updated_at=?, lock_version=lock_version+1,
      updated_by_actor_id=? WHERE id=? AND project_id=? AND lock_version=? AND archived_at IS NULL`)
      .run(now, now, repo.actors.humanId, input.id, repo.projectId, input.expectedLockVersion);
    if (result.changes !== 1) throw new MunhaeError("cas_conflict", "코멘트가 변경되었습니다. 다시 불러오세요");
  })();
}
