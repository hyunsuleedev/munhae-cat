import { restoreV9SummaryFixture } from "./legacy-materials-fixture.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProject, openProject, openSqlite, seedDemoProject, sqlitePath, type ProjectRepo } from "../src/index.ts";
import { restoreV6MaterialsFixture } from "./legacy-materials-fixture.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "munhae-materials-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function track(repo: ProjectRepo) { cleanup.push(() => repo.close()); return repo; }
function setup() {
  const repo = track(createProject({ title: "자료 계층", parentDir: directory() }).handle);
  const master = repo.getHome().documents.find(node => node.isMaster)!;
  const a = repo.createDocument({ title: "권1", parentId: master.id, nodeRole: "container" });
  const a1 = repo.createDocument({ title: "부록", parentId: a.id, nodeRole: "container" });
  const source = (title: string, parentId: string) => repo.createDocument({ title, parentId, nodeRole: "source_unit", sourceText: "太常甲𠮷乙", originKind: "paste" });
  return { repo, master: master.id, a: a.id, a1: a1.id, one: source("첫 글", a1.id).id,
    two: source("둘째 글", a.id).id, other: source("다른 권", master.id).id };
}
function card(repo: ProjectRepo, scopeId: string, title: string, extra = {}) {
  return repo.createContextItem({ scopeId, title, contentMd: `${title}의 판단`, priority: 0, enabled: true, ...extra });
}
function inspect<T>(repo: ProjectRepo, action: (db: ReturnType<typeof openSqlite>) => T): T {
  const db = openSqlite(sqlitePath(repo.packagePath));
  try { return action(db); } finally { db.close(); }
}
function comment(repo: ProjectRepo, documentNodeId: string) {
  const run = repo.beginFullTextRun({ documentNodeId, agentId: "codex", requestedModel: null, reasoningLevel: null, serviceTier: null, runtimeVersion: null });
  repo.completeFullTextRun({ messageId: run.messageId, rawResponse: JSON.stringify({ schemaVersion: 1, translation: "태상에 관한 글이다." }), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
  const editor = repo.getEditor(documentNodeId);
  return repo.createReviewComment({ documentNodeId, translationVersionId: editor.translation!.versionId,
    targetKind: "source", targetVersionId: editor.source.versionId, codepointFrom: 3, codepointTo: 4, quote: "𠮷", bodyMd: "여기서만 적용하는 판단인가? 근거를 확인한다." });
}

it("resolves actual arbitrary-depth ancestors, local cards and own-only scope without sibling leakage", () => {
  const { repo, master, a, a1, one, two, other } = setup();
  const root = card(repo, master, "공통"), branch = card(repo, a, "권1"), nested = card(repo, a1, "부록");
  const own = card(repo, a, "상위 자신만", { inheritToChildren: false });
  const direct = card(repo, one, "첫 글 전용");
  const ids = (id: string) => repo.getMaterials(id).resolved!.map(item => item.id);
  expect(ids(one)).toEqual([direct.id, nested.id, branch.id, root.id]);
  expect(ids(two)).toEqual([branch.id, root.id]);
  expect(ids(other)).toEqual([root.id]);
  expect(ids(a)).toContain(own.id);
  expect(repo.previewContext({ documentNodeId: other }).requestText).not.toContain("권1의 판단");
  expect(repo.getMaterials(one).resolved!.find(item => item.id === direct.id)?.reason).toBe("current");
});

it("persists independent direct references and exclusions, respects CAS and prevents a stale request pin bypass", () => {
  const { repo, a, one, two, other } = setup();
  const item = card(repo, a, "지역자료");
  repo.setMaterialPreference({ documentNodeId: other, source: "context_item", sourceId: item.id, mode: "include", expectedLockVersion: 0 });
  repo.setMaterialPreference({ documentNodeId: one, source: "context_item", sourceId: item.id, mode: "exclude", expectedLockVersion: 0 });
  expect(repo.getMaterials(other).resolved![0]).toMatchObject({ id: item.id, reason: "selected", included: true, referenced: true });
  expect(repo.getMaterials(one).resolved![0]).toMatchObject({ excluded: true, included: false });
  expect(repo.getMaterials(two).resolved![0]).toMatchObject({ excluded: false, included: true });
  expect(repo.previewContext({ documentNodeId: one, selections: [{ id: item.id, mode: "pin" }] }).requestText).not.toContain("지역자료의 판단");
  expect(() => repo.setMaterialPreference({ documentNodeId: one, source: "context_item", sourceId: item.id, mode: "include", expectedLockVersion: 0 })).toThrow(/변경/);
  repo.setMaterialPreference({ documentNodeId: other, source: "context_item", sourceId: item.id, mode: "exclude" });
  expect(repo.getMaterials(other).resolved![0]).toMatchObject({ referenced: true, excluded: true });
  repo.setMaterialPreference({ documentNodeId: other, source: "context_item", sourceId: item.id, mode: "include" });
  expect(repo.getMaterials(other).resolved![0]).toMatchObject({ referenced: true, included: true });
  const before = repo.getMaterials(other); repo.close();
  const reopened = track(openProject(repo.packagePath));
  expect(reopened.getMaterials(other)).toEqual(before);
  reopened.setMaterialPreference({ documentNodeId: other, source: "context_item", sourceId: item.id, mode: "reset" });
  expect(reopened.getMaterials(other).resolved).toEqual([]);
});

it("deletes a context and all live references with CAS, preserving comments and historical requests", () => {
  const { repo, a, one, two, other } = setup();
  const origin = comment(repo, one);
  const item = repo.reuseCommentAsMaterial({ commentId: origin.id, expectedCommentLockVersion: origin.lockVersion,
    scopeId: a, title: "코멘트 자료", contentMd: origin.bodyMd, priority: 0, enabled: true });
  repo.setMaterialPreference({ documentNodeId: other, source: "comment_reference", sourceId: item.id, mode: "include" });
  repo.setMaterialPreference({ documentNodeId: one, source: "comment_reference", sourceId: item.id, mode: "exclude" });
  const run = repo.beginFullTextRun({ documentNodeId: two, agentId: "codex", requestedModel: null,
    reasoningLevel: null, serviceTier: null, runtimeVersion: null });
  repo.completeFullTextRun({ messageId: run.messageId,
    rawResponse: JSON.stringify({ schemaVersion: 1, translation: "태상에 관한 글이다." }),
    eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
  const history = () => inspect(repo, db => Object.fromEntries(
    ["chat_messages", "provenance_artifacts", "review_comments", "document_translation_versions"]
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]),
  ));
  const before = history();
  const beforeMaterials = repo.getMaterials(other);
  expect(() => repo.deleteContextItem({ id: item.id, expectedLockVersion: item.lockVersion + 1 })).toThrow(/변경/);
  expect(repo.getMaterials(other)).toEqual(beforeMaterials);

  repo.deleteContextItem({ id: item.id, expectedLockVersion: item.lockVersion });
  for (const documentNodeId of [a, one, two, other]) {
    expect(repo.getMaterials(documentNodeId).resolved!.some(row => row.id === item.id)).toBe(false);
  }
  for (const documentNodeId of [one, two, other]) {
    expect(repo.previewContext({ documentNodeId, selections: [{ id: item.id, mode: "pin" }] })
      .auxiliary.some(row => row.id === item.id)).toBe(false);
  }
  inspect(repo, db => {
    expect(db.prepare("SELECT id FROM context_items WHERE id = ?").get(item.id)).toBeUndefined();
    expect(db.prepare("SELECT * FROM material_preferences WHERE source_kind = 'comment_reference' AND source_id = ?").all(item.id)).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
  });
  expect(history()).toEqual(before);
  expect(repo.getMaterials().comments.find(row => row.id === origin.id)?.materialIds).toEqual([]);
  expect(() => repo.deleteContextItem({ id: item.id, expectedLockVersion: item.lockVersion })).toThrow(/찾을 수/);
  repo.close();
  const reopened = track(openProject(repo.packagePath));
  expect(reopened.getKnowledge().contextItems.some(row => row.id === item.id)).toBe(false);
});

it("supports virtual document descriptions and per-document includes for globally disabled cards", () => {
  const { repo, a, one, two, other } = setup();
  const metadata = repo.getDocumentMetadata(a);
  repo.updateDocumentMetadata({ ...metadata, documentNodeId: a, descriptionMd: "권1의 배경 설명", expectedLockVersion: metadata.lockVersion });
  repo.setMaterialPreference({ documentNodeId: one, source: "document_description", sourceId: a, mode: "exclude" });
  repo.setMaterialPreference({ documentNodeId: other, source: "document_description", sourceId: a, mode: "include" });
  expect(repo.previewContext({ documentNodeId: one }).requestText).not.toContain("권1의 배경 설명");
  expect(repo.previewContext({ documentNodeId: two }).requestText).toContain("권1의 배경 설명");
  expect(repo.getMaterials(other).resolved![0]).toMatchObject({ id: `document:${a}:description`, reason: "selected", included: true });
  const off = card(repo, a, "기본 꺼짐", { enabled: false });
  expect(repo.getMaterials(two).resolved!.find(item => item.id === off.id)?.included).toBe(false);
  repo.setMaterialPreference({ documentNodeId: one, source: "context_item", sourceId: off.id, mode: "include" });
  expect(repo.previewContext({ documentNodeId: one }).requestText).toContain("기본 꺼짐의 판단");
  expect(repo.previewContext({ documentNodeId: two }).requestText).not.toContain("기본 꺼짐의 판단");
  expect(() => repo.setMaterialPreference({ documentNodeId: one, source: "document_description", sourceId: `document:${a}:description`, mode: "include" })).toThrow(/찾을 수/);
});

it("links live comments, blocks changed originals until reviewed, and keeps archived originals out of AI", () => {
  const { repo, one, other } = setup();
  const original = comment(repo, one);
  const first = repo.reuseCommentAsMaterial({ commentId: original.id, expectedCommentLockVersion: 1, scopeId: other,
    title: "참고 연결", contentMd: "", conditionMd: "조건", inheritToChildren: false, enabled: true, priority: 0 });
  expect(first.source).toBe("comment_reference");
  inspect(repo,db=>expect(db.prepare("SELECT id FROM context_items WHERE id=?").get(first.id)).toBeUndefined());
  const history=repo.previewContext({documentNodeId:other});
  expect(history.auxiliary.find(c=>c.id===first.id)?.kind).toBe("reference_comment");
  expect(history.requestText).toContain(original.bodyMd);
  repo.updateReviewComment({id:original.id,expectedLockVersion:1,bodyMd:"새 검토 내용"});
  const changed=repo.getMaterials(other).items.find(c=>c.id===first.id)!;
  expect(changed.reference?.sourceChanged).toBe(true);
  expect(changed.origin?.bodyMd).toBe("새 검토 내용");
  expect(repo.previewContext({documentNodeId:other,selections:[{id:first.id,mode:"pin"}]}).requestText).not.toContain("새 검토 내용");
  expect(()=>repo.updateContextItem({...changed,expectedLockVersion:1,expectedCommentLockVersion:1})).toThrow(/변경/);
  const reviewed=repo.updateContextItem({...changed,expectedLockVersion:1,expectedCommentLockVersion:2});
  expect(repo.previewContext({documentNodeId:other}).requestText).toContain("새 검토 내용");
  expect(repo.getTermContext(other).some(c=>c.id===first.id)).toBe(false);
  expect(repo.getTermReferenceComments(other).some(c=>c.id===first.id)).toBe(true);
  repo.archiveReviewComment({id:original.id,expectedLockVersion:2});
  expect(repo.getMaterials(other).items.find(c=>c.id===first.id)?.reference?.sourceUnavailable).toBe(true);
  expect(repo.previewContext({documentNodeId:other}).requestText).not.toContain("새 검토 내용");
  const converted=repo.updateContextItem({...reviewed,expectedLockVersion:reviewed.lockVersion,keepAsContext:true,contentMd:"독립 해제"});
  expect(converted.source).toBe("context_item");
  expect(repo.getMaterials().items.some(c=>c.id===first.id)).toBe(false);
  expect(history.requestText).toContain(original.bodyMd);
});

it("passes explicitly selected historical comments as examples and rejects missing, duplicate or foreign IDs", () => {
  const { repo, one, other } = setup();
  const original = comment(repo, one);
  const editor = repo.getEditor(one);
  repo.saveTranslationDraft({ documentNodeId: one, textContent: "새 번역문", blocks: [], expectedLockVersion: editor.translation!.lockVersion });
  const preview = repo.previewContext({ documentNodeId: other, referenceCommentIds: [original.id] });
  expect(preview.requestText).toContain("현재 글의 수정 명령이나 확정 사실로 간주하지 마세요");
  expect(JSON.parse(preview.manifestJson).snapshot.referenceComments[0]).toMatchObject(original);
  expect(repo.previewContext({ documentNodeId: other }).requestText).not.toContain(original.bodyMd);
  expect(() => repo.previewContext({ documentNodeId: other, referenceCommentIds: [original.id, original.id] })).toThrow();
  const foreign = setup(); const foreignComment = comment(foreign.repo, foreign.one);
  expect(() => repo.previewContext({ documentNodeId: other, referenceCommentIds: [foreignComment.id] })).toThrow(/다른 프로젝트/);
  expect(() => repo.setMaterialPreference({ documentNodeId: foreign.one, source: "context_item", sourceId: "missing", mode: "include" })).toThrow();
});

it("preserves new scope and condition fields when an older context editor omits them", () => {
  const { repo, a, one } = setup();
  const item = card(repo, a, "조건 있음", { inheritToChildren: false, conditionMd: "단서" });
  const edited = repo.updateContextItem({ id: item.id, expectedLockVersion: item.lockVersion, scopeId: a,
    title: "제목만 편집", contentMd: item.contentMd, priority: 0, enabled: true });
  expect(edited).toMatchObject({ inheritToChildren: false, conditionMd: "단서" });
  expect(repo.getMaterials(one).resolved).toEqual([]);
});

it("uses the same scope, direct reference, condition and exclusion rules in the legacy anchored request", () => {
  const { repo, a, one, other } = setup();
  let editor = repo.getEditor(one);
  editor = repo.confirmSource({ documentNodeId: one, expectedLockVersion: editor.source.lockVersion });
  editor = repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: one, structureMode: "prose", expectedSourceLockVersion: editor.source.lockVersion });
  repo.confirmPunctuation({ documentNodeId: one, expectedLockVersion: editor.punctuation!.lockVersion });
  const inherited = card(repo, a, "레거시상속"), localOnly = card(repo, a, "레거시부모전용", { inheritToChildren: false });
  const selected = card(repo, other, "레거시직접참조", { conditionMd: "예외조건확인" });
  repo.setMaterialPreference({ documentNodeId: one, source: "context_item", sourceId: inherited.id, mode: "exclude" });
  repo.setMaterialPreference({ documentNodeId: one, source: "context_item", sourceId: selected.id, mode: "include" });
  const preview = repo.previewLegacyContext({ documentNodeId: one, selections: [{ id: inherited.id, mode: "pin" }] });
  expect(preview.requestText).not.toContain(inherited.contentMd);
  expect(preview.requestText).not.toContain(localOnly.contentMd);
  expect(preview.requestText).toContain(selected.contentMd);
  expect(preview.requestText).toContain("예외조건확인");
});

