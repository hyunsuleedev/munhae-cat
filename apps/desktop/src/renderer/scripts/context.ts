import { configureContextChat } from "./context-chat";
import { t, ui, uiText } from "./i18n";
import type { DocumentListItem, HomeView, MaterialsView, NodeContextView, ResolvedMaterialView } from "../../shared/munhae-api";
import {
  bindSidebar, currentDocId, defaultSidebarTree, esc, go, ic, initShell, must, notify, store,
  renderSidebar, requireProject, revealSidebarNode, setSelfTitle, projectLocationLabel, unwrap,
  registerProjectRefresh,
} from "./shared";
import { resolveContextNode } from "./context-node";
import { documentPathText } from "./knowledge-model";

const project = await requireProject();
if (!project) throw new Error("redirect");

type ContextDraft = {
  item?: NodeContextView;
  title: HTMLInputElement;
  content: HTMLTextAreaElement;
  enabled: HTMLInputElement;
  inherit: HTMLInputElement;
  condition: HTMLTextAreaElement;
  inclusion: HTMLElement;
  status: HTMLElement;
  save: HTMLButtonElement;
  remove: HTMLButtonElement;
  saving: boolean;
};

let docs: DocumentListItem[] = [];
let node: DocumentListItem | undefined;
let materials: MaterialsView | undefined;
const drafts = new Map<HTMLFormElement, ContextDraft>();
let activeContextForm: HTMLFormElement | undefined;
let nextDraftId = 0;
let allowUnload = false;

const api = initShell({
  page: "context",
  selfTitle: ui`문맥 편집 — ${project.title}`,
  beforeNavigate: () => {
    if (!canLeave()) return false;
    allowUnload = true;
    return true;
  },
  projectTransition: {
    before: () => canLeave(),
    committed: () => { allowUnload = true; },
  },
  extraPalette: [{ g: t("문맥"), l: t("문맥 추가"), k: "", id: "add-context" }],
  pageCmd: (id) => {
    if (id === "ctxpane") { toggleContextSidebar(); return true; }
    if (id !== "add-context") return false;
    if (node) addDraft(undefined, true);
    return true;
  },
  pageKeys: (event, meta) => {
    if (!meta || event.altKey || event.shiftKey || event.code !== "KeyS") return;
    event.preventDefault();
    const activeForm = document.activeElement?.closest("form");
    const form = activeForm instanceof HTMLFormElement && drafts.has(activeForm)
      ? activeForm
      : activeContextForm;
    if (form) void saveDraft(form);
  },
}).api;

function toggleContextSidebar(hidden = !must("#contextInspector").hidden): void {
  const panel = must("#contextInspector");
  const button = must<HTMLButtonElement>("#tbCtx");
  if (hidden && panel.contains(document.activeElement)) button.focus();
  panel.hidden = hidden;
  button.classList.toggle("is-on", !hidden);
  button.setAttribute("aria-expanded", String(!hidden));
  store.set("munhae.context.sidebar", hidden ? "0" : "1");
}
must("#tbCtx").innerHTML = ic("panel");
must("#tbCtx").addEventListener("click", () => toggleContextSidebar());
toggleContextSidebar(store.get("munhae.context.sidebar") === "0");
initContextInspectorResize();

