import type { DocumentListItem, DocumentMetadataView, HomeView, KnowledgeView } from "../../shared/munhae-api";
import {
  bindSidebar, currentDocId, defaultSidebarTree, esc, fmtWhen, go, initShell,
  must, notify, openDocumentDialog, persistDoc, renderSidebar, requireProject,
  setSelfTitle, setSidebarDocs, shortPath, stateLabel, tagHtml,
} from "./shared";
import { openConfirmedExport } from "./project-tools";
import { HOME_STAGES, buildHomeGroups, homeDocumentPath, homeStage, resolveHomeCreationParent, resolveHomeResume, resolveRecentDocument } from "./home-model";

const project = await requireProject();
if (!project) throw new Error("redirect");
const api = initShell({
  page: "home", extraEnabled: ["newdoc", "import", "backup", "export"],
  selfTitle: `${project.title} — ${shortPath(project.packagePath)}`, pageCmd, pageKeys,
}).api;

let view: HomeView | null = null;
let metadata: DocumentMetadataView | null = null;
let knowledge: KnowledgeView | null = null;
let knowledgeFailed = false;
let metadataFailed = false;
let sel: string | null = null;
let resumeId: string | null = null;
let selectedGroup: string | null = null;
let selectedContainer: string | null = null;
let currentPanel = location.hash === "#documents" ? "documents" : "overview";
let loadRevision = 0;
let showAllGroups = false;
const titleOf = (doc: DocumentListItem): string => doc.originalTitle || doc.title;
const tree = (): ReturnType<typeof defaultSidebarTree> => defaultSidebarTree(view?.documents ?? []);
const sourceUnits = (): DocumentListItem[] => view?.documents.filter(d => d.nodeRole === "source_unit") ?? [];
const master = (): DocumentListItem | undefined => view?.documents.find(d => d.isMaster);

function meter(done: number, total: number): string {
  return `<span class="progress-meter" role="progressbar" aria-label="번역 확정" aria-valuemin="0" aria-valuemax="${Math.max(1, total)}" aria-valuenow="${done}" aria-valuetext="${total}개 중 ${done}개 번역 확정"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></span>`;
}
function stageBadge(doc: DocumentListItem): string {
  const stage = homeStage(doc);
  const label = HOME_STAGES.find(item => item.key === stage)?.label ?? "원문";
  return `<span class="tag study-stage-${stage}">${esc(label)}</span>`;
}
function infoUrl(id: string): string { return `knowledge.html?node=${encodeURIComponent(id)}#context`; }
function contextUrl(): string { return master() ? `context.html?node=${encodeURIComponent(master()!.id)}` : "context.html"; }

function renderHeader(): void {
  if (!view) return;
  const docs = sourceUnits();
  const groups = buildHomeGroups(view.documents);
  must("#projectTitle").textContent = view.project.title;
  must("#projectDescription").textContent = metadata?.descriptionMd?.trim()
    || (metadataFailed ? "프로젝트 설명을 불러오지 못했습니다. 프로젝트 정보에서 확인해 주세요." : "프로젝트 정보에 대상 문헌과 작업 범위를 기록해 보세요.");
  const facts: Array<[string, string]> = [["구성", `${groups.length}개 묶음 · 원문 ${docs.length}개`]];
  if (metadata?.authorName) facts.push(["저자", metadata.authorName]);
  if (metadata?.periodText || metadata?.dateText) facts.push(["시대·시기", [metadata.periodText, metadata.dateText].filter(Boolean).join(" · ")]);
  if (metadata?.sourceReference) facts.push(["출전", metadata.sourceReference]);
  must("#projectFacts").innerHTML = facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
  must("#documentTotal").textContent = String(docs.length);
  const resume = resolveHomeResume(view.documents, currentDocId(), view.recent);
  resumeId = resume.document?.id ?? null;
  must("#resumeBlock").hidden = false;
  must("#resumeLabel").textContent = !resume.document ? "첫 원문에서 시작하기" : resume.kind === "resume" ? "마지막으로 열었던 원문" : resume.kind === "recent" ? "최근 번역한 원문" : "처음 작업할 원문";
  must("#resumeTitle").textContent = resume.document ? titleOf(resume.document) : "작업할 원문을 추가해 주세요";
  must("#btnContinue").innerHTML = `${resume.document ? (resume.kind === "first" ? "원문 열기" : "작업 이어하기") : "원문 추가"} <span aria-hidden="true">→</span>`;
  must("#btnContinue").setAttribute("aria-label", resume.document ? `${titleOf(resume.document)} ${resume.kind === "first" ? "열기" : "작업 이어하기"}` : "첫 원문 추가");
  must<HTMLAnchorElement>("#contextLink").href = contextUrl();
  must<HTMLAnchorElement>("#contextPreviewLink").href = contextUrl();
}

