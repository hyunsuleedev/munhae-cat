import { describe, expect, it } from "vitest";
import { termSource } from "@munhae/domain/term-source";
import type { EditorView, TermEntry } from "../src/shared/munhae-api";
import { termHits } from "../src/renderer/scripts/term-highlights";
import { currentTermQuotes, nextReviewTerm, termReviewProgress, termSaveValue } from "../src/renderer/scripts/term-review-model";

const view = {
  document: { id: "doc" },
  source: { versionId: "source", lockVersion: 1, contentText: "𠮷王建，宮詞。後有王建，建國。" },
  punctuation: null,
} as EditorView;
const version = termSource(view).version;
const entry = (id: string, extra: Partial<TermEntry> = {}) => ({
  id, documentId: "doc", projectId: "project", parentTermId: null, sourceForm: "王建", kind: "person",
  reading: "왕건", translation: null, definition: "시인", contextNote: null, selectionReason: null,
  uncertainty: null, evidence: [], sourceVersion: version, status: "draft", lockVersion: 7,
  occurrences: [{ quote: "𠮷王建，宮詞。", start: 2, end: 4 }], ...extra,
}) as TermEntry;

describe("terminology review saves", () => {
  it("preserves sense-specific quotes and optimistic locks, and makes an edited reviewed definition a draft", () => {
    const term = entry("a", { status: "reviewed" });
    const value = termSaveValue(term, view, { draft: { definition: "당나라 시인", contextNote: "궁사 형식과 연결" } });
    expect(value).toMatchObject({ expectedLockVersion: 7, sourceVersion: version, status: "draft", quotes: ["𠮷王建，宮詞。"] });
    expect(term.status).toBe("reviewed");
    expect(termSaveValue(term, view, { status: "reviewed" }).status).toBe("reviewed");
  });
  it("rejects stale edits and cross-document saves without an explicit current quotation", () => {
    expect(() => termSaveValue(entry("a", { sourceVersion: "old" }), view, { status: "reviewed" })).toThrow(/대조/);
    expect(() => termSaveValue(entry("a", { documentId: "another" }), view)).toThrow(/현재 문서/);
    expect(() => termSaveValue(entry("a", { documentId: null }), view)).toThrow(/현재 문서/);
  });
  it("relinks only selected exact quotations and never treats reconnection as completed review", () => {
    const term = entry("a", { sourceVersion: "old", status: "reviewed" });
    const value = termSaveValue(term, view, { relinkQuotes: ["𠮷王建，宮詞。"], status: "reviewed" });
    expect(value).toMatchObject({ quotes: ["𠮷王建，宮詞。"], status: "draft", sourceVersion: version, expectedLockVersion: 7 });
    expect(value.quotes).not.toContain("後有王建，建國。");
    for (const quotes of [[], ["王健"], ["宮詞"], ["王建。"]]) {
      expect(() => termSaveValue(term, view, { relinkQuotes: quotes })).toThrow(/구절/);
    }
  });
});

describe("source-led review navigation", () => {
  it("retains supplementary glyphs and proposes distinct contexts when punctuation changed", () => {
    const term = entry("a", { sourceVersion: "old", occurrences: [{ quote: "𠮷王建宮詞", start: 2, end: 4 }] });
    const hits = termHits(view.source.contentText, version, [term]);
    expect(currentTermQuotes(view.source.contentText, term, hits)).toEqual(["𠮷王建，宮詞。", "後有王建，建國。"]);
    const current = entry("b");
    expect(currentTermQuotes(view.source.contentText, current, termHits(view.source.contentText, version, [current]))).toEqual(["𠮷王建，宮詞。"]);
  });
  it("does not count old reviewed terms as complete or navigate into excluded and common terms", () => {
    const terms = [entry("done", { status: "reviewed" }), entry("old", { sourceVersion: "old", status: "reviewed" }),
      entry("shared", { documentId: null, sourceVersion: null, status: "reviewed" }), entry("skip", { status: "excluded" })];
    const hits = terms.map((term, i) => ({ id: term.id, start: i * 5, end: i * 5 + 2, index: 0 }));
    expect(termReviewProgress(terms, view)).toEqual({ total: 3, reviewed: 2, remaining: 1 });
    expect(nextReviewTerm(terms, hits, "done", view)?.id).toBe("old");
    expect(nextReviewTerm(terms, hits, "old", view)).toBeUndefined();
    expect(nextReviewTerm(terms.filter(term => term.id !== "old"), hits, "done", view)).toBeUndefined();
  });
});
