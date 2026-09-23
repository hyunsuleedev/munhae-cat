import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadAppConfig, mergeAppConfig, parseAppConfig, parseConfigPatch, saveAppConfig } from "../src/main/app-config";
import { translateUi } from "../src/shared/ui-translations";
import { setUiLanguage, ui, uiText } from "../src/renderer/scripts/i18n";

afterEach(() => vi.unstubAllGlobals());
it("migrates old settings, persists English across reopening, and preserves it during unrelated updates", () => {
  const dir = mkdtempSync(join(tmpdir(), "munhae-language-"));
  try {
    expect(parseAppConfig({}).language).toBe("ko");
    expect(parseAppConfig({ language: "invalid" }).language).toBe("ko");
    const config = mergeAppConfig(parseAppConfig({}), parseConfigPatch({ language: "en" }));
    saveAppConfig(dir, config);
    expect(loadAppConfig(dir).language).toBe("en");
    expect(mergeAppConfig(loadAppConfig(dir), { backgroundMusicEnabled: false }).language).toBe("en");
    expect(() => parseConfigPatch({ language: "fr" })).toThrow();
    expect(() => parseConfigPatch({ language: null })).toThrow();
    saveAppConfig(dir, mergeAppConfig(config, { language: "ko" }));
    expect(loadAppConfig(dir).language).toBe("ko");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("translates authored UI while preserving Korean document text and markup in interpolations", () => {
  vi.stubGlobal("document", { documentElement: {} });
  setUiLanguage("en");
  const source = "원문";
  const userMarkup = '<span title="설정">번역</span>';
  expect(ui`<button title="설정">저장</button><p>${source}</p>${userMarkup}`).toBe('<button title="Settings">Save</button><p>원문</p>'+userMarkup);
  expect(uiText('<input placeholder="명령 검색…">')).toBe('<input placeholder="Search commands…">');
  expect(translateUi("Unknown label", "en")).toBe("Unknown label");
  setUiLanguage("ko");
  expect(ui`<button>저장</button>${source}`).toBe('<button>저장</button>원문');
});

it("persists a translation target independently of the display language", () => {
  expect(parseAppConfig({}).translationLanguage).toBe("ko");
  const config = mergeAppConfig(parseAppConfig({ language: "en" }), parseConfigPatch({ translationLanguage: "ko" }));
  expect(config.language).toBe("en");
  expect(config.translationLanguage).toBe("ko");
  expect(mergeAppConfig(config, parseConfigPatch({ translationLanguage: "en" })).translationLanguage).toBe("en");
  expect(() => parseConfigPatch({ translationLanguage: "fr" })).toThrow();
});

it("translates runtime status values without changing interpolated document text", () => {
  vi.stubGlobal("document", { documentElement: {} });
  setUiLanguage("en");
  expect(translateUi("업데이트 다운로드 중 (42%)…", "en")).toBe("Downloading update (42%)…");
  expect(ui`${3}자`).toBe("3 characters");
  expect(ui`<p>${"{{0}} 한국어 원문 $&"}</p>`).toBe("<p>{{0}} 한국어 원문 $&</p>");
  setUiLanguage("ko");
});
