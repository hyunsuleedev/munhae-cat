import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_ADAPTER_DEFINITIONS,
  CLAUDE_APP_TOOL_TRUST_PROMPT,
  assertUniqueAgentDefinitionIds,
  buildClaudeArgs,
  buildCodexArgs,
  containsSensitiveProviderData,
  createClaudeAdapter,
  createClaudeJsonlParser,
  createCodexAdapter,
  createCodexJsonlParser,
  detectClaudeCapabilities,
  detectCodexCapabilities,
  normalizeAgentError,
  parseCodexDebugModels,
  probeAll,
  redactSecrets,
  sanitizeEnv,
  type AgentId,
  type AgentRunEvent,
} from "../src/index.ts";

type FakeBehavior =
  | "success"
  | "hang"
  | "tool"
  | "credential-output"
  | "malformed"
  | "invalid-envelope"
  | "no-effort"
  | "no-allowed-tools"
  | "no-safe-mode"
  | "no-permission-mode"
  | "no-append-system-prompt"
  | "models-unavailable"
  | "context-error";

type FakeCli = {
  binary: string;
  callsPath: string;
};

const schema = {
  type: "object",
  properties: {
    schemaVersion: { const: 2 },
    anchorSetId: { type: "string" },
    blocks: { type: "array" },
  },
  required: ["schemaVersion", "anchorSetId", "blocks"],
  additionalProperties: false,
} as const;

let suiteDir: string;

beforeEach(async () => {
  suiteDir = await mkdtemp(join(tmpdir(), "munhae-agent-runtime-test-"));
});

afterEach(async () => {
  await rm(suiteDir, { recursive: true, force: true });
});

