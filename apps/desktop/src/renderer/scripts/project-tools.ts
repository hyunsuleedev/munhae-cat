import { t, uiText, ui } from "./i18n";
import type {
  ConfirmedExportFormat,
  KnowledgeView,
  MunhaeApi,
  SearchEntityType,
  SearchResult,
  TranslationExportFormat,
} from "../../shared/munhae-api";

export type ProjectToolsDeps = {
  api: MunhaeApi;
  escape(value: unknown): string;
  notify(message: string, title?: string): void;
  currentDocumentId(): string | null;
  openDocument(documentNodeId: string): void;
};

let deps: ProjectToolsDeps | null = null;
let searchKnowledge: KnowledgeView | null = null;
/** Set by the page that opened the export dialog; false blocks the export. */
let beforeExport: (() => boolean) | null = null;

function must<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

function searchEntityOptions(type: SearchEntityType): Array<{ id: string; label: string }> {
  if (!searchKnowledge || type !== "term") return [];
  return searchKnowledge.terms.map((term) => ({
    id: term.id,
    label: term.translation ? `${term.sourceForm} → ${term.translation}` : term.sourceForm,
  }));
}

function renderSearchEntityOptions(): void {
  const type = must<HTMLSelectElement>("#projectSearchEntityType").value as SearchEntityType | "";
  const select = must<HTMLSelectElement>("#projectSearchEntity");
  const selected = select.value;
  if (!type) {
    select.innerHTML = uiText('<option value="">필터 없음</option>');
    select.disabled = true;
    return;
  }
  if (!searchKnowledge) {
    select.innerHTML = uiText('<option value="">지식 항목 불러오는 중…</option>');
    select.disabled = true;
    return;
  }
  const options = searchEntityOptions(type);
  select.innerHTML = [
    uiText('<option value="">항목 선택…</option>'),
    ...options.map((entry) => `<option value="${deps?.escape(entry.id) ?? ""}">${deps?.escape(entry.label) ?? ""}</option>`),
  ].join("");
  select.disabled = false;
  if (options.some((entry) => entry.id === selected)) select.value = selected;
}

async function loadSearchEntities(): Promise<void> {
  if (!deps) return;
  const activeDeps = deps;
  searchKnowledge = null;
  renderSearchEntityOptions();
  const result = await activeDeps.api.knowledge.get();
  if (deps !== activeDeps) return;
  if (!result.ok) {
    must("#projectSearchStatus").textContent = ui`지식 필터를 불러오지 못했습니다: ${result.error.message}`;
    return;
  }
  searchKnowledge = result.data;
  renderSearchEntityOptions();
}

