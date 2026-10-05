import type { ConcordanceInput, CreateTranslationNoteInput, DeleteTranslationNoteInput, ReviewExportInput, TranslationExportInput, UpdateTranslationNoteInput } from "../shared/munhae-api";
import { NOTE_CONFIDENCE, NOTE_KINDS } from "@munhae/db-sqlite";
import {
  type ArchiveReviewCommentInput,
  type ReadingAnnotationCasInput,
  type ReadingCitation,
  type SaveReadingAnnotationInput,
  type ContextItemCasInput,
  type SetMaterialPreferenceInput,
  type ReuseCommentAsMaterialInput,
  type ConfirmPunctuationInput,
  type ConfirmSourceInput,
  type ConfirmTranslationInput,
  type ConfirmedExportInput,
  type ContextPreviewInput,
  type GetProjectChatInput,
  type CreateContextItemInput,
  type CreateDocumentInput,
  type CreateFromPasteInput,
  type CreatePunctuationDraftInput,
  type CreateProjectInput,
  type CreateTranslationDraftInput,
  type CreateReviewCommentInput,
  type DocumentNodeRole,
  type MergeBlocksInput,
  type ResetTranslationDraftInput,
  type ReviseTranslationInput,
  type SavePunctuationDraftInput,
  type SaveSourceDraftInput,
  type SaveTranslationDraftInput,
  type SaveSentenceLinkInput,
  type SearchQueryInput,
  type SplitBlockInput,
  type StartProjectChatInput,
  type StartPunctuationSuggestionInput,
  type StartTranslationInput,
  type StructureSpanInput,
  type SetContextItemEnabledInput,
  type SetContextItemPriorityInput,
  type UpdateContextItemInput,
  type UpdateReviewCommentInput,
  type UpdateDocumentMetadataInput,
  type MoveDocumentInput,
  type DeleteDocumentInput,
  type VersionDiffInput,
} from "../shared/munhae-api";
import { AppError } from "./errors";


const DOCUMENT_NODE_ROLES: readonly DocumentNodeRole[] = ["container", "source_unit"];


const ORIGIN_KINDS = ["paste", "manual", "import"] as const;
const STRUCTURE_MODES = ["prose", "poetry"] as const;
const STRUCTURE_SPAN_KINDS = ["paragraph", "sentence", "verse_line", "couplet", "stanza"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(field: string): never {
  throw new AppError("invalid_payload", `${field} 값이 올바르지 않습니다.`);
}

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(field);
  return value;
}

export function asString(value: unknown, field: string, opts?: { optional?: boolean; max?: number }): string {
  if (value === undefined || value === null) {
    if (opts?.optional) return "";
    fail(field);
  }
  if (typeof value !== "string") fail(field);
  if (opts?.max !== undefined && value.length > opts.max) fail(field);
  return value;
}

export function asOptionalString(value: unknown, field: string, max?: number): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return undefined;
  return asString(value, field, { max });
}

export function asNonEmptyString(value: unknown, field: string, max = 500): string {
  const text = asString(value, field, { max }).trim();
  if (!text) fail(field);
  return text;
}

export function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(field);
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field);
  return value;
}

export function asOptionalInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return asInt(value, field);
}

export function asInt(value: unknown, field: string): number {
  const n = asNumber(value, field);
  if (!Number.isInteger(n)) fail(field);
  return n;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(field);
  return value.map((item, index) => asString(item, `${field}[${index}]`));
}

function asOneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(field);
  return value as T;
}

export function parseOptionalPath(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const path = asString(value, "path", { max: 4096 });
  if (path.includes("\0")) fail("path");
  return path;
}

export function parseCreateProjectInput(value: unknown): CreateProjectInput {
  const rec = asRecord(value, "input");
  return {
    title: asNonEmptyString(rec.title, "title", 200),
    parentDir: asOptionalString(rec.parentDir, "parentDir", 4096),
  };
}

export function parseCreateFromPasteInput(value: unknown): CreateFromPasteInput {
  const rec = asRecord(value, "input");
  const sourceText = asString(rec.sourceText, "sourceText", { max: 20_000_000 });
  if (sourceText.trim().length === 0) fail("sourceText");
  return {
    title: asNonEmptyString(rec.title, "title", 200),
    sourceText,
    parentDir: asOptionalString(rec.parentDir, "parentDir", 4096),
  };
}

