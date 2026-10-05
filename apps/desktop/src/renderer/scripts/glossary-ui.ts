import type { IpcResult, MunhaeApi, ProjectTermListItem, ProjectTermUse, TermKind, TermSentencePage } from "../../shared/munhae-api";
import { distinctReading, firstSentence, glossaryMatches, homographNumbers, sentenceRuns, sortGlossary, termTranslation, type GlossarySort } from "./glossary-model";
import { t, ui } from "./i18n";
import { configureReadingType } from "./reading-type";
import { esc, ICONS, notify, openDocumentTerm } from "./shared";
import { evidenceText, parseEvidence, TERM_KIND_LABELS } from "./term-review-model";
import "../styles/glossary.css";

const chevron = `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${ICONS.chev}</svg>`;
const pen = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="m10.5 2.5 3 3M3 10l7.5-7.5a2.12 2.12 0 0 1 3 3L6 13l-4 1z"/></svg>';

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

type Elements = {
  list: HTMLElement; detail: HTMLElement; query: HTMLInputElement; kinds: HTMLElement; sort: HTMLSelectElement;
  selectAll: HTMLInputElement; selection: HTMLElement; selectionCount: HTMLElement; remove: HTMLButtonElement;
};

/**
 * The project glossary: every confirmed term as a row, and the selected term in the inspector.
 * Terms are added and linked in each document's term screen, never here.
 */