function installDialogs(): void {
  if (document.querySelector("#dlgProjectSearch")) return;
  document.body.insertAdjacentHTML(
    "beforeend",
    uiText(`<dialog id="dlgProjectSearch" style="width:min(780px,calc(100vw - 48px));max-height:calc(100vh - 64px)">
      <form id="projectSearchForm">
        <div class="dl-h">프로젝트 내용 검색</div>
        <div class="dl-b" style="display:grid;gap:12px">
          <div class="row" style="gap:8px;align-items:end;flex-wrap:wrap">
            <div class="field" style="flex:1;min-width:220px"><label for="projectSearchQuery">원문·한국어 번역</label><input class="input" id="projectSearchQuery" maxlength="500" required placeholder="정확한 구절 또는 검색어"></div>
            <div class="field"><label for="projectSearchScope">범위</label><select class="select" id="projectSearchScope"><option value="all">원문 + 번역</option><option value="source">원문</option><option value="translation">한국어 번역</option></select></div>
            <div class="field"><label for="projectSearchState">버전</label><select class="select" id="projectSearchState"><option value="current">현재 작업안</option><option value="confirmed">확정본</option><option value="all">모든 이력</option></select></div>
          </div>
          <div class="row" style="gap:8px;align-items:end;flex-wrap:wrap">
            <div class="field"><label for="projectSearchEntityType">지식 필터</label><select class="select" id="projectSearchEntityType"><option value="">필터 없음</option><option value="term">용어</option></select></div>
            <div class="field" style="flex:1;min-width:240px"><label for="projectSearchEntity">항목</label><select class="select" id="projectSearchEntity" disabled><option value="">필터 없음</option></select></div>
          </div>
          <label class="check" id="projectSearchCurrentWrap"><input type="checkbox" id="projectSearchCurrent"> 현재 문서에서만</label>
          <p class="muted" id="projectSearchStatus" style="font-size:12px">원문과 번역에서 구절을 찾습니다. 이전 버전을 포함해 검색할 수도 있습니다.</p>
          <div class="list" id="projectSearchResults" style="max-height:min(430px,55vh);overflow:auto"></div>
        </div>
        <div class="dl-f"><button class="btn" id="projectSearchClose" type="button">닫기</button><button class="btn btn-primary" id="projectSearchRun" type="submit">검색</button></div>
      </form>
    </dialog>`),
  );
  // Option group labels are attributes that uiText leaves alone.
  document.body.insertAdjacentHTML(
    "beforeend",
    ui`<dialog id="dlgExport" style="width:min(520px,calc(100vw - 48px))">
      <form id="exportForm">
        <div class="dl-h">내보내기</div>
        <div class="dl-b" style="display:grid;gap:12px">
          <div class="field"><label for="exportFormat">형식</label><select class="select" id="exportFormat">
            <optgroup label="${t("번역본")}"><option value="docx">Word 문서 (.docx)</option><option value="pdf">PDF (.pdf)</option><option value="txt">텍스트 (.txt)</option><option value="markdown">Markdown (.md)</option></optgroup>
            <optgroup label="${t("확정 기록 보관")}"><option value="record:markdown">검증용 Markdown (.md)</option><option value="record:json">JSON (.json)</option><option value="record:csv">CSV (.csv)</option></optgroup>
          </select></div>
          <div class="row" id="exportDocumentOptions" style="gap:8px;align-items:end;flex-wrap:wrap">
            <div class="field" style="flex:1;min-width:180px"><label for="exportLayout">구성</label><select class="select" id="exportLayout"><option value="translation">번역문만</option><option value="bilingual">원문·번역 대역</option></select></div>
            <div class="field" style="flex:1;min-width:180px"><label for="exportState">번역 버전</label><select class="select" id="exportState"><option value="current">현재 저장본 — 작업안 포함</option><option value="confirmed">확정본만</option></select></div>
          </div>
          <div class="field"><label for="exportScope">범위</label><select class="select" id="exportScope"><option value="project">프로젝트 전체</option><option value="document">현재 문서</option></select></div>
          <p class="muted" id="exportBilingualHelp" style="font-size:12px" hidden>번역 문단마다 연결된 원문을 나란히 놓습니다.</p>
          <div id="exportRecordHelp" style="display:grid;gap:8px" hidden>
            <p>선택한 범위의 확정 번역을 내보냅니다. 작성 중인 작업안은 포함하지 않습니다.</p>
            <details class="muted" style="font-size:12px"><summary>함께 보관되는 기록</summary><p>번역에 사용된 원문·표점·번역 원칙과 문장 연결 기록을 포함합니다. 각 자료의 버전 식별자와 해시도 보존합니다.</p></details>
          </div>
          <p id="exportError" class="prep-run-error" role="alert" hidden></p>
        </div>
        <div class="dl-f"><button class="btn" id="exportClose" type="button">취소</button><button class="btn btn-primary" id="exportRun" type="submit">저장 위치 선택…</button></div>
      </form>
    </dialog>`,
  );

  must("#projectSearchClose").addEventListener("click", () => must<HTMLDialogElement>("#dlgProjectSearch").close());
  must<HTMLFormElement>("#projectSearchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void runSearch();
  });
  must("#projectSearchEntityType").addEventListener("change", renderSearchEntityOptions);
  must("#projectSearchResults").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-search-document]");
    if (!button?.dataset.searchDocument || !deps) return;
    must<HTMLDialogElement>("#dlgProjectSearch").close();
    deps.openDocument(button.dataset.searchDocument);
  });
  must("#exportClose").addEventListener("click", () => must<HTMLDialogElement>("#dlgExport").close());
  must<HTMLFormElement>("#exportForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void runExport();
  });
  for (const id of ["#exportFormat", "#exportLayout"]) must(id).addEventListener("change", syncExportOptions);
}

