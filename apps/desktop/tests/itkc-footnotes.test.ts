import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildItkcFootnoteSearchUrl,
  ItkcFootnoteService,
  parseItkcFootnoteResponse,
  parseItkcFootnoteSearchInput,
} from "../src/main/itkc-footnotes";

const target = { query: "태수", mode: "target" as const, start: 0 };
const xmlText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const field = (name: string, value: string) => `<field name="${name}">${xmlText(value)}</field>`;
function doc(index = 1, overrides: Record<string, string> = {}) {
  return `<doc>${Object.entries({
    서명: "서경집(西坰集)",
    주석내용: "강릉 태수가 건강하여 함께 유람하니 외롭지 않으리라는 말이다. & <script>alert(1)</script>",
    자료ID: "ITKC_BT_0241A_0050_020_0520",
    주석ID: `D${String(index).padStart(3, "0")}`,
    주석: "강릉 태수는 여전히 건강하니 / 江陵太守身猶健\n영외로 부임해도 흥취 외롭지 않으리",
    주석명: "강릉 …… 않으리",
    역자: "강원모 김문갑 이규춘",
    간행처: "충남대학교 한자문화연구소",
    간행년: "2019",
    ...overrides,
  }).map(([name, value]) => field(name, value)).join("")}</doc>`;
}
function response(options: {
  input?: typeof target | { query: string; mode: "content"; start: number };
  total?: number;
  docs?: string;
} = {}) {
  const input = options.input ?? target;
  return `<?xml version="1.0" encoding="utf-8"?>
  <response><header>${field("secId", "JS_AA")}${field("keyword", buildItkcFootnoteSearchUrl(input).searchParams.get("keyword")!)}
  ${field("start", String(input.start))}${field("rows", "10")}${field("totalCount", String(options.total ?? 1))}</header>
  <result>${options.docs ?? doc()}</result></response>`;
}
const ok = (body = response()) => new Response(body, { headers: { "content-type": "application/xml;charset=UTF-8" } });

afterEach(() => vi.useRealTimers());

