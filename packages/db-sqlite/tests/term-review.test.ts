import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProject, formPositions, openProject, openSqlite, sqlitePath, type ProjectRepo, type TermContent } from "../src/index.ts";
import { DOCUMENT_TERMS_SQL, TERM_REVIEW_SQL } from "../src/embedded-sql.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "munhae-terms-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = createProject({ parentDir: dir, title: "용어 검토" }).handle; cleanup.push(() => repo.close());
  const one = repo.createDocument({ title: "관서악부서", parentId: null, nodeRole: "source_unit", sourceText: "王建宮詞𠮷王建", originKind: "paste" });
  const two = repo.createDocument({ title: "다른 문서", parentId: null, nodeRole: "source_unit", sourceText: "王建詩", originKind: "paste" });
  return { repo, one: one.id, two: two.id };
}
function punctuate(repo: ProjectRepo, id: string, text: string) {
  let editor = repo.getEditor(id);
  if (editor.source.state !== "confirmed") editor = repo.confirmSource({ documentNodeId: id, expectedLockVersion: editor.source.lockVersion });
  editor = editor.punctuation
    ? repo.savePunctuationDraft({ documentNodeId: id, punctuatedText: text, structureMode: "prose", expectedLockVersion: editor.punctuation.lockVersion })
    : repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: id, structureMode: "prose", expectedSourceLockVersion: editor.source.lockVersion });
  if (editor.punctuation!.punctuatedText !== text) editor = repo.savePunctuationDraft({ documentNodeId: id, punctuatedText: text, structureMode: "prose", expectedLockVersion: editor.punctuation!.lockVersion });
  repo.confirmPunctuation({ documentNodeId: id, expectedLockVersion: editor.punctuation!.lockVersion });
  return repo.getDocumentTerms(id).basis!;
}
const wangJian: TermContent = { sourceForm: "王建", kind: "person", reading: "왕건", translation: "왕건", definition: "당나라 시인, 궁사를 지음", evidence: [] };
const notes = { contextNote: "궁사를 지은 시인", confidence: "certain" as const, alternatives: [] };

/** Rebuilds terms, document_terms and term_candidates in their v13 shape, keeping rows. Foreign keys must be off. */
function restoreV13TermTables(db: ReturnType<typeof openSqlite>, written = { selectionReason: "NULL", uncertainty: "NULL" }) {
  const v13 = (from: string, to: string) => DOCUMENT_TERMS_SQL.slice(DOCUMENT_TERMS_SQL.indexOf(from), DOCUMENT_TERMS_SQL.indexOf(to));
  const candidateColumns = "id, project_id, document_node_id, punctuation_version_id, run_id, agent_id, model, suggested_term_id, source_form, kind, reading, translation, definition, evidence_json, context_note";
  db.exec(`CREATE TABLE terms_v17 AS SELECT * FROM terms; DROP TABLE terms;
    ${v13("CREATE TABLE terms (", "-- One confirmed use")}
    INSERT INTO terms SELECT * FROM terms_v17; DROP TABLE terms_v17;
    CREATE TABLE links_v17 AS SELECT * FROM document_terms; DROP TABLE document_terms;
    ${v13("CREATE TABLE document_terms (", "-- Exact positions")}
    INSERT INTO document_terms (id, project_id, document_node_id, term_id, punctuation_version_id, context_note, selection_reason, uncertainty, origin, generation_json, lock_version, created_at, updated_at)
      SELECT id, project_id, document_node_id, term_id, punctuation_version_id, context_note, ${written.selectionReason}, NULL, origin, generation_json, lock_version, created_at, updated_at FROM links_v17;
    DROP TABLE links_v17;
    CREATE TABLE candidates_v17 AS SELECT * FROM term_candidates; DROP TABLE term_candidates;
    ${v13("CREATE TABLE term_candidates (", "UPDATE meta_project_state")}
    INSERT INTO term_candidates (${candidateColumns}, selection_reason, uncertainty, positions_json, dismissed, created_at)
      SELECT ${candidateColumns}, ${written.selectionReason}, ${written.uncertainty}, positions_json, dismissed, created_at FROM candidates_v17;
    DROP TABLE candidates_v17;`);
}

