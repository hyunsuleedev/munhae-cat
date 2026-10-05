import { expect, it } from "vitest";
import { termHits, termSegments } from "../src/renderer/scripts/term-highlights";

it("renders stored code point ranges at UTF-16 offsets, including supplementary glyphs", () => {
  const text = "𠮷祖生先著鞭。祖生。";
  const hits = termHits(text, [
    { id: "long", ranges: [{ from: 1, to: 6 }], candidate: false },
    { id: "short", ranges: [{ from: 8, to: 10 }, { from: 1, to: 3 }], candidate: true },
    { id: "glyph", ranges: [{ from: 0, to: 1 }], candidate: false },
  ]);
  expect(hits.filter(h => h.id === "short").map(h => [h.start, h.index])).toEqual([[2, 0], [9, 1]]);
  expect(hits.find(h => h.id === "glyph")).toMatchObject({ start: 0, end: 2, candidate: false });
  const segments = termSegments(text, hits);
  expect(segments.map(s => s.text).join("")).toBe(text);
  expect(segments.find(s => s.text === "祖生")?.hits.map(h => h.id)).toEqual(["long", "short"]);
});

it("ignores ranges beyond the text and splits across lines without dropping overlaps", () => {
  const text = "王建\n宮詞";
  const hits = termHits(text, [{ id: "a", ranges: [{ from: 0, to: 2 }, { from: 9, to: 10 }], candidate: false }, { id: "b", ranges: [{ from: 1, to: 2 }], candidate: false }]);
  expect(hits).toHaveLength(2);
  expect(termSegments(text, hits, 0, 2).map(s => [s.text, s.hits.map(h => h.id)])).toEqual([["王", ["a"]], ["建", ["a", "b"]]]);
  expect(termSegments(text, hits, 3, 5)).toEqual([{ start: 3, end: 5, text: "宮詞", hits: [] }]);
});
