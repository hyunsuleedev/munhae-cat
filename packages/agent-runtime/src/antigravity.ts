import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { AgentJsonlParser, AgentModelOption, AgentParsedEventSink, AgentRunError } from "./index";

// Compatibility labels from open-design/apps/daemon/src/runtimes/defs/antigravity.ts.
// Current agy releases advertise their actual IDs through `agy models` instead.
export const ANTIGRAVITY_FALLBACK_MODELS: AgentModelOption[] = [
  { id: "default", label: "CLI 기본값" },
  ...["Gemini 3.1 Pro (High)", "Gemini 3.1 Pro (Low)",
    "Gemini 3.5 Flash (High)", "Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (Low)",
    "Claude Sonnet 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)", "GPT-OSS 120B (Medium)"]
    .map((label) => ({ id: label, label })),
];

export function parseAntigravityModels(stdout: string): AgentModelOption[] | null {
  const models = stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-z0-9][a-z0-9._-]*)\t+(.+)$/.exec(line.trim());
    return match ? [{ id: match[1]!, label: match[2]!.trim() }] : [];
  });
  return models.length ? [{ id: "default", label: "CLI 기본값" }, ...models] : null;
}

export function antigravityFailure(text: string): AgentRunError | null {
  if (/a tool required[^\n]*permission[^\n]*headless mode cannot prompt|Print mode: soft-denying tool confirmation/i.test(text)) {
    return { code: "tool_permission_required", retryable: false,
      message: "Antigravity 도구 실행에 권한이 필요하지만 비대화형 실행에서는 승인할 수 없습니다. 터미널에서 필요한 도구 권한을 설정한 뒤 다시 시도하세요." };
  }
  if (/\[agy\].*print timeout after|Print mode: print timeout after/i.test(text)) {
    return { code: "timeout", retryable: true,
      message: "Antigravity가 제한 시간 안에 응답을 완료하지 못했습니다. 잠시 후 다시 시도하세요." };
  }
  if (/authentication required.*please visit|authentication timed out|not logged into antigravity|error getting token source|invalid_grant/i.test(text)) {
    return { code: "auth_required", retryable: false,
      message: "Antigravity 로그인이 필요합니다. 터미널에서 agy를 실행해 Google 로그인을 완료한 뒤 다시 시도하세요." };
  }
  if (/RESOURCE_EXHAUSTED|Individual quota reached|quota exceeded/i.test(text)) {
    return { code: "rate_limited", retryable: true,
      message: "Antigravity 모델의 사용 한도에 도달했습니다. 다른 모델을 선택하거나 한도가 갱신된 뒤 다시 시도하세요." };
  }
  return null;
}

function redactJson(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (typeof value === "string") return redact(value);
  if (depth > 64) return null;
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redact, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactJson(item, redact, depth + 1)]));
}

