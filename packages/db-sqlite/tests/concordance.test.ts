import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProject, sqlitePath } from "../src/project-repo.ts";
import { openSqlite } from "../src/sqlite.ts";
import { searchConcordance } from "../src/concordance.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function setup(source = "𠮷問太守。太守答𠮷。") {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-concordance-"));
  cleanup.push(() => rmSync(parentDir, { recursive: true, force: true }));
  const repo = createProject({ title: "용례 대조", parentDir }).handle;
  cleanup.push(() => repo.close());
  const document = repo.createDocument({ title: "태수에게 묻다", nodeRole: "source_unit", sourceText: source, originKind: "paste", parentId: null });
  const db = openSqlite(sqlitePath(repo.packagePath));
  cleanup.push(() => db.close());
  const translate = (text = "길이 태수에게 물었다. 태수가 길에게 답했다.") => {
    const run = repo.beginFullTextRun({ documentNodeId: document.id, agentId: "codex", requestedModel: null, reasoningLevel: null, serviceTier: null, runtimeVersion: null });
    repo.completeFullTextRun({ messageId: run.messageId, rawResponse: JSON.stringify({ schemaVersion: 1, translation: text }), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
    return repo.getEditor(document.id).translation!;
  };
  const link = (sentenceId: string, from: number, to: number) => {
    const translation = repo.getEditor(document.id).translation!;
    repo.saveSentenceLink({ documentNodeId: document.id, versionId: translation.versionId, sentenceId,
      spans: [{ from, to, quote: Array.from(source).slice(from, to).join("") }], expectedLockVersion: translation.lockVersion });
  };
  return { repo, db, document, translate, link, search: (input: Parameters<typeof searchConcordance>[2]) => searchConcordance(db, repo.projectId, input) };
}

it("returns exact bilingual sentences, supplementary characters, and human provenance", () => {
  const { translate, link, search, document } = setup();
  const version = translate(); link("T1", 0, 5); link("T2", 5, 10);
  const result = search({ query: "𠮷", scope: "source" });
  expect(result.results).toHaveLength(2);
  expect(result.results[0]).toMatchObject({ documentNodeId: document.id, translationVersionId: version.versionId,
    sentenceId: "T1", sourceText: "𠮷問太守。", translationText: "길이 태수에게 물었다.", alignment: "human",
    contextKind: "sentence", needsReview: false, isCurrent: true, isConfirmed: false, sourceIsCurrent: true, matchedIn: ["source"] });
});

it("keeps automatic alignment distinct from reviewed human links", () => {
  const { translate, link, search, db } = setup();
  const version = translate(); link("T1", 0, 5);
  const row = db.prepare("SELECT links_json FROM translation_text_layouts WHERE version_id=?").get(version.versionId) as { links_json: string };
  const links = JSON.parse(row.links_json);
  delete links[0].reviewedBy; links[0].needsReview = true;
  db.prepare("UPDATE translation_text_layouts SET links_json=? WHERE version_id=?").run(JSON.stringify(links), version.versionId);
  expect(search({ query: "물었다" }).results[0]).toMatchObject({ alignment: "auto", needsReview: true, contextKind: "sentence" });
});

it("includes full document context when a source occurrence is outside partial alignment", () => {
  const { translate, link, search } = setup();
  translate(); link("T1", 0, 5);
  const rows = search({ query: "太守", scope: "source" }).results;
  expect(rows.map((row) => row.contextKind)).toEqual(["sentence", "document"]);
  expect(rows[1]).toMatchObject({ alignment: "unlinked", sourceText: "𠮷問太守。太守答𠮷。", translationText: "길이 태수에게 물었다. 태수가 길에게 답했다." });
});

it("shows unaligned translation matches as document context without pairing by sentence order", () => {
  const { translate, link, search } = setup();
  translate(); link("T1", 0, 5);
  const rows = search({ query: "답했다", scope: "translation" }).results;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ contextKind: "document", alignment: "unlinked", sentenceId: null, matchedIn: ["translation"] });
});

it("does not manufacture a source match by joining recorded fragments", () => {
  const { repo, document, translate, search } = setup();
  const version = translate();
  repo.saveSentenceLink({ documentNodeId: document.id, versionId: version.versionId, sentenceId: "T1", expectedLockVersion: version.lockVersion,
    spans: [{ from: 0, to: 2, quote: "𠮷問" }, { from: 2, to: 5, quote: "太守。" }] });
  expect(search({ query: "問太", scope: "source" }).results.map((row) => row.contextKind)).toEqual(["document"]);
  expect(search({ query: "𠮷問 … 太", scope: "source" }).results).toHaveLength(0);
});

it("rejects stale or corrupt recorded quotes and duplicate sentence identities as pairs", () => {
  const { translate, link, search, db } = setup();
  const version = translate(); link("T1", 0, 5);
  db.prepare("UPDATE translation_text_layouts SET links_json=? WHERE version_id=?")
    .run(JSON.stringify([{ sentenceId: "T1", spans: [{ from: 0, to: 5, quote: "別人問太守" }], needsReview: false, reviewedBy: "human" }]), version.versionId);
  expect(search({ query: "물었다" }).results.map((row) => row.contextKind)).toEqual(["document"]);
  link("T1", 0, 5);
  const layout = db.prepare("SELECT sentences_json FROM translation_text_layouts WHERE version_id=?").get(version.versionId) as { sentences_json: string };
  const sentences = JSON.parse(layout.sentences_json);
  db.prepare("UPDATE translation_text_layouts SET sentences_json=? WHERE version_id=?").run(JSON.stringify([...sentences, sentences[0]]), version.versionId);
  expect(search({ query: "물었다" }).results.map((row) => row.contextKind)).toEqual(["document"]);
  db.prepare("UPDATE translation_text_layouts SET sentences_json=? WHERE version_id=?").run(JSON.stringify("broken"), version.versionId);
  expect(search({ query: "太守" }).results[0]?.alignment).toBe("unlinked");
});

