import "../styles/review-marks.css";
import { textareaOffset, sourceDisplayFromElement, displayRangeFromSource } from "./review-selection";

export type ReviewMarkRange = {
  targetKind: "source" | "translation";
  codepointFrom: number;
  codepointTo: number;
  quote: string;
  emphasized: boolean;
};

/** A footnote number drawn where its quote ends in the translation. */
export type NoteRef = { number: number; codepointFrom: number; codepointTo: number; quote: string };

type Sentence = { id: string; from: number; to: number; text: string };
type Interval = { from: number; to: number; emphasized: boolean };
/** A footnote marker at a UTF-16 offset of the decorated text. */
type Ref = { at: number; number: number };
type Mirror = {
  textarea: HTMLTextAreaElement;
  element: HTMLDivElement;
  signature: string;
  onScroll: () => void;
};

const normalizeNewlines = (value: string) => value.replace(/\r\n?/g, "\n");

/** Require the stored coordinates and quote to agree; never guess another occurrence. */
function localIntervals(text: string, start: number, ranges: readonly ReviewMarkRange[]): Interval[] {
  const points = Array.from(text);
  return ranges.flatMap((range) => {
    const from = range.codepointFrom - start;
    const to = range.codepointTo - start;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > points.length) return [];
    if (points.slice(from, to).join("") !== range.quote) return [];
    return [{ from, to, emphasized: range.emphasized }];
  });
}

/** Footnote markers of one text piece, at the codepoint where a still-matching quote ends. */
function localRefs(length: number, start: number, notes: readonly NoteRef[], matches: (note: NoteRef) => boolean): Array<{ end: number; number: number }> {
  return notes.flatMap((note) => {
    const end = note.codepointTo - start;
    return end > 0 && end <= length && matches(note) ? [{ end, number: note.number }] : [];
  });
}

/** Split overlapping comments into one layer so overlapping fills do not get darker. */
function markedText(text: string, intervals: readonly Interval[], refs: readonly Ref[] = []): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const boundaries = [...new Set([0, text.length, ...intervals.flatMap(({ from, to }) => [from, to]), ...refs.map(ref => ref.at)])].sort((a, b) => a - b);
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index]!;
    const to = boundaries[index + 1]!;
    const covering = intervals.filter((range) => range.from <= from && range.to >= to);
    const value = text.slice(from, to);
    if (!covering.length) fragment.append(document.createTextNode(value));
    else {
      const mark = document.createElement("span");
      mark.className = `review-range-mark${covering.some((range) => range.emphasized) ? " is-emphasized" : ""}`;
      mark.textContent = value;
      fragment.append(mark);
    }
    // Empty and numbered by CSS, so text offsets used by find and selection stay exact.
    for (const ref of refs.filter(item => item.at === to)) {
      const marker = document.createElement("span");
      marker.className = "translation-note-ref";
      marker.dataset.note = String(ref.number);
      fragment.append(marker);
    }
  }
  return fragment;
}

/** Typography a textarea overlay must copy to wrap exactly like the field. */
export const textStyleProperties = [
  "font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant",
  "font-feature-settings", "font-variation-settings", "font-kerning", "font-optical-sizing",
  "line-height", "letter-spacing", "word-spacing", "text-align", "text-indent", "text-transform",
  "direction", "writing-mode", "tab-size", "white-space", "word-break", "overflow-wrap",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-radius",
] as const;

