import type { MunhaeApi } from "../../shared/munhae-api";
import type { DictionaryEntry, DictionaryProvider, DictionarySearchResult, DictionaryStatus } from "../../shared/dictionary-types";
import { dictionaryCitation, dictionaryReferenceLinks } from "./dictionary-citation";
import "../styles/dictionary.css";

export type DictionaryContext = {
  query?: string;
  quote?: string;
  isCurrent?(): boolean;
  insert?(citation: string): void;
};
type Deps = {
  api: MunhaeApi;
  escape(value: unknown): string;
  notify(message: string, title?: string): void;
  register(entry: DictionaryEntry, citation: string): void;
};
const providers: { id: DictionaryProvider; label: string; help: string }[] = [
  { id: "local", label: "내장 사전", help: "한국어 풀이·훈음과 부수·획수·이체자를 찾습니다. 인터넷 없이 사용할 수 있습니다." },
  { id: "kostma", label: "고문헌 용어", help: "KOSTMA의 고문헌용어용례사전을 조회합니다. 해설 전문은 원문 사전에서 확인하세요." },
  { id: "opendict", label: "우리말샘", help: "한자어의 한국어 뜻을 찾습니다. 국립국어원 무료 인증키가 필요합니다." },
  { id: "stdict", label: "표준국어대사전", help: "표준국어대사전에 등재된 한자어를 찾습니다. 별도의 무료 인증키가 필요합니다." },
];

function characterSummary(entry: DictionaryEntry): string {
  const info = entry.characterInfo;
  if (!info) return "";
  return [info.codePoint, info.totalStrokes.length ? `총 ${info.totalStrokes.join(" / ")}획` : "", ...info.radicals.map(r => `부수 ${r.glyph} (${r.number}) · 나머지 ${r.residualStrokes}획`)].filter(Boolean).join(" · ");
}

function characterDetails(entry: DictionaryEntry, esc: (value: unknown) => string): string {
  const info = entry.characterInfo;
  if (!info) return "";
  const labels = { semantic: "의미상 이체자", specializedSemantic: "특정 용법의 의미 이체자", z: "자형 이체자", traditional: "번체 대응", simplified: "간체 대응" };
  return `<dl class="dictionary-character-info"><dt>문자 코드</dt><dd>${esc(info.codePoint)}</dd><dt>총획</dt><dd>${info.totalStrokes.length ? `${info.totalStrokes.map(esc).join(" / ")}획` : "미수록"}</dd><dt>부수·나머지 획</dt><dd>${info.radicals.length ? info.radicals.map(r => `<span class="dictionary-radical" title="Unihan 부수·획수 원자료: ${esc(r.raw)}"><span class="hanmun">${esc(r.glyph)}</span> ${r.number}번 · 나머지 ${r.residualStrokes}획${r.simplified ? ` · 간략 부수 (${esc(r.raw)})` : ""}</span>`).join("") : "미수록"}</dd></dl>${info.variants.map(group => `<div class="dictionary-variant-group"><p>${labels[group.kind]}</p><div>${group.characters.map(char => `<button class="btn btn-sm hanmun" type="button" data-dictionary-variant="${esc(char)}" aria-label="${esc(char)} 관련 자형 찾기">${esc(char)}</button>`).join("")}</div></div>`).join("")}<p class="dictionary-help">Unicode ${esc(info.unicodeVersion)}의 문자 속성입니다. 이체 관계만으로 문맥의 뜻이나 자형의 동일성을 확정하지 않습니다. 관련 글자를 누르면 별도로 조회합니다.</p>`;
}

