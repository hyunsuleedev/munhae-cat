import { DOMParser } from "@xmldom/xmldom";
import type { DictionaryEntry, DictionaryKeyProvider, DictionarySearchInput, DictionarySearchResult } from "../shared/dictionary-types";
import { AppError } from "./errors";

const PAGE_SIZE = 10;
const MAX_BYTES = 1_048_576;
const TIMEOUT_MS = 12_000;
const HOSTS = new Set(["kostma.aks.ac.kr", "opendict.korean.go.kr", "stdict.korean.go.kr"]);
const LABELS = { opendict: "국립국어원 우리말샘", stdict: "국립국어원 표준국어대사전" };
const LICENSE = "CC BY-SA 2.0 KR";
const LICENSE_URL = "https://creativecommons.org/licenses/by-sa/2.0/kr/";
type RequestInput = DictionarySearchInput & { page: number };
type Row = Record<string, unknown>;

function invalidResponse(): never {
  throw new AppError("dictionary_invalid_response", "사전 응답 형식을 확인할 수 없습니다. 잠시 후 다시 검색하세요.");
}
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidResponse();
  return value as Row;
}
function list(value: unknown): unknown[] { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function integer(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value))) return invalidResponse();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return invalidResponse();
  return number;
}
function inputValue(input: DictionarySearchInput): RequestInput {
  if (!input || !["kostma", "opendict", "stdict"].includes(input.provider) || typeof input.query !== "string"
    || /[\u0000-\u001f\u007f\p{Cs}]/u.test(input.query)) {
    throw new AppError("invalid_input", "검색어와 사전을 확인하세요.");
  }
  const query = input.query.trim();
  const page = input.page ?? 1;
  if (!query || [...query].length > 100 || !Number.isInteger(page) || page < 1 || page > 100) {
    throw new AppError("invalid_input", "검색어는 100자 이내, 검색 페이지는 1~100으로 입력하세요.");
  }
  if (input.provider === "kostma" && page !== 1) {
    throw new AppError("invalid_input", "고문헌 용어 검색은 공식 위젯의 첫 검색 결과를 제공합니다.");
  }
  return { provider: input.provider, query, page };
}

/** Fixed upstream addresses; a key-bearing URL never crosses IPC or enters error messages. */
export function buildOnlineDictionaryUrl(input: DictionarySearchInput, apiKey?: string): URL {
  const value = inputValue(input);
  if (value.provider === "kostma") {
    const url = new URL("https://kostma.aks.ac.kr/dataSearch/dataSearchAjax.aspx");
    for (const [name, content] of Object.entries({ callback: "resultDic", cateQ: "dic", mT: "B", query: value.query, queryT: value.query })) {
      url.searchParams.set(name, content);
    }
    return url;
  }
  if (!apiKey?.trim()) throw new AppError("dictionary_key_required", "이 사전은 무료 인증 키가 필요합니다. 사전 설정에서 발급받은 키를 등록하세요.");
  if (!/^[a-f\d]{32}$/i.test(apiKey.trim())) throw new AppError("dictionary_key_invalid", "사전 인증 키 형식이 올바르지 않습니다. 설정에서 키를 확인하세요.");
  const url = new URL(value.provider === "opendict" ? "https://opendict.korean.go.kr/api/search" : "https://stdict.korean.go.kr/api/search.do");
  const hanja = /\p{Script=Han}/u.test(value.query);
  for (const [name, content] of Object.entries({ key: apiKey.trim(), q: value.query, advanced: "y", target: hanja ? "2" : "1", method: "exact", req_type: "json", num: String(PAGE_SIZE), start: String((value.page - 1) * PAGE_SIZE + 1) })) {
    url.searchParams.set(name, content);
  }
  if (hanja && value.provider === "opendict") url.searchParams.set("lang", "2");
  return url;
}

function markupDocument(text: string, xml = false): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return invalidResponse();
  let malformed = false;
  const parser = new DOMParser({ errorHandler: () => { malformed = true; } });
  const doc = parser.parseFromString(text, xml ? "application/xml" : "text/html");
  if (!doc.documentElement || (xml && malformed)) return invalidResponse();
  return doc;
}

