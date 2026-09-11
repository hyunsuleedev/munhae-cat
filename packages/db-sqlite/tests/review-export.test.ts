import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProject, seedDemoProject, sqlitePath, type ProjectRepo } from "../src/project-repo.ts";
import { openSqlite } from "../src/sqlite.ts";
import { buildReviewExport, type ReviewExportInput } from "../src/review-export.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function setup(source = "𠮷問太守。太守答。末尾", translation = "길이 태수에게 물었다.\r\n\r\n태수가 답했다.\n") {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-review-export-"));
  cleanup.push(() => rmSync(parentDir, { recursive: true, force: true }));
  const repo = createProject({ title: "검토 출력", parentDir }).handle;
  cleanup.push(() => repo.close());
  const id = addDocument(repo, "문서", source, translation);
  const db = openSqlite(sqlitePath(repo.packagePath));
  cleanup.push(() => db.close());
  return { repo, id, db, source, translation };
}
function addDocument(repo: ProjectRepo, title: string, source: string, translation: string, parentId: string | null = null): string {
  const doc = repo.createDocument({ title, nodeRole: "source_unit", sourceText: source, originKind: "paste", parentId });
  const draft = repo.createTranslationDraft({ documentNodeId: doc.id, fullText: true, expectedSourceLockVersion: repo.getEditor(doc.id).source.lockVersion, expectedPunctuationLockVersion: 1 });
  if (translation) repo.saveTranslationDraft({ documentNodeId: doc.id, textContent: translation, blocks: [], expectedLockVersion: draft.translation!.lockVersion });
  return doc.id;
}
function pair(repo: ProjectRepo, id: string, sentenceId: string, from: number, to: number, quote: string) {
  const translation = repo.getEditor(id).translation!;
  repo.saveSentenceLink({ documentNodeId: id, versionId: translation.versionId, sentenceId, spans: [{ from, to, quote }], expectedLockVersion: translation.lockVersion });
}
function comment(repo: ProjectRepo, id: string, bodyMd: string) {
  const editor = repo.getEditor(id);
  return repo.createReviewComment({ documentNodeId: id, translationVersionId: editor.translation!.versionId,
    targetKind: "source", targetVersionId: editor.source.versionId, codepointFrom: 2, codepointTo: 4, quote: "太守", bodyMd });
}
const request = (id?: string): ReviewExportInput => ({ format: "html", state: "current", documentNodeId: id });
it("exports exact recorded Unicode alignment, complete texts and uncovered source without calling it untranslated", () => {
  const { repo, id, db, source, translation } = setup();
  pair(repo, id, "T1", 0, 5, "𠮷問太守。");
  pair(repo, id, "T2", 5, 9, "太守答。");
  const result = buildReviewExport(db, repo.projectId, request(id));
  expect(result).toMatchObject({ extension: "html", documentCount: 1 });
  expect(result.content).toContain(source);
  expect(result.content).toContain(translation);
  expect(result.content).toContain("사람이 대응 확인");
  expect(result.content).toContain("대응표에 연결되지 않은 원문");
  expect(result.content).toContain("미번역을 단정하는 표시가 아닙니다");
  expect(result.content).toContain('<p class="text source">末尾</p>');
  expect(result.content).toContain("미확정 작업안");
  expect(result.content).not.toContain(repo.getEditor(id).translation!.versionId);
});
it("keeps a stale translation paired with its original source and marks the mismatch", () => {
  const { repo, id, db, source } = setup();
  pair(repo, id, "T1", 0, 5, "𠮷問太守。");
  const editor = repo.getEditor(id);
  repo.saveSourceDraft({ documentNodeId: id, contentText: "완전히 다른 새 원문", originKind: "manual", expectedLockVersion: editor.source.lockVersion });
  const html = buildReviewExport(db, repo.projectId, request(id)).content;
  expect(html).toContain(source);
  expect(html).toContain("현재 원문과 다른 버전에 기초한 번역");
  expect(html).not.toContain("완전히 다른 새 원문");
});
it("includes only active comments for the exported version and offers omission", () => {
  const { repo, id, db } = setup();
  comment(repo, id, "옛 버전 의견");
  let e = repo.getEditor(id);
  repo.saveTranslationDraft({ documentNodeId: id, textContent: "새 번역이다.", blocks: [], expectedLockVersion: e.translation!.lockVersion });
  comment(repo, id, "현재 의견\nhttps://db.itkc.or.kr/dir/item?itemId=BT#example");
  const archived = comment(repo, id, "제외한 의견");
  repo.archiveReviewComment({ id: archived.id, expectedLockVersion: archived.lockVersion });
  const html = buildReviewExport(db, repo.projectId, request(id)).content;
  expect(html).toContain("현재 의견");
  expect(html).toContain('href="https://db.itkc.or.kr/dir/item?itemId=BT#example"');
  expect(html).not.toContain("옛 버전 의견");
  expect(html).not.toContain("제외한 의견");
  expect(buildReviewExport(db, repo.projectId, { ...request(id), includeComments: false }).content).not.toContain("현재 의견");
});
it("selects current or confirmed heads independently, filters project scope and rejects empty output", () => {
  const { repo, id, db } = setup();
  expect(() => buildReviewExport(db, repo.projectId, { ...request(id), state: "confirmed" })).toThrow(/확정된 번역이 없습니다/);
  repo.confirmTranslation({ documentNodeId: id, expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  repo.reviseTranslation({ documentNodeId: id, expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  repo.saveTranslationDraft({ documentNodeId: id, textContent: "새 작업안이다.", blocks: [], expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  addDocument(repo, "둘째", "學而", "둘째 번역.");
  const emptyId = addDocument(repo, "빈 작업안", "孔子", "");
  expect(buildReviewExport(db, repo.projectId, request()).documentCount).toBe(2);
  const confirmed = buildReviewExport(db, repo.projectId, { ...request(), state: "confirmed" });
  expect(confirmed.documentCount).toBe(1);
  expect(confirmed.content).toContain("확정본");
  expect(confirmed.content).not.toContain("새 작업안이다");
  expect(() => buildReviewExport(db, repo.projectId, request(emptyId))).toThrow(/저장된 번역이 없습니다/);
});
it("escapes markup in HTML and Markdown, retains literal note content and limits links to HTTP(S)", () => {
  const { repo, id, db } = setup(undefined, '<script>alert("x")</script> [link](javascript:alert(1))\n```\n끝.');
  comment(repo, id, '<img src=x onerror=alert(1)>\n[jump](javascript:alert(1))\nhttps://example.com/?a=1&b=2');
  const html = buildReviewExport(db, repo.projectId, request(id)).content;
  expect(html).not.toContain("<script>"); expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;"); expect(html).toContain("&lt;img");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
  const markdown = buildReviewExport(db, repo.projectId, { ...request(id), format: "markdown" }).content;
  expect(markdown).toContain("````text\n<script>");
  expect(markdown).toContain("[jump](javascript:alert(1))"); // inert fenced note text
  expect(markdown).toContain("&lt;script&gt;"); // escaped table cell
});
it("falls back to unlinked exact translation when persisted sentence coordinates are inconsistent", () => {
  const { repo, id, db, translation } = setup();
  db.prepare("UPDATE translation_text_layouts SET sentences_json=? WHERE version_id=?").run(JSON.stringify([{ id: "T1", from: 0, to: 2, text: "허위" }]), repo.getEditor(id).translation!.versionId);
  const html = buildReviewExport(db, repo.projectId, request(id)).content;
  expect(html).toContain(translation); expect(html).toContain("미연결 · 원문 전문과 대조하세요"); expect(html).not.toContain("허위");
});
it("exports inherited bibliography and sorts nested source units in tree order", () => {
  const { repo, id, db } = setup();
  const folder = repo.createDocument({ title: "상위권", nodeRole: "container", parentId: null });
  const metadata = repo.getDocumentMetadata(folder.id);
  repo.updateDocumentMetadata({ ...metadata, documentNodeId: folder.id, sourceReference: "원서 3권 5면", periodText: "조선", expectedLockVersion: metadata.lockVersion });
  const child = addDocument(repo, "하위 원문", "太守", "태수다.", folder.id);
  const html = buildReviewExport(db, repo.projectId, request(child)).content;
  expect(html).toContain("상위권 › 하위 원문"); expect(html).toContain("원서 3권 5면"); expect(html).toContain("조선");
  expect(() => buildReviewExport(db, repo.projectId, request(folder.id))).toThrow(/원문 작업 단위/);
  expect(() => buildReviewExport(db, "another-project", request(id))).toThrow(/프로젝트를 찾을/);
});
it("supports older block/anchor translations without fabricating sentence links", () => {
  const parent = mkdtempSync(join(tmpdir(), "munhae-review-legacy-"));
  cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const repo = seedDemoProject(parent); cleanup.push(() => repo.close());
  const db = openSqlite(sqlitePath(repo.packagePath)); cleanup.push(() => db.close());
  const doc = repo.getHome().documents.find(item => item.originalTitle === "御製序")!;
  const output = buildReviewExport(db, repo.projectId, request(doc.id));
  expect(output.content).toContain("저장된 블록 연결 · 검토 필요");
  expect(output.content).toContain(repo.getEditor(doc.id).source.contentText);
});
it("rejects invalid format, state and comment flags before accessing data", () => {
  const { repo, db } = setup();
  for (const value of [{ format: "pdf", state: "current" }, { format: "html", state: "all" }, { ...request(), includeComments: "yes" }, { ...request(), documentNodeId: "" }])
    expect(() => buildReviewExport(db, repo.projectId, value as ReviewExportInput)).toThrow(/조건이 올바르지/);
});

it("exports inherited free-text authors and periods while keeping the document date local", () => {
  const { repo, id, db } = setup();
  const master = repo.getHome().documents.find((node) => node.isMaster)!;
  const parent = repo.getDocumentMetadata(master.id);
  repo.updateDocumentMetadata({
    ...parent, documentNodeId: master.id, authorName: "허균(許筠)", periodText: "조선 중기",
    dateText: "마스터 작성일", sourceReference: "소장본 A", expectedLockVersion: parent.lockVersion,
  });
  const direct = repo.getDocumentMetadata(id);
  const local = repo.updateDocumentMetadata({
    ...direct, documentNodeId: id, authorName: null, dateText: "1600년경", expectedLockVersion: direct.lockVersion,
  });
  const inherited = buildReviewExport(db, repo.projectId, request(id)).content;
  for (const value of ["허균(許筠)", "조선 중기", "1600년경", "소장본 A"]) expect(inherited).toContain(value);
  expect(inherited).not.toContain("마스터 작성일");
  const overridden = repo.updateDocumentMetadata({
    ...local, documentNodeId: id, authorName: "별도 저자", expectedLockVersion: local.lockVersion,
  });
  const own = buildReviewExport(db, repo.projectId, request(id)).content;
  expect(own).toContain("별도 저자");
  expect(own).not.toContain("허균(許筠)");
  repo.updateDocumentMetadata({ ...overridden, documentNodeId: id, authorName: null, expectedLockVersion: overridden.lockVersion });
  expect(buildReviewExport(db, repo.projectId, request(id)).content).toContain("허균(許筠)");
});
