import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type AccountState, type MunhaeApi, type SaveReadingAnnotationInput } from "../src/shared/munhae-api";
import { AppError } from "../src/main/errors";

const mocks = vi.hoisted(() => ({
  withAccount: vi.fn(), getState: vi.fn(), requireRepo: vi.fn(),
  listReadingAnnotations: vi.fn(), saveReadingAnnotation: vi.fn(), archiveReadingAnnotation: vi.fn(),
  invoke: vi.fn(), expose: vi.fn(),
}));
vi.mock("../src/main/auth", () => ({ withAccount: mocks.withAccount }));
vi.mock("../src/main/session", () => ({ requireRepo: mocks.requireRepo }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() },
}));

import { dispatchReadingAnnotation } from "../src/main/reading-annotations";
import { createBrowserApi } from "../src/renderer/scripts/browser-api";

const signedIn: AccountState = {
  status: "signed_in", persistence: "encrypted",
  user: { id: "reader", email: "reader@example.invalid", displayName: "연구자", emailConfirmedAt: null, providers: ["email"] },
};
const input: SaveReadingAnnotationInput = {
  documentNodeId: "document-1", sourceVersionId: "source-1", codepointFrom: 0, codepointTo: 2,
  quote: "𠀀綱", reading: "강", gloss: "벼리", readingOrder: 1, citation: null, translationQuote: null, expectedLockVersion: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getState.mockResolvedValue(signedIn);
  mocks.withAccount.mockImplementation((action) => action({ getState: mocks.getState }));
  mocks.requireRepo.mockReturnValue({
    listReadingAnnotations: mocks.listReadingAnnotations,
    saveReadingAnnotation: mocks.saveReadingAnnotation,
    archiveReadingAnnotation: mocks.archiveReadingAnnotation,
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("shared native and browser reading dispatcher", () => {
  it("returns annotations from all source versions and forwards guarded saves and archives", async () => {
    const rows = [{ ...input, id: "new" }, { ...input, sourceVersionId: "older-source", id: "old" }];
    mocks.listReadingAnnotations.mockReturnValue(rows);
    mocks.saveReadingAnnotation.mockReturnValue({ ...input, id: "new", lockVersion: 1 });
    mocks.archiveReadingAnnotation.mockReturnValue(undefined);
    expect(await dispatchReadingAnnotation(IPC_CHANNELS.editorListReadingAnnotations, "document-1")).toBe(rows);
    expect(mocks.listReadingAnnotations).toHaveBeenCalledExactlyOnceWith("document-1");
    expect(await dispatchReadingAnnotation(IPC_CHANNELS.editorSaveReadingAnnotation, input)).toMatchObject({ id: "new", lockVersion: 1 });
    expect(mocks.saveReadingAnnotation).toHaveBeenCalledExactlyOnceWith(input);
    expect(await dispatchReadingAnnotation(IPC_CHANNELS.editorArchiveReadingAnnotation, { id: "new", expectedLockVersion: 1 })).toBeUndefined();
    expect(mocks.archiveReadingAnnotation).toHaveBeenCalledExactlyOnceWith({ id: "new", expectedLockVersion: 1 });
    expect(mocks.getState).toHaveBeenCalledTimes(3);
  });

  it.each(["signed_out", "password_recovery"] as const)("denies %s before accessing project data", async (status) => {
    mocks.getState.mockResolvedValue({ ...signedIn, status });
    for (const channel of [IPC_CHANNELS.editorListReadingAnnotations, IPC_CHANNELS.editorSaveReadingAnnotation, IPC_CHANNELS.editorArchiveReadingAnnotation]) {
      await expect(dispatchReadingAnnotation(channel, input)).rejects.toMatchObject({ code: "auth_required" });
    }
    expect(mocks.requireRepo).not.toHaveBeenCalled();
  });

  it("waits for verified authentication and stops if authentication cannot be checked", async () => {
    let resolve!: (state: AccountState) => void;
    mocks.getState.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const pending = dispatchReadingAnnotation(IPC_CHANNELS.editorSaveReadingAnnotation, input);
    await Promise.resolve();
    expect(mocks.requireRepo).not.toHaveBeenCalled();
    resolve(signedIn);
    await pending;
    expect(mocks.saveReadingAnnotation).toHaveBeenCalledOnce();
    mocks.requireRepo.mockClear();
    const failure = new AppError("auth_network_error", "offline");
    mocks.getState.mockRejectedValueOnce(failure);
    await expect(dispatchReadingAnnotation(IPC_CHANNELS.editorListReadingAnnotations, "document-1")).rejects.toBe(failure);
    expect(mocks.requireRepo).not.toHaveBeenCalled();
  });

  it("rejects malformed input without invoking a mutation and preserves database conflict codes", async () => {
    await expect(dispatchReadingAnnotation(IPC_CHANNELS.editorSaveReadingAnnotation, { ...input, codepointTo: 3 }))
      .rejects.toMatchObject({ code: "invalid_payload" });
    expect(mocks.saveReadingAnnotation).not.toHaveBeenCalled();
    const conflict = new AppError("cas_conflict", "changed by another editor");
    mocks.saveReadingAnnotation.mockImplementationOnce(() => { throw conflict; });
    await expect(dispatchReadingAnnotation(IPC_CHANNELS.editorSaveReadingAnnotation, input)).rejects.toBe(conflict);
    await expect(dispatchReadingAnnotation(IPC_CHANNELS.projectClose, undefined)).rejects.toMatchObject({ code: "invalid_payload" });
  });
});

describe("reading API transports", () => {
  it("native preload carries Unicode data, citation provenance, and CAS versions unchanged", async () => {
    await import("../src/preload/index");
    const api = mocks.expose.mock.calls.find(([name]) => name === "munhae")![1] as MunhaeApi;
    const saved = { ok: true, data: { ...input, id: "note-1", lockVersion: 1 } };
    mocks.invoke.mockResolvedValue(saved);
    expect(await api.editor.saveReadingAnnotation(input)).toBe(saved);
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.editorSaveReadingAnnotation, input);
    await api.editor.listReadingAnnotations("document-1");
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.editorListReadingAnnotations, "document-1");
    await api.editor.archiveReadingAnnotation({ id: "note-1", expectedLockVersion: 1 });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.editorArchiveReadingAnnotation, { id: "note-1", expectedLockVersion: 1 });
  });

  it("browser sends the identical channel contract and retains structured conflict errors", async () => {
    const conflict = { ok: false, error: { code: "cas_conflict", message: "다른 창에서 수정했습니다." } };
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ value: conflict }) });
    vi.stubGlobal("fetch", fetcher);
    const api = createBrowserApi();
    expect(await api.editor.saveReadingAnnotation(input)).toEqual(conflict);
    await api.editor.listReadingAnnotations("document-1");
    await api.editor.archiveReadingAnnotation({ id: "note-1", expectedLockVersion: 2 });
    expect(fetcher.mock.calls.map(([url, options]) => [url, options.method, JSON.parse(options.body)])).toEqual([
      ["/__munhae/api", "POST", { channel: IPC_CHANNELS.editorSaveReadingAnnotation, args: [input] }],
      ["/__munhae/api", "POST", { channel: IPC_CHANNELS.editorListReadingAnnotations, args: ["document-1"] }],
      ["/__munhae/api", "POST", { channel: IPC_CHANNELS.editorArchiveReadingAnnotation, args: [{ id: "note-1", expectedLockVersion: 2 }] }],
    ]);
  });
});
