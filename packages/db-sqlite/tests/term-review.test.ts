import { restoreV9SummaryFixture } from "./legacy-materials-fixture.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProject, openProject, openSqlite, sqlitePath, type ProjectRepo, type SaveTermInput } from "../src/index.ts";
import { termSource } from "@munhae/domain/term-source";
import { termOccurrences } from "../src/term-review.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "munhae-terms-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = createProject({ parentDir: dir, title: "용어 검토" }).handle; cleanup.push(() => repo.close());
  const one = repo.createDocument({ title: "관서악부서", parentId: null, nodeRole: "source_unit", sourceText: "王建宮詞𠮷王建", originKind: "paste" });
  const two = repo.createDocument({ title: "다른 문서", parentId: null, nodeRole: "source_unit", sourceText: "王建", originKind: "paste" });
  return { repo, one: one.id, two: two.id };
}
function input(repo: ProjectRepo, id: string): SaveTermInput {
  const v = repo.getEditor(id);
  return { documentId: id, sourceVersion: `${v.source.versionId}:${v.source.lockVersion}`, sourceForm: "王建", kind: "person", reading: "왕건", translation: null, definition: "인물 식별 필요", contextNote: "궁사를 지은 시인", selectionReason: "동명이인 구별", uncertainty: "출전 확인 필요", evidence: [], quotes: ["王建"], status: "draft" };
}
it("keeps drafts out of translation, includes reviewed local terms only in their document, and preserves revisions", () => {
  const { repo, one, two } = setup(); const value = input(repo, one);
  const term = repo.saveTerm(value);
  expect(repo.previewContext({ documentNodeId: one }).requestText).not.toContain("궁사를 지은 시인");
  const saved = repo.saveTerm({ ...value, id: term.id, expectedLockVersion: term.lockVersion, status: "reviewed" });
  expect(repo.previewContext({ documentNodeId: one }).requestText).toContain("궁사를 지은 시인");
  expect(repo.previewContext({ documentNodeId: two }).requestText).not.toContain("궁사를 지은 시인");
  expect(() => repo.saveTerm({ ...value, id: term.id, expectedLockVersion: 1 })).toThrow(/변경/);
  const db = openSqlite(sqlitePath(repo.packagePath));
  expect(db.prepare("SELECT count(*) AS n FROM term_revisions WHERE term_id=?").get(term.id)).toEqual({ n: 2 }); db.close();
  repo.close(); const reopened = openProject(repo.packagePath); cleanup.push(() => reopened.close()); expect(reopened.getTerms(one)).toEqual([saved]);
});
it("invalidates terms after draft edits and rejects late AI output atomically", () => {
  const { repo, one } = setup(); const value = input(repo, one);
  repo.saveTerm({ ...value, status: "reviewed" });
  repo.saveSourceDraft({ documentNodeId: one, contentText: "王建新文", originKind: "manual", expectedLockVersion: repo.getEditor(one).source.lockVersion });
  expect(repo.previewContext({ documentNodeId: one }).requestText).not.toContain("궁사를 지은 시인");
  expect(() => repo.storeTermCandidates(one, value.sourceVersion!, [{ ...value, quotes: ["王建"] }], { runId: "test", model: "test", agentId: "codex" })).toThrow(/원문 또는 표점이 변경/);
  expect(repo.getTerms(one)).toHaveLength(1);
});
it("promotes atomically without destroying local context, and explicit local interpretation overrides a shared term", () => {
  const { repo, one, two } = setup(); const value = input(repo, one); const local = repo.saveTerm(value);
  const promoted = repo.promoteTerm({ ...value, id: local.id, expectedLockVersion: 1, status: "reviewed" });
  const common = repo.getTerms(one).find(t => !t.documentId)!;
  expect(promoted.contextNote).toBe(value.contextNote); expect(promoted.parentTermId).toBe(common.id); expect(common.contextNote).toBeNull(); expect(common.status).toBe("draft");
  repo.saveTerm({ ...common, expectedLockVersion: common.lockVersion, status: "reviewed", definition: "공통 풀이" });
  expect(repo.previewContext({ documentNodeId: two }).requestText).toContain("공통 풀이");
  expect(repo.previewContext({ documentNodeId: one }).requestText).not.toContain("공통 풀이");
  const count = repo.getTerms(one).length;
  expect(() => repo.promoteTerm({ ...value, id: local.id, expectedLockVersion: 1 })).toThrow(/변경/);
  expect(repo.getTerms(one)).toHaveLength(count);
});
it("validates exact glyphs, quotes, Unicode offsets and rolls back a mixed invalid batch", () => {
  expect(termOccurrences("甲𠮷乙𠮷", "𠮷", ["𠮷"])).toEqual([{ quote: "𠮷", start: 1, end: 3 }, { quote: "𠮷", start: 4, end: 6 }]);
  const { repo, one } = setup(); const value = input(repo, one);
  expect(() => repo.storeTermCandidates(one, value.sourceVersion!, [{ ...value, quotes: ["王建"] }, { ...value, quotes: ["不存在"] }], { runId: "test", model: "test", agentId: "codex" })).toThrow();
  expect(repo.getTerms(one)).toEqual([]);
});
it("retains reviewed entries when generating new AI candidates", () => {
  const { repo, one } = setup(); const value = input(repo, one);
  const original = repo.saveTerm({ ...value, status: "reviewed" });
  repo.storeTermCandidates(one, value.sourceVersion!, [{ ...value, contextNote: "새 제안", quotes: ["王建"] }], { runId: "test", model: "test", agentId: "codex" });
  expect(repo.getTerms(one).find(t => t.id === original.id)).toEqual(original);
  expect(repo.getTerms(one).find(t => t.origin === "ai")?.status).toBe("draft");
});
it("upgrades v7 projects and preserves existing glossary rows", () => {
  const { repo } = setup(); const path = repo.packagePath;
  repo.upsertGlossary({ sourceTerm: "王建", targetTerm: "왕건", targetLocale: "ko", termKind: "general", reading: null, noteMd: "기존 메모", usageStatus: "preferred" });
  const old = repo.getKnowledge().glossary; repo.close();
  const db = openSqlite(sqlitePath(path)); restoreV9SummaryFixture(db); db.exec("DROP TABLE comment_references; DROP TABLE term_revisions; DROP TABLE term_entries; DELETE FROM meta_schema_migrations WHERE version>=8; UPDATE meta_project_state SET schema_version=7;"); db.close();
  const reopened = openProject(path); cleanup.push(() => reopened.close());
  expect(reopened.getKnowledge().glossary).toEqual(old); expect(reopened.getTerms()).toEqual([]);
});

