/** Dictionary text and provenance cross the IPC boundary; credentials never do. */
export type DictionarySource = "libhangul" | "wiktionary" | "unihan" | "kostma" | "opendict" | "stdict";
export type DictionaryProvider = "local" | "kostma" | "opendict" | "stdict";
export type DictionaryKeyProvider = "opendict" | "stdict";
export type DictionarySense = { text: string; label?: string };
export type DictionaryVariantKind = "semantic" | "specializedSemantic" | "z" | "traditional" | "simplified";
export type DictionaryCharacterInfo = {
  codePoint: string;
  unicodeVersion: string;
  radicals: Array<{
    number: number;
    glyph: string;
    simplified: boolean;
    /** 0=traditional, 1=Chinese simplified, 2/3=non-Chinese simplified forms. */
    variantIndex: 0 | 1 | 2 | 3;
    residualStrokes: number;
    /** Original kRSUnicode token, including apostrophes and negative residuals. */
    raw: string;
  }>;
  /** kTotalStrokes values in source order. Unicode 17 supplies one default value. */
  totalStrokes: number[];
  variants: Array<{ kind: DictionaryVariantKind; characters: string[]; rawValues: string[] }>;
};
export type DictionaryEntry = {
  id: string;
  headword: string;
  reading: string | null;
  kind: "character" | "word";
  source: DictionarySource;
  sourceLabel: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string | null;
  attribution: string;
  senses: DictionarySense[];
  /** False for character metadata or web summaries without a verified reuse grant. */
  canCite: boolean;
  characterInfo?: DictionaryCharacterInfo;
  variants?: string[];
  radical?: string;
  strokes?: number;
};
export type DictionarySearchInput = { query: string; provider: DictionaryProvider; page?: number };
export type DictionarySearchResult = {
  query: string;
  provider: DictionaryProvider;
  page: number;
  total: number;
  hasMore: boolean;
  entries: DictionaryEntry[];
  notices: string[];
};
export type DictionaryDatasetInfo = {
  id: "libhangul" | "wiktionary" | "unihan";
  label: string;
  entryCount: number;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  updatedAt: string;
  description: string;
};
export type DictionaryStatus = {
  datasets: DictionaryDatasetInfo[];
  keys: Record<DictionaryKeyProvider, boolean>;
};
export type DictionarySetKeyInput = { provider: DictionaryKeyProvider; apiKey: string };
