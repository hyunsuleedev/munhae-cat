import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {}, shell: {} }));
import { assertAllowedExternalUrl, isAllowedExternalUrl } from "../src/main/security";
import { dictionaryReferenceLinks } from "../src/renderer/scripts/dictionary-citation";

describe("dictionary source links in the external browser", () => {
  it("allows the research providers and attribution pages used by the dictionary", () => {
    const urls = [...dictionaryReferenceLinks("太守").map(link => link.url),
      "https://kostma.aks.ac.kr/dic/dicViewY.aspx?searchid=DIC_BC_000042",
      "https://opendict.korean.go.kr/service/openApiInfo", "https://stdict.korean.go.kr/openapi/openApiInfo.do",
      "https://creativecommons.org/licenses/by-sa/4.0/", "https://opensource.org/license/bsd-3-clause",
      "https://github.com/libhangul/libhangul/blob/main/data/hanja/hanja.txt", "https://db.itkc.or.kr/dir/item",
      "https://www.unicode.org/reports/tr38/", "https://www.unicode.org/license.txt",
    ];
    for (const url of urls) { expect(isAllowedExternalUrl(url)).toBe(true); expect(assertAllowedExternalUrl(url).protocol).toBe("https:"); }
  });
  it.each(["javascript:alert(1)", "file:///tmp/test", "https://hanja.dict.naver.com.evil.invalid/", "https://reader:secret@ko.wiktionary.org/", "http://ko.wiktionary.org/", "https://unregistered.invalid/"])("rejects %s", url => {
    expect(isAllowedExternalUrl(url)).toBe(false); expect(() => assertAllowedExternalUrl(url)).toThrow();
  });
});
