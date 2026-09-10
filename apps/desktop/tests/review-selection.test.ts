import { expect, it } from "vitest";
import { textareaOffset, textareaRange } from "../src/renderer/scripts/review-selection";

it("maps a repeated supplementary Hanja after CRLF to its exact stored occurrence", () => {
  const raw = "𠮷甲\r\n乙𠮷\r丙";
  const displayed = raw.replace(/\r\n?/g, "\n");
  const start = displayed.lastIndexOf("𠮷");
  expect(textareaRange(raw, start, start + 2)).toEqual({ from: 5, to: 6, quote: "𠮷" });
  expect(textareaOffset(raw, 5)).toBe(start);
  expect(textareaOffset(raw, 6)).toBe(start + 2);
  expect(textareaRange(raw, 3, 5)).toEqual({ from: 2, to: 5, quote: "\r\n乙" });
});

it("rejects collapsed and out of bounds selections", () => {
  expect(textareaRange("甲", 0, 0)).toBeNull();
  expect(textareaRange("甲", -1, 1)).toBeNull();
  expect(textareaRange("甲", 0, 2)).toBeNull();
});
