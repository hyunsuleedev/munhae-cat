import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentAdapter, redactSecrets, type AgentParsedEvent, type AgentRunEvent } from "../src/index";
import { acquireAntigravityModelLock, antigravityLogFailure, createAntigravityParser, parseAntigravityModels, writeAntigravityModelSelection } from "../src/antigravity";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "munhae-agy-test-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function fake(behavior = "success", legacy = false, outputEnvelope?: Record<string, unknown>) {
  const binary = join(dir, "agy");
  await writeFile(binary, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.1.27'); process.exit(0); }
if (args[0] === '--help') { console.log('--print -p --print-timeout --log-file --dangerously-skip-permissions ${legacy ? '' : '--model --effort --output-format --json-schema'}'); process.exit(0); }
if (args[0] === 'models') { ${legacy ? "process.exit(1);" : "console.log('Fetching available models...\\ngemini-test\\tGemini Test'); process.exit(0);"} }
writeFileSync(${JSON.stringify(join(dir, 'call.json'))}, JSON.stringify({args, cwd:process.cwd(), model:${legacy ? "JSON.parse(readFileSync(join(process.env.HOME, '.gemini/antigravity-cli/settings.json'), 'utf8')).model" : "null"}}));
if (args.includes('--json-schema') && !['json', 'stream-json'].includes(args[args.indexOf('--output-format') + 1])) { console.error('--json-schema can only be used when --output-format is json or stream-json'); process.exit(1); }
${outputEnvelope === undefined ? "" : `console.log(${JSON.stringify(JSON.stringify(outputEnvelope))}); process.exit(0);`}
if (${JSON.stringify(behavior)} === 'empty') process.exit(0);
if (${JSON.stringify(behavior)} === 'quota') { writeFileSync(args[args.indexOf('--log-file')+1], 'RESOURCE_EXHAUSTED: Individual quota reached'); process.exit(0); }
if (${JSON.stringify(behavior)} === 'permission') { console.error('jetski: no output produced — a tool required the "read_url" permission that headless mode cannot prompt for, so it was auto-denied. api_key=private-token'); process.exit(0); }
if (${JSON.stringify(behavior)} === 'timeout-output') { writeFileSync(args[args.indexOf('--log-file')+1], 'You are not logged into Antigravity.\\nPrint mode: silent auth succeeded'); console.error('[agy] print timeout after 45s with turn in progress; returning partial output'); process.exit(0); }
if (${JSON.stringify(behavior)} === 'auth') { console.log('Authentication required. Please visit https://accounts.google.com/?token=private-token'); process.exit(0); }
if (${JSON.stringify(behavior)} === 'success') writeFileSync(args[args.indexOf('--log-file')+1], 'You are not logged into Antigravity.\\nExperiments refreshed after login');
if (${JSON.stringify(behavior)} === 'slow-success') { setTimeout(() => console.log('하늘과 땅.'), 150); } else if (${JSON.stringify(behavior)} === 'hang') { setInterval(() => {}, 1000); } else console.log('하늘과 땅.');
`, { mode: 0o700 });
  await chmod(binary, 0o700);
  return createAgentAdapter("antigravity", { binary, env: { PATH: process.env.PATH, HOME: dir }, cancelGraceMs: 50, killGraceMs: 50 });
}
describe("Antigravity adapter", () => {
  it("does not classify recovered startup authentication errors as the final failure", () => {
    const recovered = "error getting token source: You are not logged into Antigravity.\nPrint mode: silent auth succeeded\n";
    expect(antigravityLogFailure(recovered + "connection reset by peer")).toBeNull();
    expect(antigravityLogFailure(recovered + "RESOURCE_EXHAUSTED: quota exceeded")?.code).toBe("rate_limited");
    expect(antigravityLogFailure(recovered + "invalid_grant")?.code).toBe("auth_required");
    expect(antigravityLogFailure("You are not logged into Antigravity.")?.code).toBe("auth_required");
  });
  it("discovers live IDs, authenticates through models, and passes Unicode prompt and options as argv", async () => {
    const adapter = await fake();
    expect(await adapter.probe()).toMatchObject({ installed: true, loggedIn: true, modelSource: "live", capabilities: { reasoningEffort: true, serviceTier: false, resume: false } });
    expect((await adapter.beginLogin()).displayCommand).toBe("agy");
    const prompt = '天地。\nTranslate "all"; $(never-run)';
    const result = await adapter.run({ runId: "run", prompt, model: "gemini-test", reasoningEffort: "medium" });
    expect(result).toMatchObject({ ok: true, outputText: "하늘과 땅.\n", sessionRef: null });
    const call = JSON.parse(await readFile(join(dir, "call.json"), "utf8"));
    expect(call.args.slice(-2)).toEqual(["-p", prompt]);
    expect(call.args).toEqual(expect.arrayContaining(["--model", "gemini-test", "--effort", "medium"]));
    expect(call.args).not.toContain("--dangerously-skip-permissions");
    expect(call.args).not.toContain("--output-format");
    expect(call.args).not.toContain("--json-schema");
    expect(call.cwd).not.toBe(process.cwd());
    expect(await adapter.resume("unsupported", { runId: "resume", prompt })).toMatchObject({ ok: false });
  });
  it("requests JSON mode for a schema and extracts the actual agy 1.2.1 structured result", async () => {
    const payload = { ok: true };
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    // Observed agy 1.2.1 envelope: no type/subtype/is_error/result fields.
    const adapter = await fake("success", false, {
      conversation_id: "private-conversation-id", status: "SUCCESS",
      response: '{"ok":true}\n{"ok":true,"toolAction":"Finishing task","toolSummary":"Finish task"}\n',
      duration_seconds: 0.25, num_turns: 1, structured_output: payload,
      json_schema: { ...schema, description: "private-schema-metadata" }, usage: { diagnostic: "private-usage-metadata" },
    });
    const events: AgentRunEvent[] = [];
    const result = await adapter.run({ runId: "schema", prompt: "Recommend footnotes for 天地。", outputSchema: schema }, (event) => { events.push(event); });
    expect(result).toMatchObject({ ok: true, structuredOutput: payload, sessionRef: null });
    if (!result.ok) throw new Error(result.error.message);
    expect(JSON.parse(result.outputText)).toEqual(payload);
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      expect.objectContaining({ type: "text_delta", text: result.outputText }),
    ]);
    const call = JSON.parse(await readFile(join(dir, "call.json"), "utf8"));
    expect(call.args[call.args.indexOf("--output-format") + 1]).toBe("json");
    expect(call.args.filter((arg: string) => arg === "--output-format")).toHaveLength(1);
    expect(JSON.parse(call.args[call.args.indexOf("--json-schema") + 1])).toEqual(schema);
    expect(call.args).not.toContain("--dangerously-skip-permissions");
    const published = JSON.stringify({ result, events });
    for (const hidden of ["private-conversation-id", "private-schema-metadata", "private-usage-metadata", "toolAction", "toolSummary", "Finishing task"]) {
      expect(published).not.toContain(hidden);
    }
  });
  it.each(["response", "result"])("extracts a JSON payload from the %s fallback", async (field) => {
    const payload = { summary: "풀이가 필요하지 않습니다.", recommendations: [] };
    const adapter = await fake("success", false, { status: "success", [field]: JSON.stringify(payload) });
    const result = await adapter.run({ runId: `schema-${field}`, prompt: "天地", outputSchema: { type: "object" } });
    expect(result).toMatchObject({ ok: true, structuredOutput: payload });
    if (result.ok) expect(JSON.parse(result.outputText)).toEqual(payload);
  });
  it("rejects a JSON error envelope without publishing its response or structured payload", async () => {
    const adapter = await fake("success", false, {
      conversation_id: "private-conversation-id", status: "error", response: "RESOURCE_EXHAUSTED api_key=private-token",
      structured_output: { summary: "discard-partial-recommendation", recommendations: [] },
    });
    const events: AgentRunEvent[] = [];
    const result = await adapter.run({ runId: "schema-error", prompt: "天地", outputSchema: { type: "object" } }, (event) => { events.push(event); });
    expect(result).toMatchObject({ ok: false, error: { code: "rate_limited" }, partialOutput: "" });
    expect(result.structuredOutput).toBeUndefined();
    expect(events.some((event) => event.type === "text_delta")).toBe(false);
    const published = JSON.stringify({ result, events });
    for (const hidden of ["private-conversation-id", "private-token", "discard-partial-recommendation"]) expect(published).not.toContain(hidden);
  });
  it("keeps a quiet run alive and aligns the CLI deadline with the app deadline", async () => {
    const adapter = await fake("slow-success");
    const events: AgentRunEvent[] = [];
    const originalTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void, ms?: number, ...args: any[]) =>
      originalTimeout(fn, ms === 120_000 ? 20 : ms, ...args)) as typeof setTimeout);
    try {
      const result = await adapter.run({ runId: "quiet", prompt: "hello", reasoningEffort: "high" }, e => { events.push(e); });
      expect(result.ok).toBe(true);
      expect(events.some(e => e.type === "status" && e.detail?.includes("응답 대기 중"))).toBe(true);
      expect(timer.mock.calls.some(call => call[1] === 30 * 60_000)).toBe(true);
      const call = JSON.parse(await readFile(join(dir, "call.json"), "utf8"));
      expect(call.args[call.args.indexOf("--print-timeout") + 1]).toBe("1800000ms");
    } finally { timer.mockRestore(); }
    await adapter.run({ runId: "custom-deadline", prompt: "hello", timeoutMs: 5000 });
    const call = JSON.parse(await readFile(join(dir, "call.json"), "utf8"));
    expect(call.args[call.args.indexOf("--print-timeout") + 1]).toBe("5000ms");
  });
  it("approves native tools for an explicitly authorized punctuation run without an app tool", async () => {
    const adapter = await fake();
    const result = await adapter.run({ runId: "punctuation", prompt: "Punctuate 天地", antigravitySkipPermissions: true });
    expect(result.ok).toBe(true);
    const call = JSON.parse(await readFile(join(dir, "call.json"), "utf8"));
    expect(call.args.filter((arg: string) => arg === "--dangerously-skip-permissions")).toHaveLength(1);
  });
  it("uses legacy model labels while preserving other CLI settings", async () => {
    const adapter = await fake("success", true);
    const path = join(dir, ".gemini/antigravity-cli/settings.json");
    await mkdir(join(dir, ".gemini/antigravity-cli"), { recursive: true });
    await writeFile(path, JSON.stringify({ theme: "dark", model: "previous" }));
    expect(await adapter.probe()).toMatchObject({ loggedIn: null, modelSource: "fallback" });
    expect(await adapter.run({ runId: "legacy", prompt: "天地", model: "Gemini 3.1 Pro (High)" })).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "dark", model: "Gemini 3.1 Pro (High)" });
    const call = JSON.parse(await readFile(join(dir, "call.json"), "utf8"));
    expect(call.model).toBe("Gemini 3.1 Pro (High)");
    expect(call.args).not.toContain("--model");
    expect(await adapter.run({ runId: "bad", prompt: "天地", model: "invented" })).toMatchObject({ ok: false });
  });
  it.each([['quota', 'rate_limited'], ['auth', 'auth_required'], ['timeout-output', 'timeout'], ['permission', 'tool_permission_required']])("classifies %s without leaking diagnostics", async (behavior, code) => {
    const adapter = await fake(behavior);
    const events: AgentRunEvent[] = [];
    const result = await adapter.run({ runId: behavior, prompt: "hello" }, (e) => { events.push(e); });
    expect(result).toMatchObject({ ok: false, error: { code }, partialOutput: "" });
    expect(JSON.stringify({ result, events })).not.toContain("private-token");
    expect(events.some((e) => e.type === "text_delta")).toBe(false);
  });
  it.each([['quota', 'rate_limited'], ['timeout-output', 'timeout'], ['permission', 'tool_permission_required']])("preserves %s diagnostics when a schema run returns empty stdout", async (behavior, code) => {
    const adapter = await fake(behavior);
    const events: AgentRunEvent[] = [];
    const result = await adapter.run({ runId: `schema-${behavior}`, prompt: "天地", outputSchema: { type: "object" } }, (event) => { events.push(event); });
    expect(result).toMatchObject({ ok: false, error: { code }, partialOutput: "" });
    expect(result.structuredOutput).toBeUndefined();
    expect(events.some((event) => event.type === "text_delta")).toBe(false);
    expect(events.filter((event) => event.type === "error").map((event) => event.error.code)).toEqual([code]);
    expect(JSON.stringify({ result, events })).not.toContain("private-token");
  });
  it("still rejects empty schema output when there is no CLI failure diagnostic", async () => {
    const adapter = await fake("empty");
    const events: AgentRunEvent[] = [];
    const result = await adapter.run({ runId: "schema-empty", prompt: "天地", outputSchema: { type: "object" } }, (event) => { events.push(event); });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_stream" }, partialOutput: "" });
    expect(result.structuredOutput).toBeUndefined();
    expect(events.some((event) => event.type === "text_delta")).toBe(false);
    expect(events.filter((event) => event.type === "error").map((event) => event.error.code)).toEqual(["invalid_stream"]);
  });
  it("times out and cancels plain output runs", async () => {
    const adapter = await fake("hang");
    expect(await adapter.run({ runId: "timeout", prompt: "hello", timeoutMs: 100 })).toMatchObject({ ok: false, error: { code: "timeout" } });
    const run = adapter.run({ runId: "cancel", prompt: "hello" });
    await adapter.cancel("cancel");
    expect(await run).toMatchObject({ ok: false, error: { code: "canceled" } });
  });
  it("buffers split Unicode/credentials and ignores model-list progress lines", () => {
    const events: unknown[] = [];
    const parser = createAntigravityParser((event) => events.push(event), redactSecrets);
    const bytes = Buffer.from('하늘과 땅. api_key=abcdefghi');
    parser.feed(bytes.subarray(0, 2)); parser.feed(bytes.subarray(2, 23)); parser.feed(bytes.subarray(23));
    expect(events).toEqual([]);
    parser.finish();
    expect(parser.snapshot().outputText).toContain("하늘과 땅.");
    expect(parser.snapshot().outputText).not.toContain("abcdefghi");
    expect(parseAntigravityModels("Fetching...\ngemini-test\tGemini Test")).toHaveLength(2);
    expect(parseAntigravityModels("unknown command models")).toBeNull();
  });
  it("buffers JSON chunks and redacts decoded credentials and conversation IDs before publishing", () => {
    const events: AgentParsedEvent[] = [];
    const parser = createAntigravityParser((event) => events.push(event), redactSecrets, "json");
    const envelope = JSON.stringify({
      conversation_id: "private-conversation-id", status: "success", response: "unused response",
      structured_output: { summary: "하늘과 땅.", nested: [{ credential: "api_key=private-token", echoedConversation: "private-conversation-id" }] },
    }).replace("private-token", "private-\\u0074oken");
    const bytes = Buffer.from(envelope);
    const koreanByte = bytes.indexOf(Buffer.from("하"));
    parser.feed(bytes.subarray(0, koreanByte + 1));
    parser.feed(bytes.subarray(koreanByte + 1, koreanByte + 2));
    parser.feed(bytes.subarray(koreanByte + 2));
    expect(events).toEqual([]);
    expect(parser.snapshot().structuredOutput).toBeUndefined();
    parser.finish();
    const snapshot = parser.snapshot();
    expect(snapshot.structuredOutput).toEqual({ summary: "하늘과 땅.", nested: [{ credential: "api_key=[REDACTED]", echoedConversation: "[REDACTED]" }] });
    expect(JSON.parse(snapshot.outputText)).toEqual(snapshot.structuredOutput);
    expect(snapshot.sessionRef).toBeNull();
    expect(events).toEqual([{ type: "text_delta", text: snapshot.outputText }]);
    expect(JSON.stringify({ snapshot, events })).not.toContain("private-token");
    expect(JSON.stringify({ snapshot, events })).not.toContain("private-conversation-id");
    parser.finish();
    expect(events).toHaveLength(1);
  });
  it("keeps JSON-looking application output unchanged in plain mode", () => {
    const events: AgentParsedEvent[] = [];
    const parser = createAntigravityParser((event) => events.push(event), redactSecrets);
    const text = JSON.stringify({ status: "error", structured_output: { translation: "하늘과 땅." }, response: "literal application JSON" });
    parser.feed(text);
    parser.finish();
    expect(parser.snapshot()).toMatchObject({ outputText: text, error: null });
    expect(parser.snapshot().structuredOutput).toBeUndefined();
    expect(events).toEqual([{ type: "text_delta", text }]);
  });
  it.each([
    ["malformed CLI JSON", "{broken", "invalid_stream"],
    ["missing payload", JSON.stringify({ status: "success", conversation_id: "private-conversation-id" }), "invalid_stream"],
    ["malformed response JSON", JSON.stringify({ status: "success", response: "not JSON api_key=private-token" }), "invalid_envelope"],
    ["generic status error", JSON.stringify({ status: "failed", response: "private-diagnostic api_key=private-token" }), "provider_failed"],
    ["compatibility error flag", JSON.stringify({ is_error: true, result: "private-diagnostic api_key=private-token" }), "provider_failed"],
  ])("rejects %s without exposing raw JSON or diagnostics", (_name, body, code) => {
    const events: AgentParsedEvent[] = [];
    const parser = createAntigravityParser((event) => events.push(event), redactSecrets, "json");
    parser.feed(body);
    parser.finish();
    const snapshot = parser.snapshot();
    expect(snapshot).toMatchObject({ outputText: "", error: { code }, terminal: true });
    expect(snapshot.structuredOutput).toBeUndefined();
    expect(events).toEqual([{ type: "fatal", error: snapshot.error }]);
    const published = JSON.stringify({ snapshot, events });
    for (const hidden of ["private-token", "private-conversation-id", "private-diagnostic", "{broken"]) expect(published).not.toContain(hidden);
  });
  it("serializes model settings and preserves corrupt configuration", async () => {
    const path = join(dir, "settings.json");
    const release = await acquireAntigravityModelLock(path);
    let acquired = false;
    const next = acquireAntigravityModelLock(path).then((unlock) => { acquired = true; return unlock; });
    await Promise.resolve(); expect(acquired).toBe(false);
    release(); (await next)(); expect(acquired).toBe(true);
    await writeFile(path, "{broken");
    await writeAntigravityModelSelection(path, "default");
    await expect(writeAntigravityModelSelection(path, "Gemini Test")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{broken");
  });
});
const liveIt = process.env.MUNHAE_LIVE_ANTIGRAVITY === "1" ? it : it.skip;
liveIt("executes a real Antigravity request with a discovered model", async () => {
  const adapter = createAgentAdapter("antigravity");
  const probe = await adapter.probe();
  expect(probe.loggedIn).toBe(true);
  const result = await adapter.run({ runId: `live-agy-${Date.now()}`, prompt: "Translate 天地 into Korean. Reply with only the translation. Do not use tools.", model: probe.models.find((m) => m.id.includes("flash") && m.id.endsWith("low"))!.id, timeoutMs: 90_000 });
  expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
  if (result.ok) expect(result.outputText).toMatch(/하늘|천지/);
}, 110_000);
