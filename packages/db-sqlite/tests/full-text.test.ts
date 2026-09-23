import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createProject,
  ProjectRepo,
  sqlitePath,
  seedDemoProject,
  openProject,
} from "../src/project-repo.ts";
import { openSqlite } from "../src/sqlite.ts";
import { textSentences } from "../src/full-text.ts";
import { groupedTextSentences, replaceTextSentence } from "@munhae/domain/text-sentences";
import { BUNDLED_SKILLS } from "../src/bundled-skills.ts";
import { restoreV4KnowledgeFixture } from "./legacy-knowledge-fixture.ts";
const clean: Array<() => void> = [];
afterEach(() => {
  while (clean.length) clean.pop()!();
});
function setup(sourceText = "學而時習之不亦說乎有朋自遠方來不亦樂乎") {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-fulltext-"));
  clean.push(() => rmSync(parentDir, { recursive: true, force: true }));
  const repo = createProject({ title: "전문 번역", parentDir }).handle;
  clean.push(() => repo.close());
  const doc = repo.createDocument({
    title: "무표점",
    nodeRole: "source_unit",
    sourceText,
    originKind: "paste",
    parentId: null,
  });
  return { repo, id: doc.id };
}
function translate(
  repo: ProjectRepo,
  id: string,
  text = "배우고 때때로 익히면 기쁘지 않은가?\n\n벗이 먼 곳에서 찾아오면 즐겁지 않은가?",
) {
  const run = repo.beginFullTextRun({
    documentNodeId: id,
    agentId: "codex",
    requestedModel: null,
    reasoningLevel: null,
    serviceTier: null,
    runtimeVersion: null,
  });
  const input = {
    messageId: run.messageId,
    rawResponse: JSON.stringify({ schemaVersion: 1, translation: text }),
    eventsJsonl: "",
    usage: null,
    resolvedModel: null,
    runtimeVersion: null,
  };
  return { run, input, result: repo.completeFullTextRun(input), text };
}
it("bundles both skills verbatim and versions them", () => {
  for (const [name, text] of Object.entries(BUNDLED_SKILLS)) {
    expect(
      readFileSync(
        new URL(`../skills/${name}/SKILL.md`, import.meta.url),
        "utf8",
      ),
    ).toBe(text);
    expect(text).toContain(name === "align-translation" ? "version: 1.3.0" : "version: 1.0.0");
  }
});
it("saves consecutive sentence edits as one exact translation and preserves the previous version", () => {
  const { repo, id } = setup();
  const { text, result } = translate(repo, id, "첫 𠮷 문장.\n\n둘째 문장!  마지막 문장.\n");
  const before = repo.getEditor(id).translation!;
  const first = replaceTextSentence(text, before.textLayout!.sentences, "T1", "수정한 𠮷 문장.\n줄바꿈");
  const second = replaceTextSentence(first.text, first.sentences, "T2", "고친 둘째 문장!");
  repo.saveTranslationDraft({ documentNodeId: id, textContent: second.text, blocks: [], expectedLockVersion: before.lockVersion });
  const saved = repo.getEditor(id).translation!;
  expect(saved.textContent).toBe("수정한 𠮷 문장.\n줄바꿈\n\n고친 둘째 문장!  마지막 문장.\n");
  expect(saved.textLayout?.sentences).toEqual(textSentences(second.text));
  expect(saved.textLayout?.state).toBe("pending");
  expect(repo.getDocumentHistory(id).entries.find((entry) => entry.versionId === result.version.versionId)?.contentText).toBe(text);
  repo.close();
  const reopened = openProject(repo.packagePath);
  try { expect(reopened.getEditor(id).translation?.textContent).toBe(second.text); }
  finally { reopened.close(); }
});
it("translates unconfirmed, unpunctuated source and preserves exact paragraphs through save/history/reopen", () => {
  const { repo, id } = setup();
  const { result, text, input } = translate(repo, id);
  const e = repo.getEditor(id);
  expect(e.punctuation).toBeNull();
  expect(e.anchors).toEqual([]);
  expect(e.translation?.textContent).toBe(text);
  expect(e.translation?.isCurrentDependencies).toBe(true);
  expect(e.translation?.textLayout?.sentences).toHaveLength(2);
  expect(repo.completeFullTextRun(input).idempotent).toBe(true);
  const changed = text + "\n끝.";
  repo.saveTranslationDraft({
    documentNodeId: id,
    textContent: changed,
    blocks: [],
    expectedLockVersion: e.translation!.lockVersion,
  });
  const saved = repo.getEditor(id);
  expect(saved.translation?.textContent).toBe(changed);
  expect(saved.translation?.textLayout?.state).toBe("pending");
  repo.confirmTranslation({
    documentNodeId: id,
    expectedLockVersion: saved.translation!.lockVersion,
  });
  expect(repo.getEditor(id).translation?.state).toBe("confirmed");
  expect(
    repo
      .getDocumentHistory(id)
      .entries.find((v) => v.versionId === result.version.versionId)
      ?.contentText,
  ).toBe(text);
  for (const format of ["json", "markdown", "csv"] as const)
    expect(
      repo.createConfirmedExport({ format, documentNodeId: id }).content,
    ).toContain(
      format === "json" ? JSON.stringify(changed).slice(1, -1) : changed,
    );
  const db = openSqlite(sqlitePath(repo.packagePath));
  try {
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
    expect(
      db
        .prepare(
          "SELECT text_content FROM document_translation_versions WHERE id=?",
        )
        .get(result.version.versionId),
    ).toEqual({ text_content: text });
  } finally {
    db.close();
  }
});
it("matches after translation without rewriting and rejects out of range or stale results", () => {
  const { repo, id } = setup();
  const { result, text } = translate(repo, id);
  const versionId = result.version.versionId;
  const prompt = repo.prepareAlignment(versionId);
  expect(prompt).toContain(text);
  expect(prompt).toContain("submit-alignment");
  const links = [
    {
      sentenceId: "T1",
      quotes: [{ text: "學而時習之不亦說乎", occurrence: 1 }],
      needsReview: false,
    },
    {
      sentenceId: "T2",
      quotes: [{ text: "有朋自遠方來不亦樂乎", occurrence: 1 }],
      needsReview: false,
    },
  ];
  expect(() =>
    repo.completeAlignment(
      versionId,
      JSON.stringify({
        schemaVersion: 1,
        versionId,
        links,
        translation: "changed",
      }),
    ),
  ).toThrow();
  expect(
    repo.completeAlignment(
      versionId,
      JSON.stringify({ schemaVersion: 1, versionId, links }),
    ),
  ).toBe("ready");
  expect(repo.getEditor(id).translation?.textContent).toBe(text);
  repo.saveTranslationDraft({
    documentNodeId: id,
    textContent: text + " 추가.",
    blocks: [],
    expectedLockVersion: repo.getEditor(id).translation!.lockVersion,
  });
  expect(() =>
    repo.completeAlignment(
      versionId,
      JSON.stringify({ schemaVersion: 1, versionId, links }),
    ),
  ).toThrow(/번역이 수정/);
});
it("keeps saved translation when matching fails and marks uncovered source for review", () => {
  const { repo, id } = setup();
  const { result, text } = translate(repo, id, "번역.");
  const versionId = result.version.versionId;
  repo.prepareAlignment(versionId);
  repo.failAlignment(versionId, "중단");
  expect(repo.getEditor(id).translation?.textContent).toBe(text);
  repo.prepareAlignment(versionId);
  expect(
    repo.completeAlignment(
      versionId,
      JSON.stringify({
        schemaVersion: 1,
        versionId,
        links: [
          {
            sentenceId: "T1",
            quotes: [{ text: "學而", occurrence: 1 }],
            needsReview: false,
          },
        ],
      }),
    ),
  ).toBe("needs_review");
});
it("rejects late translation when source or target changed", () => {
  const { repo, id } = setup();
  const run = repo.beginFullTextRun({
    documentNodeId: id,
    agentId: "codex",
    requestedModel: null,
    reasoningLevel: null,
    serviceTier: null,
    runtimeVersion: null,
  });
  repo.saveSourceDraft({
    documentNodeId: id,
    contentText: "다른 원문",
    originKind: "manual",
    expectedLockVersion: repo.getEditor(id).source.lockVersion,
  });
  expect(() =>
    repo.completeFullTextRun({
      messageId: run.messageId,
      rawResponse: JSON.stringify({ schemaVersion: 1, translation: "번역" }),
      eventsJsonl: "",
      usage: null,
      resolvedModel: null,
      runtimeVersion: null,
    }),
  ).toThrow(/원문이 변경/);
});
it("records positions without losing whitespace, decimals or supplementary characters", () => {
  const text = "첫 문장 3.14이다.\n\n「다음 문장이다.」 𠀀 끝!";
  const sentences = textSentences(text);
  expect(sentences).toHaveLength(3);
  for (const s of sentences)
    expect(Array.from(text).slice(s.from, s.to).join("")).toBe(s.text);
});

