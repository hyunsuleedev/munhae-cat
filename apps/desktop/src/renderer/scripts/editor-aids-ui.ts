import type { EditorView, StructureSpanInput } from "../../shared/munhae-api";
import type { TextSentence } from "@munhae/domain/text-sentences";
import { EditHistory, EditorLocalStore, findReviewPlace, type ReadingPosition, type RecoveryRecord, type ReviewPlace } from "./editor-session";
import { configureWhitespace } from "./editor-whitespace";
import { t } from "./i18n";

export type TranslationDraft = {
  text: string; sentences: TextSentence[];
  links: NonNullable<NonNullable<EditorView["translation"]>["textLayout"]>["links"];
  blocks: { key: string; anchors: string[]; relationKinds: string[]; text: string; kind: string }[];
  structureDirty: boolean;
};
export type EditorRecovery = {
  translation: TranslationDraft; translationDirty: boolean;
  source: string; sourceDirty: boolean; sourceEditingConfirmed: boolean;
  punctuation: string; punctuationDirty: boolean; punctuationMode: string;
  structures?: StructureSpanInput[]; position: ReadingPosition;
};
type Context = {
  scope: string; base: string; sourceVersion: string; translationVersion: string | null;
  editable: boolean; busy: boolean; dirty: boolean; sentences: TextSentence[];
};
type Deps = {
  root: HTMLElement; escape(text: unknown): string; notify(message: string, title?: string): void;
  bookmarkRoot?: HTMLElement;
  context(): Context | null; capture(): TranslationDraft; restore(value: TranslationDraft): void;
  recovery(): EditorRecovery; restoreRecovery(value: EditorRecovery): void;
  position(): ReadingPosition; restorePosition(value: ReadingPosition): void;
  changed(): void; locate(id: string): void;
};
const validRecovery = (value: unknown): value is EditorRecovery => {
  const d = value as EditorRecovery | null;
  return !!d && typeof d.source === "string" && typeof d.punctuation === "string" && typeof d.translation?.text === "string"
    && Array.isArray(d.translation.sentences) && d.translation.sentences.every(s => typeof s.id === "string" && typeof s.text === "string" && Number.isInteger(s.from) && Number.isInteger(s.to))
    && Array.isArray(d.translation.links) && d.translation.links.every(l => typeof l.sentenceId === "string" && Array.isArray(l.spans) && l.spans.every(s => typeof s.quote === "string" && Number.isInteger(s.from) && Number.isInteger(s.to)))
    && Array.isArray(d.translation.blocks) && d.translation.blocks.every(b => typeof b.key === "string" && typeof b.text === "string" && Array.isArray(b.anchors) && Array.isArray(b.relationKinds))
    && [d.sourceDirty, d.punctuationDirty, d.translationDirty, d.sourceEditingConfirmed].every(v => typeof v === "boolean")
    && ["prose", "poetry"].includes(d.punctuationMode)
    && (!d.structures || Array.isArray(d.structures) && d.structures.every(s => s && Number.isInteger(s.codepointFrom) && Number.isInteger(s.codepointTo)))
    && !!d.position && ["source", "punctuation", "translation"].includes(d.position.workspace)
    && ["source", "parallel", "full", "reading"].includes(d.position.layout) && Number.isFinite(d.position.scrollTop);
};

