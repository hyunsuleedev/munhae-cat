import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProbe, AgentRunRequest, AgentRunResult } from "@munhae/agent-runtime";
import { DEFAULT_APP_CONFIG, type EditorView, type ReadingAnnotationView, type SaveReadingAnnotationInput } from "../src/shared/munhae-api";
import type { ReadingAnalysisInput } from "../src/shared/reading-analysis-types";
import type { DictionarySearchResult } from "../src/shared/dictionary-types";
import type { ReadingToolCommand, ReadingToolReply, createReadingToolGrant } from "../src/main/agent-tool-bridge";
vi.mock("../src/main/agent-runtime-client", () => ({ cancelAgentRuntime: vi.fn(), probeAgentRuntime: vi.fn(), resumeAgentRuntime: vi.fn(), runAgentRuntime: vi.fn() }));
vi.mock("../src/main/window", () => ({ getMainWindow: () => null }));
import { ReadingAnalysisService } from "../src/main/reading-analysis";
import { ReadingAnalysisStore, READING_RUN_LIMIT } from "../src/main/reading-analysis-store";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), "munhae-reading-")); directories.push(path); return path; };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(a => { resolve = a; }); return { promise, resolve }; }
const success = (): AgentRunResult => ({ ok: true, outputText: "This provider prose is never persisted." } as AgentRunResult);
const proposal = (overrides: Record<string, unknown> = {}) => ({ from: 4, to: 6, quote: "太守", reading: "태수", readingOrder: null, senseId: null, explanation: "이 위치의 관직명을 살펴볼 수 있습니다.", caution: "시대별 제도 차이는 별도로 확인하세요.", ...overrides });
const payload = (items = [proposal()]) => ({ summary: "선택한 구절의 관직명을 검토했습니다.", suggestions: items });
type Tool = (command: ReadingToolCommand, value?: unknown) => Promise<ReadingToolReply>;
function fixture(options: { runtime?: (tool: Tool, request: AgentRunRequest) => Promise<AgentRunResult>; persist?: () => Promise<void>; probe?: () => Promise<AgentProbe>; timeoutMs?: number } = {}) {
  const view = { project: { id: "project" }, document: { id: "doc", title: "서문", originalTitle: "序", nodeRole: "source_unit", authorName: "저자", periodText: "조선", dateText: null, language: "zh-Hant", sourceReference: "원서 1권" },
    source: { versionId: "source-v1", versionNo: 1, contentText: "甲太守乙太守丙", state: "draft", lockVersion: 1 }, punctuation: null,
    translation: { versionId: "translation-v1", versionNo: 1, textContent: "첫 태수다. 둘째 태수다.", isCurrentDependencies: true, state: "draft", textLayout: { state: "ready", error: null,
      sentences: [{ id: "T1", from: 0, to: 6, text: "첫 태수다." }, { id: "T2", from: 7, to: 14, text: "둘째 태수다." }],
      links: [{ sentenceId: "T1", spans: [{ from: 1, to: 3, quote: "太守" }], needsReview: false }, { sentenceId: "T2", spans: [{ from: 4, to: 6, quote: "太守" }], needsReview: false }] } },
  } as EditorView;
  const notes: ReadingAnnotationView[] = [];
  const repo = { projectId: "project", packagePath: directory(), getEditor: vi.fn(() => view), listReadingAnnotations: vi.fn(() => structuredClone(notes)),
    saveReadingAnnotation: vi.fn((input: SaveReadingAnnotationInput): ReadingAnnotationView => {
      const existing = input.id ? notes.findIndex(note => note.id === input.id) : -1;
      const { expectedLockVersion, ...data } = input;
      const result: ReadingAnnotationView = { ...data, id: input.id ?? randomUUID(), lockVersion: expectedLockVersion + 1, createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z" };
      if (existing < 0) notes.push(result); else notes[existing] = result;
      return structuredClone(result);
    }) };
  const input: ReadingAnalysisInput = { documentNodeId: "doc", expectedSourceVersionId: "source-v1", expectedTranslationVersionId: "translation-v1", ranges: [{ from: 4, to: 6, quote: "太守" }] };
  const completions: Promise<void>[] = [];
  let tool!: Tool;
  let committed = false;
  const revoked = vi.fn();
  const grant: typeof createReadingToolGrant = vi.fn(async opts => {
    committed = false; revoked.mockClear();
    tool = async (command, value = {}) => {
      if (committed || revoked.mock.calls.length) return { ok: false, error: "revoked" };
      const reply = await opts.onTool(command, JSON.stringify(value));
      if (reply.ok && command === "submit-reading-analysis") committed = true;
      return reply;
    };
    return { runId: opts.runId, projectId: opts.projectId, endpoint: "http://127.0.0.1:1234/reading", token: "fake-reading-token-sensitive-1234567890", expiresAt: "2026-09-23T12:00:00Z",
      inspect: () => ({ callCount: 1, committed, rawBody: null, value: null, error: null }), revoke: revoked };
  });
  const lookup = vi.fn(async (query: string): Promise<DictionarySearchResult> => ({ query, provider: "local", page: 1, total: 1, hasMore: false, notices: [], entries: [{
    id: "wiktionary:taishou", headword: query, reading: "태수", kind: "word", source: "wiktionary", sourceLabel: "위키낱말사전", sourceUrl: "https://ko.wiktionary.org/wiki/太守",
    license: "CC-BY-SA", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", attribution: "사전 기여자", senses: [{ text: "고대 중국의 지방 장관." }], canCite: true,
  }] }));
  const run = vi.fn(async (_agent: string, request: AgentRunRequest) => options.runtime ? options.runtime(tool, request) : (await tool("submit-reading-analysis", payload()), success()));
  const cancel = vi.fn(async () => {});
  const deps = { lookup, grant, run, cancel, persist: vi.fn(options.persist ?? (async () => {})), probe: vi.fn(options.probe ?? (async () => ({ agentId: "codex", installed: true, loggedIn: true, version: "test", capabilities: {} } as AgentProbe))),
    register: (activity: { completion: Promise<void> }) => { completions.push(activity.completion); }, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
  const service = new ReadingAnalysisService(deps);
  return { view, notes, repo, input, deps, service, run, cancel, lookup, revoked, completions,
    finish: async () => { await Promise.all(completions); }, tool: (...args: Parameters<Tool>) => tool(...args),
    start: () => service.start(repo, DEFAULT_APP_CONFIG, input), restore: () => new ReadingAnalysisService(deps),
  };
}
function existingNote(overrides: Partial<ReadingAnnotationView> = {}): ReadingAnnotationView {
  return { id: "note1", documentNodeId: "doc", sourceVersionId: "source-v1", codepointFrom: 4, codepointTo: 6, quote: "太守", reading: "태수", gloss: "기존 수동 메모", readingOrder: 3,
    citation: null, lockVersion: 4, createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z", ...overrides };
}

describe("explicit reading analysis tools and proposals", () => {
  it("never starts when opening history, supplies exact occurrences, and saves only explicitly adopted proposals", async () => {
    let context: Record<string, unknown> | undefined;
    const f = fixture({ runtime: async (tool, request) => {
      expect(request.appTool?.args.at(-1)).toBe("get-reading-context");
      expect(request.appTool?.env.MUNHAE_TOOL_COMMAND).toBe("reading-analysis");
      context = await tool("get-reading-context");
      expect(await tool("submit-reading-analysis", payload())).toMatchObject({ ok: true, accepted: 1 });
      return success();
    } });
    expect(f.service.latest(f.repo, f.input)).toBeNull(); expect(f.run).not.toHaveBeenCalled();
    const initial = f.start(); expect(initial.state).toBe("running"); await f.finish();
    expect(context).toMatchObject({ coordinateSystem: "unicode-codepoints", translationContext: "둘째 태수다.",
      occurrences: [{ id: "source-v1:4:5", from: 4, to: 5, quote: "太" }, { id: "source-v1:5:6", from: 5, to: 6, quote: "守" }] });
    const result = f.service.get(f.repo, initial.id); expect(result.state).toBe("completed");
    expect(f.repo.saveReadingAnnotation).not.toHaveBeenCalled();
    const saved = f.service.apply(f.repo, { runId: initial.id, suggestionId: result.result!.suggestions[0]!.id });
    expect(saved).toMatchObject({ codepointFrom: 4, codepointTo: 6, reading: "태수", gloss: "이 위치의 관직명을 살펴볼 수 있습니다.", citation: null });
    expect(f.service.get(f.repo, initial.id).result!.suggestions[0]!.applied).toBe(true);
    expect(() => f.service.apply(f.repo, { runId: initial.id, suggestionId: result.result!.suggestions[0]!.id })).toThrow();
    const persisted = readFileSync(join(f.repo.packagePath, "runs/reading-study", `${initial.id}.json`), "utf8");
    expect(persisted).not.toContain("fake-reading-token"); expect(persisted).not.toContain("provider prose"); expect(persisted).not.toContain("MUNHAE_TOOL_GRANT");
    expect(statSync(join(f.repo.packagePath, "runs/reading-study", `${initial.id}.json`)).mode & 0o777).toBe(0o600);
  });
  it("issues opaque senses only for exact local headwords and resolves provenance on adoption", async () => {
    const f = fixture({ runtime: async tool => {
      expect(await tool("lookup-reading-dictionary", { query: "甲" })).toMatchObject({ ok: false, error: "out_of_scope" });
      const dictionary = await tool("lookup-reading-dictionary", { query: "太守" });
      const sense = (dictionary.entries as { senses: { senseId: string }[] }[])[0]!.senses[0]!.senseId;
      expect(sense).not.toBe("wiktionary:taishou");
      expect(await tool("submit-reading-analysis", payload([proposal({ senseId: sense })]))).toMatchObject({ ok: true });
      return success();
    } });
    const run = f.start(); await f.finish();
    const suggestion = f.service.get(f.repo, run.id).result!.suggestions[0]!;
    expect(suggestion.citation).toMatchObject({ sense: "고대 중국의 지방 장관.", headword: "太守", attribution: "사전 기여자" });
    const saved = f.service.apply(f.repo, { runId: run.id, suggestionId: suggestion.id });
    expect(saved.citation).toEqual(suggestion.citation); expect(saved.gloss).toBe("이 위치의 관직명을 살펴볼 수 있습니다.");
  });
  it.each([
    { name: "forged sense", items: [proposal({ senseId: "forged" })] },
    { name: "first repeated occurrence", items: [proposal({ from: 1, to: 3 })] },
    { name: "wrong quote", items: [proposal({ quote: "太師" })] },
    { name: "duplicate range", items: [proposal(), proposal()] },
    { name: "invented citation field", items: [proposal({ citation: { sense: "fake" } })] },
    { name: "unusable explanation only", items: [proposal({ reading: "" })] },
    { name: "token echo", items: [proposal({ explanation: "fake-reading-token-sensitive-1234567890" })] },
    { name: "translation quote outside the provided translation", items: [proposal({ translationQuote: "없는 번역 구절" })] },
    { name: "blank translation quote", items: [proposal({ translationQuote: "  " })] },
  ])("rejects $name without writing annotation or accepting provider prose", async ({ items }) => {
    const f = fixture({ runtime: async tool => { expect((await tool("submit-reading-analysis", payload(items))).ok).toBe(false); return success(); } });
    const run = f.start(); await f.finish();
    expect(f.service.get(f.repo, run.id)).toMatchObject({ state: "failed", result: null, error: { code: "app_submission_missing" } });
    expect(f.repo.saveReadingAnnotation).not.toHaveBeenCalled();
  });
  it("keeps a verbatim translation link from the provided translation and stores it on adoption", async () => {
    const f = fixture({ runtime: async tool => {
      expect(await tool("submit-reading-analysis", payload([proposal({ translationQuote: " 둘째 태수" })]))).toMatchObject({ ok: true });
      return success();
    } });
    const run = f.start(); await f.finish();
    const suggestion = f.service.get(f.repo, run.id).result!.suggestions[0]!;
    expect(suggestion.translationQuote).toBe("둘째 태수");
    const saved = f.service.apply(f.repo, { runId: run.id, suggestionId: suggestion.id });
    expect(saved.translationQuote).toBe("둘째 태수");
    expect(f.repo.saveReadingAnnotation).toHaveBeenCalledWith(expect.objectContaining({ translationQuote: "둘째 태수" }));
  });

  it("does not cite a constituent sense for a multi-character word", async () => {
    const f = fixture({ runtime: async tool => {
      const dictionary = await tool("lookup-reading-dictionary", { query: "太" });
      const sense = (dictionary.entries as { senses: { senseId: string }[] }[])[0]!.senses[0]!.senseId;
      expect(await tool("submit-reading-analysis", payload([proposal({ senseId: sense })]))).toMatchObject({ ok: false, error: "invalid_analysis" });
      return success();
    } });
    f.start(); await f.finish(); expect(f.repo.saveReadingAnnotation).not.toHaveBeenCalled();
  });
  it("keeps IVS graphemes intact and disallows proposals bridging discontiguous ranges", async () => {
    const f = fixture({ runtime: async tool => {
      const context = await tool("get-reading-context");
      expect(context.occurrences).toMatchObject([{ from: 0, to: 2, quote: "禰󠄀" }, { from: 3, to: 4, quote: "乙" }]);
      expect(await tool("lookup-reading-dictionary", { query: "禰" })).toMatchObject({ ok: false });
      expect(await tool("submit-reading-analysis", payload([proposal({ from: 0, to: 1, quote: "禰" })]))).toMatchObject({ ok: false });
      expect(await tool("submit-reading-analysis", payload([proposal({ from: 0, to: 4, quote: "禰󠄀甲乙" })]))).toMatchObject({ ok: false });
      expect(await tool("submit-reading-analysis", payload([proposal({ from: 0, to: 2, quote: "禰󠄀", reading: "니" })]))).toMatchObject({ ok: true });
      return success();
    } });
    f.view.source.contentText = "禰󠄀甲乙"; f.input.ranges = [{ from: 0, to: 2, quote: "禰󠄀" }, { from: 3, to: 4, quote: "乙" }];
    const run = f.start(); await f.finish(); expect(f.service.get(f.repo, run.id).state).toBe("completed");
    expect(() => f.service.start(f.repo, DEFAULT_APP_CONFIG, { ...f.input, ranges: [{ from: 0, to: 1, quote: "禰" }] })).toThrow();
  });
  it.each(["edit", "archive", "recreate", "new"])("rejects annotation %s since the analysis snapshot", async mutation => {
    const f = fixture(); if (mutation !== "new") f.notes.push(existingNote());
    const run = f.start(); await f.finish(); const suggestion = f.service.get(f.repo, run.id).result!.suggestions[0]!;
    if (mutation === "edit") f.notes[0]!.lockVersion++;
    if (mutation === "archive") f.notes.length = 0;
    if (mutation === "recreate") f.notes[0]!.id = "new-id";
    if (mutation === "new") f.notes.push(existingNote());
    expect(() => f.service.apply(f.repo, { runId: run.id, suggestionId: suggestion.id })).toThrow(/연구 기록이 바뀌/);
    expect(f.repo.saveReadingAnnotation).not.toHaveBeenCalled();
  });
  it("adopts only the reading order of an existing record, leaves the proposal open, and keeps later adoption in sync", async () => {
    const f = fixture({ runtime: async tool => { await tool("submit-reading-analysis", payload([proposal({ readingOrder: 2, senseId: null })])); return success(); } });
    f.notes.push(existingNote({ citation: { source: "manual", sourceLabel: "수동 출처", entryId: "old", headword: "太守", reading: null, sense: "기존 선택 뜻", sourceUrl: "https://example.test", license: "test", licenseUrl: null, attribution: "test" }, translationQuote: "태수" }));
    const run = f.start(); await f.finish(); const suggestion = f.service.get(f.repo, run.id).result!.suggestions[0]!;
    const ordered = f.service.apply(f.repo, { runId: run.id, suggestionId: suggestion.id, orderOnly: true });
    expect(ordered).toMatchObject({ id: "note1", lockVersion: 5, readingOrder: 2, reading: "태수", gloss: "기존 수동 메모", citation: { sense: "기존 선택 뜻" }, translationQuote: "태수" });
    expect(f.service.get(f.repo, run.id).result!.suggestions[0]!.applied).toBe(false);
    const adopted = f.service.apply(f.repo, { runId: run.id, suggestionId: suggestion.id });
    expect(adopted).toMatchObject({ id: "note1", lockVersion: 6, reading: "태수", readingOrder: 2 });
    expect(f.repo.saveReadingAnnotation.mock.calls[1]![0].expectedLockVersion).toBe(5);
    expect(f.service.get(f.repo, run.id).result!.suggestions[0]!.applied).toBe(true);
    expect(() => f.service.apply(f.repo, { runId: run.id, suggestionId: suggestion.id, orderOnly: "yes" as unknown as boolean })).toThrow();
  });

  it("keeps unique single-character reading orders and drops them all when numbers repeat", async () => {
    const items = (a: number, b: number) => [proposal({ from: 4, to: 5, quote: "太", reading: "태", readingOrder: a }), proposal({ from: 5, to: 6, quote: "守", reading: "수", readingOrder: b })];
    const unique = fixture({ runtime: async tool => { await tool("submit-reading-analysis", payload(items(2, 1))); return success(); } });
    let run = unique.start(); await unique.finish();
    expect(unique.service.get(unique.repo, run.id).result!.suggestions.map(item => item.readingOrder)).toEqual([2, 1]);
    const repeated = fixture({ runtime: async tool => { expect(await tool("submit-reading-analysis", payload(items(1, 1)))).toMatchObject({ ok: true }); return success(); } });
    run = repeated.start(); await repeated.finish();
    expect(repeated.service.get(repeated.repo, run.id).state).toBe("completed");
    expect(repeated.service.get(repeated.repo, run.id).result!.suggestions.map(item => item.readingOrder)).toEqual([null, null]);
  });

  it("preserves manual gloss and citation when adopting a reading-only proposal", async () => {
    const f = fixture(); f.notes.push(existingNote({ citation: { source: "manual", sourceLabel: "수동 출처", entryId: "old", headword: "太守", reading: null, sense: "기존 선택 뜻", sourceUrl: "https://example.test", license: "test", licenseUrl: null, attribution: "test" } }));
    const run = f.start(); await f.finish(); const suggestion = f.service.get(f.repo, run.id).result!.suggestions[0]!;
    const saved = f.service.apply(f.repo, { runId: run.id, suggestionId: suggestion.id });
    expect(saved).toMatchObject({ id: "note1", lockVersion: 5, gloss: "기존 수동 메모", citation: { sense: "기존 선택 뜻" } });
    expect(f.repo.saveReadingAnnotation.mock.calls[0]![0].expectedLockVersion).toBe(4);
  });
  it.each(["source", "punctuation", "translation", "alignment"])("marks completed %s dependency changes stale without relocating proposals", async kind => {
    const f = fixture(); const run = f.start(); await f.finish(); const suggestion = f.service.get(f.repo, run.id).result!.suggestions[0]!;
    if (kind === "source") f.view.source.contentText = "甲太守丙太守丙";
    if (kind === "punctuation") f.view.punctuation = { versionId: "punct-v2" } as EditorView["punctuation"];
    if (kind === "translation") f.view.translation!.textContent += "changed";
    if (kind === "alignment") f.view.translation!.textLayout!.links[1]!.needsReview = true;
    expect(f.service.get(f.repo, run.id).state).toBe("stale");
    expect(() => f.service.apply(f.repo, { runId: run.id, suggestionId: suggestion.id })).toThrow(); expect(f.repo.saveReadingAnnotation).not.toHaveBeenCalled();
  });
  it("validates freshness again after asynchronous dictionary lookup and before accepting result", async () => {
    const pending = deferred<DictionarySearchResult>();
    const f = fixture({ runtime: async tool => { await expect(tool("lookup-reading-dictionary", { query: "太守" })).rejects.toMatchObject({ code: "stale_request" }); return success(); } });
    f.lookup.mockImplementation(() => pending.promise);
    const run = f.start(); await vi.waitFor(() => expect(f.lookup).toHaveBeenCalled());
    f.view.source.contentText += "丁"; pending.resolve({ entries: [], notices: [] } as unknown as DictionarySearchResult);
    await f.finish(); expect(f.service.get(f.repo, run.id).state).toBe("stale");
  });
  it("discards a submitted proposal when source changes before provider completion", async () => {
    const pending = deferred<AgentRunResult>();
    let submitted = false;
    const f = fixture({ runtime: async tool => {
      expect(await tool("submit-reading-analysis", payload())).toMatchObject({ ok: true }); submitted = true;
      return pending.promise;
    } });
    const run = f.start(); await vi.waitFor(() => expect(submitted).toBe(true));
    f.view.source.versionId = "source-v2"; pending.resolve(success()); await f.finish();
    expect(f.service.get(f.repo, run.id)).toMatchObject({ state: "stale", result: null });
    expect(f.repo.saveReadingAnnotation).not.toHaveBeenCalled();
  });
  it.each(["needs_review", "invalid_quote", "old_dependencies"])("omits unverified linked translation context: %s", async kind => {
    const f = fixture({ runtime: async tool => {
      expect(await tool("get-reading-context")).toMatchObject({ translationContext: "" });
      await tool("submit-reading-analysis", payload([])); return success();
    } });
    if (kind === "needs_review") f.view.translation!.textLayout!.state = "needs_review";
    if (kind === "invalid_quote") f.view.translation!.textLayout!.links[1]!.spans[0]!.quote = "太師";
    if (kind === "old_dependencies") f.view.translation!.isCurrentDependencies = false;
    const run = f.start(); await f.finish(); expect(f.service.get(f.repo, run.id)).toMatchObject({ state: "completed", result: { suggestions: [] } });
  });
  it("cancels explicitly, revokes the tool grant and waits for runtime completion", async () => {
    const pending = deferred<AgentRunResult>();
    const f = fixture({ runtime: async () => pending.promise }); const run = f.start();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    expect(f.service.cancel(f.repo, run.id).state).toBe("canceled");
    expect(f.revoked).toHaveBeenCalled(); expect(f.cancel).toHaveBeenCalledWith(run.id);
    expect(await f.tool("submit-reading-analysis", payload())).toMatchObject({ ok: false });
    pending.resolve(success()); await f.finish(); expect(f.service.get(f.repo, run.id).result).toBeNull();
  });
  it("does not launch runtime when online persistence fails", async () => {
    const f = fixture({ persist: async () => { throw { code: "online_workspace_request_failed" }; } }); const run = f.start(); await f.finish();
    expect(f.run).not.toHaveBeenCalled(); expect(f.service.get(f.repo, run.id).state).toBe("failed");
  });
  it("restores recent history and adoption state without launching AI, and isolates projects/documents", async () => {
    const f = fixture(); const run = f.start(); await f.finish(); const suggestion = f.service.get(f.repo, run.id).result!.suggestions[0]!;
    const restored = f.restore(); expect(restored.latest(f.repo, f.input)?.id).toBe(run.id); expect(f.run).toHaveBeenCalledTimes(1);
    restored.apply(f.repo, { runId: run.id, suggestionId: suggestion.id });
    expect(f.restore().get(f.repo, run.id).result!.suggestions[0]!.applied).toBe(true);
    expect(() => restored.get({ ...f.repo, projectId: "another" }, run.id)).toThrow();
    expect(() => restored.get({ ...f.repo, packagePath: directory() }, run.id)).toThrow();
    expect(restored.latest({ ...f.repo, getEditor: () => ({ ...f.view, document: { ...f.view.document, id: "other" } }) }, { ...f.input, documentNodeId: "other" })).toBeNull();
  });
  it("restores an interrupted request as canceled without auto-restarting it", async () => {
    const pending = deferred<AgentProbe>(); const f = fixture({ probe: () => pending.promise }); const run = f.start();
    expect(f.restore().get(f.repo, run.id)).toMatchObject({ state: "canceled", error: { code: "interrupted" } });
    expect(f.run).not.toHaveBeenCalled(); f.service.cancel(f.repo, run.id); pending.resolve({ installed: true, loggedIn: true } as AgentProbe); await f.finish();
  });
  it("rejects unsafe history IDs and invalid persisted shapes without scanning arbitrary files", async () => {
    const f = fixture(); const run = f.start(); await f.finish();
    expect(() => f.restore().get(f.repo, "../../secret")).toThrow();
    const path = join(f.repo.packagePath, "runs/reading-study", `${run.id}.json`);
    const stored = JSON.parse(readFileSync(path, "utf8")); stored.view.result.suggestions[0].from = 1;
    writeFileSync(path, JSON.stringify(stored)); expect(() => f.restore().get(f.repo, run.id)).toThrow();
    writeFileSync(join(f.repo.packagePath, "runs/reading-study/index.json"), JSON.stringify(["../../secret"]));
    expect(() => f.restore().latest(f.repo, f.input)).toThrow();
  });
  it("bounds the persistent history and keeps request order when updating an older run", () => {
    const packagePath = directory(); const store = new ReadingAnalysisStore(packagePath); const ids = Array.from({ length: READING_RUN_LIMIT + 3 }, () => randomUUID());
    for (const id of ids) store.save(id, { id });
    expect(store.ids()).toHaveLength(READING_RUN_LIMIT); expect(store.load(ids[0]!)).toBeNull();
    store.save(ids[3]!, { changed: true }); expect(store.ids()[0]).toBe(ids.at(-1));
    expect(readdirSync(join(packagePath, "runs/reading-study"))).toHaveLength(READING_RUN_LIMIT + 1);
  });
  it("rehydrates each unit after A to B to A navigation without another provider request", async () => {
    const f = fixture({ runtime: async tool => {
      const context = await tool("get-reading-context");
      const range = (context.ranges as ReadingAnalysisInput["ranges"])[0]!;
      expect(await tool("submit-reading-analysis", payload([proposal(range)]))).toMatchObject({ ok: true });
      return success();
    } });
    const a = f.start(); await f.finish();
    const bInput = { ...f.input, ranges: [{ from: 1, to: 3, quote: "太守" }] };
    const b = f.service.start(f.repo, DEFAULT_APP_CONFIG, bInput); await f.finish();
    const restored = f.restore();
    expect(restored.latest(f.repo, bInput)?.id).toBe(b.id);
    expect(restored.latest(f.repo, f.input)?.id).toBe(a.id);
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it("rejects a symlinked runs directory before creating files outside the project", () => {
    const packagePath = directory(), outside = directory();
    symlinkSync(outside, join(packagePath, "runs"));
    expect(() => new ReadingAnalysisStore(packagePath).save(randomUUID(), {})).toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });
});