it("upgrades v6 with one backup, preserves existing rows and checksums, and reopens without another backup", () => {
  const repo = track(seedDemoProject(directory())); const path = repo.packagePath;
  repo.close();
  const db = openSqlite(sqlitePath(path));
  restoreV6MaterialsFixture(db);
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  const cards = rows("context_items"), messages = rows("chat_messages"), artifacts = rows("provenance_artifacts");
  const migrations = db.prepare("SELECT * FROM meta_schema_migrations ORDER BY version").all();
  db.close();
  const opened = track(openProject(path));
  inspect(opened, check => {
    expect(check.prepare("SELECT schema_version FROM meta_project_state").get()).toEqual({ schema_version: 18 });
    expect(check.prepare("SELECT * FROM context_items ORDER BY id").all()).toEqual(cards.map(row => ({ ...(row as object), inherit_to_children: 1, condition_md: "", source_comment_id: null, origin_artifact_id: null })));
    expect(check.prepare("SELECT * FROM chat_messages ORDER BY id").all()).toEqual(messages);
    expect(check.prepare("SELECT * FROM provenance_artifacts ORDER BY id").all()).toEqual(artifacts);
    expect(check.prepare("SELECT * FROM meta_schema_migrations WHERE version<=6 ORDER BY version").all()).toEqual(migrations);
    expect(check.pragma("foreign_key_check")).toEqual([]);
    expect(check.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
  });
  const backups = () => readdirSync(path).filter(name => name.includes(".before-translation-materials-") && name.endsWith(".bak"));
  expect(backups()).toHaveLength(1);
  const backup = openSqlite(join(path, backups()[0]!));
  try { expect(backup.prepare("SELECT schema_version FROM meta_project_state").get()).toEqual({ schema_version: 6 }); }
  finally { backup.close(); }
  opened.close(); track(openProject(path)); expect(backups()).toHaveLength(1);
});

it("supplies terminology with the same selected and inherited context rules as translation", () => {
  const { repo, master, a, one, other } = setup();
  const common = card(repo, master, "공통", { conditionMd: "서문에 한함" });
  const inherited = card(repo, a, "상위 문맥");
  card(repo, a, "상위 전용", { inheritToChildren: false });
  card(repo, one, "비활성", { enabled: false });
  const selected = card(repo, other, "명시적 참조");
  repo.setMaterialPreference({ documentNodeId: one, source: "context_item", sourceId: inherited.id, mode: "exclude" });
  repo.setMaterialPreference({ documentNodeId: one, source: "context_item", sourceId: selected.id, mode: "include" });
  const terms = repo.getTermContext(one);
  expect(terms.map(c => c.id).sort()).toEqual([common.id, selected.id].sort());
  expect(terms.find(c => c.id === common.id)?.content).toContain("적용 조건·예외: 서문에 한함");
  expect(terms.map(c => c.id).sort()).toEqual(repo.previewContext({ documentNodeId: one }).auxiliary.filter(c => c.kind === "context_item" && c.included).map(c => c.id).sort());
});

it("migrates legacy copied comments without losing edits, preferences or original rows", () => {
  const { repo, one, other } = setup();
  const original = comment(repo, one);
  const same = card(repo, one, "같은 내용", { contentMd: original.bodyMd, inheritToChildren: false });
  const edited = card(repo, one, "편집본", { contentMd: "독립적으로 편집된 내용", conditionMd: "문맥 한정", inheritToChildren: false });
  repo.setMaterialPreference({documentNodeId:other,source:"context_item",sourceId:edited.id,mode:"include"});
  const packagePath=repo.packagePath;
  inspect(repo, db => {
    const origin={...original,commentId:original.id};
    db.prepare(`INSERT INTO provenance_artifacts(id,project_id,artifact_kind,media_type,payload_json,raw_sha256,canonical_sha256,byte_size,created_at)
      VALUES(?,?,'material_comment_origin','application/json',?,'legacy-hash','legacy-hash',1,?)`).run("legacy-origin",repo.projectId,JSON.stringify(origin),original.createdAt);
    for(const id of [same.id,edited.id]) db.prepare("UPDATE context_items SET source_comment_id=?,origin_artifact_id='legacy-origin' WHERE id=?").run(original.id,id);
    restoreV9SummaryFixture(db);
    db.exec("DROP TABLE comment_references; DELETE FROM meta_schema_migrations WHERE version=9; UPDATE meta_project_state SET schema_version=8;");
  });
  repo.close();
  const migrated=track(openProject(packagePath));
  const items=migrated.getMaterials().items;
  const a=items.find(item=>item.id===same.id)!,b=items.find(item=>item.id===edited.id)!;
  expect(a).toMatchObject({source:"comment_reference",contentMd:"",reference:{needsReview:false}});
  expect(b).toMatchObject({source:"comment_reference",contentMd:"독립적으로 편집된 내용",conditionMd:"문맥 한정",reference:{needsReview:true}});
  expect(migrated.getMaterials(other).preferences.find(p=>p.sourceId===edited.id)?.source).toBe("comment_reference");
  expect(migrated.previewContext({documentNodeId:other,selections:[{id:edited.id,mode:"pin"}]}).requestText).not.toContain("독립적으로 편집된 내용");
  const acknowledged=migrated.updateContextItem({...b,expectedLockVersion:b.lockVersion,expectedCommentLockVersion:original.lockVersion});
  expect(acknowledged.reference?.needsReview).toBe(false);
  expect(migrated.previewContext({documentNodeId:other}).requestText).toContain("독립적으로 편집된 내용");
  const standalone=migrated.updateContextItem({...acknowledged,expectedLockVersion:acknowledged.lockVersion,keepAsContext:true});
  expect(standalone.source).toBe("context_item");
  expect(migrated.getMaterials(other).resolved?.find(item=>item.id===standalone.id)?.included).toBe(true);
  inspect(migrated,db=>{
    expect(db.prepare("SELECT content_md,archived_at FROM context_items WHERE id=?").get(edited.id)).toMatchObject({content_md:"독립적으로 편집된 내용",archived_at:expect.any(String)});
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
  expect(readdirSync(packagePath).some(name=>name.includes("before-comment-references"))).toBe(true);
});

it("keeps reference comments separate from factual context in project chat", () => {
  const { repo, master, one } = setup();
  card(repo, master, "프로젝트 배경");
  const origin = comment(repo, one);
  const reference = repo.reuseCommentAsMaterial({ commentId: origin.id, expectedCommentLockVersion: origin.lockVersion,
    scopeId: master, title: "검토 질문", contentMd: "", priority: 0, enabled: true });
  const run = repo.beginProjectChatRun({ documentNodeId: one, scopeKind: "project", question: "자료를 검토해줘",
    agentId: "codex", requestedModel: "gpt-test", reasoningLevel: null, serviceTier: null, runtimeVersion: null });
  const contextSection = run.requestText.split("[ENABLED CONTEXT INHERITED FROM PROJECT MASTER]")[1]!.split("[REFERENCE COMMENTS:")[0];
  expect(contextSection).toContain("프로젝트 배경");
  expect(contextSection).not.toContain(reference.id);
  expect(run.requestText.split("[REFERENCE COMMENTS:")[1]).toContain(reference.id);
  expect(run.requestText).toContain("[REFERENCE COMMENTS:");
  expect(run.requestText).toContain(origin.bodyMd);
});