describe("ITKC footnote search boundary", () => {
  it("builds literal, fixed-origin searches without changing target/body semantics", () => {
    const input = parseItkcFootnoteSearchInput({ query: " 가릉\n태수(太守) ", mode: "target" });
    const url = buildItkcFootnoteSearchUrl(input);
    expect(url.origin + url.pathname).toBe("https://db.itkc.or.kr/openapi/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      secId: "JS_AA", keyword: "주석_s:*가릉\\ 태수\\(太守\\)*", start: "0", rows: "10",
    });
    expect(buildItkcFootnoteSearchUrl({ ...target, query: '태수" OR *:*' }).searchParams.get("keyword"))
      .toBe('주석_s:*태수\\"\\ OR\\ \\*\\:\\**');
    expect(buildItkcFootnoteSearchUrl({ ...target, query: '태수" OR *:*', mode: "content" }).searchParams.get("keyword"))
      .toBe('"태수\\" OR *:*"');
  });

  it("bounds input and preserves supplementary Hanja as one character", () => {
    expect(parseItkcFootnoteSearchInput({ query: "𠮷".repeat(100), mode: "target" }).query).toHaveLength(200);
    for (const input of [null, [], { ...target, query: " " }, { ...target, query: "𠮷".repeat(101) },
      { ...target, query: "태수\0" }, { ...target, query: "\ud800" }, { ...target, mode: "body" },
      { ...target, start: -10 }, { ...target, start: 1 }, { ...target, start: 1_000_010 }, { ...target, start: "10" }]) {
      expect(() => parseItkcFootnoteSearchInput(input)).toThrow();
    }
  });

  it("preserves the complete annotated expression separately from the shortened title and decodes XML safely", () => {
    const result = parseItkcFootnoteResponse(response(), target);
    expect(result).toMatchObject({ query: "태수", mode: "target", searchMode: "annotated-text", total: 1, hasMore: false, pageSize: 10 });
    expect(result.items[0]).toEqual({
      id: "ITKC_BT_0241A_0050_020_0520:D001",
      annotatedText: "강릉 태수는 여전히 건강하니 / 江陵太守身猶健\n영외로 부임해도 흥취 외롭지 않으리",
      displayTitle: "강릉 …… 않으리",
      bodyText: "강릉 태수가 건강하여 함께 유람하니 외롭지 않으리라는 말이다. & <script>alert(1)</script>",
      bookTitle: "서경집(西坰集)", translator: "강원모 김문갑 이규춘", publisher: "충남대학교 한자문화연구소", year: "2019",
      sourceUrl: "https://db.itkc.or.kr/dir/item?itemId=BT#/dir/node?dataId=ITKC_BT_0241A_0050_020_0520&jusokId=D001",
    });
  });

  it("handles successive result pages and honest no-results responses", () => {
    const first = parseItkcFootnoteResponse(response({ total: 11, docs: Array.from({ length: 10 }, (_, i) => doc(i + 1)).join("") }), target);
    expect(first.items).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    const next = { ...target, start: 10 };
    const last = parseItkcFootnoteResponse(response({ input: next, total: 11, docs: doc(11) }), next);
    expect(last).toMatchObject({ start: 10, total: 11, hasMore: false });
    expect(last.items[0]?.id.endsWith(":D011")).toBe(true);
    const content = { ...target, mode: "content" as const };
    expect(parseItkcFootnoteResponse(response({ input: content, total: 0, docs: "" }), content))
      .toMatchObject({ searchMode: "all-text", total: 0, items: [], hasMore: false });
  });

  it("rejects malformed, entity-bearing, mismatched, partial and unsafe-identifier responses", () => {
    const valid = response();
    const invalid = [
      "<html><body>server error</body></html>",
      valid.replace("</result>", ""),
      valid.replace("<response>", '<!DOCTYPE response [<!ENTITY ext SYSTEM "file:///etc/passwd">]><response>'),
      valid.replace("</header>", `${field("totalCount", "0")}</header>`),
      valid.replace('name="start">0', 'name="start">10'),
      valid.replace('name="secId">JS_AA', 'name="secId">BT_AA'),
      valid.replace('name="keyword">주석_s:*태수*', 'name="keyword">태수'),
      valid.replace('name="totalCount">1', 'name="totalCount">11'),
      response({ total: 0 }),
      response({ docs: doc(1, { 자료ID: "https://evil.example/" }) }),
      response({ docs: doc(1, { 주석ID: 'D001\" onclick="x' }) }),
      response({ total: 2, docs: doc() + doc() }),
    ];
    for (const body of invalid) expect(() => parseItkcFootnoteResponse(body, target)).toThrow();
  });

  it("coalesces identical requests and caches copies without reusing stale entries", async () => {
    let now = 0;
    const fetchFn = vi.fn(async () => ok());
    const service = new ItkcFootnoteService({ fetch: fetchFn, now: () => now });
    const [a, b] = await Promise.all([service.search(target), service.search(target)]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    a.items[0]!.bodyText = "local mutation";
    expect(b.items[0]!.bodyText).not.toBe("local mutation");
    expect((await service.search(target)).items[0]!.bodyText).not.toBe("local mutation");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 180_001;
    await service.search(target);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
  });

  it("waits the remaining start gap for rapid pagination while cached results stay immediate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    const next = { ...target, start: 10 };
    const fetchFn = vi.fn<typeof fetch>(async (url) => {
      starts.push(Date.now());
      return new URL(String(url)).searchParams.get("start") === "10"
        ? ok(response({ input: next, total: 11, docs: doc(11) }))
        : ok(response({ total: 11, docs: Array.from({ length: 10 }, (_, i) => doc(i + 1)).join("") }));
    });
    const service = new ItkcFootnoteService({ fetch: fetchFn });
    await service.search(target);
    await vi.advanceTimersByTimeAsync(125);
    const secondPage = service.search(next);
    const duplicatePage = service.search(next);
    await expect(service.search(target)).resolves.toMatchObject({ total: 11, start: 0 });
    await vi.advanceTimersByTimeAsync(374);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(secondPage).resolves.toMatchObject({ start: 10, hasMore: false });
    await expect(duplicatePage).resolves.toMatchObject({ start: 10 });
    expect(starts).toEqual([0, 500]);
  });

  it("bounds distinct active or waiting requests at two while identical requests coalesce", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    const releases: Array<() => void> = [];
    const fetchFn = vi.fn<typeof fetch>((url) => new Promise((resolve) => {
      starts.push(Date.now());
      const query = new URL(String(url)).searchParams.get("keyword") === "주석_s:*太守*" ? "太守" : "태수";
      releases.push(() => resolve(ok(response({ input: { ...target, query } }))));
    }));
    const service = new ItkcFootnoteService({ fetch: fetchFn });
    const first = service.search(target);
    const second = service.search({ ...target, query: "太守" });
    const duplicate = service.search({ ...target, query: "太守" });
    await expect(service.search({ ...target, query: "孔子" })).rejects.toMatchObject({ code: "itkc_rate_limited" });
    await vi.advanceTimersByTimeAsync(499);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 500]);
    releases.forEach((release) => release());
    await expect(first).resolves.toMatchObject({ query: "태수" });
    await expect(second).resolves.toMatchObject({ query: "太守" });
    await expect(duplicate).resolves.toMatchObject({ query: "太守" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("reports provider failures distinctly and does not cache them", async () => {
    let now = 0;
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("server", { status: 503 }))
      .mockRejectedValueOnce(new Error("secret upstream diagnostics"))
      .mockResolvedValueOnce(ok("<html>not XML</html>"))
      .mockResolvedValueOnce(ok());
    const service = new ItkcFootnoteService({ fetch: fetchFn, now: () => now });
    for (const code of ["itkc_rate_limited", "itkc_unavailable", "itkc_unavailable", "itkc_invalid_response"]) {
      await expect(service.search(target)).rejects.toMatchObject({ code });
      now += 500;
    }
    await expect(service.search(target)).resolves.toMatchObject({ total: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it("aborts a slow request after twelve seconds", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const service = new ItkcFootnoteService({ fetch: fetchFn });
    const rejected = expect(service.search(target)).rejects.toMatchObject({ code: "itkc_timeout" });
    await vi.advanceTimersByTimeAsync(12_000);
    await rejected;
  });

  it("bounds streaming responses even without content-length", async () => {
    const service = new ItkcFootnoteService({ fetch: vi.fn(async () => ok("x".repeat(2 * 1024 * 1024 + 1))) });
    await expect(service.search(target)).rejects.toMatchObject({ code: "itkc_invalid_response" });
  });
});
