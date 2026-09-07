import {
  type ArchiveReviewCommentInput,
  type ContextItemCasInput,
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
  type CreateUncertaintyInput,
  type CreateUncertaintyVersionInput,
  type DocumentNodeRole,
  type MergeBlocksInput,
  type ResetTranslationDraftInput,
  type ReviseTranslationInput,
  type ResolveUncertaintyInput,
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
  type UncertaintyAnchorInput,
  type UpsertGlossaryInput,
  type UpsertPersonInput,
  type UpsertPlaceInput,
  type UpdateContextItemInput,
  type UpdateReviewCommentInput,
  type UpdateDocumentMetadataInput,
  type VersionDiffInput,
} from "../shared/munhae-api";
import { AppError } from "./errors";


const DOCUMENT_NODE_ROLES: readonly DocumentNodeRole[] = ["container", "source_unit"];


const ORIGIN_KINDS = ["paste", "manual", "import"] as const;
const STRUCTURE_MODES = ["prose", "poetry"] as const;
const STRUCTURE_SPAN_KINDS = ["paragraph", "sentence", "verse_line", "couplet", "stanza"] as const;
const USAGE_STATUSES = ["preferred", "allowed", "forbidden"] as const;
const UNCERTAINTY_CATEGORIES = ["textual", "interpretive", "identification"] as const;
const UNCERTAINTY_TARGET_KINDS: readonly UncertaintyAnchorInput["targetKind"][] = [
  "document_node",
  "source_text_version",
  "punctuation_version",
  "translation_anchor",
  "document_translation",
  "document_translation_version",
];

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
  if (!sourceText.trim()) fail("sourceText");
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

function parseNullableSummary(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const summary = asString(value, field, { max: 2_000 }).trim();
  return summary || null;
}

export function parseSaveSourceDraftInput(value: unknown): SaveSourceDraftInput {
  const rec = asRecord(value, "input");
  const contentText = asString(rec.contentText, "contentText", { max: 20_000_000 });
  if (!contentText.trim()) fail("contentText");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    contentText,
    originKind: asOneOf(rec.originKind, "originKind", ORIGIN_KINDS),
    changeSummary: parseNullableSummary(rec.changeSummary, "changeSummary"),
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
    changeSummary: parseNullableSummary(rec.changeSummary, "changeSummary"),
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
    textContent: asString(rec.textContent, "textContent", { max: 20_000_000 }),
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
  };
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

export function parseMessageId(value: unknown): string {
  return asNonEmptyString(value, "messageId", 80);
}

export function parseGlossaryInput(
  value: unknown,
): UpsertGlossaryInput {
  const rec = asRecord(value, "entry");
  const id = asOptionalString(rec.id, "id", 80);
  return {
    id,
    expectedLockVersion: id ? parseExpectedLockVersion(rec.expectedLockVersion) : undefined,
    sourceTerm: asNonEmptyString(rec.sourceTerm, "sourceTerm", 500),
    targetTerm: asNonEmptyString(rec.targetTerm, "targetTerm", 500),
    targetLocale: asNonEmptyString(rec.targetLocale, "targetLocale", 32),
    termKind: asNonEmptyString(rec.termKind, "termKind", 64),
    reading: rec.reading === null ? null : asOptionalString(rec.reading, "reading", 200) ?? null,
    noteMd: rec.noteMd === null ? null : asOptionalString(rec.noteMd, "noteMd", 20_000) ?? null,
    usageStatus: asOneOf(rec.usageStatus, "usageStatus", USAGE_STATUSES),
  };
}

export function parsePersonInput(value: unknown): UpsertPersonInput {
  const rec = asRecord(value, "person");
  const id = asOptionalString(rec.id, "id", 80);
  return {
    id,
    expectedLockVersion: id ? parseExpectedLockVersion(rec.expectedLockVersion) : undefined,
    preferredName: asNonEmptyString(rec.preferredName, "preferredName", 200),
    hanjaName: rec.hanjaName === null ? null : asOptionalString(rec.hanjaName, "hanjaName", 200) ?? null,
    reading: rec.reading === null ? null : asOptionalString(rec.reading, "reading", 200) ?? null,
    aliases: rec.aliases === undefined ? [] : asStringArray(rec.aliases, "aliases"),
    descriptionMd:
      rec.descriptionMd === null ? null : asOptionalString(rec.descriptionMd, "descriptionMd", 20_000) ?? null,
    dateText: rec.dateText === null ? null : asOptionalString(rec.dateText, "dateText", 200) ?? null,
  };
}

