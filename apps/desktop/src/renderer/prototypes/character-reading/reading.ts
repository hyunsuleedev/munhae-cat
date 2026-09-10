import { lookupCharacter, type DictionaryEntry } from "./dictionary";
import { dictionaryCitation } from "../../scripts/dictionary-citation";

const source = "譬如綱擧則目張，根培則支達。";
const key = "munhae.prototype.character-reading.v1";
const sample = [
  ["비", "비유하다", 1], ["여", "~와 같다", 12], ["강", "벼리, 강령", 2],
  ["거", "들리다", 3], ["즉", "~이면", 4], ["목", "그물눈", 5], ["장", "펴지다", 6],
  ["근", "뿌리, 근원", 7], ["배", "북돋아지다", 8], ["즉", "~이면", 9],
  ["지", "나뭇가지", 10], ["달", "발달하다", 11],
] as const;
type Note = { text: string; from: number; to: number; reading: string; gloss: string; order: number; citation: string | null };
const defaults: Note[] = [];
Array.from(source).forEach((text, from) => {
  if (!/\p{Script=Han}/u.test(text)) return;
  const fixture = sample[defaults.length]!;
  defaults.push({ text, from, to: from + 1, reading: fixture[0], gloss: fixture[1], order: fixture[2], citation: null });
});
let notes = structuredClone(defaults);
try {
  const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
  if (Array.isArray(stored) && stored.length === notes.length && stored.every((note, i) =>
    note && note.text === defaults[i]!.text && note.from === defaults[i]!.from && note.to === defaults[i]!.to
    && typeof note.gloss === "string" && note.gloss.length <= 500
    && (note.citation === null || (typeof note.citation === "string" && note.citation.length <= 50_000)))) {
    notes = notes.map((note, i) => ({ ...note, gloss: stored[i].gloss, citation: stored[i].citation }));
  }
} catch { /* The sample remains usable when browser storage is unavailable. */ }
function el<T extends HTMLElement = HTMLElement>(id: string): T { const node = document.getElementById(id); if (!node) throw new Error(id); return node as T; }
const esc = (value: string): string => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
let selected = 2;
let readingOrder = false;
let activeGroup = "";
let request = 0;
let currentEntries: DictionaryEntry[] = [];
let dictionaryQuery = notes[selected]!.text;
const drafts = new Map<number, string>();
let storageFailed = false;
let toastTimer: ReturnType<typeof setTimeout>;
function toast(text: string) { clearTimeout(toastTimer); el("toast").textContent = text; el("toast").hidden = false; toastTimer = setTimeout(() => { el("toast").hidden = true; }, 3200); }
function persist() {
  try { localStorage.setItem(key, JSON.stringify(notes)); storageFailed = false; el("savedState").textContent = "이 브라우저에 저장됨"; }
  catch { storageFailed = true; el("savedState").textContent = "이 탭에만 반영됨"; toast("브라우저 저장소를 사용할 수 없습니다. 주석을 내려받아 보관하세요."); }
}
function indices(): number[] { return notes.map((_, i) => i).sort((a, b) => readingOrder ? notes[a]!.order - notes[b]!.order : a - b); }
function groupContains(i: number) { return activeGroup === "comparison" ? i < 2 : activeGroup === "condition" && (i === 4 || i === 9); }
function renderTokens() {
  el("sourceLine").innerHTML = Array.from(source).map((char, offset) => {
    const i = notes.findIndex(note => note.from === offset);
    return i < 0 ? esc(char) : `<button type="button" data-source="${i}" aria-label="${esc(char)} · 원문 ${i + 1}번째 글자" aria-pressed="${i === selected}" class="${groupContains(i) ? "group-active" : ""}">${esc(char)}</button>`;
  }).join("");
  el("tokenGrid").innerHTML = indices().map(i => {
    const note = notes[i]!;
    return `<button class="token ${groupContains(i) ? "group-active" : ""}" type="button" data-token="${i}" aria-label="${esc(note.text)} ${esc(note.reading)} · ${esc(note.gloss)} · 원문 ${i + 1}번째" aria-pressed="${selected === i}" tabindex="${i === selected ? 0 : -1}" title="${esc(note.gloss)}"><span class="order">${String(note.order).padStart(2, "0")}</span><span class="glyph">${esc(note.text)}</span><span class="reading">${esc(note.reading)}</span><span class="gloss">${esc(note.gloss)}</span></button>`;
  }).join("");
}
function renderAnnotation() {
  const note = notes[selected]!;
  el("annotationCharacter").textContent = note.text;
  el("annotationPosition").textContent = `원문 ${selected + 1}번째 글자`;
  el<HTMLTextAreaElement>("contextGloss").value = drafts.get(selected) ?? note.gloss;
  el("annotationOrigin").textContent = note.citation ? "선택한 사전 뜻을 근거로 작성" : note.gloss === defaults[selected]!.gloss ? "첨부 화면의 예시 풀이" : "직접 작성한 문맥 풀이";
  el("annotationOrigin").title = note.citation ?? "";
  el("savedState").textContent = drafts.has(selected) ? "아직 반영하지 않은 풀이" : storageFailed ? "이 탭에만 반영됨" : "이 브라우저에만 저장";
}
function setTab(character: boolean) {
  for (const [id, chosen] of [["characterTab", character], ["sensesTab", !character]] as const) {
    el(id).setAttribute("aria-selected", String(chosen)); el(id).tabIndex = chosen ? 0 : -1;
  }
  el("sensesPanel").hidden = character; el("characterPanel").hidden = !character;
}
function renderDictionary() {
  const propertyEntry = currentEntries.find(entry => entry.characterInfo);
  const info = propertyEntry?.characterInfo;
  const readings = [...new Set(currentEntries.flatMap(entry => entry.reading ? entry.reading.split(/[,，]\s*/) : []))];
  el("characterReading").textContent = readings.length ? readings.join(" · ") : "독음 미수록";
  el("characterMeta").textContent = info ? `${info.radicals.map(r => r.glyph).join(" · ")} 부수 · 총 ${info.totalStrokes.join(" / ")}획` : "문자 속성 미수록";
  el("characterCode").textContent = info?.codePoint ?? `U+${dictionaryQuery.codePointAt(0)!.toString(16).toUpperCase()}`;
  const count = currentEntries.reduce((total, entry) => total + entry.senses.filter(sense => sense.text.trim()).length, 0);
  el("senseCount").textContent = count ? String(count) : "";
  el("senseEntries").innerHTML = currentEntries.filter(entry => !entry.characterInfo).map(entry => {
    const entryIndex = currentEntries.indexOf(entry);
    return `<section class="source-block"><div class="source-block-head"><h3>${esc(entry.sourceLabel)}</h3><a href="${esc(entry.sourceUrl)}" target="_blank" rel="noreferrer" aria-label="${esc(entry.sourceLabel)} 원문 열기">↗</a></div>${entry.senses.map((sense, senseIndex) => {
      const applicable = entry.canCite && !!sense.text.trim() && dictionaryQuery === notes[selected]!.text;
      return `<button class="sense" type="button" data-entry="${entryIndex}" data-sense="${senseIndex}" ${applicable ? "" : "disabled"}><span class="sense-label">${esc(sense.label ?? `뜻 ${senseIndex + 1}`)}</span><span class="sense-text">${esc(sense.text || "이 독음의 뜻풀이는 수록되지 않았습니다.")}</span>${applicable ? '<span class="sense-action">이 문장의 풀이에 적용 ↙</span>' : ""}</button>`;
    }).join("")}<p class="source-credit">${esc(entry.license)} · <span title="${esc(entry.attribution)}">출처·가공 정보</span></p></section>`;
  }).join("") || '<p class="small-note">한국어 뜻풀이가 수록되어 있지 않습니다. 문자 정보와 다른 사전을 확인하세요.</p>';
  const kinds = { semantic: "의미상 이체자", specializedSemantic: "특정 용법의 의미 이체자", z: "자형 이체자", traditional: "번체 대응", simplified: "간체 대응" };
  el("characterDetails").innerHTML = info ? `<dl class="character-properties"><dt>문자 코드</dt><dd>${esc(info.codePoint)}</dd><dt>한국어 독음</dt><dd>${esc(propertyEntry?.reading ?? "미수록")}</dd><dt>총획</dt><dd>${info.totalStrokes.join(" / ")}획</dd><dt>부수</dt><dd>${info.radicals.map(radical => `${esc(radical.glyph)} · ${radical.number}번 / 나머지 ${radical.residualStrokes}획`).join("<br>")}</dd></dl>${info.variants.map(group => `<section class="variants"><h3>${kinds[group.kind]}</h3><div>${group.characters.map(char => `<button type="button" data-variant="${esc(char)}" aria-label="${esc(char)} 별도 조회">${esc(char)}</button>`).join("")}</div></section>`).join("")}<p class="source-credit">Unicode Unihan ${esc(info.unicodeVersion)} · ${esc(propertyEntry?.license ?? "")}<br>문자 속성 자료입니다. 관련 자형을 눌러도 원문은 바뀌지 않습니다.</p>` : '<p class="small-note">이 글자의 문자 속성이 수록되어 있지 않습니다.</p>';
}
async function loadDictionary(query: string) {
  const ticket = ++request;
  dictionaryQuery = query; currentEntries = [];
  el("heroCharacter").textContent = query;
  el("characterReading").textContent = "조회 중…";
  el("characterMeta").textContent = ""; el("characterCode").textContent = "";
  el("senseEntries").replaceChildren(); el("characterDetails").replaceChildren(); el("senseCount").textContent = "";
  el("lookupState").textContent = "내장 사전을 조회하고 있습니다.";
  el<HTMLAnchorElement>("externalLookup").href = `https://hanja.dict.naver.com/#/search?query=${encodeURIComponent(query)}`;
  try {
    const result = await lookupCharacter(query);
    if (ticket !== request) return;
    currentEntries = result.entries;
    renderDictionary();
    el("lookupState").textContent = query === notes[selected]!.text ? "" : `${notes[selected]!.text}의 관련 자형을 살펴보고 있습니다. 원문은 그대로 유지됩니다.`;
  } catch (error) {
    if (ticket !== request) return;
    el("characterReading").textContent = "연결 확인 필요";
    el("lookupState").textContent = error instanceof Error ? error.message : "사전을 불러오지 못했습니다.";
    const retry = document.createElement("button"); retry.className = "button"; retry.textContent = "다시 조회";
    retry.addEventListener("click", () => { void loadDictionary(query); });
    el("lookupState").append(document.createElement("br"), retry);
  }
}
function select(index: number, focus = false) {
  if (!notes[index]) return;
  selected = index; renderTokens(); renderAnnotation(); void loadDictionary(notes[index]!.text);
  if (focus) document.querySelector<HTMLButtonElement>(`[data-token="${selected}"]`)?.focus({ preventScroll: true });
}
el("sourceLine").addEventListener("click", event => { const target = (event.target as HTMLElement).closest<HTMLElement>("[data-source]"); if (target) select(Number(target.dataset.source)); });
el("tokenGrid").addEventListener("click", event => { const target = (event.target as HTMLElement).closest<HTMLElement>("[data-token]"); if (target) select(Number(target.dataset.token), true); });
el("tokenGrid").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault(); const order = indices(); const at = order.indexOf(selected);
  const next = event.key === "Home" ? 0 : event.key === "End" ? order.length - 1 : Math.min(order.length - 1, Math.max(0, at + (event.key === "ArrowLeft" ? -1 : 1)));
  select(order[next]!, true);
});
for (const id of ["sourceOrder", "readingOrder"]) el(id).addEventListener("click", () => {
  readingOrder = id === "readingOrder"; el("sourceOrder").setAttribute("aria-pressed", String(!readingOrder)); el("readingOrder").setAttribute("aria-pressed", String(readingOrder)); renderTokens();
});
document.querySelectorAll<HTMLButtonElement>("[data-group]").forEach(button => button.addEventListener("click", () => {
  activeGroup = activeGroup === button.dataset.group ? "" : button.dataset.group!;
  document.querySelectorAll<HTMLElement>("[data-group]").forEach(node => node.setAttribute("aria-pressed", String(activeGroup === node.dataset.group)));
  renderTokens(); el("constructionStatus").textContent = activeGroup === "comparison" ? "譬如는 뒤의 내용을 비유로 이끄는 표현입니다. 如는 풀이 순서에서 끝에 놓았습니다." : activeGroup === "condition" ? "두 則은 각각 앞 구절을 조건으로 이어 줍니다. 같은 글자도 문장 속 위치별로 풀이를 관리합니다." : "문형을 누르면 원문의 해당 글자를 함께 표시합니다.";
}));
el("contextGloss").addEventListener("input", () => { drafts.set(selected, el<HTMLTextAreaElement>("contextGloss").value); el("savedState").textContent = "아직 반영하지 않은 풀이"; });
el("applyGloss").addEventListener("click", () => {
  const value = el<HTMLTextAreaElement>("contextGloss").value.trim();
  if (!value) { toast("문맥 풀이를 입력해 주세요."); return; }
  notes[selected]!.gloss = value; drafts.delete(selected); renderTokens(); renderAnnotation(); persist();
});
el("senseEntries").addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sense]");
  if (!button || button.disabled || dictionaryQuery !== notes[selected]!.text) return;
  const entry = currentEntries[Number(button.dataset.entry)]; const index = Number(button.dataset.sense);
  const sense = entry?.senses[index]; if (!entry || !sense?.text.trim() || !entry.canCite) return;
  if (sense.text.length > 500) { toast("이 뜻풀이는 깁니다. 필요한 내용을 문맥 풀이에 직접 요약해 주세요."); return; }
  notes[selected]!.gloss = sense.text; notes[selected]!.citation = dictionaryCitation(entry, index);
  drafts.delete(selected); renderTokens(); renderAnnotation(); persist(); toast(`‘${notes[selected]!.text}’의 풀이와 사전 출처를 시안에 반영했습니다.`);
});
el("characterDetails").addEventListener("click", event => { const button = (event.target as HTMLElement).closest<HTMLElement>("[data-variant]"); if (button?.dataset.variant) void loadDictionary(button.dataset.variant); });
el("sensesTab").addEventListener("click", () => setTab(false)); el("characterTab").addEventListener("click", () => setTab(true));
document.querySelector(".dictionary-tabs")!.addEventListener("keydown", event => {
  const keyEvent = event as KeyboardEvent;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(keyEvent.key)) return;
  keyEvent.preventDefault(); const character = keyEvent.key === "End" || (keyEvent.key !== "Home" && el("sensesTab").getAttribute("aria-selected") === "true");
  setTab(character); el(character ? "characterTab" : "sensesTab").focus();
});
el("resetNotes").addEventListener("click", () => {
  notes = structuredClone(defaults); drafts.clear(); activeGroup = "";
  document.querySelectorAll<HTMLElement>("[data-group]").forEach(node => node.setAttribute("aria-pressed", "false"));
  el("constructionStatus").textContent = "문형을 누르면 원문의 해당 글자를 함께 표시합니다.";
  renderTokens(); renderAnnotation(); persist(); toast("예시 풀이로 되돌렸습니다.");
});
el("exportNotes").addEventListener("click", () => {
  const payload = { format: "munhae.character-reading-prototype.v1", sourceText: source, positionUnit: "unicode-codepoint", rangeEnd: "exclusive", sampleAttribution: "사용자가 제공한 참고 화면의 원문과 풀이", annotations: notes, unappliedDrafts: [...drafts].map(([index, gloss]) => ({ from: notes[index]!.from, to: notes[index]!.to, gloss })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "munhae-character-reading.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("문장 위치와 사전 출처를 포함한 주석을 내려받았습니다.");
});
window.addEventListener("beforeunload", event => { if (drafts.size || storageFailed) { event.preventDefault(); event.returnValue = ""; } });
renderTokens(); renderAnnotation(); void loadDictionary(notes[selected]!.text);