function initContextInspectorResize(): void {
  const workspace = document.querySelector(".context-workspace");
  const panel = must("#contextInspector");
  if (!(workspace instanceof HTMLElement)) return;
  const key = "munhae.context.inspectorWidth";
  const minWidth = 240;
  const maxWidth = (): number => Math.max(minWidth, workspace.clientWidth - 360);
  const saved = Number(store.get(key));
  let preferred = Number.isFinite(saved) && saved >= minWidth ? saved : 0;
  let width = preferred;
  let drag: { pointerId: number; startX: number; startWidth: number } | null = null;
  const handle = document.createElement("div");
  handle.className = "context-inspector-resizer";
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", t("문맥 AI 패널 너비"));
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-controls", "contextInspector");
  handle.title = t("드래그하여 너비 조절 · 두 번 클릭하면 기본 너비");
  panel.prepend(handle);

  const applyWidth = (next: number | 0): void => {
    if (next === 0) {
      width = 0;
      panel.style.removeProperty("--context-inspector-width");
      handle.removeAttribute("aria-valuenow");
      return;
    }
    width = Math.round(Math.max(minWidth, Math.min(maxWidth(), next)));
    panel.style.setProperty("--context-inspector-width", `${width}px`);
    handle.setAttribute("aria-valuemin", String(minWidth));
    handle.setAttribute("aria-valuemax", String(maxWidth()));
    handle.setAttribute("aria-valuenow", String(width));
    handle.setAttribute("aria-valuetext", ui`${width}픽셀`);
  };
  const currentWidth = (): number => width || panel.getBoundingClientRect().width;
  const finishDrag = (cancel = false): void => {
    if (!drag) return;
    const pointerId = drag.pointerId;
    drag = null;
    if (cancel) applyWidth(preferred);
    else {
      preferred = width;
      store.set(key, String(width));
    }
    handle.classList.remove("is-drag");
    document.body.classList.remove("is-resizing-context-inspector");
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag || panel.hidden) return;
    event.preventDefault();
    const start = currentWidth();
    width = start;
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: start };
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-drag");
    document.body.classList.add("is-resizing-context-inspector");
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag?.pointerId === event.pointerId) applyWidth(drag.startWidth - (event.clientX - drag.startX));
  });
  handle.addEventListener("pointerup", (event) => { if (drag?.pointerId === event.pointerId) finishDrag(); });
  handle.addEventListener("pointercancel", (event) => { if (drag?.pointerId === event.pointerId) finishDrag(true); });
  handle.addEventListener("lostpointercapture", () => finishDrag(true));
  handle.addEventListener("dblclick", () => {
    applyWidth(0);
    preferred = 0;
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  });
  handle.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drag) { event.preventDefault(); finishDrag(true); return; }
    if (drag || event.metaKey || event.ctrlKey || event.altKey) return;
    const base = currentWidth();
    const step = event.shiftKey ? 40 : 10;
    const next = { ArrowLeft: base + step, ArrowRight: base - step, Home: minWidth, End: maxWidth() }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    applyWidth(next);
    preferred = width;
    store.set(key, String(width));
  });
  if (preferred) applyWidth(preferred);
}

const chat = configureContextChat(api, project.projectId, () => [...drafts].map(([form, draft]) => ({
  key: draft.item?.id ?? form.dataset.chatKey!, scopeId: node!.id, title: draft.title.value, contentMd: draft.content.value,
  apply(original: string, text: string) {
    if (!form.isConnected || draft.saving || draft.content.value !== original) return false;
    draft.content.value = text; allowUnload = false; updateSaveState(); return true;
  },
})));
must("#contextReferencesPanel").append(must(".context-rail"));

function isDirty(draft: ContextDraft): boolean {
  return draft.title.value !== (draft.item?.title ?? "")
    || draft.content.value !== (draft.item?.contentMd ?? "")
    || draft.enabled.checked !== (draft.item?.enabled ?? true)
    || draft.inherit.checked !== (draft.item?.inheritToChildren ?? true)
    || draft.condition.value !== (draft.item?.conditionMd ?? "");
}

function canLeave(): boolean {
  if (chat.isBusy()) return false;
  if ([...drafts.values()].some((draft) => draft.saving)) {
    notify(t("문맥을 저장하고 있습니다. 저장이 끝난 뒤 이동해 주세요."), t("문맥"));
    return false;
  }
  return ![...drafts.values()].some(isDirty)
    || window.confirm(t("저장하지 않은 문맥이 있습니다. 이 화면을 떠나시겠습니까?"));
}

function updateSaveState(): void {
  for (const draft of drafts.values()) {
    draft.status.textContent = draft.saving ? t("저장 중…") : isDirty(draft) ? t("저장하지 않은 변경") : draft.item ? t("저장됨") : t("새 문맥");
    draft.save.disabled = draft.saving || !isDirty(draft);
    draft.remove.disabled = draft.saving;
  }
  const pending = [...drafts.values()].some(isDirty);
  must("#contextSaveStatus").textContent = pending ? t("저장하지 않은 변경") : "";
}

function showContext(form: HTMLFormElement, focus = false): void {
  if (!drafts.has(form)) return;
  const focusWasInNote = activeContextForm?.contains(document.activeElement);
  activeContextForm = form;
  const forms = [...drafts.keys()];
  const index = forms.indexOf(form);
  for (const candidate of forms) candidate.hidden = candidate !== form;
  must("#contextPageCount").textContent = `${index + 1} / ${forms.length}`;
  must<HTMLButtonElement>("#previousContext").disabled = index === 0;
  must<HTMLButtonElement>("#nextContext").disabled = index === forms.length - 1;
  if (focus || focusWasInNote) drafts.get(form)!.title.focus({ preventScroll: true });
}