it("requires a confirmed punctuation basis before any term work", () => {
  const { repo, one } = setup();
  expect(repo.getDocumentTerms(one)).toEqual({ basis: null, terms: [], candidates: [], previousCount: 0 });
  expect(() => repo.getTermGenerationInput(one)).toThrow(/확정된 표점본/);
  const editor = repo.getEditor(one);
  repo.confirmSource({ documentNodeId: one, expectedLockVersion: editor.source.lockVersion });
  const draft = repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: one, structureMode: "prose", expectedSourceLockVersion: repo.getEditor(one).source.lockVersion });
  repo.savePunctuationDraft({ documentNodeId: one, punctuatedText: "王建，宮詞。𠮷王建。", structureMode: "prose", expectedLockVersion: draft.punctuation!.lockVersion });
  // A punctuation draft is not a basis: terms follow the confirmed punctuated text only.
  expect(repo.getDocumentTerms(one).basis).toBeNull();
});

it("stores exact code point positions in sentences and applies a term only to the confirming document", () => {
  const { repo, one, two } = setup();
  const basis = punctuate(repo, one, "王建，宮詞。𠮷王建。");
  punctuate(repo, two, "王建詩。");
  expect(basis.sentences).toEqual([{ from: 0, to: 6 }, { from: 6, to: 10 }]);
  expect(formPositions(basis, "𠮷", [2])).toEqual([{ from: 6, to: 7 }]);
  expect(formPositions(basis, "王建", [1, 2, 9])).toEqual([{ from: 0, to: 2 }, { from: 7, to: 9 }]);
  expect(() => repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, term: wangJian, ...notes, occurrences: [{ from: 1, to: 3 }] })).toThrow(/표점본과 일치/);
  const link = repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, term: wangJian, ...notes, occurrences: [{ from: 7, to: 9 }, { from: 0, to: 2 }] });
  expect(link).toMatchObject({ origin: "manual", occurrences: [{ from: 0, to: 2 }, { from: 7, to: 9 }], term: { sourceForm: "王建" } });
  expect(repo.getTermSentences(link.term.id)).toEqual({ [one]: { total: 2, sentences: [
    { text: "王建，宮詞。", marks: [{ from: 0, to: 2 }] },
    { text: "𠮷王建。", marks: [{ from: 1, to: 3 }] },
  ] } });
  expect(() => repo.getTermSentences("missing")).toThrow(/찾을 수/);
  expect(repo.previewContext({ documentNodeId: one }).requestText).toContain("궁사를 지은 시인");
  expect(repo.previewContext({ documentNodeId: two }).requestText).not.toContain("궁사를 지은 시인");
  repo.close(); const reopened = openProject(repo.packagePath); cleanup.push(() => reopened.close());
  expect(reopened.getDocumentTerms(one).terms).toEqual([link]);
});

it("gives each position to one term so homonyms in one document stay separate", () => {
  const { repo, one } = setup();
  const basis = punctuate(repo, one, "王建，宮詞。𠮷王建。");
  const first = repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, term: wangJian, ...notes, occurrences: [{ from: 0, to: 2 }] });
  const other = { ...wangJian, definition: "고려 태조" };
  expect(() => repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, term: other, ...notes, occurrences: [{ from: 0, to: 2 }] })).toThrow(/이미 다른/);
  expect(repo.getProjectTerms()).toHaveLength(1);
  const second = repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, term: other, ...notes, occurrences: [{ from: 7, to: 9 }] });
  expect(repo.getDocumentTerms(one).terms.map(t => [t.term.definition, t.occurrences])).toEqual([["당나라 시인, 궁사를 지음", [{ from: 0, to: 2 }]], ["고려 태조", [{ from: 7, to: 9 }]]]);
  expect(() => repo.updateDocumentTerm({ id: second.id, expectedLockVersion: second.lockVersion, ...notes, occurrences: [{ from: 0, to: 2 }] })).toThrow(/이미 다른/);
  const moved = repo.updateDocumentTerm({ id: first.id, expectedLockVersion: first.lockVersion, ...notes, contextNote: "앞의 왕건", occurrences: [{ from: 0, to: 2 }] });
  expect(moved.contextNote).toBe("앞의 왕건");
  expect(() => repo.updateDocumentTerm({ id: first.id, expectedLockVersion: first.lockVersion, ...notes })).toThrow(/변경/);
});

