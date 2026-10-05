import type { TermRange } from "../../shared/munhae-api";
import { utf16Offsets } from "./term-review-model";

/** A stored code point range converted to UTF-16 offsets for rendering. */
export type TermHit = { id: string; start: number; end: number; index: number; candidate: boolean };
export function termHits(text: string, items: Array<{ id: string; ranges: TermRange[]; candidate: boolean }>): TermHit[] {
  const offsets = utf16Offsets(text);
  return items.flatMap(item => [...item.ranges].sort((a, b) => a.from - b.from)
    .filter(range => range.to < offsets.length)
    .map((range, index) => ({ id: item.id, start: offsets[range.from]!, end: offsets[range.to]!, index, candidate: item.candidate })));
}

export function termSegments(text: string, hits: TermHit[], start = 0, end = text.length) {
  const intersecting = hits.filter(hit => hit.start < end && hit.end > start);
  const points = [...new Set([start, end, ...intersecting.flatMap(hit => [Math.max(start, hit.start), Math.min(end, hit.end)])])].sort((a, b) => a - b);
  return points.slice(0, -1).map((from, index) => ({ start: from, end: points[index + 1]!, text: text.slice(from, points[index + 1]), hits: intersecting.filter(hit => hit.start <= from && hit.end >= points[index + 1]!) }));
}
