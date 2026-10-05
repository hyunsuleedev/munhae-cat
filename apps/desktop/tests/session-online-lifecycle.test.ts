import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/munhae-api";

const fixture = vi.hoisted(() => ({ root: "", owner: "11111111-1111-4111-8111-111111111111", account: "11111111-1111-4111-8111-111111111111",
  project: { id: "22222222-2222-4222-8222-222222222222", ownerId: "11111111-1111-4111-8111-111111111111", title: "온라인 문헌" },
  listener: (_state: unknown) => undefined as void,
  workspace: null as any,
  saveDialog: vi.fn(), cancel: vi.fn(async () => undefined),
}));
vi.mock("electron", () => ({ app: { getPath: () => join(fixture.root, "documents") },
  dialog: { showSaveDialog: fixture.saveDialog }, shell: {} }));
vi.mock("../src/main/window", () => ({ getMainWindow: () => null }));
vi.mock("../src/main/log", () => ({ log: { info() {}, warn() {} } }));
vi.mock("../src/main/ai-runs", () => ({ hasActiveAiRuns: () => false, cancelAllAiRuns: fixture.cancel }));
vi.mock("../src/main/auth", () => ({
  assertAuthenticatedUser: (owner: string) => { if (owner !== fixture.account) throw new Error("account changed"); },
  withAuthenticatedClient: vi.fn(), watchAuthenticatedProject: vi.fn(),
  subscribeAccountState: (listener: typeof fixture.listener) => { fixture.listener = listener; return () => { fixture.listener = () => undefined; }; },
}));
vi.mock("@munhae/db-sqlite", () => ({ openAppDb: undefined, openAppDatabase: () => ({ close() {}, listRecent: () => [] }) }));
vi.mock("../src/main/online-projects", () => ({ onlineProjectId: (id: string) => id,
  OnlineProjectsService: class { get() { return Promise.resolve(fixture.project); } } }));
vi.mock("../src/main/online-workspace-remote", () => ({ OnlineWorkspaceRemote: class {} }));
vi.mock("../src/main/online-workspace", () => ({ OnlineWorkspace: class { static open() { return Promise.resolve(fixture.workspace); } } }));

import { backupProject, exportConfirmedTranslations, exportReviewTranslations, exportTranslationDocument, getCurrentSummary, initSession,
  leaveOnlineWorkspace, openOnlineProject, requireRepo, shutdownSession, withOnlineProjectSave, onlineSaveRequestKey, syncOnlineWorkspace } from "../src/main/session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function workspace() {
  const payload = { format: "markdown", suggestedBaseName: "번역", extension: "md", content: "이전 계정의 번역", documentCount: 1,
    confirmedTranslationCount: 1, manifestHash: "hash" };
  const repo = { projectId: "local-id", title: fixture.project.title, packagePath: join(fixture.root, "online-projects", "cache.munhae"), openedAt: "now",
    close: vi.fn(), setTranslationLanguage: vi.fn(), backupTo: vi.fn(), getEditor: vi.fn(),
    createConfirmedExport: vi.fn(() => payload), createReviewExport: vi.fn(() => payload),
    createTranslationExport: vi.fn(() => ({ format: "txt", extension: "txt", suggestedBaseName: "번역", documentCount: 1, text: "이전 계정의 번역" })) };
  let savedGeneration = 0, revision = 0;
  const flush = vi.fn(async () => { if (current.changeGeneration !== savedGeneration) { revision++; savedGeneration = current.changeGeneration; } });
  const current = { repo, project: fixture.project,
    summary: { projectId: repo.projectId, title: repo.title, packagePath: `online://${fixture.owner}/${fixture.project.id}`,
      openedAt: "now", storageMode: "online", accountId: fixture.owner, onlineProjectId: fixture.project.id },
    changeGeneration: 0, flush, markDirty: vi.fn(), status: () => ({ revision }),
    close: vi.fn(async (keepUnsynced: boolean) => { if (!keepUnsynced) await flush(); repo.close(); }) };
  return current;
}

beforeEach(async () => {
  fixture.root = mkdtempSync(join(tmpdir(), "munhae-session-online-"));
  fixture.account = fixture.owner;
  fixture.workspace = workspace();
  fixture.saveDialog.mockReset();
  fixture.cancel.mockClear();
  initSession(fixture.root);
  await openOnlineProject({ id: fixture.project.id });
  fixture.workspace.flush.mockClear();
});
afterEach(async () => {
  await leaveOnlineWorkspace(true);
  shutdownSession();
  rmSync(fixture.root, { recursive: true, force: true });
});

