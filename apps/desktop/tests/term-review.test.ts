import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_APP_CONFIG, type DocumentTerm, type TermBasis } from "../src/shared/munhae-api";
import { TERM_CONFIDENCE, TERM_KINDS, type ProjectRepo } from "@munhae/db-sqlite";
import { MCP_TERM_CONFIDENCE, MCP_TERM_KINDS } from "../src/shared/mcp-tools";
import { TERM_KIND_LABELS } from "../src/renderer/scripts/term-review-model";
const mock = vi.hoisted(() => ({ probe: vi.fn(), run: vi.fn(), cancel: vi.fn(), register: vi.fn(), persist: vi.fn() }));
vi.mock("../src/main/agent-runtime-client", () => ({ probeAgentRuntime: mock.probe, runAgentRuntime: mock.run, cancelAgentRuntime: mock.cancel }));
vi.mock("../src/main/ai-runs", () => ({ registerExternalAiActivity: mock.register, persistAiBeforeLaunch: mock.persist, requestFromPreferences: (runId: string, prompt: string) => ({ runId, prompt }), publicRunError: ({ code }: { code: string }) => ({ code, message: "실행 실패" }) }));
import { latestTermExtraction, numberedSentences, termExtractionPrompt, parseTermCandidates, startTermExtraction, getTermExtraction, cancelTermExtraction } from "../src/main/term-review";

const basis: TermBasis = { documentId: "doc", punctuationVersionId: "p1", versionNo: 2, text: "王建，宮詞。𠮷王建。", sentences: [{ from: 0, to: 6 }, { from: 6, to: 10 }] };
const candidate = { sourceForm: "王建", kind: "person", reading: "왕건", translation: null, definition: "당나라 시인", contextNote: "인물 식별 후보", confidence: "probable", alternatives: ["고려 태조"], evidence: [], sentences: [1], existingTermId: null };
const shared = { id: "t1", sourceForm: "王建", kind: "person" as const, reading: "왕건", translation: "왕건", definition: "고려 태조의 기존 풀이", evidence: [], lockVersion: 1, createdAt: "", updatedAt: "" };
const previous = { id: "l0", documentId: "doc", punctuationVersionId: "p0", term: { ...shared, id: "t0", definition: "이전 표점본의 풀이" }, contextNote: "이전 문맥", confidence: "certain", alternatives: [], origin: "manual", generation: null, occurrences: [], lockVersion: 1, createdAt: "", updatedAt: "" } as DocumentTerm;
let completion: Promise<void>;
beforeEach(() => {
  vi.clearAllMocks();
  mock.probe.mockResolvedValue({ installed: true, loggedIn: true, capabilities: { structuredOutput: true } });
  mock.run.mockResolvedValue({ ok: true, structuredOutput: { terms: [candidate] }, outputText: "" });
  mock.cancel.mockResolvedValue(undefined);
  mock.persist.mockResolvedValue(undefined);
  mock.register.mockImplementation(a => { completion = a.completion; });
});
function repo(input: Partial<ReturnType<ProjectRepo["getTermGenerationInput"]>> = {}, language: "ko" | "en" = "ko") {
  return { projectId: crypto.randomUUID(), getTranslationLanguage: () => language, getEditor: () => ({ document: { title: "관서악부서" } }), getDocumentMetadata: () => ({ title: "관서악부서", parentId: null, periodText: "당" }),
    getTermContext: () => [], getTermReferenceComments: () => [],
    getTermGenerationInput: () => ({ basis, current: [], previous: [], references: [], dismissed: [], ...input }),
    storeTermCandidates: vi.fn((_id, _version, items) => items) } as unknown as ProjectRepo;
}
const promptOf = (call = 0) => mock.run.mock.calls[call]![1].prompt as string;

it("numbers confirmed sentences and keeps extraction instructions distinct from source material", () => {
  expect(numberedSentences(basis)).toBe("[1] 王建，宮詞。\n[2] 𠮷王建。");
  const prompt = termExtractionPrompt({ title: "관서악부서", metadata: [], source: numberedSentences(basis), context: [], referenceComments: [], references: [], existing: [], dismissed: [] });
  expect(prompt).toContain("선정"); expect(prompt).toContain("이체자"); expect(prompt).toContain("확정할 수 없으면"); expect(prompt).toContain("문장 번호");
  expect(prompt).toContain("이번 문서의 정답이 아니다"); expect(prompt).toContain('"existingTermId":null');
});

