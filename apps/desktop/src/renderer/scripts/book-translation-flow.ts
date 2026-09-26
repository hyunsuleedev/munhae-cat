import type { TextSentence } from "@munhae/domain/text-sentences";
import { t, ui } from "./i18n";
import { textStyleProperties } from "./review-marks";

export type BookEditChunk = { type: "equal" | "remove" | "insert"; text: string };

/** What the editing card shows next to the live field. */
export type BookEditCard = {
  before: string;
  after: string;
  position: string;
  review: "needed" | "done" | null;
  canSplit: boolean;
  collapsed: boolean;
  locked: boolean;
};

// Word runs, whitespace runs, then single punctuation marks.
const EDIT_TOKEN = /[\p{L}\p{N}\p{M}]+|\s+|[^]/gu;

/** Word-level diff for one group; groups are short, so a plain LCS stays cheap. */
export function bookEditDiff(before: string, after: string): BookEditChunk[] {
  const a = before.match(EDIT_TOKEN) ?? [], b = after.match(EDIT_TOKEN) ?? [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail), y = b.slice(head, b.length - tail);
  const tokens: BookEditChunk[] = [];
  if (x.length * y.length > 250_000) {
    tokens.push({ type: "remove", text: x.join("") }, { type: "insert", text: y.join("") });
  } else {
    const width = y.length + 1, lcs = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * width + j] = x[i] === y[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { tokens.push({ type: "equal", text: x[i]! }); i++; j++; }
      else if (i < x.length && (j === y.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) { tokens.push({ type: "remove", text: x[i]! }); i++; }
      else { tokens.push({ type: "insert", text: y[j]! }); j++; }
    }
  }
  // A lone space between two edits reads as part of one change, not two.
  const middle = tokens.map((token, index) => token.type === "equal" && /^\s+$/.test(token.text)
    && tokens[index - 1] && tokens[index - 1]!.type !== "equal" && tokens[index + 1] && tokens[index + 1]!.type !== "equal"
    ? [{ type: "remove" as const, text: token.text }, { type: "insert" as const, text: token.text }] : [token]).flat();
  const chunks: BookEditChunk[] = [];
  const equal = (text: string) => {
    const last = chunks.at(-1);
    if (!text) return;
    if (last?.type === "equal") last.text += text; else chunks.push({ type: "equal", text });
  };
  let removed = "", inserted = "";
  // Within a replaced word keep the shared stem, so a changed particle marks only the particle.
  const flush = () => {
    const r = Array.from(removed), n = Array.from(inserted);
    let p = 0;
    while (p < r.length && p < n.length && r[p] === n[p]) p++;
    let q = 0;
    while (q < r.length - p && q < n.length - p && r[r.length - 1 - q] === n[n.length - 1 - q]) q++;
    equal(r.slice(0, p).join(""));
    if (r.length - p - q > 0) chunks.push({ type: "remove", text: r.slice(p, r.length - q).join("") });
    if (n.length - p - q > 0) chunks.push({ type: "insert", text: n.slice(p, n.length - q).join("") });
    equal(r.slice(r.length - q).join(""));
    removed = inserted = "";
  };
  for (const token of [{ type: "equal" as const, text: a.slice(0, head).join("") }, ...middle, { type: "equal" as const, text: a.slice(a.length - tail).join("") }]) {
    if (token.type === "remove") removed += token.text;
    else if (token.type === "insert") inserted += token.text;
    else { flush(); equal(token.text); }
  }
  flush();
  return chunks;
}

const chevron = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

function clipped(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return Array.from(flat).length > 60 ? `${Array.from(flat).slice(0, 60).join("")}…` : flat;
}

/** Each edit run (a removal, an addition, or a replacement) shares one index across both texts. */
function changeRuns(chunks: readonly BookEditChunk[]): (number | null)[] {
  let run = -1;
  return chunks.map((chunk, index) => {
    if (chunk.type === "equal") return null;
    if (!(chunk.type === "insert" && chunks[index - 1]?.type === "remove")) run++;
    return run;
  });
}

/** Marks hug the words; surrounding spaces stay plain unless the change is only space. */
function tightMark(mark: HTMLElement, text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const [, lead = "", body = "", trail = ""] = /^(\s*)([^]*?)(\s*)$/.exec(text) ?? [];
  mark.textContent = body || text;
  if (body) out.append(lead, mark, trail); else out.append(mark);
  return out;
}

