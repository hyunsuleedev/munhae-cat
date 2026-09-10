import { fileURLToPath } from "node:url";
import {
  createAgentAdapter,
  createClaudeAdapter,
  createCodexAdapter,
  type AgentAdapter,
  type AgentRunEvent,
} from "@munhae/agent-runtime";
import {
  TRANSLATION_ENVELOPE_CONTRACT,
  validateTranslationEnvelope,
} from "@munhae/domain";
import { renderTranslationRequest } from "@munhae/db-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTranslationToolGrant,
  stopAgentToolBridge,
} from "../src/main/agent-tool-bridge";

const enabled = process.env.MUNHAE_LIVE_APP_TOOL === "1";
const liveIt = enabled ? it : it.skip;
const builtWrapperPath = fileURLToPath(new URL("../out/main/agent-tool-cli.js", import.meta.url));

afterEach(async () => {
  await stopAgentToolBridge();
});

async function runLiveSubmission(
  agentId: "codex" | "claude" | "antigravity",
  adapter: AgentAdapter,
): Promise<void> {
  const runId = `live-app-${agentId}-${Date.now()}`;
  const grant = await createTranslationToolGrant({
    projectId: "live-project",
    runId,
    onSubmit() {},
  });
  const events: AgentRunEvent[] = [];
  const prompt = renderTranslationRequest({
    documentTitle: "Live app handoff",
    anchorSetId: "live-app-anchor-set",
    punctuatedText: "天地。",
    anchors: [{
      anchorKey: "A001",
      ordinal: 1,
      boundaryKind: "sentence",
      punctuationFrom: 0,
      punctuationTo: 3,
      required: true,
    }],
    policyText: JSON.stringify({ targetLocale: "ko", style: "concise modern Korean" }),
    metadataText: JSON.stringify({ purpose: "local editable draft" }),
    auxiliary: [],
  }).requestText;

  try {
    const result = await adapter.run({
      runId,
      prompt,
      outputContract: TRANSLATION_ENVELOPE_CONTRACT,
      ...(agentId === "antigravity" ? { model: "gemini-3.8-flash-low" } : {}),
      appTool: {
        command: process.execPath,
        args: [builtWrapperPath, "tools", "submit-translation"],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          MUNHAE_NODE_BIN: process.execPath,
          MUNHAE_BIN: builtWrapperPath,
          MUNHAE_TOOL_URL: grant.endpoint,
          MUNHAE_TOOL_GRANT: grant.token,
          MUNHAE_TOOL_RUN_ID: runId,
        },
      },
      timeoutMs: 90_000,
      inactivityTimeoutMs: 45_000,
    }, (event) => events.push(event));

    expect(result.ok, JSON.stringify({ result, events })).toBe(true);
    const submission = grant.inspect();
    expect(
      submission,
      JSON.stringify({ result, events, submission }),
    ).toMatchObject({
      callCount: 1,
      committed: true,
      error: null,
    });
    expect(submission.rawBody).not.toBeNull();
    const validation = validateTranslationEnvelope(submission.value, {
      anchorSetId: "live-app-anchor-set",
      anchors: [{ anchorKey: "A001", ordinal: 1, required: true }],
    });
    expect(
      validation.state,
      JSON.stringify({ result, events, submission, validation }),
    ).toBe("valid");
    if (agentId !== "antigravity") expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", state: "started" }));
    const publicRuntimeData = JSON.stringify({ result, events });
    expect(publicRuntimeData).not.toContain(grant.token);
    expect(publicRuntimeData).not.toContain(grant.endpoint);
    expect(publicRuntimeData).not.toContain(builtWrapperPath);
  } finally {
    grant.revoke();
  }
}

describe("live provider app-owned translation command", () => {
  (process.env.MUNHAE_LIVE_ANTIGRAVITY === "1" ? it : it.skip)("Antigravity submits exactly once through the built wrapper and bridge", async () => {
    await runLiveSubmission("antigravity", createAgentAdapter("antigravity"));
  }, 110_000);

  liveIt("Codex submits exactly once through the built wrapper and bridge", async () => {
    await runLiveSubmission("codex", createCodexAdapter());
  }, 110_000);

  liveIt("Claude submits exactly once through the built wrapper and bridge", async () => {
    await runLiveSubmission("claude", createClaudeAdapter());
  }, 110_000);
});
