type Transition = Pick<ViewTransition, "skipTransition" | "ready" | "finished">;
type RevealEvent = Event & { viewTransition?: Transition | null };
type SwapEvent = RevealEvent & { activation?: { entry?: { url?: string } } };

const WORK_PAGES = new Set(["index.html", "home.html", "editor.html", "context.html", "knowledge.html", "glossary.html", "comments.html", "settings.html", "community.html"]);
export const PAGE_TRANSITION_TIMEOUT = 1_500;

/** Keep the browser-owned outgoing snapshot until the authenticated page is ready.
 * No document contents or session state are copied into persistent storage.
 * A paused CSS animation holds the snapshot on Chromium versions without waitUntil.
 */
export function installPageTransition(
  target: Window,
  root: HTMLElement,
  showLoading: () => void,
) {
  let settled = false;
  let active: Transition | null = null;
  let timer: number | undefined;
  const skip = (transition: Transition) => {
    // Skipping before capture rejects ready; observe it even on fast/auth exits.
    void transition.ready.catch(() => undefined);
    transition.skipTransition();
  };

  const clear = () => {
    target.clearTimeout(timer);
    timer = undefined;
    root.removeAttribute("data-page-transition-pending");
  };
  const finish = () => {
    settled = true;
    const previous = active;
    active = null;
    clear();
    if (previous) skip(previous);
  };
  const reveal = (event: Event) => {
    const transition = (event as RevealEvent).viewTransition;
    if (!transition) return;
    // A fast page can finish initialization before pagereveal is dispatched.
    if (settled) { skip(transition); return; }
    if (active) skip(active);
    clear();
    active = transition;
    root.setAttribute("data-page-transition-pending", "");
    timer = target.setTimeout(() => {
      if (active !== transition) return;
      // Never expose protected DOM on timeout. Yield to the existing auth gate.
      showLoading();
      finish();
    }, PAGE_TRANSITION_TIMEOUT);
    void transition.ready.catch(() => {
      if (active === transition) { active = null; clear(); }
    });
    void transition.finished.then(() => {
      if (active === transition) { active = null; clear(); }
    }, () => {
      if (active === transition) { active = null; clear(); }
    });
  };
  const swap = (event: Event) => {
    const { viewTransition, activation } = event as SwapEvent;
    if (!viewTransition) return;
    const destination = activation?.entry?.url;
    let allowed = false;
    try {
      const current = new URL(target.location.href);
      const next = destination ? new URL(destination, current) : null;
      const page = next?.pathname.split("/").pop();
      allowed = !!next && next.origin === current.origin && next.protocol === current.protocol
        && !next.username && !next.password
        && next.pathname.slice(0, next.pathname.lastIndexOf("/")) === current.pathname.slice(0, current.pathname.lastIndexOf("/"))
        && !!page && WORK_PAGES.has(page);
    } catch { /* Unknown destinations cannot retain a protected snapshot. */ }
    // Do not retain a work screen over sign-out, recovery, or an external page.
    if (!allowed || target.document.body.hasAttribute("data-auth-pending")) {
      skip(viewTransition);
    }
  };
  target.addEventListener("pagereveal", reveal);
  target.addEventListener("pageswap", swap);
  return {
    pending: () => { settled = false; },
    finish,
    dispose: () => {
      finish();
      target.removeEventListener("pagereveal", reveal);
      target.removeEventListener("pageswap", swap);
    },
  };
}