it("upgrades an actual v1 table without losing legacy history and creates a pre-upgrade backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "munhae-upgrade-"));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = seedDemoProject(dir);
  const path = repo.packagePath;
  const id = repo
    .getHome()
    .documents.find((d) => d.originalTitle === "御製序")!.id;
  const before = repo.getDocumentHistory(id);
  repo.close();
  const db = openSqlite(sqlitePath(path));
  restoreV4KnowledgeFixture(db);
  const baseline = readFileSync(
    new URL("../migrations/sqlite/001_init.sql", import.meta.url),
    "utf8",
  );
  const table = baseline
    .match(
      /CREATE TABLE document_translation_versions \([\s\S]*?\) STRICT;/,
    )![0]
    .replace(
      "CREATE TABLE document_translation_versions (",
      "CREATE TABLE versions_v1 (",
    );
  db.pragma("foreign_keys = OFF");
  db.exec("DROP TABLE review_comments; DROP TABLE translation_text_layouts");
  db.exec(table);
  db.exec(
    "INSERT INTO versions_v1 SELECT * FROM document_translation_versions; DROP TABLE document_translation_versions; ALTER TABLE versions_v1 RENAME TO document_translation_versions; ALTER TABLE context_items ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'external_evidence'; DELETE FROM meta_schema_migrations WHERE version>=2; UPDATE meta_project_state SET schema_version=1;",
  );
  db.close();
  const reopened = openProject(path);
  clean.push(() => reopened.close());
  expect(reopened.getDocumentHistory(id)).toEqual(before);
  expect(
    readdirSync(path).filter((n) => n.includes(".before-full-text-")),
  ).toHaveLength(1);
  const check = openSqlite(sqlitePath(path));
  try {
    expect(check.pragma("foreign_key_check")).toEqual([]);
    expect(check.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
    expect(
      check.prepare("SELECT schema_version FROM meta_project_state").get(),
    ).toEqual({ schema_version: 10 });
  } finally {
    check.close();
  }
});

