import { expect, it } from "vitest";
import { checkTranslation, literalMatches, replaceLiteral, type CheckInput } from "../src/renderer/scripts/translation-checks";
const fixture = (): CheckInput => ({ source: "𠮷問。太守答。", translation: "길이 묻다. 태수가 답하다.", sentences: [{ id: "T1", from: 0, to: 6, text: "길이 묻다." }, { id: "T2", from: 6, to: 15, text: " 태수가 답하다." }], links: [{ sentenceId: "T1", spans: [{ from: 0, to: 3, quote: "𠮷問。" }], needsReview: false }, { sentenceId: "T2", spans: [{ from: 3, to: 7, quote: "太守答。" }], needsReview: false }], terms: [], comments: [], currentDependencies: true, dirty: false, hasLayout: true });
it("uses codepoint coverage, allows shared source links, and ignores punctuation-only gaps", () => {
  const data = fixture();
  expect(checkTranslation(data)).toEqual([]);
  data.links[1]!.spans = data.links[0]!.spans;
  expect(checkTranslation(data).filter(issue => issue.kind === "coverage")).toMatchObject([{ from: 3, to: 7, detail: "太守答。" }]);
  data.links[1]!.spans = [{ from: 3, to: 6, quote: "太守答" }];
  expect(checkTranslation(data)).toEqual([]);
});
it("rejects mismatched stored quotes and skips stale source comparisons", () => {
  const data = fixture(); data.links[0]!.spans[0]!.quote = "wrong";
  expect(checkTranslation(data).some(issue => issue.kind === "coverage")).toBe(true);
  data.currentDependencies = false;
  expect(checkTranslation(data)).toHaveLength(1);
});
it("checks confirmed document terms and accepts any homonym's translation", () => {
  const data = fixture();
  data.terms = [{ sourceForm: "太守", translation: "군수" }];
  expect(checkTranslation(data).filter(issue => issue.kind === "term")).toHaveLength(1);
  data.terms.push({ sourceForm: "太守", translation: "태수" });
  expect(checkTranslation(data)).toEqual([]);
  data.terms = [{ sourceForm: "太守", translation: null }];
  expect(checkTranslation(data)).toEqual([]);
});
it("checks cross-sentence bracket balance without changing any text", () => {
  const data = fixture(); data.translation = "「첫 문장. 다음 문장.」";
  expect(checkTranslation(data)).toEqual([]);
  data.translation = "𠮷(태수] □";
  expect(checkTranslation(data).filter(issue => issue.kind === "text")).toHaveLength(3);
});
it("literal replacement preserves CRLF, supplementary characters, and replacement dollar signs", () => {
  const original = "𠮷太守\r\n太守. $&";
  expect(literalMatches(original, "太守")).toEqual([{ from: 2, to: 4 }, { from: 6, to: 8 }]);
  expect(replaceLiteral(original, "太守", "$&")).toBe("𠮷$&\r\n$&. $&");
  expect(replaceLiteral(original, "", "x")).toBe(original);
});
