import { t, ui } from "./i18n";
import type { DocumentListItem, DocumentMetadataView, HomeView } from "../../shared/munhae-api";
import {
  bindSidebar, currentDocId, defaultSidebarTree, esc, go, initShell,
  must, notify, openDocumentDialog, persistDoc, renderSidebar, requireProject, registerProjectRefresh,
  setSelfTitle, setSidebarDocs, projectLocationLabel,
} from "./shared";
import { openExport } from "./project-tools";
import {
  HOME_STAGES, buildHomeGroups, buildHomeSections, homeDocumentPath, homeStage, homeWhen,
  resolveHomeCreationParent, resolveHomeResume,
  type HomeGroup, type HomeStage,
} from "./home-model";

const project = await requireProject();
if (!project) throw new Error("redirect");
const api = initShell({
  page: "home", extraEnabled: ["newdoc", "import", "backup", "export"],
  selfTitle: `${project.title} — ${projectLocationLabel(project)}`, pageCmd, pageKeys,
}).api;

type Activity = HomeView["activity"][number];
let view: HomeView | null = null;
let metadata: DocumentMetadataView | null = null;
let metadataFailed = false;
let activity = new Map<string, Activity>();
let sel: string | null = null;
let resumeId: string | null = null;
let loadRevision = 0;
const filters: { query: string; stage: HomeStage | null; sort: "toc" | "recent"; container: string | null } = {
  query: "", stage: null, sort: "toc", container: null,
};
const collapsed = new Set<string>();
const chevron = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
const titleOf = (doc: DocumentListItem): string => doc.originalTitle || doc.title;
const tree = (): ReturnType<typeof defaultSidebarTree> => defaultSidebarTree(view?.documents ?? []);
const sourceUnits = (): DocumentListItem[] => view?.documents.filter(d => d.nodeRole === "source_unit" && !d.isMaster) ?? [];
const master = (): DocumentListItem | undefined => view?.documents.find(d => d.isMaster);
const stageOf = (key: HomeStage) => HOME_STAGES.find(stage => stage.key === key)!;

function renderHeader(): void {
  if (!view) return;
  must("#projectTitle").textContent = view.project.title;
  const period = [metadata?.periodText, metadata?.dateText].filter(Boolean).join(" · ");
  const facts: Array<[string, string]> = [];
  if (metadata?.authorName) facts.push([t("저자"), metadata.authorName]);
  if (period) facts.push([t("시대·시기"), period]);
  if (metadata?.sourceReference) facts.push([t("출전"), metadata.sourceReference]);
  const factList = must("#projectFacts");
  factList.innerHTML = facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
  factList.hidden = !facts.length;
  const description = must("#projectDescription");
  description.textContent = metadata?.descriptionMd?.trim() ?? "";
  description.hidden = !description.textContent;
}

/** The source last worked in, marked in the contents. A project nobody has worked in yet has none. */
function updateResume(): void {
  const resume = view ? resolveHomeResume(view.documents, currentDocId(), view.recent) : null;
  resumeId = resume?.kind === "first" ? null : resume?.document?.id ?? null;
}

function renderTools(): void {
  const docs = sourceUnits();
  must("#tocTools").hidden = !docs.length;
  const counts = new Map(HOME_STAGES.map(stage => [stage.key, docs.filter(doc => homeStage(doc) === stage.key).length]));
  if (filters.stage && !counts.get(filters.stage)) filters.stage = null;
  must("#stageFilters").innerHTML = [...HOME_STAGES].reverse().map(stage => {
    const count = counts.get(stage.key) ?? 0;
    const label = t(stage.label);
    return `<li><button type="button" data-stage-filter="${stage.key}" aria-pressed="${filters.stage === stage.key}"${count ? "" : " disabled"} aria-label="${esc(ui`${label} ${count}개 보기`)}">`
      + `<span class="toc-mark toc-stage-${stage.key}" aria-hidden="true">${stage.mark}</span>${esc(label)}<b>${count}</b></button></li>`;
  }).join("");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-sort]")) {
    button.setAttribute("aria-pressed", String(button.dataset.sort === filters.sort));
  }
  const container = filters.container ? view?.documents.find(doc => doc.id === filters.container) : undefined;
  const chip = must("#scopeChip");
  chip.hidden = !container;
  chip.innerHTML = container
    ? `<span>${esc(titleOf(container))}</span><button type="button" data-clear-scope aria-label="${esc(ui`${titleOf(container)} 범위 해제`)}">×</button>`
    : "";
}

