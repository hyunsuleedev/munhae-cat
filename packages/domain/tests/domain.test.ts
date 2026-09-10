import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonHash,
  codepointCount,
  createId,
  sha256Hex,
  sliceCodepoints,
  utf8ByteLength,
  validateTranslationEnvelope,
  translationEnvelopeJsonSchema,
  VERSION_UI,
} from "../src/index.ts";

describe("createId", () => {
  it("returns a UUIDv7", () => {
    const id = createId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(createId()).not.toBe(id);
  });
});

describe("sha256Hex", () => {
  it("hashes the empty string to the published SHA-256", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("is stable for Korean text", () => {
    const a = sha256Hex("훈민정음");
    const b = sha256Hex("훈민정음");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(sha256Hex("훈민정음 "));
  });
});

describe("codepoints", () => {
  it("counts and slices Hangul by code point", () => {
    expect(codepointCount("한글")).toBe(2);
    expect(sliceCodepoints("한글", 0, 1)).toBe("한");
    expect(sliceCodepoints("한글", 1, 2)).toBe("글");
    expect(sliceCodepoints("한글", 0, 2)).toBe("한글");
  });

  it("counts and slices Hanja by code point", () => {
    expect(codepointCount("國之")).toBe(2);
    expect(sliceCodepoints("國之", 0, 1)).toBe("國");
    expect(sliceCodepoints("國之", 1, 2)).toBe("之");
  });

  it("reports UTF-8 byte length of 가 as 3", () => {
    expect(utf8ByteLength("가")).toBe(3);
  });
});

describe("canonical JSON", () => {
  it("sorts keys and omits extra whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJsonHash({ z: 1, a: 2 })).toBe(canonicalJsonHash({ a: 2, z: 1 }));
  });
});

describe("VERSION_UI", () => {
  it("uses 작업안/확정/제외됨/변경 이력", () => {
    expect(VERSION_UI.draft).toBe("작업안");
    expect(VERSION_UI.confirmed).toBe("확정");
    expect(VERSION_UI.rejected).toBe("제외됨");
    expect(VERSION_UI.superseded).toBe("변경 이력");
  });
});

const envelopeContext = {
  anchorSetId: "tas-1",
  anchors: [
    { anchorKey: "A001", ordinal: 1, required: true },
    { anchorKey: "A002", ordinal: 2, required: true },
  ],
};

function validEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    anchorSetId: "tas-1",
    blocks: [
      { blockKey: "b1", sourceAnchorIds: ["A001", "A002"], blockKind: "paragraph", translation: "완성 번역문" },
    ],
  };
}

