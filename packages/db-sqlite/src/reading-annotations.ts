import { canonicalJson, canonicalJsonHash, codepointCount, createId, MunhaeError, nowIso, sha256Hex, sliceCodepoints } from "@munhae/domain";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ProjectActors } from "./bootstrap.ts";
import { orm } from "./drizzle-db.ts";
import { schema } from "./drizzle-schema.ts";
import { allRows, getRow, insertRow } from "./rows.ts";
import type { SqliteDb } from "./sqlite.ts";

export type ReadingCitation = {
  source: string;
  sourceLabel: string;
  entryId: string;
  headword: string;
  reading: string | null;
  sense: string;
  senseLabel?: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string | null;
  attribution: string;
};
export type ReadingAnnotationView = {
  id: string;
  documentNodeId: string;
  sourceVersionId: string;
  codepointFrom: number;
  codepointTo: number;
  quote: string;
  reading: string;
  gloss: string;
  readingOrder: number | null;
  citation: ReadingCitation | null;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
};
export type SaveReadingAnnotationInput = Omit<ReadingAnnotationView, "id" | "lockVersion" | "createdAt" | "updatedAt"> & {
  id?: string;
  expectedLockVersion: number;
};
export type ReadingAnnotationCasInput = { id: string; expectedLockVersion: number };

type Context = { db: SqliteDb; projectId: string; actors: ProjectActors };
type Stored = Omit<ReadingAnnotationView, "citation"> & { citationJson: string | null; sourceContentHash: string };
type Source = { sourceVersionId: string; contentText: string; contentHash: string };
const columns = `id, document_node_id AS documentNodeId, source_version_id AS sourceVersionId,
  source_content_hash AS sourceContentHash, codepoint_from AS codepointFrom, codepoint_to AS codepointTo,
  quote, reading, gloss, reading_order AS readingOrder, citation_json AS citationJson,
  lock_version AS lockVersion, created_at AS createdAt, updated_at AS updatedAt`;
const citationFields: Record<string, number> = { source: 100, sourceLabel: 500, entryId: 500, headword: 500,
  reading: 100, sense: 20_000, senseLabel: 500, sourceUrl: 2048, license: 1000, licenseUrl: 2048, attribution: 5000 };

