import { configureTermReview } from "./term-review-ui";
import { t, ui, uiText } from "./i18n";
import type {
  DocumentListItem,
  DocumentMetadataView,
  GlossaryEntryView,
  HomeView,
  KnowledgeView,
  NodeContextView,
  MaterialsView,
  MaterialCommentView,
  MaterialPreferenceView,
  UncertaintyView,
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
} from "./shared";

import { KNOWLEDGE_TABS as TABS, knowledgeTabFromHash, USAGE_LABELS, documentPath, documentPathText, orderedDocumentNodes, materialNodeState, type KnowledgeTab as Tab } from "./knowledge-model";
import { materialScopeNodes } from "./material-paths";
import { configureMaterialEditor } from "./material-editor-ui";

const project = await requireProject();
if (!project) throw new Error("redirect");

const NOTES: Record<Tab, string> = {
  glossary: t("프로젝트 공통 번역 표현 · 원문에 일치하는 용어를 번역할 때 참고합니다"),
  uncertainty: t("문서와 구절에 남긴 미해결 해석·근거·대안을 관리합니다"),
  context: t("연결 위치와 하위 문서의 상속 범위를 확인하세요"),
  comments: t("작성 당시 구절과 연결된 검토 기록"),
};

const api = initShell({
  page: "knowledge",
  extraEnabled: ["ctxpane"],
  extraPalette: [
    { g: t("번역 자료"), l: t("배경·지침 보기"), k: "", id: "t-context" },
    { g: t("번역 자료"), l: t("용어집 보기"), k: "", id: "t-glossary" },
    { g: t("번역 자료"), l: t("불확실성 보기"), k: "", id: "t-uncertainty" },
    { g: t("번역 자료"), l: t("코멘트 모아보기"), k: "", id: "t-comments" },
    { g: t("번역 자료"), l: t("항목 추가…"), k: "", id: "addterm" },
  ],
  selfTitle: ui`번역 자료 — ${project.title}`,
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

const termReview = configureTermReview({ api, host: must("#scopedGlossary") });

let data: KnowledgeView = { glossary: [], uncertainties: [], contextItems: [] };
let docs: DocumentListItem[] = [];
let materials: MaterialsView = { items: [], comments: [], preferences: [] };
let materialsError = "";
let tab: Tab = knowledgeTabFromHash(location.hash);
let active: string | null = null;
let selectedNodeId: string | null = null;
let detailBaseline = "";
let addBaseline = "";
let detailSaving = false;
let addSaving = false;
let allowUnload = false;
let metadataDetailId: string | null = null;
let knowledgeRefreshVersion = 0;
const materialEditor = configureMaterialEditor({
  api, documents: () => docs, currentDocumentId: () => selectedNodeId, escape: esc, notify,
  onSaved: async (saved) => {
    await refreshMaterials();
    selectedNodeId = saved.scopeId;
    clearDetail();
    must<HTMLSelectElement>("#scopeFilter").value = "";
    must<HTMLInputElement>("#q").value = "";
    setTab("context");
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

function addIsDirty(): boolean {
  return must<HTMLDialogElement>("#dlgAdd").open && formSnapshot("#addFields") !== addBaseline;
}

function canLeaveKnowledge(): boolean {
  if (detailSaving || addSaving || materialEditor.isBusy()) {
    notify(t("작업을 마치는 중입니다. 잠시 뒤 다시 시도해 주세요."), t("번역 자료"));
    return false;
  }
  return (!termReview.hasUnsavedChanges() && !detailIsDirty() && !addIsDirty() && !materialEditor.hasUnsavedDraft())
    || window.confirm(t("저장하지 않은 변경이 있습니다. 변경을 버리고 이동하시겠습니까?"));
}

function updateDetailState(): void {
  const status = $("#knowledgeSaveStatus");
  if (status) status.textContent = detailSaving ? t("저장 중…") : detailIsDirty() ? t("저장하지 않은 변경") : t("저장됨");
  const save = $<HTMLButtonElement>("#dSave, #cSave, #uSave, #mSave");
  if (save) save.disabled = detailSaving || !detailIsDirty();
}

function trackDetail(): void {
  detailBaseline = formSnapshot("#detail");
  if ($("#dSave, #cSave, #uSave, #mSave")) {
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
  if (detailSaving || addSaving) return;
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

function stTag(st: GlossaryEntryView["usageStatus"]): string {
  const cls = st === "preferred" ? "tag-ok" : st === "forbidden" ? "tag-danger" : "tag-plain";
  return `<span class="tag ${cls}">${USAGE_LABELS[st]}</span>`;
}

function setTab(nextTab: Tab): void {
  if (!TABS.includes(nextTab)) return;
  if (nextTab !== tab) {
    if (!canLeaveKnowledge()) return;
    clearDetail();
  }
  tab = nextTab;
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${nextTab}`);
  $$("#ktabs button").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.tab === nextTab));
    b.setAttribute("aria-controls", `p-${b.dataset.tab}`);
    b.tabIndex = b.dataset.tab === nextTab ? 0 : -1;
  });
  $$(".panel").forEach((p) => p.classList.toggle("is-open", p.id === `p-${nextTab}`));
  const g = nextTab === "glossary";
  must("#btnAdd").hidden = false;
  const allScopeOption = must<HTMLSelectElement>("#scopeFilter").options[0];
  if (allScopeOption) allScopeOption.text = nextTab === "comments" ? t("모든 문서의 코멘트") : t("프로젝트의 모든 자료");
  must("#q").hidden = nextTab === "uncertainty";
  must<HTMLInputElement>("#q").placeholder = g ? t("원문·번역 용어 검색") : nextTab === "comments" ? t("구절·코멘트·문서 경로 검색") : t("제목·내용·연결 경로 검색");
  must("#scopeFilter").hidden = g || nextTab === "uncertainty";
  must<HTMLSelectElement>("#scopeFilter").setAttribute("aria-label", nextTab === "comments" ? t("코멘트 문서 필터") : t("자료를 참고하는 문서 필터"));
  must("#statusSel").hidden = !g;
  must("#btnAdd").textContent =
    nextTab === "glossary" ? t("용어 추가") : nextTab === "uncertainty" ? t("불확실성 추가") : nextTab === "comments" ? t("문서에서 코멘트 쓰기") : t("자료 추가");
  must("#btnOpenDocument").hidden = nextTab !== "context" || selectedNode()?.nodeRole !== "source_unit";
  must("#btnEditMetadata").hidden = nextTab !== "context" || !selectedNode();
  must("#scopeNote").textContent = nextTab === "context" ? contextScopeNote() : NOTES[nextTab];
  renderSidebar(tree(), { currentDocId: null, currentTab: nextTab });
  if (nextTab === "glossary") { renderGlossary(); void termReview.load(true); }
  if (nextTab === "context") renderContext();
  if (nextTab === "uncertainty") renderUncertainties();
  if (nextTab === "comments") renderComments();
}

function renderGlossary(): void {
  const q = must<HTMLInputElement>("#q").value.trim();
  const st = must<HTMLSelectElement>("#statusSel").value;
  const rows = data.glossary.filter(
    (g) =>
      (!q || g.sourceTerm.includes(q) || g.targetTerm.includes(q) || (g.reading ?? "").includes(q)) &&
      (!st || g.usageStatus === st),
  );
  must("#gBody").innerHTML =
    rows
      .map(
        (g) =>
          `<tr data-id="${esc(g.id)}" class="${active === g.id ? "is-active" : ""}" tabindex="0"><td class="term">${esc(g.sourceTerm)}</td><td>${esc(g.targetTerm)}</td><td>${stTag(g.usageStatus)}</td><td class="glossary-note muted">${esc(g.noteMd ?? "")}</td></tr>`,
      )
      .join("") || uiText(`<tr><td colspan="4" class="empty">일치하는 용어가 없습니다.</td></tr>`);
  must("#cntGlossary").textContent = String(data.glossary.length);
  must("#sbG").textContent = String(data.glossary.length);
}

function renderUncertainties(): void {
  must("#uBody").innerHTML = data.uncertainties
    .map((u) => {
      const open = u.state === "open";
      return `<tr data-u="${esc(u.id)}" class="${active === u.id ? "is-active" : ""}" tabindex="0"><td class="mono">${esc(u.id.slice(0, 8))}</td><td>${esc(u.statementMd)}<div class="muted" style="font-size:12.5px;margin-top:2px">${esc(u.locator)}</div></td><td><span class="tag tag-warn">${esc(u.category)}</span></td><td class="mono muted" style="font-size:11.5px">${esc(u.locator)}</td><td>${open ? uiText('<span class="tag tag-draft">열림</span>') : uiText('<span class="tag tag-ok">해결</span>')}</td></tr>`;
    })
    .join("");
  must("#cntUnc").textContent = String(data.uncertainties.length);
  must("#sbU").textContent = String(data.uncertainties.filter((u) => u.state === "open").length);
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
  return scope ? ui`${pathLabel(scope)} · 직접·상속·선택 자료` : NOTES.context;
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
    return ui`<button type="button" class="material-row ${active === item.id ? "is-active" : ""}" data-cid="${esc(item.id)}" aria-pressed="${active === item.id}">${trail(item.scopeId)}<h3>${esc(item.title)}</h3>${item.reference?.needsReview || item.reference?.sourceChanged || item.reference?.sourceUnavailable ? `<small>확인 필요 · AI 적용 안 됨</small>` : ""}<p>${esc(item.contentMd || (item.reference ? item.origin?.bodyMd : "") || "")}</p><div class="material-row-footer"><span>${state?.included ? scopeLabel : item.enabled ? scopeLabel : t("자동 포함 꺼짐")}</span><span>${materialUseCount(item)}개 원문에서 참고</span></div>${item.origin ? uiText('<span class="material-origin-label">참고 코멘트 연결</span>') : item.source === "document_description" ? uiText('<span class="material-origin-label">문서 정보의 설명</span>') : ""}</button>`;
  };
  const known = new Set(docs.map(node => node.id));
  const unlinked = rows.filter(item => !known.has(item.scopeId));
  must("#cBody").innerHTML = materialsError ? `<p class="material-error" role="alert">${esc(materialsError)}</p>` : groups.map(({ node, rows: list }) => ui`<section class="node-materials"><div class="node-group-heading">${ic(node.nodeRole === "container" ? "folder" : "doc")}<div><strong>${esc(node.originalTitle || node.title)}</strong>${trail(node.id)}</div><small>자료 ${list.length}</small></div>${list.filter(item => item.source !== "comment_reference").map(renderRow).join("")}${list.some(item => item.source === "comment_reference") ? `<h3 class="material-help">참고 코멘트 연결</h3>${list.filter(item => item.source === "comment_reference").map(renderRow).join("")}` : ""}</section>`).join("") + (unlinked.length ? ui`<section class="node-materials"><h3>연결 위치 확인 필요</h3>${unlinked.map(renderRow).join("")}</section>` : "");
  must("#contextEmpty").hidden = rows.length > 0 || !!materialsError;
  must("#cntContext").textContent = String(materials.items.length);
  must("#sbC").textContent = String(materials.items.length);
  if (tab === "context") must("#scopeNote").textContent = contextScopeNote();
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
  must("#detail").innerHTML = ui`<h2>${esc(item.title)}</h2>${item.reference?.needsReview || item.reference?.sourceChanged || item.reference?.sourceUnavailable ? `<p class="material-help">${item.reference.sourceUnavailable ? "원본 코멘트가 삭제되었습니다." : item.reference.sourceChanged ? "원본 코멘트가 변경되었습니다." : "기존 편집본을 보충 메모로 보존했습니다."} 확인 전에는 AI에 적용하지 않습니다. 연결 편집에서 내용을 확인하세요.</p>` : ""}<div class="material-section"><h3>자료가 연결된 위치</h3>${trail(item.scopeId)}${scopeTree(item)}<p class="material-help">${(item.inheritToChildren ?? true) ? t("연결된 위치와 그 하위 문서에서 참고합니다.") : t("이 자료는 연결된 문서에서만 참고합니다.")}${item.enabled ? "" : t(" 자동 포함이 꺼져 있습니다. 문서에서 직접 선택한 경우에는 참고할 수 있습니다.")}</p></div><section class="material-section"><h3>${item.reference ? "보충 메모" : "참고 내용"}</h3><p class="material-body">${esc(item.contentMd || (item.reference ? "보충 메모가 없습니다." : ""))}</p>${item.conditionMd ? ui`<div class="material-condition"><b>적용 조건·예외</b><br>${esc(item.conditionMd)}</div>` : ""}</section>${originHtml(item)}<div class="material-actions"><button class="btn btn-primary btn-sm" type="button" id="editMaterial">${item.source === "document_description" ? t("문서 정보 편집") : item.reference ? t("연결 편집") : t("자료 편집")}</button>${item.source !== "document_description" ? ui`<button class="btn btn-sm btn-danger" type="button" id="deleteMaterial">${item.reference ? "연결 해제" : "삭제"}</button>` : ""}</div>`;
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
  must("#cntComments").textContent = String(materials.comments.length);
  must("#commentsBody").innerHTML = materialsError ? `<p class="material-error" role="alert">${esc(materialsError)}</p>` : rows.map(comment => `<button type="button" class="material-row ${active === comment.id ? "is-active" : ""}" data-comment-id="${esc(comment.id)}" aria-pressed="${active === comment.id}">${trail(comment.documentNodeId)}<blockquote class="material-quote">${esc(comment.quote)}</blockquote><p>${esc(comment.bodyMd)}</p><div class="material-row-footer"><span>${esc(comment.authorName)} · ${esc(comment.updatedAt.slice(0, 10))}</span><span>${comment.materialIds.length ? ui`참고 자료 ${comment.materialIds.length}개에 연결됨` : t("원래 구절의 검토 기록")}</span></div></button>`).join("") || uiText('<p class="empty">일치하는 코멘트가 없습니다. 문서의 구절에 남긴 코멘트가 여기에 모입니다.</p>');
}
function showComment(comment: MaterialCommentView): void {
  clearDetail(); active = comment.id; selectedNodeId = comment.documentNodeId; renderComments();
  must("#detailMeta").textContent = t("원래 구절에 남긴 코멘트");
  must("#sbSel").textContent = comment.quote;
  const linked = materials.items.filter(item => comment.materialIds.includes(item.id));
  must("#detail").innerHTML = ui`<h2>구절에 남긴 판단</h2>${trail(comment.documentNodeId)}<blockquote class="material-quote">${esc(comment.quote)}</blockquote><p class="material-body">${esc(comment.bodyMd)}</p><p class="material-help">${esc(comment.authorName)} · ${esc(comment.updatedAt.slice(0, 16).replace("T", " "))}<br>${comment.targetKind === "source" ? t("원문") : t("번역문")}의 작성 당시 구절에 연결된 기록입니다.</p>${linked.length ? ui`<section class="material-section"><h3>이 코멘트의 참고 연결</h3>${linked.map(item => `<button class="material-row" type="button" data-show-material="${esc(item.id)}"><h3>${esc(item.title)}</h3>${item.reference?.needsReview || item.reference?.sourceChanged || item.reference?.sourceUnavailable ? `<small>확인 필요 · AI 적용 안 됨</small>` : ""}${trail(item.scopeId)}</button>`).join("")}</section>` : ""}<section class="material-section"><h3>다른 번역에 활용하기</h3><p class="material-help">참고할 내용과 조건, 연결 위치를 직접 정합니다. 원래 코멘트는 그대로 남습니다.</p></section><div class="material-actions"><button class="btn btn-primary" type="button" id="reuseComment">다른 문서에서도 참고</button><button class="btn" type="button" data-open-origin="${esc(comment.documentNodeId)}">원래 문서 열기 ↗</button></div>`;
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
  renderSidebar(tree(), { currentDocId: null, currentTab: tab });
  renderContext(); renderComments();
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
    renderSidebar(tree(), { currentDocId: null, currentTab: tab });
    const refreshed = await api.knowledge.get();
    const knowledge = unwrap(refreshed, t("번역 자료"));
    if (knowledge) data = knowledge;
    await refreshMaterials();
    renderContext();
    await showDocumentMetadata(saved.id);
    notify(ui`${saved.title} 정보 저장`, t("문서 정보"));
  }));
}

function showGlossary(g: GlossaryEntryView): void {
  metadataDetailId = null;
  knowledgeRefreshVersion += 1;
  active = g.id;
  renderGlossary();
  must("#detailMeta").textContent = g.id.slice(0, 8);
  must("#sbSel").textContent = `${g.sourceTerm} → ${g.targetTerm}`;
  must("#detail").innerHTML = ui`<div class="detail">
      <div class="term" style="font-size:20px">${esc(g.sourceTerm)} <span class="muted" style="font-family:var(--font-ui);font-size:12px">${esc(g.reading ?? "")}</span></div>
      <div class="field"><label for="dTgt">번역 용어</label><input class="input" id="dTgt" value="${esc(g.targetTerm)}"></div>
      <div class="field"><label for="dSt">사용 상태</label><select class="select" id="dSt">${Object.entries(USAGE_LABELS).map(([value, label]) => `<option value="${value}" ${g.usageStatus === value ? "selected" : ""}>${label}</option>`).join("")}</select></div>
      <div class="field"><label for="dNote">메모</label><textarea class="textarea" id="dNote">${esc(g.noteMd ?? "")}</textarea></div>
      <details class="glossary-extra"><summary>보조 정보</summary><dl class="kv"><dt>독음</dt><dd>${esc(g.reading ?? "—")}</dd><dt>종류</dt><dd>${esc(g.termKind)}</dd><dt>번역 언어</dt><dd>${esc(g.targetLocale)}</dd></dl></details>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary btn-sm" id="dSave" type="button">저장 <kbd>⌘S</kbd></button></div>
    </div>`;
  trackDetail();
  must("#dSave").addEventListener("click", () => void runDetailOperation(() => saveGlossary(g)));
}

async function saveGlossary(g: GlossaryEntryView): Promise<void> {
  const target = must<HTMLInputElement>("#dTgt").value.trim();
  if (!target) {
    notify(t("번역 용어를 입력해 주세요."), t("용어집"));
    return;
  }
  const st = must<HTMLSelectElement>("#dSt").value as GlossaryEntryView["usageStatus"];
  if (
    st === "preferred" &&
    data.glossary.some((x) => x.id !== g.id && x.sourceTerm === g.sourceTerm && x.targetLocale === g.targetLocale && x.usageStatus === "preferred")
  ) {
    notify(ui`${g.sourceTerm}에는 이미 기본 표현이 있습니다. 기존 항목을 허용으로 바꾼 뒤 저장하세요`, t("저장 실패"));
    return;
  }
  const result = await api.knowledge.upsertGlossary({
    id: g.id,
    expectedLockVersion: g.lockVersion,
    sourceTerm: g.sourceTerm,
    targetTerm: target,
    targetLocale: g.targetLocale,
    termKind: g.termKind,
    reading: g.reading,
    noteMd: must<HTMLTextAreaElement>("#dNote").value.trim() || null,
    usageStatus: st,
  });
  const saved = unwrap(result, t("용어집"));
  if (!saved) return;
  const i = data.glossary.findIndex((x) => x.id === g.id);
  if (i >= 0) data.glossary[i] = saved;
  notify(ui`${saved.sourceTerm} 저장`, t("용어집"));
  showGlossary(saved);
}

function showUnc(u: UncertaintyView): void {
  metadataDetailId = null;
  knowledgeRefreshVersion += 1;
  active = u.id;
  renderUncertainties();
  must("#detailMeta").textContent = `${u.id.slice(0, 8)} · ${u.category} · ${u.severity}`;
  must("#sbSel").textContent = `${u.id.slice(0, 8)} ${u.state === "open" ? t("열림") : t("해결")}`;
  must("#detail").innerHTML = ui`<div class="detail">
      <div class="muted mono" style="font-size:11.5px">v${u.versionNo} · ${esc(u.locator)}</div>
      <div class="field"><label for="uStatement">진술</label><textarea class="textarea" id="uStatement">${esc(u.statementMd)}</textarea></div>
      <div class="row" style="gap:10px"><div class="field" style="flex:1"><label for="uCategory">범주</label><select class="select" id="uCategory">${["textual", "interpretive", "identification"].map((value) => `<option ${value === u.category ? "selected" : ""}>${value}</option>`).join("")}</select></div><div class="field" style="flex:1"><label for="uSeverity">심각도</label><input class="input" id="uSeverity" value="${esc(u.severity)}"></div></div>
      <div class="field"><label for="uConfidence">확신도 표기</label><input class="input" id="uConfidence" value="${esc(u.confidenceLabel ?? "")}" placeholder="예: 확정, 유력, 미상"></div>
      <div class="field"><label for="uRationale">근거</label><textarea class="textarea" id="uRationale">${esc(u.rationaleMd ?? "")}</textarea></div>
      <div class="field"><label for="uOptions">해석 선택지 (한 줄에 하나)</label><textarea class="textarea" id="uOptions">${esc(u.options.map((option) => option.label).join("\n"))}</textarea></div>
      <label><input type="checkbox" id="uBlocking" ${u.blocking ? "checked" : ""}> 해결 전 번역 확정 차단</label>
      <div class="row" style="justify-content:flex-end">${u.state === "open" ? uiText(`<button class="btn btn-sm" id="uResolve" type="button">해결로 표시</button><button class="btn btn-primary btn-sm" id="uSave" type="button">새 버전 저장</button>`) : uiText('<span class="tag tag-ok">해결</span>')}</div>
    </div>`;
  if (u.state !== "open") {
    $$<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#detail input, #detail textarea, #detail select")
      .forEach((field) => { field.disabled = true; });
  }
  trackDetail();
  $("#uResolve")?.addEventListener("click", () => {
    if (!canLeaveKnowledge()) return;
    void runDetailOperation(() => resolveUncertainty(u));
  });
  $("#uSave")?.addEventListener("click", () => void runDetailOperation(() => saveUncertaintyVersion(u)));
}

function replaceUncertainty(saved: UncertaintyView): void {
  const index = data.uncertainties.findIndex((item) => item.id === saved.id);
  if (index >= 0) data.uncertainties[index] = saved;
  else data.uncertainties.unshift(saved);
  renderUncertainties();
  showUnc(saved);
}

async function saveUncertaintyVersion(u: UncertaintyView): Promise<void> {
  const optionLabels = must<HTMLTextAreaElement>("#uOptions").value
    .split("\n")
    .map((label) => label.trim())
    .filter(Boolean);
  const result = await api.knowledge.versionUncertainty({
    uncertaintyId: u.id,
    expectedVersionId: u.versionId,
    category: must<HTMLSelectElement>("#uCategory").value as UncertaintyView["category"],
    severity: must<HTMLInputElement>("#uSeverity").value.trim(),
    blocking: must<HTMLInputElement>("#uBlocking").checked,
    statementMd: must<HTMLTextAreaElement>("#uStatement").value.trim(),
    rationaleMd: must<HTMLTextAreaElement>("#uRationale").value.trim() || null,
    confidenceLabel: must<HTMLInputElement>("#uConfidence").value.trim() || null,
    options: optionLabels.map((label, index) => ({
      label,
      interpretationMd: u.options[index]?.label === label ? u.options[index]?.interpretationMd : null,
    })),
    anchors: u.anchors.map((anchor) => ({
      targetKind: anchor.targetKind,
      targetVersionId: anchor.targetVersionId,
      codepointFrom: anchor.codepointFrom,
      codepointTo: anchor.codepointTo,
      quote: anchor.quote,
    })),
  });
  const saved = unwrap(result, t("불확실성"));
  if (!saved) return;
  replaceUncertainty(saved);
  notify(ui`v${saved.versionNo} 저장`, t("불확실성"));
}

async function resolveUncertainty(u: UncertaintyView): Promise<void> {
  const result = await api.knowledge.resolveUncertainty({ uncertaintyId: u.id, expectedVersionId: u.versionId });
  const saved = unwrap(result, t("불확실성"));
  if (!saved) return;
  replaceUncertainty(saved);
  notify(t("해결 상태로 변경했습니다"), t("불확실성"));
}

function addFieldsHtml(): string {
  if (tab === "uncertainty") {
    return ui`<div class="field"><label for="aScope">연결 문서</label><select class="select" id="aScope">${documentOptions(selectedNodeId)}</select></div>
      <div class="row" style="gap:10px"><div class="field" style="flex:1"><label for="aCategory">범주</label><select class="select" id="aCategory"><option>textual</option><option>interpretive</option><option>identification</option></select></div><div class="field" style="flex:1"><label for="aSeverity">심각도</label><select class="select" id="aSeverity"><option>minor</option><option>major</option><option>critical</option></select></div></div>
      <div class="field"><label for="aStatement">진술</label><textarea class="textarea" id="aStatement" required></textarea></div>
      <div class="field"><label for="aConfidence">확신도 표기</label><input class="input" id="aConfidence" placeholder="예: 확정, 유력, 미상"></div>
      <div class="field"><label for="aNote">근거</label><textarea class="textarea" id="aNote"></textarea></div>
      <div class="field"><label for="aOptions">해석 선택지 (한 줄에 하나)</label><textarea class="textarea" id="aOptions"></textarea></div>
      <label><input type="checkbox" id="aBlocking"> 해결 전 번역 확정 차단</label>`;
  }
  return uiText(`<div class="row" style="gap:10px;align-items:flex-start">
        <div class="field" style="flex:1"><label for="aSrc">원문 용어</label><input class="input hanmun" id="aSrc" required placeholder="例: 集賢殿" style="font-size:14px"></div>
        <div class="field" style="flex:1"><label for="aTgt">번역 용어</label><input class="input" id="aTgt" required placeholder="예: 집현전(集賢殿)"></div>
      </div>
      <details class="glossary-extra"><summary>보조 정보 · 종류와 독음</summary><div class="row" style="gap:10px;align-items:flex-start">
        <div class="field" style="flex:1"><label for="aKind">종류</label><select class="select" id="aKind"><option>general</option><option>technical</option><option>institution</option><option>office</option><option>book_title</option><option>era</option><option>other</option></select></div>
        <div class="field" style="flex:1"><label for="aRead">독음</label><input class="input" id="aRead" placeholder="예: 집현전"></div>
      </div></details>
      <div class="field"><label>사용 상태</label>
        <div class="radio-list">
          <label><input type="radio" name="st" value="preferred" checked> 기본 <span class="muted">· 기본 대응어. 용어당 하나</span></label>
          <label><input type="radio" name="st" value="allowed"> 허용 <span class="muted">· 문맥에 따라 허용</span></label>
          <label><input type="radio" name="st" value="forbidden"> 지양 <span class="muted">· 번역 검토에서 경고</span></label>
        </div>
      </div>
      <div class="field"><label for="aNote">메모</label><textarea class="textarea" id="aNote" placeholder="근거·출처·주의점"></textarea></div>`);
}

function documentOptions(selected: string | null): string {
  return orderedDocumentNodes(docs).map(doc => `<option value="${esc(doc.id)}" ${doc.id === selected ? "selected" : ""}>${esc(pathLabel(doc.id))}</option>`).join("");
}

function openAdd(): void {
  if (!canLeaveKnowledge()) return;
  if (detailIsDirty()) clearDetail();
  if (tab === "context") { materialEditor.open({ scopeId: selectedNodeId ?? undefined }); return; }
  if (tab === "comments") {
    const node = selectedNode()?.nodeRole === "source_unit" ? selectedNode() : docs.find(candidate => candidate.nodeRole === "source_unit");
    if (node) go("editor", node.id);
    else notify(t("먼저 원문 문서를 만들어 주세요."), t("코멘트"));
    return;
  }
  must("#addTitle").textContent =
    tab === "glossary" ? t("용어 추가") : tab === "uncertainty" ? t("불확실성 추가") : t("참고 자료 추가");
  must("#addFields").innerHTML = addFieldsHtml();
  addBaseline = formSnapshot("#addFields");
  (must("#dlgAdd") as HTMLDialogElement).showModal();
}

function pageCmd(id: string): boolean {
  if (id.startsWith("t-")) {
    setTab(id.slice(2) as Tab);
    return true;
  }
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
  if (m && !e.shiftKey && !e.altKey && e.code === "KeyF") {
    e.preventDefault();
    must<HTMLInputElement>("#q").focus();
  }
}

must("#ktabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b instanceof HTMLElement && b.dataset.tab) setTab(b.dataset.tab as Tab);
});
must("#ktabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index = TABS.indexOf(tab);
  const next = event.key === "Home" ? TABS[0] : event.key === "End" ? TABS[TABS.length - 1]
    : TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
  if (!next) return;
  setTab(next);
  if (tab === next) $<HTMLButtonElement>(`#ktabs [data-tab="${next}"]`)?.focus();
});
["#q", "#statusSel", "#scopeFilter"].forEach((s) => {
  $(s)?.addEventListener("input", () => {
    if (s === "#scopeFilter") {
      selectedNodeId = must<HTMLSelectElement>("#scopeFilter").value || docs.find(node => node.isMaster)?.id || null;
      must("#btnEditMetadata").hidden = tab !== "context" || !selectedNode();
      must("#btnOpenDocument").hidden = tab !== "context" || selectedNode()?.nodeRole !== "source_unit";
    }
    renderGlossary();
    renderUncertainties();
    renderContext();
    renderComments();
  });
});
must("#gBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-id]");
  if (tr instanceof HTMLElement && tr.dataset.id) {
    const g = data.glossary.find((x) => x.id === tr.dataset.id);
    if (g && canLeaveKnowledge()) showGlossary(g);
  }
});
must("#uBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-u]");
  if (tr instanceof HTMLElement && tr.dataset.u) {
    const u = data.uncertainties.find((x) => x.id === tr.dataset.u);
    if (u && canLeaveKnowledge()) showUnc(u);
  }
});
must("#cBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("[data-cid]");
  if (!(tr instanceof HTMLElement) || !tr.dataset.cid) return;
  const item = materials.items.find((candidate) => candidate.id === tr.dataset.cid);
  if (item && canLeaveKnowledge()) showContext(item);
});
must("#commentsBody").addEventListener("click", event => {
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-comment-id]");
  const comment = materials.comments.find(item => item.id === row?.dataset.commentId);
  if (comment && canLeaveKnowledge()) showComment(comment);
});
must("#detail").addEventListener("click", event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-open-material-node], [data-open-origin], [data-show-material]");
  if (!target || !canLeaveKnowledge()) return;
  if (target.dataset.showMaterial) {
    const item = materials.items.find(candidate => candidate.id === target.dataset.showMaterial);
    if (item) { setTab("context"); showContext(item); }
    return;
  }
  const id = target.dataset.openMaterialNode ?? target.dataset.openOrigin;
  const node = docs.find(candidate => candidate.id === id);
  if (node) go(node.nodeRole === "source_unit" ? "editor" : "context", node.id);
});
must("#btnOpenDocument").addEventListener("click", () => {
  const node = selectedNode();
  if (node?.nodeRole === "source_unit") go("editor", node.id);
});
must("#btnEditMetadata").addEventListener("click", () => {
  const node = selectedNode();
  if (node && canLeaveKnowledge()) void runDetailOperation(() => showDocumentMetadata(node.id));
});
must("#btnAdd").addEventListener("click", openAdd);
function canCloseAdd(): boolean {
  return !addSaving && (!addIsDirty() || window.confirm(t("입력한 내용을 버리고 닫으시겠습니까?")));
}
must("#addCancel").addEventListener("click", () => {
  if (canCloseAdd()) must<HTMLDialogElement>("#dlgAdd").close();
});
must<HTMLDialogElement>("#dlgAdd").addEventListener("cancel", (event) => {
  if (!canCloseAdd()) event.preventDefault();
});
must<HTMLFormElement>("#addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (addSaving || detailSaving) return;
  addSaving = true;
  must("#addForm").inert = true;
  must("#addForm").setAttribute("aria-busy", "true");
  void (async () => {
    if (tab === "uncertainty") {
      const scopeId = must<HTMLSelectElement>("#aScope").value;
      const result = await api.knowledge.createUncertainty({
        category: must<HTMLSelectElement>("#aCategory").value as UncertaintyView["category"],
        severity: must<HTMLSelectElement>("#aSeverity").value,
        blocking: must<HTMLInputElement>("#aBlocking").checked,
        statementMd: must<HTMLTextAreaElement>("#aStatement").value.trim(),
        rationaleMd: must<HTMLTextAreaElement>("#aNote").value.trim() || null,
        confidenceLabel: must<HTMLInputElement>("#aConfidence").value.trim() || null,
        options: must<HTMLTextAreaElement>("#aOptions").value.split("\n").map((label) => label.trim()).filter(Boolean).map((label) => ({ label })),
        anchors: [{ targetKind: "document_node", targetVersionId: scopeId }],
      });
      const saved = unwrap(result, t("불확실성"));
      if (!saved) return;
      data.uncertainties.unshift(saved);
      (must("#dlgAdd") as HTMLDialogElement).close();
      renderUncertainties();
      showUnc(saved);
      notify(t("불확실성 추가"), t("불확실성"));
      return;
    }
    if (tab === "glossary") {
      const src = must<HTMLInputElement>("#aSrc").value.trim();
      const tgt = must<HTMLInputElement>("#aTgt").value.trim();
      const st = (document.querySelector('input[name="st"]:checked') as HTMLInputElement | null)?.value as
        | GlossaryEntryView["usageStatus"]
        | undefined;
      if (!src || !tgt) return;
      if (st === "preferred" && data.glossary.some((x) => x.sourceTerm === src && x.targetLocale === "ko" && x.usageStatus === "preferred")) {
        notify(ui`${src}에는 이미 기본 표현이 있습니다. 기존 항목을 수정하거나 허용 표현으로 등록해 주세요.`, t("추가 실패"));
        return;
      }
      const result = await api.knowledge.upsertGlossary({
        sourceTerm: src,
        targetTerm: tgt,
        targetLocale: "ko",
        termKind: must<HTMLSelectElement>("#aKind").value,
        reading: must<HTMLInputElement>("#aRead").value.trim() || null,
        noteMd: must<HTMLTextAreaElement>("#aNote").value.trim() || null,
        usageStatus: st ?? "preferred",
      });
      const saved = unwrap(result, t("용어집"));
      if (!saved) return;
      data.glossary.unshift(saved);
      (must("#dlgAdd") as HTMLDialogElement).close();
      renderGlossary();
      renderSidebar(tree(), { currentTab: tab });
      showGlossary(saved);
      notify(ui`${src} → ${tgt} 추가`, t("용어집"));
      return;
    }
  })().catch(() => {
    notify(t("항목을 추가하지 못했습니다. 입력한 내용은 유지됩니다. 다시 시도해 주세요."), t("번역 자료"));
  }).finally(() => {
    addSaving = false;
    must("#addForm").inert = false;
    must("#addForm").removeAttribute("aria-busy");
  });
});
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.code !== "KeyS") return;
  if (must<HTMLDialogElement>("#dlgAdd").open) {
    e.preventDefault();
    if (!addSaving) must<HTMLFormElement>("#addForm").requestSubmit();
    return;
  }
  const save = $("#dSave") ?? $("#cSave") ?? $("#uSave") ?? $("#mSave");
  if (!save) return;
  e.preventDefault();
  save.click();
});

