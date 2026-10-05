import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, expect, it } from "vitest";
import { createProject, sqlitePath, type ProjectRepo } from "../src/project-repo.ts";
import { openSqlite } from "../src/sqlite.ts";
import { bilingualRows, buildTranslationExport, type TranslationExportInput } from "../src/translation-export.ts";
import type { LinkedSegment } from "../src/review-export.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function setup(source = "𠮷問太守太守答末尾", translation = "길이 태수에게 물었다.\r\n\r\n태수가 답했다.\n") {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-translation-export-"));
  cleanup.push(() => rmSync(parentDir, { recursive: true, force: true }));
  const repo = createProject({ title: "완성본 출력", parentDir }).handle;
  cleanup.push(() => repo.close());
  const id = addDocument(repo, "문서", source, translation);
  const db = openSqlite(sqlitePath(repo.packagePath));
  cleanup.push(() => db.close());
  return { repo, id, db };
}
function addDocument(repo: ProjectRepo, title: string, source: string, translation: string, parentId: string | null = null, originalTitle?: string): string {
  const doc = repo.createDocument({ title, originalTitle, nodeRole: "source_unit", sourceText: source, originKind: "paste", parentId });
  const draft = repo.createTranslationDraft({ documentNodeId: doc.id, fullText: true, expectedSourceLockVersion: repo.getEditor(doc.id).source.lockVersion, expectedPunctuationLockVersion: 1 });
  if (translation) repo.saveTranslationDraft({ documentNodeId: doc.id, textContent: translation, blocks: [], expectedLockVersion: draft.translation!.lockVersion });
  return doc.id;
}
function pair(repo: ProjectRepo, id: string, sentenceId: string, from: number, to: number, quote: string) {
  const translation = repo.getEditor(id).translation!;
  repo.saveSentenceLink({ documentNodeId: id, versionId: translation.versionId, sentenceId, spans: [{ from, to, quote }], expectedLockVersion: translation.lockVersion });
}
const request = (input: Partial<TranslationExportInput> = {}): TranslationExportInput => ({ format: "txt", layout: "translation", state: "current", documentNodeId: null, ...input });
const text = (payload: ReturnType<typeof buildTranslationExport>) => payload.format === "txt" || payload.format === "markdown" ? payload.text : "";
const plain = (source: string) => ({ points: Array.from(source), at: (cursor: number) => cursor });
const segment = (from: number, to: number, spans: Array<[number, number]>): LinkedSegment => ({ from, to, text: "", status: "", spans: spans.map(([a, b]) => ({ from: a, to: b, quote: "" })) });

it("writes only the translation with its title, without review states or version records", () => {
  const { repo, id, db } = setup();
  const payload = buildTranslationExport(db, repo.projectId, request({ documentNodeId: id }));
  expect(payload).toMatchObject({ format: "txt", extension: "txt", documentCount: 1, suggestedBaseName: "문서-번역" });
  expect(text(payload)).toBe("문서\n\n길이 태수에게 물었다.\n\n태수가 답했다.\n");
  expect(text(payload)).not.toContain(repo.getEditor(id).translation!.versionId);
});

it("pairs each translation paragraph with its linked source and keeps unlinked source in order", () => {
  const { repo, id, db } = setup();
  pair(repo, id, "T1", 0, 4, "𠮷問太守");
  pair(repo, id, "T2", 4, 7, "太守答");
  const payload = buildTranslationExport(db, repo.projectId, request({ documentNodeId: id, layout: "bilingual" }));
  expect(payload.suggestedBaseName).toBe("문서-대역");
  expect(text(payload)).toBe("문서\n\n𠮷問太守\n길이 태수에게 물었다.\n\n太守答末尾\n태수가 답했다.\n");
});

it("shows confirmed punctuation of the translated source and cuts before inserted opening marks", () => {
  const { repo, id, db } = setup();
  pair(repo, id, "T1", 0, 4, "𠮷問太守");
  pair(repo, id, "T2", 4, 7, "太守答");
  let editor = repo.confirmSource({ documentNodeId: id, expectedLockVersion: repo.getEditor(id).source.lockVersion });
  editor = repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: id, structureMode: "prose", expectedSourceLockVersion: editor.source.lockVersion });
  editor = repo.savePunctuationDraft({ documentNodeId: id, punctuatedText: "𠮷問太守。「太守答。」末尾。", structureMode: "prose", expectedLockVersion: editor.punctuation!.lockVersion });
  repo.confirmPunctuation({ documentNodeId: id, expectedLockVersion: editor.punctuation!.lockVersion });
  const markdown = text(buildTranslationExport(db, repo.projectId, request({ documentNodeId: id, layout: "bilingual", format: "markdown" })));
  expect(markdown).toBe("# 문서\n\n> 𠮷問太守。\n\n길이 태수에게 물었다.\n\n> 「太守答。」末尾。\n\n태수가 답했다.\n");
});

it("merges crossing, reordered and unlinked paragraphs instead of misplacing source", () => {
  const source = "甲乙丙丁戊己";
  const translation = "하나\n둘\n셋\n넷";
  // 하나→甲乙, 둘 unlinked, 셋→戊己 then 넷→丙丁 reverses the source order.
  const rows = bilingualRows(translation, [segment(0, 2, [[0, 2]]), segment(5, 6, [[4, 6]]), segment(7, 8, [[2, 4]])], plain(source), 6);
  expect(rows).toEqual([{ source: "甲乙", translation: "하나\n둘" }, { source: "丙丁戊己", translation: "셋\n넷" }]);
  // A group that crosses a line break keeps both lines in one row.
  expect(bilingualRows("가\n나\n다", [segment(0, 3, [[0, 1]]), segment(4, 5, [[1, 2]])], plain("甲乙"), 2))
    .toEqual([{ source: "甲", translation: "가\n나" }, { source: "乙", translation: "다" }]);
  expect(bilingualRows("가\n나", null, plain("甲乙"), 2)).toEqual([{ source: "甲乙", translation: "가\n나" }]);
  expect(bilingualRows("가\n나", [segment(0, 1, [])], plain("甲乙"), 2)).toEqual([{ source: "甲乙", translation: "가\n나" }]);
});

