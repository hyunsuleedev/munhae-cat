import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRunResult } from "@munhae/agent-runtime";
import type { ProjectRepo } from "@munhae/db-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/shared/munhae-api";

const runtime = vi.hoisted(() => ({
  cancelAgentRuntime: vi.fn(),
  probeAgentRuntime: vi.fn(),
  resumeAgentRuntime: vi.fn(),
  runAgentRuntime: vi.fn(),
}));

vi.mock("../src/main/agent-runtime-client", () => runtime);
vi.mock("../src/main/window", () => ({ getMainWindow: () => null }));

import {
  cancelAllAiRuns,
  getTranslationRun,
  startLegacyTranslationRun as startTranslationRun,
} from "../src/main/ai-runs";
import { stopAgentToolBridge } from "../src/main/agent-tool-bridge";

const tempDirs: string[] = [];

const config: AppConfig = {
  agentId: "codex",
  agentModels: {
    antigravity: { model: "default", reasoning: null, serviceTier: null },
    codex: { model: "default", reasoning: "medium", serviceTier: null },
    claude: { model: "default", reasoning: "medium", serviceTier: null },
  },
  showWelcomeOnLaunch: false,
};

async function waitForTerminal(messageId: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (getTranslationRun(messageId).state === "running") {
    if (Date.now() >= deadline) throw new Error("translation run did not finish");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

afterEach(async () => {
  await cancelAllAiRuns();
  await stopAgentToolBridge();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("translation app-tool commit boundary", () => {
  it("returns bridge success only after repository completion and finalizes the same raw bytes", async () => {
    const packagePath = mkdtempSync(join(tmpdir(), "munhae-ai-run-"));
    tempDirs.push(packagePath);
    const messageId = "translation-message-1";
    const submittedRaw = JSON.stringify({
      schemaVersion: 2,
      anchorSetId: "anchors-1",
      blocks: [{
        blockKey: "B001",
        sourceAnchorIds: ["A001"],
        blockKind: "sentence",
        translation: "제출된 번역",
      }],
    });
    const completeTranslationRun = vi.fn((input: { rawResponse: string }) => ({
      messageId,
      validationState: "valid" as const,
      fatalFindings: 0,
      recoverableFindings: 0,
      version: { translationId: "translation-1", versionId: "version-1", validationState: "valid" as const },
      idempotent: completeTranslationRun.mock.calls.length > 1,
      rawResponse: input.rawResponse,
    }));
    const repo = {
      projectId: "project-1",
      packagePath,
      beginTranslationRun: vi.fn(() => ({
        messageId,
        threadId: "thread-1",
        requestArtifactId: "request-1",
        requestText: "Use the app command exactly once.",
        requestHash: "request-hash-1",
        promptContractVersion: "munhae.translation.v2",
        snapshot: {
          documentNodeId: "document-1",
          sourceTextId: "source-1",
          sourceTextVersionId: "source-version-1",
          punctuationVersionId: "punctuation-version-1",
          policyVersionId: "policy-version-1",
          anchorSetId: "anchors-1",
          targetLocale: "ko",
          expectedHead: null,
        },
      })),
      completeTranslationRun,
      recordTranslationAgentSession: vi.fn(),
      recordInvalidTranslationResponse: vi.fn(),
      failTranslationRun: vi.fn(),
    } as unknown as ProjectRepo;

    runtime.probeAgentRuntime.mockResolvedValue({
      installed: true,
      loggedIn: true,
      version: "codex-cli test",
    });
    runtime.runAgentRuntime.mockImplementation(async (
      _agentId: string,
      request: AgentRunRequest,
    ): Promise<AgentRunResult> => {
      const tool = request.appTool;
      if (!tool) throw new Error("translation request did not receive its app tool");
      const response = await fetch(tool.env.MUNHAE_TOOL_URL!, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tool.env.MUNHAE_TOOL_GRANT!}`,
          "content-type": "application/json",
          "x-munhae-run-id": tool.env.MUNHAE_TOOL_RUN_ID!,
        },
        body: submittedRaw,
      });
      expect(response.status).toBe(200);
      expect(completeTranslationRun).toHaveBeenCalledTimes(1);
      expect(completeTranslationRun.mock.calls[0]?.[0]).toMatchObject({
        messageId,
        rawResponse: submittedRaw,
        usage: null,
        resolvedModel: null,
        runtimeVersion: null,
      });
      const duplicate = await fetch(tool.env.MUNHAE_TOOL_URL!, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tool.env.MUNHAE_TOOL_GRANT!}`,
          "content-type": "application/json",
          "x-munhae-run-id": tool.env.MUNHAE_TOOL_RUN_ID!,
        },
        body: submittedRaw,
      });
      expect(duplicate.status).toBe(409);
      expect(completeTranslationRun).toHaveBeenCalledTimes(1);
      return {
        ok: true,
        runId: messageId,
        agentId: "codex",
        startedAt: "2026-09-04T00:00:00.000Z",
        completedAt: "2026-09-04T00:00:01.000Z",
        durationMs: 1_000,
        executable: "/test/codex",
        cliVersion: "codex-cli test",
        sessionRef: null,
        model: "gpt-test",
        outputContract: null,
        outputText: '{"translation":"provider display text is not authoritative"}',
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    });

    const started = await startTranslationRun(
      repo,
      config,
      { documentNodeId: "document-1", agentId: "codex" },
      { get: () => null, set() {}, clear() {} },
    );
    await waitForTerminal(started.messageId);

    expect(getTranslationRun(messageId)).toMatchObject({
      state: "completed",
      phase: "completed",
      validationState: "valid",
    });
    expect(completeTranslationRun).toHaveBeenCalledTimes(2);
    expect(completeTranslationRun.mock.calls[1]?.[0]).toMatchObject({
      messageId,
      rawResponse: submittedRaw,
      usage: { inputTokens: 10, outputTokens: 20 },
      resolvedModel: "gpt-test",
      runtimeVersion: "codex-cli test",
    });
    expect(JSON.stringify(completeTranslationRun.mock.calls)).not.toContain("provider display text is not authoritative");
  });

  it.each(["grant", "inherited", "generic", "invalid_json"] as const)(
    "rejects %s secrets before any translation response reaches the repository",
    async (secretKind) => {
      const packagePath = mkdtempSync(join(tmpdir(), "munhae-ai-run-secret-"));
      tempDirs.push(packagePath);
      const messageId = `translation-secret-${secretKind}`;
      const inheritedSecret = "inherited-provider-secret-value";
      vi.stubEnv("EXTERNAL_SERVICE_TOKEN", inheritedSecret);
      const completeTranslationRun = vi.fn();
      const recordInvalidTranslationResponse = vi.fn();
      const failTranslationRun = vi.fn();
      const repo = {
        projectId: "project-1",
        packagePath,
        beginTranslationRun: vi.fn(() => ({
          messageId,
          threadId: "thread-1",
          requestArtifactId: "request-1",
          requestText: "Use the app command exactly once.",
          requestHash: "request-hash-1",
          promptContractVersion: "munhae.translation.v2",
          snapshot: {
            documentNodeId: "document-1",
            sourceTextId: "source-1",
            sourceTextVersionId: "source-version-1",
            punctuationVersionId: "punctuation-version-1",
            policyVersionId: "policy-version-1",
            anchorSetId: "anchors-1",
            targetLocale: "ko",
            expectedHead: null,
          },
        })),
        completeTranslationRun,
        recordTranslationAgentSession: vi.fn(),
        recordInvalidTranslationResponse,
        failTranslationRun,
      } as unknown as ProjectRepo;

      runtime.probeAgentRuntime.mockResolvedValue({
        installed: true,
        loggedIn: true,
        version: "codex-cli test",
      });
      runtime.runAgentRuntime.mockImplementation(async (
        _agentId: string,
        request: AgentRunRequest,
      ): Promise<AgentRunResult> => {
        const tool = request.appTool;
        if (!tool) throw new Error("translation request did not receive its app tool");
        const secret = secretKind === "grant"
          ? tool.env.MUNHAE_TOOL_GRANT!
          : secretKind === "inherited" || secretKind === "invalid_json"
            ? inheritedSecret
            : "Authorization: Bearer generic-provider-secret";
        const submittedRaw = secretKind === "invalid_json"
          ? `{"translation":"${secret}`
          : JSON.stringify({
              schemaVersion: 2,
              anchorSetId: "anchors-1",
              blocks: [{
                blockKey: "B001",
                sourceAnchorIds: ["A001"],
                blockKind: "sentence",
                translation: secret,
              }],
            });
        const response = await fetch(tool.env.MUNHAE_TOOL_URL!, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tool.env.MUNHAE_TOOL_GRANT!}`,
            "content-type": "application/json",
            "x-munhae-run-id": tool.env.MUNHAE_TOOL_RUN_ID!,
          },
          body: submittedRaw,
        });
        expect(response.status).toBe(secretKind === "invalid_json" ? 400 : 422);
        return {
          ok: true,
          runId: messageId,
          agentId: "codex",
          startedAt: "2026-09-04T00:00:00.000Z",
          completedAt: "2026-09-04T00:00:01.000Z",
          durationMs: 1_000,
          executable: "/test/codex",
          cliVersion: "codex-cli test",
          sessionRef: null,
          model: "gpt-test",
          outputContract: null,
          outputText: "provider display text",
          usage: null,
        };
      });

      const started = await startTranslationRun(
        repo,
        config,
        { documentNodeId: "document-1", agentId: "codex" },
        { get: () => null, set() {}, clear() {} },
      );
      await waitForTerminal(started.messageId);

      expect(getTranslationRun(messageId)).toMatchObject({
        state: "failed",
        phase: "failed",
      });
      expect(completeTranslationRun).not.toHaveBeenCalled();
      expect(recordInvalidTranslationResponse).not.toHaveBeenCalled();
      expect(failTranslationRun).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(failTranslationRun.mock.calls)).not.toContain(inheritedSecret);
      expect(JSON.stringify(failTranslationRun.mock.calls)).not.toContain("generic-provider-secret");
    },
  );
});
