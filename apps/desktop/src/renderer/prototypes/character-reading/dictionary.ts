import { IPC_CHANNELS } from "../../../shared/munhae-api";
import type { DictionaryCharacterInfo, DictionaryEntry } from "../../../shared/dictionary-types";

export type { DictionaryEntry } from "../../../shared/dictionary-types";
export type CharacterLookupResult = { query: string; entries: DictionaryEntry[]; notices: string[] };

const cache = new Map<string, Promise<CharacterLookupResult>>();
const sources = new Set(["libhangul", "wiktionary", "unihan", "kostma", "opendict", "stdict"]);
const variantKinds = new Set(["semantic", "specializedSemantic", "z", "traditional", "simplified"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function characterInfo(value: unknown): value is DictionaryCharacterInfo {
  return record(value) && typeof value.codePoint === "string" && typeof value.unicodeVersion === "string"
    && Array.isArray(value.totalStrokes) && value.totalStrokes.every(finite)
    && Array.isArray(value.radicals) && value.radicals.every(radical => record(radical)
      && finite(radical.number) && typeof radical.glyph === "string" && typeof radical.simplified === "boolean"
      && [0, 1, 2, 3].includes(radical.variantIndex as number) && finite(radical.residualStrokes) && typeof radical.raw === "string")
    && Array.isArray(value.variants) && value.variants.every(variant => record(variant)
      && typeof variant.kind === "string" && variantKinds.has(variant.kind)
      && strings(variant.characters) && strings(variant.rawValues));
}

function dictionaryEntry(value: unknown): value is DictionaryEntry {
  return record(value)
    && ["id", "headword", "sourceLabel", "sourceUrl", "license", "attribution"].every(key => typeof value[key] === "string")
    && (value.reading === null || typeof value.reading === "string")
    && (value.licenseUrl === null || typeof value.licenseUrl === "string")
    && (value.kind === "character" || value.kind === "word")
    && typeof value.source === "string" && sources.has(value.source) && typeof value.canCite === "boolean"
    && Array.isArray(value.senses) && value.senses.every(sense => record(sense) && typeof sense.text === "string"
      && (sense.label === undefined || typeof sense.label === "string"))
    && (value.characterInfo === undefined || characterInfo(value.characterInfo))
    && (value.variants === undefined || strings(value.variants))
    && (value.radical === undefined || typeof value.radical === "string")
    && (value.strokes === undefined || finite(value.strokes));
}

function parseResult(value: unknown, query: string): CharacterLookupResult {
  if (!record(value) || typeof value.ok !== "boolean") throw new Error("사전 응답 형식을 확인할 수 없습니다. 다시 조회해 주세요.");
  if (!value.ok) {
    const message = record(value.error) && typeof value.error.message === "string" ? value.error.message : "내장 사전을 조회하지 못했습니다.";
    throw new Error(message);
  }
  const data = value.data;
  if (!record(data) || data.query !== query || data.provider !== "local" || data.page !== 1
    || !Array.isArray(data.entries) || !data.entries.every(dictionaryEntry) || !strings(data.notices)) {
    throw new Error("내장 사전의 검색 결과를 읽을 수 없습니다. 다시 조회해 주세요.");
  }
  // Preserve the exact glyph. Related spellings and prefix matches are not
  // definitions of the selected character.
  return { query, entries: data.entries.filter(entry => entry.headword === query), notices: data.notices };
}

async function requestCharacter(query: string): Promise<CharacterLookupResult> {
  const input = { query, provider: "local" as const, page: 1 };
  if (typeof window !== "undefined" && window.munhae?.dictionary?.search) {
    let result: unknown;
    try { result = await window.munhae.dictionary.search(input); }
    catch { throw new Error("내장 사전에 연결하지 못했습니다. 문해 앱에서 다시 시도해 주세요."); }
    return parseResult(result, query);
  }
  let response: Response;
  try {
    response = await fetch("/__munhae/api", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: IPC_CHANNELS.dictionarySearch, args: [input] }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("내장 사전에 연결하지 못했습니다. 문해 Electron 앱이 실행 중인지 확인하고 다시 시도해 주세요.");
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error("사전 연결 응답을 읽을 수 없습니다. 문해 앱 연결을 확인해 주세요."); }
  if (!response.ok) {
    throw new Error(record(payload) && typeof payload.error === "string"
      ? payload.error : "사전 연결에 실패했습니다. 문해 앱 연결을 확인해 주세요.");
  }
  if (!record(payload) || !("value" in payload)) throw new Error("사전 검색 응답이 비어 있습니다. 다시 시도해 주세요.");
  return parseResult(payload.value, query);
}

/** Read-only access to the existing local dictionary, shared per exact query. */
export function lookupCharacter(value: string): Promise<CharacterLookupResult> {
  const query = value.trim().replace(/\s+/gu, " ");
  if (!query || Array.from(query).length > 100) return Promise.reject(new Error("검색할 한자나 어휘를 1~100자로 입력해 주세요."));
  const existing = cache.get(query);
  if (existing) return existing;
  const pending = requestCharacter(query).catch(error => {
    cache.delete(query);
    throw error;
  });
  cache.set(query, pending);
  return pending;
}
