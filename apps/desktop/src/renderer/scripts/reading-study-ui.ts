import { uiText, t, ui } from "./i18n";
import type { EditorView, MunhaeApi, ReadingAnnotationView, ReadingCitation } from "../../shared/munhae-api";
import type { DictionaryEntry } from "../../shared/dictionary-types";
import { buildReadingUnits, readingTokens, type ReadingUnit, type ReadingToken } from "./reading-model";
import { packReadingRows } from "./reading-layout";
import { configureReadingAnalysisSession } from "./reading-analysis-session";
import "../styles/reading-study.css";

type Selection = { from: number; to: number; rangeIndex: number };
type Draft = { reading: string; readingOrder: number | null; citation: ReadingCitation | null };
type Deps = { api: MunhaeApi; host: HTMLElement; escape(value: unknown): string; notify(message: string, title?: string): void; canEdit(): boolean; changed(): void; edited(): void };

export function configureReadingStudy(deps: Deps) {
  const { api, host, escape: esc } = deps;
  host.classList.add("reading-study");
  host.innerHTML = uiText(`<header class="rs-toolbar">
    <div class="rs-title"><span>句讀</span><h2>구절 연구</h2></div>
    <div class="rs-navigation"><button type="button" class="btn btn-ghost btn-sm" id="rsPrevious" aria-label="이전 연구 구절">↑</button><label class="sr-only" for="rsUnit">연구할 구절</label><select class="select" id="rsUnit"></select><button type="button" class="btn btn-ghost btn-sm" id="rsNext" aria-label="다음 연구 구절">↓</button></div>
    <div class="rs-switch" role="group" aria-label="풀이 보기"><button type="button" id="rsAligned" aria-pressed="true">행 맞춤</button><button type="button" id="rsCards" aria-pressed="false">카드</button></div>
    <button class="btn btn-sm rs-ai-trigger" type="button" id="rsAnalyze" title="현재 구절의 독음과 뜻풀이 분석">AI 분석</button>
    <button class="btn btn-ghost btn-sm" type="button" id="rsReload" title="저장된 주석 새로 불러오기" aria-label="저장된 주석 새로 불러오기">↻</button>
    </header><p id="rsStatus" class="rs-status" role="status"></p><p id="rsEmpty" class="rs-empty" hidden>저장된 원문이 없습니다. 원문을 입력하고 저장한 뒤 구절을 살펴보세요.</p>
    <div class="rs-spread" id="rsSpread"><article class="rs-document">
      <section aria-label="연구 원문"><div class="rs-section-label"><span>原文</span><h3 id="rsUnitTitle">원문 구절</h3><small id="rsVersion"></small></div><div id="rsSource" class="rs-source hanmun"></div></section>
      <section class="rs-analysis" aria-label="글자별 풀이"><div class="rs-analysis-heading"><h3>글자별 풀이</h3><div class="rs-switch" role="group" aria-label="풀이 표시 순서"><button type="button" id="rsSourceOrder" aria-pressed="true">원문 순서</button><button type="button" id="rsReadingOrder" aria-pressed="false">풀이 순서</button></div></div>
        <div id="rsTokens" class="rs-tokens"></div><p class="rs-help">기본 훈은 사전 첫 항목 · Shift+클릭으로 어휘 선택 · ← → 글자 이동</p><div id="rsSavedPhrases" class="rs-saved-phrases" aria-label="저장된 어휘 풀이"></div>
      </section>
      <section class="rs-translation" aria-label="연결된 번역"><div class="rs-section-label"><span>譯文</span><h3>연결된 번역</h3></div><p id="rsTranslation"></p><p id="rsAlignment" class="rs-help"></p></section>
      <details id="rsOldNotes" class="rs-old-notes" hidden><summary id="rsOldSummary"></summary><p>이전 원문의 주석은 해당 버전에 보존되어 있습니다. 현재 원문으로 자동 이동하지 않습니다.</p><div id="rsOldList"></div></details>
    </article>
    <aside class="rs-dictionary" aria-label="선택 글자와 어휘 연구"><div class="rs-inspector-body" id="rsInspectorBody">
      <form id="rsForm" class="rs-annotation"><div class="rs-inspector-label"><h3>선택한 글자·어휘</h3><small id="rsPosition"></small></div><b id="rsSelected" class="rs-selected hanmun"></b>
        <div class="rs-fields"><label>독음<input class="input" id="rsReading" maxlength="100" autocomplete="off" placeholder="독음 입력"></label><label>풀이 순서<input class="input" id="rsOrder" type="number" min="1" max="10000" placeholder="선택"></label></div>
        <section class="rs-citation" id="rsCitation" hidden aria-label="선택한 사전 뜻"><div class="rs-citation-heading"><span>선택한 뜻</span><button type="button" id="rsClearCitation">선택 해제</button></div><div id="rsCitationBody"></div></section>
      </form>
      <section class="rs-ai-panel" id="rsAnalysisPanel" aria-label="현재 구절 AI 분석" hidden><div class="rs-ai-heading"><h3>AI 분석</h3><button class="rs-ai-toggle" type="button" id="rsToggleAnalysis" aria-controls="rsAnalysisContent" aria-expanded="true" hidden>접기</button><button class="btn btn-ghost btn-sm" type="button" id="rsCancelAnalysis" hidden>취소</button></div><p class="rs-ai-error" id="rsAnalysisError" role="alert" hidden></p><div id="rsAnalysisContent"><p class="rs-ai-state" id="rsAnalysisState" role="status"></p><p class="rs-ai-summary" id="rsAnalysisSummary"></p><div id="rsAnalysisSuggestions"></div></div></section>
      <section class="rs-dictionary-results" aria-label="사전 조회"><div class="rs-character-heading"><span id="rsHero" class="hanmun"></span><div><b id="rsDictReading"></b><p id="rsDictMeta"></p></div><small>내장 사전</small></div>
        <div class="rs-tabs" role="tablist" aria-label="사전 정보"><button id="rsSenseTab" type="button" role="tab" aria-selected="true" aria-controls="rsSensePanel">뜻풀이</button><button id="rsInfoTab" type="button" role="tab" aria-selected="false" tabindex="-1" aria-controls="rsInfoPanel">문자 정보</button></div><p id="rsLookupState" class="rs-help" role="status"></p><button type="button" class="btn btn-sm" id="rsRetry" hidden>사전 다시 조회</button><div id="rsSensePanel" role="tabpanel" aria-labelledby="rsSenseTab"></div><div id="rsInfoPanel" role="tabpanel" aria-labelledby="rsInfoTab" hidden></div><p class="rs-dictionary-foot">사전 뜻은 출처와 함께 선택한 위치에 저장됩니다.</p>
      </section></div>
      <div class="rs-form-actions"><span id="rsSaveState" role="status"></span><div><button class="btn btn-ghost btn-sm" type="button" id="rsDelete" hidden>기록 삭제</button><button class="btn btn-ghost btn-sm" type="button" id="rsDiscard">입력 취소</button><button class="btn btn-primary btn-sm" type="submit" form="rsForm" id="rsSave">저장 <kbd>⌘S</kbd></button></div></div>
    </aside></div>`);
  function el<T extends HTMLElement = HTMLElement>(id: string): T { return host.querySelector<T>(`#${id}`)!; }
  let view: EditorView | null = null, units: ReadingUnit[] = [], unitIndex = 0, tokens: ReadingToken[] = [];
  let selection: Selection | null = null, anchor: ReadingToken | null = null;
  let notes: ReadingAnnotationView[] = [], loaded = false, visible = false, busy = false, loading = false;
  let note: ReadingAnnotationView | undefined, draft: Draft = blank(), baseline = "", message = "";
  let loadSerial = 0, dictionarySerial = 0, warmSerial = 0, orderByReading = false;
  let dictEntries: DictionaryEntry[] = [], lookupQuery = "";
  let cards = false, columnCount = 8;
  let analysisCollapsed = false, analysisRunKey = "";
  const dictionaryCache = new Map<string, Promise<DictionaryEntry[]>>();
  const characterEntries = new Map<string, DictionaryEntry[]>();
  const analysis = typeof api.research?.startReadingAnalysis === "function" ? configureReadingAnalysisSession({
    api: api.research,
    canStart: () => visible && loaded && !loading && !busy && !!unit() && deps.canEdit(),
    beforeStart: save,
    canApply: () => visible && loaded && !loading && !busy && !dirty() && deps.canEdit(),
    changed: status,
    applied: row => {
      notes = notes.filter(item => item.id !== row.id); notes.push(row);
      if (!dirty() && selection?.from === row.codepointFrom && selection?.to === row.codepointTo) {
        note = row; draft = { reading: row.reading, readingOrder: row.readingOrder, citation: row.citation }; baseline = JSON.stringify(draft);
        renderForm();
      }
      deps.edited(); renderTokens(); status();
    },
  }) : null;
  function blank(): Draft { return { reading: "", readingOrder: null, citation: null }; }
  function identity() { return view ? `${view.document.id}:${view.source.versionId}` : ""; }
  function unit() { return units[unitIndex]; }
  function selectedQuote() { return view && selection ? Array.from(view.source.contentText).slice(selection.from, selection.to).join("") : ""; }
  function dirty() { return !!selection && JSON.stringify(draft) !== baseline; }
  function currentNotes() { return notes.filter(row => row.sourceVersionId === view?.source.versionId); }
  function rangeNote(from: number, to: number) { return currentNotes().find(row => row.codepointFrom === from && row.codepointTo === to); }
  function analysisApplying() { return !!analysis?.state().applyingId; }
  function editingDisabled() { return !visible || busy || loading || !loaded || !selection || !deps.canEdit() || analysisApplying() || !!analysis?.state().starting; }
  function syncAnalysis() {
    const current = unit();
    analysis?.setContext(visible && view && current ? { documentNodeId: view.document.id, expectedSourceVersionId: view.source.versionId,
      expectedTranslationVersionId: view.translation?.versionId ?? null, ranges: current.ranges,
      sourceText: view.source.contentText, sourceLockVersion: view.source.lockVersion,
      translationText: view.translation?.textContent ?? "", translationLockVersion: view.translation?.lockVersion ?? null } : null);
  }
  function renderAnalysis() {
    const state = analysis?.state(), run = state?.run;
    const nextRunKey = run?.id ?? (state?.starting ? "starting" : "");
    if (analysisRunKey !== nextRunKey) { analysisRunKey = nextRunKey; analysisCollapsed = false; }
    const collapsible = run?.state === "completed" && !!run.result;
    el("rsToggleAnalysis").hidden = !collapsible;
    el("rsToggleAnalysis").textContent = ui`${run?.result?.suggestions.length ?? 0}개 제안 · ${analysisCollapsed ? t("펼치기") : t("접기")}`;
    el("rsToggleAnalysis").setAttribute("aria-expanded", String(!analysisCollapsed));
    el("rsAnalysisContent").hidden = collapsible && analysisCollapsed;
    el<HTMLButtonElement>("rsAnalyze").disabled = !analysis || !visible || !loaded || loading || busy || !unit() || !deps.canEdit()
      || !!state?.starting || !!state?.canceling || !!state?.applyingId || run?.state === "running";
    el("rsAnalysisPanel").hidden = !visible || !state || (!run && !state.starting && !state.error && !state.notice);
    el("rsCancelAnalysis").hidden = !state?.starting && run?.state !== "running";
    el<HTMLButtonElement>("rsCancelAnalysis").disabled = !!state?.canceling || !!state?.applyingId;
    el("rsAnalysisState").textContent = state?.starting ? t("현재 구절을 분석하고 있습니다…") : state?.canceling ? t("분석을 취소하고 있습니다…")
      : run?.state === "running" ? run.detail || t("독음과 뜻풀이를 살펴보고 있습니다…")
      : run?.state === "completed" ? t("검토한 제안만 채택하면 풀이에 저장됩니다.")
      : run?.state === "stale" ? t("원문이나 풀이가 변경되었습니다. 다시 분석해 주세요.")
      : run?.state === "canceled" ? t("분석을 취소했습니다.") : state?.notice ?? "";
    el("rsAnalysisError").textContent = state?.error || run?.error?.message || "";
    el("rsAnalysisError").hidden = !el("rsAnalysisError").textContent;
    el("rsAnalysisSummary").textContent = run?.result?.summary ?? "";
    const canAdopt = !!state && run?.state === "completed" && !state.applyingId && !state.starting && loaded && !loading && !busy && !dirty() && deps.canEdit();
    el("rsAnalysisSuggestions").innerHTML = (run?.result?.suggestions ?? []).map(item => ui`<article class="rs-ai-suggestion"><header><b class="hanmun">${esc(item.quote)}</b><small>${item.from + 1}–${item.to}</small><button class="btn btn-sm" type="button" data-rs-ai-apply="${esc(item.id)}"${!canAdopt || item.applied ? " disabled" : ""}>${esc(item.applied ? t("채택됨") : state?.applyingId === item.id ? t("저장 중…") : t("채택"))}</button></header>${item.reading ? ui`<p class="rs-ai-reading">독음 · ${esc(item.reading)}${item.readingOrder === null ? "" : ui` · 풀이 순서 ${item.readingOrder}`}</p>` : ""}${item.citation ? ui`<div class="rs-ai-citation"><small>사전 근거 · ${esc(item.citation.sourceLabel)}</small><p>${esc(item.citation.sense)}</p><button type="button" class="rs-source-link" data-rs-url="${esc(item.citation.sourceUrl)}">출처 보기 ↗</button></div>` : ""}${item.explanation ? ui`<div class="rs-ai-explanation"><small>AI 해석</small><p>${esc(item.explanation)}</p></div>` : ""}${item.caution ? ui`<p class="rs-ai-caution">확인할 점 · ${esc(item.caution)}</p>` : ""}</article>`).join("")
      || (run?.state === "completed" ? uiText('<p class="rs-help">이 구절에 제안할 풀이가 없습니다.</p>') : "");
    if (dirty() && run?.state === "completed") el("rsAnalysisState").textContent = t("편집 중인 풀이를 저장하거나 취소한 뒤 제안을 채택하세요.");
  }
  function updateDictionaryActions() {
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-rs-sense]")) {
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
    el<HTMLButtonElement>("rsSave").disabled = disabled || !dirty();
    el<HTMLButtonElement>("rsDiscard").disabled = busy || analysisApplying() || !dirty();
    el<HTMLButtonElement>("rsReload").disabled = busy || analysisApplying() || loading;
    el<HTMLSelectElement>("rsUnit").disabled = busy || analysisApplying() || !units.length;
    el<HTMLButtonElement>("rsPrevious").disabled = busy || analysisApplying() || unitIndex <= 0;
    el<HTMLButtonElement>("rsNext").disabled = busy || analysisApplying() || unitIndex >= units.length - 1;
    el("rsSaveState").textContent = busy ? t("저장 중…") : dirty() ? t("저장하지 않은 변경사항") : note ? t("프로젝트에 저장됨") : t("독음을 확인하거나 사전 뜻을 선택하세요");
    el("rsDelete").hidden = !note;
    updateDictionaryActions();
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
    return `${esc(values[0] ?? "")}${values.length > 1 ? `<small class="rs-more-gloss" aria-label="${esc(ui`그 밖의 기본 훈 ${values.length - 1}개`)}">+${values.length - 1}</small>` : ""}`;
  }
  function renderTokens() {
    const active = (token: ReadingToken) => !!selection && token.rangeIndex === selection.rangeIndex && token.from >= selection.from && token.to <= selection.to;
    el("rsSource").innerHTML = (unit()?.ranges ?? []).map((_, rangeIndex) => `<span class="rs-source-range">${tokens.filter(token => token.rangeIndex === rangeIndex).map(token => token.annotatable ? ui`<button type="button" data-rs-from="${token.from}" data-rs-to="${token.to}" data-rs-range="${rangeIndex}" aria-pressed="${active(token)}" aria-label="${esc(token.text)} · 원문 ${token.from + 1}번째 위치">${esc(token.text)}</button>` : esc(token.text)).join("")}</span>`).join(uiText('<span class="rs-source-gap" aria-label="떨어진 원문 구절"> … </span>'));
    const shown = tokens.filter(token => token.annotatable);
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
    el("rsTokens").classList.toggle("rs-cards", cards);
    el("rsTokens").innerHTML = rows.map(row => {
      const labels = ["原文", "독음", "기본 훈", "선택한 뜻"].map((label, i) => `<span class="rs-row-label" style="grid-row:${i + 1}">${esc(t(label))}</span>`).join("");
      const characters = row.map((token, index) => {
        const saved = rangeNote(token.from, token.to), basic = basicGlossFor(token.text), meaning = saved?.citation?.sense ?? "";
        return ui`<button class="rs-token" type="button" style="grid-column:${index + (cards ? 1 : 2)}" data-rs-from="${token.from}" data-rs-to="${token.to}" data-rs-range="${token.rangeIndex}" aria-pressed="${active(token)}" tabindex="${active(token) && token.from === selection?.from ? 0 : -1}" aria-label="${esc(token.text)} · ${esc(meaning || t("사전 확인"))} · 원문 ${token.from + 1}번째 위치"><small class="rs-token-order">${saved?.readingOrder ?? ""}</small><span class="rs-glyph hanmun">${esc(token.text)}</span><span class="rs-punctuation hanmun" aria-hidden="true">${esc(orderByReading ? "" : trailing.get(token.to))}</span><span class="rs-reading">${esc(saved?.reading || readingFor(token.text))}</span><span class="rs-token-basic" title="${esc(ui`사전 기본 훈: ${basic}`)}" aria-label="${esc(ui`사전 기본 훈: ${basic}`)}">${basicGlossMarkup(token.text)}</span><span class="rs-token-gloss${meaning ? "" : " rs-unselected"}" title="${esc(meaning)}">${esc(meaning || "—")}</span>${saved ? uiText('<i aria-label="저장된 기록 있음"></i>') : ""}</button>`;
      }).join("");
      // A saved phrase remains tied to its exact source range. In reordered views
      // show a bracket only when its members still appear together in source order.
      const markers = phrases.map(phrase => {
        const start = row.findIndex(token => token.from === phrase.codepointFrom), end = row.findIndex(token => token.to === phrase.codepointTo);
        if (start < 0 || end <= start || end - start + 1 !== shown.filter(token => token.from >= phrase.codepointFrom && token.to <= phrase.codepointTo).length || row.slice(start, end + 1).some((token, i, list) => i > 0 && token.from < list[i - 1]!.to)) return "";
        return `<button class="rs-group-marker" type="button" data-rs-phrase="${esc(phrase.id)}" style="grid-column:${start + (cards ? 1 : 2)} / span ${end - start + 1}" aria-pressed="${selection?.from === phrase.codepointFrom && selection?.to === phrase.codepointTo}" title="${esc(phrase.citation?.sense || phrase.reading)}">${esc(phrase.quote)}${phrase.reading ? ` · ${esc(phrase.reading)}` : ""}</button>`;
      }).join("");
      return `<div class="rs-study-line" style="--rs-cols:${columnCount}">${labels}${characters}${markers}</div>`;
    }).join("");
    el("rsSavedPhrases").innerHTML = phrases.map(row => `<button type="button" data-rs-phrase="${esc(row.id)}" aria-pressed="${selection?.from === row.codepointFrom && selection?.to === row.codepointTo}"><span class="hanmun">${esc(row.quote)}</span><span>${esc(row.citation?.sense || row.reading)}</span></button>`).join("");
  }
  function measureRows() {
    const width = el("rsTokens").clientWidth;
    if (!width) return;
    const next = Math.max(1, Math.min(12, Math.floor((width - (cards ? 0 : 48)) / 72)));
    if (next === columnCount) return;
    const focused = host.ownerDocument?.activeElement as HTMLElement | null;
    const from = focused?.classList.contains("rs-token") ? focused.dataset.rsFrom : undefined;
    columnCount = next; renderTokens();
    if (from !== undefined) el("rsTokens").querySelector<HTMLElement>(`[data-rs-from="${from}"]`)?.focus({ preventScroll: true });
  }

  function renderForm() {
    el("rsSelected").textContent = selectedQuote();
    el("rsSelected").classList.toggle("rs-word", Array.from(selectedQuote()).length > 5);
    el("rsPosition").textContent = selection ? ui`${selection.from + 1}–${selection.to}번째 위치` : "";
    el<HTMLInputElement>("rsReading").value = draft.reading;
    el<HTMLInputElement>("rsOrder").value = draft.readingOrder?.toString() ?? "";
    el("rsCitation").hidden = !draft.citation;
    const citation = draft.citation;
    el("rsCitationBody").innerHTML = citation ? ui`<p><b>${esc(citation.headword)}</b> · ${esc(citation.sense)}</p><details><summary>${esc(citation.sourceLabel)} · 출처 정보</summary><p>${esc(citation.license)}</p><button type="button" class="rs-source-link" data-rs-url="${esc(citation.sourceUrl)}">원문·출처 보기 ↗</button><p>${esc(citation.attribution)}</p></details>` : "";
    status();
  }
  function activateSelection(next: Selection) {
    if (selection?.from !== next.from || selection?.to !== next.to || selection?.rangeIndex !== next.rangeIndex) el("rsInspectorBody").scrollTop = 0;
    selection = next; note = rangeNote(next.from, next.to);
    draft = note ? { reading: note.reading, readingOrder: note.readingOrder, citation: note.citation } : { ...blank(), reading: readingFor(selectedQuote()) };
    baseline = JSON.stringify(draft); renderTokens(); renderForm(); void lookup(selectedQuote());
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
    return true;
  }
  function renderUnit() {
    const current = unit(); tokens = readingTokens(current?.ranges ?? []); selection = null; anchor = null; note = undefined; draft = blank(); baseline = JSON.stringify(draft);
    el("rsEmpty").hidden = !!current; el("rsSpread").hidden = !current;
    el<HTMLSelectElement>("rsUnit").value = String(unitIndex);
    el("rsUnitTitle").textContent = current?.label ?? t("원문 구절");
    el("rsVersion").textContent = view ? ui`원문 V${view.source.versionNo}` : "";
    el("rsTranslation").textContent = current?.translation ?? t("연결된 번역이 없는 원문 구절입니다.");
    el("rsTranslation").classList.toggle("rs-no-translation", !current?.translation);
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
  async function save(): Promise<boolean> {
    if (!dirty()) return true;
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
      draft = { reading: note.reading, readingOrder: note.readingOrder, citation: note.citation }; baseline = JSON.stringify(draft);
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
      if (!note && !dirty() && lookupQuery === selectedQuote() && !draft.reading) { draft.reading = readingFor(query); baseline = JSON.stringify(draft); el<HTMLInputElement>("rsReading").value = draft.reading; }
    } catch (error) { if (ticket === dictionarySerial) { el("rsDictReading").textContent = t("조회 실패"); el("rsLookupState").textContent = error instanceof Error ? error.message : t("사전을 불러오지 못했습니다."); el("rsRetry").hidden = false; } }
  }
  async function changeUnit(index: number) { if (!units[index] || busy || analysisApplying()) return; if (dirty() && !await save()) { el<HTMLSelectElement>("rsUnit").value = String(unitIndex); return; } unitIndex = index; renderUnit(); }
  host.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const proposal = target.closest<HTMLButtonElement>("[data-rs-ai-apply]");
    if (proposal) { if (!proposal.disabled && proposal.dataset.rsAiApply) void analysis?.apply(proposal.dataset.rsAiApply); return; }
    const token = target.closest<HTMLElement>("[data-rs-from]"); if (token) {
      const from = Number(token.dataset.rsFrom), focusToken = token.matches(".rs-token");
      void choose({ from, to: Number(token.dataset.rsTo), rangeIndex: Number(token.dataset.rsRange) }, (event as MouseEvent).shiftKey).then(chosen => {
        if (chosen && focusToken) el("rsTokens").querySelector<HTMLElement>(`[data-rs-from="${from}"]`)?.focus({ preventScroll: true });
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
  el("rsForm").addEventListener("submit", event => { event.preventDefault(); void save(); });
  el("rsAnalyze").addEventListener("click", () => { void analysis?.start(); });
  el("rsCancelAnalysis").addEventListener("click", () => { void analysis?.cancel(); });
  el("rsToggleAnalysis").addEventListener("click", () => {
    if (analysis?.state().run?.state !== "completed") return;
    analysisCollapsed = !analysisCollapsed; renderAnalysis();
  });
  host.ownerDocument?.defaultView?.addEventListener("pagehide", () => analysis?.dispose(), { once: true });
  for (const id of ["rsReading", "rsOrder"]) el(id).addEventListener("input", () => {
    if (editingDisabled()) return;
    draft.reading = el<HTMLInputElement>("rsReading").value;
    const order = el<HTMLInputElement>("rsOrder").value; draft.readingOrder = order === "" ? null : Number(order); message = ""; deps.edited(); status();
  });
  el("rsClearCitation").addEventListener("click", event => { event.preventDefault(); if (editingDisabled() || !draft.citation) return; draft.citation = null; deps.edited(); renderForm(); });
  el("rsDiscard").addEventListener("click", () => { if (!busy && !analysisApplying() && selection) { message = ""; activateSelection(selection); } });
  el("rsDelete").addEventListener("click", () => { void archive(); });
  el("rsReload").addEventListener("click", () => { if (dirty()) { message = t("변경사항을 저장하거나 ‘입력 취소’를 누른 뒤 새로고침하세요."); status(); return; } void load(); });
  el("rsPrevious").addEventListener("click", () => { void changeUnit(unitIndex - 1); }); el("rsNext").addEventListener("click", () => { void changeUnit(unitIndex + 1); });
  el<HTMLSelectElement>("rsUnit").addEventListener("change", event => { void changeUnit(Number((event.target as HTMLSelectElement).value)); });
  for (const id of ["rsSourceOrder", "rsReadingOrder"]) el(id).addEventListener("click", () => { orderByReading = id === "rsReadingOrder"; el("rsSourceOrder").setAttribute("aria-pressed", String(!orderByReading)); el("rsReadingOrder").setAttribute("aria-pressed", String(orderByReading)); renderTokens(); });
  for (const id of ["rsAligned", "rsCards"]) el(id).addEventListener("click", () => {
    cards = id === "rsCards";
    el("rsAligned").setAttribute("aria-pressed", String(!cards)); el("rsCards").setAttribute("aria-pressed", String(cards));
    measureRows(); renderTokens();
  });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => { if (visible) measureRows(); }).observe(el("rsTokens"));
  el("rsSenseTab").addEventListener("click", () => dictionaryTabs(false)); el("rsInfoTab").addEventListener("click", () => dictionaryTabs(true));
  el("rsRetry").addEventListener("click", () => { void lookup(lookupQuery || selectedQuote()); });
  host.querySelector(".rs-tabs")!.addEventListener("keydown", event => { const keyEvent = event as KeyboardEvent; if (!["ArrowLeft", "ArrowRight"].includes(keyEvent.key)) return; keyEvent.preventDefault(); const info = el("rsSenseTab").getAttribute("aria-selected") === "true"; dictionaryTabs(info); el(info ? "rsInfoTab" : "rsSenseTab").focus(); });

  return {
    hasUnsavedDraft: dirty, isBusy: () => busy || analysisApplying(), save,
    discard() { if (!busy && !analysisApplying() && selection) { message = ""; activateSelection(selection); } },
    setDocument(next: EditorView) {
      const changed = identity() !== `${next.document.id}:${next.source.versionId}`;
      const previousUnit = unit()?.id; view = next; units = buildReadingUnits(next);
      if (changed) { ++loadSerial; ++dictionarySerial; notes = []; loaded = false; loading = false; selection = null; draft = blank(); baseline = JSON.stringify(draft); message = ""; unitIndex = 0; }
      else unitIndex = Math.max(0, units.findIndex(item => item.id === previousUnit));
      el("rsUnit").innerHTML = units.map((item, i) => `<option value="${i}">${i + 1} / ${units.length} · ${esc(item.ranges.map(range => range.quote).join(" … ").slice(0, 34))}</option>`).join("");
      if (changed || !dirty()) renderUnit(); else status();
      syncAnalysis();
      renderOld(); if (visible && !loaded) void load();
    },
    setVisible(next: boolean, preferredSentenceId?: string | null) {
      visible = next; if (!next) { ++dictionarySerial; ++warmSerial; syncAnalysis(); return; }
      if (preferredSentenceId && !dirty()) { const found = units.findIndex(item => item.id === `translation:${preferredSentenceId}`); if (found >= 0) unitIndex = found; }
      measureRows();
      if (!dirty()) renderUnit(); else status();
      syncAnalysis();
      if (!loaded) void load(); else if (selection) void lookup(selectedQuote());
    },
  };
}
