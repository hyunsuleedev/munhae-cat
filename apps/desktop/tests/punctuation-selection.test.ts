import { describe, expect, it } from "vitest";
import { createPunctuationProjection, projectSourceRange } from "../src/renderer/scripts/punctuation-projection";
import { displayRangeFromSource, sourceRangeFromDisplay, type SourceDisplay } from "../src/renderer/scripts/review-selection";

function display(source: string, punctuated: string, from = 0, to = Array.from(source).length): SourceDisplay {
  const projection = createPunctuationProjection(source, punctuated);
  expect(projection).not.toBeNull();
  const projected = projectSourceRange(projection!, from, to);
  expect(projected).not.toBeNull();
  return { ...projected!, sourceText: Array.from(source).slice(from, to).join(""), sourceFrom: from };
}

describe("canonical comment selection through a punctuation display", () => {
  it("maps the second repeated phrase without moving to the first occurrence", () => {
    const shown = display("太守問僧僧答太守", "太守問僧，僧答太守。", 6, 8);
    expect(shown.text).toBe("太守。");
    expect(sourceRangeFromDisplay(shown, 0, 2)).toEqual({ from: 6, to: 8, quote: "太守" });
    expect(sourceRangeFromDisplay(shown, 0, 3)).toEqual({ from: 6, to: 8, quote: "太守" });
    expect(displayRangeFromSource(shown, 6, 8, "太守")).toEqual({ from: 0, to: 2 });
    expect(displayRangeFromSource(shown, 0, 2, "太守")).toBeNull();
  });

  it("uses display codepoints and absolute source codepoints for supplementary Hanja", () => {
    const source = "𠮷太守問𠮷太守答";
    const punctuation = "「𠮷太守問。」𠮷太守答。";
    const first = display(source, punctuation, 0, 4);
    expect(sourceRangeFromDisplay(first, 1, 2)).toEqual({ from: 0, to: 1, quote: "𠮷" });
    expect(displayRangeFromSource(first, 0, 1, "𠮷")).toEqual({ from: 1, to: 2 });
    const second = display(source, punctuation, 4, 8);
    expect(sourceRangeFromDisplay(second, 0, 1)).toEqual({ from: 4, to: 5, quote: "𠮷" });
    expect(sourceRangeFromDisplay(second, 1, 3)).toEqual({ from: 5, to: 7, quote: "太守" });
    expect(displayRangeFromSource(second, 5, 7, "太守")).toEqual({ from: 1, to: 3 });
  });

  it("rejects inserted-only selections while retaining internal display punctuation in a highlight", () => {
    const shown = display("甲乙", "「甲，乙。」");
    expect(sourceRangeFromDisplay(shown, 0, 1)).toBeNull();
    expect(sourceRangeFromDisplay(shown, 2, 3)).toBeNull();
    expect(sourceRangeFromDisplay(shown, 4, 6)).toBeNull();
    expect(sourceRangeFromDisplay(shown, 0, 6)).toEqual({ from: 0, to: 2, quote: "甲乙" });
    const mark = displayRangeFromSource(shown, 0, 2, "甲乙");
    expect(mark).toEqual({ from: 1, to: 4 });
    expect(Array.from(shown.text).slice(mark!.from, mark!.to).join("")).toBe("甲，乙");
  });

  it("distinguishes punctuation already in the source from an identical inserted mark", () => {
    const shown = display("甲。乙", "甲。。「乙！」");
    expect(sourceRangeFromDisplay(shown, 1, 2)).toEqual({ from: 1, to: 2, quote: "。" });
    expect(sourceRangeFromDisplay(shown, 2, 3)).toBeNull();
    expect(sourceRangeFromDisplay(shown, 3, 4)).toBeNull();
    expect(displayRangeFromSource(shown, 1, 2, "。")).toEqual({ from: 1, to: 2 });
    expect(sourceRangeFromDisplay(shown, 4, 7)).toEqual({ from: 2, to: 3, quote: "乙" });
  });

  it("preserves both CR and LF in canonical ranges when the punctuation layer copies them", () => {
    const shown = display("𠮷\r\n乙𠮷", "𠮷。\r\n乙，𠮷。");
    expect(sourceRangeFromDisplay(shown, 4, 5)).toEqual({ from: 3, to: 4, quote: "乙" });
    expect(sourceRangeFromDisplay(shown, 6, 7)).toEqual({ from: 4, to: 5, quote: "𠮷" });
    expect(displayRangeFromSource(shown, 3, 5, "乙𠮷")).toEqual({ from: 4, to: 7 });
    expect(sourceRangeFromDisplay(shown, 2, 4)).toBeNull();
  });

  it("retains omitted CRLF in a broad canonical quote but clips a smaller source span", () => {
    const source = "𠮷甲\r\n乙𠮷\r丙";
    const punctuation = "𠮷甲，乙𠮷；丙。";
    const full = display(source, punctuation);
    expect(sourceRangeFromDisplay(full, 3, 4)).toEqual({ from: 2, to: 5, quote: "\r\n乙" });
    expect(displayRangeFromSource(full, 4, 5, "乙")).toEqual({ from: 3, to: 4 });
    const excerpt = display(source, punctuation, 4, 6);
    expect(excerpt.text).toBe("乙𠮷；");
    expect(sourceRangeFromDisplay(excerpt, 0, 1)).toEqual({ from: 4, to: 5, quote: "乙" });
    expect(sourceRangeFromDisplay(excerpt, 0, 3)).toEqual({ from: 4, to: 6, quote: "乙𠮷" });
  });

  it("does not turn an inserted final mark into a comment on omitted trailing whitespace", () => {
    const shown = display("甲 \r\n", "甲？");
    expect(sourceRangeFromDisplay(shown, 1, 2)).toBeNull();
    expect(sourceRangeFromDisplay(shown, 0, 2)).toEqual({ from: 0, to: 4, quote: "甲 \r\n" });
    expect(displayRangeFromSource(shown, 0, 1, "甲")).toEqual({ from: 0, to: 1 });
  });

  it("keeps raw source punctuation and subrange offsets when no punctuation is added", () => {
    const shown = display("序。甲，乙。終", "序。甲，乙。終", 2, 6);
    expect(sourceRangeFromDisplay(shown, 0, 4)).toEqual({ from: 2, to: 6, quote: "甲，乙。" });
    expect(displayRangeFromSource(shown, 3, 5, "，乙")).toEqual({ from: 1, to: 3 });
  });

  it("rejects stale quoted text and invalid display/source bounds", () => {
    const shown = display("甲乙丙", "甲，乙。丙", 1, 3);
    expect(displayRangeFromSource(shown, 1, 2, "丙")).toBeNull();
    expect(displayRangeFromSource(shown, 0, 1, "甲")).toBeNull();
    expect(displayRangeFromSource(shown, 2, 4, "丙丁")).toBeNull();
    for (const [from, to] of [[0, 0], [-1, 1], [0, 4], [0.5, 1], [0, Number.NaN], [0, Infinity]]) {
      expect(sourceRangeFromDisplay(shown, from!, to!)).toBeNull();
    }
  });
});