function beforeText(chunks: readonly BookEditChunk[]): DocumentFragment {
  const out = document.createDocumentFragment(), runs = changeRuns(chunks);
  chunks.forEach((chunk, index) => {
    if (chunk.type === "equal") { out.append(chunk.text); return; }
    const next = chunks[index + 1];
    if (chunk.type === "remove") {
      const mark = document.createElement("del");
      mark.className = /^\s+$/.test(chunk.text) ? "book-edit-del is-space" : "book-edit-del";
      mark.dataset.change = String(runs[index]);
      mark.title = next?.type === "insert" ? ui`바뀐 내용: ${clipped(next.text)}` : t("삭제됨");
      out.append(tightMark(mark, chunk.text));
    } else if (chunks[index - 1]?.type !== "remove") {
      const mark = document.createElement("span");
      mark.className = "book-edit-ins";
      mark.dataset.change = String(runs[index]);
      mark.title = ui`추가: ${clipped(chunk.text)}`;
      out.append(mark);
    }
  });
  return out;
}

/** The new wording, laid out exactly like the field above it, with only added text painted. */
function afterText(chunks: readonly BookEditChunk[]): DocumentFragment {
  const out = document.createDocumentFragment(), runs = changeRuns(chunks);
  chunks.forEach((chunk, index) => {
    if (chunk.type === "equal") out.append(chunk.text);
    else if (chunk.type === "insert") {
      const mark = document.createElement("mark");
      mark.className = /^\s+$/.test(chunk.text) ? "book-edit-added is-space" : "book-edit-added";
      mark.dataset.change = String(runs[index]);
      out.append(tightMark(mark, chunk.text));
    }
  });
  // A trailing newline only gets a line box when something follows it.
  out.append("\u200b");
  return out;
}

/** Edit chrome lives only on the group being edited, so reading-mode text offsets never see it.
 * Labels follow the pane headers (原文 / 譯文): the saved wording is 舊譯, the live field 新譯. */
function renderBookEditCard(box: HTMLElement, field: HTMLTextAreaElement, card: BookEditCard | null): void {
  let before = box.querySelector<HTMLElement>(":scope > .book-edit-before");
  let now = box.querySelector<HTMLElement>(":scope > .book-edit-now");
  let after = box.querySelector<HTMLElement>(":scope > .book-edit-after");
  let foot = box.querySelector<HTMLElement>(":scope > .book-edit-foot");
  if (!card) { box.querySelectorAll(":scope > .book-edit-chrome").forEach(item => item.remove()); return; }
  if (!before) {
    before = document.createElement("span");
    before.className = "book-edit-before book-edit-chrome";
    before.innerHTML = `<span class="book-edit-meta"><button type="button" class="book-edit-label" data-book-edit-toggle>舊譯<small>${t("저장본")}</small>${chevron}</button><span class="book-edit-summary"></span><button type="button" class="btn btn-ghost btn-sm" data-book-edit-revert title="${t("이 묶음을 마지막 저장본으로 되돌립니다")}">${t("원래대로")}</button></span><span class="book-edit-before-text"></span>`;
    box.querySelector(".book-group-text")!.after(before);
  }
  if (!now) {
    now = document.createElement("span");
    now.className = "book-edit-meta book-edit-now book-edit-chrome";
    now.innerHTML = `<span class="book-edit-label is-now">新譯<small>${t("편집 중")}</small></span><span class="book-edit-position"></span>`;
    before.after(now);
  }
  if (!after) {
    after = document.createElement("span");
    after.className = "book-edit-after book-edit-chrome";
    after.setAttribute("aria-hidden", "true");
    field.before(after);
  }
  if (!foot) {
    foot = document.createElement("span");
    foot.className = "sentence-actions book-edit-foot book-edit-chrome";
    foot.innerHTML = `<span class="sentence-state book-edit-state"></span><button type="button" class="btn btn-ghost btn-sm" data-split-group="">${t("여기서 나누기")}</button><button type="button" class="btn btn-ghost btn-sm" data-book-edit-done>${t("편집 마침")}<kbd>esc</kbd></button>`;
    field.after(foot);
  }
  const chunks = bookEditDiff(card.before, card.after);
  const changes = chunks.filter((chunk, index) => chunk.type !== "equal" && chunks[index - 1]?.type !== "remove").length;
  const signature = JSON.stringify([card.before, card.after]);
  const text = before.querySelector<HTMLElement>(".book-edit-before-text")!;
  if (text.dataset.signature !== signature) { text.replaceChildren(beforeText(chunks)); text.dataset.signature = signature; }
  if (after.dataset.signature !== signature) { after.replaceChildren(afterText(chunks)); after.dataset.signature = signature; }
  const style = getComputedStyle(field);
  for (const property of textStyleProperties) after.style.setProperty(property, style.getPropertyValue(property));
  before.dataset.collapsed = String(card.collapsed);
  before.dataset.changes = String(changes);
  const toggle = before.querySelector<HTMLButtonElement>("[data-book-edit-toggle]")!;
  toggle.setAttribute("aria-expanded", String(!card.collapsed));
  toggle.title = card.collapsed ? t("편집 전 원문 펼치기") : t("편집 전 원문 접기");
  before.querySelector(".book-edit-summary")!.textContent = changes ? ui`바뀐 곳 ${changes}` : t("변경 없음");
  before.querySelector<HTMLButtonElement>("[data-book-edit-revert]")!.disabled = card.locked || !changes;
  now.querySelector(".book-edit-position")!.textContent = card.position;
  const state = foot.querySelector<HTMLElement>(".book-edit-state")!;
  state.dataset.state = card.review ?? "";
  state.textContent = card.review === "needed" ? t("대응 확인 필요") : card.review === "done" ? t("대응 확인됨") : "";
  const split = foot.querySelector<HTMLButtonElement>("[data-split-group]")!;
  split.hidden = !card.canSplit;
  split.dataset.splitGroup = box.dataset.bookGroup ?? "";
  split.disabled = card.locked;
}