it("nests folder headings in tree order and separates current from confirmed translations", () => {
  const { repo, id, db } = setup();
  const folder = repo.createDocument({ title: "권1", nodeRole: "container", parentId: null });
  addDocument(repo, "서문", "序", "서문 번역.", folder.id, "序文");
  addDocument(repo, "발문", "跋", "", folder.id);
  const all = text(buildTranslationExport(db, repo.projectId, request({ format: "markdown" })));
  expect(all).toBe("# 완성본 출력\n\n## 문서\n\n길이 태수에게 물었다.\n\n태수가 답했다.\n\n## 권1\n\n### 서문(序文)\n\n서문 번역.\n");
  expect(() => buildTranslationExport(db, repo.projectId, request({ state: "confirmed" }))).toThrow(/확정된 번역이 없습니다/);
  repo.confirmTranslation({ documentNodeId: id, expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  repo.reviseTranslation({ documentNodeId: id, expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  repo.saveTranslationDraft({ documentNodeId: id, textContent: "새 작업안.", blocks: [], expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  const confirmed = buildTranslationExport(db, repo.projectId, request({ state: "confirmed" }));
  expect(confirmed.documentCount).toBe(1);
  expect(text(confirmed)).toContain("태수가 답했다.");
  expect(text(confirmed)).not.toContain("새 작업안");
});

it("does not repeat a lone document title that matches the project title", () => {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-translation-export-"));
  cleanup.push(() => rmSync(parentDir, { recursive: true, force: true }));
  const repo = createProject({ title: "관서악부서", parentDir }).handle;
  cleanup.push(() => repo.close());
  addDocument(repo, "관서악부서", "學", "배움.");
  const db = openSqlite(sqlitePath(repo.packagePath));
  cleanup.push(() => db.close());
  expect(text(buildTranslationExport(db, repo.projectId, request({ format: "markdown" })))).toBe("# 관서악부서\n\n배움.\n");
});

it("escapes Markdown markup only where it would change the text", () => {
  const { repo, id, db } = setup(undefined, "# 제목 아님\n1. 목록 아님\n*강조* 아님 <b>태그</b>\n평범한 문장. 끝-");
  const markdown = text(buildTranslationExport(db, repo.projectId, request({ documentNodeId: id, format: "markdown" })));
  expect(markdown).toContain("\\# 제목 아님\n\n1\\. 목록 아님\n\n\\*강조\\* 아님 \\<b\\>태그\\</b\\>\n\n평범한 문장. 끝-\n");
});

it("builds a Word package with styles, escaped text and a two-column bilingual table", () => {
  const { repo, id, db } = setup(undefined, "<태수> & \"물음\"\u0001\n\n태수가 답했다.");
  pair(repo, id, "T1", 0, 4, "𠮷問太守");
  const payload = buildTranslationExport(db, repo.projectId, request({ documentNodeId: id, format: "docx", layout: "bilingual" }));
  if (payload.format !== "docx") throw new Error("expected docx");
  const files = unzipSync(payload.bytes);
  expect(Object.keys(files)[0]).toBe("[Content_Types].xml");
  const document = strFromU8(files["word/document.xml"]!);
  expect(document).toContain('<w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">문서</w:t>');
  expect(document).toContain("&lt;태수&gt; &amp; &quot;물음&quot;</w:t>");
  expect(document).not.toContain("\u0001");
  expect(document.match(/<w:tr>/g)).toHaveLength(1); // the second paragraph has no link of its own
  expect(document).toContain('<w:pStyle w:val="SourceText"/></w:pPr><w:r><w:t xml:space="preserve">𠮷問太守太守答末尾</w:t>');
  expect(strFromU8(files["word/styles.xml"]!)).toContain('<w:name w:val="heading 1"/>');
  expect(strFromU8(files["docProps/core.xml"]!)).toContain("<dc:title>문서</dc:title>");
  const again = buildTranslationExport(db, repo.projectId, request({ documentNodeId: id, format: "docx" }));
  expect(again.format === "docx" && strFromU8(unzipSync(again.bytes)["word/document.xml"]!)).not.toContain("<w:tbl>");
});

it("prepares an inert print page for PDF", () => {
  const { repo, id, db } = setup(undefined, "<script>alert(1)</script>");
  const payload = buildTranslationExport(db, repo.projectId, request({ documentNodeId: id, format: "pdf" }));
  if (payload.format !== "pdf") throw new Error("expected pdf");
  expect(payload.extension).toBe("pdf");
  expect(payload.printHtml).toContain("default-src 'none'");
  expect(payload.printHtml).toContain("&lt;script&gt;");
  expect(payload.printHtml).not.toContain("<script>");
});

it("rejects invalid conditions and non-source nodes", () => {
  const { repo, db } = setup();
  for (const value of [{ format: "hwp" }, { layout: "side" }, { state: "all" }, { documentNodeId: "" }])
    expect(() => buildTranslationExport(db, repo.projectId, request(value as Partial<TranslationExportInput>))).toThrow(/조건이 올바르지/);
  const folder = repo.createDocument({ title: "폴더", nodeRole: "container", parentId: null });
  expect(() => buildTranslationExport(db, repo.projectId, request({ documentNodeId: folder.id }))).toThrow(/원문 작업 단위/);
});