export function parseCreateDocumentInput(value: unknown): CreateDocumentInput {
  const rec = asRecord(value, "input");
  const parentId = rec.parentId === null || rec.parentId === undefined ? null : asNonEmptyString(rec.parentId, "parentId", 80);
  const base = {
    title: asNonEmptyString(rec.title, "title", 500),
    originalTitle: asOptionalString(rec.originalTitle, "originalTitle", 500) ?? null,
    parentId,
  };
  const nodeRole = asOneOf(rec.nodeRole, "nodeRole", DOCUMENT_NODE_ROLES);
  if (nodeRole === "container") {
    if (rec.sourceText !== undefined || rec.originKind !== undefined) fail("sourceText");
    return { ...base, nodeRole };
  }
  const sourceText = asString(rec.sourceText, "sourceText", { max: 20_000_000 });
  return {
    ...base,
    nodeRole,
    originKind: asOneOf(rec.originKind, "originKind", ORIGIN_KINDS),
    sourceText,
  };
}

function parseExpectedLockVersion(value: unknown, field = "expectedLockVersion"): number {
  const lockVersion = asInt(value, field);
  if (lockVersion < 1) fail(field);
  return lockVersion;
}

export function parseSaveSourceDraftInput(value: unknown): SaveSourceDraftInput {
  const rec = asRecord(value, "input");
  const contentText = asString(rec.contentText, "contentText", { max: 20_000_000 });
  if (!contentText.trim()) fail("contentText");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    contentText,
    originKind: asOneOf(rec.originKind, "originKind", ORIGIN_KINDS),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
  };
}

export function parseConfirmSourceInput(value: unknown): ConfirmSourceInput {
  const rec = asRecord(value, "input");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
  };
}

function parseStructureSpans(value: unknown, punctuatedText: string): StructureSpanInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100_000) fail("structureSpans");
  const codepointLength = Array.from(punctuatedText).length;
  const keys = new Set<string>();
  const spans = value.map((item, index) => {
    const field = `structureSpans[${index}]`;
    const rec = asRecord(item, field);
    const spanKey = asNonEmptyString(rec.spanKey, `${field}.spanKey`, 200);
    if (keys.has(spanKey)) fail(`${field}.spanKey`);
    keys.add(spanKey);
    const parentSpanKey = rec.parentSpanKey === null
      ? null
      : asOptionalString(rec.parentSpanKey, `${field}.parentSpanKey`, 200);
    const ordinal = asInt(rec.ordinal, `${field}.ordinal`);
    const codepointFrom = asInt(rec.codepointFrom, `${field}.codepointFrom`);
    const codepointTo = asInt(rec.codepointTo, `${field}.codepointTo`);
    if (ordinal < 1 || codepointFrom < 0 || codepointTo <= codepointFrom || codepointTo > codepointLength) {
      fail(field);
    }
    return {
      spanKey,
      spanKind: asOneOf(rec.spanKind, `${field}.spanKind`, STRUCTURE_SPAN_KINDS),
      parentSpanKey,
      ordinal,
      codepointFrom,
      codepointTo,
      label: rec.label === null ? null : asOptionalString(rec.label, `${field}.label`, 500),
    };
  });
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    if (!span) continue;
    if (span.parentSpanKey && (!keys.has(span.parentSpanKey) || span.parentSpanKey === span.spanKey)) {
      fail(`structureSpans[${index}].parentSpanKey`);
    }
  }
  return spans;
}

export function parseSavePunctuationDraftInput(value: unknown): SavePunctuationDraftInput {
  const rec = asRecord(value, "input");
  const punctuatedText = asString(rec.punctuatedText, "punctuatedText", { max: 20_000_000 });
  if (!punctuatedText.trim()) fail("punctuatedText");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    punctuatedText,
    structureMode: asOneOf(rec.structureMode, "structureMode", STRUCTURE_MODES),
    structureSpans: parseStructureSpans(rec.structureSpans, punctuatedText),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
  };
}

export function parseConfirmPunctuationInput(value: unknown): ConfirmPunctuationInput {
  const rec = asRecord(value, "input");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
  };
}

export function parseCreatePunctuationDraftInput(value: unknown): CreatePunctuationDraftInput {
  const rec = asRecord(value, "input");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    structureMode: asOneOf(rec.structureMode, "structureMode", STRUCTURE_MODES),
    expectedSourceLockVersion: parseExpectedLockVersion(
      rec.expectedSourceLockVersion,
      "expectedSourceLockVersion",
    ),
  };
}

export function parseCreateTranslationDraftInput(value: unknown): CreateTranslationDraftInput {
  const rec = asRecord(value, "input");
  return {
    fullText: rec.fullText === true,
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    expectedSourceLockVersion: parseExpectedLockVersion(
      rec.expectedSourceLockVersion,
      "expectedSourceLockVersion",
    ),
    expectedPunctuationLockVersion: rec.fullText === true ? 0 : parseExpectedLockVersion(
      rec.expectedPunctuationLockVersion,
      "expectedPunctuationLockVersion",
    ),
  };
}

