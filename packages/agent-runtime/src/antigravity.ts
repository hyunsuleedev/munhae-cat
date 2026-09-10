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

// Buffer plain output until completion so split credentials and OAuth URLs never
// leak as partial text events. Print mode may emit auth diagnostics on stdout.
export function createAntigravityParser(
  sink: AgentParsedEventSink,
  redact: (text: string) => string = (text) => text,
): AgentJsonlParser {
  const decoder = new StringDecoder("utf8");
  let raw = "";
  let output = "";
  let finished = false;
  let error: AgentRunError | null = null;
  return {
    feed(chunk) { raw += typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk)); },
    finish() {
      if (finished) return;
      finished = true;
      raw += decoder.end();
      error = antigravityFailure(raw);
      if (error) { sink({ type: "fatal", error }); return; }
      output = redact(raw);
      if (output) sink({ type: "text_delta", text: output });
      raw = "";
    },
    snapshot: () => ({ outputText: output, sessionRef: null, model: null, usage: null, terminal: finished, error }),
    redact,
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

export async function readAntigravityDiagnostic(path: string): Promise<AgentRunError | null> {
  try {
    const file = await open(path, "r");
    try {
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
      await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      // Only return classified, fixed guidance; never forward raw diagnostic logs.
      return antigravityFailure(buffer.toString("utf8"));
    } finally { await file.close(); }
  } catch { return null; }
}
