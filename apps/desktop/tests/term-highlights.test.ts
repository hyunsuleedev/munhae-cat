import { expect, it } from "vitest";
import type { TermEntry } from "../src/shared/munhae-api";
import { termHits, termSegments } from "../src/renderer/scripts/term-highlights";
const term = (id: string, form: string, extra = {}) => ({ id, sourceForm: form, documentId: null, occurrences: [], ...extra } as unknown as TermEntry);
it("preserves source text and supports overlapping, repeated and supplementary glyph occurrences", () => {
  const text = "𠮷祖生先著鞭。祖生。";
  const hits = termHits(text, "v1", [term("long", "祖生先著鞭"), term("short", "祖生"), term("glyph", "𠮷")]);
  expect(hits.filter(h => h.id === "short").map(h => h.start)).toEqual([2, 8]);
  const segments = termSegments(text, hits);
  expect(segments.map(s => s.text).join("")).toBe(text);
  expect(segments.find(s => s.text === "祖生")?.hits.map(h => h.id)).toEqual(["long", "short"]);
  expect(hits.find(h => h.id === "glyph")).toMatchObject({ start: 0, end: 2 });
});
it("uses saved sense-specific occurrences for current local entries and relocates stale entries by exact glyphs", () => {
  const text = "王建。王建。";
  const local = term("a", "王建", { documentId: "doc", sourceVersion: "v1", occurrences: [{ start: 3, end: 5, quote: "王建。" }] });
  expect(termHits(text, "v1", [local]).map(h => h.start)).toEqual([3]);
  expect(termHits(text, "v2", [local]).map(h => h.start)).toEqual([0, 3]);
  expect(termHits("王健。", "v2", [local])).toEqual([]);
});
it("splits across lines without changing text or dropping overlapping ranges", () => {
  const text = "甲乙\n丙丁";
  const hits = termHits(text, "v1", [term("span", "乙\n丙")]);
  expect(termSegments(text, hits, 0, 2).map(s => s.text).join("")).toBe("甲乙");
  expect(termSegments(text, hits, 3, 5)[0]).toMatchObject({ text: "丙", hits: [expect.objectContaining({ id: "span" })] });
});
