import { expect, it } from "vitest";
import type { AiRunView } from "../src/shared/munhae-api";
import { completionCue } from "../src/renderer/scripts/notification-sound-model";
import { mergeAppConfig, parseAppConfig, parseConfigPatch } from "../src/main/app-config";
const run: AiRunView = { messageId: "r1", documentNodeId: "d1", agentId: "codex", taskKind: "chat", state: "completed", phase: "completed", detail: null, partialText: "", error: null, validationState: null, startedAt: "", completedAt: "" };
it("only responds to explicit live stage signals, not historical completed snapshots", () => {
  expect(completionCue(run)).toBeNull();
  expect(completionCue({ ...run, completionStage: "chat" })).toEqual({ id: "r1:chat", kind: "chat" });
  expect(completionCue({ ...run, completionStage: "chat", state: "running" })).toBeNull();
});
it("distinguishes saved translation from completed alignment and rejects failures/cancellations", () => {
  const translation = { ...run, taskKind: "translation" as const, validationState: "valid" as const };
  expect(completionCue({ ...translation, state: "running", phase: "translation_saved", completionStage: "translation" })?.id).toBe("r1:translation");
  expect(completionCue({ ...translation, completionStage: "alignment" })?.id).toBe("r1:alignment");
  // Alignment failures can retain state=completed when the translation was saved.
  expect(completionCue({ ...translation, detail: "alignment failed" })).toBeNull();
  for (const patch of [{ state: "failed" as const }, { state: "canceled" as const }, { validationState: "invalid_unapplied" as const }, { error: { code: "failure", message: "failed" } }]) {
    expect(completionCue({ ...translation, completionStage: "alignment", ...patch })).toBeNull();
  }
});
it("keeps notification controls independent of background music and preserves mute", () => {
  const config = mergeAppConfig(parseAppConfig({ backgroundMusicEnabled: false, backgroundMusicVolume: 18 }), parseConfigPatch({ notificationSoundEnabled: true, notificationSoundVolume: 0 }));
  expect(config.notificationSoundEnabled).toBe(true);
  expect(config.notificationSoundVolume).toBe(0);
  expect(config.backgroundMusicEnabled).toBe(false);
  expect(config.backgroundMusicVolume).toBe(18);
  expect(parseAppConfig({ notificationSoundVolume: Infinity }).notificationSoundVolume).toBe(35);
});
