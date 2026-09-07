import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
}): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  await access(builtWrapperPath);
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builtWrapperPath, "tools", "submit-translation"], {
      env: {
        ...process.env,
        MUNHAE_TOOL_URL: input.grant.endpoint,
        MUNHAE_TOOL_GRANT: input.grant.token,
        MUNHAE_TOOL_RUN_ID: input.grant.runId,
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

async function postWhileRevoking(grant: TranslationToolGrant, body: string): Promise<BridgeResponse> {
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
      grant.revoke();
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