it("treats SQL wildcard characters and search operators literally, with independent scopes", () => {
  const { translate, link, search } = setup("百分100%_ [x] OR 字");
  translate("백분율 100%_ [x]라고 적었다."); link("T1", 0, 16);
  expect(search({ query: "%_ [x]" }).results[0]?.matchedIn).toEqual(["source", "translation"]);
  expect(search({ query: "%", scope: "translation" }).results).toHaveLength(1);
  expect(search({ query: "OR", scope: "translation" }).results).toHaveLength(0);
  expect(search({ query: "OR", scope: "source" }).results).toHaveLength(1);
  expect(search({ query: "*" }).results).toHaveLength(0);
});

it("uses the selected confirmed head and its exact historical source rather than mixing current versions", () => {
  const { repo, db, document, translate, link, search } = setup();
  const first = translate(); link("T1", 0, 5);
  repo.confirmTranslation({ documentNodeId: document.id, expectedLockVersion: repo.getEditor(document.id).translation!.lockVersion });
  const current = repo.getEditor(document.id).translation!;
  repo.saveTranslationDraft({ documentNodeId: document.id, expectedLockVersion: current.lockVersion, textContent: "새 번역에는 다른 표현이 있다.", blocks: [] });
  expect(search({ query: "물었다", state: "current" }).results).toHaveLength(0);
  expect(search({ query: "물었다", state: "confirmed" }).results[0]).toMatchObject({ translationVersionId: first.versionId, isConfirmed: true, isCurrent: false, alignment: "human" });
  const source = repo.getEditor(document.id).source;
  repo.saveSourceDraft({ documentNodeId: document.id, contentText: "太守新原文", originKind: "manual", expectedLockVersion: source.lockVersion });
  const historical = search({ query: "太守", state: "confirmed" }).results[0];
  expect(historical).toMatchObject({ sourceVersionId: source.versionId, sourceIsCurrent: false, sourceText: "𠮷問太守。" });
  expect(db.prepare("SELECT content_text FROM src_text_versions WHERE id=?").get(historical!.sourceVersionId)).toEqual({ content_text: "𠮷問太守。太守答𠮷。" });
  expect(search({ query: "太守", state: "current" }).results).toContainEqual(expect.objectContaining({ sourceText: "太守新原文", translationText: null, sourceIsCurrent: true }));
});

it("includes untranslated source, filters the document and project, and excludes archived nodes", () => {
  const { repo, db, document, search } = setup();
  expect(search({ query: "太守" }).results[0]).toMatchObject({ translationVersionId: null, translationText: null, contextKind: "document" });
  expect(search({ query: "太守", scope: "translation" }).results).toHaveLength(0);
  expect(search({ query: "太守", documentNodeId: "missing" }).results).toHaveLength(0);
  expect(searchConcordance(db, "other-project", { query: "太守" }).results).toHaveLength(0);
  expect(search({ query: "太守", documentNodeId: document.id }).results).toHaveLength(1);
  db.prepare("UPDATE document_nodes SET archived_at=? WHERE id=?").run(new Date().toISOString(), document.id);
  expect(search({ query: "太守" }).results).toHaveLength(0);
  expect(repo.projectId).toBeTruthy();
});

it("excludes descendants of archived containers even if the descendant itself is active", () => {
  const { repo, db, document, translate, search } = setup();
  translate();
  const parent = repo.createDocument({ title: "보관한 권", nodeRole: "container", parentId: null });
  db.prepare("UPDATE document_nodes SET parent_node_id=? WHERE id=?").run(parent.id, document.id);
  expect(search({ query: "太守" }).results).toHaveLength(1);
  db.prepare("UPDATE document_nodes SET archived_at=? WHERE id=?").run(new Date().toISOString(), parent.id);
  expect(search({ query: "太守" }).results).toHaveLength(0);
});

it("bounds result rows and validates Unicode, query controls, and filter values", () => {
  const { translate, link, search } = setup(); translate(); link("T1", 0, 5); link("T2", 5, 10);
  expect(search({ query: "太守", limit: 1 })).toMatchObject({ hasMore: true, results: [expect.objectContaining({ sentenceId: "T1" })] });
  expect(search({ query: "太守", limit: 2 }).hasMore).toBe(false);
  for (const query of ["", " \n ", "𠮷".repeat(101), "a\u0000b", "\ud800"]) expect(() => search({ query })).toThrow();
  for (const limit of [0, 101, 1.5, Infinity]) expect(() => search({ query: "太守", limit })).toThrow();
  expect(() => search({ query: "太守", scope: "fts" as never })).toThrow();
  expect(() => search({ query: "太守", state: "all" as never })).toThrow();
});