function plainNode(node: Node): string {
  if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue ?? "";
  if (node.nodeType !== 1 && node.nodeType !== 9) return "";
  const tag = node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : "";
  if (["script", "style", "iframe", "object", "template"].includes(tag)) return "";
  return Array.from(node.childNodes).map(plainNode).join(tag === "br" ? " " : "");
}
function text(value: unknown, limit = 12_000): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const raw = String(value);
  if (raw.length > limit || /<!DOCTYPE|<!ENTITY/i.test(raw)) return invalidResponse();
  // DOMParser never runs scripts or retrieves resources; the renderer receives text only.
  return plainNode(markupDocument(`<div>${raw}</div>`)).replace(/\s+/g, " ").trim();
}

function kostmaSummary(raw: string, headword: string, reading: string | null): { text: string; label: string } {
  const fallback = { text: "자세한 뜻풀이는 원문 사이트에서 확인하세요.", label: "검색 요약" };
  const indexPrefix = reading ? `${reading}${reading}${headword}` : "";
  if (!indexPrefix || !raw.startsWith(indexPrefix)) return { text: raw, label: "검색 요약" };
  const indexed = raw.slice(indexPrefix.length);
  // The live widget flattens title, romanizations, subject, category, period,
  // author and description into one string. There are no hidden HTML fields.
  // Split only the observed index format; never guess a definition boundary.
  const metadata = /^(?:[A-Za-z'’ -]+)?((?:법제·행정|역사)+)((?:제도\/관직|개념·용어\/역사|제도\/법제)+)(남북국시대\/통일신라|조선시대|고려시대)[\p{Script=Han}]{2,5}([\s\S]*)$/u.exec(indexed);
  if (!metadata) return fallback;
  const subjects = [...new Set(metadata[1]!.match(/법제·행정|역사/g))];
  const label = [...subjects, metadata[2], metadata[3]].join(" · ");
  const description = metadata[4]!.trim();
  return {
    text: !description || /^(?:\.{3,}|…+)$/.test(description) ? "검색 요약에는 뜻풀이가 없습니다. 원문 사이트에서 확인하세요." : description,
    label,
  };
}

export function parseKostmaDictionaryResponse(body: string, input: DictionarySearchInput): DictionarySearchResult {
  const value = inputValue(input);
  // The documented widget uses a variable assignment with an optional serializer comment.
  // Only its JSON value is parsed. No evaluation, Function constructor or JSONP execution.
  const match = /^\s*var\s+resultDic\s*=\s*(?:\/\*[\s\S]*?\*\/\s*)?(\{[\s\S]*\})\s*;?\s*$/.exec(body);
  if (!match?.[1]) return invalidResponse();
  let result: Row;
  try { result = object(JSON.parse(match[1])); } catch { return invalidResponse(); }
  const total = integer(result.totalCount);
  if (typeof result.resultHtml !== "string") return invalidResponse();
  const doc = markupDocument(`<dl>${result.resultHtml}</dl>`);
  const terms = Array.from(doc.getElementsByTagName("dt"));
  if (terms.length > 100 || terms.length > total || (total > 0 && terms.length === 0)) return invalidResponse();
  const entries: DictionaryEntry[] = terms.map((term) => {
    const anchor = term.getElementsByTagName("a")[0];
    const call = anchor?.getAttribute("onclick") ?? "";
    const id = /^(?:javascript:)?viewDicWord\('([A-Za-z0-9_]{1,80})','B'\);?$/.exec(call)?.[1];
    if (!id || !id.startsWith("DIC_")) return invalidResponse();
    let next = term.nextSibling;
    while (next && next.nodeType !== 1) next = next.nextSibling;
    if (!next || (next as Element).tagName.toLowerCase() !== "dd") return invalidResponse();
    const title = plainNode(term).replace(/\s+/g, " ").trim();
    const label = /^(.*?)\(([^()]+)\)$/.exec(title);
    const rawSummary = plainNode(next).replace(/\s+/g, " ").trim();
    if (!title || !rawSummary || rawSummary.length > 12_000) return invalidResponse();
    const headword = label?.[2] ?? title;
    const reading = label?.[1] || null;
    const summary = kostmaSummary(rawSummary, headword, reading);
    return {
      id: `kostma:${id}`, headword, reading, kind: "word", source: "kostma",
      sourceLabel: "KOSTMA 고문헌용어용례사전", sourceUrl: `https://kostma.aks.ac.kr/dic/dicViewY.aspx?searchid=${id}`,
      license: "공식 검색 위젯 · 원문 사이트에서 열람", licenseUrl: null,
      attribution: "한국학중앙연구원 KOSTMA 고문헌용어용례사전", senses: [summary], canCite: false,
    };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) return invalidResponse();
  // Stable ranking retains upstream order for related terms after exact matches.
  const exact = (entry: DictionaryEntry) => entry.headword === value.query || entry.reading === value.query;
  entries.sort((left, right) => Number(exact(right)) - Number(exact(left)));
  const notices = ["공식 위젯의 검색 요약입니다. 상세 설명과 출전은 원문 사이트에서 확인하세요. 프로젝트 인용에는 추가할 수 없습니다."];
  if (total > entries.length) notices.push(`검색 결과 ${total}개 중 공식 위젯이 제공한 ${entries.length}개 요약을 표시합니다.`);
  return { ...value, total, hasMore: false, entries, notices };
}

function xmlObject(node: Element, depth = 0): unknown {
  if (depth > 20) return invalidResponse();
  const children = Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1);
  if (!children.length) return node.textContent ?? "";
  const value: Row = Object.create(null) as Row;
  for (const child of children) {
    const parsed = xmlObject(child, depth + 1);
    const key = child.tagName;
    value[key] = key in value ? [...list(value[key]), parsed] : parsed;
  }
  return value;
}

function niklObject(body: string): Row {
  if (body.trimStart().startsWith("<")) {
    const doc = markupDocument(body, true);
    const root = doc.documentElement;
    if (root.tagName === "channel" || root.tagName === "error") return { [root.tagName]: xmlObject(root) };
    if (root.tagName === "xml") return object(xmlObject(root));
    return invalidResponse();
  }
  try { return object(JSON.parse(body)); } catch { return invalidResponse(); }
}

export function parseNiklDictionaryResponse(body: string, input: DictionarySearchInput): DictionarySearchResult {
  const value = inputValue(input);
  if (value.provider !== "opendict" && value.provider !== "stdict") return invalidResponse();
  const provider: DictionaryKeyProvider = value.provider;
  const result = niklObject(body);
  if (result.error != null) {
    const code = integer(object(result.error).error_code);
    if (code === 20) throw new AppError("dictionary_key_invalid", "등록되지 않은 사전 인증 키입니다. 설정에서 키를 확인하세요.");
    if (code === 21) throw new AppError("dictionary_key_suspended", "사전 인증 키가 일시 중지되었습니다. 발급 기관에서 상태를 확인하세요.");
    throw new AppError("dictionary_api_error", "사전 제공 기관에서 요청을 처리하지 못했습니다. 잠시 후 다시 검색하세요.");
  }
  const channel = object(result.channel);
  const total = integer(channel.total);
  const start = integer(channel.start);
  const expectedStart = (value.page - 1) * PAGE_SIZE + 1;
  if (start !== expectedStart) return invalidResponse();
  const items = list(channel.item);
  if (items.length > PAGE_SIZE || (total === 0 && items.length) || (total >= start && !items.length)) return invalidResponse();
  const entries: DictionaryEntry[] = [];
  for (const itemValue of items) {
    const item = object(itemValue);
    const word = text(item.word, 500);
    const senses = list(item.sense);
    if (!word || !senses.length || senses.length > 100) return invalidResponse();
    for (const senseValue of senses) {
      const sense = object(senseValue);
      const definition = text(sense.definition);
      const code = integer(sense.target_code ?? item.target_code);
      const senseNo = sense.sense_no == null ? "" : String(integer(sense.sense_no));
      const origin = text(sense.origin ?? item.origin, 500);
      if (!definition || code <= 0) return invalidResponse();
      const sourceUrl = provider === "opendict"
        ? `https://opendict.korean.go.kr/dictionary/view?sense_no=${code}`
        : `https://stdict.korean.go.kr/search/searchView.do?word_no=${code}&searchKeywordTo=3`;
      entries.push({
        id: `${provider}:${code}${senseNo ? `:${senseNo}` : ""}`, headword: origin || word,
        reading: origin ? word : null, kind: "word", source: provider, sourceLabel: LABELS[provider], sourceUrl,
        license: LICENSE, licenseUrl: LICENSE_URL, attribution: `${LABELS[provider]} · ${LICENSE}`,
        senses: [{ text: definition, ...(senseNo ? { label: `뜻 ${senseNo}` } : {}) }], canCite: true,
      });
    }
  }
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) return invalidResponse();
  const notices = ["한국어에 등재된 한자어의 뜻풀이입니다. 출전이 있는 용례와 멀티미디어는 가져오지 않습니다. 인용 시 국립국어원과 CC BY-SA 2.0 KR 표시를 유지하세요."];
  if (provider === "stdict") notices.push("검색 API의 뜻풀이입니다. 더 자세한 의미 구분은 원문 사전에서 확인하세요.");
  if (value.page === 100 && total > 1_000) notices.push("공식 API의 검색 범위에 따라 1,000번째 결과까지만 표시합니다.");
  return { ...value, total, entries, hasMore: start + items.length <= total && value.page < 100, notices };
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_BYTES) {
    await response.body?.cancel();
    throw new AppError("dictionary_response_too_large", "사전 응답이 너무 큽니다. 더 구체적인 검색어를 입력하세요.");
  }
  if (!response.body) return invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new AppError("dictionary_response_too_large", "사전 응답이 너무 큽니다. 더 구체적인 검색어를 입력하세요.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return invalidResponse(); }
}

export class OnlineDictionaryService {
  constructor(private readonly options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {}

  async search(input: DictionarySearchInput, apiKey?: string): Promise<DictionarySearchResult> {
    const value = inputValue(input);
    const url = buildOnlineDictionaryUrl(value, apiKey);
    if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.username || url.password || url.port) return invalidResponse();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AppError("dictionary_timeout", "사전 검색 응답이 늦어지고 있습니다. 잠시 후 다시 검색하세요."));
      }, this.options.timeoutMs ?? TIMEOUT_MS);
    });
    const request = async () => {
      const response = await (this.options.fetch ?? fetch)(url, {
        method: "GET", redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { Accept: value.provider === "kostma" ? "text/html" : "application/json, application/xml" },
      });
      if (response.redirected || (response.url && new URL(response.url).origin !== url.origin)) {
        await response.body?.cancel();
        return invalidResponse();
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) throw new AppError("dictionary_rate_limited", "사전 검색 요청이 많습니다. 잠시 후 다시 검색하세요.");
        if (response.status === 401 || response.status === 403) throw new AppError("dictionary_api_access", "사전 제공 기관이 접근을 허용하지 않았습니다. 인증 키와 서비스 상태를 확인하세요.");
        throw new AppError("dictionary_api_error", "사전 제공 기관의 응답 오류입니다. 잠시 후 다시 검색하세요.");
      }
      const body = await readBoundedBody(response);
      return value.provider === "kostma" ? parseKostmaDictionaryResponse(body, value) : parseNiklDictionaryResponse(body, value);
    };
    try { return await Promise.race([request(), deadline]); }
    catch (error) {
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) throw new AppError("dictionary_timeout", "사전 검색 응답이 늦어지고 있습니다. 잠시 후 다시 검색하세요.");
      // Never forward errors from fetch: they may contain the credential-bearing URL.
      throw new AppError("dictionary_network", "사전에 연결할 수 없습니다. 인터넷 연결을 확인하세요.");
    } finally { clearTimeout(timer!); }
  }
}

const service = new OnlineDictionaryService();
export function searchOnlineDictionary(input: DictionarySearchInput, apiKey?: string): Promise<DictionarySearchResult> {
  return service.search(input, apiKey);
}