it("resolves repeated quotes by occurrence and supports overlapping many-to-many links", () => {
  const { repo, id } = setup();
  repo.saveSourceDraft({ documentNodeId: id, contentText: "𠀀甲乙甲乙", originKind: "manual", expectedLockVersion: repo.getEditor(id).source.lockVersion });
  const { result } = translate(repo, id, "하나. 둘. 셋.");
  const versionId = result.version.versionId;
  const links = [
    { sentenceId: "T1", quotes: [{ text: "甲乙", occurrence: 2 }], needsReview: false },
    { sentenceId: "T2", quotes: [{ text: "甲乙", occurrence: 2 }], needsReview: false },
    { sentenceId: "T3", quotes: [{ text: "𠀀", occurrence: 1 }, { text: "甲乙", occurrence: 1 }], needsReview: false },
  ];
  expect(repo.completeAlignment(versionId, JSON.stringify({schemaVersion: 1, versionId, links}))).toBe("ready");
  expect(repo.getEditor(id).translation!.textLayout!.links[0]!.spans[0]).toEqual({from: 3, to: 5, quote: "甲乙"});
});

it("refuses to silently rebase a manual translation onto changed source", () => {
  const {repo,id}=setup();translate(repo,id);
  const before=repo.getEditor(id);
  repo.saveSourceDraft({documentNodeId:id,contentText:"새 원문",originKind:"manual",expectedLockVersion:before.source.lockVersion});
  expect(()=>repo.saveTranslationDraft({documentNodeId:id,textContent:"이전 원문을 보고 편집한 번역",blocks:[],expectedLockVersion:before.translation!.lockVersion})).toThrow(/원문이 변경/);
  expect(repo.getEditor(id).translation!.versionId).toBe(before.translation!.versionId);
});

it("carries exact unchanged many-to-many links across shifted IDs and persists them without altering history", () => {
  const { repo, id } = setup();
  const { result } = translate(repo, id, "첫 문장.\n\n둘째 문장.\n셋째 문장.");
  const versionId = result.version.versionId;
  repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 1, versionId, links: [
    { sentenceId: "T1", quotes: [{ text: "學而時習之不亦說乎", occurrence: 1 }], needsReview: false },
    { sentenceId: "T2", quotes: [{ text: "有朋自遠方來不亦樂乎", occurrence: 1 }], needsReview: false },
    { sentenceId: "T3", quotes: [{ text: "學而", occurrence: 1 }, { text: "有朋", occurrence: 1 }], needsReview: true },
  ] }));
  const before = repo.getEditor(id).translation!;
  const text = "고친 첫 문장.\n추가한 문장.\n\n둘째 문장.\n셋째 문장.";
  repo.saveTranslationDraft({ documentNodeId: id, textContent: text, blocks: [], expectedLockVersion: before.lockVersion });
  const saved = repo.getEditor(id).translation!;
  expect(saved.textLayout?.sentences).toEqual(textSentences(text));
  expect(saved.textLayout?.links).toEqual([
    { sentenceId: "T1", spans: [], needsReview: true },
    { sentenceId: "T2", spans: [], needsReview: true },
    { ...before.textLayout!.links[1], sentenceId: "T3" },
    { ...before.textLayout!.links[2], sentenceId: "T4" },
  ]);
  expect(saved.textLayout?.state).toBe("needs_review");
  expect(repo.getDocumentHistory(id).entries.find((entry) => entry.versionId === versionId)?.contentText).toBe(before.textContent);
  const db = openSqlite(sqlitePath(repo.packagePath));
  try {
    const original = db.prepare("SELECT links_json FROM translation_text_layouts WHERE version_id=?").get(versionId) as { links_json: string };
    expect(JSON.parse(original.links_json)).toEqual(before.textLayout!.links);
  } finally { db.close(); }
  repo.close();
  const reopened = openProject(repo.packagePath);
  try { expect(reopened.getEditor(id).translation?.textLayout).toEqual(saved.textLayout); }
  finally { reopened.close(); }
});

it("preserves repeated sentence links when revising an unchanged confirmed translation", () => {
  const { repo, id } = setup();
  const { result } = translate(repo, id, "같다.\n같다.");
  const versionId = result.version.versionId;
  repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 1, versionId, links: [
    { sentenceId: "T1", quotes: [{ text: "學而時習之不亦說乎", occurrence: 1 }], needsReview: false },
    { sentenceId: "T2", quotes: [{ text: "有朋自遠方來不亦樂乎", occurrence: 1 }], needsReview: false },
  ] }));
  repo.confirmTranslation({ documentNodeId: id, expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  const confirmed = repo.getEditor(id).translation!;
  repo.reviseTranslation({ documentNodeId: id, expectedLockVersion: confirmed.lockVersion });
  const draft = repo.getEditor(id).translation!;
  expect(draft.versionId).not.toBe(versionId);
  expect(draft.state).toBe("draft");
  expect(draft.textLayout).toEqual(confirmed.textLayout);
  expect(draft.textLayout?.state).toBe("ready");
  expect(repo.getDocumentHistory(id).entries.find((entry) => entry.versionId === versionId)?.state).toBe("confirmed");
});

it("leaves repeated sentences unlinked after an ambiguous deletion", () => {
  const { repo, id } = setup();
  const { result } = translate(repo, id, "같다.\n같다.\n고유하다.");
  const versionId = result.version.versionId;
  repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 1, versionId, links: [
    { sentenceId: "T1", quotes: [{ text: "學而", occurrence: 1 }], needsReview: false },
    { sentenceId: "T2", quotes: [{ text: "時習之不亦說乎", occurrence: 1 }], needsReview: false },
    { sentenceId: "T3", quotes: [{ text: "有朋自遠方來不亦樂乎", occurrence: 1 }], needsReview: false },
  ] }));
  const before = repo.getEditor(id).translation!;
  repo.saveTranslationDraft({ documentNodeId: id, textContent: "같다.\n고유하다.", blocks: [], expectedLockVersion: before.lockVersion });
  expect(repo.getEditor(id).translation?.textLayout?.links).toEqual([
    { sentenceId: "T1", spans: [], needsReview: true },
    { ...before.textLayout!.links[2], sentenceId: "T2" },
  ]);
});

