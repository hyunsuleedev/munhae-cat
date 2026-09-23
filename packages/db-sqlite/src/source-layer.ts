import {
  canonicalJson,
  canonicalJsonHash,
  codepointCount,
  createId,
  MunhaeError,
  sha256Hex,
  sliceCodepoints,
} from "@munhae/domain";
import type { ProjectActors } from "./bootstrap.ts";
import { and, eq } from "drizzle-orm";
import { orm } from "./drizzle-db.ts";
import { schema } from "./drizzle-schema.ts";
import type { SqliteDb } from "./sqlite.ts";
import type {
  PunctuationSpanKind,
  PunctuationStructureMode,
  PunctuationStructureSpanInput,
} from "./views.ts";

export type SourceLayerResult = {
  sourceTextId: string;
  sourceVersionId: string;
};

export type PreparedStructureSpan = {
  spanKey: string;
  spanKind: PunctuationSpanKind;
  parentSpanKey: string | null;
  ordinal: number;
  codepointFrom: number;
  codepointTo: number;
  quote: string;
  quoteHash: string;
  label: string | null;
};

export type PunctuationSourceMap = {
  /** Source code-point cursor at every punctuation boundary. */
  sourceBoundaryByPunctuationBoundary: number[];
  /** Explicit insertions; a boundary may also consume omitted source whitespace. */
  insertedCodepoints: string[];
};

type Range = { from: number; to: number };

// Korean classical editions also use araea as an enumeration separator;
// Unicode classifies it as a letter rather than punctuation.
const INSERTABLE_PUNCTUATION = /^(?:\p{Punctuation}|\p{White_Space}|ㆍ)$/u;
const SOURCE_WHITESPACE = /^\p{White_Space}$/u;
const SENTENCE_TERMINATOR = /[。．！？!?]/u;
const CLOSING_PUNCTUATION = /^(?:\p{Pe}|\p{Pf}|[」』】》〉〕〗〙〛])$/u;

/**
 * Punctuation may insert punctuation and reflow whitespace. It cannot delete,
 * reorder, normalize, or replace non-whitespace source code points.
 * Boundaries still refer to the original, unmodified source text.
 */
export function validatePunctuationText(sourceText: string, punctuatedText: string): PunctuationSourceMap {
  const source = Array.from(sourceText);
  const punctuation = Array.from(punctuatedText);
  if (source.length === 0 || sourceText.trim().length === 0) {
    throw new MunhaeError("empty_source", "원문이 비어 있습니다");
  }

  let sourceCursor = 0;
  let nextNonWhitespace = 0;
  const boundaries = [0];
  const insertedCodepoints: string[] = [];
  for (const codepoint of punctuation) {
    nextNonWhitespace = Math.max(sourceCursor, nextNonWhitespace);
    while (nextNonWhitespace < source.length && SOURCE_WHITESPACE.test(source[nextNonWhitespace]!)) nextNonWhitespace += 1;
    if (sourceCursor < source.length && codepoint === source[sourceCursor]) {
      sourceCursor += 1;
    } else if (nextNonWhitespace < source.length && codepoint === source[nextNonWhitespace]) {
      sourceCursor = nextNonWhitespace + 1;
    } else if (INSERTABLE_PUNCTUATION.test(codepoint)) {
      insertedCodepoints.push(codepoint);
    } else {
      throw new MunhaeError(
        "punctuation_changes_source",
        `표점안에 원문에 없는 문자 '${codepoint}'가 들어 있습니다`,
      );
    }
    boundaries.push(sourceCursor);
  }

  while (sourceCursor < source.length && SOURCE_WHITESPACE.test(source[sourceCursor]!)) sourceCursor += 1;
  if (sourceCursor !== source.length) {
    const missing = source[sourceCursor] ?? "";
    throw new MunhaeError(
      "punctuation_changes_source",
      `표점안에서 원문 문자 '${missing}'가 삭제되거나 순서가 바뀌었습니다`,
    );
  }
  // Include trailing layout whitespace in the final source range without
  // mistaking the final inserted punctuation mark for a preserved source mark.
  boundaries[boundaries.length - 1] = sourceCursor;
  return { sourceBoundaryByPunctuationBoundary: boundaries, insertedCodepoints };
}

