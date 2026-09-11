import type { AgentRunEvent } from "@munhae/agent-runtime";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_CONFIG, type AiRunView } from "../src/shared/munhae-api";

vi.mock("../src/main/agent-runtime-client", () => ({
  cancelAgentRuntime: vi.fn(),
  probeAgentRuntime: vi.fn(),
  resumeAgentRuntime: vi.fn(),
  runAgentRuntime: vi.fn(),
}));
vi.mock("../src/main/window", () => ({ getMainWindow: () => null }));

import { publicRunError, requestFromPreferences, updateFromEvent } from "../src/main/ai-runs";

function runningView(taskKind: AiRunView["taskKind"]): AiRunView {
  return {
    messageId: "run-1",
    documentNodeId: "document-1",
    agentId: "codex",
    taskKind,
    state: "running",
    phase: "starting",
    detail: null,
    partialText: "",
    error: null,
    validationState: null,
    startedAt: "2026-09-04T00:00:00.000Z",
    completedAt: null,
  };
}

function textDelta(text: string): AgentRunEvent {
  return {
    type: "text_delta",
    runId: "run-1",
    agentId: "codex",
    at: "2026-09-04T00:00:01.000Z",
    text,
  };
}

describe("AI run renderer privacy", () => {
  it("builds ordinary project-chat requests without an app tool bridge", () => {
    const request = requestFromPreferences("run-1", "project overview question", DEFAULT_APP_CONFIG, "codex");

    expect(request).not.toHaveProperty("appTool");
    expect(request).not.toHaveProperty("nativeTools");
  });

  it("does not expose translation interim prose through partialText", () => {
    const view = runningView("translation");
    view.partialText = "stale interim output";

    updateFromEvent(view, textDelta("도구로 한 번만 제출하겠습니다."));

    expect(view.phase).toBe("streaming");
    expect(view.detail).toBe("응답 처리 중…");
    expect(view.partialText).toBe("");
  });

  it("keeps assistant response streaming for ordinary chat", () => {
    const view = runningView("chat");

    updateFromEvent(view, textDelta("문서에 따르면"));
    updateFromEvent(view, textDelta(" 이 구절은…"));

    expect(view.phase).toBe("streaming");
    expect(view.partialText).toBe("문서에 따르면 이 구절은…");
  });

  it.each(["translation", "chat", "punctuation_suggest"] as const)(
    "replaces %s provider status detail with a coarse status",
    (taskKind) => {
      const view = runningView(taskKind);

      updateFromEvent(view, {
        type: "status",
        runId: "run-1",
        agentId: "codex",
        at: "2026-09-04T00:00:01.000Z",
        phase: "thinking",
        detail: "provider-specific activity",
      });

      expect(view.phase).toBe("thinking");
      expect(view.detail).toBe("AI 응답을 기다리고 있습니다. 긴 작업은 시간이 더 걸릴 수 있습니다.");
    },
  );

  it("does not expose unvalidated punctuation suggestion prose", () => {
    const view = runningView("punctuation_suggest");

    updateFromEvent(view, textDelta("원문과 다른 미검증 표점문"));

    expect(view.detail).toBe("응답 처리 중…");
    expect(view.partialText).toBe("");
  });

  it("does not copy tool names or payloads into the renderer view", () => {
    const view = runningView("chat");
    const secret = "SENTINEL-tool-name-input-result";

    updateFromEvent(view, {
      type: "tool_call",
      runId: "run-1",
      agentId: "codex",
      at: "2026-09-04T00:00:01.000Z",
      name: secret,
      state: "started",
      input: secret,
      result: secret,
    } as AgentRunEvent);

    expect(view.phase).toBe("validating");
    expect(view.detail).toBe("응답 처리 중…");
    expect(JSON.stringify(view)).not.toContain(secret);
  });

  it.each([
    "provider_failed",
    "connection_dropped",
    "tool_permission_required",
    "session_unavailable",
    "unknown_future_provider_error",
  ])("never exposes provider-authored %s error details", (code) => {
    const view = runningView("chat");
    const secret = "SENTINEL /Users/private/project.sqlite3 Bash(cat auth.json) stderr tool-result";

    updateFromEvent(view, {
      type: "error",
      runId: "run-1",
      agentId: "claude",
      at: "2026-09-04T00:00:01.000Z",
      error: {
        code,
        message: secret,
        retryable: false,
        stderr: secret,
      },
    } as AgentRunEvent);

    const publicError = publicRunError({ code, message: secret });
    expect(view.detail).toBe(publicError.message);
    expect(publicError.code).toBe(code === "unknown_future_provider_error" ? "provider_failed" : code);
    expect(JSON.stringify({ view, publicError })).not.toContain(secret);
    expect(publicError.message).not.toContain("/Users/");
    expect(publicError.message).not.toContain("Bash(");
  });

  it("replaces an unsafe provider error code as well as its message", () => {
    const secret = "SENTINEL-provider-error";
    expect(publicRunError({ code: `bad code ${secret}`, message: secret })).toEqual({
      code: "provider_failed",
      message: "AI CLI 실행에 실패했습니다.",
    });
  });
});