it("keeps missing source coverage visible after deleting a uniquely linked sentence", () => {
  const { repo, id } = setup();
  const { result } = translate(repo, id, "첫 문장.\n둘째 문장.");
  const versionId = result.version.versionId;
  repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 1, versionId, links: [
    { sentenceId: "T1", quotes: [{ text: "學而時習之不亦說乎", occurrence: 1 }], needsReview: false },
    { sentenceId: "T2", quotes: [{ text: "有朋自遠方來不亦樂乎", occurrence: 1 }], needsReview: false },
  ] }));
  const before = repo.getEditor(id).translation!;
  repo.saveTranslationDraft({ documentNodeId: id, textContent: "둘째 문장.", blocks: [], expectedLockVersion: before.lockVersion });
  const saved = repo.getEditor(id).translation!;
  expect(saved.textLayout?.links).toEqual([{ ...before.textLayout!.links[1], sentenceId: "T1" }]);
  expect(saved.textLayout?.state).toBe("needs_review");
  expect(saved.textLayout?.error).toMatch(/연결되지 않은 원문/);
});

it("persists human many-to-many corrections with exact Unicode ranges while keeping confirmed text and history immutable", () => {
  const { repo, id } = setup();
  repo.saveSourceDraft({ documentNodeId: id, contentText: "𠀀甲乙甲乙", originKind: "manual", expectedLockVersion: repo.getEditor(id).source.lockVersion });
  translate(repo, id, "하나.\n둘.");
  repo.confirmTranslation({ documentNodeId: id, expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  const before = repo.getEditor(id).translation!, history = repo.getDocumentHistory(id);
  const first = repo.saveSentenceLink({ documentNodeId: id, versionId: before.versionId, sentenceId: "T1",
    spans: [{ from: 0, to: 1, quote: "𠀀" }, { from: 3, to: 5, quote: "甲乙" }], expectedLockVersion: before.lockVersion }).translation!;
  expect(first.textLayout?.links).toEqual([
    { sentenceId: "T1", spans: [{ from: 0, to: 1, quote: "𠀀" }, { from: 3, to: 5, quote: "甲乙" }], needsReview: false, reviewedBy: "human" },
    { sentenceId: "T2", spans: [], needsReview: true },
  ]);
  expect(first.textLayout?.state).toBe("needs_review");
  const saved = repo.saveSentenceLink({ documentNodeId: id, versionId: before.versionId, sentenceId: "T2",
    spans: [{ from: 1, to: 5, quote: "甲乙甲乙" }], expectedLockVersion: first.lockVersion }).translation!;
  expect(saved.textLayout?.state).toBe("ready");
  expect(saved.textLayout?.error).toBeNull();
  expect(saved.lockVersion).toBe(before.lockVersion + 2);
  expect(saved.versionId).toBe(before.versionId);
  expect(saved.textContent).toBe(before.textContent);
  expect(saved.state).toBe("confirmed");
  expect(repo.getDocumentHistory(id)).toEqual(history);
  repo.close();
  const reopened = openProject(repo.packagePath);
  try { expect(reopened.getEditor(id).translation?.textLayout).toEqual(saved.textLayout); }
  finally { reopened.close(); }
});

it("rejects invalid manual quotes and stale locks without partially changing a layout", () => {
  const { repo, id } = setup();
  translate(repo, id);
  const before = repo.getEditor(id).translation!;
  const input = { documentNodeId: id, versionId: before.versionId, sentenceId: "T1", spans: [{ from: 0, to: 2, quote: "學而" }], expectedLockVersion: before.lockVersion };
  for (const invalid of [
    { spans: [] }, { spans: [{ from: -1, to: 1, quote: "學而" }] },
    { spans: [{ from: 0, to: 99, quote: repo.getEditor(id).source.contentText }] },
    { spans: [{ from: 0, to: 2, quote: "時習" }] },
    { spans: [{ from: 0.5, to: 2, quote: "學而" }] },
    { sentenceId: "T999" }, { versionId: "another-version" }, { expectedLockVersion: 0 },
  ]) {
    expect(() => repo.saveSentenceLink({ ...input, ...invalid })).toThrow();
    expect(repo.getEditor(id).translation).toEqual(before);
  }
  repo.saveSentenceLink(input);
  expect(() => repo.saveSentenceLink(input)).toThrow(/번역안이 변경/);
  const current = repo.getEditor(id).translation!;
  repo.saveSourceDraft({ documentNodeId: id, contentText: "새 원문", originKind: "manual", expectedLockVersion: repo.getEditor(id).source.lockVersion });
  expect(() => repo.saveSentenceLink({ ...input, expectedLockVersion: current.lockVersion })).toThrow(/원문 또는 번역/);
  expect(repo.getEditor(id).translation?.textLayout).toEqual(current.textLayout);
});

it("does not accept a version from another document or the previous translation head", () => {
  const { repo, id } = setup();
  translate(repo, id);
  const before = repo.getEditor(id).translation!;
  const input = { documentNodeId: id, versionId: before.versionId, sentenceId: "T1", spans: [{ from: 0, to: 2, quote: "學而" }], expectedLockVersion: before.lockVersion };
  const other = repo.createDocument({ title: "다른 문서", nodeRole: "source_unit", sourceText: "學而", originKind: "paste", parentId: null });
  translate(repo, other.id);
  expect(() => repo.saveSentenceLink({ ...input, documentNodeId: other.id })).toThrow(/원문 또는 번역/);
  repo.saveTranslationDraft({ documentNodeId: id, textContent: before.textContent + " 새 문장.", blocks: [], expectedLockVersion: before.lockVersion });
  expect(() => repo.saveSentenceLink({ ...input, expectedLockVersion: repo.getEditor(id).translation!.lockVersion })).toThrow(/원문 또는 번역/);
});

it("waits for active automatic alignment and preserves human corrections when AI is rerun", () => {
  const { repo, id } = setup();
  const { result } = translate(repo, id);
  const versionId = result.version.versionId;
  const input = { documentNodeId: id, versionId, sentenceId: "T1", spans: [{ from: 0, to: 2, quote: "學而" }], expectedLockVersion: repo.getEditor(id).translation!.lockVersion };
  repo.prepareAlignment(versionId);
  expect(() => repo.saveSentenceLink(input)).toThrow(/자동 원문 연결/);
  repo.failAlignment(versionId, "취소됨");
  repo.saveSentenceLink(input);
  const corrected = repo.getEditor(id).translation!.textLayout!.links[0];
  repo.prepareAlignment(versionId);
  repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 1, versionId, links: [
    { sentenceId: "T1", quotes: [{ text: "學而時習之不亦說乎", occurrence: 1 }], needsReview: false },
    { sentenceId: "T2", quotes: [{ text: "時習之不亦說乎有朋自遠方來不亦樂乎", occurrence: 1 }], needsReview: false },
  ] }));
  expect(repo.getEditor(id).translation!.textLayout!.links[0]).toEqual(corrected);
  expect(repo.getEditor(id).translation!.textLayout!.links[1]?.reviewedBy).toBeUndefined();
});

