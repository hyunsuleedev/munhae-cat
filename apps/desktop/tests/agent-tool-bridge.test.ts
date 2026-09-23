import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createReadingToolGrant,
  createTranslationToolGrant,
  stopAgentToolBridge,
  type TranslationToolGrant,
} from "../src/main/agent-tool-bridge";

const builtWrapperPath = fileURLToPath(new URL("../out/main/agent-tool-cli.js", import.meta.url));

type BridgeResponse = {
  status: number;
  body: unknown;
};

async function postSubmission(input: {
  endpoint: string;
  token: string;
  runId: string;
  body: string;
}): Promise<BridgeResponse> {
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      "x-munhae-run-id": input.runId,
    },
    body: input.body,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function runBuiltWrapperProcess(input: {
  grant: TranslationToolGrant;
  body: string;
  command?: string;
  grantedCommand?: string;
}): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  await access(builtWrapperPath);
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builtWrapperPath, "tools", input.command ?? "submit-translation"], {
      env: {
        ...process.env,
        MUNHAE_TOOL_URL: input.grant.endpoint,
        MUNHAE_TOOL_GRANT: input.grant.token,
        MUNHAE_TOOL_RUN_ID: input.grant.runId,
        MUNHAE_TOOL_COMMAND: input.grantedCommand,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(input.body);
  });
}