export function parseResetTranslationDraftInput(value: unknown): ResetTranslationDraftInput {
  const rec = asRecord(value, "input");
  return {
    ...parseCreateTranslationDraftInput(value),
    expectedTranslationLockVersion: parseExpectedLockVersion(
      rec.expectedTranslationLockVersion,
      "expectedTranslationLockVersion",
    ),
  };
}

export function parseSaveDraftInput(value: unknown): SaveTranslationDraftInput {
  const rec = asRecord(value, "input");
  if (!Array.isArray(rec.blocks)) fail("blocks");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    ...(rec.textBaseVersionId === undefined && rec.textBaseRevision === undefined ? {} : {
      textBaseVersionId: asNonEmptyString(rec.textBaseVersionId, "textBaseVersionId", 80),
      textBaseRevision: asNonEmptyString(rec.textBaseRevision, "textBaseRevision", 64),
    }),
    textContent: asString(rec.textContent, "textContent", { max: 20_000_000 }),
    ...(rec.textGroups === undefined ? {} : { textGroups: (() => {
      if (!Array.isArray(rec.textGroups)) fail("textGroups");
      return rec.textGroups.map((value, index) => {
        const group = asRecord(value, `textGroups[${index}]`);
        if (!Array.isArray(group.spans)) fail("spans");
        const hasRange = group.from !== undefined || group.to !== undefined;
        if (hasRange && (!Number.isSafeInteger(group.from) || !Number.isSafeInteger(group.to))) fail("group range");
        return { id: asNonEmptyString(group.id, "id", 160), text: asString(group.text, "text", { max: 20_000_000 }),
          ...(hasRange ? { from: group.from as number, to: group.to as number } : {}),
          spans: group.spans.map(value => {
            const span = asRecord(value, "span");
            if (!Number.isSafeInteger(span.from) || !Number.isSafeInteger(span.to)) fail("span range");
            return { from: span.from as number, to: span.to as number, quote: asString(span.quote, "quote", { max: 20_000_000 }) };
          }) };
      });
    })() }),
    blocks: rec.blocks.map((block, index) => {
      const row = asRecord(block, `blocks[${index}]`);
      return {
        blockKey: asNonEmptyString(row.blockKey, "blockKey", 80),
        blockKind: asNonEmptyString(row.blockKind, "blockKind", 64),
        translation: asString(row.translation, "translation", { max: 20_000_000 }),
        sourceAnchorIds: asStringArray(row.sourceAnchorIds, "sourceAnchorIds"),
        ...(row.relationKinds === undefined
          ? {}
          : { relationKinds: asStringArray(row.relationKinds, "relationKinds") }),
      };
    }),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
  };
}

export function parseConfirmInput(value: unknown): ConfirmTranslationInput {
  const rec = asRecord(value, "input");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
  };
}

export function parseReviseTranslationInput(value: unknown): ReviseTranslationInput {
  return parseConfirmInput(value);
}

/** Kind, confidence, text and alternative readings, shared by adding and rewriting a note. */
function parseNoteContent(rec: Record<string, unknown>) {
  const alternatives = rec.alternatives === undefined ? [] : asStringArray(rec.alternatives, "alternatives");
  if (alternatives.length > 3 || alternatives.some(item => item.length > 1_200)) fail("alternatives");
  return {
    kind: asOneOf(rec.kind, "kind", NOTE_KINDS),
    confidence: asOneOf(rec.confidence, "confidence", NOTE_CONFIDENCE),
    bodyMd: asString(rec.bodyMd, "bodyMd", { max: 8_000 }),
    alternatives,
  };
}

export function parseCreateTranslationNoteInput(value: unknown): CreateTranslationNoteInput {
  const rec = asRecord(value, "input");
  const codepointFrom = asInt(rec.codepointFrom, "codepointFrom");
  const codepointTo = asInt(rec.codepointTo, "codepointTo");
  if (codepointFrom < 0 || codepointTo <= codepointFrom || codepointTo > 20_000_000) fail("range");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    versionId: asNonEmptyString(rec.versionId, "versionId", 80),
    codepointFrom,
    codepointTo,
    quote: asString(rec.quote, "quote", { max: 1_200 }),
    ...parseNoteContent(rec),
  };
}

export function parseUpdateTranslationNoteInput(value: unknown): UpdateTranslationNoteInput {
  const rec = asRecord(value, "input");
  return { ...parseDeleteTranslationNoteInput(rec), ...parseNoteContent(rec) };
}

export function parseDeleteTranslationNoteInput(value: unknown): DeleteTranslationNoteInput {
  const rec = asRecord(value, "input");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    versionId: asNonEmptyString(rec.versionId, "versionId", 80),
    noteId: asNonEmptyString(rec.noteId, "noteId", 80),
  };
}