it("carries human correspondence confirmation only while the matched translation sentence is unchanged", () => {
  const { repo, id } = setup();
  translate(repo, id, "첫 문장.\n둘째 문장.");
  const before = repo.getEditor(id).translation!;
  repo.saveSentenceLink({ documentNodeId: id, versionId: before.versionId, sentenceId: "T2", spans: [{ from: 0, to: 2, quote: "學而" }], expectedLockVersion: before.lockVersion });
  repo.saveTranslationDraft({ documentNodeId: id, textContent: "새 문장.\n첫 문장.\n둘째 문장.", blocks: [], expectedLockVersion: repo.getEditor(id).translation!.lockVersion });
  const carried = repo.getEditor(id).translation!;
  expect(carried.textLayout?.links[2]).toMatchObject({ sentenceId: "T3", reviewedBy: "human", needsReview: false });
  repo.saveTranslationDraft({ documentNodeId: id, textContent: "새 문장.\n첫 문장.\n고친 둘째 문장.", blocks: [], expectedLockVersion: carried.lockVersion });
  expect(repo.getEditor(id).translation!.textLayout!.links[2]).toEqual({ sentenceId: "T3", spans: [], needsReview: true });
});

it("keeps Korean and English translation heads separate and requests the selected target", () => {
  const { repo, id } = setup();
  const korean = translate(repo, id);
  const koreanVersion = repo.getEditor(id).translation!.versionId;
  repo.setTranslationLanguage("en");
  expect(repo.getEditor(id).translation).toBeNull();
  const english = translate(repo, id, "Is it not a pleasure to learn and practice?\n\nIs it not a joy to welcome friends from afar?");
  const englishVersion = repo.getEditor(id).translation!.versionId;
  expect(englishVersion).not.toBe(koreanVersion);
  expect(repo.getEditor(id).translation!.textContent).toBe(english.text);
  expect(JSON.stringify(english.run)).toContain("English");
  repo.setTranslationLanguage("ko");
  expect(repo.getEditor(id).translation!.versionId).toBe(koreanVersion);
  expect(repo.getEditor(id).translation!.textContent).toBe(korean.text);
  repo.setTranslationLanguage("en");
  expect(repo.getEditor(id).translation!.versionId).toBe(englishVersion);
  expect(() => repo.setTranslationLanguage("fr" as "en")).toThrow();
  const path = repo.packagePath;
  repo.close();
  const reopened = openProject(path);
  clean.push(() => reopened.close());
  reopened.setTranslationLanguage("en");
  expect(reopened.getEditor(id).translation!.versionId).toBe(englishVersion);
  reopened.setTranslationLanguage("ko");
  expect(reopened.getEditor(id).translation!.versionId).toBe(koreanVersion);
});

