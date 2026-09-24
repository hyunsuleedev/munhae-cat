import type { ReadingAnnotationView } from "../../shared/munhae-api";
import type { ReadingAnalysisApi, ReadingAnalysisInput, ReadingAnalysisRun } from "../../shared/reading-analysis-types";

export type ReadingAnalysisContext = ReadingAnalysisInput & {
  sourceText: string;
  sourceLockVersion: number;
  translationText: string;
  translationLockVersion: number | null;
};
export type ReadingAnalysisState = {
  run: ReadingAnalysisRun | null;
  starting: boolean;
  canceling: boolean;
  applyingId: string | null;
  error: string;
  notice: string;
};
type Deps = {
  api: ReadingAnalysisApi;
  canStart(): boolean;
  beforeStart(): Promise<boolean>;
  canApply(): boolean;
  applied(note: ReadingAnnotationView): void;
  changed(): void;
};

async function sourceHash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
const empty = (): ReadingAnalysisState => ({ run: null, starting: false, canceling: false, applyingId: null, error: "", notice: "" });
const messageOf = (error: unknown) => error instanceof Error ? error.message : "AI 분석을 불러오지 못했습니다. 다시 시도하세요.";
const requestFor = ({ documentNodeId, expectedSourceVersionId, expectedTranslationVersionId, ranges }: ReadingAnalysisInput): ReadingAnalysisInput => ({
  documentNodeId, expectedSourceVersionId, expectedTranslationVersionId, ranges,
});

