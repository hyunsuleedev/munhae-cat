import { describe, expect, it } from "vitest";
import { punctuationParagraphs, punctuationStructure } from "../src/renderer/scripts/punctuation-paragraphs";

describe("punctuation workspace paragraph correspondence", () => {
  it("keeps repeated phrases at their actual source positions", () => {
    const source = "太守問僧僧答太守";
    const text = "太守問僧。\n\n僧答太守。";
    const result = punctuationParagraphs(source, text)!;
    expect(result.map(p => [p.sourceFrom, p.sourceTo])).toEqual([[0, 4], [4, 8]]);
    expect(result.map(p => p.sourceText).join("")).toBe(source);
    expect(text.slice(result[1]!.from, result[1]!.to)).toBe("僧答太守。");
  });
  it("uses UTF-16 textarea positions and preserves supplementary glyphs, source punctuation and whitespace", () => {
    const source = " 𠮷甲， \r\n乙𥊑 \t";
    const text = "𠮷甲，。\n\n乙𥊑。";
    const result = punctuationParagraphs(source, text)!;
    expect(result.map(p => p.sourceText)).toEqual(["𠮷甲，", "乙𥊑"]);
    expect(result[0]!.sourceFrom).toBe(1);
    expect(result[1]!.from).toBe(7);
    expect(text.slice(result[1]!.from, result[1]!.to)).toBe("乙𥊑。");
    expect(result[1]!.sourceTo).toBe(Array.from(source).length - 2);
  });
  it("does not invent correspondence after a source character is removed, changed or reordered", () => {
    for (const text of ["甲。\n\n丙。", "甲乙。\n\n丁。", "丙。\n\n甲乙。"]) {
      expect(punctuationParagraphs("甲乙丙", text)).toBeNull();
    }
    expect(punctuationParagraphs("甲，乙", "甲乙。")).toBeNull();
  });
  it("uses single line breaks for prose and blank lines for poetry", () => {
    const source = "甲乙丙丁";
    const text = "\n\n甲。\n乙。\r\n \r\n丙。\n丁。\n\n";
    const result = punctuationParagraphs(source, text)!;
    expect(result).toHaveLength(4);
    expect(result.map(p => p.sourceText)).toEqual(["甲", "乙", "丙", "丁"]);
    expect(result.map(p => text.slice(p.from, p.to))).toEqual(["甲。", "乙。", "丙。", "丁。"]);
    expect(punctuationParagraphs(source, text, "poetry")!.map(p => text.slice(p.from, p.to)))
      .toEqual(["甲。\n乙。", "丙。\n丁。"]);
    expect(punctuationStructure(source, text, "poetry")!.filter(p => p.spanKind === "verse_line"))
      .toHaveLength(4);
  });
});
