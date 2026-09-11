import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOnlineDictionaryUrl, OnlineDictionaryService, parseKostmaDictionaryResponse, parseNiklDictionaryResponse,
} from "../src/main/dictionary-online";
import type { DictionarySearchInput } from "../src/shared/dictionary-types";

const KEY = "a1".repeat(16);
const openInput: DictionarySearchInput = { provider: "opendict", query: "太守" };
const standardInput: DictionarySearchInput = { provider: "stdict", query: "제조" };
const kostmaInput: DictionarySearchInput = { provider: "kostma", query: "太守" };
function kostma(html?: string, totalCount = 1) {
  return `var resultDic=/*\r\nCreated by JsonExSerializer\r\n*/\r\n${JSON.stringify({
    totalCount,
    resultHtml: html ?? `<dt><a href='javascript:void(0)' onclick="javascript:viewDicWord('DIC_BC_000042','B');"><font>태수(<b>太</b>守)</font></a></dt><dd>신라의 <b>지방 관직</b>...</dd>`,
  })}\r\n`;
}
function openBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ channel: { total: 1, start: 1, num: 10, item: [{ word: "태수", sense: {
    target_code: 123, sense_no: "001", definition: "<b>지방</b> 관직 &amp; 제도.", origin: "太守", pos: "명사",
    example: "인용하면 안 되는 제3자 문장", multimedia: "https://example.com/image.png",
    link: "https://evil.example/?key=secret",
  } }], ...overrides } });
}
afterEach(() => vi.useRealTimers());

