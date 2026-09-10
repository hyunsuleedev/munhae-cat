export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) {
      if (code === "ENOENT") return "not_found";
      return code;
    }
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("project_locked") || message.includes("locked")) {
      return "project_locked";
    }
    if (message.includes("not found") || message.includes("enoent")) {
      return "not_found";
    }
  }
  return "internal";
}
