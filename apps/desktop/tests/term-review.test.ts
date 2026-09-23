import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_APP_CONFIG } from "../src/shared/munhae-api";
import type { ProjectRepo } from "@munhae/db-sqlite";
const mock = vi.hoisted(() => ({ probe: vi.fn(), run: vi.fn(), cancel: vi.fn(), register: vi.fn(), persist: vi.fn() }));
vi.mock("../src/main/agent-runtime-client", () => ({ probeAgentRuntime: mock.probe, runAgentRuntime: mock.run, cancelAgentRuntime: mock.cancel }));
vi.mock("../src/main/ai-runs", () => ({ registerExternalAiActivity: mock.register, persistAiBeforeLaunch: mock.persist, requestFromPreferences: (runId: string, prompt: string) => ({ runId, prompt }), publicRunError: ({ code }: { code: string }) => ({ code, message: "실행 실패" }) }));
import { latestTermExtraction, termExtractionPrompt, parseTermCandidates, startTermExtraction, getTermExtraction, cancelTermExtraction } from "../src/main/term-review";
const candidate = { sourceForm: "王建", kind: "person", reading: "왕건", translation: null, definition: null, contextNote: "인물 식별 후보", selectionReason: "동명이인", uncertainty: "출전 확인", evidence: [], quotes: ["王建宮詞"] };
let completion: Promise<void>;
beforeEach(() => {
  vi.clearAllMocks();
  mock.probe.mockResolvedValue({ installed: true, loggedIn: true, capabilities: { structuredOutput: true } });
  mock.run.mockResolvedValue({ ok: true, structuredOutput: { terms: [candidate] }, outputText: "" });
  mock.cancel.mockResolvedValue(undefined);
  mock.persist.mockResolvedValue(undefined);
  mock.register.mockImplementation(a => { completion = a.completion; });
});
function repo() {
  return { projectId: crypto.randomUUID(), getEditor: () => ({ document: { title: "관서악부서" }, source: { contentText: "王建宮詞", versionId: "v1", lockVersion: 2 }, punctuation: null }), getDocumentMetadata: () => ({ title: "관서악부서", parentId: null }), getKnowledge: () => ({ glossary: [] }), getTerms: () => [], getTermContext: () => [], getTermReferenceComments: () => [], storeTermCandidates: vi.fn((_id, _version, candidates) => candidates) } as unknown as ProjectRepo;
}
it("validates literal occurrences and keeps extraction instructions distinct from source material", () => {
  expect(parseTermCandidates({ terms: [candidate] }, "王建宮詞")).toHaveLength(1);
  expect(() => parseTermCandidates({ terms: [{ ...candidate, sourceForm: "王..." }] }, "王建宮詞")).toThrow();
  expect(() => parseTermCandidates({ terms: [{ ...candidate, quotes: ["虛構"] }] }, "王建宮詞")).toThrow();
  const prompt = termExtractionPrompt({ title: "관서악부서", metadata: [], source: "王建宮詞", sourceKind: "source", context: [], referenceComments: [], glossary: [] });
  expect(prompt).toContain("선정"); expect(prompt).toContain("이체자"); expect(prompt).toContain("확정할 수 없으면"); expect(prompt).toContain("관서악부서");
});
it("persists validated output with the captured source revision and provider provenance", async () => {
  const r = repo(); const start = startTermExtraction(r, { ...DEFAULT_APP_CONFIG, agentId: "codex" }, "doc"); await completion;
  expect(getTermExtraction(r, start.id)).toMatchObject({ state: "completed", count: 1 });
  expect(mock.run.mock.calls[0][1]).toMatchObject({ timeoutMs: 0, inactivityTimeoutMs: 0, codexDisableUserContext: true });
  expect(latestTermExtraction(r, "doc")?.id).toBe(start.id);
  expect(latestTermExtraction(repo(), "doc")).toBeNull();
  expect(r.storeTermCandidates).toHaveBeenCalledWith("doc", "v1:2", [candidate], expect.objectContaining({ runId: start.id }));
});

