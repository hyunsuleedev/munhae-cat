import { configureGlossary } from "./glossary-ui";
import { t, ui, uiText } from "./i18n";
import { configureInspectorResize } from "./inspector-resize";
import type {
  DocumentListItem,
  DocumentMetadataView,
  HomeView,
  KnowledgeView,
  NodeContextView,
  MaterialsView,
  MaterialCommentView,
  MaterialPreferenceView,
} from "../../shared/munhae-api";
import {
  $,
  $$,
  bindSidebar,
  defaultSidebarTree,
  esc,
  go,
  initShell,
  ic,
  must,
  notify,
  renderSidebar,
  registerProjectRefresh,
  requireProject,
  setSelfTitle,
  projectLocationLabel,
  unwrap,
  SCREEN_FILES,
  type ScreenId,
} from "./shared";

import { knowledgePage, documentPath, documentPathText, orderedDocumentNodes, materialNodeState, type KnowledgePage } from "./knowledge-model";
import { materialScopeNodes } from "./material-paths";
import { configureMaterialEditor } from "./material-editor-ui";

const project = await requireProject();
if (!project) throw new Error("redirect");

const page = knowledgePage(document.body.dataset.knowledgePage);
/** Context and comments filter by the document chosen in the sidebar. */
const scoped = page === "context" || page === "comments";
const SCREENS: Record<KnowledgePage, ScreenId> = { context: "knowledge", glossary: "glossary", comments: "comments" };
const TITLES: Record<KnowledgePage, string> = { context: t("문맥"), glossary: t("용어집"), comments: t("코멘트") };

const CONTEXT_NOTE = t("연결 위치와 하위 문서의 상속 범위를 확인하세요");

const api = initShell({
  page: SCREENS[page],
  extraEnabled: ["ctxpane"],
  extraPalette: [{ g: TITLES[page], l: t("항목 추가…"), k: "", id: "addterm" }],
  selfTitle: `${TITLES[page]} — ${project.title}`,
  pageCmd,
  pageKeys,
  beforeNavigate: () => {
    if (!canLeaveKnowledge()) return false;
    allowUnload = true;
    return true;
  },
  projectTransition: {
    before: () => canLeaveKnowledge(),
    committed: () => { allowUnload = true; },
  },
}).api;

const glossary = page === "glossary" ? configureGlossary({
  api, list: must("#glossaryList"), detail: must("#detail"),
  query: must<HTMLInputElement>("#glossaryQuery"), kinds: must("#glossaryKinds"), sort: must<HTMLSelectElement>("#glossarySort"),
  selectAll: must<HTMLInputElement>("#glossarySelectAll"), selection: must("#glossarySelection"), selectionCount: must("#glossarySelectionCount"), remove: must<HTMLButtonElement>("#glossaryDelete"),
}) : null;
if (page === "glossary") {
  const split = must("#split");
  configureInspectorResize({
    host: split, panel: must("#insp"), workspace: split, target: split, property: "--iw",
    key: "munhae.glossary.inspectorWidth", label: t("검사기 너비"), hidden: () => split.classList.contains("no-insp"),
  });
}

let data: KnowledgeView = { terms: [], contextItems: [] };
let docs: DocumentListItem[] = [];
let materials: MaterialsView = { items: [], comments: [], preferences: [] };
let materialsError = "";
let active: string | null = null;
let selectedNodeId: string | null = null;
let detailBaseline = "";
let detailSaving = false;
let allowUnload = false;
let metadataDetailId: string | null = null;
let knowledgeRefreshVersion = 0;
const materialEditor = configureMaterialEditor({
  api, documents: () => docs, currentDocumentId: () => selectedNodeId, escape: esc, notify,
  onSaved: async (saved) => {
    if (page !== "context") { openMaterial(saved.id); return; }
    await refreshMaterials();
    selectedNodeId = saved.scopeId;
    clearDetail();
    must<HTMLSelectElement>("#scopeFilter").value = "";
    must<HTMLInputElement>("#q").value = "";
    showContext(materials.items.find(item => item.id === saved.id) ?? saved);
  },
});

function formSnapshot(selector: string): string {
  return JSON.stringify($$<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `${selector} input, ${selector} textarea, ${selector} select`,
  ).map((field) => [field.id || field.name, field.value, field instanceof HTMLInputElement ? field.checked : null]));
}

function detailIsDirty(): boolean {
  return detailBaseline !== "" && formSnapshot("#detail") !== detailBaseline;
}

