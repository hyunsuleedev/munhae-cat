import "../styles/translation-notes.css";
import type { EditorView, MunhaeApi, TranslationNote } from "../../shared/munhae-api";
import { t } from "./i18n";
import { esc } from "./shared";

const KIND: Record<TranslationNote["kind"], string> = { textual: "교감", allusion: "전고", identification: "비정", interpretive: "해석" };
// A certain note needs no label; only doubt is worth the reader's attention.
const CONFIDENCE: Record<TranslationNote["confidence"], string> = { certain: "", probable: "유력", unknown: "미상" };

function noteText(note: TranslationNote): string {
  const meta = [KIND[note.kind], CONFIDENCE[note.confidence], note.from === null ? "위치 확인 필요" : ""]
    .filter(Boolean).map(label => esc(t(label))).join(" · ");
  const alternatives = note.alternatives.length
    ? `<span class="translation-note-alt">${esc(t("대안"))} ${note.alternatives.map(esc).join(" / ")}</span>` : "";
  return `<span class="translation-note-num">${note.ordinal}</span><p><span class="translation-note-meta">${meta}</span>${esc(note.bodyMd)}${alternatives}</p>`;
}

function noteMarkup(note: TranslationNote, editable: boolean): string {
  const action = (attribute: string, label: string) =>
    `<button type="button" ${attribute}="${esc(note.id)}" aria-label="${esc(`${t("각주")} ${note.ordinal} ${t(label)}`)}">${esc(t(label))}</button>`;
  const actions = editable ? `<span class="translation-note-actions">${action("data-note-edit", "수정")}${action("data-note-remove", "삭제")}</span>` : "";
  return `<li class="translation-note" data-note="${note.ordinal}">${noteText(note)}${actions}</li>`;
}

/** Placed notes whose quote ends inside one of these saved sentence ranges. */
export function notesInSentences(notes: readonly TranslationNote[], sentences: ReadonlyArray<{ from: number; to: number }>): TranslationNote[] {
  return notes.filter(note => note.to !== null && sentences.some(sentence => note.to! > sentence.from && note.to! <= sentence.to));
}

export function notesListMarkup(notes: readonly TranslationNote[], editable = false): string {
  return notes.length ? `<ol class="translation-notes" aria-label="${esc(t("각주"))}">${notes.map(note => noteMarkup(note, editable)).join("")}</ol>` : "";
}

/** Several alternative readings share one field, written the way the list shows them. */
export function parseAlternatives(value: string): string[] {
  return value.split(" / ").map(item => item.trim()).filter(Boolean).slice(0, 3);
}

type NoteRefRoots = {
  /** Book text, where markers are real (empty) elements. */
  book: HTMLElement;
  /** The book's list at the end of the translation. */
  bookNotes: HTMLElement;
  /** Sentence comparison, whose reading text carries the same markers. */
  rows: HTMLElement;
  notes(): readonly TranslationNote[];
};

/** Hovering a footnote number shows the note; choosing it moves to the note, and a book note's number leads back. */
export function configureNoteRefs(roots: NoteRefRoots): void {
  const popover = document.createElement("div");
  popover.className = "translation-note-popover";
  popover.setAttribute("role", "tooltip");
  popover.hidden = true;
  document.body.append(popover);
  let shown: string | null = null;

  function show(number: string, anchor: DOMRect): void {
    const note = roots.notes().find(item => String(item.ordinal) === number);
    if (!note) { hide(); return; }
    if (shown !== number) popover.innerHTML = `<div class="translation-note">${noteText(note)}</div>`;
    shown = number;
    popover.hidden = false;
    const below = anchor.bottom + 6;
    popover.style.left = `${Math.max(8, Math.min(anchor.left - 12, innerWidth - popover.offsetWidth - 8))}px`;
    popover.style.top = `${below + popover.offsetHeight > innerHeight - 8 ? anchor.top - popover.offsetHeight - 6 : below}px`;
  }
  function hide(): void {
    popover.hidden = true;
    shown = null;
  }
  /** Mark the destination, and let the mark fade only once the reader has arrived there. */
  function jump(target: Element | null | undefined, block: ScrollLogicalPosition): void {
    if (!target) return;
    hide();
    target.classList.add("is-target");
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      removeEventListener("scrollend", settle, true);
      setTimeout(() => target.classList.remove("is-target"), 1200);
    };
    let pane = target.parentElement;
    while (pane && !(/(auto|scroll)/.test(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight)) pane = pane.parentElement;
    const box = target.getBoundingClientRect(), view = pane?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
    if (box.top >= view.top && box.bottom <= view.bottom) { settle(); return; }
    addEventListener("scrollend", settle, true);
    setTimeout(settle, 3000);
    target.scrollIntoView({ block, behavior: "smooth" });
  }
  // Only markers in reading text; one drawn behind an editing field is not a target.
  const refOf = (event: Event) => (event.target as Element).closest?.<HTMLElement>("[data-review-translation-from] .translation-note-ref") ?? null;
  /** A book number leads to the list at the end; a comparison number to the list under its own row. */
  const noteFor = (ref: HTMLElement) => roots.book.contains(ref)
    ? roots.bookNotes.querySelector(`.translation-note[data-note="${ref.dataset.note}"]`)
    : ref.closest(".brow")?.querySelector(`.translation-note[data-note="${ref.dataset.note}"]`);

  for (const root of [roots.book, roots.rows]) {
    root.addEventListener("mouseover", event => {
      const ref = refOf(event);
      if (ref) show(ref.dataset.note!, ref.getBoundingClientRect());
    });
    root.addEventListener("mouseout", event => { if (refOf(event)) hide(); });
    // Captured so that choosing a number neither focuses nor selects the text around it.
    root.addEventListener("mousedown", event => { if (refOf(event)) event.preventDefault(); }, true);
    root.addEventListener("click", event => {
      const ref = refOf(event);
      if (!ref) return;
      event.stopPropagation();
      jump(noteFor(ref), roots.book.contains(ref) ? "center" : "nearest");
    }, true);
  }
  roots.bookNotes.addEventListener("click", event => {
    const item = (event.target as Element).closest?.(".translation-note-num")?.closest<HTMLElement>("[data-note]");
    if (item) jump(roots.book.querySelector(`.translation-note-ref[data-note="${item.dataset.note}"]`), "center");
  });
  addEventListener("scroll", hide, true);
}

