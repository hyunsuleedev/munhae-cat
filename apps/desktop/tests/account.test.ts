import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountStorage, type SecretStorageEncryption } from "../src/main/auth-storage";
import { AccountService, throwAccountError } from "../src/main/account-service";
import { accountCredentials, accountEmail, accountPassword, accountSignUp, accountVerification } from "../src/main/auth-validation";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
function file(): string { const dir = mkdtempSync(join(tmpdir(), "munhae-account-test-")); dirs.push(dir); return join(dir, "account.enc"); }
function encryption(available = true, backend = "keychain"): SecretStorageEncryption {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString: (data) => {
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString();
    },
  };
}

describe("device-only account session storage", () => {
  it("encrypts persisted sessions, restores them and removes them on logout", () => {
    const path = file(); const crypto = encryption();
    const first = new AccountStorage(path, crypto);
    first.setItem("auth", "a-sensitive-refresh-token");
    expect(readFileSync(path).includes(Buffer.from("a-sensitive-refresh-token"))).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const restored = new AccountStorage(path, crypto);
    expect(restored.getItem("auth")).toBe("a-sensitive-refresh-token");
    restored.removeItem("auth");
    expect(new AccountStorage(path, crypto).getItem("auth")).toBeNull();
  });
  it.each([[false, "unknown"], [true, "basic_text"]] as const)("never falls back to plaintext (%s, %s)", (available, backend) => {
    const path = file(); const crypto = encryption(available, backend);
    const storage = new AccountStorage(path, crypto);
    storage.setItem("auth", "temporary-session");
    expect(storage.persistent).toBe(false);
    expect(storage.getItem("auth")).toBe("temporary-session");
    expect(() => readFileSync(path)).toThrow();
    expect(new AccountStorage(path, crypto).getItem("auth")).toBeNull();
  });
  it("starts signed out when encrypted data is corrupt or belongs to another OS key", () => {
    const path = file();
    new AccountStorage(path, encryption()).setItem("auth", "secret");
    expect(new AccountStorage(path, encryption()).getItem("auth")).toBeNull();
    writeFileSync(path, "corrupt");
    expect(new AccountStorage(path, encryption()).getItem("auth")).toBeNull();
  });
});

describe("account input boundary", () => {
  it("rejects caller-controlled roles, identities and backend URLs", () => {
    const base = { email: "reader@example.com", password: "a-valid-password", displayName: "번역가" };
    for (const extra of [{ role: "admin" }, { userId: "another-user" }, { url: "https://other.invalid" }]) {
      expect(() => accountSignUp({ ...base, ...extra })).toThrow();
    }
    expect(accountSignUp(base)).toEqual(base);
  });
  it("preserves password whitespace while trimming email and name", () => {
    expect(accountCredentials({ email: " reader@example.com ", password: " secret " })).toEqual({ email: "reader@example.com", password: " secret " });
    expect(accountSignUp({ email: "reader@example.com", password: " long-secret ", displayName: " 번역가 " }).displayName).toBe("번역가");
  });
  it.each(["", "bad", "a@b", "a b@example.com"])("rejects malformed email %s", (value) => { expect(() => accountEmail(value)).toThrow(); });
  it("requires a new password of at least eight characters", () => {
    expect(() => accountPassword({ password: "short" })).toThrow();
    expect(accountPassword({ password: "long-secret" }).password).toBe("long-secret");
  });
  it("only permits signup or recovery codes, including the official eight-digit code", () => {
    expect(accountVerification({ email: "a@example.com", code: "12345678", purpose: "recovery" }).code).toBe("12345678");
    expect(() => accountVerification({ email: "a@example.com", code: "12345678", purpose: "invite" })).toThrow();
    expect(() => accountVerification({ email: "a@example.com", code: "not-a-code", purpose: "signup" })).toThrow();
  });
});

const session = {
  access_token: "access-secret", refresh_token: "refresh-secret", token_type: "bearer", expires_in: 3600,
  user: { id: "user-id", email: "reader@example.com", email_confirmed_at: "2026-09-05T00:00:00Z", user_metadata: { display_name: "번역가", private: "not-for-renderer" } },
} as unknown as Session;

