import { segmentHanmun, trimHanmunRange, type HanmunStructureSpan } from "@munhae/domain/hanmun-segmentation";
import { createPunctuationProjection } from "./punctuation-projection";

export type PunctuationParagraph = HanmunStructureSpan & {
  /** Native textarea offsets are UTF-16; structure and source offsets are code points. */
  from: number;
  to: number;
  sourceFrom: number;
  sourceTo: number;
  sourceText: string;
};

/** Uses the same segmentation as persisted punctuation; never rewrites either text. */
export function punctuationStructure(source: string, text: string, mode: "prose" | "poetry" = "prose"): PunctuationParagraph[] | null {
  const projection = createPunctuationProjection(source, text);
  if (!projection) return null;
  const points = Array.from(source);
  const utf16 = [0];
  for (const point of projection.codepoints) utf16.push(utf16[utf16.length - 1]! + point.length);
  return segmentHanmun(text, mode).map(span => {
    const sourceRange = trimHanmunRange(points,
      projection.sourceBoundaryByPunctuationBoundary[span.codepointFrom]!,
      projection.sourceBoundaryByPunctuationBoundary[span.codepointTo]!);
    return { ...span, from: utf16[span.codepointFrom]!, to: utf16[span.codepointTo]!,
      sourceFrom: sourceRange.from, sourceTo: sourceRange.to,
      sourceText: points.slice(sourceRange.from, sourceRange.to).join("") };
  });
}

export function punctuationParagraphs(source: string, text: string, mode: "prose" | "poetry" = "prose"): PunctuationParagraph[] | null {
  return punctuationStructure(source, text, mode)?.filter(span => span.spanKind === "paragraph" && span.sourceFrom < span.sourceTo) ?? null;
}