function punctuatedTranslation(source?: string, punctuation = "學而時習之，不亦說乎。有朋自遠方來，不亦樂乎。") {
  const { repo, id } = setup(source);
  let editor = repo.getEditor(id);
  editor = repo.confirmSource({ documentNodeId: id, expectedLockVersion: editor.source.lockVersion });
  editor = repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: id, structureMode: "prose", expectedSourceLockVersion: editor.source.lockVersion });
  editor = repo.savePunctuationDraft({ documentNodeId: id, punctuatedText: punctuation, structureMode: "prose", expectedLockVersion: editor.punctuation!.lockVersion });
  editor = repo.confirmPunctuation({ documentNodeId: id, expectedLockVersion: editor.punctuation!.lockVersion });
  const { result } = translate(repo, id, "첫 번역. 둘째 번역. 셋째 번역.");
  const versionId = result.version.versionId;
  return { repo, id, versionId, punctuationVersionId: editor.punctuation!.versionId };
}
it("groups target lines without sharing source across groups and leaves translation unchanged", () => {
  const { repo, id, versionId, punctuationVersionId } = punctuatedTranslation();
  const before = repo.getEditor(id).translation!.textContent;
  const prompt = repo.prepareAlignment(versionId);
  expect(prompt).toContain("[a1]學而時習之，不亦說乎。[a2]有朋自遠方來，不亦樂乎。[a3]");
  repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 3, versionId, punctuationVersionId, links: [
    { sentenceIds: ["T1", "T2"], ranges: [{ start: "a1", end: "a2" }], needsReview: false },
    { sentenceIds: ["T3"], ranges: [{ start: "a2", end: "a3" }], needsReview: false },
  ] }));
  const editor = repo.getEditor(id);
  expect(editor.translation!.textContent).toBe(before);
  expect(editor.translation!.textLayout!.links.map(l => l.spans[0]?.quote)).toEqual([
    "學而時習之不亦說乎", "學而時習之不亦說乎", "有朋自遠方來不亦樂乎",
  ]);
  expect(editor.translation!.textLayout!.state).toBe("ready");
});
it.each([{ start: "a0", end: "a2" }, { start: "a2", end: "a1" }, { start: "a2", end: "a2" }])("rejects invalid boundary ranges atomically: %j", range => {
  const { repo, id, versionId, punctuationVersionId } = punctuatedTranslation();
  repo.prepareAlignment(versionId);
  expect(() => repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 3, versionId, punctuationVersionId, links: [
    { sentenceIds: ["T1"], ranges: [range], needsReview: false },
  ] }))).toThrow();
  expect(repo.getEditor(id).translation!.textLayout!.links).toEqual([]);
});
it("rejects stale punctuation and quote-mode responses for a boundary request", () => {
  const { repo, id, versionId, punctuationVersionId } = punctuatedTranslation();
  repo.prepareAlignment(versionId);
  expect(() => repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 1, versionId, links: [] }))).toThrow();
  const editor = repo.getEditor(id);
  repo.savePunctuationDraft({ documentNodeId: id, punctuatedText: "學而時習之不亦說乎，有朋自遠方來不亦樂乎。", structureMode: "prose", expectedLockVersion: editor.punctuation!.lockVersion });
  expect(() => repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 3, versionId, punctuationVersionId, links: [] }))).toThrow(/표점/);
});
it("keeps exact-quote alignment when no confirmed punctuation was used", () => {
  const { repo, id } = setup();
  const { result } = translate(repo, id);
  const prompt = repo.prepareAlignment(result.version.versionId);
  expect(prompt).toContain("exact quotes must come from this text");
  expect(prompt).not.toContain("## Alignment mode\nboundary-groups.v3");
});

it("maps supplementary characters, existing punctuation and reflowed whitespace back to exact source ranges", () => {
  const { repo, id, versionId, punctuationVersionId } = punctuatedTranslation("𠀀甲。\n乙丙丁  ", "𠀀甲。乙丙。丁。");
  expect(repo.prepareAlignment(versionId)).toContain("[a1]𠀀甲。[a2]乙丙。[a3]丁。[a4]");
  repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 3, versionId, punctuationVersionId, links: [
    { sentenceIds: ["T1"], ranges: [{ start: "a1", end: "a2" }, { start: "a3", end: "a4" }], needsReview: false },
    { sentenceIds: ["T2"], ranges: [{ start: "a2", end: "a3" }], needsReview: false },
    { sentenceIds: ["T3"], ranges: [], needsReview: true },
  ] }));
  const layout = repo.getEditor(id).translation!.textLayout!;
  expect(layout.links[0]!.spans).toEqual([{ from: 0, to: 3, quote: "𠀀甲。" }, { from: 6, to: 9, quote: "丁  " }]);
  expect(layout.links[1]!.spans).toEqual([{ from: 3, to: 6, quote: "\n乙丙" }]);
  expect(layout.state).toBe("needs_review");
});
it("uses the source end as a final boundary even without a terminal full stop", () => {
  const { repo, versionId } = punctuatedTranslation("甲乙丙", "甲。乙丙");
  expect(repo.prepareAlignment(versionId)).toContain("[a1]甲。[a2]乙丙[a3]");
});
it("does not use an unconfirmed punctuation draft for boundary alignment", () => {
  const { repo, id } = setup();
  let editor = repo.getEditor(id);
  editor = repo.confirmSource({ documentNodeId: id, expectedLockVersion: editor.source.lockVersion });
  repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: id, structureMode: "prose", expectedSourceLockVersion: editor.source.lockVersion });
  const { result } = translate(repo, id);
  expect(repo.prepareAlignment(result.version.versionId)).not.toContain("## Alignment mode\nboundary-groups.v3");
});