function canLeaveKnowledge(): boolean {
  if (detailSaving || materialEditor.isBusy()) {
    notify(t("작업을 마치는 중입니다. 잠시 뒤 다시 시도해 주세요."), t("번역 자료"));
    return false;
  }
  return (!glossary?.hasUnsavedChanges() && !detailIsDirty() && !materialEditor.hasUnsavedDraft())
    || window.confirm(t("저장하지 않은 변경이 있습니다. 변경을 버리고 이동하시겠습니까?"));
}

function updateDetailState(): void {
  const status = $("#knowledgeSaveStatus");
  if (status) status.textContent = detailSaving ? t("저장 중…") : detailIsDirty() ? t("저장하지 않은 변경") : t("저장됨");
  const save = $<HTMLButtonElement>("#dSave, #cSave, #mSave");
  if (save) save.disabled = detailSaving || !detailIsDirty();
}

function trackDetail(): void {
  detailBaseline = formSnapshot("#detail");
  if ($("#dSave, #cSave, #mSave")) {
    const status = document.createElement("p");
    status.id = "knowledgeSaveStatus";
    status.className = "knowledge-save-state";
    status.setAttribute("role", "status");
    must("#detail").append(status);
  }
  updateDetailState();
}

function clearDetail(): void {
  metadataDetailId = null;
  active = null;
  detailBaseline = "";
  must("#detailMeta").textContent = t("자료를 선택하세요");
  must("#sbSel").textContent = "";
  must("#detail").innerHTML = uiText('<p class="muted">항목을 선택하면 내용을 보고 편집할 수 있습니다.</p>');
}

function revealDetail(): void {
  if (window.matchMedia("(max-width: 1000px)").matches) must("#detail").scrollIntoView({ block: "start" });
}

async function runDetailOperation(operation: () => Promise<void>): Promise<void> {
  if (detailSaving) return;
  detailSaving = true;
  must("#detail").inert = true;
  must("#detail").setAttribute("aria-busy", "true");
  updateDetailState();
  try {
    await operation();
  } catch {
    notify(t("작업을 완료하지 못했습니다. 입력한 내용은 유지됩니다. 다시 시도해 주세요."), t("번역 자료"));
  } finally {
    detailSaving = false;
    must("#detail").inert = false;
    must("#detail").removeAttribute("aria-busy");
    updateDetailState();
  }
}

function tree() {
  return defaultSidebarTree(docs);
}

window.addEventListener("munhae:document-created", (event) => {
  docs = (event as CustomEvent<HomeView>).detail.documents;
  renderSidebar(tree(), { currentDocId: null });
});

function renderPage(): void {
  // The glossary page is rendered by glossary-ui.
  if (page === "glossary") return renderCounts();
  if (page === "comments") renderComments();
  else renderContext();
  renderCounts();
}

function renderCounts(): void {
  must("#sbC").textContent = String(materials.items.length);
  must("#sbG").textContent = String(data.terms.length);
}

function syncDocumentActions(): void {
  if (page !== "context") return;
  must("#btnEditMetadata").hidden = !selectedNode();
  must("#btnOpenDocument").hidden = selectedNode()?.nodeRole !== "source_unit";
}

function renderScopeOptions(): void {
  const filter = must<HTMLSelectElement>("#scopeFilter");
  const value = filter.value;
  filter.innerHTML = `<option value="">${esc(page === "comments" ? t("모든 문서의 코멘트") : t("프로젝트의 모든 자료"))}</option>${documentOptions(null)}`;
  filter.value = docs.some(doc => doc.id === value) ? value : "";
}

/** Material rows live on the context page; other pages hand off to it. */
function openMaterial(id: string): void {
  allowUnload = true;
  location.href = `${SCREEN_FILES.knowledge}?material=${encodeURIComponent(id)}`;
}

function selectedNode(): DocumentListItem | undefined {
  return docs.find(document => document.id === selectedNodeId);
}

