import type { EditorView, MunhaeApi, ReadingAnnotationView, ReadingCitation } from "../../shared/munhae-api";
import type { DictionaryEntry } from "../../shared/dictionary-types";
import { buildReadingUnits, readingTokens, type ReadingUnit, type ReadingToken } from "./reading-model";
import "../styles/reading-study.css";

type Selection = { from: number; to: number; rangeIndex: number };
type Draft = { reading: string; gloss: string; readingOrder: number | null; citation: ReadingCitation | null };
type Deps = { api: MunhaeApi; host: HTMLElement; escape(value: unknown): string; notify(message: string, title?: string): void; canEdit(): boolean; changed(): void; edited(): void };

export function configureReadingStudy(deps: Deps) {
  const { api, host, escape: esc } = deps;
  host.classList.add("reading-study");
  host.innerHTML = `<header class="rs-toolbar"><div class="rs-title"><span>句讀</span><h2>구절 연구</h2></div><div class="rs-navigation"><button type="button" class="btn btn-ghost btn-sm" id="rsPrevious" aria-label="이전 연구 구절">↑</button><label class="sr-only" for="rsUnit">연구할 구절</label><select class="select" id="rsUnit"></select><button type="button" class="btn btn-ghost btn-sm" id="rsNext" aria-label="다음 연구 구절">↓</button></div><button class="btn btn-ghost btn-sm" type="button" id="rsReload" title="저장된 주석 새로 불러오기">새로고침</button></header>
    <p id="rsStatus" class="rs-status" role="status"></p><p id="rsEmpty" class="rs-empty" hidden>저장된 원문이 없습니다. 원문을 입력하고 저장한 뒤 구절을 살펴보세요.</p>
    <div class="rs-spread" id="rsSpread"><article class="rs-document"><section aria-label="연구 구절과 번역"><div class="rs-section-label"><span>原文</span><h3 id="rsUnitTitle">원문 구절</h3><small id="rsVersion"></small></div><div id="rsSource" class="rs-source hanmun"></div><div class="rs-translation"><span>譯</span><p id="rsTranslation"></p></div><p id="rsAlignment" class="rs-help"></p></section>
    <section class="rs-analysis" aria-label="글자별 풀이"><div class="rs-analysis-heading"><div class="rs-section-label"><span>逐字</span><h3>글자별 풀이</h3></div><div class="rs-order" role="group" aria-label="풀이 표시 순서"><button type="button" id="rsSourceOrder" aria-pressed="true">원문 순서</button><button type="button" id="rsReadingOrder" aria-pressed="false">풀이 순서</button></div></div><div id="rsTokens" class="rs-tokens"></div><p class="rs-help">Shift+클릭으로 어휘 선택 · 방향키로 글자 이동 · 풀이가 없으면 사전의 기본 훈을 표시합니다.</p><div id="rsSavedPhrases" class="rs-saved-phrases" aria-label="저장된 어휘 풀이"></div></section>
    <form id="rsForm" class="rs-annotation"><div class="rs-section-label"><span>私註</span><h3>이 구절의 풀이</h3><b id="rsSelected" class="hanmun"></b><small id="rsPosition"></small></div><div class="rs-fields"><label>독음<input class="input" id="rsReading" maxlength="100" autocomplete="off" placeholder="독음 입력"></label><label>풀이 순서<input class="input" id="rsOrder" type="number" min="1" max="10000" placeholder="선택"></label></div><label class="rs-gloss-label" for="rsGloss">문맥 풀이</label><textarea class="textarea" id="rsGloss" rows="3" maxlength="2000" placeholder="이 문맥에서 어떻게 읽을지 적어 주세요."></textarea><details class="rs-citation" id="rsCitation" hidden><summary>선택한 사전 근거 <button type="button" id="rsClearCitation">연결 해제</button></summary><div id="rsCitationBody"></div></details><div class="rs-form-actions"><span id="rsSaveState" role="status"></span><button class="btn btn-ghost btn-sm" type="button" id="rsDelete" hidden>풀이 삭제</button><button class="btn btn-ghost btn-sm" type="button" id="rsDiscard">입력 취소</button><button class="btn btn-primary btn-sm" type="submit" id="rsSave">풀이 저장 <kbd>⌘S</kbd></button></div></form>
    <details id="rsOldNotes" class="rs-old-notes" hidden><summary id="rsOldSummary"></summary><p>이전 원문의 주석은 해당 버전에 보존되어 있습니다. 현재 원문으로 자동 이동하지 않습니다.</p><div id="rsOldList"></div></details></article>
    <aside class="rs-dictionary" aria-label="선택 글자 사전"><div class="rs-dictionary-heading"><h3>자의와 어휘</h3><span>내장 사전</span></div><div class="rs-character-heading"><span id="rsHero" class="hanmun"></span><div><b id="rsDictReading"></b><p id="rsDictMeta"></p></div></div><div class="rs-tabs" role="tablist" aria-label="사전 정보"><button id="rsSenseTab" type="button" role="tab" aria-selected="true" aria-controls="rsSensePanel">뜻풀이</button><button id="rsInfoTab" type="button" role="tab" aria-selected="false" tabindex="-1" aria-controls="rsInfoPanel">문자 정보</button></div><p id="rsLookupState" class="rs-help" role="status"></p><button type="button" class="btn btn-sm" id="rsRetry" hidden>사전 다시 조회</button><div id="rsSensePanel" role="tabpanel" aria-labelledby="rsSenseTab"></div><div id="rsInfoPanel" role="tabpanel" aria-labelledby="rsInfoTab" hidden></div><p class="rs-dictionary-foot">사전의 뜻을 참고해 문맥 풀이를 작성하세요. 사전 근거와 직접 쓴 풀이는 구분해 저장됩니다.</p></aside></div>`;
  function el<T extends HTMLElement = HTMLElement>(id: string): T { return host.querySelector<T>(`#${id}`)!; }
  let view: EditorView | null = null, units: ReadingUnit[] = [], unitIndex = 0, tokens: ReadingToken[] = [];
  let selection: Selection | null = null, anchor: ReadingToken | null = null;
  let notes: ReadingAnnotationView[] = [], loaded = false, visible = false, busy = false, loading = false;
  let note: ReadingAnnotationView | undefined, draft: Draft = blank(), baseline = "", message = "";
  let loadSerial = 0, dictionarySerial = 0, warmSerial = 0, orderByReading = false;
  let dictEntries: DictionaryEntry[] = [], lookupQuery = "";
  const dictionaryCache = new Map<string, Promise<DictionaryEntry[]>>();
  const characterEntries = new Map<string, DictionaryEntry[]>();
  function blank(): Draft { return { reading: "", gloss: "", readingOrder: null, citation: null }; }
  function identity() { return view ? `${view.document.id}:${view.source.versionId}` : ""; }
  function unit() { return units[unitIndex]; }
  function selectedQuote() { return view && selection ? Array.from(view.source.contentText).slice(selection.from, selection.to).join("") : ""; }
  function dirty() { return !!selection && JSON.stringify(draft) !== baseline; }
  function currentNotes() { return notes.filter(row => row.sourceVersionId === view?.source.versionId); }
  function rangeNote(from: number, to: number) { return currentNotes().find(row => row.codepointFrom === from && row.codepointTo === to); }
  function editingDisabled() { return !visible || busy || loading || !loaded || !selection || !deps.canEdit(); }
  function updateDictionaryActions() {
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-rs-sense]")) {
      const entry = dictEntries[Number(button.dataset.rsEntry)];
      button.disabled = editingDisabled() || lookupQuery !== selectedQuote() || !entry?.canCite
        || !entry.senses[Number(button.dataset.rsSense)]?.text.trim();
    }
  }
  function status() {
    el("rsStatus").textContent = loading ? "프로젝트 주석을 불러오는 중…" : message || (!deps.canEdit() ? "원문·번역의 편집 내용을 먼저 저장하면 풀이를 저장할 수 있습니다." : "");
    el("rsStatus").hidden = !el("rsStatus").textContent;
    const disabled = editingDisabled();
    for (const id of ["rsReading", "rsOrder", "rsGloss", "rsSave", "rsClearCitation", "rsDelete"]) (el(id) as HTMLButtonElement | HTMLInputElement).disabled = disabled;
    el<HTMLButtonElement>("rsSave").disabled = disabled || !dirty();
    el<HTMLButtonElement>("rsDiscard").disabled = busy || !dirty();
    el<HTMLButtonElement>("rsReload").disabled = busy || loading;
    el<HTMLSelectElement>("rsUnit").disabled = busy || !units.length;
    el<HTMLButtonElement>("rsPrevious").disabled = busy || unitIndex <= 0;
    el<HTMLButtonElement>("rsNext").disabled = busy || unitIndex >= units.length - 1;
    el("rsSaveState").textContent = busy ? "저장 중…" : dirty() ? "저장하지 않은 풀이" : note ? "프로젝트에 저장됨" : "풀이를 작성해 보세요";
    el("rsDelete").hidden = !note;
    updateDictionaryActions();
    deps.changed();
  }
  function readingFor(text: string) {
    const entries = characterEntries.get(text) ?? [];
    return entries.find(entry => entry.source === "libhangul")?.reading ?? entries.find(entry => entry.reading)?.reading ?? "";
  }
  function basicGlossFor(text: string) {
    return characterEntries.get(text)?.find(entry => entry.source === "libhangul")?.senses.map(sense => sense.text).filter(Boolean).join(" · ") ?? "";
  }
  function renderTokens() {
    const active = (token: ReadingToken) => !!selection && token.rangeIndex === selection.rangeIndex && token.from >= selection.from && token.to <= selection.to;
    el("rsSource").innerHTML = (unit()?.ranges ?? []).map((_, rangeIndex) => `<span class="rs-source-range">${tokens.filter(token => token.rangeIndex === rangeIndex).map(token => token.annotatable ? `<button type="button" data-rs-from="${token.from}" data-rs-to="${token.to}" data-rs-range="${rangeIndex}" aria-pressed="${active(token)}" aria-label="${esc(token.text)} · 원문 ${token.from + 1}번째 위치">${esc(token.text)}</button>` : esc(token.text)).join("")}</span>`).join('<span class="rs-source-gap" aria-label="떨어진 원문 구절"> … </span>');
    const shown = tokens.filter(token => token.annotatable).map(token => ({ token, note: rangeNote(token.from, token.to) }));
    if (orderByReading) shown.sort((a, b) => (a.note?.readingOrder ?? Infinity) - (b.note?.readingOrder ?? Infinity) || a.token.from - b.token.from);
    el("rsTokens").innerHTML = shown.map(({ token, note: saved }) => `<button class="rs-token" type="button" data-rs-from="${token.from}" data-rs-to="${token.to}" data-rs-range="${token.rangeIndex}" aria-pressed="${active(token)}" tabindex="${active(token) && token.from === selection?.from ? 0 : -1}" aria-label="${esc(token.text)} · ${esc(saved?.gloss || "풀이 작성")} · 원문 ${token.from + 1}번째 위치"><small>${saved?.readingOrder ?? ""}</small><span class="rs-glyph hanmun">${esc(token.text)}</span><span class="rs-reading">${esc(saved?.reading || readingFor(token.text))}</span><span class="rs-token-gloss" title="${esc(saved?.gloss || `사전 기본 훈: ${basicGlossFor(token.text)}`)}">${esc(saved?.gloss || basicGlossFor(token.text))}</span>${saved ? '<i aria-label="저장된 풀이 있음"></i>' : ""}</button>`).join("");
    const phrases = currentNotes().filter(row => unit()?.ranges.some(range => row.codepointFrom >= range.from && row.codepointTo <= range.to) && tokens.filter(token => token.annotatable && token.from >= row.codepointFrom && token.to <= row.codepointTo).length > 1);
    el("rsSavedPhrases").innerHTML = phrases.map(row => `<button type="button" data-rs-phrase="${esc(row.id)}"><span class="hanmun">${esc(row.quote)}</span><span>${esc(row.gloss || row.reading)}</span></button>`).join("");
  }
  function renderForm() {
    el("rsSelected").textContent = selectedQuote();
    el("rsPosition").textContent = selection ? `${selection.from + 1}–${selection.to}번째 위치` : "";
    el<HTMLInputElement>("rsReading").value = draft.reading;
    el<HTMLInputElement>("rsOrder").value = draft.readingOrder?.toString() ?? "";
    el<HTMLTextAreaElement>("rsGloss").value = draft.gloss;
    el("rsCitation").hidden = !draft.citation;
    const citation = draft.citation;
    el("rsCitationBody").innerHTML = citation ? `<p><b>${esc(citation.headword)}</b> · ${esc(citation.sense)}</p><p>${esc(citation.sourceLabel)} · ${esc(citation.license)}</p><button type="button" class="rs-source-link" data-rs-url="${esc(citation.sourceUrl)}">원문·출처 보기 ↗</button><p>${esc(citation.attribution)}</p>` : "";
    status();
  }
  function activateSelection(next: Selection) {
    selection = next; note = rangeNote(next.from, next.to);
    draft = note ? { reading: note.reading, gloss: note.gloss, readingOrder: note.readingOrder, citation: note.citation } : { ...blank(), reading: readingFor(selectedQuote()) };
    baseline = JSON.stringify(draft); renderTokens(); renderForm(); void lookup(selectedQuote());
  }
  async function choose(next: Selection, extend = false): Promise<boolean> {
    if (busy || loading) return false;
    if (dirty() && !await save()) return false;
    const target = tokens.find(token => token.from === next.from && token.to === next.to && token.rangeIndex === next.rangeIndex);
    if (extend && anchor) {
      if (anchor.rangeIndex !== next.rangeIndex) { deps.notify("떨어진 구절을 하나의 어휘로 묶을 수 없습니다.", "구절 연구"); return false; }
      next = { from: Math.min(anchor.from, next.from), to: Math.max(anchor.to, next.to), rangeIndex: next.rangeIndex };
    } else anchor = target ?? null;
    if (next.to - next.from > 100) { deps.notify("한 번에 100자 이내의 어휘를 선택하세요.", "구절 연구"); return false; }
    activateSelection(next);
    return true;
  }
  function renderUnit() {
    const current = unit(); tokens = readingTokens(current?.ranges ?? []); selection = null; anchor = null; note = undefined; draft = blank(); baseline = JSON.stringify(draft);
    el("rsEmpty").hidden = !!current; el("rsSpread").hidden = !current;
    el<HTMLSelectElement>("rsUnit").value = String(unitIndex);
    el("rsUnitTitle").textContent = current?.label ?? "원문 구절";
    el("rsVersion").textContent = view ? `원문 V${view.source.versionNo}` : "";
    el("rsTranslation").textContent = current?.translation ?? "연결된 번역이 없는 원문 구절입니다.";
    el("rsAlignment").textContent = current?.needsReview ? "원문과 번역의 대응을 확인하며 읽어 주세요." : "";
    const first = tokens.find(token => token.annotatable);
    if (first) { anchor = first; activateSelection({ from: first.from, to: first.to, rangeIndex: first.rangeIndex }); }
    else { renderTokens(); renderForm(); ++dictionarySerial; lookupQuery = ""; dictEntries = []; for (const id of ["rsHero", "rsDictReading", "rsDictMeta", "rsLookupState"]) el(id).textContent = ""; el("rsRetry").hidden = true; el("rsSensePanel").replaceChildren(); el("rsInfoPanel").replaceChildren(); }
    void warmReadings(tokens, identity());
  }
  function renderOld() {
    const old = notes.filter(row => row.sourceVersionId !== view?.source.versionId);
    el("rsOldNotes").hidden = !old.length; el("rsOldSummary").textContent = `이전 원문에 남아 있는 풀이 ${old.length}개`;
    el("rsOldList").innerHTML = old.map(row => `<div><b class="hanmun">${esc(row.quote)}</b><p>${esc(row.gloss || row.reading)}</p><small>${esc(row.updatedAt.slice(0, 10))} · 이전 원문 / 읽기 전용</small></div>`).join("");
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
    } catch (error) { if (ticket === loadSerial) { loaded = false; message = error instanceof Error ? error.message : "주석을 불러오지 못했습니다. 새로고침으로 다시 시도하세요."; } }
    finally { if (ticket === loadSerial) { loading = false; status(); } }
  }
  async function save(): Promise<boolean> {
    if (!dirty()) return true;
    if (!view || !selection || busy || loading || !loaded || !deps.canEdit()) { message = "다른 편집 내용을 저장한 뒤 풀이를 저장하세요."; status(); return false; }
    if (!draft.gloss.trim() && !draft.reading.trim() && draft.readingOrder === null && !draft.citation) { message = "독음이나 문맥 풀이를 입력하세요. 기존 풀이를 지우려면 ‘풀이 삭제’를 누르세요."; status(); return false; }
    if (draft.readingOrder !== null && (!Number.isInteger(draft.readingOrder) || draft.readingOrder < 1 || draft.readingOrder > 10000)) { message = "풀이 순서는 1~10000 사이 정수로 입력하세요."; status(); return false; }
    const currentIdentity = identity(); busy = true; message = ""; status();
    try {
      const result = await api.editor.saveReadingAnnotation({ ...(note ? { id: note.id } : {}), documentNodeId: view.document.id, sourceVersionId: view.source.versionId, codepointFrom: selection.from, codepointTo: selection.to, quote: selectedQuote(), ...structuredClone(draft), expectedLockVersion: note?.lockVersion ?? 0 });
      if (currentIdentity !== identity()) return false;
      if (!result.ok) throw new Error(result.error.message);
      note = result.data; notes = notes.filter(row => row.id !== note!.id); notes.push(note);
      draft = { reading: note.reading, gloss: note.gloss, readingOrder: note.readingOrder, citation: note.citation }; baseline = JSON.stringify(draft);
      renderTokens(); renderForm(); return true;
    } catch (error) { message = error instanceof Error ? error.message : "풀이를 저장하지 못했습니다. 입력 내용은 유지됩니다."; return false; }
    finally { busy = false; status(); }
  }
  async function archive() {
    if (!note || busy || !deps.canEdit()) return;
    busy = true; message = ""; status(); const currentIdentity = identity(), old = note;
    try {
      const result = await api.editor.archiveReadingAnnotation({ id: old.id, expectedLockVersion: old.lockVersion });
      if (identity() !== currentIdentity) return;
      if (!result.ok) throw new Error(result.error.message);
      notes = notes.filter(row => row.id !== old.id); if (selection) activateSelection(selection);
    } catch (error) { message = error instanceof Error ? error.message : "풀이를 삭제하지 못했습니다."; }
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
            if (!saved?.gloss) {
              const gloss = button.querySelector<HTMLElement>(".rs-token-gloss")!;
              gloss.textContent = basicGlossFor(query); gloss.title = `사전 기본 훈: ${basicGlossFor(query)}`;
            }
          }
        }
      }
    }); await Promise.all(workers);
  }
  function dictionaryTabs(info: boolean) { for (const [id, on] of [["rsInfoTab", info], ["rsSenseTab", !info]] as const) { el(id).setAttribute("aria-selected", String(on)); el(id).tabIndex = on ? 0 : -1; } el("rsInfoPanel").hidden = !info; el("rsSensePanel").hidden = info; }
  function renderDictionary() {
    const propertyEntry = dictEntries.find(entry => entry.characterInfo), info = propertyEntry?.characterInfo;
    el("rsDictReading").textContent = readingFor(lookupQuery) || "독음 미수록";
    el("rsDictMeta").textContent = info ? `${info.radicals.map(radical => radical.glyph).join(" · ")} 부수 · ${info.totalStrokes.join(" / ")}획` : "";
    el("rsSensePanel").innerHTML = dictEntries.filter(entry => !entry.characterInfo).map(entry => `<section class="rs-dict-source"><h4>${esc(entry.sourceLabel)}<button type="button" data-rs-url="${esc(entry.sourceUrl)}" aria-label="${esc(entry.sourceLabel)} 원문 보기">↗</button></h4>${entry.senses.map((sense, index) => `<button class="rs-sense" type="button" data-rs-entry="${dictEntries.indexOf(entry)}" data-rs-sense="${index}"${!sense.text.trim() || !entry.canCite || lookupQuery !== selectedQuote() || busy ? " disabled" : ""}><small>${esc(sense.label ?? `뜻 ${index + 1}`)}</small><span>${esc(sense.text || "뜻 미수록")}</span>${sense.text.trim() && entry.canCite && lookupQuery === selectedQuote() ? "<em>풀이에 가져오기 ↙</em>" : ""}</button>`).join("")}<p class="rs-dict-credit" title="${esc(entry.attribution)}">${esc(entry.license)} · 출처·가공 정보</p></section>`).join("") || '<p class="rs-help">정확히 일치하는 뜻풀이가 없습니다. 선택한 글자나 어휘의 뜻을 직접 작성할 수 있습니다.</p>';
    const kinds = { semantic: "의미상 이체자", specializedSemantic: "특정 용법의 의미 이체자", z: "자형 이체자", traditional: "번체 대응", simplified: "간체 대응" };
    el("rsInfoPanel").innerHTML = info ? `<dl><dt>문자 코드</dt><dd>${esc(info.codePoint)}</dd><dt>독음</dt><dd>${esc(propertyEntry?.reading ?? "미수록")}</dd><dt>총획</dt><dd>${info.totalStrokes.join(" / ")}획</dd><dt>부수</dt><dd>${info.radicals.map(radical => `${esc(radical.glyph)} · ${radical.number}번 / 나머지 ${radical.residualStrokes}획`).join("<br>")}</dd></dl>${info.variants.map(group => `<section class="rs-variants"><h4>${kinds[group.kind]}</h4>${group.characters.map(char => `<button type="button" class="btn hanmun" data-rs-variant="${esc(char)}">${esc(char)}</button>`).join("")}</section>`).join("")}<p class="rs-help">Unicode Unihan ${esc(info.unicodeVersion)} · ${esc(propertyEntry?.license)}<br>관련 자형을 눌러도 원문은 바뀌지 않습니다.</p>` : '<p class="rs-help">문자 속성이 없거나 여러 글자를 선택했습니다.</p>';
    updateDictionaryActions();
  }
  async function lookup(query: string) {
    if (!query || !visible) return;
    const ticket = ++dictionarySerial; lookupQuery = query; dictEntries = [];
    el("rsHero").textContent = query; el("rsHero").classList.toggle("rs-word", Array.from(query).length > 2);
    el("rsDictReading").textContent = "조회 중…"; el("rsDictMeta").textContent = ""; el("rsSensePanel").replaceChildren(); el("rsInfoPanel").replaceChildren();
    el("rsLookupState").textContent = "내장 사전을 조회하고 있습니다."; el("rsRetry").hidden = true;
    try {
      const entries = await cachedLookup(query); if (ticket !== dictionarySerial || !visible) return;
      dictEntries = entries; renderDictionary(); el("rsLookupState").textContent = lookupQuery === selectedQuote() ? "" : "관련 자형을 따로 조회하고 있습니다. 원문 선택은 유지됩니다.";
      if (!note && !dirty() && lookupQuery === selectedQuote() && !draft.reading) { draft.reading = readingFor(query); baseline = JSON.stringify(draft); el<HTMLInputElement>("rsReading").value = draft.reading; }
    } catch (error) { if (ticket === dictionarySerial) { el("rsDictReading").textContent = "조회 실패"; el("rsLookupState").textContent = error instanceof Error ? error.message : "사전을 불러오지 못했습니다."; el("rsRetry").hidden = false; } }
  }
  async function changeUnit(index: number) { if (!units[index] || busy) return; if (dirty() && !await save()) { el<HTMLSelectElement>("rsUnit").value = String(unitIndex); return; } unitIndex = index; renderUnit(); }
  host.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const token = target.closest<HTMLElement>("[data-rs-from]"); if (token) { void choose({ from: Number(token.dataset.rsFrom), to: Number(token.dataset.rsTo), rangeIndex: Number(token.dataset.rsRange) }, (event as MouseEvent).shiftKey); return; }
    const phrase = target.closest<HTMLElement>("[data-rs-phrase]"); if (phrase) { const row = currentNotes().find(item => item.id === phrase.dataset.rsPhrase); const rangeIndex = unit()?.ranges.findIndex(range => row && range.from <= row.codepointFrom && range.to >= row.codepointTo) ?? -1; if (row && rangeIndex >= 0) void choose({ from: row.codepointFrom, to: row.codepointTo, rangeIndex }); return; }
    const link = target.closest<HTMLElement>("[data-rs-url]"); if (link?.dataset.rsUrl) { void api.app.openExternal(link.dataset.rsUrl).catch(error => deps.notify(error instanceof Error ? error.message : "출처를 열지 못했습니다.", "사전 출처")); return; }
    const variant = target.closest<HTMLElement>("[data-rs-variant]"); if (variant?.dataset.rsVariant) { void lookup(variant.dataset.rsVariant); return; }
    const sense = target.closest<HTMLButtonElement>("[data-rs-sense]"); if (sense && !sense.disabled && !editingDisabled() && lookupQuery === selectedQuote()) {
      const entry = dictEntries[Number(sense.dataset.rsEntry)], meaning = entry?.senses[Number(sense.dataset.rsSense)]; if (!entry?.canCite || !meaning?.text.trim()) return;
      draft.citation = { source: entry.source, sourceLabel: entry.sourceLabel, entryId: entry.id, headword: entry.headword, reading: entry.reading, sense: meaning.text, ...(meaning.label ? { senseLabel: meaning.label } : {}), sourceUrl: entry.sourceUrl, license: entry.license, licenseUrl: entry.licenseUrl, attribution: entry.attribution };
      if (!draft.gloss.trim()) draft.gloss = meaning.text.slice(0, 2000);
      if (!draft.reading) draft.reading = entry.reading ?? "";
      deps.edited();
      renderForm(); el<HTMLTextAreaElement>("rsGloss").focus();
    }
  });
  el("rsTokens").addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || busy) return;
    event.preventDefault(); const visibleTokens = Array.from(el("rsTokens").querySelectorAll<HTMLElement>("[data-rs-from]"));
    const current = (event.target as HTMLElement).closest<HTMLElement>("[data-rs-from]"); const at = Math.max(0, visibleTokens.indexOf(current!));
    const index = event.key === "Home" ? 0 : event.key === "End" ? visibleTokens.length - 1 : Math.max(0, Math.min(visibleTokens.length - 1, at + (event.key === "ArrowLeft" ? -1 : 1)));
    const next = visibleTokens[index]; if (!next) return; const from = Number(next.dataset.rsFrom);
    void choose({ from, to: Number(next.dataset.rsTo), rangeIndex: Number(next.dataset.rsRange) }, event.shiftKey).then(chosen => { if (chosen) el("rsTokens").querySelector<HTMLElement>(`[data-rs-from="${from}"]`)?.focus({ preventScroll: true }); });
  });
  el("rsForm").addEventListener("submit", event => { event.preventDefault(); void save(); });
  for (const id of ["rsReading", "rsGloss", "rsOrder"]) el(id).addEventListener("input", () => {
    if (editingDisabled()) return;
    draft.reading = el<HTMLInputElement>("rsReading").value; draft.gloss = el<HTMLTextAreaElement>("rsGloss").value;
    const order = el<HTMLInputElement>("rsOrder").value; draft.readingOrder = order === "" ? null : Number(order); message = ""; deps.edited(); status();
  });
  el("rsClearCitation").addEventListener("click", event => { event.preventDefault(); if (editingDisabled() || !draft.citation) return; draft.citation = null; deps.edited(); renderForm(); });
  el("rsDiscard").addEventListener("click", () => { if (!busy && selection) { message = ""; activateSelection(selection); } });
  el("rsDelete").addEventListener("click", () => { void archive(); });
  el("rsReload").addEventListener("click", () => { if (dirty()) { message = "먼저 풀이를 저장하거나 ‘입력 취소’를 누른 뒤 새로고침하세요."; status(); return; } void load(); });
  el("rsPrevious").addEventListener("click", () => { void changeUnit(unitIndex - 1); }); el("rsNext").addEventListener("click", () => { void changeUnit(unitIndex + 1); });
  el<HTMLSelectElement>("rsUnit").addEventListener("change", event => { void changeUnit(Number((event.target as HTMLSelectElement).value)); });
  for (const id of ["rsSourceOrder", "rsReadingOrder"]) el(id).addEventListener("click", () => { orderByReading = id === "rsReadingOrder"; el("rsSourceOrder").setAttribute("aria-pressed", String(!orderByReading)); el("rsReadingOrder").setAttribute("aria-pressed", String(orderByReading)); renderTokens(); });
  el("rsSenseTab").addEventListener("click", () => dictionaryTabs(false)); el("rsInfoTab").addEventListener("click", () => dictionaryTabs(true));
  el("rsRetry").addEventListener("click", () => { void lookup(lookupQuery || selectedQuote()); });
  host.querySelector(".rs-tabs")!.addEventListener("keydown", event => { const keyEvent = event as KeyboardEvent; if (!["ArrowLeft", "ArrowRight"].includes(keyEvent.key)) return; keyEvent.preventDefault(); const info = el("rsSenseTab").getAttribute("aria-selected") === "true"; dictionaryTabs(info); el(info ? "rsInfoTab" : "rsSenseTab").focus(); });

  return {
    hasUnsavedDraft: dirty, isBusy: () => busy, save,
    discard() { if (!busy && selection) { message = ""; activateSelection(selection); } },
    setDocument(next: EditorView) {
      const changed = identity() !== `${next.document.id}:${next.source.versionId}`;
      const previousUnit = unit()?.id; view = next; units = buildReadingUnits(next);
      if (changed) { ++loadSerial; ++dictionarySerial; notes = []; loaded = false; loading = false; selection = null; draft = blank(); baseline = JSON.stringify(draft); message = ""; unitIndex = 0; }
      else unitIndex = Math.max(0, units.findIndex(item => item.id === previousUnit));
      el("rsUnit").innerHTML = units.map((item, i) => `<option value="${i}">${i + 1} / ${units.length} · ${esc(item.ranges.map(range => range.quote).join(" … ").slice(0, 34))}</option>`).join("");
      if (changed || !dirty()) renderUnit(); else status();
      renderOld(); if (visible && !loaded) void load();
    },
    setVisible(next: boolean, preferredSentenceId?: string | null) {
      visible = next; if (!next) { ++dictionarySerial; ++warmSerial; return; }
      if (preferredSentenceId && !dirty()) { const found = units.findIndex(item => item.id === `translation:${preferredSentenceId}`); if (found >= 0) unitIndex = found; }
      if (!dirty()) renderUnit(); else status();
      if (!loaded) void load(); else if (selection) void lookup(selectedQuote());
    },
  };
}
