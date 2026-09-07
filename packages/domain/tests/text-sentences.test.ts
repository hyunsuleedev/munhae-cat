import { describe, expect, it } from "vitest";
import { replaceTextSentence, textSentences } from "../src/text-sentences.ts";

describe("sentence translation editing", () => {
  it("preserves paragraph gaps, spaces, and supplementary characters across consecutive edits", () => {
    const text = "  첫 𠮷 문장.\n\n\t둘째 문장!  셋째 문장.\n\n";
    const first = replaceTextSentence(text, textSentences(text), "T1", "  수정한 𠮷 문장.\n새 줄");
    const second = replaceTextSentence(first.text, first.sentences, "T2", "\t다음 번역!  ");
    expect(second.text).toBe("  수정한 𠮷 문장.\n새 줄\n\n\t다음 번역!    셋째 문장.\n\n");
    for (const sentence of second.sentences) {
      expect(Array.from(second.text).slice(sentence.from, sentence.to).join("")).toBe(sentence.text);
    }
  });

  it("keeps an emptied row editable without deleting neighbouring text", () => {
    const text = "첫 문장. 다음 문장.";
    const deleted = replaceTextSentence(text, textSentences(text), "T1", "");
    expect(deleted.text).toBe(" 다음 문장.");
    const restored = replaceTextSentence(deleted.text, deleted.sentences, "T1", "복원 🐱.");
    expect(restored.text).toBe("복원 🐱. 다음 문장.");
    expect(restored.sentences[1]?.text).toBe(" 다음 문장.");
  });

  it("segments decimals and quoted endings consistently after saving", () => {
    const sentences = textSentences('값은 3.14이다. “그렇다!”\n\n다음 줄。');
    expect(sentences.map((sentence) => sentence.text)).toEqual(['값은 3.14이다.', ' “그렇다!”', '다음 줄。']);
  });
});
