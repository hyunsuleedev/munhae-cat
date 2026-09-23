import type { TermEntry } from "../../shared/munhae-api";

export type TermHit = { id: string; start: number; end: number; index: number };
export function termHits(text: string, version: string, terms: TermEntry[]): TermHit[] {
  return terms.flatMap(term => {
    if (!term.sourceForm) return [];
    const ranges = term.documentId && term.sourceVersion === version
      ? term.occurrences.filter(o => text.slice(o.start, o.end) === term.sourceForm)
      : (() => {
        const result: { start: number; end: number }[] = [];
        let start = text.indexOf(term.sourceForm);
        while (start >= 0) { result.push({ start, end: start + term.sourceForm.length }); start = text.indexOf(term.sourceForm, start + term.sourceForm.length); }
        return result;
      })();
    return [...new Map(ranges.map(range => [range.start, range])).values()].sort((a, b) => a.start - b.start)
      .map((range, index) => ({ id: term.id, start: range.start, end: range.end, index }));
  });
}

export function termSegments(text: string, hits: TermHit[], start = 0, end = text.length) {
  const intersecting = hits.filter(hit => hit.start < end && hit.end > start);
  const points = [...new Set([start, end, ...intersecting.flatMap(hit => [Math.max(start, hit.start), Math.min(end, hit.end)])])].sort((a, b) => a - b);
  return points.slice(0, -1).map((from, index) => ({ start: from, end: points[index + 1]!, text: text.slice(from, points[index + 1]), hits: intersecting.filter(hit => hit.start <= from && hit.end >= points[index + 1]!) }));
}
