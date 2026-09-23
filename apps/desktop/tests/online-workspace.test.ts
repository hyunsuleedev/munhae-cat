import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPackageDir, readManifest } from "@munhae/project-format";
import { ONLINE_TABLE_METADATA, applyOnlineRowChanges, type OnlineTableData, type OnlineRow, type OnlineRowChange, type ProjectRepo } from "@munhae/db-sqlite";
import type { OnlineProject, ProjectChangeEvent } from "../src/shared/online-projects";
import { assetHash, emptyOnlineRows, type OnlineDataHead, type OnlineCommit, type OnlinePostgresRemote } from "../src/main/online-postgres-remote";
import { AppError } from "../src/main/errors";

// Replace only native SQLite. Real row metadata/diff/CAS, files, durable journals,
// attachment bytes and the production workspace state machine remain under test.
vi.mock("@munhae/db-sqlite", async importOriginal => ({
  ...await importOriginal<typeof import("@munhae/db-sqlite")>(),
  createProject: ({ title, parentDir, projectId }: { title: string; parentDir: string; projectId: string }) => ({ handle: makeRepo(parentDir, title, projectId, initialRows(projectId)) }),
  openProject: (packagePath: string) => new FileRepo(packagePath),
  openOnlineCache: ({ parentDir, title, projectId, tables }: { parentDir: string; title: string; projectId: string; tables: OnlineTableData }) => makeRepo(parentDir, title, projectId, tables),
}));
import { OnlineWorkspace } from "../src/main/online-workspace";
const owner = "11111111-1111-4111-8111-111111111111", remoteId = "22222222-2222-4222-8222-222222222222";
const project: OnlineProject = { id: remoteId, ownerId: owner, title: "관서악부 연구", description: "원문과 번역을 대조합니다.", createdAt: "2026-09-22T12:00:00Z", updatedAt: "2026-09-22T12:00:00Z", storageMode: "online", role: "owner" };
const clone = <T>(value: T): T => structuredClone(value);
function row(table: string, values: OnlineRow): OnlineRow { return { ...Object.fromEntries(ONLINE_TABLE_METADATA.find(item => item.name === table)!.columns.map(column => [column, null])), ...values }; }
function initialRows(projectId: string): OnlineTableData {
  return { ...emptyOnlineRows(), core_projects: [row("core_projects", { id: projectId, title: project.title })],
    document_nodes: [row("document_nodes", { id: "master", project_id: projectId, title: project.title, is_master: 1, description_md: "", lock_version: 1 })],
    src_text_versions: [row("src_text_versions", { id: "source-version", project_id: projectId, content_text: "" })] };
}
function makeRepo(parentDir: string, title: string, projectId: string, tables: OnlineTableData): FileRepo {
  const { packagePath } = createPackageDir({ title, parentDir, projectId, createdAt: new Date().toISOString() });
  writeFileSync(join(packagePath, "project.sqlite3"), JSON.stringify(tables)); return new FileRepo(packagePath);
}
type Configuration = Parameters<ProjectRepo["configureWorkspace"]>[0];
class FileRepo {
  readonly projectId: string; readonly openedAt = new Date().toISOString(); private configuration?: Configuration; closed = false;
  constructor(readonly packagePath: string) { this.projectId = readManifest(packagePath).projectId; }
  configureWorkspace(configuration: Configuration) { this.configuration = configuration; }
  exportOnlineRows(): OnlineTableData { return JSON.parse(readFileSync(join(this.packagePath, "project.sqlite3"), "utf8")); }
  applyOnlineRows(tables: OnlineTableData) { writeFileSync(join(this.packagePath, "project.sqlite3"), JSON.stringify(tables)); }
  get data() { const rows = this.exportOnlineRows(); return { text: rows.src_text_versions![0]!.content_text, description: rows.document_nodes![0]!.description_md, aiResponses: rows.chat_messages!.map(row => row.request_manifest_json) }; }
  getHome() { return { documents: [{ id: "master", isMaster: true }] }; }
  getDocumentMetadata() { return { lockVersion: 1, descriptionMd: this.data.description }; }
  updateDocumentMetadata(input: { descriptionMd: string }) { const rows = this.exportOnlineRows(); rows.document_nodes![0]!.description_md = input.descriptionMd; this.mutate("updateDocumentMetadata", rows); }
  write(text: string) { const rows = this.exportOnlineRows(); rows.src_text_versions![0]!.content_text = text; this.mutate("saveSourceDraft", rows); }
  aiComplete(raw: string) { const rows = this.exportOnlineRows(); rows.chat_messages!.push(row("chat_messages", { id: randomUUID(), project_id: this.projectId, request_manifest_json: raw })); this.mutate("completeFullTextRun", rows); }
  attach(bytes: Buffer) {
    const path = "assets/fixture.png", assetId = randomUUID(); mkdirSync(join(this.packagePath, "assets"), { recursive: true }); writeFileSync(join(this.packagePath, path), bytes);
    const rows = this.exportOnlineRows(); rows.src_assets!.push(row("src_assets", { id: assetId, project_id: this.projectId, sha256: assetHash(bytes), byte_size: bytes.length }));
    rows.src_asset_locations!.push(row("src_asset_locations", { id: randomUUID(), project_id: this.projectId, asset_id: assetId, relative_path: path })); this.mutate("attachReferenceAsset", rows); return path;
  }
  crashWrite(text: string) { this.configuration?.beforeOperation?.("saveSourceDraft", true); const rows = this.exportOnlineRows(); rows.src_text_versions![0]!.content_text = text; this.applyOnlineRows(rows); }
  private mutate(method: string, rows: OnlineTableData) { this.configuration?.beforeOperation?.(method, true); this.applyOnlineRows(rows); this.configuration?.onChange?.(); }
  close() { this.closed = true; }
}
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class FakeRemote {
  head: OnlineDataHead = { projectId: remoteId, dataProjectId: null, revision: 0, updatedAt: new Date().toISOString(), tables: emptyOnlineRows() };
  assets = new Map<string, Buffer>(); attempts: Array<{ mutationId: string; revision: number; changes: OnlineRowChange[] }> = [];
  accepted = new Map<string, { input: string; result: OnlineCommit }>(); failCommits = 0; loseCommitResponse = false;
  commitGate: ReturnType<typeof deferred> | null = null; commitEntered: ReturnType<typeof deferred> | null = null;
  assetGate: ReturnType<typeof deferred> | null = null; assetEntered: ReturnType<typeof deferred> | null = null;
  uploads = 0; downloads = 0; gets = 0; failUploads = 0;
  async get() { this.gets++; return clone(this.head); }
  async changes(_id: string, revision: number) { return this.head.revision > revision; }
  async commit(_id: string, revision: number, mutationId: string, changes: OnlineRowChange[]) {
    this.attempts.push({ mutationId, revision, changes: clone(changes) });
    const gate = this.commitGate; this.commitGate = null; if (gate) { this.commitEntered?.resolve(); await gate.promise; }
    if (this.failCommits-- > 0) throw new AppError("online_workspace_request_failed", "저장 연결 끊김");
    const input = JSON.stringify({ revision, changes }), previous = this.accepted.get(mutationId);
    if (previous) { expect(input).toBe(previous.input); return clone(previous.result); }
    if (revision !== this.head.revision) throw new AppError("online_workspace_conflict", "다른 기기에서 먼저 저장했습니다.");
    const next = applyOnlineRowChanges(this.head.tables, changes);
    for (const location of next.src_asset_locations!) {
      const asset = next.src_assets!.find(row => row.id === location.asset_id)!;
      expect(this.assets.get(String(asset.sha256))?.length, "attachment must exist before metadata commit").toBe(asset.byte_size);
    }
    this.head.tables = next; this.head.dataProjectId = this.head.tables.core_projects![0]!.id as string;
    this.head.revision++; this.head.updatedAt = new Date().toISOString(); const result = { revision: this.head.revision, updatedAt: this.head.updatedAt };
    this.accepted.set(mutationId, { input, result });
    if (this.loseCommitResponse) { this.loseCommitResponse = false; throw new AppError("online_workspace_request_failed", "커밋 응답 유실"); }
    return clone(result);
  }
  async uploadAsset(_id: string, bytes: Uint8Array) {
    this.uploads++; if (this.failUploads-- > 0) throw new AppError("online_workspace_request_failed", "첨부 업로드 끊김");
    const sha = assetHash(bytes); this.assets.set(sha, Buffer.from(bytes)); return sha;
  }
  async downloadAsset(_id: string, sha: string) {
    this.downloads++; const gate = this.assetGate; this.assetGate = null; if (gate) { this.assetEntered?.resolve(); await gate.promise; }
    const bytes = this.assets.get(sha); if (!bytes) throw new Error("첨부 없음"); return Buffer.from(bytes);
  }
}
const roots: string[] = [], workspaces: OnlineWorkspace[] = [], gates: Array<ReturnType<typeof deferred>> = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "munhae-pg-workspace-")); roots.push(root); const remote = new FakeRemote(); let account = owner;
  const notices = new Map<string, (revision: number | null) => void>(), events: ProjectChangeEvent[] = [], eventArrived = deferred<ProjectChangeEvent>();
  const dependencies = (device = "device-a", watch = false) => ({ root: join(root, device), remote: remote as unknown as OnlinePostgresRemote,
    assertUser: (id: string) => { if (id !== account) throw new AppError("session_not_found", "계정이 변경되었습니다."); },
    onChange: (event: ProjectChangeEvent) => { events.push(event); eventArrived.resolve(event); },
    ...(watch ? { watch: async (_id: string, notice: (revision: number | null) => void, connected: (state: boolean) => void) => { notices.set(device, notice); connected(true); return () => { notices.delete(device); }; } } : {}) });
  const open = async (device = "device-a", discard = false, watch = false) => { const value = await OnlineWorkspace.open(project, dependencies(device, watch), discard); workspaces.push(value); return value; };
  return { root, remote, events, eventArrived, notices, dependencies, open, setAccount: (id: string) => { account = id; } };
}
const repoOf = (workspace: OnlineWorkspace) => workspace.repo as unknown as FileRepo;
const journalOf = (workspace: OnlineWorkspace) => JSON.parse(readFileSync(join(workspace.directory, "journal.json"), "utf8"));
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.resolve(); for (const workspace of workspaces.splice(0).reverse()) await workspace.close(true).catch(() => undefined);
  vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PostgreSQL row working-copy protocol", () => {
  it("isolates member caches, permits editor drafts, and blocks viewer writes and AI", async () => {
    const f = fixture(); await f.open();
    const member = "33333333-3333-4333-8333-333333333333"; f.setAccount(member);
    const shared: OnlineProject = { ...project, accountId: member, role: "editor" };
    const workspace = await OnlineWorkspace.open(shared, f.dependencies("member")); workspaces.push(workspace);
    expect(workspace.directory).toContain(member);
    expect(workspace.summary).toMatchObject({ accountId: member });
    repoOf(workspace).write("편집자 초안"); await workspace.flush();
    expect(() => workspace.assertOperation("confirmSource", true)).toThrow(/소유자/);
    await workspace.close();
    const viewer = await OnlineWorkspace.open({ ...shared, role: "viewer" }, f.dependencies("member")); workspaces.push(viewer);
    expect(repoOf(viewer).data.text).toBe("편집자 초안");
    expect(viewer.status()).toMatchObject({ role: "viewer", writable: false, state: "synced" });
    expect(() => repoOf(viewer).write("차단")).toThrow(/열람자/);
    expect(() => repoOf(viewer).aiComplete("차단")).toThrow(/열람자/);
  });
  it("rechecks revocation even when a clean cache is flushed", async () => {
    const f = fixture(); await f.open(); let revoked = false;
    const workspace = await OnlineWorkspace.open({ ...project }, { ...f.dependencies("revocation"), refreshProject: async () => {
      if (revoked) throw new AppError("not_found", "권한 제거됨"); return { ...project };
    } }); workspaces.push(workspace); revoked = true;
    await expect(workspace.pull()).rejects.toThrow("권한 제거됨");
    await expect(workspace.flush()).rejects.toThrow("권한 제거됨");
    expect(workspace.status()).toMatchObject({ state: "locked", writable: false });
  });
  it("replays the durable initialization UUID when the first successful commit response was lost", async () => {
    const f = fixture(); f.remote.loseCommitResponse = true;
    await expect(f.open()).rejects.toThrow("커밋 응답 유실");
    const directory = OnlineWorkspace.directory(f.dependencies().root, owner, remoteId);
    const receiptPath = join(directory, "initial-commit.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const revision = f.remote.head.revision;
    expect(receipt).toMatchObject({ projectId: remoteId, ownerId: owner, mutationId: f.remote.attempts[0]!.mutationId });
    const opened = await f.open();
    expect(f.remote.head.revision).toBe(revision);
    expect(f.remote.attempts.at(-1)!.mutationId).toBe(receipt.mutationId);
    expect(repoOf(opened).data.description).toBe(project.description);
    expect(opened.status()).toMatchObject({ dirty: false, state: "synced" });
    expect(existsSync(receiptPath)).toBe(false);
  });
  it("publishes normalized rows and opens a separate cache without uploading SQLite or ZIP bytes", async () => {
    const f = fixture(), first = await f.open(); expect(repoOf(first).data.description).toBe(project.description);
    repoOf(first).write("𠮷王建，宮詞。\n둘째 문단"); await first.flush(); expect(first.status()).toMatchObject({ dirty: false, writable: true, state: "synced" });
    expect(first.summary.packagePath).toBe(`online://${owner}/${remoteId}`); const second = await f.open("device-b");
    expect(repoOf(second).data.text).toBe("𠮷王建，宮詞。\n둘째 문단"); expect(second.repo.projectId).toBe(first.repo.projectId);
    expect(f.remote.attempts[1]!.changes.map(change => change.table)).toEqual(["src_text_versions"]);
    expect(f.remote.uploads).toBe(0); expect(f.remote.downloads).toBe(0); expect(f.remote.assets.size).toBe(0); expect(journalOf(first)).toMatchObject({ version: 2, pending: null });
  });
  it("freezes each mutation UUID and preserves edits made during a commit", async () => {
    const f = fixture(), workspace = await f.open(), gate = deferred(); gates.push(gate); f.remote.commitGate = gate; f.remote.commitEntered = deferred();
    repoOf(workspace).write("첫 편집"); const saving = workspace.flush(); await f.remote.commitEntered.promise; const pending = journalOf(workspace).pending;
    repoOf(workspace).write("저장 중 추가 편집"); gate.resolve(); await saving;
    expect(f.remote.attempts[1]!.mutationId).toBe(pending.mutationId); expect(f.remote.attempts[2]!.mutationId).not.toBe(pending.mutationId);
    expect(f.remote.head.tables.src_text_versions![0]!.content_text).toBe("저장 중 추가 편집"); expect(workspace.status()).toMatchObject({ dirty: false, state: "synced", revision: 3 });
  });
  it("retries the exact persisted row mutation after network failure and process restart", async () => {
    const f = fixture(), workspace = await f.open(); repoOf(workspace).write("오프라인 변경"); f.remote.failCommits = 1;
    await expect(workspace.flush()).rejects.toThrow("저장 연결 끊김"); const pending = journalOf(workspace).pending; expect(pending.mutationId).toBeTruthy(); expect(pending.changes).toHaveLength(1);
    expect(existsSync(join(workspace.directory, "pending.munhaepkg"))).toBe(false); await workspace.close(true); const resumed = await f.open();
    expect(f.remote.attempts.at(-1)!.mutationId).toBe(pending.mutationId); expect(repoOf(resumed).data.text).toBe("오프라인 변경"); expect(resumed.status()).toMatchObject({ dirty: false, state: "synced" });
  });
  it("resolves an ambiguous committed mutation idempotently after restart", async () => {
    const f = fixture(), workspace = await f.open(); repoOf(workspace).write("응답 유실에도 보존"); f.remote.loseCommitResponse = true;
    await expect(workspace.flush()).rejects.toThrow("커밋 응답 유실"); const pending = journalOf(workspace).pending, revision = f.remote.head.revision;
    await workspace.close(true); const resumed = await f.open(); expect(f.remote.head.revision).toBe(revision); expect(f.remote.attempts.at(-1)!.mutationId).toBe(pending.mutationId);
    expect(journalOf(resumed).pending).toBeNull(); expect(repoOf(resumed).data.text).toBe("응답 유실에도 보존");
  });
  it("allows two open devices and preserves conflicting local rows and a terminal AI response", async () => {
    const f = fixture(), first = await f.open(), second = await f.open("device-b"); repoOf(first).write("서버에 먼저 저장"); await first.flush(); repoOf(second).write("충돌한 이 기기 편집");
    await expect(second.flush()).rejects.toMatchObject({ code: "online_workspace_conflict" }); expect(second.status()).toMatchObject({ writable: false, dirty: true, state: "conflict" });
    expect(() => repoOf(second).write("차단할 편집")).toThrow(); repoOf(second).aiComplete("이미 실행 중이던 AI 응답 𠮷"); expect(repoOf(second).data.aiResponses).toEqual(["이미 실행 중이던 AI 응답 𠮷"]);
    const before = readFileSync(join(second.packagePath, "project.sqlite3")); await second.close(true); await expect(f.open("device-b")).rejects.toMatchObject({ code: "online_workspace_conflict" });
    expect(readFileSync(join(second.packagePath, "project.sqlite3"))).toEqual(before); const restored = await f.open("device-b", true); expect(repoOf(restored).data.text).toBe("서버에 먼저 저장");
    const recovery = readdirSync(second.directory).find(name => name.startsWith("recovery-")); expect(recovery).toBeTruthy(); expect(readFileSync(join(second.directory, recovery!, "project.sqlite3"))).toEqual(before);
  });
  it("applies a Realtime notice to the same repo handle without echoing a commit", async () => {
    const f = fixture(), reader = await f.open("device-a", false, true), handle = reader.repo, writer = await f.open("device-b");
    repoOf(writer).updateDocumentMetadata({ descriptionMd: "다른 기기의 문맥" }); await writer.flush(); const commits = f.remote.attempts.length;
    f.notices.get("device-a")!(f.remote.head.revision); const event = await f.eventArrived.promise;
    expect(reader.repo).toBe(handle); expect(repoOf(reader).data.description).toBe("다른 기기의 문맥");
    expect(event).toMatchObject({ projectId: reader.repo.projectId, accountId: owner, sessionId: reader.sessionId, reason: "commit", documentIds: ["master"], scopes: ["documents"] });
    await reader.flush(); expect(f.remote.attempts).toHaveLength(commits); expect(reader.status().realtimeConnected).toBe(true); await reader.close(); expect(f.notices.has("device-a")).toBe(false);
  });
  it("does not overwrite dirty cache rows on remote notification", async () => {
    const f = fixture(), local = await f.open(), remote = await f.open("device-b"); repoOf(local).write("미전송 초안"); repoOf(remote).write("다른 기기 변경"); await remote.flush();
    await local.pull("commit"); expect(repoOf(local).data.text).toBe("미전송 초안"); expect(f.events).toEqual([]); await expect(local.flush()).rejects.toMatchObject({ code: "online_workspace_conflict" });
  });
  it("uploads and downloads only portable attachment bytes alongside rows", async () => {
    const f = fixture(), first = await f.open(), bytes = Buffer.from("PNG attachment 𠮷"), path = repoOf(first).attach(bytes); await first.flush(); const next = await f.open("device-b");
    expect(f.remote.assets.size).toBe(1); expect(f.remote.assets.get(assetHash(bytes))).toEqual(bytes); expect(readFileSync(join(next.packagePath, path))).toEqual(bytes); expect(f.remote.downloads).toBe(1);
  });
  it("retries a failed attachment upload before replaying its frozen commit after restart", async () => {
    const f = fixture(), first = await f.open(), bytes = Buffer.from("offline attachment");
    repoOf(first).attach(bytes); f.remote.failUploads = 1;
    await expect(first.flush()).rejects.toThrow("첨부 업로드 끊김");
    const pending = journalOf(first).pending; expect(f.remote.assets.size).toBe(0); expect(f.remote.attempts).toHaveLength(1);
    await first.close(true); const resumed = await f.open();
    expect(f.remote.attempts.at(-1)!.mutationId).toBe(pending.mutationId);
    expect(f.remote.assets.get(assetHash(bytes))).toEqual(bytes); expect(resumed.status()).toMatchObject({ dirty: false, state: "synced" });
    const next = await f.open("device-b"); expect(readFileSync(join(next.packagePath, "assets/fixture.png"))).toEqual(bytes);
  });
  it("rechecks dirty intent after awaiting a remote attachment download", async () => {
    const f = fixture(), local = await f.open(), writer = await f.open("device-b"); repoOf(writer).attach(Buffer.from("new remote page")); await writer.flush();
    const gate = deferred(); gates.push(gate); f.remote.assetGate = gate; f.remote.assetEntered = deferred(); const pulling = local.pull(); await f.remote.assetEntered.promise;
    repoOf(local).write("다운로드 중 작성한 초안"); gate.resolve(); await pulling; expect(repoOf(local).data.text).toBe("다운로드 중 작성한 초안"); expect(f.events).toEqual([]); expect(local.status().dirty).toBe(true);
  });
  it("journals intent before the SQLite callback and recovers a pre-notification crash", async () => {
    const f = fixture(), first = await f.open(); repoOf(first).crashWrite("onChange 이전 쓰기"); expect(journalOf(first).dirty).toBe(true); await first.close(true);
    const resumed = await f.open(); expect(repoOf(resumed).data.text).toBe("onChange 이전 쓰기"); expect(f.remote.head.tables.src_text_versions![0]!.content_text).toBe("onChange 이전 쓰기");
  });
  it("rejects account changes before writes and after a commit response", async () => {
    const f = fixture(), workspace = await f.open(), gate = deferred(); gates.push(gate); f.remote.commitGate = gate; f.remote.commitEntered = deferred();
    repoOf(workspace).write("원래 계정의 변경"); const saving = workspace.flush(); await f.remote.commitEntered.promise; f.setAccount("33333333-3333-4333-8333-333333333333"); gate.resolve();
    await expect(saving).rejects.toMatchObject({ code: "session_not_found" }); expect(() => workspace.assertOperation("getEditor", false)).toThrow(/계정/);
    expect(() => repoOf(workspace).write("다른 계정 쓰기")).toThrow(/계정/); expect(() => repoOf(workspace).aiComplete("다른 계정 AI")).toThrow(/계정/); expect(journalOf(workspace).pending).not.toBeNull();
  });
});