export function parseCreateReviewCommentInput(value: unknown): CreateReviewCommentInput {
  const rec = asRecord(value, "input");
  const codepointFrom = asInt(rec.codepointFrom, "codepointFrom");
  const codepointTo = asInt(rec.codepointTo, "codepointTo");
  const quote = asString(rec.quote, "quote", { max: 100_000 });
  if (!Number.isSafeInteger(codepointFrom) || !Number.isSafeInteger(codepointTo)
    || codepointFrom < 0 || codepointTo <= codepointFrom || codepointTo > 20_000_000) fail("range");
  if (!quote.trim() || Array.from(quote).length !== codepointTo - codepointFrom) fail("quote");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    translationVersionId: asNonEmptyString(rec.translationVersionId, "translationVersionId", 80),
    targetKind: asOneOf(rec.targetKind, "targetKind", ["source", "translation"] as const),
    targetVersionId: asNonEmptyString(rec.targetVersionId, "targetVersionId", 80),
    codepointFrom,
    codepointTo,
    quote,
    bodyMd: asNonEmptyString(rec.bodyMd, "bodyMd", 20_000),
  };
}

export function parseSaveSentenceLinkInput(value: unknown): SaveSentenceLinkInput {
  const rec = asRecord(value, "input");
  if (Object.keys(rec).some((key) => !["documentNodeId", "versionId", "sentenceId", "spans", "expectedLockVersion"].includes(key))) fail("input");
  const expectedLockVersion = parseExpectedLockVersion(rec.expectedLockVersion);
  if (!Number.isSafeInteger(expectedLockVersion)) fail("expectedLockVersion");
  if (!Array.isArray(rec.spans) || rec.spans.length < 1 || rec.spans.length > 100) fail("spans");
  const spans = rec.spans.map((value) => {
    const span = asRecord(value, "span");
    if (Object.keys(span).some((key) => !["from", "to", "quote"].includes(key))) fail("span");
    const from = asInt(span.from, "from"), to = asInt(span.to, "to");
    const quote = asString(span.quote, "quote", { max: 100_000 });
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > 20_000_000) fail("range");
    if (!quote.trim() || Array.from(quote).length !== to - from) fail("quote");
    return { from, to, quote };
  });
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    versionId: asNonEmptyString(rec.versionId, "versionId", 80),
    sentenceId: asNonEmptyString(rec.sentenceId, "sentenceId", 80),
    spans,
    expectedLockVersion,
  };
}

export function parseArchiveReviewCommentInput(value: unknown): ArchiveReviewCommentInput {
  const rec = asRecord(value, "input");
  const expectedLockVersion = parseExpectedLockVersion(rec.expectedLockVersion);
  if (!Number.isSafeInteger(expectedLockVersion)) fail("expectedLockVersion");
  return { id: asNonEmptyString(rec.id, "id", 80), expectedLockVersion };
}

function assertReadingFields(rec: Record<string, unknown>, fields: readonly string[], field: string): void {
  if (Object.keys(rec).some((key) => !fields.includes(key))) fail(field);
}

function parseReadingText(value: unknown, field: string, max: number, required = false): string {
  const text = asString(value, field, { max });
  if (/[\u0000\p{Surrogate}]/u.test(text) || (required && !text.trim())) fail(field);
  return text;
}

function parseReadingUrl(value: unknown, field: string): string {
  const text = parseReadingText(value, field, 2_048, true);
  let url: URL;
  try { url = new URL(text); } catch { fail(field); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) fail(field);
  return text;
}

function parseReadingCitation(value: unknown): ReadingCitation | null {
  if (value === null) return null;
  const rec = asRecord(value, "citation");
  assertReadingFields(rec, ["source", "sourceLabel", "entryId", "headword", "reading", "sense", "senseLabel", "sourceUrl", "license", "licenseUrl", "attribution"], "citation");
  const citation: ReadingCitation = {
    source: parseReadingText(rec.source, "citation.source", 100, true),
    sourceLabel: parseReadingText(rec.sourceLabel, "citation.sourceLabel", 500, true),
    entryId: parseReadingText(rec.entryId, "citation.entryId", 500, true),
    headword: parseReadingText(rec.headword, "citation.headword", 500, true),
    reading: rec.reading === null ? null : parseReadingText(rec.reading, "citation.reading", 100),
    sense: parseReadingText(rec.sense, "citation.sense", 20_000, true),
    ...(rec.senseLabel === undefined ? {} : { senseLabel: parseReadingText(rec.senseLabel, "citation.senseLabel", 500) }),
    sourceUrl: parseReadingUrl(rec.sourceUrl, "citation.sourceUrl"),
    license: parseReadingText(rec.license, "citation.license", 1_000, true),
    licenseUrl: rec.licenseUrl === null ? null : parseReadingUrl(rec.licenseUrl, "citation.licenseUrl"),
    attribution: parseReadingText(rec.attribution, "citation.attribution", 5_000),
  };
  if (JSON.stringify(citation).length > 40_000) fail("citation");
  return citation;
}

