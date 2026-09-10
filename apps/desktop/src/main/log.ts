/**
 * Main-process logger. Never pass source text, translations, or prompt bodies.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

let logFile: string | null = null;
export function initFileLogging(directory: string): void {
  try { mkdirSync(directory, { recursive: true }); logFile = join(directory, "main.log"); }
  catch { logFile = null; }
}

import { redactSecrets } from "@munhae/agent-runtime";

export function redact(text: string): string {
  return redactSecrets(text);
}

function serialize(value: unknown): string {
  if (typeof value === "string") return redact(value);
  if (value instanceof Error) {
    return redact(value.stack ?? value.message);
  }
  try {
    return redact(JSON.stringify(value));
  } catch {
    return "[unserializable]";
  }
}

function write(level: "info" | "warn" | "error", message: string, extra?: unknown): void {
  const line = extra === undefined ? redact(message) : `${redact(message)} ${serialize(extra)}`;
  if (logFile) {
    try {
      try { if (statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, `${logFile}.previous`); } catch { /* First run. */ }
      appendFileSync(logFile, `${new Date().toISOString()} ${level} ${line.slice(0, 16000)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch { /* Logging must not prevent startup or saving work. */ }
  }
  if (level === "error") {
    console.error("[munhae]", line);
  } else if (level === "warn") {
    console.warn("[munhae]", line);
  } else {
    console.log("[munhae]", line);
  }
}

export const log = {
  info(message: string, extra?: unknown): void {
    write("info", message, extra);
  },
  warn(message: string, extra?: unknown): void {
    write("warn", message, extra);
  },
  error(message: string, extra?: unknown): void {
    write("error", message, extra);
  },
};