function pathLabel(nodeId: string): string { return documentPathText(docs, nodeId); }
function trail(nodeId: string): string { return `<span class="material-node-trail">${esc(pathLabel(nodeId))}</span>`; }
function sourceId(item: NodeContextView): string { return item.source === "document_description" ? item.scopeId : item.id; }
function preferencesFor(item: NodeContextView): MaterialPreferenceView[] {
  return materials.preferences.filter(preference => preference.source === item.source && preference.sourceId === sourceId(item));
}
function matchesQuery(values: Array<string | null | undefined>): boolean {
  const query = must<HTMLInputElement>("#q").value.trim().toLocaleLowerCase();
  return !query || values.some(value => value?.toLocaleLowerCase().includes(query));
}
function contextRows(): NodeContextView[] {
  const scope = must<HTMLSelectElement>("#scopeFilter").value;
  return materials.items.filter(item => (!scope || materialNodeState(docs, item, materials.preferences, scope).reason !== null)
    && matchesQuery([item.title, item.contentMd, item.conditionMd, pathLabel(item.scopeId)]));
}
function contextScopeNote(): string {
  const scope = must<HTMLSelectElement>("#scopeFilter").value;
  return scope ? ui`${pathLabel(scope)} · 직접·상속·선택 자료` : CONTEXT_NOTE;
}
function itemScopeNodes(item: NodeContextView): DocumentListItem[] {
  return materialScopeNodes(docs, item.scopeId, item.inheritToChildren ?? true);
}
function materialUseCount(item: NodeContextView): number {
  return docs.filter(node => node.nodeRole === "source_unit" && materialNodeState(docs, item, materials.preferences, node.id).included).length;
}
function scopeTree(item: NodeContextView): string {
  const path = documentPath(docs, item.scopeId);
  if (!path.length) return uiText('<p class="material-help">연결 문서의 경로를 확인할 수 없습니다.</p>');
  const targets = itemScopeNodes(item);
  const natural = new Set(targets.map(node => node.id));
  const visible = new Set([...path, ...targets].map(node => node.id));
  const prefs = preferencesFor(item);
  const ordered = orderedDocumentNodes(docs);
  const children = new Map<string | null, DocumentListItem[]>();
  for (const node of ordered.filter(node => visible.has(node.id))) {
    const rows = children.get(node.parentId) ?? [];
    rows.push(node); children.set(node.parentId, rows);
  }
  const render = (node: DocumentListItem, seen: Set<string>): string => {
    if (seen.has(node.id)) return "";
    const next = new Set(seen).add(node.id);
    const anchor = node.id === item.scopeId;
    const excluded = prefs.some(pref => pref.documentNodeId === node.id && pref.excluded);
    const label = excluded ? t("이 문서에서 제외") : anchor ? t("연결 위치") : natural.has(node.id) ? t("하위 · 이어받음") : node.isMaster ? t("프로젝트") : t("상위 문서");
    const nested = (children.get(node.id) ?? []).map(child => render(child, next)).join("");
    return `<li><div class="material-scope-node ${anchor ? "is-anchor" : natural.has(node.id) ? "is-inherited" : ""} ${excluded ? "is-excluded" : ""}">${ic(node.nodeRole === "container" ? "folder" : "doc")}<button type="button" data-open-material-node="${esc(node.id)}">${esc(node.originalTitle || node.title)}</button><small>${label}</small></div>${nested ? `<ul>${nested}</ul>` : ""}</li>`;
  };
  const manual = prefs.filter(pref => pref.referenced && !natural.has(pref.documentNodeId));
  return `<div class="material-scope-tree"><ul>${render(path[0]!, new Set())}</ul></div>${manual.length ? ui`<section class="material-section"><h3>상속 범위 밖에서 직접 가져온 문서</h3>${manual.map(pref => `<div class="material-manual-link"><button type="button" data-open-material-node="${esc(pref.documentNodeId)}">${esc(pathLabel(pref.documentNodeId))}</button><p class="material-help">${pref.excluded ? t("직접 연결 · 이 문서에서 제외") : t("상속 관계 없이 직접 연결")}</p></div>`).join("")}</section>` : ""}`;
}
function renderContext(): void {
  const rows = contextRows();
  const groups = orderedDocumentNodes(docs).map(node => ({ node, rows: rows.filter(item => item.scopeId === node.id) })).filter(group => group.rows.length);
  const renderRow = (item: NodeContextView) => {
    const descendants = itemScopeNodes(item).filter(node => node.id !== item.scopeId && node.nodeRole === "source_unit").length;
    const scope = must<HTMLSelectElement>("#scopeFilter").value;
    const state = scope ? materialNodeState(docs, item, materials.preferences, scope) : null;
    const scopeLabel = state ? state.excluded ? t("선택한 문서에서 제외") : state.reason === "selected" ? t("다른 문서에서 직접 가져옴") : state.reason === "ancestor" ? t("상위 문서에서 이어받음") : t("이 문서에 직접 연결") : (item.inheritToChildren ?? true) ? ui`하위 원문 ${descendants}개에 이어짐` : t("연결 문서에서만 참고");
    return ui`<button type="button" class="material-row ${active === item.id ? "is-active" : ""}" data-cid="${esc(item.id)}" aria-pressed="${active === item.id}">${trail(item.scopeId)}<h3>${esc(item.title)}</h3>${item.reference?.needsReview || item.reference?.sourceChanged || item.reference?.sourceUnavailable ? `<small>${t("확인 필요 · AI 적용 안 됨")}</small>` : ""}<p>${esc(item.contentMd || (item.reference ? item.origin?.bodyMd : "") || "")}</p><div class="material-row-footer"><span>${state?.included ? scopeLabel : item.enabled ? scopeLabel : t("자동 포함 꺼짐")}</span><span>${ui`${materialUseCount(item)}개 원문에서 참고`}</span></div>${item.origin ? uiText('<span class="material-origin-label">참고 코멘트 연결</span>') : item.source === "document_description" ? uiText('<span class="material-origin-label">문서 정보의 설명</span>') : ""}</button>`;
  };
  const known = new Set(docs.map(node => node.id));
  const unlinked = rows.filter(item => !known.has(item.scopeId));
  must("#cBody").innerHTML = materialsError ? `<p class="material-error" role="alert">${esc(materialsError)}</p>` : groups.map(({ node, rows: list }) => ui`<section class="node-materials"><div class="node-group-heading">${ic(node.nodeRole === "container" ? "folder" : "doc")}<div><strong>${esc(node.originalTitle || node.title)}</strong>${trail(node.id)}</div><small>자료 ${list.length}</small></div>${list.filter(item => item.source !== "comment_reference").map(renderRow).join("")}${list.some(item => item.source === "comment_reference") ? `<h3 class="material-help">${t("참고 코멘트 연결")}</h3>${list.filter(item => item.source === "comment_reference").map(renderRow).join("")}` : ""}</section>`).join("") + (unlinked.length ? ui`<section class="node-materials"><h3>연결 위치 확인 필요</h3>${unlinked.map(renderRow).join("")}</section>` : "");
  must("#contextEmpty").hidden = rows.length > 0 || !!materialsError;
  must("#scopeNote").textContent = contextScopeNote();
}
function originHtml(item: NodeContextView): string {
  const origin = item.origin;
  if (!origin) return "";
  return ui`<section class="material-section"><h3>근거가 된 코멘트 · 원문 위치</h3>${trail(origin.documentNodeId)}<blockquote class="material-quote">${esc(origin.quote)}</blockquote><details><summary>원본 코멘트 보기</summary><p class="material-body">${esc(origin.bodyMd)}</p></details><p class="material-help">${origin.targetKind === "source" ? t("원문") : t("번역문")}에 남긴 판단 · 원래 구절의 기록과 자료의 적용 범위는 별개입니다.</p><button class="btn btn-sm" type="button" data-open-origin="${esc(origin.documentNodeId)}">원래 문서 열기 ↗</button></section>`;
}
function showContext(item: NodeContextView): void {
  clearDetail();
  active = item.id;
  if (!must<HTMLSelectElement>("#scopeFilter").value) selectedNodeId = item.scopeId;
  renderContext();
  must("#btnEditMetadata").hidden = false;
  must("#btnOpenDocument").hidden = selectedNode()?.nodeRole !== "source_unit";
  must("#detailMeta").textContent = item.origin ? t("참고 코멘트 연결") : item.source === "document_description" ? t("문서 정보의 설명") : t("직접 작성한 자료");
  must("#sbSel").textContent = item.title;
  must("#detail").innerHTML = ui`<h2>${esc(item.title)}</h2>${item.reference?.needsReview || item.reference?.sourceChanged || item.reference?.sourceUnavailable ? `<p class="material-help">${t(item.reference.sourceUnavailable ? "원본 코멘트가 삭제되었습니다." : item.reference.sourceChanged ? "원본 코멘트가 변경되었습니다." : "기존 편집본을 보충 메모로 보존했습니다.")} ${t("확인 전에는 AI에 적용하지 않습니다. 연결 편집에서 내용을 확인하세요.")}</p>` : ""}<div class="material-section"><h3>자료가 연결된 위치</h3>${trail(item.scopeId)}${scopeTree(item)}<p class="material-help">${(item.inheritToChildren ?? true) ? t("연결된 위치와 그 하위 문서에서 참고합니다.") : t("이 자료는 연결된 문서에서만 참고합니다.")}${item.enabled ? "" : t(" 자동 포함이 꺼져 있습니다. 문서에서 직접 선택한 경우에는 참고할 수 있습니다.")}</p></div><section class="material-section"><h3>${t(item.reference ? "보충 메모" : "참고 내용")}</h3><p class="material-body">${esc(item.contentMd || (item.reference ? t("보충 메모가 없습니다.") : ""))}</p>${item.conditionMd ? ui`<div class="material-condition"><b>적용 조건·예외</b><br>${esc(item.conditionMd)}</div>` : ""}</section>${originHtml(item)}<div class="material-actions"><button class="btn btn-primary btn-sm" type="button" id="editMaterial">${item.source === "document_description" ? t("문서 정보 편집") : item.reference ? t("연결 편집") : t("자료 편집")}</button>${item.source !== "document_description" ? ui`<button class="btn btn-sm btn-danger" type="button" id="deleteMaterial">${t(item.reference ? "연결 해제" : "삭제")}</button>` : ""}</div>`;
  must("#editMaterial").addEventListener("click", () => {
    if (!canLeaveKnowledge()) return;
    if (item.source === "document_description") void runDetailOperation(() => showDocumentMetadata(item.scopeId));
    else materialEditor.open({ item });
  });
  $("#deleteMaterial")?.addEventListener("click", () => {
    if (!canLeaveKnowledge() || !window.confirm(item.reference ? ui`‘${item.title}’ 연결을 해제하시겠습니까? 원본 코멘트는 유지됩니다.` : ui`‘${item.title}’ 자료를 삭제하시겠습니까? 삭제 후에는 복구할 수 없습니다.`)) return;
    void runDetailOperation(async () => {
      const result = await api.knowledge.deleteContext({ id: item.id, expectedLockVersion: item.lockVersion });
      if (!result.ok) { unwrap(result, t("자료 삭제")); return; }
      await refreshMaterials(); clearDetail(); renderContext();
      notify(item.reference ? t("연결을 해제했습니다. 원본 코멘트는 유지됩니다.") : t("자료를 삭제했습니다. 이전 번역의 실행 기록은 유지됩니다."), t("번역 자료"));
    });
  });
  revealDetail();
}
function renderComments(): void {
  const scope = must<HTMLSelectElement>("#scopeFilter").value;
  const rows = materials.comments.filter(comment => (!scope || comment.documentNodeId === scope)
    && matchesQuery([comment.quote, comment.bodyMd, pathLabel(comment.documentNodeId), comment.authorName]));
  must("#commentsBody").innerHTML = materialsError ? `<p class="material-error" role="alert">${esc(materialsError)}</p>` : rows.map(comment => `<button type="button" class="material-row ${active === comment.id ? "is-active" : ""}" data-comment-id="${esc(comment.id)}" aria-pressed="${active === comment.id}">${trail(comment.documentNodeId)}<blockquote class="material-quote">${esc(comment.quote)}</blockquote><p>${esc(comment.bodyMd)}</p><div class="material-row-footer"><span>${esc(comment.authorName)} · ${esc(comment.updatedAt.slice(0, 10))}</span><span>${comment.materialIds.length ? ui`참고 자료 ${comment.materialIds.length}개에 연결됨` : t("원래 구절의 검토 기록")}</span></div></button>`).join("") || uiText('<p class="empty">일치하는 코멘트가 없습니다. 문서의 구절에 남긴 코멘트가 여기에 모입니다.</p>');
}
function showComment(comment: MaterialCommentView): void {
  clearDetail(); active = comment.id; selectedNodeId = comment.documentNodeId; renderComments();
  must("#detailMeta").textContent = t("원래 구절에 남긴 코멘트");
  must("#sbSel").textContent = comment.quote;
  const linked = materials.items.filter(item => comment.materialIds.includes(item.id));
  must("#detail").innerHTML = ui`<h2>구절에 남긴 판단</h2>${trail(comment.documentNodeId)}<blockquote class="material-quote">${esc(comment.quote)}</blockquote><p class="material-body">${esc(comment.bodyMd)}</p><p class="material-help">${esc(comment.authorName)} · ${esc(comment.updatedAt.slice(0, 16).replace("T", " "))}<br>${comment.targetKind === "source" ? t("원문") : t("번역문")}의 작성 당시 구절에 연결된 기록입니다.</p>${linked.length ? ui`<section class="material-section"><h3>이 코멘트의 참고 연결</h3>${linked.map(item => `<button class="material-row" type="button" data-show-material="${esc(item.id)}"><h3>${esc(item.title)}</h3>${item.reference?.needsReview || item.reference?.sourceChanged || item.reference?.sourceUnavailable ? `<small>${t("확인 필요 · AI 적용 안 됨")}</small>` : ""}${trail(item.scopeId)}</button>`).join("")}</section>` : ""}<section class="material-section"><h3>다른 번역에 활용하기</h3><p class="material-help">참고할 내용과 조건, 연결 위치를 직접 정합니다. 원래 코멘트는 그대로 남습니다.</p></section><div class="material-actions"><button class="btn btn-primary" type="button" id="reuseComment">다른 문서에서도 참고</button><button class="btn" type="button" data-open-origin="${esc(comment.documentNodeId)}">원래 문서 열기 ↗</button></div>`;
  must("#reuseComment").addEventListener("click", () => { if (canLeaveKnowledge()) materialEditor.open({ comment }); });
  revealDetail();
}
async function refreshMaterials(): Promise<void> {
  const [result, home] = await Promise.all([api.knowledge.getMaterials(), api.home.get()]);
  if (!result.ok) {
    materialsError = result.error.message;
    throw new Error(result.error.message);
  }
  materials = result.data;
  knowledgeRefreshVersion += 1;
  materialsError = "";
  data.contextItems = materials.items;
  if (home.ok) docs = home.data.documents;
  renderSidebar(tree(), { currentDocId: null });
  renderPage();
}

