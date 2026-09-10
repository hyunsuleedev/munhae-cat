import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProbe, AgentRunRequest, AgentRunResult } from "@munhae/agent-runtime";
import { DEFAULT_APP_CONFIG, type EditorView, type FootnoteAnalysisInput, type ItkcFootnote } from "../src/shared/munhae-api";
vi.mock("../src/main/agent-runtime-client", () => ({ cancelAgentRuntime: vi.fn(), probeAgentRuntime: vi.fn(), resumeAgentRuntime: vi.fn(), runAgentRuntime: vi.fn() }));
vi.mock("../src/main/window", () => ({ getMainWindow: () => null }));
import { FootnoteAnalysisService } from "../src/main/footnote-analysis";
import { cancelAllAiRuns, hasActiveAiRuns, registerExternalAiActivity } from "../src/main/ai-runs";

afterEach(async () => { vi.useRealTimers(); await cancelAllAiRuns(); });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const probe = { agentId: "claude", installed: true, loggedIn: true, version: "test", capabilities: { structuredOutput: true } } as AgentProbe;
const note = (n: number, bodyText = `태수는 지방의 장관을 이르는 말이다. 예시 ${n}.`): ItkcFootnote => ({ id: `NOTE${n}`, annotatedText: `태수 ${n}`, displayTitle: "태수", bodyText, bookTitle: "문집", translator: "번역자", publisher: "연구소", year: "2026", sourceUrl: `https://db.itkc.or.kr/example?id=${n}` });
function fixture() {
  const view = { project: { id: "project" }, document: { id: "doc", title: "서문", originalTitle: "序", nodeRole: "source_unit", authorName: "저자", periodText: "조선", dateText: null, language: "zh-Hant", sourceReference: "원서 1권" },
    source: { versionId: "source-v1", versionNo: 1, contentText: "甲太守乙太守丙", state: "draft", lockVersion: 1 }, punctuation: null,
    translation: { versionId: "translation-v1", versionNo: 1, textContent: "첫 태수다. 둘째 태수다.", isCurrentDependencies: true, state: "draft", textLayout: { state: "ready", error: null,
      sentences: [{ id: "T1", from: 0, to: 6, text: "첫 태수다." }, { id: "T2", from: 7, to: 14, text: "둘째 태수다." }],
      links: [{ sentenceId: "T1", spans: [{ from: 1, to: 3, quote: "太守" }], needsReview: false }, { sentenceId: "T2", spans: [{ from: 4, to: 6, quote: "太守" }], needsReview: false }] } },
  } as EditorView;
  const repo = { projectId: "project", getEditor: vi.fn(() => view) };
  const input: FootnoteAnalysisInput = { documentNodeId: "doc", expectedSourceVersionId: "source-v1", expectedTranslationVersionId: "translation-v1", query: "태수", mode: "target", selection: { targetKind: "source", from: 4, to: 6, quote: "太守" } };
  return { view, repo, input };
}
function success(output: unknown): AgentRunResult { return { ok: true, outputText: JSON.stringify(output), structuredOutput: output } as AgentRunResult; }
function recommendation(id = "NOTE0", evidenceQuote = "태수는 지방의 장관을 이르는 말이다.") { return { id, relevance: "contextual", reason: "관직 뜻을 비교하는 근거다.", translationAdvice: "이 문서의 시대를 확인한 뒤 관직명으로 옮긴다.", caution: "같은 인물이라는 뜻은 아니다.", evidenceQuote }; }
function setup(options: { total?: number; notes?: ItkcFootnote[]; output?: unknown; customProbe?: AgentProbe; runtime?: (request: AgentRunRequest) => Promise<AgentRunResult>; registerReal?: boolean; collectionTimeoutMs?: number; analysisTimeoutMs?: number } = {}) {
  const f = fixture();
  const records = options.notes ?? Array.from({ length: options.total ?? 21 }, (_, i) => note(i));
  const completions: Promise<void>[] = [];
  const search = vi.fn(async (input: { query: string; mode: "target" | "content"; start?: number }) => ({ ...input, start: input.start ?? 0, pageSize: 10 as const,
    searchMode: "annotated-text" as const, total: records.length, hasMore: (input.start ?? 0) + 10 < records.length, items: records.slice(input.start ?? 0, (input.start ?? 0) + 10) }));
  const run = vi.fn(async (_agent: string, request: AgentRunRequest) => options.runtime ? options.runtime(request) : success(options.output ?? { summary: "관직의 뜻을 참고할 수 있다.", recommendations: [recommendation()] }));
  const cancel = vi.fn(async () => {});
  const service = new FootnoteAnalysisService({ search, probe: vi.fn(async () => options.customProbe ?? probe), run, cancel,
    register: activity => { if (options.registerReal) registerExternalAiActivity(activity); completions.push(activity.completion); },
    ...(options.collectionTimeoutMs ? { collectionTimeoutMs: options.collectionTimeoutMs } : {}), ...(options.analysisTimeoutMs ? { analysisTimeoutMs: options.analysisTimeoutMs } : {}) });
  return { ...f, service, search, run, cancel, completions, async finish() { await Promise.all(completions); } };
}
describe("AI footnote analysis", () => {
  it("returns an immediate run and collects beyond the visible first page before grounded recommendations", async () => {
    const f = setup({ total: 61, output: { summary: "뒤쪽 후보에 근거가 있다.", recommendations: [recommendation("NOTE42")] } });
    const initial = f.service.start(f.repo, DEFAULT_APP_CONFIG, f.input);
    expect(initial.state).toBe("collecting"); expect(initial.collectedCount).toBe(0);
    await f.finish();
    expect(f.search.mock.calls.map(([input]) => input.start)).toEqual([0, 10, 20, 30, 40]);
    const done = f.service.get(f.repo, initial.id);
    expect(done.state).toBe("completed"); expect(done.result).toMatchObject({ analyzedCount: 50, total: 61, omittedCount: 11 });
    expect(done.result!.recommendations[0]!.note.id).toBe("NOTE42");
    expect(done.result!.recommendations[0]!.note.sourceUrl).toBe("https://db.itkc.or.kr/example?id=42");
    expect(done.result!.translationContext).toBe("둘째 태수다.");
    const request = f.run.mock.calls[0]![1];
    expect(request).not.toHaveProperty("appTool"); expect(request).toHaveProperty("outputSchema");
    expect(request.prompt).toContain('"from":4,"to":6,"quote":"太守"');
  });
  it.each([
    { summary: "허위", recommendations: [recommendation("FORGED")] },
    { summary: "허위", recommendations: [recommendation("NOTE0", "존재하지 않는 인용")] },
    { summary: "중복", recommendations: [recommendation(), recommendation()] },
    { summary: "추가 필드", recommendations: [{ ...recommendation(), sourceUrl: "https://invented.example" }] },
  ])("rejects ungrounded or duplicate citations and model-created URL fields", async output => {
    const f = setup({ output }); const run = f.service.start(f.repo, DEFAULT_APP_CONFIG, f.input); await f.finish();
    expect(f.service.get(f.repo, run.id)).toMatchObject({ state: "failed", error: { code: "invalid_analysis" }, result: null });
  });
  it("budgets long candidates without truncating their stored originals and rejects evidence outside the analyzed excerpt", async () => {
    const body = "태수는 지방의 장관을 이르는 말이다。" + "甲".repeat(9_000) + "분석에 없는 마지막 근거";
    const records = Array.from({ length: 50 }, (_, i) => note(i, body));
    const f = setup({ notes: records, output: { summary: "용어 참고", recommendations: [recommendation("NOTE0", "태수는 지방의 장관을 이르는 말이다。")] } });
    const run = f.service.start(f.repo, DEFAULT_APP_CONFIG, f.input); await f.finish();
    const result = f.service.get(f.repo, run.id).result!;
    expect(Array.from(f.run.mock.calls[0]![1].prompt).length).toBeLessThanOrEqual(100_000);
    expect(result.analyzedCount).toBe(50); expect(result.excerptedCount).toBe(50);
    expect(result.recommendations[0]!.note.bodyText).toBe(body);
    const bad = setup({ notes: records, output: { summary: "허위 근거", recommendations: [recommendation("NOTE0", "분석에 없는 마지막 근거")] } });
    const badRun = bad.service.start(bad.repo, DEFAULT_APP_CONFIG, bad.input); await bad.finish();
    expect(bad.service.get(bad.repo, badRun.id).error?.code).toBe("invalid_analysis");
  });
  it("does not invoke AI for zero search results and accepts an empty recommendation list", async () => {
    const zero = setup({ total: 0 }); const run = zero.service.start(zero.repo, DEFAULT_APP_CONFIG, zero.input); await zero.finish();
    expect(zero.run).not.toHaveBeenCalled(); expect(zero.service.get(zero.repo, run.id).result).toMatchObject({ recommendations: [], analyzedCount: 0 });
    const empty = setup({ output: { summary: "관련 근거가 충분하지 않다.", recommendations: [] } }); const next = empty.service.start(empty.repo, DEFAULT_APP_CONFIG, empty.input); await empty.finish();
    expect(empty.service.get(empty.repo, next.id)).toMatchObject({ state: "completed", result: { recommendations: [] } });
  });
  it("requires exact selected coordinates and version identity instead of finding a repeated word", () => {
    const f = setup();
    expect(() => f.service.start(f.repo, DEFAULT_APP_CONFIG, { ...f.input, selection: { ...f.input.selection, from: 3, to: 5 } })).toThrow();
    expect(() => f.service.start(f.repo, DEFAULT_APP_CONFIG, { ...f.input, expectedSourceVersionId: "old" })).toThrow();
    expect(f.search).not.toHaveBeenCalled();
  });
  it("derives source context from exact translation sentence links, not the first matching phrase", async () => {
    const f = setup();
    f.view.source.contentText = "초기 문맥" + "甲".repeat(2_000) + "후기太守文脈";
    const at = Array.from(f.view.source.contentText).length - 4;
    f.view.translation!.textLayout!.links[1]!.spans = [{ from: at, to: at + 2, quote: "太守" }];
    f.input.selection = { targetKind: "translation", from: 10, to: 12, quote: "태수" };
    const run = f.service.start(f.repo, DEFAULT_APP_CONFIG, f.input); await f.finish();
    const result = f.service.get(f.repo, run.id).result!;
    expect(result.sourceContext).toContain("후기太守文脈"); expect(result.sourceContext).not.toContain("초기 문맥");
  });
  it("omits unsupported provider schemas and keeps the common strict JSON validation", async () => {
    const f = setup({ customProbe: { ...probe, agentId: "antigravity", loggedIn: null, capabilities: { ...probe.capabilities, structuredOutput: false } } });
    const config = { ...DEFAULT_APP_CONFIG, agentId: "antigravity" as const };
    const run = f.service.start(f.repo, config, f.input); await f.finish();
    expect(f.run.mock.calls[0]![1]).not.toHaveProperty("outputSchema"); expect(f.service.get(f.repo, run.id).state).toBe("completed");
  });
  it("does not fetch candidates when auth is unavailable and never leaks provider errors", async () => {
    const auth = setup({ customProbe: { ...probe, loggedIn: false } }); const run = auth.service.start(auth.repo, DEFAULT_APP_CONFIG, auth.input); await auth.finish();
    expect(auth.search).not.toHaveBeenCalled(); expect(auth.service.get(auth.repo, run.id).error?.code).toBe("auth_required");
    const error = setup({ runtime: async () => { throw Object.assign(new Error("Bearer SECRET /private/auth.json"), { code: "strange_SECRET" }); } });
    const failed = error.service.start(error.repo, DEFAULT_APP_CONFIG, error.input); await error.finish();
    expect(JSON.stringify(error.service.get(error.repo, failed.id))).not.toContain("SECRET");
  });
  it("discards a late response when the version or same-version source bytes change", async () => {
    for (const kind of ["version", "text"] as const) {
      const response = deferred<AgentRunResult>(); const f = setup({ runtime: () => response.promise });
      const run = f.service.start(f.repo, DEFAULT_APP_CONFIG, f.input);
      await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
      if (kind === "version") f.view.source.versionId = "source-v2"; else f.view.source.contentText += "changed";
      response.resolve(success({ summary: "이전 내용", recommendations: [recommendation()] })); await f.finish();
      expect(f.service.get(f.repo, run.id)).toMatchObject({ state: "failed", error: { code: "stale_request" }, result: null });
    }
  });
  it("cancels collection without launching AI and keeps active inference reserved until provider completion", async () => {
    const page = deferred<Awaited<ReturnType<ReturnType<typeof setup>["search"]>>>();
    const f = setup({ registerReal: true }); f.search.mockImplementation(() => page.promise);
    const run = f.service.start(f.repo, DEFAULT_APP_CONFIG, f.input);
    expect(hasActiveAiRuns(f.repo.projectId)).toBe(true);
    expect(() => f.service.start(f.repo, DEFAULT_APP_CONFIG, f.input)).toThrow(/진행 중/);
    await vi.waitFor(() => expect(f.search).toHaveBeenCalled());
    expect(f.service.cancel(f.repo, run.id).state).toBe("canceled"); await f.finish();
    expect(f.run).not.toHaveBeenCalled(); expect(hasActiveAiRuns()).toBe(false);
    const response = deferred<AgentRunResult>(); const g = setup({ registerReal: true, runtime: () => response.promise });
    const analyzing = g.service.start(g.repo, DEFAULT_APP_CONFIG, g.input); await vi.waitFor(() => expect(g.run).toHaveBeenCalled());
    g.service.cancel(g.repo, analyzing.id); await Promise.resolve();
    expect(g.cancel).toHaveBeenCalledWith(analyzing.id); expect(hasActiveAiRuns()).toBe(true);
    response.resolve(success({ summary: "취소 후 응답", recommendations: [recommendation()] })); await g.finish();
    expect(hasActiveAiRuns()).toBe(false); expect(g.service.get(g.repo, analyzing.id).result).toBeNull();
  });
  it("includes external collection in global app cancellation and rejects cross-project getters", async () => {
    const f = setup({ registerReal: true }); const pending = deferred<AgentProbe>();
    const g = new FootnoteAnalysisService({ probe: () => pending.promise, register: registerExternalAiActivity });
    const run = g.start(f.repo, DEFAULT_APP_CONFIG, f.input);
    expect(() => g.get({ ...f.repo, projectId: "other" }, run.id)).toThrow(/분석 기록/);
    await cancelAllAiRuns(); expect(hasActiveAiRuns()).toBe(false); expect(g.get(f.repo, run.id).state).toBe("canceled");
  });
  it("expires collection within its deadline without waiting for an unresponsive request", async () => {
    vi.useFakeTimers(); const f = setup({ collectionTimeoutMs: 100 }); f.search.mockImplementation(() => new Promise(() => {}));
    const run = f.service.start(f.repo, DEFAULT_APP_CONFIG, f.input);
    await vi.advanceTimersByTimeAsync(101); await f.finish();
    expect(f.service.get(f.repo, run.id).error?.code).toBe("collection_timeout"); expect(f.run).not.toHaveBeenCalled();
  });
});
