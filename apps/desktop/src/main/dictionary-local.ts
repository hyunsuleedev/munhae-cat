import libhangul from "./data/hanja-libhangul.json";
import wiktionary from "./data/hanja-wiktionary.json";
import unihanRaw from "./data/hanja-unihan.json?raw";
import type { DictionaryCharacterInfo, DictionaryDatasetInfo, DictionaryEntry, DictionarySearchResult, DictionaryVariantKind } from "../shared/dictionary-types";

// Only generated dictionary data have the licenses declared below; the surrounding
// application module is not part of the adapted Wiktionary dataset.
type LocalSource = "libhangul" | "wiktionary" | "unihan";
type UnihanRow = [number, string, number, string[], Partial<Record<DictionaryVariantKind, string>>];
// A raw import avoids TypeScript inferring an enormous union for 100k compact
// tuples. Vite still bundles this data in the lazily loaded dictionary module.
const unihan = JSON.parse(unihanRaw) as {
  unicodeVersion: string;
  dataset: DictionaryDatasetInfo;
  radicals: Record<string, string>;
  entries: UnihanRow[];
};
type Row = {
  headword: string;
  readings: string[];
  senses: { text: string; label?: string; reading?: string }[];
  unihan?: UnihanRow;
};
type IndexedRow = { source: LocalSource; row: Row };
const PAGE_SIZE = 20;
const DATASETS: Record<LocalSource, DictionaryDatasetInfo> = {
  libhangul: { ...libhangul.dataset, id: "libhangul" },
  wiktionary: { ...wiktionary.dataset, id: "wiktionary" },
  unihan: { ...unihan.dataset, id: "unihan" },
};
const SOURCE_ORDER: Record<LocalSource, number> = { wiktionary: 0, libhangul: 1, unihan: 2 };
const HAN = /\p{Script=Han}/u;
const KOREAN_ONLY = /^[\p{Script=Hangul}\s]+$/u;
let index: { headwords: Map<string, IndexedRow[]>; readings: Map<string, IndexedRow[]> } | undefined;

function addIndex(map: Map<string, IndexedRow[]>, key: string, entry: IndexedRow): void {
  const rows = map.get(key);
  if (rows) rows.push(entry);
  else map.set(key, [entry]);
}

function getIndex(): NonNullable<typeof index> {
  if (index) return index;
  const headwords = new Map<string, IndexedRow[]>();
  const readings = new Map<string, IndexedRow[]>();
  for (const [source, rows] of [["wiktionary", wiktionary.entries], ["libhangul", libhangul.entries]] as const) {
    for (const row of rows) {
      const entry = { source, row };
      addIndex(headwords, row.headword, entry);
      for (const reading of row.readings) addIndex(readings, reading, entry);
    }
  }
  for (const properties of unihan.entries) {
    const entry: IndexedRow = { source: "unihan", row: {
      headword: String.fromCodePoint(properties[0]), readings: properties[3], senses: [], unihan: properties,
    } };
    addIndex(headwords, entry.row.headword, entry);
    for (const reading of entry.row.readings) addIndex(readings, reading, entry);
  }
  index = { headwords, readings };
  return index;
}

function entryId(entry: IndexedRow): string {
  return `${entry.source}:${Array.from(entry.row.headword, (char) => char.codePointAt(0)!.toString(16)).join("-")}`;
}

function toEntry(entry: IndexedRow): DictionaryEntry {
  const { row, source } = entry;
  const dataset = DATASETS[source];
  const title = encodeURIComponent(row.headword);
  const history = `https://ko.wiktionary.org/w/index.php?title=${title}&action=history`;
  if (source === "unihan" && row.unihan) {
    const info = unihanCharacterInfo(row.unihan);
    return {
      id: entryId(entry), headword: row.headword, kind: "character",
      reading: row.readings.length ? row.readings.join(", ") : null,
      source, sourceLabel: dataset.label, sourceUrl: `https://www.unicode.org/cgi-bin/GetUnihanData.pl?codepoint=${info.codePoint.slice(2)}`,
      license: dataset.license, licenseUrl: dataset.licenseUrl,
      attribution: `Unicode, Inc. 및 기여자. Unihan ${unihan.unicodeVersion}; ${dataset.updatedAt}에 원자료 확인. 독음·부수·획수·종류별 이체 관계만 추출하고 독음의 소스 코드를 제거했습니다. 원문 자형과 이체 관계를 자동 치환하지 않습니다.`,
      senses: [], canCite: false, characterInfo: info,
    };
  }
  return {
    id: entryId(entry), headword: row.headword,
    reading: row.readings.length ? row.readings.join(", ") : null,
    kind: Array.from(row.headword).length === 1 ? "character" : "word",
    source, sourceLabel: dataset.label,
    sourceUrl: source === "wiktionary" ? `https://ko.wiktionary.org/wiki/${title}` : dataset.sourceUrl,
    license: dataset.license, licenseUrl: dataset.licenseUrl,
    attribution: source === "wiktionary"
      ? `한국어 위키낱말사전 기여자 · 편집 이력: ${history} · Kaikki/Wiktextract 추출 · ${wiktionary.provenance.dumpDate} 덤프. 뜻풀이를 선별·병합하고 예문을 제외했습니다. 일부 원문은 국립국어원 자료(CC-BY-SA-2.0-KR, https://creativecommons.org/licenses/by-sa/2.0/kr/).${row.readings.length ? " 독음: Choe Hwanjin/libhangul(BSD-3-Clause)." : ""}`
      : "Copyright (c) 2005,2006 Choe Hwanjin / libhangul. BSD-3-Clause. 낱자를 선별하고 독음별 훈을 병합했습니다. 원자료의 빈 뜻은 유지했습니다.",
    senses: row.senses.map((sense) => source === "libhangul"
      ? { text: sense.text, label: `${sense.reading ?? ""}${sense.text ? " · 기본 훈" : " · 뜻 미수록"}` }
      : { text: sense.text, ...(sense.label ? { label: sense.label } : {}) }),
    canCite: row.senses.some((sense) => sense.text.trim().length > 0),
  };
}

