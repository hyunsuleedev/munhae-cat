import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRunResult } from "@munhae/agent-runtime";
import { createProject, type ProjectRepo } from "@munhae/db-sqlite";
import { MunhaeError } from "@munhae/domain";
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
  registerAiPersistenceHook,
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
    submitAlignment: vi.fn(),
    checkAlignment: vi.fn(() => ({ revision: "r1", issues: [], sentences: [], canFinish: true })),
    finishAlignment: vi.fn(() => ({ state: "ready" })),
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
async function submit(request: AgentRunRequest, body: string, command?: string) {
  const e = request.appTool!.env;
  return fetch(command ? e.MUNHAE_TOOL_URL!.replace(/[^/]+$/, command) : e.MUNHAE_TOOL_URL!, {
    method: "POST",
    headers: {
      authorization: `Bearer ${e.MUNHAE_TOOL_GRANT}`,
      "content-type": "application/json",
      "x-munhae-run-id": e.MUNHAE_TOOL_RUN_ID!,
    },
    body,
  });
}
async function finish(request: AgentRunRequest) {
  const checked = await submit(request, "{}", "check-alignment");
  expect(checked.status).toBe(200);
  const report = await checked.json();
  expect((await submit(request, JSON.stringify({ revision: report.revision, outcome: "complete" }), "finish-alignment")).status).toBe(200);
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
it.each(["codex", "antigravity"] as const)("%s saves whole translation before a separate fresh alignment request with a new interactive alignment grant", async (agentId) => {
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
        expect((await submit(request, alignment)).status).toBe(200);
        await finish(request);
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
  expect(repo.submitAlignment).toHaveBeenCalledWith("v1", alignment);
  expect(repo.finishFullTextRun).toHaveBeenCalledWith(
    expect.objectContaining({ rawResponse: text, resolvedModel: "test-model" }),
  );
  expect(getTranslationRun("run").state).toBe("completed");
});
it("continues to alignment after the provider repairs invalid translation JSON", async () => {
  const repo = fixture();
  runtime.runAgentRuntime.mockImplementation(async (_a: string, request: AgentRunRequest) => {
    if (request.appTool?.env.MUNHAE_TOOL_COMMAND === "submit-translation") {
      expect((await submit(request, '{"translation":"first\nsecond"}')).status).toBe(400);
      expect(repo.completeFullTextRun).not.toHaveBeenCalled();
      expect((await submit(request, text)).status).toBe(200);
      expect((await submit(request, text)).status).toBe(409);
    } else {
      await submit(request, alignment);
      await finish(request);
    }
    return result();
  });
  await startTranslationRun(repo as unknown as ProjectRepo, config, { documentNodeId: "doc", agentId: "codex" }, sessions);
  await done();
  expect(repo.completeFullTextRun).toHaveBeenCalledTimes(1);
  expect(repo.finishFullTextRun).toHaveBeenCalledTimes(1);
  expect(repo.failTranslationRun).not.toHaveBeenCalled();
  expect(getTranslationRun("run").state).toBe("completed");
});

it("reports rejected JSON instead of claiming the provider did not submit", async () => {
  const repo = fixture();
  runtime.runAgentRuntime.mockImplementation(async (_a: string, request: AgentRunRequest) => {
    await submit(request, '{"translation":"first\nsecond"}');
    return result();
  });
  await startTranslationRun(repo as unknown as ProjectRepo, config, { documentNodeId: "doc", agentId: "codex" }, sessions);
  await done();
  expect(repo.completeFullTextRun).not.toHaveBeenCalled();
  expect(getTranslationRun("run").error?.message).toBe("AI 응답이 필요한 제출 형식을 충족하지 않았습니다.");
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
it("does not launch alignment before PostgreSQL accepts the newly submitted translation", async () => {
  const repo = fixture();
  const persist = vi.fn(async () => {});
  persist.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("online save rejected"));
  const unregister = registerAiPersistenceHook(persist, { beforeLaunch: true });
  runtime.runAgentRuntime.mockImplementation(async (_agent: string, request: AgentRunRequest) => {
    expect(persist).toHaveBeenCalledTimes(1);
    expect((await submit(request, text)).status).toBe(200);
    return result();
  });
  try {
    await startTranslationRun(repo as unknown as ProjectRepo, config, { documentNodeId: "doc", agentId: "codex" }, sessions);
    await done();
    expect(runtime.runAgentRuntime).toHaveBeenCalledTimes(1);
    expect(repo.completeFullTextRun).toHaveBeenCalledTimes(1);
    expect(repo.failAlignment).toHaveBeenCalledWith("v1", expect.any(String));
    expect(repo.failTranslationRun).not.toHaveBeenCalled();
    expect(repo.finishFullTextRun).toHaveBeenCalledWith(expect.objectContaining({ rawResponse: text }));
    expect(getTranslationRun("run").detail).toContain("번역은 저장");
    expect(persist).toHaveBeenCalledTimes(3);
  } finally { unregister(); }
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
      await finish(request);
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

it.skipIf(!process.versions.electron)("connects saved punctuation units through the runtime submit, check and finish tools", async () => {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-segments-runtime-"));
  dirs.push(parentDir);
  const repo = createProject({ title: "저장 분절 연결", parentDir }).handle;
  repos.push(repo);
  const doc = repo.createDocument({ title: "두 문장", nodeRole: "source_unit", sourceText: "甲\n乙", originKind: "paste", parentId: null });
  let editor = repo.getEditor(doc.id);
  editor = repo.confirmSource({ documentNodeId: doc.id, expectedLockVersion: editor.source.lockVersion });
  editor = repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: doc.id, structureMode: "prose", expectedSourceLockVersion: editor.source.lockVersion });
  editor = repo.savePunctuationDraft({ documentNodeId: doc.id, punctuatedText: "甲？\n\n乙！", structureMode: "prose", expectedLockVersion: editor.punctuation!.lockVersion });
  editor = repo.confirmPunctuation({ documentNodeId: doc.id, expectedLockVersion: editor.punctuation!.lockVersion });
  const punctuationVersionId = editor.punctuation!.versionId, anchorSetId = editor.punctuation!.anchorSetId!;
  const contracts: Array<string | null | undefined> = [];
  runtime.probeAgentRuntime.mockResolvedValue({ installed: true, loggedIn: true, version: "test-cli" });
  runtime.runAgentRuntime.mockImplementation(async (_agentId: string, request: AgentRunRequest) => {
    contracts.push(request.outputContract);
    if (request.appTool?.env.MUNHAE_TOOL_COMMAND === "submit-translation") {
      expect((await submit(request, text)).status).toBe(200);
    } else {
      const versionId = repo.getEditor(doc.id).translation!.versionId;
      expect(request.prompt).toContain("[A001]甲？[/A001]\n\n[A002]乙！[/A002]");
      expect((await submit(request, JSON.stringify({ schemaVersion: 4, versionId, punctuationVersionId, anchorSetId, links: [
        { sentenceIds: ["T1"], segmentIds: ["A001"], needsReview: false },
        { sentenceIds: ["T2"], segmentIds: ["A002"], needsReview: false },
      ] }))).status).toBe(200);
      await finish(request);
    }
    return result();
  });
  const started = await startTranslationRun(repo, config, { documentNodeId: doc.id, agentId: "codex" }, sessions);
  await done();
  expect(contracts).toEqual(["translation-text.v1", "translation-alignment.v4"]);
  expect(getTranslationRun(started.messageId).state).toBe("completed");
  expect(repo.getEditor(doc.id).translation!.textLayout).toMatchObject({ state: "ready", links: [
    { spans: [{ from: 0, to: 1, quote: "甲" }] }, { spans: [{ from: 2, to: 3, quote: "乙" }] },
  ] });
});

it.each([false, true])("uses separate alignment provider, model and effort (retry=%s)", async (retry) => {
  const repo = fixture();
  const settings = { ...config, alignment: { agentId: "claude" as const, model: "claude-sonnet-4-6", reasoning: "low", serviceTier: null } };
  runtime.runAgentRuntime.mockImplementation(async (agentId: string, request: AgentRunRequest) => {
    const isAlignment = request.appTool?.env.MUNHAE_TOOL_COMMAND === "submit-alignment";
    expect(agentId).toBe(isAlignment ? "claude" : "codex");
    expect(request.reasoningEffort).toBe(isAlignment ? "low" : "medium");
    if (isAlignment) expect(request.model).toBe("claude-sonnet-4-6");
    expect((await submit(request, isAlignment ? alignment : text)).status).toBe(200);
    if (isAlignment) await finish(request);
    return { ...result(), agentId };
  });
  await startTranslationRun(repo as unknown as ProjectRepo, settings, { documentNodeId: "doc", agentId: "codex", ...(retry ? { alignmentVersionId: "v1" } : {}) }, sessions);
  await done();
  expect(runtime.runAgentRuntime).toHaveBeenCalledTimes(retry ? 1 : 2);
  expect(repo.submitAlignment).toHaveBeenCalled();
  if (retry) expect(repo.beginFullTextRun).toHaveBeenCalledWith(expect.objectContaining({ agentId: "claude", requestedModel: "claude-sonnet-4-6", reasoningLevel: "low" }));
});

it("does not declare alignment complete when a provider only inputs links without checking and finishing", async () => {
  const repo = fixture();
  runtime.runAgentRuntime.mockImplementation(async (_a: string, request: AgentRunRequest) => {
    const isAlignment = request.appTool?.env.MUNHAE_TOOL_COMMAND === "submit-alignment";
    expect((await submit(request, isAlignment ? alignment : text)).status).toBe(200);
    return result();
  });
  await startTranslationRun(repo as unknown as ProjectRepo, config, { documentNodeId: "doc", agentId: "codex" }, sessions);
  await done();
  expect(repo.submitAlignment).toHaveBeenCalled();
  expect(repo.finishAlignment).not.toHaveBeenCalled();
  expect(repo.failAlignment).toHaveBeenCalled();
  expect(getTranslationRun("run").detail).toContain("원문 연결은 완료하지 못해");
});

it("reports app-owned alignment failures and successful retries alongside the shell call identity", async () => {
  const repo = fixture();
  repo.submitAlignment.mockImplementationOnce(() => { throw new MunhaeError("invalid_submission", "원문 구간 중복 배정"); });
  runtime.runAgentRuntime.mockImplementation(async (_a, request: AgentRunRequest, sink) => {
    if (request.appTool?.env.MUNHAE_TOOL_COMMAND === "submit-translation") {
      await submit(request, text);
    } else {
      const event = { type: "tool_call", runId: "run", agentId: "codex", at: new Date().toISOString(), name: "command_execution", id: "shell" };
      sink({ ...event, state: "started" });
      expect((await submit(request, alignment)).status).not.toBe(200);
      sink({ ...event, state: "failed" });
      await submit(request, alignment);
      await finish(request);
    }
    return result();
  });
  await startTranslationRun(repo as unknown as ProjectRepo, config, { documentNodeId: "doc", agentId: "codex" }, sessions);
  await done();
  const activity = getTranslationRun("run").activity!;
  expect(activity).toContainEqual(expect.objectContaining({ appTool: true, name: "submit-alignment", state: "failed", parentToolId: "alignment:shell", detail: expect.any(String) }));
  expect(activity).toContainEqual(expect.objectContaining({ appTool: true, name: "submit-alignment", state: "completed" }));
  expect(activity).toContainEqual(expect.objectContaining({ appTool: true, name: "finish-alignment", state: "completed" }));
});
