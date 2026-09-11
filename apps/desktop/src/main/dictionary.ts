import type {
  DictionaryProvider, DictionarySearchInput, DictionarySearchResult,
  DictionarySetKeyInput, DictionaryStatus,
} from "../shared/dictionary-types";
import { withAccount } from "./auth";
import { getDictionaryKey, getDictionaryKeyStatus, setDictionaryKey } from "./dictionary-credentials";
import { searchOnlineDictionary } from "./dictionary-online";
import { AppError, errorCode } from "./errors";

const PROVIDERS: readonly DictionaryProvider[] = ["local", "kostma", "opendict", "stdict"];
const INVALID_QUERY_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;

function invalidPayload(message: string): never {
  throw new AppError("invalid_payload", message);
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidPayload("사전 요청 형식이 올바르지 않습니다.");
  }
  if (Object.keys(value).some((field) => !fields.includes(field))) {
    invalidPayload("사전 요청에 허용되지 않은 항목이 있습니다.");
  }
  return value as Record<string, unknown>;
}

export function parseDictionarySearchInput(value: unknown): Required<DictionarySearchInput> {
  const input = exactRecord(value, ["query", "provider", "page"]);
  if (typeof input.query !== "string" || INVALID_QUERY_CHARACTERS.test(input.query)) {
    invalidPayload("검색어에는 제어 문자 없이 글자를 입력하세요.");
  }
  // Preserve the original Hanja, including compatibility forms and IVS. Only
  // whitespace is normalized; Unicode normalization can replace historic glyphs.
  const query = input.query.trim().replace(/\s+/gu, " ");
  const length = Array.from(query).length;
  if (length < 1 || length > 100) {
    invalidPayload("검색어는 1자 이상 100자 이하로 입력하세요.");
  }
  const provider = input.provider === undefined ? "local" : input.provider;
  if (typeof provider !== "string" || !PROVIDERS.includes(provider as DictionaryProvider)) {
    invalidPayload("지원하지 않는 사전입니다.");
  }
  const page = input.page === undefined ? 1 : input.page;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 100) {
    invalidPayload("사전 페이지는 1부터 100까지의 정수여야 합니다.");
  }
  return { query, provider: provider as DictionaryProvider, page };
}

export function parseDictionarySetKeyInput(value: unknown): DictionarySetKeyInput {
  const input = exactRecord(value, ["provider", "apiKey"]);
  if (input.provider !== "opendict" && input.provider !== "stdict") {
    invalidPayload("인증 키를 설정할 수 없는 사전입니다.");
  }
  if (typeof input.apiKey !== "string") invalidPayload("인증 키를 입력하세요.");
  const apiKey = input.apiKey.trim();
  if (apiKey !== "" && !/^[a-fA-F0-9]{32}$/.test(apiKey)) {
    invalidPayload("발급받은 32자리 영문·숫자 인증 키를 입력하세요.");
  }
  return { provider: input.provider, apiKey };
}

async function requireDictionaryAccount(): Promise<void> {
  const state = await withAccount((account) => account.getState());
  if (state.status !== "signed_in" || !state.user) {
    throw new AppError("auth_required", "사전을 사용하려면 먼저 로그인하세요.");
  }
}

async function status(): Promise<DictionaryStatus> {
  const keys = getDictionaryKeyStatus();
  const { getLocalDictionaryDatasets } = await import("./dictionary-local");
  return {
    datasets: getLocalDictionaryDatasets(),
    // Explicitly project booleans so a credential store cannot add secret fields
    // to the renderer contract by returning a wider object in the future.
    keys: { opendict: keys.opendict === true, stdict: keys.stdict === true },
  };
}

export async function dictionarySearch(value: unknown): Promise<DictionarySearchResult> {
  await requireDictionaryAccount();
  const input = parseDictionarySearchInput(value);
  if (input.provider === "local") {
    // Keep the offline JSON out of startup and online-only lookups. The module
    // loader reuses the dataset after the first authenticated dictionary use.
    const { searchLocalDictionary } = await import("./dictionary-local");
    return searchLocalDictionary(input.query, input.page);
  }
  // Online lookups are explicit. Neither a local miss nor a key setting starts
  // a network request; keys stay in main and never enter a project or IPC result.
  const key = input.provider === "opendict" || input.provider === "stdict"
    ? getDictionaryKey(input.provider) ?? undefined : undefined;
  return searchOnlineDictionary(input, key);
}

export async function dictionaryGetStatus(): Promise<DictionaryStatus> {
  await requireDictionaryAccount();
  return status();
}

export async function dictionarySetKey(value: unknown): Promise<DictionaryStatus> {
  await requireDictionaryAccount();
  const input = parseDictionarySetKeyInput(value);
  try {
    setDictionaryKey(input);
    return await status();
  } catch (error) {
    // OS/file errors must never echo a supplied credential through IPC errors.
    throw new AppError(errorCode(error), "사전 인증 키를 저장하지 못했습니다. 기기의 보안 저장소를 확인하세요.");
  }
}
