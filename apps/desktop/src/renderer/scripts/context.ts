import type { DocumentListItem, HomeView, NodeContextView } from "../../shared/munhae-api";
import {
  bindSidebar, defaultSidebarTree, esc, go, initShell, must, notify,
  renderSidebar, requireProject, revealSidebarNode, setSelfTitle, shortPath, unwrap,
} from "./shared";

const project = await requireProject();
if (!project) throw new Error("redirect");

type ContextDraft = {
  item?: NodeContextView;
  title: HTMLInputElement;
  content: HTMLTextAreaElement;
  enabled: HTMLInputElement;
  status: HTMLElement;
  save: HTMLButtonElement;
  archive: HTMLButtonElement;
  saving: boolean;
};

let docs: DocumentListItem[] = [];
let node: DocumentListItem | undefined;
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
    || draft.enabled.checked !== (draft.item?.enabled ?? true);
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
    status: form.querySelector<HTMLElement>("[data-state]")!,
    save: form.querySelector<HTMLButtonElement>("[type=submit]")!,
    archive: form.querySelector<HTMLButtonElement>("[data-archive]")!,
    saving: false,
  };
  drafts.set(form, draft);
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
    draft.archive.textContent = "보관";
    form.setAttribute("aria-label", saved.title);
    notify(`${saved.title} 저장`, "문맥");
    await refreshSidebar();
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
  } catch (error) {
    notify(error instanceof Error ? error.message : "문맥을 보관하지 못했습니다.", "문맥");
  } finally {
    draft.saving = false;
    updateSaveState();
  }
}

function referenceHtml(item: NodeContextView, inherited: boolean): string {
  const owner = docs.find((document) => document.id === item.scopeId);
  const label = owner?.originalTitle || owner?.title || "상위 문서";
  return `<details class="context-reference">
    <summary>${esc(item.title)}<span class="context-owner">${inherited ? esc(label) : "문서 정보에서 가져온 설명"}${!item.enabled ? " · 자동 포함 제외" : ""}</span></summary>
    <p class="context-reference-body">${esc(item.contentMd)}</p>
    ${inherited ? `<button class="btn" type="button" data-owner="${esc(item.scopeId)}">이 노드의 문맥 편집</button>` : ""}
  </details>`;
}

async function boot(): Promise<void> {
  try {
    const [homeResult, knowledgeResult] = await Promise.all([api.home.get(), api.knowledge.get()]);
    const home = unwrap(homeResult, "문서 불러오기");
    const knowledge = unwrap(knowledgeResult, "문맥 불러오기");
    if (!home || !knowledge) throw new Error("문맥을 불러오지 못했습니다. 페이지를 다시 열어 주세요.");
    docs = home.documents;
    const requestedId = new URLSearchParams(location.search).get("node");
    node = requestedId ? docs.find((document) => document.id === requestedId) : docs.find((document) => document.isMaster);
    if (!node) throw new Error("이 문서를 찾을 수 없습니다. 사이드바에서 문서를 선택해 주세요.");
    history.replaceState(null, "", `context.html?node=${encodeURIComponent(node.id)}`);
    const title = node.originalTitle || node.title;
    document.title = `${title} · 문맥 편집 — 문해`;
    setSelfTitle(`문맥 편집 — ${title}`);
    must("#contextNodeName").textContent = title;
    must("#contextTitle").textContent = `${title}`;
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
    const direct = knowledge.contextItems.filter((item) => item.scopeId === node!.id && item.source === "context_item");
    for (const item of direct) addDraft(item);
    if (direct.length === 0) addDraft();
    const descriptions = knowledge.contextItems.filter((item) => item.scopeId === node!.id && item.source === "document_description");
    must("#documentDescriptions").hidden = descriptions.length === 0;
    must("#documentDescriptions").innerHTML = descriptions.map((item) => referenceHtml(item, false)).join("");
    const ancestors = lineage.slice(1);
    const inherited = ancestors.flatMap((ancestor) => knowledge.contextItems.filter((item) => item.scopeId === ancestor.id));
    must("#inheritedCount").textContent = String(inherited.length);
    must("#inheritedContexts").innerHTML = inherited.map((item) => referenceHtml(item, true)).join("")
      || '<div class="context-empty"><span aria-hidden="true">↳</span><b>여기서 시작하는 문맥</b><p>상위 문서에 등록된 문맥이 없습니다.</p></div>';
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
must("#inheritedContexts").addEventListener("click", (event) => {
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
