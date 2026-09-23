import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRepo } from "@munhae/db-sqlite";
import type { AppConfig } from "../src/shared/munhae-api";
const runtime = vi.hoisted(() => ({ probeAgentRuntime: vi.fn(), cancelAgentRuntime: vi.fn(), runAgentRuntime: vi.fn(), resumeAgentRuntime: vi.fn() }));
vi.mock("../src/main/agent-runtime-client", () => runtime);
vi.mock("../src/main/window", () => ({ getMainWindow: () => null }));
vi.mock("../src/main/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@munhae/db-sqlite", () => ({ sanitizeAgentEventForPersistence: vi.fn((event) => event) }));
import { cancelAllAiRuns, getTranslationRun, hasActiveAiRuns, registerAiPersistenceHook, registerExternalAiActivity,
  startLegacyTranslationRun, startTranslationRun, startProjectChatRun, startPunctuationSuggestionRun } from "../src/main/ai-runs";
import { stopAgentToolBridge } from "../src/main/agent-tool-bridge";

const config: AppConfig = { agentId: "codex", showWelcomeOnLaunch: false, agentModels: {
  codex: { model: "default", reasoning: "medium", serviceTier: null },
  claude: { model: "default", reasoning: "medium", serviceTier: null },
  antigravity: { model: "default", reasoning: null, serviceTier: null },
} };
const sessions = { get: () => null, set() {}, clear() {} };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const hooks: Array<() => void> = [];
const directories: string[] = [];
afterEach(async () => {
  while (hooks.length) hooks.pop()!();
  await cancelAllAiRuns();
  await stopAgentToolBridge();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
  vi.clearAllMocks();
});

const launchers = [
  ["legacy translation", (repo: ProjectRepo) => startLegacyTranslationRun(repo, config, { documentNodeId: "doc", agentId: "codex" }, sessions)],
  ["translation", (repo: ProjectRepo) => startTranslationRun(repo, config, { documentNodeId: "doc", agentId: "codex" }, sessions)],
  ["chat", (repo: ProjectRepo) => startProjectChatRun(repo, config, { documentNodeId: "doc", agentId: "codex", scopeKind: "document_node", question: "뜻풀이" }, sessions)],
  ["punctuation", (repo: ProjectRepo) => startPunctuationSuggestionRun(repo, config, { documentNodeId: "doc", agentId: "codex", structureMode: "prose" }, sessions)],
] as const;

it.each(launchers)("reserves %s before probing and cancels preparation before repository writes", async (_name, launch) => {
  const probe = deferred<{ installed: boolean; loggedIn: boolean; version: string }>();
  runtime.probeAgentRuntime.mockImplementation(() => probe.promise);
  const repo = { projectId: "project", beginTranslationRun: vi.fn(), beginFullTextRun: vi.fn(), beginProjectChatRun: vi.fn(), beginPunctuationSuggestionRun: vi.fn() };
  const starting = launch(repo as unknown as ProjectRepo);
  const rejected = expect(starting).rejects.toMatchObject({ code: "canceled" });
  expect(hasActiveAiRuns("project")).toBe(true);
  await expect(launch(repo as unknown as ProjectRepo)).rejects.toMatchObject({ code: "thread_busy" });
  expect(runtime.probeAgentRuntime).toHaveBeenCalledOnce();
  let canceled = false;
  const closing = cancelAllAiRuns().then(() => { canceled = true; });
  await Promise.resolve();
  expect(canceled).toBe(false);
  probe.resolve({ installed: true, loggedIn: true, version: "test" });
  await rejected;
  await closing;
  expect(hasActiveAiRuns("project")).toBe(false);
  for (const method of [repo.beginTranslationRun, repo.beginFullTextRun, repo.beginProjectChatRun, repo.beginPunctuationSuggestionRun]) expect(method).not.toHaveBeenCalled();
  expect(runtime.runAgentRuntime).not.toHaveBeenCalled();
});

it.each(launchers)("does not launch %s when the reserved online row cannot be committed", async (_name, launch) => {
  const prepared = { messageId: "launch-rejected", threadId: "thread", requestText: "test", snapshot: {} };
  const repo = { projectId: "project", beginTranslationRun: vi.fn(() => prepared), beginFullTextRun: vi.fn(() => prepared),
    beginProjectChatRun: vi.fn(() => prepared), beginPunctuationSuggestionRun: vi.fn(() => prepared), failTranslationRun: vi.fn(), failProjectTaskRun: vi.fn() };
  runtime.probeAgentRuntime.mockResolvedValue({ installed: true, loggedIn: true, version: "test" });
  const persist = vi.fn().mockRejectedValueOnce(Object.assign(new Error("online conflict"), { code: "online_workspace_conflict" })).mockResolvedValue(undefined);
  hooks.push(registerAiPersistenceHook(persist, { beforeLaunch: true }));
  await expect(launch(repo as unknown as ProjectRepo)).rejects.toMatchObject({ code: "online_workspace_conflict" });
  expect(persist).toHaveBeenCalledTimes(2); // Reservation, then preserved failed terminal state.
  const failures = [...repo.failTranslationRun.mock.calls, ...repo.failProjectTaskRun.mock.calls];
  expect(failures).toEqual([["launch-rejected", expect.objectContaining({ code: "online_persistence_failed" })]]);
  expect(runtime.runAgentRuntime).not.toHaveBeenCalled(); expect(runtime.resumeAgentRuntime).not.toHaveBeenCalled();
  expect(hasActiveAiRuns()).toBe(false);
});

