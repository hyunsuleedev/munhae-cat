import type { CreateReviewCommentInput, EditorView, MunhaeApi, ReviewCommentView } from "../../shared/munhae-api";
import { textareaRange, sourceDisplayFromElement, sourceRangeFromDisplay } from "./review-selection";
import { configureReviewMarks, type ReviewMarkRange } from "./review-marks";
import { configureFootnoteSearch } from "./footnote-search-ui";
import { appendFootnoteCitation } from "./footnote-citation";
import { appendFootnoteRecommendation } from "./footnote-analysis-citation";
import { appendDictionaryCitation } from "./dictionary-citation";
import type { DictionaryContext } from "./dictionary-ui";
import { configureReviewContextMenu, sourceSnapshotIsCurrent, type ReviewSourceSnapshot, type ReviewSourceState } from "./review-context-menu";
import "../styles/review-context-menu.css";

type Revision = { baseVersionId: string; commentIds: string[] };
type Deps = {
  api: MunhaeApi;
  view(): EditorView | null;
  hasUnsavedChanges(): boolean;
  hasUnsavedTextChanges?(): boolean;
  canEditTranslation(sentenceId: string): boolean;
  escape(value: unknown): string;
  notify(message: string, title?: string): void;
  showComments(layout?: "parallel" | "full"): void;
  retranslate(revision: Revision): void;
  compare(): Promise<void>;
  reuseComment?(comment: ReviewCommentView): void;
  openDictionary?(context: DictionaryContext): void;
  changed?(): void;
};
type SelectionTarget = Omit<CreateReviewCommentInput, "bodyMd">;