async function showDocumentMetadata(nodeId: string): Promise<void> {
  const result = await api.home.getDocumentMetadata(nodeId);
  const metadata = unwrap(result, t("문서 정보"));
  if (!metadata) return;
  renderDocumentMetadata(metadata);
}
function renderDocumentMetadata(metadata: DocumentMetadataView): void {
  metadataDetailId = metadata.id;
  knowledgeRefreshVersion += 1;
  must("#detailMeta").textContent = ui`문서 · ${metadata.lockVersion}`;
  must("#detail").innerHTML = ui`<div class="detail">
      <div class="field"><label for="mTitle">제목</label><input class="input" id="mTitle" value="${esc(metadata.title)}" ${metadata.isMaster ? "disabled" : ""}></div>
      <div class="field"><label for="mOriginal">원제</label><input class="input hanmun" id="mOriginal" value="${esc(metadata.originalTitle ?? "")}"></div>
      <div class="field"><label for="mAuthor">저자</label><input class="input" id="mAuthor" maxlength="500" value="${esc(metadata.authorName ?? "")}" placeholder="예: 정약용(丁若鏞)" aria-describedby="mAuthorHelp"><p class="muted" id="mAuthorHelp">비워 두면 상위 문서의 저자를 이어받습니다.</p></div>
      <div class="row" style="gap:10px"><div class="field" style="flex:1"><label for="mLanguage">언어</label><input class="input" id="mLanguage" value="${esc(metadata.language ?? "")}"></div><div class="field" style="flex:1"><label for="mPeriod">시대</label><input class="input" id="mPeriod" value="${esc(metadata.periodText ?? "")}"></div></div>
      <div class="field"><label for="mDate">작성일</label><input class="input" id="mDate" value="${esc(metadata.dateText ?? "")}"></div>
      <div class="field"><label for="mReference">출전</label><input class="input" id="mReference" value="${esc(metadata.sourceReference ?? "")}"></div>
      <div class="field"><label for="mDescription">설명</label><textarea class="textarea" id="mDescription">${esc(metadata.descriptionMd ?? "")}</textarea></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary btn-sm" id="mSave" type="button">문서 정보 저장</button></div>
    </div>`;
  trackDetail();
  must("#mSave").addEventListener("click", () => void runDetailOperation(async () => {
    const save = await api.home.updateDocumentMetadata({
      documentNodeId: metadata.id,
      title: metadata.isMaster ? metadata.title : must<HTMLInputElement>("#mTitle").value.trim(),
      originalTitle: must<HTMLInputElement>("#mOriginal").value.trim() || null,
      authorName: must<HTMLInputElement>("#mAuthor").value.trim() || null,
      language: must<HTMLInputElement>("#mLanguage").value.trim() || null,
      periodText: must<HTMLInputElement>("#mPeriod").value.trim() || null,
      dateText: must<HTMLInputElement>("#mDate").value.trim() || null,
      sourceReference: must<HTMLInputElement>("#mReference").value.trim() || null,
      descriptionMd: must<HTMLTextAreaElement>("#mDescription").value.trim() || null,
      expectedLockVersion: metadata.lockVersion,
    });
    const saved = unwrap(save, t("문서 정보"));
    if (!saved) return;
    docs = docs.map((document) => document.id === saved.id
      ? { ...document, title: saved.title, originalTitle: saved.originalTitle }
      : document);
    renderSidebar(tree(), { currentDocId: null });
    const refreshed = await api.knowledge.get();
    const knowledge = unwrap(refreshed, t("번역 자료"));
    if (knowledge) data = knowledge;
    await refreshMaterials();
    renderContext();
    await showDocumentMetadata(saved.id);
    notify(ui`${saved.title} 정보 저장`, t("문서 정보"));
  }));
}

