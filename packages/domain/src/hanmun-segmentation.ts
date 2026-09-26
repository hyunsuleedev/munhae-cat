/** Text is authoritative; ranges never own surrounding layout whitespace. */
export const HANMUN_SEGMENTATION_VERSION = 2;
export type HanmunStructureSpan = {
  spanKey: string;
  spanKind: "paragraph" | "sentence" | "verse_line";
  parentSpanKey: string | null;
  ordinal: number;
  codepointFrom: number;
  codepointTo: number;
};

const whitespace = /\s/u;
const terminator = /[。．！？!?]/u;
const closing = /^(?:\p{Pe}|\p{Pf}|[」』】》〉〕〗〙〛])$/u;

export function trimHanmunRange(points: readonly string[], from: number, to: number): { from: number; to: number } {
  while (from < to && whitespace.test(points[from]!)) from++;
  while (to > from && whitespace.test(points[to - 1]!)) to--;
  return { from, to };
}

/** Prose uses line breaks for paragraphs; poetry uses blank lines and keeps each verse line. */
export function segmentHanmun(text: string, mode: "prose" | "poetry" = "prose"): HanmunStructureSpan[] {
  const points = Array.from(text);
  const spans: HanmunStructureSpan[] = [];
  type Range = { from: number; to: number };
  let paragraphLines: Range[] = [];
  let paragraphNo = 0;
  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const from = paragraphLines[0]!.from;
    const to = paragraphLines[paragraphLines.length - 1]!.to;
    const key = `p${++paragraphNo}`;
    spans.push({ spanKey: key, spanKind: "paragraph", parentSpanKey: null, ordinal: paragraphNo,
      codepointFrom: from, codepointTo: to });
    let ordinal = 0;
    const add = (start: number, end: number) => {
      const range = trimHanmunRange(points, start, end);
      if (range.from === range.to) return;
      spans.push({ spanKey: `${key}-${mode === "poetry" ? "v" : "s"}${++ordinal}`,
        spanKind: mode === "poetry" ? "verse_line" : "sentence", parentSpanKey: key, ordinal,
        codepointFrom: range.from, codepointTo: range.to });
    };
    if (mode === "poetry") {
      for (const line of paragraphLines) add(line.from, line.to);
    } else {
      let sentenceStart = from;
      for (let cursor = from; cursor < to; cursor++) {
        if (!terminator.test(points[cursor]!)) continue;
        let end = cursor + 1;
        while (end < to && (closing.test(points[end]!) || terminator.test(points[end]!))) end++;
        add(sentenceStart, end);
        sentenceStart = end;
        cursor = end - 1;
      }
      add(sentenceStart, to);
    }
    paragraphLines = [];
  };
  let start = 0;
  for (let end = 0; end <= points.length; end++) {
    if (end < points.length && points[end] !== "\n" && points[end] !== "\r") continue;
    const line = trimHanmunRange(points, start, end);
    if (line.from === line.to) flushParagraph();
    else {
      paragraphLines.push(line);
      if (mode === "prose") flushParagraph();
    }
    // A Windows CRLF is one line break, not a blank line.
    if (points[end] === "\r" && points[end + 1] === "\n") end++;
    start = end + 1;
  }
  flushParagraph();
  return spans;
}

/** Checks only a gap. Never permits dropped punctuation or other source characters. */
export function isHanmunWhitespaceGap(points: readonly string[], from: number, to: number): boolean {
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to <= points.length
    && points.slice(from, to).every(point => whitespace.test(point));
}
