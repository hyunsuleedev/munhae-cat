import { describe, expect, it } from "vitest";

import { parseGetProjectChatInput, parseStartProjectChatInput } from "../src/main/ipc-validate";

describe("project chat IPC scope validation", () => {
  it.each(["document_node", "project"] as const)("accepts the %s scope", (scopeKind) => {
    expect(parseStartProjectChatInput({
      documentNodeId: "document-1",
      scopeKind,
      question: "질문",
      agentId: "codex",
    })).toEqual({ documentNodeId: "document-1", scopeKind, question: "질문", agentId: "codex" });
    expect(parseGetProjectChatInput({ documentNodeId: "document-1", scopeKind })).toEqual({
      documentNodeId: "document-1",
      scopeKind,
    });
  });

  it("rejects an invalid scope and any caller-controlled project id", () => {
    expect(() => parseStartProjectChatInput({
      documentNodeId: "document-1",
      scopeKind: "workspace",
      question: "질문",
      agentId: "codex",
    })).toThrow();
    expect(() => parseStartProjectChatInput({
      projectId: "caller-project",
      documentNodeId: "document-1",
      scopeKind: "project",
      question: "질문",
      agentId: "codex",
    })).toThrow();
    expect(() => parseGetProjectChatInput({
      projectId: "caller-project",
      documentNodeId: "document-1",
      scopeKind: "project",
    })).toThrow();
  });
});
