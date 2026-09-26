import { describe, expect, it } from "vitest";
import { isHanmunWhitespaceGap, segmentHanmun } from "../src/hanmun-segmentation.ts";

function quotes(text: string, mode: "prose" | "poetry", kind: string) {
  return segmentHanmun(text, mode).filter(span => span.spanKind === kind)
    .map(span => Array.from(text).slice(span.codepointFrom, span.codepointTo).join(""));
}

describe("Classical Chinese segmentation", () => {
  it("uses each explicit line break for prose paragraphs, skipping blank lines", () => {
    const text = " \n甲。乙！\n\n 丙。\r\n丁？\r戊。 \n";
    expect(quotes(text, "prose", "paragraph")).toEqual(["甲。乙！", "丙。", "丁？", "戊。"]);
    expect(quotes(text, "prose", "sentence")).toEqual(["甲。", "乙！", "丙。", "丁？", "戊。"]);
    expect(quotes("甲。乙！", "prose", "paragraph")).toEqual(["甲。乙！"]);
  });

  it("groups poetry only at blank lines and never invents couplets", () => {
    const text = "\r\n 白日依山盡，\r\n 黃河入海流。\r\n 欲窮千里目，\r\n \t\r\n 更上一層樓。 \r\n";
    expect(quotes(text, "poetry", "paragraph")).toEqual([
      "白日依山盡，\r\n 黃河入海流。\r\n 欲窮千里目，", "更上一層樓。",
    ]);
    expect(quotes(text, "poetry", "verse_line")).toEqual([
      "白日依山盡，", "黃河入海流。", "欲窮千里目，", "更上一層樓。",
    ]);
    const spans = segmentHanmun(text, "poetry");
    expect(new Set(spans.map(span => span.spanKind))).toEqual(new Set(["paragraph", "verse_line"]));
    expect(spans.filter(span => span.spanKind === "verse_line").map(span => span.parentSpanKey)).toEqual(["p1", "p1", "p1", "p2"]);
  });

  it("merges poetry paragraphs separately from verse lines when editing breaks", () => {
    const text = "甲\n乙\n\n丙\n丁";
    const mergedParagraph = text.replace("\n\n", "\n");
    expect(quotes(mergedParagraph, "poetry", "paragraph")).toHaveLength(1);
    expect(quotes(mergedParagraph, "poetry", "verse_line")).toEqual(["甲", "乙", "丙", "丁"]);
    expect(quotes(mergedParagraph.replace("乙\n丙", "乙丙"), "poetry", "verse_line")).toEqual(["甲", "乙丙", "丁"]);
  });

  it("keeps supplementary codepoints, internal spacing and closing punctuation with the sentence", () => {
    const text = " \t𠮷 甲曰：「乙？！」  丙。\n\n";
    expect(quotes(text, "prose", "sentence")).toEqual(["𠮷 甲曰：「乙？！」", "丙。"]);
    const points = Array.from(text);
    const leaves = segmentHanmun(text).filter(span => span.spanKind === "sentence");
    expect(leaves[0]!.codepointFrom).toBe(2);
    let cursor = 0, restored = "";
    for (const span of leaves) {
      expect(isHanmunWhitespaceGap(points, cursor, span.codepointFrom)).toBe(true);
      restored += points.slice(cursor, span.codepointFrom).join("");
      restored += points.slice(span.codepointFrom, span.codepointTo).join("");
      cursor = span.codepointTo;
    }
    expect(isHanmunWhitespaceGap(points, cursor, points.length)).toBe(true);
    expect(restored + points.slice(cursor).join("")).toBe(text);
    expect(isHanmunWhitespaceGap(points, 0, 3)).toBe(false);
    expect(isHanmunWhitespaceGap(points, 3, 2)).toBe(false);
  });
});
