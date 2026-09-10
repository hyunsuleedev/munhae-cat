import { DOMParser } from "@xmldom/xmldom";
import type {
  ItkcFootnote,
  ItkcFootnoteSearchInput,
  ItkcFootnoteSearchResult,
} from "../shared/munhae-api";
import { AppError } from "./errors";

const SEARCH_URL = "https://db.itkc.or.kr/openapi/search";
const PAGE_SIZE = 10;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 3 * 60_000;
const CACHE_LIMIT = 32;
const REQUEST_INTERVAL_MS = 500;

type SearchRequest = Required<ItkcFootnoteSearchInput>;

function invalidInput(message: string): never {
  throw new AppError("invalid_input", message);
}

export function parseItkcFootnoteSearchInput(value: unknown): SearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidInput("각주 검색 조건을 확인하세요.");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.query !== "string") return invalidInput("검색어를 입력하세요.");
  const query = input.query.trim().replace(/\s+/gu, " ");
  if (!query || Array.from(query).length > 100 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(query)) {
    return invalidInput("검색어는 1~100자의 단어나 구절로 입력하세요.");
  }
  if (input.mode !== "target" && input.mode !== "content") {
    return invalidInput("각주 검색 범위를 확인하세요.");
  }
  const start = input.start ?? 0;
  if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0 || start > 1_000_000 || start % PAGE_SIZE !== 0) {
    return invalidInput("각주 검색 페이지를 확인하세요.");
  }
  return { query, mode: input.mode, start };
}

/**
 * Live-verified ITKC query syntax (2026-09-07): 주석_s is the complete
 * annotated expression, not the shortened 주석명. A wildcard term must escape
 * whitespace and Lucene operators, e.g. 주석_s:*가릉\\ 태수*.
 * Body-only 주석내용_s did not work; content deliberately searches all text.
 */
export function buildItkcFootnoteSearchUrl(input: SearchRequest): URL {
  const keyword = input.mode === "target"
    ? `주석_s:*${input.query.replace(/([+\-!(){}\[\]^"~*?:\\/&|\s])/gu, "\\$1")}*`
    : `"${input.query.replace(/[\\"]/gu, "\\$&")}"`;
  const url = new URL(SEARCH_URL);
  url.search = new URLSearchParams({ secId: "JS_AA", keyword, start: String(input.start), rows: String(PAGE_SIZE) }).toString();
  return url;
}

/** The official hashPageLoaded handler accepts jusokId and focuses that note. */
function sourceUrl(dataId: string, noteId: string): string {
  const match = /^ITKC_([A-Z]{2})_[A-Za-z0-9_]{1,120}$/.exec(dataId);
  if (!match || !/^[A-Za-z0-9_-]{1,40}$/.test(noteId)) {
    throw new AppError("itkc_invalid_response", "한국고전종합DB의 각주 식별자를 읽을 수 없습니다.");
  }
  const url = new URL("https://db.itkc.or.kr/dir/item");
  url.searchParams.set("itemId", match[1]!);
  url.hash = `/dir/node?${new URLSearchParams({ dataId, jusokId: noteId })}`;
  return url.toString();
}

function invalidResponse(): never {
  throw new AppError("itkc_invalid_response", "한국고전종합DB의 검색 응답을 읽을 수 없습니다. 잠시 후 다시 검색하세요.");
}

function children(element: Element): Element[] {
  return Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1);
}

function fields(element: Element): Map<string, string> {
  const result = new Map<string, string>();
  for (const field of children(element)) {
    const name = field.getAttribute("name");
    if (field.tagName !== "field" || !name || result.has(name)) return invalidResponse();
    // XML entities are decoded once by the parser. These values remain text;
    // neither HTML from the remote site nor its search-highlight field is used.
    result.set(name, (field.textContent ?? "").trim());
  }
  return result;
}

function integer(value: string | undefined): number {
  if (!value || !/^\d+$/u.test(value)) return invalidResponse();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return invalidResponse();
  return number;
}