export function prepareStructureSpans(
  punctuatedText: string,
  mode: PunctuationStructureMode,
  supplied?: PunctuationStructureSpanInput[],
): PreparedStructureSpan[] {
  const raw = supplied?.length ? supplied : deriveStructureSpans(punctuatedText, mode);
  const length = codepointCount(punctuatedText);
  if (length === 0) throw new MunhaeError("empty_punctuation", "표점안이 비어 있습니다");

  const allowed = new Set<PunctuationSpanKind>(
    mode === "poetry" ? ["verse_line", "couplet", "stanza"] : ["paragraph", "sentence"],
  );
  const byKey = new Map<string, PreparedStructureSpan>();
  for (const input of raw) {
    const key = input.spanKey.trim();
    if (!key || byKey.has(key)) {
      throw new MunhaeError("invalid_structure", "structure span key는 비어 있지 않고 고유해야 합니다");
    }
    if (!allowed.has(input.spanKind)) {
      throw new MunhaeError("invalid_structure", `${mode} 구조에서 ${input.spanKind} span을 사용할 수 없습니다`);
    }
    if (!Number.isInteger(input.ordinal) || input.ordinal < 1) {
      throw new MunhaeError("invalid_structure", "structure span ordinal은 1 이상의 정수여야 합니다");
    }
    if (
      !Number.isInteger(input.codepointFrom) ||
      !Number.isInteger(input.codepointTo) ||
      input.codepointFrom < 0 ||
      input.codepointTo <= input.codepointFrom ||
      input.codepointTo > length
    ) {
      throw new MunhaeError("invalid_structure", `structure span ${key}의 code-point 범위가 잘못되었습니다`);
    }
    const quote = sliceCodepoints(punctuatedText, input.codepointFrom, input.codepointTo);
    byKey.set(key, {
      spanKey: key,
      spanKind: input.spanKind,
      parentSpanKey: input.parentSpanKey?.trim() || null,
      ordinal: input.ordinal,
      codepointFrom: input.codepointFrom,
      codepointTo: input.codepointTo,
      quote,
      quoteHash: sha256Hex(quote),
      label: input.label?.trim() || null,
    });
  }

  for (const span of byKey.values()) {
    if (span.parentSpanKey && !byKey.has(span.parentSpanKey)) {
      throw new MunhaeError("invalid_structure", `structure span ${span.spanKey}의 parent가 없습니다`);
    }
  }
  assertAcyclic(byKey);

  const siblingOrdinals = new Set<string>();
  for (const span of byKey.values()) {
    const parent = span.parentSpanKey ? byKey.get(span.parentSpanKey)! : null;
    if (parent) {
      if (span.codepointFrom < parent.codepointFrom || span.codepointTo > parent.codepointTo) {
        throw new MunhaeError("invalid_structure", `structure span ${span.spanKey}이 parent 범위를 벗어났습니다`);
      }
      const validParent =
        (mode === "prose" && span.spanKind === "sentence" && parent.spanKind === "paragraph") ||
        (mode === "poetry" && span.spanKind === "verse_line" && parent.spanKind === "couplet") ||
        (mode === "poetry" && span.spanKind === "couplet" && parent.spanKind === "stanza");
      if (!validParent) {
        throw new MunhaeError("invalid_structure", `${span.spanKind}의 parent로 ${parent.spanKind}을 사용할 수 없습니다`);
      }
    } else {
      const validRoot =
        (mode === "prose" && span.spanKind === "paragraph") ||
        (mode === "poetry" && span.spanKind === "stanza");
      if (!validRoot) {
        throw new MunhaeError("invalid_structure", `${span.spanKind} span에는 올바른 parent가 필요합니다`);
      }
    }
    const siblingKey = `${span.parentSpanKey ?? "root"}\u0000${span.spanKind}\u0000${span.ordinal}`;
    if (siblingOrdinals.has(siblingKey)) {
      throw new MunhaeError("invalid_structure", "같은 parent와 kind 안에서 ordinal이 중복됩니다");
    }
    siblingOrdinals.add(siblingKey);
  }

  if (mode === "prose") {
    const paragraphs = [...byKey.values()].filter((span) => span.spanKind === "paragraph");
    const sentences = [...byKey.values()].filter((span) => span.spanKind === "sentence");
    assertPartition(paragraphs, 0, length, "paragraph");
    assertPartition(sentences, 0, length, "sentence");
    for (const paragraph of paragraphs) {
      assertPartition(
        sentences.filter((span) => span.parentSpanKey === paragraph.spanKey),
        paragraph.codepointFrom,
        paragraph.codepointTo,
        `paragraph ${paragraph.spanKey}의 sentence`,
      );
    }
  } else {
    const stanzas = [...byKey.values()].filter((span) => span.spanKind === "stanza");
    const couplets = [...byKey.values()].filter((span) => span.spanKind === "couplet");
    const verseLines = [...byKey.values()].filter((span) => span.spanKind === "verse_line");
    assertPartition(stanzas, 0, length, "stanza");
    assertPartition(verseLines, 0, length, "verse_line");
    for (const stanza of stanzas) {
      assertPartition(
        couplets.filter((span) => span.parentSpanKey === stanza.spanKey),
        stanza.codepointFrom,
        stanza.codepointTo,
        `stanza ${stanza.spanKey}의 couplet`,
      );
    }
    for (const couplet of couplets) {
      assertPartition(
        verseLines.filter((span) => span.parentSpanKey === couplet.spanKey),
        couplet.codepointFrom,
        couplet.codepointTo,
        `couplet ${couplet.spanKey}의 verse_line`,
      );
    }
  }

  return topologicalSpans(byKey);
}

