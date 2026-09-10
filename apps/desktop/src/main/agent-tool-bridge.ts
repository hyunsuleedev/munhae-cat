import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_TTL_MS = 25 * 60_000;

type TranslationGrantRecord = {
  projectId: string;
  runId: string;
  onSubmit(rawBody: string): void | Promise<void>;
  expiresAt: number;
  revoked: boolean;
  callCount: number;
  committed: boolean;
  rawBody: string | null;
  value: unknown;
  error: "invalid_json" | "invalid_payload" | "submission_rejected" | null;
};

export type TranslationToolSubmission = {
  callCount: number;
  committed: boolean;
  rawBody: string | null;
  value: unknown;
  error: "invalid_json" | "invalid_payload" | "submission_rejected" | null;
};

export type TranslationToolGrant = {
  runId: string;
  projectId: string;
  endpoint: string;
  token: string;
  expiresAt: string;
  inspect(): TranslationToolSubmission;
  revoke(): void;
};

let bridge: Server | null = null;
let bridgeUrl: string | null = null;
let starting: Promise<string> | null = null;
const grants = new Map<string, TranslationGrantRecord>();

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, statusCode: number, payload: object): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/u);
  return match?.[1] ?? null;
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw Object.assign(new Error("request too large"), { code: "request_too_large" });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function purgeExpired(now = Date.now()): void {
  for (const [hash, grant] of grants) {
    if (grant.expiresAt <= now) {
      grant.revoked = true;
      grants.delete(hash);
    }
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST" || request.url !== "/v1/tools/submit-translation") {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }
  const token = bearerToken(request);
  if (!token) {
    sendJson(response, 401, { ok: false, error: "unauthorized" });
    return;
  }
  purgeExpired();
  const hash = tokenHash(token);
  const grant = grants.get(hash);
  const requestRunId = request.headers["x-munhae-run-id"];
  if (!grant || grant.revoked || typeof requestRunId !== "string" || requestRunId !== grant.runId) {
    sendJson(response, 401, { ok: false, error: "unauthorized" });
    return;
  }

  grant.callCount += 1;
  if (grant.callCount !== 1) {
    sendJson(response, 409, { ok: false, error: "already_submitted" });
    return;
  }

  try {
    const rawBody = await requestBody(request);
    if (grant.revoked || grant.expiresAt <= Date.now() || grants.get(hash) !== grant) {
      sendJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    grant.rawBody = rawBody;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      grant.error = "invalid_json";
      sendJson(response, 400, { ok: false, error: "invalid_json" });
      return;
    }
    if (!isRecord(parsed)) {
      grant.error = "invalid_payload";
      sendJson(response, 400, { ok: false, error: "invalid_payload" });
      return;
    }
    grant.value = parsed;
    try {
      await grant.onSubmit(rawBody);
    } catch {
      grant.error = "submission_rejected";
      sendJson(response, 422, { ok: false, error: "submission_rejected" });
      return;
    }
    // A successful callback means the app-owned repository transaction has
    // already committed. Cancellation or expiry may race while an async
    // callback is in flight; re-check the capability and retire it, but keep
    // the committed submission authoritative instead of reporting a failure
    // that could make the provider retry a completed domain mutation.
    grant.committed = true;
    if (grant.revoked || grant.expiresAt <= Date.now() || grants.get(hash) !== grant) {
      grant.revoked = true;
      if (grants.get(hash) === grant) grants.delete(hash);
    }
    sendJson(response, 200, { ok: true, accepted: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "request_too_large") {
      grant.error = "invalid_payload";
      sendJson(response, 413, { ok: false, error: "request_too_large" });
      return;
    }
    sendJson(response, 500, { ok: false, error: "bridge_unavailable" });
  }
}

async function ensureBridge(): Promise<string> {
  if (bridgeUrl) return bridgeUrl;
  if (starting) return starting;
  starting = new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      void handleRequest(request, response).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { ok: false, error: "bridge_unavailable" });
        else response.destroy();
      });
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("agent tool bridge did not receive a TCP address"));
        return;
      }
      bridge = server;
      bridgeUrl = `http://${HOST}:${String(address.port)}`;
      resolve(bridgeUrl);
    });
  }).finally(() => {
    starting = null;
  });
  return starting;
}

export async function createTranslationToolGrant(input: {
  projectId: string;
  runId: string;
  onSubmit(rawBody: string): void | Promise<void>;
  ttlMs?: number;
}): Promise<TranslationToolGrant> {
  if (!input.projectId.trim() || !input.runId.trim() || typeof input.onSubmit !== "function") {
    throw new Error("projectId, runId, and onSubmit are required for an app tool grant");
  }
  purgeExpired();
  const baseUrl = await ensureBridge();
  const token = randomBytes(32).toString("base64url");
  const hash = tokenHash(token);
  const expiresAt = Date.now() + Math.max(10_000, input.ttlMs ?? DEFAULT_TTL_MS);
  const record: TranslationGrantRecord = {
    projectId: input.projectId,
    runId: input.runId,
    onSubmit: input.onSubmit,
    expiresAt,
    revoked: false,
    callCount: 0,
    committed: false,
    rawBody: null,
    value: undefined,
    error: null,
  };
  grants.set(hash, record);
  let revoked = false;
  return {
    projectId: input.projectId,
    runId: input.runId,
    endpoint: `${baseUrl}/v1/tools/submit-translation`,
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    inspect(): TranslationToolSubmission {
      return {
        callCount: record.callCount,
        committed: record.committed,
        rawBody: record.rawBody,
        value: record.value,
        error: record.error,
      };
    },
    revoke(): void {
      if (revoked) return;
      revoked = true;
      record.revoked = true;
      grants.delete(hash);
    },
  };
}

export async function stopAgentToolBridge(): Promise<void> {
  for (const grant of grants.values()) grant.revoked = true;
  grants.clear();
  const server = bridge;
  bridge = null;
  bridgeUrl = null;
  starting = null;
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
