import { configureMaterialRefinement } from "./material-refinement-ui";
import { t, ui } from "./i18n";
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
  const refinement = configureMaterialRefinement(deps.api);
  const esc = deps.escape;
  const dialog = document.createElement("dialog");
  dialog.className = "material-editor-dialog";
  dialog.setAttribute("aria-label", t("번역 참고 자료 편집"));
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
    el<HTMLButtonElement>("[type=submit]").textContent = value ? t("저장 중…") : editing.comment || editing.item?.reference ? t("확인 후 연결 저장") : editing.item ? t("변경 저장") : t("참고 자료에 추가");
  }
  function close(): void { if (!busy && (!hasUnsavedDraft() || window.confirm(t("저장하지 않은 참고 자료 입력을 버리시겠습니까?")))) dialog.close(); }
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.code === "KeyS") { event.preventDefault(); event.stopPropagation(); void save(); }
  });
  dialog.addEventListener("close", () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); });
  dialog.addEventListener("click", event => { if ((event.target as Element).closest("[data-material-close]")) close(); });
  dialog.addEventListener("click", event => {
    if (!(event.target as Element).closest("[data-refine]") || busy) return;
    const content = el<HTMLTextAreaElement>("[name=content]");
    const original = content.value;
    const scopeId = el<HTMLSelectElement>("[name=scopeId]").value;
    refinement.open({ scopeId, title: el<HTMLInputElement>("[name=title]").value, contentMd: original }, text => {
      if (!dialog.open || content.value !== original || el<HTMLSelectElement>("[name=scopeId]").value !== scopeId) return false;
      content.value = text;
      content.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    });
  });
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
    const pathRows = path.map((node, index) => `<li style="--material-depth:${Math.min(index, 8)}"><span>${esc(node.title)}</span><small>${node.id === scopeId ? t("연결 노드") : node.isMaster ? t("프로젝트") : t("상위 노드")}</small></li>`).join("");
    el("[data-scope-preview]").innerHTML = ui`<p>연결 위치${inherit ? ui` · 하위 노드 ${descendants.length}개에도 이어짐` : t(" · 이 노드에서만 참고")}</p><ol class="material-node-chain">${pathRows}</ol>${descendants.length ? ui`<details><summary>이어받을 하위 노드 ${descendants.length}개</summary><ul class="material-scope-descendants">${descendants.map(node => `<li>${esc(materialPathLabel(documents, node.id))}</li>`).join("")}</ul></details>` : ""}`;
  }

  async function save(): Promise<void> {
    if (busy || refinement.isOpen() || !dialog.open || !el<HTMLFormElement>("form").reportValidity()) return;
    const input = {
      scopeId: el<HTMLSelectElement>("[name=scopeId]").value,
      title: el<HTMLInputElement>("[name=title]").value.trim(),
      contentMd: el<HTMLTextAreaElement>("[name=content]").value.trim(),
      conditionMd: el<HTMLTextAreaElement>("[name=condition]").value.trim(),
      inheritToChildren: el<HTMLInputElement>("[name=inherit]").checked,
      enabled: el<HTMLInputElement>("[name=enabled]").checked,
      priority: editing.item?.priority ?? 0,
      ...(editing.item?.reference ? { expectedCommentLockVersion: editing.item.origin!.lockVersion, keepAsContext: el<HTMLInputElement>("[name=keepContext]").checked } : {}),
    };
    if (!input.title || (!editing.comment && !editing.item?.reference && !input.contentMd) || !deps.documents().some(node => node.id === input.scopeId)) {
      el("[data-material-error]").textContent = t("제목, 참고 내용과 연결할 노드를 확인하세요.");
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
      catch (error) { deps.notify(error instanceof Error ? error.message : t("저장한 자료 목록을 다시 불러오세요."), t("자료 갱신")); }
      deps.notify(t("참고 자료를 저장했습니다."), t("번역 자료"));
    } catch (error) {
      el("[data-material-error]").textContent = error instanceof Error ? error.message : t("참고 자료를 저장하지 못했습니다.");
    } finally { setBusy(false); }
  }

  return {
    open(input: MaterialEditorInput = {}): void {
      if (busy || dialog.open) return;
      if (input.item?.source === "document_description") {
        deps.notify(t("문서 설명은 해당 노드의 문서 정보에서 수정할 수 있습니다."), t("번역 자료"));
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
      const title = input.item?.title ?? (input.comment ? ui`${input.comment.quote}에 관한 검토` : "");
      const content = input.item?.contentMd ?? "";
      const isReference = !!input.comment || !!input.item?.reference;
      const status = input.item?.reference;
      const reviewNote = t(status?.sourceUnavailable ? "원본 코멘트가 삭제되었습니다. AI에 적용하지 않습니다." : status?.sourceChanged ? "원본 코멘트가 변경되었습니다. 현재 내용을 확인한 뒤 저장하면 다시 적용할 수 있습니다." : status?.needsReview ? "기존 복사본의 편집 내용을 보충 메모로 보존했습니다. 확인 후 연결로 저장하거나 독립 문맥으로 보관하세요." : "");
      const origin = source ? ui`<section class="material-editor-origin"><b>원본 코멘트</b><p>${esc(materialPathLabel(documents, sourceNodeId!))}</p><blockquote>${esc(source.quote)}</blockquote><p class="material-preserve">${esc(source.bodyMd)}</p><small>작성 당시의 ${source.targetKind === "source" ? t("원문") : t("번역문")} 구절에 대한 기록입니다. 참고할 범위와 조건을 직접 정하세요.</small></section>` : "";
      dialog.innerHTML = ui`<form><header class="material-editor-heading"><h2>${isReference ? t("참고 코멘트 연결") : input.item ? t("참고 자료 편집") : t("참고 자료 추가")}</h2><p>${isReference ? t("원본 코멘트를 연결하고, 적용 조건과 보충 메모만 별도로 저장합니다.") : t("문헌의 배경이나 번역 판단을 연결할 노드에 남깁니다.")}</p></header><div class="material-editor-body">${origin}${reviewNote ? `<p class="material-editor-help" role="status">${esc(reviewNote)}</p>` : ""}<div class="field"><label for="materialEditTitle">자료 제목</label><input id="materialEditTitle" class="input" name="title" value="${esc(title)}" required maxlength="500"></div><div class="field"><label for="materialEditContent">${t(isReference ? "보충 메모 (선택)" : "함께 참고할 내용")}</label><textarea id="materialEditContent" class="textarea" name="content" rows="6" ${isReference ? "" : "required"} maxlength="200000">${esc(content)}</textarea></div><button class="btn" type="button" data-refine>AI 채팅·다듬기</button><div class="field"><label for="materialEditCondition">적용 조건·예외 <span class="muted">(선택)</span></label><textarea id="materialEditCondition" class="textarea" name="condition" rows="2" maxlength="20000" placeholder="어떤 구절이나 시대에 해당하는 판단인지 적어 주세요.">${esc(input.item?.conditionMd ?? "")}</textarea></div><div class="field"><label for="materialEditScope">연결할 노드</label><select id="materialEditScope" class="select" name="scopeId">${documents.map(node => `<option value="${esc(node.id)}"${node.id === scopeId ? " selected" : ""}>${esc(materialPathLabel(documents, node.id))}</option>`).join("")}</select></div><label class="check"><input type="checkbox" name="inherit"${(input.item ? input.item.inheritToChildren !== false : !input.comment) ? " checked" : ""}> 하위 노드에서도 이어받기</label><section class="material-scope-preview" data-scope-preview aria-live="polite"></section><label class="check"><input type="checkbox" name="enabled"${(input.item ? input.item.enabled : !input.comment) ? " checked" : ""}> 연결 범위의 AI 작업(용어·번역·채팅)에 참고</label>${input.item?.reference ? `<label class="check"><input type="checkbox" name="keepContext"> ${t("연결 대신 독립적인 문맥 자료로 보관")}</label>` : ""}<p class="material-editor-help">다른 문서의 내용에 이 판단을 적용하기 전에는 원래 구절과 조건을 대조하세요. 문서마다 따로 제외할 수 있습니다.</p><p class="material-editor-error" data-material-error role="alert"></p></div><footer class="material-editor-footer"><button class="btn" type="button" data-material-close>취소</button><button class="btn btn-primary" type="submit">${isReference ? t("확인 후 연결 저장") : input.item ? t("변경 저장") : t("참고 자료에 추가")}</button></footer></form>`;
      renderScope();
      baseline = snapshot();
      dialog.showModal();
      el<HTMLInputElement>("[name=title]").focus();
    },
    hasUnsavedDraft,
    isBusy: () => busy || refinement.isOpen(),
    discard: () => { if (!busy && dialog.open) { baseline = snapshot(); dialog.close(); } },
  };
}