it("keeps candidates out of translation, confirms or dismisses them, and replaces only undecided ones", () => {
  const { repo, one } = setup();
  const basis = punctuate(repo, one, "王建，宮詞。𠮷王建。");
  const generation = { runId: "run-1", agentId: "codex", model: "test" };
  const [candidate, other] = repo.storeTermCandidates(one, basis.punctuationVersionId, [
    { ...wangJian, ...notes, suggestedTermId: null, occurrences: [{ from: 0, to: 2 }] },
    { ...wangJian, sourceForm: "宮詞", kind: "work", definition: "궁중 생활을 읊은 시", ...notes, suggestedTermId: null, occurrences: [{ from: 3, to: 5 }] },
  ], generation);
  expect(repo.previewContext({ documentNodeId: one }).requestText).not.toContain("궁사를 지은 시인");
  const link = repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, candidateId: candidate!.id, term: wangJian, ...notes, occurrences: candidate!.occurrences });
  expect(link).toMatchObject({ origin: "ai", generation });
  expect(repo.previewContext({ documentNodeId: one }).requestText).toContain("궁사를 지은 시인");
  repo.dismissTermCandidate({ id: other!.id });
  expect(repo.getDocumentTerms(one).candidates).toEqual([]);
  expect(repo.getTermGenerationInput(one).dismissed.map(c => c.sourceForm)).toEqual(["宮詞"]);
  repo.storeTermCandidates(one, basis.punctuationVersionId, [{ ...wangJian, sourceForm: "𠮷", kind: "object", ...notes, suggestedTermId: null, occurrences: [{ from: 6, to: 7 }] }], generation);
  repo.storeTermCandidates(one, basis.punctuationVersionId, [{ ...wangJian, sourceForm: "宮詞", kind: "work", ...notes, suggestedTermId: null, occurrences: [{ from: 3, to: 5 }] }], generation);
  expect(repo.getDocumentTerms(one).candidates.map(c => c.sourceForm)).toEqual(["宮詞"]);
  expect(repo.getTermGenerationInput(one).dismissed).toHaveLength(1);
  expect(() => repo.storeTermCandidates(one, basis.punctuationVersionId, [{ ...wangJian, ...notes, suggestedTermId: null, occurrences: [{ from: 3, to: 5 }] }], generation)).toThrow(/표점본과 일치/);
  expect(repo.getDocumentTerms(one).candidates.map(c => c.sourceForm)).toEqual(["宮詞"]);
});

it("drops previous-version links from translation on re-confirmation and removes them after the new review", () => {
  const { repo, one } = setup();
  const first = punctuate(repo, one, "王建，宮詞。𠮷王建。");
  const link = repo.confirmTerm({ documentId: one, punctuationVersionId: first.punctuationVersionId, term: wangJian, ...notes, occurrences: [{ from: 0, to: 2 }] });
  const generation = { runId: "run-1", agentId: "codex", model: "test" };
  repo.storeTermCandidates(one, first.punctuationVersionId, [{ ...wangJian, sourceForm: "宮詞", kind: "work", ...notes, suggestedTermId: null, occurrences: [{ from: 3, to: 5 }] }], generation);
  const second = punctuate(repo, one, "王建宮詞。𠮷王建。");
  expect(second.punctuationVersionId).not.toBe(first.punctuationVersionId);
  expect(repo.getDocumentTerms(one)).toMatchObject({ terms: [], candidates: [], previousCount: 1 });
  expect(repo.getProjectTerms()[0]!.documents).toEqual([{ id: one, title: "관서악부서", occurrences: 1, contextNote: "궁사를 지은 시인", versionNo: first.versionNo, current: false }]);
  expect(repo.getTermSentences(link.term.id)).toEqual({ [one]: { total: 1, sentences: [{ text: "王建，宮詞。", marks: [{ from: 0, to: 2 }] }] } });
  expect(repo.previewContext({ documentNodeId: one }).requestText).not.toContain("궁사를 지은 시인");
  expect(() => repo.storeTermCandidates(one, first.punctuationVersionId, [], generation)).toThrow(/다시 확정/);
  const input = repo.getTermGenerationInput(one);
  expect(input.previous.map(p => p.term.id)).toEqual([link.term.id]);
  const [candidate] = repo.storeTermCandidates(one, second.punctuationVersionId, [{ ...wangJian, ...notes, suggestedTermId: link.term.id, occurrences: [{ from: 0, to: 2 }] }], generation);
  expect(candidate!.suggestedTermId).toBe(link.term.id);
  repo.confirmTerm({ documentId: one, punctuationVersionId: second.punctuationVersionId, candidateId: candidate!.id, termId: link.term.id, ...notes, occurrences: candidate!.occurrences });
  expect(repo.getDocumentTerms(one)).toMatchObject({ previousCount: 0, terms: [{ term: { id: link.term.id } }] });
  expect(repo.getProjectTerms()[0]!.documents).toMatchObject([{ versionNo: second.versionNo, current: true }]);
  expect(repo.previewContext({ documentNodeId: one }).requestText).toContain("궁사를 지은 시인");
});

