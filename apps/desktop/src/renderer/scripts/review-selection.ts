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
