import { describe, expect, it } from "vitest";
import type { FootnoteRecommendation } from "../src/shared/munhae-api";
import { appendFootnoteRecommendation, footnoteRecommendationText } from "../src/renderer/scripts/footnote-analysis-citation";
import { footnoteCitation } from "../src/renderer/scripts/footnote-citation";

const recommendation: FootnoteRecommendation = {
  note: {
    id: "ITKC_BT_0394A_0030_010_0190:D001",
    annotatedText: "가릉 태수",
    displayTitle: "가릉(嘉陵)……태수(太守)",
    bodyText: "태수의 용례를 설명한다.\r\n이 글의 인물과 같은지는 확인하지 못했다.",
    bookTitle: "정관재집",
    translator: "최병준",
    publisher: "고려대학교 한자한문연구소",
    year: "2018",
    sourceUrl: "https://db.itkc.or.kr/dir/item?itemId=BT#/dir/node?dataId=ITKC_BT_0394A_0030_010_0190&jusokId=D001",
  },
  relevance: "contextual",
  reason: "동일한 관직 표현이 나타나므로 문맥을 비교할 수 있다.",
  translationAdvice: "관직명인지 인물의 별칭인지 먼저 확인한다.",
  caution: "이 문맥의 인물과 동일하다고 확정하지 않는다.",
  evidenceQuote: "태수의 용례를 설명한다.",
};

describe("AI footnote recommendation citation", () => {
  it("labels AI interpretation separately and includes the complete original citation", () => {
    const text = footnoteRecommendationText(recommendation);
    expect(text).toBe([
      "[AI 각주 추천 · 번역가 검토 필요]",
      `참고할 이유: ${recommendation.reason}`,
      `번역에 반영할 점: ${recommendation.translationAdvice}`,
      `확인할 점: ${recommendation.caution}`,
      `근거 구절: ${recommendation.evidenceQuote}`,
      "",
      footnoteCitation(recommendation.note),
    ].join("\n"));
    expect(text).toContain(recommendation.note.bodyText);
    expect(text).toContain("《정관재집》 · 최병준 역 · 고려대학교 한자한문연구소 · 2018");
    expect(text).toContain(recommendation.note.sourceUrl);
  });

  it("omits only an empty caution and preserves all other text literally", () => {
    const supplied = { ...recommendation, caution: " \n", reason: "𠮷 <甲> & 乙\r\n  확인 필요.  ", evidenceQuote: "<script>내용</script>" };
    const text = footnoteRecommendationText(supplied);
    expect(text).not.toContain("확인할 점:");
    expect(text).toContain(`참고할 이유: ${supplied.reason}`);
    expect(text).toContain(`근거 구절: ${supplied.evidenceQuote}`);
    expect(text).not.toContain("&lt;");
    expect(supplied.reason).toBe("𠮷 <甲> & 乙\r\n  확인 필요.  ");
  });

  it("keeps the exact existing opinion and appends the recommendation", () => {
    const body = "  다른 해석 가능성을 남겨 둔다.\r\n𠮷의 지시 대상은 미상.  ";
    expect(appendFootnoteRecommendation(body, recommendation)).toBe(`${body}\n\n${footnoteRecommendationText(recommendation)}`);
    expect(appendFootnoteRecommendation("", recommendation)).toBe(footnoteRecommendationText(recommendation));
  });

  it("rejects a repeated full recommendation without adding another source", () => {
    const body = appendFootnoteRecommendation("내 의견", recommendation);
    expect(() => appendFootnoteRecommendation(body, recommendation)).toThrow("이 AI 각주 추천은 이미");
  });

  it("rejects an already cited original note, even when the AI analysis is different", () => {
    const body = `기존 의견\n\n${footnoteCitation(recommendation.note)}`;
    expect(() => appendFootnoteRecommendation(body, recommendation)).toThrow("기존 인용을 확인");
    const priorAnalysis = footnoteRecommendationText({ ...recommendation, reason: "이전 분석" });
    expect(() => appendFootnoteRecommendation(priorAnalysis, recommendation)).toThrow("이 각주 자료는 이미");
    expect(body).toBe(`기존 의견\n\n${footnoteCitation(recommendation.note)}`);
  });

  it("allows another note with a different source, even if its annotated text is the same", () => {
    const other = { ...recommendation, note: { ...recommendation.note, id: "another:D002", sourceUrl: "https://db.itkc.or.kr/dir/item?itemId=BT#/dir/node?dataId=another&jusokId=D002" } };
    const body = footnoteRecommendationText(recommendation);
    expect(appendFootnoteRecommendation(body, other)).toBe(`${body}\n\n${footnoteRecommendationText(other)}`);
  });

  it("counts the final UTF-16 length, including separators and supplementary characters", () => {
    const body = "𠮷\r\n검토";
    const combined = `${body}\n\n${footnoteRecommendationText(recommendation)}`;
    expect(appendFootnoteRecommendation(body, recommendation, combined.length)).toBe(combined);
    expect(() => appendFootnoteRecommendation(body, recommendation, combined.length - 1)).toThrow("제한을 넘습니다");
    expect(() => appendFootnoteRecommendation("𠮷".repeat(10_000), recommendation)).toThrow("20,000자");
    expect(recommendation.note.bodyText).toBe("태수의 용례를 설명한다.\r\n이 글의 인물과 같은지는 확인하지 못했다.");
  });
});