it("adds English output rules only for an English project and leaves the Korean prompt as it was", () => {
  const input = { title: "t", metadata: [], source: "[1] 借。", context: [], referenceComments: [], references: [], existing: [], dismissed: [] };
  const ko = termExtractionPrompt(input), en = termExtractionPrompt(input, "en");
  expect(termExtractionPrompt(input, "ko")).toBe(ko);
  expect(ko).not.toContain("Output language"); expect(ko).not.toContain("Revised Romanization");
  const koLines = ko.split("\n"), enLines = en.split("\n");
  // The English rules sit after every Korean instruction and before the source material.
  expect(enLines.slice(0, koLines.length - 1)).toEqual(koLines.slice(0, -1));
  expect(enLines.at(-1)).toBe(JSON.stringify(input));
  const rules = enLines.slice(koLines.length - 1, -1).join("\n");
  expect(rules).toContain("Output language: this project is translated into English");
  for (const text of ["Revised Romanization", "借 → cha", "平視陵谷 → pyeongsi neunggok", "Hanyu Pinyin", "without 《 》 or 〈 〉", '"reading":"byeongyeong"']) expect(rules).toContain(text);
});

it("sends the English rules for an English project and stores romanized English candidates", async () => {
  mock.run.mockResolvedValue({ ok: true, structuredOutput: { terms: [{ ...candidate, reading: "wanggeon", translation: "Wang Jian", definition: "Tang dynasty poet known for his palace poems.", contextNote: "Refers to the author of the palace poems.", alternatives: ["Wang Geon, founder of Goryeo"] }] }, outputText: "" });
  const r = repo({}, "en"), start = startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  expect(promptOf()).toContain("Output language: this project is translated into English");
  expect(getTermExtraction(r, start.id)).toMatchObject({ state: "completed", count: 1 });
  expect(r.storeTermCandidates).toHaveBeenCalledWith("doc", "p1", [expect.objectContaining({ reading: "wanggeon", translation: "Wang Jian", alternatives: ["Wang Geon, founder of Goryeo"] })], expect.anything());
  const k = repo(); startTermExtraction(k, DEFAULT_APP_CONFIG, "doc"); await completion;
  expect(promptOf(1)).not.toContain("Output language");
});

it("keeps the MCP list and the screen labels in step with the database's term kinds", () => {
  expect([...MCP_TERM_KINDS]).toEqual([...TERM_KINDS]);
  expect([...MCP_TERM_CONFIDENCE]).toEqual([...TERM_CONFIDENCE]);
  expect(Object.keys(TERM_KIND_LABELS)).toEqual([...TERM_KINDS]);
  const prompt = termExtractionPrompt({ title: "t", metadata: [], source: "[1] 王建。", context: [], referenceComments: [], references: [], existing: [], dismissed: [] });
  for (const kind of TERM_KINDS) expect(prompt).toContain(`${kind}(`);
});

it("turns sentence numbers into exact positions and skips forms missing from the named sentences", () => {
  const parsed = parseTermCandidates({ terms: [
    { ...candidate, sentences: [2, 1] },
    { ...candidate, sourceForm: "宮詞", kind: "work", sentences: [2] },
    { ...candidate, sourceForm: "李白", sentences: [1, 9] },
  ] }, basis, []);
  expect(parsed.items).toEqual([expect.objectContaining({ sourceForm: "王建", suggestedTermId: null, occurrences: [{ from: 0, to: 2 }, { from: 7, to: 9 }] })]);
  expect(parsed.skipped).toEqual(["宮詞", "李白"]);
  expect(() => parseTermCandidates({ terms: [{ ...candidate, kind: "unknown" }] }, basis, [])).toThrow();
});

it("keeps an existing-term link only for a provided reference with the same written form", () => {
  const references = [{ ...shared, origin: "project" as const, documents: ["다른 문서"], contextNote: null, confidence: null, alternatives: [] }];
  const parse = (existingTermId: string, sourceForm = "王建") => parseTermCandidates({ terms: [{ ...candidate, sourceForm, existingTermId, sentences: [1, 2] }] }, basis, references).items[0];
  expect(parse("t1")?.suggestedTermId).toBe("t1");
  expect(parse("invented")?.suggestedTermId).toBeNull();
  expect(parse("t1", "𠮷")?.suggestedTermId).toBeNull();
});

