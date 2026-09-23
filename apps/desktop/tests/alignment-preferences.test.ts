import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseAppConfig, parseConfigPatch, mergeAppConfig, saveAppConfig, loadAppConfig } from "../src/main/app-config";
import { alignmentPreferences } from "../src/shared/alignment-preferences";

it("inherits the actual translation provider on old configs", () => {
  const config = parseAppConfig({ agentId: "claude", agentModels: { codex: { model: "gpt-6", reasoning: "max", serviceTier: null } } });
  expect(config.alignment).toBeNull();
  expect(alignmentPreferences(config, "codex")).toMatchObject({ agentId: "codex", model: "gpt-6", reasoning: "max" });
});
it("persists separate alignment preferences without modifying translation and restores inheritance", () => {
  const dir = mkdtempSync(join(tmpdir(), "munhae-alignment-prefs-"));
  try {
    const original = parseAppConfig({});
    const alignment = { agentId: "codex", model: "gpt-6", reasoning: "low", serviceTier: null };
    const saved = mergeAppConfig(original, parseConfigPatch({ alignment }));
    saveAppConfig(dir, saved);
    const reopened = loadAppConfig(dir);
    expect(alignmentPreferences(reopened, "claude")).toEqual(alignment);
    expect(reopened.agentModels).toEqual(original.agentModels);
    expect(mergeAppConfig(reopened, parseConfigPatch({ alignment: null })).alignment).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("drops unsupported service tiers and Gemini effort values", () => {
  expect(parseAppConfig({ alignment: { agentId: "antigravity", model: "default", reasoning: "max", serviceTier: "fast" } }).alignment).toMatchObject({ reasoning: null, serviceTier: null });
});

it("normalizes fixed Gemini effort for both translation and alignment", () => {
  const config = parseAppConfig({ agentModels: { antigravity: { model: "gemini-3.8-flash-low", reasoning: "medium", serviceTier: null } }, alignment: { agentId: "antigravity", model: "gemini-3.8-flash-high", reasoning: "low", serviceTier: null } });
  expect(config.agentModels.antigravity.reasoning).toBe("low");
  expect(config.alignment?.reasoning).toBe("high");
});
