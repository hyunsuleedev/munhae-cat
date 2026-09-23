import { createPunctuationProjection } from "./punctuation-projection";

export type PunctuationParagraph = {
  /** Textarea selection positions are UTF-16; source cursors are code points. */
  from: number;
  to: number;
  sourceFrom: number;
  sourceTo: number;
  sourceText: string;
};

/** Display-only paragraph grouping. Never normalize or rewrite either text. */
export function punctuationParagraphs(source: string, text: string): PunctuationParagraph[] | null {
  const projection = createPunctuationProjection(source, text);
  if (!projection) return null;
  const points = Array.from(source);
  const ends = [...text.matchAll(/\r?\n[\t \r]*\n(?:[\t \r]*\n)*/g)].map(match => match.index! + match[0].length);
  if (ends.at(-1) !== text.length) ends.push(text.length);
  const paragraphs: PunctuationParagraph[] = [];
  let from = 0, sourceFrom = 0, pointCursor = 0;
  for (const to of ends) {
    pointCursor += Array.from(text.slice(from, to)).length;
    const sourceTo = projection.sourceBoundaryByPunctuationBoundary[pointCursor]!;
    if (sourceTo > sourceFrom) {
      paragraphs.push({ from, to, sourceFrom, sourceTo, sourceText: points.slice(sourceFrom, sourceTo).join("") });
      sourceFrom = sourceTo;
      from = to;
    } else {
      // Leading blank lines belong to the next real paragraph.
      pointCursor -= Array.from(text.slice(from, to)).length;
    }
  }
  return paragraphs;
}