export function insertPunctuationVersionWithAnchors(opts: {
  db: SqliteDb;
  projectId: string;
  documentNodeId: string;
  sourceTextId: string;
  sourceVersionId: string;
  sourceText: string;
  sourceContentHash: string;
  punctuationSetId: string;
  parentVersionId: string | null;
  versionNo: number;
  punctuatedText: string;
  structureMode: PunctuationStructureMode;
  structureSpans?: PunctuationStructureSpanInput[];
  actorId: string;
  anchorActorId: string;
  originKind?: "manual" | "rule" | "ai" | "import";
  /** Draft saves persist validated structure only. Anchors are created when the draft is confirmed. */
  createAnchors?: boolean;
  now: string;
}): { punctuationVersionId: string; anchorSetId: string | null; contentHash: string } {
  const sourceVersions = schema.src_text_versions;
  const punctuationSets = schema.punctuation_sets;
  const punctuationVersions = schema.punctuation_versions;
  const dependency = orm(opts.db).select({
    source_text_id: sourceVersions.source_text_id,
    project_id: sourceVersions.project_id,
  }).from(sourceVersions).where(eq(sourceVersions.id, opts.sourceVersionId)).get();
  const punctuationSet = orm(opts.db).select({
    source_text_id: punctuationSets.source_text_id,
    project_id: punctuationSets.project_id,
  }).from(punctuationSets).where(eq(punctuationSets.id, opts.punctuationSetId)).get();
  if (
    !dependency ||
    !punctuationSet ||
    dependency.source_text_id !== opts.sourceTextId ||
    punctuationSet.source_text_id !== opts.sourceTextId ||
    dependency.project_id !== opts.projectId ||
    punctuationSet.project_id !== opts.projectId ||
    sha256Hex(opts.sourceText) !== opts.sourceContentHash
  ) {
    throw new MunhaeError("invalid_dependency", "원문·표점안의 project/version 의존성이 일치하지 않습니다");
  }
  if (opts.parentVersionId) {
    const parent = orm(opts.db).select({ punctuation_set_id: punctuationVersions.punctuation_set_id })
      .from(punctuationVersions).where(eq(punctuationVersions.id, opts.parentVersionId)).get();
    if (parent?.punctuation_set_id !== opts.punctuationSetId) {
      throw new MunhaeError("invalid_dependency", "표점안 parent version이 같은 표점 집합에 속하지 않습니다");
    }
  }
  const sourceMap = validatePunctuationText(opts.sourceText, opts.punctuatedText);
  const spans = prepareStructureSpans(opts.punctuatedText, opts.structureMode, opts.structureSpans);
  const spanByKey = new Map(spans.map((span) => [span.spanKey, span]));
  const structureJson = canonicalJson({ mode: opts.structureMode });
  const spanManifest = spans
    .map((span) => ({
      spanKind: span.spanKind,
      ordinal: span.ordinal,
      codepointFrom: span.codepointFrom,
      codepointTo: span.codepointTo,
      quoteHash: span.quoteHash,
      parent: span.parentSpanKey ? spanSignature(spanByKey.get(span.parentSpanKey)!) : null,
      label: span.label,
    }))
    .sort(compareSpanManifest);
  const contentHash = canonicalJsonHash({
    punctuatedText: opts.punctuatedText,
    structureJson: { mode: opts.structureMode },
    spans: spanManifest,
  });
  const punctuationVersionId = createId();
  orm(opts.db).insert(schema.punctuation_versions).values({
    id: punctuationVersionId,
    project_id: opts.projectId,
    punctuation_set_id: opts.punctuationSetId,
    source_text_version_id: opts.sourceVersionId,
    parent_version_id: opts.parentVersionId,
    version_no: opts.versionNo,
    punctuated_text: opts.punctuatedText,
    structure_json: structureJson,
    state: "draft",
    content_hash: contentHash,
    created_by_actor_id: opts.actorId,
    created_at: opts.now,
  }).run();

  const spanIdByKey = new Map<string, string>();
  for (const span of spans) {
    const id = createId();
    spanIdByKey.set(span.spanKey, id);
    orm(opts.db).insert(schema.punctuation_structure_spans).values({
      id,
      project_id: opts.projectId,
      punctuation_version_id: punctuationVersionId,
      span_kind: span.spanKind,
      parent_span_id: span.parentSpanKey ? spanIdByKey.get(span.parentSpanKey) : null,
      ordinal: span.ordinal,
      codepoint_from: span.codepointFrom,
      codepoint_to: span.codepointTo,
      quote: span.quote,
      quote_hash: span.quoteHash,
      origin_kind: opts.originKind ?? "manual",
      confidence: null,
      label: span.label,
      created_by_actor_id: opts.actorId,
      created_at: opts.now,
    }).run();
  }

  if (opts.createAnchors === false) {
    return { punctuationVersionId, anchorSetId: null, contentHash };
  }

  const anchorSetId = insertPreparedTranslationAnchors({
    db: opts.db,
    projectId: opts.projectId,
    documentNodeId: opts.documentNodeId,
    sourceVersionId: opts.sourceVersionId,
    sourceText: opts.sourceText,
    sourceContentHash: opts.sourceContentHash,
    punctuationVersionId,
    punctuationContentHash: contentHash,
    structureMode: opts.structureMode,
    sourceMap,
    spans,
    spanIdByKey,
    anchorActorId: opts.anchorActorId,
    now: opts.now,
  });

  return { punctuationVersionId, anchorSetId, contentHash };
}

