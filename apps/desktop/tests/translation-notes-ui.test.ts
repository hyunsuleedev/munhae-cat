import { expect, it } from "vitest";
import type { TranslationNote } from "../src/shared/munhae-api";
import { notesInSentences, notesListMarkup, parseAlternatives } from "../src/renderer/scripts/translation-notes-ui";

const note = (ordinal: number, from: number | null, patch: Partial<TranslationNote> = {}): TranslationNote => ({
  id: `n${ordinal}`, ordinal, kind: "allusion", confidence: "certain", targetQuote: "구절", from, to: from === null ? null : from + 2,
  sourceQuote: null, bodyMd: `각주 ${ordinal}`, alternatives: [], origin: "ai", ...patch,
});

it("gives each row the placed notes whose quote ends inside its saved sentences", () => {
  const notes = [note(1, 0), note(2, 8), note(3, 18), note(4, null)];
  expect(notesInSentences(notes, [{ from: 0, to: 10 }]).map(n => n.ordinal)).toEqual([1, 2]);
  expect(notesInSentences(notes, [{ from: 10, to: 20 }, { from: 30, to: 40 }]).map(n => n.ordinal)).toEqual([3]);
  // A quote ending exactly at a sentence start belongs to the sentence before it.
  expect(notesInSentences([note(5, 8)], [{ from: 10, to: 20 }])).toEqual([]);
});

it("lists notes with kind, doubt and alternatives only, escaping their text", () => {
  expect(notesListMarkup([])).toBe("");
  const html = notesListMarkup([
    note(1, 0),
    note(2, 4, { kind: "textual", confidence: "probable", bodyMd: "<樂>은 幾의 오자", alternatives: ["즐겼으니"] }),
    note(3, null, { kind: "identification" }),
  ]);
  expect(html).toContain('aria-label="각주"');
  expect(html).toContain('<span class="translation-note-num">1</span><p><span class="translation-note-meta">전고</span>각주 1</p>');
  expect(html).toContain('<span class="translation-note-meta">교감 · 유력</span>&lt;樂&gt;은 幾의 오자<span class="translation-note-alt">대안 즐겼으니</span>');
  expect(html).toContain('<span class="translation-note-meta">비정 · 위치 확인 필요</span>');
});

it("offers editing and removal only when the list is editable", () => {
  expect(notesListMarkup([note(1, 0)])).not.toContain("translation-note-actions");
  const html = notesListMarkup([note(1, 0, { id: "n<1>" })], true);
  expect(html).toContain('data-note-edit="n&lt;1&gt;" aria-label="각주 1 수정"');
  expect(html).toContain('data-note-remove="n&lt;1&gt;" aria-label="각주 1 삭제"');
});

it("reads alternative readings the way the list writes them", () => {
  expect(parseAlternatives(" 관선에 걸린 절구 / 관선에서 지은 절구 /  ")).toEqual(["관선에 걸린 절구", "관선에서 지은 절구"]);
  expect(parseAlternatives("a / b / c / d")).toEqual(["a", "b", "c"]);
  expect(parseAlternatives("")).toEqual([]);
});
