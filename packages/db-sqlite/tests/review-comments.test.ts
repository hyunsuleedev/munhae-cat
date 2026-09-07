import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sha256Hex } from "@munhae/domain";
import { createProject, openProject, openSqlite, sqlitePath, type ProjectRepo } from "../src/index.ts";

const clean: Array<() => void> = [];
afterEach(() => { while (clean.length) clean.pop()!(); });
const runOptions = { agentId: "codex" as const, requestedModel: null, reasoningLevel: null, serviceTier: null, runtimeVersion: null };
const original = "甲𠮷乙甲𠮷乙";
const translation = "첫 𠮷 문장. 둘째 문장.";
function completion(messageId: string, text = translation) {
  return { messageId, rawResponse: JSON.stringify({ schemaVersion: 1, translation: text }), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null };
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "munhae-review-"));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = createProject({ title: "구절 검토", parentDir: dir }).handle;
  clean.push(() => repo.close());
  const doc = repo.createDocument({ title: "본문", nodeRole: "source_unit", sourceText: original, originKind: "paste", parentId: null });
  const run = repo.beginFullTextRun({ documentNodeId: doc.id, ...runOptions });
  const result = repo.completeFullTextRun(completion(run.messageId));
  return { repo, id: doc.id, baseVersionId: result.version.versionId };
}
function sourceComment(repo: ProjectRepo, id: string, bodyMd = "두 번째 𠮷은 인명으로 읽는다.") {
  const e = repo.getEditor(id);
  return repo.createReviewComment({ documentNodeId: id, translationVersionId: e.translation!.versionId,
    targetKind: "source", targetVersionId: e.source.versionId, codepointFrom: 4, codepointTo: 5, quote: "𠮷", bodyMd });
}