function renderProgress(): void {
  if (!view) return;
  const docs = sourceUnits();
  const counts = HOME_STAGES.map(stage => docs.filter(doc => homeStage(doc) === stage.key).length);
  const confirmed = docs.filter(doc => homeStage(doc) === "confirmed").length;
  const review = docs.filter(doc => homeStage(doc) === "review").length;
  const drafts = docs.filter(doc => homeStage(doc) === "translation").length;
  must("#progressTotal").textContent = `전체 원문 ${docs.length}개`;
  must("#homeStatus").textContent = `원문 ${docs.length}개 · 번역 확정 ${confirmed}개`;
  must("#progressBody").innerHTML = docs.length ? `
    <div class="study-progress-summary"><div><span class="study-percent mono">${Math.round(confirmed / docs.length * 100)}<small>%</small></span><span class="study-percent-label">번역 확정</span></div><p><strong>${confirmed}개 원문을 확정했습니다.</strong><span>${docs.length - confirmed}개 원문의 작업이 남아 있습니다.</span></p></div>
    <div class="study-stage-bar" role="img" aria-label="${HOME_STAGES.map((stage, i) => `${stage.label} ${counts[i]}개`).join(", ")}">${HOME_STAGES.map((stage, i) => counts[i] ? `<span class="study-stage-${stage.key}" style="flex:${counts[i]}"></span>` : "").join("")}</div>
    <div class="study-stage-legend">${HOME_STAGES.map((stage, i) => `<button type="button" data-filter="${stage.key}" aria-label="${esc(stage.label)} ${counts[i]}개 원문 보기"><i class="study-stage-${stage.key}"></i>${esc(stage.label)}<b class="mono">${counts[i]}</b></button>`).join("")}</div>`
    : '<div class="study-progress-empty"><h3>첫 원문에서 시작하는 번역</h3><p>원문을 추가하면 문헌의 구성과 번역 진행 상황이 이곳에 모입니다.</p><button class="btn btn-primary" type="button" data-add-source>첫 원문 추가</button></div>';
  must("#attentionActions").innerHTML = docs.length ? `<button type="button" data-filter="review">재검토 필요 <strong>${review}</strong><span aria-hidden="true">→</span></button><button type="button" data-filter="translation">번역안 <strong>${drafts}</strong><span aria-hidden="true">→</span></button><button type="button" data-filter="uncertain">불확실성 <strong>${view.uncertainties.length}</strong><span aria-hidden="true">→</span></button>` : "";
  must("#uncertaintyMeta").textContent = view.uncertainties.length ? `열린 기록 ${view.uncertainties.length}건 · 해석의 의문과 근거` : "열린 불확실성이 없습니다";
}

function renderChapters(): void {
  if (!view) return;
  const groups = buildHomeGroups(view.documents);
  const opened = new Set([...document.querySelectorAll<HTMLDetailsElement>(".study-chapter[open]")].map(el => el.dataset.group));
  must("#chapterCount").textContent = `${groups.length}개 묶음 · 확정 / 전체`;
  must("#chapterList").innerHTML = groups.length ? groups.map((group, index) => {
    const count = group.documents.filter(doc => homeStage(doc) === "confirmed").length;
    return `<details class="study-chapter" data-group="${esc(group.id)}" ${opened.has(group.id) ? "open" : ""} ${index >= 6 && !showAllGroups ? "hidden" : ""}>
      <summary class="study-chapter-toggle"><span class="study-chapter-number mono">${String(index + 1).padStart(2, "0")}</span><span class="study-chapter-name"><strong>${esc(group.title)}</strong><span>${group.documents.length ? `${esc(titleOf(group.documents[0]!))}${group.documents.length > 1 ? ` 외 ${group.documents.length - 1}개 원문` : ""}` : "아직 원문이 없습니다"}</span></span><span class="study-chapter-progress">${meter(count, group.documents.length)}<span>${count} / ${group.documents.length}</span></span><span class="study-chevron" aria-hidden="true">⌄</span></summary>
      <div class="study-chapter-docs">${group.documents.slice(0, 5).map(doc => `<button type="button" data-open-doc="${esc(doc.id)}" class="study-inline-doc"><span>${esc(titleOf(doc))}</span>${stageBadge(doc)}</button>`).join("") || `<button class="study-text-button" type="button" data-add-under="${esc(group.containerId ?? "")}">이 목차에 원문 추가 →</button>`}${group.documents.length ? `<button type="button" class="study-text-button" data-show-group="${esc(group.id)}">이 묶음의 원문 ${group.documents.length}개 모두 보기 →</button>` : ""}${group.containerId ? `<a class="study-text-button" href="${infoUrl(group.containerId)}">목차 정보 ↗</a>` : ""}</div></details>`;
  }).join("") + (groups.length > 6 ? `<button type="button" class="study-text-button study-more-chapters" id="showAllGroups" aria-expanded="${showAllGroups}">${showAllGroups ? "6개 묶음만 보기 ↑" : `나머지 ${groups.length - 6}개 묶음 펼치기 ↓`}</button>` : "")
    : '<p class="study-empty-copy">왼쪽 목차에서 문헌의 구성을 정리하거나, 첫 원문을 추가해 보세요.</p>';
}