export function configureDictionary(deps: Deps) {
  const esc = deps.escape;
  const dialog = document.createElement("dialog");
  dialog.id = "dlgDictionary";
  dialog.className = "dictionary-dialog";
  dialog.setAttribute("aria-labelledby", "dictionaryTitle");
  dialog.innerHTML = `<header class="dictionary-heading"><div><p class="dictionary-eyebrow">字 · 어휘와 뜻을 살피다</p><h2 id="dictionaryTitle">한자·어휘 사전</h2></div><button class="btn btn-ghost" id="dictionaryClose" type="button" aria-label="사전 닫기">닫기</button></header>
    <p id="dictionaryContext" class="dictionary-context" hidden></p>
    <form id="dictionaryForm" class="dictionary-search"><label class="sr-only" for="dictionaryQuery">한자·한자어·독음 검색</label><input id="dictionaryQuery" class="input" type="search" placeholder="한자, 한자어 또는 독음 · 예: 目, 太守, 태수" required maxlength="200" autocomplete="off" spellcheck="false"><button class="btn btn-primary" type="submit">찾기</button></form>
    <div id="dictionaryCharacters" class="dictionary-characters" aria-label="글자별 찾기"></div>
    <div id="dictionaryProviders" class="dictionary-providers" role="group" aria-label="사전 선택">${providers.map(p => `<button type="button" data-dictionary-provider="${p.id}" aria-pressed="${p.id === "local"}">${p.label}</button>`).join("")}</div>
    <p id="dictionaryHelp" class="dictionary-help"></p>
    <div class="dictionary-meta"><p id="dictionaryStatus" role="status" aria-live="polite"></p><button id="dictionarySettingsToggle" class="btn btn-ghost btn-sm" type="button" aria-expanded="false" aria-controls="dictionarySettings">사전 연결·출처</button></div>
    <section id="dictionarySettings" class="dictionary-settings" hidden aria-label="사전 연결과 데이터 출처">
      <p>내장 사전은 바로 사용할 수 있습니다. 국립국어원 사전은 각 사이트에서 무료 인증키를 발급받아 연결하세요.</p>
      <form id="dictionaryKeyForm" class="dictionary-key-form"><label for="dictionaryKeyProvider">연결할 사전</label><select id="dictionaryKeyProvider" class="select"><option value="opendict">우리말샘</option><option value="stdict">표준국어대사전</option></select><label for="dictionaryApiKey">인증키</label><input id="dictionaryApiKey" type="password" class="input" autocomplete="off" placeholder="발급받은 인증키" maxlength="200"><div class="dictionary-key-actions"><button type="submit" class="btn btn-primary btn-sm">키 저장</button><button id="dictionaryKeyRemove" type="button" class="btn btn-sm">저장한 키 삭제</button><button id="dictionaryKeyGuide" type="button" class="btn btn-ghost btn-sm">무료 키 발급 안내 ↗</button></div></form>
      <p id="dictionaryKeyStatus" role="status"></p><p class="dictionary-help">인증키는 이 기기에 암호화해 저장하며 프로젝트 파일에는 포함하지 않습니다.</p><div id="dictionaryDatasets"></div>
      <button class="btn btn-ghost btn-sm" id="dictionaryOldBook" type="button">공유마당 『자전석요』 원전 보기 ↗</button>
    </section>
    <p id="dictionaryError" class="dictionary-error" role="alert" hidden></p>
    <div class="dictionary-content"><div id="dictionaryResults" class="dictionary-results" aria-label="사전 검색 결과"></div><aside class="dictionary-detail" aria-label="선택한 뜻풀이"><div id="dictionarySelected"></div><div class="dictionary-actions"><button id="dictionaryInsert" type="button" class="btn btn-primary" hidden disabled>코멘트에 뜻 넣기</button><button id="dictionaryRegister" type="button" class="btn" disabled>용어 등록에 가져오기</button><button id="dictionaryCopy" type="button" class="btn btn-ghost" disabled>뜻·출처 복사</button></div><p id="dictionaryActionStatus" role="status"></p></aside></div>
    <footer class="dictionary-footer"><div class="dictionary-pages"><button id="dictionaryPrevious" type="button" class="btn btn-sm" disabled>이전</button><span id="dictionaryPage"></span><button id="dictionaryNext" type="button" class="btn btn-sm" disabled>다음</button></div><div><p>다른 사전에서 대조하기 <span class="muted">· 외부 브라우저</span></p><div id="dictionaryReferences" class="dictionary-references"></div></div></footer>`;
  document.body.append(dialog);
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const node = dialog.querySelector<T>(`#${id}`);
    if (!node) throw new Error(`missing ${id}`);
    return node;
  };
  const query = el<HTMLInputElement>("dictionaryQuery");
  let provider: DictionaryProvider = "local";
  let result: DictionarySearchResult | null = null;
  let status: DictionaryStatus | null = null;
  let context: DictionaryContext = {};
  let selected: { entry: number; sense: number } | null = null;
  let request = 0;
  let opening = 0;
  let statusRequest = 0;
  let busy = false;
  let keyBusy = false;
  let previousFocus: HTMLElement | null = null;
  let currentLinks = dictionaryReferenceLinks("");

  function message(id: string, text: string) { el(id).textContent = text; el(id).hidden = !text; }
  function fail(cause: unknown) { message("dictionaryError", cause instanceof Error ? cause.message : "사전을 조회하지 못했습니다. 다시 시도해 주세요."); }
  function chosen() { return selected && result ? result.entries[selected.entry] : undefined; }
  function isCurrent() { return !context.isCurrent || context.isCurrent(); }
  function setProvider(next: DictionaryProvider) {
    provider = next;
    for (const button of dialog.querySelectorAll<HTMLElement>("[data-dictionary-provider]")) button.setAttribute("aria-pressed", String(button.dataset.dictionaryProvider === provider));
    el("dictionaryHelp").textContent = providers.find(p => p.id === provider)!.help;
  }
  function renderQueryLinks() {
    currentLinks = dictionaryReferenceLinks(query.value);
    el("dictionaryReferences").innerHTML = currentLinks.map((link, i) => `<button type="button" data-dictionary-link="${i}">${esc(link.label)} ↗</button>`).join("");
    const chars = [...new Set(Array.from(query.value).filter(c => /\p{Script=Han}/u.test(c)))].slice(0, 32);
    el("dictionaryCharacters").innerHTML = chars.length > 1 ? `<span>글자별</span>${chars.map(c => `<button type="button" data-dictionary-character="${esc(c)}" aria-label="${esc(c)} 한 글자 찾기">${esc(c)}</button>`).join("")}` : "";
  }
  function renderSelected() {
    const entry = chosen();
    const sense = selected ? entry?.senses[selected.sense] : undefined;
    const canCite = !!entry?.canCite && !!sense?.text.trim() && !busy && isCurrent();
    for (const id of ["dictionaryCopy", "dictionaryRegister", "dictionaryInsert"]) el<HTMLButtonElement>(id).disabled = !canCite;
    el("dictionaryInsert").hidden = !context.insert;
    el("dictionarySelected").innerHTML = entry && (sense || entry.characterInfo)
      ? `<p class="dictionary-eyebrow">${entry.characterInfo ? "문자 정보" : "선택한 뜻"}</p><h3 class="hanmun">${esc(entry.headword)}</h3>${entry.reading ? `<p>${esc(entry.reading)}</p>` : ""}${sense ? `<p class="dictionary-chosen-sense">${esc(sense.text)}</p>` : characterDetails(entry, esc)}<p class="dictionary-source-label">${esc(entry.sourceLabel)}</p><p class="dictionary-license">${esc(entry.license)}</p><button class="btn btn-ghost btn-sm" id="dictionaryOpenSelected" type="button">원문·출처 보기 ↗</button>${entry.characterInfo ? "" : `<p class="dictionary-help">${entry.canCite ? "현재 문맥에 맞는 뜻을 골라 검토 의견이나 용어의 근거로 남기세요." : "이 자료의 상세 해설은 원문 사전에서 확인하세요."}</p>`}`
      : `<p class="dictionary-eyebrow">뜻을 선택하세요</p><p class="dictionary-help">자의나 어휘의 뜻을 누르면 출처와 함께 가져올 수 있습니다. 기본 훈음은 고전의 모든 의미를 포함하지 않습니다.</p>`;
  }
  function render() {
    renderQueryLinks();
    el("dictionaryResults").setAttribute("aria-busy", String(busy));
    el("dictionaryStatus").textContent = busy ? "사전을 찾고 있습니다…" : result
      ? `‘${result.query}’ · ${result.total.toLocaleString()}건${result.hasMore ? " · 다음 페이지 있음" : ""}` : "한자·어휘를 입력해 뜻을 찾아보세요.";
    const entries = result?.entries ?? [];
    el("dictionaryResults").innerHTML = busy ? `<p class="dictionary-empty">뜻과 출처를 불러오는 중입니다.</p>` : result && !entries.length
      ? `<div class="dictionary-empty"><strong>이 사전에서 일치하는 항목을 찾지 못했습니다.</strong><p>어휘를 짧게 바꾸거나 글자별로 찾아보세요. 아래 외부 사전에서도 대조할 수 있습니다.</p></div>`
      : entries.map((entry, i) => `<article class="dictionary-entry"><header><h3 class="hanmun">${esc(entry.headword)}</h3>${entry.reading ? `<span>${esc(entry.reading)}</span>` : ""}<span class="dictionary-kind">${entry.characterInfo ? "문자 속성" : entry.kind === "character" ? "낱자" : "어휘"}</span></header><p class="dictionary-source-label">${esc(entry.sourceLabel)}${entry.strokes ? ` · ${entry.strokes}획` : ""}${entry.radical ? ` · 부수 ${esc(entry.radical)}` : ""}</p>${entry.senses.length ? `<ol>${entry.senses.map((sense, s) => `<li><button type="button" data-dictionary-entry="${i}" data-dictionary-sense="${s}" aria-pressed="${selected?.entry === i && selected.sense === s}">${sense.label ? `<span class="dictionary-sense-label">${esc(sense.label)}</span>` : ""}${esc(sense.text)}</button></li>`).join("")}</ol>` : entry.characterInfo ? `<p class="dictionary-help">${esc(characterSummary(entry))}</p><p class="dictionary-help">한국어 뜻풀이는 수록하지 않은 문자 정보입니다.</p><button class="btn btn-sm" type="button" data-dictionary-entry="${i}" data-dictionary-sense="-1" aria-pressed="${selected?.entry === i}">부수·획수·이체자 보기</button>` : `<p class="dictionary-help">독음 정보만 있습니다. 상세 뜻풀이는 다른 사전에서 확인하세요.</p>`}${entry.variants?.length ? `<p class="dictionary-help">관련 자형 · ${entry.variants.map(esc).join(" · ")}</p>` : ""}<button class="dictionary-origin" type="button" data-dictionary-origin="${i}">원문·출처 ↗</button></article>`).join("");
    if (result?.notices.length) el("dictionaryResults").insertAdjacentHTML("beforeend", `<div class="dictionary-notices">${result.notices.map(n => `<p>${esc(n)}</p>`).join("")}</div>`);
    el<HTMLButtonElement>("dictionaryPrevious").disabled = busy || !result || result.page <= 1;
    el<HTMLButtonElement>("dictionaryNext").disabled = busy || !result?.hasMore;
    el("dictionaryPage").textContent = result ? `${result.page} 페이지` : "";
    renderSelected();
  }
  function renderStatus() {
    el("dictionaryKeyStatus").textContent = status ? `우리말샘: ${status.keys.opendict ? "키 저장됨" : "미연결"} · 표준국어대사전: ${status.keys.stdict ? "키 저장됨" : "미연결"}` : "사전 연결 상태를 확인하고 있습니다.";
    el("dictionaryDatasets").innerHTML = status ? status.datasets.map((d, i) => `<div class="dictionary-dataset"><strong>${esc(d.label)}</strong><span>${d.entryCount.toLocaleString()}개 항목 · ${esc(d.updatedAt)}</span><p>${esc(d.description)}</p><p>${esc(d.license)} <button type="button" data-dictionary-license="${i}">이용 조건 ↗</button><button type="button" data-dictionary-dataset="${i}">자료 출처 ↗</button></p></div>`).join("") : "";
  }
  async function refreshStatus() {
    if (keyBusy) return;
    const serial = ++statusRequest;
    const session = opening;
    try {
      const response = await deps.api.dictionary.getStatus();
      if (serial !== statusRequest || session !== opening || !dialog.open || keyBusy) return;
      if (!response.ok) throw new Error(response.error.message);
      status = response.data; renderStatus();
    } catch (cause) { if (dialog.open && serial === statusRequest && session === opening) fail(cause); }
  }
  async function search(page = 1) {
    const q = query.value.trim();
    const serial = ++request;
    result = null; selected = null; message("dictionaryError", ""); message("dictionaryActionStatus", "");
    if (!q || Array.from(q).length > 100) { busy = false; render(); message("dictionaryError", "검색어를 1~100자로 입력하세요."); return; }
    busy = true; render();
    try {
      const response = await deps.api.dictionary.search({ query: q, provider, page });
      if (serial !== request || !dialog.open) return;
      if (!response.ok) {
        if (response.error.code === "dictionary_key_required") showSettings(true);
        throw new Error(response.error.message);
      }
      result = response.data;
      if (result.entries.length === 1 && result.entries[0]?.characterInfo) selected = { entry: 0, sense: -1 };
    } catch (cause) { if (serial === request && dialog.open) fail(cause); }
    finally { if (serial === request) { busy = false; render(); } }
  }
  async function openExternal(url: string) {
    try { await deps.api.app.openExternal(url); }
    catch (cause) { if (dialog.open) fail(cause); }
  }
  function showSettings(open: boolean) {
    el("dictionarySettings").hidden = !open;
    el("dictionarySettingsToggle").setAttribute("aria-expanded", String(open));
    if (open) { if (provider === "opendict" || provider === "stdict") el<HTMLSelectElement>("dictionaryKeyProvider").value = provider; void refreshStatus(); }
  }
  async function saveKey(remove = false) {
    if (keyBusy) return;
    const input = el<HTMLInputElement>("dictionaryApiKey");
    const keyProvider = el<HTMLSelectElement>("dictionaryKeyProvider").value === "stdict" ? "stdict" : "opendict";
    if (!remove && !input.value.trim()) { message("dictionaryError", "발급받은 인증키를 입력하세요."); input.focus(); return; }
    const session = opening;
    ++statusRequest;
    keyBusy = true; message("dictionaryError", "");
    for (const control of el("dictionaryKeyForm").querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button,input,select")) control.disabled = true;
    try {
      const response = await deps.api.dictionary.setKey({ provider: keyProvider, apiKey: remove ? "" : input.value.trim() });
      input.value = "";
      if (!response.ok) throw new Error(response.error.message);
      status = response.data; renderStatus();
      if (dialog.open && session === opening) {
        message("dictionaryActionStatus", remove ? "저장한 인증키를 삭제했습니다." : "인증키를 저장했습니다. 검색해서 연결을 확인하세요.");
        if (!remove && provider === keyProvider && query.value.trim()) void search();
      }
    } catch (cause) { input.value = ""; if (dialog.open && session === opening) fail(cause); }
    finally { keyBusy = false; for (const control of el("dictionaryKeyForm").querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button,input,select")) control.disabled = false; if (dialog.open && session !== opening) void refreshStatus(); }
  }
  function withCitation(action: (entry: DictionaryEntry, citation: string) => void) {
    const entry = chosen();
    if (!entry || !selected || busy) return;
    if (!isCurrent()) { message("dictionaryError", "문서나 선택 구절이 바뀌었습니다. 현재 구절에서 다시 사전을 여세요."); renderSelected(); return; }
    try { action(entry, dictionaryCitation(entry, selected.sense)); }
    catch (cause) { fail(cause); }
  }
  el("dictionaryForm").addEventListener("submit", event => { event.preventDefault(); void search(); });
  query.addEventListener("input", () => { ++request; busy = false; result = null; selected = null; message("dictionaryError", ""); render(); });
  el("dictionaryProviders").addEventListener("click", event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-dictionary-provider]");
    const next = providers.find(p => p.id === button?.dataset.dictionaryProvider);
    if (!next) return; setProvider(next.id); if (query.value.trim()) void search(); else { ++request; busy = false; result = null; selected = null; render(); }
  });
  el("dictionaryCharacters").addEventListener("click", event => {
    const char = (event.target as HTMLElement).closest<HTMLElement>("[data-dictionary-character]")?.dataset.dictionaryCharacter;
    if (char) { query.value = char; setProvider("local"); void search(); }
  });
  el("dictionaryResults").addEventListener("click", event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-dictionary-entry],[data-dictionary-origin]");
    if (!target || busy || !result) return;
    if (target.dataset.dictionaryOrigin !== undefined) { const entry = result.entries[Number(target.dataset.dictionaryOrigin)]; if (entry) void openExternal(entry.sourceUrl); return; }
    selected = { entry: Number(target.dataset.dictionaryEntry), sense: Number(target.dataset.dictionarySense) }; message("dictionaryActionStatus", "");
    for (const button of el("dictionaryResults").querySelectorAll<HTMLElement>("[data-dictionary-entry]")) button.setAttribute("aria-pressed", String(Number(button.dataset.dictionaryEntry) === selected.entry && Number(button.dataset.dictionarySense) === selected.sense));
    renderSelected();
  });
  el("dictionarySelected").addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const variant = target.closest<HTMLElement>("[data-dictionary-variant]")?.dataset.dictionaryVariant;
    if (variant) { query.value = variant; setProvider("local"); void search(); return; }
    if (target.closest("#dictionaryOpenSelected")) { const entry = chosen(); if (entry) void openExternal(entry.sourceUrl); }
  });
  el("dictionaryCopy").addEventListener("click", () => withCitation((_entry, citation) => {
    const serial = request;
    void navigator.clipboard.writeText(citation).then(() => { if (dialog.open && serial === request) message("dictionaryActionStatus", "선택한 뜻과 출처를 복사했습니다."); }).catch(() => { if (dialog.open && serial === request) message("dictionaryError", "복사하지 못했습니다. 다시 시도해 주세요."); });
  }));
  el("dictionaryRegister").addEventListener("click", () => withCitation((entry, citation) => { dialog.close(); deps.register(entry, citation); }));
  el("dictionaryInsert").addEventListener("click", () => withCitation((_entry, citation) => { const insert = context.insert; if (!insert) return; insert(citation); dialog.close(); }));
  el("dictionaryPrevious").addEventListener("click", () => { if (result && !busy) void search(Math.max(1, result.page - 1)); });
  el("dictionaryNext").addEventListener("click", () => { if (result?.hasMore && !busy) void search(result.page + 1); });
  el("dictionaryReferences").addEventListener("click", event => { const i = (event.target as HTMLElement).closest<HTMLElement>("[data-dictionary-link]")?.dataset.dictionaryLink; if (i !== undefined && currentLinks[Number(i)]) void openExternal(currentLinks[Number(i)]!.url); });
  el("dictionarySettingsToggle").addEventListener("click", () => showSettings(el("dictionarySettings").hidden));
  el("dictionaryKeyForm").addEventListener("submit", event => { event.preventDefault(); void saveKey(); });
  el("dictionaryKeyRemove").addEventListener("click", () => { void saveKey(true); });
  el("dictionaryKeyGuide").addEventListener("click", () => { void openExternal(el<HTMLSelectElement>("dictionaryKeyProvider").value === "stdict" ? "https://stdict.korean.go.kr/openapi/openApiInfo.do" : "https://opendict.korean.go.kr/service/openApiInfo"); });
  el("dictionaryDatasets").addEventListener("click", event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-dictionary-license],[data-dictionary-dataset]");
    if (!target || !status) return;
    const index = target.dataset.dictionaryLicense ?? target.dataset.dictionaryDataset;
    const dataset = status.datasets[Number(index)]; if (dataset) void openExternal(target.dataset.dictionaryLicense !== undefined ? dataset.licenseUrl : dataset.sourceUrl);
  });
  el("dictionaryOldBook").addEventListener("click", () => { void openExternal("https://gongu.copyright.or.kr/gongu/wrt/wrt/view.do?menuNo=200019&wrtSn=9082919"); });
  el("dictionaryClose").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { if (dialog.open) return; ++request; ++opening; ++statusRequest; busy = false; context = {}; el<HTMLInputElement>("dictionaryApiKey").value = ""; if (!document.querySelector("dialog[open]") && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); });
  return {
    open(next: DictionaryContext = {}) {
      ++request; ++opening; ++statusRequest; busy = false; context = next; selected = null; result = null;
      query.value = Array.from((next.query ?? "").trim()).slice(0, 100).join("");
      message("dictionaryContext", next.quote ? `검토 구절 · ${next.quote}` : "");
      message("dictionaryError", ""); message("dictionaryActionStatus", "");
      setProvider("local"); render(); renderStatus();
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!dialog.open) dialog.showModal();
      query.focus(); query.select(); void refreshStatus();
      if (query.value) void search();
    },
    closeAttached() { if (dialog.open && context.insert) dialog.close(); },
  };
}
