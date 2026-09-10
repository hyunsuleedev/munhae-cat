import { describe, expect, it } from "vitest";
import type { ItkcFootnote } from "../src/shared/munhae-api";
import { appendFootnoteCitation, footnoteCitation } from "../src/renderer/scripts/footnote-citation";

const note: ItkcFootnote = {
  id: "ITKC_BT_0394A_0030_010_0190:D001", annotatedText: "가릉 태수", displayTitle: "가릉(嘉陵)……태수(太守)",
  bodyText: "다른 문헌에서의 설명.\n확정하지 않은 해석도 보존한다.", bookTitle: "미암집", translator: "번역자",
  publisher: "간행처", year: "2000", sourceUrl: "https://db.itkc.or.kr/dir/item?itemId=BT#/dir/node?dataId=ITKC_BT_0394A_0030_010_0190&jusokId=D001",
};

describe("footnote citation", () => {
  it("keeps annotated phrase, processed title, explanatory text and source distinct", () => {
    const text = footnoteCitation(note);
    expect(text).toContain("각주 대상 구절: 가릉 태수");
    expect(text).toContain(`표시 제목: ${note.displayTitle}`);
    expect(text).toContain(`각주 설명: ${note.bodyText}`);
    expect(text).toContain("《미암집》 · 번역자 역 · 간행처 · 2000");
    expect(text).toContain(note.sourceUrl);
  });
  it("preserves the user's opinion and appends a complete source without implying approval", () => {
    const body = "이 문맥에서도 같은 관직인가?\n확인 필요.  ";
    expect(appendFootnoteCitation(body, note)).toBe(`${body}\n\n${footnoteCitation(note)}`);
    expect(() => appendFootnoteCitation(appendFootnoteCitation(body, note), note)).toThrow("이미");
  });
  it("rejects oversized citations without truncating either text or provenance", () => {
    expect(() => appendFootnoteCitation("의견", note, 40)).toThrow("20,000자");
    expect(appendFootnoteCitation("", note)).toBe(footnoteCitation(note));
  });
});
