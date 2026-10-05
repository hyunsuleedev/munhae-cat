import type { DocumentTerm, ProjectTerm, TermConfidence, TermEvidence, TermKind } from "@munhae/db-sqlite";

export type TermReferenceSelection = { enabled: boolean; excludedIds: string[] };
/** A term confirmed elsewhere. It is a sense candidate for this document, never its answer. */
export type TermReference = {
  id: string; sourceForm: string; kind: TermKind; reading: string | null; translation: string | null;
  definition: string | null; evidence: TermEvidence[];
  origin: "previous" | "project"; documents: string[];
  contextNote: string | null; confidence: TermConfidence | null; alternatives: string[];
};

/** Previous-version links of this document first, then terms confirmed in other documents. */
export function termReferences(input: {
  current: DocumentTerm[]; previous: DocumentTerm[]; references: Array<ProjectTerm & { documents: string[] }>;
}): TermReference[] {
  const seen = new Set(input.current.map(link => link.term.id));
  const result: TermReference[] = [];
  const content = ({ id, sourceForm, kind, reading, translation, definition, evidence }: ProjectTerm) => ({ id, sourceForm, kind, reading, translation, definition, evidence });
  for (const link of input.previous) {
    if (seen.has(link.term.id)) continue;
    seen.add(link.term.id);
    result.push({ ...content(link.term), origin: "previous", documents: [], contextNote: link.contextNote, confidence: link.confidence, alternatives: link.alternatives });
  }
  for (const term of input.references) {
    if (seen.has(term.id)) continue;
    seen.add(term.id);
    result.push({ ...content(term), origin: "project", documents: term.documents, contextNote: null, confidence: null, alternatives: [] });
  }
  return result;
}