// Buffer output until completion so split credentials and OAuth URLs never leak
// as partial text events. JSON mode contains a CLI envelope, not the app payload.
export function createAntigravityParser(
  sink: AgentParsedEventSink,
  redact: (text: string) => string = (text) => text,
  format: "text" | "json" = "text",
  initialSecrets: readonly string[] = [],
): AgentJsonlParser {
  const decoder = new StringDecoder("utf8");
  const secrets = new Set(initialSecrets.filter(Boolean));
  let raw = "";
  let output = "";
  let structuredOutput: unknown = undefined;
  let finished = false;
  let error: AgentRunError | null = null;
  const clean = (text: string): string => {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]");
    return redact(text);
  };
  const fail = (failure: AgentRunError): void => {
    error = failure;
    sink({ type: "fatal", error });
  };
  const invalid = (code: "invalid_stream" | "invalid_envelope", message: string): void => {
    fail({ code, message, retryable: false });
  };
  return {
    feed(chunk) {
      if (!finished) raw += typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    },
    finish() {
      if (finished) return;
      finished = true;
      const body = raw + decoder.end();
      raw = "";
      if (format === "text") {
        const failure = antigravityFailure(body);
        if (failure) { fail(failure); return; }
        output = clean(body);
      } else {
        // Empty stdout may have a more specific error in stderr or the agy log.
        // Let the runtime inspect those before classifying a missing result.
        if (!body.trim()) return;
        let envelope: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(body);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an envelope");
          envelope = parsed as Record<string, unknown>;
        } catch {
          const failure = antigravityFailure(body);
          if (failure) fail(failure);
          else invalid("invalid_stream", "Antigravity emitted a malformed JSON result envelope");
          return;
        }
        for (const key of ["conversation_id", "session_id"]) {
          if (typeof envelope[key] === "string" && envelope[key]) secrets.add(envelope[key]);
        }
        const status = typeof envelope.status === "string" ? envelope.status.toLowerCase() : "";
        const subtype = typeof envelope.subtype === "string" ? envelope.subtype : "";
        if (envelope.is_error === true || envelope.type === "error" || subtype.startsWith("error")
          || /^(?:error|failed|failure|canceled|cancelled|timeout)(?:$|[_ -])/.test(status)
          || (envelope.error !== undefined && envelope.error !== null && envelope.error !== false && envelope.error !== "")) {
          const failure = antigravityFailure(JSON.stringify({ status, error: envelope.error, errors: envelope.errors,
            response: envelope.response, result: envelope.result }));
          fail(failure ?? { code: status === "timeout" ? "timeout" : /^(?:canceled|cancelled)$/.test(status) ? "canceled" : "provider_failed",
            message: "Antigravity reported an unsuccessful structured result", retryable: status === "timeout" });
          return;
        }
        let payload: unknown;
        if (Object.prototype.hasOwnProperty.call(envelope, "structured_output")) {
          payload = envelope.structured_output;
        } else {
          const response = envelope.response ?? envelope.result;
          if (response === undefined || (typeof response === "string" && !response.trim())) {
            invalid("invalid_stream", "Antigravity completed without a structured result"); return;
          }
          try { payload = typeof response === "string" ? JSON.parse(response) : response; }
          catch { invalid("invalid_envelope", "Antigravity result is not valid structured JSON"); return; }
        }
        // Redact decoded strings before serialization; escaped secrets otherwise
        // evade exact-value matching. Never expose CLI metadata or schema fields.
        structuredOutput = redactJson(payload, clean);
        output = JSON.stringify(structuredOutput);
      }
      if (output) sink({ type: "text_delta", text: output });
    },
    snapshot: () => ({ outputText: output, ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      sessionRef: null, model: null, usage: null, terminal: finished, error }),
    redact: clean,
  };
}

// Older agy reads one global model setting. Hold this lock for the full run,
// including default-model runs, so another Munhae run cannot change it mid-start.
const modelLocks = new Map<string, Promise<void>>();
export async function acquireAntigravityModelLock(path: string): Promise<() => void> {
  const previous = modelLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  modelLocks.set(path, current);
  await previous;
  return () => {
    release();
    if (modelLocks.get(path) === current) modelLocks.delete(path);
  };
}

export async function writeAntigravityModelSelection(path: string, model: string): Promise<void> {
  if (model === "default") return;
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Antigravity settings");
    existing = parsed as Record<string, unknown>;
  } catch (error) {
    // Preserve damaged or unreadable user settings instead of overwriting them.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ ...existing, model }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** Startup token lookups can fail before agy restores a valid keyring session. */
export function antigravityLogFailure(text: string): AgentRunError | null {
  const authenticated = /(?:Print mode: silent auth succeeded|ChainedAuth: authenticated via|OAuth: authenticated successfully)[^\n]*(?:\n|$)/g;
  let start = 0;
  for (const match of text.matchAll(authenticated)) start = match.index! + match[0].length;
  return antigravityFailure(text.slice(start));
}

export async function readAntigravityDiagnostic(path: string): Promise<AgentRunError | null> {
  try {
    const file = await open(path, "r");
    try {
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
      await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      // Only return classified, fixed guidance; never forward raw diagnostic logs.
      return antigravityLogFailure(buffer.toString("utf8"));
    } finally { await file.close(); }
  } catch { return null; }
}
