import { describe, expect, it } from "vitest";
import { editGroupedText, groupedTextSentences, matchUnchangedTextSentences, replaceTextSentence, textSentences, trimTextSentences } from "../src/text-sentences.ts";

describe("sentence translation editing", () => {
  it("preserves paragraph gaps, spaces, and supplementary characters across consecutive edits", () => {
    const text = "  첫 𠮷 문장.\n\n\t둘째 문장!  셋째 문장.\n\n";
    const first = replaceTextSentence(text, textSentences(text), "T1", "수정한 𠮷 문장.\n새 줄");
    const second = replaceTextSentence(first.text, first.sentences, "T2", "다음 번역!");
    expect(second.text).toBe("  수정한 𠮷 문장.\n새 줄\n\n\t다음 번역!  셋째 문장.\n\n");
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
    expect(restored.sentences[1]?.text).toBe("다음 문장.");
  });

  it("segments decimals and quoted endings consistently after saving", () => {
    const sentences = textSentences('값은 3.14이다. “그렇다!”\n\n다음 줄。');
    expect(sentences.map((sentence) => sentence.text)).toEqual(['값은 3.14이다.', '“그렇다!”', '다음 줄。']);
  });

  it("moves later codepoint ranges by the edit length without changing gap text or IDs", () => {
    const text = " \t갑이다.\r\n\r\n을이다.  병이다.\n";
    const before = textSentences(text);
    const after = replaceTextSentence(text, before, "T1", "𠀀갑이었다.");
    const delta = Array.from("𠀀갑이었다.").length - Array.from("갑이다.").length;
    expect(after.text).toBe(" \t𠀀갑이었다.\r\n\r\n을이다.  병이다.\n");
    expect(after.sentences.slice(1)).toEqual(before.slice(1).map(sentence => ({ ...sentence, from: sentence.from + delta, to: sentence.to + delta })));
    expect(after.sentences.map(sentence => sentence.text)).toEqual(["𠀀갑이었다.", "을이다.", "병이다."]);
  });

  it("trims historical whitespace-owning groups while preserving internal CRLF and split/merge gaps", () => {
    const text = "  갑이다.\r\n\r\n을이다.  병이다.\n";
    const sentences = textSentences(text);
    const legacy = sentences.map((sentence, i) => {
      const from = i === 0 ? 0 : sentence.from;
      const to = sentences[i + 1]?.from ?? Array.from(text).length;
      return { ...sentence, from, to, text: Array.from(text).slice(from, to).join("") };
    });
    const links = sentences.map((sentence, i) => ({ sentenceId: sentence.id, groupId: i < 2 ? "g1" : "g2" }));
    const grouped = groupedTextSentences(text, legacy, links);
    expect(grouped.map(sentence => sentence.text)).toEqual(["갑이다.\r\n\r\n을이다.", "병이다."]);
    const split = trimTextSentences(text, [{ ...grouped[0]!, to: sentences[0]!.to }, { ...sentences[1]! }, grouped[1]!]);
    expect(split).toEqual(sentences);
    const edited = replaceTextSentence(text, split, "T2", "을이었다.");
    expect(edited.text).toBe("  갑이다.\r\n\r\n을이었다.  병이다.\n");
  });
});

describe("unchanged sentence matching", () => {
  it("matches exact unique sentences after insertion and reordering without relying on IDs", () => {
    const previous = textSentences("첫 𠮷 문장.\n둘째 문장.\n셋째 문장.");
    const next = textSentences("새 문장.\n셋째 문장.\n고친 첫 문장.\n둘째 문장.");
    expect([...matchUnchangedTextSentences(previous, next)]).toEqual([["T2", "T3"], ["T4", "T2"]]);
  });

  it.each<[string, string, Array<[string, string]>]>([
    ["같다.\n같다.\n고유하다.", "같다.\n고유하다.", [["T2", "T3"]]],
    ["같다.\n고유하다.", "같다.\n같다.\n고유하다.", [["T3", "T2"]]],
  ])("does not guess which repeated sentence survived", (previous, next, expected) => {
    expect([...matchUnchangedTextSentences(textSentences(previous), textSentences(next))]).toEqual(expected);
  });

  it("does not normalize spaces or punctuation when inferring unchanged content", () => {
    expect([...matchUnchangedTextSentences(textSentences("옛 문장.\n둘째 문장!"), textSentences("옛  문장.\n둘째 문장?"))]).toEqual([]);
  });
});

describe("full editor with independent groups", () => {
  it("removes blank lines without merging identities or changing group text", () => {
    const text = "첫 문장.\n\n둘째 문장.";
    const before = textSentences(text);
    const result = editGroupedText(text, before, "첫 문장.둘째 문장.")!;
    expect(result.text).toBe("첫 문장.둘째 문장.");
    expect(result.sentences.map(s => [s.id, s.text])).toEqual(before.map(s => [s.id, s.text]));
    expect(result.changedIds).toEqual([]);
    expect(result.sentences[1]!.from).toBe(before[0]!.to);
  });
  it("preserves CRLFs and codepoint positions outside the edited region", () => {
    const text = "첫 𠀀 문장.\r\n\r\n둘째 문장.\r\n셋째 문장.";
    const result = editGroupedText(text, textSentences(text), "첫 𠀀 수정 문장.\n\n둘째 문장.\n셋째 문장.")!;
    expect(result.text).toBe("첫 𠀀 수정 문장.\r\n\r\n둘째 문장.\r\n셋째 문장.");
    expect(result.changedIds).toEqual(["T1"]);
    for (const s of result.sentences) expect(Array.from(result.text).slice(s.from, s.to).join("")).toBe(s.text);
  });
  it("inserts internal paragraphs in one group and new boundary whitespace between groups", () => {
    const text = "첫 문장. 둘째 문장.";
    const result = editGroupedText(text, textSentences(text), "첫\n\n문장. 둘째 문장.")!;
    expect(result.sentences).toHaveLength(2);
    expect(result.sentences[0]!.text).toBe("첫\n\n문장.");
    const boundary = editGroupedText(text, textSentences(text), "첫 문장.\n\n둘째 문장.")!;
    expect(boundary.changedIds).toEqual([]);
    expect(boundary.sentences).toHaveLength(2);
  });
  it("rejects a deletion across group bodies instead of guessing source ownership", () => {
    const text = "첫 문장. 둘째 문장.";
    expect(editGroupedText(text, textSentences(text), "첫 문장.")).toBeNull();
  });
});