/** Reading order and whitespace come from the exact draft, not group boundaries. */
export function bookFlowParts(text: string, sentences: readonly TextSentence[]) {
  const points = Array.from(text);
  const parts: { id?: string; from: number; to: number; text: string }[] = [];
  let cursor = 0;
  for (const sentence of sentences) {
    parts.push({ from: cursor, to: sentence.from, text: points.slice(cursor, sentence.from).join("") });
    parts.push({ id: sentence.id, from: sentence.from, to: sentence.to, text: points.slice(sentence.from, sentence.to).join("") });
    cursor = sentence.to;
  }
  parts.push({ from: cursor, to: points.length, text: points.slice(cursor).join("") });
  return parts;
}

export function renderBookFlow(root: HTMLElement, text: string, sentences: readonly TextSentence[], selectedId: string | null, editingId: string | null, card: BookEditCard | null = null) {
  const parts = bookFlowParts(text, sentences);
  const ids = sentences.map(sentence => sentence.id).join("|");
  const rebuilt = root.dataset.ids !== ids || root.children.length !== parts.length;
  if (rebuilt) {
    root.dataset.ids = ids;
    root.replaceChildren(...parts.map((part, index) => {
      const element = document.createElement("span");
      if (part.id) {
        element.className = "book-group";
        element.dataset.bookGroup = part.id;
        element.tabIndex = 0;
        element.setAttribute("aria-label", `번역 묶음 ${Math.ceil(index / 2)}`);
        const body = document.createElement("span"); body.className = "book-group-text";
        const field = document.createElement("textarea");
        field.className = "sentence-edit"; field.dataset.sentenceEdit = part.id;
        field.setAttribute("aria-label", element.getAttribute("aria-label")!);
        field.spellcheck = false; field.rows = 1; field.hidden = true;
        element.append(body, field);
      } else element.className = "book-flow-gap";
      return element;
    }));
  }
  root.dataset.translationText = text;
  parts.forEach((part, index) => {
    const box = root.children[index] as HTMLElement;
    const body = part.id ? box.querySelector<HTMLElement>(".book-group-text")! : box;
    if (body.textContent !== part.text) body.textContent = part.text;
    // A plain space after the editing card would otherwise indent the next line.
    if (!part.id) box.classList.toggle("is-inline-space", /^[ \t]+$/.test(part.text));
    body.dataset.reviewTranslationFrom = String(part.from);
    body.dataset.reviewTranslationTo = String(part.to);
    if (!part.id) return;
    const editing = editingId === part.id;
    const field = box.querySelector<HTMLTextAreaElement>("textarea")!;
    if (field.value !== part.text.replace(/\r\n?/g, "\n")) field.value = part.text;
    field.hidden = !editing;
    body.hidden = editing;
    box.classList.toggle("is-editing", editing);
    box.classList.toggle("is-selected", selectedId === part.id);
    renderBookEditCard(box, field, editing ? card : null);
  });
  return rebuilt;
}

/** UTF-16 offsets for find/navigation, matching the original full-text input. */
export function bookFlowRange(root: HTMLElement, from: number, to: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest("textarea, .review-textarea-mirror, .book-edit-chrome") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const range = document.createRange();
  let offset = 0, started = false, node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!started && from <= offset + length) { range.setStart(node, Math.max(0, from - offset)); started = true; }
    if (started && to <= offset + length) { range.setEnd(node, Math.max(0, to - offset)); return range; }
    offset += length;
  }
  return null;
}

