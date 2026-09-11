export type SelectionRect = { left: number; right: number; top: number; bottom: number };
export type ReviewSourceSnapshot = {
  documentNodeId: string;
  sourceVersionId: string;
  punctuationVersionId: string | null;
  translationVersionId: string | null;
  from: number;
  to: number;
  quote: string;
};
export type ReviewSourceState = Omit<ReviewSourceSnapshot, "from" | "to" | "quote"> & { sourceText: string };

/** Check every line fragment; the whitespace between wrapped lines is not selected. */
export function selectionContainsPoint(rects: readonly SelectionRect[], x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && rects.some(rect => rect.right > rect.left && rect.bottom > rect.top
    && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
}

export function reviewContextMenuPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const margin = 8;
  const left = x + width + margin > viewportWidth ? x - width : x;
  const top = y + height + margin > viewportHeight ? y - height : y;
  return {
    left: Math.max(margin, Math.min(left, Math.max(margin, viewportWidth - width - margin))),
    top: Math.max(margin, Math.min(top, Math.max(margin, viewportHeight - height - margin))),
  };
}

/** A menu must not act on a different document/version or an altered source quote. */
export function sourceSnapshotIsCurrent(snapshot: ReviewSourceSnapshot, state: ReviewSourceState | null): boolean {
  if (!state || snapshot.documentNodeId !== state.documentNodeId || snapshot.sourceVersionId !== state.sourceVersionId
    || snapshot.punctuationVersionId !== state.punctuationVersionId || snapshot.translationVersionId !== state.translationVersionId
    || !Number.isInteger(snapshot.from) || !Number.isInteger(snapshot.to) || snapshot.from < 0 || snapshot.to <= snapshot.from
    || !snapshot.quote.trim()) return false;
  const source = Array.from(state.sourceText);
  return snapshot.to <= source.length && source.slice(snapshot.from, snapshot.to).join("") === snapshot.quote;
}

type MenuAction = { id: string; label: string; enabled: boolean; description?: string; run(): void };
type MenuInvocation = { target: EventTarget | null; keyboard: boolean };
type MenuSelection = { quote: string; rects: SelectionRect[]; actions: MenuAction[] };

/** The caller snapshots selection and validates it again inside each action. */
export function configureReviewContextMenu(root: HTMLElement, capture: (invocation: MenuInvocation) => MenuSelection | null) {
  const menu = document.createElement("div");
  menu.id = "reviewSelectionMenu";
  menu.className = "review-selection-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "선택한 원문 구절 작업");
  menu.tabIndex = -1;
  menu.hidden = true;
  document.body.append(menu);
  let actions: MenuAction[] = [];
  let previousFocus: HTMLElement | null = null;

  function close(restoreFocus = false): void {
    if (menu.hidden) return;
    const hadFocus = menu.contains(document.activeElement);
    menu.hidden = true;
    actions = [];
    if (restoreFocus && hadFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }

  function show(selection: MenuSelection, x: number, y: number): void {
    close();
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    actions = selection.actions;
    menu.replaceChildren();
    const quote = document.createElement("div");
    quote.className = "review-selection-menu-quote";
    quote.setAttribute("role", "presentation");
    quote.textContent = selection.quote;
    menu.append(quote);
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.tabIndex = -1;
      button.dataset.reviewSelectionAction = action.id;
      button.textContent = action.label;
      button.disabled = !action.enabled;
      if (action.description) button.title = action.description;
      menu.append(button);
    }
    menu.hidden = false;
    const bounds = menu.getBoundingClientRect();
    const position = reviewContextMenuPosition(x, y, bounds.width, bounds.height, window.innerWidth, window.innerHeight);
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
    (menu.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? menu).focus({ preventScroll: true });
  }

  root.addEventListener("contextmenu", event => {
    const selection = capture({ target: event.target, keyboard: false });
    const keyboard = event.clientX === 0 && event.clientY === 0;
    if (!selection || !keyboard && !selectionContainsPoint(selection.rects, event.clientX, event.clientY)) {
      close();
      return;
    }
    const rect = selection.rects.at(-1);
    if (!rect) return;
    event.preventDefault();
    // The editor also has an older block menu; only a selected phrase owns this event.
    event.stopImmediatePropagation();
    show(selection, keyboard ? rect.left : event.clientX, keyboard ? rect.bottom : event.clientY);
  }, true);

  document.addEventListener("keydown", event => {
    if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) {
      const selection = capture({ target: event.target, keyboard: true });
      const rect = selection?.rects.at(-1);
      if (!selection || !rect) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      show(selection, rect.left, rect.bottom);
      return;
    }
    if (menu.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : event.key === "ArrowDown" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
      buttons[index]?.focus({ preventScroll: true });
    }
  }, true);
  menu.addEventListener("pointerdown", event => event.preventDefault());
  menu.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-review-selection-action]") : null;
    const action = actions.find(item => item.id === button?.dataset.reviewSelectionAction);
    if (!action?.enabled) return;
    close();
    action.run();
  });
  document.addEventListener("pointerdown", event => { if (!(event.target instanceof Node) || !menu.contains(event.target)) close(); }, true);
  document.addEventListener("scroll", event => { if (!(event.target instanceof Node) || !menu.contains(event.target)) close(); }, true);
  document.addEventListener("focusin", event => { if (!(event.target instanceof Node) || !menu.contains(event.target)) close(); });
  window.addEventListener("resize", () => close());
  window.addEventListener("blur", () => close());
  return { close, isOpen: () => !menu.hidden };
}
