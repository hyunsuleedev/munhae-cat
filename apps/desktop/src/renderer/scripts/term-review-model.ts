import { termSource } from "@munhae/domain/term-source";
import type { EditorView, SaveTermInput, TermEntry } from "../../shared/munhae-api";
import type { TermHit } from "./term-highlights";

export const termIsStale = (entry: TermEntry, view: EditorView) =>
  !!entry.documentId && entry.sourceVersion !== termSource(view).version;

export function termReviewProgress(entries: TermEntry[], view: EditorView) {
  const included = entries.filter(entry => entry.status !== "excluded");
  const reviewed = included.filter(entry => entry.status === "reviewed" && !termIsStale(entry, view)).length;
  return { total: included.length, reviewed, remaining: included.length - reviewed };
}

export function sourceOrderedTerms(entries: TermEntry[], hits: TermHit[]) {
  const position = (id: string) => Math.min(...hits.filter(hit => hit.id === id).map(hit => hit.start));
  return [...entries].sort((a, b) => position(a.id) - position(b.id));
}

export function nextReviewTerm(entries: TermEntry[], hits: TermHit[], selectedId: string, view: EditorView) {
  const ordered = sourceOrderedTerms(entries, hits);
  const index = ordered.findIndex(entry => entry.id === selectedId);
  return [...ordered.slice(index + 1), ...ordered.slice(0, Math.max(0, index))].find(entry =>
    entry.id !== selectedId && entry.documentId === view.document.id && entry.status !== "excluded" &&
    (entry.status !== "reviewed" || termIsStale(entry, view)));
}

/** Quotes retain exact glyphs. Candidate locations never imply approval of a sense. */
export function currentTermQuotes(text: string, entry: TermEntry, hits: TermHit[]) {
  const previous = [...new Set(entry.occurrences.map(item => item.quote))];
  return [...new Set(hits.filter(hit => hit.id === entry.id).map(hit => {
    const unchanged = previous.find(quote => {
      const start = text.lastIndexOf(quote, hit.start);
      return start >= 0 && start <= hit.start && start + quote.length >= hit.end;
    });
    if (unchanged) return unchanged;
    let start = hit.start, end = hit.end;
    while (start > 0 && !/[。！？\n\r]/u.test(text[start - 1]!)) start--;
    while (end < text.length && !/[。！？\n\r]/u.test(text[end]!)) end++;
    if (end < text.length && /[。！？]/u.test(text[end]!)) end++;
    if (end - start > 10000) {
      start = Math.max(start, hit.start - 80); end = Math.min(end, hit.end + 80);
      if (/[\uDC00-\uDFFF]/u.test(text[start]!)) start--;
      if (/[\uD800-\uDBFF]/u.test(text[end - 1]!)) end++;
    }
    return text.slice(start, end);
  }))];
}

export function termSaveValue(entry: TermEntry, view: EditorView, changes: {
  draft?: { definition: string; contextNote: string };
  status?: TermEntry["status"];
  relinkQuotes?: string[];
} = {}): SaveTermInput {
  if (entry.documentId !== view.document.id) throw new Error("현재 문서의 용어만 수정할 수 있습니다.");
  const source = termSource(view);
  if (termIsStale(entry, view) && !changes.relinkQuotes) throw new Error("현재 원문의 구절을 대조한 뒤 다시 연결하세요.");
  if (changes.relinkQuotes && (!changes.relinkQuotes.length || changes.relinkQuotes.length > 100 ||
    changes.relinkQuotes.some(quote => !quote || quote.length > 10000 || !quote.includes(entry.sourceForm) || !source.text.includes(quote)))) {
    throw new Error("현재 원문에서 연결할 구절을 선택하세요.");
  }
  const definition = changes.draft ? changes.draft.definition.trim() || null : entry.definition;
  const contextNote = changes.draft ? changes.draft.contextNote.trim() || null : entry.contextNote;
  const edited = definition !== entry.definition || contextNote !== entry.contextNote;
  return {
    ...entry,
    expectedLockVersion: entry.lockVersion,
    sourceVersion: changes.relinkQuotes ? source.version : entry.sourceVersion,
    quotes: [...new Set(changes.relinkQuotes ?? entry.occurrences.map(item => item.quote))],
    definition, contextNote,
    status: changes.relinkQuotes ? entry.status === "excluded" ? "excluded" : "draft"
      : changes.status ?? (edited && entry.status === "reviewed" ? "draft" : entry.status),
  };
}
