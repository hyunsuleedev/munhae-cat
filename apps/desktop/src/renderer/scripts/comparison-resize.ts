import { store } from "./shared";

export function configureComparisonResize(sheet: HTMLElement, handle: HTMLElement, changed: () => void): void {
  const key = "munhae.comparison.sourceRatio";
  const saved = Number.parseFloat(store.get(key) ?? "");
  let ratio = Number.isFinite(saved) ? Math.max(20, Math.min(80, saved)) : 41;
  let pointer: number | undefined;
  let frame = 0;
  const limits = (): [number, number] => {
    const min = Math.min(50, Math.max(20, 180 / (sheet.clientWidth || 1) * 100));
    return [min, 100 - min];
  };
  const render = (): void => {
    sheet.style.setProperty("--comparison-source-width", `clamp(180px, ${ratio}%, calc(100% - 180px))`);
    const [min, max] = limits();
    handle.setAttribute("aria-valuemin", String(Math.round(min)));
    handle.setAttribute("aria-valuemax", String(Math.round(max)));
    handle.setAttribute("aria-valuenow", String(Math.round(Math.max(min, Math.min(max, ratio)))));
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; changed(); });
  };
  const save = (): void => store.set(key, String(ratio));
  const finish = (): void => {
    const id = pointer;
    pointer = undefined;
    handle.classList.remove("is-drag");
    document.body.classList.remove("is-comparison-resizing");
    if (id !== undefined && handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    save();
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary || pointer !== undefined) return;
    event.preventDefault();
    pointer = event.pointerId;
    handle.setPointerCapture(pointer);
    handle.focus({ preventScroll: true });
    handle.classList.add("is-drag");
    document.body.classList.add("is-comparison-resizing");
  });
  handle.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointer) return;
    const bounds = sheet.getBoundingClientRect();
    const [min, max] = limits();
    ratio = Math.max(min, Math.min(max, (event.clientX - bounds.left - sheet.clientLeft) / sheet.clientWidth * 100));
    render();
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    handle.addEventListener(name, (event) => { if (event.pointerId === pointer) finish(); });
  }
  window.addEventListener("blur", () => { if (pointer !== undefined) finish(); });
  handle.addEventListener("dblclick", () => { ratio = 41; render(); save(); });
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
    event.preventDefault();
    const [min, max] = limits();
    const current = Math.max(min, Math.min(max, ratio));
    ratio = event.key === "Enter" ? 41 : event.key === "Home" ? min : event.key === "End" ? max
      : Math.max(min, Math.min(max, current + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 5 : 1)));
    render(); save();
  });
  let width = -1;
  new ResizeObserver(() => {
    if (sheet.clientWidth === width) return;
    width = sheet.clientWidth;
    render();
  }).observe(sheet);
  render();
}