export function parsePlaceInput(value: unknown): UpsertPlaceInput {
  const rec = asRecord(value, "place");
  const id = asOptionalString(rec.id, "id", 80);
  return {
    id,
    expectedLockVersion: id ? parseExpectedLockVersion(rec.expectedLockVersion) : undefined,
    preferredName: asNonEmptyString(rec.preferredName, "preferredName", 200),
    hanjaName: rec.hanjaName === null ? null : asOptionalString(rec.hanjaName, "hanjaName", 200) ?? null,
    reading: rec.reading === null ? null : asOptionalString(rec.reading, "reading", 200) ?? null,
    aliases: rec.aliases === undefined ? [] : asStringArray(rec.aliases, "aliases"),
    placeKind: rec.placeKind === null ? null : asOptionalString(rec.placeKind, "placeKind", 64) ?? null,
    locationNoteMd:
      rec.locationNoteMd === null ? null : asOptionalString(rec.locationNoteMd, "locationNoteMd", 20_000) ?? null,
    descriptionMd:
      rec.descriptionMd === null ? null : asOptionalString(rec.descriptionMd, "descriptionMd", 20_000) ?? null,
  };
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
    authorPersonId: nullableString(rec.authorPersonId, "authorPersonId", 80),
    language: nullableString(rec.language, "language", 80),
    periodText: nullableString(rec.periodText, "periodText", 500),
    dateText: nullableString(rec.dateText, "dateText", 500),
    descriptionMd: nullableString(rec.descriptionMd, "descriptionMd", 100_000),
    sourceReference: nullableString(rec.sourceReference, "sourceReference", 4_000),
    expectedLockVersion: parseExpectedLockVersion(rec.expectedLockVersion),
  };
}

function parseContextItemBody(value: unknown, field: string): CreateContextItemInput {
  const rec = asRecord(value, field);
  const priority = asInt(rec.priority, `${field}.priority`);
  if (priority < -1_000_000 || priority > 1_000_000) fail(`${field}.priority`);
  return {
    scopeId: asNonEmptyString(rec.scopeId, `${field}.scopeId`, 80),
    title: asNonEmptyString(rec.title, `${field}.title`, 500),
    contentMd: asNonEmptyString(rec.contentMd, `${field}.contentMd`, 200_000),
    priority,
    enabled: asBoolean(rec.enabled, `${field}.enabled`),
  };
}

export function parseCreateContextItemInput(value: unknown): CreateContextItemInput {
  return parseContextItemBody(value, "input");
}

export function parseUpdateContextItemInput(value: unknown): UpdateContextItemInput {
  const rec = asRecord(value, "input");
  return {
    ...parseContextItemBody(value, "input"),
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

function parseUncertaintyBody(value: unknown, field: string): CreateUncertaintyInput {
  const rec = asRecord(value, field);
  if (!Array.isArray(rec.options) || rec.options.length > 100) fail(`${field}.options`);
  if (!Array.isArray(rec.anchors) || rec.anchors.length === 0 || rec.anchors.length > 100) {
    fail(`${field}.anchors`);
  }
  return {
    category: asOneOf(rec.category, `${field}.category`, UNCERTAINTY_CATEGORIES),
    severity: asNonEmptyString(rec.severity, `${field}.severity`, 64),
    blocking: asBoolean(rec.blocking, `${field}.blocking`),
    statementMd: asNonEmptyString(rec.statementMd, `${field}.statementMd`, 100_000),
    rationaleMd: nullableString(rec.rationaleMd, `${field}.rationaleMd`, 100_000),
    confidenceLabel: nullableString(rec.confidenceLabel, `${field}.confidenceLabel`, 100),
    options: rec.options.map((item, index) => {
      const option = asRecord(item, `${field}.options[${index}]`);
      return {
        label: asNonEmptyString(option.label, `${field}.options[${index}].label`, 2_000),
        interpretationMd: nullableString(
          option.interpretationMd,
          `${field}.options[${index}].interpretationMd`,
          100_000,
        ),
      };
    }),
    anchors: rec.anchors.map((item, index) => {
      const anchor = asRecord(item, `${field}.anchors[${index}]`);
      const codepointFrom = asOptionalInt(anchor.codepointFrom, `${field}.anchors[${index}].codepointFrom`);
      const codepointTo = asOptionalInt(anchor.codepointTo, `${field}.anchors[${index}].codepointTo`);
      if (codepointFrom !== undefined && codepointFrom < 0) fail(`${field}.anchors[${index}].codepointFrom`);
      if (codepointTo !== undefined && codepointTo < 1) fail(`${field}.anchors[${index}].codepointTo`);
      return {
        targetKind: asOneOf(anchor.targetKind, `${field}.anchors[${index}].targetKind`, UNCERTAINTY_TARGET_KINDS),
        targetVersionId: asNonEmptyString(anchor.targetVersionId, `${field}.anchors[${index}].targetVersionId`, 80),
        codepointFrom: codepointFrom ?? null,
        codepointTo: codepointTo ?? null,
        quote: nullableString(anchor.quote, `${field}.anchors[${index}].quote`, 20_000),
      };
    }),
  };
}

export function parseCreateUncertaintyInput(value: unknown): CreateUncertaintyInput {
  return parseUncertaintyBody(value, "input");
}

export function parseCreateUncertaintyVersionInput(value: unknown): CreateUncertaintyVersionInput {
  const rec = asRecord(value, "input");
  return {
    ...parseUncertaintyBody(value, "input"),
    uncertaintyId: asNonEmptyString(rec.uncertaintyId, "input.uncertaintyId", 80),
    expectedVersionId: asNonEmptyString(rec.expectedVersionId, "input.expectedVersionId", 80),
  };
}

export function parseResolveUncertaintyInput(value: unknown): ResolveUncertaintyInput {
  const rec = asRecord(value, "input");
  return {
    uncertaintyId: asNonEmptyString(rec.uncertaintyId, "input.uncertaintyId", 80),
    expectedVersionId: asNonEmptyString(rec.expectedVersionId, "input.expectedVersionId", 80),
  };
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
            ["glossary", "person", "place"] as const,
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