it("fails before invoking the provider when the online input cannot be saved", async () => {
  mock.persist.mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: "online_workspace_conflict" }));
  const r = repo(), run = startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  expect(mock.persist).toHaveBeenCalledWith(r.projectId); expect(mock.run).not.toHaveBeenCalled();
  expect(r.storeTermCandidates).not.toHaveBeenCalled(); expect(getTermExtraction(r, run.id).state).toBe("failed");
});
it("ignores canceled late results and keeps lifecycle ownership until the provider settles", async () => {
  let release!: (value: unknown) => void;
  mock.run.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const r = repo(); const start = startTermExtraction(r, DEFAULT_APP_CONFIG, "doc");
  await vi.waitFor(() => expect(mock.run).toHaveBeenCalled());
  await cancelTermExtraction(r, start.id);
  release({ ok: true, structuredOutput: { terms: [candidate] }, outputText: "" }); await completion;
  expect(getTermExtraction(r, start.id).state).toBe("canceled"); expect(r.storeTermCandidates).not.toHaveBeenCalled();
});
it("does not poison the document after activity registration rejects a busy project", async () => {
  const r = repo(); mock.register.mockImplementationOnce(() => { throw new Error("busy"); });
  expect(() => startTermExtraction(r, DEFAULT_APP_CONFIG, "doc")).toThrow("busy");
  const next = startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  expect(getTermExtraction(r, next.id).state).toBe("completed");
});
it("rejects unsupported source quotations without saving any entries", async () => {
  const r = repo(); mock.run.mockResolvedValue({ ok: true, structuredOutput: { terms: [{ ...candidate, quotes: ["別文"] }] }, outputText: "" });
  const start = startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  expect(getTermExtraction(r, start.id).state).toBe("failed"); expect(r.storeTermCandidates).not.toHaveBeenCalled();
});

it("uses punctuation as the extraction and quotation basis when available", async () => {
  const r = repo(); const editor = r.getEditor("doc");
  vi.spyOn(r, "getEditor").mockReturnValue({ ...editor, punctuation: { versionId: "p1", lockVersion: 3, state: "draft", punctuatedText: "王建，宮詞。" } } as ReturnType<ProjectRepo["getEditor"]>);
  const term = { ...candidate, quotes: ["王建，宮詞。"] };
  mock.run.mockResolvedValue({ ok: true, structuredOutput: { terms: [term] }, outputText: "" });
  const start = startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  expect(getTermExtraction(r, start.id).state).toBe("completed");
  expect(mock.run.mock.calls[0][1].prompt).toContain('"source":"王建，宮詞。"');
  expect(r.storeTermCandidates).toHaveBeenCalledWith("doc", "v1:2:punctuation:p1:3", [term], expect.anything());
});

it("includes resolved document context in the provider request", async () => {
  const r = repo();
  vi.spyOn(r, "getTermContext").mockReturnValue([{ id: "c1", title: "문헌 배경", scopeId: "book", reason: "ancestor", content: "왕건은 이 글에서 당나라 시인을 가리킨다.\n\n적용 조건·예외: 궁사 문맥에 한함" }]);
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  const prompt = mock.run.mock.calls[0][1].prompt;
  expect(prompt).toContain("왕건은 이 글에서 당나라 시인");
  expect(prompt).toContain("궁사 문맥에 한함");
  expect(prompt).toContain('"context":[{"id":"c1"');
});

it("keeps linked comments distinct from document context in extraction input", async () => {
  const r=repo();
  vi.spyOn(r,"getTermReferenceComments").mockReturnValue([{id:"ref1",title:"과거 질문",content:"원래 구절에 대한 질문"}]);
  startTermExtraction(r,DEFAULT_APP_CONFIG,"doc"); await completion;
  const prompt=mock.run.mock.calls[0][1].prompt;
  expect(prompt).toContain('"referenceComments":[{"id":"ref1"');
  expect(prompt).toContain('"context":[]');
});