function turnContext(direction: number): void {
  const forms = [...drafts.keys()];
  const index = activeContextForm ? forms.indexOf(activeContextForm) : 0;
  const next = forms[index + direction];
  if (next) showContext(next);
}

function addDraft(item?: NodeContextView, focus = false): void {
  const id = `context-draft-${++nextDraftId}`;
  const form = document.createElement("form");
  form.className = "context-form";
  form.id = id;
  form.dataset.chatKey = item?.id ?? crypto.randomUUID();
  form.setAttribute("aria-label", item?.title || t("새 문맥"));
  form.innerHTML = ui`
    <div class="context-note-head"><span class="context-note-icon" aria-hidden="true">≡</span><span>문맥 노트</span><span class="context-state" data-state role="status"></span></div>
    <div class="field context-title-field"><label for="${id}-title">제목</label><input class="input" id="${id}-title" name="title" maxlength="500" required placeholder="예: 문집 해제, 이 문서의 배경" value="${esc(item?.title ?? "")}"></div>
    <div class="field context-body-field"><label for="${id}-body">내용</label><textarea class="textarea" id="${id}-body" name="content" maxlength="200000" required placeholder="해제나 배경 설명, 번역할 때 참고할 내용을 그대로 적어 주세요. 출처도 함께 남길 수 있습니다.">${esc(item?.contentMd ?? "")}</textarea></div>
    <details class="context-options" ${item?.conditionMd || item?.origin ? "open" : ""}>
      <summary>적용 범위·조건${item?.origin ? t("·출처") : ""}</summary>
      <label class="check"><input type="checkbox" name="inherit" ${item?.inheritToChildren !== false ? "checked" : ""}> 하위 폴더·문서에도 적용</label>
      <label for="${id}-condition">참고 조건 <span class="muted">선택</span></label>
      <textarea class="textarea context-condition" id="${id}-condition" name="condition" maxlength="20000" rows="2" placeholder="예: 같은 관서가 등장할 때 참고">${esc(item?.conditionMd ?? "")}</textarea>
      ${item?.origin ? ui`<div class="context-origin"><span class="context-eyebrow">코멘트에서 가져온 문맥</span><p>${esc(documentPathText(docs, item.origin.documentNodeId))}</p><blockquote>${esc(item.origin.quote)}</blockquote><details><summary>원 코멘트와 작성 버전</summary><p>${esc(item.origin.bodyMd)}</p><p class="muted">번역 버전 ${esc(item.origin.translationVersionId)}</p></details></div>` : ""}
    </details>
    <p class="context-inclusion" data-inclusion></p>
    <div class="context-actions">
      <label class="check"><input type="checkbox" name="enabled" ${item?.enabled !== false ? "checked" : ""}> AI 요청에 포함</label>
      <span class="sp"></span>
      <button class="btn btn-ghost ${item ? "btn-danger" : ""}" type="button" data-delete>${item ? t("삭제") : t("취소")}</button>
      <button class="btn btn-primary" type="submit">저장 <kbd>⌘S</kbd></button>
    </div>`;
  const draft: ContextDraft = {
    item,
    title: form.querySelector<HTMLInputElement>("[name=title]")!,
    content: form.querySelector<HTMLTextAreaElement>("[name=content]")!,
    enabled: form.querySelector<HTMLInputElement>("[name=enabled]")!,
    inherit: form.querySelector<HTMLInputElement>("[name=inherit]")!,
    condition: form.querySelector<HTMLTextAreaElement>("[name=condition]")!,
    inclusion: form.querySelector<HTMLElement>("[data-inclusion]")!,
    status: form.querySelector<HTMLElement>("[data-state]")!,
    save: form.querySelector<HTMLButtonElement>("[type=submit]")!,
    remove: form.querySelector<HTMLButtonElement>("[data-delete]")!,
    saving: false,
  };
  drafts.set(form, draft);
  updateInclusion(draft);
  form.addEventListener("input", () => { allowUnload = false; updateSaveState(); });
  draft.title.addEventListener("change", () => chat.refresh());
  form.addEventListener("submit", (event) => { event.preventDefault(); void saveDraft(form); });
  draft.remove.addEventListener("click", () => void removeDraft(form));
  must("#contextEditors").append(form);
  updateSaveState();
  chat.refresh();
  showContext(focus || !activeContextForm ? form : activeContextForm, focus);
}

