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
import { replaceTextSentence } from "@munhae/domain/text-sentences";
import { BUNDLED_SKILLS } from "../src/bundled-skills.ts";
const clean: Array<() => void> = [];
afterEach(() => {
  while (clean.length) clean.pop()!();
});
function setup() {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-fulltext-"));
  clean.push(() => rmSync(parentDir, { recursive: true, force: true }));
  const repo = createProject({ title: "전문 번역", parentDir }).handle;
  clean.push(() => repo.close());
  const doc = repo.createDocument({
    title: "무표점",
    nodeRole: "source_unit",
    sourceText: "學而時習之不亦說乎有朋自遠方來不亦樂乎",
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
    expect(text).toContain("version: 1.0.0");
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
    ).toEqual({ schema_version: 4 });
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
