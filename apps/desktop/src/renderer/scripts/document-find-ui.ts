import { t, uiText, ui } from "./i18n";
import { literalMatches, replaceLiteral } from "./translation-checks";

export function configureDocumentFind(deps: {
  host: HTMLElement; trigger: HTMLElement; source(): string; translation(): string; editable(): boolean;
  apply(text: string, edits?: Array<{ from: number; to: number; text: string }>): void; locate(target: "source" | "translation", from: number, to: number): void;
}) {
  const panel = document.createElement("section");
  panel.className = "document-find"; panel.id = "documentFind"; panel.hidden = true;
  panel.setAttribute("aria-label", t("문서에서 찾기 및 바꾸기"));
  panel.setAttribute("role", "dialog");
  panel.innerHTML = uiText(`<div class="document-find-head"><strong>찾기·바꾸기</strong><button class="btn btn-sm" data-find-close type="button" aria-label="찾기·바꾸기 닫기">닫기 <kbd>Esc</kbd></button></div>
    <div class="document-find-row"><input class="input" data-find-query aria-label="문서에서 찾을 구절" placeholder="문서에서 찾을 구절"><select class="select" data-find-target aria-label="찾기 범위"><option value="translation">번역문</option><option value="source">원문</option></select><button class="btn btn-sm" data-find-prev type="button" aria-label="이전 검색 결과">↑</button><button class="btn btn-sm" data-find-next type="button" aria-label="다음 검색 결과">↓</button></div>
    <div class="document-find-row" data-replace-row><input class="input" data-replace-value aria-label="바꿀 표현" placeholder="바꿀 표현"><button class="btn btn-sm" data-replace-one type="button">이곳 바꾸기</button><button class="btn btn-sm" data-replace-all type="button">모두 바꾸기</button><button class="btn btn-sm" data-replace-undo type="button" disabled>바꾸기 취소</button></div><p data-find-status role="status"></p>`);
  document.body.append(panel);
  deps.trigger.setAttribute("aria-controls", panel.id);
  deps.trigger.setAttribute("aria-haspopup", "dialog");
  deps.trigger.setAttribute("aria-expanded", "false");
  const query = panel.querySelector<HTMLInputElement>("[data-find-query]")!;
  const replacement = panel.querySelector<HTMLInputElement>("[data-replace-value]")!;
  const target = panel.querySelector<HTMLSelectElement>("[data-find-target]")!;
  const status = panel.querySelector<HTMLElement>("[data-find-status]")!;
  let index = 0;
  let undo: { before: string; after: string; edits: Array<{ from: number; to: number; text: string }> } | null = null;
  let returnFocus: HTMLElement | null = null;
  function position() {
    if (panel.hidden) return;
    const bounds = (deps.host.closest(".pane-center") ?? deps.host).getBoundingClientRect();
    panel.style.left = `${Math.max(12, Math.min(bounds.right - panel.offsetWidth - 12, window.innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(bounds.top + 12, window.innerHeight - panel.offsetHeight - 12))}px`;
  }
  function close(restoreFocus = true) {
    const hadFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    deps.trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && hadFocus) (returnFocus?.isConnected ? returnFocus : deps.trigger).focus({ preventScroll: true });
  }
  window.addEventListener("resize", position);
  new ResizeObserver(position).observe(panel);
  const text = () => target.value === "source" ? deps.source() : deps.translation();
  function render(locate = false) {
    const matches = literalMatches(text(), query.value);
    index = Math.max(0, Math.min(index, matches.length - 1));
    const can = target.value === "translation" && deps.editable();
    panel.querySelector<HTMLElement>("[data-replace-row]")!.hidden = target.value === "source";
    for (const key of ["prev", "next"]) panel.querySelector<HTMLButtonElement>(`[data-find-${key}]`)!.disabled = !matches.length;
    for (const key of ["one", "all"]) panel.querySelector<HTMLButtonElement>(`[data-replace-${key}]`)!.disabled = !can || !matches.length || query.value === replacement.value;
    panel.querySelector<HTMLButtonElement>("[data-replace-undo]")!.disabled = !can || !undo || deps.translation() !== undo.after;
    panel.querySelector("[data-replace-all]")!.textContent = matches.length ? ui`${matches.length}곳 모두 바꾸기` : t("모두 바꾸기");
    status.textContent = !query.value ? t("구절을 그대로 찾습니다. 바꾸기는 번역 작업안에 적용되며 저장 전에 취소할 수 있습니다.") : ui`${matches.length ? index + 1 : 0} / ${matches.length}곳${target.value === "translation" && !can ? t(" · 읽기 전용") : ""}${matches.length && can ? ` · ‘${query.value}’ → ‘${replacement.value || t("(삭제)")}’` : ""}`;
    if (locate && matches[index]) deps.locate(target.value as "source" | "translation", matches[index]!.from, matches[index]!.to);
  }
  function change(all: boolean) {
    if (target.value !== "translation" || !deps.editable() || !query.value) return;
    const before = deps.translation();
    const match = literalMatches(before, query.value)[index];
    if (!match) return;
    const after = all ? replaceLiteral(before, query.value, replacement.value) : before.slice(0, match.from) + replacement.value + before.slice(match.to);
    const edits = (all ? literalMatches(before, query.value) : [match]).map(range => ({ ...range, text: replacement.value }));
    let delta = 0;
    const inverse = edits.map(edit => {
      const from = edit.from + delta;
      delta += edit.text.length - (edit.to - edit.from);
      return { from, to: from + edit.text.length, text: before.slice(edit.from, edit.to) };
    });
    deps.apply(after, edits); undo = deps.translation() === after ? { before, after, edits: inverse } : null; render(false);
  }
  panel.querySelector("[data-replace-one]")!.addEventListener("click", () => change(false));
  panel.querySelector("[data-replace-all]")!.addEventListener("click", () => change(true));
  panel.querySelector("[data-replace-undo]")!.addEventListener("click", () => { if (undo && deps.editable() && deps.translation() === undo.after) { deps.apply(undo.before, undo.edits); undo = null; render(); } });
  panel.querySelector("[data-find-prev]")!.addEventListener("click", () => { const count = literalMatches(text(), query.value).length; index = (index - 1 + count) % (count || 1); render(true); });
  panel.querySelector("[data-find-next]")!.addEventListener("click", () => { const count = literalMatches(text(), query.value).length; index = (index + 1) % (count || 1); render(true); });
  query.addEventListener("input", () => { index = 0; render(); });
  query.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); render(true); } });
  replacement.addEventListener("input", () => render());
  target.addEventListener("change", () => { index = 0; render(); });
  panel.querySelector("[data-find-close]")!.addEventListener("click", () => close());
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || panel.hidden || document.querySelector("dialog[open]")) return;
    event.preventDefault(); event.stopPropagation(); close();
  }, true);
  return { open(value = "") {
    if (panel.hidden) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : deps.trigger;
    panel.hidden = false; deps.trigger.setAttribute("aria-expanded", "true");
    if (value) query.value = value;
    index = 0; render(); position(); query.focus({ preventScroll: true }); query.select();
  }, refresh() { if (!panel.hidden) render(); }, reset() { close(false); undo = null; query.value = ""; } };
}
