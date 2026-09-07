import { describe, expect, it } from "vitest";
import {
  TRANSLATION_ENVELOPE_CONTRACT,
  translationEnvelopeJsonSchema,
  validateTranslationEnvelope,
} from "@munhae/domain";
import {
  createClaudeAdapter,
  createCodexAdapter,
  type AgentAdapter,
  type AgentRunEvent,
} from "../src/index.ts";

const prompt = [
  "Translate the complete Classical Chinese source into Korean.",
  "Use whatever internal translation process you judge appropriate; the app does not prescribe or receive those internal steps.",
  "First use your native shell tool to run exactly: /usr/bin/printenv MUNHAE_LIVE_APP_VALUE",
  "Do not include the command output or tool trace in the final response.",
  "The translation must cover A001 exactly once.",
  "anchorSetId=live-smoke-anchor-set",
  "[A001]天地。",
  "Return JSON with exactly this shape (replace only the Korean translations):",
  JSON.stringify({
    schemaVersion: 2,
    anchorSetId: "live-smoke-anchor-set",
    blocks: [{
      blockKey: "translation-A001",
      sourceAnchorIds: ["A001"],
      blockKind: "translation",
      translation: "하늘과 땅.",
    }],
  }),
].join("\n");
const enabled = process.env.MUNHAE_LIVE_CLI === "1";
const liveIt = enabled ? it : it.skip;

function structuredText(result: Awaited<ReturnType<AgentAdapter["run"]>>): string {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  if (result.structuredOutput !== undefined) return JSON.stringify(result.structuredOutput);
  const text = result.outputText.trim();
  if (text) {
    try {
      JSON.parse(text);
      return text;
    } catch {
      // Claude exposes --json-schema results separately.
    }
  }
  return JSON.stringify(result.structuredOutput);
}

describe("live provider CLI smoke", () => {
  liveIt("probes installed CLI versions, capabilities, and model choices", async () => {
    const [codex, claude] = await Promise.all([
      createCodexAdapter().probe(),
      createClaudeAdapter().probe(),
    ]);
    expect(codex).toMatchObject({
      installed: true,
      capabilitySource: "live",
      modelSource: "live",
      capabilities: {
        jsonStreaming: true,
        modelSelection: true,
        nativeTools: true,
      },
    });
    expect(codex.models.length).toBeGreaterThan(1);
    expect(codex.models.some((model) => model.id === "default")).toBe(true);
    expect(claude).toMatchObject({
      installed: true,
      capabilitySource: "live",
      modelSource: "fallback",
      capabilities: {
        jsonStreaming: true,
        modelSelection: true,
        nativeTools: true,
      },
    });
    expect(claude.models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "default",
      "sonnet",
      "opus",
      "haiku",
      "fable",
    ]));
  }, 20_000);

  for (const [agentId, adapter] of [
    ["codex", createCodexAdapter()],
    ["claude", createClaudeAdapter()],
  ] as const) {
    liveIt(`${agentId} completes a native tool turn and returns a valid structured result`, async () => {
      const events: AgentRunEvent[] = [];
      const result = await adapter.run({
        runId: `live-${agentId}-${Date.now()}`,
        prompt,
        outputSchema: translationEnvelopeJsonSchema(),
        outputContract: TRANSLATION_ENVELOPE_CONTRACT,
        appTool: {
          command: "/usr/bin/printenv",
          args: ["MUNHAE_LIVE_APP_VALUE"],
          env: { MUNHAE_LIVE_APP_VALUE: "run-scoped-smoke-value" },
        },
        timeoutMs: 90_000,
        inactivityTimeoutMs: 45_000,
      }, (event: AgentRunEvent) => {
        events.push(event);
      });
      expect(result.ok, result.ok ? undefined : JSON.stringify({ result, events })).toBe(true);
      const validation = validateTranslationEnvelope(structuredText(result), {
        anchorSetId: "live-smoke-anchor-set",
        anchors: [{ anchorKey: "A001", ordinal: 1, required: true }],
      });
      expect(validation.state, JSON.stringify(validation)).toBe("valid");
      expect(events).toContainEqual(expect.objectContaining({
        type: "tool_call",
        state: "started",
      }));
      expect(JSON.stringify({ result, events })).not.toContain("run-scoped-smoke-value");
    }, 110_000);
  }
});
