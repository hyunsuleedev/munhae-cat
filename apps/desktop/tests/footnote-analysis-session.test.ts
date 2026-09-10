import { afterEach, expect, it, vi } from "vitest";
import type { FootnoteAnalysisInput, FootnoteAnalysisRun, IpcResult } from "../src/shared/munhae-api";
import { configureFootnoteAnalysisSession } from "../src/renderer/scripts/footnote-analysis-session";

const input: FootnoteAnalysisInput = { documentNodeId: "doc", expectedSourceVersionId: "source", expectedTranslationVersionId: "translation", query: "太守", mode: "target", selection: { targetKind: "source", from: 5, to: 7, quote: "太守" } };
const run = (state: FootnoteAnalysisRun["state"] = "collecting", id = "run-1"): FootnoteAnalysisRun => ({
  id, documentNodeId: "doc", sourceVersionId: "source", translationVersionId: "translation", agentId: "codex", query: "太守", mode: "target", state, detail: "", collectedCount: 10, total: 20, result: null, error: null,
});
const ok = (value: FootnoteAnalysisRun): IpcResult<FootnoteAnalysisRun> => ({ ok: true, data: value });
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup() {
  const api = {
    startFootnoteAnalysis: vi.fn(async (_input: FootnoteAnalysisInput) => ok(run())),
    getFootnoteAnalysis: vi.fn(async (_id: string) => ok(run("completed"))),
    cancelFootnoteAnalysis: vi.fn(async (id: string) => ok(run("canceled", id))),
  };
  const current = vi.fn(() => true);
  const onChange = vi.fn();
  return { api, current, onChange, session: configureFootnoteAnalysisSession(api, onChange, current) };
}
afterEach(() => vi.useRealTimers());

it("preserves exact selection context and polls until the analysis completes", async () => {
  vi.useFakeTimers();
  const { api, session } = setup();
  api.getFootnoteAnalysis.mockResolvedValueOnce(ok(run("analyzing"))).mockResolvedValueOnce(ok(run("completed")));
  await session.start(input);
  expect(api.startFootnoteAnalysis).toHaveBeenCalledWith(input);
  expect(session.state().phase).toBe("collecting");
  await vi.advanceTimersByTimeAsync(800);
  expect(session.state().phase).toBe("analyzing");
  await vi.advanceTimersByTimeAsync(800);
  expect(session.state().phase).toBe("completed");
  await vi.advanceTimersByTimeAsync(4000);
  expect(api.getFootnoteAnalysis).toHaveBeenCalledTimes(2);
});

it("cancels a late start reply after the dialog was closed or query reset", async () => {
  const { api, session } = setup();
  const deferred = pending<IpcResult<FootnoteAnalysisRun>>();
  api.startFootnoteAnalysis.mockReturnValueOnce(deferred.promise);
  const start = session.start(input);
  session.reset();
  deferred.resolve(ok(run()));
  await start;
  expect(api.cancelFootnoteAnalysis).toHaveBeenCalledWith("run-1");
  expect(session.state().phase).toBe("idle");
});

it("waits for an acknowledged user cancellation instead of claiming immediate success", async () => {
  const { api, session } = setup();
  const deferred = pending<IpcResult<FootnoteAnalysisRun>>();
  await session.start(input);
  api.cancelFootnoteAnalysis.mockReturnValueOnce(deferred.promise);
  session.cancel();
  expect(session.state().phase).toBe("canceling");
  deferred.resolve(ok(run("canceled")));
  await Promise.resolve();
  expect(session.state().phase).toBe("canceled");
});

it("reports failed cancellation without saying the running task stopped", async () => {
  const { api, session } = setup();
  await session.start(input);
  api.cancelFootnoteAnalysis.mockResolvedValueOnce({ ok: false, error: { code: "unavailable", message: "연결 오류" } });
  session.cancel();
  await Promise.resolve();
  expect(session.state().phase).toBe("failed");
  expect(session.state().error).toContain("중지를 확인하지 못했습니다");
  expect(session.state().run?.state).toBe("collecting");
});

it("cancels a user-stopped request even if its start reply arrived later", async () => {
  const { api, session } = setup();
  const deferred = pending<IpcResult<FootnoteAnalysisRun>>();
  api.startFootnoteAnalysis.mockReturnValueOnce(deferred.promise);
  const start = session.start(input);
  session.cancel();
  expect(session.state().phase).toBe("canceling");
  deferred.resolve(ok(run()));
  await start;
  await Promise.resolve();
  expect(api.cancelFootnoteAnalysis).toHaveBeenCalledWith("run-1");
  expect(session.state().phase).toBe("canceled");
});

it("does not mistake an older start reply for the pending request being canceled", async () => {
  const { api, session } = setup();
  const first = pending<IpcResult<FootnoteAnalysisRun>>();
  const second = pending<IpcResult<FootnoteAnalysisRun>>();
  api.startFootnoteAnalysis.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const firstStart = session.start(input);
  const secondStart = session.start({ ...input, query: "太常" });
  session.cancel();
  first.resolve(ok(run("collecting", "old")));
  await firstStart;
  expect(session.state().phase).toBe("canceling");
  second.resolve(ok(run("collecting", "new")));
  await secondStart;
  await Promise.resolve();
  expect(api.cancelFootnoteAnalysis.mock.calls.map(([id]) => id)).toEqual(["old", "new"]);
  expect(session.state().phase).toBe("canceled");
});

it("ignores a late completion after reset", async () => {
  vi.useFakeTimers();
  const { api, session } = setup();
  const deferred = pending<IpcResult<FootnoteAnalysisRun>>();
  api.getFootnoteAnalysis.mockReturnValueOnce(deferred.promise);
  await session.start(input);
  await vi.advanceTimersByTimeAsync(800);
  session.reset();
  deferred.resolve(ok(run("completed")));
  await Promise.resolve();
  expect(session.state().phase).toBe("idle");
});

it("invalidates completed recommendations and cancels active work when context changes", async () => {
  vi.useFakeTimers();
  const { api, session, current } = setup();
  await session.start(input);
  current.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(800);
  expect(session.state().phase).toBe("stale");
  expect(api.cancelFootnoteAnalysis).toHaveBeenCalledWith("run-1");
  expect(api.getFootnoteAnalysis).not.toHaveBeenCalled();
  current.mockReturnValue(true);
  await session.start(input);
  await vi.advanceTimersByTimeAsync(800);
  expect(session.state().phase).toBe("completed");
  current.mockReturnValue(false);
  session.refresh();
  expect(session.state().phase).toBe("stale");
  expect(session.state().run).toBeNull();
});
