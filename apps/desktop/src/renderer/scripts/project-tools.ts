import type {
  ConfirmedExportFormat,
  KnowledgeView,
  MunhaeApi,
  SearchEntityType,
  SearchResult,
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

function must<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

function searchEntityOptions(type: SearchEntityType): Array<{ id: string; label: string }> {
  if (!searchKnowledge) return [];
  if (type === "glossary") {
    return searchKnowledge.glossary.map((entry) => ({
      id: entry.id,
      label: `${entry.sourceTerm} → ${entry.targetTerm}`,
    }));
  }
  const rows = type === "person" ? searchKnowledge.persons : searchKnowledge.places;
  return rows.map((entry) => ({
    id: entry.id,
    label: entry.hanjaName && entry.hanjaName !== entry.preferredName
      ? `${entry.preferredName} (${entry.hanjaName})`
      : entry.preferredName,
  }));
}

function renderSearchEntityOptions(): void {
  const type = must<HTMLSelectElement>("#projectSearchEntityType").value as SearchEntityType | "";
  const select = must<HTMLSelectElement>("#projectSearchEntity");
  const selected = select.value;
  if (!type) {
    select.innerHTML = '<option value="">필터 없음</option>';
    select.disabled = true;
    return;
  }
  if (!searchKnowledge) {
    select.innerHTML = '<option value="">지식 항목 불러오는 중…</option>';
    select.disabled = true;
    return;
  }
  const options = searchEntityOptions(type);
  select.innerHTML = [
    '<option value="">항목 선택…</option>',
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
    must("#projectSearchStatus").textContent = `지식 필터를 불러오지 못했습니다: ${result.error.message}`;
    return;
  }
  searchKnowledge = result.data;
  renderSearchEntityOptions();
}

function installDialogs(): void {
  if (document.querySelector("#dlgProjectSearch")) return;
  document.body.insertAdjacentHTML(
    "beforeend",
    `<dialog id="dlgProjectSearch" style="width:min(780px,calc(100vw - 48px));max-height:calc(100vh - 64px)">
      <form id="projectSearchForm">
        <div class="dl-h">프로젝트 내용 검색</div>
        <div class="dl-b" style="display:grid;gap:12px">
          <div class="row" style="gap:8px;align-items:end;flex-wrap:wrap">
            <div class="field" style="flex:1;min-width:220px"><label for="projectSearchQuery">원문·한국어 번역</label><input class="input" id="projectSearchQuery" maxlength="500" required placeholder="정확한 구절 또는 검색어"></div>
            <div class="field"><label for="projectSearchScope">범위</label><select class="select" id="projectSearchScope"><option value="all">원문 + 번역</option><option value="source">원문</option><option value="translation">한국어 번역</option></select></div>
            <div class="field"><label for="projectSearchState">버전</label><select class="select" id="projectSearchState"><option value="current">현재 작업안</option><option value="confirmed">확정본</option><option value="all">모든 이력</option></select></div>
          </div>
          <div class="row" style="gap:8px;align-items:end;flex-wrap:wrap">
            <div class="field"><label for="projectSearchEntityType">지식 필터</label><select class="select" id="projectSearchEntityType"><option value="">필터 없음</option><option value="glossary">용어</option><option value="person">인물</option><option value="place">지명</option></select></div>
            <div class="field" style="flex:1;min-width:240px"><label for="projectSearchEntity">항목</label><select class="select" id="projectSearchEntity" disabled><option value="">필터 없음</option></select></div>
          </div>
          <label class="check" id="projectSearchCurrentWrap"><input type="checkbox" id="projectSearchCurrent"> 현재 문서에서만</label>
          <p class="muted" id="projectSearchStatus" style="font-size:12px">원문·번역 exact 검색과 SQLite FTS를 함께 사용하며, 1–2자 한자는 prefix 인덱스도 적용합니다.</p>
          <div class="list" id="projectSearchResults" style="max-height:min(430px,55vh);overflow:auto"></div>
        </div>
        <div class="dl-f"><button class="btn" id="projectSearchClose" type="button">닫기</button><button class="btn btn-primary" id="projectSearchRun" type="submit">검색</button></div>
      </form>
    </dialog>
    <dialog id="dlgConfirmedExport" style="width:min(520px,calc(100vw - 48px))">
      <form id="confirmedExportForm">
        <div class="dl-h">확정 번역 내보내기</div>
        <div class="dl-b" style="display:grid;gap:12px">
          <p>확정 head가 가리키는 번역만 내보냅니다. 미확정 작업안은 포함하지 않습니다.</p>
          <div class="field"><label for="confirmedExportFormat">형식</label><select class="select" id="confirmedExportFormat"><option value="markdown">Markdown (.md)</option><option value="json">JSON (.json)</option><option value="csv">CSV (.csv)</option></select></div>
          <div class="field"><label for="confirmedExportScope">범위</label><select class="select" id="confirmedExportScope"><option value="project">프로젝트 전체</option><option value="document">현재 문서</option></select></div>
          <p class="muted" style="font-size:12px">exact 원문·표점·번역·정책 version ID와 SHA-256, 앵커·블록 연결 metadata를 함께 기록합니다.</p>
          <p id="confirmedExportError" class="prep-run-error" role="alert" hidden></p>
        </div>
        <div class="dl-f"><button class="btn" id="confirmedExportClose" type="button">취소</button><button class="btn btn-primary" id="confirmedExportRun" type="submit">저장 위치 선택…</button></div>
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
  must("#confirmedExportClose").addEventListener("click", () => must<HTMLDialogElement>("#dlgConfirmedExport").close());
  must<HTMLFormElement>("#confirmedExportForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void runExport();
  });
}

function resultLabel(result: SearchResult): string {
  if (result.resultKind === "source") return `원문 V${result.versionNo}`;
  return `번역 v${result.versionNo}`;
}

async function runSearch(): Promise<void> {
  if (!deps) return;
  const query = must<HTMLInputElement>("#projectSearchQuery").value.trim();
  if (!query) return;
  const button = must<HTMLButtonElement>("#projectSearchRun");
  const status = must("#projectSearchStatus");
  button.disabled = true;
  button.textContent = "검색 중…";
  status.textContent = "version 원장에서 검색 인덱스를 다시 만들고 있습니다.";
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
    const searchMode = result.data.usedShortHanPrefix ? "1–2자 한자 prefix + exact" : "SQLite FTS + exact";
    const entityLabel = result.data.entityFilter ? ` · ${result.data.entityFilter.label} 필터` : "";
    status.textContent = `${result.data.results.length}건 · 원장 version에서 재생성한 ${searchMode} 결과${entityLabel}`;
    must("#projectSearchResults").innerHTML = result.data.results.length
      ? result.data.results.map((item) => {
          const state = item.isConfirmed ? "확정" : item.isCurrent ? "현재" : "이력";
          return `<button class="li" type="button" data-search-document="${deps!.escape(item.documentNodeId)}" style="width:100%;text-align:left;display:grid;gap:5px;padding:10px;border:1px solid var(--border);border-radius:7px;background:var(--panel)">
            <span class="row" style="gap:6px"><b>${deps!.escape(item.documentTitle)}</b><span class="tag ${item.isConfirmed ? "tag-ok" : "tag-plain"}">${state}</span><span class="tag tag-line">${deps!.escape(resultLabel(item))}</span><span class="sp"></span><span class="mono muted">${item.matchKind}</span></span>
            <span>${deps!.escape(item.snippet)}</span>
            <span class="mono muted" style="font-size:10.5px">${deps!.escape(item.versionId)} · ${deps!.escape(item.contentHash)}</span>
          </button>`;
        }).join("")
      : '<p class="muted" style="padding:18px;text-align:center">조건에 맞는 원문·번역이 없습니다.</p>';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "검색하지 못했습니다.";
  } finally {
    button.disabled = false;
    button.textContent = "검색";
  }
}

async function runExport(): Promise<void> {
  if (!deps) return;
  const button = must<HTMLButtonElement>("#confirmedExportRun");
  const errorBox = must("#confirmedExportError");
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = "준비 중…";
  try {
    const scope = must<HTMLSelectElement>("#confirmedExportScope").value;
    const result = await deps.api.project.exportConfirmed({
      format: must<HTMLSelectElement>("#confirmedExportFormat").value as ConfirmedExportFormat,
      documentNodeId: scope === "document" ? deps.currentDocumentId() : null,
    });
    if (!result.ok) {
      errorBox.textContent = result.error.message;
      errorBox.hidden = false;
      return;
    }
    if (!result.data) return;
    must<HTMLDialogElement>("#dlgConfirmedExport").close();
    deps.notify(
      `${result.data.confirmedTranslationCount}개 확정 번역을 저장했습니다.\n${result.data.filePath}`,
      "내보내기",
    );
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : "내보내지 못했습니다.";
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "저장 위치 선택…";
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

export function openConfirmedExport(): void {
  installDialogs();
  const current = deps?.currentDocumentId() ?? null;
  const scope = must<HTMLSelectElement>("#confirmedExportScope");
  const documentOption = [...scope.options].find((option) => option.value === "document");
  if (documentOption) documentOption.disabled = !current;
  if (!current && scope.value === "document") scope.value = "project";
  must("#confirmedExportError").hidden = true;
  must<HTMLDialogElement>("#dlgConfirmedExport").showModal();
}
