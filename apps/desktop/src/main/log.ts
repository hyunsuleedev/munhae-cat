/**
 * Main-process logger. Never pass source text, translations, or prompt bodies.
 */

const SECRET =
  /Bearer\s+\S+|Authorization:\s*\S+|Cookie:\s*[^\r\n]+|\bsk-[A-Za-z0-9_-]+/gi;

export function redact(text: string): string {
  return text.replace(SECRET, (match) => {
    if (/^Bearer/i.test(match)) return "Bearer [redacted]";
    if (/^Authorization/i.test(match)) return "Authorization: [redacted]";
    if (/^Cookie/i.test(match)) return "Cookie: [redacted]";
    return "[redacted-key]";
  });
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
