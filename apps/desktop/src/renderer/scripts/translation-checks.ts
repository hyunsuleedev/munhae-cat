import type { GlossaryEntryView, ReviewCommentView } from "../../shared/munhae-api";

export type CheckSentence = { id: string; from: number; to: number; text: string };
export type CheckLink = { sentenceId: string; spans: { from: number; to: number; quote: string }[]; needsReview: boolean };
export type TranslationCheck = {
  kind: "alignment" | "coverage" | "term" | "text" | "comment";
  title: string; detail: string; sentenceId?: string;
  target?: "source" | "translation"; from?: number; to?: number; commentId?: string;
};
export type CheckInput = {
  identity?: string;
  source: string; translation: string; sentences: CheckSentence[]; links: CheckLink[];
  glossary: GlossaryEntryView[]; comments: ReviewCommentView[];
  currentDependencies: boolean; dirty: boolean; hasLayout: boolean;
};

// These checks flag evidence for a human reviewer; they do not grade a translation.
export function checkTranslation(input: CheckInput): TranslationCheck[] {
  const issues: TranslationCheck[] = [];
  const points = Array.from(input.source);
  if (!input.translation.trim()) issues.push({ kind: "text", title: "번역 내용이 비어 있습니다", detail: "번역문을 입력하세요." });
  if (!input.currentDependencies) {
    issues.push({ kind: "alignment", title: "이전 원문을 기준으로 한 번역입니다", detail: "현재 원문과의 대응·용어 검사는 생략했습니다. 이전 번역을 보존하면서 새 번역안을 검토하세요." });
  }
  const covered = new Uint8Array(points.length);
  if (input.hasLayout && input.currentDependencies) {
    const variants = new Map<string, GlossaryEntryView[]>();
    for (const entry of input.glossary) {
      if (!entry.sourceTerm || !entry.targetTerm) continue;
      variants.set(entry.sourceTerm, [...(variants.get(entry.sourceTerm) ?? []), entry]);
    }
    for (const sentence of input.sentences) {
      const link = input.links.find(item => item.sentenceId === sentence.id);
      const spans = (link?.spans ?? []).filter(span => Number.isInteger(span.from) && Number.isInteger(span.to)
        && span.from >= 0 && span.to > span.from && span.to <= points.length
        && points.slice(span.from, span.to).join("") === span.quote);
      for (const span of spans) covered.fill(1, span.from, span.to);
      if (!spans.length || link?.needsReview) issues.push({ kind: "alignment", title: `${sentence.id} · ${spans.length ? "대응 확인 필요" : "원문 미연결"}`, detail: sentence.text, sentenceId: sentence.id });
      for (const [term, entries] of variants) {
        if (!spans.some(span => span.quote.includes(term))) continue;
        const allowed = entries.filter(entry => entry.usageStatus !== "forbidden");
        const forbidden = entries.filter(entry => entry.usageStatus === "forbidden" && sentence.text.includes(entry.targetTerm));
        for (const entry of forbidden) issues.push({ kind: "term", title: `${sentence.id} · 지양하는 번역어 ‘${entry.targetTerm}’`, detail: `연결 원문에 ‘${term}’이 있습니다. 용어집 메모와 이 문맥을 비교하세요.${entry.noteMd ? ` ${entry.noteMd}` : ""}`, sentenceId: sentence.id });
        if (allowed.some(entry => entry.usageStatus === "preferred") && !allowed.some(entry => sentence.text.includes(entry.targetTerm))) {
          issues.push({ kind: "term", title: `${sentence.id} · ‘${term}’의 번역어 확인`, detail: `용어집: ${allowed.map(entry => entry.targetTerm).join(" / ")}. 의역·생략·동형이의어일 수 있으므로 문맥을 확인하세요.`, sentenceId: sentence.id });
        }
      }
    }
    let start = -1;
    const finish = (end: number) => {
      if (start < 0) return;
      const quote = points.slice(start, end).join("");
      if (/[\p{L}\p{N}]/u.test(quote)) issues.push({ kind: "coverage", title: "연결되지 않은 원문 범위", detail: quote, target: "source", from: start, to: end });
      start = -1;
    };
    for (let i = 0; i < points.length; i++) {
      if (!covered[i] && start < 0) start = i;
      if (covered[i]) finish(i);
    }
    finish(points.length);
  }
  const target = Array.from(input.translation);
  const opens: Record<string, string> = { "(": ")", "（": "）", "[": "]", "{": "}", "「": "」", "『": "』", "《": "》", "〈": "〉", "【": "】" };
  const closes = new Set(Object.values(opens));
  const stack: { char: string; at: number }[] = [];
  const addText = (at: number, title: string) => {
    const sentence = input.sentences.find(item => item.from <= at && item.to > at);
    issues.push({ kind: "text", title, detail: target.slice(Math.max(0, at - 20), at + 35).join(""), sentenceId: sentence?.id, target: "translation", from: at, to: at + 1 });
  };
  target.forEach((char, at) => {
    if (opens[char]) stack.push({ char, at });
    else if (closes.has(char)) {
      if (stack.length && opens[stack[stack.length - 1]!.char] === char) stack.pop();
      else addText(at, `괄호 짝 확인 · ${char}`);
    }
    if (char === "�" || char === "□") addText(at, "누락·미상 표시 확인");
  });
  for (const item of stack) addText(item.at, `닫히지 않은 괄호 · ${item.char}`);
  // Saved comments use saved offsets. Do not offer misleading draft locations.
  for (const comment of input.comments) issues.push({ kind: "comment", title: `검토 코멘트 · ${comment.quote}`, detail: comment.bodyMd, commentId: input.dirty ? undefined : comment.id });
  return issues;
}

export type LiteralMatch = { from: number; to: number };
// UTF-16 offsets are only used for native textarea selections and string slicing.
export function literalMatches(text: string, query: string): LiteralMatch[] {
  if (!query) return [];
  const matches: LiteralMatch[] = [];
  let at = 0;
  while ((at = text.indexOf(query, at)) >= 0) {
    matches.push({ from: at, to: at + query.length });
    at += query.length;
  }
  return matches;
}

export function replaceLiteral(text: string, query: string, replacement: string): string {
  if (!query) return text;
  return text.split(query).join(replacement);
}
