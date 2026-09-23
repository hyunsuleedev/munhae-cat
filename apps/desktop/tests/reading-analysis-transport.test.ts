import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type MunhaeApi } from "../src/shared/munhae-api";

const mocks = vi.hoisted(() => ({
  account: vi.fn(), repo: vi.fn(), config: vi.fn(), start: vi.fn(), get: vi.fn(), latest: vi.fn(), cancel: vi.fn(), apply: vi.fn(),
  invoke: vi.fn(), expose: vi.fn(),
}));
vi.mock("../src/main/auth", () => ({ withAccount: (fn: (account: unknown) => unknown) => fn({ getState: mocks.account }) }));
vi.mock("../src/main/session", () => ({ requireRepo: mocks.repo, getAppConfig: mocks.config }));
vi.mock("../src/main/reading-analysis", () => ({ startReadingAnalysis: mocks.start, getReadingAnalysis: mocks.get,
  latestReadingAnalysis: mocks.latest, cancelReadingAnalysis: mocks.cancel, applyReadingAnalysis: mocks.apply }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() } }));
import { dispatchReadingAnalysis, READING_ANALYSIS_CHANNELS } from "../src/main/reading-analysis-handlers";
import { createBrowserApi } from "../src/renderer/scripts/browser-api";

const input = { documentNodeId: "doc-1", expectedSourceVersionId: "source-1", expectedTranslationVersionId: null,
  ranges: [{ from: 5, to: 8, quote: "𠀀󠄀綱" }] };
const adopt = { runId: "run-1", suggestionId: "suggestion-1" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.account.mockResolvedValue({ status: "signed_in", user: { id: "reader" } });
  mocks.repo.mockReturnValue({ projectId: "project-1" }); mocks.config.mockReturnValue({ agentId: "codex" });
});
afterEach(() => vi.unstubAllGlobals());

describe("on-demand reading analysis transport", () => {
  it("authenticates every endpoint before accessing the project", async () => {
    mocks.account.mockResolvedValue({ status: "signed_out", user: null });
    for (const channel of READING_ANALYSIS_CHANNELS) await expect(dispatchReadingAnalysis(channel, input)).rejects.toMatchObject({ code: "auth_required" });
    expect(mocks.repo).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("loading or polling analysis never starts a new run or applies a proposal", async () => {
    mocks.latest.mockReturnValue(null); mocks.get.mockReturnValue({ state: "completed" });
    expect(await dispatchReadingAnalysis(IPC_CHANNELS.researchLatestReadingAnalysis, input)).toBeNull();
    expect(mocks.latest).toHaveBeenCalledExactlyOnceWith(mocks.repo(), input);
    await dispatchReadingAnalysis(IPC_CHANNELS.researchGetReadingAnalysis, "run-1");
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
    await dispatchReadingAnalysis(IPC_CHANNELS.researchStartReadingAnalysis, input);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(mocks.repo(), mocks.config(), input);
    await dispatchReadingAnalysis(IPC_CHANNELS.researchApplyReadingAnalysis, adopt);
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(mocks.repo(), adopt);
  });

  it("retains domain conflict errors and rejects unrelated channels", async () => {
    const conflict = Object.assign(new Error("다른 창에서 변경되었습니다."), { code: "cas_conflict" });
    mocks.apply.mockImplementationOnce(() => { throw conflict; });
    await expect(dispatchReadingAnalysis(IPC_CHANNELS.researchApplyReadingAnalysis, adopt)).rejects.toBe(conflict);
    await expect(dispatchReadingAnalysis(IPC_CHANNELS.aiStartChat, input)).rejects.toMatchObject({ code: "invalid_payload" });
  });

  it("native and browser use identical explicit analysis endpoints with exact Unicode ranges", async () => {
    await import("../src/preload/index");
    const native = mocks.expose.mock.calls.find(([name]) => name === "munhae")![1] as MunhaeApi;
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ value: { ok: true, data: null } }) });
    vi.stubGlobal("fetch", fetcher);
    for (const api of [native, createBrowserApi()]) {
      await api.research.startReadingAnalysis(input);
      await api.research.getReadingAnalysis("run-1");
      await api.research.latestReadingAnalysis(input);
      await api.research.cancelReadingAnalysis("run-1");
      await api.research.applyReadingAnalysis(adopt);
    }
    const expected = [
      [IPC_CHANNELS.researchStartReadingAnalysis, input], [IPC_CHANNELS.researchGetReadingAnalysis, "run-1"],
      [IPC_CHANNELS.researchLatestReadingAnalysis, input], [IPC_CHANNELS.researchCancelReadingAnalysis, "run-1"],
      [IPC_CHANNELS.researchApplyReadingAnalysis, adopt],
    ];
    expect(mocks.invoke.mock.calls).toEqual(expected);
    expect(fetcher.mock.calls.map(([, options]) => { const body = JSON.parse(options.body); return [body.channel, ...body.args]; })).toEqual(expected);
  });
});
