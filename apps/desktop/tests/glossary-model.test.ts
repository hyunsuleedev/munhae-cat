import { expect, it } from "vitest";
import type { ProjectTermListItem, ProjectTermUse } from "../src/shared/munhae-api";
import { distinctReading, firstSentence, glossaryMatches, homographNumbers, sentenceRuns, sortGlossary, termTranslation } from "../src/renderer/scripts/glossary-model";
import { evidenceText, parseEvidence } from "../src/renderer/scripts/term-review-model";

const use = (title: string, extra: Partial<ProjectTermUse> = {}): ProjectTermUse => ({ id: title, title, occurrences: 1, contextNote: null, versionNo: 1, current: true, ...extra });
const term = (id: string, sourceForm: string, extra: Partial<ProjectTermListItem> = {}): ProjectTermListItem => ({
  id, sourceForm, kind: "person", reading: null, translation: null, definition: null, evidence: [], lockVersion: 1, createdAt: "", updatedAt: "", documents: [use("관서악부서")], ...extra });

const wangJian = term("t1", "王建", { reading: "왕건", translation: "왕건", definition: "당나라 시인. 궁사 100수로 이름났다." });
const taejo = term("t2", "王建", { reading: "왕건", translation: "태조 왕건", definition: "고려를 세운 태조.", documents: [use("서경 제영", { contextNote: "서경을 중시한 임금" })] });
const pyongyang = term("t3", "平壤", { kind: "place", reading: "평양", translation: "평양", documents: [use("관서악부서"), use("다른 문서")] });
const jizi = term("t4", "箕子", { reading: "기자" });

it("pairs the headword with its translation and adds the reading only when it differs", () => {
  expect([termTranslation(wangJian), distinctReading(wangJian)]).toEqual(["왕건", null]);
  expect([termTranslation(taejo), distinctReading(taejo)]).toEqual(["태조 왕건", "왕건"]);
  expect([termTranslation(jizi), distinctReading(jizi)]).toEqual(["기자", null]);
  expect(termTranslation(term("t5", "某"))).toBe("");
});

it("numbers only the written forms that have more than one sense, in list order", () => {
  expect([...homographNumbers([wangJian, pyongyang, taejo])]).toEqual([["t1", 1], ["t2", 2]]);
  expect(firstSentence(wangJian.definition!)).toBe("당나라 시인.");
  expect(firstSentence("마침표 없는 풀이")).toBe("마침표 없는 풀이");
});

it("searches headwords, readings, definitions and each document's own note", () => {
  expect(glossaryMatches(taejo, "서경을 중시")).toBe(true);
  expect(glossaryMatches(pyongyang, "다른 문서")).toBe(true);
  expect(glossaryMatches(wangJian, "고려")).toBe(false);
  expect(glossaryMatches(wangJian, "  ")).toBe(true);
});

it("sorts by reading, kind or number of documents without changing the input", () => {
  const input = [pyongyang, taejo, jizi, wangJian];
  expect(sortGlossary(input, "reading").map(t => t.id)).toEqual(["t4", "t2", "t1", "t3"]);
  expect(sortGlossary(input, "kind").map(t => t.id)).toEqual(["t4", "t2", "t1", "t3"]);
  expect(sortGlossary(input, "documents").map(t => t.id)).toEqual(["t3", "t4", "t2", "t1"]);
  expect(input.map(t => t.id)).toEqual(["t3", "t2", "t4", "t1"]);
});

it("edits evidence as one citation per line with the address at the end", () => {
  const evidence = [{ citation: "『사기』 「송미자세가」", url: null }, { citation: "한국고전종합DB", url: "https://db.itkc.or.kr" }];
  expect(evidenceText(evidence)).toBe("『사기』 「송미자세가」\n한국고전종합DB https://db.itkc.or.kr");
  expect(parseEvidence(evidenceText(evidence))).toEqual(evidence);
  expect(parseEvidence("")).toEqual([]);
});

it("marks a term inside its sentence by code point and merges overlapping marks", () => {
  expect(sentenceRuns({ text: "𠮷王建，王建。", marks: [{ from: 1, to: 3 }, { from: 4, to: 6 }] })).toEqual([
    { text: "𠮷", marked: false }, { text: "王建", marked: true }, { text: "，", marked: false }, { text: "王建", marked: true }, { text: "。", marked: false },
  ]);
  expect(sentenceRuns({ text: "哈哈哈。", marks: [{ from: 0, to: 2 }, { from: 1, to: 3 }] })).toEqual([{ text: "哈哈", marked: true }, { text: "哈", marked: true }, { text: "。", marked: false }]);
});