function invalid(message: string): never { throw new MunhaeError("invalid_submission", message); }
function text(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== "string" || value.length > max || /[\u0000\p{Surrogate}]/u.test(value) || (required && !value.trim()))
    invalid(`${label} 내용을 확인해 주세요`);
  return value;
}
function citation(value: ReadingCitation | null): ReadingCitation | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(citationFields, key))) invalid("사전 출처 형식이 올바르지 않습니다");
  for (const [key, max] of Object.entries(citationFields)) {
    const field = (value as unknown as Record<string, unknown>)[key];
    if ((key === "reading" || key === "licenseUrl") && field === null || key === "senseLabel" && field === undefined) continue;
    text(field, max, "사전 출처", !["reading", "senseLabel", "attribution"].includes(key));
  }
  for (const address of [value.sourceUrl, value.licenseUrl]) {
    if (address === null) continue;
    let url: URL;
    try { url = new URL(address); } catch { invalid("사전 출처 주소가 올바르지 않습니다"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) invalid("사전 출처 주소가 올바르지 않습니다");
  }
  if (canonicalJson(value).length > 40_000) invalid("사전 출처 내용이 너무 깁니다");
  return value;
}
function lock(value: number, isNew = false): void {
  if (!Number.isSafeInteger(value) || (isNew ? value !== 0 : value < 1)) invalid("주석의 저장 상태가 올바르지 않습니다");
}
function activeDocument(repo: Context, id: string): void {
  if (!getRow(repo.db, `SELECT id FROM document_nodes WHERE id=? AND project_id=? AND node_role='source_unit' AND archived_at IS NULL`, id, repo.projectId))
    throw new MunhaeError("not_found", "원문 문서를 찾을 수 없습니다");
}
function currentSource(repo: Context, documentNodeId: string): Source {
  activeDocument(repo, documentNodeId);
  const sources = schema.src_texts, heads = schema.src_text_heads, versions = schema.src_text_versions;
  const source = orm(repo.db).select({
    sourceVersionId: versions.id,
    contentText: versions.content_text,
    contentHash: versions.content_hash,
  }).from(sources)
    .innerJoin(heads, eq(heads.source_text_id, sources.id))
    .innerJoin(versions, and(eq(versions.id, heads.current_version_id), eq(versions.source_text_id, sources.id)))
    .where(and(
      eq(sources.document_node_id, documentNodeId),
      eq(sources.project_id, repo.projectId),
      eq(versions.project_id, repo.projectId),
      isNull(sources.tombstoned_at),
      inArray(versions.state, ["draft", "confirmed"]),
    )).get();
  if (!source) throw new MunhaeError("not_ready", "저장된 원문이 없습니다");
  if (sha256Hex(source.contentText) !== source.contentHash) throw new MunhaeError("stale_request", "원문 내용이 변경되었습니다. 원문을 다시 저장하고 주석을 확인해 주세요");
  return source;
}
function stored(repo: Context, id: string): Stored {
  const row = getRow<Stored>(repo.db, `SELECT ${columns} FROM reading_annotations WHERE id=? AND project_id=? AND archived_at IS NULL`, id, repo.projectId);
  if (!row) throw new MunhaeError("not_found", "글자 풀이를 찾을 수 없습니다");
  activeDocument(repo, row.documentNodeId);
  return row;
}
function view(row: Stored): ReadingAnnotationView {
  const { citationJson, sourceContentHash: _hash, ...fields } = row;
  return { ...fields, citation: citationJson === null ? null : JSON.parse(citationJson) as ReadingCitation };
}
function currentTarget(source: Source, target: Pick<Stored, "sourceVersionId" | "sourceContentHash" | "codepointFrom" | "codepointTo" | "quote">): void {
  if (source.sourceVersionId !== target.sourceVersionId || source.contentHash !== target.sourceContentHash
    || sliceCodepoints(source.contentText, target.codepointFrom, target.codepointTo) !== target.quote)
    throw new MunhaeError("stale_request", "이전 원문의 풀이는 읽기 전용입니다. 현재 원문에서 다시 작성해 주세요");
}

/** Include old source versions, without relocating them to similar current text. */
export function listReadingAnnotations(repo: Context, documentNodeId: string): ReadingAnnotationView[] {
  activeDocument(repo, documentNodeId);
  return allRows<Stored>(repo.db, `SELECT ${columns} FROM reading_annotations
    WHERE project_id=? AND document_node_id=? AND archived_at IS NULL
    ORDER BY source_version_id, codepoint_from, codepoint_to, created_at, id`, repo.projectId, documentNodeId).map(view);
}