function insertPreparedTranslationAnchors(opts: {
  db: SqliteDb;
  projectId: string;
  documentNodeId: string;
  sourceVersionId: string;
  sourceText: string;
  sourceContentHash: string;
  punctuationVersionId: string;
  punctuationContentHash: string;
  structureMode: PunctuationStructureMode;
  sourceMap: PunctuationSourceMap;
  spans: PreparedStructureSpan[];
  spanIdByKey: Map<string, string>;
  anchorActorId: string;
  now: string;
}): string {
  const strategyKey = opts.structureMode === "poetry" ? "poetry-verse-line-v1" : "prose-sentence-v1";
  const anchorSets = schema.translation_anchor_sets;
  const existing = orm(opts.db).select({ id: anchorSets.id }).from(anchorSets).where(and(
    eq(anchorSets.punctuation_version_id, opts.punctuationVersionId),
    eq(anchorSets.strategy_key, strategyKey),
    eq(anchorSets.strategy_version, 1),
    eq(anchorSets.coverage_policy, "full_text"),
  )).get();
  if (existing) return existing.id;

  const leafKind: PunctuationSpanKind = opts.structureMode === "poetry" ? "verse_line" : "sentence";
  const spanByKey = new Map(opts.spans.map((span) => [span.spanKey, span]));
  const leaves = opts.spans
    .filter((span) => span.spanKind === leafKind)
    .sort((a, b) => a.codepointFrom - b.codepointFrom || a.codepointTo - b.codepointTo || a.ordinal - b.ordinal);
  const anchors = leaves.map((span, index) => {
    const sourceFrom = opts.sourceMap.sourceBoundaryByPunctuationBoundary[span.codepointFrom];
    const sourceTo = opts.sourceMap.sourceBoundaryByPunctuationBoundary[span.codepointTo];
    if (sourceFrom === undefined || sourceTo === undefined || sourceTo <= sourceFrom) {
      throw new MunhaeError("invalid_structure", `${span.spanKey} span에 대응하는 원문 문자가 없습니다`);
    }
    const sourceQuote = sliceCodepoints(opts.sourceText, sourceFrom, sourceTo);
    const linkedSpans = ancestorChain(span, spanByKey);
    const structureLinks = linkedSpans.map((linked) => ({
      spanKind: linked.spanKind,
      from: linked.codepointFrom,
      to: linked.codepointTo,
      quoteHash: linked.quoteHash,
      ordinal: linked.ordinal,
      parentPath: parentPath(linked, spanByKey),
    }));
    return {
      anchorKey: anchorKey(index + 1),
      ordinal: index + 1,
      boundaryKind: leafKind,
      punctuationFrom: span.codepointFrom,
      punctuationTo: span.codepointTo,
      punctuatedQuote: span.quote,
      punctuatedQuoteHash: span.quoteHash,
      sourceFrom,
      sourceTo,
      sourceQuote,
      sourceQuoteHash: sha256Hex(sourceQuote),
      contextBeforeHash: contextHash(opts.sourceText, Math.max(0, sourceFrom - 16), sourceFrom),
      contextAfterHash: contextHash(opts.sourceText, sourceTo, Math.min(codepointCount(opts.sourceText), sourceTo + 16)),
      structureLinks,
      spanKeys: linkedSpans.map((linked) => linked.spanKey),
    };
  });
  const anchorSetHash = canonicalJsonHash({
    sourceTextVersionId: opts.sourceVersionId,
    sourceHash: opts.sourceContentHash,
    punctuationVersionId: opts.punctuationVersionId,
    punctuationHash: opts.punctuationContentHash,
    strategyKey,
    strategyVersion: 1,
    coveragePolicy: "full_text",
    anchors: anchors.map(({ spanKeys: _spanKeys, punctuatedQuote: _punctuatedQuote, sourceQuote: _sourceQuote, ...anchor }) => anchor),
  });
  const anchorSetId = createId();
  orm(opts.db).insert(schema.translation_anchor_sets).values({
    id: anchorSetId,
    project_id: opts.projectId,
    document_node_id: opts.documentNodeId,
    source_text_version_id: opts.sourceVersionId,
    punctuation_version_id: opts.punctuationVersionId,
    strategy_key: strategyKey,
    strategy_version: 1,
    coverage_policy: "full_text",
    anchor_set_hash: anchorSetHash,
    created_by_actor_id: opts.anchorActorId,
    created_at: opts.now,
  }).run();
  for (const anchor of anchors) {
    const id = createId();
    orm(opts.db).insert(schema.translation_anchors).values({
      id,
      project_id: opts.projectId,
      anchor_set_id: anchorSetId,
      anchor_key: anchor.anchorKey,
      ordinal: anchor.ordinal,
      boundary_kind: anchor.boundaryKind,
      punctuation_codepoint_from: anchor.punctuationFrom,
      punctuation_codepoint_to: anchor.punctuationTo,
      punctuated_quote: anchor.punctuatedQuote,
      punctuated_quote_hash: anchor.punctuatedQuoteHash,
      source_codepoint_from: anchor.sourceFrom,
      source_codepoint_to: anchor.sourceTo,
      source_quote: anchor.sourceQuote,
      source_quote_hash: anchor.sourceQuoteHash,
      context_before_hash: anchor.contextBeforeHash,
      context_after_hash: anchor.contextAfterHash,
      display_label: anchor.anchorKey,
      required: 1,
      created_at: opts.now,
    }).run();
    anchor.spanKeys.forEach((spanKey, ordinal) => {
      orm(opts.db).insert(schema.translation_anchor_structure_spans).values({
        project_id: opts.projectId,
        anchor_id: id,
        punctuation_structure_span_id: opts.spanIdByKey.get(spanKey)!,
        ordinal: ordinal + 1,
      }).run();
    });
  }

  return anchorSetId;
}

