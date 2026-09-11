import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "../src/shared/munhae-api";

const mocks = vi.hoisted(() => ({
  account: vi.fn(), local: vi.fn(), online: vi.fn(), datasets: vi.fn(),
  keyStatus: vi.fn(), key: vi.fn(), setKey: vi.fn(), localModuleLoads: 0,
}));
vi.mock("../src/main/auth", () => ({ withAccount: (action: (account: unknown) => unknown) => action({ getState: mocks.account }) }));
vi.mock("../src/main/dictionary-local", () => {
  mocks.localModuleLoads += 1;
  return { searchLocalDictionary: mocks.local, getLocalDictionaryDatasets: mocks.datasets };
});
vi.mock("../src/main/dictionary-online", () => ({ searchOnlineDictionary: mocks.online }));
vi.mock("../src/main/dictionary-credentials", () => ({ getDictionaryKeyStatus: mocks.keyStatus, getDictionaryKey: mocks.key, setDictionaryKey: mocks.setKey }));
import { dictionaryGetStatus, dictionarySearch, dictionarySetKey, parseDictionarySearchInput, parseDictionarySetKeyInput } from "../src/main/dictionary";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.account.mockResolvedValue({ status: "signed_in", user: { id: "account-1" } } as AccountState);
  mocks.local.mockReturnValue({ entries: [], provider: "local" });
  mocks.online.mockResolvedValue({ entries: [], provider: "opendict" });
  mocks.datasets.mockReturnValue([]);
  mocks.keyStatus.mockReturnValue({ opendict: true, stdict: false });
  mocks.key.mockReturnValue("a".repeat(32));
});

describe("dictionary search boundary", () => {
  it("leaves offline data unloaded at startup, for online lookup and for unauthenticated status", async () => {
    expect(mocks.localModuleLoads).toBe(0);
    await dictionarySearch({ query: "太守", provider: "kostma" });
    expect(mocks.localModuleLoads).toBe(0);
    mocks.account.mockResolvedValue({ status: "signed_out", user: null });
    await expect(dictionaryGetStatus()).rejects.toMatchObject({ code: "auth_required" });
    expect(mocks.localModuleLoads).toBe(0);
  });

  it("defaults to local and normalizes whitespace without replacing compatibility Hanja or IVS", () => {
    expect(parseDictionarySearchInput({ query: "　神  目\u{e0100}　" }))
      .toEqual({ query: "神 目\u{e0100}", provider: "local", page: 1 });
    expect(parseDictionarySearchInput({ query: "𠀀".repeat(100), page: 100 }).query).toHaveLength(200);
  });

  it.each([
    null, [], "目", {}, { query: 1 }, { query: "　 " }, { query: "目".repeat(101) },
    { query: "𠀀".repeat(101) }, { query: "目\n" }, { query: "\t目" },
    { query: "目\u0000" }, { query: "目\u0085" }, { query: "目\u202e" },
    { query: "\ud800" }, { query: "目\udc00" }, { query: "目", provider: "naver" },
    { query: "目", provider: "" }, { query: "目", provider: null },
    { query: "目", page: null }, { query: "目", page: 0 }, { query: "目", page: 101 },
    { query: "目", page: 1.5 }, { query: "目", page: "2" }, { query: "目", page: NaN },
    { query: "目", url: "https://example.com" }, { query: "目", apiKey: "secret" },
  ])("rejects malformed and unexpected requests: %j", (value) => {
    expect(() => parseDictionarySearchInput(value)).toThrow();
  });

  it("does not perform online requests or read keys for a local miss", async () => {
    await dictionarySearch({ query: "  太守  " });
    expect(mocks.local).toHaveBeenCalledWith("太守", 1);
    expect(mocks.online).not.toHaveBeenCalled();
    expect(mocks.key).not.toHaveBeenCalled();
  });

  it("only dispatches the explicitly selected online provider and supplies its key in main", async () => {
    await dictionarySearch({ query: "目", provider: "opendict", page: 2 });
    expect(mocks.key).toHaveBeenCalledWith("opendict");
    expect(mocks.online).toHaveBeenCalledWith({ query: "目", provider: "opendict", page: 2 }, "a".repeat(32));
    expect(mocks.local).not.toHaveBeenCalled();
    mocks.key.mockClear();
    await dictionarySearch({ query: "太守", provider: "kostma" });
    expect(mocks.online).toHaveBeenLastCalledWith({ query: "太守", provider: "kostma", page: 1 }, undefined);
    expect(mocks.key).not.toHaveBeenCalled();
  });

  it.each(["signed_out", "password_recovery"])("blocks all dictionary operations during %s", async (status) => {
    mocks.account.mockResolvedValue({ status, user: status === "signed_out" ? null : { id: "account-1" } });
    await expect(dictionarySearch({ query: "目", provider: "opendict" })).rejects.toMatchObject({ code: "auth_required" });
    await expect(dictionaryGetStatus()).rejects.toMatchObject({ code: "auth_required" });
    await expect(dictionarySetKey({ provider: "opendict", apiKey: "a".repeat(32) })).rejects.toMatchObject({ code: "auth_required" });
    for (const fn of [mocks.local, mocks.online, mocks.key, mocks.keyStatus, mocks.setKey, mocks.datasets]) expect(fn).not.toHaveBeenCalled();
  });
});

describe("dictionary credentials boundary", () => {
  it("validates only supported providers and a complete key, with blank input for deletion", () => {
    expect(parseDictionarySetKeyInput({ provider: "stdict", apiKey: `  ${"a".repeat(32)}  ` }))
      .toEqual({ provider: "stdict", apiKey: "a".repeat(32) });
    expect(parseDictionarySetKeyInput({ provider: "opendict", apiKey: " " })).toEqual({ provider: "opendict", apiKey: "" });
    for (const value of [null, [], {}, { provider: "kostma", apiKey: "" },
      { provider: "stdict", apiKey: 1 }, { provider: "stdict", apiKey: "a".repeat(31) },
      { provider: "stdict", apiKey: "g".repeat(32) }, { provider: "stdict", apiKey: "", query: "目" }]) {
      expect(() => parseDictionarySetKeyInput(value)).toThrow();
    }
  });

  it("projects only boolean flags even if the underlying store returns extra secret fields", async () => {
    mocks.keyStatus.mockReturnValue({ opendict: true, stdict: "should-never-be-a-key", apiKey: "secret" });
    expect(await dictionaryGetStatus()).toEqual({ datasets: [], keys: { opendict: true, stdict: false } });
    expect(await dictionarySetKey({ provider: "opendict", apiKey: "" }))
      .toEqual({ datasets: [], keys: { opendict: true, stdict: false } });
    expect(mocks.setKey).toHaveBeenCalledWith({ provider: "opendict", apiKey: "" });
    expect(mocks.online).not.toHaveBeenCalled();
  });

  it("does not expose a supplied key in an unexpected storage failure", async () => {
    const apiKey = "a".repeat(32);
    mocks.setKey.mockImplementation(() => { throw new Error(`cannot save ${apiKey}`); });
    const error = await dictionarySetKey({ provider: "opendict", apiKey }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(apiKey);
  });

  it("keeps status failures after key storage inside the existing redacted error boundary", async () => {
    const apiKey = "a".repeat(32);
    mocks.datasets.mockImplementation(() => { throw new Error(`status failed ${apiKey}`); });
    const error = await dictionarySetKey({ provider: "opendict", apiKey }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(apiKey);
    expect(String(error)).toContain("사전 인증 키를 저장하지 못했습니다");
  });
});
