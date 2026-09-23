import { t, uiText, ui } from "./i18n";
import type { EditorView, FootnoteAnalysisInput, FootnoteRecommendation, ItkcFootnote, MunhaeApi } from "../../shared/munhae-api";
import { configureFootnoteAnalysisSession, type FootnoteAnalysisState } from "./footnote-analysis-session";
import { footnoteRecommendationText } from "./footnote-analysis-citation";
import "../styles/footnote-analysis.css";

export type FootnoteAnalysisContext = {
  selection?: FootnoteAnalysisInput["selection"];
  isCurrent?(): boolean;
  insertAnalysis?(recommendation: FootnoteRecommendation): void;
};
export type FootnoteAnalysisViewDeps = { view(): EditorView | null; hasUnsavedChanges(): boolean };
type Deps = FootnoteAnalysisViewDeps & {
  api: MunhaeApi;
  dialog: HTMLDialogElement;
  query: HTMLInputElement;
  mode: HTMLSelectElement;
  context(): FootnoteAnalysisContext;
  escape(value: unknown): string;
  showNote(note: ItkcFootnote): void;
  onStart(): void;
};

function selectionMatches(view: EditorView, selection: FootnoteAnalysisInput["selection"]): boolean {
  if (!selection) return true;
  const text = selection.targetKind === "source" ? view.source.contentText : view.translation?.textContent;
  if (text === undefined || !Number.isInteger(selection.from) || !Number.isInteger(selection.to)
    || selection.from < 0 || selection.to <= selection.from || !selection.quote.trim()) return false;
  const points = Array.from(text);
  return selection.to <= points.length && points.slice(selection.from, selection.to).join("") === selection.quote;
}

