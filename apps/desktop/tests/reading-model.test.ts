import { describe, expect, it } from "vitest";
import type { EditorView } from "../src/shared/munhae-api";
import { buildReadingUnits, readingTokens, type ReadingRange } from "../src/renderer/scripts/reading-model";

function view(source: string, pairs: Array<{ text: string; ranges: ReadingRange[]; needsReview?: boolean }> = []): EditorView {
  let cursor = 0;
  const sentences = pairs.map((pair, index) => {
    const from = cursor;
    cursor += Array.from(pair.text).length;
    return { id: `T${index + 1}`, from, to: cursor, text: pair.text };
  });
  return {
    source: { versionId: "source-1", contentText: source, versionNo: 1, state: "confirmed", lockVersion: 0 },
    punctuation: null,
    translation: pairs.length ? { versionId: "translation-1", textContent: pairs.map(pair => pair.text).join(""),
      isCurrentDependencies: true, state: "draft", textLayout: { state: "ready", error: null, sentences,
        links: pairs.map((pair, index) => ({ sentenceId: `T${index + 1}`, spans: pair.ranges, needsReview: pair.needsReview ?? false })) } } : null,
  } as EditorView;
}

const span = (quote: string, from = 0): ReadingRange => ({ from, to: from + Array.from(quote).length, quote });
const quotes = (input: EditorView) => buildReadingUnits(input).map(unit => unit.ranges.map(range => range.quote));