function unihanCharacterInfo(properties: UnihanRow): DictionaryCharacterInfo {
  const [cp, radicalStrokes, defaultStrokes, , variantValues] = properties;
  return {
    codePoint: `U+${cp.toString(16).toUpperCase()}`, unicodeVersion: unihan.unicodeVersion,
    radicals: radicalStrokes.split(" ").filter(Boolean).map((raw) => {
      // Build-time validation ensures valid values. Keep all forms and negative
      // residuals: the residual count must never be used as the total count.
      const match = /^(\d+)('{0,3})\.(-?\d+)$/.exec(raw)!;
      const variantIndex = match[2]!.length as 0 | 1 | 2 | 3;
      return {
        number: Number(match[1]), glyph: unihan.radicals[`${match[1]}${match[2]}`]!,
        simplified: variantIndex > 0, variantIndex, residualStrokes: Number(match[3]), raw,
      };
    }),
    totalStrokes: [defaultStrokes],
    variants: (Object.entries(variantValues) as [DictionaryVariantKind, string][]).map(([kind, values]) => {
      const rawValues = values.split(" ");
      return { kind, rawValues, characters: [...new Set(rawValues.map((raw) => String.fromCodePoint(Number.parseInt(raw.slice(2).split("<")[0]!, 16))))] };
    }),
  };
}

/** Metadata counts are measured headwords, not meanings, source lines or readings. */
export function getLocalDictionaryDatasets(): DictionaryDatasetInfo[] {
  return ["libhangul", "wiktionary", "unihan"].map((source) => ({ ...DATASETS[source as LocalSource] }));
}

/** Exact headwords first, then exact Korean readings, character fallback and prefixes. */
export function searchLocalDictionary(query: string, page = 1): DictionarySearchResult {
  const cleanQuery = query.trim();
  // NFC is confined to a Hangul-only query. Applying it to Han text can merge
  // compatibility ideographs, so even NFC (as well as NFKC) must not be global.
  const lookup = KOREAN_ONLY.test(cleanQuery) ? cleanQuery.normalize("NFC") : cleanQuery;
  const currentPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  const result: DictionarySearchResult = {
    query: cleanQuery, provider: "local", page: currentPage, total: 0,
    hasMore: false, entries: [], notices: [],
  };
  if (!lookup) return result;
  const { headwords, readings } = getIndex();
  const matches = new Map<IndexedRow, { entry: IndexedRow; rank: number; position: number }>();
  function add(rows: IndexedRow[] | undefined, rank: number, position = 0): void {
    for (const entry of rows ?? []) if (!matches.has(entry)) matches.set(entry, { entry, rank, position });
  }
  const exact = headwords.get(lookup);
  add(exact, 0);
  add(readings.get(lookup), 1);
  const characters = [...new Set(Array.from(lookup).filter((char) => HAN.test(char)))];
  if (Array.from(lookup).length > 1) {
    characters.forEach((character, position) => add(headwords.get(character), 2, position));
  }
  const prefixIndex = KOREAN_ONLY.test(lookup) ? readings : headwords;
  for (const [key, entries] of prefixIndex) {
    if (key.length > lookup.length && key.startsWith(lookup)) add(entries, 3);
  }
  const sorted = [...matches.values()].sort((a, b) =>
    a.rank - b.rank || a.position - b.position ||
    Number(!a.entry.row.senses.some((sense) => sense.text)) - Number(!b.entry.row.senses.some((sense) => sense.text)) ||
    (a.entry.row.headword < b.entry.row.headword ? -1 : a.entry.row.headword > b.entry.row.headword ? 1 : 0) ||
    SOURCE_ORDER[a.entry.source] - SOURCE_ORDER[b.entry.source]);
  result.total = sorted.length;
  const offset = (currentPage - 1) * PAGE_SIZE;
  result.entries = sorted.slice(offset, offset + PAGE_SIZE).map(({ entry }) => toEntry(entry));
  result.hasMore = offset + result.entries.length < sorted.length;
  if (!exact && characters.length > 1 && sorted.some((row) => row.rank === 2)) {
    result.notices.push("이 오프라인 자료에 정확히 일치하는 어휘가 없어 포함된 낱자를 함께 표시합니다. 낱자의 뜻을 합쳐 어휘 뜻으로 확정하지 마세요.");
  }
  if (result.entries.some((entry) => entry.source === "libhangul" && entry.senses.some((sense) => !sense.text))) {
    result.notices.push("일부 독음에는 원자료의 뜻풀이가 없습니다. ‘뜻 미수록’은 뜻이 없다는 판정이 아닙니다.");
  }
  if (result.entries.length && result.entries.every((entry) => entry.source === "unihan")) {
    result.notices.push("문자 속성만 수록된 결과입니다. 한국어 뜻풀이는 없으며 이체 관계는 문맥과 자형을 확인하는 참고 정보입니다.");
  }
  if (sorted.length === 0) result.notices.push("오프라인 사전에 수록된 결과가 없습니다. 원문의 자형은 자동 변환하지 않았습니다.");
  return result;
}
