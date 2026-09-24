import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcResult, ReadingAnnotationView } from "../src/shared/munhae-api";
import type { ReadingAnalysisApi, ReadingAnalysisRun } from "../src/shared/reading-analysis-types";
import { configureReadingAnalysisSession, type ReadingAnalysisContext } from "../src/renderer/scripts/reading-analysis-session";

const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const context = (extra: Partial<ReadingAnalysisContext> = {}): ReadingAnalysisContext => ({
  documentNodeId: "doc", expectedSourceVersionId: "source", expectedTranslationVersionId: null,
  ranges: [{ from: 2, to: 4, quote: "甲乙" }], sourceText: "甲乙甲乙", sourceLockVersion: 1, translationText: "", translationLockVersion: null, ...extra,
});
const run = (extra: Partial<ReadingAnalysisRun> = {}): ReadingAnalysisRun => ({
  id: "run", documentNodeId: "doc", sourceVersionId: "source", translationVersionId: null,
  sourceHash: createHash("sha256").update("甲乙甲乙").digest("hex"), ranges: [{ from: 2, to: 4, quote: "甲乙" }],
  agentId: "codex", createdAt: "2026-09-23T12:00:00Z", state: "running", detail: "분석 중", result: null, error: null, ...extra,
});
const completed = () => run({ state: "completed", result: { summary: "문맥을 확인하세요.", suggestions: [{
  id: "suggestion", from: 2, to: 3, quote: "甲", reading: "갑", readingOrder: null, citation: null, translationQuote: null,
  explanation: "AI 해석", caution: "추가 확인", applied: false,
}] } });
const annotation = (): ReadingAnnotationView => ({
  id: "note", documentNodeId: "doc", sourceVersionId: "source", codepointFrom: 2, codepointTo: 3, quote: "甲", reading: "갑",
  readingOrder: null, citation: null, translationQuote: null, gloss: "", lockVersion: 1, createdAt: "2026-09-23", updatedAt: "2026-09-23",
});
function fixture() {
  const starts: ReturnType<typeof deferred<IpcResult<ReadingAnalysisRun>>>[] = [];
  const latest: ReturnType<typeof deferred<IpcResult<ReadingAnalysisRun | null>>>[] = [];
  const gets: ReturnType<typeof deferred<IpcResult<ReadingAnalysisRun>>>[] = [];
  const applications: ReturnType<typeof deferred<IpcResult<ReadingAnnotationView>>>[] = [];
  const api = {
    startReadingAnalysis: vi.fn(() => { const request = deferred<IpcResult<ReadingAnalysisRun>>(); starts.push(request); return request.promise; }),
    latestReadingAnalysis: vi.fn(() => { const request = deferred<IpcResult<ReadingAnalysisRun | null>>(); latest.push(request); return request.promise; }),
    getReadingAnalysis: vi.fn(() => { const request = deferred<IpcResult<ReadingAnalysisRun>>(); gets.push(request); return request.promise; }),
    cancelReadingAnalysis: vi.fn(async (id: string) => ({ ok: true as const, data: run({ id, state: "canceled" }) })),
    applyReadingAnalysis: vi.fn(() => { const request = deferred<IpcResult<ReadingAnnotationView>>(); applications.push(request); return request.promise; }),
  } satisfies ReadingAnalysisApi;
  let editable = true;
  const beforeStart = vi.fn(async () => true), applied = vi.fn(), changed = vi.fn();
  const session = configureReadingAnalysisSession({ api, beforeStart, applied, changed, canStart: () => editable, canApply: () => editable });
  return { session, api, starts, latest, gets, applications, beforeStart, applied, setEditable: (next: boolean) => { editable = next; } };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (_algorithm, value) => {
    const buffer = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value as ArrayBuffer);
    return Uint8Array.from(createHash("sha256").update(buffer).digest()).buffer;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("on-demand reading analysis lifecycle", () => {
  it("only restores matching results on entry and never starts or applies them automatically", async () => {
    const f = fixture(); f.session.setContext(context());
    expect(f.api.latestReadingAnalysis).toHaveBeenCalledExactlyOnceWith({ documentNodeId: "doc", expectedSourceVersionId: "source",
      expectedTranslationVersionId: null, ranges: [{ from: 2, to: 4, quote: "甲乙" }] });
    f.latest[0]!.resolve({ ok: true, data: completed() }); await flush();
    expect(f.session.state().run?.state).toBe("completed");
    expect(f.api.startReadingAnalysis).not.toHaveBeenCalled();
    expect(f.api.applyReadingAnalysis).not.toHaveBeenCalled();
    expect(f.applied).not.toHaveBeenCalled();
    f.session.setContext(null);
    expect(await f.session.start()).toBe(false);
  });

  it("restores each unit's saved result after moving from A to B and back to A", async () => {
    const f = fixture(), a = context(), b = context({ ranges: [{ from: 0, to: 2, quote: "甲乙" }] });
    const savedA = completed(), savedB = run({ id: "run-b", state: "completed", ranges: b.ranges,
      result: { summary: "첫 번째 어휘 위치의 분석", suggestions: [] } });
    f.session.setContext(a); f.latest[0]!.resolve({ ok: true, data: savedA }); await flush();
    expect(f.session.state().run?.id).toBe("run");

    f.session.setContext(b);
    expect(f.api.latestReadingAnalysis).toHaveBeenNthCalledWith(2, { documentNodeId: "doc", expectedSourceVersionId: "source",
      expectedTranslationVersionId: null, ranges: b.ranges });
    f.latest[1]!.resolve({ ok: true, data: savedB }); await flush();
    expect(f.session.state().run?.id).toBe("run-b");

    f.session.setContext(a);
    expect(f.api.latestReadingAnalysis).toHaveBeenNthCalledWith(3, { documentNodeId: "doc", expectedSourceVersionId: "source",
      expectedTranslationVersionId: null, ranges: a.ranges });
    f.latest[2]!.resolve({ ok: true, data: savedA }); await flush();
    expect(f.session.state().run).toEqual(savedA);
    expect(f.api.startReadingAnalysis).not.toHaveBeenCalled();
    expect(f.api.applyReadingAnalysis).not.toHaveBeenCalled();
    f.session.dispose();
  });

  it("saves before an explicit start and lets a failed save abort the request", async () => {
    const f = fixture(); f.session.setContext(context()); f.beforeStart.mockResolvedValueOnce(false);
    expect(await f.session.start()).toBe(false);
    expect(f.api.startReadingAnalysis).not.toHaveBeenCalled();
    expect(f.session.state().starting).toBe(false);
    const starting = f.session.start(); await flush();
    expect(f.api.startReadingAnalysis).toHaveBeenCalledExactlyOnceWith({ documentNodeId: "doc", expectedSourceVersionId: "source",
      expectedTranslationVersionId: null, ranges: [{ from: 2, to: 4, quote: "甲乙" }] });
    f.starts[0]!.resolve({ ok: true, data: run() }); expect(await starting).toBe(true);
    f.session.dispose();
  });

  it("cancels a late start response after navigation without leaking polling", async () => {
    const f = fixture(); f.session.setContext(context());
    const starting = f.session.start(); await flush();
    f.session.setContext(context({ ranges: [{ from: 0, to: 2, quote: "甲乙" }] }));
    f.starts[0]!.resolve({ ok: true, data: run() }); expect(await starting).toBe(false);
    expect(f.api.cancelReadingAnalysis).toHaveBeenCalledExactlyOnceWith("run");
    expect(f.session.state().run).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.api.getReadingAnalysis).not.toHaveBeenCalled();
    f.session.dispose();
  });

  it("honors cancel while the start request is pending and ignores its eventual result", async () => {
    const f = fixture(); f.session.setContext(context());
    const starting = f.session.start(); await flush();
    await f.session.cancel();
    expect(f.session.state().starting).toBe(false);
    f.starts[0]!.resolve({ ok: true, data: run() }); expect(await starting).toBe(false);
    expect(f.api.cancelReadingAnalysis).toHaveBeenCalledExactlyOnceWith("run");
    expect(f.session.state().run).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.api.getReadingAnalysis).not.toHaveBeenCalled();
    f.session.dispose();
  });

  it("cancels a running analysis when the saved source lock changes without a new version ID", async () => {
    const f = fixture(); f.session.setContext(context());
    f.latest[0]!.resolve({ ok: true, data: run() }); await flush();
    f.session.setContext(context({ sourceLockVersion: 2 }));
    expect(f.api.cancelReadingAnalysis).toHaveBeenCalledExactlyOnceWith("run");
    expect(f.session.state().run).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.api.getReadingAnalysis).not.toHaveBeenCalled();
    f.session.dispose();
  });

  it("does not let latest or poll responses replace a newer request or different document", async () => {
    const f = fixture(); f.session.setContext(context());
    const starting = f.session.start(); await flush();
    f.starts[0]!.resolve({ ok: true, data: run({ id: "new" }) }); await starting;
    f.latest[0]!.resolve({ ok: true, data: completed() }); await flush();
    expect(f.session.state().run?.id).toBe("new");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.api.getReadingAnalysis).toHaveBeenCalledExactlyOnceWith("new");
    f.session.setContext(context({ documentNodeId: "other" }));
    f.gets[0]!.resolve({ ok: true, data: completed() }); await flush();
    expect(f.session.state().run).toBeNull();
    expect(f.api.cancelReadingAnalysis).toHaveBeenCalledExactlyOnceWith("new");
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.api.getReadingAnalysis).toHaveBeenCalledTimes(1);
    f.session.dispose();
  });

  it.each([
    { sourceHash: "wrong-hash" }, { sourceVersionId: "old-source" }, { translationVersionId: "old-translation" },
    { ranges: [{ from: 0, to: 2, quote: "甲乙" }] },
  ])("ignores persisted analysis for a stale snapshot %j", async mismatch => {
    const f = fixture(); f.session.setContext(context());
    f.latest[0]!.resolve({ ok: true, data: { ...completed(), ...mismatch } }); await flush();
    expect(f.session.state().run).toBeNull();
    expect(await f.session.apply("suggestion")).toBe(false);
    expect(f.api.applyReadingAnalysis).not.toHaveBeenCalled();
    f.session.dispose();
  });

  it("adopts only an explicit proposal while editable and preserves failures for review", async () => {
    const f = fixture(); f.session.setContext(context()); f.latest[0]!.resolve({ ok: true, data: completed() }); await flush();
    f.setEditable(false); expect(await f.session.apply("suggestion")).toBe(false);
    expect(f.api.applyReadingAnalysis).not.toHaveBeenCalled();
    f.setEditable(true); const failed = f.session.apply("suggestion"); await flush();
    f.applications[0]!.resolve({ ok: false, error: { code: "conflict", message: "다른 창에서 풀이를 수정했습니다." } });
    expect(await failed).toBe(false); expect(f.session.state().error).toContain("다른 창");
    expect(f.applied).not.toHaveBeenCalled();
    const applying = f.session.apply("suggestion"); await flush();
    f.applications[1]!.resolve({ ok: true, data: annotation() });
    expect(await applying).toBe(true);
    expect(f.applied).toHaveBeenCalledExactlyOnceWith(annotation());
    expect(f.session.state().run?.result?.suggestions[0]?.applied).toBe(true);
    expect(await f.session.apply("suggestion")).toBe(false);
    f.session.dispose();
  });

  it("ignores adoption responses after the visible context has changed", async () => {
    const f = fixture(); f.session.setContext(context()); f.latest[0]!.resolve({ ok: true, data: completed() }); await flush();
    const applying = f.session.apply("suggestion"); await flush();
    f.session.setContext(null); f.applications[0]!.resolve({ ok: true, data: annotation() });
    expect(await applying).toBe(false); expect(f.applied).not.toHaveBeenCalled();
    expect(f.session.state().applyingId).toBeNull();
  });
});