it("finishes the guarded flush once before detaching instead of flushing a second time with no active session", async () => {
  const current = fixture.workspace;
  current.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("second request failed"));
  await expect(leaveOnlineWorkspace()).resolves.toBeUndefined();
  expect(current.flush).toHaveBeenCalledOnce();
  expect(current.close).toHaveBeenCalledWith(true);
  expect(current.repo.close).toHaveBeenCalledOnce();
  expect(getCurrentSummary()).toBeNull();
});

it("keeps the current online working copy available when the guarded flush fails", async () => {
  fixture.workspace.flush.mockRejectedValueOnce(new Error("offline"));
  await expect(leaveOnlineWorkspace()).rejects.toThrow("offline");
  expect(requireRepo()).toBe(fixture.workspace.repo);
  expect(fixture.workspace.close).not.toHaveBeenCalled();
});

it.each(["backup", "confirmed", "review", "translation"])("rejects an old account's %s export after its native dialog resolves", async kind => {
  const save = deferred<{ canceled: boolean; filePath: string }>();
  fixture.saveDialog.mockReturnValueOnce(save.promise);
  const destination = join(fixture.root, "old-account.md");
  const exporting = kind === "backup" ? backupProject() : kind === "confirmed"
    ? exportConfirmedTranslations({} as Parameters<typeof exportConfirmedTranslations>[0])
    : kind === "review" ? exportReviewTranslations({} as Parameters<typeof exportReviewTranslations>[0])
    : exportTranslationDocument({} as Parameters<typeof exportTranslationDocument>[0]);
  const rejected = expect(exporting).rejects.toThrow("account changed");
  fixture.account = "another-account";
  fixture.listener({ status: "signed_out", user: null });
  save.resolve({ canceled: false, filePath: destination });
  await rejected;
  await vi.waitFor(() => expect(fixture.workspace.close).toHaveBeenCalledWith(true));
  expect(existsSync(destination)).toBe(false);
  expect(fixture.workspace.repo.backupTo).not.toHaveBeenCalled();
});

it("uses the user's Documents folder for online review exports", async () => {
  fixture.saveDialog.mockResolvedValueOnce({ canceled: true });
  await exportReviewTranslations({} as Parameters<typeof exportReviewTranslations>[0]);
  expect(fixture.saveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: join(fixture.root, "documents", "번역.md") }));
});

it("writes a translation export with the chosen extension appended", async () => {
  const destination = join(fixture.root, "완성본");
  fixture.saveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
  const result = await exportTranslationDocument({ format: "txt", layout: "translation", state: "current" });
  expect(result).toEqual({ filePath: `${destination}.txt`, format: "txt", documentCount: 1 });
  expect(readFileSync(`${destination}.txt`, "utf8")).toBe("이전 계정의 번역");
});

it("still cancels AI and closes the detached account cache if its recovery journal fails", async () => {
  fixture.workspace.markDirty.mockImplementationOnce(() => { throw new Error("disk full"); });
  fixture.account = "another-account";
  fixture.listener({ status: "signed_out", user: null });
  expect(getCurrentSummary()).toBeNull();
  expect(fixture.cancel).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(fixture.workspace.close).toHaveBeenCalledWith(true));
});


it("acknowledges a mutation only after PostgreSQL accepts it, while reads stay local", async () => {
  const gate = deferred<void>();
  fixture.workspace.flush.mockReturnValueOnce(gate.promise);
  let acknowledged = false;
  const saving = withOnlineProjectSave(() => { fixture.workspace.changeGeneration++; return "saved"; }).then(value => { acknowledged = true; return value; });
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  expect(fixture.workspace.flush).toHaveBeenCalledOnce();
  gate.resolve();
  await expect(saving).resolves.toBe("saved");
  fixture.workspace.flush.mockClear();
  await expect(withOnlineProjectSave(() => "read")).resolves.toBe("read");
  expect(fixture.workspace.flush).not.toHaveBeenCalled();
});
it("returns a server conflict as save failure without discarding the current cache", async () => {
  fixture.workspace.flush.mockRejectedValueOnce(new Error("server conflict"));
  await expect(withOnlineProjectSave(() => { fixture.workspace.changeGeneration++; return "local"; })).rejects.toThrow("server conflict");
  expect(requireRepo()).toBe(fixture.workspace.repo);
});

const saveKey = (text = "원문", version = 1) => onlineSaveRequestKey(IPC_CHANNELS.editorSaveSourceDraft, [{ documentNodeId: "doc", contentText: text, expectedLockVersion: version }])!;
const editorValue = (version = 2) => ({ project: { projectId: "local-id" }, document: { id: "doc" }, source: { lockVersion: version, contentText: "원문" } });