describe("official dictionary requests", () => {
  it("builds literal original-Hanja and Korean-headword searches using each provider's schema", () => {
    const url = buildOnlineDictionaryUrl({ ...openInput, page: 2 }, KEY);
    expect(url.origin + url.pathname).toBe("https://opendict.korean.go.kr/api/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ key: KEY, q: "太守", advanced: "y", target: "2", method: "exact", req_type: "json", num: "10", start: "11", lang: "2" });
    const standard = buildOnlineDictionaryUrl(standardInput, KEY);
    expect(standard.pathname).toBe("/api/search.do");
    expect(standard.searchParams.get("target")).toBe("1");
    expect(standard.searchParams.has("lang")).toBe(false);
    expect(buildOnlineDictionaryUrl({ provider: "stdict", query: "提調" }, KEY).searchParams.get("target")).toBe("2");
    const widget = buildOnlineDictionaryUrl({ ...kostmaInput, query: "太守&callback=evil" });
    expect(widget.searchParams.get("callback")).toBe("resultDic");
    expect(widget.searchParams.get("query")).toBe("太守&callback=evil");
    expect(widget.searchParams.has("key")).toBe(false);
  });

  it("rejects absent keys, malformed input and unsupported pagination before fetching", async () => {
    const fetcher = vi.fn();
    const service = new OnlineDictionaryService({ fetch: fetcher });
    await expect(service.search(openInput)).rejects.toMatchObject({ code: "dictionary_key_required" });
    await expect(service.search(openInput, "bad")).rejects.toMatchObject({ code: "dictionary_key_invalid" });
    for (const input of [{ ...kostmaInput, page: 2 }, { ...openInput, page: 101 }, { ...openInput, query: "\0" }, { ...openInput, query: "\ud800" }, { ...openInput, query: "𠮷".repeat(101) }, { ...openInput, provider: "local" }]) {
      await expect(service.search(input as DictionarySearchInput, KEY)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("KOSTMA safe widget parsing", () => {
  it("extracts text and fixed-origin links without executing or retaining HTML", () => {
    const body = kostma(`<dt><a href='https://evil.example' onclick="javascript:viewDicWord('DIC_BC_000042','B');">태수(<b>太守</b>)</a></dt><dd>신라<script>throw new Error('execute')</script><img src='https://evil.example'> 지방 관직 &amp; 제도</dd>`);
    const result = parseKostmaDictionaryResponse(body, kostmaInput);
    expect(result).toMatchObject({ total: 1, hasMore: false, entries: [{ id: "kostma:DIC_BC_000042", headword: "太守", reading: "태수", canCite: false,
      sourceUrl: "https://kostma.aks.ac.kr/dic/dicViewY.aspx?searchid=DIC_BC_000042", senses: [{ text: "신라 지방 관직 & 제도", label: "검색 요약" }] }] });
    expect(JSON.stringify(result)).not.toContain("evil.example");
    expect(JSON.stringify(result)).not.toContain("execute");
  });

  it("reports the widget's limited summaries honestly and handles no results", () => {
    expect(parseKostmaDictionaryResponse(kostma(undefined, 18), kostmaInput)).toMatchObject({ total: 18, hasMore: false });
    expect(parseKostmaDictionaryResponse(kostma(undefined, 18), kostmaInput).notices.join(" ")).toContain("18개 중");
    expect(parseKostmaDictionaryResponse(kostma("", 0), kostmaInput)).toMatchObject({ total: 0, entries: [] });
  });

  it("cleans the live 2026-09-08 widget index prefixes and ranks the exact term first", () => {
    // These dd strings are actual widget responses, not inferred detail-page text.
    const rows = [
      ["DIC_B6_000541", "부제조", "副提調", "부제조부제조副提調법제·행정역사제도/관직조선시대金成俊조선시대 잡무와 기술계통의 중앙관서에서..."],
      ["DIC_B9_000644", "제조", "提調", "제조제조提調역사법제·행정제도/관직조선시대金成俊조선시대 당상관 이상의 관원이 없는 관아에..."],
      ["DIC_B3_000417", "도제조", "都提調", "도제조도제조都提調역사법제·행정제도/관직조선시대車文燮조선시대 육조의 속아문이나 군영 등에..."],
    ];
    const html = rows.map(([id, reading, headword, description]) => `<dt><a onclick="javascript:viewDicWord('${id}','B');">${reading}(<b>${headword}</b>)</a></dt><dd>${description}</dd>`).join("");
    for (const query of ["提調", "제조"]) {
      const result = parseKostmaDictionaryResponse(kostma(html, 3), { provider: "kostma", query });
      expect(result.entries.map((entry) => entry.headword)).toEqual(["提調", "副提調", "都提調"]);
      expect(result.entries[0]?.senses).toEqual([{ text: "조선시대 당상관 이상의 관원이 없는 관아에...", label: "역사 · 법제·행정 · 제도/관직 · 조선시대" }]);
      expect(result.entries.every((entry) => !entry.canCite)).toBe(true);
      expect(JSON.stringify(result.entries.map((entry) => entry.senses))).not.toMatch(/제조제조|金成俊|車文燮/);
    }
    const noDescription = `<dt><a onclick="javascript:viewDicWord('DIC_BC_000042','B');">태수(太守)</a></dt><dd>태수태수太守taesut'aesuprefect법제·행정역사제도/관직남북국시대/통일신라李基東...</dd>`;
    expect(parseKostmaDictionaryResponse(kostma(noDescription), kostmaInput).entries[0]?.senses).toEqual([
      { text: "검색 요약에는 뜻풀이가 없습니다. 원문 사이트에서 확인하세요.", label: "법제·행정 · 역사 · 제도/관직 · 남북국시대/통일신라" },
    ]);
    const unrecognized = noDescription.replace("법제·행정역사제도/관직남북국시대/통일신라李基東", "알수없는필드형식");
    expect(parseKostmaDictionaryResponse(kostma(unrecognized), kostmaInput).entries[0]?.senses[0]?.text).toBe("자세한 뜻풀이는 원문 사이트에서 확인하세요.");
  });

  it("rejects executable assignments, injected handlers, entity declarations and partial results", () => {
    for (const body of [kostma() + ";globalThis.pwned=true", kostma().replace("var resultDic", "window.evil"),
      kostma().replace("DIC_BC_000042", "../../evil"), kostma().replace("viewDicWord", "fetch"),
      kostma("<!DOCTYPE foo [<!ENTITY e SYSTEM 'file:///etc/passwd'>]>", 1), kostma("", 2), "<html>error</html>",
      kostma().replace('"totalCount":1', '"totalCount":0')]) {
      expect(() => parseKostmaDictionaryResponse(body, kostmaInput)).toThrow(expect.objectContaining({ code: "dictionary_invalid_response" }));
    }
  });
});

describe("National Institute of Korean Language responses", () => {
  it("returns only definitions and attribution, never third-party examples, media or untrusted links", () => {
    const result = parseNiklDictionaryResponse(openBody(), openInput);
    expect(result.entries[0]).toMatchObject({ id: "opendict:123:1", headword: "太守", reading: "태수", canCite: true,
      license: "CC BY-SA 2.0 KR", licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/kr/",
      sourceUrl: "https://opendict.korean.go.kr/dictionary/view?sense_no=123", senses: [{ text: "지방 관직 & 제도.", label: "뜻 1" }] });
    expect(JSON.stringify(result)).not.toContain("제3자 문장");
    expect(JSON.stringify(result)).not.toContain("example.com");
    expect(JSON.stringify(result)).not.toContain("evil.example");
  });

  it("supports the documented standard-dictionary item-level target code and XML wrapper", () => {
    const xml = `<?xml version="1.0"?><xml version="2.0"><channel><total>1</total><start>1</start><num>10</num><item><target_code>456</target_code><word>제조</word><sup_no>2</sup_no><pos>명사</pos><sense><definition>조선 시대 관직.</definition><link><![CDATA[https://evil.example]]></link></sense></item></channel></xml>`;
    expect(parseNiklDictionaryResponse(xml, standardInput)).toMatchObject({ total: 1, hasMore: false, entries: [{ id: "stdict:456", headword: "제조", sourceUrl: "https://stdict.korean.go.kr/search/searchView.do?word_no=456&searchKeywordTo=3", canCite: true }] });
    const json = JSON.stringify({ channel: { total: 1, start: 1, num: 10, item: { target_code: 456, word: "제조", sense: { definition: "조선 시대 관직." } } } });
    expect(parseNiklDictionaryResponse(json, standardInput).entries[0]?.id).toBe("stdict:456");
  });

  it("supports multiple meanings and pagination without treating key failures as empty results", () => {
    const multiple = openBody({ item: [{ word: "태수", origin: "太守", sense: [
      { target_code: 123, sense_no: 1, definition: "신라의 지방 관직." },
      { target_code: 124, sense_no: 2, definition: "지방 행정 책임자." },
    ] }] });
    expect(parseNiklDictionaryResponse(multiple, openInput).entries.map((entry) => entry.id)).toEqual(["opendict:123:1", "opendict:124:2"]);
    const body = openBody({ start: 11, total: 11 });
    expect(parseNiklDictionaryResponse(body, { ...openInput, page: 2 })).toMatchObject({ page: 2, total: 11, hasMore: false });
    expect(parseNiklDictionaryResponse(openBody({ total: 0, item: [] }), openInput)).toMatchObject({ entries: [], total: 0, hasMore: false });
    for (const [code, expected] of [[20, "dictionary_key_invalid"], [21, "dictionary_key_suspended"], [0, "dictionary_api_error"], [101, "dictionary_api_error"]] as const) {
      for (const error of [JSON.stringify({ error: { error_code: code, message: KEY } }), `<error><error_code>${String(code).padStart(3, "0")}</error_code><message>${KEY}</message></error>`]) {
        expect(() => parseNiklDictionaryResponse(error, openInput)).toThrow(expect.objectContaining({ code: expected }));
        try { parseNiklDictionaryResponse(error, openInput); } catch (failure) { expect(String(failure)).not.toContain(KEY); }
      }
    }
  });

  it("rejects malformed or mismatched upstream payloads instead of claiming there are no entries", () => {
    for (const body of ["{}", "not json", "<channel><total>0</total>", "<!DOCTYPE foo><channel/>", openBody({ start: 2 }),
      openBody({ total: 1, item: [] }), openBody({ total: 0 }), openBody().replace('"target_code":123', '"target_code":"bad"')]) {
      expect(() => parseNiklDictionaryResponse(body, openInput)).toThrow(expect.objectContaining({ code: "dictionary_invalid_response" }));
    }
  });
});

describe("online network boundary", () => {
  it("omits credentials, forbids redirects and does not expose URLs or keys in network errors", async () => {
    const fetcher = vi.fn(async () => new Response(openBody()));
    const service = new OnlineDictionaryService({ fetch: fetcher });
    await service.search(openInput, KEY);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", credentials: "omit", method: "GET" });
    fetcher.mockImplementation(async () => { throw new Error(`request failed https://example.com/?key=${KEY}`); });
    await expect(service.search(openInput, KEY)).rejects.toMatchObject({ code: "dictionary_network" });
    try { await service.search(openInput, KEY); } catch (error) { expect(String(error)).not.toContain(KEY); }
  });

  it("separates HTTP, rate-limit and access errors from empty results", async () => {
    for (const [status, code] of [[503, "dictionary_api_error"], [429, "dictionary_rate_limited"], [403, "dictionary_api_access"]] as const) {
      const service = new OnlineDictionaryService({ fetch: vi.fn(async () => new Response(KEY, { status })) });
      await expect(service.search(openInput, KEY)).rejects.toMatchObject({ code });
    }
  });

  it("bounds both declared and streamed response sizes", async () => {
    for (const response of [new Response("small", { headers: { "content-length": "1048577" } }), new Response("x".repeat(1_048_577))]) {
      const service = new OnlineDictionaryService({ fetch: vi.fn(async () => response) });
      await expect(service.search(openInput, KEY)).rejects.toMatchObject({ code: "dictionary_response_too_large" });
    }
  });

  it("rejects unexpected redirects and invalid UTF-8 as response errors", async () => {
    const redirect = new Response(openBody());
    Object.defineProperty(redirect, "redirected", { value: true });
    Object.defineProperty(redirect, "url", { value: "https://evil.example/" });
    for (const response of [redirect, new Response(new Uint8Array([0xff]))]) {
      const service = new OnlineDictionaryService({ fetch: vi.fn(async () => response) });
      await expect(service.search(openInput, KEY)).rejects.toMatchObject({ code: "dictionary_invalid_response" });
    }
  });

  it("enforces the deadline even when a transport never resolves", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const service = new OnlineDictionaryService({ fetch: fetcher, timeoutMs: 100 });
    const request = service.search(openInput, KEY);
    const assertion = expect(request).rejects.toMatchObject({ code: "dictionary_timeout" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

describe("opt-in live KOSTMA widget smoke", () => {
  it.skipIf(process.env.MUNHAE_LIVE_DICTIONARY !== "1")("reads only two public widget summaries through the real adapter", async () => {
    const service = new OnlineDictionaryService();
    for (const [query, id] of [["太守", "DIC_BC_000042"], ["提調", "DIC_B9_000644"]]) {
      const result = await service.search({ provider: "kostma", query: query! });
      expect(result.total).toBeGreaterThan(0);
      expect(result.entries.some((entry) => entry.id === `kostma:${id}`)).toBe(true);
      expect(result.entries.every((entry) => !entry.canCite && entry.senses[0]?.text && entry.sourceUrl.startsWith("https://kostma.aks.ac.kr/dic/dicViewY.aspx?searchid=DIC_"))).toBe(true);
      expect(result.entries[0]?.headword).toBe(query);
      expect(result.entries[0]?.senses[0]?.text).not.toMatch(/제조제조|태수태수|金成俊|李基東/);
    }
  }, 30_000);
});
