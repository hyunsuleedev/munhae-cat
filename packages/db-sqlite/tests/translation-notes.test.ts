import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProject, openProject, sqlitePath, type ProjectRepo } from "../src/project-repo.ts";
import { openSqlite } from "../src/sqlite.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const TEXT = "𠮷 김황원처럼 울었다. 같은 말. 같은 말.";
const FOOTNOTES = [
  { target: { quote: "같은 말", occurrence: 2 }, kind: "interpretive", confidence: "probable", body: "둘째 구절의 해석.", alternatives: ["다른 독법"] },
  { target: { quote: "김황원처럼 울었다" }, source: { quote: "金黃元之哭" }, kind: "allusion", confidence: "certain", body: "부벽루에서 시를 잇지 못해 통곡한 일화." },
  { target: { quote: "번역에 없는 구절" }, kind: "textual", confidence: "unknown", body: "위치를 찾지 못한 각주." },
  { target: { quote: "같은 말" }, kind: "footnote", confidence: "certain", body: "없는 종류라 버린다." },
  "문자열 각주",
];

/** Codepoint offset of the nth occurrence, matching how translation ranges are stored. */
function at(text: string, quote: string, nth = 1): number {
  const t = Array.from(text), q = Array.from(quote);
  let seen = 0;
  for (let i = 0; i + q.length <= t.length; i++) {
    if (q.every((c, j) => t[i + j] === c) && ++seen === nth) return i;
  }
  throw new Error(`missing ${quote}`);
}
function setup() {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-notes-"));
  cleanup.push(() => rmSync(parentDir, { recursive: true, force: true }));
  const repo = createProject({ title: "각주", parentDir }).handle;
  cleanup.push(() => repo.close());
  const id = repo.createDocument({ title: "문서", nodeRole: "source_unit", sourceText: "幾欲爲金黃元之哭甚矣", originKind: "paste", parentId: null }).id;
  return { repo, id };
}
function submit(repo: ProjectRepo, id: string, payload: object) {
  const run = repo.beginFullTextRun({ documentNodeId: id, agentId: "codex", requestedModel: null, reasoningLevel: null, serviceTier: null, runtimeVersion: null });
  return repo.completeFullTextRun({ messageId: run.messageId, rawResponse: JSON.stringify(payload), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
}

it("asks for footnotes in the submission contract and forbids notes inside the translation", () => {
  const { repo, id } = setup();
  const preview = repo.previewContext({ documentNodeId: id });
  const contract = JSON.parse(preview.required.find(item => item.kind === "output_contract")!.content);
  expect(contract.properties.schemaVersion).toEqual({ const: 2 });
  expect(contract.properties.footnotes.items.properties.kind.enum).toEqual(["textual", "allusion", "identification", "interpretive"]);
  expect(preview.requestText).toContain("never as remarks or explanations inside `translation`");
});

it("saves footnotes at their quoted codepoint positions, keeps an unplaceable note and drops malformed ones", () => {
  const { repo, id } = setup();
  const result = submit(repo, id, { schemaVersion: 2, translation: TEXT, footnotes: FOOTNOTES, review: "중대한 수정 없음", stages: [{ label: "信", text: "초안" }] });
  expect(result).toMatchObject({ validationState: "valid", recoverableFindings: 2 });
  expect(repo.getEditor(id).translation!.textContent).toBe(TEXT);
  const notes = repo.getTranslationNotes(result.version.versionId);
  expect(notes.map(n => [n.ordinal, n.targetQuote, n.from, n.to])).toEqual([
    [1, "김황원처럼 울었다", at(TEXT, "김황원처럼 울었다"), at(TEXT, "김황원처럼 울었다") + 9],
    [2, "같은 말", at(TEXT, "같은 말", 2), at(TEXT, "같은 말", 2) + 4],
    [3, "번역에 없는 구절", null, null],
  ]);
  expect(notes[0]).toMatchObject({ kind: "allusion", confidence: "certain", sourceQuote: "金黃元之哭", alternatives: [], origin: "ai" });
  expect(notes[1]).toMatchObject({ kind: "interpretive", confidence: "probable", sourceQuote: null, alternatives: ["다른 독법"] });
  expect(repo.getEditor(id).translation!.notes).toEqual(notes);
  // Resubmitting the same run changes nothing.
  expect(submit(repo, id, { schemaVersion: 2, translation: "다른 번역.", footnotes: [] }).version.versionId).not.toBe(result.version.versionId);
  expect(repo.getTranslationNotes(result.version.versionId)).toEqual(notes);
});

it("still accepts a v1 submission and rejects unknown top-level fields", () => {
  const { repo, id } = setup();
  const v1 = submit(repo, id, { schemaVersion: 1, translation: TEXT });
  expect(repo.getTranslationNotes(v1.version.versionId)).toEqual([]);
  const run = repo.beginFullTextRun({ documentNodeId: id, agentId: "codex", requestedModel: null, reasoningLevel: null, serviceTier: null, runtimeVersion: null });
  const complete = (payload: object) => repo.completeFullTextRun({ messageId: run.messageId, rawResponse: JSON.stringify(payload), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
  expect(() => complete({ schemaVersion: 1, translation: TEXT, footnotes: [] })).toThrow(/허용된 키/);
  expect(() => complete({ schemaVersion: 2, translation: TEXT, notes: [] })).toThrow(/허용된 키/);
});

it("carries footnotes into an edited version, re-placing moved quotes, and leaves earlier versions untouched", () => {
  const { repo, id } = setup();
  const first = submit(repo, id, { schemaVersion: 2, translation: TEXT, footnotes: FOOTNOTES });
  const before = repo.getTranslationNotes(first.version.versionId);
  const edited = "앞 문장. 𠮷 김황원처럼 통곡했다. 같은 말. 같은 말.";
  repo.saveTranslationDraft({ documentNodeId: id, textContent: edited, blocks: [], expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  const version = repo.getEditor(id).translation!.versionId;
  const after = repo.getTranslationNotes(version);
  expect(after.map(n => [n.ordinal, n.targetQuote, n.from])).toEqual([
    [1, "같은 말", at(edited, "같은 말", 2)],
    [2, "김황원처럼 울었다", null],
    [3, "번역에 없는 구절", null],
  ]);
  expect(repo.getTranslationNotes(first.version.versionId)).toEqual(before);
  const db = openSqlite(sqlitePath(repo.packagePath)); cleanup.push(() => db.close());
  const lineage = db.prepare("SELECT previous_note_id FROM translation_notes WHERE version_id = ? ORDER BY ordinal").all(version) as Array<{ previous_note_id: string }>;
  expect(lineage.map(row => row.previous_note_id)).toEqual([before[1]!.id, before[0]!.id, before[2]!.id]);
});

it("keeps footnotes when a confirmed translation is reopened and after reopening the project", () => {
  const { repo, id } = setup();
  submit(repo, id, { schemaVersion: 2, translation: TEXT, footnotes: FOOTNOTES.slice(0, 2) });
  repo.confirmTranslation({ documentNodeId: id, expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  const confirmed = repo.getEditor(id).translation!;
  repo.reviseTranslation({ documentNodeId: id, expectedLockVersion: confirmed.lockVersion });
  const draft = repo.getEditor(id).translation!;
  expect(draft.versionId).not.toBe(confirmed.versionId);
  const strip = (notes: ReturnType<ProjectRepo["getTranslationNotes"]>) => notes.map(({ id: _id, ...note }) => note);
  expect(strip(repo.getTranslationNotes(draft.versionId))).toEqual(strip(repo.getTranslationNotes(confirmed.versionId)));
  const path = repo.packagePath;
  repo.close();
  const reopened = openProject(path); cleanup.push(() => reopened.close());
  expect(reopened.getTranslationNotes(draft.versionId)).toHaveLength(2);
});

it("gives a comment-driven retranslation the reviewed version's footnotes", () => {
  const { repo, id } = setup();
  const result = submit(repo, id, { schemaVersion: 2, translation: TEXT, footnotes: FOOTNOTES.slice(0, 2) });
  const versionId = result.version.versionId;
  const comment = repo.createReviewComment({ documentNodeId: id, translationVersionId: versionId, targetKind: "translation", targetVersionId: versionId,
    codepointFrom: at(TEXT, "울었다"), codepointTo: at(TEXT, "울었다") + 3, quote: "울었다", bodyMd: "통곡으로 고칠 것" });
  const preview = repo.previewContext({ documentNodeId: id, revision: { baseVersionId: versionId, commentIds: [comment.id] } });
  const section = preview.required.find(item => item.kind === "base_footnotes")!;
  expect(section.label).toBe("검토한 이전 번역의 각주");
  expect(section.content).toContain("부벽루에서 시를 잇지 못해 통곡한 일화.");
  expect(section.content).toContain("\"targetQuote\":\"김황원처럼 울었다\"");
});

it("lets a person add footnotes to the current draft, numbered by position, and delete them", () => {
  const { repo, id } = setup();
  const versionId = submit(repo, id, { schemaVersion: 2, translation: TEXT, footnotes: FOOTNOTES.slice(0, 2) }).version.versionId;
  const input = { documentNodeId: id, versionId, kind: "identification" as const, confidence: "certain" as const, alternatives: [] };
  const added = repo.createTranslationNote({ ...input, codepointFrom: 0, codepointTo: 1, quote: "𠮷", bodyMd: "확장 한자." });
  expect(added.map(n => [n.ordinal, n.targetQuote, n.origin])).toEqual([[1, "𠮷", "human"], [2, "김황원처럼 울었다", "ai"], [3, "같은 말", "ai"]]);
  // Whitespace picked up with a selection is not part of the phrase.
  const spaced = repo.createTranslationNote({ ...input, kind: "interpretive", confidence: "unknown", alternatives: ["  대안  ", ""],
    codepointFrom: at(TEXT, "같은 말") - 1, codepointTo: at(TEXT, "같은 말") + 4, quote: " 같은 말", bodyMd: "  첫 구절.  " });
  expect(spaced.find(n => n.bodyMd === "첫 구절.")).toMatchObject({ ordinal: 3, targetQuote: "같은 말", from: at(TEXT, "같은 말"), alternatives: ["대안"] });
  expect(repo.getEditor(id).translation!.notes!.map(n => n.ordinal)).toEqual([1, 2, 3, 4]);
  const remaining = repo.deleteTranslationNote({ documentNodeId: id, versionId, noteId: added[0]!.id });
  expect(remaining.map(n => [n.ordinal, n.targetQuote])).toEqual([[1, "김황원처럼 울었다"], [2, "같은 말"], [3, "같은 말"]]);
  expect(() => repo.deleteTranslationNote({ documentNodeId: id, versionId, noteId: added[0]!.id })).toThrow(/찾지 못했습니다/);
});

it("refuses footnote edits on a stale selection, an old version or a confirmed translation", () => {
  const { repo, id } = setup();
  const first = submit(repo, id, { schemaVersion: 2, translation: TEXT, footnotes: [] }).version.versionId;
  const input = { documentNodeId: id, versionId: first, kind: "allusion" as const, confidence: "certain" as const, alternatives: [], bodyMd: "내용" };
  expect(() => repo.createTranslationNote({ ...input, codepointFrom: 0, codepointTo: 1, quote: "김" })).toThrow(/맞지 않습니다/);
  expect(() => repo.createTranslationNote({ ...input, codepointFrom: 0, codepointTo: 1, quote: "𠮷", kind: "note" as never })).toThrow(/종류/);
  repo.saveTranslationDraft({ documentNodeId: id, textContent: `${TEXT} 끝.`, blocks: [], expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  expect(() => repo.createTranslationNote({ ...input, codepointFrom: 0, codepointTo: 1, quote: "𠮷" })).toThrow(/바뀌었습니다/);
  const current = repo.getEditor(id).translation!;
  repo.confirmTranslation({ documentNodeId: id, expectedLockVersion: current.lockVersion });
  expect(() => repo.createTranslationNote({ ...input, versionId: current.versionId, codepointFrom: 0, codepointTo: 1, quote: "𠮷" })).toThrow(/새 번역안으로 수정/);
});

it("lets a person rewrite a draft footnote in place, taking it over only when something changed", () => {
  const { repo, id } = setup();
  const versionId = submit(repo, id, { schemaVersion: 2, translation: TEXT, footnotes: FOOTNOTES.slice(0, 2) }).version.versionId;
  const [first, second] = repo.getTranslationNotes(versionId);
  const same = { documentNodeId: id, versionId, noteId: first!.id, kind: first!.kind, confidence: first!.confidence, bodyMd: first!.bodyMd, alternatives: first!.alternatives };
  expect(repo.updateTranslationNote(same)[0]).toEqual(first);
  const edited = repo.updateTranslationNote({ ...same, kind: "textual", confidence: "probable", bodyMd: "  고친 내용.  ", alternatives: ["다른 읽기", " "] });
  expect(edited[0]).toMatchObject({ id: first!.id, ordinal: 1, from: first!.from, kind: "textual", confidence: "probable", bodyMd: "고친 내용.", alternatives: ["다른 읽기"], origin: "human" });
  expect(edited[1]).toEqual(second);
  expect(() => repo.updateTranslationNote({ ...same, bodyMd: " " })).toThrow(/내용/);
  expect(() => repo.updateTranslationNote({ ...same, noteId: "missing" })).toThrow(/찾지 못했습니다/);
  repo.confirmTranslation({ documentNodeId: id, expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  expect(() => repo.updateTranslationNote(same)).toThrow(/새 번역안으로 수정/);
});
