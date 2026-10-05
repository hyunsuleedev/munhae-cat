import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProject, openSqlite, sqlitePath, type ProjectRepo, type TermContent } from "../src/index.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); });
const runOptions = { agentId: "codex" as const, requestedModel: null, reasoningLevel: null, serviceTier: null, runtimeVersion: null };
const notes = { contextNote: null, confidence: "certain" as const, alternatives: [] };
const wangJian: TermContent = { sourceForm: "王建", kind: "person", reading: "왕건", translation: "왕건", definition: null, evidence: [] };
const gongsa: TermContent = { sourceForm: "宮詞", kind: "work", reading: "궁사", translation: "궁사", definition: null, evidence: [] };

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "munhae-delete-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  const repo = createProject({ title: "삭제 검증", parentDir: path }).handle;
  cleanup.push(() => repo.close());
  const root = repo.getHome().documents.find(doc => doc.isMaster)!;
  const folder = (title: string, parentId = root.id) => repo.createDocument({ title, parentId, nodeRole: "container", originalTitle: null });
  const source = (title: string, parentId: string, sourceText = "天地玄黃。") => repo.createDocument({ title, parentId, nodeRole: "source_unit", originalTitle: null, sourceText, originKind: "manual" });
  return { repo, root, folder, source };
}
function remove(repo: ProjectRepo, id: string, removeTermsAndComments = false) {
  repo.deleteDocument({ documentNodeId: id, expectedLockVersion: repo.getDocumentDeletion(id).lockVersion, removeTermsAndComments });
}
function punctuate(repo: ProjectRepo, id: string, text: string) {
  let editor = repo.confirmSource({ documentNodeId: id, expectedLockVersion: repo.getEditor(id).source.lockVersion });
  editor = repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: id, structureMode: "prose", expectedSourceLockVersion: editor.source.lockVersion });
  editor = repo.savePunctuationDraft({ documentNodeId: id, punctuatedText: text, structureMode: "prose", expectedLockVersion: editor.punctuation!.lockVersion });
  repo.confirmPunctuation({ documentNodeId: id, expectedLockVersion: editor.punctuation!.lockVersion });
  return repo.getDocumentTerms(id).basis!;
}
function comment(repo: ProjectRepo, id: string) {
  const run = repo.beginFullTextRun({ documentNodeId: id, ...runOptions });
  repo.completeFullTextRun({ messageId: run.messageId, rawResponse: JSON.stringify({ schemaVersion: 1, translation: "왕건의 궁사." }),
    eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
  const editor = repo.getEditor(id);
  return repo.createReviewComment({ documentNodeId: id, translationVersionId: editor.translation!.versionId,
    targetKind: "source", targetVersionId: editor.source.versionId, codepointFrom: 2, codepointTo: 4, quote: "宮詞", bodyMd: "작품명으로 읽는다." });
}

describe("document deletion", () => {
  it("hides a folder with its whole branch and closes it to further edits", () => {
    const { repo, root, folder, source } = fixture();
    const kept = source("남길 글", root.id), volume = folder("권1"), part = folder("상", volume.id), doc = source("서문", part.id);
    expect(repo.getDocumentDeletion(volume.id)).toMatchObject({ documentIds: [volume.id, part.id, doc.id], termCount: 0, commentCount: 0 });
    remove(repo, volume.id);
    expect(repo.getHome().documents.map(item => item.id)).toEqual([root.id, kept.id]);
    expect(() => repo.getEditor(doc.id)).toThrow(/not found/);
    expect(() => repo.getDocumentMetadata(part.id)).toThrow();
    expect(() => source("새 글", part.id)).toThrow(/not found/);
    expect(() => remove(repo, doc.id)).toThrow(/찾을 수 없습니다/);
    // Archived rows keep their ordinals, so a new sibling still gets a free one.
    expect(source("다음 글", root.id).title).toBe("다음 글");
    const db = openSqlite(sqlitePath(repo.packagePath));
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM document_nodes WHERE archived_at IS NOT NULL").get()).toEqual({ count: 3 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM src_texts WHERE document_node_id = ?").get(doc.id)).toEqual({ count: 1 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });

  it("refuses the project master and stale requests", () => {
    const { repo, root, source } = fixture();
    const doc = source("서문", root.id);
    expect(() => repo.getDocumentDeletion(root.id)).toThrow(/마스터/);
    expect(() => repo.deleteDocument({ documentNodeId: root.id, expectedLockVersion: 1, removeTermsAndComments: false })).toThrow(/마스터/);
    const stale = repo.getDocumentDeletion(doc.id).lockVersion;
    const metadata = repo.getDocumentMetadata(doc.id);
    repo.updateDocumentMetadata({ ...metadata, documentNodeId: doc.id, title: "고친 서문", expectedLockVersion: metadata.lockVersion });
    expect(() => repo.deleteDocument({ documentNodeId: doc.id, expectedLockVersion: stale, removeTermsAndComments: false })).toThrow(/다른 창/);
    expect(repo.getHome().documents.some(item => item.id === doc.id)).toBe(true);
  });

  function withTermsAndComments() {
    const base = fixture();
    const { repo, root, source } = base;
    const one = source("관서악부서", root.id, "王建宮詞𠮷王建"), two = source("다른 문서", root.id, "王建詩");
    const oneBasis = punctuate(repo, one.id, "王建，宮詞。𠮷王建。"), twoBasis = punctuate(repo, two.id, "王建詩。");
    const shared = repo.confirmTerm({ documentId: one.id, punctuationVersionId: oneBasis.punctuationVersionId, term: wangJian, ...notes, occurrences: [{ from: 0, to: 2 }, { from: 7, to: 9 }] });
    repo.confirmTerm({ documentId: two.id, punctuationVersionId: twoBasis.punctuationVersionId, termId: shared.term.id, ...notes, occurrences: [{ from: 0, to: 2 }] });
    const own = repo.confirmTerm({ documentId: one.id, punctuationVersionId: oneBasis.punctuationVersionId, term: gongsa, ...notes, occurrences: [{ from: 3, to: 5 }] });
    const note = comment(repo, one.id);
    return { ...base, one, two, shared: shared.term, own: own.term, note };
  }

  it("counts only the terms no other document uses, and keeps terms and comments unless asked", () => {
    const { repo, one, two, shared, own, note } = withTermsAndComments();
    expect(repo.getDocumentDeletion(one.id)).toMatchObject({ termCount: 1, commentCount: 1 });
    expect(repo.getDocumentDeletion(two.id)).toMatchObject({ termCount: 0, commentCount: 0 });
    remove(repo, one.id);
    const terms = repo.getProjectTerms();
    expect(terms.map(term => term.id).sort()).toEqual([shared.id, own.id].sort());
    expect(terms.find(term => term.id === own.id)!.documents).toEqual([]);
    expect(terms.find(term => term.id === shared.id)!.documents.map(use => use.id)).toEqual([two.id]);
    const db = openSqlite(sqlitePath(repo.packagePath));
    try {
      expect(db.prepare("SELECT archived_at FROM review_comments WHERE id = ?").get(note.id)).toEqual({ archived_at: null });
      expect(db.prepare("SELECT COUNT(*) AS count FROM document_terms WHERE document_node_id = ?").get(one.id)).toEqual({ count: 2 });
    } finally { db.close(); }
  });

  it("deletes the terms and comments only the deleted documents have when asked", () => {
    const { repo, one, two, shared, note } = withTermsAndComments();
    remove(repo, one.id, true);
    const terms = repo.getProjectTerms();
    expect(terms.map(term => term.id)).toEqual([shared.id]);
    expect(terms[0]!.documents.map(use => use.id)).toEqual([two.id]);
    expect(repo.getDocumentTerms(two.id).terms.map(link => link.term.id)).toEqual([shared.id]);
    const db = openSqlite(sqlitePath(repo.packagePath));
    try {
      expect(db.prepare("SELECT archived_at FROM review_comments WHERE id = ?").get(note.id)).toMatchObject({ archived_at: expect.any(String) });
      expect(db.prepare("SELECT COUNT(*) AS count FROM document_terms WHERE document_node_id = ?").get(one.id)).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM term_occurrences o JOIN document_terms dt ON dt.id = o.document_term_id WHERE dt.document_node_id = ?").get(one.id)).toEqual({ count: 0 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });
});
