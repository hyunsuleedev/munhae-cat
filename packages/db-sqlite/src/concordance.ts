import { MunhaeError } from "@munhae/domain";
import type { SqliteDb } from "./sqlite.ts";

export type ConcordanceInput = {
  query: string;
  scope?: "all" | "source" | "translation";
  state?: "current" | "confirmed";
  documentNodeId?: string | null;
  limit?: number;
};
export type ConcordanceResult = {
  id: string;
  documentNodeId: string;
  documentTitle: string;
  sourceVersionId: string;
  sourceVersionNo: number;
  translationVersionId: string | null;
  translationVersionNo: number | null;
  translationState: string | null;
  isCurrent: boolean;
  isConfirmed: boolean;
  sourceIsCurrent: boolean;
  contextKind: "sentence" | "document";
  alignment: "human" | "auto" | "unlinked";
  needsReview: boolean;
  sentenceId: string | null;
  sourceText: string;
  translationText: string | null;
  matchedIn: Array<"source" | "translation">;
};
export type ConcordanceView = {
  query: string;
  scope: "all" | "source" | "translation";
  state: "current" | "confirmed";
  results: ConcordanceResult[];
  hasMore: boolean;
};

type Row = {
  document_node_id: string; title: string;
  source_id: string; source_no: number; source_text: string; source_current: number;
  translation_id: string | null; translation_no: number | null; translation_state: string | null;
  translation_text: string | null; is_current: number; is_confirmed: number;
  sentences_json: string | null; links_json: string | null;
};
type Span = { from: number; to: number; quote: string };
type Sentence = { id: string; from: number; to: number; text: string };
type Link = { sentenceId: string; spans: Span[]; needsReview: boolean; reviewedBy?: "human" };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const range = (value: Record<string, unknown>, points: string[], field: "quote" | "text"): boolean =>
  Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to)
  && (value.from as number) >= 0 && (value.to as number) > (value.from as number) && (value.to as number) <= points.length
  && typeof value[field] === "string" && points.slice(value.from as number, value.to as number).join("") === value[field];

/** True when at least one literal occurrence has no complete recorded range. */
function hasUncoveredMatch(text: string, query: string, spans: Array<{ from: number; to: number }>): boolean {
  const ordered = [...spans].sort((a, b) => a.from - b.from);
  const queryLength = Array.from(query).length;
  let utf16 = 0, points = 0, rangeIndex = 0, maxEnd = -1;
  for (let index = text.indexOf(query); index >= 0; index = text.indexOf(query, index + 1)) {
    points += Array.from(text.slice(utf16, index)).length;
    utf16 = index;
    while (rangeIndex < ordered.length && ordered[rangeIndex]!.from <= points) {
      maxEnd = Math.max(maxEnd, ordered[rangeIndex++]!.to);
    }
    if (maxEnd < points + queryLength) return true;
  }
  return false;
}

function* pairs(row: Row, query: string, scope: ConcordanceView["scope"]): Generator<ConcordanceResult> {
  const base = {
    documentNodeId: row.document_node_id, documentTitle: row.title,
    sourceVersionId: row.source_id, sourceVersionNo: row.source_no,
    translationVersionId: row.translation_id, translationVersionNo: row.translation_no,
    translationState: row.translation_state, isCurrent: !!row.is_current,
    isConfirmed: !!row.is_confirmed, sourceIsCurrent: !!row.source_current,
  };
  const matches = (source: string, target: string | null): ConcordanceResult["matchedIn"] => [
    ...(scope !== "translation" && source.includes(query) ? ["source" as const] : []),
    ...(scope !== "source" && target?.includes(query) ? ["translation" as const] : []),
  ];
  const coveredSource: Span[] = [], coveredTranslation: Sentence[] = [];
  let sentences: unknown, links: unknown;
  try { sentences = JSON.parse(row.sentences_json ?? "null"); links = JSON.parse(row.links_json ?? "null"); } catch { /* Damaged metadata is context, never an inferred pair. */ }
  if (Array.isArray(sentences) && Array.isArray(links) && row.translation_text !== null) {
    const sourcePoints = Array.from(row.source_text), targetPoints = Array.from(row.translation_text);
    const linksById = new Map<string, unknown[]>();
    for (const link of links) if (object(link) && typeof link.sentenceId === "string") {
      const previous = linksById.get(link.sentenceId) ?? [];
      previous.push(link); linksById.set(link.sentenceId, previous);
    }
    const ids = new Set<string>();
    const duplicatedIds = new Set<string>();
    for (const sentence of sentences) if (object(sentence) && typeof sentence.id === "string") {
      if (ids.has(sentence.id)) duplicatedIds.add(sentence.id);
      ids.add(sentence.id);
    }
    for (const value of sentences) {
      if (!object(value) || typeof value.id !== "string" || duplicatedIds.has(value.id) || !range(value, targetPoints, "text")) continue;
      const candidates = linksById.get(value.id);
      const candidate = candidates?.length === 1 ? candidates[0] : null;
      if (!object(candidate) || !Array.isArray(candidate.spans) || !candidate.spans.length
        || !candidate.spans.every((span) => object(span) && range(span, sourcePoints, "quote"))) continue;
      const sentence = value as unknown as Sentence;
      const link = candidate as unknown as Link;
      coveredSource.push(...link.spans); coveredTranslation.push(sentence);
      // A visible ellipsis represents discontiguous recorded spans; it is not searched as invented text.
      const matchedIn = matches("", sentence.text);
      if (scope !== "translation" && link.spans.some((span) => span.quote.includes(query))) matchedIn.unshift("source");
      if (!matchedIn.length) continue;
      yield { ...base, id: `${row.translation_id}:${sentence.id}`, contextKind: "sentence",
        alignment: link.reviewedBy === "human" ? "human" : "auto", needsReview: link.needsReview !== false,
        sentenceId: sentence.id, sourceText: link.spans.map((span) => span.quote).join(" … "), translationText: sentence.text, matchedIn };
    }
  }
  const outsideSource = scope !== "translation" && hasUncoveredMatch(row.source_text, query, coveredSource);
  const outsideTarget = scope !== "source" && row.translation_text !== null && hasUncoveredMatch(row.translation_text, query, coveredTranslation);
  if (outsideSource || outsideTarget) yield { ...base, id: `${row.translation_id ?? row.source_id}:context`,
    contextKind: "document", alignment: "unlinked", needsReview: true, sentenceId: null,
    sourceText: row.source_text, translationText: row.translation_text, matchedIn: matches(row.source_text, row.translation_text) };
}