export function configureReviewComments(deps: Deps) {
  const el = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const value = document.querySelector<T>(selector);
    if (!value) throw new Error(`missing ${selector}`);
    return value;
  };
  const esc = deps.escape;
  let comments: ReviewCommentView[] = [];
  let selected: SelectionTarget | null = null;
  let selecting = false;
  let pointerTarget: HTMLElement | null = null;
  let editing: ReviewCommentView | null = null;
  let draftTarget: SelectionTarget | null = null;
  let activeCommentId: string | null = null;
  let loading = false;
  let saving = false;
  let serial = 0;
  let versionKey = "";
  const included = new Set<string>();
  const dialog = el<HTMLDialogElement>("#dlgReviewComment");
  const marks = configureReviewMarks(el("#translationWorkspace"));
  const footnotes = configureFootnoteSearch(deps.api, esc, { view: deps.view, hasUnsavedChanges: deps.hasUnsavedTextChanges ?? deps.hasUnsavedChanges });
  const contextMenu = configureReviewContextMenu(el("#translationWorkspace"), captureContextSelection);

  function sourceState(): ReviewSourceState | null {
    const v = deps.view();
    return v ? {
      documentNodeId: v.document.id,
      sourceVersionId: v.source.versionId,
      punctuationVersionId: v.punctuation?.versionId ?? null,
      translationVersionId: v.translation?.versionId ?? null,
      sourceText: v.source.contentText,
    } : null;
  }

  function captureContextSelection(invocation: { target: EventTarget | null; keyboard: boolean }) {
    if (dialog.open || document.querySelector("dialog[open]") || loading || saving) return null;
    const state = sourceState();
    const selection = window.getSelection();
    if (!state || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
    const source = start?.closest<HTMLElement>("[data-review-source-from]");
    if (!source || !el("#translationWorkspace").contains(source) || !source.contains(range.endContainer)
      || !invocation.keyboard && (!(invocation.target instanceof Node) || !source.contains(invocation.target))) return null;
    const display = sourceDisplayFromElement(source);
    if (!display || Array.from(state.sourceText).slice(display.sourceFrom, display.sourceFrom + Array.from(display.sourceText).length).join("") !== display.sourceText) return null;
    const before = document.createRange();
    before.selectNodeContents(source);
    before.setEnd(range.startContainer, range.startOffset);
    const from = Array.from(before.toString()).length;
    const mapped = sourceRangeFromDisplay(display, from, from + Array.from(range.toString()).length);
    if (!mapped) return null;
    const snapshot: ReviewSourceSnapshot = {
      documentNodeId: state.documentNodeId,
      sourceVersionId: state.sourceVersionId,
      punctuationVersionId: state.punctuationVersionId,
      translationVersionId: state.translationVersionId,
      ...mapped,
    };
    const stillCurrent = () => {
      if (sourceSnapshotIsCurrent(snapshot, sourceState()) && !loading && !saving && !document.querySelector("dialog[open]")) return true;
      deps.notify("문서나 원문이 바뀌었습니다. 구절을 다시 선택해 주세요.", "선택 구절");
      return false;
    };
    const canSearch = Array.from(snapshot.quote.trim()).length <= 100;
    return {
      quote: snapshot.quote,
      rects: [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })),
      actions: [
        {
          id: "comment", label: "코멘트 달기", enabled: selectionReady(),
          description: selectionReady() ? undefined : "현재 번역의 편집 내용을 저장한 뒤 코멘트를 남길 수 있습니다.",
          run: () => {
            if (!stillCurrent() || !selectionReady() || !snapshot.translationVersionId) return;
            selected = {
              documentNodeId: snapshot.documentNodeId,
              translationVersionId: snapshot.translationVersionId,
              targetKind: "source",
              targetVersionId: snapshot.sourceVersionId,
              codepointFrom: snapshot.from,
              codepointTo: snapshot.to,
              quote: snapshot.quote,
            };
            openComment();
          },
        },
        {
          id: "dictionary", label: "한자·어휘 사전", enabled: canSearch && !!deps.openDictionary,
          description: "선택한 한자나 어휘의 한국어 뜻을 찾습니다.",
          run: () => {
            if (!stillCurrent()) return;
            cancelSelection();
            clearNativeSelection();
            deps.openDictionary?.({
              query: snapshot.quote, quote: snapshot.quote,
              isCurrent: () => sourceSnapshotIsCurrent(snapshot, sourceState()),
              insert: selectionReady() && snapshot.translationVersionId ? citation => {
                if (!sourceSnapshotIsCurrent(snapshot, sourceState()) || !selectionReady() || !snapshot.translationVersionId) {
                  throw new Error("문서나 번역이 바뀌었습니다. 현재 구절을 다시 선택해 주세요.");
                }
                selected = {
                  documentNodeId: snapshot.documentNodeId, translationVersionId: snapshot.translationVersionId,
                  targetKind: "source", targetVersionId: snapshot.sourceVersionId,
                  codepointFrom: snapshot.from, codepointTo: snapshot.to, quote: snapshot.quote,
                };
                openComment();
                el<HTMLTextAreaElement>("#reviewCommentBody").value = citation;
              } : undefined,
            });
          },
        },
        {
          id: "footnote", label: "각주 검색", enabled: canSearch,
          description: canSearch ? "선택한 구절로 한국고전종합DB의 각주 용례를 검색합니다." : "각주 검색은 100자 이하의 구절을 선택하세요.",
          run: () => {
            if (!stillCurrent()) return;
            cancelSelection();
            clearNativeSelection();
            footnotes.openAndSearch({ query: snapshot.quote, quote: snapshot.quote,
              selection: { targetKind: "source", from: snapshot.from, to: snapshot.to, quote: snapshot.quote },
              isCurrent: () => sourceSnapshotIsCurrent(snapshot, sourceState()),
            });
          },
        },
        {
          id: "footnote-ai", label: "AI 각주 추천", enabled: canSearch && !(deps.hasUnsavedTextChanges ?? deps.hasUnsavedChanges)()
            && (!deps.view()?.translation || !!deps.view()?.translation?.isCurrentDependencies),
          description: "선택한 구절의 문맥과 각주 자료를 AI가 대조해 추립니다.",
          run: () => {
            if (!stillCurrent() || (deps.hasUnsavedTextChanges ?? deps.hasUnsavedChanges)()) return;
            cancelSelection();
            clearNativeSelection();
            footnotes.openAndAnalyze({ query: snapshot.quote, quote: snapshot.quote,
              selection: { targetKind: "source", from: snapshot.from, to: snapshot.to, quote: snapshot.quote },
              isCurrent: () => sourceSnapshotIsCurrent(snapshot, sourceState()),
            });
          },
        },
      ],
    };
  }

  function eligible(comment: ReviewCommentView): boolean {
    const v = deps.view();
    return !!v?.translation?.isCurrentDependencies
      && comment.translationVersionId === v.translation.versionId
      && comment.documentNodeId === v.document.id;
  }

  function selectionReady(): boolean {
    const v = deps.view();
    return !!v?.translation?.textLayout && v.translation.isCurrentDependencies
      && !deps.hasUnsavedChanges() && !loading && !saving;
  }

  function renderSelection(): void {
    const ready = selectionReady();
    if (!ready) {
      selecting = false;
      pointerTarget = null;
      selected = null;
    }
    const button = el<HTMLButtonElement>("#btnAddReviewComment");
    button.disabled = !ready;
    button.setAttribute("aria-pressed", String(selecting));
    button.title = selecting ? "코멘트 선택 모드 끄기 (Esc)" : "코멘트 선택 모드 켜기";
    el("#rows").classList.toggle("is-comment-selecting", selecting);
    for (const textarea of el("#rows").querySelectorAll<HTMLTextAreaElement>(".sentence-edit")) {
      textarea.readOnly = selecting || !deps.canEditTranslation(textarea.dataset.sentenceEdit ?? "");
    }
    el("#reviewSelectionHint").textContent = selecting
      ? "코멘트를 남길 원문이나 번역문 범위를 선택하세요. Esc로 취소합니다."
      : deps.hasUnsavedChanges()
        ? "편집한 내용을 저장하고 AI 작업을 마친 뒤 코멘트를 남길 수 있습니다."
        : "‘코멘트 달기’를 누르고 범위를 선택하거나, 원문 구절을 선택한 뒤 우클릭하세요.";
  }

  function cancelSelection(): void {
    contextMenu.close();
    selecting = false;
    pointerTarget = null;
    selected = null;
    renderSelection();
  }

  function clearNativeSelection(): void {
    window.getSelection()?.removeAllRanges();
    for (const textarea of el("#rows").querySelectorAll<HTMLTextAreaElement>(".sentence-edit")) {
      textarea.setSelectionRange(textarea.selectionEnd, textarea.selectionEnd);
    }
  }

  function renderMarks(): void {
    const v = deps.view();
    const current = comments.filter(eligible);
    if (!current.some(comment => comment.id === activeCommentId)) activeCommentId = null;
    const ranges: ReviewMarkRange[] = current.map(comment => ({
      ...comment,
      emphasized: !dialog.open && comment.id === activeCommentId,
    }));
    if (dialog.open && draftTarget && v?.translation?.isCurrentDependencies
      && draftTarget.documentNodeId === v.document.id
      && draftTarget.translationVersionId === v.translation.versionId) {
      ranges.push({ ...draftTarget, emphasized: true });
    }
    marks.render(ranges, v?.translation?.textLayout?.sentences ?? []);
    for (const card of el("#reviewCommentsList").querySelectorAll<HTMLElement>("[data-review-card]")) {
      const active = !dialog.open && card.dataset.reviewCard === activeCommentId;
      card.classList.toggle("is-active", active);
      card.querySelector("[data-review-locate]")?.setAttribute("aria-pressed", String(active));
    }
  }

  function render(): void {
    contextMenu.close();
    footnotes.refreshContext();
    renderSelection();
    const current = comments.filter(eligible);
    const prior = comments.filter(comment => !eligible(comment));
    el("#reviewCommentCount").textContent = String(current.length);
    for (const row of document.querySelectorAll<HTMLElement>("[data-review-sentence]")) {
      const sentence = deps.view()?.translation?.textLayout?.sentences.find(s => s.id === row.dataset.reviewSentence);
      const ranges = [...row.querySelectorAll<HTMLElement>("[data-review-source-from]")];
      const count = current.filter(comment => comment.targetKind === "translation"
        ? sentence && comment.codepointFrom < sentence.to && comment.codepointTo > sentence.from
        : ranges.some(range => comment.codepointFrom < Number(range.dataset.reviewSourceTo) && comment.codepointTo > Number(range.dataset.reviewSourceFrom))).length;
      const badge = row.querySelector<HTMLElement>("[data-review-row-count]");
      if (badge) badge.innerHTML = count ? `<button class="review-row-count" type="button">코멘트 ${count}</button>` : "";
    }
    const selectedCount = current.filter(comment => included.has(comment.id)).length;
    const button = el<HTMLButtonElement>("#btnRetranslateComments");
    button.disabled = !selectedCount || !selectionReady();
    button.textContent = selectedCount ? `코멘트 ${selectedCount}개로 재번역…` : "코멘트로 재번역…";
    const card = (comment: ReviewCommentView, old: boolean) => `<article class="review-comment" data-review-card="${esc(comment.id)}">
      <div class="review-comment-meta"><span>${comment.targetKind === "source" ? "원문" : "번역문"}</span>${old ? '<span class="tag tag-plain">이전 버전</span>' : `<label><input type="checkbox" data-review-include="${esc(comment.id)}"${included.has(comment.id) ? " checked" : ""}> 재번역에 포함</label>`}</div>
      <button class="review-quote" type="button" data-review-locate="${esc(comment.id)}"${old ? " disabled" : ""}>${esc(comment.quote)}</button>
      <p class="review-comment-body">${esc(comment.bodyMd)}</p>
      <div class="review-comment-actions"><button class="btn btn-sm" type="button" data-review-edit="${esc(comment.id)}">수정</button>${deps.reuseComment ? `<button class="btn btn-sm" type="button" data-review-reuse="${esc(comment.id)}">참고 자료로 재사용</button>` : ""}<button class="btn btn-sm" type="button" data-review-archive="${esc(comment.id)}">제외</button></div>
    </article>`;
    el("#reviewCommentsList").innerHTML = loading
      ? '<p class="muted">코멘트를 불러오는 중입니다.</p>'
      : `${current.length ? current.map(comment => card(comment, false)).join("") : '<p class="review-empty muted">아직 이 번역의 코멘트가 없습니다. ‘코멘트 달기’를 누른 뒤 문장별 대조에서 범위를 선택하세요.</p>'}${prior.length ? `<details class="review-prior"><summary>이전 버전의 코멘트 ${prior.length}개</summary><p class="muted">작성 당시의 번역에 연결된 기록입니다. 현재 재번역에는 포함되지 않습니다.</p>${prior.map(comment => card(comment, true)).join("")}</details>` : ""}`;
    renderMarks();
    deps.changed?.();
  }

  async function load(): Promise<void> {
    const v = deps.view();
    if (!v) return;
    const request = ++serial;
    const key = `${v.document.id}:${v.translation?.versionId}:${v.source.versionId}`;
    if (key !== versionKey) {
      versionKey = key;
      comments = [];
      included.clear();
      selected = null;
      selecting = false;
      pointerTarget = null;
      activeCommentId = null;
      if (dialog.open) dialog.close();
      draftTarget = null;
      editing = null;
    }
    loading = true;
    render();
    try {
      const result = await deps.api.editor.listReviewComments(v.document.id);
      if (request !== serial) return;
      if (!result.ok) throw new Error(result.error.message);
      const known = new Set(comments.map(comment => comment.id));
      comments = result.data;
      for (const comment of comments) if (!known.has(comment.id) && eligible(comment)) included.add(comment.id);
    } catch (error) {
      if (request === serial) deps.notify(error instanceof Error ? error.message : "코멘트를 불러오지 못했습니다.", "검토 코멘트");
    } finally {
      if (request === serial) {
        loading = false;
        render();
      }
    }
  }

  function captureSelection(target: Node): void {
    if (!selecting || !selectionReady() || dialog.open) return;
    const v = deps.view()!;
    const translation = v.translation!;
    if (!el("#rows").contains(target)) return;
    const textarea = target instanceof HTMLTextAreaElement ? target : null;
    if (textarea?.matches(".sentence-edit")) {
      const sentence = translation.textLayout!.sentences.find(s => s.id === textarea.dataset.sentenceEdit);
      const from = textarea.selectionStart;
      const to = textarea.selectionEnd;
      const range = sentence ? textareaRange(sentence.text, from, to) : null;
      selected = sentence && range && textarea.value === sentence.text.replace(/\r\n?/g, "\n") ? {
        documentNodeId: v.document.id,
        translationVersionId: translation.versionId,
        targetKind: "translation",
        targetVersionId: translation.versionId,
        codepointFrom: sentence.from + range.from,
        codepointTo: sentence.from + range.to,
        quote: range.quote,
      } : null;
    } else {
      selected = null;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
        const source = start?.closest<HTMLElement>("[data-review-source-from]");
        if (source && source.contains(range.endContainer)) {
          const before = document.createRange();
          before.selectNodeContents(source);
          before.setEnd(range.startContainer, range.startOffset);
          const display = sourceDisplayFromElement(source);
          const localFrom = Array.from(before.toString()).length;
          const mapped = display ? sourceRangeFromDisplay(display, localFrom, localFrom + Array.from(range.toString()).length) : null;
          if (mapped) selected = {
            documentNodeId: v.document.id,
            translationVersionId: translation.versionId,
            targetKind: "source",
            targetVersionId: v.source.versionId,
            codepointFrom: mapped.from,
            codepointTo: mapped.to,
            quote: mapped.quote,
          };
          else if (range.toString().trim() && source.dataset.reviewSourceMap) el("#reviewSelectionHint").textContent = "표점 부호만 선택한 경우에는 앞뒤 원문 글자도 함께 선택하세요.";
        }
      }
    }
    if (selected) openComment();
  }

  function openComment(comment?: ReviewCommentView): void {
    if (!comment && (!selected || !selectionReady())) return;
    editing = comment ?? null;
    draftTarget = comment ?? selected;
    activeCommentId = null;
    cancelSelection();
    clearNativeSelection();
    el("#reviewCommentHeading").textContent = comment ? "코멘트 수정" : "코멘트 달기";
    el("#reviewCommentQuote").textContent = draftTarget!.quote;
    el<HTMLTextAreaElement>("#reviewCommentBody").value = comment?.bodyMd ?? "";
    el("#reviewCommentError").textContent = "";
    dialog.showModal();
    renderMarks();
    el<HTMLTextAreaElement>("#reviewCommentBody").focus();
  }

  async function save(): Promise<void> {
    const bodyMd = el<HTMLTextAreaElement>("#reviewCommentBody").value.trim();
    if (!bodyMd || !draftTarget || saving) return;
    saving = true;
    el<HTMLButtonElement>("#reviewCommentSave").disabled = true;
    el<HTMLButtonElement>("#reviewCommentCancel").disabled = true;
    el<HTMLButtonElement>("#btnReviewFootnotes").disabled = true;
    el<HTMLButtonElement>("#btnReviewDictionary").disabled = true;
    try {
      const result = editing
        ? await deps.api.editor.updateReviewComment({ id: editing.id, expectedLockVersion: editing.lockVersion, bodyMd })
        : await deps.api.editor.createReviewComment({ ...draftTarget, bodyMd });
      if (!result.ok) throw new Error(result.error.message);
      dialog.close();
      selected = null;
      deps.showComments();
      await load();
    } catch (error) {
      el("#reviewCommentError").textContent = error instanceof Error ? error.message : "코멘트를 저장하지 못했습니다.";
    } finally {
      saving = false;
      el<HTMLButtonElement>("#reviewCommentSave").disabled = false;
      el<HTMLButtonElement>("#reviewCommentCancel").disabled = false;
      el<HTMLButtonElement>("#btnReviewFootnotes").disabled = false;
      el<HTMLButtonElement>("#btnReviewDictionary").disabled = false;
      renderSelection();
      render();
    }
  }

  async function archive(comment: ReviewCommentView): Promise<void> {
    if (saving) return;
    saving = true;
    try {
      const result = await deps.api.editor.archiveReviewComment({ id: comment.id, expectedLockVersion: comment.lockVersion });
      if (!result.ok) throw new Error(result.error.message);
      await load();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : "코멘트를 제외하지 못했습니다.", "검토 코멘트");
    } finally {
      saving = false;
      render();
    }
  }

  function locate(comment: ReviewCommentView): void {
    if (!eligible(comment)) return;
    cancelSelection();
    deps.showComments();
    clearNativeSelection();
    let target: HTMLElement | undefined;
    if (comment.targetKind === "translation") {
      const sentence = deps.view()?.translation?.textLayout?.sentences.find(s => s.from <= comment.codepointFrom && s.to >= comment.codepointTo);
      const textarea = [...document.querySelectorAll<HTMLTextAreaElement>(".sentence-edit")].find(e => e.dataset.sentenceEdit === sentence?.id);
      if (textarea && sentence) {
        if (textarea.value !== sentence.text.replace(/\r\n?/g, "\n")) {
          deps.notify("번역문이 수정되어 구절의 위치를 표시할 수 없습니다. 저장 후 다시 확인하세요.", "검토 코멘트");
          return;
        }
        target = textarea;
      }
    } else {
      target = [...document.querySelectorAll<HTMLElement>("#rows [data-review-source-from]")].find(e => {
        const from = Number(e.dataset.reviewSourceFrom);
        return from <= comment.codepointFrom && Number(e.dataset.reviewSourceTo) >= comment.codepointTo;
      });
      if (!target) {
        deps.showComments("full");
        target = el("#folioSourceText");
      }
    }
    if (!target) return;
    activeCommentId = comment.id;
    renderMarks();
    (target.querySelector<HTMLElement>(".review-range-mark.is-emphasized") ?? target).scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  el("#rows").addEventListener("pointerdown", event => {
    if (!selecting || event.button !== 0) return;
    pointerTarget = (event.target as HTMLElement).closest<HTMLElement>("[data-review-source-from], .sentence-edit");
  });
  document.addEventListener("pointerup", () => {
    const target = pointerTarget;
    pointerTarget = null;
    if (target) captureSelection(target);
  });
  document.addEventListener("pointercancel", () => { pointerTarget = null; });
  el("#rows").addEventListener("keyup", event => {
    // Wait until keyboard range selection finishes, not after each Shift+arrow.
    if ((event.key === "Shift" || event.key === "Enter") && event.target instanceof Node) captureSelection(event.target);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !selecting) return;
    event.preventDefault();
    event.stopPropagation();
    cancelSelection();
  }, true);
  el("#rows").addEventListener("input", () => { cancelSelection(); render(); });
  el("#rows").addEventListener("click", event => {
    if ((event.target as HTMLElement).closest(".review-row-count")) deps.showComments();
  });
  el("#btnAddReviewComment").addEventListener("click", () => {
    if (selecting) { cancelSelection(); return; }
    if (!selectionReady()) return;
    deps.showComments();
    selected = null;
    pointerTarget = null;
    activeCommentId = null;
    clearNativeSelection();
    selecting = true;
    renderSelection();
    renderMarks();
  });
  el("#reviewCommentForm").addEventListener("submit", event => { event.preventDefault(); void save(); });
  for (const id of ["#btnSearchFootnotes", "#btnSearchFootnotesContext"]) {
    el(id).addEventListener("click", () => { cancelSelection(); footnotes.open(); });
  }
  el("#btnReviewFootnotes").addEventListener("click", () => {
    const target = draftTarget;
    if (!target || saving || !dialog.open) return;
    const currentTarget = () => {
      const v = deps.view();
      return !!v && target.documentNodeId === v.document.id && target.translationVersionId === v.translation?.versionId
        && target.targetVersionId === (target.targetKind === "source" ? v.source.versionId : v.translation?.versionId)
        && draftTarget === target && dialog.open && !saving;
    };
    footnotes.open({
      query: target.quote,
      quote: target.quote,
      selection: { targetKind: target.targetKind, from: target.codepointFrom, to: target.codepointTo, quote: target.quote },
      isCurrent: currentTarget,
      insertAnalysis: recommendation => {
        if (!currentTarget() || (deps.hasUnsavedTextChanges ?? deps.hasUnsavedChanges)()) throw new Error("문서나 작성 중인 코멘트가 바뀌었습니다. 현재 구절에서 다시 추천받으세요.");
        const body = el<HTMLTextAreaElement>("#reviewCommentBody");
        body.value = appendFootnoteRecommendation(body.value, recommendation, body.maxLength);
        body.dispatchEvent(new Event("input", { bubbles: true }));
        queueMicrotask(() => { body.focus(); body.setSelectionRange(body.value.length, body.value.length); });
      },
      insert: note => {
        if (!dialog.open || saving || draftTarget !== target) throw new Error("작성 중인 코멘트가 바뀌었습니다. 구절을 다시 확인해 주세요.");
        const body = el<HTMLTextAreaElement>("#reviewCommentBody");
        body.value = appendFootnoteCitation(body.value, note, body.maxLength);
        body.dispatchEvent(new Event("input", { bubbles: true }));
        queueMicrotask(() => { body.focus(); body.setSelectionRange(body.value.length, body.value.length); });
      },
    });
  });
  el("#btnReviewDictionary").addEventListener("click", () => {
    const target = draftTarget;
    if (!target || saving || !dialog.open) return;
    const current = () => {
      const v = deps.view();
      return !!v && v.document.id === target.documentNodeId && v.translation?.versionId === target.translationVersionId
        && target.targetVersionId === (target.targetKind === "source" ? v.source.versionId : v.translation?.versionId)
        && draftTarget === target && dialog.open && !saving;
    };
    deps.openDictionary?.({ query: target.quote, quote: target.quote, isCurrent: current,
      insert: citation => {
        if (!current()) throw new Error("작성 중인 코멘트가 바뀌었습니다. 구절을 다시 확인해 주세요.");
        const body = el<HTMLTextAreaElement>("#reviewCommentBody");
        body.value = appendDictionaryCitation(body.value, citation, body.maxLength);
        body.dispatchEvent(new Event("input", { bubbles: true }));
        queueMicrotask(() => { body.focus(); body.setSelectionRange(body.value.length, body.value.length); });
      },
    });
  });
  el("#reviewCommentCancel").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    // A queued close event from the previous comment must not clear a newly opened draft.
    if (dialog.open) return;
    footnotes.closeAttached();
    draftTarget = null;
    editing = null;
    renderSelection();
    renderMarks();
  });
  el("#btnShowReviewComments").addEventListener("click", () => deps.showComments());
  el("#btnCompareTranslation").addEventListener("click", () => { void deps.compare().catch(error => deps.notify(String(error), "번역 비교")); });
  el("#btnRetranslateComments").addEventListener("click", () => {
    const v = deps.view();
    const commentIds = comments.filter(comment => eligible(comment) && included.has(comment.id)).map(comment => comment.id);
    if (v?.translation && commentIds.length && selectionReady()) deps.retranslate({ baseVersionId: v.translation.versionId, commentIds });
  });
  el("#reviewCommentsList").addEventListener("change", event => {
    const input = event.target as HTMLInputElement;
    const id = input.dataset.reviewInclude;
    if (!id) return;
    if (input.checked) included.add(id); else included.delete(id);
    render();
  });
  el("#reviewCommentsList").addEventListener("click", event => {
    const target = event.target as HTMLElement;
    if (target.closest("input, label, summary")) return;
    const button = target.closest<HTMLButtonElement>("button");
    const id = button?.dataset.reviewEdit ?? button?.dataset.reviewArchive ?? button?.dataset.reviewReuse ?? button?.dataset.reviewLocate
      ?? target.closest<HTMLElement>("[data-review-card]")?.dataset.reviewCard;
    const comment = comments.find(comment => comment.id === id);
    if (!comment) return;
    if (button?.dataset.reviewEdit) openComment(comment);
    else if (button?.dataset.reviewReuse) deps.reuseComment?.(comment);
    else if (button?.dataset.reviewArchive) void archive(comment);
    else locate(comment);
  });

  return {
    load,
    refresh: render,
    cancelSelection,
    isSelecting: () => selecting,
    current: () => comments.filter(eligible),
    locateById: (id: string) => { const comment = comments.find(item => item.id === id); if (comment) locate(comment); },
    hasUnsavedDraft: () => dialog.open && el<HTMLTextAreaElement>("#reviewCommentBody").value !== (editing?.bodyMd ?? ""),
  };
}
