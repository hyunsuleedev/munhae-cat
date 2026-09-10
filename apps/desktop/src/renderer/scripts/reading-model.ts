import type { EditorView } from "../../shared/munhae-api";
import { createPunctuationProjection } from "./punctuation-projection";

export type ReadingRange = { from: number; to: number; quote: string };
export type ReadingUnit = {
  id: string;
  label: string;
  translation: string | null;
  ranges: ReadingRange[];
  needsReview: boolean;
};
export type ReadingToken = {
  text: string;
  from: number;
  to: number;
  /** Selection may extend only within this range, never across a displayed gap. */
  rangeIndex: number;
  annotatable: boolean;
};

const segmenter = new Intl.Segmenter("zh-Hant", { granularity: "grapheme" });
const MAX_SOURCE_CHUNK = 160;
const HAS_LETTER_OR_NUMBER = /[\p{Letter}\p{Number}]/u;

/** Preserve canonical code-point positions, including supplementary Han and IVS. */
export function readingTokens(ranges: readonly ReadingRange[]): ReadingToken[] {
  return ranges.flatMap((range, rangeIndex) => {
    let cursor = range.from;
    const tokens: ReadingToken[] = [];
    for (const { segment } of segmenter.segment(range.quote)) {
      const from = cursor;
      cursor += Array.from(segment).length;
      tokens.push({ text: segment, from, to: cursor, rangeIndex, annotatable: HAS_LETTER_OR_NUMBER.test(segment) });
    }
    return tokens;
  });
}

function mergeRanges(ranges: readonly ReadingRange[], source: readonly string[]): ReadingRange[] {
  const merged: ReadingRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = merged.at(-1);
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
      last.quote = source.slice(last.from, last.to).join("");
    } else merged.push({ ...range });
  }
  return merged;
}

function sentenceBoundaries(points: readonly string[]): number[] {
  const boundaries: number[] = [];
  for (let index = 0; index < points.length; index++) {
    const char = points[index]!;
    if (char === "\n" || char === "\r") boundaries.push(index + 1);
    else if (/[。！？]/u.test(char) || (/[.!?]/u.test(char) && (index + 1 === points.length || /\s/u.test(points[index + 1]!)))) {
      let end = index + 1;
      while (end < points.length && /[”’"'」』)\]】]/u.test(points[end]!)) end++;
      boundaries.push(end);
      index = end - 1;
    }
  }
  return boundaries;
}

function after(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (values[mid]! <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Build from persisted source and checked correspondence only. Invalid or stale
 * correspondence leaves source-only units; it never assigns translation by order.
 */
export function buildReadingUnits(view: EditorView): ReadingUnit[] {
  const text = view.source?.contentText;
  if (typeof text !== "string" || !text.trim()) return [];
  const source = Array.from(text);
  const sourceTokens = readingTokens([{ from: 0, to: source.length, quote: text }]);
  const graphemeBoundaries = new Set([0, ...sourceTokens.map(token => token.to)]);
  const units: ReadingUnit[] = [];
  const translation = view.translation;
  const layout = translation?.textLayout;
  const validSourceRange = (range: ReadingRange) => Number.isInteger(range.from) && Number.isInteger(range.to)
    && range.from >= 0 && range.to > range.from && range.to <= source.length
    && graphemeBoundaries.has(range.from) && graphemeBoundaries.has(range.to)
    && source.slice(range.from, range.to).join("") === range.quote;

  if (translation?.isCurrentDependencies && layout && layout.state !== "running" && layout.state !== "pending") {
    const translated = Array.from(translation.textContent);
    const sentenceCounts = new Map<string, number>();
    const links = new Map<string, typeof layout.links>();
    for (const sentence of layout.sentences) sentenceCounts.set(sentence.id, (sentenceCounts.get(sentence.id) ?? 0) + 1);
    for (const link of layout.links) links.set(link.sentenceId, [...(links.get(link.sentenceId) ?? []), link]);
    layout.sentences.forEach((sentence, index) => {
      const matches = links.get(sentence.id);
      const link = matches?.[0];
      if (sentenceCounts.get(sentence.id) !== 1 || matches?.length !== 1 || !link?.spans.length
        || !Number.isInteger(sentence.from) || !Number.isInteger(sentence.to)
        || sentence.from < 0 || sentence.to <= sentence.from || sentence.to > translated.length
        || !sentence.text.trim() || translated.slice(sentence.from, sentence.to).join("") !== sentence.text
        || !link.spans.every(validSourceRange)) return;
      units.push({
        id: `translation:${sentence.id}`, label: `번역 문장 ${index + 1}`, translation: sentence.text,
        ranges: mergeRanges(link.spans, source), needsReview: link.needsReview || layout.state !== "ready" || !!layout.error,
      });
    });
  }

  const boundaries = new Set(sentenceBoundaries(source));
  const punctuation = view.punctuation;
  const projection = punctuation && (punctuation.state === "confirmed" || punctuation.state === "draft")
    ? createPunctuationProjection(text, punctuation.punctuatedText) : null;
  if (projection) {
    for (const boundary of sentenceBoundaries(projection.codepoints)) {
      boundaries.add(projection.sourceBoundaryByPunctuationBoundary[boundary]!);
    }
  }
  boundaries.add(source.length);
  const preferredEnds = [...boundaries].filter(boundary => graphemeBoundaries.has(boundary)).sort((a, b) => a - b);
  const graphemeEnds = sourceTokens.map(token => token.to);
  const coverage = mergeRanges(units.flatMap(unit => unit.ranges), source);
  const gaps: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  for (const range of coverage) {
    if (cursor < range.from) gaps.push({ from: cursor, to: range.from });
    cursor = range.to;
  }
  if (cursor < source.length) gaps.push({ from: cursor, to: source.length });

  for (const gap of gaps) {
    let from = gap.from;
    while (from < gap.to) {
      const limit = Math.min(from + MAX_SOURCE_CHUNK, gap.to);
      const preferred = preferredEnds[after(preferredEnds, from)];
      const bounded = graphemeEnds[after(graphemeEnds, limit) - 1];
      const naturalEnd = preferred !== undefined && preferred <= limit ? preferred : undefined;
      const boundedEnd = bounded !== undefined && bounded > from ? bounded : undefined;
      // A single grapheme can exceed the limit; never separate its combining marks.
      const to = naturalEnd ?? boundedEnd ?? graphemeEnds[after(graphemeEnds, from)]!;
      const quote = source.slice(from, to).join("");
      if (quote.trim()) units.push({ id: `source:${from}:${to}`, label: "원문 구절", translation: null,
        ranges: [{ from, to, quote }], needsReview: !!translation });
      from = to;
    }
  }
  return units.sort((a, b) => a.ranges[0]!.from - b.ranges[0]!.from);
}
