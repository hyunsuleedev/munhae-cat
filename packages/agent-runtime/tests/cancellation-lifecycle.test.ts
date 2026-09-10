import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAdapter } from "../src/index.ts";

const stage = vi.hoisted(() => ({
  waiting: null as null | (() => Promise<void>),
  release: null as null | (() => void),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdtemp: async (...args: Parameters<typeof original.mkdtemp>) => {
      const result = await original.mkdtemp(...args);
      if (String(args[0]).endsWith("munhae-agent-") && stage.waiting) await stage.waiting();
      return result;
    },
  };
});

let root: string;
const helperPids: number[] = [];
const pending: Array<{ cancel(): Promise<void>; completion: Promise<unknown> }> = [];

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "munhae-cancel-lifecycle-")); });
afterEach(async () => {
  await writeFile(join(root, "probe-release"), "release");
  stage.release?.();
  stage.release = null;
  stage.waiting = null;
  for (const pid of helperPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  for (const run of pending.splice(0)) { await run.cancel(); await run.completion; }
  await rm(root, { recursive: true, force: true });
});

async function fake(name: string, body: string): Promise<string> {
  const file = join(root, `${name}.mjs`);
  await writeFile(file, `#!/usr/bin/env node\n${body}`);
  await chmod(file, 0o700);
  return file;
}

function prelude(holdAuth = false, authenticated = true): string {
  return `
import { writeFileSync, existsSync as probeGateExists } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex 9.9.9'); process.exit(0); }
if (args.join(' ') === 'login status') {
  writeFileSync(${JSON.stringify(join(root, "probing"))}, 'ready');
  ${holdAuth ? `while (!probeGateExists(${JSON.stringify(join(root, "probe-release"))})) await new Promise(resolve => setTimeout(resolve, 10));` : ""}
  console.log(${JSON.stringify(authenticated ? "Logged in using ChatGPT" : "Not logged in")});
  process.exit(${authenticated ? 0 : 1});
}
if (args.join(' ') === 'exec --help') { console.log('--json --sandbox workspace-write --model --config --output-schema resume'); process.exit(0); }
if (args.join(' ') === 'debug models') process.exit(1);
writeFileSync(${JSON.stringify(join(root, "request-started"))}, 'started');
for await (const chunk of process.stdin) {}
`;
}

const success = `
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-session' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fake completion' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
`;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("cancellation across the complete CLI lifetime", () => {
  it.each([true, false])("cancels during auth probe without starting a request (authenticated=%s)", async (authenticated) => {
    const adapter = createCodexAdapter({ binary: await fake("probe", prelude(true, authenticated) + success), tempRoot: root });
    const completion = adapter.run({ runId: "probe-cancel", prompt: "fake request" });
    pending.push({ cancel: () => adapter.cancel("probe-cancel"), completion });
    // Wait for readiness, then keep the fake probe blocked until cancellation
    // has been recorded. Process startup speed must not define this race.
    await vi.waitFor(() => expect(existsSync(join(root, "probing"))).toBe(true), { timeout: 10_000, interval: 10 });
    await adapter.cancel("probe-cancel");
    await writeFile(join(root, "probe-release"), "release");
    const result = await completion;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("canceled");
    expect(existsSync(join(root, "request-started"))).toBe(false);
  }, 15_000);

  it("honors cancellation while staging files after probe and before spawning the provider", async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    stage.waiting = () => new Promise<void>(resolve => { release = resolve; stage.release = resolve; entered(); });
    const adapter = createCodexAdapter({ binary: await fake("staging", prelude() + success), tempRoot: root });
    const completion = adapter.run({ runId: "staging-cancel", prompt: "fake request" });
    pending.push({ cancel: () => adapter.cancel("staging-cancel"), completion });
    await ready;
    await adapter.cancel("staging-cancel");
    release();
    const result = await completion;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("canceled");
    expect(existsSync(join(root, "request-started"))).toBe(false);
  });

  it.skipIf(process.platform === "win32").each(["ignore", "inherit"] as const)("kills a SIGTERM-resistant helper after its parent exits (stdio=%s)", async (stdio) => {
    const pidFile = join(root, "helper-pid");
    const helper = await fake("helper", `
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
    const binary = await fake("tree", prelude() + `
const { spawn } = await import('node:child_process');
const { existsSync } = await import('node:fs');
spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: ${stdio === "ignore" ? "'ignore'" : "['ignore', process.stdout, process.stderr]"} });
while (!existsSync(${JSON.stringify(pidFile)})) await new Promise(resolve => setTimeout(resolve, 5));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'helper-ready' }));
setInterval(() => {}, 1000);
`);
    const adapter = createCodexAdapter({ binary, tempRoot: root, cancelGraceMs: 50, killGraceMs: 300 });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const completion = adapter.run({ runId: "tree-cancel", prompt: "fake request", timeoutMs: 3000 }, event => {
      if (event.type === "session") started();
    });
    pending.push({ cancel: () => adapter.cancel("tree-cancel"), completion });
    await ready;
    const helperPid = Number(await readFile(pidFile, "utf8"));
    helperPids.push(helperPid);
    const canceled = adapter.cancel("tree-cancel");
    const result = await completion;
    // A canceled result itself must mean cleanup finished, even if its caller
    // has not separately awaited adapter.cancel().
    expect(isAlive(helperPid)).toBe(false);
    await canceled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("canceled");
    await vi.waitFor(() => expect(isAlive(helperPid)).toBe(false), { timeout: 1000 });
  }, 6000);
});
