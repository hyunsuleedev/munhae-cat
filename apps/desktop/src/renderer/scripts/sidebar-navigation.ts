import { t } from "./i18n";
import { readSidebarSnapshot, sidebarStorageKey } from "./sidebar-model";

export class SidebarNavigation {
  readonly expanded = new Map<string, boolean>();
  query = "";
  private key: string | null = null;
  private focusKey: string | null = null;
  private scroll = 0;
  private root: HTMLElement | null = null;
  private redraw: (() => void) | null = null;
  private input: HTMLInputElement | null = null;
  private clear: HTMLButtonElement | null = null;
  private status: HTMLElement | null = null;
  private restoreFocus = false;
  private revision = 0;
  private searchScroll = 0;
  private restored = false;
  private pendingReveal = false;
  private observer: ResizeObserver | null = null;

  setProject(project: { projectId: string; packagePath: string }): void {
    const key = sidebarStorageKey(project);
    if (this.key === key) return;
    this.key = key;
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { /* storage is optional */ }
    const state = readSidebarSnapshot(raw);
    this.expanded.clear();
    state.expanded.forEach(([id, value]) => this.expanded.set(id, value));
    this.focusKey = state.focus;
    this.scroll = state.scroll;
    this.restored = false;
  }

  save(): void {
    if (!this.key) return;
    try {
      localStorage.setItem(this.key, JSON.stringify({ expanded: [...this.expanded], focus: this.focusKey, scroll: this.query ? this.searchScroll : this.scroll }));
    } catch { /* storage is optional */ }
  }

