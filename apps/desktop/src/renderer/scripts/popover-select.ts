// shadcn Select-style trigger + listbox popover that drives a hidden native <select>.
// The native element stays the source of truth: value, disabled and "change" keep working.
let nextId = 0;

export function mountPopoverSelect(select: HTMLSelectElement, className = ""): HTMLButtonElement {
  const id = `psel-${++nextId}`;
  const anchor = `--${id}`;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = `psel-trigger ${className}`.trim();
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", id);
  trigger.style.setProperty("anchor-name", anchor);
  const label = document.createElement("span"); label.className = "psel-value";
  const chevron = document.createElement("span"); chevron.className = "psel-chevron"; chevron.setAttribute("aria-hidden", "true");
  trigger.append(label, chevron);

  const list = document.createElement("div");
  list.id = id; list.className = "psel-content"; list.popover = "auto";
  list.setAttribute("role", "listbox");
  list.style.setProperty("position-anchor", anchor);

  const options = () => [...list.querySelectorAll<HTMLElement>("[role=option]")];
  const sync = () => {
    const current = select.selectedOptions[0];
    label.textContent = current?.textContent ?? "";
    trigger.disabled = select.disabled;
    const aria = select.getAttribute("aria-label");
    if (aria) { trigger.setAttribute("aria-label", `${aria}: ${label.textContent}`); list.setAttribute("aria-label", aria); }
  };
  const render = () => {
    list.replaceChildren(...[...select.options].map(option => {
      const item = document.createElement("div");
      item.className = "psel-item"; item.setAttribute("role", "option"); item.tabIndex = -1;
      item.dataset.value = option.value;
      item.setAttribute("aria-selected", String(option.selected));
      item.textContent = option.textContent;
      return item;
    }));
  };
  const choose = (value: string) => {
    list.hidePopover();
    trigger.focus({ preventScroll: true });
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
  };

  trigger.addEventListener("click", () => { if (!trigger.disabled) list.togglePopover(); });
  trigger.addEventListener("keydown", event => {
    if (["ArrowDown", "ArrowUp"].includes(event.key) && !trigger.disabled) { event.preventDefault(); list.showPopover(); }
  });
  list.addEventListener("toggle", event => {
    const open = (event as ToggleEvent).newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (!open) return;
    render();
    list.style.minWidth = `${trigger.offsetWidth}px`;
    (options().find(item => item.getAttribute("aria-selected") === "true") ?? options()[0])?.focus({ preventScroll: true });
  });
  list.addEventListener("click", event => {
    const item = (event.target as Element).closest<HTMLElement>("[role=option]");
    if (item?.dataset.value !== undefined) choose(item.dataset.value);
  });
  list.addEventListener("pointermove", event => {
    const item = (event.target as Element).closest<HTMLElement>("[role=option]");
    if (item && document.activeElement !== item) item.focus({ preventScroll: true });
  });
  list.addEventListener("keydown", event => {
    const items = options();
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); const value = items[index]?.dataset.value; if (value !== undefined) choose(value); }
    else if (event.key === "Escape") { event.preventDefault(); list.hidePopover(); trigger.focus({ preventScroll: true }); }
    else if (event.key === "Tab") list.hidePopover();
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
    }
  });

  select.hidden = true;
  select.tabIndex = -1;
  select.after(trigger, list);
  new MutationObserver(sync).observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
  select.addEventListener("change", sync);
  sync();
  return trigger;
}
