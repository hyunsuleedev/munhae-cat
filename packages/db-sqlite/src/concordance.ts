import { loadContent, projectContent } from "./translation-content.ts";
import { MunhaeError } from "@munhae/domain";
import { and, desc, eq, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { orm } from "./drizzle-db.ts";
import { schema as tables } from "./drizzle-schema.ts";
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
  translation_text: string | null; is_current: number; is_confirmed: number | null;
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
  const {
    document_nodes: nodes,
    document_translations: translations,
    document_translation_heads: translationHeads,
    document_translation_versions: translationVersions,
    src_texts: sourceTexts,
    src_text_heads: sourceHeads,
    src_text_versions: sourceVersions,
    translation_text_layouts: layouts,
  } = tables;
  const child = alias(nodes, "child");
  const branches = orm(db)
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(
      and(
        eq(nodes.project_id, projectId),
        isNull(nodes.parent_node_id),
        isNull(nodes.archived_at),
      ),
    )
    .unionAll(
      orm(db)
        .select({ id: child.id, title: child.title })
        .from(child)
        .innerJoin(
          sql`visible_branch`,
          eq(child.parent_node_id, sql<string>`visible_branch.id`),
        )
        .where(and(eq(child.project_id, projectId), isNull(child.archived_at))),
    );
  // Drizzle's CTE builder does not expose WITH RECURSIVE. Keep that SQLite
  // construct as a fragment while schema columns and project values stay bound.
  const visibleNodes = orm(db).$with("visible_nodes", {
    id: nodes.id,
    title: nodes.title,
  }).as(sql`
      WITH RECURSIVE visible_branch(id, title) AS (${branches.getSQL()})
      SELECT id, title FROM visible_branch
    `);
  const translationHead = state === "confirmed" ? translationHeads.confirmed_version_id : translationHeads.current_version_id;
  const sourceHead = state === "confirmed" ? sourceHeads.confirmed_version_id : sourceHeads.current_version_id;
  const translationConfirmed = sql<number | null>`${translationVersions.id} = ${translationHeads.confirmed_version_id}`;
  const sourceConfirmed = sql<number | null>`${sourceVersions.id} = ${sourceHeads.confirmed_version_id}`;
  const translationQuery = orm(db)
    .with(visibleNodes)
    .select({
      document_node_id: sql<string>`${visibleNodes.id}`.as("document_node_id"),
      title: sql<string>`${visibleNodes.title}`.as("title"),
      source_id: sql<string>`${sourceVersions.id}`.as("source_id"),
      source_no: sql<number>`${sourceVersions.version_no}`.as("source_no"),
      source_text: sql<string>`${sourceVersions.content_text}`.as("source_text"),
      source_current:
        sql<number>`${sourceVersions.id} = ${sourceHeads.current_version_id}`.as(
          "source_current",
        ),
      translation_id: sql<string>`${translationVersions.id}`.as("translation_id"),
      translation_no: sql<number>`${translationVersions.version_no}`.as(
        "translation_no",
      ),
      translation_state: sql<string>`${translationVersions.state}`.as(
        "translation_state",
      ),
      translation_text: sql<string>`${translationVersions.text_content}`.as(
        "translation_text",
      ),
      is_current:
        sql<number>`${translationVersions.id} = ${translationHeads.current_version_id}`.as(
          "is_current",
        ),
      is_confirmed: translationConfirmed.as("is_confirmed"),
      sentences_json: sql<string | null>`${layouts.sentences_json}`.as(
        "sentences_json",
      ),
      links_json: sql<string | null>`${layouts.links_json}`.as("links_json"),
    })
    .from(translations)
    .innerJoin(visibleNodes, eq(visibleNodes.id, translations.document_node_id))
    .innerJoin(
      translationHeads,
      eq(translationHeads.document_translation_id, translations.id),
    )
    .innerJoin(translationVersions, eq(translationVersions.id, translationHead))
    .innerJoin(
      sourceVersions,
      eq(sourceVersions.id, translationVersions.source_text_version_id),
    )
    .innerJoin(
      sourceTexts,
      and(
        eq(sourceTexts.id, sourceVersions.source_text_id),
        eq(sourceTexts.project_id, projectId),
        isNull(sourceTexts.tombstoned_at),
      ),
    )
    .innerJoin(sourceHeads, eq(sourceHeads.source_text_id, sourceTexts.id))
    .leftJoin(layouts, eq(layouts.version_id, translationVersions.id))
    .where(
      and(
        eq(translations.project_id, projectId),
        isNull(translations.tombstoned_at),
        input.documentNodeId == null
          ? undefined
          : eq(visibleNodes.id, input.documentNodeId),
        or(
          scope !== "translation"
            ? sql`instr(${sourceVersions.content_text}, ${query}) > 0`
            : undefined,
          scope !== "source"
            ? sql`instr(${translationVersions.text_content}, ${query}) > 0`
            : undefined,
        ),
      ),
    )
    .orderBy(
      desc(translationConfirmed),
      visibleNodes.title,
      visibleNodes.id,
      translationVersions.id,
    );
  const sourceQuery = orm(db)
    .with(visibleNodes)
    .select({
      document_node_id: sql<string>`${visibleNodes.id}`.as("document_node_id"),
      title: sql<string>`${visibleNodes.title}`.as("title"),
      source_id: sql<string>`${sourceVersions.id}`.as("source_id"),
      source_no: sql<number>`${sourceVersions.version_no}`.as("source_no"),
      source_text: sql<string>`${sourceVersions.content_text}`.as("source_text"),
      source_current:
        sql<number>`${sourceVersions.id} = ${sourceHeads.current_version_id}`.as(
          "source_current",
        ),
      translation_id: sql<null>`NULL`.as("translation_id"),
      translation_no: sql<null>`NULL`.as("translation_no"),
      translation_state: sql<null>`NULL`.as("translation_state"),
      translation_text: sql<null>`NULL`.as("translation_text"),
      is_current:
        sql<number>`${sourceVersions.id} = ${sourceHeads.current_version_id}`.as(
          "is_current",
        ),
      is_confirmed: sourceConfirmed.as("is_confirmed"),
      sentences_json: sql<null>`NULL`.as("sentences_json"),
      links_json: sql<null>`NULL`.as("links_json"),
    })
    .from(sourceTexts)
    .innerJoin(visibleNodes, eq(visibleNodes.id, sourceTexts.document_node_id))
    .innerJoin(sourceHeads, eq(sourceHeads.source_text_id, sourceTexts.id))
    .innerJoin(sourceVersions, eq(sourceVersions.id, sourceHead))
    .where(
      and(
        eq(sourceTexts.project_id, projectId),
        isNull(sourceTexts.tombstoned_at),
        input.documentNodeId == null
          ? undefined
          : eq(visibleNodes.id, input.documentNodeId),
        sql`instr(${sourceVersions.content_text}, ${query}) > 0`,
        notExists(
          orm(db)
            .select({ present: sql`1` })
            .from(translations)
            .innerJoin(
              translationHeads,
              eq(translationHeads.document_translation_id, translations.id),
            )
            .innerJoin(
              translationVersions,
              eq(translationVersions.id, translationHead),
            )
            .where(
              and(
                eq(translations.document_node_id, visibleNodes.id),
                eq(translations.project_id, projectId),
                isNull(translations.tombstoned_at),
                eq(translationVersions.source_text_version_id, sourceVersions.id),
              ),
            ),
        ),
      ),
    )
    .orderBy(
      desc(sourceConfirmed),
      visibleNodes.title,
      visibleNodes.id,
      sourceVersions.id,
    );
  const results: ConcordanceResult[] = [];
  for (const selection of scope === "translation" ? [translationQuery] : [translationQuery, sourceQuery]) {
    const statement = selection.toSQL();
    // Drizzle's better-sqlite3 driver has no iterator API. Stream the typed,
    // parameterized query through the same connection instead of loading every
    // matching document before the result limit can stop the search.
    for (const row of db.prepare(statement.sql).iterate(...statement.params) as Iterable<Row>) {
      const content = row.translation_id ? loadContent(db, row.translation_id) : null;
      if (content) {
        const projected = projectContent(content, { state: "ready", error: null });
        row.sentences_json = JSON.stringify(projected.sentences); row.links_json = JSON.stringify(projected.links);
      }
      for (const result of pairs(row, query, scope)) {
        if (results.length === limit) return { query, scope, state, results, hasMore: true };
        results.push(result);
      }
    }
  }
  return { query, scope, state, results, hasMore: false };
}