it("shares one term across documents, applies edits everywhere and removes it with its last link", () => {
  const { repo, one, two } = setup();
  const basisOne = punctuate(repo, one, "王建，宮詞。𠮷王建。");
  const basisTwo = punctuate(repo, two, "王建詩。");
  const a = repo.confirmTerm({ documentId: one, punctuationVersionId: basisOne.punctuationVersionId, term: wangJian, ...notes, occurrences: [{ from: 0, to: 2 }] });
  expect(repo.getTermGenerationInput(two).references.map(r => [r.id, r.documents])).toEqual([[a.term.id, ["관서악부서"]]]);
  const b = repo.confirmTerm({ documentId: two, punctuationVersionId: basisTwo.punctuationVersionId, termId: a.term.id, ...notes, occurrences: [{ from: 0, to: 2 }] });
  expect(b.term.id).toBe(a.term.id);
  const { sourceForm: _form, ...content } = wangJian;
  const updated = repo.updateTerm({ id: a.term.id, expectedLockVersion: a.term.lockVersion, ...content, definition: "고친 풀이" });
  expect(() => repo.updateTerm({ id: a.term.id, expectedLockVersion: a.term.lockVersion, ...content })).toThrow(/변경/);
  expect(repo.previewContext({ documentNodeId: one }).requestText).toContain("고친 풀이");
  expect(repo.previewContext({ documentNodeId: two }).requestText).toContain("고친 풀이");
  expect(repo.getProjectTerms()).toMatchObject([{ id: updated.id, documents: [
    { id: one, title: "관서악부서", occurrences: 1, contextNote: "궁사를 지은 시인", versionNo: basisOne.versionNo, current: true },
    { id: two, title: "다른 문서", occurrences: 1, current: true },
  ] }]);
  repo.deleteDocumentTerm({ id: a.id, expectedLockVersion: a.lockVersion });
  expect(repo.getProjectTerms()).toHaveLength(1);
  repo.deleteDocumentTerm({ id: b.id, expectedLockVersion: b.lockVersion });
  expect(repo.getProjectTerms()).toEqual([]);
  expect(() => repo.deleteDocumentTerm({ id: b.id, expectedLockVersion: b.lockVersion })).toThrow(/찾을 수/);
});

it("deletes selected terms from every document at once, or none when one of them changed", () => {
  const { repo, one, two } = setup();
  const basisOne = punctuate(repo, one, "王建，宮詞。𠮷王建。");
  const basisTwo = punctuate(repo, two, "王建詩。");
  const a = repo.confirmTerm({ documentId: one, punctuationVersionId: basisOne.punctuationVersionId, term: wangJian, ...notes, occurrences: [{ from: 0, to: 2 }] });
  repo.confirmTerm({ documentId: two, punctuationVersionId: basisTwo.punctuationVersionId, termId: a.term.id, ...notes, occurrences: [{ from: 0, to: 2 }] });
  const work = repo.confirmTerm({ documentId: one, punctuationVersionId: basisOne.punctuationVersionId, term: { ...wangJian, sourceForm: "宮詞", kind: "work", reading: "궁사", translation: "궁사", definition: "궁중 생활을 읊은 시" }, ...notes, occurrences: [{ from: 3, to: 5 }] });
  const [candidate] = repo.storeTermCandidates(two, basisTwo.punctuationVersionId, [{ ...wangJian, ...notes, suggestedTermId: a.term.id, occurrences: [{ from: 0, to: 2 }] }], { runId: "run-1", agentId: "codex", model: "test" });
  expect(candidate!.suggestedTermId).toBe(a.term.id);
  const both = [{ id: a.term.id, expectedLockVersion: a.term.lockVersion }, { id: work.term.id, expectedLockVersion: work.term.lockVersion }];
  expect(() => repo.deleteTerms({ terms: [both[0]!, { ...both[1]!, expectedLockVersion: work.term.lockVersion + 1 }] })).toThrow(/변경/);
  expect(repo.getProjectTerms()).toHaveLength(2);
  expect(repo.getDocumentTerms(two).terms).toHaveLength(1);
  repo.deleteTerms({ terms: both });
  expect(repo.getProjectTerms()).toEqual([]);
  expect(repo.getDocumentTerms(one).terms).toEqual([]);
  expect(repo.getDocumentTerms(two)).toMatchObject({ terms: [], candidates: [{ id: candidate!.id, suggestedTermId: null }] });
  expect(() => repo.deleteTerms({ terms: both })).toThrow(/찾을 수/);
  expect(() => repo.deleteTerms({ terms: [] })).toThrow(/확인/);
});