export function parseSaveReadingAnnotationInput(value: unknown): SaveReadingAnnotationInput {
  const rec = asRecord(value, "input");
  assertReadingFields(rec, ["id", "documentNodeId", "sourceVersionId", "codepointFrom", "codepointTo", "quote", "reading", "gloss", "readingOrder", "citation", "translationQuote", "expectedLockVersion"], "input");
  const id = rec.id === undefined ? undefined : asNonEmptyString(rec.id, "id", 80);
  const expectedLockVersion = asInt(rec.expectedLockVersion, "expectedLockVersion");
  if (!Number.isSafeInteger(expectedLockVersion) || (id ? expectedLockVersion < 1 : expectedLockVersion !== 0)) fail("expectedLockVersion");
  const codepointFrom = asInt(rec.codepointFrom, "codepointFrom");
  const codepointTo = asInt(rec.codepointTo, "codepointTo");
  const quote = parseReadingText(rec.quote, "quote", 200, true);
  if (!Number.isSafeInteger(codepointFrom) || !Number.isSafeInteger(codepointTo)
    || codepointFrom < 0 || codepointTo <= codepointFrom || codepointTo > 20_000_000
    || codepointTo - codepointFrom > 100) fail("range");
  if (!quote.trim() || Array.from(quote).length !== codepointTo - codepointFrom) fail("quote");
  const reading = parseReadingText(rec.reading, "reading", 100).trim();
  const gloss = parseReadingText(rec.gloss, "gloss", 2_000).trim();
  const readingOrder = rec.readingOrder === null ? null : asInt(rec.readingOrder, "readingOrder");
  if (readingOrder !== null && (readingOrder < 1 || readingOrder > 1_000_000)) fail("readingOrder");
  const citation = parseReadingCitation(rec.citation);
  const translationQuote = rec.translationQuote === null ? null : parseReadingText(rec.translationQuote, "translationQuote", 500).trim() || null;
  if (!reading && !gloss && readingOrder === null && citation === null) fail("annotation");
  return {
    ...(id === undefined ? {} : { id }),
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    sourceVersionId: asNonEmptyString(rec.sourceVersionId, "sourceVersionId", 80),
    codepointFrom, codepointTo, quote, reading, gloss, readingOrder, citation, translationQuote, expectedLockVersion,
  };
}

export function parseArchiveReadingAnnotationInput(value: unknown): ReadingAnnotationCasInput {
  const rec = asRecord(value, "input");
  assertReadingFields(rec, ["id", "expectedLockVersion"], "input");
  const expectedLockVersion = parseExpectedLockVersion(rec.expectedLockVersion);
  if (!Number.isSafeInteger(expectedLockVersion)) fail("expectedLockVersion");
  return { id: asNonEmptyString(rec.id, "id", 80), expectedLockVersion };
}

export function parseUpdateReviewCommentInput(value: unknown): UpdateReviewCommentInput {
  const rec = asRecord(value, "input");
  return {
    ...parseArchiveReviewCommentInput(value),
    bodyMd: asNonEmptyString(rec.bodyMd, "bodyMd", 20_000),
  };
}

export function parseMergeBlocksInput(value: unknown): MergeBlocksInput {
  const rec = asRecord(value, "input");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    leftBlockKey: asNonEmptyString(rec.leftBlockKey, "leftBlockKey", 80),
    rightBlockKey: asNonEmptyString(rec.rightBlockKey, "rightBlockKey", 80),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
  };
}

export function parseSplitBlockInput(value: unknown): SplitBlockInput {
  const rec = asRecord(value, "input");
  const splitAt = asInt(rec.splitAt, "splitAt");
  if (splitAt < 1) fail("splitAt");
  const anchorSplitAt = asOptionalInt(rec.anchorSplitAt, "anchorSplitAt");
  if (anchorSplitAt !== undefined && anchorSplitAt < 1) fail("anchorSplitAt");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    blockKey: asNonEmptyString(rec.blockKey, "blockKey", 80),
    splitAt,
    anchorSplitAt,
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
  };
}

export function parseDocumentNodeId(value: unknown): string {
  return asNonEmptyString(value, "documentNodeId", 80);
}

export function parseAssetId(value: unknown): string {
  return asNonEmptyString(value, "assetId", 80);
}

