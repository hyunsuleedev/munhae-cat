import { loadContent, projectContent } from "./translation-content.ts";
import {
  canonicalJson,
  MunhaeError,
  nowIso,
  sha256Hex,
  sliceCodepoints,
} from "@munhae/domain";
import { and, asc, count, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { orm } from "./drizzle-db.ts";
import { schema } from "./drizzle-schema.ts";
import type { SqliteDb } from "./sqlite.ts";

const {
  document_nodes: nodes,
  core_projects: projects,
  core_actors: actors,
  core_translation_policy_versions: policyVersions,
  src_texts: sources,
  src_text_heads: sourceHeads,
  src_text_versions: sourceVersions,
  punctuation_sets: punctuationSets,
  punctuation_heads: punctuationHeads,
  punctuation_versions: punctuationVersions,
  punctuation_structure_spans: structureSpans,
  document_translations: translations,
  document_translation_heads: translationHeads,
  document_translation_versions: translationVersions,
  translation_blocks: translationBlocks,
  translation_block_anchors: blockAnchors,
  translation_anchors: anchors,
  translation_anchor_sets: anchorSets,
  translation_text_layouts: layouts,
  terms: projectTerms,
} = schema;

export type VersionHistoryKind = "source" | "punctuation" | "translation";

export type HistoryAnchorLink = {
  anchorId: string;
  anchorKey: string;
  ordinal: number;
  relationKind: string;
  boundaryKind: string;
  sourceCodepointFrom: number;
  sourceCodepointTo: number;
  sourceQuote: string;
  sourceQuoteHash: string;
  punctuationCodepointFrom: number;
  punctuationCodepointTo: number;
  punctuatedQuote: string;
  punctuatedQuoteHash: string;
};

export type HistoryBlock = {
  blockKey: string;
  ordinal: number;
  blockKind: string;
  translation: string;
  targetHash: string;
  validationState: "valid" | "needs_review";
  anchors: HistoryAnchorLink[];
};

export type VersionHistoryEntry = {
  kind: VersionHistoryKind;
  aggregateId: string;
  stage: string | null;
  versionId: string;
  parentVersionId: string | null;
  versionNo: number;
  state: "draft" | "confirmed" | "rejected" | "superseded";
  isCurrent: boolean;
  isConfirmed: boolean;
  contentHash: string;
  contentText: string;
  createdAt: string;
  createdBy: string;
  originKind: string;
  validationState: "valid" | "needs_review" | null;
  sourceTextVersionId: string | null;
  sourceTextHash: string | null;
  punctuationVersionId: string | null;
  punctuationHash: string | null;
  anchorSetId: string | null;
  anchorSetHash: string | null;
  translationPolicyVersionId: string | null;
  translationPolicyHash: string | null;
  structureJson: string | null;
  structureSpanCount: number;
  blocks: HistoryBlock[];
};

export type DocumentHistoryView = {
  documentNodeId: string;
  documentTitle: string;
  entries: VersionHistoryEntry[];
};

export type VersionDiffInput = {
  documentNodeId: string;
  kind: VersionHistoryKind;
  stage?: string | null;
  baseVersionId: string;
  targetVersionId: string;
};

export type VersionDiffChunk = {
  type: "equal" | "remove" | "add";
  text: string;
};

export type VersionDiffView = {
  kind: VersionHistoryKind;
  stage: string | null;
  aggregateId: string;
  base: Pick<VersionHistoryEntry, "versionId" | "versionNo" | "contentHash" | "state">;
  target: Pick<VersionHistoryEntry, "versionId" | "versionNo" | "contentHash" | "state">;
  chunks: VersionDiffChunk[];
};

export type ConfirmedExportFormat = "markdown" | "json" | "csv";

export type ConfirmedExportInput = {
  format: ConfirmedExportFormat;
  documentNodeId?: string | null;
};

export type ConfirmedExportPayload = {
  format: ConfirmedExportFormat;
  mediaType: string;
  extension: "md" | "json" | "csv";
  suggestedBaseName: string;
  confirmedTranslationCount: number;
  manifestHash: string;
  content: string;
};

export type SearchScope = "all" | "source" | "translation";
export type SearchState = "current" | "confirmed" | "all";
export type SearchEntityType = "term";

export type SearchEntityFilterInput = {
  entityType: SearchEntityType;
  entityId: string;
};

export type ResolvedSearchEntityFilter = SearchEntityFilterInput & {
  label: string;
  terms: string[];
};

export type SearchQueryInput = {
  query: string;
  scope?: SearchScope;
  state?: SearchState;
  documentNodeId?: string | null;
  entityFilter?: SearchEntityFilterInput | null;
  limit?: number;
};

export type SearchResult = {
  resultKind: "source" | "translation";
  documentNodeId: string;
  documentTitle: string;
  aggregateId: string;
  versionId: string;
  versionNo: number;
  contentHash: string;
  stage: string | null;
  state: string;
  isCurrent: boolean;
  isConfirmed: boolean;
  matchKind: "exact" | "prefix" | "fts";
  snippet: string;
};

export type SearchView = {
  query: string;
  scope: SearchScope;
  state: SearchState;
  entityFilter: ResolvedSearchEntityFilter | null;
  usedShortHanPrefix: boolean;
  rebuiltFromLedger: true;
  results: SearchResult[];
};

type BaseHistoryRow = {
  kind: VersionHistoryKind;
  aggregate_id: string;
  stage: string | null;
  version_id: string;
  parent_version_id: string | null;
  version_no: number;
  state: VersionHistoryEntry["state"];
  current_version_id: string;
  confirmed_version_id: string | null;
  content_hash: string;
  content_text: string;
  created_at: string;
  created_by: string;
  origin_kind: string;
  validation_state: "valid" | "needs_review" | null;
  source_text_version_id: string | null;
  source_text_hash: string | null;
  punctuation_version_id: string | null;
  punctuation_hash: string | null;
  anchor_set_id: string | null;
  anchor_set_hash: string | null;
  translation_policy_version_id: string | null;
  translation_policy_hash: string | null;
  structure_json: string | null;
  structure_span_count: number;
};

function requireSourceUnit(db: SqliteDb, projectId: string, documentNodeId: string): { title: string } {
  const row = orm(db).select({ title: nodes.title, node_role: nodes.node_role }).from(nodes)
    .where(and(eq(nodes.id, documentNodeId), eq(nodes.project_id, projectId), isNull(nodes.archived_at))).get();
  if (!row) throw new MunhaeError("not_found", "문서를 찾을 수 없습니다");
  if (row.node_role !== "source_unit") {
    throw new MunhaeError("invalid_document", "원문 작업 단위만 이력·검색 범위로 선택할 수 있습니다");
  }
  return { title: row.title };
}

function loadHistoryBlocks(db: SqliteDb, versionId: string): HistoryBlock[] {
  const blocks = orm(db).select({
    id: translationBlocks.id, block_key: translationBlocks.block_key, ordinal: translationBlocks.ordinal,
    block_kind: translationBlocks.block_kind, target_codepoint_from: translationBlocks.target_codepoint_from,
    target_codepoint_to: translationBlocks.target_codepoint_to, target_hash: translationBlocks.target_hash,
    validation_state: translationBlocks.validation_state, text_content: translationVersions.text_content,
  }).from(translationBlocks)
    .innerJoin(translationVersions, eq(translationVersions.id, translationBlocks.document_translation_version_id))
    .where(eq(translationBlocks.document_translation_version_id, versionId)).orderBy(asc(translationBlocks.ordinal)).all();
  if (!blocks.length) {
    const full = orm(db).select({ text_content: translationVersions.text_content, content_hash: translationVersions.content_hash,
      validation_state: translationVersions.validation_state }).from(translationVersions)
      .innerJoin(layouts, eq(layouts.version_id, translationVersions.id)).where(eq(translationVersions.id, versionId)).get();
    if(full) return [{blockKey:"text",ordinal:1,blockKind:"text",translation:full.text_content,targetHash:full.content_hash,validationState:full.validation_state,anchors:[]}];
  }
  return blocks.map((block) => ({
    blockKey: block.block_key,
    ordinal: block.ordinal,
    blockKind: block.block_kind,
    translation: sliceCodepoints(block.text_content, block.target_codepoint_from, block.target_codepoint_to),
    targetHash: block.target_hash,
    validationState: block.validation_state,
    anchors: orm(db).select({
      anchor_id: anchors.id, anchor_key: anchors.anchor_key, ordinal: blockAnchors.ordinal,
      relation_kind: blockAnchors.relation_kind, boundary_kind: anchors.boundary_kind,
      source_codepoint_from: anchors.source_codepoint_from, source_codepoint_to: anchors.source_codepoint_to,
      source_quote: anchors.source_quote, source_quote_hash: anchors.source_quote_hash,
      punctuation_codepoint_from: anchors.punctuation_codepoint_from, punctuation_codepoint_to: anchors.punctuation_codepoint_to,
      punctuated_quote: anchors.punctuated_quote, punctuated_quote_hash: anchors.punctuated_quote_hash,
    }).from(blockAnchors).innerJoin(anchors, eq(anchors.id, blockAnchors.translation_anchor_id))
      .where(eq(blockAnchors.translation_block_id, block.id)).orderBy(asc(blockAnchors.ordinal)).all().map((anchor) => ({
      anchorId: anchor.anchor_id,
      anchorKey: anchor.anchor_key,
      ordinal: anchor.ordinal,
      relationKind: anchor.relation_kind,
      boundaryKind: anchor.boundary_kind,
      sourceCodepointFrom: anchor.source_codepoint_from,
      sourceCodepointTo: anchor.source_codepoint_to,
      sourceQuote: anchor.source_quote,
      sourceQuoteHash: anchor.source_quote_hash,
      punctuationCodepointFrom: anchor.punctuation_codepoint_from,
      punctuationCodepointTo: anchor.punctuation_codepoint_to,
      punctuatedQuote: anchor.punctuated_quote,
      punctuatedQuoteHash: anchor.punctuated_quote_hash,
    })),
  }));
}

function toHistoryEntry(db: SqliteDb, row: BaseHistoryRow): VersionHistoryEntry {
  return {
    kind: row.kind,
    aggregateId: row.aggregate_id,
    stage: row.stage,
    versionId: row.version_id,
    parentVersionId: row.parent_version_id,
    versionNo: row.version_no,
    state: row.state,
    isCurrent: row.current_version_id === row.version_id,
    isConfirmed: row.confirmed_version_id === row.version_id,
    contentHash: row.content_hash,
    contentText: row.content_text,
    createdAt: row.created_at,
    createdBy: row.created_by,
    originKind: row.origin_kind,
    validationState: row.validation_state,
    sourceTextVersionId: row.source_text_version_id,
    sourceTextHash: row.source_text_hash,
    punctuationVersionId: row.punctuation_version_id,
    punctuationHash: row.punctuation_hash,
    anchorSetId: row.anchor_set_id,
    anchorSetHash: row.anchor_set_hash,
    translationPolicyVersionId: row.translation_policy_version_id,
    translationPolicyHash: row.translation_policy_hash,
    structureJson: row.structure_json,
    structureSpanCount: row.structure_span_count,
    blocks: row.kind === "translation" ? loadHistoryBlocks(db, row.version_id) : [],
  };
}

export function loadDocumentHistory(
  db: SqliteDb,
  projectId: string,
  documentNodeId: string,
): DocumentHistoryView {
  const document = requireSourceUnit(db, projectId, documentNodeId);
  const sourceRows = orm(db).select({
    kind: sql<"source">`'source'`, aggregate_id: sources.id, stage: sql<null>`NULL`, version_id: sourceVersions.id,
    parent_version_id: sourceVersions.parent_version_id, version_no: sourceVersions.version_no, state: sourceVersions.state,
    current_version_id: sourceHeads.current_version_id, confirmed_version_id: sourceHeads.confirmed_version_id,
    content_hash: sourceVersions.content_hash, content_text: sourceVersions.content_text, created_at: sourceVersions.created_at,
    created_by: actors.display_name, origin_kind: sourceVersions.origin_kind,
    validation_state: sql<null>`NULL`, source_text_version_id: sourceVersions.id, source_text_hash: sourceVersions.content_hash,
    punctuation_version_id: sql<null>`NULL`, punctuation_hash: sql<null>`NULL`,
    anchor_set_id: sql<null>`NULL`, anchor_set_hash: sql<null>`NULL`,
    translation_policy_version_id: sql<null>`NULL`, translation_policy_hash: sql<null>`NULL`,
    structure_json: sql<null>`NULL`, structure_span_count: sql<number>`0`,
  }).from(sources).innerJoin(sourceHeads, eq(sourceHeads.source_text_id, sources.id))
    .innerJoin(sourceVersions, eq(sourceVersions.source_text_id, sources.id))
    .innerJoin(actors, eq(actors.id, sourceVersions.created_by_actor_id))
    .where(and(eq(sources.project_id, projectId), eq(sources.document_node_id, documentNodeId), isNull(sources.tombstoned_at)))
    .orderBy(desc(sourceVersions.version_no), desc(sourceVersions.created_at)).all();
  const punctuationRows = orm(db).select({
    kind: sql<"punctuation">`'punctuation'`, aggregate_id: punctuationSets.id, stage: sql<null>`NULL`, version_id: punctuationVersions.id,
    parent_version_id: punctuationVersions.parent_version_id, version_no: punctuationVersions.version_no, state: punctuationVersions.state,
    current_version_id: punctuationHeads.current_version_id, confirmed_version_id: punctuationHeads.confirmed_version_id,
    content_hash: punctuationVersions.content_hash, content_text: punctuationVersions.punctuated_text,
    created_at: punctuationVersions.created_at, created_by: actors.display_name, origin_kind: sql<string>`'punctuation'`,
    validation_state: sql<null>`NULL`, source_text_version_id: punctuationVersions.source_text_version_id,
    source_text_hash: sourceVersions.content_hash, punctuation_version_id: punctuationVersions.id, punctuation_hash: punctuationVersions.content_hash,
    anchor_set_id: sql<string | null>`(${orm(db).select({ id: anchorSets.id }).from(anchorSets)
      .where(eq(anchorSets.punctuation_version_id, punctuationVersions.id)).orderBy(desc(anchorSets.created_at)).limit(1)})`,
    anchor_set_hash: sql<string | null>`(${orm(db).select({ hash: anchorSets.anchor_set_hash }).from(anchorSets)
      .where(eq(anchorSets.punctuation_version_id, punctuationVersions.id)).orderBy(desc(anchorSets.created_at)).limit(1)})`,
    translation_policy_version_id: sql<null>`NULL`, translation_policy_hash: sql<null>`NULL`,
    structure_json: punctuationVersions.structure_json,
    structure_span_count: sql<number>`(${orm(db).select({ count: count() }).from(structureSpans)
      .where(eq(structureSpans.punctuation_version_id, punctuationVersions.id))})`,
  }).from(sources).innerJoin(punctuationSets, eq(punctuationSets.source_text_id, sources.id))
    .innerJoin(punctuationHeads, eq(punctuationHeads.punctuation_set_id, punctuationSets.id))
    .innerJoin(punctuationVersions, eq(punctuationVersions.punctuation_set_id, punctuationSets.id))
    .innerJoin(sourceVersions, eq(sourceVersions.id, punctuationVersions.source_text_version_id))
    .innerJoin(actors, eq(actors.id, punctuationVersions.created_by_actor_id))
    .where(and(eq(sources.project_id, projectId), eq(sources.document_node_id, documentNodeId), isNull(sources.tombstoned_at)))
    .orderBy(desc(punctuationSets.created_at), desc(punctuationVersions.version_no), desc(punctuationVersions.created_at)).all();
  const translationRows = orm(db).select({
    kind: sql<"translation">`'translation'`, aggregate_id: translations.id, stage: sql<string>`'translation'`, version_id: translationVersions.id,
    parent_version_id: translationVersions.parent_version_id, version_no: translationVersions.version_no, state: translationVersions.state,
    current_version_id: translationHeads.current_version_id, confirmed_version_id: translationHeads.confirmed_version_id,
    content_hash: translationVersions.content_hash, content_text: translationVersions.text_content, created_at: translationVersions.created_at,
    created_by: actors.display_name, origin_kind: translationVersions.origin_kind, validation_state: translationVersions.validation_state,
    source_text_version_id: translationVersions.source_text_version_id, source_text_hash: sourceVersions.content_hash,
    punctuation_version_id: translationVersions.punctuation_version_id, punctuation_hash: punctuationVersions.content_hash,
    anchor_set_id: translationVersions.translation_anchor_set_id, anchor_set_hash: anchorSets.anchor_set_hash,
    translation_policy_version_id: translationVersions.translation_policy_version_id, translation_policy_hash: policyVersions.content_hash,
    structure_json: sql<null>`NULL`, structure_span_count: sql<number>`0`,
  }).from(translations).innerJoin(translationHeads, eq(translationHeads.document_translation_id, translations.id))
    .innerJoin(translationVersions, eq(translationVersions.document_translation_id, translations.id))
    .innerJoin(sourceVersions, eq(sourceVersions.id, translationVersions.source_text_version_id))
    .leftJoin(punctuationVersions, eq(punctuationVersions.id, translationVersions.punctuation_version_id))
    .leftJoin(anchorSets, eq(anchorSets.id, translationVersions.translation_anchor_set_id))
    .innerJoin(policyVersions, eq(policyVersions.id, translationVersions.translation_policy_version_id))
    .innerJoin(actors, eq(actors.id, translationVersions.created_by_actor_id))
    .where(and(eq(translations.project_id, projectId), eq(translations.document_node_id, documentNodeId), isNull(translations.tombstoned_at)))
    .orderBy(desc(translationVersions.version_no), desc(translationVersions.created_at)).all();
  return {
    documentNodeId,
    documentTitle: document.title,
    entries: [...sourceRows, ...punctuationRows, ...translationRows].map((row) => toHistoryEntry(db, row)),
  };
}

function compactVersion(entry: VersionHistoryEntry): VersionDiffView["base"] {
  return {
    versionId: entry.versionId,
    versionNo: entry.versionNo,
    contentHash: entry.contentHash,
    state: entry.state,
  };
}

function diffChunks(before: string, after: string): VersionDiffChunk[] {
  if (before === after) return before ? [{ type: "equal", text: before }] : [];
  const a = Array.from(before);
  const b = Array.from(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1;
  const chunks: VersionDiffChunk[] = [];
  const commonBefore = a.slice(0, prefix).join("");
  const removed = a.slice(prefix, a.length - suffix).join("");
  const added = b.slice(prefix, b.length - suffix).join("");
  const commonAfter = suffix ? a.slice(a.length - suffix).join("") : "";
  if (commonBefore) chunks.push({ type: "equal", text: commonBefore });
  if (removed) chunks.push({ type: "remove", text: removed });
  if (added) chunks.push({ type: "add", text: added });
  if (commonAfter) chunks.push({ type: "equal", text: commonAfter });
  return chunks;
}

export function compareDocumentVersions(
  db: SqliteDb,
  projectId: string,
  input: VersionDiffInput,
): VersionDiffView {
  if (input.baseVersionId === input.targetVersionId) {
    throw new MunhaeError("invalid_diff", "서로 다른 두 버전을 선택하세요");
  }
  const history = loadDocumentHistory(db, projectId, input.documentNodeId);
  const base = history.entries.find((entry) => entry.versionId === input.baseVersionId && entry.kind === input.kind);
  const target = history.entries.find((entry) => entry.versionId === input.targetVersionId && entry.kind === input.kind);
  if (!base || !target) throw new MunhaeError("not_found", "비교할 버전을 이 문서에서 찾을 수 없습니다");
  if (base.aggregateId !== target.aggregateId) {
    throw new MunhaeError("different_lineage", "같은 변경 계보의 버전만 비교할 수 있습니다");
  }
  if (input.kind === "translation") {
    if (!input.stage || base.stage !== input.stage || target.stage !== input.stage || base.stage !== target.stage) {
      throw new MunhaeError("different_stage", "같은 번역 단계의 버전만 비교할 수 있습니다");
    }
  } else if (input.stage) {
    throw new MunhaeError("invalid_diff", "원문·표점 비교에는 번역 단계를 지정하지 않습니다");
  }
  return {
    kind: input.kind,
    stage: base.stage,
    aggregateId: base.aggregateId,
    base: compactVersion(base),
    target: compactVersion(target),
    chunks: diffChunks(base.contentText, target.contentText),
  };
}


type ExportDocument = {
  alignment?: { state: string; sentences: unknown[]; links: unknown[] };
  document: { id: string; title: string; originalTitle: string | null; path: string[] };
  stage: string;
  targetLocale: string;
  confirmedTranslation: { versionId: string; versionNo: number; contentHash: string; contentText: string; versionCreatedAt: string };
  source: { versionId: string; versionNo: number; contentHash: string; contentText: string };
  punctuation: { versionId: string | null; versionNo: number | null; contentHash: string | null; contentText: string | null };
  anchorSet: { id: string | null; contentHash: string | null };
  translationPolicy: { versionId: string; contentHash: string };
  blocks: HistoryBlock[];
};

function documentPaths(db: SqliteDb, projectId: string): Map<string, string[]> {
  const rows = orm(db).select({ id: nodes.id, parent_node_id: nodes.parent_node_id, title: nodes.title }).from(nodes)
    .where(and(eq(nodes.project_id, projectId), isNull(nodes.archived_at))).all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: typeof row | undefined = row;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.unshift(current.title);
      current = current.parent_node_id ? byId.get(current.parent_node_id) : undefined;
    }
    result.set(row.id, path);
  }
  return result;
}