export function parseItkcFootnoteResponse(xml: string, input: SearchRequest): ItkcFootnoteSearchResult {
  // The API needs no DTD. Reject declarations before parsing so external and
  // expanding entities cannot change text or cause work outside this response.
  if (Buffer.byteLength(xml, "utf8") > MAX_RESPONSE_BYTES || /<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) return invalidResponse();
  let malformed = false;
  const parser = new DOMParser({ errorHandler: () => { malformed = true; } });
  let document: Document;
  try {
    document = parser.parseFromString(xml, "application/xml");
  } catch {
    return invalidResponse();
  }
  const root = document.documentElement;
  if (malformed || !root || root.tagName !== "response") return invalidResponse();
  const rootChildren = children(root);
  if (rootChildren.length !== 2 || rootChildren[0]?.tagName !== "header" || rootChildren[1]?.tagName !== "result") return invalidResponse();
  const header = fields(rootChildren[0]);
  const expectedKeyword = buildItkcFootnoteSearchUrl(input).searchParams.get("keyword");
  if (header.get("secId") !== "JS_AA" || header.get("keyword") !== expectedKeyword
    || integer(header.get("start")) !== input.start || integer(header.get("rows")) !== PAGE_SIZE) return invalidResponse();
  const total = integer(header.get("totalCount"));
  const docs = children(rootChildren[1]);
  // A partial page would skip records when the next request advances by ten.
  if (docs.length !== Math.min(PAGE_SIZE, Math.max(0, total - input.start))) return invalidResponse();
  const seen = new Set<string>();
  const items: ItkcFootnote[] = docs.map((doc) => {
    if (doc.tagName !== "doc") return invalidResponse();
    const values = fields(doc);
    const dataId = values.get("자료ID") ?? "";
    const noteId = values.get("주석ID") ?? "";
    const id = `${dataId}:${noteId}`;
    const annotatedText = values.get("주석") ?? "";
    const bodyText = values.get("주석내용") ?? "";
    if (!annotatedText || !bodyText || seen.has(id)) return invalidResponse();
    seen.add(id);
    return {
      id, annotatedText, bodyText,
      displayTitle: values.get("주석명") || annotatedText,
      bookTitle: values.get("서명") ?? "",
      translator: values.get("역자") ?? "",
      publisher: values.get("간행처") ?? "",
      year: values.get("간행년") ?? "",
      sourceUrl: sourceUrl(dataId, noteId),
    };
  });
  return {
    query: input.query,
    mode: input.mode,
    searchMode: input.mode === "target" ? "annotated-text" : "all-text",
    total, start: input.start, pageSize: PAGE_SIZE,
    hasMore: input.start + items.length < total,
    items,
  };
}

async function readBoundedBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return invalidResponse();
  }
  const reader = response.body?.getReader();
  if (!reader) return invalidResponse();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return invalidResponse();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class ItkcFootnoteService {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, { expiresAt: number; result: ItkcFootnoteSearchResult }>();
  private readonly pending = new Map<string, Promise<ItkcFootnoteSearchResult>>();
  private lastRequestAt = -Infinity;
  private startQueue: Promise<void> = Promise.resolve();

  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
  }

  async search(value: unknown): Promise<ItkcFootnoteSearchResult> {
    const input = parseItkcFootnoteSearchInput(value);
    const url = buildItkcFootnoteSearchUrl(input);
    const key = url.toString();
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return structuredClone(cached.result);
    }
    this.cache.delete(key);
    const pending = this.pending.get(key);
    if (pending) return structuredClone(await pending);
    if (this.pending.size >= 2) {
      throw new AppError("itkc_rate_limited", "검색 요청이 진행 중입니다. 잠시 후 다시 검색하세요.");
    }
    const request = this.scheduleRequest(url, input);
    this.pending.set(key, request);
    try {
      const result = await request;
      this.cache.set(key, { expiresAt: this.now() + CACHE_TTL_MS, result });
      while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
      return structuredClone(result);
    } finally {
      this.pending.delete(key);
    }
  }

  private scheduleRequest(url: URL, input: SearchRequest): Promise<ItkcFootnoteSearchResult> {
    // Queue only the start gate, not the network operation. Rapid pagination
    // waits for the remaining gap; at most two distinct requests may be active
    // or waiting. Read the clock after each wait so delayed timers cannot make
    // later requests start simultaneously against an old reserved timestamp.
    const start = this.startQueue.then(async () => {
      const wait = Math.max(0, this.lastRequestAt + REQUEST_INTERVAL_MS - this.now());
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      this.lastRequestAt = this.now();
    });
    this.startQueue = start;
    return start.then(() => this.request(url, input));
  }

  private async request(url: URL, input: SearchRequest): Promise<ItkcFootnoteSearchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchFn(url, {
        method: "GET", redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { Accept: "application/xml, text/xml" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) throw new AppError("itkc_rate_limited", "한국고전종합DB의 검색 요청이 많습니다. 잠시 후 다시 검색하세요.");
        throw new AppError("itkc_unavailable", `한국고전종합DB 검색에 실패했습니다 (HTTP ${response.status}). 잠시 후 다시 검색하세요.`);
      }
      return parseItkcFootnoteResponse(await readBoundedBody(response), input);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) throw new AppError("itkc_timeout", "한국고전종합DB 검색 응답이 늦어지고 있습니다. 다시 검색하세요.");
      throw new AppError("itkc_unavailable", "한국고전종합DB에 연결할 수 없습니다. 인터넷 연결을 확인하고 다시 검색하세요.");
    } finally {
      clearTimeout(timeout);
    }
  }
}

const service = new ItkcFootnoteService();

/** Shared by Electron IPC and the development browser bridge. */
export function searchItkcFootnotes(input: unknown): Promise<ItkcFootnoteSearchResult> {
  return service.search(input);
}