/** Decorate existing source spans and native textareas without changing their text or selection. */
export function configureReviewMarks(rows: HTMLElement) {
  const sourceSignatures = new WeakMap<HTMLElement, string>();
  const mirrors = new Map<HTMLTextAreaElement, Mirror>();
  let frame = 0;

  function syncMirror(mirror: Mirror) {
    const { textarea, element } = mirror;
    const parent = textarea.parentElement;
    if (!parent || !textarea.isConnected || !textarea.getClientRects().length) {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    const style = getComputedStyle(textarea);
    for (const property of textStyleProperties) element.style.setProperty(property, style.getPropertyValue(property));
    const rectangle = textarea.getBoundingClientRect();
    const parentRectangle = parent.getBoundingClientRect();
    element.style.left = `${rectangle.left - parentRectangle.left - parent.clientLeft + parent.scrollLeft}px`;
    element.style.top = `${rectangle.top - parentRectangle.top - parent.clientTop + parent.scrollTop}px`;
    element.style.width = `${rectangle.width}px`;
    element.style.height = `${rectangle.height}px`;
    element.scrollLeft = textarea.scrollLeft;
    element.scrollTop = textarea.scrollTop;
  }

  function scheduleSync() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const mirror of mirrors.values()) syncMirror(mirror);
    });
  }

  const observer = new ResizeObserver(scheduleSync);
  observer.observe(rows);
  window.addEventListener("resize", scheduleSync);
  document.fonts.addEventListener("loadingdone", scheduleSync);
  void document.fonts.ready.then(scheduleSync);

  function removeMirror(textarea: HTMLTextAreaElement) {
    const mirror = mirrors.get(textarea);
    if (!mirror) return;
    textarea.removeEventListener("scroll", mirror.onScroll);
    textarea.classList.remove("has-review-marks");
    observer.unobserve(textarea);
    mirror.element.remove();
    mirrors.delete(textarea);
    if (!textarea.parentElement?.querySelector(".review-textarea-mirror")) textarea.parentElement?.classList.remove("review-marks-container");
  }

  function render(ranges: ReviewMarkRange[], sentences: readonly Sentence[], notes: readonly NoteRef[] = []) {
    const sourceRanges = ranges.filter((range) => range.targetKind === "source");
    for (const source of rows.querySelectorAll<HTMLElement>("[data-review-source-from][data-review-source-to]")) {
      const text = source.textContent ?? "";
      const display = sourceDisplayFromElement(source);
      const mapped = display ? sourceRanges.flatMap(range => {
        const interval = displayRangeFromSource(display, range.codepointFrom, range.codepointTo, range.quote);
        return interval ? [{ ...interval, emphasized: range.emphasized }] : [];
      }) : [];
      const intervals = mapped.map((range) => ({
        ...range,
        from: Array.from(text).slice(0, range.from).join("").length,
        to: Array.from(text).slice(0, range.to).join("").length,
      }));
      const signature = JSON.stringify([text, intervals]);
      // Unchanged DOM is especially important while the user is dragging a selection.
      if (sourceSignatures.get(source) === signature) continue;
      if (intervals.length || source.querySelector(".review-range-mark")) source.replaceChildren(markedText(text, intervals));
      sourceSignatures.set(source, signature);
    }

    const translationRanges = ranges.filter((range) => range.targetKind === "translation");
    // Plain translation text (book flow, or comparison rows while reading) can span several
    // pieces. Validate the full quote, then decorate each intersecting fragment in place.
    for (const body of rows.querySelectorAll<HTMLElement>("[data-review-translation-from]")) {
      const raw = body.closest<HTMLElement>("#bookGroups, #rows")?.dataset.translationText ?? "";
      const points = Array.from(raw), from = Number(body.dataset.reviewTranslationFrom), to = Number(body.dataset.reviewTranslationTo);
      const text = body.textContent ?? "";
      const intervals = translationRanges.flatMap(range => {
        if (points.slice(range.codepointFrom, range.codepointTo).join("") !== range.quote) return [];
        const start = Math.max(from, range.codepointFrom), end = Math.min(to, range.codepointTo);
        return start < end ? [{ from: points.slice(from, start).join("").length, to: points.slice(from, end).join("").length, emphasized: range.emphasized }] : [];
      });
      const local = Array.from(text);
      const refs = localRefs(local.length, from, notes, note => points.slice(note.codepointFrom, note.codepointTo).join("") === note.quote)
        .map(ref => ({ at: local.slice(0, ref.end).join("").length, number: ref.number }));
      const signature = JSON.stringify([text, intervals, refs]);
      if (sourceSignatures.get(body) === signature) continue;
      if (intervals.length || refs.length || body.querySelector(".review-range-mark, .translation-note-ref")) body.replaceChildren(markedText(text, intervals, refs));
      sourceSignatures.set(body, signature);
    }
    const sentenceById = new Map(sentences.map((sentence) => [sentence.id, sentence]));
    const retained = new Set<HTMLTextAreaElement>();
    for (const textarea of rows.querySelectorAll<HTMLTextAreaElement>(".sentence-edit[data-sentence-edit]")) {
      if (textarea.hidden) continue;
      const sentence = sentenceById.get(textarea.dataset.sentenceEdit ?? "");
      if (!sentence || textarea.value !== normalizeNewlines(sentence.text)) continue;
      const intervals = localIntervals(sentence.text, sentence.from, translationRanges).map((range) => ({
        ...range,
        from: textareaOffset(sentence.text, range.from),
        to: textareaOffset(sentence.text, range.to),
      }));
      // A quote may begin in an earlier sentence; only the part inside this one can be checked here.
      const sentencePoints = Array.from(sentence.text);
      const refs = localRefs(sentencePoints.length, sentence.from, notes, note => {
        const head = Math.max(note.codepointFrom, sentence.from);
        return sentencePoints.slice(head - sentence.from, note.codepointTo - sentence.from).join("") === Array.from(note.quote).slice(head - note.codepointFrom).join("");
      }).map(ref => ({ at: textareaOffset(sentence.text, ref.end), number: ref.number }));
      if (!intervals.length && !refs.length) continue;
      retained.add(textarea);
      let mirror = mirrors.get(textarea);
      if (!mirror) {
        const element = document.createElement("div");
        element.className = "review-textarea-mirror";
        element.setAttribute("aria-hidden", "true");
        textarea.parentElement?.classList.add("review-marks-container");
        textarea.before(element);
        textarea.classList.add("has-review-marks");
        mirror = { textarea, element, signature: "", onScroll: () => scheduleSync() };
        mirrors.set(textarea, mirror);
        textarea.addEventListener("scroll", mirror.onScroll, { passive: true });
        observer.observe(textarea);
      }
      const signature = JSON.stringify([textarea.value, intervals, refs]);
      if (mirror.signature !== signature) {
        const fragment = markedText(textarea.value, intervals, refs);
        // A trailing newline occupies a final line in the native textarea too.
        if (textarea.value.endsWith("\n")) fragment.append(document.createTextNode("\u200b"));
        mirror.element.replaceChildren(fragment);
        mirror.signature = signature;
      }
      syncMirror(mirror);
    }
    for (const textarea of mirrors.keys()) if (!retained.has(textarea)) removeMirror(textarea);
    scheduleSync();
  }

  function destroy() {
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener("resize", scheduleSync);
    document.fonts.removeEventListener("loadingdone", scheduleSync);
    for (const textarea of mirrors.keys()) removeMirror(textarea);
    for (const source of rows.querySelectorAll<HTMLElement>("[data-review-source-from], [data-review-translation-from]")) {
      if (source.querySelector(".review-range-mark, .translation-note-ref")) source.replaceChildren(document.createTextNode(source.textContent ?? ""));
    }
  }

  return { render, destroy };
}
