import {
  canonicalJson,
  MunhaeError,
  nowIso,
  sha256Hex,
  sliceCodepoints,
} from "@munhae/domain";
import { allRows, getRow } from "./rows.ts";
import type { SqliteDb } from "./sqlite.ts";

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
  changeSummary: string | null;
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
export type SearchEntityType = "glossary";

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
  change_summary: string | null;
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
  const row = getRow<{ title: string; node_role: string }>(
    db,
    `SELECT title, node_role FROM document_nodes
     WHERE id = ? AND project_id = ? AND archived_at IS NULL`,
    documentNodeId,
    projectId,
  );
  if (!row) throw new MunhaeError("not_found", "문서를 찾을 수 없습니다");
  if (row.node_role !== "source_unit") {
    throw new MunhaeError("invalid_document", "원문 작업 단위만 이력·검색 범위로 선택할 수 있습니다");
  }
  return { title: row.title };
}

function loadHistoryBlocks(db: SqliteDb, versionId: string): HistoryBlock[] {
  const blocks = allRows<{
    id: string;
    block_key: string;
    ordinal: number;
    block_kind: string;
    target_codepoint_from: number;
    target_codepoint_to: number;
    target_hash: string;
    validation_state: "valid" | "needs_review";
    text_content: string;
  }>(
    db,
    `SELECT b.id, b.block_key, b.ordinal, b.block_kind, b.target_codepoint_from,
            b.target_codepoint_to, b.target_hash, b.validation_state, v.text_content
     FROM translation_blocks b
     JOIN document_translation_versions v ON v.id = b.document_translation_version_id
     WHERE b.document_translation_version_id = ?
     ORDER BY b.ordinal`,
    versionId,
  );
  if (!blocks.length) {
    const full = getRow<{text_content:string;content_hash:string;validation_state:"valid"|"needs_review"}>(db, "SELECT v.text_content,v.content_hash,v.validation_state FROM document_translation_versions v JOIN translation_text_layouts l ON l.version_id=v.id WHERE v.id=?",versionId);
    if(full) return [{blockKey:"text",ordinal:1,blockKind:"text",translation:full.text_content,targetHash:full.content_hash,validationState:full.validation_state,anchors:[]}];
  }
  return blocks.map((block) => ({
    blockKey: block.block_key,
    ordinal: block.ordinal,
    blockKind: block.block_kind,
    translation: sliceCodepoints(block.text_content, block.target_codepoint_from, block.target_codepoint_to),
    targetHash: block.target_hash,
    validationState: block.validation_state,
    anchors: allRows<{
      anchor_id: string;
      anchor_key: string;
      ordinal: number;
      relation_kind: string;
      boundary_kind: string;
      source_codepoint_from: number;
      source_codepoint_to: number;
      source_quote: string;
      source_quote_hash: string;
      punctuation_codepoint_from: number;
      punctuation_codepoint_to: number;
      punctuated_quote: string;
      punctuated_quote_hash: string;
    }>(
      db,
      `SELECT a.id AS anchor_id, a.anchor_key, ba.ordinal, ba.relation_kind, a.boundary_kind,
              a.source_codepoint_from, a.source_codepoint_to, a.source_quote, a.source_quote_hash,
              a.punctuation_codepoint_from, a.punctuation_codepoint_to,
              a.punctuated_quote, a.punctuated_quote_hash
       FROM translation_block_anchors ba
       JOIN translation_anchors a ON a.id = ba.translation_anchor_id
       WHERE ba.translation_block_id = ?
       ORDER BY ba.ordinal`,
      block.id,
    ).map((anchor) => ({
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
    changeSummary: row.change_summary,
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
  const sourceRows = allRows<BaseHistoryRow>(
    db,
    `SELECT 'source' AS kind, s.id AS aggregate_id, NULL AS stage, v.id AS version_id,
            v.parent_version_id, v.version_no, v.state, h.current_version_id,
            h.confirmed_version_id, v.content_hash, v.content_text, v.created_at,
            actor.display_name AS created_by, v.origin_kind, v.change_summary,
            NULL AS validation_state, v.id AS source_text_version_id,
            v.content_hash AS source_text_hash, NULL AS punctuation_version_id,
            NULL AS punctuation_hash, NULL AS anchor_set_id, NULL AS anchor_set_hash,
            NULL AS translation_policy_version_id, NULL AS translation_policy_hash,
            NULL AS structure_json, 0 AS structure_span_count
     FROM src_texts s
     JOIN src_text_heads h ON h.source_text_id = s.id
     JOIN src_text_versions v ON v.source_text_id = s.id
     JOIN core_actors actor ON actor.id = v.created_by_actor_id
     WHERE s.project_id = ? AND s.document_node_id = ? AND s.tombstoned_at IS NULL
     ORDER BY v.version_no DESC, v.created_at DESC`,
    projectId,
    documentNodeId,
  );
  const punctuationRows = allRows<BaseHistoryRow>(
    db,
    `SELECT 'punctuation' AS kind, p.id AS aggregate_id, NULL AS stage, v.id AS version_id,
            v.parent_version_id, v.version_no, v.state, h.current_version_id,
            h.confirmed_version_id, v.content_hash, v.punctuated_text AS content_text,
            v.created_at, actor.display_name AS created_by, 'punctuation' AS origin_kind,
            v.change_summary, NULL AS validation_state, v.source_text_version_id,
            source_v.content_hash AS source_text_hash, v.id AS punctuation_version_id,
            v.content_hash AS punctuation_hash,
            (SELECT a.id FROM translation_anchor_sets a
             WHERE a.punctuation_version_id = v.id ORDER BY a.created_at DESC LIMIT 1) AS anchor_set_id,
            (SELECT a.anchor_set_hash FROM translation_anchor_sets a
             WHERE a.punctuation_version_id = v.id ORDER BY a.created_at DESC LIMIT 1) AS anchor_set_hash,
            NULL AS translation_policy_version_id, NULL AS translation_policy_hash,
            v.structure_json,
            (SELECT COUNT(*) FROM punctuation_structure_spans span
             WHERE span.punctuation_version_id = v.id) AS structure_span_count
     FROM src_texts s
     JOIN punctuation_sets p ON p.source_text_id = s.id
     JOIN punctuation_heads h ON h.punctuation_set_id = p.id
     JOIN punctuation_versions v ON v.punctuation_set_id = p.id
     JOIN src_text_versions source_v ON source_v.id = v.source_text_version_id
     JOIN core_actors actor ON actor.id = v.created_by_actor_id
     WHERE s.project_id = ? AND s.document_node_id = ? AND s.tombstoned_at IS NULL
     ORDER BY p.created_at DESC, v.version_no DESC, v.created_at DESC`,
    projectId,
    documentNodeId,
  );
  const translationRows = allRows<BaseHistoryRow>(
    db,
    `SELECT 'translation' AS kind, t.id AS aggregate_id, 'translation' AS stage, v.id AS version_id,
            v.parent_version_id, v.version_no, v.state, h.current_version_id,
            h.confirmed_version_id, v.content_hash, v.text_content AS content_text, v.created_at,
            actor.display_name AS created_by, v.origin_kind, NULL AS change_summary,
            v.validation_state, v.source_text_version_id,
            source_v.content_hash AS source_text_hash, v.punctuation_version_id,
            punctuation_v.content_hash AS punctuation_hash, v.translation_anchor_set_id AS anchor_set_id,
            anchor_set.anchor_set_hash, v.translation_policy_version_id,
            policy_v.content_hash AS translation_policy_hash, NULL AS structure_json,
            0 AS structure_span_count
     FROM document_translations t
     JOIN document_translation_heads h ON h.document_translation_id = t.id
     JOIN document_translation_versions v ON v.document_translation_id = t.id
     JOIN src_text_versions source_v ON source_v.id = v.source_text_version_id
     LEFT JOIN punctuation_versions punctuation_v ON punctuation_v.id = v.punctuation_version_id
     LEFT JOIN translation_anchor_sets anchor_set ON anchor_set.id = v.translation_anchor_set_id
     JOIN core_translation_policy_versions policy_v ON policy_v.id = v.translation_policy_version_id
     JOIN core_actors actor ON actor.id = v.created_by_actor_id
     WHERE t.project_id = ? AND t.document_node_id = ? AND t.tombstoned_at IS NULL
     ORDER BY v.version_no DESC, v.created_at DESC`,
    projectId,
    documentNodeId,
  );
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

type ExportRow = {
  document_node_id: string;
  title: string;
  original_title: string | null;
  stage: string;
  target_locale: string;
  translation_version_id: string;
  translation_version_no: number;
  translation_hash: string;
  translation_text: string;
  source_version_id: string;
  source_version_no: number;
  source_hash: string;
  source_text: string;
  punctuation_version_id: string;
  punctuation_version_no: number;
  punctuation_hash: string;
  punctuation_text: string;
  anchor_set_id: string;
  anchor_set_hash: string;
  policy_version_id: string;
  policy_hash: string;
  version_created_at: string;
};

type ExportDocument = {
  alignment?: { state: string; sentences: unknown[]; links: unknown[] };
  document: { id: string; title: string; originalTitle: string | null; path: string[] };
  stage: string;
  targetLocale: string;
  confirmedTranslation: { versionId: string; versionNo: number; contentHash: string; contentText: string; versionCreatedAt: string };
  source: { versionId: string; versionNo: number; contentHash: string; contentText: string };
  punctuation: { versionId: string; versionNo: number; contentHash: string; contentText: string };
  anchorSet: { id: string; contentHash: string };
  translationPolicy: { versionId: string; contentHash: string };
  blocks: HistoryBlock[];
};

function documentPaths(db: SqliteDb, projectId: string): Map<string, string[]> {
  const rows = allRows<{ id: string; parent_node_id: string | null; title: string }>(
    db,
    `SELECT id, parent_node_id, title FROM document_nodes
     WHERE project_id = ? AND archived_at IS NULL`,
    projectId,
  );
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
  const rows = allRows<ExportRow>(
    db,
    `SELECT n.id AS document_node_id, n.title, n.original_title,
            'translation' AS stage, t.target_locale,
            v.id AS translation_version_id, v.version_no AS translation_version_no,
            v.content_hash AS translation_hash, v.text_content AS translation_text,
            source_v.id AS source_version_id, source_v.version_no AS source_version_no,
            source_v.content_hash AS source_hash, source_v.content_text AS source_text,
            punctuation_v.id AS punctuation_version_id,
            punctuation_v.version_no AS punctuation_version_no,
            punctuation_v.content_hash AS punctuation_hash,
            punctuation_v.punctuated_text AS punctuation_text,
            anchor_set.id AS anchor_set_id, anchor_set.anchor_set_hash,
            policy_v.id AS policy_version_id, policy_v.content_hash AS policy_hash,
            v.created_at AS version_created_at
     FROM document_translation_heads h
     JOIN document_translations t ON t.id = h.document_translation_id
     JOIN document_translation_versions v ON v.id = h.confirmed_version_id
     JOIN document_nodes n ON n.id = t.document_node_id
     JOIN src_text_versions source_v ON source_v.id = v.source_text_version_id
     LEFT JOIN punctuation_versions punctuation_v ON punctuation_v.id = v.punctuation_version_id
     LEFT JOIN translation_anchor_sets anchor_set ON anchor_set.id = v.translation_anchor_set_id
     JOIN core_translation_policy_versions policy_v ON policy_v.id = v.translation_policy_version_id
     WHERE t.project_id = ? AND t.tombstoned_at IS NULL AND n.archived_at IS NULL
       AND v.state = 'confirmed' AND (? IS NULL OR n.id = ?)
     ORDER BY n.ordinal, n.id`,
    projectId,
    documentNodeId ?? null,
    documentNodeId ?? null,
  );
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
    ...(() => { const layout=getRow<{alignment_state:string;sentences_json:string;links_json:string}>(db,'SELECT alignment_state,sentences_json,links_json FROM translation_text_layouts WHERE version_id=?',row.translation_version_id); return layout ? {alignment:{state:layout.alignment_state,sentences:JSON.parse(layout.sentences_json),links:JSON.parse(layout.links_json)}} : {}; })(),
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
    out.push("### 무표점 원문", "", item.source.contentText, "", ...(item.punctuation.versionId ? ["### 표점 원문", "", item.punctuation.contentText] : []), "", "### 확정 번역", "");
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
  const project = getRow<{ title: string }>(db, `SELECT title FROM core_projects WHERE id = ?`, projectId);
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
  db.transaction(() => {
    db.prepare(`DELETE FROM search_documents_fts WHERE project_id = ?`).run(projectId);
    db.prepare(
      `INSERT INTO search_documents_fts
         (project_id, document_node_id, result_kind, aggregate_id, version_id, content_hash,
          stage, state, is_current, is_confirmed, title, content)
       SELECT s.project_id, s.document_node_id, 'source', s.id, v.id, v.content_hash,
              '', v.state, CASE WHEN h.current_version_id = v.id THEN '1' ELSE '0' END,
              CASE WHEN h.confirmed_version_id = v.id THEN '1' ELSE '0' END,
              n.title, v.content_text
       FROM src_texts s
       JOIN src_text_heads h ON h.source_text_id = s.id
       JOIN src_text_versions v ON v.source_text_id = s.id
       JOIN document_nodes n ON n.id = s.document_node_id
       WHERE s.project_id = ? AND s.tombstoned_at IS NULL AND n.archived_at IS NULL`,
    ).run(projectId);
    db.prepare(
      `INSERT INTO search_documents_fts
         (project_id, document_node_id, result_kind, aggregate_id, version_id, content_hash,
          stage, state, is_current, is_confirmed, title, content)
       SELECT t.project_id, t.document_node_id, 'translation', t.id, v.id, v.content_hash,
              'translation', v.state, CASE WHEN h.current_version_id = v.id THEN '1' ELSE '0' END,
              CASE WHEN h.confirmed_version_id = v.id THEN '1' ELSE '0' END,
              n.title, v.text_content
       FROM document_translations t
       JOIN document_translation_heads h ON h.document_translation_id = t.id
       JOIN document_translation_versions v ON v.document_translation_id = t.id
       JOIN document_nodes n ON n.id = t.document_node_id
       WHERE t.project_id = ? AND t.tombstoned_at IS NULL AND n.archived_at IS NULL`,
    ).run(projectId);
  })();
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
  if (input.entityType !== "glossary") {
    throw new MunhaeError("invalid_search", "지식 엔티티 종류가 올바르지 않습니다");
  }
  const entityId = input.entityId.trim();
  if (!entityId || entityId.length > 80) {
    throw new MunhaeError("invalid_search", "지식 엔티티 ID가 올바르지 않습니다");
  }

  const row = getRow<{
    source_term: string;
    target_term: string;
    reading: string | null;
  }>(
    db,
    `SELECT source_term, target_term, reading
     FROM glossary_entries
     WHERE id = ? AND project_id = ? AND archived_at IS NULL`,
    entityId,
    projectId,
  );
  if (!row) throw new MunhaeError("not_found", "이 프로젝트에서 용어 항목을 찾을 수 없습니다");
  return {
    entityType: input.entityType,
    entityId,
    label: `${row.source_term} → ${row.target_term}`,
    terms: entityTerms([row.source_term, row.target_term, row.reading]),
  };
}

function stateWhere(state: SearchState): string {
  if (state === "current") return "AND is_current = '1'";
  if (state === "confirmed") return "AND is_confirmed = '1'";
  return "";
}

function scopeWhere(scope: SearchScope): string {
  if (scope === "source") return "AND result_kind = 'source'";
  if (scope === "translation") return "AND result_kind = 'translation'";
  return "";
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
    return getRow<{ version_no: number }>(db, `SELECT version_no FROM src_text_versions WHERE id = ?`, row.version_id)?.version_no ?? 0;
  }
  return getRow<{ version_no: number }>(db, `SELECT version_no FROM document_translation_versions WHERE id = ?`, row.version_id)?.version_no ?? 0;
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
  const entityWhere = entityFilter
    ? `AND (${entityFilter.terms.map((_, index) => `instr(content, @entityTerm${index}) > 0`).join(" OR ")})`
    : "";
  const common = `${scopeWhere(scope)} ${stateWhere(state)} ${input.documentNodeId ? "AND document_node_id = @documentNodeId" : ""} ${entityWhere}`;
  const params: Record<string, unknown> = {
    projectId,
    query,
    documentNodeId: input.documentNodeId ?? null,
    limit,
  };
  entityFilter?.terms.forEach((term, index) => {
    params[`entityTerm${index}`] = term;
  });
  const exactRows = allRows<SearchRow>(
    db,
    `SELECT result_kind, document_node_id, title, aggregate_id, version_id, content_hash,
            stage, state, is_current, is_confirmed, content, 0 AS score
     FROM search_documents_fts
     WHERE project_id = @projectId AND instr(content, @query) > 0 ${common}
     ORDER BY CAST(is_current AS INTEGER) DESC, CAST(is_confirmed AS INTEGER) DESC, title, version_id
     LIMIT @limit`,
    params,
  );
  let ftsRows: SearchRow[] = [];
  const expression = matchExpression(query, usedShortHanPrefix);
  if (expression) {
    try {
      ftsRows = allRows<SearchRow>(
        db,
        `SELECT result_kind, document_node_id, title, aggregate_id, version_id, content_hash,
                stage, state, is_current, is_confirmed, content,
                bm25(search_documents_fts) AS score
         FROM search_documents_fts
         WHERE search_documents_fts MATCH @expression AND project_id = @projectId ${common}
         ORDER BY score, CAST(is_current AS INTEGER) DESC, CAST(is_confirmed AS INTEGER) DESC
         LIMIT @limit`,
        { ...params, expression },
      );
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
