import { restoreV6MaterialsFixture } from "./legacy-materials-fixture.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sha256Hex, sliceCodepoints } from "@munhae/domain";
import { createProject, openProject, openSqlite, sqlitePath, type ProjectRepo, type ReadingCitation, type SaveReadingAnnotationInput } from "../src/index.ts";
import { assertSqliteIntegrity } from "../src/sqlite.ts";

const clean: Array<() => void> = [];
afterEach(() => { while (clean.length) clean.pop()!(); });
const source = "甲𠮷乙，甲𠮷乙。";
const citation: ReadingCitation = { source: "wiktionary", sourceLabel: "한국어 위키낱말사전", entryId: "entry-𠮷",
  headword: "𠮷", reading: "길", sense: "길하다", senseLabel: "뜻 1", sourceUrl: "https://ko.wiktionary.org/wiki/𠮷",
  license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  attribution: "위키낱말사전 기여자; 한국어 사전에서 가져온 뜻풀이." };

function setup(text = source) {
  const dir = mkdtempSync(join(tmpdir(), "munhae-reading-annotations-"));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = createProject({ title: "구절 연구", parentDir: dir }).handle;
  clean.push(() => repo.close());
  const doc = repo.createDocument({ title: "본문", nodeRole: "source_unit", sourceText: text, originKind: "paste", parentId: null });
  return { repo, id: doc.id };
}
function input(repo: ProjectRepo, documentNodeId: string, from = 5, to = 6): SaveReadingAnnotationInput {
  const current = repo.getEditor(documentNodeId).source;
  return { documentNodeId, sourceVersionId: current.versionId, codepointFrom: from, codepointTo: to,
    quote: sliceCodepoints(current.contentText, from, to), reading: "길", gloss: "두 번째 𠮷의 문맥 풀이", readingOrder: 4, citation, translationQuote: null, expectedLockVersion: 0 };
}
function inspect<T>(repo: ProjectRepo, action: (db: ReturnType<typeof openSqlite>) => T): T {
  const db = openSqlite(sqlitePath(repo.packagePath));
  try { return action(db); } finally { db.close(); }
}

it("persists independent repeated characters, multi-character codepoint ranges and full provenance across reopen", () => {
  const { repo, id } = setup();
  const originalSource = repo.getEditor(id).source;
  const first = repo.saveReadingAnnotation({ ...input(repo, id, 1, 2), gloss: "첫 번째 글자", readingOrder: 1 });
  const second = repo.saveReadingAnnotation(input(repo, id));
  const phrase = repo.saveReadingAnnotation({ ...input(repo, id, 4, 7), reading: "갑길을", gloss: "세 글자의 풀이", citation: null });
  expect(second).toMatchObject({ codepointFrom: 5, codepointTo: 6, quote: "𠮷", citation, lockVersion: 1 });
  expect(phrase.quote).toBe("甲𠮷乙");
  expect(second.id).not.toBe(first.id);
  expect(repo.getEditor(id).source).toEqual(originalSource);
  expect(repo.getEditor(id).translation).toBeNull();
  inspect(repo, db => {
    const row = db.prepare("SELECT source_content_hash, created_by_actor_id, updated_by_actor_id FROM reading_annotations WHERE id=?").get(second.id);
    expect(row).toMatchObject({ source_content_hash: sha256Hex(source), created_by_actor_id: expect.any(String), updated_by_actor_id: expect.any(String) });
    expect(db.prepare("SELECT count(*) AS n FROM glossary_entries").get()).toEqual({ n: 0 });
    assertSqliteIntegrity(db);
  });
  const before = repo.listReadingAnnotations(id);
  repo.close();
  const reopened = openProject(repo.packagePath);
  clean.push(() => reopened.close());
  expect(reopened.listReadingAnnotations(id)).toEqual(before);
});