function serviceFixture(active: Session | null = session) {
  let listener: (event: string, data: Session | null) => void = () => undefined;
  const auth = {
    onAuthStateChange: vi.fn((callback) => { listener = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; }),
    getSession: vi.fn(async () => ({ data: { session: active }, error: null as { code: string } | null })),
    getUser: vi.fn(async () => ({ data: { user: active?.user ?? null }, error: null as { status?: number; name?: string } | null })),
    signInWithPassword: vi.fn(async () => ({ data: { session }, error: null })),
    setSession: vi.fn(async () => ({ data: { session }, error: null })),
    signUp: vi.fn(async () => ({ data: { session: null, user: session.user }, error: null })),
    verifyOtp: vi.fn(async () => ({ data: { session }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    resend: vi.fn(async () => ({ error: null })),
    resetPasswordForEmail: vi.fn(async () => ({ error: null })),
    updateUser: vi.fn(async () => ({ data: { user: session.user }, error: null })),
    stopAutoRefresh: vi.fn(),
  };
  const storage = new AccountStorage(file(), encryption(false));
  const service = new AccountService(auth as unknown as SupabaseClient["auth"], storage);
  return { service, auth, storage, event: (event: string) => listener(event, active) };
}

describe("official account flow", () => {
  it("verifies restored sessions against the server and shares concurrent startup checks", async () => {
    const { service, auth } = serviceFixture();
    const results = await Promise.all([service.getState(), service.getState()]);
    expect(results.every((state) => state.status === "signed_in")).toBe(true);
    expect(auth.getUser).toHaveBeenCalledExactlyOnceWith(session.access_token);
  });
  it("does not call the server when there is no stored session", async () => {
    const { service, auth } = serviceFixture(null);
    expect((await service.getState()).status).toBe("signed_out");
    expect(auth.getUser).not.toHaveBeenCalled();
  });
  it("returns to sign-in when restoring an expired session cannot refresh it", async () => {
    const { service, auth } = serviceFixture();
    auth.getSession.mockResolvedValue({ data: { session: null }, error: { code: "refresh_token_not_found" } });
    expect((await service.getState()).status).toBe("signed_out");
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(auth.getUser).not.toHaveBeenCalled();
  });
  it("rejects a restored session whose account was removed or disabled", async () => {
    const { service, auth } = serviceFixture();
    auth.getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
    expect((await service.getState()).status).toBe("signed_out");
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("keeps persisted credentials on a network failure and allows a retry", async () => {
    const { service, auth } = serviceFixture();
    auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthRetryableFetchError" } });
    await expect(service.getState()).rejects.toMatchObject({ code: "auth_network_error" });
    expect(auth.signOut).not.toHaveBeenCalled();
    expect((await service.getState()).status).toBe("signed_in");
  });
  it("exposes only a user summary to IPC, never access/refresh tokens or arbitrary metadata", async () => {
    const { service } = serviceFixture();
    const state = await service.getState();
    expect(state.status).toBe("signed_in");
    expect(state.user?.displayName).toBe("번역가");
    expect(JSON.stringify(state)).not.toMatch(/access-secret|refresh-secret|not-for-renderer/);
  });
  it("keeps signup pending until email verification", async () => {
    const { service, auth } = serviceFixture(null);
    const result = await service.signUp({ email: "reader@example.com", password: "long-password", displayName: "번역가" });
    expect(result.confirmationRequired).toBe(true);
    expect(result.state.status).toBe("signed_out");
    expect(auth.signUp.mock.calls[0]).toEqual([{ email: "reader@example.com", password: "long-password", options: { data: { display_name: "번역가" } } }]);
  });
  it("signs out only this device", async () => {
    const { service, auth } = serviceFixture();
    expect((await service.signOut()).status).toBe("signed_out");
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("requires the current password outside a verified recovery flow", async () => {
    const { service, auth } = serviceFixture();
    await expect(service.updatePassword({ password: "new-password" })).rejects.toMatchObject({ code: "current_password_required" });
    expect(auth.updateUser).not.toHaveBeenCalled();
    await service.updatePassword({ password: "new-password", currentPassword: "old-password" });
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "reader@example.com", password: "old-password" });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "new-password" });
  });
  it("accepts a recovery OTP, preserves recovery on restored sessions and ends it after password update", async () => {
    const { service, auth, storage, event } = serviceFixture();
    const result = await service.verifyCode({ email: "reader@example.com", code: "12345678", purpose: "recovery" });
    expect(result.status).toBe("password_recovery");
    expect(auth.verifyOtp).toHaveBeenCalledWith({ email: "reader@example.com", token: "12345678", type: "recovery" });
    event("SIGNED_IN");
    expect((await service.getState()).status).toBe("password_recovery");
    const restored = new AccountService(auth as unknown as SupabaseClient["auth"], storage);
    expect((await restored.getState()).status).toBe("password_recovery");
    expect((await service.updatePassword({ password: "new-password" })).status).toBe("signed_in");
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
  it("does not grant recovery privileges to an ordinary signup verification", async () => {
    const { service } = serviceFixture();
    expect((await service.verifyCode({ email: "reader@example.com", code: "12345678", purpose: "signup" })).status).toBe("signed_in");
    await expect(service.updatePassword({ password: "new-password" })).rejects.toMatchObject({ code: "current_password_required" });
  });
  it("accepts a Google session without carrying over password-recovery privileges", async () => {
    const { service, auth } = serviceFixture();
    await service.verifyCode({ email: "reader@example.com", code: "12345678", purpose: "recovery" });
    expect((await service.acceptGoogleSession({ access_token: "access", refresh_token: "refresh" })).status).toBe("signed_in");
    expect(auth.setSession).toHaveBeenCalledWith({ access_token: "access", refresh_token: "refresh" });
    await expect(service.updatePassword({ password: "new-password" })).rejects.toMatchObject({ code: "current_password_required" });
  });
  it("uses Google profile names and exposes only recognized identity providers", async () => {
    const active = { ...session, user: { ...session.user, user_metadata: { full_name: "Google Reader", picture: "private-image" }, identities: [{ provider: "google" }, { provider: "unknown-provider" }] } } as unknown as Session;
    const { service } = serviceFixture(active);
    const result = await service.getState();
    expect(result.user?.displayName).toBe("Google Reader");
    expect(result.user?.providers).toEqual(["google"]);
    expect(JSON.stringify(result)).not.toContain("private-image");
  });
  it("does not expose raw provider errors that might contain credentials", () => {
    expect(() => throwAccountError({ code: "unknown-provider-error", message: "access_token=secret" })).toThrow("계정 요청을 완료하지 못했습니다");
    expect(() => throwAccountError({ code: "invalid_credentials" })).toThrow("이메일 또는 비밀번호");
    expect(() => throwAccountError({ name: "AuthRetryableFetchError" })).toThrow("인터넷 연결");
  });
});