function syncExportOptions(): void {
  const record = must<HTMLSelectElement>("#exportFormat").value.startsWith("record:");
  must("#exportDocumentOptions").hidden = record;
  must("#exportRecordHelp").hidden = !record;
  must("#exportBilingualHelp").hidden = record || must<HTMLSelectElement>("#exportLayout").value !== "bilingual";
}

function resultLabel(result: SearchResult): string {
  if (result.resultKind === "source") return ui`원문 V${result.versionNo}`;
  return ui`번역 v${result.versionNo}`;
}

async function runSearch(): Promise<void> {
  if (!deps) return;
  const query = must<HTMLInputElement>("#projectSearchQuery").value.trim();
  if (!query) return;
  const button = must<HTMLButtonElement>("#projectSearchRun");
  const status = must("#projectSearchStatus");
  button.disabled = true;
  button.textContent = t("검색 중…");
  status.textContent = t("저장된 원문과 번역에서 찾고 있습니다…");
  try {
    const currentOnly = must<HTMLInputElement>("#projectSearchCurrent").checked;
    const entityType = must<HTMLSelectElement>("#projectSearchEntityType").value as SearchEntityType | "";
    const entityId = must<HTMLSelectElement>("#projectSearchEntity").value;
    const result = await deps.api.project.search({
      query,
      scope: must<HTMLSelectElement>("#projectSearchScope").value as "all" | "source" | "translation",
      state: must<HTMLSelectElement>("#projectSearchState").value as "current" | "confirmed" | "all",
      documentNodeId: currentOnly ? deps.currentDocumentId() : null,
      entityFilter: entityType && entityId ? { entityType, entityId } : null,
      limit: 100,
    });
    if (!result.ok) {
      status.textContent = result.error.message;
      must("#projectSearchResults").innerHTML = "";
      return;
    }
    const entityLabel = result.data.entityFilter ? ui` · ${result.data.entityFilter.label} 필터` : "";
    status.textContent = ui`${result.data.results.length}건${entityLabel}${result.data.results.length >= 100 ? t(" · 최대 100건까지 표시합니다") : ""}`;
    must("#projectSearchResults").innerHTML = result.data.results.length
      ? result.data.results.map((item) => {
          const state = item.isConfirmed ? t("확정") : item.isCurrent ? t("현재") : t("이력");
          return ui`<article class="li" style="display:grid;gap:7px;padding:12px;border:1px solid var(--border);border-radius:7px;background:var(--panel)">
            <button type="button" data-search-document="${deps!.escape(item.documentNodeId)}" style="width:100%;text-align:left;display:grid;gap:7px;padding:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer">
              <span class="row" style="gap:6px"><b>${deps!.escape(item.documentTitle)}</b><span class="tag ${item.isConfirmed ? "tag-ok" : "tag-plain"}">${state}</span><span class="tag tag-line">${deps!.escape(resultLabel(item))}</span></span>
              <span>${deps!.escape(item.snippet)}</span>
              <span class="muted" style="font-size:11.5px">${item.isCurrent ? t("현재 문서 열기 →") : t("이전 버전의 검색 결과입니다. 누르면 현재 문서가 열립니다. →")}</span>
            </button>
            <details class="muted" style="font-size:10.5px"><summary>검색 기록 정보</summary><div style="overflow-wrap:anywhere;margin-top:6px">버전 식별자: ${deps!.escape(item.versionId)}<br>내용 해시: ${deps!.escape(item.contentHash)}</div></details>
          </article>`;
        }).join("")
      : uiText('<p class="muted" style="padding:18px;text-align:center">조건에 맞는 원문·번역이 없습니다.</p>');
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : t("검색하지 못했습니다.");
  } finally {
    button.disabled = false;
    button.textContent = t("검색");
  }
}

