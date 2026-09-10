import type { FootnoteRecommendation } from "../../shared/munhae-api";
import { footnoteCitation } from "./footnote-citation";

/** Plain text: the caller decides whether to copy it or put it in a text field. */
export function footnoteRecommendationText(recommendation: FootnoteRecommendation): string {
  const analysis = [
    "[AI 각주 추천 · 번역가 검토 필요]",
    `참고할 이유: ${recommendation.reason}`,
    `번역에 반영할 점: ${recommendation.translationAdvice}`,
    recommendation.caution.trim() ? `확인할 점: ${recommendation.caution}` : "",
    `근거 구절: ${recommendation.evidenceQuote}`,
  ].filter(Boolean).join("\n");
  return `${analysis}\n\n${footnoteCitation(recommendation.note)}`;
}

/** Preserve the user's exact draft and the complete citation; never truncate either. */
export function appendFootnoteRecommendation(
  body: string,
  recommendation: FootnoteRecommendation,
  maxLength = 20_000,
): string {
  const citation = footnoteRecommendationText(recommendation);
  if (body.includes(citation)) throw new Error("이 AI 각주 추천은 이미 코멘트에 들어 있습니다.");
  if (body.includes(footnoteCitation(recommendation.note))) {
    throw new Error("이 각주 자료는 이미 코멘트에 들어 있습니다. 기존 인용을 확인하고, 필요한 AI 분석 내용만 직접 추가해 주세요.");
  }
  const combined = `${body}${body ? "\n\n" : ""}${citation}`;
  if (combined.length > maxLength) {
    throw new Error(`AI 분석과 각주를 모두 넣으면 코멘트의 ${maxLength.toLocaleString("ko-KR")}자 제한을 넘습니다. 필요한 부분을 골라 입력해 주세요.`);
  }
  return combined;
}