export function saveReadingAnnotation(repo: Context, input: SaveReadingAnnotationInput): ReadingAnnotationView {
  lock(input.expectedLockVersion, input.id === undefined);
  if (input.id !== undefined) text(input.id, 500, "주석 ID", true);
  text(input.documentNodeId, 500, "문서 ID", true);
  text(input.sourceVersionId, 500, "원문 버전", true);
  const reading = text(input.reading, 100, "독음").trim();
  const gloss = text(input.gloss, 2000, "문맥 풀이").trim();
  const sourceCitation = citation(input.citation);
  if (input.readingOrder !== null && (!Number.isSafeInteger(input.readingOrder) || input.readingOrder < 1 || input.readingOrder > 1_000_000))
    invalid("풀이 순서는 1 이상의 정수로 입력해 주세요");
  if (!reading && !gloss && input.readingOrder === null && sourceCitation === null) invalid("독음이나 풀이를 입력해 주세요");
  if (!Number.isSafeInteger(input.codepointFrom) || !Number.isSafeInteger(input.codepointTo)
    || input.codepointFrom < 0 || input.codepointTo <= input.codepointFrom || input.codepointTo > 20_000_000
    || input.codepointTo - input.codepointFrom > 100) invalid("원문 범위가 올바르지 않습니다");
  text(input.quote, 200, "원문 인용", true);
  if (codepointCount(input.quote) !== input.codepointTo - input.codepointFrom) invalid("원문 인용과 글자 위치가 일치하지 않습니다");
  return repo.db.transaction(() => {
    const source = currentSource(repo, input.documentNodeId);
    if (source.sourceVersionId !== input.sourceVersionId) throw new MunhaeError("stale_request", "원문 버전이 변경되었습니다. 현재 원문에서 다시 작성해 주세요");
    if (input.codepointTo > codepointCount(source.contentText) || sliceCodepoints(source.contentText, input.codepointFrom, input.codepointTo) !== input.quote)
      invalid("원문 인용과 글자 위치가 일치하지 않습니다");
    if (input.id) {
      const old = stored(repo, input.id);
      if (old.documentNodeId !== input.documentNodeId || old.sourceVersionId !== input.sourceVersionId
        || old.codepointFrom !== input.codepointFrom || old.codepointTo !== input.codepointTo || old.quote !== input.quote)
        invalid("기존 풀이의 원문 범위는 변경할 수 없습니다");
      currentTarget(source, old);
      if (old.lockVersion !== input.expectedLockVersion) throw new MunhaeError("cas_conflict", "글자 풀이가 다른 편집에서 변경되었습니다. 다시 불러오세요");
    } else if (getRow(repo.db, `SELECT id FROM reading_annotations WHERE project_id=? AND document_node_id=?
      AND source_version_id=? AND codepoint_from=? AND codepoint_to=? AND archived_at IS NULL`, repo.projectId, input.documentNodeId, input.sourceVersionId, input.codepointFrom, input.codepointTo)) {
      throw new MunhaeError("duplicate_annotation", "이 원문 범위에 풀이가 이미 있습니다. 기존 풀이를 다시 불러오세요");
    }
    const id = input.id ?? createId(), now = nowIso();
    const hash = canonicalJsonHash({ documentNodeId: input.documentNodeId, sourceVersionId: input.sourceVersionId,
      sourceContentHash: source.contentHash, codepointFrom: input.codepointFrom, codepointTo: input.codepointTo,
      quote: input.quote, reading, gloss, readingOrder: input.readingOrder, citation: sourceCitation });
    const citationJson = sourceCitation === null ? null : canonicalJson(sourceCitation);
    if (input.id) {
      const result = repo.db.prepare(`UPDATE reading_annotations SET reading=?, gloss=?, reading_order=?, citation_json=?,
        content_hash=?, lock_version=lock_version+1, updated_by_actor_id=?, updated_at=?
        WHERE id=? AND project_id=? AND lock_version=? AND archived_at IS NULL`)
        .run(reading, gloss, input.readingOrder, citationJson, hash, repo.actors.humanId, now, id, repo.projectId, input.expectedLockVersion);
      if (result.changes !== 1) throw new MunhaeError("cas_conflict", "글자 풀이가 다른 편집에서 변경되었습니다. 다시 불러오세요");
    } else {
      insertRow(repo.db, "reading_annotations", { id, project_id: repo.projectId, document_node_id: input.documentNodeId,
        source_version_id: input.sourceVersionId, source_content_hash: source.contentHash,
        codepoint_from: input.codepointFrom, codepoint_to: input.codepointTo, quote: input.quote,
        reading, gloss, reading_order: input.readingOrder, citation_json: citationJson, content_hash: hash,
        lock_version: 1, created_by_actor_id: repo.actors.humanId, updated_by_actor_id: repo.actors.humanId,
        created_at: now, updated_at: now });
    }
    return view(stored(repo, id));
  }).immediate();
}

export function archiveReadingAnnotation(repo: Context, input: ReadingAnnotationCasInput): void {
  text(input.id, 500, "주석 ID", true);
  lock(input.expectedLockVersion);
  repo.db.transaction(() => {
    const old = stored(repo, input.id);
    currentTarget(currentSource(repo, old.documentNodeId), old);
    const now = nowIso();
    const result = repo.db.prepare(`UPDATE reading_annotations SET archived_at=?, updated_at=?,
      lock_version=lock_version+1, updated_by_actor_id=? WHERE id=? AND project_id=? AND lock_version=? AND archived_at IS NULL`)
      .run(now, now, repo.actors.humanId, input.id, repo.projectId, input.expectedLockVersion);
    if (result.changes !== 1) throw new MunhaeError("cas_conflict", "글자 풀이가 다른 편집에서 변경되었습니다. 다시 불러오세요");
  }).immediate();
}