export function ensureTranslationAnchorsForPunctuationVersion(opts: {
  db: SqliteDb;
  projectId: string;
  documentNodeId: string;
  punctuationVersionId: string;
  anchorActorId: string;
  now: string;
}): string {
  const punctuationVersions = schema.punctuation_versions;
  const punctuationSets = schema.punctuation_sets;
  const sourceTexts = schema.src_texts;
  const sourceVersions = schema.src_text_versions;
  const structureSpans = schema.punctuation_structure_spans;
  const dependency = orm(opts.db).select({
    source_version_id: punctuationVersions.source_text_version_id,
    source_text: sourceVersions.content_text,
    source_hash: sourceVersions.content_hash,
    punctuated_text: punctuationVersions.punctuated_text,
    punctuation_hash: punctuationVersions.content_hash,
    structure_json: punctuationVersions.structure_json,
  }).from(punctuationVersions)
    .innerJoin(punctuationSets, eq(punctuationSets.id, punctuationVersions.punctuation_set_id))
    .innerJoin(sourceTexts, eq(sourceTexts.id, punctuationSets.source_text_id))
    .innerJoin(sourceVersions, and(
      eq(sourceVersions.id, punctuationVersions.source_text_version_id),
      eq(sourceVersions.source_text_id, sourceTexts.id),
    ))
    .where(and(
      eq(punctuationVersions.id, opts.punctuationVersionId),
      eq(punctuationVersions.project_id, opts.projectId),
      eq(punctuationSets.project_id, opts.projectId),
      eq(sourceTexts.document_node_id, opts.documentNodeId),
    )).get();
  if (!dependency) throw new MunhaeError("invalid_dependency", "표점안의 원문 의존성을 찾을 수 없습니다");
  let structureMode: PunctuationStructureMode = "prose";
  if (dependency.structure_json) {
    try {
      const parsed = JSON.parse(dependency.structure_json) as { mode?: unknown; kind?: unknown };
      if (parsed.mode === "poetry" || parsed.kind === "poetry") structureMode = "poetry";
    } catch {
      throw new MunhaeError("invalid_structure", "표점 구조 설정이 올바른 JSON이 아닙니다");
    }
  }
  const stored = orm(opts.db).select({
    id: structureSpans.id,
    span_kind: structureSpans.span_kind,
    parent_span_id: structureSpans.parent_span_id,
    ordinal: structureSpans.ordinal,
    codepoint_from: structureSpans.codepoint_from,
    codepoint_to: structureSpans.codepoint_to,
    label: structureSpans.label,
  }).from(structureSpans).where(and(
    eq(structureSpans.project_id, opts.projectId),
    eq(structureSpans.punctuation_version_id, opts.punctuationVersionId),
  )).all();
  const supplied = stored.map((span) => ({
    spanKey: span.id,
    spanKind: punctuationSpanKind(span.span_kind),
    parentSpanKey: span.parent_span_id,
    ordinal: span.ordinal,
    codepointFrom: span.codepoint_from,
    codepointTo: span.codepoint_to,
    label: span.label,
  }));
  const sourceMap = validatePunctuationText(dependency.source_text, dependency.punctuated_text);
  const spans = prepareStructureSpans(dependency.punctuated_text, structureMode, supplied);
  const spanIdByKey = new Map(spans.map((span) => [span.spanKey, span.spanKey]));
  return insertPreparedTranslationAnchors({
    db: opts.db,
    projectId: opts.projectId,
    documentNodeId: opts.documentNodeId,
    sourceVersionId: dependency.source_version_id,
    sourceText: dependency.source_text,
    sourceContentHash: dependency.source_hash,
    punctuationVersionId: opts.punctuationVersionId,
    punctuationContentHash: dependency.punctuation_hash,
    structureMode,
    sourceMap,
    spans,
    spanIdByKey,
    anchorActorId: opts.anchorActorId,
    now: opts.now,
  });
}

