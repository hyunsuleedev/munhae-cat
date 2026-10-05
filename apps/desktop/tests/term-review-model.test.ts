import { expect, it } from "vitest";
import type { DocumentTerm, DocumentTermsView, TermBasis, TermCandidate } from "../src/shared/munhae-api";
import { candidateConfirmation, formRanges, judgmentNote, nextCandidate, parseAlternatives, rangeContext, termItems, termReviewProgress, utf16Offsets } from "../src/renderer/scripts/term-review-model";

const basis: TermBasis = { documentId: "doc", punctuationVersionId: "p1", versionNo: 2, text: "𠮷王建，宮詞。後有王建。", sentences: [{ from: 0, to: 7 }, { from: 7, to: 12 }] };
const term = { id: "t1", sourceForm: "王建", kind: "person", reading: "왕건", translation: "왕건", definition: "당나라 시인", evidence: [], lockVersion: 1, createdAt: "", updatedAt: "" } as const;
const link = { id: "l1", documentId: "doc", punctuationVersionId: "p1", term, contextNote: null, confidence: "certain", alternatives: [], origin: "manual", generation: null, occurrences: [{ from: 9, to: 11 }], lockVersion: 1, createdAt: "", updatedAt: "" } as DocumentTerm;
const candidate = (id: string, from: number, extra: Partial<TermCandidate> = {}) => ({ id, documentId: "doc", punctuationVersionId: "p1", generation: { runId: "r", agentId: "codex", model: "m" },
  suggestedTermId: null, sourceForm: "王建", kind: "person", reading: "왕건", translation: null, definition: "고려 태조", evidence: [], contextNote: "앞의 인물", confidence: "probable", alternatives: ["고려 태조"],
  occurrences: [{ from, to: from + 2 }], createdAt: "", ...extra }) as TermCandidate;
const view: DocumentTermsView = { basis, terms: [link], candidates: [candidate("c2", 5), candidate("c1", 1)], previousCount: 0 };

it("orders confirmed terms and candidates by their first position in the punctuated text", () => {
  expect(termItems(view).map(item => item.id)).toEqual(["candidate:c1", "candidate:c2", "term:l1"]);
  expect(termReviewProgress(view)).toEqual({ confirmed: 1, candidates: 2 });
  const items = termItems(view);
  expect(nextCandidate(items, "candidate:c2")?.id).toBe("candidate:c1");
  expect(nextCandidate(items, "term:l1")?.id).toBe("candidate:c1");
  expect(nextCandidate(items.filter(item => item.id !== "candidate:c2"), "candidate:c1")).toBeNull();
});

it("finds exact code point positions of a form and shows each one in its sentence", () => {
  expect(utf16Offsets("𠮷王")).toEqual([0, 2, 3]);
  expect(formRanges(basis, "王建")).toEqual([{ from: 1, to: 3 }, { from: 9, to: 11 }]);
  expect(formRanges(basis, "𠮷")).toEqual([{ from: 0, to: 1 }]);
  expect(formRanges(basis, "")).toEqual([]);
  expect(rangeContext(basis, { from: 9, to: 11 })).toEqual({ before: "後有", form: "王建", after: "。" });
});

it("confirms a candidate with every AI-found position and its link suggestion", () => {
  expect(candidateConfirmation(basis, candidate("c1", 1, { suggestedTermId: "t1" }))).toMatchObject({
    documentId: "doc", punctuationVersionId: "p1", candidateId: "c1", termId: "t1",
    term: { sourceForm: "王建", definition: "고려 태조" }, contextNote: "앞의 인물", confidence: "probable", alternatives: ["고려 태조"], occurrences: [{ from: 1, to: 3 }],
  });
  expect(candidateConfirmation(basis, candidate("c1", 1)).termId).toBeNull();
});

it("marks only judgments a person should check, and reads alternatives one per line", () => {
  expect(judgmentNote({ confidence: "certain", alternatives: [] })).toBe("");
  expect(judgmentNote({ confidence: "certain", alternatives: ["당 시인"] })).toBe("다른 해석: 당 시인");
  expect(judgmentNote({ confidence: "unknown", alternatives: ["1749년", "1809년"] })).toBe("미상 · 다른 해석: 1749년 / 1809년");
  expect(parseAlternatives(" 1749년 \n\n 1809년 ")).toEqual(["1749년", "1809년"]);
});
