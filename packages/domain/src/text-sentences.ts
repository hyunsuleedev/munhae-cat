export type TextSentence = {
  id: string;
  from: number;
  to: number;
  text: string;
};

/** Layout whitespace stays in the full text, outside each editable body range. */
export function trimTextSentences(text: string, sentences: TextSentence[]): TextSentence[] {
  const points = Array.from(text);
  return sentences.map(sentence => {
    let { from, to } = sentence;
    while (from < to && /\s/u.test(points[from]!)) from++;
    while (to > from && /\s/u.test(points[to - 1]!)) to--;
    return { ...sentence, from, to, text: points.slice(from, to).join("") };
  });
}

export function textSentences(text: string): TextSentence[] {
  // Ranges use Unicode code points. Whitespace remains in the canonical text.
  const out: TextSentence[] = [];
  const points = Array.from(text);
  let from = 0;
  const add = (to: number) => {
    const sentence = points.slice(from, to).join("");
    if (sentence.trim()) out.push({ id: `T${out.length + 1}`, from, to, text: sentence });
    from = to;
  };
  for (let i = 0; i < points.length; i++) {
    const ch = points[i]!;
    if (ch === "\n") {
      add(i + 1);
      continue;
    }
    if (!/[.!?。！？]/u.test(ch)) continue;
    if (ch === "." && /[0-9]/.test(points[i - 1] ?? "") && /[0-9]/.test(points[i + 1] ?? "")) continue;
    let end = i + 1;
    while (end < points.length && /[”’"'」』)\]】]/u.test(points[end]!)) end++;
    if (end === points.length || /\s/u.test(points[end]!)) {
      add(end);
      i = end - 1;
    }
  }
  add(points.length);
  return trimTextSentences(text, out);
}

export function replaceTextSentence(
  text: string,
  sentences: TextSentence[],
  sentenceId: string,
  replacement: string,
): { text: string; sentences: TextSentence[] } {
  const index = sentences.findIndex((sentence) => sentence.id === sentenceId);
  const sentence = sentences[index];
  if (!sentence) throw new Error("편집할 번역 문장을 찾을 수 없습니다");
  const points = Array.from(text);
  const delta = Array.from(replacement).length - (sentence.to - sentence.from);
  return {
    text: points.slice(0, sentence.from).join("") + replacement + points.slice(sentence.to).join(""),
    // Keep row identities stable while typing; re-segment after saving.
    sentences: sentences.map((item, i) => i < index ? item : i === index
      ? { ...item, text: replacement, to: item.to + delta }
      : { ...item, from: item.from + delta, to: item.to + delta }),
  };
}

/** Map each new sentence ID to an exact, unambiguous previous sentence ID. */
export function matchUnchangedTextSentences(
  previous: TextSentence[],
  next: TextSentence[],
): Map<string, string> {
  const unique = (sentences: TextSentence[]) => {
    const ids = new Map<string, string | null>();
    for (const sentence of sentences) {
      ids.set(sentence.text, ids.has(sentence.text) ? null : sentence.id);
    }
    return ids;
  };
  const previousIds = unique(previous);
  const nextIds = unique(next);
  const matches = new Map<string, string>();
  for (const sentence of next) {
    const previousId = previousIds.get(sentence.text);
    if (previousId && nextIds.get(sentence.text)) matches.set(sentence.id, previousId);
  }
  return matches;
}

/** Collapse contiguous members without changing a single character of the text. */
export function groupedTextSentences(text: string, sentences: TextSentence[], links: Array<{ sentenceId: string; groupId?: string }>): TextSentence[] {
  const points = Array.from(text);
  const result: TextSentence[] = [];
  const group = (id: string) => links.find(link => link.sentenceId === id)?.groupId;
  for (const sentence of sentences) {
    const last = result.at(-1);
    if (last && group(sentence.id) && group(last.id) === group(sentence.id)) {
      last.to = sentence.to;
      last.text = points.slice(last.from, last.to).join("");
    } else result.push({ ...sentence });
  }
  return trimTextSentences(text, result);
}

/** Apply one full-editor input without losing group identities or unchanged CRLFs. */
export function editGroupedText(text: string, sentences: TextSentence[], input: string): { text: string; sentences: TextSentence[]; changedIds: string[] } | null {
  const raw = Array.from(text), normalized: string[] = [], boundaries = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\r") {
      if (raw[i + 1] === "\n") i++;
      normalized.push("\n");
    } else normalized.push(raw[i]!);
    boundaries.push(i + 1);
  }
  const next = Array.from(input.replace(/\r\n?/g, "\n"));
  let start = 0;
  while (start < normalized.length && start < next.length && normalized[start] === next[start]) start++;
  let end = normalized.length, nextEnd = next.length;
  while (end > start && nextEnd > start && normalized[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  const from = boundaries[start]!, to = boundaries[end]!, replacement = next.slice(start, nextEnd).join("");
  if (from === to && !replacement) return { text, sentences, changedIds: [] };
  const body = sentences.find(s => from >= s.from && to <= s.to && (from !== to || /\S/u.test(replacement) || from > s.from && from < s.to));
  if (body) {
    const value = raw.slice(body.from, from).join("") + replacement + raw.slice(to, body.to).join("");
    if (!value.trim()) return null;
    const result = replaceTextSentence(text, sentences, body.id, value);
    return { ...result, sentences: trimTextSentences(result.text, result.sentences), changedIds: [body.id] };
  }
  const removed = raw.slice(from, to).join("");
  if (/\S/u.test(removed + replacement) || sentences.some(s => from < s.to && to > s.from)) return null;
  const delta = Array.from(replacement).length - (to - from);
  const result = raw.slice(0, from).join("") + replacement + raw.slice(to).join("");
  return { text: result, sentences: sentences.map(s => s.from >= to ? { ...s, from: s.from + delta, to: s.to + delta } : s), changedIds: [] };
}