function renderKnowledge(): void {
  const root = master();
  const contexts = (knowledge?.contextItems ?? []).filter(item => item.enabled && item.scopeId === root?.id);
  const cards = contexts.filter(item => item.source === "context_item").sort((a, b) => b.priority - a.priority || a.updatedAt.localeCompare(b.updatedAt));
  must("#contextMeta").textContent = knowledgeFailed ? "문맥을 불러오지 못했습니다" : contexts.length ? `프로젝트 공통 문맥 ${contexts.length}개` : "문헌의 배경과 번역 원칙";
  must("#knowledgeMeta").textContent = knowledge ? `자료 ${knowledge.contextItems.length} · 용어 ${knowledge.glossary.length} · 미해결 ${knowledge.uncertainties.filter(item => item.state === "open").length}` : knowledgeFailed ? "자료를 불러오지 못했습니다" : "배경·지침·용어집·코멘트";
  must("#contextPreviewTitle").textContent = cards[0]?.title || "함께 참고할 문맥";
  must("#contextPreview").textContent = cards[0]?.contentMd || (knowledgeFailed ? "번역 자료 화면에서 내용을 확인하거나 다시 불러와 주세요." : "자료는 연결 노드와 설정한 하위 문서에서 함께 참고합니다. 문헌의 배경과 번역 원칙을 정리해 보세요.");
}

