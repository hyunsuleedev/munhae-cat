import type { EditorView } from "../../shared/munhae-api";
import { t, ui } from "./i18n";
import { must } from "./shared";

type SavedPunctuation = NonNullable<EditorView["punctuation"]>;

/** Paint saved ranges behind the native textarea without changing its text or layout. */
export function configurePunctuationSegmentation() {
  const workspace = must<HTMLElement>("#punctuationWorkspace");
  const button = must<HTMLButtonElement>("#btnPunctuationSegments");
  const overlay = must<HTMLElement>("#punctuationSegments");
  const mirror = must<HTMLElement>("#punctuationSegmentsText");
  const marks = must<HTMLElement>("#punctuationSegmentMarks");
  const boundaries: Array<{ range: Range; mark: HTMLElement; paragraph: boolean }> = [];
  const textarea = must<HTMLTextAreaElement>("#punctuationDraftText");
  let saved: SavedPunctuation | null = null;
  let renderedVersion: string | null = null;
  let showing = false;

  function syncLayout() {
    if (!showing) return;
    const computed = getComputedStyle(textarea);
    for (const property of ["font", "letter-spacing", "line-height", "padding", "box-sizing", "white-space", "overflow-wrap", "word-break", "tab-size", "text-indent", "text-align", "direction"]) {
      mirror.style.setProperty(property, computed.getPropertyValue(property));
    }
    Object.assign(overlay.style, {
      top: `${textarea.offsetTop}px`, left: `${textarea.offsetLeft}px`,
      width: `${textarea.clientWidth}px`, height: `${textarea.clientHeight}px`,
    });
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
    const rect = overlay.getBoundingClientRect();
    const scaleX = rect.width / overlay.clientWidth || 1;
    const scaleY = rect.height / overlay.clientHeight || 1;
    for (const { range, mark, paragraph } of boundaries) {
      const start = range.getBoundingClientRect();
      mark.style.left = `${(start.left - rect.left) / scaleX - (paragraph ? 20 : 0)}px`;
      mark.style.top = `${(start.top - rect.top) / scaleY + (paragraph ? 5 : -8)}px`;
    }
  }

  function render() {
    if (!saved || renderedVersion === saved.versionId) return;
    const points = Array.from(saved.punctuatedText);
    const kinds: Record<string, string> = {
      paragraph: t("문단"), sentence: t("문장"), verse_line: t("시행"),
      stanza: t("연"), couplet: t("대구"), clause: t("절"),
    };
    const children = new Map<string | null, SavedPunctuation["structureSpans"]>();
    const ids = new Set(saved.structureSpans.map(span => span.id));
    for (const span of saved.structureSpans) {
      const parent = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : null;
      const siblings = children.get(parent) ?? [];
      siblings.push(span);
      children.set(parent, siblings);
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.codepointFrom - b.codepointFrom);
    const append = (parent: HTMLElement | DocumentFragment, id: string | null, from: number, to: number) => {
      let cursor = from;
      for (const span of children.get(id) ?? []) {
        parent.append(document.createTextNode(points.slice(cursor, span.codepointFrom).join("")));
        const node = document.createElement("span");
        const group = children.has(span.id);
        node.className = group ? "punctuation-segment-group" : "punctuation-segment-unit";
        node.dataset.from = String(span.codepointFrom);
        node.dataset.to = String(span.codepointTo);
        node.dataset.kind = span.spanKind;
        node.dataset.number = String(span.ordinal);
        if (group) append(node, span.id, span.codepointFrom, span.codepointTo);
        else {
          node.dataset.tone = String((span.ordinal - 1) % 2);
          node.textContent = points.slice(span.codepointFrom, span.codepointTo).join("");
        }
        parent.append(node);
        cursor = span.codepointTo;
      }
      parent.append(document.createTextNode(points.slice(cursor, to).join("")));
    };
    const fragment = document.createDocumentFragment();
    append(fragment, null, 0, points.length);
    mirror.replaceChildren(fragment);
    marks.replaceChildren();
    boundaries.length = 0;
    for (const node of mirror.querySelectorAll<HTMLElement>("[data-number]")) {
      const paragraph = node.dataset.kind === "paragraph" || node.dataset.kind === "stanza";
      if (!paragraph && node.classList.contains("punctuation-segment-group")) continue;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let first: Node | null;
      while ((first = walker.nextNode())) {
        const value = first.textContent ?? "";
        const index = value.search(/\S/u);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(first, index);
        range.setEnd(first, index + Array.from(value.slice(index))[0]!.length);
        const mark = document.createElement("span");
        mark.textContent = `${paragraph ? "¶" : ""}${node.dataset.number}`;
        marks.append(mark);
        boundaries.push({ range, mark, paragraph });
        break;
      }
    }
    const counts = new Map<string, number>();
    for (const span of saved.structureSpans) counts.set(span.spanKind, (counts.get(span.spanKind) ?? 0) + 1);
    button.title = [ui`저장된 표점 P${saved.versionNo}`, ...["paragraph", "stanza", "couplet", "sentence", "verse_line", "clause"]
      .filter(kind => counts.has(kind)).map(kind => `${kinds[kind]} ${counts.get(kind)}`),
      t("¶ 문단 · 색상과 번호로 문장·시행 표시")].join(" · ");
    renderedVersion = saved.versionId;
  }

  function setShowing(next: boolean) {
    if (next) render();
    showing = next;
    button.setAttribute("aria-pressed", String(showing));
    overlay.hidden = !showing;
    syncLayout();
  }
  button.addEventListener("click", () => { if (saved) setShowing(!showing); });
  textarea.addEventListener("scroll", syncLayout, { passive: true });
  textarea.addEventListener("input", () => {
    if (saved?.punctuatedText !== textarea.value) setShowing(false);
  });
  workspace.addEventListener("keydown", event => {
    if (event.key === "Escape" && showing) setShowing(false);
  });
  workspace.addEventListener("change", syncLayout);
  new ResizeObserver(syncLayout).observe(textarea);

  return {
    update(next: SavedPunctuation | null) {
      const available = next && ["draft", "confirmed"].includes(next.state)
        && next.structureSpans.length > 0 && next.punctuatedText === textarea.value ? next : null;
      if (saved?.versionId !== available?.versionId) {
        setShowing(false);
        renderedVersion = null;
        mirror.replaceChildren();
        marks.replaceChildren();
        boundaries.length = 0;
      }
      saved = available;
      button.hidden = !saved;
      syncLayout();
    },
  };
}
