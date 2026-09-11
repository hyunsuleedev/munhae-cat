import { describe, expect, it } from "vitest";
import { appendDictionaryCitation, dictionaryCitation, dictionaryReferenceLinks } from "../src/renderer/scripts/dictionary-citation";
import type { DictionaryEntry } from "../src/shared/dictionary-types";

const entry: DictionaryEntry = {
  id: "wiktionary:目", headword: "目", reading: "목", kind: "character", source: "wiktionary",
  sourceLabel: "한국어 위키낱말사전", sourceUrl: "https://ko.wiktionary.org/wiki/目",
  license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  attribution: "한국어 위키낱말사전 기여자 · 가공: 문해", senses: [{ text: "첫째 뜻" }, { text: "둘째 뜻", label: "명사" }], canCite: true,
};
describe("selected dictionary meaning provenance", () => {
  it("carries only the chosen meaning together with author, source and license", () => {
    const text = dictionaryCitation(entry, 1);
    expect(text).toContain("둘째 뜻"); expect(text).not.toContain("첫째 뜻");
    for (const value of [entry.headword, entry.sourceUrl, entry.attribution, entry.licenseUrl!]) expect(text).toContain(value);
    expect(text).toContain("검토 필요");
  });
  it("does not copy unlicensed web summaries or missing definitions", () => {
    expect(() => dictionaryCitation({ ...entry, canCite: false }, 0)).toThrow();
    expect(() => dictionaryCitation({ ...entry, senses: [{ text: " " }] }, 0)).toThrow();
    expect(() => dictionaryCitation(entry, 20)).toThrow();
  });
  it("preserves the translator opinion, prevents duplicates and respects the comment limit", () => {
    const citation = dictionaryCitation(entry, 0);
    const appended = appendDictionaryCitation("이 문장에서는 다른 의미일 수 있다.", citation);
    expect(appended.startsWith("이 문장에서는 다른 의미일 수 있다.\n\n")).toBe(true);
    expect(() => appendDictionaryCitation(appended, citation)).toThrow(/이미/);
    expect(() => appendDictionaryCitation("기존 의견", citation, 10)).toThrow(/한도/);
  });
  it("keeps exact supplementary and compatibility characters in fixed-host links", () => {
    const query = "𠮷神&x=<script>";
    const links = dictionaryReferenceLinks(query);
    const naver = new URL(links[0]!.url);
    expect(naver.host).toBe("hanja.dict.naver.com");
    expect(new URLSearchParams(naver.hash.split("?")[1]).get("query")).toBe(query);
    expect(new URL(links[1]!.url).searchParams.get("q")).toBe(query);
    expect(new URL(links[2]!.url).searchParams.get("q")).toContain(query);
    expect(links.every(link => new URL(link.url).protocol === "https:")).toBe(true);
  });
});