it("hashes stable channel and arguments without retaining text or treating different requests as retries", () => {
  const a = onlineSaveRequestKey(IPC_CHANNELS.editorSaveSourceDraft, [{ expectedLockVersion: 1, contentText: "원문", documentNodeId: "doc" }]);
  expect(a).toBe(saveKey()); expect(a).toMatch(/^[a-f0-9]{64}$/);
  expect(a).not.toBe(saveKey("새 원문")); expect(a).not.toBe(saveKey("원문", 2));
  expect(a).not.toBe(onlineSaveRequestKey(IPC_CHANNELS.editorSaveDraft, [{ expectedLockVersion: 1, contentText: "원문", documentNodeId: "doc" }]));
  expect(onlineSaveRequestKey(IPC_CHANNELS.editorGet, ["doc"])).toBeUndefined();
  expect(onlineSaveRequestKey(IPC_CHANNELS.onlineProjectsSync, [])).toBeUndefined();
});

it("retries a failed PostgreSQL flush without rerunning a local mutation with its old CAS version", async () => {
  let lockVersion = 1;
  const operation = vi.fn(() => {
    if (lockVersion !== 1) throw new Error("local CAS conflict");
    fixture.workspace.changeGeneration++; lockVersion++; return editorValue(lockVersion);
  });
  fixture.workspace.repo.getEditor.mockImplementation(() => editorValue(lockVersion));
  fixture.workspace.flush.mockRejectedValueOnce(new Error("offline"));
  await expect(withOnlineProjectSave(operation, false, saveKey())).rejects.toThrow("offline");
  await expect(withOnlineProjectSave(operation, false, saveKey())).resolves.toEqual(editorValue(2));
  expect(operation).toHaveBeenCalledOnce(); expect(fixture.workspace.repo.getEditor).toHaveBeenCalledWith("doc");
});

it("preserves a failed receipt when reconnect sync succeeds before the renderer retries", async () => {
  const operation = vi.fn(() => { fixture.workspace.changeGeneration++; return editorValue(); });
  fixture.workspace.flush.mockRejectedValueOnce(new Error("response lost"));
  await expect(withOnlineProjectSave(operation, false, saveKey())).rejects.toThrow("response lost");
  await syncOnlineWorkspace(); fixture.workspace.repo.getEditor.mockReturnValue(editorValue());
  await expect(withOnlineProjectSave(operation, false, saveKey())).resolves.toEqual(editorValue());
  expect(operation).toHaveBeenCalledOnce();
});

it("returns a current editor view after later mutations instead of restoring a stale cached version", async () => {
  const operation = vi.fn(() => { fixture.workspace.changeGeneration++; return editorValue(2); });
  fixture.workspace.flush.mockRejectedValueOnce(new Error("offline"));
  await expect(withOnlineProjectSave(operation, false, saveKey())).rejects.toThrow("offline");
  await withOnlineProjectSave(() => { fixture.workspace.changeGeneration++; return "another saved operation"; }, false, saveKey("다른 요청"));
  const latest = editorValue(4); fixture.workspace.repo.getEditor.mockReturnValue(latest);
  await expect(withOnlineProjectSave(operation, false, saveKey())).resolves.toEqual(latest);
  expect(operation).toHaveBeenCalledOnce();
});

it("coalesces overlapping failed-save retries into one flush and one result read", async () => {
  const operation = vi.fn(() => { fixture.workspace.changeGeneration++; return editorValue(); });
  fixture.workspace.flush.mockRejectedValueOnce(new Error("offline"));
  await expect(withOnlineProjectSave(operation, false, saveKey())).rejects.toThrow("offline");
  const gate = deferred<void>(); fixture.workspace.flush.mockClear(); fixture.workspace.flush.mockReturnValueOnce(gate.promise);
  fixture.workspace.repo.getEditor.mockReturnValue(editorValue());
  const first = withOnlineProjectSave(operation, false, saveKey()), second = withOnlineProjectSave(operation, false, saveKey());
  gate.resolve(); await Promise.all([first, second]);
  expect(fixture.workspace.flush).toHaveBeenCalledOnce(); expect(fixture.workspace.repo.getEditor).toHaveBeenCalledOnce(); expect(operation).toHaveBeenCalledOnce();
});

it("does not cache completed requests or failed local operations", async () => {
  const operation = vi.fn(() => { fixture.workspace.changeGeneration++; return "new document"; });
  await withOnlineProjectSave(operation, false, saveKey()); await withOnlineProjectSave(operation, false, saveKey());
  expect(operation).toHaveBeenCalledTimes(2);
  const failed = vi.fn().mockRejectedValueOnce(new Error("validation")).mockImplementationOnce(() => { fixture.workspace.changeGeneration++; return "saved"; });
  await expect(withOnlineProjectSave(failed, false, saveKey("invalid"))).rejects.toThrow("validation");
  await expect(withOnlineProjectSave(failed, false, saveKey("invalid"))).resolves.toBe("saved"); expect(failed).toHaveBeenCalledTimes(2);
});