it("validates punctuation quotations and invalidates reviewed terms and late results after punctuation edits", () => {
  const { repo, one } = setup();
  let editor = repo.getEditor(one);
  editor = repo.confirmSource({ documentNodeId: one, expectedLockVersion: editor.source.lockVersion });
  editor = repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: one, structureMode: "prose", expectedSourceLockVersion: editor.source.lockVersion });
  editor = repo.savePunctuationDraft({ documentNodeId: one, punctuatedText: "王建，宮詞。𠮷王建。", structureMode: "prose", expectedLockVersion: editor.punctuation!.lockVersion });
  const basis = termSource(editor);
  const value = { ...input(repo, one), sourceVersion: basis.version, quotes: ["王建，宮詞。"], status: "reviewed" as const };
  const saved = repo.saveTerm(value);
  expect(saved.occurrences).toEqual([{ quote: "王建，宮詞。", start: 0, end: 2 }]);
  expect(repo.previewContext({ documentNodeId: one }).requestText).toContain("궁사를 지은 시인");
  repo.savePunctuationDraft({ documentNodeId: one, punctuatedText: "王建宮詞，𠮷王建。", structureMode: "prose", expectedLockVersion: editor.punctuation!.lockVersion });
  expect(repo.previewContext({ documentNodeId: one }).requestText).not.toContain("궁사를 지은 시인");
  expect(() => repo.storeTermCandidates(one, basis.version, [value], { runId: "test", model: "test", agentId: "codex" })).toThrow(/표점이 변경/);
  expect(termSource({ ...editor, punctuation: { ...editor.punctuation!, state: "superseded" } }).text).toBe(editor.source.contentText);
});

it("deletes local terms without deleting common entries or history, and rejects stale saves", () => {
  const { repo, one } = setup();
  const value = input(repo, one);
  const saved = repo.saveTerm(value);
  const local = repo.promoteTerm({ ...value, id: saved.id, expectedLockVersion: saved.lockVersion });
  const commonId = local.parentTermId!;
  expect(() => repo.deleteTerm({ id: local.id, expectedLockVersion: local.lockVersion - 1 })).toThrow(/변경/);
  expect(() => repo.deleteTerm({ id: commonId, expectedLockVersion: 1 })).toThrow(/문서 용어/);
  repo.deleteTerm({ id: local.id, expectedLockVersion: local.lockVersion });
  expect(repo.getTerms(one).some(t => t.id === local.id)).toBe(false);
  expect(repo.getTerms().some(t => t.id === local.id)).toBe(false);
  expect(repo.getTerms().some(t => t.id === commonId)).toBe(true);
  expect(() => repo.saveTerm({ ...value, id: local.id, expectedLockVersion: local.lockVersion })).toThrow(/찾을 수/);
  expect(() => repo.deleteTerm({ id: local.id, expectedLockVersion: local.lockVersion })).toThrow(/찾을 수/);
  const db = openSqlite(sqlitePath(repo.packagePath));
  try {
    const rows = db.prepare("SELECT payload_json FROM term_revisions WHERE term_id=? ORDER BY created_at,id").all(local.id) as { payload_json: string }[];
    expect(rows.some(row => JSON.parse(row.payload_json).archivedAt)).toBe(true);
    expect(rows.some(row => !JSON.parse(row.payload_json).archivedAt)).toBe(true);
  } finally { db.close(); }
});

it("removes a reviewed document term from future translation inputs", () => {
  const { repo, one } = setup();
  const term = repo.saveTerm({ ...input(repo, one), status: "reviewed" });
  expect(repo.previewContext({ documentNodeId: one }).requestText).toContain("궁사를 지은 시인");
  repo.deleteTerm({ id: term.id, expectedLockVersion: term.lockVersion });
  expect(repo.previewContext({ documentNodeId: one }).requestText).not.toContain("궁사를 지은 시인");
});
