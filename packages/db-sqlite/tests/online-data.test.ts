import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readManifest } from "@munhae/project-format";
import { createProject, seedDemoProject, openProject, openOnlineCache, openSqlite, sqlitePath,
  ONLINE_TABLE_METADATA, applyOnlineRowChanges, diffOnlineRows, type ProjectRepo, type OnlineTableData } from "../src/index.ts";

const clean: Array<() => void> = [];
afterEach(() => { while (clean.length) clean.pop()!(); });
function directory() { const path = mkdtempSync(join(tmpdir(), "munhae-online-data-")); clean.push(() => rmSync(path, { recursive: true, force: true })); return path; }
function keep(repo: ProjectRepo) { clean.push(() => repo.close()); return repo; }
function inspect<T>(repo: ProjectRepo, action: (db: ReturnType<typeof openSqlite>) => T): T { const db = openSqlite(sqlitePath(repo.packagePath)); try { return action(db); } finally { db.close(); } }
function clone(tables: OnlineTableData): OnlineTableData { return structuredClone(tables); }
const options = { agentId: "codex" as const, requestedModel: null, reasoningLevel: null, serviceTier: null, runtimeVersion: null };

it("matches the PostgreSQL generator's complete physical columns and composite keys", () => {
  const generated = JSON.parse(readFileSync(new URL("../../../scripts/online-postgres-schema.json", import.meta.url), "utf8")) as {
    schemaVersion: number; tables: Array<{ name: string; columns: Array<{ name: string }>; primaryKey: string[] }>;
  };
  expect(generated.schemaVersion).toBe(10);
  expect(ONLINE_TABLE_METADATA).toEqual(generated.tables.map(table => ({ name: table.name, columns: table.columns.map(column => column.name), primaryKey: table.primaryKey })));
});

it("roundtrips the demo document/source/punctuation/translation graph into a separate native cache", () => {
  const source = keep(seedDemoProject(directory())), rows = source.exportOnlineRows();
  expect(ONLINE_TABLE_METADATA).toHaveLength(48);
  const cache = keep(openOnlineCache({ parentDir: directory(), title: source.title, projectId: source.projectId, tables: rows }));
  expect(readManifest(cache.packagePath).projectId).toBe(source.projectId);
  expect(cache.getHome().documents).toEqual(source.getHome().documents);
  expect(diffOnlineRows(rows, cache.exportOnlineRows())).toEqual([]);
  for (const document of source.getHome().documents.filter(doc => doc.nodeRole === "source_unit")) {
    expect(cache.getEditor(document.id).source).toEqual(source.getEditor(document.id).source);
    expect(cache.getEditor(document.id).punctuation).toEqual(source.getEditor(document.id).punctuation);
    expect(cache.getEditor(document.id).translation).toEqual(source.getEditor(document.id).translation);
  }
  expect(inspect(cache, db => db.pragma("foreign_key_check"))).toEqual([]);
});

