import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import libhangul from "../src/main/data/hanja-libhangul.json";
import wiktionary from "../src/main/data/hanja-wiktionary.json";
import { getLocalDictionaryDatasets, searchLocalDictionary } from "../src/main/dictionary-local";

describe("offline dictionary", () => {
  it("returns licensed Korean senses for 目 and retains per-source provenance", () => {
    const result = searchLocalDictionary("目");
    const exact = result.entries.filter((entry) => entry.headword === "目");
    expect(exact.map((entry) => entry.source)).toEqual(["wiktionary", "libhangul", "unihan"]);
    expect(exact.slice(0, 2).every((entry) => entry.kind === "character" && entry.canCite)).toBe(true);
    expect(exact[0]?.senses.some((sense) => sense.text.includes("눈"))).toBe(true);
    expect(exact[0]?.attribution).toContain("action=history");
    expect(exact[0]?.license).toBe("CC-BY-SA-4.0");
    expect(exact[1]?.license).toBe("BSD-3-Clause");
    expect(exact[1]?.reading).toBe("목");
  });

  it("keeps 謚's missing 시 meaning separate from its 익 gloss and from 諡", () => {
    const result = searchLocalDictionary("謚");
    const item = result.entries.find((entry) => entry.headword === "謚" && entry.source === "libhangul")!;
    expect(item.reading).toBe("시, 익");
    expect(item.senses).toContainEqual({ text: "", label: "시 · 뜻 미수록" });
    expect(item.senses.some((sense) => sense.label?.startsWith("익") && sense.text.includes("웃"))).toBe(true);
    expect(result.notices.some((notice) => notice.includes("원자료의 뜻풀이"))).toBe(true);
    expect(result.entries.some((entry) => entry.headword === "諡")).toBe(false);
    const other = searchLocalDictionary("諡").entries.find((entry) => entry.source === "wiktionary" && entry.headword === "諡")!;
    expect(other.senses.some((sense) => sense.text.includes("시호"))).toBe(true);
  });

  it("prioritizes the exact 太守 word over its character fallback and supports Korean reading lookup", () => {
    const result = searchLocalDictionary("太守");
    expect(result.entries[0]).toMatchObject({ headword: "太守", reading: "태수", kind: "word", source: "wiktionary" });
    expect(result.entries[0]?.senses.some((sense) => sense.text.includes("벼슬"))).toBe(true);
    expect(result.entries.some((entry) => entry.headword === "太" && entry.kind === "character")).toBe(true);
    expect(searchLocalDictionary("태수").entries[0]?.headword).toBe("太守");
    expect(searchLocalDictionary("목").entries.some((entry) => entry.headword === "目")).toBe(true);
  });

  it("does not invent a 提調 dictionary meaning from its component characters", () => {
    const result = searchLocalDictionary("提調");
    expect(result.entries.map((entry) => entry.headword)).toEqual(expect.arrayContaining(["提", "調"]));
    expect(result.entries.some((entry) => entry.headword === "提調")).toBe(false);
    expect(result.notices.some((notice) => notice.includes("정확히 일치하는 어휘가 없어"))).toBe(true);
  });

  it("treats non-BMP characters as single characters without fabricating meanings for 𠮷", () => {
    const available = searchLocalDictionary("𪚥").entries.find((entry) => entry.headword === "𪚥")!;
    expect(available.kind).toBe("character");
    expect(available.id).toContain("2a6a5");
    const propertiesOnly = searchLocalDictionary("𠮷");
    expect(propertiesOnly.entries).toHaveLength(1);
    expect(propertiesOnly.entries[0]).toMatchObject({
      headword: "𠮷", reading: null, kind: "character", source: "unihan", senses: [], canCite: false,
      characterInfo: { codePoint: "U+20BB7", radicals: [{ number: 30, glyph: "口", residualStrokes: 3, raw: "30.3" }], totalStrokes: [6] },
    });
    expect(propertiesOnly.query).toBe("𠮷");
    expect(propertiesOnly.notices.some((notice) => notice.includes("문자 속성만"))).toBe(true);
    expect(searchLocalDictionary("𠮷目").entries.some((entry) => entry.headword === "目")).toBe(true);
  });

  it("never normalizes a compatibility ideograph to another headword", () => {
    const compatibilityCharacter = "金";
    expect(compatibilityCharacter.normalize("NFKC")).toBe("金");
    expect(searchLocalDictionary("金").entries.some((entry) => entry.headword === "金")).toBe(true);
    const result = searchLocalDictionary(compatibilityCharacter);
    expect(result.query).toBe(compatibilityCharacter);
    expect(result.entries.some((entry) => entry.headword === "金")).toBe(false);
  });

  it("paginates the entire ranked result set without duplicates or changing totals", () => {
    const first = searchLocalDictionary("가");
    const second = searchLocalDictionary("가", 2);
    expect(first.entries).toHaveLength(20);
    expect(second.entries).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(second.total).toBe(first.total);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(40);
    const last = searchLocalDictionary("가", Math.ceil(first.total / 20));
    expect(last.hasMore).toBe(false);
    expect(last.entries.length).toBeGreaterThan(0);
    const pastEnd = searchLocalDictionary("가", Math.ceil(first.total / 20) + 1);
    expect(pastEnd.entries).toEqual([]);
    expect(pastEnd.total).toBe(first.total);
    expect(searchLocalDictionary("가", -2).page).toBe(1);
  });

  it("counts measured headwords, excludes quotation fields, and protects cached data from callers", () => {
    const datasets = getLocalDictionaryDatasets();
    expect(datasets.map((dataset) => dataset.entryCount)).toEqual([libhangul.entries.length, wiktionary.entries.length, 102998]);
    expect(libhangul.provenance.charactersWithMeaning).toBe(7374);
    expect(wiktionary.entries.every((entry) => entry.senses.every((sense) => Object.keys(sense).every((key) => ["text", "label"].includes(key))))).toBe(true);
    expect(wiktionary.provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
    const mutable = searchLocalDictionary("目");
    mutable.entries[0]!.senses[0]!.text = "changed by caller";
    datasets[0]!.label = "changed by caller";
    expect(searchLocalDictionary("目").entries[0]?.senses[0]?.text).not.toBe("changed by caller");
    expect(getLocalDictionaryDatasets()[0]?.label).not.toBe("changed by caller");
    expect(searchLocalDictionary("  ").entries).toEqual([]);
  });

  it("returns Korean reading and licensed Unicode properties separately from meanings", () => {
    const properties = searchLocalDictionary("目").entries.find((entry) => entry.source === "unihan")!;
    expect(properties).toMatchObject({
      sourceLabel: "Unicode Unihan 문자 속성", reading: "목", senses: [], canCite: false,
      license: "Unicode-3.0", licenseUrl: "https://www.unicode.org/license.txt",
      sourceUrl: "https://www.unicode.org/cgi-bin/GetUnihanData.pl?codepoint=76EE",
      characterInfo: {
        codePoint: "U+76EE", unicodeVersion: "17.0.0",
        radicals: [{ number: 109, glyph: "目", simplified: false, variantIndex: 0, residualStrokes: 0, raw: "109.0" }],
        totalStrokes: [5],
      },
    });
    // Include all pages: Korean readings can match many sourced entries.
    const readingResult = searchLocalDictionary("목");
    const all = [...readingResult.entries];
    for (let page = 2; page <= Math.ceil(readingResult.total / 20); page++) all.push(...searchLocalDictionary("목", page).entries);
    expect(all.some((entry) => entry.id === properties.id)).toBe(true);
    expect(all.filter((entry) => entry.source === "unihan").every((entry) => !entry.reading?.includes(":"))).toBe(true);
  });

  it("preserves multiple radicals, negative residuals and every radical variant index", () => {
    const info = (query: string) => searchLocalDictionary(query).entries.find((entry) => entry.source === "unihan" && entry.headword === query)!.characterInfo!;
    expect(info("㚇").radicals.map((radical) => radical.raw)).toEqual(["35.6", "66.6"]);
    expect(info("㚇").totalStrokes).toEqual([9]);
    expect(info("王").radicals).toContainEqual({ number: 96, glyph: "玉", simplified: false, variantIndex: 0, residualStrokes: -1, raw: "96.-1" });
    expect(info("竜").radicals).toContainEqual({ number: 212, glyph: "竜", simplified: true, variantIndex: 2, residualStrokes: 0, raw: "212''.0" });
    expect(info("𱷥").radicals.some((radical) => radical.variantIndex === 3 && radical.raw === "212'''.0")).toBe(true);
    expect(info("龙").radicals.some((radical) => radical.variantIndex === 1)).toBe(true);
  });

  it("keeps variant kinds, source qualifiers and one-to-many or self relationships", () => {
    const variants = (query: string) => searchLocalDictionary(query).entries.find((entry) => entry.source === "unihan" && entry.headword === query)!.characterInfo!.variants;
    expect(variants("謚")).toContainEqual({ kind: "semantic", characters: ["諡"], rawValues: ["U+8AE1<kMatthews"] });
    expect(variants("謚")).toContainEqual({ kind: "simplified", characters: ["谥"], rawValues: ["U+8C25"] });
    expect(variants("竜").find((variant) => variant.kind === "specializedSemantic")?.characters).toContain("龍");
    expect(variants("㖈").find((variant) => variant.kind === "z")?.characters).toContain("䎛");
    expect(variants("万")).toContainEqual({ kind: "traditional", characters: ["万", "萬"], rawValues: ["U+4E07", "U+842C"] });
    expect(variants("万")).toContainEqual({ kind: "simplified", characters: ["万"], rawValues: ["U+4E07"] });
    expect(searchLocalDictionary("謚").entries.find((entry) => entry.source === "unihan")?.reading).toBe("익");
    expect(searchLocalDictionary("謚").entries.every((entry) => entry.headword !== "諡")).toBe(true);
  });

  it("does not expose mutable Unicode metadata or bundle English definitions", () => {
    const get = () => searchLocalDictionary("万").entries.find((entry) => entry.source === "unihan")!;
    const original = get();
    const mutable = get();
    mutable.characterInfo!.radicals[0]!.residualStrokes = 999;
    mutable.characterInfo!.totalStrokes.push(999);
    mutable.characterInfo!.variants[0]!.characters.push("假");
    mutable.characterInfo!.variants[0]!.rawValues.push("U+5047");
    expect(get()).toEqual(original);
    // Read as runtime JSON so TypeScript does not infer 100k compact tuples.
    const generated = JSON.parse(readFileSync(new URL("../src/main/data/hanja-unihan.json", import.meta.url), "utf8"));
    expect(generated.entries).toHaveLength(102998);
    expect(generated.provenance.propertyCounts.kHangul).toBe(8525);
    expect(generated.provenance.properties).toEqual([
      "kHangul", "kRSUnicode", "kSemanticVariant", "kSimplifiedVariant", "kSpecializedSemanticVariant", "kTotalStrokes", "kTraditionalVariant", "kZVariant",
    ]);
    expect(generated.provenance.sources.every((source: { sha256: string }) => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
    const notice = readFileSync(new URL("../src/main/data/hanja-Unihan-NOTICE.txt", import.meta.url), "utf8");
    expect(notice).toContain("UNICODE LICENSE V3");
    expect(notice).toContain("Copyright © 1991-2026 Unicode, Inc.");
  });
});