it("discards legacy glossary and term-review rows when upgrading a v12 project", () => {
  const { repo } = setup(); const path = repo.packagePath; repo.close();
  const db = openSqlite(sqlitePath(path));
  db.exec(`DROP TABLE translation_notes; DROP TABLE term_candidates; DROP TABLE term_occurrences; DROP TABLE document_terms; DROP TABLE terms;
    CREATE TABLE glossary_entries (id TEXT PRIMARY KEY, source_term TEXT NOT NULL) STRICT;
    INSERT INTO glossary_entries VALUES ('g1', '王建');
    ${TERM_REVIEW_SQL}
    DELETE FROM meta_schema_migrations WHERE version >= 13; UPDATE meta_project_state SET schema_version = 12;`);
  db.close();
  const reopened = openProject(path); cleanup.push(() => reopened.close());
  expect(reopened.getProjectTerms()).toEqual([]);
  const check = openSqlite(sqlitePath(path));
  try {
    expect(check.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('glossary_entries', 'term_entries', 'term_revisions')").all()).toEqual([]);
  } finally { check.close(); }
});

it("previews the first sentences of the first documents and gives one document all of its sentences on request", () => {
  const { repo, two } = setup();
  const one = repo.createDocument({ title: "넷째 문장까지", parentId: null, nodeRole: "source_unit", sourceText: "王建甲王建乙王建王建丙王建丁", originKind: "paste" }).id;
  const basis = punctuate(repo, one, "王建甲。王建乙王建。王建丙。王建丁。");
  const link = repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, term: wangJian, ...notes,
    occurrences: formPositions(basis, "王建", [1, 2, 3, 4]) });
  expect(link.occurrences).toHaveLength(5);
  const basisTwo = punctuate(repo, two, "王建詩。");
  repo.confirmTerm({ documentId: two, punctuationVersionId: basisTwo.punctuationVersionId, termId: link.term.id, ...notes, occurrences: [{ from: 0, to: 2 }] });
  const preview = repo.getTermSentences(link.term.id);
  expect(Object.keys(preview).sort()).toEqual([one, two].sort());
  expect(preview[one]).toEqual({ total: 4, sentences: [
    { text: "王建甲。", marks: [{ from: 0, to: 2 }] },
    { text: "王建乙王建。", marks: [{ from: 0, to: 2 }, { from: 3, to: 5 }] },
    { text: "王建丙。", marks: [{ from: 0, to: 2 }] },
  ] });
  const all = repo.getTermSentences(link.term.id, one);
  expect(Object.keys(all)).toEqual([one]);
  expect(all[one]!.sentences.map(s => s.text)).toEqual(["王建甲。", "王建乙王建。", "王建丙。", "王建丁。"]);
});

