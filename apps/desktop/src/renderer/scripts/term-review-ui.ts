import { configureTermSourceReview } from "./term-source-review";
import { termIsStale, termReviewProgress } from "./term-review-model";
import type { TermGlossarySelection } from "../../shared/term-glossary";
import { termSource } from "@munhae/domain/term-source";
import { configureTermGeneration } from "./term-generation-ui";
import type { EditorView, GlossaryEntryView, MunhaeApi, TermEntry, SaveTermInput, TermExtractionRun } from "../../shared/munhae-api";
import { esc, notify } from "./shared";
import "../styles/term-review.css";

function unwrap<T>(result: import("../../shared/munhae-api").IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
const kinds: Record<TermEntry["kind"], string> = { person: "인물", place: "장소", office: "관직", institution: "제도", work: "서명·작품", object: "사물", concept: "개념", allusion: "전고", expression: "표현" };
const statuses = { draft: "검토 전", reviewed: "검토됨", excluded: "제외" };
export function configureTermReview(options: { api: MunhaeApi; host: HTMLElement; view?: () => EditorView | null; canStart?: () => boolean; changed?: () => void }) {
  const { api, host } = options;
  let entries: TermEntry[] = [];
  let legacyTerms: GlossaryEntryView[] = [];
  let documentTitles = new Map<string, string>();
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
  dialog.setAttribute("aria-label", "용어");
  document.body.append(dialog);
  const get = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const source = () => options.view?.() ?? null;
  const linkedReview = configureTermSourceReview({ api, host, refresh: () => load(true), changed: options.changed, edit: entry => { void edit(entry); }, reveal: () => { query = ""; filter = "all"; render(); } });
  const busy = () => starting || run?.state === "running";
  const generationPopup = configureTermGeneration({ api, view: source, start: generate, cancel: async () => {
    if (!run) return;
    run = unwrap(await api.terms.cancel(run.id)); window.clearTimeout(timer); message = "용어 추출을 취소했습니다."; render();
  } });
  function filteredEntries(v = source()) {
    const outdated = (entry: TermEntry) => !!v && termIsStale(entry, v);
    return entries.filter(e => (filter === "all" || filter === "project" && !e.documentId || filter === "document" && !!e.documentId || filter === "stale" && e.status !== "excluded" && outdated(e) || e.status === filter && (filter === "excluded" || !outdated(e))) && [e.sourceForm, e.reading, e.translation, e.definition, e.contextNote].some(s => s?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  }
  function render() {
    const v = source();
    const shown = filteredEntries(v);
    const progress = v ? termReviewProgress(entries, v) : null;
    const generateButton = `<button class="btn btn-primary btn-sm" data-term-generate ${loading || !v || !busy() && options.canStart?.() === false ? "disabled" : ""}>${busy() ? "용어 생성 중 · 진행 보기" : "AI 용어 생성…"}</button>`;
    const toolbar = v ? `<div class="term-review-toolbar" role="toolbar" aria-label="용어 검토 도구"><div class="term-toolbar-group term-toolbar-title"><h2>용어 검토</h2><span data-term-progress>${progress!.reviewed} / ${progress!.total} 검토</span></div>${linkedReview.toolbarControls()}<span class="sp"></span><div class="term-review-actions"><button class="btn btn-ghost btn-sm" data-term-refresh>새로고침</button><button class="btn btn-ghost btn-sm" data-term-add ${saving ? "disabled" : ""}>직접 추가</button>${generateButton}</div></div>`
      : `<div class="term-review-toolbar"><div><h2>${options.view ? "용어 <small>선택</small>" : "용어 풀이"}</h2><p>${options.view ? "인물·전고·문맥상 의미를 확인합니다." : "문서별 풀이와 프로젝트 공통 항목을 함께 관리합니다."}</p></div><div class="term-review-actions">${options.view ? generateButton : ""}<button class="btn" data-term-add ${saving ? "disabled" : ""}>직접 추가</button><button class="btn btn-ghost" data-term-refresh>새로고침</button></div></div>`;
    host.innerHTML = `${toolbar}
      <div class="term-review-filters">${v ? '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/></svg>' : ""}<input class="input" data-term-query aria-label="용어 검색" placeholder="용어·독음·뜻풀이 검색" value="${esc(query)}"><select class="select" data-term-filter aria-label="용어 범위와 상태">${[["all", "전체"], ["document", "문서 용어"], ["project", "프로젝트 공통"], ["draft", "검토 전"], ["reviewed", "검토 완료"], ...(v ? [["stale", "재검토 필요"]] : []), ["excluded", "참고 제외"]].map(([val, label]) => `<option value="${val}" ${filter === val ? "selected" : ""}>${label}</option>`).join("")}</select>${v ? "" : `<span class="muted">${entries.filter(e => e.status === "reviewed").length}개 검토 · ${entries.filter(e => e.status === "draft").length}개 후보</span>`}</div>
      <p class="term-review-status" role="status">${esc(message || (!v && loading ? "용어를 불러오는 중…" : ""))}</p>
      <div class="term-review-list">${shown.map(e => { const stale = !!v && e.documentId === v.document.id && e.sourceVersion !== termSource(v).version; return `<button type="button" class="term-review-card" data-term-id="${esc(e.id)}"><span class="term-review-card-head"><strong>${esc(e.sourceForm)}</strong><span>${esc(e.reading || "")}</span><span class="term-review-badge">${kinds[e.kind]}</span></span><span class="term-review-meaning">${esc(e.contextNote || e.definition || e.translation || "뜻풀이를 추가하세요")}</span><span class="term-review-card-foot"><span>${esc(e.documentId ? (v ? "이 문서" : documentTitles.get(e.documentId) || "문서 용어") : "프로젝트 공통")}</span><span>${stale ? "원문·표점 변경 · 재검토 필요" : statuses[e.status]}</span>${e.uncertainty ? '<span class="term-review-warning">확인할 점 있음</span>' : ""}</span></button>`; }).join("") || `<div class="term-review-empty">${query || filter !== "all" ? "조건에 맞는 용어가 없습니다." : "아직 용어가 없습니다. AI로 후보를 추출하거나 직접 추가하세요."}${options.view ? "<p>이 단계를 건너뛰고 바로 번역해도 됩니다.</p>" : ""}</div>`}</div>${options.view && legacyTerms.length ? `<details class="term-existing"><summary>기존 공통 용어 ${legacyTerms.length}개</summary><p class="muted">원문에 등장하는 기존 용어도 번역에 함께 반영합니다. <a href="glossary.html">용어집에서 편집</a></p>${legacyTerms.map(e => `<p><strong>${esc(e.sourceTerm)}</strong> · ${esc(e.targetTerm)} <span class="muted">${esc(e.noteMd || "")}</span></p>`).join("")}</details>` : ""}`;
    if (v) {
      const list = host.querySelector<HTMLElement>(".term-review-list")!;
      const filters = host.querySelector<HTMLElement>(".term-review-filters")!;
      linkedReview.render(list, v, shown, entries);
      list.querySelector("[data-linked-filters]")!.append(filters);
      host.classList.add("has-linked-terms");
    } else host.classList.remove("has-linked-terms");
    renderActivity();
  }
  function renderActivity() { generationPopup.update(run, starting); }
  async function prepareRefresh(v = source()): Promise<() => void> {
    const [termResult, knowledgeResult, homeResult] = await Promise.all([api.terms.list(v?.document.id), api.knowledge.get(), api.home.get()]);
    const nextEntries = unwrap(termResult), nextKnowledge = unwrap(knowledgeResult), nextHome = unwrap(homeResult);
    return () => {
      ++serial;
      key = v ? `${v.document.id}:${termSource(v).version}` : "project";
      entries = nextEntries;
      legacyTerms = v ? nextKnowledge.glossary.filter(e => termSource(v).text.includes(e.sourceTerm)) : [];
      documentTitles = new Map(nextHome.documents.map(d => [d.id, d.title]));
      message = ""; loading = false; render();
    };
  }
  async function load(force = false) {
    const v = source();
    if (options.view && !v) return;
    const nextKey = v ? `${v.document.id}:${termSource(v).version}` : "project";
    if (!force && nextKey === key) return;
    if (key !== nextKey) { window.clearTimeout(timer); run = null; }
    key = nextKey;
    const token = ++serial;
    loading = true; render();
    try {
      const [termResult, knowledgeResult, homeResult] = await Promise.all([api.terms.list(v?.document.id), api.knowledge.get(), api.home.get()]);
      const result = unwrap(termResult);
      if (token !== serial) return;
      const knowledge = unwrap(knowledgeResult);
      legacyTerms = v ? knowledge.glossary.filter(e => termSource(v).text.includes(e.sourceTerm)) : [];
      documentTitles = new Map(unwrap(homeResult).documents.map(d => [d.id, d.title]));
      if (token !== serial) return;
      entries = result;
      message = "";
      if (v) {
        if (api.terms.latestRun) {
          const latest = unwrap(await api.terms.latestRun(v.document.id));
          if (token !== serial) return;
          run = latest;
          window.clearTimeout(timer);
          if (run?.state === "running") { message = "용어 후보를 추출하고 있습니다."; timer = window.setTimeout(() => void poll(), 900); }
          else if (run?.error) message = run.error.message;
        }
      }
    } catch (error) { if (token === serial) message = error instanceof Error ? error.message : "용어를 불러오지 못했습니다."; }
    finally { if (token === serial) { loading = false; render(); } }
  }
  async function poll() {
    if (!run || run.state !== "running") return;
    try {
      const id = run.id; const currentKey = key;
      const updated = unwrap(await api.terms.getRun(id));
      if (key !== currentKey || run?.id !== id) return;
      run = updated;
      renderActivity();
      if (run.state === "running") timer = window.setTimeout(() => void poll(), 900);
      else { const result = run; await load(true); message = result.state === "completed" ? `${result.count}개 후보를 추가했습니다. 뜻풀이와 확인할 점을 검토하세요.` : result.error?.message || "용어 추출을 취소했습니다."; render(); options.changed?.(); }
    } catch (error) { message = error instanceof Error ? error.message : "진행 상태를 불러오지 못했습니다."; render(); timer = window.setTimeout(() => void poll(), 2500); }
  }
  async function generate(excludedMaterialIds: string[] = [], glossarySelection?: TermGlossarySelection) {
    if (busy()) return;
    if (options.canStart?.() === false) throw new Error("원문 변경을 저장한 뒤 용어를 생성하세요.");
    const v = source(); if (!v) return;
    starting = true; message = "저장된 원문을 읽고 용어 후보를 추출합니다."; render();
    try { run = unwrap(await api.terms.start(v.document.id, excludedMaterialIds, glossarySelection)); void poll(); }
    catch (error) { message = error instanceof Error ? error.message : "용어 추출을 시작하지 못했습니다."; throw error; }
    finally { starting = false; render(); }
  }
  function close() { if (saving) return; if (formDirty && !window.confirm("저장하지 않은 용어 수정을 닫을까요?")) return; dialog.close(); formDirty = false; }
  dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
  dialog.addEventListener("input", () => { formDirty = true; });
  async function edit(entry?: TermEntry) {
    let v = source();
    if (entry?.documentId && v?.document.id !== entry.documentId) {
      try { v = unwrap(await api.editor.get(entry.documentId)); } catch (error) { notify(String(error), "용어"); return; }
    }
    const local = entry ? !!entry.documentId : !!v;
    const stale = local && entry && entry.sourceVersion !== (v ? termSource(v).version : null);
    const field = (name: string, label: string, value: string | null | undefined, multiline = false) => `<label class="term-edit-field">${label}${multiline ? `<textarea rows="3" name="${name}">${esc(value || "")}</textarea>` : `<input name="${name}" value="${esc(value || "")}">`}</label>`;
    dialog.innerHTML = `<form><header><h2>${entry ? "용어" : "용어 추가"}</h2><button type="button" class="btn btn-ghost" data-close aria-label="닫기">닫기</button></header><div class="term-edit-body"><p class="muted">${local ? `이 문서 · ${esc(v?.document.title)}` : "프로젝트 공통"}${stale ? " · 원문 또는 표점이 변경되었습니다. 등장 구절을 현재 기준 본문과 대조하세요." : ""}</p><div class="term-edit-grid">${field("sourceForm", "원문 표현", entry?.sourceForm)}<label class="term-edit-field">분류<select name="kind">${Object.entries(kinds).map(([val, label]) => `<option value="${val}" ${(entry?.kind ?? "concept") === val ? "selected" : ""}>${label}</option>`).join("")}</select></label>${field("reading", "독음", entry?.reading)}${field("translation", "권장 번역어", entry?.translation)}</div>${field("definition", "일반적인 뜻", entry?.definition, true)}${field("contextNote", "이 글에서의 의미·역할", entry?.contextNote, true)}${local ? field("quote", `실제 등장 구절 · ${v ? termSource(v).label : "원문"} 그대로`, entry?.occurrences[0]?.quote, true) : ""}${field("selectionReason", "선정 이유", entry?.selectionReason)}${field("uncertainty", "추가 확인이 필요한 점", entry?.uncertainty, true)}${field("evidence", "근거 · 한 줄에 하나", entry?.evidence.map(e => e.citation + (e.url ? " " + e.url : "")).join("\n"), true)}${local ? `<label class="term-edit-field">연결된 공통 용어<select name="parentTermId"><option value="">연결 없음</option>${entries.filter(t => !t.documentId).map(t => `<option value="${esc(t.id)}" ${entry?.parentTermId === t.id ? "selected" : ""}>${esc(t.sourceForm)} · ${esc(t.definition || t.translation || "")}</option>`).join("")}</select></label>` : ""}<label class="term-edit-field">검토 상태<select name="status">${Object.entries(statuses).map(([val,label]) => `<option value="${val}" ${(entry?.status ?? "draft") === val ? "selected" : ""}>${label}</option>`).join("")}</select></label>${entry?.generation ? `<p class="muted">AI 초안 · ${esc(entry.generation.model)} · ${esc(entry.createdAt.slice(0, 10))}</p>` : ""}<p data-error role="alert"></p></div><footer>${local && entry ? '<button type="button" class="btn btn-danger" data-delete>용어 삭제</button>' : ""}${local && entry ? '<button type="button" class="btn" data-common>공통 항목으로 복사</button>' : ""}<span class="sp"></span><button type="submit" class="btn btn-primary">저장</button></footer></form>`;
    formDirty = false;
    dialog.querySelector("[data-close]")!.addEventListener("click", close);
    const form = get<HTMLFormElement>("form");
    function input(): SaveTermInput {
      const data = new FormData(form); const text = (name: string) => String(data.get(name) ?? "").trim();
      const quote = text("quote");
      return { id: entry?.id, expectedLockVersion: entry?.lockVersion, documentId: local ? v!.document.id : null, parentTermId: text("parentTermId") || null,
        sourceVersion: local ? termSource(v!).version : null, quotes: local ? [...new Set([quote, ...(entry?.occurrences.filter(o => o.quote === quote || !stale && entry.sourceForm === text("sourceForm")).map(o => o.quote) ?? [])])] : [],
        sourceForm: text("sourceForm"), kind: text("kind") as TermEntry["kind"], reading: text("reading") || null, translation: text("translation") || null,
        definition: text("definition") || null, contextNote: text("contextNote") || null, selectionReason: text("selectionReason") || null, uncertainty: text("uncertainty") || null,
        status: text("status") as TermEntry["status"], evidence: text("evidence").split("\n").filter(Boolean).map(line => { const url = line.match(/https?:\/\/\S+$/)?.[0] ?? null; return { citation: url ? line.slice(0, -url.length).trim() : line, url }; }) };
    }
    async function save(common = false) {
      if (saving) return; saving = true;
      form.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = true; });
      try {
        const value = input();
        // Promotion copies the reusable definition, retaining contextual interpretation locally.
        unwrap(await (common ? api.terms.promote(value) : api.terms.save(value))); formDirty = false; dialog.close(); await load(true); options.changed?.();
      } catch (error) { get("[data-error]").textContent = error instanceof Error ? error.message : "저장하지 못했습니다."; }
      finally { saving = false; form.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = false; }); }
    }
    form.querySelector("[data-delete]")?.addEventListener("click", async () => {
      if (saving || !entry) return;
      if (!window.confirm(`‘${entry.sourceForm}’ 용어를 이 문서에서 삭제할까요?${formDirty ? " 저장하지 않은 수정도 버립니다." : ""} 연결된 공통 용어는 유지됩니다.`)) return;
      saving = true;
      form.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = true; });
      try {
        unwrap(await api.terms.delete({ id: entry.id, expectedLockVersion: entry.lockVersion }));
        formDirty = false; dialog.close(); await load(true); options.changed?.();
        notify("문서 용어를 삭제했습니다.", "용어");
      } catch (error) { get("[data-error]").textContent = error instanceof Error ? error.message : "삭제하지 못했습니다."; }
      finally { saving = false; form.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = false; }); }
    });
    form.addEventListener("submit", e => { e.preventDefault(); void save(); });
    form.querySelector("[data-common]")?.addEventListener("click", () => void save(true));
    if (!dialog.open) dialog.showModal();
  }
  host.addEventListener("click", event => {
    const target = event.target as Element;
    if (target.closest("[data-term-generate]") && linkedReview.beforeChange()) { render(); void generationPopup.open(); }
    if (target.closest("[data-term-cancel]") && run) void api.terms.cancel(run.id).then(result => { run = unwrap(result); window.clearTimeout(timer); message = "용어 추출을 취소했습니다."; render(); }).catch(error => notify(String(error), "용어"));
    if (target.closest("[data-term-refresh]") && linkedReview.beforeChange()) void load(true);
    if (target.closest("[data-term-add]") && linkedReview.beforeChange()) { render(); void edit(); }
    const id = target.closest<HTMLElement>("[data-term-id]")?.dataset.termId;
    if (id) void edit(entries.find(e => e.id === id));
  });
  host.addEventListener("input", event => {
    const el = event.target as HTMLInputElement;
    if (!el.matches("[data-term-query]")) return;
    if (!linkedReview.beforeChange()) { el.value = query; return; }
    query = el.value;
    if (source()) linkedReview.filter(filteredEntries());
    else { const position = el.selectionStart; render(); const next = host.querySelector<HTMLInputElement>("[data-term-query]")!; next.focus(); next.setSelectionRange(position, position); }
  });
  host.addEventListener("change", event => {
    const el = event.target as HTMLSelectElement;
    if (!el.matches("[data-term-filter]")) return;
    if (!linkedReview.beforeChange()) { el.value = filter; return; }
    filter = el.value;
    if (source()) linkedReview.filter(filteredEntries());
    else { render(); host.querySelector<HTMLSelectElement>("[data-term-filter]")?.focus(); }
  });
  window.addEventListener("beforeunload", event => { if (formDirty || saving || linkedReview.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ""; } });
  return { load, prepareRefresh, hasUnsavedChanges: () => formDirty || saving || linkedReview.hasUnsavedChanges(), isBusy: busy };
}