it.each([
  [{ sentenceIds: ["T1", "T2"], ranges: [{ start: "a1", end: "a3" }], needsReview: false }, { sentenceIds: ["T3"], ranges: [{ start: "a2", end: "a3" }], needsReview: false }],
  [{ sentenceIds: ["T1", "T1", "T2", "T3"], ranges: [{ start: "a1", end: "a3" }], needsReview: false }],
  [{ sentenceIds: ["T1", "T2", "T3"], ranges: [{ start: "a1", end: "a3" }, { start: "a1", end: "a2" }], needsReview: false }],
])("rejects duplicate target ownership and overlapping source ownership: %j", (...items) => {
  const { repo, id, versionId, punctuationVersionId } = punctuatedTranslation();
  repo.prepareAlignment(versionId);
  expect(() => repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 3, versionId, punctuationVersionId, links: items }))).toThrow();
  expect(repo.getEditor(id).translation!.textLayout!.links).toEqual([]);
});
it("edits a whole group, rejects manual cross-group overlaps and invalidates groups changed by text edits", () => {
  const { repo, id, versionId, punctuationVersionId } = punctuatedTranslation();
  repo.prepareAlignment(versionId);
  repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 3, versionId, punctuationVersionId, links: [
    { sentenceIds: ["T1", "T2"], ranges: [{ start: "a1", end: "a2" }], needsReview: false },
    { sentenceIds: ["T3"], ranges: [{ start: "a2", end: "a3" }], needsReview: false },
  ] }));
  let t = repo.getEditor(id).translation!;
  expect(t.textLayout!.links[0]!.groupId).toBe(t.textLayout!.links[1]!.groupId);
  expect(t.textLayout!.links[0]!.groupId).not.toBe(t.textLayout!.links[2]!.groupId);
  expect(() => repo.saveSentenceLink({ documentNodeId: id, versionId, sentenceId: "T1", expectedLockVersion: t.lockVersion, spans: t.textLayout!.links[2]!.spans })).toThrow(/중복/);
  repo.saveSentenceLink({ documentNodeId: id, versionId, sentenceId: "T1", expectedLockVersion: t.lockVersion, spans: t.textLayout!.links[0]!.spans });
  t = repo.getEditor(id).translation!;
  expect(t.textLayout!.links.slice(0, 2).map(l => l.reviewedBy)).toEqual(["human", "human"]);
  repo.saveTranslationDraft({ documentNodeId: id, textContent: "바뀐 번역. 둘째 번역. 셋째 번역.", blocks: [], expectedLockVersion: t.lockVersion });
  const links = repo.getEditor(id).translation!.textLayout!.links;
  expect(links[0]!.spans).toEqual([]);
  expect(links[1]!.spans).toEqual([]);
  expect(links.every(link => !!link.groupId)).toBe(true);
  expect(links[2]!.spans.length).toBe(1);
});

it("keeps editing group identity and source through multiline edits, save, and reopen", () => {
  const { repo, id, versionId, punctuationVersionId } = punctuatedTranslation();
  repo.prepareAlignment(versionId);
  repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 3, versionId, punctuationVersionId, links: [
    { sentenceIds: ["T1", "T2"], ranges: [{ start: "a1", end: "a2" }], needsReview: false },
    { sentenceIds: ["T3"], ranges: [{ start: "a2", end: "a3" }], needsReview: false },
  ] }));
  const before = repo.getEditor(id).translation!;
  const links = before.textLayout!.links;
  const groups = [
    { id: links[0]!.groupId!, text: "수정한 𠮷 번역.\n새 문장!\n\n", spans: links[0]!.spans },
    { id: links[2]!.groupId!, text: before.textLayout!.sentences[2]!.text, spans: links[2]!.spans },
  ];
  const saved = repo.saveTranslationDraft({ documentNodeId: id, textContent: groups.map(g => g.text).join(""), textGroups: groups, blocks: [], expectedLockVersion: before.lockVersion }).translation!;
  expect(saved.textLayout!.sentences.map(s => s.text)).toEqual(groups.map(g => g.text));
  expect(saved.textLayout!.links.map(l => l.groupId)).toEqual(groups.map(g => g.id));
  expect(saved.textLayout!.links.map(l => l.spans)).toEqual(groups.map(g => g.spans));
  expect(saved.textLayout!.links.map(l => l.needsReview)).toEqual([true, false]);
  const unchanged = repo.saveTranslationDraft({ documentNodeId: id, textContent: saved.textContent, blocks: [], expectedLockVersion: saved.lockVersion }).translation!;
  expect(unchanged.textLayout!.sentences).toEqual(saved.textLayout!.sentences);
  expect(repo.getDocumentHistory(id).entries.find(e => e.versionId === versionId)?.contentText).toBe(before.textContent);
  expect(() => repo.saveTranslationDraft({ documentNodeId: id, textContent: groups.map(g => g.text).join(""), textGroups: [groups[0]!, { ...groups[1]!, spans: groups[0]!.spans }], blocks: [], expectedLockVersion: unchanged.lockVersion })).toThrow();
  expect(repo.getEditor(id).translation!.versionId).toBe(unchanged.versionId);
});

it("persists explicit merge and split with exclusive source ranges and unchanged translation text", () => {
  const { repo, id, versionId, punctuationVersionId } = punctuatedTranslation();
  repo.prepareAlignment(versionId);
  repo.completeAlignment(versionId, JSON.stringify({ schemaVersion: 3, versionId, punctuationVersionId, links: [
    { sentenceIds: ["T1", "T2"], ranges: [{ start: "a1", end: "a2" }], needsReview: false },
    { sentenceIds: ["T3"], ranges: [{ start: "a2", end: "a3" }], needsReview: false },
  ] }));
  const before = repo.getEditor(id).translation!;
  const links = before.textLayout!.links;
  const merged = [{ id: links[0]!.groupId!, text: before.textContent, spans: [links[0]!.spans[0]!, links[2]!.spans[0]!] }];
  const saved = repo.saveTranslationDraft({ documentNodeId: id, textContent: before.textContent, textGroups: merged, blocks: [], expectedLockVersion: before.lockVersion }).translation!;
  expect(saved.textLayout!.sentences).toHaveLength(1);
  expect(saved.textLayout!.links[0]!.needsReview).toBe(true);
  const cut = before.textLayout!.sentences[2]!.from;
  const points = Array.from(before.textContent);
  const split = [
    { id: merged[0]!.id, text: points.slice(0, cut).join(""), spans: links[0]!.spans },
    { id: "new-stable-group", text: points.slice(cut).join(""), spans: links[2]!.spans },
  ];
  const resplit = repo.saveTranslationDraft({ documentNodeId: id, textContent: before.textContent, textGroups: split, blocks: [], expectedLockVersion: saved.lockVersion }).translation!;
  expect(resplit.textContent).toBe(before.textContent);
  expect(resplit.textLayout!.sentences).toHaveLength(2);
  expect(resplit.textLayout!.links.map(l => l.groupId)).toEqual(split.map(g => g.id));
});

