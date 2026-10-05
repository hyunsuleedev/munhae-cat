import type { ConfirmTermInput, DocumentTerm, DocumentTermsView, TermBasis, TermCandidate, TermConfidence, TermEvidence, TermKind, TermRange } from "../../shared/munhae-api";
import { tAs, ui } from "./i18n";

/** Display labels; the keys are stored values. Translate a label where it is shown: t(TERM_KIND_LABELS[kind]), tAs("confidence", ...). */
export const TERM_KIND_LABELS: Record<TermKind, string> = { person: "인물", place: "장소", period: "시기", event: "사건", object: "사물", work: "작품·문헌", concept: "개념", allusion: "전고", grammar: "문법", idu: "이두" };
export const TERM_CONFIDENCE_LABELS: Record<TermConfidence, string> = { certain: "확정", probable: "유력", unknown: "미상" };

/** What a person should check, in one line. A certain judgment with no alternatives needs no mark. */
export function judgmentNote(judgment: { confidence: TermConfidence; alternatives: string[] }): string {
  const doubt = judgment.confidence === "certain" ? "" : tAs("confidence", TERM_CONFIDENCE_LABELS[judgment.confidence]);
  const others = judgment.alternatives.length ? ui`다른 해석: ${judgment.alternatives.join(" / ")}` : "";
  return [doubt, others].filter(Boolean).join(" · ");
}

/** Alternatives as editable text: one reading per line. */
export function parseAlternatives(text: string): string[] {
  return text.split("\n").map(line => line.trim()).filter(Boolean);
}

/** Evidence as editable text: one citation per line, with its address at the end. */
export const evidenceText = (evidence: TermEvidence[]) => evidence.map(e => e.citation + (e.url ? " " + e.url : "")).join("\n");
export function parseEvidence(text: string): TermEvidence[] {
  return text.split("\n").filter(Boolean).map(line => {
    const url = line.match(/https?:\/\/\S+$/)?.[0] ?? null;
    return { citation: url ? line.slice(0, -url.length).trim() : line, url };
  });
}

/** One row of the document term list: a confirmed use or an undecided AI candidate. */
export type TermItem = { id: string; kind: "term"; link: DocumentTerm } | { id: string; kind: "candidate"; candidate: TermCandidate };

export const itemForm = (item: TermItem) => item.kind === "term" ? item.link.term.sourceForm : item.candidate.sourceForm;
export const itemRanges = (item: TermItem): TermRange[] => item.kind === "term" ? item.link.occurrences : item.candidate.occurrences;
export const itemDefinition = (item: TermItem) => item.kind === "term" ? item.link.term.definition : item.candidate.definition;

export function termItems(view: DocumentTermsView): TermItem[] {
  return [
    ...view.terms.map(link => ({ id: `term:${link.id}`, kind: "term" as const, link })),
    ...view.candidates.map(candidate => ({ id: `candidate:${candidate.id}`, kind: "candidate" as const, candidate })),
  ].sort((a, b) => (itemRanges(a)[0]?.from ?? 0) - (itemRanges(b)[0]?.from ?? 0));
}

export function termReviewProgress(view: DocumentTermsView) {
  return { confirmed: view.terms.length, candidates: view.candidates.length };
}

/** The next undecided candidate after the selected row, wrapping around. */
export function nextCandidate(items: TermItem[], selectedId: string | null): TermItem | null {
  const index = items.findIndex(item => item.id === selectedId);
  return [...items.slice(index + 1), ...items.slice(0, Math.max(0, index))].find(item => item.kind === "candidate" && item.id !== selectedId) ?? null;
}

/** UTF-16 offset of every code point boundary, for rendering code point ranges. */
export function utf16Offsets(text: string): number[] {
  const offsets = [0];
  for (const glyph of text) offsets.push(offsets[offsets.length - 1]! + glyph.length);
  return offsets;
}

/** Every occurrence of a written form in the basis, as code point ranges. */
export function formRanges(basis: TermBasis, form: string): TermRange[] {
  const points = Array.from(basis.text), glyphs = Array.from(form), ranges: TermRange[] = [];
  if (!glyphs.length) return ranges;
  for (let at = 0; at + glyphs.length <= points.length; at++) {
    if (glyphs.every((glyph, i) => points[at + i] === glyph)) ranges.push({ from: at, to: at + glyphs.length });
  }
  return ranges;
}

/** The punctuated sentence that holds a range, with the range itself for emphasis. */
export function rangeContext(basis: TermBasis, range: TermRange): { before: string; form: string; after: string } {
  const points = Array.from(basis.text);
  const sentence = basis.sentences.find(s => s.from <= range.from && s.to >= range.to) ?? { from: Math.max(0, range.from - 20), to: Math.min(points.length, range.to + 20) };
  return { before: points.slice(sentence.from, range.from).join(""), form: points.slice(range.from, range.to).join(""), after: points.slice(range.to, sentence.to).join("") };
}

/** A quick confirmation keeps every AI-found position and follows the AI's link suggestion. */
export function candidateConfirmation(basis: TermBasis, candidate: TermCandidate): ConfirmTermInput {
  const { sourceForm, kind, reading, translation, definition, evidence, contextNote, confidence, alternatives } = candidate;
  return { documentId: basis.documentId, punctuationVersionId: basis.punctuationVersionId, candidateId: candidate.id,
    termId: candidate.suggestedTermId, term: { sourceForm, kind, reading, translation, definition, evidence },
    contextNote, confidence, alternatives, occurrences: candidate.occurrences };
}
