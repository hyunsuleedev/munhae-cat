import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProject, openProject, sqlitePath } from "../src/project-repo.ts";
import { openSqlite } from "../src/sqlite.ts";
import { loadContent, contentText } from "../src/translation-content.ts";
import { replaceTextSentence } from "@munhae/domain/text-sentences";
import type { EditorView } from "../src/views.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function setup(text = "첫 𠀀 문장.\n\n둘째 문장.\n셋째 문장.") {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-content-"));
  cleanup.push(() => rmSync(parentDir, { recursive: true, force: true }));
  const repo = createProject({ title: "묶음 저장", parentDir }).handle;
  cleanup.push(() => repo.close());
  const id = repo.createDocument({ title: "문서", nodeRole: "source_unit", sourceText: "甲乙丙", originKind: "paste", parentId: null }).id;
  const run = repo.beginFullTextRun({ documentNodeId: id, agentId: "codex", requestedModel: null, reasoningLevel: null, serviceTier: null, runtimeVersion: null });
  const result = repo.completeFullTextRun({ messageId: run.messageId, rawResponse: JSON.stringify({ schemaVersion: 1, translation: text }), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
  repo.completeAlignment(result.version.versionId, JSON.stringify({ schemaVersion: 1, versionId: result.version.versionId, links: ["甲", "乙", "丙"].map((s, i) => ({ sentenceId: `T${i + 1}`, quotes: [{ text: s, occurrence: 1 }], needsReview: false })) }));
  const db = openSqlite(sqlitePath(repo.packagePath)); cleanup.push(() => db.close());
  const view = () => repo.getEditor(id);
  function save(base: EditorView, text: string, sentences = base.translation!.textLayout!.sentences, links = base.translation!.textLayout!.links) {
    const tr = base.translation!;
    return repo.saveTranslationDraft({ documentNodeId: id, textContent: text, expectedLockVersion: tr.lockVersion, blocks: [], textBaseVersionId: tr.versionId, textBaseRevision: tr.textLayout!.storageRevision,
      textGroups: sentences.map(s => { const l = links.find(l => l.sentenceId === s.id); return { ...s, id: l?.groupId ?? s.id, spans: l?.spans ?? [] }; }) });
  }
  function edit(base: EditorView, id: string, replacement: string) {
    const changed = replaceTextSentence(base.translation!.textContent, base.translation!.textLayout!.sentences, id, replacement);
    return save(base, changed.text, changed.sentences);
  }
  return { repo, db, id, view, save, edit, text };
}
it("updates only the edited group's rows, preserving all other revisions, links and order keys", () => {
  const { db, view, edit } = setup();
  edit(view(), "T1", "첫 수정 문장.");
  const before = view(), state = loadContent(db, before.translation!.versionId)!;
  const other = state.parts.filter(p => p.groupId !== "T1");
  const rows = db.prepare("SELECT * FROM translation_content_parts WHERE id IN (" + other.map(() => "?").join(",") + ") ORDER BY id").all(...other.map(p => p.id));
  const groups = db.prepare("SELECT * FROM translation_groups WHERE group_key != 'T1' ORDER BY id").all();
  const links = db.prepare("SELECT * FROM translation_group_source_links ORDER BY group_id").all();
  const revisions = db.prepare("SELECT count(*) AS n FROM translation_content_revisions").get() as { n: number };
  const after = edit(before, "T1", "길이가 훨씬 길어진 첫 𠀀 수정 문장.");
  expect(db.prepare("SELECT * FROM translation_content_parts WHERE id IN (" + other.map(() => "?").join(",") + ") ORDER BY id").all(...other.map(p => p.id))).toEqual(rows);
  expect(db.prepare("SELECT * FROM translation_groups WHERE group_key != 'T1' ORDER BY id").all()).toEqual(groups);
  expect(db.prepare("SELECT * FROM translation_group_source_links ORDER BY group_id").all()).toEqual(links);
  expect((db.prepare("SELECT count(*) AS n FROM translation_content_revisions").get() as { n: number }).n - revisions.n).toBe(2);
  expect(db.prepare("SELECT sentences_json, links_json FROM translation_text_layouts WHERE version_id=?").get(after.translation!.versionId)).toEqual({ sentences_json: "[]", links_json: "[]" });
  expect(contentText(loadContent(db, before.translation!.versionId)!)).toBe(before.translation!.textContent);
});
it("merges independent stale-editor saves but rejects a competing edit to the same group atomically", () => {
  const { db, view, edit } = setup();
  edit(view(), "T1", "준비한 첫 문장.");
  const base = view();
  edit(base, "T1", "첫 사용자가 고친 문장.");
  const merged = edit(base, "T3", "다른 사용자가 고친 셋째 문장.");
  expect(merged.translation!.textContent).toBe("첫 사용자가 고친 문장.\n\n둘째 문장.\n다른 사용자가 고친 셋째 문장.");
  const n = db.prepare("SELECT count(*) AS n FROM document_translation_versions").get();
  expect(() => edit(base, "T1", "덮어쓰면 안 되는 문장.")).toThrow("변경되었습니다");
  expect(db.prepare("SELECT count(*) AS n FROM document_translation_versions").get()).toEqual(n);
  expect(view().translation!.textContent).toBe(merged.translation!.textContent);
});
it("deletes a paragraph break without merging source groups or rewriting their rows", () => {
  const { db, view, edit, save } = setup();
  edit(view(), "T1", "첫 수정 문장.");
  const base = view(), tr = base.translation!;
  const before = db.prepare("SELECT * FROM translation_groups ORDER BY id").all();
  const text = tr.textContent.replace("\n\n", " ");
  const sentences = tr.textLayout!.sentences.map((s, i) => i ? { ...s, from: s.from - 1, to: s.to - 1 } : s);
  const after = save(base, text, sentences);
  expect(after.translation!.textContent).toBe(text);
  expect(db.prepare("SELECT * FROM translation_groups ORDER BY id").all()).toEqual(before);
  expect(after.translation!.textLayout!.links).toEqual(tr.textLayout!.links);
});
it("keeps paragraphs independent through group merge, split, reopen, confirmation and export", () => {
  const { repo, db, id, view, edit, save } = setup();
  edit(view(), "T1", "첫 수정 문장.");
  const base = view(), tr = base.translation!, [a, b, c] = tr.textLayout!.sentences;
  const mergedRange = { ...a!, to: b!.to, text: Array.from(tr.textContent).slice(a!.from, b!.to).join("") };
  const mergedLinks = [{ ...tr.textLayout!.links[0]!, spans: [{ from: 0, to: 2, quote: "甲乙" }] }, tr.textLayout!.links[2]!];
  const merged = save(base, tr.textContent, [mergedRange, c!], mergedLinks);
  expect(merged.translation!.textContent).toBe(tr.textContent);
  expect(merged.translation!.textLayout!.sentences).toHaveLength(2);
  expect(loadContent(db, merged.translation!.versionId)!.parts.filter(p => p.kind === "whitespace").map(p => p.content)).toEqual(["\n\n", "\n"]);
  const split = save(merged, tr.textContent, [a!, { ...b!, id: "new-group" }, c!], [tr.textLayout!.links[0]!, { ...tr.textLayout!.links[1]!, sentenceId: "new-group", groupId: "new-group" }, tr.textLayout!.links[2]!]);
  expect(split.translation!.textLayout!.sentences).toHaveLength(3);
  expect(split.translation!.textContent).toBe(tr.textContent);
  repo.confirmTranslation({ documentNodeId: id, expectedLockVersion: split.translation!.lockVersion });
  expect(repo.createConfirmedExport({ documentNodeId: id, format: "markdown" }).content).toContain(tr.textContent);
  expect(repo.getDocumentHistory(id).entries.find(e => e.versionId === base.translation!.versionId)?.contentText).toBe(tr.textContent);
  repo.close();
  const reopened = openProject(repo.packagePath);
  try { expect(reopened.getEditor(id).translation!.textContent).toBe(tr.textContent); expect(reopened.getEditor(id).translation!.textLayout!.sentences).toHaveLength(3); }
  finally { reopened.close(); }
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
it("rejects omitted non-whitespace and preserves CRLF and supplementary codepoints exactly", () => {
  const { view, edit, save, db } = setup("첫 𠀀 문장.\r\n\r\n둘째 문장.\r\n셋째 문장.\r\n");
  const first = edit(view(), "T1", "첫 𠀀 문장 수정.");
  expect(contentText(loadContent(db, first.translation!.versionId)!)).toBe(first.translation!.textContent);
  expect(first.translation!.textContent).toContain("\r\n\r\n");
  expect(() => save(first, first.translation!.textContent, first.translation!.textLayout!.sentences.slice(1))).toThrow("누락");
});
it("keeps source correspondence editable after conversion and protects saved human links", () => {
  const { repo, id, view, edit } = setup();
  const converted = edit(view(), "T1", "첫 수정 문장.");
  repo.saveSentenceLink({ documentNodeId: id, versionId: converted.translation!.versionId, expectedLockVersion: converted.translation!.lockVersion, sentenceId: "T1", spans: [{ from: 0, to: 1, quote: "甲" }] });
  expect(view().translation!.textLayout!.links.find(l => l.sentenceId === "T1")?.reviewedBy).toBe("human");
  const prompt = repo.prepareAlignment(view().translation!.versionId);
  expect(prompt).toContain("첫 수정 문장.");
  expect(prompt).toContain('"sentenceId":"T1"');
  expect(() => edit(view(), "T2", "연결 중 수정.")).toThrow("연결이 끝난 뒤");
});
it("preserves confirmed entity identities when revising and projects links for all export readers", () => {
  const { repo, db, id, view, edit } = setup();
  const saved = edit(view(), "T1", "첫 수정 문장.");
  repo.confirmTranslation({ documentNodeId: id, expectedLockVersion: saved.translation!.lockVersion });
  const confirmed = view();
  const state = loadContent(db, confirmed.translation!.versionId)!;
  const revised = repo.reviseTranslation({ documentNodeId: id, expectedLockVersion: confirmed.translation!.lockVersion });
  expect(loadContent(db, revised.translation!.versionId)).toEqual(state);
  expect(repo.createReviewExport({ documentNodeId: id, format: "markdown", state: "current" }).content).toContain("첫 수정 문장");
  expect(repo.concordance({ query: "둘째", scope: "translation", state: "current" }).results.some(r => r.contextKind === "sentence" && r.sourceText === "乙")).toBe(true);
  const exported = JSON.parse(repo.createConfirmedExport({ documentNodeId: id, format: "json" }).content);
  expect(JSON.stringify(exported)).toContain('"sentenceId":"T2"');
  const online = repo.exportOnlineRows();
  expect(online.translation_content_parts).toBeUndefined();
  expect(online.translation_text_layouts!.find(r => r.version_id === confirmed.translation!.versionId)?.links_json).toContain('"sentenceId":"T2"');
  const changed = edit(revised, "T3", "수정본의 셋째 문장.");
  expect(changed.translation!.textContent).toContain("수정본의 셋째");
  expect(contentText(loadContent(db, confirmed.translation!.versionId)!)).toBe(confirmed.translation!.textContent);
});
it("retains accepted partial AI links if alignment fails or the project is reopened", () => {
  const { repo, db, id, view, edit } = setup();
  const saved = edit(view(), "T1", "첫 수정 문장.");
  const versionId = saved.translation!.versionId;
  repo.prepareAlignment(versionId);
  repo.submitAlignment(versionId, JSON.stringify({ schemaVersion: 1, versionId, links: [{ sentenceId: "T1", quotes: [{ text: "甲", occurrence: 1 }], needsReview: false }] }));
  expect(view().translation!.textLayout!.sentences).toHaveLength(3);
  expect(view().translation!.textLayout!.state).toBe("running");
  expect(loadContent(db, versionId)!.groups.find(g => g.id === "T1")?.needsReview).toBe(false);
  repo.close();
  const reopened = openProject(repo.packagePath);
  try {
    const tr = reopened.getEditor(id).translation!;
    expect(tr.textLayout!.state).toBe("failed");
    expect(tr.textLayout!.links.find(l => l.sentenceId === "T1")?.needsReview).toBe(false);
    reopened.prepareAlignment(versionId);
    const report = reopened.checkAlignment(versionId);
    expect(report.canFinish).toBe(true);
    reopened.finishAlignment(versionId, { revision: report.revision, outcome: "complete" });
    expect(reopened.getEditor(id).translation!.textLayout!.state).toBe("ready");
    expect(reopened.getEditor(id).translation!.textLayout!.sentences).toHaveLength(3);
  } finally { reopened.close(); }
});
it("rejects competing paragraph insertions at an empty boundary without duplicating whitespace", () => {
  const { view, save, edit } = setup("첫 문장. 둘째 문장. 셋째 문장.");
  edit(view(), "T1", "첫 수정 문장.");
  const old = view(), tr = old.translation!, [a, b, c] = tr.textLayout!.sentences;
  const joined = save(old, tr.textContent.replace(". 둘째", ".둘째"), [a!, { ...b!, from: b!.from - 1, to: b!.to - 1 }, { ...c!, from: c!.from - 1, to: c!.to - 1 }]);
  const base = joined.translation!, point = base.textLayout!.sentences[1]!.from;
  const text = Array.from(base.textContent).slice(0, point).join("") + "\n\n" + Array.from(base.textContent).slice(point).join("");
  const ranges = base.textLayout!.sentences.map((s, i) => i ? { ...s, from: s.from + 2, to: s.to + 2 } : s);
  save(joined, text, ranges);
  expect(() => save(joined, text, ranges)).toThrow("변경되었습니다");
  expect(view().translation!.textContent).toBe(text);
});
it("preserves inherited overlapping quote links during a text-only conversion", () => {
  const { repo, id, view, edit } = setup();
  const v = view().translation!;
  repo.completeAlignment(v.versionId, JSON.stringify({ schemaVersion: 1, versionId: v.versionId, links: [
    { sentenceId: "T1", quotes: [{ text: "甲乙", occurrence: 1 }], needsReview: false },
    { sentenceId: "T2", quotes: [{ text: "乙", occurrence: 1 }], needsReview: false },
    { sentenceId: "T3", quotes: [{ text: "丙", occurrence: 1 }], needsReview: false },
  ] }));
  const after = edit(view(), "T1", "겹친 연결을 보존하는 수정.");
  expect(after.translation!.textLayout!.links[0]!.spans).toEqual([{ from: 0, to: 2, quote: "甲乙" }]);
  expect(after.translation!.textLayout!.links[1]!.spans).toEqual([{ from: 1, to: 2, quote: "乙" }]);
  expect(after.translation!.textLayout!.state).toBe("needs_review");
});
it("normalizes a newly completed AI translation without another AI response or text change", () => {
  const { repo, db, view, text } = setup();
  const before = view().translation!;
  expect(loadContent(db, before.versionId)).toBeNull();
  const { messageId } = db.prepare("SELECT generated_by_message_id AS messageId FROM document_translation_versions WHERE id=?").get(before.versionId) as { messageId: string };
  repo.finishFullTextRun({ messageId, rawResponse: JSON.stringify({ schemaVersion: 1, translation: text }), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
  expect(loadContent(db, before.versionId)!.groups).toHaveLength(3);
  expect(view().translation!.textContent).toBe(before.textContent);
  expect(view().translation!.versionId).toBe(before.versionId);
  expect(view().translation!.textLayout!.links.map(l => l.spans)).toEqual(before.textLayout!.links.map(l => l.spans));
});
