import "../styles/review-marks.css";
import { textareaOffset, sourceDisplayFromElement, displayRangeFromSource } from "./review-selection";

export type ReviewMarkRange = {
  targetKind: "source" | "translation";
  codepointFrom: number;
  codepointTo: number;
  quote: string;
  emphasized: boolean;
};

type Sentence = { id: string; from: number; to: number; text: string };
type Interval = { from: number; to: number; emphasized: boolean };
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

/** Split overlapping comments into one layer so overlapping fills do not get darker. */
function markedText(text: string, intervals: readonly Interval[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const boundaries = [...new Set([0, text.length, ...intervals.flatMap(({ from, to }) => [from, to])])].sort((a, b) => a - b);
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index]!;
    const to = boundaries[index + 1]!;
    const covering = intervals.filter((range) => range.from <= from && range.to >= to);
    const value = text.slice(from, to);
    if (!covering.length) {
      fragment.append(document.createTextNode(value));
      continue;
    }
    const mark = document.createElement("span");
    mark.className = `review-range-mark${covering.some((range) => range.emphasized) ? " is-emphasized" : ""}`;
    mark.textContent = value;
    fragment.append(mark);
  }
  return fragment;
}

const textStyleProperties = [
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

  function render(ranges: ReviewMarkRange[], sentences: readonly Sentence[]) {
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
    const sentenceById = new Map(sentences.map((sentence) => [sentence.id, sentence]));
    const retained = new Set<HTMLTextAreaElement>();
    for (const textarea of rows.querySelectorAll<HTMLTextAreaElement>(".sentence-edit[data-sentence-edit]")) {
      const sentence = sentenceById.get(textarea.dataset.sentenceEdit ?? "");
      if (!sentence || textarea.value !== normalizeNewlines(sentence.text)) continue;
      const intervals = localIntervals(sentence.text, sentence.from, translationRanges).map((range) => ({
        ...range,
        from: textareaOffset(sentence.text, range.from),
        to: textareaOffset(sentence.text, range.to),
      }));
      if (!intervals.length) continue;
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
      const signature = JSON.stringify([textarea.value, intervals]);
      if (mirror.signature !== signature) {
        const fragment = markedText(textarea.value, intervals);
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
    for (const source of rows.querySelectorAll<HTMLElement>("[data-review-source-from]")) {
      if (source.querySelector(".review-range-mark")) source.replaceChildren(document.createTextNode(source.textContent ?? ""));
    }
  }

  return { render, destroy };
}