it("cancels a reserved run while its initial PostgreSQL commit is pending without ever launching the provider", async () => {
  const pending = deferred<void>(), entered = deferred<void>();
  const repo = { projectId: "project", beginFullTextRun: vi.fn(() => ({ messageId: "cancel-pending-save", threadId: "thread", requestText: "test", snapshot: {} })), failTranslationRun: vi.fn() };
  runtime.probeAgentRuntime.mockResolvedValue({ installed: true, loggedIn: true, version: "test" });
  hooks.push(registerAiPersistenceHook(async () => { entered.resolve(); await pending.promise; }, { beforeLaunch: true }));
  const starting = startTranslationRun(repo as unknown as ProjectRepo, config, { documentNodeId: "doc", agentId: "codex" }, sessions);
  const rejected = expect(starting).rejects.toMatchObject({ code: "canceled" });
  await entered.promise; expect(hasActiveAiRuns("project")).toBe(true); expect(runtime.runAgentRuntime).not.toHaveBeenCalled();
  const closing = cancelAllAiRuns(); pending.resolve(); await rejected; await closing;
  expect(repo.failTranslationRun).toHaveBeenCalledWith("cancel-pending-save", expect.objectContaining({ code: "canceled" }));
  expect(runtime.runAgentRuntime).not.toHaveBeenCalled(); expect(hasActiveAiRuns()).toBe(false);
});

it("awaits external AI results and terminal persistence during cancellation", async () => {
  const result = deferred<void>(), persisted = deferred<void>(), entered = deferred<void>();
  const hook = vi.fn(async () => { entered.resolve(); await persisted.promise; });
  hooks.push(registerAiPersistenceHook(hook));
  const cancel = vi.fn(() => { result.resolve(); });
  registerExternalAiActivity({ id: "term-run", projectId: "project", completion: result.promise, cancel });
  let closed = false;
  const closing = cancelAllAiRuns().then(() => { closed = true; });
  await entered.promise;
  expect(cancel).toHaveBeenCalledOnce();
  expect(hook).toHaveBeenCalledWith("project");
  expect(closed).toBe(false);
  expect(() => registerExternalAiActivity({ id: "next", projectId: "project", completion: Promise.resolve(), cancel() {} })).toThrow();
  persisted.resolve();
  await closing;
  expect(hasActiveAiRuns()).toBe(false);
});

it("also waits for a natural completion's outstanding flush and isolates persistence errors", async () => {
  const persisted = deferred<void>(), entered = deferred<void>();
  const afterFailure = vi.fn();
  hooks.push(registerAiPersistenceHook(async () => { entered.resolve(); await persisted.promise; throw new Error("offline"); }));
  hooks.push(registerAiPersistenceHook(afterFailure));
  registerExternalAiActivity({ id: "term-run", projectId: "project", completion: Promise.resolve(), cancel() {} });
  await entered.promise;
  expect(hasActiveAiRuns()).toBe(false);
  let closed = false;
  const closing = cancelAllAiRuns().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  persisted.resolve();
  await closing;
  expect(afterFailure).toHaveBeenCalledWith("project");
});

it("flushes a completed run's terminal ledger and keeps its state when snapshot persistence fails", async () => {
  const packagePath = mkdtempSync(join(tmpdir(), "munhae-ai-lifecycle-"));
  directories.push(packagePath);
  const repo = { projectId: "project", packagePath,
    beginFullTextRun: vi.fn(() => ({ messageId: "terminal-run", threadId: "thread", requestText: "translate", snapshot: {} })),
    failTranslationRun: vi.fn() };
  runtime.probeAgentRuntime.mockResolvedValue({ installed: true, loggedIn: true, version: "test" });
  runtime.runAgentRuntime.mockResolvedValue({ ok: true, outputText: "", usage: {}, model: "test", cliVersion: "test" });
  const completed = deferred<void>();
  let stateAtFlush: string | undefined, ledgerAtFlush = 0;
  const hook = vi.fn(async () => {
    stateAtFlush = getTranslationRun("terminal-run").state;
    ledgerAtFlush = repo.failTranslationRun.mock.calls.length;
    completed.resolve();
    throw new Error("snapshot unavailable");
  });
  hooks.push(registerAiPersistenceHook(hook));
  await startTranslationRun(repo as unknown as ProjectRepo, config, { documentNodeId: "doc", agentId: "codex" }, sessions);
  await completed.promise;
  await cancelAllAiRuns();
  expect(hook).toHaveBeenCalledWith("project");
  expect(hook).toHaveBeenCalledOnce();
  expect(ledgerAtFlush).toBe(1);
  expect(stateAtFlush).toBe("failed");
  expect(getTranslationRun("terminal-run").state).toBe("failed");
});
