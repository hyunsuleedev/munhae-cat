import { t, ui } from "./i18n";
import { must, store } from "./shared";
import { punctuationParagraphs, type PunctuationParagraph } from "./punctuation-paragraphs";

/** Keep the native textarea (IME, undo, draft recovery) as the sole text editor. */
export function configurePunctuationWorkspace() {
  const workspace = must<HTMLElement>("#punctuationWorkspace");
  const sheet = must<HTMLElement>("#punctuationComparison");
  const reference = must<HTMLElement>("#punctuationSourceReference");
  const textarea = must<HTMLTextAreaElement>("#punctuationDraftText");
  const compare = must<HTMLButtonElement>("#btnPunctuationCompare");
  const settings = must<HTMLElement>("#punctuationViewSettings");
  const font = must<HTMLSelectElement>("#punctuationFontSize");
  const leading = must<HTMLSelectElement>("#punctuationLineHeight");
  const sync = must<HTMLInputElement>("#punctuationSync");
  let source = "", text = "", paragraphs: PunctuationParagraph[] | null = null;
  let current = -1, narrow = false, showSource = false;
  let focused = store.get("munhae.punctuation.focused") === "true";
  const savedFont = store.get("munhae.punctuation.font-size");
  const savedLeading = store.get("munhae.punctuation.line-height");
  font.value = savedFont && ["18", "20", "22", "24"].includes(savedFont) ? savedFont : "18";
  leading.value = savedLeading && ["1.7", "1.9", "2.2"].includes(savedLeading) ? savedLeading : "1.9";
  sync.checked = store.get("munhae.punctuation.sync") !== "false";
  const applyType = () => {
    workspace.style.setProperty("--punctuation-font-size", `${font.value}px`);
    workspace.style.setProperty("--punctuation-line-height", leading.value);
  };
  font.addEventListener("change", () => { applyType(); store.set("munhae.punctuation.font-size", font.value); });
  leading.addEventListener("change", () => { applyType(); store.set("munhae.punctuation.line-height", leading.value); });
  sync.addEventListener("change", () => store.set("munhae.punctuation.sync", String(sync.checked)));
  applyType();

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

  function selectCurrent(scroll = false): void {
    if (!paragraphs?.length) { must("#punctuationLocation").textContent = ""; return; }
    const position = textarea.selectionStart;
    const found = paragraphs.findIndex(paragraph => position < paragraph.to);
    const index = found < 0 ? paragraphs.length - 1 : found;
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
  function selectSource(target: EventTarget | null): void {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-punctuation-paragraph]") : null;
    if (!element) return;
    const paragraph = paragraphs?.[Number(element.dataset.punctuationParagraph)];
    if (!paragraph) return;
    if (narrow) { showSource = false; renderLayout(); }
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(paragraph.from, paragraph.to);
    // A same-size, offscreen mirror measures wrapped lines without touching the editor value.
    const mirror = document.createElement("div");
    const computed = getComputedStyle(textarea);
    for (const property of ["font", "letter-spacing", "line-height", "padding", "box-sizing", "white-space", "overflow-wrap", "word-break", "tab-size"]) {
      mirror.style.setProperty(property, computed.getPropertyValue(property));
    }
    Object.assign(mirror.style, { position: "fixed", visibility: "hidden", pointerEvents: "none", width: `${textarea.clientWidth}px`, height: "auto", top: "0", left: "-10000px" });
    mirror.textContent = textarea.value.slice(0, paragraph.from);
    const cursor = document.createElement("span");
    cursor.textContent = "\u200b";
    mirror.append(cursor);
    document.body.append(mirror);
    textarea.scrollTop = cursor.getBoundingClientRect().top - mirror.getBoundingClientRect().top - parseFloat(computed.paddingTop);
    mirror.remove();
    selectCurrent();
  }
  reference.addEventListener("click", event => {
    if (!window.getSelection()?.isCollapsed) return;
    selectSource(event.target);
  });
  reference.addEventListener("keydown", event => {
    if ((event.key === "Enter" || event.key === " ") && event.target instanceof Element && event.target.matches("[data-punctuation-paragraph]")) {
      event.preventDefault(); selectSource(event.target);
    }
  });

  return {
    update(nextSource: string): void {
      if (source !== nextSource || text !== textarea.value) {
        const sourceChanged = source !== nextSource;
        const scrollTop = reference.scrollTop;
        source = nextSource; text = textarea.value;
        paragraphs = punctuationParagraphs(source, text);
        current = -1;
        if (paragraphs?.length) {
          reference.replaceChildren(...paragraphs.map((paragraph, index) => {
            const span = document.createElement("span");
            span.className = "punctuation-source-paragraph";
            span.dataset.punctuationParagraph = String(index);
            span.tabIndex = 0;
            span.setAttribute("role", "button");
            span.setAttribute("aria-label", ui`표점 ${index + 1}문단 대조`);
            span.textContent = paragraph.sourceText;
            return span;
          }));
        } else reference.textContent = source;
        reference.scrollTop = sourceChanged ? 0 : scrollTop;
      }
      must("#punctuationSourceCount").textContent = ui`${Array.from(source).length.toLocaleString()}자`;
      must("#punctuationCorrespondence").textContent = !text.trim() ? "" : paragraphs ? t("원문 일치") : t("원문 대응 확인 필요");
      selectCurrent();
    },
  };
}