export function configureFootnoteAnalysisUi(host: HTMLElement, deps: Deps) {
  const esc = deps.escape;
  host.className = "footnote-analysis";
  host.id = "footnoteAnalysis";
  host.setAttribute("aria-label", t("AI 각주 추천"));
  host.innerHTML = uiText(`<div class="footnote-analysis-heading"><div><h3>지금 번역에 필요한 각주</h3><p>검색 결과 앞쪽 최대 50건을 현재 원문·번역과 함께 읽고, 참고할 자료와 이유를 추립니다.</p></div></div>
    <div class="footnote-analysis-controls"><button class="btn btn-primary" id="footnoteAnalysisStart" type="button">AI로 필요한 각주 추리기</button><button class="btn btn-sm" id="footnoteAnalysisCancel" type="button" hidden>중지</button></div>
    <p class="footnote-analysis-status" id="footnoteAnalysisStatus" role="status" aria-live="polite"></p>
    <div id="footnoteAnalysisResults"></div><p class="footnote-analysis-action-status" id="footnoteAnalysisActionStatus" role="status" aria-live="polite"></p>`);
  const el = <T extends HTMLElement>(id: string) => host.querySelector<T>(`#${id}`)!;
  const startButton = el<HTMLButtonElement>("footnoteAnalysisStart");
  const cancelButton = el<HTMLButtonElement>("footnoteAnalysisCancel");
  const status = el<HTMLParagraphElement>("footnoteAnalysisStatus");
  const results = el<HTMLDivElement>("footnoteAnalysisResults");
  const actionStatus = el<HTMLParagraphElement>("footnoteAnalysisActionStatus");
  let expected: FootnoteAnalysisInput | null = null;
  let expectedContext: FootnoteAnalysisContext | null = null;
  let expectedText: { source: string; translation: string | null; sourceLock: number; translationLock: number | null } | null = null;
  let uiState: FootnoteAnalysisState = { phase: "idle", run: null, error: "" };

  function eligibility(): string {
    const view = deps.view();
    if (!view) return t("문서를 열면 현재 문맥에 맞는 각주를 추천받을 수 있습니다.");
    if (deps.hasUnsavedChanges()) return t("편집한 원문·번역을 저장하고 실행하세요.");
    if (view.translation && !view.translation.isCurrentDependencies) return t("현재 원문에 맞는 번역으로 갱신한 뒤 실행하세요.");
    if (deps.context().isCurrent?.() === false || !selectionMatches(view, deps.context().selection)) return t("이 구절의 문서나 버전이 바뀌었습니다. 현재 구절에서 다시 열어 주세요.");
    const query = deps.query.value.trim();
    if (!query) return t("검색할 단어나 구절을 입력하세요. 앱에 설정된 AI로 추천합니다.");
    if (Array.from(query).length > 100) return t("검색어는 100자 이하로 입력하세요.");
    return t("앱에 설정된 AI로 분석합니다. 추천은 번역가가 문맥과 출처를 확인한 뒤 활용하세요.");
  }
  function canStart(): boolean {
    const view = deps.view();
    const query = deps.query.value.trim();
    return !!view && !deps.hasUnsavedChanges() && (!view.translation || view.translation.isCurrentDependencies)
      && deps.context().isCurrent?.() !== false && selectionMatches(view, deps.context().selection)
      && !!query && Array.from(query).length <= 100;
  }
  function isCurrent(): boolean {
    const view = deps.view();
    return !!expected && !!expectedText && !!view && deps.dialog.open && expectedContext === deps.context() && canStart()
      && expected.documentNodeId === view.document.id && expected.expectedSourceVersionId === view.source.versionId
      && expected.expectedTranslationVersionId === (view.translation?.versionId ?? null)
      && expectedText.source === view.source.contentText && expectedText.translation === (view.translation?.textContent ?? null)
      && expectedText.sourceLock === view.source.lockVersion && expectedText.translationLock === (view.translation?.lockVersion ?? null)
      && expected.query === deps.query.value.trim() && expected.mode === deps.mode.value;
  }

  function render(state: FootnoteAnalysisState): void {
    uiState = state;
    const busy = ["starting", "collecting", "analyzing", "canceling"].includes(state.phase);
    const current = state.phase === "completed" && isCurrent();
    startButton.disabled = busy || !canStart();
    startButton.textContent = state.phase === "completed" ? t("다시 추천받기") : t("AI로 필요한 각주 추리기");
    cancelButton.hidden = !busy && !(state.phase === "failed" && (state.run?.state === "collecting" || state.run?.state === "analyzing"));
    cancelButton.disabled = state.phase === "canceling";
    host.setAttribute("aria-busy", String(busy));
    status.classList.toggle("is-error", state.phase === "failed" || state.phase === "stale");
    const run = state.run;
    const provider = run ? ({ codex: "Codex", claude: "Claude", antigravity: "Antigravity" }[run.agentId]) : t("설정된 AI");
    status.textContent = state.phase === "starting" ? t("각주 추천을 준비하고 있습니다…")
      : state.phase === "collecting" ? ui`한국고전종합DB 각주를 모으고 있습니다 · ${run?.collectedCount ?? 0}건${run?.total == null ? "" : ui` / 검색 결과 ${run.total.toLocaleString()}건`}`
      : state.phase === "analyzing" ? ui`${provider}가 각주 ${run?.collectedCount ?? 0}건을 현재 문맥과 대조하고 있습니다…`
      : state.phase === "failed" || state.phase === "stale" ? state.error
      : state.phase === "canceling" ? t("AI 작업의 중지를 확인하고 있습니다…")
      : state.phase === "canceled" ? t("추천 작업을 중지했습니다. 검색 결과는 계속 확인할 수 있습니다.")
      : state.phase === "completed" ? ui`${provider} 추천 완료 · ${run?.result?.recommendations.length ?? 0}건`
      : eligibility();
    const result = state.phase === "completed" ? run?.result : null;
    if (!result) { results.replaceChildren(); return; }
    results.innerHTML = ui`<p class="footnote-analysis-summary">${esc(result.summary)}</p>
      <p class="footnote-analysis-coverage">검색 결과 ${result.total.toLocaleString()}건 중 ${result.analyzedCount.toLocaleString()}건 검토 · 미검토 ${result.omittedCount.toLocaleString()}건${result.excerptedCount ? ui` · 설명을 발췌해 읽은 자료 ${result.excerptedCount}건` : ""}</p>
      ${result.limitations.length ? `<ul class="footnote-analysis-limitations">${result.limitations.map(value => `<li>${esc(value)}</li>`).join("")}</ul>` : ""}
      <div class="footnote-recommendations">${result.recommendations.map((recommendation, index) => ui`<article class="footnote-recommendation">
        <div class="footnote-recommendation-heading"><span>${recommendation.relevance === "direct" ? t("직접 관련 후보") : t("문맥 참고")}</span><h4>${esc(recommendation.note.annotatedText || recommendation.note.displayTitle)}</h4></div>
        <dl><dt>참고할 이유</dt><dd>${esc(recommendation.reason)}</dd><dt>번역에 반영할 점</dt><dd>${esc(recommendation.translationAdvice)}</dd>${recommendation.caution ? ui`<dt>확인할 점</dt><dd>${esc(recommendation.caution)}</dd>` : ""}</dl>
        <blockquote>${esc(recommendation.evidenceQuote)}<cite>${esc(recommendation.note.bookTitle || t("서명 정보 없음"))}</cite></blockquote>
        <div class="footnote-recommendation-actions"><button class="btn btn-sm" type="button" data-footnote-recommendation-view="${index}">각주 전문·출처 보기</button><button class="btn btn-sm" type="button" data-footnote-recommendation-copy="${index}"${current ? "" : " disabled"}>추천과 출처 복사</button>${deps.context().insertAnalysis ? ui`<button class="btn btn-sm" type="button" data-footnote-recommendation-insert="${index}"${current ? "" : " disabled"}>코멘트에 넣기</button>` : ""}</div>
      </article>`).join("") || uiText('<p class="footnote-analysis-empty">검토한 자료 중 추천할 각주를 찾지 못했습니다. 검색어를 바꾸거나 검색 범위를 넓혀 보세요.</p>')}</div>
      <details class="footnote-analysis-context"><summary>AI가 참고한 문맥</summary><p class="footnote-label">원문</p><div>${esc(result.sourceContext)}</div>${result.translationContext ? ui`<p class="footnote-label">번역문</p><div>${esc(result.translationContext)}</div>` : ""}</details>`;
  }

  const session = configureFootnoteAnalysisSession(deps.api.research, render, isCurrent);
  function reset(): void {
    expected = null;
    expectedContext = null;
    expectedText = null;
    actionStatus.textContent = "";
    session.reset();
  }
  function start(): void {
    if (!canStart()) { render(uiState); return; }
    const view = deps.view()!;
    expectedContext = deps.context();
    expectedText = {
      source: view.source.contentText, translation: view.translation?.textContent ?? null,
      sourceLock: view.source.lockVersion, translationLock: view.translation?.lockVersion ?? null,
    };
    expected = {
      documentNodeId: view.document.id,
      expectedSourceVersionId: view.source.versionId,
      expectedTranslationVersionId: view.translation?.versionId ?? null,
      query: deps.query.value.trim(),
      mode: deps.mode.value === "content" ? "content" : "target",
      ...(expectedContext.selection ? { selection: { ...expectedContext.selection } } : {}),
    };
    actionStatus.textContent = "";
    deps.onStart();
    void session.start(expected);
  }
  startButton.addEventListener("click", start);
  cancelButton.addEventListener("click", () => session.cancel());
  results.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    const index = Number(button?.dataset.footnoteRecommendationView ?? button?.dataset.footnoteRecommendationCopy ?? button?.dataset.footnoteRecommendationInsert);
    const recommendation = uiState.phase === "completed" ? uiState.run?.result?.recommendations[index] : null;
    if (!button || !recommendation) return;
    if (button.dataset.footnoteRecommendationView !== undefined) { deps.showNote(recommendation.note); return; }
    if (!isCurrent()) { session.refresh(); return; }
    if (button.dataset.footnoteRecommendationCopy !== undefined) {
      const request = expected;
      void navigator.clipboard.writeText(footnoteRecommendationText(recommendation)).then(() => {
        if (expected === request && isCurrent()) actionStatus.textContent = t("AI 추천과 출처를 함께 복사했습니다.");
      }).catch(() => { if (expected === request && isCurrent()) actionStatus.textContent = t("복사하지 못했습니다. 다시 시도해 주세요."); });
    } else if (button.dataset.footnoteRecommendationInsert !== undefined && deps.context().insertAnalysis) {
      try { deps.context().insertAnalysis!(recommendation); deps.dialog.close(); }
      catch (cause) { actionStatus.textContent = cause instanceof Error ? cause.message : t("코멘트에 넣지 못했습니다."); }
    }
  });
  render(uiState);
  return { reset, start, isCurrent, refresh: () => { session.refresh(); render(session.state()); } };
}
