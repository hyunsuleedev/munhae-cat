import { describe, expect, it } from "vitest";
import { validatePunctuationText } from "../../../packages/db-sqlite/src/source-layer.ts";
import {
  createPunctuationProjection,
  projectSourceRange,
  punctuationCaretForSource,
} from "../src/renderer/scripts/punctuation-projection";

function project(source: string, punctuation: string, from: number, to: number) {
  const mapping = createPunctuationProjection(source, punctuation);
  expect(mapping).not.toBeNull();
  return projectSourceRange(mapping!, from, to);
}

describe("punctuation display over canonical source ranges", () => {
  it("retains the exact occurrence of a repeated phrase", () => {
    expect(project("太守問僧僧答太守", "太守問僧，僧答太守。", 6, 8)).toEqual({
      text: "太守。",
      boundaries: [6, 7, 8, 8],
    });
    expect(project("太守問僧僧答太守", "太守問僧，僧答太守。", 0, 2)).toEqual({
      text: "太守",
      boundaries: [0, 1, 2],
    });
  });

  it("keeps closing punctuation on the left and opening punctuation on the right", () => {
    const source = "甲乙丙";
    const punctuation = "「甲。」「乙」，『丙』。";
    expect(project(source, punctuation, 0, 1)).toEqual({ text: "「甲。」", boundaries: [0, 0, 1, 1, 1] });
    expect(project(source, punctuation, 1, 2)).toEqual({ text: "「乙」，", boundaries: [1, 1, 2, 2, 2] });
    expect(project(source, punctuation, 2, 3)).toEqual({ text: "『丙』。", boundaries: [2, 2, 3, 3, 3] });
  });

  it("distinguishes opening and closing straight quotes", () => {
    expect(project("甲乙", '"甲。" "乙。"', 0, 1)?.text).toBe('"甲。" ');
    expect(project("甲乙", '"甲。" "乙。"', 1, 2)?.text).toBe('"乙。"');
  });

  it("uses Unicode code points for supplementary Hanja and exact comment coordinates", () => {
    const result = project("𠮷問𠮷答", "「𠮷問。」𠮷答。", 2, 4)!;
    expect(result).toEqual({ text: "𠮷答。", boundaries: [2, 3, 4, 4] });
    expect(Array.from("𠮷問𠮷答").slice(result.boundaries[0], result.boundaries[1]).join("")).toBe("𠮷");
    expect(project("𠮷問𠮷答", "「𠮷問。」𠮷答。", 0, 2)).toEqual({
      text: "「𠮷問。」",
      boundaries: [0, 0, 1, 2, 2, 2],
    });
  });

  it("preserves source punctuation separately from newly inserted marks", () => {
    expect(project("甲。乙", "甲。。乙！", 0, 1)).toEqual({ text: "甲", boundaries: [0, 1] });
    expect(project("甲。乙", "甲。。乙！", 1, 2)).toEqual({ text: "。。", boundaries: [1, 2, 2] });
    expect(project("甲。乙", "甲。。乙！", 2, 3)).toEqual({ text: "乙！", boundaries: [2, 3, 3] });
  });

  it("clips omitted layout whitespace to the requested source range", () => {
    const source = " \t甲\n乙 \u3000";
    const punctuation = "甲，乙。";
    expect(project(source, punctuation, 2, 3)).toEqual({ text: "甲，", boundaries: [2, 3, 3] });
    expect(project(source, punctuation, 4, 5)).toEqual({ text: "乙。", boundaries: [4, 5, 5] });
    expect(project(source, punctuation, 3, 5)).toEqual({ text: "乙。", boundaries: [3, 5, 5] });
    expect(project(source, punctuation, 0, 2)).toBeNull();
    expect(project(source, punctuation, 3, 4)).toBeNull();
    expect(project(source, punctuation, 5, 7)).toBeNull();
  });

  it("preserves copied whitespace and DB trailing-whitespace boundary semantics", () => {
    expect(project("甲 \n乙", "甲 \n乙", 1, 3)).toEqual({ text: " \n", boundaries: [1, 2, 3] });
    expect(project("甲 \n", "甲？", 0, 1)).toEqual({ text: "甲？", boundaries: [0, 1, 1] });
    expect(project("甲 \n", "甲？", 0, 3)).toEqual({ text: "甲？", boundaries: [0, 1, 3] });
  });

  it.each([
    [" \t甲\n乙 \u3000", "甲，乙。"],
    ["甲 \n乙", "甲 \n乙"],
    ["甲 \n", "甲？"],
    ["甲〇乙○丙", "甲，〇乙。○丙！"],
    ["𠮷甲\r\n乙𠮷\r丙", "𠮷甲，乙𠮷；丙。"],
    ["甲，乙", "甲，，乙。"],
    ["甲乙", "甲ㆍ乙"],
  ])("matches DB validation boundaries for %j -> %j", (source, punctuation) => {
    const mapping = createPunctuationProjection(source, punctuation)!;
    expect(mapping.sourceBoundaryByPunctuationBoundary).toEqual(
      validatePunctuationText(source, punctuation).sourceBoundaryByPunctuationBoundary,
    );
    const length = Array.from(source).length;
    for (let from = 0; from < length; from += 1) {
      for (let to = from + 1; to <= length; to += 1) {
        const range = projectSourceRange(mapping, from, to);
        if (!range) continue;
        expect(range.boundaries).toHaveLength(Array.from(range.text).length + 1);
        expect(range.boundaries.every((boundary) => boundary >= from && boundary <= to)).toBe(true);
        expect(range.boundaries.every((boundary, index, all) => index === 0 || boundary >= all[index - 1]!)).toBe(true);
      }
    }
  });

  it.each([
    ["", "甲。"],
    [" \n", "。"],
    ["甲乙", ""],
    ["甲〇乙 ", "甲○乙。"],
    ["甲〇乙 ", "甲乙。"],
    ["甲○乙", "甲乙。"],
    ["甲 乙", "甲丙。"],
    ["甲 乙", "乙甲。"],
    ["甲？乙 ", "甲。乙。"],
    ["甲𠀀乙 ", "甲乙。"],
    ["甲乙", "太常寺。甲乙。"],
    ["甲乙", "甲〇乙"],
    ["甲乙", "甲○乙"],
  ])("rejects changed or incomplete source exactly as DB validation: %j -> %j", (source, punctuation) => {
    expect(() => validatePunctuationText(source, punctuation)).toThrow();
    expect(createPunctuationProjection(source, punctuation)).toBeNull();
  });

  it("rejects empty, fractional, and out-of-bounds source ranges", () => {
    const mapping = createPunctuationProjection("甲乙", "甲，乙。")!;
    for (const [from, to] of [[0, 0], [-1, 1], [0, 3], [1, 0], [0.5, 1], [0, Number.NaN], [0, Infinity]]) {
      expect(projectSourceRange(mapping, from!, to!)).toBeNull();
    }
  });

  it("maps a source click to a caret after the preceding character", () => {
    const source = "錢塘 國朝昇平";
    const punctuation = "錢塘，國朝昇平。";
    const mapping = createPunctuationProjection(source, punctuation)!;
    // Before and after the source space, the caret stays on 塘 ahead of the comma.
    expect(punctuationCaretForSource(mapping, source, 2)).toBe(2);
    expect(punctuationCaretForSource(mapping, source, 3)).toBe(2);
    expect(punctuationCaretForSource(mapping, source, 0)).toBe(0);
    expect(punctuationCaretForSource(mapping, source, 7)).toBe(7);
  });

  it("counts supplementary Hanja in UTF-16 caret offsets", () => {
    const source = "蛾眉𥊑睩 管絃";
    const punctuation = "蛾眉𥊑睩，管絃。";
    const mapping = createPunctuationProjection(source, punctuation)!;
    expect(punctuationCaretForSource(mapping, source, 4)).toBe(5);
    expect(punctuation.slice(0, 5)).toBe("蛾眉𥊑睩");
  });
});
