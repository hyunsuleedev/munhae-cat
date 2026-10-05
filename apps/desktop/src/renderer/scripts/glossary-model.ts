import type { ProjectTermListItem, TermSentence } from "../../shared/munhae-api";
import { TERM_KIND_LABELS } from "./term-review-model";

export type GlossarySort = "reading" | "kind" | "documents";

const collator = new Intl.Collator("ko");
const KIND_ORDER = Object.keys(TERM_KIND_LABELS);

/** The Korean shown beside the hanja headword: the chosen translation, else the reading. */
export const termTranslation = (term: ProjectTermListItem) => term.translation || term.reading || "";

/** The reading, only when it adds something to the shown translation. */
export const distinctReading = (term: ProjectTermListItem) => term.reading && term.reading !== termTranslation(term) ? term.reading : null;

/** Numbers each sense of a written form that has more than one, as a dictionary does: 王建¹, 王建². */
export function homographNumbers(terms: ProjectTermListItem[]): Map<string, number> {
  const byForm = new Map<string, string[]>();
  for (const term of terms) byForm.set(term.sourceForm, [...byForm.get(term.sourceForm) ?? [], term.id]);
  const numbers = new Map<string, number>();
  for (const ids of byForm.values()) if (ids.length > 1) ids.forEach((id, index) => numbers.set(id, index + 1));
  return numbers;
}

export function glossaryMatches(term: ProjectTermListItem, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  return [term.sourceForm, term.reading, term.translation, term.definition, ...term.documents.flatMap(use => [use.title, use.contextNote])]
    .some(value => value?.toLocaleLowerCase().includes(q));
}

export function sortGlossary(terms: ProjectTermListItem[], sort: GlossarySort): ProjectTermListItem[] {
  const byReading = (a: ProjectTermListItem, b: ProjectTermListItem) =>
    collator.compare(a.reading || termTranslation(a) || a.sourceForm, b.reading || termTranslation(b) || b.sourceForm) || terms.indexOf(a) - terms.indexOf(b);
  const compare = sort === "kind" ? (a: ProjectTermListItem, b: ProjectTermListItem) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || byReading(a, b)
    : sort === "documents" ? (a: ProjectTermListItem, b: ProjectTermListItem) => b.documents.length - a.documents.length || byReading(a, b)
    : byReading;
  return [...terms].sort(compare);
}

/** The first sentence of a definition, to tell homographs apart at a glance. */
export const firstSentence = (text: string) => text.match(/^.*?[.。](?=\s|$)/)?.[0] ?? text;

/** A sentence cut into plain and marked runs by code point; overlapping marks merge. */
export function sentenceRuns(sentence: TermSentence): Array<{ text: string; marked: boolean }> {
  const points = Array.from(sentence.text), runs: Array<{ text: string; marked: boolean }> = [];
  let at = 0;
  for (const mark of sentence.marks) {
    if (mark.to <= at) continue;
    const from = Math.max(at, mark.from);
    if (from > at) runs.push({ text: points.slice(at, from).join(""), marked: false });
    runs.push({ text: points.slice(from, mark.to).join(""), marked: true });
    at = mark.to;
  }
  if (at < points.length) runs.push({ text: points.slice(at).join(""), marked: false });
  return runs;
}
