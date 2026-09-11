/** Textareas normalize CRLF/CR to LF; stored range coordinates must retain them. */
export function textareaRange(raw: string, from: number, to: number) {
  const boundaries = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\r" && raw[i + 1] === "\n") i++;
    boundaries.push(i + 1);
  }
  const start = boundaries[from];
  const end = boundaries[to];
  if (!Number.isInteger(from) || !Number.isInteger(to) || start === undefined || end === undefined || to <= from) return null;
  return {
    from: Array.from(raw.slice(0, start)).length,
    to: Array.from(raw.slice(0, end)).length,
    quote: raw.slice(start, end),
  };
}

export function textareaOffset(raw: string, codepoint: number): number {
  return Array.from(raw).slice(0, codepoint).join("").replace(/\r\n?/g, "\n").length;
}

export type SourceDisplay = { text: string; sourceText: string; sourceFrom: number; boundaries: number[] };

/** A displayed punctuation mark can occupy space without consuming a source character. */
export function sourceRangeFromDisplay(display: SourceDisplay, from: number, to: number) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to >= display.boundaries.length) return null;
  const start = display.boundaries[from]!;
  const end = display.boundaries[to]!;
  const quote = Array.from(display.sourceText).slice(start - display.sourceFrom, end - display.sourceFrom).join("");
  if (end <= start || !quote.trim()) return null;
  return { from: start, to: end, quote };
}

export function sourceDisplayFromElement(element: HTMLElement): SourceDisplay | null {
  const text = element.textContent ?? "";
  const sourceText = element.dataset.reviewSourceQuote ?? text;
  const sourceFrom = Number(element.dataset.reviewSourceFrom);
  const sourceTo = Number(element.dataset.reviewSourceTo);
  const count = Array.from(text).length;
  if (!Number.isInteger(sourceFrom) || !Number.isInteger(sourceTo) || sourceFrom < 0 || sourceTo <= sourceFrom || Array.from(sourceText).length !== sourceTo - sourceFrom) return null;
  let boundaries: unknown;
  try { boundaries = element.dataset.reviewSourceMap ? JSON.parse(element.dataset.reviewSourceMap) : Array.from({ length: count + 1 }, (_, i) => sourceFrom + i); }
  catch { return null; }
  if (!Array.isArray(boundaries) || boundaries.length !== count + 1
    || boundaries.some((value, i) => !Number.isInteger(value) || value < sourceFrom || value > sourceTo || (i > 0 && value < boundaries[i - 1]))) return null;
  return { text, sourceText, sourceFrom, boundaries };
}

/** Match the canonical quote first, then decorate its displayed characters. */
export function displayRangeFromSource(display: SourceDisplay, from: number, to: number, quote: string) {
  const start = from - display.sourceFrom, end = to - display.sourceFrom;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > Array.from(display.sourceText).length) return null;
  if (Array.from(display.sourceText).slice(start, end).join("") !== quote) return null;
  let first = -1, last = -1;
  for (let i = 0; i < display.boundaries.length - 1; i++) {
    if (display.boundaries[i + 1]! > display.boundaries[i]! && display.boundaries[i]! < to && display.boundaries[i + 1]! > from) {
      if (first < 0) first = i;
      last = i + 1;
    }
  }
  return first < 0 ? null : { from: first, to: last };
}