/** A paragraph break is named by the group after it; only line breaks between two groups qualify. */
export function bookGapBefore(text: string, sentences: readonly TextSentence[], id: string): { from: number; to: number } | null {
  const index = sentences.findIndex(sentence => sentence.id === id);
  if (index < 1) return null;
  const from = sentences[index - 1]!.to, to = sentences[index]!.from;
  const gap = Array.from(text).slice(from, to).join("");
  return /^\s*[\r\n]\s*$/u.test(gap) ? { from, to } : null;
}

/** Removing a paragraph break joins the two groups with one space, as sentences sit within a paragraph. */
export function joinBookGap(text: string, sentences: readonly TextSentence[], id: string): string | null {
  const gap = bookGapBefore(text, sentences, id);
  if (!gap) return null;
  const points = Array.from(text);
  return points.slice(0, gap.from).join("") + " " + points.slice(gap.to).join("");
}

/** The paragraph break under a double-click: its blank line, or the empty space after a paragraph's last word. */
export function bookGapAtPoint(root: HTMLElement, x: number, y: number): string | null {
  const caret = document.caretRangeFromPoint?.(x, y);
  const node = caret?.startContainer;
  const element = node instanceof Element ? node : node?.parentElement;
  if (!caret || !element || !root.contains(element)) return null;
  let gap = element.closest<HTMLElement>(".book-flow-gap");
  const body = element.closest<HTMLElement>(".book-group-text");
  if (!gap && body) {
    const before = document.createRange(); before.selectNodeContents(body); before.setEnd(caret.startContainer, caret.startOffset);
    if (before.toString().length === body.textContent?.length) gap = body.closest(".book-group")?.nextElementSibling as HTMLElement | null;
  }
  const next = gap?.nextElementSibling as HTMLElement | null | undefined;
  return gap?.classList.contains("book-flow-gap") && /[\r\n]/.test(gap.textContent ?? "") && next?.dataset.bookGroup ? next.dataset.bookGroup : null;
}

/** Selection chrome carries no text of its own, so the gap's text and every flow offset stay exact.
 * A blank line gets a band filling it; a bare line break gets a mark at the end of its line. */
export function markBookGap(root: HTMLElement, id: string | null): HTMLElement | null {
  const box = id ? [...root.querySelectorAll<HTMLElement>("[data-book-group]")].find(item => item.dataset.bookGroup === id) : null;
  const gap = box?.previousElementSibling as HTMLElement | null | undefined;
  const text = gap?.textContent ?? "";
  const valid = !!gap?.classList.contains("book-flow-gap") && !!box?.previousElementSibling?.previousElementSibling && /[\r\n]/.test(text);
  const current = root.querySelector<HTMLElement>(".book-gap-mark");
  if (valid && current && current.parentElement === gap && current.dataset.text === text) return current;
  if (current) { const parent = current.parentElement; current.remove(); parent?.classList.remove("is-selected"); parent?.normalize(); }
  if (!valid || !gap) return null;
  const breaks = [...text.matchAll(/\r\n|\r|\n/g)];
  const blank = breaks.length > 1;
  const mark = document.createElement("span");
  mark.className = `book-gap-mark book-edit-chrome${blank ? "" : " is-line"}`;
  mark.tabIndex = -1;
  mark.setAttribute("role", "button");
  mark.setAttribute("aria-label", blank ? t("문단 사이 빈 줄. Backspace를 누르면 지웁니다.") : t("문단 사이 줄바꿈. Backspace를 누르면 지웁니다."));
  mark.dataset.hint = blank ? t("⌫ 빈 줄 지우기") : t("⌫ 줄바꿈 지우기");
  mark.dataset.text = text;
  const first = breaks[0]!;
  gap.normalize();
  const rest = (gap.firstChild as Text).splitText(blank ? first.index! + first[0].length : first.index!);
  gap.insertBefore(mark, rest);
  gap.classList.add("is-selected");
  return mark;
}

export function bookGroupCaret(root: HTMLElement, id: string): number | null {
  return bookGroupSelection(root, id)?.focus ?? null;
}

/** Reading-mode selection inside one group, as UTF-16 offsets into its text. */
export function bookGroupSelection(root: HTMLElement, id: string): { start: number; end: number; focus: number } | null {
  const selection = window.getSelection();
  const box = [...root.querySelectorAll<HTMLElement>("[data-book-group]")].find(item => item.dataset.bookGroup === id);
  const body = box?.querySelector(".book-group-text");
  if (!body || !selection?.focusNode || !body.contains(selection.focusNode)) return null;
  const offset = (node: Node, at: number) => {
    const before = document.createRange(); before.selectNodeContents(body);
    before.setEnd(node, at);
    return before.toString().length;
  };
  const focus = offset(selection.focusNode, selection.focusOffset);
  const anchor = selection.anchorNode && body.contains(selection.anchorNode) ? offset(selection.anchorNode, selection.anchorOffset) : focus;
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus), focus };
}