bindSidebar(
  (id) => {
    if (!canLeaveKnowledge()) return;
    clearDetail();
    selectedNodeId = id;
    must<HTMLSelectElement>("#scopeFilter").value = id;
    setTab("context");
  },
  (nextTab) => setTab(nextTab as Tab),
  tree,
  undefined,
  { selectExpandable: true },
);

must("#detail").addEventListener("input", updateDetailState);
must("#detail").addEventListener("change", updateDetailState);
for (const selector of ["#gBody", "#uBody", "#cBody"]) {
  must(selector).addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("tr[tabindex]");
    if (!row) return;
    event.preventDefault();
    row.click();
  });
}
window.addEventListener("beforeunload", (event) => {
  if (!allowUnload && (detailSaving || addSaving || detailIsDirty() || addIsDirty() || materialEditor.isBusy() || materialEditor.hasUnsavedDraft())) {
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
    setSelfTitle(ui`번역 자료 — ${home.data.project.title}`);
    must("#materialsProject").textContent = home.data.project.title;
    must("#scopeFilter").innerHTML = ui`<option value="">프로젝트의 모든 자료</option>${documentOptions(null)}`;
    if (requestedNodeId && docs.some(node => node.id === requestedNodeId)) must<HTMLSelectElement>("#scopeFilter").value = requestedNodeId;
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
  renderGlossary();
  renderUncertainties();
  renderContext();
  setTab(tab);
  if (new URLSearchParams(location.search).get("info") === "1" && selectedNodeId) {
    await showDocumentMetadata(selectedNodeId);
    revealDetail();
  }
  const requestedMaterialId = new URLSearchParams(location.search).get("material");
  const requestedMaterial = materials.items.find(item => item.id === requestedMaterialId);
  if (requestedMaterial) {
    must<HTMLSelectElement>("#scopeFilter").value = "";
    setTab("context");
    showContext(requestedMaterial);
  }
}

await boot();

registerProjectRefresh({
  blocked: () => detailSaving || addSaving || detailIsDirty() || addIsDirty() || materialEditor.isBusy()
    || materialEditor.hasUnsavedDraft() || termReview.hasUnsavedChanges() || termReview.isBusy(),
  version: () => `${knowledgeRefreshVersion}:${tab}:${active}:${selectedNodeId}:${metadataDetailId}`,
  async prepare() {
    const [home, nextKnowledge, nextMaterials] = await Promise.all([api.home.get(), api.knowledge.get(), api.knowledge.getMaterials()]);
    if (!home.ok) throw new Error(home.error.message);
    if (!nextKnowledge.ok) throw new Error(nextKnowledge.error.message);
    if (!nextMaterials.ok) throw new Error(nextMaterials.error.message);
    const metadataId = metadataDetailId;
    const metadata = metadataId && home.data.documents.some(doc => doc.id === metadataId) ? await api.home.getDocumentMetadata(metadataId) : null;
    if (metadata && !metadata.ok) throw new Error(metadata.error.message);
    const applyTerms = await termReview.prepareRefresh();
    return () => {
      const selected = active;
      const filter = must<HTMLSelectElement>("#scopeFilter").value;
      docs = home.data.documents; data = nextKnowledge.data; materials = nextMaterials.data;
      data.contextItems = materials.items; materialsError = ""; knowledgeRefreshVersion += 1;
      if (selectedNodeId && !docs.some(doc => doc.id === selectedNodeId)) selectedNodeId = null;
      must<HTMLSelectElement>("#scopeFilter").innerHTML = `<option value="">${esc(tab === "comments" ? t("모든 문서의 코멘트") : t("프로젝트의 모든 자료"))}</option>${documentOptions(null)}`;
      must<HTMLSelectElement>("#scopeFilter").value = docs.some(doc => doc.id === filter) ? filter : "";
      must("#materialsProject").textContent = home.data.project.title;
      must("#btnEditMetadata").hidden = tab !== "context" || !selectedNode();
      must("#btnOpenDocument").hidden = tab !== "context" || selectedNode()?.nodeRole !== "source_unit";
      setSelfTitle(ui`번역 자료 — ${home.data.project.title}`);
      renderSidebar(tree(), { currentDocId: null, currentTab: tab });
      renderGlossary(); renderUncertainties(); renderContext(); renderComments(); applyTerms();
      if (metadataId) { if (metadata?.ok) renderDocumentMetadata(metadata.data); else clearDetail(); }
      else if (selected) {
        const glossary = data.glossary.find(item => item.id === selected);
        const uncertainty = data.uncertainties.find(item => item.id === selected);
        const material = materials.items.find(item => item.id === selected);
        const comment = materials.comments.find(item => item.id === selected);
        if (glossary) showGlossary(glossary);
        else if (uncertainty) showUnc(uncertainty);
        else if (material) showContext(material);
        else if (comment) showComment(comment);
        else clearDetail();
      }
    };
  },
});