  mount(root: HTMLElement, redraw: () => void): void {
    this.redraw = redraw;
    if (this.root) return;
    this.root = root;
    const search = document.createElement("div");
    search.className = "sb-search";
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = t("문서 찾기");
    input.setAttribute("aria-label", t("제목·원제·경로로 문서 찾기"));
    input.setAttribute("aria-controls", "sbDocuments");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.title = `${t("문서 찾기")} (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}P)`;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "ic");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>';
    const shortcut = document.createElement("kbd");
    shortcut.textContent = navigator.platform.includes("Mac") ? "⌘P" : "Ctrl P";
    shortcut.setAttribute("aria-hidden", "true");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "×";
    clear.setAttribute("aria-label", t("검색 지우기"));
    clear.hidden = true;
    const status = document.createElement("span");
    status.className = "sb-search-status";
    status.setAttribute("role", "status");
    search.append(icon, input, shortcut, clear, status);
    root.before(search);
    this.input = input; this.clear = clear; this.status = status;
    input.addEventListener("input", () => {
      if (!this.query) this.searchScroll = this.scroll;
      this.query = input.value.trim();
      clear.hidden = !input.value;
      if (!this.query) this.scroll = this.searchScroll;
      this.redraw?.();
    });
    clear.addEventListener("click", () => { this.clearSearch(); input.focus(); });
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (input.value) this.clearSearch();
        else this.focus(this.items().find(item => item.tabIndex === 0) ?? this.items()[0]);
      } else if (event.key === "ArrowDown" || event.key === "Enter") {
        event.preventDefault(); event.stopPropagation();
        const item = this.items().find(row => row.dataset.go === "editor") ?? this.items()[0];
        this.focus(item);
        if (event.key === "Enter") item?.click();
      }
    });
    document.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.code === "KeyP" && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        // Use the existing toggle so its preference and titlebar state stay in sync.
        if (document.querySelector("#win")?.classList.contains("sb-hidden")) document.querySelector<HTMLButtonElement>("#tbSidebar")?.click();
        input.focus(); input.select();
      }
    });
    root.addEventListener("focusin", event => {
      const item = (event.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
      if (!item) return;
      this.focusKey = item.dataset.sbKey ?? null;
      this.items().forEach(row => { row.tabIndex = row === item ? 0 : -1; });
      this.save();
    });
    root.addEventListener("scroll", () => {
      // display:none during authentication must not overwrite the saved position.
      if (this.restored && root.clientHeight && !this.query) { this.scroll = root.scrollTop; this.save(); }
    }, { passive: true });
    root.addEventListener("keydown", event => this.onKey(event));
    window.addEventListener("pagehide", () => this.save());
  }

  clearSearch(): void {
    this.query = "";
    if (this.input) this.input.value = "";
    if (this.clear) this.clear.hidden = true;
    this.scroll = this.searchScroll;
    this.redraw?.();
  }

  beforeRender(): void {
    this.restoreFocus = !!this.root?.contains(document.activeElement) && document.activeElement?.getAttribute("role") === "treeitem";
    this.restored = false;
  }

  afterRender(reveal = false): void {
    const root = this.root;
    if (!root) return;
    this.pendingReveal ||= reveal;
    const items = this.items();
    const current = items.find(item => item.getAttribute("aria-current") === "page");
    const focused = items.find(item => item.dataset.sbKey === this.focusKey) ?? current ?? items[0];
    items.forEach(item => { item.tabIndex = item === focused ? 0 : -1; });
    if (this.restoreFocus) this.focus(focused, false);
    if (this.status) this.status.textContent = this.query ? `${items.filter(item => item.dataset.go === "editor").length} ${t("검색 결과")}` : "";
    const revision = ++this.revision;
    // The auth gate reveals the shell after the page module has finished loading.
    this.observer?.disconnect();
    const observer = this.observer = new ResizeObserver(() => {
      if (revision !== this.revision) { observer.disconnect(); return; }
      if (!root.clientHeight) return;
      observer.disconnect();
      root.scrollTop = this.query ? 0 : this.scroll;
      if (this.pendingReveal && current) this.scrollTo(current);
      this.pendingReveal = false;
      this.restored = true;
      if (!this.query) this.scroll = root.scrollTop;
    });
    observer.observe(root);
    this.save();
  }

  private items(): HTMLElement[] { return [...(this.root?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])]; }
  private scrollTo(item: HTMLElement): void {
    if (!this.root) return;
    const bounds = this.root.getBoundingClientRect(), row = item.getBoundingClientRect();
    if (row.top < bounds.top) this.root.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) this.root.scrollTop += row.bottom - bounds.bottom;
  }
  private focus(item?: HTMLElement, scroll = true): void {
    if (!item) return;
    item.focus({ preventScroll: true });
    if (scroll) this.scrollTo(item);
  }
  private onKey(event: KeyboardEvent): void {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const item = (event.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
    if (!item) return;
    const items = this.items(), index = items.indexOf(item), depth = Number(item.dataset.depth);
    let target: HTMLElement | undefined;
    if (event.key === "ArrowDown") target = items[Math.min(index + 1, items.length - 1)];
    else if (event.key === "ArrowUp") target = items[Math.max(0, index - 1)];
    else if (event.key === "Home") target = items[0];
    else if (event.key === "End") target = items.at(-1);
    else if (event.key === "ArrowRight") {
      if (item.getAttribute("aria-expanded") === "false") this.toggle(item, true);
      else if (Number(items[index + 1]?.dataset.depth) > depth) target = items[index + 1];
    } else if (event.key === "ArrowLeft") {
      if (item.getAttribute("aria-expanded") === "true" && !this.query) this.toggle(item, false);
      else target = items.slice(0, index).reverse().find(row => Number(row.dataset.depth) < depth);
    } else if (event.key === "Escape" && this.query) {
      this.clearSearch(); this.input?.focus();
    } else return; // Native button Enter/Space activation opens a document.
    event.preventDefault(); event.stopPropagation();
    this.focus(target);
  }
  private toggle(item: HTMLElement, value: boolean): void {
    const key = item.dataset.sbKey;
    if (!key) return;
    this.expanded.set(key, value);
    this.redraw?.();
  }
}