async function refreshSidebar(): Promise<void> {
  const home = await api.home.get();
  if (home.ok) docs = home.data.documents;
  if (node) revealSidebarNode(docs, node.id);
  renderSidebar(defaultSidebarTree(docs), { currentDocId: node?.id ?? null });
}

async function saveDraft(form: HTMLFormElement): Promise<void> {
  const draft = drafts.get(form);
  if (!draft || !node || draft.saving || !form.reportValidity()) return;
  if (!draft.title.value.trim() || !draft.content.value.trim()) {
    notify(t("문맥의 제목과 내용을 입력해 주세요."), t("문맥"));
    return;
  }
  const input = {
    scopeId: node.id,
    title: draft.title.value.trim(),
    contentMd: draft.content.value,
    priority: draft.item?.priority ?? 0,
    enabled: draft.enabled.checked,
    inheritToChildren: draft.inherit.checked,
    conditionMd: draft.condition.value,
  };
  const originalTitle = draft.title.value;
  draft.saving = true;
  updateSaveState();
  try {
    const result = draft.item
      ? await api.knowledge.updateContext({ ...input, id: draft.item.id, expectedLockVersion: draft.item.lockVersion })
      : await api.knowledge.createContext(input);
    const saved = unwrap(result, t("문맥 저장"));
    if (!saved) return;
    const priorChatKey = draft.item?.id ?? form.dataset.chatKey!;
    draft.item = saved;
    chat.rekey(priorChatKey, saved.id);
    // Preserve any edits made while the request was in flight.
    if (draft.title.value === originalTitle) draft.title.value = saved.title;
    if (draft.content.value === input.contentMd) draft.content.value = saved.contentMd;
    if (draft.condition.value === input.conditionMd) draft.condition.value = saved.conditionMd ?? "";
    draft.remove.textContent = t("삭제");
    draft.remove.classList.add("btn-danger");
    form.setAttribute("aria-label", saved.title);
    notify(ui`${saved.title} 저장`, t("문맥"));
    await refreshSidebar();
    await refreshReferences();
  } catch (error) {
    notify(error instanceof Error ? error.message : t("문맥을 저장하지 못했습니다."), t("문맥 저장"));
  } finally {
    draft.saving = false;
    updateSaveState();
  }
}

async function removeDraft(form: HTMLFormElement): Promise<void> {
  const draft = drafts.get(form);
  if (!draft || draft.saving || chat.isBusy()) return;
  if (draft.item) {
    if (!window.confirm(ui`‘${draft.item.title}’ 문맥을 삭제하시겠습니까? 삭제 후에는 복구할 수 없습니다.`)) return;
  } else if (isDirty(draft) && !window.confirm(t("이 문맥의 저장하지 않은 변경을 버리시겠습니까?"))) return;
  draft.saving = true;
  updateSaveState();
  try {
    if (draft.item) {
      const result = await api.knowledge.deleteContext({ id: draft.item.id, expectedLockVersion: draft.item.lockVersion });
      if (!result.ok) { unwrap(result, t("문맥 삭제")); return; }
    }
    const removedIndex = [...drafts.keys()].indexOf(form);
    drafts.delete(form);
    form.remove();
    chat.refresh();
    if (drafts.size === 0) { activeContextForm = undefined; addDraft(undefined, true); }
    else {
      const remaining = [...drafts.keys()];
      showContext(activeContextForm === form ? remaining[Math.min(removedIndex, remaining.length - 1)]! : activeContextForm!, true);
    }
    await refreshSidebar();
    await refreshReferences();
  } catch (error) {
    notify(error instanceof Error ? error.message : t("문맥을 삭제하지 못했습니다."), t("문맥"));
  } finally {
    draft.saving = false;
    updateSaveState();
  }
}

function inclusionLabel(item: ResolvedMaterialView): string {
  const ownerKind = node?.nodeRole === "container" ? t("폴더") : t("문서");
  return item.excluded ? ui`이 ${ownerKind}에서 제외됨` : item.included ? t("AI 참고에 포함") : t("AI 자동 포함 꺼짐");
}

