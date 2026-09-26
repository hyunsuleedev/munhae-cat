import { expect, it } from "vitest";
import { bookEditDiff, bookFlowParts, bookGapBefore, joinBookGap } from "../src/renderer/scripts/book-translation-flow";

it("reconstructs the full text exactly with inline boundaries, line breaks, blank lines and supplementary characters", () => {
  const text = "  첫𠀀 문장.둘째 문장.\n셋째.\r\n\r\n넷째.  ";
  const points = Array.from(text);
  const quotes = ["첫𠀀 문장.", "둘째 문장.", "셋째.", "넷째."];
  let from = 2;
  const sentences = quotes.map((quote, index) => {
    while (points.slice(from, from + Array.from(quote).length).join("") !== quote) from++;
    const sentence = { id: `T${index + 1}`, from, to: from + Array.from(quote).length, text: quote };
    from = sentence.to; return sentence;
  });
  const parts = bookFlowParts(text, sentences);
  expect(parts.map(part => part.text).join("")).toBe(text);
  expect(parts.filter(part => !part.id).map(part => part.text)).toEqual(["  ", "", "\n", "\r\n\r\n", "  "]);
  expect(parts.filter(part => part.id).map(part => part.id)).toEqual(["T1", "T2", "T3", "T4"]);
});

it("retains newlines inside a group and supports an empty translation", () => {
  const text = "한 묶음\n안의 시행\n\n다음 문단";
  const parts = bookFlowParts(text, [{ id: "group", from: 0, to: Array.from(text).length, text }]);
  expect(parts[1]?.text).toBe(text);
  expect(bookFlowParts("", [])).toEqual([{ from: 0, to: 0, text: "" }]);
});

it("marks the changed words of a group against its saved text", () => {
  expect(bookEditDiff("진회(秦淮)의 안개 낀 달밤", "진회(秦淮)의 안개 어린 달밤")).toEqual([
    { type: "equal", text: "진회(秦淮)의 안개 " }, { type: "remove", text: "낀" }, { type: "insert", text: "어린" }, { type: "equal", text: " 달밤" },
  ]);
  expect(bookEditDiff("태평한 세상", "태평을 누린 세상")).toEqual([
    { type: "equal", text: "태평" }, { type: "remove", text: "한" }, { type: "insert", text: "을 누린" }, { type: "equal", text: " 세상" },
  ]);
  expect(bookEditDiff("같은 문장.", "같은 문장.")).toEqual([{ type: "equal", text: "같은 문장." }]);
  expect(bookEditDiff("", "")).toEqual([]);
  // A space between two edited words belongs to one change.
  expect(bookEditDiff("가 나 끝", "라 마 끝")).toEqual([{ type: "remove", text: "가 나" }, { type: "insert", text: "라 마" }, { type: "equal", text: " 끝" }]);
});

it("keeps both sides of a diff reconstructable, including pure insertions and line breaks", () => {
  const cases: [string, string][] = [
    ["황조의 칙사", "황조(皇朝)의 칙사"],
    ["첫 줄\n둘째 줄", "첫 줄\n\n둘째 줄을 고침"],
    ["𠀀 글자 삭제", "글자"],
    ["", "새 번역"],
  ];
  for (const [before, after] of cases) {
    const chunks = bookEditDiff(before, after);
    expect(chunks.filter(chunk => chunk.type !== "insert").map(chunk => chunk.text).join("")).toBe(before);
    expect(chunks.filter(chunk => chunk.type !== "remove").map(chunk => chunk.text).join("")).toBe(after);
    expect(chunks.every((chunk, index) => chunk.type !== chunks[index + 1]?.type)).toBe(true);
  }
  expect(bookEditDiff("황조의 칙사", "황조(皇朝)의 칙사")).toEqual([
    { type: "equal", text: "황조" }, { type: "insert", text: "(皇朝)" }, { type: "equal", text: "의 칙사" },
  ]);
});

it("joins two paragraphs across a removed paragraph break without touching either group", () => {
  const text = "첫째.\n\n둘째. 셋째.\r\n넷째.";
  const sentences = ["첫째.", "둘째.", "셋째.", "넷째."].map((quote, index) => {
    const from = text.indexOf(quote);
    return { id: `T${index + 1}`, from: Array.from(text.slice(0, from)).length, to: Array.from(text.slice(0, from)).length + Array.from(quote).length, text: quote };
  });
  expect(bookGapBefore(text, sentences, "T2")).toEqual({ from: 3, to: 5 });
  expect(joinBookGap(text, sentences, "T2")).toBe("첫째. 둘째. 셋째.\r\n넷째.");
  expect(joinBookGap(text, sentences, "T4")).toBe("첫째.\n\n둘째. 셋째. 넷째.");
  // An inline space and the text start are not paragraph breaks.
  expect(joinBookGap(text, sentences, "T3")).toBeNull();
  expect(joinBookGap(text, sentences, "T1")).toBeNull();
  expect(joinBookGap(text, sentences, "missing")).toBeNull();
});
