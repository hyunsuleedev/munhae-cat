/** A validated, positional view of a punctuation layer over its unchanged source. */
export type PunctuationProjection = {
  readonly sourceLength: number;
  readonly codepoints: readonly string[];
  /** Same source cursor convention as validatePunctuationText in db-sqlite. */
  readonly sourceBoundaryByPunctuationBoundary: readonly number[];
  /** Monotone source character owners, used only to choose a display slice. */
  readonly sourceOwnerByPunctuationCodepoint: readonly number[];
};

export type ProjectedSourceRange = {
  text: string;
  /** Absolute source code-point cursors, including the two end boundaries. */
  boundaries: number[];
};

// Keep the acceptance rules and greedy alignment in sync with
// packages/db-sqlite/src/source-layer.ts: validatePunctuationText.
const INSERTABLE_PUNCTUATION = /^(?:\p{Punctuation}|\p{White_Space}|ㆍ)$/u;
const SOURCE_WHITESPACE = /^\p{White_Space}$/u;
const OPENING_PUNCTUATION = /^(?:\p{Ps}|\p{Pi}|[「『【《〈〔〖〘〚])$/u;

/**
 * Build once per punctuation version. Invalid, changed, or incomplete source
 * text is rejected; repeated phrases are always aligned by position.
 */
export function createPunctuationProjection(
  sourceText: string,
  punctuatedText: string,
): PunctuationProjection | null {
  const source = Array.from(sourceText);
  const codepoints = Array.from(punctuatedText);
  if (source.length === 0 || sourceText.trim().length === 0) return null;

  let sourceCursor = 0;
  let nextNonWhitespace = 0;
  const boundaries = [0];
  const sourceIndices: Array<number | null> = [];
  const openingFlags: boolean[] = [];
  const openStraightQuotes = new Set<string>();

  for (const codepoint of codepoints) {
    let isOpening = OPENING_PUNCTUATION.test(codepoint);
    if (codepoint === '"' || codepoint === "'") {
      isOpening = !openStraightQuotes.has(codepoint);
      if (isOpening) openStraightQuotes.add(codepoint);
      else openStraightQuotes.delete(codepoint);
    }
    openingFlags.push(isOpening);

    nextNonWhitespace = Math.max(sourceCursor, nextNonWhitespace);
    while (nextNonWhitespace < source.length && SOURCE_WHITESPACE.test(source[nextNonWhitespace]!)) {
      nextNonWhitespace += 1;
    }

    if (sourceCursor < source.length && codepoint === source[sourceCursor]) {
      sourceIndices.push(sourceCursor);
      sourceCursor += 1;
    } else if (nextNonWhitespace < source.length && codepoint === source[nextNonWhitespace]) {
      sourceIndices.push(nextNonWhitespace);
      sourceCursor = nextNonWhitespace + 1;
    } else if (INSERTABLE_PUNCTUATION.test(codepoint)) {
      sourceIndices.push(null);
    } else {
      return null;
    }
    boundaries.push(sourceCursor);
  }

  while (sourceCursor < source.length && SOURCE_WHITESPACE.test(source[sourceCursor]!)) sourceCursor += 1;
  if (sourceCursor !== source.length) return null;
  boundaries[boundaries.length - 1] = sourceCursor;

  // A run of inserted punctuation belongs to the preceding source character
  // until its first opening bracket/quote; the remainder introduces the next
  // character. This retains 「乙」 and closes 甲。」 at a shared range boundary.
  const owners: number[] = [];
  for (let index = 0; index < codepoints.length;) {
    const preservedIndex = sourceIndices[index];
    if (preservedIndex != null) {
      owners.push(preservedIndex);
      index += 1;
      continue;
    }
    const start = index;
    while (index < codepoints.length && sourceIndices[index] == null) index += 1;
    const left = start > 0 ? sourceIndices[start - 1] : null;
    const right = index < codepoints.length ? sourceIndices[index] : null;
    let opensNext = false;
    for (let cursor = start; cursor < index; cursor += 1) {
      opensNext ||= openingFlags[cursor] ?? false;
      const owner = left == null ? right : right == null ? left : opensNext ? right : left;
      // A valid nonempty source always has at least one preserved character.
      if (owner == null) return null;
      owners.push(owner);
    }
  }

  return {
    sourceLength: source.length,
    codepoints,
    sourceBoundaryByPunctuationBoundary: boundaries,
    sourceOwnerByPunctuationCodepoint: owners,
  };
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Project a canonical [from, to) source range into the punctuation layer.
 * Omitted whitespace alone has no displayed counterpart and returns null.
 * If a display boundary consumed whitespace outside this range, clip it so
 * selecting the displayed phrase can never reach outside the requested range.
 */
export function projectSourceRange(
  projection: PunctuationProjection,
  from: number,
  to: number,
): ProjectedSourceRange | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > projection.sourceLength) {
    return null;
  }
  const start = lowerBound(projection.sourceOwnerByPunctuationCodepoint, from);
  const end = lowerBound(projection.sourceOwnerByPunctuationCodepoint, to);
  if (start === end) return null;
  return {
    text: projection.codepoints.slice(start, end).join(""),
    boundaries: projection.sourceBoundaryByPunctuationBoundary
      .slice(start, end + 1)
      .map((boundary) => Math.max(from, Math.min(to, boundary))),
  };
}

/**
 * Map a source cursor to a UTF-16 caret in the punctuated text: just after the
 * preceding source character, before any punctuation already placed there.
 */
export function punctuationCaretForSource(projection: PunctuationProjection, sourceText: string, cursor: number): number {
  const points = Array.from(sourceText);
  let previous = cursor - 1;
  while (previous >= 0 && SOURCE_WHITESPACE.test(points[previous] ?? "")) previous -= 1;
  const boundary = previous < 0 ? 0 : lowerBound(projection.sourceBoundaryByPunctuationBoundary, previous + 1);
  return projection.codepoints.slice(0, boundary).join("").length;
}