function documentOptions(selected: string | null): string {
  return orderedDocumentNodes(docs).map(doc => `<option value="${esc(doc.id)}" ${doc.id === selected ? "selected" : ""}>${esc(pathLabel(doc.id))}</option>`).join("");
}

function openAdd(): void {
  if (!canLeaveKnowledge()) return;
  if (detailIsDirty()) clearDetail();
  if (page === "context") { materialEditor.open({ scopeId: selectedNodeId ?? undefined }); return; }
  if (page === "comments") {
    const node = selectedNode()?.nodeRole === "source_unit" ? selectedNode() : docs.find(candidate => candidate.nodeRole === "source_unit");
    if (node) go("editor", node.id);
    else notify(t("먼저 원문 문서를 만들어 주세요."), t("코멘트"));
    return;
  }
  notify(t("새 용어는 각 문서의 용어 화면에서 확정한 표점본의 위치에 추가합니다."), t("용어집"));
}

function pageCmd(id: string): boolean {
  switch (id) {
    case "ctxpane":
      return false;
    case "addterm":
      openAdd();
      return true;
    case "find":
      return false;
  }
  return false;
}

function pageKeys(e: KeyboardEvent, m: boolean): void {
  const search = $<HTMLInputElement>("#q") ?? $<HTMLInputElement>("#glossaryQuery");
  if (search && m && !e.shiftKey && !e.altKey && e.code === "KeyF") {
    e.preventDefault();
    search.focus();
  }
}

