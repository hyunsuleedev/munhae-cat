import { configureTermSourceReview } from "./term-source-review";
import { evidenceText, formRanges, parseAlternatives, parseEvidence, rangeContext, TERM_CONFIDENCE_LABELS, TERM_KIND_LABELS, termItems, termReviewProgress, type TermItem } from "./term-review-model";
import { configureTermGeneration } from "./term-generation-ui";
import type { DocumentTermsView, EditorView, IpcResult, MunhaeApi, ProjectTermListItem, TermConfidence, TermContent, TermExtractionRun, TermKind, TermRange, TermReferenceSelection } from "../../shared/munhae-api";
import { esc, notify } from "./shared";
import { t, tAs, ui, uiText } from "./i18n";
import "../styles/term-review.css";

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(t(result.error.message));
  return result.data;
}
type DialogMode =
  | { type: "candidate"; item: Extract<TermItem, { kind: "candidate" }> }
  | { type: "term"; item: Extract<TermItem, { kind: "term" }> }
  | { type: "add"; form: string; prefill: Partial<TermContent> };

/** The editor's term screen for one document. The project glossary lives in glossary-ui. */
export function configureTermReview(options: { api: MunhaeApi; host: HTMLElement; view: () => EditorView | null; canStart?: () => boolean; changed?: () => void }) {
  const { api, host } = options;
  let data: DocumentTermsView | null = null;
  let project: ProjectTermListItem[] = [];
  let run: TermExtractionRun | null = null;
  let key = "";
  let serial = 0;
  let loading = false;
  let message = "";
  let query = "";
  let filter = "all";
  let timer: number | undefined;
  let starting = false;
  let saving = false;
  let formDirty = false;
  const dialog = document.createElement("dialog");
  dialog.className = "term-edit-dialog";
  dialog.setAttribute("aria-label", t("용어"));
  document.body.append(dialog);
  const get = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const source = () => options.view();
  const linkedReview = configureTermSourceReview({ api, host, refresh: () => load(true), changed: options.changed, edit: item => openDialog(item.kind === "term" ? { type: "term", item } : { type: "candidate", item }), reveal: () => { query = ""; filter = "all"; render(); } });
  const busy = () => starting || run?.state === "running";
  const generationPopup = configureTermGeneration({ api, view: source, basis: () => data?.basis ?? null, start: generate, cancel: async () => {
    if (!run) return;
    run = unwrap(await api.terms.cancel(run.id)); window.clearTimeout(timer); message = t("용어 추출을 취소했습니다."); render();
  } });
  const matches = (values: Array<string | null | undefined>) => values.some(s => s?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  function filteredItems(): TermItem[] {
    if (!data) return [];
    return termItems(data).filter(item => (filter === "all" || filter === item.kind)
      && matches(item.kind === "term" ? [item.link.term.sourceForm, item.link.term.reading, item.link.term.translation, item.link.term.definition, item.link.contextNote]
        : [item.candidate.sourceForm, item.candidate.reading, item.candidate.translation, item.candidate.definition, item.candidate.contextNote]));
  }
  function render() {
    renderDocument(source());
    generationPopup.update(run, starting);
  }
  function renderDocument(v: EditorView | null) {
    if (!v) { host.innerHTML = ""; return; }
    const basis = data?.basis ?? null;
    const progress = data ? termReviewProgress(data) : { confirmed: 0, candidates: 0 };
    const disabled = loading || !basis || !busy() && options.canStart?.() === false;
    const generateButton = `<button class="btn btn-primary btn-sm" data-term-generate ${disabled ? "disabled" : ""} ${basis ? "" : `title="${esc(t("확정된 표점본이 있어야 용어를 생성할 수 있습니다."))}"`}>${t(busy() ? "용어 생성 중 · 진행 보기" : "AI 용어 생성…")}</button>`;
    const previous = data?.previousCount ? ui`이전 표점본에서 확정한 용어 ${data.previousCount}개는 참고용이며 번역에 쓰이지 않습니다. 용어를 다시 생성하면 AI가 참고합니다.` : "";
    host.innerHTML = ui`<div class="term-review-toolbar" role="toolbar" aria-label="용어 도구"><div class="term-toolbar-group term-toolbar-title"><h2>${tAs("plural", "용어")}</h2><span data-term-progress>${ui`${progress.confirmed}개 확정 · 후보 ${progress.candidates}개`}</span></div>${basis ? linkedReview.toolbarControls() : ""}<span class="sp"></span><div class="term-review-actions"><button class="btn btn-ghost btn-sm" data-term-refresh>새로고침</button><button class="btn btn-ghost btn-sm" data-term-add ${saving || !basis ? "disabled" : ""}>직접 추가</button>${generateButton}</div></div>
      <div class="term-review-filters"><svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/></svg><input class="input" data-term-query aria-label="용어 검색" placeholder="용어·독음·뜻풀이 검색" value="${esc(query)}"><select class="select" data-term-filter aria-label="용어 상태">${[["all", t("전체")], ["candidate", tAs("plural", "후보")], ["term", t("확정")]].map(([val, label]) => `<option value="${val}" ${filter === val ? "selected" : ""}>${label}</option>`).join("")}</select></div>
      <p class="term-review-status" role="status">${esc(message || (loading ? t("용어를 불러오는 중…") : previous))}</p>
      <div class="term-review-list">${!loading && data && !basis ? uiText('<div class="term-review-empty">표점을 확정하면 이 문서의 용어를 만들 수 있습니다.<p>용어는 확정된 표점본의 정확한 위치에 연결됩니다. 이 단계를 건너뛰고 바로 번역해도 됩니다.</p></div>') : ""}</div>`;
    if (data && basis) {
      const list = host.querySelector<HTMLElement>(".term-review-list")!;
      const filters = host.querySelector<HTMLElement>(".term-review-filters")!;
      linkedReview.render(list, data, filteredItems(), project);
      list.querySelector("[data-linked-filters]")!.append(filters);
      host.classList.add("has-linked-terms");
    } else {
      host.querySelector(".term-review-filters")?.remove();
      host.classList.remove("has-linked-terms");
    }
  }
  async function fetchAll(v: EditorView | null) {
    const [termResult, projectResult] = await Promise.all([v ? api.terms.document(v.document.id) : Promise.resolve(null), api.terms.project()]);
    return { document: termResult ? unwrap(termResult) : null, project: unwrap(projectResult) };
  }
  const keyFor = (v: EditorView | null) => v ? `${v.document.id}:${v.punctuation?.versionId ?? ""}:${v.punctuation?.state ?? ""}` : "";
  async function prepareRefresh(v = source()): Promise<() => void> {
    const next = await fetchAll(v);
    return () => { ++serial; key = keyFor(v); data = next.document; project = next.project; message = ""; loading = false; render(); };
  }
  async function load(force = false) {
    const v = source();
    if (!v) return;
    const nextKey = keyFor(v);
    if (!force && nextKey === key) return;
    if (key.split(":")[0] !== nextKey.split(":")[0]) { window.clearTimeout(timer); run = null; }
    key = nextKey;
    const token = ++serial;
    loading = true; render();
    try {
      const next = await fetchAll(v);
      if (token !== serial) return;
      data = next.document; project = next.project; message = "";
      if (v && api.terms.latestRun) {
        const latest = unwrap(await api.terms.latestRun(v.document.id));
        if (token !== serial) return;
        run = latest;
        window.clearTimeout(timer);
        if (run?.state === "running") { message = t("용어 후보를 추출하고 있습니다."); timer = window.setTimeout(() => void poll(), 900); }
        else if (run?.error) message = t(run.error.message);
      }
    } catch (error) { if (token === serial) message = error instanceof Error ? error.message : t("용어를 불러오지 못했습니다."); }
    finally { if (token === serial) { loading = false; render(); } }
  }
  async function poll() {
    if (!run || run.state !== "running") return;
    try {
      const id = run.id; const currentKey = key;
      const updated = unwrap(await api.terms.getRun(id));
      if (key !== currentKey || run?.id !== id) return;
      run = updated;
      generationPopup.update(run, starting);
      if (run.state === "running") timer = window.setTimeout(() => void poll(), 900);
      else {
        const result = run; await load(true);
        message = result.state === "completed" ? result.skipped.length ? ui`${result.count}개 후보를 추가했습니다. 표점본에서 위치를 찾지 못한 ${result.skipped.length}개(${result.skipped.join(", ")})는 제외했습니다. 확정하거나 버리세요.` : ui`${result.count}개 후보를 추가했습니다. 확정하거나 버리세요.` : t(result.error?.message || "용어 추출을 취소했습니다.");
        render(); options.changed?.();
      }
    } catch (error) { message = error instanceof Error ? error.message : t("진행 상태를 불러오지 못했습니다."); render(); timer = window.setTimeout(() => void poll(), 2500); }
  }
  async function generate(excludedMaterialIds: string[] = [], referenceSelection?: TermReferenceSelection) {
    if (busy()) return;
    if (options.canStart?.() === false) throw new Error(t("원문·표점 변경을 저장한 뒤 용어를 생성하세요."));
    const v = source(); if (!v) return;
    starting = true; message = t("확정된 표점본을 읽고 용어 후보를 추출합니다."); render();
    try { run = unwrap(await api.terms.start(v.document.id, excludedMaterialIds, referenceSelection)); void poll(); }
    catch (error) { message = error instanceof Error ? error.message : t("용어 추출을 시작하지 못했습니다."); throw error; }
    finally { starting = false; render(); }
  }
  function close() { if (saving) return; if (formDirty && !window.confirm(t("저장하지 않은 용어 수정을 닫을까요?"))) return; dialog.close(); formDirty = false; }
  dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
  dialog.addEventListener("input", () => { formDirty = true; });
  const field = (name: string, label: string, value: string | null | undefined, multiline = false, disabled = false) => `<label class="term-edit-field">${t(label)}${multiline ? `<textarea rows="3" name="${name}" ${disabled ? "disabled" : ""}>${esc(value || "")}</textarea>` : `<input name="${name}" value="${esc(value || "")}" ${disabled ? "disabled" : ""}>`}</label>`;
  function openDialog(mode: DialogMode) {
    const basis = data?.basis ?? null;
    if (!basis) return;
    const candidate = mode.type === "candidate" ? mode.item.candidate : null, link = mode.type === "term" ? mode.item.link : null;
    const shared: TermContent | null = mode.type === "add"
      ? { sourceForm: mode.form, kind: mode.prefill.kind ?? "concept", reading: mode.prefill.reading ?? null, translation: mode.prefill.translation ?? null, definition: mode.prefill.definition ?? null, evidence: mode.prefill.evidence ?? [] }
      : link?.term ?? candidate;
    const notes = link ?? candidate;
    const linking = mode.type === "candidate" || mode.type === "add";
    let form = mode.type === "add" ? mode.form : shared!.sourceForm;
    const checked = new Set((link?.occurrences ?? candidate?.occurrences ?? []).map(r => `${r.from}:${r.to}`));
    const positions = () => {
      if (!basis) return "";
      const extra = mode.type === "term" || mode.type === "candidate" ? itemRangesOf(mode) : [];
      const ranges = [...new Map([...extra, ...formRanges(basis, form)].map(r => [`${r.from}:${r.to}`, r])).values()].sort((a, b) => a.from - b.from);
      const selectAll = mode.type === "add";
      return `<fieldset class="term-edit-positions"><legend>${ui`등장 위치 · 표점본 P${basis.versionNo}`}</legend>${ranges.map(r => { const c = rangeContext(basis, r); const on = selectAll || checked.has(`${r.from}:${r.to}`); return `<label><input type="checkbox" data-range="${r.from}:${r.to}" ${on ? "checked" : ""}><span>${esc(c.before)}<mark>${esc(c.form)}</mark>${esc(c.after)}</span></label>`; }).join("") || uiText("<p>표점본에 이 표현이 없습니다.</p>")}</fieldset>`;
    };
    const linkOptions = () => {
      const same = project.filter(term => term.sourceForm === form);
      const selected = candidate?.suggestedTermId ?? "";
      return same.length ? `<label class="term-edit-field">${tAs("link", "연결")}<select name="termId"><option value="">${t("새 용어로 만들기")}</option>${same.map(term => `<option value="${esc(term.id)}" ${selected === term.id ? "selected" : ""}>${t("기존 용어")} · ${esc(term.definition || term.translation || term.sourceForm)}${term.documents.length ? ` (${esc(term.documents.map(d => d.title).join(", "))})` : ""}</option>`).join("")}</select></label>` : "";
    };
    const title = t(mode.type === "candidate" ? "용어 후보 확정" : mode.type === "add" ? "용어 추가" : "용어");
    const scope = linking ? ui`이 문서 · ${esc(source()?.document.title ?? "")}` : ui`이 문서 · ${esc(source()?.document.title ?? "")} · 뜻풀이·번역어는 이 용어를 쓰는 모든 문서에 반영됩니다.`;
    // Linking to an existing term shows its shared content read-only; it is edited from that term.
    const content = (term: TermContent | null, disabled: boolean) => `<div class="term-edit-grid"><label class="term-edit-field">${t("분류")}<select name="kind" ${disabled ? "disabled" : ""}>${Object.entries(TERM_KIND_LABELS).map(([val, label]) => `<option value="${val}" ${(term?.kind ?? "concept") === val ? "selected" : ""}>${t(label)}</option>`).join("")}</select></label>${field("reading", "독음", term?.reading, false, disabled)}${field("translation", "권장 번역어", term?.translation, false, disabled)}</div>${field("definition", "뜻풀이", term?.definition, true, disabled)}${field("evidence", "근거 · 한 줄에 하나", term ? evidenceText(term.evidence) : "", true, disabled)}`;
    dialog.innerHTML = `<form><header><h2>${title}</h2>${uiText('<button type="button" class="btn btn-ghost" data-close aria-label="닫기">닫기</button>')}</header><div class="term-edit-body"><p class="muted">${scope}</p>
      ${field("sourceForm", "원문 표현", form, false, mode.type !== "add")}${linking ? `<div data-link-choice>${linkOptions()}</div>` : ""}<div data-term-content>${content(shared, false)}</div>
      ${field("contextNote", "이 글에서의 의미·역할", notes?.contextNote, true)}<label class="term-edit-field">${t("확신")}<select name="confidence">${Object.entries(TERM_CONFIDENCE_LABELS).map(([val, label]) => `<option value="${val}" ${(notes?.confidence ?? "certain") === val ? "selected" : ""}>${tAs("confidence", label)}</option>`).join("")}</select></label>${field("alternatives", "다른 해석 (한 줄에 하나, 3개까지)", notes?.alternatives.join("\n"), true)}<div data-positions>${positions()}</div>
      ${candidate ? ui`<p class="muted">AI 후보 · ${esc(candidate.generation.model)} · ${esc(candidate.createdAt.slice(0, 10))}</p>` : ""}<p data-error role="alert"></p></div>
      <footer>${mode.type === "term" ? uiText('<button type="button" class="btn btn-danger" data-delete>이 문서에서 삭제</button>') : ""}${mode.type === "candidate" ? uiText('<button type="button" class="btn" data-dismiss>버림</button>') : ""}<span class="sp"></span><button type="submit" class="btn btn-primary">${linking ? mode.type === "add" ? t("추가") : tAs("action", "확정") : t("저장")}</button></footer></form>`;
    formDirty = false;
    get("[data-close]").addEventListener("click", close);
    const formElement = get<HTMLFormElement>("form");
    const selectedTerm = () => linking ? project.find(term => term.id === (formElement.querySelector<HTMLSelectElement>("[name=termId]")?.value ?? "")) ?? null : null;
    // Redraw only when the link target changes, so typing the form keeps the fields entered so far.
    let shownTermId: string | null | undefined;
    function syncLinking() {
      const existing = selectedTerm();
      if ((existing?.id ?? null) === shownTermId) return;
      shownTermId = existing?.id ?? null;
      get("[data-term-content]").innerHTML = content(existing ?? shared, !!existing);
    }
    if (linking) { formElement.addEventListener("change", e => { if ((e.target as Element).matches("[name=termId]")) syncLinking(); }); syncLinking(); }
    if (mode.type === "add") formElement.addEventListener("input", e => {
      if (!(e.target as Element).matches("[name=sourceForm]")) return;
      form = (e.target as HTMLInputElement).value.trim();
      get("[data-positions]").innerHTML = positions();
      get("[data-link-choice]").innerHTML = linkOptions(); syncLinking();
    });
    const text = (name: string) => String(new FormData(formElement).get(name) ?? "").trim();
    const termContent = (): TermContent => ({ sourceForm: mode.type === "add" ? form : shared!.sourceForm, kind: text("kind") as TermKind, reading: text("reading") || null, translation: text("translation") || null, definition: text("definition") || null,
      evidence: parseEvidence(text("evidence")) });
    const noteValues = () => ({ contextNote: text("contextNote") || null, confidence: text("confidence") as TermConfidence, alternatives: parseAlternatives(text("alternatives")) });
    const ranges = (): TermRange[] => [...formElement.querySelectorAll<HTMLInputElement>("[data-range]:checked")].map(input => { const [from, to] = input.dataset.range!.split(":").map(Number); return { from: from!, to: to! }; });
    async function act(action: () => Promise<void>) {
      if (saving) return; saving = true;
      formElement.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = true; });
      try {
        await action();
        formDirty = false; saving = false; dialog.close();
        await load(true); options.changed?.();
      } catch (error) { get("[data-error]").textContent = error instanceof Error ? error.message : t("저장하지 못했습니다."); }
      finally { saving = false; formElement.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = false; }); }
    }
    formElement.addEventListener("submit", e => {
      e.preventDefault();
      void act(async () => {
        if (!ranges().length) throw new Error(t("등장 위치를 하나 이상 선택하세요."));
        if (mode.type === "term") {
          const term = mode.item.link.term, { sourceForm: _form, ...rest } = termContent();
          if (JSON.stringify(rest) !== JSON.stringify({ kind: term.kind, reading: term.reading, translation: term.translation, definition: term.definition, evidence: term.evidence })) {
            unwrap(await api.terms.update({ id: term.id, expectedLockVersion: term.lockVersion, ...rest }));
          }
          unwrap(await api.terms.updateUse({ id: mode.item.link.id, expectedLockVersion: mode.item.link.lockVersion, ...noteValues(), occurrences: ranges() }));
          return;
        }
        const existing = selectedTerm();
        unwrap(await api.terms.confirm({ documentId: basis!.documentId, punctuationVersionId: basis!.punctuationVersionId, candidateId: candidate?.id ?? null,
          termId: existing?.id ?? null, term: existing ? undefined : termContent(), ...noteValues(), occurrences: ranges() }));
      });
    });
    formElement.querySelector("[data-dismiss]")?.addEventListener("click", () => void act(async () => { unwrap(await api.terms.dismiss({ id: candidate!.id })); }));
    formElement.querySelector("[data-delete]")?.addEventListener("click", () => {
      if (!link || !window.confirm(formDirty ? ui`‘${link.term.sourceForm}’ 용어를 이 문서에서 삭제할까요? 저장하지 않은 수정도 버립니다. 다른 문서의 같은 용어는 유지됩니다.` : ui`‘${link.term.sourceForm}’ 용어를 이 문서에서 삭제할까요? 다른 문서의 같은 용어는 유지됩니다.`)) return;
      void act(async () => { unwrap(await api.terms.delete({ id: link.id, expectedLockVersion: link.lockVersion })); notify(t("문서 용어를 삭제했습니다."), t("용어")); });
    });
    if (!dialog.open) dialog.showModal();
  }
  const itemRangesOf = (mode: Extract<DialogMode, { type: "term" | "candidate" }>) => mode.type === "term" ? mode.item.link.occurrences : mode.item.candidate.occurrences;
  /** Manual terms start in the current document, at positions in its confirmed punctuated text. */
  async function add(form = "", prefill: Partial<TermContent> = {}) {
    if (!linkedReview.beforeChange()) return;
    await load();
    if (!data?.basis) { notify(t("확정된 표점본이 있어야 용어를 추가할 수 있습니다."), t("용어")); return; }
    openDialog({ type: "add", form: form.trim(), prefill });
  }
  host.addEventListener("click", event => {
    const target = event.target as Element;
    if (target.closest("[data-term-generate]") && linkedReview.beforeChange()) { render(); void generationPopup.open(); }
    if (target.closest("[data-term-refresh]") && linkedReview.beforeChange()) void load(true);
    if (target.closest("[data-term-add]")) void add(linkedReview.selectedText());
  });
  host.addEventListener("input", event => {
    const el = event.target as HTMLInputElement;
    if (!el.matches("[data-term-query]")) return;
    if (!linkedReview.beforeChange()) { el.value = query; return; }
    query = el.value;
    if (data?.basis) linkedReview.filter(filteredItems());
    else { const position = el.selectionStart; render(); const next = host.querySelector<HTMLInputElement>("[data-term-query]")!; next.focus(); next.setSelectionRange(position, position); }
  });
  host.addEventListener("change", event => {
    const el = event.target as HTMLSelectElement;
    if (!el.matches("[data-term-filter]")) return;
    if (!linkedReview.beforeChange()) { el.value = filter; return; }
    filter = el.value;
    if (data?.basis) linkedReview.filter(filteredItems());
  });
  window.addEventListener("beforeunload", event => { if (formDirty || saving || linkedReview.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ""; } });
  return { load, prepareRefresh, add, focusTerm: linkedReview.focusTerm, hasUnsavedChanges: () => formDirty || saving || linkedReview.hasUnsavedChanges(), isBusy: busy };
}
