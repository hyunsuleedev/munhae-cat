import { uiText, t, ui } from "./i18n";
import type { EditorView, MunhaeApi, ReadingAnnotationView, ReadingCitation } from "../../shared/munhae-api";
import type { DictionaryEntry } from "../../shared/dictionary-types";
import { buildReadingUnits, readingTokens, type ReadingUnit, type ReadingToken } from "./reading-model";
import type { ReadingAnalysisSuggestion } from "../../shared/reading-analysis-types";
import { packReadingRows } from "./reading-layout";
import { createReadingAnalysisDialog } from "./reading-analysis-dialog";
import { configureReadingAnalysisSession } from "./reading-analysis-session";
import "../styles/reading-study.css";

type Selection = { from: number; to: number; rangeIndex: number };
type Draft = { reading: string; readingOrder: number | null; citation: ReadingCitation | null; translationQuote: string | null };
type Deps = { api: MunhaeApi; host: HTMLElement; inspectorHost?: HTMLElement; openInspector?(): void; escape(value: unknown): string; notify(message: string, title?: string): void; canEdit(): boolean; changed(): void; edited(): void };

export function configureReadingStudy(deps: Deps) {
  const { api, host, escape: esc } = deps;
  host.classList.add("reading-study");
  host.innerHTML = uiText(`<header class="rs-toolbar" role="toolbar" aria-label="구절 연구 도구">
    <div class="rs-navigation" role="group" aria-label="구절 이동">
      <button type="button" class="btn btn-ghost btn-sm rs-step" id="rsPrevious" title="이전 연구 구절" aria-label="이전 연구 구절">↑</button>
      <button type="button" class="btn btn-ghost btn-sm rs-unit-trigger" id="rsUnit" popovertarget="rsUnitPicker" aria-haspopup="dialog" aria-controls="rsUnitPicker" aria-expanded="false" aria-label="연구할 구절"><span id="rsUnitCount">0 / 0</span><svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button type="button" class="btn btn-ghost btn-sm rs-step" id="rsNext" title="다음 연구 구절" aria-label="다음 연구 구절">↓</button>
    </div>
    <div id="rsUnitPicker" class="rs-unit-picker" popover role="dialog" aria-label="연구할 구절">
      <div class="rs-unit-search"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.25"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg><input id="rsUnitSearch" type="text" role="combobox" aria-label="구절 번호 또는 원문 검색" placeholder="구절 번호 또는 원문 검색" aria-autocomplete="list" aria-expanded="false" aria-controls="rsUnitList" autocomplete="off" spellcheck="false" autofocus></div>
      <div id="rsUnitList" class="rs-unit-list" role="listbox" aria-label="연구할 구절"></div>
      <p id="rsUnitNoResults" class="rs-unit-empty" role="status" hidden>일치하는 구절이 없습니다.</p>
      <div class="rs-unit-foot" aria-hidden="true"><span>↑ ↓ 이동</span><span>Enter 선택</span><span>Esc 닫기</span></div>
    </div>
    <button class="btn btn-sm rs-ai-trigger" type="button" id="rsAnalyze" title="현재 구절의 독음과 뜻풀이 분석">현재 구절 AI 분석</button>
    <button class="btn btn-ghost btn-sm rs-more-trigger" type="button" id="rsMore" popovertarget="rsMoreActions" aria-haspopup="dialog" aria-controls="rsMoreActions" aria-label="구절 연구 추가 작업" title="구절 연구 추가 작업">⋯</button>
    <div id="rsMoreActions" class="rs-more-actions" popover role="dialog" aria-label="구절 연구 추가 작업"><button class="btn btn-ghost" type="button" id="rsReload">저장된 주석 다시 불러오기</button></div>
    </header><p id="rsStatus" class="rs-status" role="status"></p><p id="rsEmpty" class="rs-empty" hidden>저장된 원문이 없습니다. 원문을 입력하고 저장한 뒤 구절을 살펴보세요.</p>
    <div class="rs-spread" id="rsSpread"><article class="rs-document">
      <section aria-label="연구 원문"><div class="rs-section-label"><span>原文</span><h3 id="rsUnitTitle">원문 구절</h3><small id="rsVersion"></small></div><div id="rsSource" class="rs-source hanmun"></div></section>
      <section class="rs-translation" aria-label="연결된 번역"><div class="rs-section-label"><span>譯文</span><h3>연결된 번역</h3></div><p id="rsTranslation"></p><p id="rsAlignment" class="rs-help"></p></section>
      <section class="rs-analysis" aria-label="글자별 풀이"><div class="rs-analysis-heading"><h3>글자별 풀이</h3><div class="rs-analysis-tools"><button type="button" class="btn btn-ghost btn-sm rs-order-mode" id="rsOrderMode" aria-pressed="false" title="글자를 누르는 순서대로 풀이 순서를 매깁니다">순서 매기기</button><div class="rs-switch" role="group" aria-label="풀이 표시 순서"><button type="button" id="rsSourceOrder" aria-pressed="true">원문 순서</button><button type="button" id="rsReadingOrder" aria-pressed="false">풀이 순서</button></div></div></div>
        <div id="rsTokens" class="rs-tokens"></div><p class="rs-help">기본 훈은 사전 첫 항목 · Shift+클릭으로 어휘 선택 · ← → 글자 이동</p><div id="rsSavedPhrases" class="rs-saved-phrases" aria-label="저장된 어휘 풀이"></div>
      </section>
      <details id="rsOldNotes" class="rs-old-notes" hidden><summary id="rsOldSummary"></summary><p>이전 원문의 주석은 해당 버전에 보존되어 있습니다. 현재 원문으로 자동 이동하지 않습니다.</p><div id="rsOldList"></div></details>
    </article>
    <aside class="rs-dictionary" aria-label="선택 글자와 어휘 연구"><div class="rs-inspector-body" id="rsInspectorBody">
      <form id="rsForm" class="rs-annotation"><div class="rs-inspector-label"><h3>선택한 글자·어휘</h3><small id="rsPosition"></small></div><b id="rsSelected" class="rs-selected hanmun"></b>
        <div class="rs-fields"><label>독음<input class="input" id="rsReading" maxlength="100" autocomplete="off" placeholder="독음 입력"></label><label>풀이 순서<input class="input" id="rsOrder" type="number" min="1" max="10000" placeholder="선택"></label></div>
        <section class="rs-citation" id="rsCitation" hidden aria-label="선택한 사전 뜻"><div class="rs-citation-heading"><span>선택한 뜻</span><button type="button" id="rsClearCitation">선택 해제</button></div><div id="rsCitationBody"></div></section>
        <section class="rs-memo" id="rsMemo" hidden aria-label="풀이 메모"><small>풀이 메모 · 채택한 AI 해석 또는 직접 쓴 풀이</small><p id="rsMemoBody"></p></section>
        <section class="rs-link" id="rsLink" aria-label="번역 대응"><small>번역 대응</small><p id="rsLinkBody"></p><div class="rs-link-actions"><button type="button" class="btn btn-ghost btn-sm" id="rsLinkSelection" hidden></button><button type="button" class="btn btn-ghost btn-sm" id="rsClearLink" hidden>연결 해제</button></div></section>
        <button type="button" class="rs-proposal-hint" id="rsProposalHint" hidden></button>
      </form>
      <div class="rs-inspector-tabs seg wide" role="tablist" aria-label="연구 도구"><button type="button" role="tab" id="rsDictionaryTab" aria-selected="true" aria-controls="rsDictionarySection">사전</button><button type="button" role="tab" id="rsAiTab" aria-selected="false" tabindex="-1" aria-controls="rsAnalysisPanel" hidden>AI 제안</button></div>
      <section class="rs-ai-panel" id="rsAnalysisPanel" role="tabpanel" aria-labelledby="rsAiTab" aria-label="현재 구절 AI 분석" hidden><div class="rs-ai-heading"><h3>AI 분석</h3><label class="rs-ai-auto"><input type="checkbox" id="rsAutoAdopt"><span>완료 시 자동 채택</span></label><button class="btn btn-ghost btn-sm" type="button" id="rsCancelAnalysis" hidden>취소</button></div><p class="rs-ai-error" id="rsAnalysisError" role="alert" hidden></p><div id="rsAnalysisContent"><p class="rs-ai-state" id="rsAnalysisState" role="status"></p><div class="rs-ai-actions"><button class="btn btn-sm" type="button" id="rsAdoptAll" hidden></button><button class="btn btn-ghost btn-sm" type="button" id="rsAdoptOrders" hidden title="기존 기록의 독음·뜻은 두고 AI가 제안한 풀이 순서만 넣습니다"></button></div><p class="rs-ai-summary" id="rsAnalysisSummary"></p><div id="rsAnalysisSuggestions"></div></div></section>
      <section class="rs-dictionary-results" id="rsDictionarySection" role="tabpanel" aria-labelledby="rsDictionaryTab" aria-label="사전 조회"><div class="rs-character-heading"><span id="rsHero" class="hanmun"></span><div><b id="rsDictReading"></b><p id="rsDictMeta"></p></div><small>내장 사전</small></div>
        <div class="rs-tabs" role="tablist" aria-label="사전 정보"><button id="rsSenseTab" type="button" role="tab" aria-selected="true" aria-controls="rsSensePanel">뜻풀이</button><button id="rsInfoTab" type="button" role="tab" aria-selected="false" tabindex="-1" aria-controls="rsInfoPanel">문자 정보</button></div><p id="rsLookupState" class="rs-help" role="status"></p><button type="button" class="btn btn-sm" id="rsRetry" hidden>사전 다시 조회</button><div id="rsSensePanel" role="tabpanel" aria-labelledby="rsSenseTab"></div><div id="rsInfoPanel" role="tabpanel" aria-labelledby="rsInfoTab" hidden></div><p class="rs-dictionary-foot">사전 뜻은 출처와 함께 선택한 위치에 저장됩니다.</p>
      </section></div>
      <div class="rs-form-actions"><span id="rsSaveState" role="status"></span><div><button class="btn btn-ghost btn-sm" type="button" id="rsDelete" hidden>기록 삭제</button><button class="btn btn-ghost btn-sm" type="button" id="rsDiscard">입력 취소</button><button class="btn btn-primary btn-sm" type="submit" form="rsForm" id="rsSave">저장 <kbd>⌘S</kbd></button></div></div>
    </aside></div>`);
  const inspector = host.querySelector<HTMLElement>(".rs-dictionary")!;
  if (deps.inspectorHost) {
    deps.inspectorHost.classList.add("reading-inspector");
    deps.inspectorHost.append(inspector);
    host.classList.add("rs-detached-inspector");
  }
  function el<T extends HTMLElement = HTMLElement>(id: string): T {
    return (host.querySelector<T>(`#${id}`) ?? deps.inspectorHost?.querySelector<T>(`#${id}`))!;
  }
  let view: EditorView | null = null, units: ReadingUnit[] = [], unitIndex = 0, tokens: ReadingToken[] = [];
  let selection: Selection | null = null, anchor: ReadingToken | null = null;
  let notes: ReadingAnnotationView[] = [], loaded = false, visible = false, busy = false, loading = false;
  let note: ReadingAnnotationView | undefined, draft: Draft = blank(), baseline = "", message = "";
  let loadSerial = 0, dictionarySerial = 0, warmSerial = 0, orderByReading = false;
  let dictEntries: DictionaryEntry[] = [], lookupQuery = "";
  let columnCount = 8;
  let inspectorTab: "dictionary" | "ai" = "dictionary", analysisRunKey = "";
  let ordering = false, orderNext = 1;
  let proposalKey = "";
  // Auto-adoption fills empty positions only; positions with a saved record keep their proposals for review.
  const AUTO_ADOPT_KEY = "munhae.readingStudy.autoAdopt";
  let autoAdopt = true;
  try { autoAdopt = host.ownerDocument?.defaultView?.localStorage.getItem(AUTO_ADOPT_KEY) !== "0"; } catch { /* storage unavailable */ }
  let adopting = false, adoptDone = 0, adoptTotal = 0, autoAdoptRunId = "", autoAdoptedRunId = "";
  let filteredUnits: number[] = [], activeUnit = -1;
  const previewSegmenter = new Intl.Segmenter("zh-Hant", { granularity: "grapheme" });
  const dictionaryCache = new Map<string, Promise<DictionaryEntry[]>>();
  const characterEntries = new Map<string, DictionaryEntry[]>();
  let analysisDialog: ReturnType<typeof createReadingAnalysisDialog> | null = null, analysisContextKey = "";
  const analysis = typeof api.research?.startReadingAnalysis === "function" ? configureReadingAnalysisSession({
    api: api.research,
    canStart: () => visible && loaded && !loading && !busy && !!unit() && deps.canEdit(),
    beforeStart: save,
    canApply: () => visible && loaded && !loading && !busy && !dirty() && deps.canEdit(),
    changed: status,
    applied: row => {
      notes = notes.filter(item => item.id !== row.id); notes.push(row);
      if (!dirty() && selection?.from === row.codepointFrom && selection?.to === row.codepointTo) {
        note = row; draft = draftOf(row); baseline = JSON.stringify(draft);
        renderForm();
      }
      deps.edited(); renderTokens(); status();
    },
  }) : null;
  if (analysis) analysisDialog = createReadingAnalysisDialog({
    api, trigger: el<HTMLButtonElement>("rsAnalyze"), start: analysis.start, cancel: analysis.cancel,
    review: () => { deps.openInspector?.(); inspectorTab = "ai"; renderAnalysis(); el("rsInspectorBody").scrollTop = 0; },
  });
  function blank(): Draft { return { reading: "", readingOrder: null, citation: null, translationQuote: null }; }
  function draftOf(row: ReadingAnnotationView): Draft { return { reading: row.reading, readingOrder: row.readingOrder, citation: row.citation, translationQuote: row.translationQuote }; }
  function identity() { return view ? `${view.document.id}:${view.source.versionId}` : ""; }
  function unit() { return units[unitIndex]; }
  function selectedQuote() { return view && selection ? Array.from(view.source.contentText).slice(selection.from, selection.to).join("") : ""; }
  function dirty() { return !!selection && JSON.stringify(draft) !== baseline; }
  function currentNotes() { return notes.filter(row => row.sourceVersionId === view?.source.versionId); }
  function rangeNote(from: number, to: number) { return currentNotes().find(row => row.codepointFrom === from && row.codepointTo === to); }
  function suggestions(): ReadingAnalysisSuggestion[] { const run = analysis?.state().run; return run?.state === "completed" ? run.result?.suggestions ?? [] : []; }
  /** Proposals not yet adopted. They are previews only; nothing is stored until adoption. */
  function proposals() { return suggestions().filter(item => !item.applied); }
  function overlapsSelection(item: { from: number; to: number }) { return !!selection && item.from < selection.to && item.to > selection.from; }
  function unitProgress(item: ReadingUnit | undefined) {
    if (!item) return { done: 0, total: 0 };
    const chars = readingTokens(item.ranges).filter(token => token.annotatable);
    const rows = currentNotes().filter(row => item.ranges.some(range => range.from <= row.codepointFrom && range.to >= row.codepointTo));
    return { done: chars.filter(token => rows.some(row => row.codepointFrom <= token.from && row.codepointTo >= token.to)).length, total: chars.length };
  }
  function analysisApplying() { return !!analysis?.state().applyingId || adopting; }
  function editingDisabled() { return !visible || busy || loading || !loaded || !selection || !deps.canEdit() || analysisApplying() || !!analysis?.state().starting; }
  function syncAnalysis() {
    const current = unit();
    const nextKey = visible && view && current ? JSON.stringify([identity(), current.id, view.source.contentText, view.translation?.versionId, view.translation?.textContent]) : "";
    if (nextKey !== analysisContextKey) { analysisContextKey = nextKey; analysisDialog?.reset(); }
    analysis?.setContext(visible && view && current ? { documentNodeId: view.document.id, expectedSourceVersionId: view.source.versionId,
      expectedTranslationVersionId: view.translation?.versionId ?? null, ranges: current.ranges,
      sourceText: view.source.contentText, sourceLockVersion: view.source.lockVersion,
      translationText: view.translation?.textContent ?? "", translationLockVersion: view.translation?.lockVersion ?? null } : null);
  }
  function renderAnalysis() {
    const state = analysis?.state(), run = state?.run;
    if (state) analysisDialog?.update(state);
    const nextRunKey = run?.id ?? (state?.starting ? "starting" : "");
    if (analysisRunKey !== nextRunKey) {
      // Only analysis requested here brings proposals to the front. Restored results keep the dictionary visible.
      if (nextRunKey === "starting" || analysisRunKey === "starting") inspectorTab = "ai";
      if (analysisRunKey === "starting" && nextRunKey && nextRunKey !== "starting") autoAdoptRunId = nextRunKey;
      analysisRunKey = nextRunKey;
    }
    // Pending proposals preview in the glyph grid, so the grid follows the run's lifecycle too.
    const pendingKey = proposals().map(item => item.id).join(",");
    if (pendingKey !== proposalKey) { proposalKey = pendingKey; renderTokens(); renderTranslation(); }
    const available = !!state && visible && (!!run || state.starting || !!state.error || !!state.notice);
    if (!available && inspectorTab === "ai") inspectorTab = "dictionary";
    const showAi = available && inspectorTab === "ai", pending = proposals();
    el("rsAiTab").hidden = !available;
    el("rsAiTab").setAttribute("aria-selected", String(showAi)); el("rsAiTab").tabIndex = showAi ? 0 : -1;
    el("rsAiTab").innerHTML = state?.starting || run?.state === "running" ? uiText("AI 분석 중…") : run?.state === "completed" ? ui`AI 제안 <span class="cnt">${pending.length}</span>` : uiText("AI 분석");
    el("rsDictionaryTab").setAttribute("aria-selected", String(!showAi)); el("rsDictionaryTab").tabIndex = showAi ? -1 : 0;
    el("rsDictionarySection").hidden = showAi;
    el("rsAnalysisPanel").hidden = !showAi;
    el<HTMLButtonElement>("rsAnalyze").disabled = !analysis || !visible || !loaded || loading || busy || !unit() || !deps.canEdit()
      || !!state?.applyingId;
    el("rsAnalyze").textContent = state?.starting || run?.state === "running" ? t("분석 진행 보기") : t("현재 구절 AI 분석");
    el("rsCancelAnalysis").hidden = !state?.starting && run?.state !== "running";
    el<HTMLButtonElement>("rsCancelAnalysis").disabled = !!state?.canceling || !!state?.applyingId;
    el("rsAnalysisState").textContent = state?.starting ? t("현재 구절을 분석하고 있습니다…") : state?.canceling ? t("분석을 취소하고 있습니다…")
      : run?.state === "running" ? run.detail || t("독음과 뜻풀이를 살펴보고 있습니다…")
      : run?.state === "completed" ? t("제안의 원문을 누르면 해당 위치를 선택합니다. 검토한 제안만 채택하면 풀이에 저장됩니다.")
      : run?.state === "stale" ? t("원문이나 풀이가 변경되었습니다. 다시 분석해 주세요.")
      : run?.state === "canceled" ? t("분석을 취소했습니다.") : state?.notice ?? "";
    el("rsAnalysisError").textContent = state?.error || run?.error?.message || "";
    el("rsAnalysisError").hidden = !el("rsAnalysisError").textContent;
    el("rsAnalysisSummary").textContent = run?.result?.summary ?? "";
    const canAdopt = !!state && run?.state === "completed" && !state.applyingId && !adopting && !state.starting && loaded && !loading && !busy && !dirty() && deps.canEdit();
    el<HTMLInputElement>("rsAutoAdopt").checked = autoAdopt;
    el<HTMLInputElement>("rsAutoAdopt").disabled = adopting;
    el("rsAdoptAll").hidden = run?.state !== "completed" || !pending.length;
    el<HTMLButtonElement>("rsAdoptAll").disabled = !canAdopt;
    el("rsAdoptAll").textContent = adopting ? ui`채택 중 ${adoptDone}/${adoptTotal}` : ui`남은 제안 ${pending.length}개 모두 채택`;
    const orders = orderTargets().length;
    el("rsAdoptOrders").hidden = run?.state !== "completed" || !orders;
    el<HTMLButtonElement>("rsAdoptOrders").disabled = !canAdopt;
    el("rsAdoptOrders").textContent = ui`풀이 순서만 채택 ${orders}`;
    if (adopting) el("rsAnalysisState").textContent = ui`AI 제안을 채택하고 있습니다 · ${adoptDone}/${adoptTotal}`;
    if (autoAdopt && run?.state === "completed" && run.id === autoAdoptRunId && autoAdoptedRunId !== run.id && !adopting) {
      autoAdoptedRunId = run.id;
      if (!dirty()) void adoptAll(true);
      else { message = t("편집 중인 풀이가 있어 자동 채택하지 않았습니다. 저장한 뒤 ‘모두 채택’을 누르세요."); el("rsStatus").textContent = message; el("rsStatus").hidden = false; }
    }
    el("rsAnalysisSuggestions").innerHTML = (run?.result?.suggestions ?? []).map(item => {
      const saved = rangeNote(item.from, item.to);
      return ui`<article class="rs-ai-suggestion${overlapsSelection(item) ? " is-current" : ""}" data-rs-ai-card="${esc(item.id)}"><header><button type="button" class="rs-ai-select hanmun" data-rs-ai-select="${esc(item.id)}" title="이 범위를 선택">${esc(item.quote)}</button><small>${item.from + 1}–${item.to}</small><button class="btn btn-sm" type="button" data-rs-ai-apply="${esc(item.id)}"${!canAdopt || item.applied ? " disabled" : ""}>${esc(item.applied ? t("채택됨") : state?.applyingId === item.id ? t("저장 중…") : t("채택"))}</button></header>${saved && !item.applied ? ui`<p class="rs-ai-current">현재 저장 · ${esc([saved.reading, saved.citation?.sense || saved.gloss].filter(Boolean).join(" · ") || t("독음·뜻 없음"))}</p>` : ""}${item.reading ? ui`<p class="rs-ai-reading">독음 · ${esc(item.reading)}${item.readingOrder === null ? "" : ui` · 풀이 순서 ${item.readingOrder}`}</p>` : ""}${item.translationQuote ? ui`<p class="rs-ai-link">번역 대응 · 「${esc(item.translationQuote)}」</p>` : ""}${item.citation ? ui`<div class="rs-ai-citation"><small>사전 근거 · ${esc(item.citation.sourceLabel)}</small><p>${esc(item.citation.sense)}</p><button type="button" class="rs-source-link" data-rs-url="${esc(item.citation.sourceUrl)}">출처 보기 ↗</button></div>` : ""}${item.explanation ? ui`<div class="rs-ai-explanation"><small>AI 해석</small><p>${esc(item.explanation)}</p></div>` : ""}${item.caution ? ui`<p class="rs-ai-caution">확인할 점 · ${esc(item.caution)}</p>` : ""}</article>`;
    }).join("") || (run?.state === "completed" ? uiText('<p class="rs-help">이 구절에 제안할 풀이가 없습니다.</p>') : "");
    if (dirty() && run?.state === "completed") el("rsAnalysisState").textContent = t("편집 중인 풀이를 저장하거나 취소한 뒤 제안을 채택하세요.");
    const here = pending.filter(overlapsSelection).length;
    el("rsProposalHint").hidden = showAi || !here;
    el("rsProposalHint").textContent = here ? ui`이 위치에 AI 제안 ${here}개 · 보기` : "";
  }
  const singleGrapheme = (quote: string) => Array.from(previewSegmenter.segment(quote)).length === 1;
  /** Saved single-character records whose reading order differs from the run's proposal, adopted or not. */
  function orderTargets() {
    return suggestions().filter(item => item.readingOrder !== null && singleGrapheme(item.quote))
      .filter(item => { const saved = rangeNote(item.from, item.to); return !!saved && saved.readingOrder !== item.readingOrder; });
  }
  async function adoptOrders() {
    if (!analysis || adopting || analysis.state().applyingId || analysis.state().run?.state !== "completed") return;
    const targets = orderTargets();
    if (!targets.length) return;
    if (dirty() && !await save()) return;
    adopting = true; adoptDone = 0; adoptTotal = targets.length; message = ""; status();
    let failed = 0;
    try {
      for (const item of targets) {
        if (!visible || analysis.state().run?.state !== "completed" || !deps.canEdit()) break;
        if (await analysis.apply(item.id, true)) adoptDone += 1; else failed += 1;
        status();
      }
    } finally {
      adopting = false;
      message = failed ? ui`풀이 순서 ${adoptDone}개를 채택했습니다. ${failed}개는 채택하지 못했습니다.` : ui`풀이 순서 ${adoptDone}개를 채택했습니다.`;
      status();
    }
  }
  /** Automatic adoption is conservative: empty positions only, and a word only when the dictionary has its headword. */
  function autoAdoptable(item: ReadingAnalysisSuggestion) { return !rangeNote(item.from, item.to) && (singleGrapheme(item.quote) || !!item.citation); }
  /** Adopts pending proposals in order through the same validated apply path. `emptyOnly` applies the automatic policy. */
  async function adoptAll(emptyOnly: boolean) {
    if (!analysis || adopting || analysis.state().applyingId || analysis.state().run?.state !== "completed") return;
    const targets = proposals().filter(item => !emptyOnly || autoAdoptable(item));
    const held = emptyOnly ? proposals().filter(item => !rangeNote(item.from, item.to) && !autoAdoptable(item)).length : 0;
    if (!targets.length) { if (held) { message = ui`사전 근거 없는 어휘 묶음 ${held}개는 검토용으로 남겼습니다.`; status(); } return; }
    if (dirty() && !await save()) return;
    adopting = true; adoptDone = 0; adoptTotal = targets.length; message = ""; status();
    let failed = 0;
    try {
      for (const item of targets) {
        if (!visible || analysis.state().run?.state !== "completed" || !deps.canEdit()) break;
        if (await analysis.apply(item.id)) adoptDone += 1; else failed += 1;
        status();
      }
    } finally {
      adopting = false;
      message = failed ? ui`AI 제안 ${adoptDone}개를 채택했습니다. ${failed}개는 채택하지 못했습니다.` : ui`AI 제안 ${adoptDone}개를 채택했습니다.`;
      if (held) message += " " + ui`사전 근거 없는 어휘 묶음 ${held}개는 검토용으로 남겼습니다.`;
      status();
    }
  }
  function showProposals() {
    inspectorTab = "ai"; renderAnalysis();
    el("rsAnalysisSuggestions").querySelector<HTMLElement>(".is-current")?.scrollIntoView({ block: "nearest" });
  }
  function updateDictionaryActions() {
    for (const button of el("rsSensePanel").querySelectorAll<HTMLButtonElement>("[data-rs-sense]")) {
      const entry = dictEntries[Number(button.dataset.rsEntry)];
      button.setAttribute("aria-pressed", String(!!draft.citation && draft.citation.entryId === entry?.id && draft.citation.source === entry?.source && draft.citation.sense === entry?.senses[Number(button.dataset.rsSense)]?.text));
      button.disabled = editingDisabled() || lookupQuery !== selectedQuote() || !entry?.canCite
        || !entry.senses[Number(button.dataset.rsSense)]?.text.trim();
    }
  }
  function status() {
    el("rsStatus").textContent = loading ? t("프로젝트 주석을 불러오는 중…") : message || (!deps.canEdit() ? t("원문·번역의 편집 내용을 먼저 저장하면 독음과 사전 뜻을 저장할 수 있습니다.") : "");
    el("rsStatus").hidden = !el("rsStatus").textContent;
    const disabled = editingDisabled();
    for (const id of ["rsReading", "rsOrder", "rsSave", "rsClearCitation", "rsDelete"]) (el(id) as HTMLButtonElement | HTMLInputElement).disabled = disabled;
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-rs-delete-phrase]")) button.disabled = disabled;
    el<HTMLButtonElement>("rsSave").disabled = disabled || (!dirty() && (!!note || !draft.reading.trim()));
    el("rsOrderMode").setAttribute("aria-pressed", String(ordering));
    el<HTMLButtonElement>("rsOrderMode").disabled = !visible || busy || loading || !loaded || !deps.canEdit() || analysisApplying();
    el("rsOrderMode").textContent = ordering ? ui`순서 매기는 중 · 다음 ${orderNext}` : t("순서 매기기");
    el<HTMLButtonElement>("rsDiscard").disabled = busy || analysisApplying() || !dirty();
    el<HTMLButtonElement>("rsReload").disabled = busy || analysisApplying() || loading;
    el<HTMLButtonElement>("rsUnit").disabled = busy || analysisApplying() || !units.length;
    el<HTMLInputElement>("rsUnitSearch").disabled = busy || analysisApplying();
    for (const option of el("rsUnitList").querySelectorAll<HTMLButtonElement>("[data-rs-unit]")) option.disabled = busy || analysisApplying();
    el<HTMLButtonElement>("rsPrevious").disabled = busy || analysisApplying() || unitIndex <= 0;
    el<HTMLButtonElement>("rsNext").disabled = busy || analysisApplying() || unitIndex >= units.length - 1;
    el("rsSaveState").textContent = busy ? t("저장 중…") : dirty() ? t("저장하지 않은 변경사항") : note ? t("프로젝트에 저장됨") : draft.reading.trim() ? t("사전 독음을 확인했으면 저장하세요") : t("독음을 확인하거나 사전 뜻을 선택하세요");
    el("rsDelete").hidden = !note;
    updateDictionaryActions();
    syncLinkSelection();
    renderAnalysis();
    deps.changed();
  }
  function readingFor(text: string) {
    const entries = characterEntries.get(text) ?? [];
    return entries.find(entry => entry.source === "libhangul")?.reading ?? entries.find(entry => entry.reading)?.reading ?? "";
  }
  function basicGlossFor(text: string) {
    return characterEntries.get(text)?.find(entry => entry.source === "libhangul")?.senses.map(sense => sense.text).filter(Boolean).join(" · ") ?? "";
  }
  function basicGlossMarkup(text: string) {
    const values = basicGlossFor(text).split(/,\s*| · /u).filter(Boolean);
    return `${esc(values[0] ?? "")}${values.length > 1 ? `<small class="rs-more-gloss" aria-label="${esc(ui`그 밖의 기본 훈 ${values.length - 1}개`)}">${ui`외 ${values.length - 1}`}</small>` : ""}`;
  }
  function renderTokens() {
    const active = (token: ReadingToken) => !!selection && token.rangeIndex === selection.rangeIndex && token.from >= selection.from && token.to <= selection.to;
    el("rsSource").innerHTML = (unit()?.ranges ?? []).map((_, rangeIndex) => `<span class="rs-source-range">${tokens.filter(token => token.rangeIndex === rangeIndex).map(token => token.annotatable ? ui`<button type="button" data-rs-from="${token.from}" data-rs-to="${token.to}" data-rs-range="${rangeIndex}" aria-pressed="${active(token)}" aria-label="${esc(token.text)} · 원문 ${token.from + 1}번째 위치">${esc(token.text)}</button>` : esc(token.text)).join("")}</span>`).join(uiText('<span class="rs-source-gap" aria-label="떨어진 원문 구절"> … </span>'));
    const shown = tokens.filter(token => token.annotatable), pending = proposals();
    if (orderByReading) shown.sort((a, b) => (rangeNote(a.from, a.to)?.readingOrder ?? Infinity) - (rangeNote(b.from, b.to)?.readingOrder ?? Infinity) || a.from - b.from);
    const phrases = currentNotes().filter(row => unit()?.ranges.some(range => row.codepointFrom >= range.from && row.codepointTo <= range.to) && tokens.filter(token => token.annotatable && token.from >= row.codepointFrom && token.to <= row.codepointTo).length > 1);
    const trailing = new Map<number, string>();
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!token.annotatable) continue;
      let punctuation = "";
      for (let j = i + 1; j < tokens.length && tokens[j]!.rangeIndex === token.rangeIndex && !tokens[j]!.annotatable; j++) punctuation += tokens[j]!.text;
      trailing.set(token.to, punctuation.trim());
    }
    const rows = packReadingRows(shown, { columns: columnCount, groups: phrases.map(row => ({ from: row.codepointFrom, to: row.codepointTo })),
      breakAfter: orderByReading ? [] : shown.filter(token => /[，、；。！？,;!?]/u.test(trailing.get(token.to) ?? "")).map(token => token.to) });
    el("rsTokens").innerHTML = rows.map(row => {
      // Only merge meanings when every phrase member is adjacent in source order.
      const rowPhrases = phrases.flatMap(phrase => {
        const start = row.findIndex(token => token.from === phrase.codepointFrom), end = row.findIndex(token => token.to === phrase.codepointTo);
        if (start < 0 || end <= start || end - start + 1 !== shown.filter(token => token.from >= phrase.codepointFrom && token.to <= phrase.codepointTo).length || row.slice(start, end + 1).some((token, i, list) => i > 0 && token.from < list[i - 1]!.to)) return [];
        return [{ phrase, start, end }];
      });
      const characters = row.map((token, index) => {
        const grouped = rowPhrases.some(({ start, end }) => index >= start && index <= end);
        const saved = rangeNote(token.from, token.to), basic = basicGlossFor(token.text), meaning = saved?.citation?.sense || "";
        // Without a cited sense the record's memo (adopted AI explanation or a legacy manual gloss) fills the meaning row.
        const memo = meaning ? "" : saved?.gloss.trim() ?? "";
        // An exact-range proposal previews its cited sense in the meaning row; wider proposals only mark the glyph.
        const proposed = meaning || memo ? "" : pending.find(item => item.from === token.from && item.to === token.to)?.citation?.sense ?? "";
        const marked = !saved && pending.some(item => item.from <= token.from && item.to >= token.to);
        return ui`<button class="rs-token${grouped ? " rs-token-grouped" : ""}" type="button" style="grid-column:${index + 1}" data-rs-from="${token.from}" data-rs-to="${token.to}" data-rs-range="${token.rangeIndex}" aria-pressed="${active(token)}" tabindex="${active(token) && token.from === selection?.from ? 0 : -1}" aria-label="${esc(token.text)} · ${esc(meaning || memo || (proposed ? ui`AI 제안 ${proposed}` : t("사전 확인")))} · 원문 ${token.from + 1}번째 위치"><small class="rs-token-order">${saved?.readingOrder ?? ""}</small><span class="rs-glyph hanmun">${esc(token.text)}</span><span class="rs-punctuation hanmun" aria-hidden="true">${esc(orderByReading ? "" : trailing.get(token.to))}</span><span class="rs-reading">${esc(saved?.reading || readingFor(token.text))}</span><span class="rs-token-basic" title="${esc(ui`사전 기본 훈: ${basic}`)}" aria-label="${esc(ui`사전 기본 훈: ${basic}`)}">${basicGlossMarkup(token.text)}</span><span class="rs-token-gloss${meaning ? "" : memo ? " rs-note-gloss" : proposed ? " rs-proposed" : " rs-unselected"}" title="${esc(meaning || memo || (proposed ? ui`AI 제안: ${proposed}` : ""))}">${esc(meaning || memo || proposed)}</span>${saved ? uiText('<i aria-label="저장된 기록 있음"></i>') : marked ? uiText('<em class="rs-ai-mark" aria-label="AI 제안 있음">AI</em>') : ""}</button>`;
      }).join("");
      // A shared grid keeps overlapping saved ranges on separate lines inside
      // the same meaning row, without covering another phrase's button.
      const markers = rowPhrases.map(({ phrase, start, end }) => {
        const meaning = phrase.citation?.sense || phrase.gloss.trim();
        return `<button class="rs-group-marker" type="button" data-rs-phrase="${esc(phrase.id)}" style="grid-column:${start + 1} / span ${end - start + 1}" aria-pressed="${selection?.from === phrase.codepointFrom && selection?.to === phrase.codepointTo}"><span class="rs-group-heading">${esc(phrase.quote)}${phrase.reading ? ` · ${esc(phrase.reading)}` : ""}</span>${meaning ? `<span class="rs-group-gloss${phrase.citation?.sense ? "" : " rs-note-gloss"}" title="${esc(meaning)}">${esc(meaning)}</span>` : ""}</button>`;
      }).join("");
      return `<div class="rs-study-line" style="--rs-cols:${columnCount}">${characters}${markers ? `<div class="rs-group-meanings">${markers}</div>` : ""}</div>`;
    }).join("");
    const progress = unitProgress(unit());
    el("rsVersion").textContent = !view ? "" : progress.total ? ui`원문 V${view.source.versionNo} · 풀이 ${progress.done}/${progress.total}` : ui`원문 V${view.source.versionNo}`;
    el("rsSavedPhrases").innerHTML = phrases.map(row => ui`<div class="rs-saved-phrase"><button class="rs-phrase-select" type="button" data-rs-phrase="${esc(row.id)}" aria-pressed="${selection?.from === row.codepointFrom && selection?.to === row.codepointTo}"><span class="hanmun">${esc(row.quote)}</span><span>${esc(row.reading || row.citation?.reading || "")}</span></button><button class="rs-phrase-delete" type="button" data-rs-delete-phrase="${esc(row.id)}" aria-label="${esc(row.quote)} 묶음 삭제" title="묶음 삭제"${editingDisabled() ? " disabled" : ""}><span aria-hidden="true">×</span></button></div>`).join("");
  }
  function measureRows() {
    const width = el("rsTokens").clientWidth;
    if (!width) return;
    const next = Math.max(1, Math.min(12, Math.floor(width / 72)));
    if (next === columnCount) return;
    const focused = host.ownerDocument?.activeElement as HTMLElement | null;
    const from = focused?.classList.contains("rs-token") ? focused.dataset.rsFrom : undefined;
    columnCount = next; renderTokens();
    if (from !== undefined) el("rsTokens").querySelector<HTMLElement>(`[data-rs-from="${from}"]`)?.focus({ preventScroll: true });
  }

  let inferredQuote = "";
  /** Translations often keep the source in parentheses, e.g. 평양(平壤): find the selection or a saved word containing it that way. */
  function inferTranslationHit(text: string): { at: number; quote: string } | null {
    if (!selection) return null;
    const words = currentNotes().filter(row => row.codepointFrom <= selection!.from && row.codepointTo >= selection!.to && row.codepointTo - row.codepointFrom > 1).map(row => row.quote);
    for (const quote of [...words, selectedQuote()]) {
      const at = quote.trim() ? text.indexOf(quote) : -1;
      if (at < 0) continue;
      let start = at, end = at + quote.length;
      // Inside 평양(平壤), take the whole parenthetical plus the Korean word it annotates.
      let open = start - 1, close = end;
      while (open >= 0 && start - open <= 30 && text[open] !== "(" && text[open] !== ")") open -= 1;
      while (close < text.length && close - end <= 30 && text[close] !== ")" && text[close] !== "(") close += 1;
      if (text[open] === "(" && text[close] === ")") {
        start = open; end = close + 1;
        while (start > 0 && /[\p{Script=Hangul}\p{L}\p{N}]/u.test(text[start - 1]!)) start -= 1;
      }
      return { at: start, quote: text.slice(start, end) };
    }
    return null;
  }
  /** The translation shows only the part that renders the current selection: a saved or drafted link, else a proposal, else a literal match. */
  function renderTranslation() {
    const text = unit()?.translation ?? "";
    inferredQuote = "";
    el("rsTranslation").classList.toggle("rs-no-translation", !text);
    if (!text) { el("rsTranslation").textContent = t("연결된 번역이 없는 원문 구절입니다."); return; }
    const linked = draft.translationQuote?.trim() ?? "";
    // Prefer a proposal for exactly this range, then the narrowest proposal covering it.
    const proposal = !linked && selection ? proposals().filter(item => item.translationQuote && item.from <= selection!.from && item.to >= selection!.to)
      .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0] : undefined;
    const proposed = proposal?.translationQuote ?? "";
    let active = linked || proposed, at = active ? text.indexOf(active) : -1, kind = linked ? "" : " rs-proposed";
    if (at < 0) {
      const hit = inferTranslationHit(text);
      if (!hit) { el("rsTranslation").textContent = text; return; }
      active = hit.quote; at = hit.at; kind = " rs-inferred"; inferredQuote = hit.quote;
    }
    const title = kind === "" ? ui`${selectedQuote()} 번역 대응` : kind === " rs-proposed" ? ui`AI 제안 · ${selectedQuote()} 번역 대응` : ui`원문 표기 일치 · ${selectedQuote()}`;
    el("rsTranslation").innerHTML = `${esc(text.slice(0, at))}<mark class="rs-translation-hit${kind}" title="${esc(title)}">${esc(active)}</mark>${esc(text.slice(at + active.length))}`;
  }
  let pendingLink = "";
  function translationSelectionText(): string {
    const view = host.ownerDocument?.defaultView, current = view?.getSelection?.();
    if (!current || current.isCollapsed || !current.rangeCount) return "";
    const range = current.getRangeAt(0), paragraph = el("rsTranslation");
    if (!paragraph.contains?.(range.commonAncestorContainer)) return "";
    const value = current.toString().trim();
    return value && (unit()?.translation ?? "").includes(value) ? value.slice(0, 500) : "";
  }
  function syncLinkSelection() {
    // A dragged selection wins; otherwise a literal match can be saved as the link with one click.
    pendingLink = translationSelectionText() || (draft.translationQuote ? "" : inferredQuote);
    const button = el<HTMLButtonElement>("rsLinkSelection");
    button.hidden = !pendingLink || editingDisabled();
    button.textContent = pendingLink ? ui`「${Array.from(pendingLink).slice(0, 16).join("")}${Array.from(pendingLink).length > 16 ? "…" : ""}」 연결` : "";
  }
  function renderForm() {
    el("rsSelected").textContent = selectedQuote();
    el("rsSelected").classList.toggle("rs-word", Array.from(selectedQuote()).length > 5);
    el("rsPosition").textContent = selection ? ui`${selection.from + 1}–${selection.to}번째 위치` : "";
    el<HTMLInputElement>("rsReading").value = draft.reading;
    el<HTMLInputElement>("rsOrder").value = draft.readingOrder?.toString() ?? "";
    el("rsCitation").hidden = !draft.citation;
    el("rsMemo").hidden = !note?.gloss.trim();
    el("rsMemoBody").textContent = note?.gloss.trim() ?? "";
    el("rsLink").hidden = !selection;
    el("rsLinkBody").textContent = draft.translationQuote ? ui`「${draft.translationQuote}」` : unit()?.translation ? t("번역 본문에서 해당 부분을 드래그한 뒤 연결하세요.") : t("연결된 번역이 없습니다.");
    el("rsClearLink").hidden = !draft.translationQuote;
    renderTranslation();
    syncLinkSelection();
    const citation = draft.citation;
    el("rsCitationBody").innerHTML = citation ? ui`<p><b>${esc(citation.headword)}</b> · ${esc(citation.sense)}</p><details><summary>${esc(citation.sourceLabel)} · 출처 정보</summary><p>${esc(citation.license)}</p><button type="button" class="rs-source-link" data-rs-url="${esc(citation.sourceUrl)}">원문·출처 보기 ↗</button><p>${esc(citation.attribution)}</p></details>` : "";
    status();
  }
  function activateSelection(next: Selection) {
    if (selection?.from !== next.from || selection?.to !== next.to || selection?.rangeIndex !== next.rangeIndex) el("rsInspectorBody").scrollTop = 0;
    selection = next; note = rangeNote(next.from, next.to);
    draft = note ? draftOf(note) : { ...blank(), reading: readingFor(selectedQuote()) };
    baseline = JSON.stringify(draft); renderTokens(); renderForm(); void lookup(selectedQuote());
    if (inspectorTab === "ai" && !el("rsAnalysisPanel").hidden) el("rsAnalysisSuggestions").querySelector<HTMLElement>(".is-current")?.scrollIntoView({ block: "nearest" });
  }
  async function assignOrder() {
    if (!ordering || editingDisabled()) return;
    draft.readingOrder = orderNext; message = ""; deps.edited(); renderForm();
    if (await save(true)) { orderNext += 1; status(); }
  }
  async function choose(next: Selection, extend = false): Promise<boolean> {
    if (busy || loading || analysisApplying()) return false;
    if (dirty() && !await save()) return false;
    const target = tokens.find(token => token.from === next.from && token.to === next.to && token.rangeIndex === next.rangeIndex);
    if (extend && anchor) {
      if (anchor.rangeIndex !== next.rangeIndex) { deps.notify(t("떨어진 구절을 하나의 어휘로 묶을 수 없습니다."), t("구절 연구")); return false; }
      next = { from: Math.min(anchor.from, next.from), to: Math.max(anchor.to, next.to), rangeIndex: next.rangeIndex };
    } else anchor = target ?? null;
    if (next.to - next.from > 100) { deps.notify(t("한 번에 100자 이내의 어휘를 선택하세요."), t("구절 연구")); return false; }
    activateSelection(next);
    deps.openInspector?.();
    return true;
  }
  function renderUnit() {
    const current = unit(); tokens = readingTokens(current?.ranges ?? []); selection = null; anchor = null; note = undefined; draft = blank(); baseline = JSON.stringify(draft); ordering = false;
    el("rsEmpty").hidden = !!current; el("rsSpread").hidden = !current;
    updateUnitCount();
    el("rsUnitTitle").textContent = current?.label ?? t("원문 구절");
    renderTranslation();
    el("rsAlignment").textContent = current?.needsReview ? t("원문과 번역의 대응을 확인하며 읽어 주세요.") : "";
    const first = tokens.find(token => token.annotatable);
    if (first) { anchor = first; activateSelection({ from: first.from, to: first.to, rangeIndex: first.rangeIndex }); }
    else { renderTokens(); renderForm(); ++dictionarySerial; lookupQuery = ""; dictEntries = []; for (const id of ["rsHero", "rsDictReading", "rsDictMeta", "rsLookupState"]) el(id).textContent = ""; el("rsRetry").hidden = true; el("rsSensePanel").replaceChildren(); el("rsInfoPanel").replaceChildren(); }
    void warmReadings(tokens, identity());
    syncAnalysis();
  }
  function renderOld() {
    const old = notes.filter(row => row.sourceVersionId !== view?.source.versionId);
    el("rsOldNotes").hidden = !old.length; el("rsOldSummary").textContent = ui`이전 원문에 남아 있는 풀이 ${old.length}개`;
    el("rsOldList").innerHTML = old.map(row => ui`<div><b class="hanmun">${esc(row.quote)}</b><p>${esc(row.citation?.sense || row.gloss || row.reading)}</p><small>${esc(row.updatedAt.slice(0, 10))} · 이전 원문 / 읽기 전용</small></div>`).join("");
  }
  async function load() {
    if (!view || loading || busy) return;
    const documentId = view.document.id, currentIdentity = identity(), ticket = ++loadSerial;
    loading = true; message = ""; status();
    try {
      const result = await api.editor.listReadingAnnotations(documentId);
      if (ticket !== loadSerial || currentIdentity !== identity()) return;
      if (!result.ok) throw new Error(result.error.message);
      notes = result.data; loaded = true; renderOld();
      if (!dirty() && selection) activateSelection(selection);
      else renderTokens();
    } catch (error) { if (ticket === loadSerial) { loaded = false; message = error instanceof Error ? error.message : t("주석을 불러오지 못했습니다. 새로고침으로 다시 시도하세요."); } }
    finally { if (ticket === loadSerial) { loading = false; status(); } }
  }
  /** `confirm` also stores an unedited dictionary reading for a position without a record. */
  async function save(confirm = false): Promise<boolean> {
    if (!dirty() && !(confirm && selection && !note)) return true;
    if (!view || !selection || busy || loading || !loaded || !deps.canEdit() || analysisApplying()) { message = t("다른 편집 내용을 먼저 저장하세요."); status(); return false; }
    if (!note?.gloss.trim() && !draft.reading.trim() && draft.readingOrder === null && !draft.citation) { message = t("독음·풀이 순서를 입력하거나 사전 뜻을 선택하세요. 기존 기록을 지우려면 ‘기록 삭제’를 누르세요."); status(); return false; }
    if (draft.readingOrder !== null && (!Number.isInteger(draft.readingOrder) || draft.readingOrder < 1 || draft.readingOrder > 10000)) { message = t("풀이 순서는 1~10000 사이 정수로 입력하세요."); status(); return false; }
    const currentIdentity = identity(); busy = true; message = ""; status();
    try {
      // Preserve previously authored glosses when updating other fields. New
      // records store dictionary meanings only in their source citation.
      const result = await api.editor.saveReadingAnnotation({ ...(note ? { id: note.id } : {}), documentNodeId: view.document.id, sourceVersionId: view.source.versionId, codepointFrom: selection.from, codepointTo: selection.to, quote: selectedQuote(), ...structuredClone(draft), gloss: note?.gloss ?? "", expectedLockVersion: note?.lockVersion ?? 0 });
      if (currentIdentity !== identity()) return false;
      if (!result.ok) throw new Error(result.error.message);
      note = result.data; notes = notes.filter(row => row.id !== note!.id); notes.push(note);
      draft = draftOf(note); baseline = JSON.stringify(draft);
      renderTokens(); renderForm(); return true;
    } catch (error) { message = error instanceof Error ? error.message : t("저장하지 못했습니다. 변경사항은 유지됩니다."); return false; }
    finally { busy = false; status(); }
  }
  async function archive() {
    if (!note || busy || !deps.canEdit() || analysisApplying()) return;
    busy = true; message = ""; status(); const currentIdentity = identity(), old = note;
    try {
      const result = await api.editor.archiveReadingAnnotation({ id: old.id, expectedLockVersion: old.lockVersion });
      if (identity() !== currentIdentity) return;
      if (!result.ok) throw new Error(result.error.message);
      notes = notes.filter(row => row.id !== old.id); if (selection) activateSelection(selection);
    } catch (error) { message = error instanceof Error ? error.message : t("기록을 삭제하지 못했습니다."); }
    finally { busy = false; status(); }
  }
  async function cachedLookup(query: string): Promise<DictionaryEntry[]> {
    let pending = dictionaryCache.get(query);
    if (!pending) {
      pending = api.dictionary.search({ query, provider: "local", page: 1 }).then(result => { if (!result.ok) throw new Error(result.error.message); const entries = result.data.entries.filter(entry => entry.headword === query); characterEntries.set(query, entries); return entries; }).catch(error => { dictionaryCache.delete(query); throw error; });
      dictionaryCache.set(query, pending);
    }
    return pending;
  }
  async function warmReadings(values: ReadingToken[], currentIdentity: string) {
    const ticket = ++warmSerial;
    const unique = [...new Set(values.filter(token => token.annotatable).map(token => token.text))];
    let cursor = 0;
    const workers = Array.from({ length: 2 }, async () => {
      while (cursor < unique.length && identity() === currentIdentity && visible && ticket === warmSerial) {
        const query = unique[cursor++]!;
        try { await cachedLookup(query); } catch { return; }
        if (identity() !== currentIdentity || !visible || ticket !== warmSerial) return;
        for (const button of host.querySelectorAll<HTMLElement>(".rs-token")) {
          const token = tokens.find(item => item.from === Number(button.dataset.rsFrom));
          if (token?.text === query) {
            const saved = rangeNote(token.from, token.to);
            if (!saved?.reading) button.querySelector<HTMLElement>(".rs-reading")!.textContent = readingFor(query);
            const gloss = button.querySelector<HTMLElement>(".rs-token-basic")!;
            gloss.innerHTML = basicGlossMarkup(query); gloss.title = ui`사전 기본 훈: ${basicGlossFor(query)}`; gloss.setAttribute("aria-label", gloss.title);
          }
        }
      }
    }); await Promise.all(workers);
  }
  function dictionaryTabs(info: boolean) { for (const [id, on] of [["rsInfoTab", info], ["rsSenseTab", !info]] as const) { el(id).setAttribute("aria-selected", String(on)); el(id).tabIndex = on ? 0 : -1; } el("rsInfoPanel").hidden = !info; el("rsSensePanel").hidden = info; }
  function renderDictionary() {
    const propertyEntry = dictEntries.find(entry => entry.characterInfo), info = propertyEntry?.characterInfo;
    el("rsDictReading").textContent = readingFor(lookupQuery) || t("독음 미수록");
    el("rsDictMeta").textContent = info ? ui`${info.radicals.map(radical => radical.glyph).join(" · ")} 부수 · ${info.totalStrokes.join(" / ")}획` : "";
    el("rsSensePanel").innerHTML = dictEntries.filter(entry => !entry.characterInfo).map(entry => ui`<section class="rs-dict-source"><h4>${esc(entry.sourceLabel)}<button type="button" data-rs-url="${esc(entry.sourceUrl)}" aria-label="${esc(entry.sourceLabel)} 원문 보기">↗</button></h4>${entry.senses.map((sense, index) => `<button class="rs-sense" type="button" data-rs-entry="${dictEntries.indexOf(entry)}" data-rs-sense="${index}"${!sense.text.trim() || !entry.canCite || lookupQuery !== selectedQuote() || busy ? " disabled" : ""}><small>${esc(sense.label ?? ui`뜻 ${index + 1}`)}</small><span>${esc(sense.text || t("뜻 미수록"))}</span>${sense.text.trim() && entry.canCite && lookupQuery === selectedQuote() ? uiText("<em>이 뜻 선택</em>") : ""}</button>`).join("")}<p class="rs-dict-credit" title="${esc(entry.attribution)}">${esc(entry.license)} · 출처·가공 정보</p></section>`).join("") || uiText('<p class="rs-help">내장 사전에 정확히 일치하는 뜻풀이가 없습니다.</p>');
    const kinds = { semantic: t("의미상 이체자"), specializedSemantic: t("특정 용법의 의미 이체자"), z: t("자형 이체자"), traditional: t("번체 대응"), simplified: t("간체 대응") };
    el("rsInfoPanel").innerHTML = info ? ui`<dl><dt>문자 코드</dt><dd>${esc(info.codePoint)}</dd><dt>독음</dt><dd>${esc(propertyEntry?.reading ?? t("미수록"))}</dd><dt>총획</dt><dd>${info.totalStrokes.join(" / ")}획</dd><dt>부수</dt><dd>${info.radicals.map(radical => ui`${esc(radical.glyph)} · ${radical.number}번 / 나머지 ${radical.residualStrokes}획`).join("<br>")}</dd></dl>${info.variants.map(group => `<section class="rs-variants"><h4>${kinds[group.kind]}</h4>${group.characters.map(char => `<button type="button" class="btn hanmun" data-rs-variant="${esc(char)}">${esc(char)}</button>`).join("")}</section>`).join("")}<p class="rs-help">Unicode Unihan ${esc(info.unicodeVersion)} · ${esc(propertyEntry?.license)}<br>관련 자형을 눌러도 원문은 바뀌지 않습니다.</p>` : uiText('<p class="rs-help">문자 속성이 없거나 여러 글자를 선택했습니다.</p>');
    updateDictionaryActions();
  }
  async function lookup(query: string) {
    if (!query || !visible) return;
    const ticket = ++dictionarySerial; lookupQuery = query; dictEntries = [];
    el("rsHero").textContent = query; el("rsHero").classList.toggle("rs-word", Array.from(query).length > 2);
    el("rsDictReading").textContent = t("조회 중…"); el("rsDictMeta").textContent = ""; el("rsSensePanel").replaceChildren(); el("rsInfoPanel").replaceChildren();
    el("rsLookupState").textContent = t("내장 사전을 조회하고 있습니다."); el("rsRetry").hidden = true;
    try {
      const entries = await cachedLookup(query); if (ticket !== dictionarySerial || !visible) return;
      dictEntries = entries; renderDictionary(); el("rsLookupState").textContent = lookupQuery === selectedQuote() ? "" : t("관련 자형을 따로 조회하고 있습니다. 원문 선택은 유지됩니다.");
      if (!note && !dirty() && lookupQuery === selectedQuote() && !draft.reading) { draft.reading = readingFor(query); baseline = JSON.stringify(draft); el<HTMLInputElement>("rsReading").value = draft.reading; status(); }
    } catch (error) { if (ticket === dictionarySerial) { el("rsDictReading").textContent = t("조회 실패"); el("rsLookupState").textContent = error instanceof Error ? error.message : t("사전을 불러오지 못했습니다."); el("rsRetry").hidden = false; } }
  }
  function updateUnitCount() {
    const count = `${units.length ? unitIndex + 1 : 0} / ${units.length}`;
    el("rsUnitCount").textContent = count;
    el("rsUnit").setAttribute("aria-label", `${t("연구할 구절")} · ${count}`);
  }
  function closePopover(id: string, focusId?: string) {
    if (!el(id).matches(":popover-open")) return;
    el(id).hidePopover();
    if (focusId) el(focusId).focus({ preventScroll: true });
  }
  function highlightUnit(scroll = false) {
    for (const option of el("rsUnitList").querySelectorAll<HTMLElement>("[data-rs-unit]")) {
      const active = Number(option.dataset.rsUnit) === activeUnit;
      option.classList.toggle("is-active", active);
      if (active && scroll) option.scrollIntoView({ block: "nearest" });
    }
    if (activeUnit >= 0) el("rsUnitSearch").setAttribute("aria-activedescendant", `rsUnitOption${activeUnit}`);
    else el("rsUnitSearch").removeAttribute("aria-activedescendant");
  }
  function renderUnitList() {
    const query = el<HTMLInputElement>("rsUnitSearch").value.trim().toLocaleLowerCase();
    const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
    filteredUnits = [];
    el("rsUnitList").innerHTML = units.flatMap((item, index) => {
      const quote = normalize(item.ranges.map(range => range.quote).join(" … "));
      if (query && !(/^\d+$/u.test(query) ? String(index + 1) === query : quote.toLocaleLowerCase().includes(normalize(query)))) return [];
      filteredUnits.push(index);
      const glyphs = Array.from(previewSegmenter.segment(quote), part => part.segment);
      const preview = glyphs.slice(0, 15).join("").trimEnd() + (glyphs.length > 15 ? "…" : "");
      const progress = unitProgress(item);
      return [`<button type="button" class="rs-unit-option" id="rsUnitOption${index}" role="option" aria-selected="${index === unitIndex}" tabindex="-1" data-rs-unit="${index}"${busy || analysisApplying() ? " disabled" : ""}><span class="rs-unit-number">${index + 1}</span><span class="rs-unit-preview hanmun">${esc(preview)}</span><span class="rs-unit-progress${progress.done && progress.done === progress.total ? " is-done" : ""}" aria-label="${esc(ui`풀이 ${progress.done}/${progress.total}`)}">${progress.done ? `${progress.done}/${progress.total}` : ""}</span><span class="rs-unit-check" aria-hidden="true">${index === unitIndex ? "✓" : ""}</span></button>`];
    }).join("");
    activeUnit = filteredUnits.includes(unitIndex) ? unitIndex : filteredUnits[0] ?? -1;
    el("rsUnitNoResults").hidden = filteredUnits.length > 0;
    highlightUnit();
  }
  async function changeUnit(index: number): Promise<boolean> {
    if (!units[index] || busy || analysisApplying()) return false;
    if (index === unitIndex) return true;
    const currentIdentity = identity(), targetId = units[index]!.id;
    if (dirty() && !await save()) return false;
    if (!visible || identity() !== currentIdentity || units[index]?.id !== targetId) return false;
    unitIndex = index; renderUnit(); return true;
  }
  async function selectUnit(index: number) {
    if (await changeUnit(index)) closePopover("rsUnitPicker", "rsUnit");
  }
  el("rsUnitPicker").addEventListener("beforetoggle", event => {
    if ((event as ToggleEvent).newState === "open") { el<HTMLInputElement>("rsUnitSearch").value = ""; renderUnitList(); }
  });
  el("rsUnitPicker").addEventListener("toggle", () => {
    const open = el("rsUnitPicker").matches(":popover-open");
    el("rsUnit").setAttribute("aria-expanded", String(open));
    el("rsUnitSearch").setAttribute("aria-expanded", String(open));
    if (open) { el("rsUnitSearch").focus({ preventScroll: true }); highlightUnit(true); }
  });
  el("rsUnit").addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || el<HTMLButtonElement>("rsUnit").disabled) return;
    event.preventDefault(); el("rsUnitPicker").showPopover();
  });
  el("rsUnitSearch").addEventListener("input", renderUnitList);
  el("rsUnitSearch").addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); if (activeUnit >= 0) void selectUnit(activeUnit); }
    else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const at = filteredUnits.indexOf(activeUnit), next = Math.max(0, Math.min(filteredUnits.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
      activeUnit = filteredUnits[next] ?? -1; highlightUnit(true);
    }
  });
  el("rsUnitList").addEventListener("pointerdown", event => { if ((event.target as HTMLElement).closest("[data-rs-unit]")) event.preventDefault(); });
  el("rsUnitList").addEventListener("click", event => {
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-rs-unit]");
    if (option && !option.disabled) void selectUnit(Number(option.dataset.rsUnit));
  });
  for (const [id, trigger] of [["rsUnitPicker", "rsUnit"], ["rsMoreActions", "rsMore"]]) {
    el(id!).addEventListener("focusout", event => {
      if (event.relatedTarget && !el(id!).contains(event.relatedTarget as Node) && event.relatedTarget !== el(trigger!)) closePopover(id!);
    });
  }
  const interactionRoots = deps.inspectorHost ? [host, deps.inspectorHost] : [host];
  for (const root of interactionRoots) root.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const removePhrase = target.closest<HTMLButtonElement>("[data-rs-delete-phrase]");
    if (removePhrase) {
      if (removePhrase.disabled || editingDisabled()) return;
      const row = currentNotes().find(item => item.id === removePhrase.dataset.rsDeletePhrase);
      const rangeIndex = unit()?.ranges.findIndex(range => row && range.from <= row.codepointFrom && range.to >= row.codepointTo) ?? -1;
      if (row && rangeIndex >= 0) void choose({ from: row.codepointFrom, to: row.codepointTo, rangeIndex }).then(async chosen => {
        if (!chosen || note?.id !== row.id || editingDisabled()) return;
        await archive();
        el("rsReading").focus({ preventScroll: true });
      });
      return;
    }
    const proposal = target.closest<HTMLButtonElement>("[data-rs-ai-apply]");
    if (proposal) { if (!proposal.disabled && proposal.dataset.rsAiApply) void analysis?.apply(proposal.dataset.rsAiApply); return; }
    const pick = target.closest<HTMLElement>("[data-rs-ai-select]"); if (pick) {
      const item = suggestions().find(entry => entry.id === pick.dataset.rsAiSelect);
      const rangeIndex = unit()?.ranges.findIndex(range => item && range.from <= item.from && range.to >= item.to) ?? -1;
      if (item && rangeIndex >= 0) void choose({ from: item.from, to: item.to, rangeIndex });
      return;
    }
    const token = target.closest<HTMLElement>("[data-rs-from]"); if (token) {
      const from = Number(token.dataset.rsFrom), focusToken = token.matches(".rs-token"), extend = (event as MouseEvent).shiftKey;
      void choose({ from, to: Number(token.dataset.rsTo), rangeIndex: Number(token.dataset.rsRange) }, extend).then(async chosen => {
        if (!chosen) return;
        if (focusToken) el("rsTokens").querySelector<HTMLElement>(`[data-rs-from="${from}"]`)?.focus({ preventScroll: true });
        if (ordering && !extend && focusToken) await assignOrder();
      });
      return;
    }
    const phrase = target.closest<HTMLElement>("[data-rs-phrase]"); if (phrase) {
      const row = currentNotes().find(item => item.id === phrase.dataset.rsPhrase);
      const rangeIndex = unit()?.ranges.findIndex(range => row && range.from <= row.codepointFrom && range.to >= row.codepointTo) ?? -1;
      const focusHost = phrase.matches(".rs-group-marker") ? el("rsTokens") : el("rsSavedPhrases");
      if (row && rangeIndex >= 0) void choose({ from: row.codepointFrom, to: row.codepointTo, rangeIndex }).then(chosen => {
        if (chosen) Array.from(focusHost.querySelectorAll<HTMLElement>("[data-rs-phrase]")).find(button => button.dataset.rsPhrase === row.id)?.focus({ preventScroll: true });
      });
      return;
    }
    const link = target.closest<HTMLElement>("[data-rs-url]"); if (link?.dataset.rsUrl) { void api.app.openExternal(link.dataset.rsUrl).catch(error => deps.notify(error instanceof Error ? error.message : t("출처를 열지 못했습니다."), t("사전 출처"))); return; }
    const variant = target.closest<HTMLElement>("[data-rs-variant]"); if (variant?.dataset.rsVariant) { void lookup(variant.dataset.rsVariant); return; }
    const sense = target.closest<HTMLButtonElement>("[data-rs-sense]"); if (sense && !sense.disabled && !editingDisabled() && lookupQuery === selectedQuote()) {
      const entry = dictEntries[Number(sense.dataset.rsEntry)], meaning = entry?.senses[Number(sense.dataset.rsSense)]; if (!entry?.canCite || !meaning?.text.trim()) return;
      draft.citation = { source: entry.source, sourceLabel: entry.sourceLabel, entryId: entry.id, headword: entry.headword, reading: entry.reading, sense: meaning.text, ...(meaning.label ? { senseLabel: meaning.label } : {}), sourceUrl: entry.sourceUrl, license: entry.license, licenseUrl: entry.licenseUrl, attribution: entry.attribution };
      if (!draft.reading) draft.reading = entry.reading ?? "";
      deps.edited();
      renderForm(); el("rsSave").focus({ preventScroll: true });
    }
  });
  el("rsTokens").addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || busy) return;
    const current = (event.target as HTMLElement).closest<HTMLElement>("[data-rs-from]");
    if (!current) return;
    event.preventDefault(); const visibleTokens = Array.from(el("rsTokens").querySelectorAll<HTMLElement>("[data-rs-from]"));
    const at = Math.max(0, visibleTokens.indexOf(current));
    const index = event.key === "Home" ? 0 : event.key === "End" ? visibleTokens.length - 1 : Math.max(0, Math.min(visibleTokens.length - 1, at + (event.key === "ArrowLeft" ? -1 : 1)));
    const next = visibleTokens[index]; if (!next) return; const from = Number(next.dataset.rsFrom);
    void choose({ from, to: Number(next.dataset.rsTo), rangeIndex: Number(next.dataset.rsRange) }, event.shiftKey).then(chosen => { if (chosen) el("rsTokens").querySelector<HTMLElement>(`[data-rs-from="${from}"]`)?.focus({ preventScroll: true }); });
  });
  el("rsForm").addEventListener("submit", event => { event.preventDefault(); void save(true); });
  el("rsDictionaryTab").addEventListener("click", () => { inspectorTab = "dictionary"; renderAnalysis(); });
  el("rsAiTab").addEventListener("click", showProposals);
  el("rsAdoptAll").addEventListener("click", () => { if (!el<HTMLButtonElement>("rsAdoptAll").disabled) void adoptAll(false); });
  el("rsAdoptOrders").addEventListener("click", () => { if (!el<HTMLButtonElement>("rsAdoptOrders").disabled) void adoptOrders(); });
  el("rsAutoAdopt").addEventListener("change", () => {
    autoAdopt = el<HTMLInputElement>("rsAutoAdopt").checked;
    try { host.ownerDocument?.defaultView?.localStorage.setItem(AUTO_ADOPT_KEY, autoAdopt ? "1" : "0"); } catch { /* storage unavailable */ }
    renderAnalysis();
  });
  el("rsProposalHint").addEventListener("click", showProposals);
  (deps.inspectorHost ?? host).querySelector(".rs-inspector-tabs")!.addEventListener("keydown", event => {
    const keyEvent = event as KeyboardEvent; if (!["ArrowLeft", "ArrowRight"].includes(keyEvent.key) || el("rsAiTab").hidden) return;
    keyEvent.preventDefault(); inspectorTab = inspectorTab === "ai" ? "dictionary" : "ai"; renderAnalysis(); el(inspectorTab === "ai" ? "rsAiTab" : "rsDictionaryTab").focus();
  });
  el("rsOrderMode").addEventListener("click", () => {
    if (el<HTMLButtonElement>("rsOrderMode").disabled) return;
    ordering = !ordering; orderNext = 1; message = ordering ? t("글자를 읽는 순서대로 누르세요. 1번부터 매기며 누를 때마다 저장합니다.") : "";
    if (ordering && orderByReading) { orderByReading = false; el("rsSourceOrder").setAttribute("aria-pressed", "true"); el("rsReadingOrder").setAttribute("aria-pressed", "false"); renderTokens(); }
    status();
  });
  el("rsAnalyze").addEventListener("click", () => {
    if (el<HTMLButtonElement>("rsAnalyze").disabled || !view || !unit()) return;
    analysisDialog?.open(view.document.originalTitle || view.document.title, unit()!.ranges.map(range => range.quote).join(" … "));
  });
  el("rsCancelAnalysis").addEventListener("click", () => { void analysis?.cancel(); });
  host.ownerDocument?.defaultView?.addEventListener("pagehide", () => { analysis?.dispose(); analysisDialog?.dispose(); }, { once: true });
  for (const id of ["rsReading", "rsOrder"]) el(id).addEventListener("input", () => {
    if (editingDisabled()) return;
    draft.reading = el<HTMLInputElement>("rsReading").value;
    const order = el<HTMLInputElement>("rsOrder").value; draft.readingOrder = order === "" ? null : Number(order); message = ""; deps.edited(); status();
  });
  host.ownerDocument?.addEventListener("selectionchange", syncLinkSelection);
  el("rsLinkSelection").addEventListener("pointerdown", event => event.preventDefault());
  el("rsLinkSelection").addEventListener("click", () => {
    if (editingDisabled() || !pendingLink || !(unit()?.translation ?? "").includes(pendingLink)) return;
    draft.translationQuote = pendingLink; message = ""; deps.edited(); renderForm();
    host.ownerDocument?.defaultView?.getSelection?.()?.removeAllRanges(); syncLinkSelection();
  });
  el("rsClearLink").addEventListener("click", () => { if (editingDisabled() || !draft.translationQuote) return; draft.translationQuote = null; deps.edited(); renderForm(); });
  el("rsClearCitation").addEventListener("click", event => { event.preventDefault(); if (editingDisabled() || !draft.citation) return; draft.citation = null; deps.edited(); renderForm(); });
  el("rsDiscard").addEventListener("click", () => { if (!busy && !analysisApplying() && selection) { message = ""; activateSelection(selection); } });
  el("rsDelete").addEventListener("click", () => { void archive(); });
  el("rsReload").addEventListener("click", () => { closePopover("rsMoreActions", "rsMore"); if (dirty()) { message = t("변경사항을 저장하거나 ‘입력 취소’를 누른 뒤 새로고침하세요."); status(); return; } void load(); });
  el("rsPrevious").addEventListener("click", () => { void changeUnit(unitIndex - 1); }); el("rsNext").addEventListener("click", () => { void changeUnit(unitIndex + 1); });
  for (const id of ["rsSourceOrder", "rsReadingOrder"]) el(id).addEventListener("click", () => { orderByReading = id === "rsReadingOrder"; el("rsSourceOrder").setAttribute("aria-pressed", String(!orderByReading)); el("rsReadingOrder").setAttribute("aria-pressed", String(orderByReading)); renderTokens(); });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => { if (visible) measureRows(); }).observe(el("rsTokens"));
  el("rsSenseTab").addEventListener("click", () => dictionaryTabs(false)); el("rsInfoTab").addEventListener("click", () => dictionaryTabs(true));
  el("rsRetry").addEventListener("click", () => { void lookup(lookupQuery || selectedQuote()); });
  (deps.inspectorHost ?? host).querySelector(".rs-tabs")!.addEventListener("keydown", event => { const keyEvent = event as KeyboardEvent; if (!["ArrowLeft", "ArrowRight"].includes(keyEvent.key)) return; keyEvent.preventDefault(); const info = el("rsSenseTab").getAttribute("aria-selected") === "true"; dictionaryTabs(info); el(info ? "rsInfoTab" : "rsSenseTab").focus(); });

  return {
    hasUnsavedDraft: dirty, isBusy: () => busy || analysisApplying(), save,
    discard() { if (!busy && !analysisApplying() && selection) { message = ""; activateSelection(selection); } },
    setDocument(next: EditorView) {
      const changed = identity() !== `${next.document.id}:${next.source.versionId}`;
      const previousUnit = unit()?.id; view = next; units = buildReadingUnits(next);
      if (changed) { ++loadSerial; ++dictionarySerial; notes = []; loaded = false; loading = false; selection = null; draft = blank(); baseline = JSON.stringify(draft); message = ""; unitIndex = 0; }
      else unitIndex = Math.max(0, units.findIndex(item => item.id === previousUnit));
      closePopover("rsUnitPicker"); updateUnitCount();
      if (changed || !dirty()) renderUnit(); else status();
      syncAnalysis();
      renderOld(); if (visible && !loaded) void load();
    },
    setVisible(next: boolean, preferredSentenceId?: string | null) {
      visible = next; if (!next) { ordering = false; closePopover("rsUnitPicker"); closePopover("rsMoreActions"); ++dictionarySerial; ++warmSerial; syncAnalysis(); return; }
      if (preferredSentenceId && !dirty()) { const found = units.findIndex(item => item.id === `translation:${preferredSentenceId}`); if (found >= 0) unitIndex = found; }
      measureRows();
      if (!dirty()) renderUnit(); else status();
      syncAnalysis();
      if (!loaded) void load(); else if (selection) void lookup(selectedQuote());
    },
  };
}