/** Owns one visible source snapshot. Only start() may launch analysis. */
export function configureReadingAnalysisSession(deps: Deps) {
  let context: ReadingAnalysisContext | null = null, contextKey = "", generation = 0;
  let hash: Promise<string> | null = null, state = empty();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const emit = () => deps.changed();
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const current = (ticket: number) => !!context && ticket === generation;
  function stopRemote(run: ReadingAnalysisRun | null) {
    if (run?.state === "running") void deps.api.cancelReadingAnalysis(run.id).catch(() => {});
  }
  async function matches(run: ReadingAnalysisRun, ticket: number) {
    const expected = context, pendingHash = hash;
    if (!expected || !pendingHash || !current(ticket)) return false;
    if (run.documentNodeId !== expected.documentNodeId || run.sourceVersionId !== expected.expectedSourceVersionId
      || run.translationVersionId !== expected.expectedTranslationVersionId || run.ranges.length !== expected.ranges.length
      || run.ranges.some((range, index) => range.from !== expected.ranges[index]!.from || range.to !== expected.ranges[index]!.to || range.quote !== expected.ranges[index]!.quote)) return false;
    const actualHash = await pendingHash;
    if (!current(ticket) || context !== expected || run.sourceHash !== actualHash) return false;
    const chars = Array.from(expected.sourceText);
    return !run.result?.suggestions.some(item => !Number.isInteger(item.from) || !Number.isInteger(item.to) || item.from >= item.to
      || !expected.ranges.some(range => range.from <= item.from && range.to >= item.to)
      || chars.slice(item.from, item.to).join("") !== item.quote);
  }
  function schedule(ticket: number) {
    clearTimer();
    if (!current(ticket) || state.run?.state !== "running") return;
    timer = setTimeout(() => { timer = null; void poll(ticket); }, 1000);
  }
  async function poll(ticket: number) {
    const id = state.run?.id;
    if (!id || !current(ticket)) return;
    try {
      const result = await deps.api.getReadingAnalysis(id);
      if (!current(ticket)) return;
      if (!result.ok) throw new Error(result.error.message);
      if (!await matches(result.data, ticket)) {
        if (current(ticket)) { stopRemote(result.data); state.run = null; state.error = "원문이 달라져 분석을 다시 실행해야 합니다."; emit(); }
        return;
      }
      state.run = result.data; state.error = ""; emit(); schedule(ticket);
    } catch (error) {
      if (current(ticket)) { state.error = messageOf(error); emit(); schedule(ticket); }
    }
  }
  async function latest(ticket: number, input: ReadingAnalysisInput) {
    try {
      const result = await deps.api.latestReadingAnalysis(input);
      if (!current(ticket)) return;
      if (!result.ok) throw new Error(result.error.message);
      if (result.data && await matches(result.data, ticket)) { state.run = result.data; emit(); schedule(ticket); }
    } catch (error) { if (current(ticket)) { state.error = messageOf(error); emit(); } }
  }
  function setContext(next: ReadingAnalysisContext | null) {
    const key = next ? JSON.stringify(next) : "";
    if (key === contextKey) return;
    const previous = state.run;
    ++generation; clearTimer(); context = next; contextKey = key; hash = next ? sourceHash(next.sourceText) : null;
    // A rejected hash is consumed here too when the view is left before a response.
    void hash?.catch(() => {});
    state = empty(); stopRemote(previous); emit();
    if (next) void latest(generation, requestFor(next));
  }
  async function start(): Promise<boolean> {
    if (!context || !deps.canStart() || state.starting || state.canceling || state.applyingId || state.run?.state === "running") return false;
    const expected = context, ticket = ++generation;
    clearTimer(); state = { ...empty(), starting: true }; emit();
    try {
      if (!await deps.beforeStart() || !current(ticket) || context !== expected || !deps.canStart()) return false;
      const result = await deps.api.startReadingAnalysis(requestFor(expected));
      if (!current(ticket)) { if (result.ok) stopRemote(result.data); return false; }
      if (!result.ok) throw new Error(result.error.message);
      if (!await matches(result.data, ticket)) {
        stopRemote(result.data);
        if (current(ticket)) state.error = "원문이 달라져 분석을 다시 실행해야 합니다.";
        return false;
      }
      state.run = result.data; schedule(ticket); return true;
    } catch (error) { if (current(ticket)) state.error = messageOf(error); return false; }
    finally { if (current(ticket)) { state.starting = false; emit(); } }
  }
  async function cancel() {
    if (!context || state.applyingId || state.canceling) return;
    const run = state.run, ticket = ++generation;
    clearTimer(); state.starting = false; state.canceling = !!run && run.state === "running"; state.error = "";
    state.notice = "분석을 취소했습니다."; emit();
    if (!state.canceling || !run) return;
    try {
      const result = await deps.api.cancelReadingAnalysis(run.id);
      if (!current(ticket)) return;
      if (!result.ok) throw new Error(result.error.message);
      if (await matches(result.data, ticket)) state.run = result.data;
    } catch (error) { if (current(ticket)) { state.error = messageOf(error); schedule(ticket); } }
    finally { if (current(ticket)) { state.canceling = false; emit(); } }
  }
  /** `orderOnly` re-applies just the reading order to an existing record and leaves the proposal open. */
  async function apply(suggestionId: string, orderOnly = false): Promise<boolean> {
    const run = state.run, ticket = generation;
    const suggestion = run?.result?.suggestions.find(item => item.id === suggestionId);
    if (!context || !run || run.state !== "completed" || !suggestion || (suggestion.applied && !orderOnly) || state.starting || state.canceling || state.applyingId || !deps.canApply()) return false;
    state.applyingId = suggestionId; state.error = ""; emit();
    try {
      if (!await matches(run, ticket) || !current(ticket) || !deps.canApply()) return false;
      const result = await deps.api.applyReadingAnalysis({ runId: run.id, suggestionId, ...(orderOnly ? { orderOnly: true } : {}) });
      if (!current(ticket)) return false;
      if (!result.ok) throw new Error(result.error.message);
      const note = result.data;
      if (note.documentNodeId !== run.documentNodeId || note.sourceVersionId !== run.sourceVersionId
        || note.codepointFrom !== suggestion.from || note.codepointTo !== suggestion.to || note.quote !== suggestion.quote) throw new Error("저장된 풀이의 원문 위치를 확인할 수 없습니다.");
      if (!orderOnly) state.run = { ...run, result: { ...run.result!, suggestions: run.result!.suggestions.map(item => item.id === suggestionId ? { ...item, applied: true } : item) } };
      deps.applied(note); return true;
    } catch (error) { if (current(ticket)) state.error = messageOf(error); return false; }
    finally { if (current(ticket)) { state.applyingId = null; emit(); } }
  }
  return { setContext, start, cancel, apply, state: () => state, dispose: () => setContext(null) };
}