["#q", "#scopeFilter"].forEach((s) => {
  $(s)?.addEventListener("input", () => {
    if (s === "#scopeFilter") {
      selectedNodeId = must<HTMLSelectElement>("#scopeFilter").value || docs.find(node => node.isMaster)?.id || null;
      syncDocumentActions();
    }
    renderPage();
  });
});
$("#cBody")?.addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("[data-cid]");
  if (!(tr instanceof HTMLElement) || !tr.dataset.cid) return;
  const item = materials.items.find((candidate) => candidate.id === tr.dataset.cid);
  if (item && canLeaveKnowledge()) showContext(item);
});
$("#commentsBody")?.addEventListener("click", event => {
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-comment-id]");
  const comment = materials.comments.find(item => item.id === row?.dataset.commentId);
  if (comment && canLeaveKnowledge()) showComment(comment);
});
must("#detail").addEventListener("click", event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-open-material-node], [data-open-origin], [data-show-material]");
  if (!target || !canLeaveKnowledge()) return;
  if (target.dataset.showMaterial) {
    openMaterial(target.dataset.showMaterial);
    return;
  }
  const id = target.dataset.openMaterialNode ?? target.dataset.openOrigin;
  const node = docs.find(candidate => candidate.id === id);
  if (node) go(node.nodeRole === "source_unit" ? "editor" : "context", node.id);
});
$("#btnOpenDocument")?.addEventListener("click", () => {
  const node = selectedNode();
  if (node?.nodeRole === "source_unit") go("editor", node.id);
});
$("#btnEditMetadata")?.addEventListener("click", () => {
  const node = selectedNode();
  if (node && canLeaveKnowledge()) void runDetailOperation(() => showDocumentMetadata(node.id));
});
$("#btnAdd")?.addEventListener("click", openAdd);
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.code !== "KeyS") return;
  const save = $("#dSave") ?? $("#cSave") ?? $("#mSave");
  if (!save) return;
  e.preventDefault();
  save.click();
});