export function parseContextPreviewInput(value: unknown): ContextPreviewInput {
  const rec = asRecord(value, "input");
  if (rec.selections !== undefined && !Array.isArray(rec.selections)) fail("selections");
  if ((rec.selections?.length ?? 0) > 10_000) fail("selections");
  const seen = new Set<string>();
  const selections = (rec.selections ?? []).map((selection, index) => {
    const row = asRecord(selection, `selections[${index}]`);
    const id = asNonEmptyString(row.id, `selections[${index}].id`, 200);
    if (seen.has(id)) fail(`selections[${index}].id`);
    seen.add(id);
    return {
      id,
      mode: asOneOf(row.mode, `selections[${index}].mode`, ["auto", "pin", "exclude"] as const),
    };
  });
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    selections,
    ...(rec.revision === undefined ? {} : { revision: parseTranslationRevisionInput(rec.revision) }),
    ...(rec.referenceCommentIds === undefined ? {} : { referenceCommentIds: parseReferenceCommentIds(rec.referenceCommentIds) }),
  };
}

function parseReferenceCommentIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) fail("referenceCommentIds");
  const ids = value.map((id, index) => asNonEmptyString(id, `referenceCommentIds[${index}]`, 80));
  if (new Set(ids).size !== ids.length) fail("referenceCommentIds");
  return ids;
}

function parseTranslationRevisionInput(value: unknown): NonNullable<ContextPreviewInput["revision"]> {
  const rec = asRecord(value, "revision");
  if (Object.keys(rec).some((key) => key !== "baseVersionId" && key !== "commentIds")) fail("revision");
  if (!Array.isArray(rec.commentIds) || rec.commentIds.length < 1 || rec.commentIds.length > 500) fail("revision.commentIds");
  const commentIds = rec.commentIds.map((id, index) => asNonEmptyString(id, `revision.commentIds[${index}]`, 80));
  if (new Set(commentIds).size !== commentIds.length) fail("revision.commentIds");
  return { baseVersionId: asNonEmptyString(rec.baseVersionId, "revision.baseVersionId", 80), commentIds };
}

export function parseStartTranslationInput(value: unknown): StartTranslationInput {
  const context = parseContextPreviewInput(value);
  const rec = asRecord(value, "input");
  if (context.revision && rec.alignmentVersionId !== undefined) fail("alignmentVersionId");
  return {
    ...(rec.alignmentVersionId === undefined ? {} : { alignmentVersionId: asNonEmptyString(rec.alignmentVersionId, "alignmentVersionId", 80) }),
    ...context,
    agentId: asOneOf(rec.agentId, "agentId", ["codex", "claude", "antigravity"] as const),
  };
}

export function parseAgentId(value: unknown): "codex" | "claude" | "antigravity" {
  return asOneOf(value, "agentId", ["codex", "claude", "antigravity"] as const);
}

export function parseStartProjectChatInput(value: unknown): StartProjectChatInput {
  const rec = asRecord(value, "input");
  if (Object.prototype.hasOwnProperty.call(rec, "projectId")) fail("projectId");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    scopeKind: asOneOf(rec.scopeKind, "scopeKind", ["document_node", "project"] as const),
    question: asNonEmptyString(rec.question, "question", 100_000),
    agentId: parseAgentId(rec.agentId),
  };
}

export function parseGetProjectChatInput(value: unknown): GetProjectChatInput {
  const rec = asRecord(value, "input");
  if (Object.prototype.hasOwnProperty.call(rec, "projectId")) fail("projectId");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    scopeKind: asOneOf(rec.scopeKind, "scopeKind", ["document_node", "project"] as const),
  };
}

export function parseStartPunctuationSuggestionInput(value: unknown): StartPunctuationSuggestionInput {
  const rec = asRecord(value, "input");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    structureMode: asOneOf(rec.structureMode, "structureMode", STRUCTURE_MODES),
    agentId: parseAgentId(rec.agentId),
  };
}

/** Matches the SKILL.md name rule; installed plugins live in a folder of this name. */
export function parsePluginName(value: unknown): string {
  const name = asNonEmptyString(value, "name", 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail("name");
  return name;
}

export function parseMessageId(value: unknown): string {
  return asNonEmptyString(value, "messageId", 80);
}

function nullableString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = asString(value, field, { max }).trim();
  return text || null;
}

export function parseUpdateDocumentMetadataInput(value: unknown): UpdateDocumentMetadataInput {
  const rec = asRecord(value, "input");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    title: asNonEmptyString(rec.title, "title", 500),
    originalTitle: nullableString(rec.originalTitle, "originalTitle", 500),
    authorName: nullableString(rec.authorName, "authorName", 500),
    language: nullableString(rec.language, "language", 80),
    periodText: nullableString(rec.periodText, "periodText", 500),
    dateText: nullableString(rec.dateText, "dateText", 500),
    descriptionMd: nullableString(rec.descriptionMd, "descriptionMd", 100_000),
    sourceReference: nullableString(rec.sourceReference, "sourceReference", 4_000),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
  };
}