/** Read exact ledger text without rebuilding the general search index or guessing alignment. */
export function searchConcordance(db: SqliteDb, projectId: string, input: ConcordanceInput): ConcordanceView {
  if (!object(input) || typeof input.query !== "string") throw new MunhaeError("invalid_search", "검색어를 입력하세요");
  const query = input.query.trim();
  if (!query || Array.from(query).length > 100 || /[\u0000-\u001f\u007f]/u.test(query)
    || Array.from(query).some((ch) => /^[\ud800-\udfff]$/u.test(ch)))
    throw new MunhaeError("invalid_search", "검색어는 줄바꿈 없이 1~100자로 입력하세요");
  const scope = input.scope ?? "all", state = input.state ?? "current", limit = input.limit ?? 50;
  if (!["all", "source", "translation"].includes(scope) || !["current", "confirmed"].includes(state)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || (input.documentNodeId != null && (typeof input.documentNodeId !== "string" || !input.documentNodeId || input.documentNodeId.length > 100)))
    throw new MunhaeError("invalid_search", "검색 범위와 결과 수를 확인하세요");
  const head = state === "confirmed" ? "confirmed_version_id" : "current_version_id";
  const common = `WITH RECURSIVE visible_nodes(id,title) AS (
    SELECT id,title FROM document_nodes WHERE project_id=@projectId AND parent_node_id IS NULL AND archived_at IS NULL
    UNION ALL SELECT n.id,n.title FROM document_nodes n JOIN visible_nodes p ON p.id=n.parent_node_id
    WHERE n.project_id=@projectId AND n.archived_at IS NULL
  )`;
  const translationSql = `${common}
    SELECT n.id AS document_node_id,n.title,s.id AS source_id,s.version_no AS source_no,s.content_text AS source_text,
      s.id=sh.current_version_id AS source_current,v.id AS translation_id,v.version_no AS translation_no,
      v.state AS translation_state,v.text_content AS translation_text,v.id=h.current_version_id AS is_current,
      v.id=h.confirmed_version_id AS is_confirmed,l.sentences_json,l.links_json
    FROM document_translations t JOIN visible_nodes n ON n.id=t.document_node_id
    JOIN document_translation_heads h ON h.document_translation_id=t.id
    JOIN document_translation_versions v ON v.id=h.${head}
    JOIN src_text_versions s ON s.id=v.source_text_version_id
    JOIN src_texts st ON st.id=s.source_text_id AND st.project_id=@projectId AND st.tombstoned_at IS NULL
    JOIN src_text_heads sh ON sh.source_text_id=st.id
    LEFT JOIN translation_text_layouts l ON l.version_id=v.id
    WHERE t.project_id=@projectId AND t.tombstoned_at IS NULL
      AND (@documentNodeId IS NULL OR n.id=@documentNodeId)
      AND ((@scope<>'translation' AND instr(s.content_text,@query)>0) OR (@scope<>'source' AND instr(v.text_content,@query)>0))
    ORDER BY is_confirmed DESC,n.title,n.id,v.id`;
  const sourceSql = `${common}
    SELECT n.id AS document_node_id,n.title,s.id AS source_id,s.version_no AS source_no,s.content_text AS source_text,
      s.id=h.current_version_id AS source_current,NULL AS translation_id,NULL AS translation_no,NULL AS translation_state,
      NULL AS translation_text,s.id=h.current_version_id AS is_current,s.id=h.confirmed_version_id AS is_confirmed,
      NULL AS sentences_json,NULL AS links_json
    FROM src_texts st JOIN visible_nodes n ON n.id=st.document_node_id
    JOIN src_text_heads h ON h.source_text_id=st.id JOIN src_text_versions s ON s.id=h.${head}
    WHERE st.project_id=@projectId AND st.tombstoned_at IS NULL AND @scope<>'translation'
      AND (@documentNodeId IS NULL OR n.id=@documentNodeId) AND instr(s.content_text,@query)>0
      AND NOT EXISTS (SELECT 1 FROM document_translations t JOIN document_translation_heads th ON th.document_translation_id=t.id
        JOIN document_translation_versions v ON v.id=th.${head}
        WHERE t.document_node_id=n.id AND t.project_id=@projectId AND t.tombstoned_at IS NULL AND v.source_text_version_id=s.id)
    ORDER BY is_confirmed DESC,n.title,n.id,s.id`;
  const params = { projectId, query, scope, documentNodeId: input.documentNodeId ?? null };
  const results: ConcordanceResult[] = [];
  for (const sql of [translationSql, sourceSql]) {
    for (const row of db.prepare(sql).iterate(params) as Iterable<Row>) {
      for (const result of pairs(row, query, scope)) {
        if (results.length === limit) return { query, scope, state, results, hasMore: true };
        results.push(result);
      }
    }
  }
  return { query, scope, state, results, hasMore: false };
}