bindSidebar(
  scoped ? (id) => {
    if (!canLeaveKnowledge()) return;
    clearDetail();
    selectedNodeId = id;
    must<HTMLSelectElement>("#scopeFilter").value = id;
    syncDocumentActions();
    renderPage();
  } : undefined,
  tree,
  undefined,
  { selectExpandable: scoped },
);

must("#detail").addEventListener("input", updateDetailState);
must("#detail").addEventListener("change", updateDetailState);
for (const selector of ["#gBody", "#cBody"]) {
  $(selector)?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("tr[tabindex]");
    if (!row) return;
    event.preventDefault();
    row.click();
  });
}
window.addEventListener("beforeunload", (event) => {
  if (!allowUnload && (detailSaving || detailIsDirty() || materialEditor.isBusy() || materialEditor.hasUnsavedDraft())) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function boot(): Promise<void> {
  const home = await api.home.get();
  if (home.ok) {
    docs = home.data.documents;
    const requestedNodeId = new URLSearchParams(location.search).get("node");
    selectedNodeId = docs.some((document) => document.id === requestedNodeId) ? requestedNodeId : docs[0]?.id ?? null;
    setSelfTitle(`${TITLES[page]} — ${home.data.project.title}`);
    const projectLabel = $("#materialsProject");
    if (projectLabel) projectLabel.textContent = home.data.project.title;
    if (scoped) {
      renderScopeOptions();
      if (requestedNodeId && docs.some(node => node.id === requestedNodeId)) must<HTMLSelectElement>("#scopeFilter").value = requestedNodeId;
    }
    const path = $("#sbPath");
    if (path) path.textContent = projectLocationLabel(home.data.project);
  } else {
    const path = $("#sbPath");
    if (path) path.textContent = project ? projectLocationLabel(project) : "";
  }
  const result = await api.knowledge.get();
  const v = unwrap(result, t("번역 자료"));
  if (v) data = v;
  try { await refreshMaterials(); } catch { /* The collection displays the retrieval error. */ }
  syncDocumentActions();
  renderPage();
  if (page === "glossary") void glossary?.load();
  if (page !== "context") return;
  if (new URLSearchParams(location.search).get("info") === "1" && selectedNodeId) {
    await showDocumentMetadata(selectedNodeId);
    revealDetail();
  }
  const requestedMaterialId = new URLSearchParams(location.search).get("material");
  const requestedMaterial = materials.items.find(item => item.id === requestedMaterialId);
  if (requestedMaterial) {
    must<HTMLSelectElement>("#scopeFilter").value = "";
    showContext(requestedMaterial);
  }
}

await boot();

registerProjectRefresh({
  blocked: () => detailSaving || detailIsDirty() || materialEditor.isBusy()
    || materialEditor.hasUnsavedDraft() || !!glossary?.hasUnsavedChanges() || !!glossary?.isBusy(),
  version: () => `${knowledgeRefreshVersion}:${page}:${active}:${selectedNodeId}:${metadataDetailId}`,
  async prepare() {
    const [home, nextKnowledge, nextMaterials] = await Promise.all([api.home.get(), api.knowledge.get(), api.knowledge.getMaterials()]);
    if (!home.ok) throw new Error(home.error.message);
    if (!nextKnowledge.ok) throw new Error(nextKnowledge.error.message);
    if (!nextMaterials.ok) throw new Error(nextMaterials.error.message);
    const metadataId = metadataDetailId;
    const metadata = metadataId && home.data.documents.some(doc => doc.id === metadataId) ? await api.home.getDocumentMetadata(metadataId) : null;
    if (metadata && !metadata.ok) throw new Error(metadata.error.message);
    const applyTerms = await glossary?.prepareRefresh();
    return () => {
      const selected = active;
      docs = home.data.documents; data = nextKnowledge.data; materials = nextMaterials.data;
      data.contextItems = materials.items; materialsError = ""; knowledgeRefreshVersion += 1;
      if (selectedNodeId && !docs.some(doc => doc.id === selectedNodeId)) selectedNodeId = null;
      if (scoped) renderScopeOptions();
      const projectLabel = $("#materialsProject");
      if (projectLabel) projectLabel.textContent = home.data.project.title;
      syncDocumentActions();
      setSelfTitle(`${TITLES[page]} — ${home.data.project.title}`);
      renderSidebar(tree(), { currentDocId: null });
      renderPage(); applyTerms?.();
      if (metadataId) { if (metadata?.ok) renderDocumentMetadata(metadata.data); else clearDetail(); }
      else if (selected) {
        const material = materials.items.find(item => item.id === selected);
        const comment = materials.comments.find(item => item.id === selected);
        if (material) showContext(material);
        else if (comment) showComment(comment);
        else clearDetail();
      }
    };
  },
});