export function insertSourceLayer(opts: {
  db: SqliteDb;
  projectId: string;
  documentNodeId: string;
  name: string;
  text: string;
  originKind: "paste" | "manual" | "import";
  policyVersionId: string;
  actors: ProjectActors;
  now: string;
  structureMode?: PunctuationStructureMode;
}): SourceLayerResult {
  const text = opts.text.replace(/^\uFEFF/, "");
  if (!text.trim()) throw new MunhaeError("empty_source", "원문이 비어 있습니다");
  const sourceTextId = createId();
  const sourceVersionId = createId();
  const sourceHash = sha256Hex(text);
  orm(opts.db).insert(schema.src_texts).values({
    id: sourceTextId,
    project_id: opts.projectId,
    document_node_id: opts.documentNodeId,
    name: opts.name,
    status: "active",
    created_at: opts.now,
    tombstoned_at: null,
  }).run();
  orm(opts.db).insert(schema.src_text_versions).values({
    id: sourceVersionId,
    project_id: opts.projectId,
    source_text_id: sourceTextId,
    parent_version_id: null,
    version_no: 1,
    content_text: text,
    origin_kind: opts.originKind,
    source_asset_id: null,
    page_from: null,
    page_to: null,
    locator_text: null,
    state: "draft",
    content_hash: sourceHash,
    created_by_actor_id: opts.actors.humanId,
    created_at: opts.now,
  }).run();
  orm(opts.db).insert(schema.src_text_heads).values({
    project_id: opts.projectId,
    source_text_id: sourceTextId,
    current_version_id: sourceVersionId,
    confirmed_version_id: null,
    lock_version: 1,
    updated_at: opts.now,
  }).run();

  return { sourceTextId, sourceVersionId };
}

function deriveStructureSpans(
  punctuatedText: string,
  mode: PunctuationStructureMode,
): PunctuationStructureSpanInput[] {
  return mode === "poetry" ? derivePoetrySpans(punctuatedText) : deriveProseSpans(punctuatedText);
}

export function punctuationSpanKind(value: string): PunctuationSpanKind {
  switch (value) {
    case "paragraph":
    case "sentence":
    case "verse_line":
    case "couplet":
    case "stanza":
    case "clause":
      return value;
    default:
      throw new MunhaeError("invalid_structure", `알 수 없는 structure span kind: ${value}`);
  }
}

