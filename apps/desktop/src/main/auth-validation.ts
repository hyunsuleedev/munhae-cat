import type { AccountCredentials, AccountPasswordInput, AccountSignUpInput, AccountVerifyInput } from "../shared/munhae-api";
import { AppError } from "./errors";

function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new AppError("invalid_payload", "계정 요청 형식이 올바르지 않습니다.");
  }
  return value as Record<string, unknown>;
}

export function accountEmail(value: unknown): string {
  if (typeof value !== "string" || value.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new AppError("invalid_email", "올바른 이메일 주소를 입력하세요.");
  }
  return value.trim();
}

function password(value: unknown, creating: boolean): string {
  if (typeof value !== "string" || value.length > 256 || value.includes("\0") || value.length < (creating ? 8 : 1)) {
    throw new AppError("weak_password", creating ? "비밀번호는 8자 이상, 256자 이하로 입력하세요." : "비밀번호를 입력하세요.");
  }
  return value;
}

export function accountCredentials(value: unknown): AccountCredentials {
  const input = record(value, ["email", "password"]);
  return { email: accountEmail(input.email), password: password(input.password, false) };
}

export function accountSignUp(value: unknown): AccountSignUpInput {
  const input = record(value, ["email", "password", "displayName"]);
  if (typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.trim().length > 80) {
    throw new AppError("invalid_name", "이름은 1자 이상, 80자 이하로 입력하세요.");
  }
  return { email: accountEmail(input.email), password: password(input.password, true), displayName: input.displayName.trim() };
}

export function accountVerification(value: unknown): AccountVerifyInput {
  const input = record(value, ["email", "code", "purpose"]);
  if (typeof input.code !== "string" || !/^\d{6,10}$/.test(input.code.trim())
    || (input.purpose !== "signup" && input.purpose !== "recovery")) {
    throw new AppError("invalid_code", "이메일로 받은 인증번호를 입력하세요.");
  }
  return { email: accountEmail(input.email), code: input.code.trim(), purpose: input.purpose };
}

export function accountPassword(value: unknown): AccountPasswordInput {
  const input = record(value, ["password", "currentPassword"]);
  return { password: password(input.password, true), ...(input.currentPassword !== undefined ? { currentPassword: password(input.currentPassword, false) } : {}) };
}