function renderRecent(): void {
  if (!view) return;
  const seen = new Set<string>();
  const records = view.recent.filter(record => {
    const doc = resolveRecentDocument(record, view!.documents);
    if (!doc) return true;
    if (seen.has(doc.id)) return false;
    seen.add(doc.id); return true;
  }).slice(0, 3);
  must("#recentList").innerHTML = records.length ? records.map(record => {
    const doc = resolveRecentDocument(record, view!.documents);
    const content = `<span class="study-recent-meta">${esc(doc ? homeDocumentPath(doc, view!.documents) || "원문 문서" : "번역 기록")}<span>${esc(fmtWhen(record.when))}</span></span><strong class="hanmun">${esc(doc ? titleOf(doc) : record.title)}</strong><p class="study-excerpt">${esc(record.summary)}</p><span class="study-recent-footer">${doc ? stageBadge(doc) : `<span class="tag">${esc(record.tag)}</span>`}<span>${doc ? "원문 열기 →" : "연결할 원문을 확인할 수 없습니다"}</span></span>`;
    return doc ? `<button class="study-recent-doc" type="button" data-open-doc="${esc(doc.id)}">${content}</button>` : `<article class="study-recent-doc">${content}</article>`;
  }).join("") : '<p class="study-empty-copy">아직 번역 작업 기록이 없습니다. 원문을 열고 번역을 시작해 보세요.</p>';
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
function renderDocuments(): void {
  if (!view) return;
  const query = must<HTMLInputElement>("#q").value.trim().toLocaleLowerCase();
  const status = must<HTMLSelectElement>("#statusSel").value;
  const group = selectedGroup ? buildHomeGroups(view.documents).find(item => item.id === selectedGroup) : null;
  const container = selectedContainer ? view.documents.find(doc => doc.id === selectedContainer) : null;
  const docs = (group?.documents ?? sourceUnits()).filter(doc => (!container || belongsTo(doc, container.id))
    && (!query || `${doc.title} ${doc.originalTitle ?? ""} ${homeDocumentPath(doc, view!.documents)}`.toLocaleLowerCase().includes(query))
    && (!status || (status === "uncertain" ? doc.uncertaintyCount > 0 : status === "working" ? homeStage(doc) !== "confirmed" : homeStage(doc) === status)));
  must("#scopeMeta").textContent = `${container ? `${titleOf(container)} · ` : group ? `${group.title} · ` : ""}${docs.length}개 원문${status === "uncertain" ? ` · 프로젝트 전체 불확실성 ${view.uncertainties.length}건` : ""}`;
  must("#clearFilters").hidden = !query && !status && !selectedGroup && !selectedContainer;
  must("#docBody").innerHTML = docs.length ? docs.map(doc => `<div class="study-document-row" data-id="${esc(doc.id)}">
    <button type="button" class="study-document-open" data-open-doc="${esc(doc.id)}"><span class="study-document-title"><strong>${esc(titleOf(doc))}</strong><small>${esc(homeDocumentPath(doc, view!.documents) || "프로젝트 원문")}</small></span></button>
    <div class="study-document-states">${([['원문', 'source', doc.sourceState], ['표점', 'punctuation', doc.punctuationState], ['번역', 'translation', doc.translationState]] as const).map(([label, kind, state]) => `<span><small>${label}</small>${tagHtml(stateLabel(kind, state))}</span>`).join("")}</div>
    <a class="study-uncertainty ${doc.uncertaintyCount ? "has-uncertainty" : ""}" href="knowledge.html#uncertainty" aria-label="불확실성 기록 보기 · 이 원문에 연결된 ${doc.uncertaintyCount}건">${doc.uncertaintyCount ? `의문 ${doc.uncertaintyCount}` : "—"}</a>
    <a class="study-metadata" href="${infoUrl(doc.id)}" aria-label="${esc(titleOf(doc))} 문서 정보">정보 ↗</a></div>`).join("")
    : `<div class="home-empty"><h3>${sourceUnits().length ? "조건에 맞는 원문이 없습니다" : "아직 원문이 없습니다"}</h3><p>${sourceUnits().length ? (status === "uncertain" && view.uncertainties.length ? "연결된 원문이 없는 불확실성은 불확실성 기록에서 확인할 수 있습니다." : "검색어나 상태 필터를 바꿔 보세요.") : "번역할 문헌의 원문을 추가해 작업을 시작하세요."}</p>${sourceUnits().length ? '<button class="btn" type="button" data-reset-filters>필터 초기화</button>' : '<button class="btn btn-primary" type="button" data-add-source>원문 추가</button>'}${status === "uncertain" ? '<a class="study-text-button" href="knowledge.html#uncertainty">모든 불확실성 기록 보기 →</a>' : ""}</div>`;
}

function showPanel(name: string, focus = false): void {
  currentPanel = name;
  for (const key of ["overview", "documents"]) {
    const selected = key === name;
    const tab = must<HTMLButtonElement>(`#study-tab-${key}`);
    tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
    must(`#study-${key}`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  history.replaceState(null, "", `${location.pathname}${location.search}${name === "documents" ? "#documents" : ""}`);
  if (name === "documents") renderDocuments();
}
function clearFilters(): void {
  selectedGroup = null; selectedContainer = null;
  must<HTMLInputElement>("#q").value = ""; must<HTMLSelectElement>("#statusSel").value = "";
  renderDocuments();
}
function applyFilter(status: string): void {
  clearFilters(); must<HTMLSelectElement>("#statusSel").value = status; showPanel("documents", true);
}
function creationParent(explicitParentId?: string | null): string | null {
  return resolveHomeCreationParent(view?.documents ?? [], { explicitParentId, containerId: selectedContainer, groupId: selectedGroup, selectedId: sel });
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
    case "export": openConfirmedExport(); return true;
    case "import": void openDocumentDialog(creationParent(), true); return true;
    case "find": showPanel("documents"); must<HTMLInputElement>("#q").focus(); return true;
  }
  return false;
}
function pageKeys(e: KeyboardEvent, m: boolean): void {
  if (m && !e.shiftKey && !e.altKey && e.code === "KeyN") { e.preventDefault(); openNewSource(); }
  else if (m && !e.shiftKey && e.code === "KeyE") { e.preventDefault(); openConfirmedExport(); }
}
function showError(message: string): void {
  must("#homeErrorText").textContent = message; must("#homeError").hidden = false;
}
async function load(): Promise<void> {
  const revision = ++loadRevision;
  must("#homeStudy").setAttribute("aria-busy", "true"); must("#homeError").hidden = true;
  try {
    const result = await api.home.get();
    if (revision !== loadRevision) return;
    if (!result.ok) throw new Error(result.error.message);
    view = result.data; metadata = null; knowledge = null; metadataFailed = false; knowledgeFailed = false;
    setSidebarDocs(view.documents);
    const remembered = currentDocId();
    sel = view.documents.some(doc => doc.id === remembered) ? remembered : master()?.id ?? null;
    must("#tbTitle").textContent = view.project.title;
    must("#tbSub").textContent = "— 프로젝트 서재";
    must("#sbPath").textContent = shortPath(view.project.packagePath);
    setSelfTitle(`${view.project.title} — ${shortPath(view.project.packagePath)}`);
    renderSidebar(tree(), { currentDocId: sel });
    renderHeader(); renderProgress(); renderChapters(); renderKnowledge(); renderRecent(); showPanel(currentPanel);
    const root = master();
    const [metaResult, knowledgeResult] = await Promise.allSettled([root ? api.home.getDocumentMetadata(root.id) : Promise.resolve(null), api.knowledge.get()]);
    if (revision !== loadRevision) return;
    metadata = metaResult.status === "fulfilled" && metaResult.value?.ok ? metaResult.value.data : null;
    metadataFailed = metaResult.status === "rejected" || (metaResult.status === "fulfilled" && metaResult.value !== null && !metaResult.value.ok);
    knowledge = knowledgeResult.status === "fulfilled" && knowledgeResult.value.ok ? knowledgeResult.value.data : null;
    knowledgeFailed = knowledgeResult.status === "rejected" || (knowledgeResult.status === "fulfilled" && !knowledgeResult.value.ok);
    renderHeader(); renderKnowledge();
    if (metadataFailed || knowledgeFailed) showError("프로젝트 소개나 공통 지식 일부를 불러오지 못했습니다. 문서 작업은 계속할 수 있습니다.");
  } catch (error) {
    if (revision !== loadRevision) return;
    showError(error instanceof Error ? error.message : "프로젝트를 불러오지 못했습니다.");
    if (!view) must("#projectTitle").textContent = "프로젝트를 불러오지 못했습니다";
  } finally {
    if (revision === loadRevision) must("#homeStudy").setAttribute("aria-busy", "false");
  }
}

must("#q").addEventListener("input", renderDocuments);
must("#statusSel").addEventListener("change", renderDocuments);
must("#clearFilters").addEventListener("click", clearFilters);
must("#btnNewDoc").addEventListener("click", () => openNewSource());
must("#btnRetryHome").addEventListener("click", () => void load());
must("#btnContinue").addEventListener("click", () => resumeId ? openDoc(resumeId) : openNewSource());
must("#btnBackup").addEventListener("click", () => {
  void api.project.backup().then(result => {
    if (!result.ok) notify(result.error.message, "백업");
    else if (result.data) notify(`백업을 저장했습니다 · ${result.data}`, "백업");
  }).catch(() => notify("백업을 저장하지 못했습니다.", "백업"));
});
must("#btnExport").addEventListener("click", openConfirmedExport);
must("#homeStudy").addEventListener("click", event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("button, a");
  if (!target) return;
  if (target.dataset.openDoc) openDoc(target.dataset.openDoc);
  else if (target.hasAttribute("data-filter")) applyFilter(target.dataset.filter!);
  else if (target.hasAttribute("data-add-source")) openNewSource();
  else if (target.hasAttribute("data-add-under")) openNewSource(target.dataset.addUnder || null);
  else if (target.hasAttribute("data-project-info") && master()) location.href = infoUrl(master()!.id);
  else if (target.hasAttribute("data-show-documents")) { clearFilters(); showPanel("documents", true); }
  else if (target.hasAttribute("data-show-group")) { clearFilters(); selectedGroup = target.dataset.showGroup!; showPanel("documents", true); }
  else if (target.hasAttribute("data-reset-filters")) clearFilters();
  else if (target.id === "study-tab-overview") showPanel("overview");
  else if (target.id === "study-tab-documents") showPanel("documents");
  else if (target.id === "showAllGroups") { showAllGroups = !showAllGroups; renderChapters(); must("#showAllGroups").focus(); }
});
must(".study-tabs").addEventListener("keydown", event => {
  const e = event as KeyboardEvent;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault(); showPanel(e.key === "Home" ? "overview" : e.key === "End" ? "documents" : currentPanel === "overview" ? "documents" : "overview", true);
});
bindSidebar(id => {
  sel = id;
  const doc = view?.documents.find(item => item.id === id);
  if (doc?.nodeRole === "source_unit") { openDoc(id); return; }
  clearFilters(); selectedContainer = doc && !doc.isMaster ? doc.id : null; showPanel("documents");
}, undefined, tree, (parentId, role) => { void openDocumentDialog(creationParent(parentId), false, role); }, { selectExpandable: true });
window.addEventListener("munhae:document-created", () => void load());
window.addEventListener("pageshow", event => { if (event.persisted) void load(); });
await load();