function parseContextItemBody(value: unknown, field: string, allowEmpty = false): CreateContextItemInput {
  const rec = asRecord(value, field);
  const priority = asInt(rec.priority, `${field}.priority`);
  if (priority < -1_000_000 || priority > 1_000_000) fail(`${field}.priority`);
  return {
    scopeId: asNonEmptyString(rec.scopeId, `${field}.scopeId`, 80),
    title: asNonEmptyString(rec.title, `${field}.title`, 500),
    contentMd: allowEmpty ? asString(rec.contentMd, `${field}.contentMd`, { max: 200_000 }) : asNonEmptyString(rec.contentMd, `${field}.contentMd`, 200_000),
    ...(rec.inheritToChildren === undefined ? {} : { inheritToChildren: asBoolean(rec.inheritToChildren, `${field}.inheritToChildren`) }),
    ...(rec.conditionMd === undefined ? {} : { conditionMd: asString(rec.conditionMd, `${field}.conditionMd`, { max: 20_000 }) }),
    priority,
    enabled: asBoolean(rec.enabled, `${field}.enabled`),
  };
}

export function parseSetMaterialPreferenceInput(value: unknown): SetMaterialPreferenceInput {
  const rec = asRecord(value, "input");
  const expectedLockVersion = rec.expectedLockVersion === undefined ? undefined : asInt(rec.expectedLockVersion, "input.expectedLockVersion");
  if (expectedLockVersion !== undefined && expectedLockVersion < 0) fail("input.expectedLockVersion");
  return {
    documentNodeId: parseDocumentNodeId(rec.documentNodeId),
    source: asOneOf(rec.source, "input.source", ["context_item", "document_description", "comment_reference"] as const),
    sourceId: asNonEmptyString(rec.sourceId, "input.sourceId", 80),
    mode: asOneOf(rec.mode, "input.mode", ["include", "exclude", "reset"] as const),
    ...(expectedLockVersion === undefined ? {} : { expectedLockVersion }),
  };
}

export function parseReuseCommentAsMaterialInput(value: unknown): ReuseCommentAsMaterialInput {
  const rec = asRecord(value, "input");
  return {
    ...parseContextItemBody(value, "input", true),
    commentId: asNonEmptyString(rec.commentId, "input.commentId", 80),
    expectedCommentLockVersion: parseExpectedLockVersion(rec.expectedCommentLockVersion, "input.expectedCommentLockVersion"),
  };
}

export function parseCreateContextItemInput(value: unknown): CreateContextItemInput {
  return parseContextItemBody(value, "input");
}

export function parseUpdateContextItemInput(value: unknown): UpdateContextItemInput {
  const rec = asRecord(value, "input");
  return {
    ...parseContextItemBody(value, "input", true),
    ...(rec.expectedCommentLockVersion === undefined ? {} : { expectedCommentLockVersion: parseExpectedLockVersion(rec.expectedCommentLockVersion) }),
    ...(rec.keepAsContext === undefined ? {} : { keepAsContext: asBoolean(rec.keepAsContext, "input.keepAsContext") }),
    id: asNonEmptyString(rec.id, "input.id", 80),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion, "input.expectedLockVersion"),
  };
}

export function parseContextItemCasInput(value: unknown): ContextItemCasInput {
  const rec = asRecord(value, "input");
  return {
    id: asNonEmptyString(rec.id, "input.id", 80),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion, "input.expectedLockVersion"),
  };
}

export function parseSetContextItemEnabledInput(value: unknown): SetContextItemEnabledInput {
  const rec = asRecord(value, "input");
  return { ...parseContextItemCasInput(value), enabled: asBoolean(rec.enabled, "input.enabled") };
}

export function parseSetContextItemPriorityInput(value: unknown): SetContextItemPriorityInput {
  const rec = asRecord(value, "input");
  const priority = asInt(rec.priority, "input.priority");
  if (priority < -1_000_000 || priority > 1_000_000) fail("input.priority");
  return { ...parseContextItemCasInput(value), priority };
}

export function parseConfirmedExportInput(value: unknown): ConfirmedExportInput {
  const rec = asRecord(value, "input");
  return {
    format: asOneOf(rec.format, "input.format", ["markdown", "json", "csv"] as const),
    documentNodeId: nullableString(rec.documentNodeId, "input.documentNodeId", 80),
  };
}

export function parseVersionDiffInput(value: unknown): VersionDiffInput {
  const rec = asRecord(value, "input");
  const kind = asOneOf(rec.kind, "input.kind", ["source", "punctuation", "translation"] as const);
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "input.documentNodeId", 80),
    kind,
    stage: kind === "translation" ? asNonEmptyString(rec.stage, "input.stage", 64) : null,
    baseVersionId: asNonEmptyString(rec.baseVersionId, "input.baseVersionId", 80),
    targetVersionId: asNonEmptyString(rec.targetVersionId, "input.targetVersionId", 80),
  };
}