it("persists exact Unicode source and translation ranges, CAS updates and archive across reopen", () => {
  const { repo, id, baseVersionId } = setup();
  const first = sourceComment(repo, id);
  expect(first).toMatchObject({ quote: "𠮷", codepointFrom: 4, codepointTo: 5, lockVersion: 1, translationVersionId: baseVersionId });
  const target = repo.createReviewComment({ documentNodeId: id, translationVersionId: baseVersionId, targetKind: "translation",
    targetVersionId: baseVersionId, codepointFrom: 2, codepointTo: 3, quote: "𠮷", bodyMd: "주변 주어를 다시 확인한다." });
  const updated = repo.updateReviewComment({ id: first.id, expectedLockVersion: 1, bodyMd: "인명으로 확정한다." });
  expect(updated).toMatchObject({ id: first.id, quote: first.quote, codepointFrom: 4, lockVersion: 2, bodyMd: "인명으로 확정한다." });
  expect(() => repo.updateReviewComment({ id: first.id, expectedLockVersion: 1, bodyMd: "이전 화면" })).toThrow(/코멘트가 변경/);
  expect(() => repo.archiveReviewComment({ id: first.id, expectedLockVersion: 1 })).toThrow(/코멘트가 변경/);
  repo.archiveReviewComment({ id: target.id, expectedLockVersion: target.lockVersion });
  expect(repo.listReviewComments(id)).toEqual([updated]);
  repo.close();
  const reopened = openProject(repo.packagePath);
  clean.push(() => reopened.close());
  expect(reopened.listReviewComments(id)).toEqual([updated]);
  const db = openSqlite(sqlitePath(repo.packagePath));
  try {
    expect(db.prepare("SELECT archived_at FROM review_comments WHERE id=?").get(target.id)).toMatchObject({ archived_at: expect.any(String) });
    expect(() => db.prepare("UPDATE review_comments SET quote='변경' WHERE id=?").run(first.id)).toThrow(/immutable/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
  } finally { db.close(); }
});

it("rejects mismatched quotes, UTF-16 offsets, invalid ranges, blank bodies and foreign versions", () => {
  const { repo, id, baseVersionId } = setup();
  const input = { documentNodeId: id, translationVersionId: baseVersionId, targetKind: "source" as const,
    targetVersionId: repo.getEditor(id).source.versionId, codepointFrom: 4, codepointTo: 5, quote: "𠮷", bodyMd: "검토" };
  for (const patch of [{ quote: "乙" }, { codepointFrom: 5, codepointTo: 7 }, { codepointFrom: -1 },
    { codepointTo: 4 }, { codepointTo: 99 }, { codepointFrom: 1.5 }, { bodyMd: "\n " }, { bodyMd: "가".repeat(20_001) }])
    expect(() => repo.createReviewComment({ ...input, ...patch })).toThrow();
  const other = repo.createDocument({ title: "다른 문서", nodeRole: "source_unit", sourceText: original, originKind: "paste", parentId: null });
  const otherRun = repo.beginFullTextRun({ documentNodeId: other.id, ...runOptions });
  repo.completeFullTextRun(completion(otherRun.messageId));
  expect(() => repo.createReviewComment({ ...input, documentNodeId: other.id })).toThrow(/변경/);
  expect(() => repo.createReviewComment({ ...input, targetVersionId: repo.getEditor(other.id).source.versionId })).toThrow(/버전/);
  expect(repo.listReviewComments(id)).toEqual([]);
});

it("requires the current baseline and source while keeping old comments attached to their version", () => {
  const { repo, id, baseVersionId } = setup();
  const c = sourceComment(repo, id);
  repo.saveTranslationDraft({ documentNodeId: id, textContent: translation + " 수정.", blocks: [], expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  expect(repo.listReviewComments(id)).toEqual([c]);
  expect(() => repo.previewContext({ documentNodeId: id, revision: { baseVersionId, commentIds: [c.id] } })).toThrow(/변경/);
  expect(() => repo.createReviewComment({ ...c, bodyMd: "다른 버전" })).toThrow(/변경/);
  const current = repo.getEditor(id);
  repo.saveSourceDraft({ documentNodeId: id, contentText: original + "丙", originKind: "manual", expectedLockVersion: current.source.lockVersion });
  expect(() => sourceComment(repo, id)).toThrow(/변경/);
  expect(() => repo.previewContext({ documentNodeId: id, revision: { baseVersionId: current.translation!.versionId, commentIds: [c.id] } })).toThrow(/변경/);
});

it("includes only selected comments and the exact baseline in revision requests and preserves both versions for comparison", () => {
  const { repo, id, baseVersionId } = setup();
  const c = sourceComment(repo, id);
  const unused = sourceComment(repo, id, "제외한 코멘트의 고유 문장");
  const input = { documentNodeId: id, revision: { baseVersionId, commentIds: [c.id] }, ...runOptions };
  const preview = repo.previewContext(input);
  expect(preview.required.find((r) => r.kind === "base_translation")?.content).toBe(translation);
  expect(preview.requestText).toContain(c.bodyMd);
  expect(preview.requestText).not.toContain(unused.bodyMd);
  expect(preview.requestText).toContain("질문과 불확실성은 확정 사실로 바꾸지 마세요");
  const run = repo.beginFullTextRun(input);
  expect(run.requestHash).toBe(preview.requestHash);
  repo.updateReviewComment({ id: c.id, expectedLockVersion: c.lockVersion, bodyMd: "실행 시작 후 바꾼 의견" });
  const newText = "첫 𠮷 문장. 인명으로 고친 둘째 문장.";
  const result = repo.completeFullTextRun(completion(run.messageId, newText));
  expect(repo.getEditor(id).translation?.textContent).toBe(newText);
  const history = repo.getDocumentHistory(id);
  expect(history.entries.find((v) => v.versionId === baseVersionId)?.contentText).toBe(translation);
  expect(history.entries.find((v) => v.versionId === result.version.versionId)?.parentVersionId).toBe(baseVersionId);
  const diff = repo.compareVersions({ documentNodeId: id, kind: "translation", stage: "translation", baseVersionId, targetVersionId: result.version.versionId });
  expect(diff.chunks.some((chunk) => chunk.type === "add" && chunk.text.includes("인명"))).toBe(true);
  const db = openSqlite(sqlitePath(repo.packagePath));
  try {
    const row = db.prepare(`SELECT m.request_manifest_json, a.payload_text FROM chat_messages m
      JOIN provenance_artifacts a ON a.id=m.request_artifact_id WHERE m.id=?`).get(run.messageId) as { request_manifest_json: string; payload_text: string };
    expect(JSON.parse(row.request_manifest_json).snapshot.revision).toEqual({ baseVersionId, baseTranslationHash: sha256Hex(translation), comments: [c] });
    expect(row.payload_text).toBe(preview.requestText);
  } finally { db.close(); }
  repo.close();
  const reopened = openProject(repo.packagePath);
  clean.push(() => reopened.close());
  expect(reopened.compareVersions({ documentNodeId: id, kind: "translation", stage: "translation", baseVersionId, targetVersionId: result.version.versionId })).toEqual(diff);
});

it("rejects empty, duplicate, archived, foreign-document and other-baseline revision comments", () => {
  const { repo, id, baseVersionId } = setup();
  const c = sourceComment(repo, id);
  const other = repo.createDocument({ title: "별도", nodeRole: "source_unit", sourceText: original, originKind: "paste", parentId: null });
  const run = repo.beginFullTextRun({ documentNodeId: other.id, ...runOptions });
  repo.completeFullTextRun(completion(run.messageId));
  const foreign = sourceComment(repo, other.id);
  for (const commentIds of [[], [c.id, c.id], ["missing"], [foreign.id]])
    expect(() => repo.previewContext({ documentNodeId: id, revision: { baseVersionId, commentIds } })).toThrow();
  repo.archiveReviewComment({ id: c.id, expectedLockVersion: c.lockVersion });
  expect(() => repo.beginFullTextRun({ documentNodeId: id, revision: { baseVersionId, commentIds: [c.id] }, ...runOptions })).toThrow(/삭제/);
  const current = sourceComment(repo, id);
  repo.saveTranslationDraft({ documentNodeId: id, textContent: translation + " 수정", blocks: [], expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  expect(() => repo.previewContext({ documentNodeId: id, revision: { baseVersionId: repo.getEditor(id).translation!.versionId, commentIds: [current.id] } })).toThrow(/다른 번역/);
});

it("rejects late revision results if a human changed the baseline during the run", () => {
  const { repo, id, baseVersionId } = setup();
  const c = sourceComment(repo, id);
  const run = repo.beginFullTextRun({ documentNodeId: id, revision: { baseVersionId, commentIds: [c.id] }, ...runOptions });
  const human = translation + " 사람이 수정한 문장.";
  repo.saveTranslationDraft({ documentNodeId: id, textContent: human, blocks: [], expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  expect(() => repo.completeFullTextRun(completion(run.messageId, "뒤늦은 재번역"))).toThrow(/변경/);
  expect(repo.getEditor(id).translation?.textContent).toBe(human);
  expect(repo.getDocumentHistory(id).entries.some((v) => v.contentText === "뒤늦은 재번역")).toBe(false);
});

it("upgrades v3 with a backup and no changes to existing translation history or requests", () => {
  const { repo, id } = setup();
  const path = repo.packagePath, history = repo.getDocumentHistory(id);
  repo.close();
  const db = openSqlite(sqlitePath(path));
  const requests = db.prepare("SELECT * FROM chat_messages ORDER BY id").all();
  db.exec("DROP TABLE review_comments; DELETE FROM meta_schema_migrations WHERE version=4; UPDATE meta_project_state SET schema_version=3;");
  db.close();
  const reopened = openProject(path);
  expect(reopened.listReviewComments(id)).toEqual([]);
  expect(reopened.getDocumentHistory(id)).toEqual(history);
  reopened.close();
  const backups = readdirSync(path).filter((name) => name.includes(".before-review-comments-"));
  expect(backups).toHaveLength(1);
  const check = openSqlite(sqlitePath(path));
  try {
    expect(check.prepare("SELECT schema_version FROM meta_project_state").get()).toEqual({ schema_version: 4 });
    expect(check.prepare("SELECT * FROM chat_messages ORDER BY id").all()).toEqual(requests);
    expect(check.pragma("foreign_key_check")).toEqual([]);
    expect(check.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
  } finally { check.close(); }
  const backup = openSqlite(join(path, backups[0]!));
  try { expect(backup.prepare("SELECT schema_version FROM meta_project_state").get()).toEqual({ schema_version: 3 }); }
  finally { backup.close(); }
  const again = openProject(path);
  again.close();
  expect(readdirSync(path).filter((name) => name.includes(".before-review-comments-"))).toHaveLength(1);
});
