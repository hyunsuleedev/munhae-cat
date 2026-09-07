import { describe, expect, it } from "vitest";
import { validatePunctuationText } from "../src/source-layer.ts";

describe("punctuation source preservation with layout whitespace", () => {
  it("maps reflowed whitespace back to the original source positions", () => {
    expect(validatePunctuationText(" \t甲\n乙 \u3000", "甲，乙。")).toEqual({
      sourceBoundaryByPunctuationBoundary: [0, 3, 3, 5, 7],
      insertedCodepoints: ["，", "。"],
    });
  });

  it("keeps existing boundary mappings when whitespace is copied unchanged", () => {
    expect(validatePunctuationText("甲 \n乙", "甲 \n乙").sourceBoundaryByPunctuationBoundary)
      .toEqual([0, 1, 2, 3, 4]);
  });

  it.each([
    ["甲〇乙 ", "甲○乙。"],
    ["甲〇乙 ", "甲乙。"],
    ["甲 乙", "甲丙。"],
    ["甲 乙", "乙甲。"],
    ["甲？乙 ", "甲。乙。"],
    ["甲𠀀乙 ", "甲乙。"],
    ["甲乙", "太常寺。甲乙。"],
  ])("still rejects a character change from %s to %s", (source, response) => {
    expect(() => validatePunctuationText(source, response)).toThrow();
  });

  it("tracks a new final mark even when its source boundary absorbs trailing whitespace", () => {
    const result = validatePunctuationText("甲 \n", "甲？");
    expect(result.sourceBoundaryByPunctuationBoundary).toEqual([0, 1, 3]);
    expect(result.insertedCodepoints).toEqual(["？"]);
  });
});