function loadConfirmedExportDocuments(db: SqliteDb, projectId: string, documentNodeId?: string | null): ExportDocument[] {
  if (documentNodeId) requireSourceUnit(db, projectId, documentNodeId);
  const rows = orm(db).select({
    document_node_id: nodes.id, title: nodes.title, original_title: nodes.original_title,
    stage: sql<string>`'translation'`, target_locale: translations.target_locale,
    translation_version_id: translationVersions.id, translation_version_no: translationVersions.version_no,
    translation_hash: translationVersions.content_hash, translation_text: translationVersions.text_content,
    source_version_id: sourceVersions.id, source_version_no: sourceVersions.version_no,
    source_hash: sourceVersions.content_hash, source_text: sourceVersions.content_text,
    punctuation_version_id: punctuationVersions.id, punctuation_version_no: punctuationVersions.version_no,
    punctuation_hash: punctuationVersions.content_hash, punctuation_text: punctuationVersions.punctuated_text,
    anchor_set_id: anchorSets.id, anchor_set_hash: anchorSets.anchor_set_hash,
    policy_version_id: policyVersions.id, policy_hash: policyVersions.content_hash, version_created_at: translationVersions.created_at,
  }).from(translationHeads).innerJoin(translations, eq(translations.id, translationHeads.document_translation_id))
    .innerJoin(translationVersions, eq(translationVersions.id, translationHeads.confirmed_version_id))
    .innerJoin(nodes, eq(nodes.id, translations.document_node_id))
    .innerJoin(sourceVersions, eq(sourceVersions.id, translationVersions.source_text_version_id))
    .leftJoin(punctuationVersions, eq(punctuationVersions.id, translationVersions.punctuation_version_id))
    .leftJoin(anchorSets, eq(anchorSets.id, translationVersions.translation_anchor_set_id))
    .innerJoin(policyVersions, eq(policyVersions.id, translationVersions.translation_policy_version_id))
    .where(and(eq(translations.project_id, projectId), isNull(translations.tombstoned_at), isNull(nodes.archived_at),
      eq(translationVersions.state, "confirmed"), documentNodeId == null ? undefined : eq(nodes.id, documentNodeId)))
    .orderBy(asc(nodes.ordinal), asc(nodes.id)).all();
  const paths = documentPaths(db, projectId);
  return rows.map((row) => ({
    document: {
      id: row.document_node_id,
      title: row.title,
      originalTitle: row.original_title,
      path: paths.get(row.document_node_id) ?? [row.title],
    },
    stage: row.stage,
    targetLocale: row.target_locale,
    confirmedTranslation: {
      versionId: row.translation_version_id,
      versionNo: row.translation_version_no,
      contentHash: row.translation_hash,
      contentText: row.translation_text,
      versionCreatedAt: row.version_created_at,
    },
    source: {
      versionId: row.source_version_id,
      versionNo: row.source_version_no,
      contentHash: row.source_hash,
      contentText: row.source_text,
    },
    punctuation: {
      versionId: row.punctuation_version_id,
      versionNo: row.punctuation_version_no,
      contentHash: row.punctuation_hash,
      contentText: row.punctuation_text,
    },
    anchorSet: { id: row.anchor_set_id, contentHash: row.anchor_set_hash },
    translationPolicy: { versionId: row.policy_version_id, contentHash: row.policy_hash },
    blocks: loadHistoryBlocks(db, row.translation_version_id),
    ...(() => { const layout=orm(db).select({ alignment_state: layouts.alignment_state, sentences_json: layouts.sentences_json, links_json: layouts.links_json })
      .from(layouts).where(eq(layouts.version_id, row.translation_version_id)).get();
      if (!layout) return {};
      const content = loadContent(db, row.translation_version_id);
      const projected = content ? projectContent(content, { state: layout.alignment_state, error: null }) : null;
      return {alignment:{state:layout.alignment_state,sentences:projected?.sentences ?? JSON.parse(layout.sentences_json),links:projected?.links ?? JSON.parse(layout.links_json)}}; })(),
  }));
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function renderMarkdown(projectTitle: string, generatedAt: string, manifestHash: string, documents: ExportDocument[]): string {
  const out = [
    `# ${projectTitle} — 확정 번역`,
    "",
    `- 생성 시각: ${generatedAt}`,
    `- export schema: \`munhae-confirmed-export.v1\``,
    `- manifest SHA-256: \`${manifestHash}\``,
    "",
  ];
  for (const item of documents) {
    out.push(`## ${item.document.path.join(" › ")} · ${item.stage}`, "");
    out.push("| 항목 | exact version / SHA-256 |", "|---|---|");
    out.push(`| 번역 | v${item.confirmedTranslation.versionNo} · \`${item.confirmedTranslation.versionId}\`<br>\`${item.confirmedTranslation.contentHash}\` |`);
    out.push(`| 번역 version 생성 | ${item.confirmedTranslation.versionCreatedAt} |`);
    out.push(`| 원문 | v${item.source.versionNo} · \`${item.source.versionId}\`<br>\`${item.source.contentHash}\` |`);
    if(item.punctuation.versionId) out.push(`| 표점 | v${item.punctuation.versionNo} · \`${item.punctuation.versionId}\`<br>\`${item.punctuation.contentHash}\` |`);
    if(item.anchorSet.id) out.push(`| 앵커 집합 | \`${item.anchorSet.id}\`<br>\`${item.anchorSet.contentHash}\` |`);
    out.push(`| 번역 원칙 | \`${item.translationPolicy.versionId}\`<br>\`${item.translationPolicy.contentHash}\` |`, "");
    out.push("### 무표점 원문", "", item.source.contentText, "", ...(item.punctuation.versionId ? ["### 표점 원문", "", item.punctuation.contentText ?? ""] : []), "", "### 확정 번역", "");
    for (const block of item.blocks) {
      const anchors = block.anchors.map((anchor) => anchor.anchorKey).join(", ");
      const quotes = block.anchors.map((anchor) => anchor.punctuatedQuote).join("");
      out.push(`#### ${block.blockKey} · ${block.blockKind}`, "");
      out.push(`- 앵커: ${anchors || "—"}`);
      out.push(`- target SHA-256: \`${block.targetHash}\``);
      for (const anchor of block.anchors) {
        out.push(
          `  - \`${anchor.anchorKey}\` · ${anchor.relationKind}/${anchor.boundaryKind} · source ${anchor.sourceCodepointFrom}–${anchor.sourceCodepointTo} \`${anchor.sourceQuoteHash}\` · punctuation ${anchor.punctuationCodepointFrom}–${anchor.punctuationCodepointTo} \`${anchor.punctuatedQuoteHash}\``,
        );
      }
      out.push("");
      if (quotes) out.push(`> ${markdownCell(quotes)}`, "");
      out.push(block.translation, "");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

function renderCsv(
  generatedAt: string,
  manifestHash: string,
  documents: ExportDocument[],
): string {
  const header = [
    "export_schema", "generated_at", "manifest_hash", "document_id", "document_path", "stage",
    "target_locale", "translation_version_id", "translation_version_no", "translation_hash",
    "translation_version_created_at", "source_version_id", "source_version_no", "source_hash",
    "punctuation_version_id", "punctuation_version_no", "punctuation_hash", "anchor_set_id", "anchor_set_hash",
    "policy_version_id", "policy_hash", "source_text", "punctuation_text", "block_key", "block_ordinal", "block_kind",
    "target_hash", "anchor_keys", "anchor_relations", "anchors_json", "source_quotes", "punctuated_quotes", "translation",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const item of documents) {
    for (const block of item.blocks) {
      lines.push([
        "munhae-confirmed-export.v1",
        generatedAt,
        manifestHash,
        item.document.id,
        item.document.path.join(" › "),
        item.stage,
        item.targetLocale,
        item.confirmedTranslation.versionId,
        item.confirmedTranslation.versionNo,
        item.confirmedTranslation.contentHash,
        item.confirmedTranslation.versionCreatedAt,
        item.source.versionId,
        item.source.versionNo,
        item.source.contentHash,
        item.punctuation.versionId,
        item.punctuation.versionNo,
        item.punctuation.contentHash,
        item.anchorSet.id,
        item.anchorSet.contentHash,
        item.translationPolicy.versionId,
        item.translationPolicy.contentHash,
        item.source.contentText,
        item.punctuation.contentText,
        block.blockKey,
        block.ordinal,
        block.blockKind,
        block.targetHash,
        block.anchors.map((anchor) => anchor.anchorKey).join("|"),
        block.anchors.map((anchor) => anchor.relationKind).join("|"),
        JSON.stringify(block.anchors),
        block.anchors.map((anchor) => anchor.sourceQuote).join("|"),
        block.anchors.map((anchor) => anchor.punctuatedQuote).join("|"),
        block.translation,
      ].map(csvCell).join(","));
    }
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function safeBaseName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "munhae";
}

export function createConfirmedExport(
  db: SqliteDb,
  projectId: string,
  input: ConfirmedExportInput,
): ConfirmedExportPayload {
  if (!(["markdown", "json", "csv"] as const).includes(input.format)) {
    throw new MunhaeError("invalid_export", "지원하지 않는 내보내기 형식입니다");
  }
  const project = orm(db).select({ title: projects.title }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new MunhaeError("invalid_project", "프로젝트를 찾을 수 없습니다");
  const documents = loadConfirmedExportDocuments(db, projectId, input.documentNodeId);
  if (!documents.length) {
    throw new MunhaeError("nothing_to_export", "선택한 범위에 확정된 번역이 없습니다");
  }
  const generatedAt = nowIso();
  const manifestCore = {
    schema: "munhae-confirmed-export.v1",
    project: { id: projectId, title: project.title },
    scope: input.documentNodeId ? { documentNodeId: input.documentNodeId } : { project: true },
    documents,
  };
  const manifestHash = sha256Hex(canonicalJson(manifestCore));
  const json = { ...manifestCore, generatedAt, manifestHash };
  const renderers: Record<ConfirmedExportFormat, { mediaType: string; extension: ConfirmedExportPayload["extension"]; content: string }> = {
    markdown: {
      mediaType: "text/markdown; charset=utf-8",
      extension: "md",
      content: renderMarkdown(project.title, generatedAt, manifestHash, documents),
    },
    json: {
      mediaType: "application/json; charset=utf-8",
      extension: "json",
      content: `${JSON.stringify(json, null, 2)}\n`,
    },
    csv: {
      mediaType: "text/csv; charset=utf-8",
      extension: "csv",
      content: renderCsv(generatedAt, manifestHash, documents),
    },
  };
  const rendered = renderers[input.format];
  return {
    format: input.format,
    mediaType: rendered.mediaType,
    extension: rendered.extension,
    suggestedBaseName: `${safeBaseName(project.title)}-confirmed-translations`,
    confirmedTranslationCount: documents.length,
    manifestHash,
    content: rendered.content,
  };
}

function rebuildSearchIndex(db: SqliteDb, projectId: string): void {
  orm(db).transaction(() => {
    // FTS5 remains a SQL-managed virtual table; its ledger inputs are typed queries.
    orm(db).run(sql`DELETE FROM search_documents_fts WHERE project_id = ${projectId}`);
    const sourceRows = orm(db).select({
      project_id: sources.project_id, document_node_id: sources.document_node_id,
      result_kind: sql<string>`'source'`, aggregate_id: sources.id, version_id: sourceVersions.id,
      content_hash: sourceVersions.content_hash, stage: sql<string>`''`, state: sourceVersions.state,
      is_current: sql<string>`case when ${sourceHeads.current_version_id} = ${sourceVersions.id} then '1' else '0' end`,
      is_confirmed: sql<string>`case when ${sourceHeads.confirmed_version_id} = ${sourceVersions.id} then '1' else '0' end`,
      title: nodes.title, content: sourceVersions.content_text,
    }).from(sources).innerJoin(sourceHeads, eq(sourceHeads.source_text_id, sources.id))
      .innerJoin(sourceVersions, eq(sourceVersions.source_text_id, sources.id))
      .innerJoin(nodes, eq(nodes.id, sources.document_node_id))
      .where(and(eq(sources.project_id, projectId), isNull(sources.tombstoned_at), isNull(nodes.archived_at)));
    const translationRows = orm(db).select({
      project_id: translations.project_id, document_node_id: translations.document_node_id,
      result_kind: sql<string>`'translation'`, aggregate_id: translations.id, version_id: translationVersions.id,
      content_hash: translationVersions.content_hash, stage: sql<string>`'translation'`, state: translationVersions.state,
      is_current: sql<string>`case when ${translationHeads.current_version_id} = ${translationVersions.id} then '1' else '0' end`,
      is_confirmed: sql<string>`case when ${translationHeads.confirmed_version_id} = ${translationVersions.id} then '1' else '0' end`,
      title: nodes.title, content: translationVersions.text_content,
    }).from(translations).innerJoin(translationHeads, eq(translationHeads.document_translation_id, translations.id))
      .innerJoin(translationVersions, eq(translationVersions.document_translation_id, translations.id))
      .innerJoin(nodes, eq(nodes.id, translations.document_node_id))
      .where(and(eq(translations.project_id, projectId), isNull(translations.tombstoned_at), isNull(nodes.archived_at)));
    for (const query of [sourceRows, translationRows]) {
      orm(db).run(sql`INSERT INTO search_documents_fts
        (project_id, document_node_id, result_kind, aggregate_id, version_id, content_hash,
         stage, state, is_current, is_confirmed, title, content) ${query.getSQL()}`);
    }
  });
}

type SearchRow = {
  result_kind: "source" | "translation";
  document_node_id: string;
  title: string;
  aggregate_id: string;
  version_id: string;
  content_hash: string;
  stage: string;
  state: string;
  is_current: string;
  is_confirmed: string;
  content: string;
  score: number;
};

function matchExpression(query: string, prefix: boolean): string | null {
  const tokens = query.normalize("NFC").split(/\s+/u).filter(Boolean);
  if (!tokens.length || tokens.some((token) => !/[\p{Letter}\p{Number}]/u.test(token))) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"${prefix ? "*" : ""}`).join(" AND ");
}

function isShortHanQuery(query: string): boolean {
  return /^\p{Script=Han}{1,2}$/u.test(query);
}

function entityTerms(values: Array<string | null | undefined>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = value?.normalize("NFC").trim();
    if (normalized && normalized.length <= 500) unique.add(normalized);
  }
  return [...unique].slice(0, 100);
}

function resolveSearchEntityFilter(
  db: SqliteDb,
  projectId: string,
  input: SearchEntityFilterInput | null | undefined,
): ResolvedSearchEntityFilter | null {
  if (!input) return null;
  if (input.entityType !== "term") {
    throw new MunhaeError("invalid_search", "지식 엔티티 종류가 올바르지 않습니다");
  }
  const entityId = input.entityId.trim();
  if (!entityId || entityId.length > 80) {
    throw new MunhaeError("invalid_search", "지식 엔티티 ID가 올바르지 않습니다");
  }

  const row = orm(db).select({ source_form: projectTerms.source_form, translation: projectTerms.translation, reading: projectTerms.reading })
    .from(projectTerms).where(and(eq(projectTerms.id, entityId), eq(projectTerms.project_id, projectId))).get();
  if (!row) throw new MunhaeError("not_found", "이 프로젝트에서 용어 항목을 찾을 수 없습니다");
  return {
    entityType: input.entityType,
    entityId,
    label: row.translation ? `${row.source_form} → ${row.translation}` : row.source_form,
    terms: entityTerms([row.source_form, row.translation, row.reading]),
  };
}

function stateWhere(state: SearchState): SQL | undefined {
  if (state === "current") return sql`is_current = '1'`;
  if (state === "confirmed") return sql`is_confirmed = '1'`;
  return undefined;
}

function scopeWhere(scope: SearchScope): SQL | undefined {
  return scope === "all" ? undefined : sql`result_kind = ${scope}`;
}

function snippet(content: string, query: string): string {
  const normalized = content.toLocaleLowerCase("ko-KR");
  const needle = query.toLocaleLowerCase("ko-KR");
  let utf16At = normalized.indexOf(needle);
  if (utf16At < 0) {
    const token = query.split(/\s+/u).find(Boolean) ?? query;
    utf16At = normalized.indexOf(token.toLocaleLowerCase("ko-KR"));
  }
  const at = utf16At < 0 ? 0 : Array.from(content.slice(0, utf16At)).length;
  const chars = Array.from(content);
  const from = Math.max(0, at - 48);
  const to = Math.min(chars.length, at + Math.max(24, Array.from(query).length) + 72);
  return `${from > 0 ? "…" : ""}${chars.slice(from, to).join("")}${to < chars.length ? "…" : ""}`;
}

function versionNumber(db: SqliteDb, row: SearchRow): number {
  if (row.result_kind === "source") {
    return orm(db).select({ version_no: sourceVersions.version_no }).from(sourceVersions).where(eq(sourceVersions.id, row.version_id)).get()?.version_no ?? 0;
  }
  return orm(db).select({ version_no: translationVersions.version_no }).from(translationVersions).where(eq(translationVersions.id, row.version_id)).get()?.version_no ?? 0;
}

export function searchProject(db: SqliteDb, projectId: string, input: SearchQueryInput): SearchView {
  const query = input.query.normalize("NFC").trim();
  if (!query || query.length > 500) throw new MunhaeError("invalid_search", "검색어는 1~500자여야 합니다");
  const scope = input.scope ?? "all";
  const state = input.state ?? "current";
  if (!(["all", "source", "translation"] as const).includes(scope)) {
    throw new MunhaeError("invalid_search", "검색 범위가 올바르지 않습니다");
  }
  if (!(["current", "confirmed", "all"] as const).includes(state)) {
    throw new MunhaeError("invalid_search", "버전 상태 필터가 올바르지 않습니다");
  }
  if (input.documentNodeId) requireSourceUnit(db, projectId, input.documentNodeId);
  const entityFilter = resolveSearchEntityFilter(db, projectId, input.entityFilter);
  const usedShortHanPrefix = isShortHanQuery(query);
  const limit = Math.max(1, Math.min(200, input.limit ?? 80));
  rebuildSearchIndex(db, projectId);
  const common = and(
    sql`project_id = ${projectId}`,
    scopeWhere(scope), stateWhere(state),
    input.documentNodeId ? sql`document_node_id = ${input.documentNodeId}` : undefined,
    entityFilter ? or(...entityFilter.terms.map((term) => sql`instr(content, ${term}) > 0`)) : undefined,
  )!;
  const exactRows = orm(db).all<SearchRow>(sql`
     SELECT result_kind, document_node_id, title, aggregate_id, version_id, content_hash,
            stage, state, is_current, is_confirmed, content, 0 AS score
     FROM search_documents_fts
     WHERE ${common} AND instr(content, ${query}) > 0
     ORDER BY CAST(is_current AS INTEGER) DESC, CAST(is_confirmed AS INTEGER) DESC, title, version_id
     LIMIT ${limit}`);
  let ftsRows: SearchRow[] = [];
  const expression = matchExpression(query, usedShortHanPrefix);
  if (expression) {
    try {
      ftsRows = orm(db).all<SearchRow>(sql`
         SELECT result_kind, document_node_id, title, aggregate_id, version_id, content_hash,
                stage, state, is_current, is_confirmed, content,
                bm25(search_documents_fts) AS score
         FROM search_documents_fts
         WHERE search_documents_fts MATCH ${expression} AND ${common}
         ORDER BY score, CAST(is_current AS INTEGER) DESC, CAST(is_confirmed AS INTEGER) DESC
         LIMIT ${limit}`);
    } catch {
      // Exact substring search still returns useful results for punctuation-only
      // or tokenizer-specific input. A malformed MATCH expression never escapes.
      ftsRows = [];
    }
  }
  const merged = new Map<string, { row: SearchRow; kind: SearchResult["matchKind"] }>();
  if (usedShortHanPrefix) {
    for (const row of ftsRows) merged.set(row.version_id, { row, kind: "prefix" });
    for (const row of exactRows) {
      if (!merged.has(row.version_id)) merged.set(row.version_id, { row, kind: "exact" });
    }
  } else {
    for (const row of exactRows) merged.set(row.version_id, { row, kind: "exact" });
    for (const row of ftsRows) {
      if (!merged.has(row.version_id)) merged.set(row.version_id, { row, kind: "fts" });
    }
  }
  const results = [...merged.values()]
    .sort((left, right) => {
      const rank = (kind: SearchResult["matchKind"]): number => kind === "prefix" ? 0 : kind === "exact" ? 1 : 2;
      if (left.kind !== right.kind) return rank(left.kind) - rank(right.kind);
      const current = Number(right.row.is_current) - Number(left.row.is_current);
      if (current) return current;
      const confirmed = Number(right.row.is_confirmed) - Number(left.row.is_confirmed);
      if (confirmed) return confirmed;
      return left.row.score - right.row.score || left.row.title.localeCompare(right.row.title, "ko");
    })
    .slice(0, limit)
    .map(({ row, kind }) => ({
      resultKind: row.result_kind,
      documentNodeId: row.document_node_id,
      documentTitle: row.title,
      aggregateId: row.aggregate_id,
      versionId: row.version_id,
      versionNo: versionNumber(db, row),
      contentHash: row.content_hash,
      stage: row.stage || null,
      state: row.state,
      isCurrent: row.is_current === "1",
      isConfirmed: row.is_confirmed === "1",
      matchKind: kind,
      snippet: snippet(row.content, query),
    } satisfies SearchResult));
  return { query, scope, state, entityFilter, usedShortHanPrefix, rebuiltFromLedger: true, results };
}