function deriveProseSpans(text: string): PunctuationStructureSpanInput[] {
  const codepoints = Array.from(text);
  const paragraphs = logicalLineRanges(text);
  const out: PunctuationStructureSpanInput[] = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const paragraphKey = `p${paragraphIndex + 1}`;
    out.push({
      spanKey: paragraphKey,
      spanKind: "paragraph",
      parentSpanKey: null,
      ordinal: paragraphIndex + 1,
      codepointFrom: paragraph.from,
      codepointTo: paragraph.to,
    });
    const sentences: Range[] = [];
    let start = paragraph.from;
    let cursor = paragraph.from;
    while (cursor < paragraph.to) {
      if (SENTENCE_TERMINATOR.test(codepoints[cursor] ?? "")) {
        cursor += 1;
        while (cursor < paragraph.to && CLOSING_PUNCTUATION.test(codepoints[cursor] ?? "")) cursor += 1;
        while (cursor < paragraph.to && /\p{White_Space}/u.test(codepoints[cursor] ?? "")) cursor += 1;
        sentences.push({ from: start, to: cursor });
        start = cursor;
      } else {
        cursor += 1;
      }
    }
    if (start < paragraph.to) sentences.push({ from: start, to: paragraph.to });
    if (!sentences.length) sentences.push(paragraph);
    sentences.forEach((sentence, sentenceIndex) => {
      out.push({
        spanKey: `${paragraphKey}-s${sentenceIndex + 1}`,
        spanKind: "sentence",
        parentSpanKey: paragraphKey,
        ordinal: sentenceIndex + 1,
        codepointFrom: sentence.from,
        codepointTo: sentence.to,
      });
    });
  });
  return out;
}

function derivePoetrySpans(text: string): PunctuationStructureSpanInput[] {
  const rawLines = rawLineRanges(text);
  const logicalLines: Array<Range & { stanza: number }> = [];
  let stanza = 1;
  let pendingBreak = false;
  for (const line of rawLines) {
    const content = sliceCodepoints(text, line.from, line.to);
    if (!content.trim()) {
      const previous = logicalLines[logicalLines.length - 1];
      if (previous) previous.to = line.to;
      pendingBreak = true;
      continue;
    }
    if (pendingBreak && logicalLines.length) stanza += 1;
    const from = logicalLines.length === 0 ? 0 : line.from;
    logicalLines.push({ from, to: line.to, stanza });
    pendingBreak = false;
  }
  const trailing = logicalLines[logicalLines.length - 1];
  if (trailing) trailing.to = codepointCount(text);
  if (!logicalLines.length) throw new MunhaeError("invalid_structure", "운문에는 하나 이상의 논리적 시행이 필요합니다");

  const groups = new Map<number, Array<Range & { stanza: number }>>();
  for (const line of logicalLines) {
    const group = groups.get(line.stanza) ?? [];
    group.push(line);
    groups.set(line.stanza, group);
  }
  const out: PunctuationStructureSpanInput[] = [];
  let globalLine = 1;
  for (const [stanzaNo, lines] of groups) {
    const stanzaKey = `stanza-${stanzaNo}`;
    out.push({
      spanKey: stanzaKey,
      spanKind: "stanza",
      parentSpanKey: null,
      ordinal: stanzaNo,
      codepointFrom: lines[0]!.from,
      codepointTo: lines[lines.length - 1]!.to,
    });
    for (let index = 0; index < lines.length; index += 2) {
      const pair = lines.slice(index, index + 2);
      const coupletNo = Math.floor(index / 2) + 1;
      const coupletKey = `${stanzaKey}-couplet-${coupletNo}`;
      out.push({
        spanKey: coupletKey,
        spanKind: "couplet",
        parentSpanKey: stanzaKey,
        ordinal: coupletNo,
        codepointFrom: pair[0]!.from,
        codepointTo: pair[pair.length - 1]!.to,
      });
      pair.forEach((line, lineIndex) => {
        out.push({
          spanKey: `verse-${globalLine}`,
          spanKind: "verse_line",
          parentSpanKey: coupletKey,
          ordinal: lineIndex + 1,
          codepointFrom: line.from,
          codepointTo: line.to,
        });
        globalLine += 1;
      });
    }
  }
  return out;
}

function rawLineRanges(text: string): Range[] {
  const codepoints = Array.from(text);
  const out: Range[] = [];
  let start = 0;
  for (let index = 0; index < codepoints.length; index += 1) {
    if (codepoints[index] === "\n") {
      out.push({ from: start, to: index + 1 });
      start = index + 1;
    }
  }
  if (start < codepoints.length) out.push({ from: start, to: codepoints.length });
  return out.length ? out : [{ from: 0, to: codepoints.length }];
}

