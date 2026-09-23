import { store } from "./shared";

export function configureTermSourceResize(host: HTMLElement): (sheet: HTMLElement) => void {
  const key = "munhae.terms.sourceRatio";
  const saved = Number.parseFloat(store.get(key) ?? "");
  let preferred = Number.isFinite(saved) ? Math.max(20, Math.min(80, saved)) : null;
  let sheet: HTMLElement | null = null;
  let handle: HTMLElement | null = null;
  let pointer: number | undefined;

  const limits = (): [number, number] => {
    const width = sheet!.clientWidth;
    return [Math.max(20, 240 / width * 100), Math.min(80, 100 - (width <= 950 ? 310 : 330) / width * 100)];
  };
  const finish = (): void => {
    if (pointer === undefined) return;
    const id = pointer;
    pointer = undefined;
    handle?.classList.remove("is-drag");
    document.body.classList.remove("is-term-source-resizing");
    if (handle?.hasPointerCapture(id)) handle.releasePointerCapture(id);
    store.set(key, preferred === null ? "" : String(preferred));
  };
  const render = (): void => {
    if (!sheet || !handle) return;
    if (sheet.clientWidth <= 680) { finish(); return; }
    const [min, max] = limits();
    const ratio = Math.max(min, Math.min(max, preferred ?? (sheet.clientWidth <= 950 ? 50 : 100 * 1.15 / 2.15)));
    sheet.style.setProperty("--term-source-width", `${ratio}%`);
    handle.setAttribute("aria-valuemin", String(Math.round(min)));
    handle.setAttribute("aria-valuemax", String(Math.round(max)));
    handle.setAttribute("aria-valuenow", String(Math.round(ratio)));
  };
  const isHandle = (target: EventTarget | null): boolean => target === handle;

  // Bind to the stable workspace: loading or refreshing terms replaces the panes.
  host.addEventListener("pointerdown", event => {
    if (!isHandle(event.target) || !sheet || sheet.clientWidth <= 680 || event.button !== 0 || !event.isPrimary || pointer !== undefined) return;
    event.preventDefault();
    pointer = event.pointerId;
    handle!.setPointerCapture(pointer);
    handle!.focus({ preventScroll: true });
    handle!.classList.add("is-drag");
    document.body.classList.add("is-term-source-resizing");
  });
  host.addEventListener("pointermove", event => {
    if (event.pointerId !== pointer || !sheet) return;
    const bounds = sheet.getBoundingClientRect();
    if (!bounds.width) { finish(); return; }
    const [min, max] = limits();
    preferred = Math.max(min, Math.min(max, (event.clientX - bounds.left) / bounds.width * 100));
    render();
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    host.addEventListener(name, event => { if (event.pointerId === pointer) finish(); });
  }
  window.addEventListener("blur", finish);
  host.addEventListener("dblclick", event => {
    if (!isHandle(event.target)) return;
    preferred = null;
    render();
    store.set(key, "");
  });
  host.addEventListener("keydown", event => {
    if (!isHandle(event.target) || !sheet || sheet.clientWidth <= 680 || !["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const [min, max] = limits();
    const current = Math.max(min, Math.min(max, preferred ?? (sheet.clientWidth <= 950 ? 50 : 100 * 1.15 / 2.15)));
    preferred = event.key === "Enter" ? null : event.key === "Home" ? min : event.key === "End" ? max
      : Math.max(min, Math.min(max, current + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 5 : 1)));
    render();
    store.set(key, preferred === null ? "" : String(preferred));
  });
  new ResizeObserver(render).observe(host);

  return target => {
    finish();
    sheet = target;
    handle = sheet.querySelector<HTMLElement>(".term-linked-divider");
    render();
  };
}