it("requires CAS for edits and archive, rejects duplicate live ranges, and permits a new annotation after archive", () => {
  const { repo, id } = setup();
  const request = input(repo, id);
  const original = repo.saveReadingAnnotation(request);
  expect(() => repo.saveReadingAnnotation(request)).toThrow(/이미/);
  const changed = repo.saveReadingAnnotation({ ...request, id: original.id, expectedLockVersion: 1, gloss: "고친 풀이" });
  expect(changed).toMatchObject({ id: original.id, lockVersion: 2, gloss: "고친 풀이", citation });
  expect(() => repo.saveReadingAnnotation({ ...request, id: original.id, expectedLockVersion: 1 })).toThrow(/다른 편집/);
  expect(() => repo.archiveReadingAnnotation({ id: original.id, expectedLockVersion: 1 })).toThrow(/다른 편집/);
  expect(() => repo.saveReadingAnnotation({ ...request, expectedLockVersion: 1 })).toThrow(/저장 상태/);
  expect(() => repo.saveReadingAnnotation({ ...request, id: original.id, expectedLockVersion: 0 })).toThrow(/저장 상태/);
  repo.archiveReadingAnnotation({ id: original.id, expectedLockVersion: 2 });
  expect(repo.listReadingAnnotations(id)).toEqual([]);
  expect(() => repo.archiveReadingAnnotation({ id: original.id, expectedLockVersion: 3 })).toThrow(/찾을 수/);
  const replacement = repo.saveReadingAnnotation(request);
  expect(replacement.id).not.toBe(original.id);
  inspect(repo, db => {
    expect(db.prepare("SELECT lock_version, archived_at, citation_json FROM reading_annotations WHERE id=?").get(original.id))
      .toMatchObject({ lock_version: 3, archived_at: expect.any(String), citation_json: expect.stringContaining("CC BY-SA") });
    expect(() => db.prepare("UPDATE reading_annotations SET quote='甲' WHERE id=?").run(replacement.id)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE reading_annotations SET archived_at=NULL WHERE id=?").run(original.id)).toThrow(/read-only/);
  });
});

it("keeps previous source annotations read-only without relocation after draft edits or text restoration", () => {
  const { repo, id } = setup();
  const request = input(repo, id), old = repo.saveReadingAnnotation(request);
  const before = repo.getEditor(id);
  const edited = repo.saveSourceDraft({ documentNodeId: id, contentText: "丁" + source, originKind: "manual", expectedLockVersion: before.source.lockVersion });
  expect(edited.source.versionId).not.toBe(before.source.versionId);
  expect(repo.listReadingAnnotations(id)).toEqual([old]);
  expect(() => repo.saveReadingAnnotation({ ...request, id: old.id, expectedLockVersion: 1 })).toThrow(/원문 버전/);
  expect(() => repo.archiveReadingAnnotation({ id: old.id, expectedLockVersion: 1 })).toThrow(/읽기 전용/);
  const current = repo.saveReadingAnnotation({ ...input(repo, id, 6, 7), gloss: "현재 원문의 같은 글자" });
  expect(current.sourceVersionId).toBe(edited.source.versionId);
  expect(repo.listReadingAnnotations(id)).toHaveLength(2);
  const restored = repo.saveSourceDraft({ documentNodeId: id, contentText: source, originKind: "manual", expectedLockVersion: edited.source.lockVersion });
  expect(restored.source.versionId).not.toBe(before.source.versionId);
  expect(() => repo.saveReadingAnnotation({ ...request, id: old.id, sourceVersionId: restored.source.versionId, expectedLockVersion: 1 })).toThrow(/범위/);
  expect(() => repo.saveReadingAnnotation(request)).toThrow(/원문 버전/);
  expect(repo.listReadingAnnotations(id)).toHaveLength(2);
  inspect(repo, db => {
    expect(() => db.prepare("UPDATE reading_annotations SET gloss='옮겨 쓰기' WHERE id=?").run(old.id)).toThrow(/read-only/);
    expect(db.prepare("SELECT source_content_hash FROM reading_annotations WHERE id=?").get(old.id)).toEqual({ source_content_hash: sha256Hex(source) });
  });
});

it("checks the saved source hash as well as the version and exact quote", () => {
  const { repo, id } = setup();
  const request = input(repo, id), annotation = repo.saveReadingAnnotation(request);
  // Simulate external modification retaining both the old ID and the selected
  // quote. It must not silently reattach a note to a different source snapshot.
  inspect(repo, db => db.prepare("UPDATE src_text_versions SET content_text=?, content_hash=? WHERE id=?")
    .run(source + "丁", sha256Hex(source + "丁"), request.sourceVersionId));
  expect(() => repo.saveReadingAnnotation({ ...request, id: annotation.id, expectedLockVersion: 1 })).toThrow(/읽기 전용/);
  expect(() => repo.archiveReadingAnnotation({ id: annotation.id, expectedLockVersion: 1 })).toThrow(/읽기 전용/);
  expect(repo.listReadingAnnotations(id)).toEqual([annotation]);
  inspect(repo, db => db.prepare("UPDATE src_text_versions SET content_hash=? WHERE id=?").run("0".repeat(64), request.sourceVersionId));
  expect(() => repo.saveReadingAnnotation({ ...input(repo, id, 1, 2) })).toThrow(/원문 내용/);
});

it("allows saved draft notes without a translation and preserves them when that same source version is confirmed", () => {
  const { repo, id } = setup();
  const old = repo.saveReadingAnnotation(input(repo, id));
  const editor = repo.getEditor(id);
  repo.confirmSource({ documentNodeId: id, expectedLockVersion: editor.source.lockVersion });
  const updated = repo.saveReadingAnnotation({ ...input(repo, id), id: old.id, expectedLockVersion: old.lockVersion, gloss: "원문 확정 후 검토" });
  expect(updated.sourceVersionId).toBe(old.sourceVersionId);
  expect(updated.lockVersion).toBe(2);
});

it("rejects UTF-16 offsets, wrong quotes, invalid ranges and empty or oversized annotations", () => {
  const { repo, id } = setup();
  const request = input(repo, id);
  for (const patch of [
    { codepointFrom: 6, codepointTo: 8 }, { quote: "甲" }, { codepointFrom: -1 }, { codepointTo: 5 },
    { codepointFrom: 0.5 }, { codepointTo: 1000 }, { quote: "\u0000" },
    { reading: "독".repeat(101) }, { gloss: "풀이".repeat(1001) },
    { reading: " ", gloss: "\n", readingOrder: null, citation: null },
    { readingOrder: 0 }, { readingOrder: 1.5 }, { readingOrder: 1_000_001 }, { translationQuote: "번".repeat(501) }, { translationQuote: "\u0000" },
  ]) expect(() => repo.saveReadingAnnotation({ ...request, ...patch })).toThrow();
  expect(repo.listReadingAnnotations(id)).toEqual([]);
  const long = setup("𠮷".repeat(101));
  expect(() => long.repo.saveReadingAnnotation(input(long.repo, long.id, 0, 101))).toThrow(/범위/);
  expect(long.repo.saveReadingAnnotation(input(long.repo, long.id, 0, 100)).quote).toBe("𠮷".repeat(100));
});

it("retains optional citation fields and rejects incomplete, unsafe or oversized provenance", () => {
  const { repo, id } = setup();
  const request = input(repo, id);
  for (const patch of [{ sourceUrl: "javascript:alert(1)" }, { sourceUrl: "https://user:password@example.invalid" },
    { licenseUrl: "/license" }, { source: "" }, { sense: "" }, { sense: "뜻".repeat(20_001) }, { unexpected: "value" }]) {
    expect(() => repo.saveReadingAnnotation({ ...request, citation: { ...citation, ...patch } })).toThrow(/출처/);
  }
  expect(() => repo.saveReadingAnnotation({ ...request, citation: { source: "wiktionary" } as ReadingCitation })).toThrow(/출처/);
  const { senseLabel: _label, ...withoutLabel } = citation;
  const saved = repo.saveReadingAnnotation({ ...request, citation: { ...withoutLabel, reading: null, licenseUrl: null, attribution: "" } });
  expect(saved.citation).toEqual({ ...withoutLabel, reading: null, licenseUrl: null, attribution: "" });
});

it("enforces document ownership and immutable positions in repository and SQL writes", () => {
  const { repo, id } = setup();
  const request = input(repo, id), saved = repo.saveReadingAnnotation(request);
  const other = repo.createDocument({ title: "다른 문서", nodeRole: "source_unit", sourceText: source, originKind: "paste", parentId: null });
  expect(() => repo.saveReadingAnnotation({ ...request, documentNodeId: other.id })).toThrow(/원문 버전/);
  expect(() => repo.saveReadingAnnotation({ ...input(repo, other.id), id: saved.id, expectedLockVersion: 1 })).toThrow(/범위/);
  expect(() => repo.saveReadingAnnotation({ ...input(repo, id, 1, 2), id: saved.id, expectedLockVersion: 1 })).toThrow(/범위/);
  inspect(repo, db => {
    const row = db.prepare("SELECT * FROM reading_annotations WHERE id=?").get(saved.id) as Record<string, unknown>;
    const insert = (patch: Record<string, unknown>) => {
      const entries = Object.entries({ ...row, id: "invalid-reading-row", ...patch });
      db.prepare(`INSERT INTO reading_annotations (${entries.map(([name]) => name).join(",")}) VALUES (${entries.map(() => "?").join(",")})`)
        .run(...entries.map(([, value]) => value));
    };
    expect(() => insert({})).toThrow(/UNIQUE/);
    expect(() => insert({ document_node_id: other.id })).toThrow(/current source/);
    expect(() => insert({ codepoint_from: 1, codepoint_to: 2, quote: "甲" })).toThrow(/exact quote/);
    expect(() => insert({ codepoint_from: 1, codepoint_to: 2, citation_json: "{}" })).toThrow();
    expect(() => insert({ codepoint_from: 1, codepoint_to: 2, reading_order: 0 })).toThrow();
    expect(() => db.prepare("UPDATE reading_annotations SET source_version_id=? WHERE id=?").run(repo.getEditor(other.id).source.versionId, saved.id)).toThrow(/immutable/);
    assertSqliteIntegrity(db);
  });
});

it("upgrades v5 once with a consistent backup and leaves existing project data unchanged", () => {
  const { repo, id } = setup();
  const before = repo.getEditor(id), path = repo.packagePath;
  repo.close();
  const db = openSqlite(sqlitePath(path));
  const tables = ["src_text_versions", "src_text_heads", "document_nodes", "document_translation_versions", "glossary_entries", "review_comments"];
  const rows = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
  const oldRows = rows();
  restoreV6MaterialsFixture(db);
  db.exec("DROP TABLE reading_annotations; DELETE FROM meta_schema_migrations WHERE version=6; UPDATE meta_project_state SET schema_version=5;");
  db.close();
  const reopened = openProject(path);
  clean.push(() => reopened.close());
  expect(reopened.getEditor(id)).toEqual({ ...before, project: { ...before.project, openedAt: expect.any(String) } });
  expect(reopened.listReadingAnnotations(id)).toEqual([]);
  const backups = readdirSync(path).filter(name => name.includes(".before-reading-annotations-") && name.endsWith(".bak"));
  expect(backups).toHaveLength(1);
  const backup = openSqlite(join(path, backups[0]!));
  try {
    expect(backup.prepare("SELECT schema_version FROM meta_project_state").get()).toEqual({ schema_version: 5 });
    expect(backup.prepare("SELECT name FROM sqlite_schema WHERE name='reading_annotations'").get()).toBeUndefined();
    assertSqliteIntegrity(backup);
  } finally { backup.close(); }
  inspect(reopened, check => {
    expect(check.prepare("SELECT schema_version FROM meta_project_state").get()).toEqual({ schema_version: 11 });
    expect(Object.fromEntries(tables.map(table => [table, check.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]))).toEqual(oldRows);
    assertSqliteIntegrity(check);
  });
  reopened.close();
  const again = openProject(path);
  clean.push(() => again.close());
  expect(readdirSync(path).filter(name => name.includes(".before-reading-annotations-") && name.endsWith(".bak"))).toEqual(backups);
  expect(again.listReadingAnnotations(id)).toEqual([]);
});

it("stores an optional translation quote as display-only evidence and drops blank values", () => {
  const { repo, id } = setup();
  const linked = repo.saveReadingAnnotation({ ...input(repo, id), translationQuote: " 길한 " });
  expect(linked.translationQuote).toBe("길한");
  inspect(repo, db => expect(db.prepare("SELECT translation_quote FROM reading_translation_links WHERE annotation_id=?").get(linked.id)).toEqual({ translation_quote: "길한" }));
  const cleared = repo.saveReadingAnnotation({ ...input(repo, id), id: linked.id, expectedLockVersion: linked.lockVersion, translationQuote: "  " });
  expect(cleared.translationQuote).toBeNull();
  expect(cleared.lockVersion).toBe(2);
  inspect(repo, db => expect(db.prepare("SELECT count(*) AS n FROM reading_translation_links").get()).toEqual({ n: 0 }));
  expect(repo.getEditor(id).translation).toBeNull();
  const relinked = repo.saveReadingAnnotation({ ...input(repo, id), id: linked.id, expectedLockVersion: 2, translationQuote: "길" });
  expect(repo.listReadingAnnotations(id).find(row => row.id === linked.id)?.translationQuote).toBe("길");
  repo.archiveReadingAnnotation({ id: relinked.id, expectedLockVersion: relinked.lockVersion });
  inspect(repo, db => { expect(db.prepare("SELECT count(*) AS n FROM reading_translation_links").get()).toEqual({ n: 0 }); expect(db.pragma("foreign_key_check")).toEqual([]); });
});
