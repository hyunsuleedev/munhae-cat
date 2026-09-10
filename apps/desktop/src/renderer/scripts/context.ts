import type { DocumentListItem, HomeView, MaterialsView, NodeContextView, ResolvedMaterialView } from "../../shared/munhae-api";
import {
  bindSidebar, currentDocId, defaultSidebarTree, esc, go, initShell, must, notify,
  renderSidebar, requireProject, revealSidebarNode, setSelfTitle, shortPath, unwrap,
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
  archive: HTMLButtonElement;
  saving: boolean;
};

let docs: DocumentListItem[] = [];
let node: DocumentListItem | undefined;
let materials: MaterialsView | undefined;
const drafts = new Map<HTMLFormElement, ContextDraft>();
let nextDraftId = 0;
let allowUnload = false;

const api = initShell({
  page: "context",
  selfTitle: `문맥 편집 — ${project.title}`,
  beforeNavigate: () => {
    if (!canLeave()) return false;
    allowUnload = true;
    return true;
  },
  projectTransition: {
    before: () => canLeave(),
    committed: () => { allowUnload = true; },
  },
  extraPalette: [{ g: "문맥", l: "문맥 추가", k: "", id: "add-context" }],
  pageCmd: (id) => {
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
      : [...drafts].find(([, draft]) => isDirty(draft))?.[0];
    if (form) void saveDraft(form);
  },
}).api;

function isDirty(draft: ContextDraft): boolean {
  return draft.title.value !== (draft.item?.title ?? "")
    || draft.content.value !== (draft.item?.contentMd ?? "")
    || draft.enabled.checked !== (draft.item?.enabled ?? true)
    || draft.inherit.checked !== (draft.item?.inheritToChildren ?? true)
    || draft.condition.value !== (draft.item?.conditionMd ?? "");
}

function canLeave(): boolean {
  if ([...drafts.values()].some((draft) => draft.saving)) {
    notify("문맥을 저장하고 있습니다. 저장이 끝난 뒤 이동해 주세요.", "문맥");
    return false;
  }
  return ![...drafts.values()].some(isDirty)
    || window.confirm("저장하지 않은 문맥이 있습니다. 이 화면을 떠나시겠습니까?");
}

function updateSaveState(): void {
  for (const draft of drafts.values()) {
    draft.status.textContent = draft.saving ? "저장 중…" : isDirty(draft) ? "저장하지 않은 변경" : draft.item ? "저장됨" : "새 문맥";
    draft.save.disabled = draft.saving || !isDirty(draft);
    draft.archive.disabled = draft.saving;
  }
  const pending = [...drafts.values()].some(isDirty);
  must("#contextSaveStatus").textContent = pending ? "저장하지 않은 변경" : "";
}