/** Merge blank physical lines into a neighbouring logical paragraph. */
function logicalLineRanges(text: string): Range[] {
  const raw = rawLineRanges(text);
  const out: Range[] = [];
  for (const line of raw) {
    const content = sliceCodepoints(text, line.from, line.to);
    if (!content.trim()) {
      const previous = out[out.length - 1];
      if (previous) previous.to = line.to;
      else out.push({ ...line });
      continue;
    }
    const previous = out[out.length - 1];
    if (previous && !sliceCodepoints(text, previous.from, previous.to).trim()) previous.to = line.to;
    else out.push({ ...line });
  }
  return out.length ? out : raw;
}

function assertAcyclic(byKey: Map<string, PreparedStructureSpan>): void {
  for (const span of byKey.values()) {
    const seen = new Set<string>();
    let current: PreparedStructureSpan | undefined = span;
    while (current?.parentSpanKey) {
      if (seen.has(current.spanKey)) {
        throw new MunhaeError("invalid_structure", "structure span parent 관계에 순환이 있습니다");
      }
      seen.add(current.spanKey);
      current = byKey.get(current.parentSpanKey);
    }
  }
}

function assertPartition(spans: PreparedStructureSpan[], from: number, to: number, label: string): void {
  const sorted = [...spans].sort(
    (a, b) => a.codepointFrom - b.codepointFrom || a.codepointTo - b.codepointTo || a.ordinal - b.ordinal,
  );
  if (!sorted.length) throw new MunhaeError("invalid_structure", `${label} span이 필요합니다`);
  let cursor = from;
  for (const span of sorted) {
    if (span.codepointFrom !== cursor || span.codepointTo > to) {
      throw new MunhaeError("invalid_structure", `${label} span은 겹침이나 빈틈 없이 범위를 덮어야 합니다`);
    }
    cursor = span.codepointTo;
  }
  if (cursor !== to) {
    throw new MunhaeError("invalid_structure", `${label} span은 겹침이나 빈틈 없이 범위를 덮어야 합니다`);
  }
}

function topologicalSpans(byKey: Map<string, PreparedStructureSpan>): PreparedStructureSpan[] {
  const depth = (span: PreparedStructureSpan): number => {
    let result = 0;
    let parentKey = span.parentSpanKey;
    while (parentKey) {
      result += 1;
      parentKey = byKey.get(parentKey)?.parentSpanKey ?? null;
    }
    return result;
  };
  return [...byKey.values()].sort(
    (a, b) =>
      depth(a) - depth(b) ||
      a.codepointFrom - b.codepointFrom ||
      a.codepointTo - b.codepointTo ||
      a.ordinal - b.ordinal ||
      a.spanKey.localeCompare(b.spanKey),
  );
}

function anchorKey(index: number): string {
  return `A${String(index).padStart(3, "0")}`;
}

function ancestorChain(
  span: PreparedStructureSpan,
  byKey: Map<string, PreparedStructureSpan>,
): PreparedStructureSpan[] {
  const chain = [span];
  let parentKey = span.parentSpanKey;
  while (parentKey) {
    const parent = byKey.get(parentKey);
    if (!parent) break;
    chain.push(parent);
    parentKey = parent.parentSpanKey;
  }
  return chain;
}

function parentPath(span: PreparedStructureSpan, byKey: Map<string, PreparedStructureSpan>): string[] {
  return ancestorChain(span, byKey)
    .slice(1)
    .reverse()
    .map((parent) => `${parent.spanKind}:${parent.ordinal}`);
}

function spanSignature(span: PreparedStructureSpan): Record<string, unknown> {
  return {
    spanKind: span.spanKind,
    ordinal: span.ordinal,
    codepointFrom: span.codepointFrom,
    codepointTo: span.codepointTo,
    quoteHash: span.quoteHash,
  };
}

function compareSpanManifest(
  a: { codepointFrom: number; codepointTo: number; spanKind: string; ordinal: number },
  b: { codepointFrom: number; codepointTo: number; spanKind: string; ordinal: number },
): number {
  return (
    a.codepointFrom - b.codepointFrom ||
    a.codepointTo - b.codepointTo ||
    a.spanKind.localeCompare(b.spanKind) ||
    a.ordinal - b.ordinal
  );
}

function contextHash(text: string, from: number, to: number): string | null {
  return from === to ? null : sha256Hex(sliceCodepoints(text, from, to));
}
