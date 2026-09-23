import { t, uiText, ui } from "./i18n";
import type { EditorView, MunhaeApi } from "../../shared/munhae-api";
import { textareaRange, textareaOffset } from "./review-selection";

type Span = { from: number; to: number; quote: string };
type Deps = {
  api: MunhaeApi;
  view(): EditorView | null;
  hasUnsavedChanges(): boolean;
  apply(view: EditorView): void;
  escape(text: string): string;
  notify(message: string, title?: string): void;
};

/** Manual links use the stored source's codepoint offsets, never quote search. */
export function configureSentenceLinkUi(deps: Deps) {
  const dialog = document.createElement("dialog");
  dialog.className = "dlg sentence-link-dialog";
  dialog.setAttribute("aria-labelledby", "sentenceLinkTitle");
  dialog.innerHTML = uiText(`<form><header><h2 id="sentenceLinkTitle">원문 대응 확인</h2><p>이 번역에 해당하는 원문 구절을 선택해 추가하세요. 떨어진 구절을 여러 개 연결하거나, 같은 구절을 여러 번역 문장에 연결할 수 있습니다.</p></header><blockquote id="sentenceLinkTarget"></blockquote><label for="sentenceLinkSource">원문에서 구절 선택</label><textarea id="sentenceLinkSource" class="textarea hanmun" readonly spellcheck="false" rows="6"></textarea><div class="row"><span class="muted">선택한 구절은 정확한 위치로 저장됩니다.</span><span class="sp"></span><button class="btn btn-sm" id="addSentenceSpan" type="button" disabled>선택 구절 추가</button></div><div id="sentenceLinkSpans"></div><p id="sentenceLinkError" class="review-error" role="alert"></p><footer><button class="btn" id="cancelSentenceLink" type="button">취소</button><button class="btn btn-primary" type="submit" id="saveSentenceLink">대응 확인하고 저장</button></footer></form>`);
  document.body.append(dialog);
  const el = <T extends HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const source = el<HTMLTextAreaElement>("sentenceLinkSource");
  const add = el<HTMLButtonElement>("addSentenceSpan");
  const save = el<HTMLButtonElement>("saveSentenceLink");
  const cancel = el<HTMLButtonElement>("cancelSentenceLink");
  const error = el<HTMLElement>("sentenceLinkError");
  let target: { documentNodeId: string; versionId: string; sentenceId: string; expectedLockVersion: number; source: string } | null = null;
  let spans: Span[] = [];
  let saving = false;
  function render() {
    el<HTMLElement>("sentenceLinkSpans").innerHTML = spans.map((span, i) => ui`<div class="sentence-link-span"><button type="button" data-locate="${i}" title="원문 위치 보기">${deps.escape(span.quote)}</button><button class="btn btn-ghost btn-sm" type="button" data-remove="${i}" aria-label="연결 구절 ${i + 1} 제거">×</button></div>`).join("");
    save.disabled = saving || spans.length === 0;
    cancel.disabled = saving;
    save.textContent = saving ? t("저장 중…") : t("대응 확인하고 저장");
    dialog.querySelectorAll<HTMLButtonElement>("[data-remove],[data-locate]").forEach((b) => b.disabled = saving);
  }
  function selection() {
    return target ? textareaRange(target.source, source.selectionStart, source.selectionEnd) : null;
  }
  source.addEventListener("select", () => { add.disabled = saving || !selection(); });
  source.addEventListener("keyup", () => { add.disabled = saving || !selection(); });
  source.addEventListener("pointerup", () => { add.disabled = saving || !selection(); });
  add.addEventListener("click", () => {
    const span = selection();
    if (!span || saving) return;
    if (!spans.some((item) => item.from === span.from && item.to === span.to)) spans.push(span);
    spans.sort((a, b) => a.from - b.from || a.to - b.to);
    error.textContent = "";
    render();
  });
  dialog.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-remove],button[data-locate]");
    if (!button || saving) return;
    if (button.dataset.remove !== undefined) { spans.splice(Number(button.dataset.remove), 1); render(); }
    else {
      const span = spans[Number(button.dataset.locate)];
      if (span && target) { source.focus(); source.setSelectionRange(textareaOffset(target.source, span.from), textareaOffset(target.source, span.to)); }
    }
  });
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
  dialog.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!target || !spans.length || saving) return;
    const input = { documentNodeId: target.documentNodeId, versionId: target.versionId, sentenceId: target.sentenceId, expectedLockVersion: target.expectedLockVersion, spans: spans.map((span) => ({ ...span })) };
    saving = true; add.disabled = true; error.textContent = ""; render();
    void (async () => {
      try {
        const result = await deps.api.editor.saveSentenceLink(input);
        if (!result.ok) { error.textContent = result.error.message; return; }
        const current = deps.view();
        if (current?.document.id === input.documentNodeId && current.translation?.versionId === input.versionId && !deps.hasUnsavedChanges()) deps.apply(result.data);
        dialog.close();
        deps.notify(t("원문 대응을 저장했습니다"), t("문장별 대조"));
      } catch (e) { error.textContent = e instanceof Error ? e.message : t("원문 대응을 저장하지 못했습니다"); }
      finally { saving = false; render(); }
    })();
  });
  return {
    isBusy: () => saving,
    open(sentenceId: string) {
      const view = deps.view();
      const translation = view?.translation;
      const sentence = translation?.textLayout?.sentences.find((item) => item.id === sentenceId);
      if (!view || !translation?.isCurrentDependencies || !sentence || translation.textLayout?.state === "running") return;
      if (deps.hasUnsavedChanges()) { deps.notify(t("번역을 먼저 저장한 뒤 원문 대응을 확인하세요"), t("문장별 대조")); return; }
      target = { documentNodeId: view.document.id, versionId: translation.versionId, sentenceId, expectedLockVersion: translation.lockVersion, source: view.source.contentText };
      spans = (translation.textLayout?.links.find((item) => item.sentenceId === sentenceId)?.spans ?? []).map((span) => ({ ...span }));
      const groupId = translation.textLayout?.links.find(link => link.sentenceId === sentenceId)?.groupId;
      const members = groupId ? new Set(translation.textLayout!.links.filter(link => link.groupId === groupId).map(link => link.sentenceId)) : new Set([sentenceId]);
      el<HTMLElement>("sentenceLinkTarget").textContent = translation.textLayout!.sentences.filter(item => members.has(item.id)).map(item => item.text).join("");
      source.value = target.source;
      error.textContent = ""; add.disabled = true; render();
      dialog.showModal();
      source.focus(); source.setSelectionRange(0, 0);
    },
  };
}