function addDraft(item?: NodeContextView, focus = false): void {
  const id = `context-draft-${++nextDraftId}`;
  const form = document.createElement("form");
  form.className = "context-form";
  form.setAttribute("aria-label", item?.title || "새 문맥");
  form.innerHTML = `
    <div class="context-note-head"><span class="context-note-icon" aria-hidden="true">≡</span><span>문맥 노트</span><span class="context-state" data-state role="status"></span></div>
    <div class="field context-title-field"><label for="${id}-title">제목</label><input class="input" id="${id}-title" name="title" maxlength="500" required placeholder="예: 문집 해제, 이 문서의 배경" value="${esc(item?.title ?? "")}"></div>
    <div class="field context-body-field"><label for="${id}-body">내용</label><textarea class="textarea" id="${id}-body" name="content" maxlength="200000" required placeholder="해제나 배경 설명, 번역할 때 참고할 내용을 그대로 적어 주세요. 출처도 함께 남길 수 있습니다.">${esc(item?.contentMd ?? "")}</textarea></div>
    <details class="context-options" ${item?.conditionMd || item?.origin ? "open" : ""}>
      <summary>적용 범위·조건${item?.origin ? "·출처" : ""}</summary>
      <label class="check"><input type="checkbox" name="inherit" ${item?.inheritToChildren !== false ? "checked" : ""}> 하위 폴더·문서에도 적용</label>
      <label for="${id}-condition">참고 조건 <span class="muted">선택</span></label>
      <textarea class="textarea context-condition" id="${id}-condition" name="condition" maxlength="20000" rows="2" placeholder="예: 같은 관서가 등장할 때 참고">${esc(item?.conditionMd ?? "")}</textarea>
      ${item?.origin ? `<div class="context-origin"><span class="context-eyebrow">코멘트에서 가져온 문맥</span><p>${esc(documentPathText(docs, item.origin.documentNodeId))}</p><blockquote>${esc(item.origin.quote)}</blockquote><details><summary>원 코멘트와 작성 버전</summary><p>${esc(item.origin.bodyMd)}</p><p class="muted">번역 버전 ${esc(item.origin.translationVersionId)}</p></details></div>` : ""}
    </details>
    <p class="context-inclusion" data-inclusion></p>
    <div class="context-actions">
      <label class="check"><input type="checkbox" name="enabled" ${item?.enabled !== false ? "checked" : ""}> AI 요청에 포함</label>
      <span class="sp"></span>
      <button class="btn btn-ghost" type="button" data-archive>${item ? "보관" : "취소"}</button>
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
    archive: form.querySelector<HTMLButtonElement>("[data-archive]")!,
    saving: false,
  };
  drafts.set(form, draft);
  updateInclusion(draft);
  form.addEventListener("input", () => { allowUnload = false; updateSaveState(); });
  form.addEventListener("submit", (event) => { event.preventDefault(); void saveDraft(form); });
  draft.archive.addEventListener("click", () => void archiveDraft(form));
  must("#contextEditors").append(form);
  updateSaveState();
  if (focus) {
    form.scrollIntoView({ block: "nearest" });
    draft.title.focus({ preventScroll: true });
  }
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
    notify("문맥의 제목과 내용을 입력해 주세요.", "문맥");
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
    const saved = unwrap(result, "문맥 저장");
    if (!saved) return;
    draft.item = saved;
    // Preserve any edits made while the request was in flight.
    if (draft.title.value === originalTitle) draft.title.value = saved.title;
    if (draft.content.value === input.contentMd) draft.content.value = saved.contentMd;
    if (draft.condition.value === input.conditionMd) draft.condition.value = saved.conditionMd ?? "";
    draft.archive.textContent = "보관";
    form.setAttribute("aria-label", saved.title);
    notify(`${saved.title} 저장`, "문맥");
    await refreshSidebar();
    await refreshReferences();
  } catch (error) {
    notify(error instanceof Error ? error.message : "문맥을 저장하지 못했습니다.", "문맥 저장");
  } finally {
    draft.saving = false;
    updateSaveState();
  }
}

async function archiveDraft(form: HTMLFormElement): Promise<void> {
  const draft = drafts.get(form);
  if (!draft || draft.saving) return;
  if (isDirty(draft) && !window.confirm("이 문맥의 저장하지 않은 변경을 버리시겠습니까?")) return;
  draft.saving = true;
  updateSaveState();
  try {
    if (draft.item) {
      const result = await api.knowledge.archiveContext({ id: draft.item.id, expectedLockVersion: draft.item.lockVersion });
      if (!result.ok) { unwrap(result, "문맥 보관"); return; }
    }
    drafts.delete(form);
    form.remove();
    if (drafts.size === 0) addDraft();
    await refreshSidebar();
    await refreshReferences();
  } catch (error) {
    notify(error instanceof Error ? error.message : "문맥을 보관하지 못했습니다.", "문맥");
  } finally {
    draft.saving = false;
    updateSaveState();
  }
}

function inclusionLabel(item: ResolvedMaterialView): string {
  const ownerKind = node?.nodeRole === "container" ? "폴더" : "문서";
  return item.excluded ? `이 ${ownerKind}에서 제외됨` : item.included ? "AI 참고에 포함" : "AI 자동 포함 꺼짐";
}

function updateInclusion(draft: ContextDraft): void {
  const resolved = materials?.resolved?.find((item) => item.id === draft.item?.id);
  draft.inclusion.hidden = !resolved || !resolved.excluded && !(resolved.included && !resolved.enabled);
  draft.inclusion.textContent = resolved?.excluded
    ? `${inclusionLabel(resolved)} · 문서별 참고 패널에서 선택한 제외 상태가 적용됩니다.`
    : resolved?.included && !resolved.enabled ? "문서별 참고 패널에서 직접 포함한 문맥입니다." : "";
}

function referenceHtml(item: ResolvedMaterialView): string {
  return `<details class="context-reference${!item.included ? " is-excluded" : ""}">
    <summary>${esc(item.title)}<span class="context-owner">${esc(documentPathText(docs, item.scopeId))}</span><span class="context-reference-status">${esc(inclusionLabel(item))}${item.source === "document_description" ? " · 문서 정보의 설명" : ""}</span></summary>
    <p class="context-reference-body">${esc(item.contentMd)}</p>
    ${item.conditionMd ? `<p class="context-reference-condition"><b>참고 조건</b> ${esc(item.conditionMd)}</p>` : ""}
    ${item.scopeId !== node?.id ? `<button class="btn" type="button" data-owner="${esc(item.scopeId)}">연결된 ${docs.find((document) => document.id === item.scopeId)?.nodeRole === "container" ? "폴더" : "문서"}의 문맥 열기</button>` : ""}
  </details>`;
}

function renderReferences(): void {
  const resolved = materials?.resolved ?? [];
  const descriptions = resolved.filter((item) => item.reason === "current" && item.source === "document_description");
  must("#documentDescriptions").hidden = descriptions.length === 0;
  must("#documentDescriptions").innerHTML = '<h2>문서 정보의 설명</h2>' + descriptions.map(referenceHtml).join("");
  const inherited = resolved.filter((item) => item.reason === "ancestor");
  must("#inheritedCount").textContent = String(inherited.length);
  must("#inheritedContexts").innerHTML = inherited.map(referenceHtml).join("")
    || (!node?.parentId
      ? '<div class="context-empty"><span aria-hidden="true">↳</span><b>프로젝트 최상위 폴더</b><p>상속받을 상위 폴더가 없습니다. 각 문맥에서 하위 적용 범위를 정할 수 있습니다.</p></div>'
      : '<div class="context-empty"><span aria-hidden="true">↳</span><b>상속된 문맥이 없습니다</b><p>상위 폴더·문서에서 하위 적용을 켠 문맥이 이곳에 나타납니다.</p></div>');
  const selected = resolved.filter((item) => item.reason === "selected");
  must("#selectedReferences").hidden = selected.length === 0;
  must("#selectedCount").textContent = String(selected.length);
  must("#selectedContexts").innerHTML = selected.map(referenceHtml).join("");
  for (const draft of drafts.values()) updateInclusion(draft);
}

async function refreshReferences(): Promise<void> {
  if (!node) return;
  const result = unwrap(await api.knowledge.getMaterials(node.id), "문맥 적용 상태 불러오기");
  if (!result) return;
  materials = result;
  renderReferences();
}

async function boot(): Promise<void> {
  try {
    const home = unwrap(await api.home.get(), "문서 불러오기");
    if (!home) throw new Error("문맥을 불러오지 못했습니다. 페이지를 다시 열어 주세요.");
    docs = home.documents;
    const requestedId = new URLSearchParams(location.search).get("node");
    node = resolveContextNode(docs, requestedId, currentDocId());
    if (!node) throw new Error("이 문서를 찾을 수 없습니다. 사이드바에서 문서를 선택해 주세요.");
    materials = unwrap(await api.knowledge.getMaterials(node.id), "문맥 불러오기") ?? undefined;
    if (!materials) throw new Error("문맥을 불러오지 못했습니다. 페이지를 다시 열어 주세요.");
    history.replaceState(null, "", `context.html?node=${encodeURIComponent(node.id)}`);
    const title = node.originalTitle || node.title;
    document.title = `${title} · 문맥 편집 — 문해`;
    setSelfTitle(`문맥 편집 — ${title}`);
    must("#contextNodeName").textContent = title;
    must("#directContextTitle").textContent = node.nodeRole === "container" ? "이 폴더의 문맥" : "이 문서의 문맥";
    must("#currentScopeLabel").textContent = node.nodeRole === "container" ? "현재 폴더" : "현재 문서";
    must("#sbPath").textContent = shortPath(project!.packagePath);
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
    must("#contextLoading").textContent = error instanceof Error ? error.message : "문맥을 불러오지 못했습니다.";
    renderSidebar(defaultSidebarTree(docs));
  }
}

must("#addContext").addEventListener("click", () => { if (node) addDraft(undefined, true); });
must("#openSource").addEventListener("click", () => { if (node) go("editor", node.id); });
must("#openMaterials").addEventListener("click", () => go("knowledge"));
must(".context-rail").addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-owner]");
  if (target?.dataset.owner) go("context", target.dataset.owner);
});
window.addEventListener("beforeunload", (event) => {
  if (!allowUnload && [...drafts.values()].some((draft) => draft.saving || isDirty(draft))) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("munhae:document-created", (event) => {
  docs = (event as CustomEvent<HomeView>).detail.documents;
  if (node) revealSidebarNode(docs, node.id);
  renderSidebar(defaultSidebarTree(docs), { currentDocId: node?.id ?? null });
});
bindSidebar(undefined, undefined, () => defaultSidebarTree(docs));
await boot();