it("fills the sentence of positions confirmed before v14", () => {
  const { repo, one } = setup();
  const basis = punctuate(repo, one, "王建，宮詞。𠮷王建。");
  const link = repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, term: wangJian, ...notes, occurrences: [{ from: 0, to: 2 }, { from: 7, to: 9 }] });
  const expected = repo.getTermSentences(link.term.id);
  const path = repo.packagePath; repo.close();
  const db = openSqlite(sqlitePath(path));
  // Rebuild term_occurrences exactly as v13 created it, keeping its rows.
  const v13 = DOCUMENT_TERMS_SQL.slice(DOCUMENT_TERMS_SQL.indexOf("CREATE TABLE term_occurrences ("), DOCUMENT_TERMS_SQL.indexOf("-- AI suggestions"));
  db.pragma("foreign_keys = OFF");
  restoreV13TermTables(db);
  db.exec(`DROP TABLE translation_notes; DELETE FROM meta_schema_migrations WHERE version >= 15;
    DROP TRIGGER trg_term_occurrences_sentence; DROP TRIGGER trg_term_occurrences_version; DROP INDEX idx_term_occurrences_link;
    ALTER TABLE term_occurrences RENAME TO term_occurrences_v14;
    ${v13}
    INSERT INTO term_occurrences SELECT id, project_id, document_term_id, punctuation_version_id, codepoint_from, codepoint_to FROM term_occurrences_v14;
    DROP TABLE term_occurrences_v14;
    DELETE FROM meta_schema_migrations WHERE version = 14; UPDATE meta_project_state SET schema_version = 13;`);
  db.close();
  const reopened = openProject(path); cleanup.push(() => reopened.close());
  expect(reopened.getTermSentences(link.term.id)).toEqual(expected);
  const check = openSqlite(sqlitePath(path));
  try {
    expect(check.prepare("SELECT COUNT(*) AS n FROM term_occurrences WHERE sentence_span_id IS NULL").get()).toEqual({ n: 0 });
    expect(() => check.prepare("UPDATE term_occurrences SET sentence_span_id = NULL").run()).not.toThrow();
    const row = check.prepare("SELECT * FROM term_occurrences LIMIT 1").get() as Record<string, unknown>;
    const other = check.prepare("SELECT id FROM punctuation_structure_spans WHERE punctuation_version_id = ? AND span_kind = 'paragraph' LIMIT 1").get(row.punctuation_version_id) as { id: string };
    check.prepare("DELETE FROM term_occurrences WHERE id = ?").run(row.id);
    expect(() => check.prepare("INSERT INTO term_occurrences(id, project_id, document_term_id, punctuation_version_id, codepoint_from, codepoint_to, sentence_span_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.project_id, row.document_term_id, row.punctuation_version_id, row.codepoint_from, row.codepoint_to, other.id)).toThrow(/sentence mismatch/);
  } finally { check.close(); }
});

it("upgrades v15 term rows through new kinds and judgment confidence, keeping every link", () => {
  const { repo, one } = setup();
  const basis = punctuate(repo, one, "王建，宮詞。𠮷王建。");
  const link = repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, term: wangJian, ...notes, occurrences: [{ from: 0, to: 2 }] });
  const [candidate] = repo.storeTermCandidates(one, basis.punctuationVersionId, [{ ...wangJian, ...notes, suggestedTermId: link.term.id, occurrences: [{ from: 7, to: 9 }] }], { runId: "run", agentId: "codex", model: "m" });
  const path = repo.packagePath; repo.close();
  const db = openSqlite(sqlitePath(path));
  // Put the three tables back in their v13 shape, with kinds and notes that only v15 had.
  db.pragma("foreign_keys = OFF");
  restoreV13TermTables(db, { selectionReason: "'동명이인 구별'", uncertainty: "'출전 확인'" });
  db.exec(`UPDATE terms SET kind = 'office'; UPDATE term_candidates SET kind = 'expression';
    DELETE FROM meta_schema_migrations WHERE version >= 16; UPDATE meta_project_state SET schema_version = 15;`);
  db.close();
  const reopened = openProject(path); cleanup.push(() => reopened.close());
  const view = reopened.getDocumentTerms(one);
  expect(view.terms.map(t => [t.term.id, t.term.kind, t.contextNote, t.confidence, t.alternatives, t.occurrences]))
    .toEqual([[link.term.id, "concept", notes.contextNote, "certain", [], [{ from: 0, to: 2 }]]]);
  expect(view.candidates.map(c => [c.id, c.kind, c.confidence, c.suggestedTermId])).toEqual([[candidate!.id, "grammar", "probable", link.term.id]]);
  const check = openSqlite(sqlitePath(path));
  try {
    expect(check.pragma("foreign_key_check")).toEqual([]);
    expect(() => check.prepare("UPDATE terms SET kind = 'office'").run()).toThrow(/CHECK/);
    expect(() => check.prepare("UPDATE document_terms SET confidence = 'maybe'").run()).toThrow(/CHECK/);
    const columns = (check.pragma("table_info(document_terms)") as Array<{ name: string }>).map(c => c.name);
    expect(columns).not.toContain("selection_reason"); expect(columns).not.toContain("uncertainty");
  } finally { check.close(); }
});