async function waitForCall(grant: TranslationToolGrant): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (grant.inspect().callCount === 0) {
    if (Date.now() >= deadline) throw new Error("bridge did not begin reading the request");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function postWhileRevoking(grant: TranslationToolGrant, body: string, whileReading = () => grant.revoke()): Promise<BridgeResponse> {
  const url = new URL(grant.endpoint);
  const bodyBuffer = Buffer.from(body, "utf8");
  const responsePromise = new Promise<BridgeResponse>((resolve, reject) => {
    const call = request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.token}`,
        "content-type": "application/json",
        "content-length": bodyBuffer.byteLength,
        "x-munhae-run-id": grant.runId,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 500,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    call.once("error", reject);
    call.flushHeaders();
    call.write(bodyBuffer.subarray(0, 1));
    void waitForCall(grant).then(() => {
      whileReading();
      call.end(bodyBuffer.subarray(1));
    }, reject);
  });
  return await responsePromise;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await stopAgentToolBridge();
});

describe("run-scoped translation tool bridge", () => {
  it("accepts one complete JSON submission and preserves the exact body", async () => {
    let submittedBody: string | null = null;
    const grant = await createTranslationToolGrant({
      projectId: "project-a",
      runId: "run-a",
      onSubmit(rawBody) {
        submittedBody = rawBody;
      },
    });
    const envelope = {
      schemaVersion: 2,
      anchorSetId: "anchor-set-a",
      blocks: [{ blockKey: "b1", sourceAnchorIds: ["A001"], blockKind: "paragraph", translation: "번역" }],
    };
    const rawBody = JSON.stringify(envelope);

    const response = await postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body: rawBody,
    });

    expect(response).toEqual({ status: 200, body: { ok: true, accepted: true } });
    expect(submittedBody).toBe(rawBody);
    expect(grant.inspect()).toEqual({ callCount: 1, committed: true, rawBody, value: envelope, error: null });
  });

  it("does not answer before the app-owned submit callback resolves", async () => {
    let resolveSubmit!: () => void;
    let markStarted!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const grant = await createTranslationToolGrant({
      projectId: "project-a",
      runId: "run-a",
      onSubmit: async () => {
        markStarted();
        await new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        });
      },
    });
    let settled = false;
    const responsePromise = postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body: JSON.stringify({ schemaVersion: 2 }),
    }).finally(() => {
      settled = true;
    });

    await submitStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(grant.inspect().committed).toBe(false);

    resolveSubmit();
    await expect(responsePromise).resolves.toEqual({ status: 200, body: { ok: true, accepted: true } });
    expect(grant.inspect().committed).toBe(true);
  });

  it("keeps a successful domain commit authoritative when revoke races with the callback", async () => {
    let resolveSubmit!: () => void;
    let markStarted!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const grant = await createTranslationToolGrant({
      projectId: "project-a",
      runId: "run-a",
      onSubmit: async () => {
        markStarted();
        await new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        });
      },
    });
    const rawBody = JSON.stringify({ schemaVersion: 2 });
    const responsePromise = postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body: rawBody,
    });

    await submitStarted;
    grant.revoke();
    resolveSubmit();

    await expect(responsePromise).resolves.toEqual({ status: 200, body: { ok: true, accepted: true } });
    expect(grant.inspect()).toEqual({
      callCount: 1,
      committed: true,
      rawBody,
      value: { schemaVersion: 2 },
      error: null,
    });
    await expect(postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body: rawBody,
    })).resolves.toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
  });

  it("keeps a successful domain commit authoritative when expiry races with the callback", async () => {
    const initialNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(initialNow);
    let resolveSubmit!: () => void;
    let markStarted!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const grant = await createTranslationToolGrant({
      projectId: "project-a",
      runId: "run-a",
      ttlMs: 10_000,
      onSubmit: async () => {
        markStarted();
        await new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        });
      },
    });
    const rawBody = JSON.stringify({ schemaVersion: 2 });
    const responsePromise = postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body: rawBody,
    });

    await submitStarted;
    now.mockReturnValue(initialNow + 10_001);
    resolveSubmit();

    await expect(responsePromise).resolves.toEqual({ status: 200, body: { ok: true, accepted: true } });
    expect(grant.inspect()).toEqual({
      callCount: 1,
      committed: true,
      rawBody,
      value: { schemaVersion: 2 },
      error: null,
    });
    await expect(postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body: rawBody,
    })).resolves.toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
  });

  it("returns a generic non-2xx response when the app-owned callback rejects", async () => {
    const grant = await createTranslationToolGrant({
      projectId: "project-a",
      runId: "run-a",
      onSubmit() {
        throw new Error("private stale/CAS detail");
      },
    });
    const rawBody = JSON.stringify({ schemaVersion: 2 });

    const response = await postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body: rawBody,
    });

    expect(response).toEqual({ status: 422, body: { ok: false, error: "submission_rejected" } });
    expect(JSON.stringify(response)).not.toContain("private stale/CAS detail");
    expect(grant.inspect()).toEqual({
      callCount: 1,
      committed: false,
      rawBody,
      value: { schemaVersion: 2 },
      error: "submission_rejected",
    });
  });

  it("does not consume the grant for an invalid token or run ID", async () => {
    const grant = await createTranslationToolGrant({ projectId: "project-a", runId: "run-a", onSubmit() {} });
    const body = JSON.stringify({ schemaVersion: 2 });

    const invalidToken = await postSubmission({
      endpoint: grant.endpoint,
      token: "x".repeat(43),
      runId: grant.runId,
      body,
    });
    const invalidRun = await postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: "run-b",
      body,
    });

    expect(invalidToken).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(invalidRun).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(grant.inspect()).toEqual({ callCount: 0, committed: false, rawBody: null, value: undefined, error: null });

    const valid = await postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body,
    });
    expect(valid.status).toBe(200);
    expect(grant.inspect().callCount).toBe(1);
  });

  it("rejects a duplicate submission and records that the run called twice", async () => {
    const grant = await createTranslationToolGrant({ projectId: "project-a", runId: "run-a", onSubmit() {} });
    const body = JSON.stringify({ schemaVersion: 2 });

    const first = await postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body,
    });
    const second = await postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body,
    });

    expect(first.status).toBe(200);
    expect(second).toEqual({ status: 409, body: { ok: false, error: "already_submitted" } });
    expect(grant.inspect()).toMatchObject({ callCount: 2, committed: true, rawBody: body, error: null });
  });

  it("preserves invalid JSON as raw evidence and consumes the only submission", async () => {
    const grant = await createTranslationToolGrant({ projectId: "project-a", runId: "run-a", onSubmit() {} });
    const rawBody = '{"schemaVersion":2,"blocks":[';

    const invalid = await postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body: rawBody,
    });

    expect(invalid).toEqual({ status: 400, body: { ok: false, error: "invalid_json" } });
    expect(grant.inspect()).toEqual({
      callCount: 1,
      committed: false,
      rawBody,
      value: undefined,
      error: "invalid_json",
    });

    const retry = await postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body: JSON.stringify({ schemaVersion: 2 }),
    });
    expect(retry).toEqual({ status: 409, body: { ok: false, error: "already_submitted" } });
  });

  it("rejects a revoked grant without recording a call", async () => {
    const grant = await createTranslationToolGrant({ projectId: "project-a", runId: "run-a", onSubmit() {} });
    grant.revoke();
    grant.revoke();

    const response = await postSubmission({
      endpoint: grant.endpoint,
      token: grant.token,
      runId: grant.runId,
      body: JSON.stringify({ schemaVersion: 2 }),
    });

    expect(response).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(grant.inspect()).toEqual({ callCount: 0, committed: false, rawBody: null, value: undefined, error: null });
  });

  it("does not accept an in-flight body after the grant is revoked", async () => {
    const grant = await createTranslationToolGrant({ projectId: "project-a", runId: "run-a", onSubmit() {} });
    const response = await postWhileRevoking(grant, JSON.stringify({ schemaVersion: 2 }));

    expect(response).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(grant.inspect()).toEqual({ callCount: 1, committed: false, rawBody: null, value: undefined, error: null });
  });

  it("submits through the built wrapper subprocess", async () => {
    let callbackCalls = 0;
    const grant = await createTranslationToolGrant({
      projectId: "project-wrapper",
      runId: "run-wrapper",
      onSubmit() {
        callbackCalls += 1;
      },
    });
    const envelope = {
      schemaVersion: 2,
      anchorSetId: "anchor-set-wrapper",
      blocks: [{ blockKey: "b1", sourceAnchorIds: ["A001"], blockKind: "paragraph", translation: "완성 번역" }],
    };
    const rawBody = JSON.stringify(envelope);

    const result = await runBuiltWrapperProcess({ grant, body: rawBody });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "문해가 완성 번역 하나를 수신했습니다.\n",
      stderr: "",
    });
    expect(callbackCalls).toBe(1);
    expect(grant.inspect()).toEqual({ callCount: 1, committed: true, rawBody, value: envelope, error: null });
  });

  it("keeps callback failure details private through the built wrapper", async () => {
    const privateDetail = "private repository CAS failure";
    const grant = await createTranslationToolGrant({
      projectId: "project-wrapper",
      runId: "run-wrapper-rejected",
      onSubmit() {
        throw new Error(privateDetail);
      },
    });
    const rawBody = JSON.stringify({ schemaVersion: 2 });

    const result = await runBuiltWrapperProcess({ grant, body: rawBody });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("submission_rejected");
    expect(result.stderr).not.toContain(privateDetail);
    expect(grant.inspect()).toMatchObject({
      callCount: 1,
      committed: false,
      rawBody,
      error: "submission_rejected",
    });
  });

});

it("isolates alignment capabilities, permits retries, and serializes concurrent calls", async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const handler = vi.fn(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return { ok: true }; });
  const grant = await createTranslationToolGrant({ projectId: "p", runId: "r", onSubmit: vi.fn(), onAlignment: handler });
  const send = (command: string, body = "{}") => postSubmission({ endpoint: grant.endpoint.replace(/[^/]+$/, command), token: grant.token, runId: grant.runId, body });
  expect((await send("submit-translation")).status).toBe(403);
  expect((await send("submit-alignment", "not-json")).status).toBe(400);
  const first = send("submit-alignment");
  await entered;
  expect((await send("check-alignment")).body).toEqual({ ok: false, error: "tool_busy" });
  release();
  expect((await first).status).toBe(200);
  expect(grant.inspect().committed).toBe(false);
  grant.revoke();
  expect((await send("check-alignment")).status).toBe(401);
  const translation = await createTranslationToolGrant({ projectId: "p", runId: "r", onSubmit: vi.fn() });
  expect((await postSubmission({ endpoint: translation.endpoint.replace(/[^/]+$/, "check-alignment"), token: translation.token, runId: translation.runId, body: "{}" })).status).toBe(403);
});


it("keeps new alignment CLI compatible with an old app grant endpoint", async () => {
  const accept = vi.fn();
  const grant = await createTranslationToolGrant({ projectId: "legacy", runId: "legacy-alignment", onSubmit: accept });
  const body = JSON.stringify({ schemaVersion: 3, versionId: "v", links: [] });
  const result = await runBuiltWrapperProcess({ grant, body, command: "submit-alignment" });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, accepted: true });
  expect(accept).toHaveBeenCalledWith(body);
  expect(grant.inspect().committed).toBe(true);
});

it("explains restart before invoking unsupported check tools on an old app", async () => {
  const accept = vi.fn();
  const grant = await createTranslationToolGrant({ projectId: "legacy", runId: "legacy-check", onSubmit: accept });
  const result = await runBuiltWrapperProcess({ grant, body: "{}", command: "check-alignment" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("앱을 다시 시작");
  expect(accept).not.toHaveBeenCalled();
  expect(grant.inspect().callCount).toBe(0);
});

describe("on-demand reading tool capability", () => {
  function send(grant: TranslationToolGrant, command: string, body = "{}", runId = grant.runId) {
    return postSubmission({ endpoint: grant.endpoint.replace(/[^/]+$/, command), token: grant.token, runId, body });
  }

  it("isolates reading, translation, and alignment grants in both directions", async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const reading = await createReadingToolGrant({ projectId: "p", runId: "reading", onTool: handler });
    const translation = await createTranslationToolGrant({ projectId: "p", runId: "translation", onSubmit: vi.fn() });
    const alignment = await createTranslationToolGrant({ projectId: "p", runId: "alignment", onSubmit: vi.fn(), onAlignment: handler });
    expect(reading.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/tools\/get-reading-context$/);
    for (const command of ["submit-translation", "submit-alignment", "check-alignment", "finish-alignment"]) {
      expect(await send(reading, command)).toEqual({ status: 403, body: { ok: false, error: "wrong_tool" } });
    }
    for (const grant of [translation, alignment]) {
      for (const command of ["get-reading-context", "lookup-reading-dictionary", "submit-reading-analysis"]) {
        expect(await send(grant, command)).toEqual({ status: 403, body: { ok: false, error: "wrong_tool" } });
      }
    }
    expect(handler).not.toHaveBeenCalled();
    expect(reading.inspect().callCount).toBe(0);
  });

  it("allows repeated context and dictionary reads, retries invalid proposals, and accepts exactly one submission", async () => {
    const handler = vi.fn((command: string, raw: string) => {
      if (command === "submit-reading-analysis" && !JSON.parse(raw).suggestions) return { ok: false, error: "invalid_suggestions" };
      return { ok: true, command };
    });
    const grant = await createReadingToolGrant({ projectId: "p", runId: "r", onTool: handler });
    for (let count = 0; count < 2; count++) {
      expect((await send(grant, "get-reading-context")).status).toBe(200);
      expect((await send(grant, "lookup-reading-dictionary", '{"query":"學"}')).status).toBe(200);
    }
    expect((await send(grant, "submit-reading-analysis", "{")).body).toEqual({ ok: false, error: "invalid_json" });
    expect((await send(grant, "submit-reading-analysis", "[]")).body).toEqual({ ok: false, error: "invalid_payload" });
    expect((await send(grant, "submit-reading-analysis")).status).toBe(422);
    expect(grant.inspect().committed).toBe(false);
    const raw = '{ "suggestions": [{"from":0,"to":1,"quote":"學"}] }';
    expect((await send(grant, "submit-reading-analysis", raw)).status).toBe(200);
    expect(grant.inspect()).toEqual({ callCount: 8, committed: true, rawBody: raw, value: JSON.parse(raw), error: null });
    for (const command of ["get-reading-context", "lookup-reading-dictionary", "submit-reading-analysis"]) {
      expect(await send(grant, command)).toEqual({ status: 409, body: { ok: false, error: "already_submitted" } });
    }
    expect(handler).toHaveBeenCalledTimes(6);
  });

  it("rejects mismatched runs and invalid tokens without invoking a handler", async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const grant = await createReadingToolGrant({ projectId: "p", runId: "r", onTool: handler });
    expect((await send(grant, "get-reading-context", "{}", "other-run")).status).toBe(401);
    expect((await postSubmission({ endpoint: grant.endpoint, token: "x".repeat(43), runId: grant.runId, body: "{}" })).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(grant.inspect().callCount).toBe(0);
    expect((await send(grant, "get-reading-context")).status).toBe(200);
  });

  it("rechecks revocation and expiry after reading an in-flight request body", async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const revoked = await createReadingToolGrant({ projectId: "p", runId: "revoked", onTool: handler });
    expect((await postWhileRevoking(revoked, "{}")).status).toBe(401);
    const initialNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(initialNow);
    const expired = await createReadingToolGrant({ projectId: "p", runId: "expired", ttlMs: 10_000, onTool: handler });
    expect((await postWhileRevoking(expired, "{}", () => { now.mockReturnValue(initialNow + 10_001); })).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(expired.inspect().committed).toBe(false);
  });

  it("rejects concurrent calls without losing a valid retry", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const handler = vi.fn(async (command: string) => {
      if (command === "lookup-reading-dictionary") { started(); await new Promise<void>(resolve => { release = resolve; }); }
      return { ok: true };
    });
    const grant = await createReadingToolGrant({ projectId: "p", runId: "r", onTool: handler });
    const pending = send(grant, "lookup-reading-dictionary");
    await entered;
    expect(await send(grant, "submit-reading-analysis")).toEqual({ status: 409, body: { ok: false, error: "tool_busy" } });
    release();
    expect((await pending).status).toBe(200);
    expect((await send(grant, "submit-reading-analysis")).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not publish a late proposal when cancellation happens during the handler", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const grant = await createReadingToolGrant({ projectId: "p", runId: "r", onTool: async () => {
      started(); await new Promise<void>(resolve => { release = resolve; }); return { ok: true, proposal: "late" };
    } });
    const pending = send(grant, "submit-reading-analysis");
    await entered;
    grant.revoke();
    release();
    expect(await pending).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(grant.inspect()).toMatchObject({ committed: false, rawBody: null });
  });

  it("keeps callback exceptions private and permits a corrected submission", async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error("private provider token or SQL detail")).mockResolvedValue({ ok: true });
    const grant = await createReadingToolGrant({ projectId: "p", runId: "r", onTool: handler });
    expect(await send(grant, "submit-reading-analysis")).toEqual({ status: 422, body: { ok: false, error: "submission_rejected" } });
    expect((await send(grant, "submit-reading-analysis")).status).toBe(200);
    expect(grant.inspect()).toMatchObject({ committed: true, error: null });
  });

  it("runs all three CLI commands only under the reading-analysis family and returns JSON", async () => {
    const handler = vi.fn((command: string) => ({ ok: true, command }));
    const grant = await createReadingToolGrant({ projectId: "p", runId: "r", onTool: handler });
    for (const command of ["get-reading-context", "lookup-reading-dictionary", "submit-reading-analysis"]) {
      const result = await runBuiltWrapperProcess({ grant, command, grantedCommand: "reading-analysis", body: "{}" });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, command });
      expect(result.stdout).not.toContain(grant.token);
    }
  });

  it("blocks CLI reading commands without the reading family and all cross-family commands", async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const grant = await createReadingToolGrant({ projectId: "p", runId: "r", onTool: handler });
    for (const grantedCommand of [undefined, "submit-translation", "submit-alignment", "get-reading-context"]) {
      const result = await runBuiltWrapperProcess({ grant, command: "get-reading-context", grantedCommand, body: "{}" });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
    }
    for (const command of ["submit-translation", "submit-alignment", "check-alignment", "finish-alignment"]) {
      const result = await runBuiltWrapperProcess({ grant, command, grantedCommand: "reading-analysis", body: "{}" });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
    }
    expect(handler).not.toHaveBeenCalled();
    expect(grant.inspect().callCount).toBe(0);
  });

  it("refuses a reading CLI command pointed at a translation endpoint without sending the grant", async () => {
    const accept = vi.fn();
    const grant = await createTranslationToolGrant({ projectId: "p", runId: "r", onSubmit: accept });
    const result = await runBuiltWrapperProcess({ grant, command: "get-reading-context", grantedCommand: "reading-analysis", body: "{}" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("허용된 로컬 bridge");
    expect(result.stderr).not.toContain(grant.token);
    expect(accept).not.toHaveBeenCalled();
    expect(grant.inspect().callCount).toBe(0);
  });
});
