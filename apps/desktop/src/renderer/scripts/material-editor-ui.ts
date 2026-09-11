import type { DocumentListItem, MunhaeApi, NodeContextView, ReviewCommentView } from "../../shared/munhae-api";
import { materialNodePath, materialPathLabel, materialScopeNodes } from "./material-paths";
import "../styles/material-editor.css";

type MaterialEditorDeps = {
  api: MunhaeApi;
  documents(): DocumentListItem[];
  currentDocumentId(): string | null;
  escape(value: unknown): string;
  notify(message: string, title?: string): void;
  onSaved(item: NodeContextView): void | Promise<void>;
};
export type MaterialEditorInput = { item?: NodeContextView; comment?: ReviewCommentView; scopeId?: string };

export function configureMaterialEditor(deps: MaterialEditorDeps) {
  const esc = deps.escape;
  const dialog = document.createElement("dialog");
  dialog.className = "material-editor-dialog";
  dialog.setAttribute("aria-label", "번역 참고 자료 편집");
  document.body.append(dialog);
  let editing: MaterialEditorInput = {};
  let busy = false;
  let baseline = "";
  let opener: HTMLElement | null = null;
  const el = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const snapshot = () => JSON.stringify([...dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")]
    .map(input => input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value));
  const hasUnsavedDraft = () => dialog.open && snapshot() !== baseline;
  function setBusy(value: boolean): void {
    busy = value;
    dialog.setAttribute("aria-busy", String(value));
    dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input,select,textarea,button").forEach(control => { control.disabled = value; });
    el<HTMLButtonElement>("[type=submit]").textContent = value ? "저장 중…" : editing.item ? "변경 저장" : "참고 자료에 추가";
  }
  function close(): void { if (!busy && (!hasUnsavedDraft() || window.confirm("저장하지 않은 참고 자료 입력을 버리시겠습니까?"))) dialog.close(); }
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.code === "KeyS") { event.preventDefault(); event.stopPropagation(); void save(); }
  });
  dialog.addEventListener("close", () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); });
  dialog.addEventListener("click", event => { if ((event.target as Element).closest("[data-material-close]")) close(); });
  dialog.addEventListener("change", event => {
    if ((event.target as HTMLElement).matches("[name=scopeId],[name=inherit]")) renderScope();
  });
  dialog.addEventListener("submit", event => { event.preventDefault(); void save(); });

  function renderScope(): void {
    const documents = deps.documents();
    const scopeId = el<HTMLSelectElement>("[name=scopeId]").value;
    const inherit = el<HTMLInputElement>("[name=inherit]").checked;
    const path = materialNodePath(documents, scopeId);
    const scope = materialScopeNodes(documents, scopeId, inherit);
    const descendants = scope.filter(node => node.id !== scopeId);
    const pathRows = path.map((node, index) => `<li style="--material-depth:${Math.min(index, 8)}"><span>${esc(node.title)}</span><small>${node.id === scopeId ? "연결 노드" : node.isMaster ? "프로젝트" : "상위 노드"}</small></li>`).join("");
    el("[data-scope-preview]").innerHTML = `<p>연결 위치${inherit ? ` · 하위 노드 ${descendants.length}개에도 이어짐` : " · 이 노드에서만 참고"}</p><ol class="material-node-chain">${pathRows}</ol>${descendants.length ? `<details><summary>이어받을 하위 노드 ${descendants.length}개</summary><ul class="material-scope-descendants">${descendants.map(node => `<li>${esc(materialPathLabel(documents, node.id))}</li>`).join("")}</ul></details>` : ""}`;
  }

  async function save(): Promise<void> {
    if (busy || !dialog.open || !el<HTMLFormElement>("form").reportValidity()) return;
    const input = {
      scopeId: el<HTMLSelectElement>("[name=scopeId]").value,
      title: el<HTMLInputElement>("[name=title]").value.trim(),
      contentMd: el<HTMLTextAreaElement>("[name=content]").value.trim(),
      conditionMd: el<HTMLTextAreaElement>("[name=condition]").value.trim(),
      inheritToChildren: el<HTMLInputElement>("[name=inherit]").checked,
      enabled: el<HTMLInputElement>("[name=enabled]").checked,
      priority: editing.item?.priority ?? 0,
    };
    if (!input.title || !input.contentMd || !deps.documents().some(node => node.id === input.scopeId)) {
      el("[data-material-error]").textContent = "제목, 참고 내용과 연결할 노드를 확인하세요.";
      return;
    }
    setBusy(true);
    el("[data-material-error]").textContent = "";
    try {
      const result = editing.item
        ? await deps.api.knowledge.updateContext({ ...input, id: editing.item.id, expectedLockVersion: editing.item.lockVersion })
        : editing.comment
          ? await deps.api.knowledge.reuseCommentAsMaterial({ ...input, commentId: editing.comment.id, expectedCommentLockVersion: editing.comment.lockVersion })
          : await deps.api.knowledge.createContext(input);
      if (!result.ok) throw new Error(result.error.message);
      baseline = snapshot();
      dialog.close();
      setBusy(false);
      try { await deps.onSaved(result.data); }
      catch (error) { deps.notify(error instanceof Error ? error.message : "저장한 자료 목록을 다시 불러오세요.", "자료 갱신"); }
      deps.notify("참고 자료를 저장했습니다.", "번역 자료");
    } catch (error) {
      el("[data-material-error]").textContent = error instanceof Error ? error.message : "참고 자료를 저장하지 못했습니다.";
    } finally { setBusy(false); }
  }

  return {
    open(input: MaterialEditorInput = {}): void {
      if (busy || dialog.open) return;
      if (input.item?.source === "document_description") {
        deps.notify("문서 설명은 해당 노드의 문서 정보에서 수정할 수 있습니다.", "번역 자료");
        return;
      }
      const documents = deps.documents();
      if (!documents.length) return;
      editing = input;
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const source = input.comment ?? input.item?.origin;
      const sourceNodeId = source?.documentNodeId;
      const desiredScope = input.item?.scopeId ?? input.scopeId ?? input.comment?.documentNodeId ?? deps.currentDocumentId();
      const scopeId = documents.some(node => node.id === desiredScope) ? desiredScope : documents.find(node => node.isMaster)?.id ?? documents[0]!.id;
      const title = input.item?.title ?? (input.comment ? `${input.comment.quote}에 관한 검토` : "");
      const content = input.item?.contentMd ?? input.comment?.bodyMd ?? "";
      const origin = source ? `<section class="material-editor-origin"><b>근거가 된 코멘트</b><p>${esc(materialPathLabel(documents, sourceNodeId!))}</p><blockquote>${esc(source.quote)}</blockquote><p class="material-preserve">${esc(source.bodyMd)}</p><small>작성 당시의 ${source.targetKind === "source" ? "원문" : "번역문"} 구절에 대한 기록입니다. 참고할 범위와 조건을 직접 정하세요.</small></section>` : "";
      dialog.innerHTML = `<form><header class="material-editor-heading"><h2>${input.item ? "참고 자료 편집" : input.comment ? "코멘트를 참고 자료로 재사용" : "참고 자료 추가"}</h2><p>${input.comment ? "원래 코멘트는 그대로 두고, 참고할 내용을 별도로 저장합니다." : "문헌의 배경이나 번역 판단을 연결할 노드에 남깁니다."}</p></header><div class="material-editor-body">${origin}<div class="field"><label for="materialEditTitle">자료 제목</label><input id="materialEditTitle" class="input" name="title" value="${esc(title)}" required maxlength="500"></div><div class="field"><label for="materialEditContent">함께 참고할 내용</label><textarea id="materialEditContent" class="textarea" name="content" rows="6" required maxlength="200000">${esc(content)}</textarea></div><div class="field"><label for="materialEditCondition">적용 조건·예외 <span class="muted">(선택)</span></label><textarea id="materialEditCondition" class="textarea" name="condition" rows="2" maxlength="20000" placeholder="어떤 구절이나 시대에 해당하는 판단인지 적어 주세요.">${esc(input.item?.conditionMd ?? "")}</textarea></div><div class="field"><label for="materialEditScope">연결할 노드</label><select id="materialEditScope" class="select" name="scopeId">${documents.map(node => `<option value="${esc(node.id)}"${node.id === scopeId ? " selected" : ""}>${esc(materialPathLabel(documents, node.id))}</option>`).join("")}</select></div><label class="check"><input type="checkbox" name="inherit"${(input.item ? input.item.inheritToChildren !== false : !input.comment) ? " checked" : ""}> 하위 노드에서도 이어받기</label><section class="material-scope-preview" data-scope-preview aria-live="polite"></section><label class="check"><input type="checkbox" name="enabled"${input.item?.enabled !== false ? " checked" : ""}> 연결 범위의 번역에서 기본으로 참고</label><p class="material-editor-help">다른 문서의 내용에 이 판단을 적용하기 전에는 원래 구절과 조건을 대조하세요. 문서마다 따로 제외할 수 있습니다.</p><p class="material-editor-error" data-material-error role="alert"></p></div><footer class="material-editor-footer"><button class="btn" type="button" data-material-close>취소</button><button class="btn btn-primary" type="submit">${input.item ? "변경 저장" : "참고 자료에 추가"}</button></footer></form>`;
      renderScope();
      baseline = snapshot();
      dialog.showModal();
      el<HTMLInputElement>("[name=title]").focus();
    },
    hasUnsavedDraft,
    isBusy: () => busy,
    discard: () => { if (!busy && dialog.open) { baseline = snapshot(); dialog.close(); } },
  };
}
