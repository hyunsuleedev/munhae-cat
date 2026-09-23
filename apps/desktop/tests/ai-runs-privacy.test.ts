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

  it("shows tool names without copying tool inputs or results", () => {
    const view = runningView("chat");
    const secret = "SENTINEL-tool-name-input-result";

    updateFromEvent(view, {
      type: "tool_call",
      runId: "run-1",
      agentId: "codex",
      at: "2026-09-04T00:00:01.000Z",
      name: "web_search",
      state: "started",
      input: secret,
      result: secret,
    } as AgentRunEvent);

    expect(view.phase).toBe("validating");
    expect(view.detail).toBe("응답 처리 중…");
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(view.activity).toEqual([{ kind: "tool", text: "web_search · 실행 중", name: "web_search", state: "started" }]);
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

it("keeps thinking separate from chat answers and excludes other providers/tasks", () => {
  for (const task of ["chat", "translation", "punctuation_suggest"] as const) {
    for (const agent of ["claude", "codex", "antigravity"] as const) {
      const view = runningView(task); view.agentId = agent;
      updateFromEvent(view, { type: "thinking_delta", runId: "run-1", agentId: agent, at: "", text: "문맥 검토" });
      expect(view.thinkingText ?? "").toBe((task === "chat" || task === "translation") && agent !== "antigravity" ? "문맥 검토" : "");
      expect(view.partialText).toBe("");
    }
  }
});

it("retains text, tool activity and thinking in arrival order for chat only", () => {
  const view = runningView("chat");
  updateFromEvent(view, textDelta("출전 확인"));
  updateFromEvent(view, { ...textDelta(""), type: "tool_call", name: "web_search", state: "started" });
  updateFromEvent(view, { ...textDelta("검토"), type: "thinking_delta" });
  updateFromEvent(view, textDelta("답변"));
  expect(view.activity?.map(block => block.kind)).toEqual(["text", "tool", "thinking", "text"]);
  const translation = runningView("translation");
  updateFromEvent(translation, textDelta("초안"));
  expect(translation.activity).toBeUndefined();
});


it("updates calls by ID even when same-name calls overlap and terminal events replay", () => {
  const view = runningView("chat");
  const tool = (id: string, state: "started" | "completed" | "failed") => updateFromEvent(view, { ...textDelta(""), type: "tool_call", id, name: "web_search", state });
  tool("a", "started"); tool("b", "started");
  tool("b", "failed"); tool("a", "completed"); tool("a", "completed"); tool("a", "started");
  expect(view.activity?.map(({ id, state }) => ({ id, state }))).toEqual([{ id: "a", state: "completed" }, { id: "b", state: "failed" }]);
});

 it("streams translation thinking and tool lifecycle without result JSON", () => {
  const view = runningView("translation");
  updateFromEvent(view, { ...textDelta("원문을 검토합니다."), type: "thinking_delta" });
  const tool = { ...textDelta(""), type: "tool_call" as const, id: "lookup", name: "web_search", state: "started" as const };
  updateFromEvent(view, tool);
  updateFromEvent(view, textDelta('{"translation":"structured result"}'));
  updateFromEvent(view, { ...tool, state: "completed" });
  expect(view.activity?.map(block => block.kind)).toEqual(["thinking", "tool"]);
  expect(view.activity?.[1]?.state).toBe("completed");
  expect(view.partialText).toBe("");
  expect(JSON.stringify(view)).not.toContain("structured result");
 });
