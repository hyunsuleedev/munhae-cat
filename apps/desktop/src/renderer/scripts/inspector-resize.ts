import { t, ui } from "./i18n";
import { store } from "./shared";

type InspectorResizeOptions = {
  /** Receives the handle, which straddles the inspector's leading edge. */
  host: HTMLElement;
  /** Inspector whose rendered width seeds a drag. */
  panel: HTMLElement;
  /** Holds both the main column and the inspector; bounds the widest inspector. */
  workspace: HTMLElement;
  /** Element carrying the chosen width as a custom property. */
  target: HTMLElement;
  property: string;
  key: string;
  label: string;
  hidden: () => boolean;
  minWidth?: number;
  minMain?: number;
};

/** Drag, arrow keys, or double-click (default width) on the inspector edge; the width persists per key. */
export function configureInspectorResize(options: InspectorResizeOptions): void {
  const { host, panel, workspace, target, property, key, hidden, minWidth = 240, minMain = 360 } = options;
  // AuthGate hides the shell during page initialization, so an unmeasured workspace leaves the width unbounded.
  const maxWidth = (): number => workspace.clientWidth ? Math.max(minWidth, workspace.clientWidth - minMain) : Infinity;
  const saved = Number(store.get(key));
  let preferred = Number.isFinite(saved) && saved >= minWidth ? saved : 0;
  let width = preferred;
  let drag: { pointerId: number; startX: number; startWidth: number } | null = null;
  const handle = document.createElement("div");
  handle.className = "inspector-resizer";
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", options.label);
  handle.setAttribute("aria-orientation", "vertical");
  if (panel.id) handle.setAttribute("aria-controls", panel.id);
  handle.title = t("드래그하여 너비 조절 · 두 번 클릭하면 기본 너비");
  host.prepend(handle);

  const applyWidth = (next: number | 0): void => {
    if (next === 0) {
      width = 0;
      target.style.removeProperty(property);
      handle.removeAttribute("aria-valuenow");
      return;
    }
    const max = maxWidth();
    width = Math.round(Math.max(minWidth, Math.min(max, next)));
    target.style.setProperty(property, `${width}px`);
    handle.setAttribute("aria-valuemin", String(minWidth));
    if (Number.isFinite(max)) handle.setAttribute("aria-valuemax", String(max));
    handle.setAttribute("aria-valuenow", String(width));
    handle.setAttribute("aria-valuetext", ui`${width}픽셀`);
  };
  const remember = (): void => {
    preferred = width;
    store.set(key, String(width));
  };
  const currentWidth = (): number => width || panel.getBoundingClientRect().width;
  const finishDrag = (cancel = false): void => {
    if (!drag) return;
    const pointerId = drag.pointerId;
    drag = null;
    if (cancel) applyWidth(preferred);
    else remember();
    handle.classList.remove("is-drag");
    document.body.classList.remove("is-resizing-inspector");
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag || hidden()) return;
    event.preventDefault();
    const start = currentWidth();
    width = start;
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: start };
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-drag");
    document.body.classList.add("is-resizing-inspector");
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag?.pointerId === event.pointerId) applyWidth(drag.startWidth - (event.clientX - drag.startX));
  });
  handle.addEventListener("pointerup", (event) => { if (drag?.pointerId === event.pointerId) finishDrag(); });
  handle.addEventListener("pointercancel", (event) => { if (drag?.pointerId === event.pointerId) finishDrag(true); });
  handle.addEventListener("lostpointercapture", () => finishDrag(true));
  handle.addEventListener("dblclick", () => {
    applyWidth(0);
    preferred = 0;
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  });
  handle.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drag) { event.preventDefault(); finishDrag(true); return; }
    if (drag || event.metaKey || event.ctrlKey || event.altKey) return;
    const base = currentWidth();
    const step = event.shiftKey ? 40 : 10;
    const next = { ArrowLeft: base + step, ArrowRight: base - step, Home: minWidth, End: maxWidth() }[event.key];
    if (next === undefined || !Number.isFinite(next)) return;
    event.preventDefault();
    applyWidth(next);
    remember();
  });
  window.addEventListener("resize", () => { finishDrag(true); if (preferred) applyWidth(preferred); });
  window.addEventListener("blur", () => finishDrag(true));
  if (preferred) applyWidth(preferred);
}