type NoteEditing = {
  api: MunhaeApi;
  view(): EditorView | null;
  /** Checked again on every action: the draft, its saved text and the project may have changed. */
  canEdit(): boolean;
  applied(notes: TranslationNote[]): void;
  notify(message: string, title?: string): void;
};

/** A person adds a note to a selected phrase of the current draft, or rewrites or removes one from a list. */
export function configureNoteEditing(deps: NoteEditing) {
  const dialog = document.querySelector<HTMLDialogElement>("#dlgTranslationNote")!;
  const field = <T extends HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const error = field<HTMLElement>("translationNoteError");
  type Selection = { codepointFrom: number; codepointTo: number; quote: string };
  /** What the open dialog saves to: a new note on a phrase, or an existing note. */
  let target: { documentNodeId: string; versionId: string } & ({ selection: Selection } | { noteId: string }) | null = null;
  let busy = false;

  function show(heading: string, quote: string, note?: TranslationNote): void {
    field<HTMLElement>("translationNoteHeading").textContent = t(heading);
    field<HTMLElement>("translationNoteQuote").textContent = quote;
    field<HTMLSelectElement>("translationNoteKind").value = note?.kind ?? "allusion";
    field<HTMLSelectElement>("translationNoteConfidence").value = note?.confidence ?? "certain";
    field<HTMLTextAreaElement>("translationNoteBody").value = note?.bodyMd ?? "";
    field<HTMLInputElement>("translationNoteAlternative").value = note?.alternatives.join(" / ") ?? "";
    error.textContent = "";
    dialog.showModal();
    field<HTMLTextAreaElement>("translationNoteBody").focus();
  }

  function open(selection: Selection): void {
    const view = deps.view();
    if (!view?.translation || !deps.canEdit()) return;
    target = { documentNodeId: view.document.id, versionId: view.translation.versionId, selection };
    show("각주 달기", selection.quote);
  }

  function openEdit(noteId: string): void {
    const view = deps.view(), note = view?.translation?.notes?.find(item => item.id === noteId);
    if (!view?.translation || !note) return;
    if (!deps.canEdit()) { deps.notify(t("편집한 번역을 저장한 뒤 각주를 고칠 수 있습니다."), t("각주")); return; }
    target = { documentNodeId: view.document.id, versionId: view.translation.versionId, noteId };
    show("각주 수정", note.targetQuote, note);
  }

  async function save(): Promise<void> {
    const bodyMd = field<HTMLTextAreaElement>("translationNoteBody").value.trim();
    if (!target || !bodyMd || busy) return;
    busy = true;
    field<HTMLButtonElement>("translationNoteSave").disabled = true;
    try {
      const content = {
        bodyMd,
        alternatives: parseAlternatives(field<HTMLInputElement>("translationNoteAlternative").value),
        kind: field<HTMLSelectElement>("translationNoteKind").value as TranslationNote["kind"],
        confidence: field<HTMLSelectElement>("translationNoteConfidence").value as TranslationNote["confidence"],
      };
      const { documentNodeId, versionId } = target;
      const result = "noteId" in target
        ? await deps.api.editor.updateTranslationNote({ documentNodeId, versionId, noteId: target.noteId, ...content })
        : await deps.api.editor.createTranslationNote({ documentNodeId, versionId, ...target.selection, ...content });
      if (!result.ok) throw new Error(result.error.message);
      dialog.close();
      target = null;
      deps.applied(result.data);
    } catch (reason) {
      error.textContent = reason instanceof Error ? reason.message : t("각주를 저장하지 못했습니다.");
    } finally {
      busy = false;
      field<HTMLButtonElement>("translationNoteSave").disabled = false;
    }
  }

  async function remove(noteId: string): Promise<void> {
    const view = deps.view();
    if (!view?.translation || busy) return;
    if (!deps.canEdit()) { deps.notify(t("편집한 번역을 저장한 뒤 각주를 고칠 수 있습니다."), t("각주")); return; }
    busy = true;
    try {
      const result = await deps.api.editor.deleteTranslationNote({ documentNodeId: view.document.id, versionId: view.translation.versionId, noteId });
      if (!result.ok) throw new Error(result.error.message);
      deps.applied(result.data);
    } catch (reason) {
      deps.notify(reason instanceof Error ? reason.message : t("각주를 지우지 못했습니다."), t("각주"));
    } finally {
      busy = false;
    }
  }

  field<HTMLFormElement>("translationNoteForm").addEventListener("submit", event => { event.preventDefault(); void save(); });
  field<HTMLButtonElement>("translationNoteCancel").addEventListener("click", () => { dialog.close(); target = null; });
  document.addEventListener("click", event => {
    const button = (event.target as Element).closest?.<HTMLElement>("[data-note-edit], [data-note-remove]");
    if (button?.dataset.noteEdit) openEdit(button.dataset.noteEdit);
    else if (button?.dataset.noteRemove) void remove(button.dataset.noteRemove);
  });
  return { open };
}
