import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonHash,
  codepointCount,
  createId,
  sha256Hex,
  sliceCodepoints,
  utf8ByteLength,
  VERSION_UI,
} from "../src/index.ts";

describe("createId", () => {
  it("returns a UUIDv7", () => {
    const id = createId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(createId()).not.toBe(id);
  });
});

describe("sha256Hex", () => {
  it("hashes the empty string to the published SHA-256", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("is stable for Korean text", () => {
    const a = sha256Hex("훈민정음");
    const b = sha256Hex("훈민정음");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(sha256Hex("훈민정음 "));
  });
});

describe("codepoints", () => {
  it("counts and slices Hangul by code point", () => {
    expect(codepointCount("한글")).toBe(2);
    expect(sliceCodepoints("한글", 0, 1)).toBe("한");
    expect(sliceCodepoints("한글", 1, 2)).toBe("글");
    expect(sliceCodepoints("한글", 0, 2)).toBe("한글");
  });

  it("counts and slices Hanja by code point", () => {
    expect(codepointCount("國之")).toBe(2);
    expect(sliceCodepoints("國之", 0, 1)).toBe("國");
    expect(sliceCodepoints("國之", 1, 2)).toBe("之");
  });

  it("reports UTF-8 byte length of 가 as 3", () => {
    expect(utf8ByteLength("가")).toBe(3);
  });
});

describe("canonical JSON", () => {
  it("sorts keys and omits extra whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJsonHash({ z: 1, a: 2 })).toBe(canonicalJsonHash({ a: 2, z: 1 }));
  });
});

describe("VERSION_UI", () => {
  it("uses 작업안/확정/제외됨/변경 이력", () => {
    expect(VERSION_UI.draft).toBe("작업안");
    expect(VERSION_UI.confirmed).toBe("확정");
    expect(VERSION_UI.rejected).toBe("제외됨");
    expect(VERSION_UI.superseded).toBe("변경 이력");
  });
});
