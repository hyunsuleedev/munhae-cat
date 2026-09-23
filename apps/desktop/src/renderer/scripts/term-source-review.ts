import { termSource } from "@munhae/domain/term-source";
import type { EditorView, MunhaeApi, TermEntry } from "../../shared/munhae-api";
import { esc, ICONS, notify } from "./shared";
import { termHits, termSegments, type TermHit } from "./term-highlights";
import { currentTermQuotes, nextReviewTerm, sourceOrderedTerms, termIsStale, termReviewProgress, termSaveValue } from "./term-review-model";
import { configureTermSourceResize } from "./term-source-resize";
import "../styles/term-source-review.css";

const kinds: Record<TermEntry["kind"], string> = { person: "인물", place: "장소", office: "관직", institution: "제도", work: "작품", object: "사물", concept: "개념", allusion: "전고", expression: "표현" };
const chevron = `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${ICONS.chev}</svg>`;
const editIcon = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="m10.5 2.5 3 3M3 10l7.5-7.5a2.12 2.12 0 0 1 3 3L6 13l-4 1z"/></svg>';
type Draft = { entry: TermEntry; definition: string; contextNote: string };

export function configureTermSourceReview(options: { api: MunhaeApi; host: HTMLElement; refresh(): Promise<void>; changed?(): void; edit(entry: TermEntry): void; reveal(): void }) {
  const resize = configureTermSourceResize(options.host);
  let root: HTMLElement | null = null, view: EditorView | null = null;
  let entries: TermEntry[] = [], shown: TermEntry[] = [], hits: TermHit[] = [];
  let selectedId: string | null = null, occurrence = 0, draft: Draft | null = null, saving = false;
  let showMarks = true, mobileTerms = false, error = "", chooser: string[] = [];
  let scope = "", comparing = false, quoteChoices: string[] = [], checkedQuotes = new Set<string>();
  let fontSize = "21", lineHeight = "2.1";
  const popoverId = `${options.host.id || "terms"}-reading-settings`;
  const menuId = `${options.host.id || "terms"}-entry-actions`;
  const active = () => entries.find(entry => entry.id === selectedId);
  const changed = () => !!draft && (draft.definition !== (draft.entry.definition ?? "") || draft.contextNote !== (draft.entry.contextNote ?? ""));
  const canLeave = () => !saving && (!changed() || window.confirm("저장하지 않은 용어 수정을 버리고 이동할까요?"));
  const stale = (entry: TermEntry) => !!view && termIsStale(entry, view);
  const currentHit = () => hits.find(hit => hit.id === selectedId && hit.index === occurrence);
  function beforeChange() {
    if (!canLeave()) return false;
    draft = null; comparing = false; error = "";
    return true;
  }
  function locate() {
    const host = root?.querySelector<HTMLElement>("[data-linked-source]");
    const hit = host?.querySelector<HTMLElement>(".term-linked-hit.is-current");
    if (host && hit) host.scrollTop += hit.getBoundingClientRect().top - host.getBoundingClientRect().top - host.clientHeight / 3;
  }
  function revealCard(focus = false) {
    const host = root?.querySelector<HTMLElement>("[data-linked-list]");
    const card = host?.querySelector<HTMLElement>(".is-selected");
    if (!host || !card) return;
    const top = card.getBoundingClientRect().top - host.getBoundingClientRect().top;
    if (top < 0 || top > host.clientHeight * .4) host.scrollTop += top;
    if (focus) card.querySelector<HTMLElement>(".term-linked-summary")?.focus({ preventScroll: true });
  }
  function setMobile(terms: boolean) {
    mobileTerms = terms; root?.classList.toggle("show-terms", terms);
    root?.querySelectorAll<HTMLElement>("[data-linked-mobile]").forEach(button => button.setAttribute("aria-pressed", String((button.dataset.linkedMobile === "terms") === terms)));
  }
  function renderSource() {
    if (!view || !root) return;
    const source = termSource(view), current = currentHit(); let offset = 0, paragraph = 0;
    const host = root.querySelector<HTMLElement>("[data-linked-source]")!, scroll = host.scrollTop;
    host.innerHTML = source.text.split("\n").map(line => {
      const start = offset, end = offset + line.length; offset = end + 1;
      if (!line.trim()) return '<p class="term-linked-line is-blank" aria-hidden="true"></p>';
      const html = termSegments(source.text, hits, start, end).map(segment => {
        if (!segment.hits.length) return esc(segment.text);
        const ids = [...new Set(segment.hits.map(hit => hit.id))];
        const related = segment.hits.some(hit => hit.id === selectedId);
        const focus = !!(related && current && segment.start >= current.start && segment.end <= current.end);
        return `<button type="button" class="term-linked-hit${related ? " is-related" : ""}${focus ? " is-current" : ""}" data-linked-hit="${segment.start}" aria-pressed="${focus}" aria-label="${esc(ids.map(id => entries.find(entry => entry.id === id)?.sourceForm).join(" / "))} 용어 보기">${esc(segment.text)}</button>`;
      }).join("");
      return `<p class="term-linked-line"><span aria-hidden="true">${String(++paragraph).padStart(2, "0")}</span><span>${html}</span></p>`;
    }).join("");
    host.scrollTop = scroll;
    const count = hits.filter(hit => hit.id === selectedId).length;
    root.querySelector("[data-linked-position]")!.textContent = selectedId ? count ? `${active()?.sourceForm ?? ""} · ${occurrence + 1} / ${count}` : "현재 본문에 대응 위치 없음" : "용어를 선택하세요";
    root.querySelector<HTMLButtonElement>("[data-linked-prev]")!.disabled = !count || occurrence <= 0;
    root.querySelector<HTMLButtonElement>("[data-linked-next]")!.disabled = !count || occurrence >= count - 1;
  }
  function comparison(entry: TermEntry) {
    return `<div class="term-linked-stale"><strong>원문이 바뀌어 다시 확인해야 합니다</strong>${comparing ? `
      <div class="term-linked-old-quotes"><small>이전 저장 구절</small>${[...new Set(entry.occurrences.map(item => item.quote))].map(quote => `<p>${esc(quote)}</p>`).join("") || "<p>저장된 구절이 없습니다.</p>"}</div>
      <fieldset class="term-linked-current-quotes"><legend>연결할 현재 구절</legend>${quoteChoices.map((quote, index) => `<label><input type="checkbox" data-linked-quote="${index}" ${checkedQuotes.has(quote) ? "checked" : ""} ${saving ? "disabled" : ""}><span>${esc(quote)}</span></label>`).join("") || '<p>현재 본문에서 같은 표현을 찾지 못했습니다. 상세 편집에서 표현과 등장 구절을 확인하세요.</p>'}</fieldset>
      <div class="term-linked-compare-actions"><button class="btn btn-sm" type="button" data-linked-relink ${saving || !checkedQuotes.size ? "disabled" : ""}>선택한 구절로 다시 연결</button><button class="btn btn-ghost btn-sm" type="button" data-linked-cancel-compare ${saving ? "disabled" : ""}>닫기</button></div>
      <small>다시 연결한 풀이는 검토 전 상태로 저장됩니다.</small>` : '<p>저장된 등장 구절을 현재 원문과 대조하세요.</p><button class="btn btn-sm" type="button" data-linked-compare>현재 원문과 대조</button>'}</div>`;
  }
  function detail(entry: TermEntry): string {
    const current = draft?.entry.id === entry.id ? draft : null;
    const local = entry.documentId === view!.document.id, outdated = stale(entry);
    if (current) return `<div class="term-linked-detail term-linked-editing"><div class="term-linked-meta"><span data-linked-save-state>${saving ? "저장 중…" : changed() ? "저장하지 않은 변경" : "풀이 수정 중"}</span><span>⌘S 저장</span></div>
      <label class="term-edit-field">뜻풀이<textarea data-linked-field="definition" rows="3" maxlength="5000" ${saving ? "disabled" : ""}>${esc(current.definition)}</textarea></label><label class="term-edit-field">이 글에서의 풀이 <small>선택</small><textarea data-linked-field="contextNote" rows="2" maxlength="5000" ${saving ? "disabled" : ""}>${esc(current.contextNote)}</textarea></label>
      <p class="term-linked-error" role="alert">${esc(error)}</p><div class="term-linked-actions"><button type="button" class="btn btn-ghost btn-sm" data-linked-cancel-edit ${saving ? "disabled" : ""}>취소</button><button type="button" class="btn btn-primary btn-sm" data-linked-save ${saving || !changed() ? "disabled" : ""}>저장</button></div></div>`;
    const quotes = [...new Set(entry.occurrences.map(item => item.quote))];
    return `<div class="term-linked-detail"><div class="term-linked-meta"><span>${local ? "이 문서의 풀이" : "프로젝트 공통 풀이"}</span><button type="button" class="btn btn-ghost btn-sm" data-linked-locate>원문 위치 ${chevron}</button></div>
      ${outdated && local && entry.status !== "excluded" ? comparison(entry) : ""}
      <p class="term-linked-definition">${esc(entry.definition || entry.translation || "뜻풀이가 없습니다.")}</p>
      ${entry.contextNote ? `<div class="term-linked-context"><small>이 글에서</small><p>${esc(entry.contextNote)}</p></div>` : ""}
      ${entry.uncertainty ? `<p class="term-linked-warning">확인할 점 · ${esc(entry.uncertainty)}</p>` : ""}
      <details class="term-linked-evidence"><summary>${chevron}원문·근거<small>${quotes.length ? `연결 구절 ${quotes.length}개` : ""}${entry.evidence.length ? ` · 근거 ${entry.evidence.length}개` : ""}</small></summary>
      ${quotes.map(quote => `<blockquote>${esc(quote)}</blockquote>`).join("")}${entry.evidence.map(item => `<p>${esc(item.citation)}${item.url ? `<br>${esc(item.url)}` : ""}</p>`).join("") || "<p>등록된 외부 근거가 없습니다.</p>"}${entry.selectionReason ? `<p>선정 이유 · ${esc(entry.selectionReason)}</p>` : ""}</details>
      <p class="term-linked-error" role="alert">${esc(error)}</p><div class="term-linked-actions">
      <button type="button" class="btn btn-ghost btn-sm" ${local && !outdated ? "data-linked-begin-edit" : "data-linked-edit"} ${saving ? "disabled" : ""}>${editIcon}${outdated ? "상세 편집" : "수정"}</button>
      ${local ? `<button type="button" class="btn btn-ghost btn-sm term-linked-more" popovertarget="${menuId}" aria-label="용어 추가 작업" ${saving ? "disabled" : ""}>⋯</button><div class="editor-tool-popover term-linked-menu" id="${menuId}" popover><button class="btn btn-ghost" data-linked-edit type="button">상세 편집</button>${!outdated ? `<button class="btn btn-ghost" type="button" data-linked-status="${entry.status === "excluded" ? "draft" : "excluded"}">${entry.status === "excluded" ? "참고에 포함" : "참고 제외"}</button>${entry.status === "reviewed" ? '<button class="btn btn-ghost" type="button" data-linked-status="draft">검토 전으로</button>' : ""}` : ""}<button class="btn btn-ghost" type="button" data-linked-delete>용어 삭제</button></div>
      ${entry.status === "excluded" ? '<span class="term-linked-action-state">참고에서 제외됨</span>' : entry.status === "reviewed" && !outdated ? '<span class="term-linked-action-state is-reviewed">검토 완료</span><button class="btn btn-sm" type="button" data-linked-next-term>다음 용어</button>' : `<button type="button" class="btn btn-primary btn-sm" data-linked-review ${saving || outdated ? 'disabled' : ""} ${outdated ? 'title="현재 구절을 먼저 대조하세요"' : ""}>검토 완료·다음 ${chevron}</button>`}` : ""}</div></div>`;
  }
  function renderList() {
    if (!root || !view) return;
    const list = root.querySelector<HTMLElement>("[data-linked-list]")!, scroll = list.scrollTop;
    list.innerHTML = sourceOrderedTerms(shown, hits).map(entry => {
      const selected = entry.id === selectedId, outdated = stale(entry);
      const state = entry.status === "excluded" ? "참고 제외" : outdated ? "재검토" : entry.status === "reviewed" ? "검토 완료" : "검토 전";
      return `<article class="term-linked-card${selected ? " is-selected" : ""}" data-linked-card="${esc(entry.id)}"><button class="term-linked-summary" type="button" data-linked-id="${esc(entry.id)}" aria-expanded="${selected}" ${saving ? "disabled" : ""}><span><strong>${esc(entry.sourceForm)}</strong><small>${esc(entry.reading || "")}</small><span class="term-linked-kind">${kinds[entry.kind]}${!entry.documentId ? " · 공통" : ""}</span><span class="term-linked-state${outdated ? " is-stale" : entry.status === "reviewed" ? " is-reviewed" : ""}">${state}</span></span>${selected ? "" : `<span class="term-linked-meaning">${esc(entry.definition || entry.translation || entry.contextNote || "뜻풀이를 추가하세요")}</span>`}</button>${selected ? detail(entry) : ""}</article>`;
    }).join("") || `<div class="term-review-empty"><p>${entries.length ? "조건에 맞는 용어가 없습니다." : "아직 용어가 없습니다."}</p>${entries.length ? '<button class="btn btn-sm" data-linked-clear type="button">전체 용어 보기</button>' : '<button class="btn btn-sm" data-term-add type="button">직접 추가</button>'}</div>`;
    list.scrollTop = scroll;
    const chooserHost = root.querySelector<HTMLElement>("[data-linked-chooser]")!;
    chooserHost.innerHTML = chooser.length ? `<span>겹치는 용어 선택</span>${chooser.map(id => `<button class="btn btn-sm" type="button" data-linked-choice="${esc(id)}">${esc(entries.find(entry => entry.id === id)?.sourceForm)}</button>`).join("")}` : "";
    chooserHost.hidden = !chooser.length;
    const progress = termReviewProgress(entries, view);
    root.querySelector("[data-linked-count]")!.textContent = `${shown.length}개`;
    root.querySelector("[data-linked-reviewed]")!.textContent = `${progress.reviewed}개 검토 완료`;
    root.querySelector("[data-linked-remaining]")!.textContent = `${progress.remaining}개 남음`;
    root.querySelector<HTMLElement>("[data-linked-progress]")!.style.width = `${progress.total ? progress.reviewed / progress.total * 100 : 0}%`;
    options.host.querySelectorAll("[data-term-progress]").forEach(node => { node.textContent = `${progress.reviewed} / ${progress.total} 검토`; });
  }
  function select(id: string, start?: number, fromSource = false) {
    if (saving || (id !== selectedId && !beforeChange())) return;
    selectedId = id; error = ""; chooser = [];
    occurrence = start === undefined ? 0 : hits.find(hit => hit.id === id && hit.start <= start && hit.end > start)?.index ?? 0;
    if (root && getComputedStyle(root.querySelector(".term-linked-mobile")!).display !== "none") setMobile(true);
    if (fromSource && !shown.some(entry => entry.id === id)) options.reveal();
    else { renderSource(); renderList(); }
    if (!fromSource) locate();
    revealCard();
  }
  async function save(changes: Parameters<typeof termSaveValue>[2] = {}, advance = false) {
    const entry = active(); if (!entry || !view || saving) return;
    const capturedView = view, captured = draft?.entry ?? entry;
    const next = advance ? nextReviewTerm(shown, hits, entry.id, capturedView) : null;
    let saved = false;
    try {
      const value = termSaveValue(captured, capturedView, { ...changes, ...(draft ? { draft } : {}) });
      saving = true; error = ""; renderList();
      const result = await options.api.terms.save(value); if (!result.ok) throw new Error(result.error.message);
      if (view.document.id !== capturedView.document.id) return;
      draft = null; comparing = false;
      if (next) { selectedId = next.id; occurrence = 0; }
      await options.refresh(); options.changed?.();
      saved = true;
    } catch (e) { error = e instanceof Error ? e.message : "저장하지 못했습니다."; }
    finally {
      saving = false; renderList();
      if (saved && advance) { locate(); revealCard(true); }
    }
  }
  options.host.addEventListener("input", event => {
    const field = event.target as HTMLTextAreaElement;
    if (!field.matches("[data-linked-field]") || !draft || saving) return;
    if (field.dataset.linkedField === "definition") draft.definition = field.value; else draft.contextNote = field.value;
    root!.querySelector("[data-linked-save-state]")!.textContent = changed() ? "저장하지 않은 변경" : "풀이 수정 중";
    root!.querySelector<HTMLButtonElement>("[data-linked-save]")!.disabled = !changed();
  });
  let choiceStart = 0;
  options.host.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLElement>("button"); if (!button || !root?.contains(button) || saving) return;
    const menu = button.closest<HTMLElement>(".term-linked-menu"); if (menu?.matches(":popover-open")) menu.hidePopover();
    if (button.dataset.linkedId) select(button.dataset.linkedId);
    if (button.dataset.linkedHit !== undefined) {
      choiceStart = Number(button.dataset.linkedHit);
      const ids = [...new Set(hits.filter(hit => hit.start <= choiceStart && hit.end > choiceStart).map(hit => hit.id))];
      if (ids.length === 1) select(ids[0]!, choiceStart, true); else { chooser = ids; renderList(); }
    }
    if (button.dataset.linkedChoice) select(button.dataset.linkedChoice, choiceStart, true);
    if (button.hasAttribute("data-linked-prev") || button.hasAttribute("data-linked-next")) {
      const next = occurrence + (button.hasAttribute("data-linked-prev") ? -1 : 1);
      if (hits.some(hit => hit.id === selectedId && hit.index === next)) { occurrence = next; renderSource(); locate(); }
    }
    if (button.hasAttribute("data-linked-locate")) { setMobile(false); locate(); }
    if (button.hasAttribute("data-linked-mobile")) setMobile(button.dataset.linkedMobile === "terms");
    if (button.hasAttribute("data-linked-clear") && beforeChange()) options.reveal();
    if (button.hasAttribute("data-linked-edit") && active() && beforeChange()) { renderList(); options.edit(active()!); }
    if (button.hasAttribute("data-linked-begin-edit") && active() && !stale(active()!)) {
      draft = { entry: active()!, definition: active()!.definition ?? "", contextNote: active()!.contextNote ?? "" };
      comparing = false; error = ""; renderList(); root.querySelector<HTMLTextAreaElement>("[data-linked-field]")?.focus();
    }
    if (button.hasAttribute("data-linked-cancel-edit")) { draft = null; error = ""; renderList(); revealCard(true); }
    if (button.hasAttribute("data-linked-save")) void save();
    if (button.hasAttribute("data-linked-review")) void save({ status: "reviewed" }, true);
    if (button.dataset.linkedStatus === "draft" || button.dataset.linkedStatus === "excluded") void save({ status: button.dataset.linkedStatus });
    if (button.hasAttribute("data-linked-next-term") && view && selectedId) {
      const next = nextReviewTerm(shown, hits, selectedId, view);
      if (next) { select(next.id); revealCard(true); } else notify("표시된 용어 중 남은 검토 후보가 없습니다.", "용어");
    }
    if (button.hasAttribute("data-linked-compare") && view && active()) {
      comparing = true; quoteChoices = currentTermQuotes(termSource(view).text, active()!, hits);
      checkedQuotes = new Set(quoteChoices.filter(quote => active()!.occurrences.some(item => item.quote === quote)));
      if (!checkedQuotes.size && quoteChoices.length === 1) checkedQuotes.add(quoteChoices[0]!);
      renderList(); locate();
    }
    if (button.hasAttribute("data-linked-cancel-compare")) { comparing = false; renderList(); }
    if (button.hasAttribute("data-linked-relink")) void save({ relinkQuotes: [...checkedQuotes] });
    if (button.hasAttribute("data-linked-delete")) void remove();
  });
  async function remove() {
    const entry = active(); if (!entry?.documentId || saving) return;
    if (!window.confirm(`‘${entry.sourceForm}’ 용어를 삭제할까요?${changed() ? " 저장하지 않은 수정도 버립니다." : ""} 연결된 공통 용어는 유지됩니다.`)) return;
    saving = true; renderList();
    try {
      const result = await options.api.terms.delete({ id: entry.id, expectedLockVersion: entry.lockVersion }); if (!result.ok) throw new Error(result.error.message);
      draft = null; selectedId = null; await options.refresh(); options.changed?.(); notify("문서 용어를 삭제했습니다.", "용어");
    } catch (e) { error = e instanceof Error ? e.message : "삭제하지 못했습니다."; }
    finally { saving = false; renderList(); }
  }
  options.host.addEventListener("change", event => {
    const input = event.target as HTMLInputElement;
    if (input.matches("[data-linked-marks]")) { showMarks = input.checked; root?.classList.toggle("hide-marks", !showMarks); }
    if (input.matches("[data-linked-font]")) { fontSize = input.value; options.host.style.setProperty("--term-font-size", `${fontSize}px`); }
    if (input.matches("[data-linked-leading]")) { lineHeight = input.value; options.host.style.setProperty("--term-line-height", lineHeight); }
    if (input.dataset.linkedQuote !== undefined) {
      const quote = quoteChoices[Number(input.dataset.linkedQuote)]; if (!quote || saving) return;
      if (input.checked) checkedQuotes.add(quote); else checkedQuotes.delete(quote);
      root!.querySelector<HTMLButtonElement>("[data-linked-relink]")!.disabled = !checkedQuotes.size;
    }
  });
  options.host.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.code === "KeyS" && draft) { event.preventDefault(); event.stopPropagation(); if (changed()) void save(); }
  });
  return {
    hasUnsavedChanges: () => changed() || saving,
    canLeave, beforeChange,
    filter(filtered: TermEntry[]) {
      shown = filtered; chooser = [];
      if (!shown.some(entry => entry.id === selectedId)) { selectedId = sourceOrderedTerms(shown, hits)[0]?.id ?? null; occurrence = 0; }
      renderSource(); renderList();
      const list = root?.querySelector<HTMLElement>("[data-linked-list]");
      if (list) list.scrollTop = 0;
    },
    toolbarControls: () => `<div class="term-toolbar-group"><label class="term-toolbar-toggle"><input type="checkbox" data-linked-marks ${showMarks ? "checked" : ""}>용어 표시</label></div><div class="term-toolbar-group"><button class="btn btn-ghost btn-sm term-reading-trigger" type="button" popovertarget="${popoverId}" aria-label="글자 크기와 줄 간격" title="글자 크기와 줄 간격"><span aria-hidden="true">가</span><span aria-hidden="true">가</span></button><div class="editor-tool-popover term-reading-settings" id="${popoverId}" popover><label>글자 크기<select data-linked-font>${[18, 21, 24, 27].map(size => `<option value="${size}" ${fontSize === String(size) ? "selected" : ""}>${size} px</option>`).join("")}</select></label><label>줄 간격<select data-linked-leading>${[["1.8", "좁게"], ["2.1", "보통"], ["2.5", "넓게"]].map(([value, label]) => `<option value="${value}" ${value === lineHeight ? "selected" : ""}>${label}</option>`).join("")}</select></label></div></div>`,
    render(target: HTMLElement, nextView: EditorView, filtered: TermEntry[], all: TermEntry[]) {
      const scroll = root?.querySelector("[data-linked-source]")?.scrollTop ?? 0;
      const listScroll = root?.querySelector("[data-linked-list]")?.scrollTop ?? 0;
      if (scope !== nextView.document.id) { selectedId = null; draft = null; occurrence = 0; scope = nextView.document.id; mobileTerms = false; comparing = false; }
      if (view && termSource(view).version !== termSource(nextView).version) comparing = false;
      root = target; view = nextView; entries = all; shown = filtered;
      const basis = termSource(view); hits = termHits(basis.text, basis.version, entries);
      if (!entries.some(entry => entry.id === selectedId)) { selectedId = null; draft = null; }
      if (!draft && !shown.some(entry => entry.id === selectedId)) { selectedId = sourceOrderedTerms(shown, hits)[0]?.id ?? null; occurrence = 0; comparing = false; }
      occurrence = Math.min(occurrence, Math.max(0, hits.filter(hit => hit.id === selectedId).length - 1));
      const version = basis.kind === "punctuation" ? `P${view.punctuation!.versionNo}` : `V${view.source.versionNo}`;
      const state = (basis.kind === "punctuation" ? view.punctuation!.state : view.source.state) === "confirmed" ? "확정" : "작업안";
      root.className = `term-linked${showMarks ? "" : " hide-marks"}${mobileTerms ? " show-terms" : ""}`;
      root.innerHTML = `<div class="term-linked-mobile" role="group" aria-label="대조 영역"><button class="btn btn-sm" type="button" data-linked-mobile="source" aria-pressed="${!mobileTerms}">${basis.kind === "punctuation" ? "표점 원문" : "원문"}</button><button class="btn btn-sm" type="button" data-linked-mobile="terms" aria-pressed="${mobileTerms}">용어 검토</button></div>
        <section class="term-linked-source-pane" aria-label="용어 원문 대조"><header><strong>${basis.kind === "punctuation" ? "표점 원문" : "원문"}</strong><small>${version} · ${state}</small><span>읽기 전용</span></header><div class="term-linked-source" data-linked-source tabindex="0" aria-label="원문의 용어를 선택할 수 있습니다"></div><div class="term-linked-chooser" data-linked-chooser hidden></div><footer><span>${Array.from(basis.text).length.toLocaleString()}자</span><span data-linked-position></span><button class="btn btn-ghost btn-sm term-location-prev" type="button" data-linked-prev aria-label="이전 등장 위치">${chevron}</button><button class="btn btn-ghost btn-sm" type="button" data-linked-next aria-label="다음 등장 위치">${chevron}</button></footer></section>
        <div class="term-linked-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-label="원문과 용어 목록 너비 조절" title="드래그하여 너비 조절 · 더블클릭하여 기본 비율 복원"></div>
        <section class="term-linked-terms-pane" aria-label="용어 검토"><header><strong>용어</strong><small data-linked-count>${shown.length}개</small><span>원문 등장 순서</span></header><div data-linked-filters></div><div class="term-linked-list" data-linked-list></div><footer><span data-linked-reviewed></span><span class="sp"></span><span class="term-linked-progress" aria-hidden="true"><span data-linked-progress></span></span><span data-linked-remaining></span></footer></section>`;
      resize(root);
      renderSource(); renderList();
      root.querySelector("[data-linked-source]")!.scrollTop = scroll;
      root.querySelector("[data-linked-list]")!.scrollTop = listScroll;
    },
  };
}