export function parseSearchQueryInput(value: unknown): SearchQueryInput {
  const rec = asRecord(value, "input");
  const limit = asOptionalInt(rec.limit, "input.limit");
  if (limit !== undefined && (limit < 1 || limit > 200)) fail("input.limit");
  const entityFilter = rec.entityFilter === undefined || rec.entityFilter === null
    ? null
    : (() => {
        const filter = asRecord(rec.entityFilter, "input.entityFilter");
        return {
          entityType: asOneOf(
            filter.entityType,
            "input.entityFilter.entityType",
            ["term"] as const,
          ),
          entityId: asNonEmptyString(filter.entityId, "input.entityFilter.entityId", 80),
        };
      })();
  return {
    query: asNonEmptyString(rec.query, "input.query", 500),
    scope: rec.scope === undefined
      ? "all"
      : asOneOf(rec.scope, "input.scope", ["all", "source", "translation"] as const),
    state: rec.state === undefined
      ? "current"
      : asOneOf(rec.state, "input.state", ["current", "confirmed", "all"] as const),
    documentNodeId: nullableString(rec.documentNodeId, "input.documentNodeId", 80),
    entityFilter,
    ...(limit === undefined ? {} : { limit }),
  };
}

export function parseConcordanceInput(value: unknown): ConcordanceInput {
  const rec = asRecord(value, "input");
  const limit = asOptionalInt(rec.limit, "input.limit");
  if (limit !== undefined && (limit < 1 || limit > 200)) fail("input.limit");
  return { query: asNonEmptyString(rec.query, "input.query", 500),
    scope: rec.scope === undefined ? "all" : asOneOf(rec.scope, "input.scope", ["all", "source", "translation"] as const),
    state: rec.state === undefined ? "current" : asOneOf(rec.state, "input.state", ["current", "confirmed"] as const),
    documentNodeId: nullableString(rec.documentNodeId, "input.documentNodeId", 80), limit };
}
export function parseReviewExportInput(value: unknown): ReviewExportInput {
  const rec = asRecord(value, "input");
  if (rec.includeComments !== undefined && typeof rec.includeComments !== "boolean") fail("input.includeComments");
  return { format: asOneOf(rec.format, "input.format", ["html", "markdown"] as const),
    state: asOneOf(rec.state, "input.state", ["current", "confirmed"] as const),
    documentNodeId: nullableString(rec.documentNodeId, "input.documentNodeId", 80), includeComments: rec.includeComments as boolean | undefined };
}

export function parseTranslationExportInput(value: unknown): TranslationExportInput {
  const rec = asRecord(value, "input");
  return { format: asOneOf(rec.format, "input.format", ["docx", "pdf", "txt", "markdown"] as const),
    layout: asOneOf(rec.layout, "input.layout", ["translation", "bilingual"] as const),
    state: asOneOf(rec.state, "input.state", ["current", "confirmed"] as const),
    documentNodeId: nullableString(rec.documentNodeId, "input.documentNodeId", 80) };
}

export function parseTermMaterialExclusions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10000) throw new AppError("invalid_input", "제외할 참고 자료 목록을 확인하세요.");
  return [...new Set(value.map(id => asNonEmptyString(id, "excludedMaterialId", 200)))];
}

export function parseTermReferenceSelection(value: unknown): import("../shared/term-references").TermReferenceSelection {
  if (value === undefined) return { enabled: true, excludedIds: [] };
  const rec = asRecord(value, "referenceSelection");
  if (typeof rec.enabled !== "boolean") throw new AppError("invalid_input", "참고 용어 사용 여부를 확인하세요.");
  return { enabled: rec.enabled, excludedIds: parseTermMaterialExclusions(rec.excludedIds) };
}

export function parseDeleteDocumentInput(value: unknown): DeleteDocumentInput {
  const rec = asRecord(value, "input");
  if (typeof rec.removeTermsAndComments !== "boolean") throw new AppError("invalid_input", "용어·코멘트 정리 여부를 확인하세요.");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
    removeTermsAndComments: rec.removeTermsAndComments,
  };
}

export function parseMoveDocumentInput(value: unknown): MoveDocumentInput {
  const rec = asRecord(value, "input");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    parentId: asNonEmptyString(rec.parentId, "parentId", 80),
    beforeDocumentNodeId: rec.beforeDocumentNodeId === null ? null : asNonEmptyString(rec.beforeDocumentNodeId, "beforeDocumentNodeId", 80),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
  };
}