export function configureGlossary(options: { api: MunhaeApi } & Elements) {
  const { api, list, detail } = options;
  const emptyDetail = detail.innerHTML;
  let terms: ProjectTermListItem[] = [];
  let loaded = false, error = "";
  let kind: TermKind | "all" = "all", sort: GlossarySort = "reading";
  let selectedId: string | null = null;
  // Checked rows are a set apart from the term open in the inspector, as with the editor's sentence groups.
  const checked = new Set<string>();
  let editing = false, saving = false, deleting = false, baseline = "";
  // Sentences are read for the term on screen only, never with the whole list: a preview first, then one document on request.
  let sentences: { termId: string; byDocument: Record<string, TermSentencePage> } | null = null;
  let sentencesFor: string | null = null;
  configureReadingType();

  const selected = () => terms.find(term => term.id === selectedId) ?? null;
  const shown = () => sortGlossary(terms.filter(term => (kind === "all" || term.kind === kind) && glossaryMatches(term, options.query.value)), sort);
  const form = () => detail.querySelector<HTMLFormElement>("[data-glossary-form]");
  const snapshot = () => { const f = form(); return f ? JSON.stringify([...new FormData(f)].map(([name, value]) => [name, String(value)])) : ""; };
  const dirty = () => editing && snapshot() !== baseline;
  const canDiscard = () => !saving && (!dirty() || window.confirm(t("저장하지 않은 용어 수정을 버릴까요?")));
  const formWithNumber = (term: ProjectTermListItem, numbers: Map<string, number>) =>
    `<span class="glossary-form">${esc(term.sourceForm)}${numbers.has(term.id) ? `<sup>${numbers.get(term.id)}</sup>` : ""}</span>`;
  const useSentences = (termId: string, use: ProjectTermUse) => {
    if (sentences?.termId !== termId) return "";
    const page = sentences.byDocument[use.id], more = (label: string) => `<button type="button" class="glossary-use-more" data-glossary-more="${esc(use.id)}">${label}</button>`;
    // Documents past the preview show their sentences only when asked.
    if (!page) return more(t("문장 보기"));
    const rest = page.total - page.sentences.length;
    return `${page.sentences.length ? `<ul class="glossary-use-sentences">${page.sentences.map(sentence => `<li>${sentenceRuns(sentence).map(run => run.marked ? `<mark>${esc(run.text)}</mark>` : esc(run.text)).join("")}</li>`).join("")}</ul>` : ""}
      ${rest > 0 ? more(ui`문장 ${rest}개 더 보기`) : ""}`;
  };

  function ensureSelection() {
    if (!terms.some(term => term.id === selectedId)) { selectedId = shown()[0]?.id ?? null; editing = false; }
    const ids = new Set(terms.map(term => term.id));
    for (const id of checked) if (!ids.has(id)) checked.delete(id);
  }

  function paintChecks() {
    const visible = loaded && !error ? shown() : [];
    const count = visible.filter(term => checked.has(term.id)).length;
    options.selectAll.disabled = visible.length === 0;
    options.selectAll.checked = visible.length > 0 && count === visible.length;
    options.selectAll.indeterminate = count > 0 && count < visible.length;
    options.selection.hidden = checked.size === 0;
    options.selectionCount.textContent = ui`${checked.size}개 선택`;
    options.remove.disabled = deleting;
    list.querySelectorAll<HTMLInputElement>("[data-glossary-check]").forEach(box => {
      box.checked = checked.has(box.dataset.glossaryCheck!);
      box.closest(".glossary-item")?.classList.toggle("is-checked", box.checked);
    });
  }

  function render() {
    renderTools();
    renderList();
    renderDetail();
  }

  function renderTools() {
    const matching = terms.filter(term => glossaryMatches(term, options.query.value));
    const button = (value: string, label: string, count: number) =>
      `<button type="button" data-glossary-kind="${value}" aria-pressed="${kind === value}">${esc(label)}<span class="cnt">${count}</span></button>`;
    const kinds = (Object.keys(TERM_KIND_LABELS) as TermKind[]).filter(value => terms.some(term => term.kind === value));
    options.kinds.innerHTML = button("all", t("전체"), matching.length) + kinds.map(value => button(value, t(TERM_KIND_LABELS[value]), matching.filter(term => term.kind === value).length)).join("");
  }

  function renderList() {
    const scroll = list.scrollTop;
    if (!loaded || error) {
      list.innerHTML = `<p class="glossary-empty" role="status">${esc(error || t("용어를 불러오는 중…"))}</p>`;
      paintChecks();
      return;
    }
    const numbers = homographNumbers(terms);
    const rows = shown().map(term => {
      const active = term.id === selectedId, translation = termTranslation(term), reading = distinctReading(term);
      return `<div class="glossary-item${active ? " is-active" : ""}">
        <label class="glossary-select-cell"><input type="checkbox" class="select-checkbox" data-glossary-check="${esc(term.id)}" aria-label="${ui`${esc(term.sourceForm)} 선택`}"></label>
        <button type="button" class="glossary-row${active ? " is-active" : ""}" data-glossary-term="${esc(term.id)}" aria-current="${active}">
        <span class="glossary-row-head">${formWithNumber(term, numbers)}${translation ? `<span class="glossary-translation">${esc(translation)}</span>` : ""}${reading ? `<span class="glossary-reading">${esc(reading)}</span>` : ""}
        <span class="glossary-row-meta">${term.documents.length > 1 ? `<span class="glossary-documents">${ui`문서 ${term.documents.length}`}</span>` : ""}<span>${t(TERM_KIND_LABELS[term.kind])}</span></span></span>
        <span class="glossary-definition${term.definition ? "" : " is-empty"}">${esc(term.definition || t("뜻풀이가 없습니다"))}</span></button></div>`;
    }).join("");
    list.innerHTML = rows || (terms.length
      ? `<div class="glossary-empty"><p>${t("조건에 맞는 용어가 없습니다.")}</p><button type="button" class="btn btn-sm" data-glossary-clear>${t("전체 용어 보기")}</button></div>`
      : `<div class="glossary-empty"><p>${t("아직 확정한 용어가 없습니다.")}</p><p>${t("문서의 용어 화면에서 용어를 확정하면 여기에 모입니다.")}</p></div>`);
    list.scrollTop = scroll;
    paintChecks();
  }

  function renderDetail() {
    const term = selected();
    if (!term) { detail.innerHTML = emptyDetail; return; }
    const numbers = homographNumbers(terms);
    if (editing) {
      const field = (name: string, label: string, value: string | null, rows = 0) => `<label class="glossary-field">${label}${rows
        ? `<textarea name="${name}" rows="${rows}" maxlength="5000">${esc(value ?? "")}</textarea>`
        : `<input name="${name}" value="${esc(value ?? "")}" maxlength="1000">`}</label>`;
      detail.innerHTML = `<form class="glossary-edit" data-glossary-form>
        <div class="glossary-detail-top"><span>${t("용어 수정")}</span><span>${t("⌘S 저장 · Esc 취소")}</span></div>
        <h2 class="glossary-title">${formWithNumber(term, numbers)}</h2>
        <div class="glossary-field-row"><label class="glossary-field">${t("분류")}<select name="kind">${(Object.keys(TERM_KIND_LABELS) as TermKind[]).map(value => `<option value="${value}"${term.kind === value ? " selected" : ""}>${t(TERM_KIND_LABELS[value])}</option>`).join("")}</select></label>${field("reading", t("독음"), term.reading)}</div>
        ${field("translation", t("번역어"), term.translation)}
        ${field("definition", t("뜻풀이"), term.definition, 6)}
        ${field("evidence", ui`근거 <small>한 줄에 하나 · 주소는 줄 끝에</small>`, evidenceText(term.evidence), 3)}
        ${term.documents.length > 1 ? `<p class="glossary-edit-note">${ui`뜻풀이·번역어·근거는 이 용어를 쓰는 문서 ${term.documents.length}곳에 함께 반영됩니다.`}</p>` : ""}
        <p class="glossary-error" data-glossary-error role="alert"></p>
        <div class="glossary-edit-actions"><button type="button" class="btn btn-sm" data-glossary-cancel>${t("취소")}</button><button type="submit" class="btn btn-primary btn-sm">${t("저장")}</button></div>
      </form>`;
      baseline = snapshot();
      return;
    }
    loadSentences(term.id);
    const reading = distinctReading(term), translation = termTranslation(term);
    const homographs = terms.filter(other => other.sourceForm === term.sourceForm && other.id !== term.id);
    const uses = term.documents.map(use => `<article class="glossary-use${use.current ? "" : " is-previous"}">
        <div class="glossary-use-head"><strong>${esc(use.title)}</strong><small>${ui`등장 ${use.occurrences}곳 · 표점본 P${use.versionNo}`}</small></div>
        ${useSentences(term.id, use)}
        ${use.contextNote ? `<p class="glossary-use-note">${esc(use.contextNote)}</p>` : ""}
        ${use.current ? "" : `<p class="glossary-use-state">${t("이전 표점본에서 확정한 용어라 이 문서의 번역에는 쓰이지 않습니다.")}</p>`}
        <button type="button" class="glossary-use-open" data-glossary-open="${esc(use.id)}">${t("문서에서 보기")}${chevron}</button>
      </article>`).join("");
    detail.innerHTML = `<div class="glossary-detail-top"><span>${ui`${t(TERM_KIND_LABELS[term.kind])} · 문서 ${term.documents.length}곳`}</span><button type="button" class="btn btn-ghost btn-sm" data-glossary-edit>${pen}${t("수정")}</button></div>
      <h2 class="glossary-title">${formWithNumber(term, numbers)}${translation ? `<span>${esc(translation)}</span>` : ""}</h2>
      ${reading ? `<p class="glossary-reading-line">${ui`독음 ${esc(reading)}`}</p>` : ""}
      <p class="glossary-detail-definition${term.definition ? "" : " is-empty"}">${esc(term.definition || t("뜻풀이가 없습니다"))}</p>
      ${term.evidence.length ? `<section class="glossary-section"><h3>${t("근거")}</h3><ul class="glossary-evidence">${term.evidence.map(item => `<li>${esc(item.citation)}${item.url ? `<small>${esc(item.url)}</small>` : ""}</li>`).join("")}</ul></section>` : ""}
      <section class="glossary-section"><h3>${t("쓰이는 문서")}<small>${term.documents.length}</small></h3>${uses || `<p class="glossary-use-state">${t("쓰이는 문서가 없습니다.")}</p>`}</section>
      ${homographs.length ? `<section class="glossary-section"><h3>${t("표기가 같은 다른 용어")}</h3>${homographs.map(other => `<button type="button" class="glossary-homograph" data-glossary-term="${esc(other.id)}">${formWithNumber(other, numbers)}<span>${esc([termTranslation(other), other.definition && firstSentence(other.definition)].filter(Boolean).join(" · "))}</span><small>${esc(other.documents.map(use => use.title).join(" · "))}</small></button>`).join("")}</section>` : ""}`;
  }

  function loadSentences(termId: string) {
    if (sentencesFor === termId) return;
    sentencesFor = termId;
    void api.terms.sentences(termId).then(result => {
      if (sentencesFor !== termId || !result.ok) return;
      sentences = { termId, byDocument: result.data };
      if (!editing) renderDetail();
    });
  }

  async function loadDocumentSentences(documentId: string) {
    const termId = sentences?.termId;
    if (!termId) return;
    const result = await api.terms.sentences(termId, documentId);
    if (sentences?.termId !== termId || !result.ok) return;
    sentences = { termId, byDocument: { ...sentences.byDocument, ...result.data } };
    if (!editing) renderDetail();
  }

  function revealRow() {
    const row = list.querySelector<HTMLElement>(".glossary-row.is-active");
    if (!row) return;
    const offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (offset < 0 || offset > list.clientHeight - row.offsetHeight) list.scrollTop += offset - list.clientHeight / 3;
  }

  function select(id: string, reveal = false) {
    if (id === selectedId || !canDiscard()) return;
    editing = false; selectedId = id;
    if (reveal && !shown().some(term => term.id === id)) { kind = "all"; options.query.value = ""; renderTools(); }
    renderList(); renderDetail();
    if (reveal) revealRow();
  }

  function cancelEdit() {
    if (!canDiscard()) return;
    editing = false; renderDetail();
    detail.querySelector<HTMLElement>("[data-glossary-edit]")?.focus();
  }

  async function save(target: HTMLFormElement) {
    const term = selected();
    if (!term || saving) return;
    const values = new FormData(target), text = (name: string) => String(values.get(name) ?? "").trim();
    saving = true;
    target.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
    try {
      unwrap(await api.terms.update({ id: term.id, expectedLockVersion: term.lockVersion, kind: text("kind") as TermKind,
        reading: text("reading") || null, translation: text("translation") || null, definition: text("definition") || null, evidence: parseEvidence(text("evidence")) }));
      terms = unwrap(await api.terms.project());
      saving = false; editing = false;
      render();
    } catch (failure) {
      // Keep what was typed; only the error and the buttons change.
      saving = false;
      target.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = false; });
      target.querySelector("[data-glossary-error]")!.textContent = failure instanceof Error ? failure.message : t("저장하지 못했습니다.");
    }
  }

  list.addEventListener("click", event => {
    const target = event.target as Element;
    const row = target.closest<HTMLElement>("[data-glossary-term]");
    if (row) { select(row.dataset.glossaryTerm!); list.querySelector<HTMLElement>(".glossary-row.is-active")?.focus({ preventScroll: true }); }
    if (target.closest("[data-glossary-clear]")) { kind = "all"; options.query.value = ""; render(); }
  });
  list.addEventListener("change", event => {
    const box = (event.target as Element).closest<HTMLInputElement>("[data-glossary-check]");
    if (!box) return;
    if (box.checked) checked.add(box.dataset.glossaryCheck!); else checked.delete(box.dataset.glossaryCheck!);
    paintChecks();
  });
  options.selectAll.addEventListener("change", () => {
    if (options.selectAll.checked) shown().forEach(term => checked.add(term.id));
    else checked.clear();
    paintChecks();
  });
  options.remove.addEventListener("click", () => void removeChecked());
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !checked.size || event.defaultPrevented || document.querySelector("dialog[open]")) return;
    if ((event.target as Element).matches?.("input:not([type=checkbox]), textarea, select")) return;
    checked.clear(); paintChecks();
  });
  list.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-glossary-term]")];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (index < 0 || !next) return;
    event.preventDefault();
    select(next.dataset.glossaryTerm!);
    list.querySelector<HTMLElement>(".glossary-row.is-active")?.focus({ preventScroll: true });
    revealRow();
  });
  detail.addEventListener("click", event => {
    const target = event.target as Element;
    const other = target.closest<HTMLElement>("[data-glossary-term]");
    if (other) { select(other.dataset.glossaryTerm!, true); return; }
    if (target.closest("[data-glossary-edit]")) { editing = true; renderDetail(); detail.querySelector<HTMLTextAreaElement>("[name=definition]")?.focus(); return; }
    if (target.closest("[data-glossary-cancel]")) { cancelEdit(); return; }
    const more = target.closest<HTMLElement>("[data-glossary-more]");
    if (more) { void loadDocumentSentences(more.dataset.glossaryMore!); return; }
    const open = target.closest<HTMLElement>("[data-glossary-open]");
    const term = selected();
    if (open && term && canDiscard()) { editing = false; openDocumentTerm(open.dataset.glossaryOpen!, term.id); }
  });
  detail.addEventListener("submit", event => {
    const target = (event.target as Element).closest<HTMLFormElement>("[data-glossary-form]");
    if (!target) return;
    event.preventDefault();
    void save(target);
  });
  detail.addEventListener("keydown", event => {
    if (!editing) return;
    if ((event.metaKey || event.ctrlKey) && event.code === "KeyS") { event.preventDefault(); event.stopPropagation(); form()?.requestSubmit(); }
    else if (event.key === "Escape") { event.preventDefault(); cancelEdit(); }
  });
  options.query.addEventListener("input", () => { renderTools(); renderList(); });
  options.kinds.addEventListener("click", event => {
    const value = (event.target as Element).closest<HTMLElement>("[data-glossary-kind]")?.dataset.glossaryKind;
    if (!value) return;
    kind = value as TermKind | "all"; list.scrollTop = 0;
    renderTools(); renderList();
  });
  options.sort.addEventListener("change", () => { sort = options.sort.value as GlossarySort; list.scrollTop = 0; renderList(); });

  /** Deleting reaches every document that confirmed the term, so the prompt names how many documents lose it. */
  async function removeChecked() {
    const targets = sortGlossary(terms.filter(term => checked.has(term.id)), sort);
    if (!targets.length || deleting) return;
    const documents = new Set(targets.flatMap(term => term.documents.map(use => use.id))).size;
    const names = targets.slice(0, 3).map(term => term.sourceForm).join(", ") + (targets.length > 3 ? ui` 외 ${targets.length - 3}개` : "");
    const opened = targets.some(term => term.id === selectedId);
    if (!window.confirm(ui`용어 ${targets.length}개(${names})를 삭제할까요? 이 용어를 확정한 문서 ${documents}곳에서도 빠지며 되돌릴 수 없습니다.`
      + (opened && dirty() ? t(" 저장하지 않은 수정도 버립니다.") : ""))) return;
    deleting = true; paintChecks();
    try {
      unwrap(await api.terms.deleteProjectTerms({ terms: targets.map(term => ({ id: term.id, expectedLockVersion: term.lockVersion })) }));
      terms = unwrap(await api.terms.project());
      if (opened) { selectedId = null; editing = false; }
      checked.clear(); sentencesFor = null;
      ensureSelection();
      notify(ui`용어 ${targets.length}개를 삭제했습니다.`, t("용어집"));
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : t("용어를 삭제하지 못했습니다."), t("용어집"));
      // Nothing was deleted; reread so a term changed elsewhere shows its current version.
      try { terms = unwrap(await api.terms.project()); ensureSelection(); } catch { /* The list keeps what it showed. */ }
    } finally {
      deleting = false;
      render();
    }
  }

  async function load() {
    try { terms = unwrap(await api.terms.project()); error = ""; }
    catch (failure) { error = failure instanceof Error ? failure.message : t("용어를 불러오지 못했습니다."); }
    loaded = true; sentencesFor = null;
    ensureSelection();
    render();
  }

  async function prepareRefresh(): Promise<() => void> {
    const next = unwrap(await api.terms.project());
    return () => {
      terms = next; error = ""; loaded = true; sentencesFor = null;
      if (editing && !dirty()) editing = false;
      ensureSelection();
      render();
    };
  }

  render();
  return { load, prepareRefresh, hasUnsavedChanges: () => saving || dirty(), isBusy: () => saving };
}
