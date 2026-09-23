import { ui } from "./i18n";

/** Group selection is separate from the active sentence and native text selection. */
export function configureSentenceSelection() {
  const rows = document.querySelector<HTMLElement>("#rows")!;
  const controls = document.querySelector<HTMLElement>("#sentenceSelectionControls")!;
  const count = document.querySelector<HTMLElement>("#sentenceSelectionCount")!;
  const allControl = document.querySelector<HTMLElement>("#sentenceSelectAllControl")!;
  const all = document.querySelector<HTMLInputElement>("#selectAllSentences")!;
  const selected = new Set<string>();
  let enabled = false;
  let scope = "";
  const groups = () => Array.from(rows.querySelectorAll<HTMLElement>(":scope > .sentence-group"));
  const key = (row: HTMLElement) => row.dataset.sentenceGroup ?? row.dataset.key ?? "";
  const visible = () => groups().filter(row => !row.hidden);

  function paint() {
    count.textContent = ui`${selected.size}개 선택`;
    controls.hidden = !enabled || selected.size === 0;
    const visibleRows = visible();
    const selectedCount = visibleRows.filter(row => selected.has(key(row))).length;
    all.disabled = !enabled || visibleRows.length === 0;
    all.checked = visibleRows.length > 0 && selectedCount === visibleRows.length;
    all.indeterminate = selectedCount > 0 && selectedCount < visibleRows.length;
    groups().forEach((row, index) => {
      let box = row.querySelector<HTMLInputElement>(".sentence-select-checkbox");
      if (!box && enabled) {
        box = document.createElement("input");
        box.type = "checkbox";
        box.className = "sentence-select-checkbox";
        row.querySelector(".sentence-selection-cell")?.append(box);
      }
      if (box) {
        box.hidden = !enabled;
        box.checked = selected.has(key(row));
        box.setAttribute("aria-label", ui`${index + 1}번 묶음 선택`);
      }
      row.classList.toggle("is-batch-selected", enabled && selected.has(key(row)));
    });
  }
  all.addEventListener("change", () => {
    if (all.checked) visible().forEach(row => selected.add(key(row)));
    else selected.clear();
    paint();
  });
  rows.addEventListener("click", event => {
    if ((event.target as HTMLElement).matches(".sentence-select-checkbox")) event.stopPropagation();
  }, true);
  rows.addEventListener("input", event => {
    if ((event.target as HTMLElement).matches(".sentence-select-checkbox")) event.stopPropagation();
  }, true);
  rows.addEventListener("change", event => {
    const box = event.target as HTMLInputElement;
    if (!box.matches(".sentence-select-checkbox")) return;
    const row = box.closest<HTMLElement>(".brow")!;
    if (box.checked) selected.add(key(row)); else selected.delete(key(row));
    paint();
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !selected.size || document.querySelector("dialog[open]")) return;
    selected.clear(); paint();
  });
  return {
    sync(nextScope: string, nextEnabled: boolean) {
      enabled = nextEnabled;
      if (scope !== nextScope || !enabled) { scope = nextScope; selected.clear(); }
      controls.hidden = !enabled;
      allControl.hidden = !enabled;
      const available = new Set(visible().map(key));
      for (const id of selected) if (!available.has(id)) selected.delete(id);
      paint();
    },
  };
}