describe("translation-envelope.v2", () => {
  it("accepts one structurally valid translation envelope", () => {
    const result = validateTranslationEnvelope(validEnvelope(), envelopeContext);
    expect(result.state).toBe("valid");
    expect(result.fatalFindings).toHaveLength(0);
    expect(result.recoverableFindings).toHaveLength(0);
  });

  it("treats parse, schema, and anchor-set errors as invalid_unapplied", () => {
    expect(validateTranslationEnvelope("not-json", envelopeContext).state).toBe("invalid_unapplied");
    expect(validateTranslationEnvelope({ ...validEnvelope(), schemaVersion: 1 }, envelopeContext).state).toBe(
      "invalid_unapplied",
    );
    expect(validateTranslationEnvelope({ ...validEnvelope(), anchorSetId: "other" }, envelopeContext).state).toBe(
      "invalid_unapplied",
    );
  });

  it("rejects empty translations, unknown anchors, and duplicate links within one block", () => {
    const value = validEnvelope();
    (value.blocks as Array<Record<string, unknown>>)[0]!.translation = "";
    (value.blocks as Array<Record<string, unknown>>)[0]!.sourceAnchorIds = ["A002", "A001", "A001", "UNKNOWN"];
    const result = validateTranslationEnvelope(value, envelopeContext);
    expect(result.state).toBe("invalid_unapplied");
    expect(result.recoverableFindings.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "empty_translation",
      "unknown_anchor",
      "duplicate_anchor",
    ]));

    const unlinked = validEnvelope();
    (unlinked.blocks as Array<Record<string, unknown>>)[0]!.sourceAnchorIds = [];
    expect(validateTranslationEnvelope(unlinked, envelopeContext).recoverableFindings.map((item) => item.kind)).toContain(
      "empty_block",
    );
  });

  it("does not mechanically reject omitted anchors or cross-block reuse", () => {
    const missing = validEnvelope();
    (missing.blocks as Array<Record<string, unknown>>)[0]!.sourceAnchorIds = ["A001"];
    expect(validateTranslationEnvelope(missing, envelopeContext)).toMatchObject({
      state: "valid",
      fatalFindings: [],
      recoverableFindings: [],
    });

    const reused = validEnvelope();
    reused.blocks = [
      { blockKey: "b1", sourceAnchorIds: ["A001"], blockKind: "paragraph", translation: "첫 블록" },
      { blockKey: "b2", sourceAnchorIds: ["A001"], blockKind: "paragraph", translation: "둘째 블록" },
    ];
    expect(validateTranslationEnvelope(reused, envelopeContext)).toMatchObject({
      state: "valid",
      fatalFindings: [],
      recoverableFindings: [],
    });
  });

  it("accepts AI-selected anchor order and grouping", () => {
    const reordered = {
      ...validEnvelope(),
      blocks: [
        { blockKey: "b1", sourceAnchorIds: ["A003", "A001"], blockKind: "paragraph", translation: "첫 블록" },
        { blockKey: "b2", sourceAnchorIds: ["A002"], blockKind: "paragraph", translation: "둘째 블록" },
      ],
    };
    const threeAnchors = {
      ...envelopeContext,
      anchors: [...envelopeContext.anchors, { anchorKey: "A003", ordinal: 3, required: true }],
    };
    const result = validateTranslationEnvelope(reordered, threeAnchors);
    expect(result.state).toBe("valid");
    expect(result.fatalFindings).toHaveLength(0);
    expect(result.recoverableFindings).toHaveLength(0);
  });

  it("detects a duplicate block key even when one duplicate block is malformed", () => {
    const value = validEnvelope();
    const blocks = value.blocks as Array<Record<string, unknown>>;
    blocks.push({ blockKey: "b1", blockKind: "paragraph", translation: 123, sourceAnchorIds: ["A001"] });
    const result = validateTranslationEnvelope(value, envelopeContext);
    expect(result.state).toBe("invalid_unapplied");
    expect(result.fatalFindings.map((item) => item.kind)).toContain("duplicate_block_key");
  });

  it("rejects fields and blank identifiers outside the exact provider schema", () => {
    const rootExtra = validEnvelope();
    rootExtra.unexpected = true;
    expect(validateTranslationEnvelope(rootExtra, envelopeContext).state).toBe("invalid_unapplied");

    const blockExtra = validEnvelope();
    const firstBlock = (blockExtra.blocks as Array<Record<string, unknown>>)[0]!;
    firstBlock.explanation = "schema 밖의 값";
    expect(validateTranslationEnvelope(blockExtra, envelopeContext).state).toBe("invalid_unapplied");

    const malformedWithExtra = validEnvelope();
    const malformedBlock = (malformedWithExtra.blocks as Array<Record<string, unknown>>)[0]!;
    malformedBlock.translation = 123;
    malformedBlock.unexpected = true;
    expect(validateTranslationEnvelope(malformedWithExtra, envelopeContext).state).toBe("invalid_unapplied");

    const blankIdentity = validEnvelope();
    (blankIdentity.blocks as Array<Record<string, unknown>>)[0]!.blockKey = "";
    const result = validateTranslationEnvelope(blankIdentity, envelopeContext);
    expect(result.state).toBe("invalid_unapplied");
    expect(result.fatalFindings.map((item) => item.kind)).toContain("invalid_shape");
  });

  it("builds an exact one-translation provider schema without candidates or Reflection", () => {
    const schema = translationEnvelopeJsonSchema();
    expect(schema.required).toEqual(["schemaVersion", "anchorSetId", "blocks"]);
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty("candidates");
    expect(properties).not.toHaveProperty("reflection");
    expect((properties.schemaVersion as { enum: number[] }).enum).toEqual([2]);
  });
});
