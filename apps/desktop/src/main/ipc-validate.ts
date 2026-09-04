import {
  type ConfirmTranslationInput,
  type ContextPreviewInput,
  type CreateDocumentInput,
  type CreateFromPasteInput,
  type CreateProjectInput,
  type DocumentGenre,
  type DocumentKind,
  type DocumentNodeRole,
  type GlossaryEntryView,
  type MergeBlocksInput,
  type PersonView,
  type PlaceView,
  type SaveTranslationDraftInput,
  type SplitBlockInput,
} from "../shared/munhae-api";
import { AppError } from "./errors";

const DOCUMENT_KINDS: readonly DocumentKind[] = [
  "collection",
  "work",
  "volume",
  "chapter",
  "section",
  "item",
];

const DOCUMENT_NODE_ROLES: readonly DocumentNodeRole[] = ["container", "source_unit"];

const DOCUMENT_GENRES: readonly DocumentGenre[] = [
  "poetry",
  "letter",
  "memorial",
  "preface",
  "epitaph",
  "biography",
  "official_document",
  "prose",
  "other",
];

const ORIGIN_KINDS = ["paste", "manual", "import"] as const;
const USAGE_STATUSES = ["preferred", "allowed", "forbidden"] as const;

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
    structuralKind: asOneOf(rec.structuralKind, "structuralKind", DOCUMENT_KINDS),
    genre: asOneOf(rec.genre, "genre", DOCUMENT_GENRES),
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

export function parseSaveDraftInput(value: unknown): SaveTranslationDraftInput {
  const rec = asRecord(value, "input");
  if (!Array.isArray(rec.blocks)) fail("blocks");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    stage: asNonEmptyString(rec.stage, "stage", 64),
    textContent: asString(rec.textContent, "textContent", { max: 20_000_000 }),
    blocks: rec.blocks.map((block, index) => {
      const row = asRecord(block, `blocks[${index}]`);
      return {
        blockKey: asNonEmptyString(row.blockKey, "blockKey", 80),
        blockKind: asNonEmptyString(row.blockKind, "blockKind", 64),
        translation: asString(row.translation, "translation", { max: 20_000_000 }),
        sourceAnchorIds: asStringArray(row.sourceAnchorIds, "sourceAnchorIds"),
      };
    }),
    expectedLockVersion: asOptionalInt(rec.expectedLockVersion, "expectedLockVersion"),
  };
}

export function parseConfirmInput(value: unknown): ConfirmTranslationInput {
  const rec = asRecord(value, "input");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    stage: asNonEmptyString(rec.stage, "stage", 64),
    expectedLockVersion: asInt(rec.expectedLockVersion, "expectedLockVersion"),
  };
}

export function parseMergeBlocksInput(value: unknown): MergeBlocksInput {
  const rec = asRecord(value, "input");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    stage: asNonEmptyString(rec.stage, "stage", 64),
    leftBlockKey: asNonEmptyString(rec.leftBlockKey, "leftBlockKey", 80),
    rightBlockKey: asNonEmptyString(rec.rightBlockKey, "rightBlockKey", 80),
    expectedLockVersion: asOptionalInt(rec.expectedLockVersion, "expectedLockVersion"),
  };
}

export function parseSplitBlockInput(value: unknown): SplitBlockInput {
  const rec = asRecord(value, "input");
  const splitAt = asNumber(rec.splitAt, "splitAt");
  if (splitAt < 0) fail("splitAt");
  return {
    documentNodeId: asNonEmptyString(rec.documentNodeId, "documentNodeId", 80),
    stage: asNonEmptyString(rec.stage, "stage", 64),
    blockKey: asNonEmptyString(rec.blockKey, "blockKey", 80),
    splitAt,
    expectedLockVersion: asOptionalInt(rec.expectedLockVersion, "expectedLockVersion"),
  };
}

export function parseDocumentNodeId(value: unknown): string {
  return asNonEmptyString(value, "documentNodeId", 80);
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
    recipe: asOneOf(rec.recipe, "recipe", ["two_step", "three_step"] as const),
    selections,
  };
}

export function parseStage(value: unknown): string {
  return asNonEmptyString(value, "stage", 64);
}

export function parseGlossaryInput(
  value: unknown,
): Omit<GlossaryEntryView, "id"> & { id?: string } {
  const rec = asRecord(value, "entry");
  return {
    id: asOptionalString(rec.id, "id", 80),
    sourceTerm: asNonEmptyString(rec.sourceTerm, "sourceTerm", 500),
    targetTerm: asNonEmptyString(rec.targetTerm, "targetTerm", 500),
    targetLocale: asNonEmptyString(rec.targetLocale, "targetLocale", 32),
    termKind: asNonEmptyString(rec.termKind, "termKind", 64),
    reading: rec.reading === null ? null : asOptionalString(rec.reading, "reading", 200) ?? null,
    noteMd: rec.noteMd === null ? null : asOptionalString(rec.noteMd, "noteMd", 20_000) ?? null,
    usageStatus: asOneOf(rec.usageStatus, "usageStatus", USAGE_STATUSES),
  };
}

export function parsePersonInput(value: unknown): Omit<PersonView, "id"> & { id?: string } {
  const rec = asRecord(value, "person");
  return {
    id: asOptionalString(rec.id, "id", 80),
    preferredName: asNonEmptyString(rec.preferredName, "preferredName", 200),
    hanjaName: rec.hanjaName === null ? null : asOptionalString(rec.hanjaName, "hanjaName", 200) ?? null,
    reading: rec.reading === null ? null : asOptionalString(rec.reading, "reading", 200) ?? null,
    aliases: rec.aliases === undefined ? [] : asStringArray(rec.aliases, "aliases"),
    descriptionMd:
      rec.descriptionMd === null ? null : asOptionalString(rec.descriptionMd, "descriptionMd", 20_000) ?? null,
    dateText: rec.dateText === null ? null : asOptionalString(rec.dateText, "dateText", 200) ?? null,
  };
}

export function parsePlaceInput(value: unknown): Omit<PlaceView, "id"> & { id?: string } {
  const rec = asRecord(value, "place");
  return {
    id: asOptionalString(rec.id, "id", 80),
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
