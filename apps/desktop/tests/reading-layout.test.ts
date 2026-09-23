import { describe, expect, it } from "vitest";
import { packReadingRows, type ReadingLayoutToken } from "../src/renderer/scripts/reading-layout";
import { readingTokens } from "../src/renderer/scripts/reading-model";

const chars = (text: string, from = 0) => readingTokens([{ from, to: from + Array.from(text).length, quote: text }])
  .filter(token => token.annotatable);
const rowText = (rows: ReadingLayoutToken[][]) => rows.map(row => row.map(token => token.text).join(""));

describe("reading rows", () => {
  it("keeps exact graphemes, object identities and code-point positions while wrapping", () => {
    const tokens = chars("甲𠮷葛\u{E0100}乙甲乙", 17);
    const before = structuredClone(tokens);
    const rows = packReadingRows(tokens, { columns: 3 });
    expect(rowText(rows)).toEqual(["甲𠮷葛\u{E0100}", "乙甲乙"]);
    expect(rows.flat().every((token, index) => token === tokens[index])).toBe(true);
    expect(tokens).toEqual(before);
    expect(rows[0]![2]).toMatchObject({ from: 19, to: 21 });
  });

  it("combines clauses that fit and starts a whole fitting clause on the next row", () => {
    const tokens = chars("甲乙丙丁戊己庚辛壬癸");
    expect(rowText(packReadingRows(tokens, { columns: 5, breakAfter: [3, 5, 9] })))
      .toEqual(["甲乙丙丁戊", "己庚辛壬癸"]);
    expect(rowText(packReadingRows(tokens, { columns: 5, breakAfter: [3, 7] })))
      .toEqual(["甲乙丙", "丁戊己庚", "辛壬癸"]);
  });

  it("does not join separated source ranges even when both fit in one row", () => {
    const tokens = readingTokens([
      { from: 0, to: 2, quote: "甲乙" }, { from: 12, to: 14, quote: "丙丁" },
    ]);
    expect(rowText(packReadingRows(tokens, { columns: 8, groups: [{ from: 0, to: 14 }] })))
      .toEqual(["甲乙", "丙丁"]);
  });

  it("keeps a fitting saved phrase together across a would-be row or clause break", () => {
    const tokens = chars("甲乙丙丁戊己庚辛");
    expect(rowText(packReadingRows(tokens, { columns: 4, groups: [{ from: 2, to: 5 }] })))
      .toEqual(["甲乙", "丙丁戊己", "庚辛"]);
    expect(rowText(packReadingRows(tokens, { columns: 5, groups: [{ from: 2, to: 5 }], breakAfter: [3] })))
      .toEqual(["甲乙丙丁戊", "己庚辛"]);
  });

  it("allows punctuation gaps inside a source-ordered phrase without changing offsets", () => {
    const tokens = chars("甲乙，丙丁戊己");
    expect(rowText(packReadingRows(tokens, { columns: 3, groups: [{ from: 1, to: 5 }] })))
      .toEqual(["甲", "乙丙丁", "戊己"]);
  });

  it("wraps an oversized phrase and resolves impossible overlapping groups without losing tokens", () => {
    const tokens = chars("甲乙丙丁戊己庚辛");
    expect(rowText(packReadingRows(tokens, { columns: 3, groups: [{ from: 0, to: 8 }] })))
      .toEqual(["甲乙丙", "丁戊己", "庚辛"]);
    const rows = packReadingRows(tokens, { columns: 4, groups: [{ from: 0, to: 4 }, { from: 2, to: 6 }] });
    expect(rows.flat()).toEqual(tokens);
    expect(rows.every(row => row.length > 0 && row.length <= 4)).toBe(true);
  });

  it("does not group nonadjacent or reversed phrase members in reading order", () => {
    const tokens = chars("甲乙丙丁戊己");
    const separated = [tokens[0]!, tokens[2]!, tokens[1]!, ...tokens.slice(3)];
    expect(rowText(packReadingRows(separated, { columns: 3, groups: [{ from: 1, to: 4 }] })))
      .toEqual(["甲丙乙", "丁戊己"]);
    const nonadjacent = [tokens[0]!, tokens[1]!, tokens[4]!, tokens[2]!, tokens[3]!, tokens[5]!];
    expect(rowText(packReadingRows(nonadjacent, { columns: 3, groups: [{ from: 1, to: 4 }] })))
      .toEqual(["甲乙戊", "丙丁己"]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("safely falls back to one column for %s", columns => {
    expect(rowText(packReadingRows(chars("甲乙"), { columns }))).toEqual(["甲", "乙"]);
  });

  it("handles no displayed characters", () => {
    expect(packReadingRows([], { columns: 8 })).toEqual([]);
  });
});