it("keeps one live repo while importing remote AI results, terms and immutable comment targets without push echo", () => {
  const source = keep(createProject({ parentDir: directory(), title: "온라인" }).handle);
  const doc = source.createDocument({ parentId: null, title: "본문", nodeRole: "source_unit", sourceText: "學而時習之", originKind: "paste" });
  const initial = source.exportOnlineRows();
  const cache = keep(openOnlineCache({ parentDir: directory(), title: source.title, projectId: source.projectId, tables: initial }));
  const run = source.beginFullTextRun({ documentNodeId: doc.id, ...options });
  source.completeFullTextRun({ messageId: run.messageId, rawResponse: JSON.stringify({ schemaVersion: 1, translation: "배우고 때때로 익힌다." }), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
  const editor = source.getEditor(doc.id);
  const comment = source.createReviewComment({ documentNodeId: doc.id, translationVersionId: editor.translation!.versionId,
    targetKind: "source", targetVersionId: editor.source.versionId, codepointFrom: 0, codepointTo: 1, quote: "學", bodyMd: "배움" });
  source.saveTerm({ documentId: doc.id, sourceVersion: `${editor.source.versionId}:${editor.source.lockVersion}`, sourceForm: "學", kind: "concept", reading: "학", translation: null, definition: "배움", contextNote: null, selectionReason: null, uncertainty: null, evidence: [], quotes: ["學"], status: "draft" });
  const changed = source.exportOnlineRows();
  const onChange = vi.fn(); cache.configureWorkspace({ onChange });
  const captured = cache;
  cache.applyOnlineRows(applyOnlineRowChanges(initial, diffOnlineRows(initial, changed)));
  expect(captured.getEditor(doc.id).translation?.textContent).toBe("배우고 때때로 익힌다.");
  expect(captured.listReviewComments(doc.id)).toEqual([comment]);
  expect(captured.getTerms(doc.id)).toHaveLength(1);
  expect(onChange).not.toHaveBeenCalled();
  cache.applyOnlineRows(changed);
  expect(diffOnlineRows(changed, cache.exportOnlineRows())).toEqual([]);
  expect(() => inspect(cache, db => db.prepare("UPDATE review_comments SET quote='違' WHERE id=?").run(comment.id))).toThrow(/immutable/);
  captured.updateReviewComment({ id: comment.id, expectedLockVersion: comment.lockVersion, bodyMd: "동기화 후 편집" });
  expect(onChange).toHaveBeenCalledOnce();
});

it("does not recover another device's running AI task when opening an online cache", () => {
  const repo = keep(createProject({ parentDir: directory(), title: "AI 실행" }).handle);
  const doc = repo.createDocument({ parentId: null, title: "원문", nodeRole: "source_unit", sourceText: "學而時習之", originKind: "paste" });
  const run = repo.beginFullTextRun({ documentNodeId: doc.id, ...options });
  const before = repo.exportOnlineRows(); repo.close();
  const reopened = keep(openProject(repo.packagePath, { onlineCache: true }));
  expect(reopened.exportOnlineRows().chat_messages!.find(row => row.id === run.messageId)).toEqual(before.chat_messages!.find(row => row.id === run.messageId));
  const completed = reopened.completeFullTextRun({ messageId: run.messageId, rawResponse: JSON.stringify({ schemaVersion: 1, translation: "익힌다." }), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
  inspect(reopened, db => db.prepare("UPDATE translation_text_layouts SET alignment_state='running' WHERE version_id=?").run(completed.version.versionId));
  reopened.close();
  const next = keep(openProject(repo.packagePath, { onlineCache: true }));
  expect(next.exportOnlineRows().translation_text_layouts![0]!.alignment_state).toBe("running");
});

it("excludes local CLI/session/path state while preserving portable attachment descriptors", () => {
  const parent = directory(), repo = keep(createProject({ parentDir: parent, title: "첨부" }).handle);
  const doc = repo.createDocument({ parentId: null, title: "원문", nodeRole: "source_unit", sourceText: "學", originKind: "paste" });
  const file = join(parent, "page.png");
  writeFileSync(file, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from("page")]));
  repo.attachReferenceAsset(doc.id, file);
  inspect(repo, db => {
    db.prepare("UPDATE src_assets SET source_uri=?").run("file:///Users/private/book.png");
    db.prepare("UPDATE src_asset_locations SET verified_at='2026-09-22T00:00:00Z',state='missing'").run();
  });
  const rows = repo.exportOnlineRows();
  expect(rows.chat_agent_sessions).toBeUndefined();
  expect(rows.meta_schema_migrations).toBeUndefined();
  expect(rows.core_project_settings![0]!.active_document_node_id).toBeNull();
  expect(rows.src_asset_locations![0]).toMatchObject({ state: "present", verified_at: null, relative_path: expect.stringMatching(/^assets\//) });
  expect(rows.src_assets![0]!.source_uri).toBeNull();
  expect(JSON.stringify(rows)).not.toContain("/Users/private");
  inspect(repo, db => db.prepare("UPDATE src_asset_locations SET relative_path='/Users/private/book.png'").run());
  expect(repo.exportOnlineRows().src_asset_locations).toEqual([]);
});

it("retains only this device's CLI state while references remain and never exports it to another cache", () => {
  const repo = keep(createProject({ parentDir: directory(), title: "로컬 실행 상태" }).handle);
  const doc = repo.createDocument({ parentId: null, title: "원문", nodeRole: "source_unit", sourceText: "學", originKind: "paste" });
  const run = repo.beginFullTextRun({ documentNodeId: doc.id, ...options });
  const base = repo.exportOnlineRows();
  const message = base.chat_messages!.find(row => row.id === run.messageId)!;
  inspect(repo, db => db.prepare(`INSERT INTO chat_agent_sessions(project_id,thread_id,agent_id,model,cwd_hash,last_message_id,stable_prompt_hash,state,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(repo.projectId, message.thread_id!, "codex", "device-private-model", "/Users/device-private", run.messageId, "private-prompt-hash", "ready", "2026-09-22T00:00:00Z"));
  expect(JSON.stringify(repo.exportOnlineRows())).not.toContain("device-private");
  repo.applyOnlineRows(base);
  expect(inspect(repo, db => db.prepare("SELECT cwd_hash FROM chat_agent_sessions").get())).toEqual({ cwd_hash: "/Users/device-private" });
  const other = keep(openOnlineCache({ parentDir: directory(), title: repo.title, projectId: repo.projectId, tables: base }));
  expect(inspect(other, db => db.prepare("SELECT * FROM chat_agent_sessions").all())).toEqual([]);
  const withoutChat = clone(base);
  withoutChat.chat_message_parts = []; withoutChat.chat_messages = []; withoutChat.chat_threads = [];
  repo.applyOnlineRows(withoutChat);
  expect(inspect(repo, db => db.prepare("SELECT * FROM chat_agent_sessions").all())).toEqual([]);
});

it("rolls back invalid authoritative rows and restores triggers; pure CAS rejects stale/malformed deltas", () => {
  const repo = keep(seedDemoProject(directory())), before = repo.exportOnlineRows();
  const broken = clone(before); broken.document_nodes!.find(row => row.is_master !== 1)!.parent_node_id = "missing-parent";
  expect(() => repo.applyOnlineRows(broken)).toThrow();
  expect(diffOnlineRows(before, repo.exportOnlineRows())).toEqual([]);
  const master = before.document_nodes!.find(row => row.is_master === 1)!;
  expect(() => inspect(repo, db => db.prepare("DELETE FROM document_nodes WHERE id=?").run(master.id!))).toThrow(/master/);
  const foreign = clone(before); foreign.core_projects![0]!.id = "foreign-project";
  expect(() => repo.applyOnlineRows(foreign)).toThrow(/프로젝트/);
  const next = clone(before); next.document_nodes![0]!.title = "원격 변경";
  const changes = diffOnlineRows(before, next);
  expect(applyOnlineRowChanges(before, changes)).toEqual(next);
  expect(() => applyOnlineRowChanges(next, changes)).toThrow(/이전 버전/);
  expect(() => applyOnlineRowChanges(before, [{ ...changes[0]!, table: "chat_agent_sessions" }])).toThrow(/테이블/);
  expect(before.document_nodes![0]!.title).not.toBe("원격 변경");
});
