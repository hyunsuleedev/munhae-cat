import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createProject, openSqlite, sqlitePath, type ProjectRepo, type TermCandidateInput } from "../src/index.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "munhae-workspace-hooks-"));
  cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const repo = createProject({ parentDir: parent, title: "온라인 작업" }).handle;
  cleanup.push(() => repo.close());
  const doc = repo.createDocument({ title: "원문", parentId: null, nodeRole: "source_unit", sourceText: "王建宮詞", originKind: "paste" });
  return { parent, repo, documentId: doc.id };
}
/** Terms need a confirmed punctuation basis. */
function term(repo: ProjectRepo, documentId: string): { versionId: string; candidate: TermCandidateInput } {
  let editor = repo.getEditor(documentId);
  editor = repo.confirmSource({ documentNodeId: documentId, expectedLockVersion: editor.source.lockVersion });
  editor = repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: documentId, structureMode: "prose", expectedSourceLockVersion: editor.source.lockVersion });
  repo.confirmPunctuation({ documentNodeId: documentId, expectedLockVersion: editor.punctuation!.lockVersion });
  return { versionId: repo.getDocumentTerms(documentId).basis!.punctuationVersionId, candidate: { sourceForm: "王建", kind: "person", reading: "왕건", translation: null,
    definition: "궁사의 작자", contextNote: null, confidence: "certain", alternatives: [], evidence: [], suggestedTermId: null, occurrences: [{ from: 0, to: 2 }] } };
}

it("uses an online display identity and guards captured repo reads and writes before any access", () => {
  const { repo, parent } = fixture();
  let authorized = true;
  const beforeOperation = vi.fn(() => { if (!authorized) throw new Error("account changed"); });
  const onChange = vi.fn();
  repo.configureWorkspace({ summary: { ...repo.getHome().project, storageMode: "online", accountId: "owner", onlineProjectId: "remote",
    packagePath: "online://owner/remote" }, beforeOperation, onChange });
  expect(repo.getHome().project).toMatchObject({ storageMode: "online", packagePath: "online://owner/remote" });
  expect(repo.packagePath).not.toContain("online://");
  const captured = repo;
  authorized = false;
  expect(() => captured.getHome()).toThrow("account changed");
  expect(() => captured.createDocument({ title: "거부", parentId: null, nodeRole: "container" })).toThrow("account changed");
  expect(beforeOperation).toHaveBeenCalledWith("getHome", false);
  expect(beforeOperation).toHaveBeenCalledWith("createDocument", true);
  expect(onChange).not.toHaveBeenCalled();
  // Recovery snapshots and shutdown remain possible after a lease/account guard fails.
  beforeOperation.mockClear();
  repo.backupTo(join(parent, "recovery.munhae.zip"));
  repo.configureWorkspace({ beforeOperation });
  repo.close();
  expect(beforeOperation).not.toHaveBeenCalled();
});

it("notifies once after a nested confirmation transaction and ignores mutations with no DB changes", () => {
  const { repo, documentId } = fixture();
  const { versionId, candidate } = term(repo, documentId);
  const [stored] = repo.storeTermCandidates(documentId, versionId, [candidate], { runId: "ai-test", agentId: "codex", model: "test" });
  const onChange = vi.fn(() => { expect(repo.getDocumentTerms(documentId)).toMatchObject({ terms: [{ term: { sourceForm: "王建" } }], candidates: [] }); });
  repo.configureWorkspace({ onChange });
  repo.setTranslationLanguage("ko");
  expect(onChange).not.toHaveBeenCalled();
  repo.confirmTerm({ documentId, punctuationVersionId: versionId, candidateId: stored!.id, term: candidate, ...candidate });
  expect(onChange).toHaveBeenCalledOnce();
});

it("does not dirty the workspace for reference verification or derived search writes", () => {
  const { repo, parent, documentId } = fixture();
  const file = join(parent, "page.png");
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("reference")]));
  repo.attachReferenceAsset(documentId, file);
  const db = openSqlite(sqlitePath(repo.packagePath));
  try { db.prepare("UPDATE src_asset_locations SET verified_at=NULL").run(); } finally { db.close(); }
  const onChange = vi.fn();
  repo.configureWorkspace({ onChange });
  expect(repo.getEditor(documentId).referenceAssets[0]!.state).toBe("present");
  repo.search({ query: "王建" });
  expect(onChange).not.toHaveBeenCalled();
  const inspect = openSqlite(sqlitePath(repo.packagePath));
  try { expect(inspect.prepare("SELECT verified_at FROM src_asset_locations").get()).toMatchObject({ verified_at: expect.any(String) }); }
  finally { inspect.close(); }
});

it("observes AI candidate persistence and replaces hook configuration without duplicate notifications", () => {
  const { repo, documentId } = fixture();
  const { versionId, candidate } = term(repo, documentId);
  const first = vi.fn(), second = vi.fn(), guard = vi.fn();
  repo.configureWorkspace({ onChange: first });
  repo.configureWorkspace({ beforeOperation: guard, onChange: second });
  repo.storeTermCandidates(documentId, versionId, [candidate], { runId: "ai-test", agentId: "codex", model: "test" });
  expect(guard).toHaveBeenCalledWith("storeTermCandidates", true);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
  expect(repo.getDocumentTerms(documentId).candidates).toHaveLength(1);
});
