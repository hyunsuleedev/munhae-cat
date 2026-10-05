import type { DocumentTermsView, MunhaeApi, ProjectTermListItem, TermBasis } from "../../shared/munhae-api";
import { esc, ICONS, notify } from "./shared";
import { termHits, termSegments, type TermHit } from "./term-highlights";
import { candidateConfirmation, itemDefinition, itemForm, itemRanges, judgmentNote, nextCandidate, TERM_KIND_LABELS, termItems, termReviewProgress, type TermItem } from "./term-review-model";
import { configureTermSourceResize } from "./term-source-resize";
import { t, tAs, ui, uiText } from "./i18n";
import { readingTypeFields } from "./reading-type";
import "../styles/term-source-review.css";

const chevron = `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${ICONS.chev}</svg>`;
const editIcon = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="m10.5 2.5 3 3M3 10l7.5-7.5a2.12 2.12 0 0 1 3 3L6 13l-4 1z"/></svg>';
type Draft = { item: Extract<TermItem, { kind: "term" }>; definition: string; contextNote: string };

export function configureTermSourceReview(options: { api: MunhaeApi; host: HTMLElement; refresh(): Promise<void>; changed?(): void; edit(item: TermItem): void; reveal(): void }) {
  const resize = configureTermSourceResize(options.host);
  let root: HTMLElement | null = null, data: DocumentTermsView | null = null, basis: TermBasis | null = null;
  let projectTerms = new Map<string, ProjectTermListItem>();
  let items: TermItem[] = [], shown: TermItem[] = [], hits: TermHit[] = [];
  let selectedId: string | null = null, occurrence = 0, draft: Draft | null = null, saving = false;
  let showMarks = true, mobileTerms = false, error = "", chooser: string[] = [], scope = "";
  let focusTermId: string | null = null;
  const popoverId = `${options.host.id || "terms"}-reading-settings`;
  const menuId = `${options.host.id || "terms"}-entry-actions`;
  const active = () => items.find(item => item.id === selectedId);
  const changed = () => !!draft && (draft.definition !== (draft.item.link.term.definition ?? "") || draft.contextNote !== (draft.item.link.contextNote ?? ""));
  const canLeave = () => !saving && (!changed() || window.confirm(t("저장하지 않은 용어 수정을 버리고 이동할까요?")));
  const currentHit = () => hits.find(hit => hit.id === selectedId && hit.index === occurrence);
  function beforeChange() {
    if (!canLeave()) return false;
    draft = null; error = "";
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
    if (!basis || !root) return;
    const text = basis.text, current = currentHit(); let offset = 0, paragraph = 0;
    const host = root.querySelector<HTMLElement>("[data-linked-source]")!, scroll = host.scrollTop;
    host.innerHTML = text.split("\n").map(line => {
      const start = offset, end = offset + line.length; offset = end + 1;
      if (!line.trim()) return '<p class="term-linked-line is-blank" aria-hidden="true"></p>';
      const html = termSegments(text, hits, start, end).map(segment => {
        if (!segment.hits.length) return esc(segment.text);
        const ids = [...new Set(segment.hits.map(hit => hit.id))];
        const related = segment.hits.some(hit => hit.id === selectedId);
        const candidate = segment.hits.every(hit => hit.candidate);
        const focus = !!(related && current && segment.start >= current.start && segment.end <= current.end);
        return `<button type="button" class="term-linked-hit${candidate ? " is-candidate" : ""}${related ? " is-related" : ""}${focus ? " is-current" : ""}" data-linked-hit="${segment.start}" aria-pressed="${focus}" aria-label="${esc(ui`${ids.map(id => { const item = items.find(entry => entry.id === id); return item ? itemForm(item) : ""; }).join(" / ")} 용어 보기`)}">${esc(segment.text)}</button>`;
      }).join("");
      return `<p class="term-linked-line"><span aria-hidden="true">${String(++paragraph).padStart(2, "0")}</span><span>${html}</span></p>`;
    }).join("");
    host.scrollTop = scroll;
    const count = hits.filter(hit => hit.id === selectedId).length;
    const item = active();
    root.querySelector("[data-linked-position]")!.textContent = selectedId ? count ? `${item ? itemForm(item) : ""} · ${occurrence + 1} / ${count}` : t("표점본에 등장 위치 없음") : t("용어를 선택하세요");
    root.querySelector<HTMLButtonElement>("[data-linked-prev]")!.disabled = !count || occurrence <= 0;
    root.querySelector<HTMLButtonElement>("[data-linked-next]")!.disabled = !count || occurrence >= count - 1;
  }
  function evidence(list: { citation: string; url: string | null }[], positions: number) {
    return `<details class="term-linked-evidence"><summary>${chevron}${t("근거")}<small>${ui`등장 ${positions}곳`}${list.length ? ` · ${ui`근거 ${list.length}개`}` : ""}</small></summary>
      ${list.map(item => `<p>${esc(item.citation)}${item.url ? `<br>${esc(item.url)}` : ""}</p>`).join("") || uiText("<p>등록된 외부 근거가 없습니다.</p>")}</details>`;
  }
  function usedIn(termId: string | null): string {
    const documents = termId ? projectTerms.get(termId)?.documents ?? [] : [];
    return documents.length ? documents.map(document => document.title).join(" · ") : "";
  }
  function detail(item: TermItem): string {
    if (item.kind === "candidate") {
      const c = item.candidate, suggested = c.suggestedTermId ? projectTerms.get(c.suggestedTermId) : null;
      return `<div class="term-linked-detail"><div class="term-linked-meta"><span>${ui`AI 후보 · ${esc(c.generation.model)}`}</span><button type="button" class="btn btn-ghost btn-sm" data-linked-locate>${t("원문 위치")} ${chevron}</button></div>
        ${suggested ? `<div class="term-linked-context"><small>${t("기존 용어와 같은 대상으로 제안")}</small><p>${esc(suggested.definition || suggested.translation || suggested.sourceForm)}${usedIn(suggested.id) ? ` · ${esc(usedIn(suggested.id))}` : ""}</p></div>` : ""}
        <p class="term-linked-definition">${esc(c.definition || c.translation || t("뜻풀이가 없습니다."))}</p>
        ${c.contextNote ? `<div class="term-linked-context"><small>${t("이 글에서")}</small><p>${esc(c.contextNote)}</p></div>` : ""}
        ${judgmentNote(c) ? `<p class="term-linked-warning">${esc(judgmentNote(c))}</p>` : ""}
        ${evidence(c.evidence, c.occurrences.length)}
        <p class="term-linked-error" role="alert">${esc(error)}</p><div class="term-linked-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-linked-dismiss ${saving ? "disabled" : ""}>${t("버림")}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-linked-edit ${saving ? "disabled" : ""}>${editIcon}${t("고쳐서 확정")}</button>
        <button type="button" class="btn btn-primary btn-sm" data-linked-confirm ${saving ? "disabled" : ""}>${t("확정·다음")} ${chevron}</button></div></div>`;
    }
    const link = item.link, term = link.term, documents = projectTerms.get(term.id)?.documents.length ?? 1;
    const current = draft?.item.id === item.id ? draft : null;
    if (current) return `<div class="term-linked-detail term-linked-editing"><div class="term-linked-meta"><span data-linked-save-state>${t(saving ? "저장 중…" : changed() ? "저장하지 않은 변경" : "풀이 수정 중")}</span><span>${t("⌘S 저장")}</span></div>
      <label class="term-edit-field">${t("뜻풀이")}${documents > 1 ? ` <small>${ui`이 용어를 쓰는 문서 ${documents}곳에 함께 반영`}</small>` : ""}<textarea data-linked-field="definition" rows="3" maxlength="5000" ${saving ? "disabled" : ""}>${esc(current.definition)}</textarea></label><label class="term-edit-field">${t("이 글에서의 풀이")} <small>${tAs("optional", "선택")}</small><textarea data-linked-field="contextNote" rows="2" maxlength="5000" ${saving ? "disabled" : ""}>${esc(current.contextNote)}</textarea></label>
      <p class="term-linked-error" role="alert">${esc(error)}</p><div class="term-linked-actions"><button type="button" class="btn btn-ghost btn-sm" data-linked-cancel-edit ${saving ? "disabled" : ""}>${t("취소")}</button><button type="button" class="btn btn-primary btn-sm" data-linked-save ${saving || !changed() ? "disabled" : ""}>${t("저장")}</button></div></div>`;
    return `<div class="term-linked-detail"><div class="term-linked-meta"><span>${usedIn(term.id) ? esc(usedIn(term.id)) : t("이 문서에서 확정")}</span><button type="button" class="btn btn-ghost btn-sm" data-linked-locate>${t("원문 위치")} ${chevron}</button></div>
      <p class="term-linked-definition">${esc(term.definition || term.translation || t("뜻풀이가 없습니다."))}</p>
      ${term.translation && term.definition ? `<p class="term-linked-translation">${ui`번역어 · ${esc(term.translation)}`}</p>` : ""}
      ${link.contextNote ? `<div class="term-linked-context"><small>${t("이 글에서")}</small><p>${esc(link.contextNote)}</p></div>` : ""}
      ${judgmentNote(link) ? `<p class="term-linked-warning">${esc(judgmentNote(link))}</p>` : ""}
      ${evidence(term.evidence, link.occurrences.length)}
      <p class="term-linked-error" role="alert">${esc(error)}</p><div class="term-linked-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-linked-begin-edit ${saving ? "disabled" : ""}>${editIcon}${t("수정")}</button>
      <button type="button" class="btn btn-ghost btn-sm term-linked-more" popovertarget="${menuId}" aria-label="${esc(t("용어 추가 작업"))}" ${saving ? "disabled" : ""}>⋯</button><div class="editor-tool-popover term-linked-menu" id="${menuId}" popover>${uiText('<button class="btn btn-ghost" data-linked-edit type="button">상세 편집</button><button class="btn btn-ghost" type="button" data-linked-delete>이 문서에서 삭제</button>')}</div>
      <span class="term-linked-action-state is-reviewed">${t("확정")}</span>${data?.candidates.length ? uiText('<button class="btn btn-sm" type="button" data-linked-next-term>다음 후보</button>') : ""}</div></div>`;
  }
  function renderList() {
    if (!root || !data) return;
    const list = root.querySelector<HTMLElement>("[data-linked-list]")!, scroll = list.scrollTop;
    list.innerHTML = shown.map(item => {
      const selected = item.id === selectedId, kind = item.kind === "term" ? item.link.term.kind : item.candidate.kind;
      const reading = item.kind === "term" ? item.link.term.reading : item.candidate.reading;
      return `<article class="term-linked-card${selected ? " is-selected" : ""}" data-linked-card="${esc(item.id)}"><button class="term-linked-summary" type="button" data-linked-id="${esc(item.id)}" aria-expanded="${selected}" ${saving ? "disabled" : ""}><span><strong>${esc(itemForm(item))}</strong><small>${esc(reading || "")}</small><span class="term-linked-kind">${t(TERM_KIND_LABELS[kind])}</span><span class="term-linked-state${item.kind === "term" ? " is-reviewed" : ""}">${t(item.kind === "term" ? "확정" : "후보")}</span></span>${selected ? "" : `<span class="term-linked-meaning">${esc(itemDefinition(item) || t("뜻풀이가 없습니다"))}</span>`}</button>${selected ? detail(item) : ""}</article>`;
    }).join("") || `<div class="term-review-empty"><p>${t(items.length ? "조건에 맞는 용어가 없습니다." : "아직 용어가 없습니다.")}</p>${items.length ? uiText('<button class="btn btn-sm" data-linked-clear type="button">전체 용어 보기</button>') : uiText('<button class="btn btn-sm" data-term-add type="button">직접 추가</button>')}</div>`;
    list.scrollTop = scroll;
    const chooserHost = root.querySelector<HTMLElement>("[data-linked-chooser]")!;
    chooserHost.innerHTML = chooser.length ? `<span>${t("겹치는 용어 선택")}</span>${chooser.map(id => { const item = items.find(entry => entry.id === id); return `<button class="btn btn-sm" type="button" data-linked-choice="${esc(id)}">${esc(item ? `${itemForm(item)}${item.kind === "candidate" ? ` · ${t("후보")}` : ""}` : "")}</button>`; }).join("")}` : "";
    chooserHost.hidden = !chooser.length;
    const progress = termReviewProgress(data);
    root.querySelector("[data-linked-count]")!.textContent = ui`${shown.length}개`;
    root.querySelector("[data-linked-reviewed]")!.textContent = ui`${progress.confirmed}개 확정`;
    root.querySelector("[data-linked-remaining]")!.textContent = ui`후보 ${progress.candidates}개`;
    root.querySelector<HTMLElement>("[data-linked-progress]")!.style.width = `${progress.confirmed + progress.candidates ? progress.confirmed / (progress.confirmed + progress.candidates) * 100 : 0}%`;
    options.host.querySelectorAll("[data-term-progress]").forEach(node => { node.textContent = ui`${progress.confirmed}개 확정 · 후보 ${progress.candidates}개`; });
  }
  function select(id: string, start?: number, fromSource = false) {
    if (saving || (id !== selectedId && !beforeChange())) return;
    selectedId = id; error = ""; chooser = [];
    occurrence = start === undefined ? 0 : hits.find(hit => hit.id === id && hit.start <= start && hit.end > start)?.index ?? 0;
    if (root && getComputedStyle(root.querySelector(".term-linked-mobile")!).display !== "none") setMobile(true);
    if (fromSource && !shown.some(item => item.id === id)) options.reveal();
    else { renderSource(); renderList(); }
    if (!fromSource) locate();
    revealCard();
  }
  async function run(action: () => Promise<void>, advance = false) {
    const item = active(); if (!item || !data || saving) return;
    const next = advance ? nextCandidate(items, item.id) : null;
    let done = false;
    saving = true; error = ""; renderList();
    try {
      await action();
      draft = null;
      if (next) { selectedId = next.id; occurrence = 0; }
      await options.refresh(); options.changed?.();
      done = true;
    } catch (e) { error = e instanceof Error ? e.message : t("저장하지 못했습니다."); }
    finally {
      saving = false; renderList();
      if (done && advance) { renderSource(); locate(); revealCard(true); }
    }
  }
  const unwrap = <T,>(result: { ok: true; data: T } | { ok: false; error: { message: string } }): T => { if (!result.ok) throw new Error(t(result.error.message)); return result.data; };
  async function saveDraft() {
    const current = draft; if (!current) return;
    await run(async () => {
      const { link } = current.item, term = link.term;
      const definition = current.definition.trim() || null, contextNote = current.contextNote.trim() || null;
      if (definition !== term.definition) unwrap(await options.api.terms.update({ id: term.id, expectedLockVersion: term.lockVersion, kind: term.kind, reading: term.reading, translation: term.translation, definition, evidence: term.evidence }));
      if (contextNote !== link.contextNote) unwrap(await options.api.terms.updateUse({ id: link.id, expectedLockVersion: link.lockVersion, contextNote, confidence: link.confidence, alternatives: link.alternatives }));
    });
  }
  options.host.addEventListener("input", event => {
    const field = event.target as HTMLTextAreaElement;
    if (!field.matches("[data-linked-field]") || !draft || saving) return;
    if (field.dataset.linkedField === "definition") draft.definition = field.value; else draft.contextNote = field.value;
    root!.querySelector("[data-linked-save-state]")!.textContent = t(changed() ? "저장하지 않은 변경" : "풀이 수정 중");
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
    const item = active();
    if (button.hasAttribute("data-linked-edit") && item && beforeChange()) { renderList(); options.edit(item); }
    if (button.hasAttribute("data-linked-begin-edit") && item?.kind === "term") {
      draft = { item, definition: item.link.term.definition ?? "", contextNote: item.link.contextNote ?? "" };
      error = ""; renderList(); root.querySelector<HTMLTextAreaElement>("[data-linked-field]")?.focus();
    }
    if (button.hasAttribute("data-linked-cancel-edit")) { draft = null; error = ""; renderList(); revealCard(true); }
    if (button.hasAttribute("data-linked-save")) void saveDraft();
    if (button.hasAttribute("data-linked-confirm") && item?.kind === "candidate" && basis) {
      const input = candidateConfirmation(basis, item.candidate);
      void run(async () => { unwrap(await options.api.terms.confirm(input)); }, true);
    }
    if (button.hasAttribute("data-linked-dismiss") && item?.kind === "candidate") void run(async () => { unwrap(await options.api.terms.dismiss({ id: item.candidate.id })); }, true);
    if (button.hasAttribute("data-linked-next-term")) {
      const next = nextCandidate(items, selectedId);
      if (next) { select(next.id); revealCard(true); } else notify(t("남은 후보가 없습니다."), t("용어"));
    }
    if (button.hasAttribute("data-linked-delete") && item?.kind === "term") {
      if (!window.confirm(ui`‘${item.link.term.sourceForm}’ 용어를 이 문서에서 삭제할까요? 다른 문서의 같은 용어는 유지됩니다.`)) return;
      void run(async () => { unwrap(await options.api.terms.delete({ id: item.link.id, expectedLockVersion: item.link.lockVersion })); selectedId = null; notify(t("문서 용어를 삭제했습니다."), t("용어")); });
    }
  });
  options.host.addEventListener("change", event => {
    const input = event.target as HTMLInputElement;
    if (input.matches("[data-linked-marks]")) { showMarks = input.checked; root?.classList.toggle("hide-marks", !showMarks); }
  });
  options.host.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.code === "KeyS" && draft) { event.preventDefault(); event.stopPropagation(); if (changed()) void saveDraft(); }
  });
  return {
    hasUnsavedChanges: () => changed() || saving,
    canLeave, beforeChange,
    selectedText(): string {
      const selection = window.getSelection(), source = root?.querySelector("[data-linked-source]");
      return selection && !selection.isCollapsed && source?.contains(selection.anchorNode) ? selection.toString().trim() : "";
    },
    filter(filtered: TermItem[]) {
      shown = filtered; chooser = [];
      if (!shown.some(item => item.id === selectedId)) { selectedId = shown[0]?.id ?? null; occurrence = 0; }
      renderSource(); renderList();
      const list = root?.querySelector<HTMLElement>("[data-linked-list]");
      if (list) list.scrollTop = 0;
    },
    toolbarControls: () => `<div class="term-toolbar-group"><label class="term-toolbar-toggle"><input type="checkbox" data-linked-marks ${showMarks ? "checked" : ""}>${t("용어 표시")}</label></div><div class="term-toolbar-group"><button class="btn btn-ghost btn-sm reading-type-trigger term-reading-trigger" type="button" popovertarget="${popoverId}" aria-label="${t("글자 크기와 줄 간격")}" title="${t("글자 크기와 줄 간격")}"><span aria-hidden="true">가</span><span aria-hidden="true">가</span></button><div class="editor-tool-popover reading-type-settings term-reading-settings" id="${popoverId}" popover>${readingTypeFields(popoverId)}</div></div>`,
    render(target: HTMLElement, next: DocumentTermsView, filtered: TermItem[], project: ProjectTermListItem[]) {
      const scroll = root?.querySelector("[data-linked-source]")?.scrollTop ?? 0;
      const listScroll = root?.querySelector("[data-linked-list]")?.scrollTop ?? 0;
      if (!next.basis) return;
      if (scope !== next.basis.documentId) { selectedId = null; draft = null; occurrence = 0; scope = next.basis.documentId; mobileTerms = false; }
      root = target; data = next; basis = next.basis; shown = filtered;
      projectTerms = new Map(project.map(term => [term.id, term]));
      items = termItems(next);
      hits = termHits(basis.text, items.map(item => ({ id: item.id, ranges: itemRanges(item), candidate: item.kind === "candidate" })));
      if (!items.some(item => item.id === selectedId)) { selectedId = null; draft = null; }
      const focus = focusTermId ? items.find(item => item.kind === "term" && item.link.term.id === focusTermId) : undefined;
      focusTermId = null;
      if (focus) { selectedId = focus.id; draft = null; occurrence = 0; }
      if (!draft && !shown.some(item => item.id === selectedId)) { selectedId = shown[0]?.id ?? null; occurrence = 0; }
      occurrence = Math.min(occurrence, Math.max(0, hits.filter(hit => hit.id === selectedId).length - 1));
      root.className = `term-linked${showMarks ? "" : " hide-marks"}${mobileTerms ? " show-terms" : ""}`;
      root.innerHTML = ui`<div class="term-linked-mobile" role="group" aria-label="대조 영역"><button class="btn btn-sm" type="button" data-linked-mobile="source" aria-pressed="${!mobileTerms}">표점 원문</button><button class="btn btn-sm" type="button" data-linked-mobile="terms" aria-pressed="${mobileTerms}">${tAs("plural", "용어")}</button></div>
        <section class="term-linked-source-pane" aria-label="용어 원문 대조"><header><strong>표점 원문</strong><small>P${basis.versionNo} · 확정</small><span>읽기 전용</span></header><div class="term-linked-source" data-linked-source tabindex="0" aria-label="원문의 용어를 선택할 수 있습니다"></div><div class="term-linked-chooser" data-linked-chooser hidden></div><footer><span>${Array.from(basis.text).length.toLocaleString()}자</span><span data-linked-position></span><button class="btn btn-ghost btn-sm term-location-prev" type="button" data-linked-prev aria-label="이전 등장 위치">${chevron}</button><button class="btn btn-ghost btn-sm" type="button" data-linked-next aria-label="다음 등장 위치">${chevron}</button></footer></section>
        <div class="term-linked-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-label="원문과 용어 목록 너비 조절" title="드래그하여 너비 조절 · 더블클릭하여 기본 비율 복원"></div>
        <section class="term-linked-terms-pane" aria-label="${tAs("plural", "용어")}"><header><strong>${tAs("plural", "용어")}</strong><small data-linked-count>${shown.length}개</small><span>원문 등장 순서</span></header><div data-linked-filters></div><div class="term-linked-list" data-linked-list></div><footer><span data-linked-reviewed></span><span class="sp"></span><span class="term-linked-progress" aria-hidden="true"><span data-linked-progress></span></span><span data-linked-remaining></span></footer></section>`;
      resize(root);
      renderSource(); renderList();
      root.querySelector("[data-linked-source]")!.scrollTop = scroll;
      root.querySelector("[data-linked-list]")!.scrollTop = listScroll;
      if (focus) { locate(); revealCard(); }
    },
    /** Selects this project term's use the next time the document's terms render. */
    focusTerm(termId: string) { focusTermId = termId; },
  };
}
