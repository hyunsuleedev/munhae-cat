import type { DocumentListItem, IpcResult, MunhaeApi } from "../../shared/munhae-api";
import { t, ui } from "./i18n";
import { documentPathText } from "./knowledge-model";

type Dependencies = {
  api: MunhaeApi;
  docs: () => DocumentListItem[];
  escape: (value: unknown) => string;
  create: (parentId: string, role: "container" | "source_unit") => void;
  context: (id: string) => void;
  info: (id: string) => void;
  mutate: (action: () => Promise<IpcResult<unknown>>) => Promise<boolean>;
  error: (message: string) => void;
};

export function bindSidebarActions(root: HTMLElement, deps: Dependencies): void {
  if (root.dataset.actionsBound) return;
  root.dataset.actionsBound = "1";
  const esc = deps.escape;
  let menu: HTMLElement | null = null;
  let ownerId: string | undefined;
  let opening = false;
  const restore = () => root.querySelector<HTMLElement>(`[role=treeitem][data-doc-id="${CSS.escape(ownerId ?? "")}"]`)?.focus({ preventScroll: true });
  const closeMenu = (focus = false) => { menu?.remove(); menu = null; if (focus) restore(); };
  const openDialog = async (id: string, kind: "rename" | "move") => {
    if (opening) return;
    opening = true;
    try {
      const result = await deps.api.home.getDocumentMetadata(id);
      if (!result.ok) throw new Error(result.error.message);
      const metadata = result.data;
      if (metadata.isMaster) throw new Error(t("프로젝트 마스터 폴더는 이름이나 위치를 바꿀 수 없습니다"));
      const home = await deps.api.home.get();
      if (!home.ok) throw new Error(home.error.message);
      const documents = home.data.documents;
      const title = kind === "rename" ? t("이름 변경") : t("이동·순서 변경");
      const dialog = document.createElement("dialog");
      dialog.className = "sb-action-dialog";
      dialog.setAttribute("aria-label", title);
      const form = document.createElement("form");
      form.innerHTML = `<div class="dl-h">${esc(title)}</div><div class="dl-b"><p class="sb-action-path">${esc(documentPathText(documents, id))}</p>${kind === "rename" ? ui`
        <div class="field"><label for="sbRenameTitle">제목</label><input class="input" id="sbRenameTitle" maxlength="500" required value="${esc(metadata.title)}"></div>
        <div class="field"><label for="sbRenameOriginal">원제</label><input class="input" id="sbRenameOriginal" maxlength="500" value="${esc(metadata.originalTitle ?? "")}"></div>
        <p class="muted">원제가 있으면 사이드바에 원제를 표시합니다.</p>` : ui`
        <div class="field"><label for="sbMoveParent">이동할 폴더</label><select class="select" id="sbMoveParent"></select></div>
        <div class="field"><label for="sbMoveBefore">폴더 안의 위치</label><select class="select" id="sbMoveBefore"></select></div>
        <p class="sb-move-impact" role="status"></p>`}<p class="sb-action-error" role="alert" hidden></p></div>
        <div class="dl-f"><button class="btn" type="button" data-cancel>${esc(t("취소"))}</button><button class="btn btn-primary" type="submit">${esc(kind === "rename" ? t("저장") : t("이동"))}</button></div>`;
      dialog.append(form); document.body.append(dialog);
      let saving = false;
      const cancel = form.querySelector<HTMLButtonElement>("[data-cancel]")!;
      cancel.onclick = () => dialog.close();
      dialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
      dialog.addEventListener("close", () => { dialog.remove(); restore(); }, { once: true });
      const parent = form.querySelector<HTMLSelectElement>("#sbMoveParent");
      const before = form.querySelector<HTMLSelectElement>("#sbMoveBefore");
      if (parent && before) {
        const blocked = new Set([id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const doc of documents) if (doc.parentId && blocked.has(doc.parentId) && !blocked.has(doc.id)) { blocked.add(doc.id); changed = true; }
        }
        parent.innerHTML = documents.filter(doc => doc.nodeRole === "container" && !blocked.has(doc.id))
          .map(doc => `<option value="${esc(doc.id)}">${esc(documentPathText(documents, doc.id))}</option>`).join("");
        parent.value = metadata.parentId ?? "";
        const updatePosition = () => {
          const siblings = documents.filter(doc => doc.parentId === parent.value && doc.id !== id).sort((a, b) => a.ordinal - b.ordinal);
          before.innerHTML = `<option value="">${esc(t("맨 뒤"))}</option>` + siblings.map(doc => `<option value="${esc(doc.id)}">${esc(doc.originalTitle || doc.title)} ${esc(t("앞으로"))}</option>`).join("");
          if (parent.value === metadata.parentId) {
            const current = documents.find(doc => doc.id === id);
            before.value = siblings.find(doc => doc.ordinal > (current?.ordinal ?? Infinity))?.id ?? "";
          }
          const impact = form.querySelector<HTMLElement>(".sb-move-impact")!;
          impact.textContent = parent.value === metadata.parentId ? t("같은 폴더 안에서 순서만 바꿉니다. 상속 문맥은 유지됩니다.") : t("폴더를 옮기면 이 항목과 하위 문서가 이어받는 문맥·자료와 저자·출전 정보가 달라질 수 있습니다. 기존 원문과 번역은 유지됩니다.");
          impact.classList.toggle("is-warning", parent.value !== metadata.parentId);
        };
        parent.addEventListener("change", updatePosition);
        updatePosition();
      }
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (saving) return;
        const error = form.querySelector<HTMLElement>(".sb-action-error")!;
        error.hidden = true;
        if (kind === "rename" && !form.querySelector<HTMLInputElement>("#sbRenameTitle")!.value.trim()) return;
        saving = true;
        form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select").forEach(control => { control.disabled = true; });
        void (async () => {
          try {
            const changed = await deps.mutate(() => kind === "rename" ? deps.api.home.updateDocumentMetadata({
              documentNodeId: id, title: form.querySelector<HTMLInputElement>("#sbRenameTitle")!.value.trim(),
              originalTitle: form.querySelector<HTMLInputElement>("#sbRenameOriginal")!.value.trim() || null,
              authorName: metadata.authorName, language: metadata.language, periodText: metadata.periodText,
              dateText: metadata.dateText, descriptionMd: metadata.descriptionMd, sourceReference: metadata.sourceReference,
              expectedLockVersion: metadata.lockVersion,
            }) : deps.api.home.moveDocument({ documentNodeId: id, parentId: parent!.value, beforeDocumentNodeId: before!.value || null, expectedLockVersion: metadata.lockVersion }));
            if (changed) dialog.close();
          } catch (cause) { error.textContent = cause instanceof Error ? cause.message : t("문서를 변경하지 못했습니다"); error.hidden = false; }
          finally { saving = false; form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select").forEach(control => { control.disabled = false; }); }
        })();
      });
      dialog.showModal();
      form.querySelector<HTMLInputElement>("input")?.select();
    } catch (cause) { deps.error(cause instanceof Error ? cause.message : t("문서 정보를 불러오지 못했습니다")); }
    finally { opening = false; }
  };
  const show = (id: string, x: number, y: number) => {
    const doc = deps.docs().find(item => item.id === id);
    if (!doc) return;
    closeMenu(); ownerId = id;
    const actions: Array<{ label: string; run: () => void; disabled?: boolean }> = [
      { label: t("문서 정보"), run: () => deps.info(id) },
      { label: t("문맥 열기"), run: () => deps.context(id) },
      { label: t("이름 변경"), disabled: doc.isMaster, run: () => void openDialog(id, "rename") },
      { label: t("이동·순서 변경"), disabled: doc.isMaster, run: () => void openDialog(id, "move") },
      ...(doc.nodeRole === "container" ? [
        { label: t("이 폴더에 문서 추가"), run: () => deps.create(id, "source_unit") },
        { label: t("이 폴더에 폴더 추가"), run: () => deps.create(id, "container") },
      ] : []),
    ];
    const element = document.createElement("div");
    element.className = "sb-context-menu"; element.setAttribute("role", "menu");
    element.setAttribute("aria-label", doc.originalTitle || doc.title);
    actions.forEach(action => {
      const button = document.createElement("button");
      button.type = "button"; button.setAttribute("role", "menuitem"); button.tabIndex = -1;
      button.disabled = !!action.disabled; button.textContent = action.label;
      button.onclick = () => { closeMenu(); action.run(); };
      element.append(button);
    });
    document.body.append(element); menu = element;
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, innerHeight - element.offsetHeight - 8))}px`;
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    element.addEventListener("keydown", event => {
      const buttons = [...element.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    });
  };
  root.addEventListener("contextmenu", event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".sb-row");
    const item = row?.querySelector<HTMLElement>("[data-doc-id]");
    if (!item?.dataset.docId) return;
    event.preventDefault(); show(item.dataset.docId, event.clientX, event.clientY);
  });
  root.addEventListener("click", event => {
    const more = (event.target as HTMLElement).closest<HTMLElement>("[data-sb-menu]");
    if (!more?.dataset.sbMenu) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = more.getBoundingClientRect(); show(more.dataset.sbMenu, bounds.right, bounds.bottom);
  });
  root.addEventListener("keydown", event => {
    const item = (event.target as HTMLElement).closest<HTMLElement>("[role=treeitem][data-doc-id]");
    if (!item?.dataset.docId || event.isComposing) return;
    if (event.key === "F2") { event.preventDefault(); ownerId = item.dataset.docId; void openDialog(ownerId, "rename"); }
    else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault(); const bounds = item.getBoundingClientRect(); show(item.dataset.docId, bounds.left + 20, bounds.bottom);
    }
  });
  document.addEventListener("pointerdown", event => { if (menu && !menu.contains(event.target as Node)) closeMenu(); }, true);
  root.addEventListener("scroll", () => closeMenu(), { passive: true });
  window.addEventListener("resize", () => closeMenu());
}
