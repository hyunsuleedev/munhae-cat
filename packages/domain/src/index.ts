import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";

export function createId(): string {
  return uuidv7();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function codepointCount(text: string): number {
  return Array.from(text).length;
}

export function sliceCodepoints(text: string, from: number, to: number): string {
  return Array.from(text).slice(from, to).join("");
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type VersionState = "draft" | "confirmed" | "rejected" | "superseded";

export const VERSION_UI = {
  draft: "작업안",
  confirmed: "확정",
  rejected: "제외됨",
  superseded: "변경 이력",
} as const;

export function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

/** Canonical JSON: recursively sorted keys, no extra whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function canonicalJsonHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export class MunhaeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MunhaeError";
    this.code = code;
  }
}

export function joinBlockTranslations(translations: string[]): string {
  return translations.join(" ");
}

export function blockTargetRanges(translations: string[]): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  for (let i = 0; i < translations.length; i += 1) {
    const len = codepointCount(translations[i] ?? "");
    ranges.push({ from: cursor, to: cursor + len });
    cursor += len;
    if (i < translations.length - 1) cursor += 1;
  }
  return ranges;
}
