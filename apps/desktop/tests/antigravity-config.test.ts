import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadAppConfig, parseAppConfig, saveAppConfig } from "../src/main/app-config";
import { parseAgentId } from "../src/main/ipc-validate";
import { isAgentRuntimeRequest } from "../src/main/agent-runtime-protocol";
it("adds Antigravity defaults to existing preferences and persists model selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "munhae-agy-config-"));
  try {
    const old = parseAppConfig({ agentId: "codex", agentModels: { codex: { model: "saved-codex", reasoning: "high", serviceTier: "priority" } } });
    expect(old.agentId).toBe("codex");
    expect(old.agentModels.codex.model).toBe("saved-codex");
    expect(old.agentModels.antigravity).toEqual({ model: "default", reasoning: null, serviceTier: null });
    const current = parseAppConfig({ ...old, agentId: "antigravity", agentModels: { ...old.agentModels, antigravity: { model: "gemini-test", reasoning: "high", serviceTier: "priority" } } });
    saveAppConfig(dir, current);
    expect(loadAppConfig(dir)).toEqual(current);
    expect(current.agentModels.antigravity.serviceTier).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("accepts Antigravity across IPC and worker transport while rejecting unknown providers", () => {
  expect(parseAgentId("antigravity")).toBe("antigravity");
  expect(() => parseAgentId("unknown")).toThrow();
  for (const operation of ["probe", "begin_login", "run"]) {
    expect(isAgentRuntimeRequest({ type: "request", requestId: "r", operation, agentId: "antigravity", request: { runId: "test", prompt: "天地" } })).toBe(true);
  }
});
