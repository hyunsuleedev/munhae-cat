import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";

export function createId(): string {
  return uuidv7();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function codepointCount(text: string): number {
  return Array.from(text).length;
}

export function sliceCodepoints(text: string, from: number, to: number): string {
  return Array.from(text).slice(from, to).join("");
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type VersionState = "draft" | "confirmed" | "rejected" | "superseded";

export const VERSION_UI = {
  draft: "작업안",
  confirmed: "확정",
  rejected: "제외됨",
  superseded: "변경 이력",
} as const;

export function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
  return out;
}

/** Canonical JSON: recursively sorted keys, no extra whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function canonicalJsonHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export class MunhaeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MunhaeError";
    this.code = code;
  }
}

export function joinBlockTranslations(translations: string[]): string {
  return translations.join(" ");
}

export function blockTargetRanges(translations: string[]): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  for (let i = 0; i < translations.length; i += 1) {
    const len = codepointCount(translations[i] ?? "");
    ranges.push({ from: cursor, to: cursor + len });
    cursor += len;
    if (i < translations.length - 1) cursor += 1;
  }
  return ranges;
}

/** The app accepts one translation result with an AI-selected source-anchor mapping. */
export const TRANSLATION_ENVELOPE_CONTRACT = "translation-envelope.v2" as const;
export const TRANSLATION_ENVELOPE_SCHEMA_VERSION = 2 as const;

export type TranslationEnvelopeBlock = {
  blockKey: string;
  sourceAnchorIds: string[];
  blockKind: string;
  translation: string;
};

export type TranslationEnvelope = {
  schemaVersion: 2;
  anchorSetId: string;
  blocks: TranslationEnvelopeBlock[];
};

export type TranslationEnvelopeAnchor = {
  anchorKey: string;
  ordinal: number;
  required: boolean;
};

export type TranslationEnvelopeValidationFinding = {
  kind:
    | "invalid_json"
    | "invalid_shape"
    | "schema_version"
    | "anchor_set_mismatch"
    | "duplicate_block_key"
    | "empty_block"
    | "empty_translation"
    | "unknown_anchor"
    | "duplicate_anchor";
  severity: "error" | "warning";
  blockKey: string | null;
  anchorKey: string | null;
  message: string;
};

export type TranslationEnvelopeValidation = {
  state: "valid" | "invalid_unapplied";
  envelope: TranslationEnvelope | null;
  fatalFindings: TranslationEnvelopeValidationFinding[];
  recoverableFindings: TranslationEnvelopeValidationFinding[];
};

export type TranslationEnvelopeValidationContext = {
  anchorSetId: string;
  anchors: TranslationEnvelopeAnchor[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function unexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedKeys.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finding(
  kind: TranslationEnvelopeValidationFinding["kind"],
  message: string,
  details: Partial<Pick<TranslationEnvelopeValidationFinding, "blockKey" | "anchorKey">> = {},
): TranslationEnvelopeValidationFinding {
  return {
    kind,
    severity: "error",
    blockKey: details.blockKey ?? null,
    anchorKey: details.anchorKey ?? null,
    message,
  };
}

function normalizeEnvelope(value: unknown): {
  envelope: TranslationEnvelope | null;
  shapeFindings: TranslationEnvelopeValidationFinding[];
} {
  if (!isRecord(value)) {
    return { envelope: null, shapeFindings: [finding("invalid_shape", "응답이 JSON 객체가 아닙니다")] };
  }
  const shapeFindings: TranslationEnvelopeValidationFinding[] = [];
  const rootExtras = unexpectedKeys(value, ["schemaVersion", "anchorSetId", "blocks"]);
  if (rootExtras.length > 0) {
    shapeFindings.push(finding("invalid_shape", `허용되지 않은 envelope 필드: ${rootExtras.join(", ")}`));
  }
  if (!Number.isInteger(value.schemaVersion) || !nonEmptyString(value.anchorSetId) || !Array.isArray(value.blocks)) {
    return {
      envelope: null,
      shapeFindings: [
        ...shapeFindings,
        finding("invalid_shape", "schemaVersion, anchorSetId, blocks 필드의 형식이 올바르지 않습니다"),
      ],
    };
  }

  const blocks: TranslationEnvelopeBlock[] = [];
  const blockKeys = new Set<string>();
  for (const rawBlock of value.blocks) {
    const rawBlockKey = isRecord(rawBlock) && nonEmptyString(rawBlock.blockKey)
      ? rawBlock.blockKey
      : null;
    if (rawBlockKey) {
      if (blockKeys.has(rawBlockKey)) {
        shapeFindings.push(finding("duplicate_block_key", `중복 blockKey: ${rawBlockKey}`, {
          blockKey: rawBlockKey,
        }));
      }
      blockKeys.add(rawBlockKey);
    }
    if (isRecord(rawBlock)) {
      const extras = unexpectedKeys(rawBlock, ["blockKey", "sourceAnchorIds", "blockKind", "translation"]);
      if (extras.length > 0) {
        shapeFindings.push(finding(
          "invalid_shape",
          `허용되지 않은 block 필드: ${extras.join(", ")}`,
          { blockKey: typeof rawBlock.blockKey === "string" ? rawBlock.blockKey : null },
        ));
      }
    }
    if (
      !isRecord(rawBlock)
      || !nonEmptyString(rawBlock.blockKey)
      || !nonEmptyString(rawBlock.blockKind)
      || typeof rawBlock.translation !== "string"
      || !isStringArray(rawBlock.sourceAnchorIds)
      || rawBlock.sourceAnchorIds.some((anchorId) => anchorId.length === 0)
    ) {
      shapeFindings.push(finding("invalid_shape", "번역 block의 필수 필드 형식이 올바르지 않습니다", {
        blockKey: isRecord(rawBlock) && typeof rawBlock.blockKey === "string" ? rawBlock.blockKey : null,
      }));
      continue;
    }
    blocks.push({
      blockKey: rawBlock.blockKey,
      sourceAnchorIds: [...rawBlock.sourceAnchorIds],
      blockKind: rawBlock.blockKind,
      translation: rawBlock.translation,
    });
  }

  return {
    envelope: {
      schemaVersion: value.schemaVersion as 2,
      anchorSetId: value.anchorSetId,
      blocks,
    },
    shapeFindings,
  };
}

/**
 * Parses and validates translation-envelope.v2 without mutating the raw response.
 * Contract and reference-integrity errors prevent application. Semantic completeness and
 * cross-block source mapping are reviewed by the AI and user, not inferred by this validator.
 * Callers preserve invalid raw responses and findings as evidence, never as a partial draft.
 */
export function validateTranslationEnvelope(
  raw: string | unknown,
  context: TranslationEnvelopeValidationContext,
): TranslationEnvelopeValidation {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      const invalid = finding("invalid_json", "응답을 JSON으로 해석할 수 없습니다");
      return { state: "invalid_unapplied", envelope: null, fatalFindings: [invalid], recoverableFindings: [] };
    }
  }

  const normalized = normalizeEnvelope(parsed);
  if (!normalized.envelope) {
    return {
      state: "invalid_unapplied",
      envelope: null,
      fatalFindings: normalized.shapeFindings,
      recoverableFindings: [],
    };
  }
  const envelope = normalized.envelope;
  const fatalFindings = [...normalized.shapeFindings];
  const recoverableFindings: TranslationEnvelopeValidationFinding[] = [];
  if (envelope.schemaVersion !== TRANSLATION_ENVELOPE_SCHEMA_VERSION) {
    fatalFindings.push(finding("schema_version", `지원하지 않는 schemaVersion: ${String(envelope.schemaVersion)}`));
  }
  if (envelope.anchorSetId !== context.anchorSetId) {
    fatalFindings.push(finding("anchor_set_mismatch", "요청에 고정한 anchor set과 응답이 다릅니다"));
  }
  if (fatalFindings.length > 0) {
    return { state: "invalid_unapplied", envelope, fatalFindings, recoverableFindings };
  }

  const anchorsByKey = new Map(context.anchors.map((anchor) => [anchor.anchorKey, anchor]));
  if (envelope.blocks.length === 0) recoverableFindings.push(finding("empty_block", "번역 block이 없습니다"));
  for (const block of envelope.blocks) {
    if (!block.translation.trim()) {
      recoverableFindings.push(finding("empty_translation", "번역 문자열이 비어 있습니다", {
        blockKey: block.blockKey,
      }));
    }
    if (block.sourceAnchorIds.length === 0) {
      recoverableFindings.push(finding("empty_block", "block에 source anchor가 없습니다", {
        blockKey: block.blockKey,
      }));
    }
    const blockSeen = new Set<string>();
    for (const anchorKey of block.sourceAnchorIds) {
      const anchor = anchorsByKey.get(anchorKey);
      if (!anchor) {
        recoverableFindings.push(finding("unknown_anchor", `존재하지 않는 anchor: ${anchorKey}`, {
          blockKey: block.blockKey,
          anchorKey,
        }));
        continue;
      }
      if (blockSeen.has(anchorKey)) {
        recoverableFindings.push(finding("duplicate_anchor", `같은 block에 anchor가 중복 연결되었습니다: ${anchorKey}`, {
          blockKey: block.blockKey,
          anchorKey,
        }));
      }
      blockSeen.add(anchorKey);
    }
  }

  return {
    state: recoverableFindings.length > 0 ? "invalid_unapplied" : "valid",
    envelope,
    fatalFindings,
    recoverableFindings,
  };
}

/** JSON Schema passed to provider CLIs for one complete translation result. */
export function translationEnvelopeJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "anchorSetId", "blocks"],
    properties: {
      schemaVersion: { type: "integer", enum: [TRANSLATION_ENVELOPE_SCHEMA_VERSION] },
      anchorSetId: { type: "string", minLength: 1 },
      blocks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["blockKey", "sourceAnchorIds", "blockKind", "translation"],
          properties: {
            blockKey: { type: "string", minLength: 1 },
            sourceAnchorIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
            blockKind: { type: "string", minLength: 1 },
            translation: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}
