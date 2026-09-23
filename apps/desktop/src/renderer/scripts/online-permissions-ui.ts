import type { OnlineWorkspaceStatus } from "../../shared/online-projects";

// Presentation only. The repo guard and PostgreSQL RPC independently enforce access.
const ownerControls = "#btnConfirm,#btnConfirmSource,#btnConfirmPunctuation";
const writeControls = [ownerControls, "#btnEditorUndo,#btnEditorRedo,#btnEditSource,#btnSaveSourceDraft,#btnEditPunctuation,#btnSavePunctuationDraft,#btnCreatePunctuationDraft,#btnSuggestPunctuation,#btnCreateTranslationDraft,#btnSaveFullTranslation,#btnPrepare,#btnRevise", "[data-edit-sentence],[data-edit-sentence-link],[data-split-group],[data-merge-group]"].join(",");
const textControls = "#sourceDraftText,#punctuationDraftText,#fullTranslationInput,.sentence-edit,.tgt-edit";
export function initOnlinePermissions(root: Document = document) {
  let status: OnlineWorkspaceStatus | null = null;
  const locked = new Set<HTMLElement>();
  const readonly = new Map<HTMLTextAreaElement | HTMLElement, boolean | string>();
  function apply() {
    observer.disconnect();
    const selector = status && !status.writable ? writeControls : status?.role === "editor" ? ownerControls : "";
    const next = new Set(selector ? root.querySelectorAll<HTMLElement>(selector) : []);
    for (const node of locked) if (!next.has(node)) { node.inert = false; node.removeAttribute("aria-disabled"); node.classList.remove("online-permission-disabled"); locked.delete(node); }
    for (const node of next) { node.inert = true; node.setAttribute("aria-disabled", "true"); node.classList.add("online-permission-disabled"); locked.add(node); }
    if (status && !status.writable) {
      for (const node of root.querySelectorAll<HTMLElement>(textControls)) {
        if (node instanceof HTMLTextAreaElement) { if (!readonly.has(node)) readonly.set(node, node.readOnly); node.readOnly = true; }
        else { if (!readonly.has(node)) readonly.set(node, node.contentEditable); node.contentEditable = "false"; }
      }
    } else {
      for (const [node, value] of readonly) if (node instanceof HTMLTextAreaElement) node.readOnly = value === true; else node.contentEditable = String(value);
      readonly.clear();
    }
    observer.observe(root.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["readonly", "contenteditable"] });
  }
  const observer = new MutationObserver(apply);
  return { update(value: OnlineWorkspaceStatus | null) { status = value; apply(); }, dispose() { observer.disconnect(); } };
}
