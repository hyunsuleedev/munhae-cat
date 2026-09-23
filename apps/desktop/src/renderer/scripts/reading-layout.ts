export type ReadingLayoutToken = {
  text: string;
  from: number;
  to: number;
  rangeIndex: number;
};

export type ReadingLayoutOptions = {
  columns: number;
  groups?: readonly { from: number; to: number }[];
  /** Token source ends after which a clause break is preferred. */
  breakAfter?: readonly number[];
};

type GroupSpan = { start: number; end: number };

/**
 * Pack the displayed tokens without changing their order, identities, or source
 * positions. A saved group is kept together only when its members are adjacent
 * and source-ordered in this display; reading-order views may separate them.
 * Groups wider than a row can wrap. Conflicting overlapping groups can also
 * wrap when no break satisfies them all.
 */
export function packReadingRows<T extends ReadingLayoutToken>(
  tokens: readonly T[],
  options: ReadingLayoutOptions,
): T[][] {
  if (!tokens.length) return [];
  const columns = Number.isFinite(options.columns) ? Math.max(1, Math.floor(options.columns)) : 1;
  const preferred = new Set(options.breakAfter ?? []);
  const groups: GroupSpan[] = [];

  for (const group of options.groups ?? []) {
    const members: number[] = [];
    tokens.forEach((token, index) => {
      if (token.from >= group.from && token.to <= group.to) members.push(index);
    });
    if (members.length < 2 || members.length > columns) continue;
    const start = members[0]!;
    const end = members.at(-1)! + 1;
    if (end - start !== members.length || tokens[start]!.from !== group.from || tokens[end - 1]!.to !== group.to) continue;
    const rangeIndex = tokens[start]!.rangeIndex;
    if (members.some((index, offset) => tokens[index]!.rangeIndex !== rangeIndex
      || (offset > 0 && tokens[members[offset - 1]!]!.to > tokens[index]!.from))) continue;
    groups.push({ start, end });
  }

  const crossesGroup = (boundary: number) => groups.some(group => group.start < boundary && group.end > boundary);
  const rows: T[][] = [];
  let segmentStart = 0;
  while (segmentStart < tokens.length) {
    let segmentEnd = segmentStart + 1;
    while (segmentEnd < tokens.length && tokens[segmentEnd]!.rangeIndex === tokens[segmentStart]!.rangeIndex) segmentEnd++;

    const clauseEnds: number[] = [];
    for (let index = segmentStart + 1; index < segmentEnd; index++) {
      if (preferred.has(tokens[index - 1]!.to) && !crossesGroup(index)) clauseEnds.push(index);
    }
    clauseEnds.push(segmentEnd);

    let pending: T[] = [];
    let clauseStart = segmentStart;
    for (const clauseEnd of clauseEnds) {
      if (pending.length && pending.length + clauseEnd - clauseStart > columns) {
        rows.push(pending);
        pending = [];
      }
      while (clauseEnd - clauseStart > columns) {
        const limit = clauseStart + columns;
        let end = limit;
        while (end > clauseStart && crossesGroup(end)) end--;
        // Overlapping saved ranges can make every available boundary protected.
        // The visual row still has to fit; leave the original records untouched.
        if (end === clauseStart) end = limit;
        rows.push(tokens.slice(clauseStart, end));
        clauseStart = end;
      }
      pending.push(...tokens.slice(clauseStart, clauseEnd));
      clauseStart = clauseEnd;
    }
    if (pending.length) rows.push(pending);
    segmentStart = segmentEnd;
  }
  return rows;
}
