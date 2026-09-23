import { t, ui } from "./i18n";
import type { FootnoteAnalysisInput, FootnoteAnalysisRun, MunhaeApi } from "../../shared/munhae-api";

export type FootnoteAnalysisState = {
  phase: FootnoteAnalysisRun["state"] | "idle" | "starting" | "canceling" | "stale";
  run: FootnoteAnalysisRun | null;
  error: string;
};
type AnalysisApi = Pick<MunhaeApi["research"], "startFootnoteAnalysis" | "getFootnoteAnalysis" | "cancelFootnoteAnalysis">;
const active = (run: FootnoteAnalysisRun | null) => run?.state === "collecting" || run?.state === "analyzing";

/** Owns one explicit AI request, including late start replies after close/reset. */
export function configureFootnoteAnalysisSession(
  api: AnalysisApi,
  onChange: (state: FootnoteAnalysisState) => void,
  isCurrent: () => boolean,
) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let state: FootnoteAnalysisState = { phase: "idle", run: null, error: "" };
  let userCancelGeneration: number | null = null;
  let pendingStartGeneration: number | null = null;
  let canceledStartGeneration: number | null = null;

  const publish = (next: FootnoteAnalysisState) => { state = next; onChange(state); };
  const cancelRun = (run: FootnoteAnalysisRun | null) => {
    if (active(run)) void api.cancelFootnoteAnalysis(run!.id).catch(() => {});
  };
  function invalidate(cancel = true): void {
    ++generation;
    userCancelGeneration = null;
    canceledStartGeneration = null;
    if (timer) clearTimeout(timer);
    timer = null;
    if (cancel) cancelRun(state.run);
  }
  function reset(): void {
    invalidate();
    publish({ phase: "idle", run: null, error: "" });
  }
  function stale(): void {
    invalidate();
    publish({ phase: "stale", run: null, error: t("문서나 검색 조건이 바뀌었습니다. 현재 내용으로 다시 추천받으세요.") });
  }
  function accept(run: FootnoteAnalysisRun, current: number): void {
    publish({ phase: run.state, run, error: run.error?.message ?? "" });
    if (active(run)) timer = setTimeout(() => { void poll(run.id, current); }, 800);
  }
  async function poll(id: string, current: number): Promise<void> {
    timer = null;
    if (current !== generation) return;
    if (!isCurrent()) { stale(); return; }
    try {
      const response = await api.getFootnoteAnalysis(id);
      if (current !== generation) return;
      if (!isCurrent()) { stale(); return; }
      if (!response.ok) throw new Error(response.error.message);
      accept(response.data, current);
    } catch (cause) {
      if (current !== generation) return;
      cancelRun(state.run);
      publish({ phase: "failed", run: state.run, error: cause instanceof Error ? cause.message : t("AI 추천 상태를 확인하지 못했습니다.") });
    }
  }
  async function start(input: FootnoteAnalysisInput): Promise<void> {
    invalidate();
    const current = generation;
    pendingStartGeneration = current;
    publish({ phase: "starting", run: null, error: "" });
    try {
      const response = await api.startFootnoteAnalysis(input);
      if (current !== generation || !isCurrent()) {
        if (response.ok) {
          if (userCancelGeneration === generation && canceledStartGeneration === current && state.phase === "canceling") void confirmCancel(response.data, generation);
          else cancelRun(response.data);
        } else if (userCancelGeneration === generation && canceledStartGeneration === current && state.phase === "canceling") publish({ phase: "canceled", run: null, error: "" });
        if (current === generation) stale();
        return;
      }
      if (!response.ok) throw new Error(response.error.message);
      accept(response.data, current);
    } catch (cause) {
      if (current === generation) publish({ phase: "failed", run: null, error: cause instanceof Error ? cause.message : t("AI 추천을 시작하지 못했습니다.") });
      else if (userCancelGeneration === generation && canceledStartGeneration === current && state.phase === "canceling") publish({ phase: "canceled", run: null, error: "" });
    } finally {
      if (pendingStartGeneration === current) pendingStartGeneration = null;
    }
  }
  async function confirmCancel(run: FootnoteAnalysisRun, current: number): Promise<void> {
    try {
      if (active(run)) {
        const response = await api.cancelFootnoteAnalysis(run.id);
        if (current !== generation) return;
        if (!response.ok) throw new Error(response.error.message);
        if (active(response.data)) throw new Error(t("AI 작업이 아직 실행 중입니다. 다시 중지해 주세요."));
      }
      if (current === generation) publish({ phase: "canceled", run: null, error: "" });
    } catch (cause) {
      if (current === generation) publish({ phase: "failed", run, error: ui`중지를 확인하지 못했습니다. ${cause instanceof Error ? cause.message : t("다시 중지해 주세요.")}` });
    }
  }
  function cancel(): void {
    const run = state.run;
    const wasStarting = state.phase === "starting";
    const pending = pendingStartGeneration;
    invalidate(false);
    userCancelGeneration = generation;
    canceledStartGeneration = wasStarting ? pending : null;
    publish({ phase: "canceling", run, error: "" });
    if (run) void confirmCancel(run, generation);
    else if (!wasStarting) publish({ phase: "canceled", run: null, error: "" });
  }
  function refresh(): void {
    if (state.phase !== "idle" && state.phase !== "canceled" && state.phase !== "stale" && !isCurrent()) stale();
  }
  return { start, cancel, reset, refresh, state: () => state };
}