it("collapses old group members without losing whitespace or supplementary characters", () => {
  const text = "  첫 𠮷 문장.\n\n둘째 문장!  셋째 문장.\n";
  const sentences = textSentences(text);
  const links = sentences.map((sentence, i) => ({ sentenceId: sentence.id, groupId: i < 2 ? "group-one" : "group-two" }));
  const groups = groupedTextSentences(text, sentences, links);
  expect(groups).toHaveLength(2);
  expect(groups.map(group => group.text).join("")).toBe(text);
  expect(groups[0]!.to).toBe(groups[1]!.from);
  expect(groups[1]!.to).toBe(Array.from(text).length);
});

it("partially repairs shifted correspondence without replacing unaffected links", () => {
  const { repo, id, versionId, punctuationVersionId } = punctuatedTranslation();
  repo.prepareAlignment(versionId);
  const input = (links: unknown[]) => JSON.stringify({ schemaVersion: 3, versionId, punctuationVersionId, links });
  const group = (sentenceIds: string[], start: string, end: string) => ({ sentenceIds, ranges: [{ start, end }], needsReview: false });
  repo.submitAlignment(versionId, input([group(["T1"], "a1", "a2"), group(["T2"], "a2", "a3")]));
  const report = repo.checkAlignment(versionId);
  expect(report.issues.map(issue => issue.id)).toEqual(["target:T3"]);
  expect(report.warnings).toHaveLength(1);
  expect(repo.getEditor(id).translation!.textLayout!.state).toBe("running");
  expect(() => repo.finishAlignment(versionId, { revision: report.revision, outcome: "complete" })).toThrow(/미해결/);
  const before = repo.getEditor(id).translation!.textLayout!.links;
  expect(() => repo.submitAlignment(versionId, input([group(["T3"], "a2", "a3")]))).toThrow(/중복/);
  expect(repo.getEditor(id).translation!.textLayout!.links).toEqual(before);
  repo.submitAlignment(versionId, input([group(["T1", "T2"], "a1", "a2"), group(["T3"], "a2", "a3")]));
  expect(() => repo.finishAlignment(versionId, { revision: report.revision, outcome: "complete" })).toThrow(/변경/);
  const fixed = repo.checkAlignment(versionId);
  expect(fixed.issues).toEqual([]);
  expect(repo.finishAlignment(versionId, { revision: fixed.revision, outcome: "complete" }).state).toBe("ready");
  const stable = repo.getEditor(id).translation!.textLayout!.links;
  expect(() => repo.submitAlignment(versionId, input([group(["T2"], "a1", "a2")]))).toThrow(/T1/);
  expect(repo.getEditor(id).translation!.textLayout!.links).toEqual(stable);
  repo.submitAlignment(versionId, input([{ ...group(["T3"], "a2", "a3"), needsReview: true }]));
  expect(repo.getEditor(id).translation!.textLayout!.links.slice(0, 2)).toEqual(stable.slice(0, 2));
  const pending = repo.checkAlignment(versionId);
  expect(() => repo.finishAlignment(versionId, { revision: pending.revision, outcome: "needs_review", unresolved: [] })).toThrow(/사유/);
  repo.finishAlignment(versionId, { revision: pending.revision, outcome: "needs_review", unresolved: [{ issueId: "target:T3", reason: "의미 대응이 불확실함" }] });
  expect(repo.getEditor(id).translation!.textLayout!.error).toContain("의미 대응이 불확실함");
});

it("rejects checks and finalization after the source dependency changes", () => {
  const { repo, id, versionId } = punctuatedTranslation();
  repo.prepareAlignment(versionId);
  const report = repo.checkAlignment(versionId);
  const editor = repo.getEditor(id);
  repo.savePunctuationDraft({ documentNodeId: id, punctuatedText: "學而時習之。不亦說乎。有朋自遠方來，不亦樂乎。", structureMode: "prose", expectedLockVersion: editor.punctuation!.lockVersion });
  expect(() => repo.checkAlignment(versionId)).toThrow(/표점/);
  expect(() => repo.finishAlignment(versionId, { revision: report.revision, outcome: "needs_review" })).toThrow(/표점/);
});

it("protects human-reviewed groups while allowing partial updates elsewhere", () => {
  const { repo, id, versionId, punctuationVersionId } = punctuatedTranslation();
  repo.prepareAlignment(versionId);
  const groups = [
    { sentenceIds: ["T1", "T2"], ranges: [{ start: "a1", end: "a2" }], needsReview: false },
    { sentenceIds: ["T3"], ranges: [{ start: "a2", end: "a3" }], needsReview: false },
  ];
  const input = (links: unknown[]) => JSON.stringify({ schemaVersion: 3, versionId, punctuationVersionId, links });
  repo.completeAlignment(versionId, input(groups));
  const t = repo.getEditor(id).translation!;
  repo.saveSentenceLink({ documentNodeId: id, versionId, sentenceId: "T1", expectedLockVersion: t.lockVersion, spans: t.textLayout!.links[0]!.spans });
  repo.prepareAlignment(versionId);
  const before = repo.getEditor(id).translation!.textLayout!.links;
  expect(() => repo.submitAlignment(versionId, input(groups))).toThrow(/사람/);
  expect(repo.getEditor(id).translation!.textLayout!.links).toEqual(before);
  repo.submitAlignment(versionId, input([groups[1]]));
  expect(repo.getEditor(id).translation!.textLayout!.links.slice(0, 2)).toEqual(before.slice(0, 2));
});