it("keeps a judgment's confidence and at most three alternatives", () => {
  const { repo, one } = setup();
  const basis = punctuate(repo, one, "王建，宮詞。𠮷王建。");
  const link = repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, term: wangJian, contextNote: "궁사를 지은 시인",
    confidence: "probable", alternatives: [" 고려 태조 ", ""], occurrences: [{ from: 0, to: 2 }] });
  expect([link.confidence, link.alternatives]).toEqual(["probable", ["고려 태조"]]);
  const updated = repo.updateDocumentTerm({ id: link.id, expectedLockVersion: link.lockVersion, contextNote: link.contextNote, confidence: "unknown", alternatives: ["가", "나", "다"] });
  expect([updated.confidence, updated.alternatives]).toEqual(["unknown", ["가", "나", "다"]]);
  expect(() => repo.updateDocumentTerm({ id: link.id, expectedLockVersion: updated.lockVersion, contextNote: null, confidence: "unknown", alternatives: ["가", "나", "다", "라"] })).toThrow(/3개/);
  expect(() => repo.updateDocumentTerm({ id: link.id, expectedLockVersion: updated.lockVersion, contextNote: null, confidence: "maybe" as never, alternatives: [] })).toThrow(/확신/);
});

it("undoes an outside edit by restoring the document's term rows, only while they are unchanged", () => {
  const { repo, one } = setup();
  const basis = punctuate(repo, one, "王建，宮詞。𠮷王建。");
  const generation = { runId: "run", agentId: "codex", model: "m" };
  repo.storeTermCandidates(one, basis.punctuationVersionId, [{ ...wangJian, ...notes, suggestedTermId: null, occurrences: [{ from: 0, to: 2 }, { from: 7, to: 9 }] }], generation);
  const second = repo.storeTermCandidates(one, basis.punctuationVersionId, [{ ...wangJian, sourceForm: "宮詞", kind: "work", ...notes, suggestedTermId: null, occurrences: [{ from: 3, to: 5 }] }], generation, true);
  expect(second.map(candidate => candidate.sourceForm).sort()).toEqual(["宮詞", "王建"]);
  const candidates = repo.getDocumentTerms(one).candidates;

  const before = repo.snapshotTermRows(one);
  // Confirming every candidate deletes the candidates and creates terms, links and positions.
  for (const candidate of candidates) {
    repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, candidateId: candidate.id, term: candidate, ...notes, occurrences: candidate.occurrences });
  }
  const after = repo.snapshotTermRows(one, before);
  expect(repo.getProjectTerms()).toHaveLength(2);

  repo.restoreTermRows(before, after);
  expect(repo.getDocumentTerms(one).terms).toEqual([]);
  expect(repo.getDocumentTerms(one).candidates.map(candidate => candidate.id).sort()).toEqual(candidates.map(candidate => candidate.id).sort());
  expect(repo.getProjectTerms()).toHaveLength(0);
  // Undoing twice finds the rows no longer in the edited state.
  expect(() => repo.restoreTermRows(before, after)).toThrow(/이후에 바뀐/);
});

it("refuses to undo an outside edit once the terms changed again", () => {
  const { repo, one } = setup();
  const basis = punctuate(repo, one, "王建，宮詞。𠮷王建。");
  const before = repo.snapshotTermRows(one);
  const link = repo.confirmTerm({ documentId: one, punctuationVersionId: basis.punctuationVersionId, term: wangJian, ...notes, occurrences: [{ from: 0, to: 2 }] });
  const after = repo.snapshotTermRows(one, before);
  const edited = repo.updateTerm({ id: link.term.id, expectedLockVersion: link.term.lockVersion, kind: "person", reading: "왕건", translation: "왕건(王建)", definition: null, evidence: [] });
  expect(() => repo.restoreTermRows(before, after)).toThrow(/이후에 바뀐/);
  expect(repo.getProjectTerms()[0]).toMatchObject({ id: link.term.id, translation: edited.translation });
});
