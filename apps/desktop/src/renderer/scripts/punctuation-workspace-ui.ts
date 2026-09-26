import type { EditorView } from "../../shared/munhae-api";
import { configurePunctuationSegmentation } from "./punctuation-segmentation-ui";
import { configureComparisonResize } from "./comparison-resize";
import { t, ui } from "./i18n";
import { must, store } from "./shared";
import { onReadingTypeChange } from "./reading-type";
import { punctuationParagraphs, type PunctuationParagraph } from "./punctuation-paragraphs";
import { createPunctuationProjection, punctuationCaretForSource } from "./punctuation-projection";

/** Keep the native textarea (IME, undo, draft recovery) as the sole text editor. */
export function configurePunctuationWorkspace() {
  const segmentation = configurePunctuationSegmentation();
  const sheet = must<HTMLElement>("#punctuationComparison");
  const reference = must<HTMLElement>("#punctuationSourceReference");
  const textarea = must<HTMLTextAreaElement>("#punctuationDraftText");
  const compare = must<HTMLButtonElement>("#btnPunctuationCompare");
  const settings = must<HTMLElement>("#punctuationViewSettings");
  const sync = must<HTMLInputElement>("#punctuationSync");
  let source = "", text = "", paragraphs: PunctuationParagraph[] | null = null;
  let mode: "prose" | "poetry" = "prose";
  let current = -1, narrow = false, showSource = false;
  let focused = store.get("munhae.punctuation.focused") === "true";
  sync.checked = store.get("munhae.punctuation.sync") !== "false";
  sync.addEventListener("change", () => store.set("munhae.punctuation.sync", String(sync.checked)));

  const renderLayout = () => {
    sheet.classList.toggle("is-focused", !narrow && focused);
    sheet.classList.toggle("is-showing-source", narrow && showSource);
    compare.querySelector("span")!.textContent = narrow ? showSource ? t("표점 편집") : t("원문 보기") : t("원문 대조");
    compare.setAttribute("aria-pressed", String(narrow ? showSource : !focused));
  };
  compare.addEventListener("click", () => {
    if (narrow) showSource = !showSource;
    else { focused = !focused; store.set("munhae.punctuation.focused", String(focused)); }
    renderLayout();
  });
  new ResizeObserver(() => {
    narrow = must<HTMLElement>(".pane-center").clientWidth <= 680;
    renderLayout();
  }).observe(must(".pane-center"));
  settings.addEventListener("toggle", () => must("#btnPunctuationView").setAttribute("aria-expanded", String(settings.matches(":popover-open"))));
  configureComparisonResize(sheet, must("#punctuationDivider"), () => {}, "munhae.punctuation.sourceRatio", 50);

  function selectCurrent(scroll = false): void {
    if (!paragraphs?.length) { must("#punctuationLocation").textContent = ""; return; }
    const position = textarea.selectionStart;
    // Whitespace after a paragraph belongs to neither range; keep the previous
    // paragraph highlighted until the caret reaches the next paragraph body.
    const next = paragraphs.findIndex(paragraph => position < paragraph.from);
    const index = next < 0 ? paragraphs.length - 1 : Math.max(0, next - 1);
    const changed = current !== index;
    current = index;
    Array.from(reference.children).forEach((child, i) => {
      child.classList.toggle("is-current", i === index);
      if (i === index) child.setAttribute("aria-current", "true");
      else child.removeAttribute("aria-current");
    });
    must("#punctuationLocation").textContent = ui`${index + 1} / ${paragraphs.length} 문단`;
    if (scroll && changed && sync.checked && reference.clientHeight) {
      const child = reference.children[index];
      if (child) reference.scrollTop += child.getBoundingClientRect().top - reference.getBoundingClientRect().top - 20;
    }
  }
  for (const event of ["click", "keyup", "select", "focus"]) textarea.addEventListener(event, () => selectCurrent(true));
  // `select` also fires for mouse-drag selections; no document-wide listener needed.
  // A same-size, offscreen mirror measures wrapped lines without touching the editor value.
  function caretBox(offset: number): { top: number; left: number; height: number } {
    const mirror = document.createElement("div");
    const computed = getComputedStyle(textarea);
    for (const property of ["font", "letter-spacing", "line-height", "padding", "box-sizing", "white-space", "overflow-wrap", "word-break", "tab-size"]) {
      mirror.style.setProperty(property, computed.getPropertyValue(property));
    }
    Object.assign(mirror.style, { position: "fixed", visibility: "hidden", pointerEvents: "none", width: `${textarea.clientWidth}px`, height: "auto", top: "0", left: "-10000px" });
    mirror.textContent = textarea.value.slice(0, offset);
    const cursor = document.createElement("span");
    cursor.textContent = "\u200b";
    mirror.append(cursor);
    document.body.append(mirror);
    const box = cursor.getBoundingClientRect(), origin = mirror.getBoundingClientRect();
    mirror.remove();
    return { top: box.top - origin.top, left: box.left - origin.left, height: box.height };
  }
  const caretMark = must<HTMLElement>("#punctuationCaretMark");
  let markOffset = -1, markText = "", markBox: ReturnType<typeof caretBox> | null = null;
  const placeCaretMark = () => {
    if (!markBox) return;
    caretMark.style.top = `${textarea.offsetTop + markBox.top - textarea.scrollTop}px`;
    caretMark.style.left = `${textarea.offsetLeft + markBox.left - textarea.scrollLeft}px`;
    caretMark.style.height = `${markBox.height}px`;
  };
  const hideCaretMark = () => { markOffset = -1; markBox = null; caretMark.hidden = true; };
  // Wrapping changes with pane width and type settings, so measure again.
  const remeasureCaretMark = () => { if (markOffset >= 0) { markBox = caretBox(markOffset); placeCaretMark(); } };
  textarea.addEventListener("scroll", placeCaretMark);
  for (const event of ["mousedown", "keydown", "input", "blur"]) textarea.addEventListener(event, hideCaretMark);
  new ResizeObserver(remeasureCaretMark).observe(textarea);
  onReadingTypeChange(remeasureCaretMark);
  function moveCaret(offset: number, ratio: number): void {
    if (narrow) { showSource = false; renderLayout(); }
    textarea.setSelectionRange(offset, offset);
    // Record the paragraph before focus/select events sync the source pane, so
    // the pane the user just clicked in never jumps to a paragraph start.
    selectCurrent();
    textarea.focus({ preventScroll: true });
    const box = caretBox(offset);
    textarea.scrollTop = box.top - parseFloat(getComputedStyle(textarea).paddingTop) - textarea.clientHeight * ratio;
    // An editable textarea shows its own caret; only read-only needs the mark.
    if (!textarea.readOnly) { hideCaretMark(); return; }
    markOffset = offset; markText = textarea.value; markBox = box;
    placeCaretMark();
    caretMark.hidden = false;
    caretMark.getAnimations().forEach(animation => { animation.cancel(); animation.play(); });
  }
  reference.addEventListener("click", event => {
    // Dragging selects source text for copying; only a plain click moves the caret.
    if (!window.getSelection()?.isCollapsed) return;
    const position = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (!position || !reference.contains(position.offsetNode)) return;
    const projection = createPunctuationProjection(source, textarea.value);
    if (!projection) return;
    // The reference text is the source verbatim, so its text length is the source cursor.
    const range = document.createRange();
    range.setStart(reference, 0);
    range.setEnd(position.offsetNode, position.offset);
    moveCaret(punctuationCaretForSource(projection, source, Array.from(range.toString()).length), 1 / 3);
  });
  // Keyboard users still step by paragraph; the caret goes to its start.
  reference.addEventListener("keydown", event => {
    if ((event.key === "Enter" || event.key === " ") && event.target instanceof Element && event.target.matches("[data-punctuation-paragraph]")) {
      event.preventDefault();
      const paragraph = paragraphs?.[Number((event.target as HTMLElement).dataset.punctuationParagraph)];
      if (paragraph) moveCaret(paragraph.from, 0);
    }
  });

  return {
    update(nextSource: string, savedPunctuation: EditorView["punctuation"] = null): void {
      segmentation.update(savedPunctuation);
      const nextMode = must<HTMLSelectElement>("#punctuationMode").value === "poetry" ? "poetry" : "prose";
      if (source !== nextSource || text !== textarea.value || mode !== nextMode) {
        const sourceChanged = source !== nextSource;
        const scrollTop = reference.scrollTop;
        source = nextSource; text = textarea.value;
        mode = nextMode;
        paragraphs = punctuationParagraphs(source, text, mode);
        current = -1;
        if (paragraphs?.length) {
          const sourcePoints = Array.from(source);
          const fragment = document.createDocumentFragment();
          let cursor = 0;
          paragraphs.forEach((paragraph, index) => {
            fragment.append(document.createTextNode(sourcePoints.slice(cursor, paragraph.sourceFrom).join("")));
            const span = document.createElement("span");
            span.className = "punctuation-source-paragraph";
            span.dataset.punctuationParagraph = String(index);
            span.tabIndex = 0;
            span.setAttribute("role", "button");
            span.setAttribute("aria-label", ui`표점 ${index + 1}문단 대조`);
            span.textContent = paragraph.sourceText;
            fragment.append(span);
            cursor = paragraph.sourceTo;
          });
          fragment.append(document.createTextNode(sourcePoints.slice(cursor).join("")));
          reference.replaceChildren(fragment);
        } else reference.textContent = source;
        reference.scrollTop = sourceChanged ? 0 : scrollTop;
      }
      must("#punctuationSourceCount").textContent = ui`${Array.from(source).length.toLocaleString()}자`;
      must("#punctuationCorrespondence").textContent = !text.trim() ? "" : paragraphs ? t("원문 일치") : t("원문 대응 확인 필요");
      selectCurrent();
      if (markOffset >= 0 && (!textarea.readOnly || textarea.value !== markText)) hideCaretMark();
    },
  };
}
