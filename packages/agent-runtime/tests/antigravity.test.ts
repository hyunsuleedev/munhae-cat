import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAdapter, redactSecrets, type AgentRunEvent } from "../src/index";
import { acquireAntigravityModelLock, createAntigravityParser, parseAntigravityModels, writeAntigravityModelSelection } from "../src/antigravity";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "munhae-agy-test-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function fake(behavior = "success", legacy = false) {
  const binary = join(dir, "agy");
  await writeFile(binary, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.1.27'); process.exit(0); }
if (args[0] === '--help') { console.log('--print -p --log-file --dangerously-skip-permissions ${legacy ? '' : '--model --effort --json-schema'}'); process.exit(0); }
if (args[0] === 'models') { ${legacy ? "process.exit(1);" : "console.log('Fetching available models...\\ngemini-test\\tGemini Test'); process.exit(0);"} }
writeFileSync(${JSON.stringify(join(dir, 'call.json'))}, JSON.stringify({args, cwd:process.cwd(), model:${legacy ? "JSON.parse(readFileSync(join(process.env.HOME, '.gemini/antigravity-cli/settings.json'), 'utf8')).model" : "null"}}));
if (${JSON.stringify(behavior)} === 'quota') { writeFileSync(args[args.indexOf('--log-file')+1], 'RESOURCE_EXHAUSTED: Individual quota reached'); process.exit(0); }
if (${JSON.stringify(behavior)} === 'auth') { console.log('Authentication required. Please visit https://accounts.google.com/?token=private-token'); process.exit(0); }
if (${JSON.stringify(behavior)} === 'success') writeFileSync(args[args.indexOf('--log-file')+1], 'You are not logged into Antigravity.\\nExperiments refreshed after login');
if (${JSON.stringify(behavior)} === 'hang') { setInterval(() => {}, 1000); } else console.log('하늘과 땅.');
`, { mode: 0o700 });
  await chmod(binary, 0o700);
  return createAgentAdapter("antigravity", { binary, env: { PATH: process.env.PATH, HOME: dir }, cancelGraceMs: 50, killGraceMs: 50 });
}
describe("Antigravity adapter", () => {
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
    expect(call.cwd).not.toBe(process.cwd());
    expect(await adapter.resume("unsupported", { runId: "resume", prompt })).toMatchObject({ ok: false });
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
  it.each([['quota', 'rate_limited'], ['auth', 'auth_required']])("classifies %s without leaking diagnostics", async (behavior, code) => {
    const adapter = await fake(behavior);
    const events: AgentRunEvent[] = [];
    const result = await adapter.run({ runId: behavior, prompt: "hello" }, (e) => { events.push(e); });
    expect(result).toMatchObject({ ok: false, error: { code }, partialOutput: "" });
    expect(JSON.stringify({ result, events })).not.toContain("private-token");
    expect(events.some((e) => e.type === "text_delta")).toBe(false);
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