function updateInclusion(draft: ContextDraft): void {
  const resolved = materials?.resolved?.find((item) => item.id === draft.item?.id);
  draft.inclusion.hidden = !resolved || !resolved.excluded && !(resolved.included && !resolved.enabled);
  draft.inclusion.textContent = resolved?.excluded
    ? ui`${inclusionLabel(resolved)} · 문서별 참고 패널에서 선택한 제외 상태가 적용됩니다.`
    : resolved?.included && !resolved.enabled ? t("문서별 참고 패널에서 직접 포함한 문맥입니다.") : "";
}

function referenceHtml(item: ResolvedMaterialView): string {
  return `<details class="context-reference${!item.included ? " is-excluded" : ""}">
    <summary>${esc(item.title)}<span class="context-owner">${esc(documentPathText(docs, item.scopeId))}</span><span class="context-reference-status">${esc(inclusionLabel(item))}${item.source === "document_description" ? t(" · 문서 정보의 설명") : ""}</span></summary>
    <p class="context-reference-body">${esc(item.contentMd)}</p>
    ${item.conditionMd ? ui`<p class="context-reference-condition"><b>참고 조건</b> ${esc(item.conditionMd)}</p>` : ""}
    ${item.scopeId !== node?.id ? ui`<button class="btn" type="button" data-owner="${esc(item.scopeId)}">연결된 ${docs.find((document) => document.id === item.scopeId)?.nodeRole === "container" ? t("폴더") : t("문서")}의 문맥 열기</button>` : ""}
  </details>`;
}

function renderReferences(): void {
  const resolved = (materials?.resolved ?? []).filter(item => item.source !== "comment_reference");
  const descriptions = resolved.filter((item) => item.reason === "current" && item.source === "document_description");
  must("#documentDescriptions").hidden = descriptions.length === 0;
  must("#documentDescriptions").innerHTML = uiText('<h2>문서 정보의 설명</h2>') + descriptions.map(referenceHtml).join("");
  const inherited = resolved.filter((item) => item.reason === "ancestor");
  must("#inheritedCount").textContent = String(inherited.length);
  must("#inheritedContexts").innerHTML = inherited.map(referenceHtml).join("")
    || (!node?.parentId
      ? uiText('<div class="context-empty"><span aria-hidden="true">↳</span><b>프로젝트 최상위 폴더</b><p>상속받을 상위 폴더가 없습니다. 각 문맥에서 하위 적용 범위를 정할 수 있습니다.</p></div>')
      : uiText('<div class="context-empty"><span aria-hidden="true">↳</span><b>상속된 문맥이 없습니다</b><p>상위 폴더·문서에서 하위 적용을 켠 문맥이 이곳에 나타납니다.</p></div>'));
  const selected = resolved.filter((item) => item.reason === "selected");
  must("#selectedReferences").hidden = selected.length === 0;
  must("#selectedCount").textContent = String(selected.length);
  must("#selectedContexts").innerHTML = selected.map(referenceHtml).join("");
  for (const draft of drafts.values()) updateInclusion(draft);
}

async function refreshReferences(): Promise<void> {
  if (!node) return;
  const result = unwrap(await api.knowledge.getMaterials(node.id), t("문맥 적용 상태 불러오기"));
  if (!result) return;
  materials = result;
  renderReferences();
}

async function boot(): Promise<void> {
  try {
    const home = unwrap(await api.home.get(), t("문서 불러오기"));
    if (!home) throw new Error(t("문맥을 불러오지 못했습니다. 페이지를 다시 열어 주세요."));
    docs = home.documents;
    const requestedId = new URLSearchParams(location.search).get("node");
    node = resolveContextNode(docs, requestedId, currentDocId());
    if (!node) throw new Error(t("이 문서를 찾을 수 없습니다. 사이드바에서 문서를 선택해 주세요."));
    materials = unwrap(await api.knowledge.getMaterials(node.id), t("문맥 불러오기")) ?? undefined;
    if (!materials) throw new Error(t("문맥을 불러오지 못했습니다. 페이지를 다시 열어 주세요."));
    history.replaceState(null, "", `context.html?node=${encodeURIComponent(node.id)}`);
    const title = node.originalTitle || node.title;
    document.title = ui`${title} · 문맥 편집 — 문해`;
    setSelfTitle(ui`문맥 편집 — ${title}`);
    must("#contextNodeName").textContent = title;
    must("#directContextTitle").textContent = node.nodeRole === "container" ? t("이 폴더의 문맥") : t("이 문서의 문맥");
    must("#currentScopeLabel").textContent = node.nodeRole === "container" ? t("현재 폴더") : t("현재 문서");
    must("#sbPath").textContent = projectLocationLabel(project!);
    const lineage: DocumentListItem[] = [];
    const seen = new Set<string>();
    let current: DocumentListItem | undefined = node;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      lineage.push(current);
      current = docs.find((document) => document.id === current!.parentId);
    }
    must("#contextPath").textContent = [...lineage].reverse().map((document) => document.originalTitle || document.title).join(" / ");
    const direct = materials.items.filter((item) => item.scopeId === node!.id && item.source === "context_item");
    for (const item of direct) addDraft(item);
    if (direct.length === 0) addDraft();
    renderReferences();
    must("#openSource").hidden = node.nodeRole !== "source_unit";
    revealSidebarNode(docs, node.id);
    renderSidebar(defaultSidebarTree(docs), { currentDocId: node.id });
    must("#contextPage").hidden = false;
    must("#contextLoading").hidden = true;
  } catch (error) {
    must("#contextLoading").textContent = error instanceof Error ? error.message : t("문맥을 불러오지 못했습니다.");
    renderSidebar(defaultSidebarTree(docs));
  }
}

