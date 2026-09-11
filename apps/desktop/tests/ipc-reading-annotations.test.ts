import { describe, expect, it } from "vitest";
import { parseArchiveReadingAnnotationInput, parseSaveReadingAnnotationInput } from "../src/main/ipc-validate";

const citation = {
  source: "wiktionary", sourceLabel: "한국어 위키낱말사전", entryId: "wiktionary:綱",
  headword: "綱", reading: "강", sense: "벼리, 강령", senseLabel: "명사",
  sourceUrl: "https://ko.wiktionary.org/wiki/%E7%B6%B1", license: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", attribution: "한국어 위키낱말사전 기여자",
};
const annotation = {
  documentNodeId: "document-1", sourceVersionId: "source-1", codepointFrom: 3, codepointTo: 5,
  quote: "𠀀綱", reading: "강", gloss: "문맥에서 그물의 벼리를 가리킴", readingOrder: 2,
  citation, expectedLockVersion: 0,
};

describe("reading annotation IPC validation", () => {
  it("preserves exact Unicode ranges and complete dictionary provenance", () => {
    expect(parseSaveReadingAnnotationInput(annotation)).toEqual(annotation);
    expect(parseSaveReadingAnnotationInput({ ...annotation, id: "note-1", expectedLockVersion: 4 }))
      .toEqual({ ...annotation, id: "note-1", expectedLockVersion: 4 });
    const spacedCitation = { ...citation, sense: " 벼리\n강령 ", attribution: " 기여자 " };
    expect(parseSaveReadingAnnotationInput({ ...annotation, citation: spacedCitation }).citation).toEqual(spacedCitation);
  });

  it("allows a manual gloss, reading order only, or citation only without inventing data", () => {
    const empty = { ...annotation, reading: "", gloss: "", readingOrder: null, citation: null };
    for (const change of [{ gloss: "풀이" }, { reading: "강" }, { readingOrder: 1 }, { citation }]) {
      expect(parseSaveReadingAnnotationInput({ ...empty, ...change })).toEqual({ ...empty, ...change });
    }
    expect(parseSaveReadingAnnotationInput({ ...empty, gloss: " 풀이 \n" }).gloss).toBe("풀이");
    expect(() => parseSaveReadingAnnotationInput(empty)).toThrow();
  });

  it("accepts up to 100 codepoints even when each occupies two UTF-16 units", () => {
    expect(parseSaveReadingAnnotationInput({ ...annotation, codepointFrom: 0, codepointTo: 100, quote: "𠀀".repeat(100) }).quote)
      .toHaveLength(200);
  });

  it.each([
    { id: "" }, { id: null }, { documentNodeId: " " }, { sourceVersionId: "" },
    { expectedLockVersion: undefined }, { expectedLockVersion: 1 }, { expectedLockVersion: -1 },
    { id: "note", expectedLockVersion: 0 }, { id: "note", expectedLockVersion: 1.5 },
    { id: "note", expectedLockVersion: Number.MAX_SAFE_INTEGER + 1 },
    { codepointFrom: -1 }, { codepointFrom: 3.5 }, { codepointTo: 3 }, { codepointTo: Number.NaN },
    { codepointFrom: 20_000_000, codepointTo: 20_000_002 },
    { codepointFrom: Number.MAX_SAFE_INTEGER + 1, codepointTo: Number.MAX_SAFE_INTEGER + 3 },
    { codepointTo: 6 }, { quote: "  " }, { quote: "𠀀綱 ", codepointTo: 5 },
    { quote: "綱".repeat(101), codepointFrom: 0, codepointTo: 101 },
    { reading: "강".repeat(101) }, { gloss: "뜻".repeat(2_001) },
    { readingOrder: 0 }, { readingOrder: -1 }, { readingOrder: 0.5 }, { readingOrder: 1_000_001 },
    { readingOrder: undefined }, { reading: null }, { citation: undefined },
    { quote: "\ud800綱" }, { reading: "\u0000" }, { gloss: "풀이\udfff" },
    { createdBy: "renderer-asserted-owner" }, { sourceContent: "must not edit source" },
  ])("rejects invalid bounds, missing version guards, and unexpected fields: %j", (invalid) => {
    expect(() => parseSaveReadingAnnotationInput({ ...annotation, ...invalid })).toThrow();
  });

  it.each([
    { source: "" }, { sourceLabel: " " }, { entryId: "" }, { headword: "" }, { sense: "" }, { license: "" },
    { source: "x".repeat(101) }, { sense: "x".repeat(20_001) }, { attribution: "x".repeat(5_001) },
    { reading: "x".repeat(101) }, { senseLabel: "x".repeat(501) },
    { sourceUrl: "javascript:alert(1)" }, { sourceUrl: "file:///tmp/private" }, { sourceUrl: "/relative" },
    { sourceUrl: "https://reader:secret@example.invalid/" }, { licenseUrl: "data:text/plain,license" },
    { licenseUrl: "https://reader@example.invalid/" }, { sourceUrl: "https://example.invalid/" + "x".repeat(2_048) },
    { licenseUrl: undefined }, { reading: undefined }, { canCite: true },
    { sense: "뜻\u0000" }, { headword: "\ud800" },
    { sense: "\\".repeat(20_000) },
  ])("rejects malformed citation provenance and unsafe links: %j", (invalid) => {
    expect(() => parseSaveReadingAnnotationInput({ ...annotation, citation: { ...citation, ...invalid } })).toThrow();
  });

  it("does not infer a license URL or reading when unavailable", () => {
    const value = { ...citation, reading: null, licenseUrl: null, attribution: "" };
    delete (value as { senseLabel?: string }).senseLabel;
    expect(parseSaveReadingAnnotationInput({ ...annotation, citation: value }).citation).toEqual(value);
  });

  it("requires an existing optimistic lock to archive and rejects broad deletion input", () => {
    expect(parseArchiveReadingAnnotationInput({ id: "note-1", expectedLockVersion: 2 }))
      .toEqual({ id: "note-1", expectedLockVersion: 2 });
    for (const expectedLockVersion of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseArchiveReadingAnnotationInput({ id: "note-1", expectedLockVersion })).toThrow();
    }
    expect(() => parseArchiveReadingAnnotationInput({ id: "", expectedLockVersion: 1 })).toThrow();
    expect(() => parseArchiveReadingAnnotationInput({ id: "note-1", expectedLockVersion: 1, documentNodeId: "all" })).toThrow();
  });
});