async function runExport(): Promise<void> {
  if (!deps) return;
  const button = must<HTMLButtonElement>("#exportRun");
  const errorBox = must("#exportError");
  errorBox.hidden = true;
  const format = must<HTMLSelectElement>("#exportFormat").value;
  const documentNodeId = must<HTMLSelectElement>("#exportScope").value === "document" ? deps.currentDocumentId() : null;
  if (beforeExport && !beforeExport()) {
    errorBox.textContent = t("편집 중인 내용을 저장한 뒤 다시 내보내세요.");
    errorBox.hidden = false;
    return;
  }
  button.disabled = true;
  button.textContent = t("준비 중…");
  try {
    if (format.startsWith("record:")) {
      const result = await deps.api.project.exportConfirmed({ format: format.slice("record:".length) as ConfirmedExportFormat, documentNodeId });
      if (!result.ok) throw new Error(result.error.message);
      if (!result.data) return;
      must<HTMLDialogElement>("#dlgExport").close();
      deps.notify(ui`${result.data.confirmedTranslationCount}개 확정 번역을 저장했습니다.\n${result.data.filePath}`, t("내보내기"));
      return;
    }
    const result = await deps.api.project.exportTranslation({
      format: format as TranslationExportFormat,
      layout: must<HTMLSelectElement>("#exportLayout").value === "bilingual" ? "bilingual" : "translation",
      state: must<HTMLSelectElement>("#exportState").value === "confirmed" ? "confirmed" : "current",
      documentNodeId,
    });
    if (!result.ok) throw new Error(result.error.message);
    if (!result.data) return;
    must<HTMLDialogElement>("#dlgExport").close();
    deps.notify(ui`${result.data.documentCount}개 문서의 번역본을 저장했습니다.\n${result.data.filePath}`, t("내보내기"));
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : t("내보내지 못했습니다.");
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = t("저장 위치 선택…");
  }
}

export function configureProjectTools(next: ProjectToolsDeps): void {
  deps = next;
  installDialogs();
}

export function openProjectSearch(): void {
  installDialogs();
  const current = deps?.currentDocumentId() ?? null;
  const wrap = must("#projectSearchCurrentWrap");
  const checkbox = must<HTMLInputElement>("#projectSearchCurrent");
  wrap.hidden = !current;
  checkbox.checked = false;
  checkbox.disabled = !current;
  must<HTMLSelectElement>("#projectSearchEntityType").value = "";
  renderSearchEntityOptions();
  void loadSearchEntities();
  const selected = window.getSelection()?.toString().trim().slice(0, 500) ?? "";
  if (selected && !selected.includes("\n")) must<HTMLInputElement>("#projectSearchQuery").value = selected;
  must<HTMLDialogElement>("#dlgProjectSearch").showModal();
  must<HTMLInputElement>("#projectSearchQuery").focus();
}

/** From a document, the export starts scoped to it; `guard` returns false while edits are unsaved. */
export function openExport(options: { guard?: () => boolean } = {}): void {
  installDialogs();
  const dialog = must<HTMLDialogElement>("#dlgExport");
  if (dialog.open) return;
  beforeExport = options.guard ?? null;
  const current = deps?.currentDocumentId() ?? null;
  const scope = must<HTMLSelectElement>("#exportScope");
  const documentOption = [...scope.options].find((option) => option.value === "document");
  if (documentOption) documentOption.disabled = !current;
  if (current && options.guard) scope.value = "document";
  else if (!current) scope.value = "project";
  must("#exportError").hidden = true;
  syncExportOptions();
  dialog.showModal();
}
