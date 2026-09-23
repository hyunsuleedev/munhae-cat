import { t, uiText, ui } from "./i18n";
import type {
  DocumentListItem, EditorView, MaterialCommentView, MaterialOrigin, MaterialsView,
  MunhaeApi, NodeContextView, ResolvedMaterialView, ReviewCommentView,
} from "../../shared/munhae-api";
import { configureMaterialEditor } from "./material-editor-ui";
import { materialNodePath, materialPathLabel } from "./material-paths";
import "../styles/document-materials.css";

type Deps = {
  api: MunhaeApi;
  documents(): DocumentListItem[];
  view(): EditorView | null;
  escape(value: unknown): string;
  notify(message: string, title?: string): void;
  canChange(): boolean;
  openPreparation(): void;
  openDocument(id: string): void | Promise<void>;
  openMaterials(id?: string): void;
  changed(): void;
};

export function configureDocumentMaterials(deps: Deps) {
  const host = document.querySelector<HTMLElement>("#documentMaterials")!;
  const esc = deps.escape;
  let data: MaterialsView | null = null;
  let documentId: string | null = null;
  let versionKey = "";
  let serial = 0;
  let loading = false;
  let saving = false;
  let error = "";
  let showExcluded = true;
  const oneOff = new Map<string, MaterialCommentView>();
  const picked = new Set<string>();
  let pickerKind: "materials" | "comments" = "materials";
  let pickerDocumentId: string | null = null;
  let pickerOpener: HTMLElement | null = null;
  let sourceOpener: HTMLElement | null = null;
  const picker = document.createElement("dialog");
  picker.className = "document-material-dialog";
  picker.setAttribute("aria-label", t("다른 문서에서 참고 자료 가져오기"));
  const sourceDialog = document.createElement("dialog");
  sourceDialog.className = "document-material-dialog";
  sourceDialog.setAttribute("aria-label", t("참고 자료의 출처"));
  document.body.append(picker, sourceDialog);
  const materialEditor = configureMaterialEditor({
    api: deps.api, documents: deps.documents, currentDocumentId: () => documentId, escape: esc, notify: deps.notify,
    onSaved: async () => { await load(); deps.changed(); },
  });

  function sourceId(item: NodeContextView): string { return item.source === "document_description" ? item.scopeId : item.id; }
  function preference(item: NodeContextView) {
    return data?.preferences.find(entry => entry.documentNodeId === documentId && entry.source === item.source && entry.sourceId === sourceId(item));
  }
  function path(id: string): string { return materialPathLabel(deps.documents(), id); }
  function isCurrent(id: string | null): boolean { return id !== null && id === documentId && id === deps.view()?.document.id; }
  function isBusy(): boolean { return saving || materialEditor.isBusy(); }
  function canChange(): boolean { return !!documentId && !loading && !isBusy() && deps.canChange(); }
  function refs(): ResolvedMaterialView[] { return data?.resolved ?? []; }
  function included(item: ResolvedMaterialView): boolean { return item.included; }
  function activeIds(): string[] { return [...oneOff.keys()]; }
  const materialById = (id: string) => data?.items.find(item => item.id === id);

  function render(): void {
    const scroll = host.closest<HTMLElement>(".pane-scroll");
    const scrollTop = scroll?.scrollTop ?? 0;
    const active = document.activeElement instanceof HTMLInputElement ? document.activeElement.dataset.materialInclude : undefined;
    if (!documentId) { host.innerHTML = uiText('<p class="muted">문서를 선택하면 참고 자료를 볼 수 있습니다.</p>'); return; }
    if (loading && !data) { host.innerHTML = uiText('<p class="muted" role="status">번역 자료를 불러오는 중…</p>'); return; }
    const rows = refs();
    const documents = deps.documents();
    const lineage = materialNodePath(documents, documentId);
    const count = rows.filter(included).length + oneOff.size;
    const chain = lineage.map((node, index) => {
      const atNode = rows.filter(item => item.scopeId === node.id && item.reason !== "selected");
      const enabled = atNode.filter(included).length;
      return `<li style="--material-depth:${Math.min(index, 8)}"><span>${esc(node.originalTitle || node.title)}<small>${node.id === documentId ? t("현재 노드에 둔 자료") : node.isMaster ? t("상위 프로젝트") : t("상위 노드")}</small></span><b>${enabled === atNode.length ? enabled : `${enabled}/${atNode.length}`}</b></li>`;
    }).join("");
    const groups = lineage.map(node => ({ label: node.id === documentId ? t("현재 문서") : node.isMaster ? t("상위 프로젝트") : t("상위 노드"), node,
      items: rows.filter(item => item.scopeId === node.id && item.reason !== "selected") }));
    const selected = rows.filter(item => item.reason === "selected");
    const renderGroup = (label: string, title: string, items: ResolvedMaterialView[]) => {
      const visible = showExcluded ? items : items.filter(included);
      if (!visible.length) return "";
      return `<section class="document-material-group"><header><span>${esc(label)}</span><strong>${esc(title)}</strong><small>${items.filter(included).length}/${items.length}</small></header>${visible.filter(item => item.source !== "comment_reference").map(card).join("")}${visible.some(item => item.source === "comment_reference") ? `<h4>참고 코멘트</h4>${visible.filter(item => item.source === "comment_reference").map(card).join("")}` : ""}</section>`;
    };
    host.innerHTML = ui`<div class="document-material-heading"><h2>이번 번역의 참고 자료</h2><span>${count}개 사용</span></div><section class="document-material-chain" aria-label="현재 문서의 상위 경로"><p>현재 문서와 상위 노드</p><ol class="material-node-chain">${chain}</ol></section>${error ? ui`<p class="document-material-error" role="alert">${esc(error)} <button type="button" class="btn btn-sm" data-material-action="reload">다시 불러오기</button></p>` : ""}${groups.map(group => renderGroup(group.label, group.node.originalTitle || group.node.title, group.items)).join("")}${renderGroup(t("다른 노드에서 직접 가져옴"), t("상속 관계 없이 선택한 자료"), selected)}${oneOff.size ? ui`<section class="document-material-group"><header><strong>이번 번역에서만 참고</strong><button class="btn btn-sm" type="button" data-material-action="clear-oneoff">비우기</button></header>${[...oneOff.values()].map(comment => ui`<article class="document-material-card"><div class="document-material-title"><b>${esc(comment.quote)}</b><button class="btn btn-ghost btn-sm" type="button" data-material-action="remove-oneoff" data-id="${esc(comment.id)}" aria-label="이번 참고에서 제외">제외</button></div><p>${esc(comment.bodyMd)}</p><small>${esc(path(comment.documentNodeId))}</small><button class="document-material-link" type="button" data-material-action="comment-source" data-id="${esc(comment.id)}">원래 구절과 기록 보기 ↗</button></article>`).join("")}</section>` : ""}${!rows.length && !oneOff.size && !error ? uiText('<p class="document-material-empty">이 문서에 연결된 자료가 없습니다. 배경이나 참고할 판단을 추가할 수 있습니다.</p>') : ""}${rows.some(item => item.excluded) ? ui`<label class="document-material-show"><input type="checkbox" data-material-show-excluded${showExcluded ? " checked" : ""}> 이 문서에서 제외한 자료도 보기</label>` : ""}<div class="document-material-actions"><button class="btn btn-sm" type="button" data-material-action="picker"${canChange() ? "" : " disabled"}>다른 문서에서 가져오기</button><button class="btn btn-sm" type="button" data-material-action="add"${canChange() ? "" : " disabled"}>자료 추가</button><button class="document-material-link" type="button" data-material-action="preview">전달 내용 보기 ↗</button><button class="document-material-link" type="button" data-material-action="hub">번역 자료 관리 ↗</button></div><p class="document-material-help">선택과 제외는 이 문서에 저장됩니다. ‘이번 번역에서만 참고’한 코멘트는 실행 후 비워집니다.</p>`;
    if (scroll) scroll.scrollTop = scrollTop;
    if (active) [...host.querySelectorAll<HTMLInputElement>("[data-material-include]")].find(input => input.dataset.materialInclude === active)?.focus({ preventScroll: true });
  }

  function card(item: ResolvedMaterialView): string {
    const origin = item.origin;
    return ui`<article class="document-material-card${included(item) ? "" : " is-excluded"}"><div class="document-material-path">${item.reason === "selected" ? t("다른 노드의 자료를 직접 연결") : item.reason === "ancestor" ? t("상위에서 이어받음") : t("현재 노드에 둔 자료")}<span>${esc(path(item.scopeId))}</span></div><label class="document-material-title"><input type="checkbox" data-material-include="${esc(item.id)}"${included(item) ? " checked" : ""}${canChange() ? "" : " disabled"}><b>${esc(item.title)}</b></label><p>${esc(item.contentMd || (item.reference ? item.origin?.bodyMd : "") || "")}</p>${item.conditionMd ? `<p class="document-material-condition">${esc(item.conditionMd)}</p>` : ""}${item.excluded ? uiText('<small>이 문서에서 제외됨</small>') : !included(item) ? uiText('<small>원본 자료의 기본 사용 꺼짐 · 이 문서에서 선택할 수 있음</small>') : ""}${item.reference ? `<small>참고 코멘트${item.reference.sourceUnavailable ? " · 원본 삭제됨" : item.reference.sourceChanged ? " · 원본 변경됨, 확인 필요" : item.reference.needsReview ? " · 보충 메모 확인 필요" : ""}</small>` : ""}${origin ? ui`<small>원본 코멘트 · ${esc(path(origin.documentNodeId))}</small>` : ""}<div class="document-material-card-actions"><button class="document-material-link" type="button" data-material-action="source" data-id="${esc(item.id)}">내용·출처 보기 ↗</button>${item.referenced ? ui`<button class="document-material-link" type="button" data-material-action="unlink" data-id="${esc(item.id)}"${canChange() ? "" : " disabled"}>직접 연결 해제</button>` : ""}</div></article>`;
  }

  async function load(): Promise<void> {
    const id = documentId;
    if (!id) return;
    const request = ++serial;
    loading = true;
    error = "";
    render();
    try {
      const result = await deps.api.knowledge.getMaterials(id);
      if (request !== serial || !isCurrent(id)) return;
      if (!result.ok) throw new Error(result.error.message);
      data = result.data;
      const known = new Set(data.comments.map(comment => comment.id));
      for (const commentId of oneOff.keys()) if (!known.has(commentId)) oneOff.delete(commentId);
    } catch (cause) {
      if (request === serial && isCurrent(id)) error = cause instanceof Error ? cause.message : t("번역 자료를 불러오지 못했습니다.");
    } finally { if (request === serial && isCurrent(id)) { loading = false; render(); } }
  }

  async function setPreference(item: NodeContextView, mode: "include" | "exclude" | "reset"): Promise<boolean> {
    const id = documentId;
    if (!id || !canChange()) return false;
    saving = true;
    render();
    try {
      const result = await deps.api.knowledge.setMaterialPreference({ documentNodeId: id, source: item.source, sourceId: sourceId(item), mode,
        expectedLockVersion: preference(item)?.lockVersion ?? 0 });
      if (!result.ok) throw new Error(result.error.message);
      if (isCurrent(id)) { await load(); deps.changed(); }
      return true;
    } catch (cause) {
      if (isCurrent(id)) { error = cause instanceof Error ? cause.message : t("참고 설정을 저장하지 못했습니다."); await load(); }
      deps.notify(cause instanceof Error ? cause.message : t("참고 설정을 저장하지 못했습니다."), t("번역 자료"));
      return false;
    } finally { saving = false; if (isCurrent(id)) render(); }
  }

  function openSource(item: NodeContextView | ReviewCommentView): void {
    sourceOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const material = "contentMd" in item ? item : null;
    const comment: ReviewCommentView | MaterialOrigin | null = material ? material.origin ?? null : item as ReviewCommentView;
    const sourceNodeId = comment?.documentNodeId ?? material!.scopeId;
    sourceDialog.innerHTML = ui`<header class="document-material-dialog-heading"><h2>${material ? esc(material.title) : t("근거가 된 코멘트")}</h2></header><div class="document-material-dialog-body">${material ? ui`<div class="document-material-source"><b>자료 연결 노드</b><p>${esc(path(material.scopeId))}</p><small>${material.inheritToChildren === false ? t("이 노드에서만 참고") : t("하위 노드에도 이어짐")}</small></div><p class="material-preserve">${esc(material.contentMd)}</p>${material.conditionMd ? `<p class="document-material-condition">${esc(material.conditionMd)}</p>` : ""}` : ""}${comment ? ui`<section class="document-material-source"><b>원래 코멘트의 문서</b><p>${esc(path(comment.documentNodeId))}</p><blockquote>${esc(comment.quote)}</blockquote><p class="material-preserve">${esc(comment.bodyMd)}</p><small>작성 당시 ${comment.targetKind === "source" ? t("원문") : t("번역문")}의 선택 구절 · 버전 ${esc(comment.targetVersionId.slice(0, 8))}<br>현재 글에도 적용할 수 있는지는 문맥을 대조하세요.</small></section>` : ""}</div><footer class="document-material-dialog-footer"><button class="btn" type="button" data-source-close>닫기</button><button class="btn" type="button" data-source-document="${esc(sourceNodeId)}">원래 문서 열기</button>${material ? ui`<button class="btn btn-primary" type="button" data-source-manage="${esc(material.id)}">자료 관리</button>` : ""}</footer>`;
    sourceDialog.showModal();
  }

  function renderPicker(): void {
    const available = pickerKind === "materials"
      ? (data?.items ?? []).filter(item => !refs().some(existing => existing.id === item.id))
      : (data?.comments ?? []).filter(comment => !oneOff.has(comment.id));
    const rows = available.map(item => {
      const material = "contentMd" in item ? item : null;
      const comment = "bodyMd" in item ? item : null;
      return `<label class="document-material-pick"><input type="checkbox" data-material-pick="${esc(item.id)}"${picked.has(item.id) ? " checked" : ""}><span><small>${esc(path(material?.scopeId ?? comment!.documentNodeId))}</small><b>${esc(material?.title ?? comment!.quote)}</b><p>${esc(material?.contentMd ?? comment!.bodyMd)}</p>${material?.conditionMd ? `<small>${esc(material.conditionMd)}</small>` : ""}${comment ? ui`<small>${esc(comment.authorName)} · 작성 당시 ${comment.targetKind === "source" ? t("원문") : t("번역문")} · ${esc(comment.targetVersionId.slice(0, 8))}</small>` : ""}</span></label>`;
    }).join("");
    picker.innerHTML = ui`<header class="document-material-dialog-heading"><h2>다른 문서에서 가져오기</h2><p>${esc(path(pickerDocumentId!))}</p></header><div class="document-material-picker-tabs" role="tablist"><button class="btn" role="tab" type="button" data-picker-kind="materials" aria-selected="${pickerKind === "materials"}">배경·지침</button><button class="btn" role="tab" type="button" data-picker-kind="comments" aria-selected="${pickerKind === "comments"}">문서 코멘트 · 이번만</button></div><div class="document-material-dialog-body"><p class="document-material-help">${pickerKind === "materials" ? t("이 문서의 참고 자료로 연결합니다. 자료의 원래 연결 노드는 바뀌지 않습니다.") : t("작성 당시의 구절과 함께 과거 검토 사례로 전달합니다. 원래 코멘트는 바뀌지 않습니다.")}</p>${rows || uiText('<p class="muted">가져올 자료가 없습니다. 이미 연결된 자료는 문서의 참고 패널에서 선택하세요.</p>')}</div><footer class="document-material-dialog-footer"><span data-picker-count>${picked.size}개 선택</span><button class="btn" type="button" data-picker-close>취소</button><button class="btn btn-primary" type="button" data-picker-confirm${picked.size ? "" : " disabled"}>${pickerKind === "materials" ? t("이 문서에 연결") : t("이번 번역에 참고")}</button></footer>`;
  }
  async function openPicker(): Promise<void> {
    if (!canChange()) return;
    pickerOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pickerDocumentId = documentId;
    picked.clear();
    pickerKind = "materials";
    await load();
    if (!isCurrent(pickerDocumentId) || error) return;
    renderPicker();
    picker.showModal();
  }
  async function confirmPicker(): Promise<void> {
    if (!canChange() || !isCurrent(pickerDocumentId) || !picked.size) return;
    if (pickerKind === "comments") {
      for (const comment of data?.comments ?? []) if (picked.has(comment.id)) oneOff.set(comment.id, comment);
      picked.clear(); picker.close(); render(); deps.changed(); return;
    }
    const selectedItems = (data?.items ?? []).filter(item => picked.has(item.id));
    picker.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach(input => { input.disabled = true; });
    for (const item of selectedItems) {
      if (!isCurrent(pickerDocumentId) || !await setPreference(item, "include")) { renderPicker(); return; }
      picked.delete(item.id);
    }
    picker.close();
  }
  picker.addEventListener("change", event => {
    const input = event.target as HTMLInputElement;
    const id = input.dataset.materialPick;
    if (!id) return;
    if (input.checked) picked.add(id); else picked.delete(id);
    picker.querySelector("[data-picker-count]")!.textContent = ui`${picked.size}개 선택`;
    (picker.querySelector("[data-picker-confirm]") as HTMLButtonElement).disabled = !picked.size;
  });
  picker.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!button || isBusy()) return;
    if (button.hasAttribute("data-picker-close")) picker.close();
    else if (button.hasAttribute("data-picker-confirm")) void confirmPicker();
    else if (button.dataset.pickerKind) { pickerKind = button.dataset.pickerKind as typeof pickerKind; picked.clear(); renderPicker(); }
  });
  picker.addEventListener("cancel", event => { if (isBusy()) event.preventDefault(); });
  picker.addEventListener("close", () => { picked.clear(); if (pickerOpener?.isConnected) pickerOpener.focus({ preventScroll: true }); });
  sourceDialog.addEventListener("close", () => { if (sourceOpener?.isConnected) sourceOpener.focus({ preventScroll: true }); });
  sourceDialog.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!button) return;
    if (button.hasAttribute("data-source-close")) sourceDialog.close();
    else if (button.dataset.sourceDocument) { sourceDialog.close(); void deps.openDocument(button.dataset.sourceDocument); }
    else if (button.dataset.sourceManage) { sourceDialog.close(); deps.openMaterials(button.dataset.sourceManage); }
  });
  host.addEventListener("change", event => {
    const input = event.target as HTMLInputElement;
    if (input.hasAttribute("data-material-show-excluded")) { showExcluded = input.checked; render(); return; }
    const item = materialById(input.dataset.materialInclude ?? "");
    if (item) void setPreference(item, input.checked ? "include" : "exclude");
  });
  host.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-material-action]");
    if (!button) return;
    const action = button.dataset.materialAction;
    const item = materialById(button.dataset.id ?? "");
    if (action === "source" && item) openSource(item);
    else if (action === "comment-source") { const comment = oneOff.get(button.dataset.id!); if (comment) openSource(comment); }
    else if (action === "hub") deps.openMaterials();
    else if (action === "preview") deps.openPreparation();
    else if (action === "reload") void load();
    else if (!canChange()) return;
    else if (action === "picker") void openPicker();
    else if (action === "add") materialEditor.open({ scopeId: documentId! });
    else if (action === "unlink" && item) void setPreference(item, "reset");
    else if (action === "clear-oneoff" || action === "remove-oneoff") {
      if (action === "clear-oneoff") oneOff.clear(); else oneOff.delete(button.dataset.id!);
      render(); deps.changed();
    }
  });

  return {
    setDocument(view: EditorView): void {
      const key = `${view.document.id}:${view.source.versionId}:${view.translation?.versionId ?? ""}`;
      if (key !== versionKey) {
        versionKey = key;
        oneOff.clear(); picked.clear();
        if (picker.open) picker.close();
        if (sourceDialog.open) sourceDialog.close();
      }
      if (documentId !== view.document.id) { data = null; serial += 1; materialEditor.discard(); }
      documentId = view.document.id;
      void load();
    },
    refresh: load,
    render,
    referenceCommentIds: activeIds,
    clearLaunchedComments(id: string, commentIds: string[]): void {
      if (!isCurrent(id)) return;
      for (const commentId of commentIds) oneOff.delete(commentId);
      render();
    },
    reuseComment(comment: ReviewCommentView): void { if (canChange()) materialEditor.open({ comment }); },
    isBusy,
    hasUnsavedDraft: () => materialEditor.hasUnsavedDraft() || picker.open && picked.size > 0,
    discard(): void { materialEditor.discard(); if (!isBusy()) { picker.close(); sourceDialog.close(); } },
  };
}