it("persists candidates on the captured punctuation version with provider provenance", async () => {
  const r = repo(); const start = startTermExtraction(r, { ...DEFAULT_APP_CONFIG, agentId: "codex" }, "doc"); await completion;
  expect(getTermExtraction(r, start.id)).toMatchObject({ state: "completed", count: 1, skipped: [] });
  expect(mock.run.mock.calls[0][1]).toMatchObject({ timeoutMs: 0, inactivityTimeoutMs: 0, codexDisableUserContext: true, outputContract: "munhae.term-review.v2" });
  expect(promptOf()).toContain("[2] 𠮷王建。");
  expect(latestTermExtraction(r, "doc")?.id).toBe(start.id);
  expect(latestTermExtraction(repo(), "doc")).toBeNull();
  expect(r.storeTermCandidates).toHaveBeenCalledWith("doc", "p1", [expect.objectContaining({ sourceForm: "王建", occurrences: [{ from: 0, to: 2 }] })], expect.objectContaining({ runId: start.id }));
});

it("reports skipped candidates without failing the run", async () => {
  mock.run.mockResolvedValue({ ok: true, structuredOutput: { terms: [candidate, { ...candidate, sourceForm: "別文" }] }, outputText: "" });
  const r = repo(), start = startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  expect(getTermExtraction(r, start.id)).toMatchObject({ state: "completed", count: 1, skipped: ["別文"] });
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

it("refuses to start without a confirmed punctuation basis", () => {
  const r = repo();
  vi.spyOn(r, "getTermGenerationInput").mockImplementation(() => { throw Object.assign(new Error("확정된 표점본이 있어야 용어를 다룰 수 있습니다."), { code: "not_ready" }); });
  expect(() => startTermExtraction(r, DEFAULT_APP_CONFIG, "doc")).toThrow(/확정된 표점본/);
  expect(mock.register).not.toHaveBeenCalled();
});

it("includes resolved document context and keeps linked comments distinct", async () => {
  const r = repo();
  vi.spyOn(r, "getTermContext").mockReturnValue([{ id: "c1", title: "문헌 배경", scopeId: "book", reason: "ancestor", content: "왕건은 이 글에서 당나라 시인을 가리킨다.\n\n적용 조건·예외: 궁사 문맥에 한함" }]);
  vi.spyOn(r, "getTermReferenceComments").mockReturnValue([{ id: "ref1", title: "과거 질문", content: "원래 구절에 대한 질문" }]);
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  expect(promptOf()).toContain("궁사 문맥에 한함");
  expect(promptOf()).toContain('"context":[{"id":"c1"');
  expect(promptOf()).toContain('"referenceComments":[{"id":"ref1"');
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
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc", ["c1", "document:doc:description"]); await completion;
  expect(promptOf()).toContain("유지할 문맥 본문");
  for (const text of ["제외한 설명 본문", "제외할 문맥 본문"]) expect(promptOf()).not.toContain(text);
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  for (const text of ["제외한 설명 본문", "제외할 문맥 본문"]) expect(promptOf(1)).toContain(text);
});

it("offers previous-version and other-document terms as sense candidates and honors exclusions", async () => {
  const current = { ...previous, id: "l1", punctuationVersionId: "p1", term: { ...shared, id: "t2", definition: "현재 확정 풀이" } } as DocumentTerm;
  const r = repo({ current: [current], previous: [previous], references: [{ ...shared, documents: ["다른 문서"] }, { ...shared, id: "t2", documents: ["중복"] }],
    dismissed: [{ sourceForm: "宮詞", definition: "버린 풀이" } as never] });
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc"); await completion;
  expect(promptOf()).toContain("이전 표점본의 풀이"); expect(promptOf()).toContain("이전 문맥");
  expect(promptOf()).toContain("고려 태조의 기존 풀이"); expect(promptOf()).toContain('"documents":["다른 문서"]');
  expect(promptOf()).toContain("버린 풀이");
  expect(promptOf()).not.toContain('"documents":["중복"]');
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc", [], { enabled: true, excludedIds: ["t1"] }); await completion;
  expect(promptOf(1)).not.toContain("고려 태조의 기존 풀이"); expect(promptOf(1)).toContain("이전 표점본의 풀이");
  startTermExtraction(r, DEFAULT_APP_CONFIG, "doc", [], { enabled: false, excludedIds: [] }); await completion;
  expect(promptOf(2)).not.toContain("이전 표점본의 풀이"); expect(promptOf(2)).toContain('"references":[]');
});