describe("source-grounded reading units", () => {
  it("distinguishes repeated phrases by exact code-point positions after supplementary Han", () => {
    const units = buildReadingUnits(view("𠮷太守乙太守", [
      { text: "둘째 태수다.", ranges: [span("太守", 4)] },
      { text: "첫 태수다.", ranges: [span("太守", 1)] },
    ]));
    expect(units.map(unit => [unit.translation, unit.ranges])).toEqual([
      [null, [span("𠮷", 0)]], ["첫 태수다.", [span("太守", 1)]],
      [null, [span("乙", 3)]], ["둘째 태수다.", [span("太守", 4)]],
    ]);
  });

  it("keeps separated ranges separate and exposes the uncovered text for study", () => {
    const [linked, gap, tail] = buildReadingUnits(view("甲乙丙丁戊己", [
      { text: "갑과 무다.", ranges: [span("戊", 4), span("甲乙", 0)] },
    ]));
    expect(linked).toMatchObject({ id: "translation:T1", translation: "갑과 무다.", ranges: [span("甲乙", 0), span("戊", 4)] });
    expect(gap).toMatchObject({ translation: null, ranges: [span("丙丁", 2)], needsReview: true });
    expect(tail?.ranges).toEqual([span("己", 5)]);
    expect(readingTokens(linked!.ranges).map(token => [token.from, token.to, token.rangeIndex])).toEqual([[0, 1, 0], [1, 2, 0], [4, 5, 1]]);
  });

  it("deduplicates and merges overlapping or adjacent spans without repeating characters", () => {
    const units = buildReadingUnits(view("甲乙丙丁", [{ text: "네 글자다.", ranges: [
      span("甲乙"), span("甲乙"), span("乙丙", 1), span("丁", 3),
    ] }]));
    expect(units).toHaveLength(1);
    expect(units[0]?.ranges).toEqual([span("甲乙丙丁")]);
  });

  it("preserves separate translated sentences sharing a source range and does not add duplicate fallback", () => {
    const units = buildReadingUnits(view("甲乙", [
      { text: "갑이다.", ranges: [span("甲乙")] }, { text: "을이다.", ranges: [span("甲乙")], needsReview: true },
    ]));
    expect(units.map(unit => [unit.translation, unit.needsReview])).toEqual([["갑이다.", false], ["을이다.", true]]);
  });

  it("does not use stale dependencies even when quoted text happens to remain identical", () => {
    const input = view("甲乙", [{ text: "옛 번역.", ranges: [span("甲乙")] }]);
    input.translation!.isCurrentDependencies = false;
    expect(buildReadingUnits(input)).toEqual([{ id: "source:0:2", label: "원문 구절", translation: null,
      ranges: [span("甲乙")], needsReview: true }]);
  });

  it("rejects an entire link when one quoted span is wrong instead of displaying a partial false correspondence", () => {
    const input = view("甲乙丙", [{ text: "전체 구절.", ranges: [span("甲"), span("錯", 2)] }]);
    expect(buildReadingUnits(input).map(unit => unit.translation)).toEqual([null]);
    expect(quotes(input)).toEqual([["甲乙丙"]]);
  });

  it.each([
    { from: -1, to: 1, quote: "甲" }, { from: 0, to: 0, quote: "" },
    { from: 0.5, to: 1, quote: "甲" }, { from: 0, to: 3, quote: "甲乙" },
  ])("rejects invalid canonical ranges %j", range => {
    expect(buildReadingUnits(view("甲乙", [{ text: "번역.", ranges: [range] }]))[0]?.translation).toBeNull();
  });

  it("rejects stale translated sentence text and duplicate link identities", () => {
    const input = view("甲乙", [{ text: "갑이다.", ranges: [span("甲乙")] }]);
    input.translation!.textContent = "을이다.";
    expect(buildReadingUnits(input)[0]?.translation).toBeNull();
    input.translation!.textContent = "갑이다.";
    input.translation!.textLayout!.links.push(input.translation!.textLayout!.links[0]!);
    expect(buildReadingUnits(input)[0]?.translation).toBeNull();
  });

  it.each(["pending", "running"] as const)("does not present provisional %s alignment", state => {
    const input = view("甲乙", [{ text: "번역.", ranges: [span("甲乙")] }]);
    input.translation!.textLayout!.state = state;
    expect(buildReadingUnits(input)[0]?.translation).toBeNull();
  });

  it("retains an explicitly uncertain valid correspondence as needing review", () => {
    const input = view("甲乙", [{ text: "번역.", ranges: [span("甲乙")] }]);
    input.translation!.textLayout!.state = "needs_review";
    expect(buildReadingUnits(input)[0]).toMatchObject({ translation: "번역.", needsReview: true });
  });

  it("does not assign an unlinked or legacy translation by sentence order", () => {
    const input = view("甲。乙。", [{ text: "연결 없음.", ranges: [] }]);
    expect(buildReadingUnits(input).every(unit => unit.translation === null)).toBe(true);
    input.translation!.textLayout = undefined;
    expect(buildReadingUnits(input).every(unit => unit.translation === null)).toBe(true);
  });

  it("uses valid punctuation sentence boundaries without inserting punctuation into canonical ranges", () => {
    const input = view("甲乙丙丁戊");
    input.punctuation = { state: "confirmed", punctuatedText: "甲乙。丙丁！戊。" } as EditorView["punctuation"];
    expect(quotes(input)).toEqual([["甲乙"], ["丙丁"], ["戊"]]);
    expect(buildReadingUnits(input).map(unit => unit.ranges[0]!.from)).toEqual([0, 2, 4]);
    input.punctuation!.punctuatedText = "甲錯。丙丁戊。";
    expect(quotes(input)).toEqual([["甲乙丙丁戊"]]);
  });

  it("uses actual source paragraph and Chinese punctuation boundaries", () => {
    expect(quotes(view("甲。乙！\n丙丁\n戊"))).toEqual([["甲。"], ["乙！"], ["丙丁\n"], ["戊"]]);
  });

  it("bounds unpunctuated chunks and never splits Han plus a variation selector", () => {
    const text = "甲".repeat(159) + "禰\u{E0100}" + "𠮷".repeat(170);
    const units = buildReadingUnits(view(text));
    expect(units.map(unit => unit.ranges[0]!.to - unit.ranges[0]!.from)).toEqual([159, 160, 12]);
    expect(units.flatMap(unit => unit.ranges).map(range => range.quote).join("")).toBe(text);
    expect(units[1]?.ranges[0]?.quote.startsWith("禰\u{E0100}")).toBe(true);
    const invalid = view("禰\u{E0100}甲", [{ text: "자형 일부.", ranges: [span("禰")] }]);
    expect(buildReadingUnits(invalid)[0]?.translation).toBeNull();
  });

  it.each(["", " \n\t", undefined])("returns no study units for absent or blank source %j", text => {
    expect(buildReadingUnits(view(text as string))).toEqual([]);
  });
});

describe("source tokens", () => {
  it("keeps supplementary Han, IVS and combining marks intact at code-point coordinates", () => {
    expect(readingTokens([span("𠮷禰\u{E0100}e\u0301", 7)])).toEqual([
      { text: "𠮷", from: 7, to: 8, rangeIndex: 0, annotatable: true },
      { text: "禰\u{E0100}", from: 8, to: 10, rangeIndex: 0, annotatable: true },
      { text: "e\u0301", from: 10, to: 12, rangeIndex: 0, annotatable: true },
    ]);
  });

  it("preserves punctuation and whitespace without presenting them as dictionary terms", () => {
    expect(readingTokens([span("甲，\n 乙")]).map(token => [token.text, token.annotatable]))
      .toEqual([["甲", true], ["，", false], ["\n", false], [" ", false], ["乙", true]]);
  });
});
