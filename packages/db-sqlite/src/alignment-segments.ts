import { MunhaeError, sha256Hex } from "@munhae/domain";
import { isHanmunWhitespaceGap, trimHanmunRange } from "@munhae/domain/hanmun-segmentation";
import { and, eq } from "drizzle-orm";
import { orm } from "./drizzle-db.ts";
import { schema as tables } from "./drizzle-schema.ts";
import { validatePunctuationText } from "./source-layer.ts";
import type { SqliteDb } from "./sqlite.ts";

/** Load the immutable units chosen when this translation was created. No segmentation here. */
export function loadAlignmentSegments(repo: { db: SqliteDb; projectId: string }, versionId: string) {
  const row = orm(repo.db).select({
    punctuationVersionId: tables.punctuation_versions.id,
    punctuatedText: tables.punctuation_versions.punctuated_text,
    source: tables.src_text_versions.content_text,
    sourceVersionId: tables.src_text_versions.id,
    anchorSetId: tables.document_translation_versions.translation_anchor_set_id,
  }).from(tables.document_translation_versions)
    .innerJoin(tables.punctuation_versions, and(
      eq(tables.punctuation_versions.id, tables.document_translation_versions.punctuation_version_id),
      eq(tables.punctuation_versions.source_text_version_id, tables.document_translation_versions.source_text_version_id),
      eq(tables.punctuation_versions.state, "confirmed"),
    ))
    .innerJoin(tables.src_text_versions, eq(tables.src_text_versions.id, tables.document_translation_versions.source_text_version_id))
    .where(and(eq(tables.document_translation_versions.id, versionId), eq(tables.document_translation_versions.project_id, repo.projectId))).get();
  if (!row) return null;
  const invalid = (): never => { throw new MunhaeError("invalid_structure", "확정 표점의 저장된 분절과 원문 범위가 일치하지 않습니다"); };
  if (!row.anchorSetId) return invalid();
  const anchorSet = orm(repo.db).select().from(tables.translation_anchor_sets)
    .where(and(eq(tables.translation_anchor_sets.id, row.anchorSetId), eq(tables.translation_anchor_sets.project_id, repo.projectId))).get();
  if (!anchorSet || anchorSet.punctuation_version_id !== row.punctuationVersionId || anchorSet.source_text_version_id !== row.sourceVersionId) return invalid();
  const anchors = orm(repo.db).select().from(tables.translation_anchors)
    .where(eq(tables.translation_anchors.anchor_set_id, row.anchorSetId)).orderBy(tables.translation_anchors.ordinal).all();
  if (!anchors.length) return invalid();
  const spans = orm(repo.db).select().from(tables.punctuation_structure_spans)
    .where(eq(tables.punctuation_structure_spans.punctuation_version_id, row.punctuationVersionId)).all();
  const links = orm(repo.db).select({ anchorId: tables.translation_anchor_structure_spans.anchor_id, spanId: tables.translation_anchor_structure_spans.punctuation_structure_span_id })
    .from(tables.translation_anchor_structure_spans)
    .innerJoin(tables.translation_anchors, eq(tables.translation_anchors.id, tables.translation_anchor_structure_spans.anchor_id))
    .where(eq(tables.translation_anchors.anchor_set_id, row.anchorSetId)).all();
  const spanById = new Map(spans.map(span => [span.id, span]));
  const linkedSpans = new Map<string, typeof spans>();
  for (const link of links) {
    const span = spanById.get(link.spanId);
    if (span) linkedSpans.set(link.anchorId, [...linkedSpans.get(link.anchorId) ?? [], span]);
  }
  const punctuation = Array.from(row.punctuatedText), source = Array.from(row.source);
  const projection = validatePunctuationText(row.source, row.punctuatedText).sourceBoundaryByPunctuationBoundary;
  let punctuationCursor = 0, sourceCursor = 0;
  const segments = anchors.map((anchor, index) => {
    const pFrom = anchor.punctuation_codepoint_from, pTo = anchor.punctuation_codepoint_to;
    const sFrom = anchor.source_codepoint_from, sTo = anchor.source_codepoint_to;
    const leaf = linkedSpans.get(anchor.id)?.filter(span => span.span_kind === anchor.boundary_kind && span.codepoint_from === pFrom && span.codepoint_to === pTo);
    if (anchor.project_id !== repo.projectId || anchor.ordinal !== index + 1 || anchor.anchor_key !== `A${String(index + 1).padStart(3, "0")}`
      || anchor.required !== 1 || leaf?.length !== 1
      || !Number.isSafeInteger(pFrom) || !Number.isSafeInteger(pTo) || pFrom < 0 || pTo <= pFrom || pTo > punctuation.length
      || !Number.isSafeInteger(sFrom) || !Number.isSafeInteger(sTo) || sFrom < 0 || sTo <= sFrom || sTo > source.length
      || punctuation.slice(pFrom, pTo).join("") !== anchor.punctuated_quote || sha256Hex(anchor.punctuated_quote) !== anchor.punctuated_quote_hash
      || source.slice(sFrom, sTo).join("") !== anchor.source_quote || sha256Hex(anchor.source_quote) !== anchor.source_quote_hash
      || leaf[0]!.quote !== anchor.punctuated_quote || leaf[0]!.quote_hash !== anchor.punctuated_quote_hash) return invalid();
    // Historical versions own surrounding layout whitespace. Exclude it from NEW links only.
    const p = trimHanmunRange(punctuation, pFrom, pTo), s = trimHanmunRange(source, sFrom, sTo);
    const mapped = trimHanmunRange(source, projection[p.from]!, projection[p.to]!);
    if (p.from === p.to || s.from === s.to || mapped.from !== s.from || mapped.to !== s.to
      || !isHanmunWhitespaceGap(punctuation, punctuationCursor, p.from) || !isHanmunWhitespaceGap(source, sourceCursor, s.from)) return invalid();
    punctuationCursor = p.to; sourceCursor = s.to;
    return { id: anchor.anchor_key, spanId: leaf[0]!.id, kind: anchor.boundary_kind,
      punctuationFrom: p.from, punctuationTo: p.to,
      from: s.from, to: s.to, quote: source.slice(s.from, s.to).join(""),
      text: punctuation.slice(p.from, p.to).join("") };
  });
  if (!isHanmunWhitespaceGap(punctuation, punctuationCursor, punctuation.length) || !isHanmunWhitespaceGap(source, sourceCursor, source.length)) return invalid();
  let cursor = 0;
  const marked = segments.map(segment => {
    const text = punctuation.slice(cursor, segment.punctuationFrom).join("") + `[${segment.id}]${segment.text}[/${segment.id}]`;
    cursor = segment.punctuationTo;
    return text;
  }).join("") + punctuation.slice(cursor).join("");
  return { punctuationVersionId: row.punctuationVersionId, anchorSetId: row.anchorSetId, segments, marked };
}