function belongsTo(doc: DocumentListItem, containerId: string): boolean {
  const seen = new Set<string>();
  let id = doc.parentId;
  while (id && !seen.has(id)) {
    if (id === containerId) return true;
    seen.add(id); id = view?.documents.find(d => d.id === id)?.parentId ?? null;
  }
  return false;
}
function matches(doc: DocumentListItem): boolean {
  if (filters.stage && homeStage(doc) !== filters.stage) return false;
  if (filters.container && !belongsTo(doc, filters.container)) return false;
  if (!filters.query) return true;
  const query = filters.query.toLocaleLowerCase();
  return `${doc.title} ${doc.originalTitle ?? ""} ${homeDocumentPath(doc, view!.documents)}`.toLocaleLowerCase().includes(query);
}
/** The path below the chapter heading, so nested folders stay visible inside one group. */
function subPathOf(doc: DocumentListItem, group: HomeGroup): string {
  const path = homeDocumentPath(doc, view!.documents);
  const prefix = `${group.title} › `;
  return path === group.title ? "" : path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function lineHtml(doc: DocumentListItem, number: string, subPath: string): string {
  const entry = activity.get(doc.id);
  const stage = stageOf(homeStage(doc));
  // Ledger facts sit where a printed contents page puts its page numbers.
  const version = entry?.translationVersion ? `v${entry.translationVersion}` : doc.punctuationState === "draft" ? t("초안") : "";
  const when = entry?.lastActivityAt ? homeWhen(entry.lastActivityAt) : "";
  const resume = doc.id === resumeId;
  const summary = [t(stage.label), version, when].filter(Boolean).join(" · ");
  const label = `${titleOf(doc)}${subPath ? ` (${subPath})` : ""} — ${summary}${resume ? `, ${t("지난 작업")}` : ""}`;
  return `<li class="toc-entry${resume ? " is-resume" : ""}">`
    + `<button class="toc-line" type="button" data-open-doc="${esc(doc.id)}" title="${esc(summary)}" aria-label="${esc(label)}">`
    + `<span class="toc-no" aria-hidden="true">${esc(number)}</span>`
    + `<span class="toc-name" aria-hidden="true"><span class="toc-doc">${esc(titleOf(doc))}</span>${subPath ? `<small>${esc(subPath)}</small>` : ""}</span>`
    + '<span class="toc-leader" aria-hidden="true"></span>'
    + `<span class="toc-ver${entry?.translationVersion ? "" : " is-draft"}" aria-hidden="true">${esc(version)}</span>`
    + `<span class="toc-when" aria-hidden="true">${esc(when)}</span>`
    + `<span class="toc-mark toc-stage-${stage.key}" aria-hidden="true">${stage.mark}</span>`
    + "</button></li>";
}

function renderContents(): void {
  if (!view) return;
  const body = must("#docBody");
  const docs = sourceUnits();
  if (!docs.length) {
    body.innerHTML = `<div class="toc-empty"><p>${esc(t("아직 원문이 없습니다"))}</p><button class="btn btn-primary" type="button" data-add-source>${esc(t("원문 추가"))}</button></div>`;
    must("#tocStatus").textContent = "";
    return;
  }
  const filtering = !!(filters.query || filters.stage || filters.container);
  let shown = 0;
  let html = "";
  if (filters.sort === "recent") {
    const lastAt = (doc: DocumentListItem) => activity.get(doc.id)?.lastActivityAt ?? "";
    const list = docs.filter(matches).sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
    shown = list.length;
    if (list.length) html = `<ol class="toc-list">${list.map(doc => lineHtml(doc, "", homeDocumentPath(doc, view!.documents))).join("")}</ol>`;
  } else {
    for (const section of buildHomeSections(view.documents)) {
      if (section.kind === "loose") {
        const list = section.documents.filter(matches);
        shown += list.length;
        if (list.length) html += `<ol class="toc-list">${list.map(doc => lineHtml(doc, "", "")).join("")}</ol>`;
        continue;
      }
      const group = section.group;
      const list = group.documents.filter(matches);
      shown += list.length;
      if (filtering && !list.length) continue;
      const open = filtering || !collapsed.has(group.id);
      const confirmed = group.documents.filter(doc => homeStage(doc) === "confirmed").length;
      const count = group.documents.length
        ? `<span class="toc-group-count" aria-label="${esc(ui`확정 ${confirmed} / 전체 ${group.documents.length}`)}"><b>${confirmed}</b> / ${group.documents.length}</span>`
        : "";
      const lines = list.length
        ? `<ol class="toc-list">${list.map(doc => lineHtml(doc, String(group.documents.indexOf(doc) + 1), subPathOf(doc, group))).join("")}</ol>`
        : `<p class="toc-empty-group">${esc(t("원문 없음"))}</p>`;
      html += `<section class="toc-group" aria-labelledby="g-${esc(group.id)}">`
        + `<h3 class="toc-group-heading" id="g-${esc(group.id)}"><button class="toc-group-toggle" type="button" data-toggle-group="${esc(group.id)}" aria-expanded="${open}"${filtering ? " disabled" : ""}>${chevron}<span class="toc-group-title">${esc(group.title)}</span></button>${count}</h3>`
        + `${open ? lines : ""}</section>`;
    }
  }
  body.innerHTML = html
    || `<div class="toc-empty"><p>${esc(t("조건에 맞는 원문이 없습니다"))}</p><button class="btn btn-sm" type="button" data-reset-filters>${esc(t("필터 초기화"))}</button></div>`;
  must("#tocStatus").textContent = filtering ? ui`원문 ${shown}개` : "";
}

function renderList(): void { renderTools(); renderContents(); }
function clearFilters(): void {
  filters.query = ""; filters.stage = null; filters.container = null;
  must<HTMLInputElement>("#q").value = "";
  renderList();
}
function creationParent(explicitParentId?: string | null): string | null {
  return resolveHomeCreationParent(view?.documents ?? [], { explicitParentId, containerId: filters.container, selectedId: sel });
}
function openNewSource(parentId?: string | null): void {
  void openDocumentDialog(creationParent(parentId));
}
function openDoc(id: string): void {
  if (!view?.documents.some(doc => doc.id === id && doc.nodeRole === "source_unit")) return;
  persistDoc(id); go("editor", id);
}
function pageCmd(id: string): boolean {
  switch (id) {
    case "newdoc": openNewSource(); return true;
    case "export": openExport(); return true;
    case "import": void openDocumentDialog(creationParent(), true); return true;
    case "find": {
      if (must("#tocTools").hidden) return true;
      const input = must<HTMLInputElement>("#q");
      input.focus(); input.select();
      return true;
    }
  }
  return false;
}
function pageKeys(e: KeyboardEvent, m: boolean): void {
  if (m && !e.shiftKey && !e.altKey && e.code === "KeyN") { e.preventDefault(); openNewSource(); }
  else if (m && !e.shiftKey && e.code === "KeyE") { e.preventDefault(); openExport(); }
}
function showError(message: string): void {
  must("#homeErrorText").textContent = message; must("#homeError").hidden = false;
}
async function prepareHomeRefresh(strict = false): Promise<() => void> {
  const result = await api.home.get();
  if (!result.ok) throw new Error(result.error.message);
  const next = result.data;
  const root = next.documents.find(doc => doc.isMaster);
  const [metaResult] = await Promise.allSettled([root ? api.home.getDocumentMetadata(root.id) : Promise.resolve(null)]);
  if (strict) {
    if (metaResult.status === "rejected") throw metaResult.reason;
    if (metaResult.value && !metaResult.value.ok) throw new Error(metaResult.value.error.message);
  }
  return () => {
    view = next;
    activity = new Map(next.activity.map(entry => [entry.documentId, entry]));
    metadata = metaResult.status === "fulfilled" && metaResult.value?.ok ? metaResult.value.data : null;
    metadataFailed = metaResult.status === "rejected" || (metaResult.status === "fulfilled" && metaResult.value !== null && !metaResult.value.ok);
    setSidebarDocs(view.documents);
    const remembered = sel ?? currentDocId();
    sel = view.documents.some(doc => doc.id === remembered) ? remembered : master()?.id ?? null;
    if (filters.container && !view.documents.some(doc => doc.id === filters.container)) filters.container = null;
    must("#tbTitle").textContent = view.project.title;
    must("#tbSub").textContent = t("— 프로젝트 서재");
    must("#projectStorageMode").textContent = t(view.project.storageMode === "online" ? "온라인 프로젝트" : "로컬 프로젝트");
    must("#homeSaveLabel").textContent = t(view.project.storageMode === "online" ? "온라인 저장됨 " : "저장됨 ");
    must("#sbPath").textContent = projectLocationLabel(view.project);
    setSelfTitle(`${view.project.title} — ${projectLocationLabel(view.project)}`);
    renderSidebar(tree(), { currentDocId: sel });
    updateResume(); renderHeader(); renderList();
    must("#homeError").hidden = true;
    if (metadataFailed) showError(t("프로젝트 소개를 불러오지 못했습니다. 문서 작업은 계속할 수 있습니다."));
  };
}
async function load(): Promise<void> {
  const revision = ++loadRevision;
  must("#homeStudy").setAttribute("aria-busy", "true"); must("#homeError").hidden = true;
  try {
    const apply = await prepareHomeRefresh();
    if (revision === loadRevision) apply();
  } catch (error) {
    if (revision !== loadRevision) return;
    showError(error instanceof Error ? error.message : t("프로젝트를 불러오지 못했습니다."));
    if (!view) must("#projectTitle").textContent = t("프로젝트를 불러오지 못했습니다");
  } finally {
    if (revision === loadRevision) must("#homeStudy").setAttribute("aria-busy", "false");
  }
}

must<HTMLInputElement>("#q").addEventListener("input", event => {
  filters.query = (event.target as HTMLInputElement).value.trim(); renderContents();
});
must<HTMLInputElement>("#q").addEventListener("keydown", event => {
  if (event.key === "Escape" && filters.query) { event.preventDefault(); clearFilters(); }
});
must("#btnNewDoc").addEventListener("click", () => openNewSource());
must("#btnRetryHome").addEventListener("click", () => void load());
must("#btnBackup").addEventListener("click", () => {
  void api.project.backup().then(result => {
    if (!result.ok) notify(result.error.message, t("백업"));
    else if (result.data) notify(ui`백업을 저장했습니다 · ${result.data}`, t("백업"));
  }).catch(() => notify(t("백업을 저장하지 못했습니다."), t("백업")));
});
must("#btnExport").addEventListener("click", () => openExport());
must("#homeStudy").addEventListener("click", event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("button, a");
  if (!target) return;
  if (target.dataset.openDoc) openDoc(target.dataset.openDoc);
  else if (target.dataset.stageFilter) {
    filters.stage = filters.stage === target.dataset.stageFilter ? null : target.dataset.stageFilter as HomeStage;
    renderList();
  } else if (target.dataset.sort) {
    filters.sort = target.dataset.sort === "recent" ? "recent" : "toc";
    renderList();
  } else if (target.dataset.toggleGroup) {
    const id = target.dataset.toggleGroup;
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    renderContents();
    document.querySelector<HTMLElement>(`[data-toggle-group="${CSS.escape(id)}"]`)?.focus();
  } else if (target.hasAttribute("data-clear-scope")) { filters.container = null; renderList(); }
  else if (target.hasAttribute("data-add-source")) openNewSource();
  else if (target.hasAttribute("data-reset-filters")) clearFilters();
});
must("#docBody").addEventListener("keydown", event => {
  const line = (event.target as HTMLElement).closest<HTMLElement>(".toc-line");
  if (!line || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const lines = [...document.querySelectorAll<HTMLElement>("#docBody .toc-line")];
  const index = lines.indexOf(line);
  const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: lines.length - 1 }[event.key]!;
  if (lines[next]) { event.preventDefault(); lines[next].focus(); }
});
bindSidebar(id => {
  sel = id;
  const doc = view?.documents.find(item => item.id === id);
  if (doc?.nodeRole === "source_unit") { openDoc(id); return; }
  clearFilters();
  if (!doc || doc.isMaster || !view) { must("#homeScroll").scrollTo({ top: 0 }); return; }
  const group = buildHomeGroups(view.documents).find(item => item.containerId === doc.id);
  if (group) {
    collapsed.delete(group.id); renderContents();
    document.getElementById(`g-${group.id}`)?.scrollIntoView({ block: "start" });
    return;
  }
  // Nested folders narrow the contents instead of hunting for their lines inside a chapter.
  filters.container = doc.id; renderList();
  must("#tocTools").scrollIntoView({ block: "start" });
}, tree, (parentId, role) => { void openDocumentDialog(creationParent(parentId), false, role); }, { selectExpandable: true });
window.addEventListener("munhae:document-created", () => void load());
window.addEventListener("pageshow", event => { if (event.persisted) void load(); });
await load();
registerProjectRefresh({ blocked: () => must("#homeStudy").getAttribute("aria-busy") === "true", version: () => loadRevision, prepare: () => prepareHomeRefresh(true) });