async function makeFakeCli(
  agentId: AgentId,
  behavior: FakeBehavior = "success",
  options: { tag?: string; version?: string; modelLabel?: string } = {},
): Promise<FakeCli> {
  const stem = `${agentId}-${behavior}${options.tag ? `-${options.tag}` : ""}`;
  const binary = join(suiteDir, `${stem}.mjs`);
  const callsPath = join(suiteDir, `${stem}-calls.jsonl`);
  const structured = {
    schemaVersion: 2,
    anchorSetId: "anchor-set",
    blocks: [{
      blockKey: "translation-A001",
      sourceAnchorIds: ["A001"],
      blockKind: "translation",
      translation: "하늘과 땅.",
    }],
  };
  const claudeHelp = [
    "--input-format stream-json",
    "--output-format stream-json",
    "--resume",
    "--model",
    "--include-partial-messages",
    "--append-system-prompt",
    "--permission-mode",
    "--permission-prompts",
    "--tools",
    "--allowedTools",
    "--mcp-config",
    "--strict-mcp-config",
    "--safe-mode",
    "--setting-sources",
    "--restricted",
    "--disable-slash-commands",
    "--no-chrome",
    "--json-schema",
    "--session-id",
    "--effort",
  ].filter((flag) => {
    if (behavior === "no-effort" && flag === "--effort") return false;
    if (behavior === "no-allowed-tools" && flag === "--allowedTools") return false;
    if (behavior === "no-safe-mode" && flag === "--safe-mode") return false;
    if (behavior === "no-permission-mode" && flag === "--permission-mode") return false;
    if (behavior === "no-append-system-prompt" && flag === "--append-system-prompt") return false;
    return true;
  }).join("\n");
  const codexHelp = [
    "resume",
    "-c, --config <key=value>",
    "--json",
    "--model",
    "--output-schema",
    "--disable",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox [read-only, workspace-write, danger-full-access]",
  ].join("\n");
  const codexModels = {
    models: [
      {
        slug: "hidden-test",
        display_name: "Hidden",
        visibility: "hide",
        supported_reasoning_levels: [{ effort: "low" }],
      },
      {
        slug: "gpt-test",
        display_name: options.modelLabel ?? "GPT Test",
        description: "RAW_CATALOG_SENTINEL",
        visibility: "list",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "medium" },
          { effort: "high" },
        ],
        service_tiers: [{ id: "priority", name: "Fast" }],
      },
    ],
  };
  const source = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + "\\n");
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(${JSON.stringify(agentId === "codex"
    ? `codex-cli ${options.version ?? "9.9.9"}\n`
    : `${options.version ?? "9.9.9"} (Claude Code)\n`)});
  process.exit(0);
}
if (${JSON.stringify(agentId)} === "codex" && args.join(" ") === "login status") {
  process.stdout.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
if (${JSON.stringify(agentId)} === "codex" && args.join(" ") === "exec --help") {
  process.stdout.write(${JSON.stringify(`${codexHelp}\n`)});
  process.exit(0);
}
if (${JSON.stringify(agentId)} === "codex" && args.join(" ") === "debug models") {
  if (${JSON.stringify(behavior)} === "models-unavailable") {
    process.stderr.write("model catalog unavailable\\n");
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(`${JSON.stringify(codexModels)}\n`)});
  process.exit(0);
}
if (${JSON.stringify(agentId)} === "claude" && args.join(" ") === "auth status") {
  process.stdout.write('{"authenticated":true}\\n');
  process.exit(0);
}
if (${JSON.stringify(agentId)} === "claude" && args[0] === "-p" && args[1] === "--help") {
  process.stdout.write(${JSON.stringify(`${claudeHelp}\n`)});
  process.exit(0);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
let schemaText = null;
const schemaIndex = args.indexOf("--output-schema");
if (schemaIndex >= 0) schemaText = readFileSync(args[schemaIndex + 1], "utf8");
writeFileSync(${JSON.stringify(join(suiteDir, `${agentId}-${behavior}-run.json`))}, JSON.stringify({
  args,
  input,
  cwd: process.cwd(),
  schemaText,
  appEnv: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("MUNHAE_TEST_"))),
}));
const line = (value) => JSON.stringify(value) + "\\n";
if (${JSON.stringify(behavior)} === "hang") {
  if (${JSON.stringify(agentId)} === "codex") process.stdout.write(line({ type: "thread.started", thread_id: "thread-hang" }));
  else process.stdout.write(line({ type: "system", subtype: "init", session_id: "session-hang", model: "fake" }));
  setInterval(() => {}, 1000);
} else if (${JSON.stringify(behavior)} === "tool") {
  if (${JSON.stringify(agentId)} === "codex") {
    [
      { type: "thread.started", thread_id: "thread-tool" },
      { type: "item.started", item: { type: "command_execution", id: "cmd-1", command: "private command arguments" } },
      { type: "item.completed", item: { type: "command_execution", id: "cmd-1", command: "private command arguments", status: "completed" } },
      { type: "item.completed", item: { type: "error", message: "diagnostic " + (process.env.MUNHAE_TEST_TOKEN || "") + " " + (process.env.EXTERNAL_SERVICE_TOKEN || "") } },
      { type: "item.completed", item: { type: "agent_message", text: "tool finished 1" } },
      { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } },
    ].forEach((record) => process.stdout.write(line(record)));
  } else {
    [
      { type: "system", subtype: "init", session_id: "session-tool", model: "fake" },
      { type: "system", subtype: "status", status: "tool " + (process.env.MUNHAE_TEST_TOKEN || "") + " " + (process.env.EXTERNAL_SERVICE_TOKEN || "") },
      { type: "stream_event", event: { type: "message_start", message: { id: "message-tool" } } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "private command arguments" } } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "private arguments" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "assistant", message: { id: "message-tool", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "private command arguments" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "private result" }] } },
      { type: "result", is_error: false, result: "tool finished 1", usage: {} },
    ].forEach((record) => process.stdout.write(line(record)));
  }
} else if (${JSON.stringify(behavior)} === "credential-output") {
  const credentialKeys = ["COOKIE", "DATABASE_URL", "GITHUB_PAT", "SESSION", "DSN", "SHORT_SECRET"];
  const values = [
    ...credentialKeys.map((key) => process.env[key] || ""),
    ...Object.entries(process.env)
      .filter(([key]) => key.startsWith("MANY_SECRET_"))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value || ""),
  ].filter(Boolean);
  const output = "credentials=" + values.join("|");
  if (${JSON.stringify(agentId)} === "codex") {
    [
      { type: "thread.started", thread_id: "thread-credential-output" },
      { type: "item.completed", item: { type: "agent_message", id: "message-credential-output", text: output } },
      { type: "turn.completed", usage: {} },
    ].forEach((record) => process.stdout.write(line(record)));
  } else {
    const first = Math.max(1, Math.floor(output.length / 3));
    const second = Math.max(first + 1, Math.floor(output.length * 2 / 3));
    [
      { type: "system", subtype: "init", session_id: "session-credential-output", model: "fake" },
      { type: "stream_event", event: { type: "message_start", message: { id: "message-credential-output" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: output.slice(0, first) } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: output.slice(first, second) } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: output.slice(second) } } },
      { type: "assistant", message: { id: "message-credential-output", content: [{ type: "text", text: output }] } },
      { type: "result", is_error: false, usage: {} },
    ].forEach((record) => process.stdout.write(line(record)));
  }
} else if (${JSON.stringify(behavior)} === "malformed") {
  process.stdout.write('{bad json\\n');
} else if (${JSON.stringify(behavior)} === "context-error") {
  if (${JSON.stringify(agentId)} === "codex") {
    process.stdout.write(line({ type: "error", message: "maximum context length exceeded" }));
  } else {
    process.stdout.write(line({ type: "result", is_error: true, errors: ["Prompt is too long"], usage: {} }));
  }
  process.stderr.write("Authorization: Bearer secret-value sk-proj-abcdefghijk\\n");
  process.exitCode = 1;
} else if (${JSON.stringify(agentId)} === "codex") {
  const resumed = args[0] === "exec" && args[1] === "resume";
  const session = resumed ? args[args.length - 1] : "thread-fresh";
  const output = ${JSON.stringify(behavior === "invalid-envelope" ? "not-json" : JSON.stringify(structured))};
  const records = [
    { type: "thread.started", thread_id: session },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", id: "message-1", text: output } },
    { type: "turn.completed", usage: { input_tokens: 11, output_tokens: 7, reasoning_output_tokens: 3, cached_input_tokens: 2 } },
  ];
  const payload = records.map(line).join("");
  const bytes = Buffer.from(payload);
  process.stdout.write(bytes.subarray(0, 19));
  await new Promise((resolve) => setTimeout(resolve, 5));
  process.stdout.write(bytes.subarray(19));
} else {
  const sessionIndex = args.indexOf("--session-id");
  const resumeIndex = args.indexOf("--resume");
  const session = resumeIndex >= 0 ? args[resumeIndex + 1] : args[sessionIndex + 1];
  const output = ${JSON.stringify(behavior === "invalid-envelope" ? "not-json" : JSON.stringify(structured))};
  const records = [
    { type: "system", subtype: "init", session_id: session, model: "claude-fake" },
    { type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: output.slice(0, 9) } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: output.slice(9) } } },
    { type: "assistant", message: { id: "message-1", content: [{ type: "text", text: output }], stop_reason: "end_turn" } },
    { type: "result", is_error: false, structured_output: ${JSON.stringify(structured)}, usage: { input_tokens: 13, output_tokens: 8, cache_read_input_tokens: 4 }, total_cost_usd: 0.01, duration_ms: 25 },
  ];
  const payload = records.map(line).join("");
  const bytes = Buffer.from(payload);
  process.stdout.write(bytes.subarray(0, 23));
  await new Promise((resolve) => setTimeout(resolve, 5));
  process.stdout.write(bytes.subarray(23));
}
`;
  await writeFile(binary, source, "utf8");
  await chmod(binary, 0o755);
  return { binary, callsPath };
}

async function readCalls(path: string): Promise<Array<{ args: string[] }>> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[] });
}

async function installPathCandidate(fake: FakeCli, directoryName: string): Promise<string> {
  const directory = join(suiteDir, directoryName);
  await mkdir(directory, { recursive: true });
  const binary = join(directory, "claude");
  await writeFile(binary, await readFile(fake.binary));
  await chmod(binary, 0o755);
  return binary;
}

async function readRun(agentId: AgentId, behavior: FakeBehavior): Promise<{
  args: string[];
  input: string;
  cwd: string;
  schemaText: string | null;
  appEnv: Record<string, string>;
}> {
  return JSON.parse(
    await readFile(join(suiteDir, `${agentId}-${behavior}-run.json`), "utf8"),
  ) as {
    args: string[];
    input: string;
    cwd: string;
    schemaText: string | null;
    appEnv: Record<string, string>;
  };
}

describe("probe and login", () => {
  it("keeps a unique declarative registry and parses live Codex model metadata", () => {
    expect(AGENT_ADAPTER_DEFINITIONS.map((definition) => definition.id)).toEqual([
      "claude",
      "codex",
      "antigravity",
    ]);
    expect(() => assertUniqueAgentDefinitionIds([
      { id: "codex" },
      { id: "codex" },
    ])).toThrow("Duplicate agent definition id: codex");

    const models = parseCodexDebugModels(JSON.stringify({
      models: [
        { slug: "secret", display_name: "Secret", visibility: "hide" },
        { slug: "legacy-secret", display_name: "Legacy Secret", visibility: "hidden" },
        {
          slug: "gpt-visible",
          display_name: "GPT Visible",
          visibility: "list",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "ultra" },
          ],
          additional_speed_tiers: ["fast"],
        },
      ],
    }));
    expect(models).toEqual([
      { id: "default", label: "CLI 기본값" },
      {
        id: "gpt-visible",
        label: "GPT Visible",
        defaultReasoningEffort: "medium",
        reasoningOptions: [{ id: "low", label: "low" }, { id: "medium", label: "medium" }],
        serviceTierOptions: [{ id: "priority", label: "Fast" }],
      },
    ]);
    expect(parseCodexDebugModels("not-json")).toBeNull();

    const unsafeCodex = detectCodexCapabilities([
      "-c, --config <key=value>",
      "--disable",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox [read-only, workspace-write]",
    ].join("\n"));
    expect(unsafeCodex.nativeTools).toBe(true);
    expect(unsafeCodex.jsonStreaming).toBe(false);
  });

  it("keeps probeAll compatibility and uses each provider's exact auth command", async () => {
    const codex = await makeFakeCli("codex");
    const claude = await makeFakeCli("claude");
    const probes = await probeAll({
      codex: { binary: codex.binary },
      claude: { binary: claude.binary },
      antigravity: { binary: join(suiteDir, "missing-agy") },
    });

    expect(probes.map((probe) => probe.agentId)).toEqual(["claude", "codex", "antigravity"]);
    expect(probes.filter((probe) => probe.agentId !== "antigravity").every((probe) => probe.installed && probe.loggedIn)).toBe(true);
    const codexProbe = probes.find((probe) => probe.agentId === "codex");
    const claudeProbe = probes.find((probe) => probe.agentId === "claude");
    expect(codexProbe).toMatchObject({
      displayName: "Codex CLI",
      capabilitySource: "live",
      modelSource: "live",
      capabilities: { nativeTools: true },
    });
    expect(codexProbe?.models.map((model) => model.id)).toEqual(["default", "gpt-test"]);
    expect(JSON.stringify(codexProbe)).not.toContain("RAW_CATALOG_SENTINEL");
    expect(claudeProbe).toMatchObject({
      displayName: "Claude Code",
      modelSource: "fallback",
      capabilities: { nativeTools: true, serviceTier: false },
    });
    expect(claudeProbe?.models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "default",
      "sonnet",
      "opus",
      "haiku",
      "fable",
    ]));
    const codexCalls = (await readCalls(codex.callsPath)).map((call) => call.args);
    expect(codexCalls).toContainEqual([
      "login",
      "status",
    ]);
    expect(codexCalls).toContainEqual(["exec", "--help"]);
    expect(codexCalls).toContainEqual(["debug", "models"]);
    expect((await readCalls(claude.callsPath)).map((call) => call.args)).toContainEqual([
      "auth",
      "status",
    ]);

    const codexLogin = await createCodexAdapter({ binary: codex.binary }).beginLogin();
    const claudeLogin = await createClaudeAdapter({ binary: claude.binary }).beginLogin();
    expect(codexLogin.args).toEqual(["login"]);
    expect(claudeLogin.args).toEqual(["auth", "login"]);
    expect(codexLogin.requiresInteractiveTerminal).toBe(true);
  });

  it("redacts inherited credential values from public probe and runtime metadata", async () => {
    const secret = "probe-environment-secret-value";
    const fake = await makeFakeCli("codex", "success", {
      tag: "probe-redaction",
      version: secret,
      modelLabel: secret,
    });
    const adapter = createCodexAdapter({
      binary: fake.binary,
      tempRoot: suiteDir,
      env: { ...process.env, EXTERNAL_SERVICE_TOKEN: secret },
    });

    const probe = await adapter.probe();
    expect(JSON.stringify(probe)).not.toContain(secret);
    expect(probe.version).toContain("[REDACTED]");
    expect(probe.models.find((model) => model.id === "gpt-test")?.label).toBe("[REDACTED]");

    const result = await adapter.run({ runId: "probe-redaction-run", prompt: "translate" });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.cliVersion).toContain("[REDACTED]");
  });

  it("uses the first usable Claude on PATH without isolation-policy substitution", async () => {
    const firstOnPath = await makeFakeCli("claude", "no-safe-mode", {
      tag: "resolver-first",
      version: "100.0.0",
    });
    const secondOnPath = await makeFakeCli("claude", "success", {
      tag: "resolver-second",
      version: "99.0.0",
    });
    const firstPath = await installPathCandidate(firstOnPath, "resolver-first-bin");
    const secondPath = await installPathCandidate(secondOnPath, "resolver-second-bin");
    const path = [
      join(suiteDir, "resolver-first-bin"),
      join(suiteDir, "resolver-second-bin"),
      process.env.PATH ?? "",
    ].join(process.platform === "win32" ? ";" : ":");

    const result = await createClaudeAdapter({
      env: {
        ...process.env,
        HOME: suiteDir,
        PATH: path,
        CLAUDE_BIN: undefined,
        NVM_BIN: undefined,
        FNM_MULTISHELL_PATH: undefined,
        VOLTA_HOME: undefined,
        NPM_CONFIG_PREFIX: undefined,
      },
    }).run({
      runId: "claude-resolver",
      prompt: "도구 없이 답하라",
    });

    expect(result).toMatchObject({ ok: true });
    expect(await realpath(result.executable!)).toBe(await realpath(firstPath));
    expect(await realpath(result.executable!)).not.toBe(await realpath(secondPath));
  });

  it("prefers the active user Node toolchain over a stale system-first GUI PATH", async () => {
    const active = await makeFakeCli("claude", "success", {
      tag: "resolver-active-nvm",
      version: "2.1.260",
    });
    const stale = await makeFakeCli("claude", "success", {
      tag: "resolver-stale-system",
      version: "2.0.15",
    });
    const home = join(suiteDir, "gui-home");
    const nvmBin = join(home, ".nvm", "versions", "node", "v25.4.0", "bin");
    const activePath = await installPathCandidate(
      active,
      "gui-home/.nvm/versions/node/v25.4.0/bin",
    );
    const stalePath = await installPathCandidate(stale, "gui-system-bin");

    const result = await createClaudeAdapter({
      env: {
        ...process.env,
        HOME: home,
        NVM_BIN: nvmBin,
        PATH: [dirname(stalePath), dirname(process.execPath)]
          .join(process.platform === "win32" ? ";" : ":"),
      },
    }).run({
      runId: "claude-resolver-active-toolchain",
      prompt: "활성 CLI로 답하라",
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.executable).toBe(activePath);
    expect(result.executable).not.toBe(stalePath);
  });

  it("discovers the newest NVM install from a Finder-style minimal PATH", async () => {
    const discovered = await makeFakeCli("claude", "success", {
      tag: "resolver-discovered-nvm",
      version: "2.1.260",
    });
    const home = join(suiteDir, "finder-home");
    const discoveredPath = await installPathCandidate(
      discovered,
      "finder-home/.nvm/versions/node/v25.4.0/bin",
    );

    const login = await createClaudeAdapter({
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_BIN: undefined,
        NVM_BIN: undefined,
        FNM_MULTISHELL_PATH: undefined,
        VOLTA_HOME: undefined,
        NPM_CONFIG_PREFIX: undefined,
        PATH: process.platform === "win32"
          ? join(process.env.SystemRoot ?? "C:\\Windows", "System32")
          : "/usr/bin:/bin",
      },
    }).beginLogin();

    expect(login.available).toBe(true);
    expect(login.command).toBe(discoveredPath);
  });

  it("honors an absolute CLAUDE_BIN override before discovery", async () => {
    const configured = await makeFakeCli("claude", "success", {
      tag: "resolver-configured",
      version: "2.1.260",
    });
    const pathFake = await makeFakeCli("claude", "success", {
      tag: "resolver-path",
      version: "2.0.15",
    });
    const pathBinary = await installPathCandidate(pathFake, "resolver-env-path");

    const result = await createClaudeAdapter({
      env: {
        ...process.env,
        HOME: suiteDir,
        CLAUDE_BIN: configured.binary,
        PATH: [dirname(pathBinary), dirname(process.execPath)]
          .join(process.platform === "win32" ? ";" : ":"),
      },
    }).run({
      runId: "claude-resolver-configured",
      prompt: "설정된 CLI로 답하라",
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.executable).toBe(configured.binary);
  });
});

describe("environment and error safety", () => {
  it("preserves the user's CLI environment but clears stale Munhae capabilities", () => {
    const env = sanitizeEnv({
      PATH: "/usr/bin",
      HOME: "/tmp",
      CODEX_HOME: "/tmp/codex",
      CLAUDE_CONFIG_DIR: "/tmp/claude",
      CODEX_BIN: "/tmp/bin/codex",
      CLAUDE_BIN: "/tmp/bin/claude",
      NVM_BIN: "/tmp/nvm/bin",
      HTTPS_PROXY: "http://localhost:8080",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      AUTHORIZATION: "Bearer tok",
      RANDOM_SECRET: "secret",
      MUNHAE_TOOL_GRANT: "stale-grant",
      LANG: "en_US.UTF-8",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CODEX_HOME).toBe("/tmp/codex");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude");
    expect(env.CODEX_BIN).toBe("/tmp/bin/codex");
    expect(env.CLAUDE_BIN).toBe("/tmp/bin/claude");
    expect(env.NVM_BIN).toBe("/tmp/nvm/bin");
    expect(env.HTTPS_PROXY).toBe("http://localhost:8080");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.NO_COLOR).toBe("1");
    expect(env.OPENAI_API_KEY).toBe("sk-secret");
    expect(env.ANTHROPIC_API_KEY).toBe("secret");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("secret");
    expect(env.AUTHORIZATION).toBe("Bearer tok");
    expect(env.RANDOM_SECRET).toBe("secret");
    expect(env.MUNHAE_TOOL_GRANT).toBeUndefined();
  });

  it("redacts secrets and normalizes provider failures", () => {
    const redacted = redactSecrets(
      [
        'Authorization: Bearer abc.def',
        'Cookie: session=cookie-secret; theme=dark',
        'Set-Cookie: auth=set-cookie-secret; Secure',
        'api_key="value" sk-ant-abcdefghijk ?token=query-secret',
        'DATABASE_URL=postgres://database-user:database-password@localhost/munhae',
      ].join("\n"),
    );
    expect(redacted).not.toContain("abc.def");
    expect(redacted).not.toContain("abcdefghijk");
    expect(redacted).not.toContain("query-secret");
    expect(redacted).not.toContain("cookie-secret");
    expect(redacted).not.toContain("set-cookie-secret");
    expect(redacted).not.toContain("database-password");
    expect(redacted).toContain("Cookie: [REDACTED]");
    expect(redacted).toContain("Set-Cookie: [REDACTED]");
    expect(normalizeAgentError("Prompt is too long").code).toBe("context_too_large");
    expect(normalizeAgentError("HTTP 429 rate limit").code).toBe("rate_limited");
    expect(normalizeAgentError("authentication_failed").code).toBe("auth_required");
    expect(
      normalizeAgentError("OAuth session expired and could not be refreshed").code,
    ).toBe("auth_required");
    expect(normalizeAgentError("no rollout found for thread id abc").code).toBe(
      "session_unavailable",
    );
  });

  it("detects generic, inherited exact, escaped JSON, and run-scoped secrets in app payloads", () => {
    const inherited = 'inherited-quote-"-\\-secret';
    const grant = "current-run-grant";
    const envelope = (translation: string) => JSON.stringify({
      schemaVersion: 2,
      anchorSetId: "anchors-1",
      blocks: [{
        blockKey: "B001",
        sourceAnchorIds: ["A001"],
        blockKind: "sentence",
        translation,
      }],
    });

    expect(containsSensitiveProviderData(
      envelope(inherited),
      { EXTERNAL_SERVICE_TOKEN: inherited },
    )).toBe(true);
    expect(containsSensitiveProviderData(
      envelope(`Authorization: Bearer generic-secret`),
      {},
    )).toBe(true);
    expect(containsSensitiveProviderData(envelope(grant), {}, [grant])).toBe(true);
    expect(containsSensitiveProviderData(envelope("민감 정보가 없는 번역"), {}, [grant])).toBe(false);
  });
});

describe("argv builders", () => {
  it("keeps Codex native tools and user customization under workspace-write", () => {
    const fresh = buildCodexArgs({
      cwd: "/isolated",
      model: "gpt-test",
      outputSchemaPath: "/isolated/schema.json",
    });
    expect(fresh).toEqual(
      expect.arrayContaining(["exec", "--json", "--sandbox", "workspace-write", "-C", "/isolated"]),
    );
    expect(fresh).not.toContain("--add-dir");
    expect(fresh).toContain("sandbox_workspace_write.network_access=true");
    expect(fresh).not.toContain("allow_login_shell=false");
    expect(fresh.join(" ")).not.toContain("shell_environment_policy");
    expect(fresh).not.toContain("--strict-config");
    expect(fresh).not.toContain("--ignore-user-config");
    expect(fresh).not.toContain("--ignore-rules");
    expect(fresh).not.toContain("--disable");
    expect(fresh).not.toContain('approval_policy="never"');
    expect(fresh.join(" ").toLowerCase()).not.toContain("mcp");

    const resumed = buildCodexArgs({ cwd: "/isolated", sessionRef: "thread-id" });
    expect(resumed.slice(0, 4)).toEqual(["exec", "resume", "--json", "--skip-git-repo-check"]);
    expect(resumed).toContain('sandbox_mode="workspace-write"');
    expect(resumed).toContain("sandbox_workspace_write.network_access=true");
    expect(resumed).not.toContain("--sandbox");
    expect(resumed).not.toContain("-C");
    expect(resumed).not.toContain("--add-dir");
    expect(resumed).not.toContain("--disable");
    expect(resumed).not.toContain("--strict-config");
    expect(resumed).not.toContain("--ignore-user-config");
    expect(resumed).not.toContain("--ignore-rules");
    expect(resumed.at(-1)).toBe("thread-id");
  });

  it("keeps Claude native tools, settings, skills, and MCP under Open Design's trusted mode", () => {
    const capabilities = detectClaudeCapabilities(
      [
        "--include-partial-messages --append-system-prompt --permission-mode --permission-prompts",
        "--tools --allowedTools --mcp-config --strict-mcp-config --safe-mode --setting-sources --restricted",
        "--disable-slash-commands --no-chrome --json-schema --session-id --effort",
      ].join(" "),
    );
    const args = buildClaudeArgs({
      capabilities,
      newSessionId: "00000000-0000-4000-8000-000000000000",
      outputSchema: schema,
      reasoningEffort: "high",
    });
    expect(args).toEqual(expect.arrayContaining(["--effort", "high"]));
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions"]));
    expect(args).not.toContain("--append-system-prompt");
    for (const removed of [
      "--safe-mode",
      "--restricted",
      "--setting-sources",
      "--strict-mcp-config",
      "--mcp-config",
      "--tools",
      "--allowedTools",
      "--permission-prompts",
      "--disable-slash-commands",
      "--no-chrome",
    ]) {
      expect(args).not.toContain(removed);
    }

    const legacyPolicyFlags = {
      ...capabilities,
      allowedTools: false,
      safeMode: false,
      restricted: false,
      strictMcpConfig: false,
    };
    expect(buildClaudeArgs({ capabilities: legacyPolicyFlags })).toEqual(
      expect.arrayContaining(["--permission-mode", "bypassPermissions"]),
    );
    expect(() => buildClaudeArgs({
      capabilities: { ...legacyPolicyFlags, permissionMode: false },
    })).toThrow("does not support required --permission-mode");

    const appToolArgs = buildClaudeArgs({ capabilities, appTool: true });
    expect(appToolArgs).toEqual(expect.arrayContaining([
      "--append-system-prompt",
      CLAUDE_APP_TOOL_TRUST_PROMPT,
      "--permission-mode",
      "bypassPermissions",
    ]));
    expect(CLAUDE_APP_TOOL_TRUST_PROMPT).toContain("initiated by the user through the Munhae desktop UI");
    expect(CLAUDE_APP_TOOL_TRUST_PROMPT).toContain("MUNHAE_* environment variables");
    expect(CLAUDE_APP_TOOL_TRUST_PROMPT).toContain("local editable draft");
    expect(CLAUDE_APP_TOOL_TRUST_PROMPT).toContain("source text");
    expect(CLAUDE_APP_TOOL_TRUST_PROMPT).toContain("does not impose a tool allowlist");
    expect(appToolArgs).not.toContain("--tools");
    expect(appToolArgs).not.toContain("--allowedTools");
    expect(() => buildClaudeArgs({
      capabilities: { ...capabilities, appendSystemPrompt: false },
      appTool: true,
    })).toThrow("does not support required --append-system-prompt for app tools");
  });
});

describe("strict JSONL parsers", () => {
  it.each(["codex", "claude"] as const)(
    "uses only the final %s response after progress and tool messages",
    (agentId) => {
      const events: unknown[] = [];
      const parser = agentId === "codex"
        ? createCodexJsonlParser((event) => events.push(event))
        : createClaudeJsonlParser((event) => events.push(event));
      const progress = "고한문 번역 스킬의 원문 보존·표점 지침만 적용해 초안을 점검하겠습니다. 앱 데이터는 변경하지 않습니다.";
      const final = "供奉下士四人。〇書吏十六人，皁隷三十人。\n\n臣謹案：《周禮》小史。\n";
      const records = agentId === "codex" ? [
        { type: "item.completed", item: { id: "progress", type: "agent_message", text: progress } },
        { type: "item.completed", item: { id: "tool", type: "command_execution", status: "completed" } },
        { type: "item.completed", item: { id: "answer", type: "agent_message", text: final } },
        { type: "item.completed", item: { id: "answer-replay", type: "agent_message", text: final } },
        { type: "turn.completed", usage: {} },
      ] : [
        { type: "stream_event", event: { type: "message_start", message: { id: "progress" } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: progress } } },
        { type: "assistant", message: { id: "progress", content: [{ type: "text", text: progress }, { type: "tool_use", id: "tool", name: "Read" }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool" }] } },
        { type: "stream_event", event: { type: "message_start", message: { id: "answer" } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: final } } },
        { type: "result", is_error: false, result: final, usage: {} },
      ];
      parser.feed(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
      expect(events.some((event) => (event as { type: string }).type === "text_delta")).toBe(false);
      parser.finish();
      expect(parser.snapshot()).toMatchObject({ outputText: final, terminal: true, error: null });
      expect(events.filter((event) => (event as { type: string }).type === "text_delta"))
        .toEqual([{ type: "text_delta", text: final }]);
    },
  );

  it.each(["codex", "claude"] as const)(
    "preserves invalid or empty %s final content for downstream validation",
    (agentId) => {
      for (const final of ["설명입니다.\n供奉下士五人。", ""]) {
        const parser = agentId === "codex" ? createCodexJsonlParser() : createClaudeJsonlParser();
        const records = agentId === "codex" ? [
          { type: "item.completed", item: { type: "agent_message", text: "供奉下士四人。" } },
          { type: "item.completed", item: { type: "agent_message", text: final } },
          { type: "turn.completed", usage: {} },
        ] : [
          { type: "assistant", message: { content: [{ type: "text", text: "供奉下士四人。" }] } },
          { type: "result", is_error: false, result: final, usage: {} },
        ];
        parser.feed(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
        parser.finish();
        expect(parser.snapshot().outputText).toBe(final);
      }
    },
  );

  it("buffers semantic text deltas until it can redact secrets across every boundary", () => {
    const events: unknown[] = [];
    const secret = "split-delta-secret";
    const parser = createClaudeJsonlParser(
      (event) => events.push(event),
      (text) => redactSecrets(text).split(secret).join("[REDACTED]"),
    );
    parser.feed([
      { type: "stream_event", event: { type: "message_start", message: { id: "message-secret" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "before Cook" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ie: cookie-value\na split-delta-" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "secret after" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "split-delta-" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "secret" } } },
      { type: "assistant", message: { id: "message-secret", content: [{ type: "text", text: "duplicate final block" }] } },
      { type: "result", is_error: false, usage: {} },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");

    expect(events.some((event) => (event as { type?: string }).type === "text_delta")).toBe(false);
    parser.finish();
    const result = parser.snapshot();
    const publicEvents = JSON.stringify(events);
    expect(result.outputText).toBe("before Cookie: [REDACTED]\na [REDACTED] after");
    expect(publicEvents).not.toContain("cookie-value");
    expect(publicEvents).not.toContain(secret);
    expect(events.filter((event) => (event as { type?: string }).type === "thinking_delta"))
      .toEqual([{ type: "thinking_delta", text: "" }]);
    expect(events).toContainEqual({ type: "text_delta", text: result.outputText });
  });

  it("keeps session refs app-local when fresh or resumed providers repeat them", () => {
    const freshSession = "fresh-provider-session-ref";
    const freshEvents: unknown[] = [];
    const fresh = createClaudeJsonlParser((event) => freshEvents.push(event));
    fresh.feed([
      { type: "system", subtype: "init", session_id: freshSession, model: "fake" },
      { type: "stream_event", event: { type: "message_start", message: { id: "message-session" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `session=${freshSession}` } } },
      { type: "result", is_error: false, structured_output: { echoed: freshSession }, usage: {} },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    fresh.finish();

    const freshResult = fresh.snapshot();
    expect(freshResult.sessionRef).toBe(freshSession);
    expect(freshResult.outputText).toBe("session=[REDACTED]");
    expect(freshResult.structuredOutput).toEqual({ echoed: "[REDACTED]" });
    expect(JSON.stringify(freshEvents.filter((event) => (
      event as { type?: string }
    ).type !== "session"))).not.toContain(freshSession);

    const resumedSession = "resumed-provider-session-ref";
    const resumed = createCodexJsonlParser(() => {}, redactSecrets, [resumedSession]);
    resumed.feed(JSON.stringify({
      type: "error",
      message: `resume failed for ${resumedSession}`,
    }) + "\n");
    resumed.finish();
    expect(resumed.snapshot().error?.message).toBe("resume failed for [REDACTED]");
  });

  it("handles arbitrary UTF-8 chunk boundaries and captures Codex session/output/usage", () => {
    const events: unknown[] = [];
    const parser = createCodexJsonlParser((event) => events.push(event));
    const payload = Buffer.from(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", id: "message-1", text: "번역 완료" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", id: "message-1-replay", text: "번역 완료" },
        }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }),
      ].join("\n") + "\n",
    );
    const split = payload.indexOf(Buffer.from("역")) + 1;
    parser.feed(payload.subarray(0, split));
    parser.feed(payload.subarray(split));
    parser.finish();

    const result = parser.snapshot();
    expect(result.error).toBeNull();
    expect(result.outputText).toBe("번역 완료");
    expect(result.sessionRef).toBe("thread-1");
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    expect(events).toContainEqual({ type: "text_delta", text: "번역 완료" });
  });

  it("fails closed for malformed JSONL and accepts Claude native tool frames", () => {
    const codex = createCodexJsonlParser();
    codex.feed("{bad json\n");
    codex.finish();
    expect(codex.snapshot().error?.code).toBe("invalid_stream");

    const events: unknown[] = [];
    const claude = createClaudeJsonlParser((event) => events.push(event));
    claude.feed(
      [
        { type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } },
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "must stay private" },
            },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "must stay private" },
          },
        },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1" }] } },
        { type: "result", is_error: false, result: "done", usage: {} },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    claude.finish();
    expect(claude.snapshot().error).toBeNull();
    expect(events).toEqual(expect.arrayContaining([
      { type: "tool_call", name: "Bash", state: "started" },
      { type: "tool_call", name: "Bash", state: "completed" },
    ]));
    expect(JSON.stringify(events)).not.toContain("must stay private");
  });

  it("normalizes Codex native tool lifecycle without exposing arguments", () => {
    const events: unknown[] = [];
    const parser = createCodexJsonlParser((event) => events.push(event));
    parser.feed([
      {
        type: "item.started",
        item: { type: "command_execution", id: "command-1", command: "private command" },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          id: "command-1",
          command: "private command",
          status: "completed",
        },
      },
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: {} },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    parser.finish();
    expect(parser.snapshot().error).toBeNull();
    expect(events).toEqual(expect.arrayContaining([
      { type: "tool_call", name: "command_execution", state: "started" },
      { type: "tool_call", name: "command_execution", state: "completed" },
    ]));
    expect(JSON.stringify(events)).not.toContain("private command");
  });
});

describe("fake CLI integration", () => {
  it.each(["codex", "claude"] as const)(
    "redacts every inherited credential value from %s output without a count or length gap",
    async (agentId) => {
      const fake = await makeFakeCli(agentId, "credential-output");
      const namedSecrets = {
        COOKIE: "cookie-env-value",
        DATABASE_URL: "postgres://database-user:database-password@localhost/munhae",
        GITHUB_PAT: "github-pat-value",
        SESSION: "session-env-value",
        DSN: "dsn-env-value",
        SHORT_SECRET: "tiny7",
      };
      const manySecrets = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [
        `MANY_SECRET_${String(index).padStart(3, "0")}`,
        `many-secret-value-${String(index).padStart(3, "0")}`,
      ]));
      const env = { ...process.env, ...namedSecrets, ...manySecrets };
      const adapter = agentId === "codex"
        ? createCodexAdapter({ binary: fake.binary, tempRoot: suiteDir, env })
        : createClaudeAdapter({ binary: fake.binary, tempRoot: suiteDir, env });
      const events: AgentRunEvent[] = [];
      const result = await adapter.run({
        runId: `${agentId}-credential-output`,
        prompt: "Return the credential test fixture.",
      }, (event) => {
        events.push(event);
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const publicData = JSON.stringify({ events, result });
      for (const value of [...Object.values(namedSecrets), ...Object.values(manySecrets)]) {
        expect(publicData).not.toContain(value);
      }
      expect(result.outputText.match(/\[REDACTED\]/gu)).toHaveLength(306);
      expect(events
        .filter((event): event is Extract<AgentRunEvent, { type: "text_delta" }> => event.type === "text_delta")
        .map((event) => event.text)
        .join(""))
        .toBe(result.outputText);
    },
  );

  it("validates live Codex model and model-specific reasoning support before spawning", async () => {
    const fake = await makeFakeCli("codex");
    const adapter = createCodexAdapter({ binary: fake.binary, tempRoot: suiteDir });
    const missingModel = await adapter.run({
      runId: "codex-missing-model",
      prompt: "translate",
      model: "not-in-live-catalog",
    });
    expect(missingModel.ok).toBe(false);
    if (!missingModel.ok) {
      expect(missingModel.error.message).toContain("not advertised");
    }
    const unsupportedEffort = await adapter.run({
      runId: "codex-unsupported-effort",
      prompt: "translate",
      model: "gpt-test",
      reasoningEffort: "xhigh",
    });
    expect(unsupportedEffort.ok).toBe(false);
    if (!unsupportedEffort.ok) {
      expect(unsupportedEffort.error.message).toContain("does not advertise reasoning effort xhigh");
    }
  });

  it("uses declarative fallback hints when Codex model discovery is unavailable", async () => {
    const fake = await makeFakeCli("codex", "models-unavailable");
    const adapter = createCodexAdapter({ binary: fake.binary, tempRoot: suiteDir });
    const probe = await adapter.probe();
    expect(probe.modelSource).toBe("fallback");
    expect(probe.models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "default",
      "gpt-5.5",
      "gpt-5.4",
    ]));
    expect(probe.detail).toContain("using fallback model hints");
  });

  it.each(["codex", "claude"] as const)(
    "injects a run-scoped app command environment into %s's native tool loop",
    async (agentId) => {
      const fake = await makeFakeCli(agentId, "tool");
      const env = {
        ...process.env,
        EXTERNAL_SERVICE_TOKEN: "environment-secret-value",
      };
      const adapter = agentId === "codex"
        ? createCodexAdapter({
            binary: fake.binary,
            tempRoot: suiteDir,
            env,
          })
        : createClaudeAdapter({
            binary: fake.binary,
            tempRoot: suiteDir,
            env,
          });
      const events: AgentRunEvent[] = [];
      const result = await adapter.run({
        runId: `${agentId}-app-tool`,
        prompt: "Use the app command once, then answer.",
        appTool: {
          command: "/bundled/node",
          args: ["/bundled/agent-tool-cli", "tools", "submit-translation"],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            MUNHAE_NODE_BIN: "/bundled/node",
            MUNHAE_BIN: "/bundled/agent-tool-cli",
            MUNHAE_TEST_TOOL_URL: "http://127.0.0.1:12345/run",
            MUNHAE_TEST_TOKEN: "run-scoped-secret-value",
          },
        },
      }, (event) => {
        events.push(event);
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(events).toContainEqual(expect.objectContaining({
        type: "tool_call",
        name: agentId === "codex" ? "command_execution" : "Bash",
        state: "completed",
      }));
      expect(JSON.stringify({ events, result })).not.toContain("run-scoped-secret-value");
      expect(JSON.stringify({ events, result })).not.toContain("environment-secret-value");
      expect(JSON.stringify(events)).toContain("[REDACTED]");
      expect(JSON.stringify(events)).not.toContain("private command arguments");
      expect(result.outputText).toBe("tool finished 1");
      const run = await readRun(agentId, "tool");
      expect(run.appEnv).toEqual({
        MUNHAE_TEST_TOOL_URL: "http://127.0.0.1:12345/run",
        MUNHAE_TEST_TOKEN: "run-scoped-secret-value",
      });
      if (agentId === "codex") {
        expect(run.args).toContain('shell_environment_policy.inherit="all"');
        expect(run.args).toContain("shell_environment_policy.ignore_default_excludes=true");
        expect(run.args.some((arg) => arg.startsWith("shell_environment_policy.include_only=")))
          .toBe(false);
        expect(run.args).not.toContain("--disable");
      } else {
        expect(run.args).toEqual(expect.arrayContaining([
          "--permission-mode",
          "bypassPermissions",
        ]));
        expect(run.args).toEqual(expect.arrayContaining([
          "--append-system-prompt",
          CLAUDE_APP_TOOL_TRUST_PROMPT,
        ]));
        expect(run.args).not.toContain("--permission-prompts");
        expect(run.args).not.toContain("--tools");
        expect(run.args).not.toContain("--allowedTools");
        expect(run.args).not.toContain("--strict-mcp-config");
        expect(run.args).not.toContain("--mcp-config");
      }
    },
  );

  it("runs Codex via stdin in an isolated cwd with an output-schema file", async () => {
    const fake = await makeFakeCli("codex");
    const events: AgentRunEvent[] = [];
    const adapter = createCodexAdapter({ binary: fake.binary, tempRoot: suiteDir });
    const result = await adapter.run(
      {
        runId: "codex-fresh",
        prompt: "御製序를 번역하라",
        model: "gpt-test",
        outputSchema: schema,
        outputContract: "translation-envelope.v2",
      },
      (event) => {
        events.push(event);
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionRef).toBe("thread-fresh");
    expect(result.structuredOutput).toMatchObject({ schemaVersion: 2, anchorSetId: "anchor-set" });
    expect(result.usage).toMatchObject({ inputTokens: 11, cachedInputTokens: 2 });
    const run = await readRun("codex", "success");
    expect(run.input).toBe("御製序를 번역하라");
    expect(run.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write", "--output-schema"]));
    expect(run.args).not.toContain("--disable");
    expect(run.args).not.toContain("--strict-config");
    expect(run.args).not.toContain("--ignore-user-config");
    expect(run.args).not.toContain("--ignore-rules");
    expect(run.args).not.toContain("--add-dir");
    expect(run.schemaText).toBe(JSON.stringify(schema));
    expect(run.cwd).not.toBe(process.cwd());
    expect(existsSync(run.cwd)).toBe(false);
    expect(events.some((event) => event.type === "session")).toBe(true);
  });

  it("resumes Codex without -C/add-dir/--sandbox", async () => {
    const fake = await makeFakeCli("codex");
    const adapter = createCodexAdapter({ binary: fake.binary, tempRoot: suiteDir });
    const result = await adapter.resume("thread-resume", {
      runId: "codex-resume",
      prompt: "번역을 계속하라",
      outputSchema: schema,
    });

    expect(result.ok).toBe(true);
    expect(result.sessionRef).toBe("thread-resume");
    const run = await readRun("codex", "success");
    expect(run.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(run.args).not.toContain("-C");
    expect(run.args).not.toContain("--add-dir");
    expect(run.args).not.toContain("--sandbox");
    expect(run.args).not.toContain("--disable");
    expect(run.args).not.toContain("--strict-config");
    expect(run.args).not.toContain("--ignore-user-config");
    expect(run.args).not.toContain("--ignore-rules");
    expect(run.args.at(-1)).toBe("thread-resume");
  });

  it("runs Claude stream-json with its native tool/config surface and no duplicate final text", async () => {
    const fake = await makeFakeCli("claude");
    const adapter = createClaudeAdapter({ binary: fake.binary, tempRoot: suiteDir });
    const result = await adapter.run({
      runId: "claude-fresh",
      prompt: "고한문을 번역하라",
      model: "claude-fake",
      reasoningEffort: "high",
      outputSchema: schema,
      outputContract: "translation-envelope.v2",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedOutput = JSON.stringify({
      schemaVersion: 2,
      anchorSetId: "anchor-set",
      blocks: [{
        blockKey: "translation-A001",
        sourceAnchorIds: ["A001"],
        blockKind: "translation",
        translation: "하늘과 땅.",
      }],
    });
    expect(result.outputText).toBe(expectedOutput);
    expect(result.structuredOutput).toMatchObject({ schemaVersion: 2, anchorSetId: "anchor-set" });
    expect(result.sessionRef).toMatch(/^[0-9a-f-]{36}$/u);
    const run = await readRun("claude", "success");
    expect(run.args).toEqual(expect.arrayContaining([
      "--permission-mode",
      "bypassPermissions",
    ]));
    expect(run.args).toEqual(expect.arrayContaining(["--effort", "high"]));
    expect(run.args).not.toContain("--tools");
    expect(run.args).not.toContain("--allowedTools");
    expect(run.args).not.toContain("--safe-mode");
    expect(run.args).not.toContain("--restricted");
    expect(run.args).not.toContain("--strict-mcp-config");
    expect(run.args).not.toContain("--mcp-config");
    expect(run.args).not.toContain("--add-dir");
    expect(run.args).not.toContain("--append-system-prompt");
    const initial = JSON.parse(run.input.trim()) as {
      type: string;
      message: { role: string; content: Array<{ type: string; text: string }> };
    };
    expect(initial).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "고한문을 번역하라" }] },
    });
    expect(run.cwd).not.toBe(process.cwd());
    expect(existsSync(run.cwd)).toBe(false);
  });

  it("reapplies Claude's trusted native-tool mode when resuming a chat", async () => {
    const fake = await makeFakeCli("claude");
    const adapter = createClaudeAdapter({ binary: fake.binary, tempRoot: suiteDir });
    const result = await adapter.resume("session-resume", {
      runId: "claude-resume",
      prompt: "이전 대화를 이어 답하라",
    });

    expect(result.ok).toBe(true);
    expect(result.sessionRef).toBe("session-resume");
    const run = await readRun("claude", "success");
    expect(run.args).toEqual(expect.arrayContaining(["--resume", "session-resume"]));
    expect(run.args).toEqual(expect.arrayContaining([
      "--permission-mode",
      "bypassPermissions",
    ]));
    expect(run.args).not.toContain("--safe-mode");
    expect(run.args).not.toContain("--restricted");
    expect(run.args).not.toContain("--permission-prompts");
    expect(run.args).not.toContain("--tools");
    expect(run.args).not.toContain("--allowedTools");
    expect(run.args).not.toContain("--append-system-prompt");
  });

  it("fails rather than recording a Claude reasoning level the CLI cannot apply", async () => {
    const fake = await makeFakeCli("claude", "no-effort");
    const adapter = createClaudeAdapter({ binary: fake.binary, tempRoot: suiteDir });
    const result = await adapter.run({
      runId: "claude-no-effort",
      prompt: "고한문을 번역하라",
      reasoningEffort: "high",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "provider_failed",
      message: "Installed Claude CLI does not support the requested --effort setting",
    });
  });

  it.each(["no-safe-mode", "no-allowed-tools"] as const)(
    "does not require Claude's optional policy flag set: %s",
    async (behavior) => {
      const fake = await makeFakeCli("claude", behavior);
      const adapter = createClaudeAdapter({ binary: fake.binary, tempRoot: suiteDir });
      const result = await adapter.run({
        runId: `claude-${behavior}`,
        prompt: "완성 번역을 stdin wrapper로 제출하라",
        appTool: {
          command: "/bundled/node",
          args: ["/bundled/wrapper", "tools", "submit-translation"],
          env: {},
        },
      });

      expect(result.ok).toBe(true);
      const run = await readRun("claude", behavior);
      expect(run.args).not.toContain("--safe-mode");
      expect(run.args).not.toContain("--allowedTools");
      expect(run.args).toEqual(expect.arrayContaining([
        "--permission-mode",
        "bypassPermissions",
      ]));
      expect(run.args).toEqual(expect.arrayContaining([
        "--append-system-prompt",
        CLAUDE_APP_TOOL_TRUST_PROMPT,
      ]));
      expect(run.args).not.toContain("--tools");
    },
  );

  it("fails before spawning when Claude lacks --permission-mode", async () => {
    const fake = await makeFakeCli("claude", "no-permission-mode");
    const adapter = createClaudeAdapter({ binary: fake.binary, tempRoot: suiteDir });
    const result = await adapter.run({
      runId: "claude-no-permission-mode",
      prompt: "완성 번역을 제출하라",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "provider_failed",
      message: "Installed Claude CLI does not support required --permission-mode",
    });
    expect(existsSync(join(suiteDir, "claude-no-permission-mode-run.json"))).toBe(false);
  });

  it("fails an app-tool run before spawning when Claude lacks --append-system-prompt", async () => {
    const fake = await makeFakeCli("claude", "no-append-system-prompt");
    const adapter = createClaudeAdapter({ binary: fake.binary, tempRoot: suiteDir });
    const result = await adapter.run({
      runId: "claude-no-append-system-prompt",
      prompt: "완성 번역을 제출하라",
      appTool: {
        command: "/bundled/node",
        args: ["/bundled/wrapper", "tools", "submit-translation"],
        env: {},
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "provider_failed",
      message: "Installed Claude CLI does not support required --append-system-prompt for app tools",
    });
    expect(existsSync(join(suiteDir, "claude-no-append-system-prompt-run.json"))).toBe(false);
  });

  it.each(["codex", "claude"] as const)("lets %s finish its native tool loop", async (agentId) => {
    const fake = await makeFakeCli(agentId, "tool");
    const adapter =
      agentId === "codex"
        ? createCodexAdapter({ binary: fake.binary, tempRoot: suiteDir, cancelGraceMs: 20, killGraceMs: 20 })
        : createClaudeAdapter({ binary: fake.binary, tempRoot: suiteDir, cancelGraceMs: 20, killGraceMs: 20 });
    const result = await adapter.run({ runId: `${agentId}-tool`, prompt: "translate" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputText).toBe("tool finished 1");
  });

  it("cancels an active process group and lets cancellation win over stream-finalization errors", async () => {
    const fake = await makeFakeCli("codex", "hang");
    const adapter = createCodexAdapter({
      binary: fake.binary,
      tempRoot: suiteDir,
      cancelGraceMs: 30,
      killGraceMs: 30,
    });
    let initialized!: () => void;
    const ready = new Promise<void>((resolve) => {
      initialized = resolve;
    });
    const runPromise = adapter.run(
      { runId: "cancel-me", prompt: "translate", timeoutMs: 5_000 },
      (event) => {
        if (event.type === "session") initialized();
      },
    );
    await ready;
    await adapter.cancel("cancel-me");
    const result = await runPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("canceled");
  });

  it("enforces a hard timeout", async () => {
    const fake = await makeFakeCli("codex", "hang");
    const adapter = createCodexAdapter({
      binary: fake.binary,
      tempRoot: suiteDir,
      cancelGraceMs: 20,
      killGraceMs: 20,
    });
    const result = await adapter.run({
      runId: "timeout-me",
      prompt: "translate",
      timeoutMs: 40,
      inactivityTimeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("timeout");
  });

  it("distinguishes malformed transport, invalid structured output and context overflow", async () => {
    const malformed = await makeFakeCli("codex", "malformed");
    const malformedResult = await createCodexAdapter({
      binary: malformed.binary,
      tempRoot: suiteDir,
      cancelGraceMs: 20,
      killGraceMs: 20,
    }).run({ runId: "malformed", prompt: "translate" });
    expect(malformedResult.ok).toBe(false);
    if (!malformedResult.ok) expect(malformedResult.error.code).toBe("invalid_stream");

    const invalid = await makeFakeCli("codex", "invalid-envelope");
    const invalidResult = await createCodexAdapter({ binary: invalid.binary, tempRoot: suiteDir }).run({
      runId: "invalid-envelope",
      prompt: "translate",
      outputSchema: schema,
    });
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) expect(invalidResult.error.code).toBe("invalid_envelope");

    const context = await makeFakeCli("claude", "context-error");
    const contextResult = await createClaudeAdapter({
      binary: context.binary,
      tempRoot: suiteDir,
      cancelGraceMs: 20,
      killGraceMs: 20,
    }).run({ runId: "context-error", prompt: "translate" });
    expect(contextResult.ok).toBe(false);
    if (!contextResult.ok) {
      expect(contextResult.error.code).toBe("context_too_large");
      expect(contextResult.error.stderr).not.toContain("secret-value");
      expect(contextResult.error.stderr).not.toContain("abcdefghijk");
    }
  });
});