it("excludes selected materials from the provider prompt without changing future defaults", async () => {
  const r = repo();
  const metadata = r.getDocumentMetadata("doc");
  vi.spyOn(r, "getDocumentMetadata").mockReturnValue({ ...metadata, descriptionMd: "제외한 설명 본문" });
  vi.spyOn(r, "getTermContext").mockReturnValue([
    { id: "document:doc:description", title: "문서 설명", scopeId: "doc", reason: "current", content: "제외한 설명 본문" },
    { id: "c1", title: "제외할 자료", scopeId: "doc", reason: "current", content: "제외할 문맥 본문" },
    { id: "c2", title: "유지할 자료", scopeId: "doc", reason: "current", content: "유지할 문맥 본문" },
  ]);
  vi.spyOn(r, "getTermReferenceComments").mockReturnValue([{ id: "r1", title: "제외할 코멘트", content: "제외할 코멘트 본문" }]);
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc", ["c1", "r1", "document:doc:description"]); await completion;
  const prompt = mock.run.mock.calls[0][1].prompt;
  expect(prompt).toContain("유지할 문맥 본문");
  for (const text of ["제외한 설명 본문", "제외할 문맥 본문", "제외할 코멘트 본문"]) expect(prompt).not.toContain(text);
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  const next = mock.run.mock.calls[1][1].prompt;
  for (const text of ["제외한 설명 본문", "제외할 문맥 본문", "제외할 코멘트 본문"]) expect(next).toContain(text);
});

it("uses related common entries as sense candidates and honors global and item exclusions across both stores", async () => {
  const r = repo();
  const legacy = { id: "old", sourceTerm: "王建", targetTerm: "고려 태조", reading: "왕건", noteMd: "고려 인물의 기존 풀이", usageStatus: "preferred" as const, contentHash: "hash", lockVersion: 1, targetLocale: "ko", termKind: "person" };
  vi.spyOn(r, "getKnowledge").mockReturnValue({ glossary: [legacy, { ...legacy, id: "unrelated", sourceTerm: "李白", noteMd: "관계없는 옛 항목" }], contextItems: [], uncertainties: [] });
  const common = { ...candidate, id: "new", documentId: null, status: "reviewed", definition: "새 공통 풀이", projectId: r.projectId } as unknown as ReturnType<ProjectRepo["getTerms"]>[number];
  vi.spyOn(r, "getTerms").mockReturnValue([common, { ...common, id: "unrelated-new", sourceForm: "李白", definition: "관계없는 새 항목" }, { ...common, id: "excluded", status: "excluded", definition: "사용 제외된 항목" }, { ...common, id: "local", documentId: "doc", definition: "이 문서의 풀이" }]);
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  const first = mock.run.mock.calls[0][1].prompt;
  expect(first).toContain("고려 인물의 기존 풀이"); expect(first).toContain("새 공통 풀이");
  expect(first).toContain("이번 문서의 정답이 아니다");
  for (const text of ["관계없는 옛 항목", "관계없는 새 항목", "사용 제외된 항목"]) expect(first).not.toContain(text);
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc", [], { enabled: true, excludedIds: ["glossary:old"] }); await completion;
  const second = mock.run.mock.calls[1][1].prompt;
  expect(second).not.toContain("고려 인물의 기존 풀이"); expect(second).toContain("새 공통 풀이");
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc", [], { enabled: false, excludedIds: [] }); await completion;
  const third = mock.run.mock.calls[2][1].prompt;
  expect(third).not.toContain("고려 인물의 기존 풀이"); expect(third).not.toContain("새 공통 풀이"); expect(third).toContain("이 문서의 풀이");
  expect(r.storeTermCandidates).toHaveBeenLastCalledWith("doc", expect.any(String), [candidate], expect.anything());
});

// Regression: the live CCTI comparison failed when the model mixed a valid
// occurrence with a related sentence that does not contain the headword.
it("keeps literal occurrences while discarding unrelated or fabricated extra quotes", async () => {
  const r = repo();
  const mixed = { ...candidate, quotes: ["王建宮詞", "百有加八", "王建作詩", "王建宮詞"] };
  mock.run.mockResolvedValue({ ok: true, structuredOutput: { terms: [mixed] }, outputText: "" });
  const start = startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  expect(getTermExtraction(r, start.id)).toMatchObject({ state: "completed", count: 1 });
  expect(r.storeTermCandidates).toHaveBeenCalledWith("doc", "v1:2", [candidate], expect.anything());
});
it("does not invent occurrences or normalize distinct glyphs to rescue an invalid candidate", () => {
  expect(() => parseTermCandidates({ terms: [{ ...candidate, quotes: ["王建作詩"] }] }, "王建宮詞")).toThrow("王建");
  expect(() => parseTermCandidates({ terms: [{ ...candidate, sourceForm: "諡", quotes: ["謚"] }] }, "謚")).toThrow("諡");
  expect(() => parseTermCandidates({ terms: [candidate, { ...candidate, sourceForm: "李白" }] }, "王建宮詞")).toThrow("李白");
});
