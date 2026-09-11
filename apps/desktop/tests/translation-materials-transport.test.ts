import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type MunhaeApi } from "../src/shared/munhae-api";
import { parseContextPreviewInput, parseCreateContextItemInput, parseReuseCommentAsMaterialInput, parseSetMaterialPreferenceInput, parseStartTranslationInput } from "../src/main/ipc-validate";

const mocks = vi.hoisted(() => ({
  withAccount: vi.fn(), getState: vi.fn(), requireRepo: vi.fn(),
  getMaterials: vi.fn(), setMaterialPreference: vi.fn(), reuseCommentAsMaterial: vi.fn(),
  invoke: vi.fn(), expose: vi.fn(),
}));
vi.mock("../src/main/auth", () => ({ withAccount: mocks.withAccount }));
vi.mock("../src/main/session", () => ({ requireRepo: mocks.requireRepo }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() },
}));
import { dispatchMaterial } from "../src/main/translation-materials";
import { createBrowserApi } from "../src/renderer/scripts/browser-api";

const reuse = {
  commentId: "comment-1", expectedCommentLockVersion: 3,
  scopeId: "volume-1", title: "太常의 명칭", contentMd: "이 구절에서만 판단한다.",
  inheritToChildren: false, conditionMd: "다른 시대 인용은 별도 확인", enabled: true, priority: 0,
};
const preference = { documentNodeId: "document-2", source: "document_description" as const, sourceId: "document-1", mode: "exclude" as const, expectedLockVersion: 0 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.withAccount.mockImplementation(action => action({ getState: mocks.getState }));
  mocks.getState.mockResolvedValue({ status: "signed_in", user: { id: "reader" } });
  mocks.requireRepo.mockReturnValue(mocks);
});
afterEach(() => vi.unstubAllGlobals());

describe("materials payload boundaries", () => {
  it("retains a document-only scope, conditions and the selected comment revision", () => {
    expect(parseReuseCommentAsMaterialInput(reuse)).toEqual(reuse);
    expect(parseCreateContextItemInput(reuse)).toMatchObject({ inheritToChildren: false, conditionMd: reuse.conditionMd });
    expect(parseSetMaterialPreferenceInput(preference)).toEqual(preference);
    expect(() => parseSetMaterialPreferenceInput({ ...preference, source: "unknown" })).toThrow();
    expect(() => parseSetMaterialPreferenceInput({ ...preference, expectedLockVersion: -1 })).toThrow();
    expect(() => parseReuseCommentAsMaterialInput({ ...reuse, expectedCommentLockVersion: undefined })).toThrow();
    expect(() => parseCreateContextItemInput({ ...reuse, inheritToChildren: "false" })).toThrow();
  });

  it("keeps past-document reference comments separate from revision instructions in preview and execution", () => {
    const input = { documentNodeId: "document-2", referenceCommentIds: ["other-comment"], revision: { baseVersionId: "version-2", commentIds: ["current-comment"] } };
    const preview = parseContextPreviewInput(input);
    expect(parseStartTranslationInput({ ...input, agentId: "claude" })).toEqual({ ...preview, agentId: "claude" });
    expect(preview.referenceCommentIds).toEqual(["other-comment"]);
    expect(preview.revision?.commentIds).toEqual(["current-comment"]);
    expect(() => parseContextPreviewInput({ ...input, referenceCommentIds: ["duplicate", "duplicate"] })).toThrow();
    expect(() => parseContextPreviewInput({ ...input, referenceCommentIds: [""] })).toThrow();
  });
});

describe("shared materials dispatch", () => {
  it("checks authentication before accessing a project and rejects unsupported mutations", async () => {
    mocks.getState.mockResolvedValueOnce({ status: "signed_out", user: null });
    await expect(dispatchMaterial(IPC_CHANNELS.knowledgeGetMaterials, undefined)).rejects.toMatchObject({ code: "auth_required" });
    expect(mocks.requireRepo).not.toHaveBeenCalled();
    await expect(dispatchMaterial(IPC_CHANNELS.projectClose, undefined)).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(dispatchMaterial(IPC_CHANNELS.knowledgeReuseCommentAsMaterial, { ...reuse, expectedCommentLockVersion: -1 })).rejects.toMatchObject({ code: "invalid_payload" });
    expect(mocks.reuseCommentAsMaterial).not.toHaveBeenCalled();
  });

  it("forwards the exact selected node and preserves conflicts from the project repository", async () => {
    await dispatchMaterial(IPC_CHANNELS.knowledgeGetMaterials, "document-2");
    await dispatchMaterial(IPC_CHANNELS.knowledgeSetMaterialPreference, preference);
    expect(mocks.getMaterials).toHaveBeenCalledWith("document-2");
    expect(mocks.setMaterialPreference).toHaveBeenCalledWith(preference);
    const conflict = Object.assign(new Error("changed"), { code: "cas_conflict" });
    mocks.reuseCommentAsMaterial.mockImplementationOnce(() => { throw conflict; });
    await expect(dispatchMaterial(IPC_CHANNELS.knowledgeReuseCommentAsMaterial, reuse)).rejects.toBe(conflict);
  });
});

it("exposes the same material identity and CAS input in Electron and browser transports", async () => {
  await import("../src/preload/index");
  const native = mocks.expose.mock.calls.find(([name]) => name === "munhae")![1] as MunhaeApi;
  await native.knowledge.getMaterials("document-2");
  await native.knowledge.setMaterialPreference(preference);
  await native.knowledge.reuseCommentAsMaterial(reuse);
  expect(mocks.invoke.mock.calls).toEqual([
    [IPC_CHANNELS.knowledgeGetMaterials, "document-2"],
    [IPC_CHANNELS.knowledgeSetMaterialPreference, preference],
    [IPC_CHANNELS.knowledgeReuseCommentAsMaterial, reuse],
  ]);
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ value: { ok: true } }) });
  vi.stubGlobal("fetch", fetcher);
  const browser = createBrowserApi();
  await browser.knowledge.getMaterials("document-2");
  await browser.knowledge.setMaterialPreference(preference);
  await browser.knowledge.reuseCommentAsMaterial(reuse);
  expect(fetcher.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
    { channel: IPC_CHANNELS.knowledgeGetMaterials, args: ["document-2"] },
    { channel: IPC_CHANNELS.knowledgeSetMaterialPreference, args: [preference] },
    { channel: IPC_CHANNELS.knowledgeReuseCommentAsMaterial, args: [reuse] },
  ]);
});