must("#addContext").addEventListener("click", () => { if (node) addDraft(undefined, true); });
must("#previousContext").addEventListener("click", () => turnContext(-1));
must("#nextContext").addEventListener("click", () => turnContext(1));
must("#openSource").addEventListener("click", () => { if (node) go("editor", node.id); });
must("#openMaterials").addEventListener("click", () => go("knowledge"));
must(".context-rail").addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-owner]");
  if (target?.dataset.owner) go("context", target.dataset.owner);
});
window.addEventListener("beforeunload", (event) => {
  if (!allowUnload && (chat.isBusy() || [...drafts.values()].some((draft) => draft.saving || isDirty(draft)))) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("munhae:document-created", (event) => {
  docs = (event as CustomEvent<HomeView>).detail.documents;
  if (node) revealSidebarNode(docs, node.id);
  renderSidebar(defaultSidebarTree(docs), { currentDocId: node?.id ?? null });
});
bindSidebar(undefined, () => defaultSidebarTree(docs));
await boot();

registerProjectRefresh({
  blocked: () => chat.isBusy() || [...drafts.values()].some(draft => draft.saving || isDirty(draft)),
  version: () => `${node?.id}:${[...drafts.values()].map(draft => `${draft.item?.id}:${draft.item?.lockVersion}`).join("|")}`,
  async prepare() {
    const id = node?.id;
    const home = await api.home.get();
    if (!home.ok) throw new Error(home.error.message);
    const nextNode = home.data.documents.find(doc => doc.id === id);
    if (!nextNode) return () => { location.href = "home.html"; };
    const result = await api.knowledge.getMaterials(nextNode.id);
    if (!result.ok) throw new Error(result.error.message);
    return () => {
      docs = home.data.documents; node = nextNode; materials = result.data;
      const direct = materials.items.filter(item => item.scopeId === node!.id && item.source === "context_item");
      const selectedId = activeContextForm ? drafts.get(activeContextForm)?.item?.id : null;
      const remaining = new Map(direct.map(item => [item.id, item]));
      for (const [form, draft] of drafts) {
        const next = draft.item ? remaining.get(draft.item.id) : undefined;
        if (!next) { drafts.delete(form); form.remove(); if (activeContextForm === form) activeContextForm = undefined; continue; }
        remaining.delete(next.id); draft.item = next;
        draft.title.value = next.title; draft.content.value = next.contentMd;
        draft.enabled.checked = next.enabled; draft.inherit.checked = next.inheritToChildren !== false;
        draft.condition.value = next.conditionMd ?? "";
        form.setAttribute("aria-label", next.title);
      }
      for (const item of remaining.values()) addDraft(item);
      if (!drafts.size) addDraft();
      const selected = [...drafts].find(([, draft]) => draft.item?.id === selectedId)?.[0] ?? activeContextForm ?? [...drafts.keys()][0]!;
      showContext(selected);
      const title = node.originalTitle || node.title;
      must("#contextNodeName").textContent = title;
      must("#contextPath").textContent = documentPathText(docs, node.id);
      document.title = ui`${title} · 문맥 편집 — 문해`; setSelfTitle(ui`문맥 편집 — ${title}`);
      renderReferences(); updateSaveState(); chat.refresh();
      renderSidebar(defaultSidebarTree(docs), { currentDocId: node.id });
    };
  },
});
