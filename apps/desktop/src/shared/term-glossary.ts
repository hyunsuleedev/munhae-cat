import type { GlossaryEntryView, TermEntry } from "./munhae-api";

export type TermGlossarySelection = { enabled: boolean; excludedIds: string[] };
export type TermGlossaryCandidate = {
  id: string; sourceForm: string; reading: string | null; translation: string | null;
  definition: string | null; contextNote: string | null; uncertainty: string | null;
  evidence: { citation: string; url: string | null }[]; status: string;
};

// Literal matching preserves original glyphs. A spelling match is not a sense match.
export function relatedTermGlossary(source: string, legacy: GlossaryEntryView[], terms: TermEntry[]): TermGlossaryCandidate[] {
  return [
    ...legacy.filter(item => item.sourceTerm.trim() && source.includes(item.sourceTerm)).map(item => ({
      id: `glossary:${item.id}`, sourceForm: item.sourceTerm, reading: item.reading,
      translation: item.targetTerm, definition: null, contextNote: item.noteMd,
      uncertainty: null, evidence: [], status: item.usageStatus,
    })),
    ...terms.filter(item => item.documentId === null && item.status !== "excluded" && item.sourceForm.trim() && source.includes(item.sourceForm)).map(item => ({
      id: `term:${item.id}`, sourceForm: item.sourceForm, reading: item.reading,
      translation: item.translation, definition: item.definition, contextNote: item.contextNote,
      uncertainty: item.uncertainty, evidence: item.evidence, status: item.status,
    })),
  ];
}