export function configureEditorAids(deps: Deps) {
  const el = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
  const history = new EditHistory<TranslationDraft>();
  const whitespace = configureWhitespace(deps.root, text => deps.escape(text));
  const writer = crypto.randomUUID();
  let local: EditorLocalStore | null = null, scope = "", base = "", ready = false, applying = false;
  let timer: number | undefined, positionTimer: number | undefined, lastStored = "", storageFailed = false;
  let places: ReviewPlace[] = [], recoveries: RecoveryRecord<EditorRecovery>[] = [], recoveryIndex = 0;
  let consumedWriter: string | null = null;
  let pendingPosition: { scope: string; value: ReadingPosition } | null = null;
  function storageError() {
    if (!storageFailed) deps.notify(t("이 기기에 임시저장하지 못했습니다. 작업을 정식 저장하거나 복구문을 내려받으세요."), t("임시저장"));
    storageFailed = true;
    el("#editor-local-error").hidden = false;
  }
  function guarded(action: () => void) { try { action(); } catch { storageError(); } }
  function buttons() {
    const c = deps.context();
    el<HTMLButtonElement>("#btnEditorUndo").disabled = !c?.editable || c.busy || !history.canUndo;
    el<HTMLButtonElement>("#btnEditorRedo").disabled = !c?.editable || c.busy || !history.canRedo;
    el<HTMLButtonElement>("#btnRestoreEditorDraft").disabled = !c || c.busy || c.dirty || recoveries[recoveryIndex]?.base !== c.base;
    whitespace.refresh();
  }
  function persist() {
    window.clearTimeout(timer); timer = undefined;
    const c = deps.context();
    if (!ready || applying || !local || !c || c.scope !== scope || c.base !== base) return;
    guarded(() => {
      const draft = deps.recovery();
      if (draft.sourceDirty || draft.punctuationDirty || draft.translationDirty) {
        const serialized = JSON.stringify(draft);
        if (serialized !== lastStored) { local!.recover(base, draft); lastStored = serialized; }
      } else { local!.clearRecovery(); lastStored = ""; }
      if (consumedWriter) { local!.clearRecovery(consumedWriter); consumedWriter = null; }
      storageFailed = false; el("#editor-local-error").hidden = true;
    });
  }
  function checkpoint() { if (ready && !applying) { window.clearTimeout(timer); timer = window.setTimeout(persist, 250); } buttons(); }
  function savePosition() {
    window.clearTimeout(positionTimer); positionTimer = undefined;
    if (ready && !pendingPosition && local && deps.context()?.scope === scope) guarded(() => local!.write("position", deps.position()));
  }
  function rememberPosition() { window.clearTimeout(positionTimer); positionTimer = window.setTimeout(savePosition, 180); }
  function showRecovery() {
    const record = recoveries[recoveryIndex], c = deps.context();
    el("#editorRecovery").hidden = !record;
    if (!record) return;
    const compatible = record.base === c?.base;
    el("#editorRecoveryMessage").textContent = compatible ? t("저장하지 못한 편집이 이 기기에 남아 있습니다.") : t("다른 버전의 임시저장본입니다. 복구문을 내려받아 현재 문서와 비교하세요.");
    const select = el<HTMLSelectElement>("#editorRecoveryList");
    select.innerHTML = recoveries.map((r, i) => `<option value="${i}">${deps.escape(new Date(r.at).toLocaleString())}</option>`).join("");
    select.value = String(recoveryIndex); select.hidden = recoveries.length < 2;
    buttons();
  }
  function exportText(draft: EditorRecovery) {
    const sections = [draft.sourceDirty ? `${t("원문")}\n${draft.source}` : "", draft.punctuationDirty ? `${t("표점 원문")}\n${draft.punctuation}` : "", draft.translationDirty ? `${t("번역")}\n${draft.translation.text || draft.translation.blocks.map(b => b.text).join("\n")}` : ""].filter(Boolean);
    const url = URL.createObjectURL(new Blob([sections.join("\n\n────────\n\n")], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `munhae-recovery-${Date.now()}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  el("#btnDownloadEditorDraft").addEventListener("click", () => { const r = recoveries[recoveryIndex]; if (r) exportText(r.draft); });
  el("#btnDownloadCurrentDraft").addEventListener("click", () => exportText(deps.recovery()));
  el("#editorRecoveryList").addEventListener("change", () => { recoveryIndex = Number(el<HTMLSelectElement>("#editorRecoveryList").value); showRecovery(); });
  el("#btnDiscardEditorDraft").addEventListener("click", () => {
    const record = recoveries[recoveryIndex]; if (!record || !local) return;
    guarded(() => { local!.clearRecovery(record.writer); recoveries.splice(recoveryIndex, 1); recoveryIndex = 0; showRecovery(); });
  });
  el("#btnRestoreEditorDraft").addEventListener("click", () => {
    const record = recoveries[recoveryIndex], c = deps.context();
    if (!record || !c || c.busy || c.dirty || record.base !== c.base) return;
    applying = true;
    try { deps.restoreRecovery(structuredClone(record.draft)); history.record(deps.capture()); history.breakGroup(); consumedWriter = record.writer === writer ? null : record.writer; }
    finally { applying = false; }
    recoveries.splice(recoveryIndex, 1); recoveryIndex = 0; persist(); showRecovery(); buttons();
    deps.notify(t("임시저장본을 편집 중인 내용으로 복구했습니다. 확인 후 저장하세요."), t("편집 복구"));
  });
  function step(direction: -1 | 1) {
    const c = deps.context(); if (!c?.editable || c.busy || applying) return;
    const snapshot = direction < 0 ? history.undo() : history.redo(); if (!snapshot) return;
    applying = true;
    try { deps.restore(snapshot); } finally { applying = false; }
    el("#editorAidStatus").textContent = direction < 0 ? t("편집을 되돌렸습니다.") : t("편집을 다시 실행했습니다.");
    checkpoint();
  }
  el("#btnEditorUndo").addEventListener("click", () => step(-1));
  el("#btnEditorRedo").addEventListener("click", () => step(1));
  for (const id of ["#btnEditorUndo", "#btnEditorRedo"]) el(id).addEventListener("pointerdown", e => e.preventDefault());
  deps.root.addEventListener("beforeinput", event => {
    if (!(event instanceof InputEvent) || !["historyUndo", "historyRedo"].includes(event.inputType) || !(event.target instanceof Element) || !event.target.matches(".sentence-edit,.tgt-edit,#fullTranslationInput")) return;
    event.preventDefault(); step(event.inputType === "historyUndo" ? -1 : 1);
  });
  deps.root.addEventListener("focusout", () => history.breakGroup());
  deps.root.addEventListener("compositionend", () => history.breakGroup());
  function resolve(place: ReviewPlace): string | null {
    const c = deps.context(); if (!c) return null;
    if (place.translationVersion === c.translationVersion && c.sentences.some(s => s.id === place.sentenceId)) return place.sentenceId;
    if (place.sourceVersion !== c.sourceVersion) return null;
    return findReviewPlace(place, c.sentences);
  }
  function isBookmarked(id: string): boolean { return places.some(p => resolve(p) === id); }
  function bookmarkMarkup(id: string, number?: number): string {
    const marked = isBookmarked(id), label = (number === undefined ? "" : `${number}. `) + (marked ? t("다시 볼 곳 표시 해제") : t("다시 볼 곳 표시"));
    return `<button class="btn btn-ghost btn-sm editor-bookmark${marked ? " is-marked" : ""}" type="button" data-editor-bookmark="${deps.escape(id)}" aria-pressed="${marked}" title="${label}" aria-label="${label}"><svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h8v11l-4-2.8-4 2.8z"/></svg></button>`;
  }
  (deps.bookmarkRoot ?? deps.root).addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-editor-bookmark]");
    const c = deps.context(); if (!button || !c || !local) return;
    const id = button.dataset.editorBookmark!, sentence = c.sentences.find(s => s.id === id); if (!sentence) return;
    const next = isBookmarked(id) ? places.filter(p => resolve(p) !== id) : [...places, { id: crypto.randomUUID(), sourceVersion: c.sourceVersion, translationVersion: c.translationVersion!, sentenceId: id, from: sentence.from, quote: sentence.text, sourceSpans: deps.capture().links.find(l => l.sentenceId === id)?.spans ?? [] }];
    guarded(() => { local!.write("bookmarks", next); places = next; deps.changed(); });
  });
  el("#btnEditorBookmarks").addEventListener("click", () => {
    const dialog = el<HTMLDialogElement>("#dlgEditorBookmarks"), list = el("#editorBookmarksList");
    list.innerHTML = places.length ? places.map(p => `<li><button class="editor-bookmark-quote" data-locate-bookmark="${deps.escape(p.id)}"${resolve(p) ? "" : " disabled"}>${deps.escape(p.quote)}</button>${resolve(p) ? "" : `<small>${t("이전 번역의 표시 · 위치를 다시 확인하세요.")}</small>`}<button class="btn btn-ghost btn-sm" data-remove-bookmark="${deps.escape(p.id)}">${t("표시 해제")}</button></li>`).join("") : `<li class="muted">${t("문장의 ⋯ 메뉴에서 다시 볼 곳을 표시하세요.")}</li>`;
    dialog.showModal();
  });
  el("#editorBookmarksList").addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    const place = places.find(p => p.id === (button?.dataset.locateBookmark ?? button?.dataset.removeBookmark));
    if (!place || !button) return;
    if (button.dataset.locateBookmark) { const id = resolve(place); if (id) { el<HTMLDialogElement>("#dlgEditorBookmarks").close(); deps.locate(id); } }
    else guarded(() => { const next = places.filter(p => p.id !== place.id); local!.write("bookmarks", next); places = next; button.closest("li")?.remove(); deps.changed(); });
  });
  el<HTMLInputElement>("#chkWhitespace").addEventListener("change", () => {
    const enabled = el<HTMLInputElement>("#chkWhitespace").checked; whitespace.set(enabled);
    guarded(() => local?.write("whitespace", enabled));
  });
  // The auth gate keeps the editor at display:none until its module finishes booting.
  // Restore scroll only once the real pane has geometry, and retain the saved position until then.
  function finishView() {
    const pending = pendingPosition;
    if (!pending || !deps.root.getClientRects().length) return;
    pendingPosition = null;
    if (deps.context()?.scope === pending.scope) deps.restorePosition(pending.value);
  }
  new ResizeObserver(finishView).observe(deps.root);
  new MutationObserver(finishView).observe(document.body, { attributes: true, attributeFilter: ["data-auth-pending"] });
  const scroller = deps.root.closest(".pane-scroll")!;
  scroller.addEventListener("scroll", rememberPosition, { passive: true });
  deps.root.addEventListener("focusin", rememberPosition); deps.root.addEventListener("click", rememberPosition);
  deps.root.addEventListener("input", checkpoint);
  deps.root.addEventListener("change", checkpoint);
  deps.root.addEventListener("click", checkpoint);
  window.addEventListener("pagehide", () => { persist(); savePosition(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { persist(); savePosition(); } });
  return {
    bookmarkMarkup, isBookmarked, checkpoint, rememberPosition, flush: () => { persist(); savePosition(); },
    record(group = "") { if (!ready || applying) return; history.record(deps.capture(), group); checkpoint(); },
    key(event: KeyboardEvent): boolean {
      const target = event.target instanceof Element ? event.target : null;
      if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || document.querySelector("dialog[open]")) return false;
      if (target?.closest("input,textarea,[contenteditable=true]") && !target.matches(".sentence-edit,.tgt-edit,#fullTranslationInput")) return false;
      if (event.code !== "KeyZ" && !(event.ctrlKey && event.code === "KeyY")) return false;
      event.preventDefault(); step(event.shiftKey || event.code === "KeyY" ? 1 : -1); return true;
    },
    beforeView() {
      persist(); savePosition();
      if (ready && local) guarded(() => {
        const c = deps.context();
        places = places.map(place => {
          const id = resolve(place), sentence = c?.sentences.find(s => s.id === id);
          return sentence && c ? { ...place, sentenceId: sentence.id, from: sentence.from, quote: sentence.text, translationVersion: c.translationVersion ?? place.translationVersion } : place;
        });
        local!.write("bookmarks", places);
      });
      ready = false;
    },
    finishView,
    /** An explicit destination, such as a term opened from the glossary, replaces the saved reading position. */
    dropPendingPosition() { pendingPosition = null; },
    loaded(options: { saved?: boolean; preserveHistory?: boolean } = {}) {
      const c = deps.context(); if (!c) return;
      const changedScope = scope !== c.scope;
      if (options.saved) guarded(() => { local?.clearRecovery(); if (consumedWriter) local?.clearRecovery(consumedWriter); consumedWriter = null; });
      scope = c.scope; base = c.base; lastStored = "";
      if (changedScope) { local = null; places = []; recoveries = []; pendingPosition = null; consumedWriter = null; }
      guarded(() => {
        local = new EditorLocalStore(localStorage, scope, writer);
        const stored = local.read<ReviewPlace[]>("bookmarks");
        places = Array.isArray(stored) ? stored.filter(p => p && typeof p.id === "string" && typeof p.quote === "string" && typeof p.sentenceId === "string") : [];
        const enabled = local.read<boolean>("whitespace") === true; el<HTMLInputElement>("#chkWhitespace").checked = enabled; whitespace.set(enabled);
        if (changedScope) { recoveries = local.recoveries(validRecovery); recoveryIndex = 0; }
      });
      if (options.preserveHistory && !changedScope) history.replaceCurrent(deps.capture()); else history.reset(deps.capture());
      ready = true; showRecovery(); buttons();
      if (changedScope) guarded(() => {
        const restoredScope = scope;
        const position = local?.read<ReadingPosition>("position");
        if (position && ["source", "punctuation", "translation"].includes(position.workspace) && ["source", "parallel", "full", "reading"].includes(position.layout) && Number.isFinite(position.scrollTop)) pendingPosition = { scope: restoredScope, value: position };
      });
    },
  };
}
