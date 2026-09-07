export type TextSentence = {
  id: string;
  from: number;
  to: number;
  text: string;
};

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
  return out;
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