it("never replays a non-editor result whose saved row may have changed afterward", async () => {
  const operation = vi.fn(() => { fixture.workspace.changeGeneration++; return { id: "context", lockVersion: 2, contentMd: "old" }; });
  fixture.workspace.flush.mockRejectedValueOnce(new Error("offline"));
  await expect(withOnlineProjectSave(operation, false, saveKey())).rejects.toThrow("offline");
  fixture.workspace.changeGeneration++;
  await expect(withOnlineProjectSave(operation, false, saveKey())).rejects.toMatchObject({ code: "online_save_result_changed" });
  expect(operation).toHaveBeenCalledOnce();
});

it("bounds failed receipts without evicting retry identities, while permitting reads and reconnect", async () => {
  const operation = vi.fn(() => { fixture.workspace.changeGeneration++; return editorValue(); });
  for (let index = 0; index < 8; index++) {
    fixture.workspace.flush.mockRejectedValueOnce(new Error("offline"));
    await expect(withOnlineProjectSave(operation, false, saveKey(String(index)))).rejects.toThrow("offline");
  }
  await expect(withOnlineProjectSave(operation, false, saveKey("ninth"))).rejects.toMatchObject({ code: "online_save_retry_limit" });
  expect(operation).toHaveBeenCalledTimes(8);
  await expect(withOnlineProjectSave(() => "read")).resolves.toBe("read"); await syncOnlineWorkspace();
  fixture.workspace.repo.getEditor.mockReturnValue(editorValue());
  await withOnlineProjectSave(operation, false, saveKey("0")); expect(operation).toHaveBeenCalledTimes(8);
  await withOnlineProjectSave(operation, false, saveKey("ninth")); expect(operation).toHaveBeenCalledTimes(9);
});

it("rejects a retry immediately on account change and never carries receipts into a reopened session", async () => {
  const operation = vi.fn(() => { fixture.workspace.changeGeneration++; return editorValue(); });
  fixture.workspace.flush.mockRejectedValueOnce(new Error("offline"));
  await expect(withOnlineProjectSave(operation, false, saveKey())).rejects.toThrow("offline");
  fixture.account = "another-account";
  await expect(withOnlineProjectSave(operation, false, saveKey())).rejects.toThrow("account changed"); expect(operation).toHaveBeenCalledOnce();
  fixture.account = fixture.owner; await leaveOnlineWorkspace(true);
  fixture.workspace = workspace(); await openOnlineProject({ id: fixture.project.id });
  await withOnlineProjectSave(operation, false, saveKey()); expect(operation).toHaveBeenCalledTimes(2);
});

it("does not return an old session's receipt after a project switch during retry flush", async () => {
  const old = fixture.workspace;
  const operation = vi.fn(() => { old.changeGeneration++; return editorValue(); });
  old.flush.mockRejectedValueOnce(new Error("offline"));
  await expect(withOnlineProjectSave(operation, false, saveKey())).rejects.toThrow("offline");
  const gate = deferred<void>(); old.flush.mockReturnValueOnce(gate.promise);
  const retry = withOnlineProjectSave(operation, false, saveKey());
  const rejected = expect(retry).rejects.toMatchObject({ code: "project_transition" });
  await leaveOnlineWorkspace(true); fixture.workspace = workspace(); await openOnlineProject({ id: fixture.project.id });
  gate.resolve(); await rejected;
  expect(old.repo.getEditor).not.toHaveBeenCalled(); expect(operation).toHaveBeenCalledOnce();
});

it("keeps shared-member saves and token refresh bound to the signed-in member", async () => {
  const member = "33333333-3333-4333-8333-333333333333";
  fixture.workspace.project = { ...fixture.project, accountId: member, role: "editor" };
  fixture.account = member;
  fixture.listener({ status: "signed_in", user: { id: member } });
  expect(requireRepo()).toBe(fixture.workspace.repo);
  await expect(withOnlineProjectSave(() => { fixture.workspace.changeGeneration++; return "member saved"; }, false, saveKey())).resolves.toBe("member saved");
  expect(fixture.workspace.close).not.toHaveBeenCalled();
  fixture.workspace.project.role = "viewer";
  fixture.listener({ status: "signed_out", user: null });
  await vi.waitFor(() => expect(fixture.workspace.close).toHaveBeenCalled());
  expect(fixture.workspace.markDirty).not.toHaveBeenCalled();
});
