import { whitespaceMarkup } from "./editor-session";

/** Paint-only mirrors: copied text, native selection and saved glyphs are untouched. */
export function configureWhitespace(root: HTMLElement, escape: (text: string) => string) {
  const mirrors = new Map<HTMLElement, HTMLDivElement>();
  let enabled = false;
  let frame = 0;
  const properties = ["font", "font-family", "font-size", "font-weight", "font-style", "font-feature-settings", "font-variation-settings", "line-height", "letter-spacing", "word-spacing", "text-align", "text-indent", "text-transform", "white-space", "word-break", "overflow-wrap", "tab-size", "padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "box-sizing", "direction"];
  function draw() {
    frame = 0;
    const targets = enabled ? [...root.querySelectorAll<HTMLElement>(".sentence-edit, .sentence-source, #folioSourceText, #sourceDraftText, #punctuationDraftText, .tgt-edit")] : [];
    const current = new Set(targets);
    for (const [target, mirror] of mirrors) if (!current.has(target) || !target.isConnected) { mirror.remove(); mirrors.delete(target); }
    for (const target of targets) {
      let mirror = mirrors.get(target);
      const parent = target.parentElement;
      if (!parent) continue;
      if (!mirror) {
        mirror = document.createElement("div"); mirror.className = "editor-whitespace-mirror"; mirror.setAttribute("aria-hidden", "true");
        parent.classList.add("has-whitespace-mirror"); parent.append(mirror); mirrors.set(target, mirror);
      }
      mirror.hidden = !target.getClientRects().length;
      if (mirror.hidden) continue;
      const style = getComputedStyle(target), rect = target.getBoundingClientRect(), bounds = parent.getBoundingClientRect();
      for (const property of properties) mirror.style.setProperty(property, style.getPropertyValue(property));
      mirror.style.left = `${rect.left - bounds.left - parent.clientLeft + parent.scrollLeft}px`;
      mirror.style.top = `${rect.top - bounds.top - parent.clientTop + parent.scrollTop}px`;
      mirror.style.width = `${rect.width}px`; mirror.style.height = `${rect.height}px`;
      const text = target instanceof HTMLTextAreaElement ? target.value : target.textContent ?? "";
      if (mirror.dataset.text !== text) { mirror.innerHTML = whitespaceMarkup(text, escape); mirror.dataset.text = text; }
      mirror.scrollTop = target.scrollTop; mirror.scrollLeft = target.scrollLeft;
    }
  }
  function refresh() { if (!frame) frame = requestAnimationFrame(draw); }
  root.addEventListener("input", refresh); root.addEventListener("scroll", refresh, true);
  window.addEventListener("resize", refresh);
  new ResizeObserver(refresh).observe(root);
  return { set(value: boolean) { enabled = value; refresh(); }, refresh };
}
