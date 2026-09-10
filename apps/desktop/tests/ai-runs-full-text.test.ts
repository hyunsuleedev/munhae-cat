import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRunResult } from "@munhae/agent-runtime";
import { createProject, type ProjectRepo } from "@munhae/db-sqlite";
import { afterEach, expect, it, vi } from "vitest";
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
  startTranslationRun,
  getTranslationRun,
  cancelAllAiRuns,
  hasActiveAiRuns,
} from "../src/main/ai-runs";
import { stopAgentToolBridge } from "../src/main/agent-tool-bridge";
const dirs: string[] = [];
const repos: ProjectRepo[] = [];
const config: AppConfig = {
  agentId: "codex",
  agentModels: {
    antigravity: { model: "default", reasoning: null, serviceTier: null },
    codex: { model: "default", reasoning: "medium", serviceTier: null },
    claude: { model: "default", reasoning: "medium", serviceTier: null },
  },
  showWelcomeOnLaunch: false,
};
const sessions = { get: () => null, set() {}, clear() {} };
const text = JSON.stringify({
  schemaVersion: 1,
  translation: "첫 문장.\n\n둘째 문장.",
});
const alignment = JSON.stringify({
  schemaVersion: 1,
  versionId: "v1",
  links: [],
});
function fixture() {
  const packagePath = mkdtempSync(join(tmpdir(), "munhae-fulltext-run-"));
  dirs.push(packagePath);
  const repo = {
    projectId: "test-project",
    packagePath,
    beginFullTextRun: vi.fn(() => ({
      messageId: "run",
      threadId: "thread",
      requestText: "translation skill",
      snapshot: {},
    })),
    completeFullTextRun: vi.fn(() => ({ version: { versionId: "v1" } })),
    prepareAlignment: vi.fn(() => "alignment skill"),
    completeAlignment: vi.fn(),
    finishFullTextRun: vi.fn(),
    failAlignment: vi.fn(),
    failTranslationRun: vi.fn(),
    getEditor: vi.fn(() => ({
      translation: {
        versionId: "v1",
        textLayout: { state: "failed" },
        isCurrentDependencies: true,
      },
    })),
  };
  runtime.probeAgentRuntime.mockResolvedValue({
    installed: true,
    loggedIn: true,
    version: "test-cli",
  });
  return repo;
}
function result(): AgentRunResult {
  return {
    ok: true,
    runId: "run",
    agentId: "codex",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1,
    executable: "/test/codex",
    cliVersion: "test-cli",
    sessionRef: null,
    model: "test-model",
    outputContract: null,
    outputText: "",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}
async function submit(request: AgentRunRequest, body: string) {
  const e = request.appTool!.env;
  return fetch(e.MUNHAE_TOOL_URL!, {
    method: "POST",
    headers: {
      authorization: `Bearer ${e.MUNHAE_TOOL_GRANT}`,
      "content-type": "application/json",
      "x-munhae-run-id": e.MUNHAE_TOOL_RUN_ID!,
    },
    body,
  });
}
async function done() {
  const until = Date.now() + 3000;
  while (hasActiveAiRuns()) {
    if (Date.now() > until) throw Error("run did not finish");
    await new Promise((r) => setTimeout(r, 2));
  }
}
afterEach(async () => {
  await cancelAllAiRuns();
  await stopAgentToolBridge();
  vi.clearAllMocks();
  while (repos.length) repos.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
it.each(["codex", "antigravity"] as const)("%s saves whole translation before a separate fresh alignment request with a new one-use grant", async (agentId) => {
  const repo = fixture();
  let first: AgentRunRequest | undefined;
  runtime.runAgentRuntime.mockImplementation(
    async (_a: string, request: AgentRunRequest) => {
      expect(_a).toBe(agentId);
      if (!first) {
        first = request;
        expect(request.appTool?.env.MUNHAE_TOOL_COMMAND).toBe(
          "submit-translation",
        );
        expect((await submit(request, text)).status).toBe(200);
        expect(repo.completeFullTextRun).toHaveBeenCalledTimes(1);
      } else {
        expect(repo.completeFullTextRun).toHaveBeenCalledTimes(1);
        expect(request.prompt).toBe("alignment skill");
        expect(request.appTool?.env.MUNHAE_TOOL_COMMAND).toBe(
          "submit-alignment",
        );
        expect(request.appTool?.env.MUNHAE_TOOL_GRANT).not.toBe(
          first.appTool?.env.MUNHAE_TOOL_GRANT,
        );
        expect((await submit(first, text)).status).not.toBe(200);
        expect((await submit(request, alignment)).status).toBe(200);
        expect((await submit(request, alignment)).status).toBe(409);
      }
      return { ...result(), agentId };
    },
  );
  await startTranslationRun(
    repo as unknown as ProjectRepo,
    config,
    { documentNodeId: "doc", agentId },
    sessions,
  );
  await done();
  expect(runtime.runAgentRuntime).toHaveBeenCalledTimes(2);
  expect(runtime.resumeAgentRuntime).not.toHaveBeenCalled();
  expect(repo.completeAlignment).toHaveBeenCalledWith("v1", alignment);
  expect(repo.finishFullTextRun).toHaveBeenCalledWith(
    expect.objectContaining({ rawResponse: text, resolvedModel: "test-model" }),
  );
  expect(getTranslationRun("run").state).toBe("completed");
});
it("preserves submitted translation when the second request fails", async () => {
  const repo = fixture();
  runtime.runAgentRuntime.mockImplementation(
    async (_a: string, r: AgentRunRequest) => {
      if (r.appTool?.env.MUNHAE_TOOL_COMMAND === "submit-translation") {
        await submit(r, text);
        return result();
      }
      throw Error("alignment provider interrupted");
    },
  );
  await startTranslationRun(
    repo as unknown as ProjectRepo,
    config,
    { documentNodeId: "doc", agentId: "codex" },
    sessions,
  );
  await done();
  expect(repo.completeFullTextRun).toHaveBeenCalledTimes(1);
  expect(repo.failAlignment).toHaveBeenCalledWith("v1", expect.any(String));
  expect(repo.failTranslationRun).not.toHaveBeenCalled();
  expect(repo.finishFullTextRun).toHaveBeenCalledWith(
    expect.objectContaining({ rawResponse: text }),
  );
  expect(getTranslationRun("run").detail).toContain("번역은 저장");
});
it("does not start alignment without a submitted translation", async () => {
  const repo = fixture();
  runtime.runAgentRuntime.mockResolvedValue(result());
  await startTranslationRun(
    repo as unknown as ProjectRepo,
    config,
    { documentNodeId: "doc", agentId: "codex" },
    sessions,
  );
  await done();
  expect(runtime.runAgentRuntime).toHaveBeenCalledTimes(1);
  expect(repo.prepareAlignment).not.toHaveBeenCalled();
  expect(repo.failTranslationRun).toHaveBeenCalled();
  expect(getTranslationRun("run").state).toBe("failed");
});
it("retries only alignment and closes a failed retry without replacing translation", async () => {
  const repo = fixture();
  runtime.runAgentRuntime.mockRejectedValue(Error("retry failed"));
  await startTranslationRun(
    repo as unknown as ProjectRepo,
    config,
    { documentNodeId: "doc", agentId: "codex", alignmentVersionId: "v1" },
    sessions,
  );
  await done();
  expect(runtime.runAgentRuntime).toHaveBeenCalledTimes(1);
  expect(repo.completeFullTextRun).not.toHaveBeenCalled();
  expect(repo.failAlignment).toHaveBeenCalledWith("v1", expect.any(String));
  expect(repo.failTranslationRun).toHaveBeenCalled();
});

// SQLite uses the desktop Electron ABI. Run this file with Electron-hosted Vitest
// to exercise persistence; the ordinary Node suite still runs the runtime mocks.
it.skipIf(!process.versions.electron)("revises from selected comments through the runtime tool and preserves linked translation versions", async () => {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-revision-runtime-"));
  dirs.push(parentDir);
  const repo = createProject({ title: "재번역 실행 검증", parentDir }).handle;
  repos.push(repo);
  const original = "巖棲客問僧";
  const baseline = "스님이 스님에게 물었다.";
  const revised = "화자가 스님에게 물었다.";
  const doc = repo.createDocument({ title: "질문의 주체", nodeRole: "source_unit", sourceText: original, originKind: "paste", parentId: null });
  const firstRun = repo.beginFullTextRun({ documentNodeId: doc.id, agentId: "codex", requestedModel: null, reasoningLevel: null, serviceTier: null, runtimeVersion: null });
  const firstResult = repo.completeFullTextRun({ messageId: firstRun.messageId, rawResponse: JSON.stringify({ schemaVersion: 1, translation: baseline }), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
  const baseVersionId = firstResult.version.versionId;
  const target = { documentNodeId: doc.id, translationVersionId: baseVersionId, targetKind: "source" as const,
    targetVersionId: repo.getEditor(doc.id).source.versionId, codepointFrom: 0, codepointTo: 3, quote: "巖棲客" };
  const included = repo.createReviewComment({ ...target, bodyMd: "巖棲客은 화자다. 질문의 주체를 화자로 수정한다." });
  const excluded = repo.createReviewComment({ ...target, bodyMd: "이번 재번역에 포함하지 않은 별도 검토 의견." });
  const revision = { baseVersionId, commentIds: [included.id] };
  const preview = repo.previewContext({ documentNodeId: doc.id, revision });
  const requests: AgentRunRequest[] = [];
  runtime.probeAgentRuntime.mockResolvedValue({ installed: true, loggedIn: true, version: "test-cli" });
  runtime.runAgentRuntime.mockImplementation(async (_agentId: string, request: AgentRunRequest) => {
    requests.push(request);
    if (request.appTool?.env.MUNHAE_TOOL_COMMAND === "submit-translation") {
      expect(request.prompt).toBe(preview.requestText);
      expect(request.prompt).toContain(baseline);
      expect(request.prompt).toContain(included.bodyMd);
      expect(request.prompt).not.toContain(excluded.bodyMd);
      expect((await submit(request, JSON.stringify({ schemaVersion: 1, translation: revised }))).status).toBe(200);
    } else {
      const current = repo.getEditor(doc.id).translation!;
      expect(current.textContent).toBe(revised);
      expect(current.versionId).not.toBe(baseVersionId);
      expect(request.prompt).toContain(revised);
      expect((await submit(request, JSON.stringify({ schemaVersion: 1, versionId: current.versionId,
        links: [{ sentenceId: "T1", quotes: [{ text: original, occurrence: 1 }], needsReview: false }] }))).status).toBe(200);
    }
    return result();
  });

  const started = await startTranslationRun(repo, config, { documentNodeId: doc.id, agentId: "codex", revision }, sessions);
  await done();

  expect(getTranslationRun(started.messageId)).toMatchObject({ state: "completed", validationState: "valid" });
  expect(requests.map(request => request.appTool?.env.MUNHAE_TOOL_COMMAND)).toEqual(["submit-translation", "submit-alignment"]);
  const current = repo.getEditor(doc.id).translation!;
  expect(current.textContent).toBe(revised);
  expect(current.textLayout?.state).toBe("ready");
  const history = repo.getDocumentHistory(doc.id);
  expect(history.entries.find(entry => entry.versionId === baseVersionId)?.contentText).toBe(baseline);
  expect(history.entries.find(entry => entry.versionId === current.versionId)?.parentVersionId).toBe(baseVersionId);
  const diff = repo.compareVersions({ documentNodeId: doc.id, kind: "translation", stage: "translation", baseVersionId, targetVersionId: current.versionId });
  expect(diff.chunks.some(chunk => chunk.type === "add" && chunk.text.includes("화자"))).toBe(true);
  expect(repo.listReviewComments(doc.id).map(comment => comment.translationVersionId)).toEqual([baseVersionId, baseVersionId]);
});
