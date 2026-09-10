import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadAppConfig, mergeAppConfig, parseAppConfig, parseConfigPatch, saveAppConfig } from "../src/main/app-config";

it("defaults old installations to music on and preserves an explicit off after restart and unrelated changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "munhae-music-"));
  try {
    const old = parseAppConfig({ showWelcomeOnLaunch: false });
    expect(old.backgroundMusicEnabled).toBe(true);
    const off = mergeAppConfig(old, parseConfigPatch({ backgroundMusicEnabled: false }));
    saveAppConfig(dir, off);
    const reopened = loadAppConfig(dir);
    expect(reopened.backgroundMusicEnabled).toBe(false);
    expect(reopened.showWelcomeOnLaunch).toBe(false);
    expect(mergeAppConfig(reopened, { showWelcomeOnLaunch: true }).backgroundMusicEnabled).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("persists volume including mute, clamps bounds, and migrates missing or invalid volume", () => {
  const dir = mkdtempSync(join(tmpdir(), "munhae-volume-"));
  try {
    expect(parseAppConfig({}).backgroundMusicVolume).toBe(18);
    for (const invalid of [NaN, Infinity, "50", null]) {
      expect(parseAppConfig({ backgroundMusicVolume: invalid }).backgroundMusicVolume).toBe(18);
    }
    expect(parseAppConfig({ backgroundMusicVolume: -1 }).backgroundMusicVolume).toBe(0);
    expect(parseAppConfig({ backgroundMusicVolume: 101 }).backgroundMusicVolume).toBe(100);
    for (const volume of [0, 37, 100]) {
      const config = mergeAppConfig(parseAppConfig({}), parseConfigPatch({ backgroundMusicVolume: volume }));
      saveAppConfig(dir, config);
      expect(loadAppConfig(dir).backgroundMusicVolume).toBe(volume);
      expect(mergeAppConfig(config, { backgroundMusicEnabled: false }).backgroundMusicVolume).toBe(volume);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
