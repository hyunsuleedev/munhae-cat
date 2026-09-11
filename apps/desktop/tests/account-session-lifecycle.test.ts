import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { AccountService } from "../src/main/account-service";
import type { AccountStorage } from "../src/main/auth-storage";

const START = Date.parse("2026-09-08T12:00:00Z");
const INITIAL = {
  access_token: "test-access", refresh_token: "test-refresh", token_type: "bearer",
  expires_in: 3600, expires_at: START / 1000 + 3600,
  user: { id: "reader", email: "reader@example.invalid", user_metadata: { display_name: "Reader", private: "private-metadata" } },
} as Session;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(initial: Session | null = INITIAL) {
  let active = initial;
  let listener: (event: string, session: Session | null) => void = () => undefined;
  const notify = vi.fn();
  const unsubscribe = vi.fn();
  const auth = {
    onAuthStateChange: (callback: typeof listener) => {
      listener = callback;
      return { data: { subscription: { unsubscribe } } };
    },
    getSession: vi.fn(async () => ({ data: { session: active }, error: null })),
    getUser: vi.fn(async () => ({ data: { user: active?.user ?? null }, error: null as { status?: number; name?: string } | null })),
    signOut: vi.fn(async () => { active = null; return { error: null }; }),
    signInWithPassword: vi.fn(async () => ({ data: { session: INITIAL }, error: null })),
    setSession: vi.fn(async () => ({ data: { session: INITIAL }, error: null })),
    verifyOtp: vi.fn(async () => ({ data: { session: INITIAL }, error: null })),
    updateUser: vi.fn(async () => ({ data: { user: INITIAL.user }, error: null })),
    stopAutoRefresh: vi.fn(),
  };
  const storage = { persistent: false, getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() } as unknown as AccountStorage;
  const service = new AccountService(auth as unknown as SupabaseClient["auth"], storage, notify);
  return {
    service, auth, notify, unsubscribe, storage,
    session: () => active,
    emit: (event: string, session = active) => { active = session; listener(event, session); },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("main-owned account session lifecycle", () => {
  it("restores and verifies once, then serves all page reads without a TTL or further auth requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const f = fixture();
    const results = await Promise.all([f.service.getState(), f.service.getState()]);
    expect(results.every((state) => state.status === "signed_in")).toBe(true);
    vi.setSystemTime(START + 24 * 60 * 60 * 1000);
    await f.service.getState();
    await f.service.getState();
    expect(f.auth.getSession).toHaveBeenCalledOnce();
    expect(f.auth.getUser).toHaveBeenCalledExactlyOnceWith(INITIAL.access_token);
    expect(f.notify).toHaveBeenCalledOnce();
    expect(JSON.stringify(results)).not.toMatch(/test-access|test-refresh|private-metadata/);
  });

  it("does not trust INITIAL_SESSION or the SDK's startup SIGNED_IN before remote verification", async () => {
    const f = fixture();
    const verification = deferred<Awaited<ReturnType<typeof f.auth.getUser>>>();
    f.auth.getUser.mockImplementationOnce(() => verification.promise);
    f.emit("INITIAL_SESSION");
    f.emit("SIGNED_IN");
    expect(f.notify).not.toHaveBeenCalled();
    const ready = f.service.getState();
    await Promise.resolve();
    f.emit("INITIAL_SESSION");
    expect(f.notify).not.toHaveBeenCalled();
    verification.resolve({ data: { user: INITIAL.user }, error: null });
    expect((await ready).status).toBe("signed_in");
    expect(f.auth.getUser).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it("retries a failed initial verification without accepting a later stored-session event as proof", async () => {
    const f = fixture();
    f.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthRetryableFetchError" } });
    await expect(f.service.getState()).rejects.toMatchObject({ code: "auth_network_error" });
    f.emit("INITIAL_SESSION");
    f.emit("SIGNED_IN");
    expect(f.notify).not.toHaveBeenCalled();
    expect((await f.service.getState()).status).toBe("signed_in");
    expect(f.auth.getUser).toHaveBeenCalledTimes(2);
    expect(f.auth.signOut).not.toHaveBeenCalled();
  });

  it("restores an empty session once and later accepts SDK sign-in without another network check", async () => {
    const f = fixture(null);
    expect((await f.service.getState()).status).toBe("signed_out");
    await f.service.getState();
    f.emit("SIGNED_IN", INITIAL);
    expect((await f.service.getState()).status).toBe("signed_in");
    expect(f.auth.getSession).toHaveBeenCalledOnce();
    expect(f.auth.getUser).not.toHaveBeenCalled();
  });

  it("uses SDK refresh and user events without briefly signing out or repeating unchanged notifications", async () => {
    const f = fixture();
    await f.service.getState();
    f.notify.mockClear();
    f.emit("TOKEN_REFRESHED", { ...INITIAL, access_token: "refreshed-access" });
    f.emit("TOKEN_REFRESHED", null);
    expect((await f.service.getState()).status).toBe("signed_in");
    expect(f.notify).not.toHaveBeenCalled();
    f.emit("USER_UPDATED", { ...INITIAL, user: { ...INITIAL.user, user_metadata: { display_name: "Updated" } } });
    expect((await f.service.getState()).user?.displayName).toBe("Updated");
    expect(f.notify).toHaveBeenCalledOnce();
    f.emit("SIGNED_OUT", null);
    expect((await f.service.getState()).status).toBe("signed_out");
    expect(f.auth.getSession).toHaveBeenCalledOnce();
    expect(f.auth.getUser).toHaveBeenCalledOnce();
  });

  it("tracks recovery events and clears recovery only after a successful password update", async () => {
    const f = fixture();
    await f.service.getState();
    f.emit("PASSWORD_RECOVERY");
    expect((await f.service.getState()).status).toBe("password_recovery");
    f.auth.updateUser.mockImplementationOnce(async () => {
      f.emit("USER_UPDATED", INITIAL);
      expect((await f.service.getState()).status).toBe("password_recovery");
      return { data: { user: INITIAL.user }, error: null };
    });
    expect((await f.service.updatePassword({ password: "replacement" })).status).toBe("signed_in");
    expect(f.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(f.auth.getUser).toHaveBeenCalledOnce();
  });

  it("publishes the OTP's final recovery state without a transient signed-in event", async () => {
    const f = fixture(null);
    await f.service.getState();
    f.notify.mockClear();
    f.auth.verifyOtp.mockImplementationOnce(async () => {
      f.emit("SIGNED_IN", INITIAL);
      f.emit("PASSWORD_RECOVERY", INITIAL);
      expect(f.notify).not.toHaveBeenCalled();
      return { data: { session: INITIAL }, error: null };
    });
    expect((await f.service.verifyCode({ email: "reader@example.invalid", token: "123456", purpose: "recovery" })).status).toBe("password_recovery");
    expect(f.notify.mock.calls.map(([state]) => state.status)).toEqual(["password_recovery"]);
    expect((await f.service.getState()).status).toBe("password_recovery");
  });

  it("publishes managed login, Google login and logout results even when the SDK emits no event", async () => {
    const f = fixture(null);
    await f.service.getState();
    await f.service.signIn({ email: "reader@example.invalid", password: "password" });
    expect((await f.service.getState()).status).toBe("signed_in");
    await f.service.verifyCode({ email: "reader@example.invalid", token: "123456", purpose: "recovery" });
    await f.service.acceptGoogleSession({ access_token: "google-access", refresh_token: "google-refresh" });
    expect((await f.service.getState()).status).toBe("signed_in");
    await f.service.signOut();
    expect((await f.service.getState()).status).toBe("signed_out");
    expect(f.auth.getSession).toHaveBeenCalledOnce();
    expect(f.auth.getUser).not.toHaveBeenCalled();
  });

  it("preserves the established session on a failed managed auth request", async () => {
    const f = fixture();
    await f.service.getState();
    f.auth.signInWithPassword.mockRejectedValueOnce(new Error("offline"));
    await expect(f.service.signIn({ email: "reader@example.invalid", password: "password" })).rejects.toThrow("offline");
    expect((await f.service.getState()).status).toBe("signed_in");
    expect(f.auth.getUser).toHaveBeenCalledOnce();
  });

  it("does not overwrite logout with late initial verification", async () => {
    const f = fixture();
    const verification = deferred<Awaited<ReturnType<typeof f.auth.getUser>>>();
    f.auth.getUser.mockImplementationOnce(() => verification.promise);
    const ready = f.service.getState();
    await Promise.resolve();
    await f.service.signOut();
    verification.resolve({ data: { user: INITIAL.user }, error: null });
    expect((await ready).status).toBe("signed_out");
    expect(f.notify.mock.calls.every(([state]) => state.status === "signed_out")).toBe(true);
  });

  it("does not use a getSession result obtained before SDK logout", async () => {
    const f = fixture();
    const restoration = deferred<Awaited<ReturnType<typeof f.auth.getSession>>>();
    f.auth.getSession.mockImplementationOnce(() => restoration.promise);
    const ready = f.service.getState();
    f.emit("SIGNED_OUT", null);
    restoration.resolve({ data: { session: INITIAL }, error: null });
    expect((await ready).status).toBe("signed_out");
    expect(f.auth.getUser).not.toHaveBeenCalled();
  });

  it.each(["signIn", "recovery"])("does not resurrect logout from late %s results or events", async (operation) => {
    const f = fixture(null);
    await f.service.getState();
    const result = deferred<Awaited<ReturnType<typeof f.auth.signInWithPassword>>>();
    f.auth.signInWithPassword.mockImplementationOnce(() => result.promise);
    f.auth.verifyOtp.mockImplementationOnce(() => result.promise);
    const pending = operation === "signIn"
      ? f.service.signIn({ email: "reader@example.invalid", password: "password" })
      : f.service.verifyCode({ email: "reader@example.invalid", token: "123456", purpose: "recovery" });
    const rejected = expect(pending).rejects.toMatchObject({ code: "auth_request_superseded" });
    await Promise.resolve();
    const logout = f.service.signOut();
    expect(f.auth.signOut).not.toHaveBeenCalled();
    f.emit(operation === "signIn" ? "SIGNED_IN" : "PASSWORD_RECOVERY", INITIAL);
    result.resolve({ data: { session: INITIAL }, error: null });
    await rejected;
    await logout;
    expect((await f.service.getState()).status).toBe("signed_out");
    expect(f.session()).toBeNull();
    expect(f.notify.mock.calls.every(([state]) => state.status === "signed_out")).toBe(true);
  });

  it("does not let an older logout result replace a newer successful sign-in", async () => {
    const f = fixture();
    await f.service.getState();
    const result = deferred<Awaited<ReturnType<typeof f.auth.signOut>>>();
    f.auth.signOut.mockImplementationOnce(() => result.promise);
    const pending = f.service.signOut();
    const rejected = expect(pending).rejects.toMatchObject({ code: "auth_request_superseded" });
    await Promise.resolve();
    const login = f.service.signIn({ email: "reader@example.invalid", password: "password" });
    expect(f.auth.signInWithPassword).not.toHaveBeenCalled();
    f.emit("SIGNED_OUT", null);
    result.resolve({ error: null });
    await rejected;
    await login;
    expect((await f.service.getState()).status).toBe("signed_in");
  });

  it("does not restore an old session while the first managed login is in flight", async () => {
    const f = fixture();
    const result = deferred<Awaited<ReturnType<typeof f.auth.signInWithPassword>>>();
    f.auth.signInWithPassword.mockImplementationOnce(() => result.promise);
    const login = f.service.signIn({ email: "reader@example.invalid", password: "password" });
    const ready = f.service.getState();
    expect(f.auth.getSession).not.toHaveBeenCalled();
    result.resolve({ data: { session: INITIAL }, error: null });
    await login;
    expect((await ready).status).toBe("signed_in");
    expect(f.auth.getSession).not.toHaveBeenCalled();
    expect(f.auth.getUser).not.toHaveBeenCalled();
  });

  it("stops listening and prevents late async work from publishing after disposal", async () => {
    const f = fixture();
    const verification = deferred<Awaited<ReturnType<typeof f.auth.getUser>>>();
    f.auth.getUser.mockImplementationOnce(() => verification.promise);
    const pending = f.service.getState();
    const rejected = expect(pending).rejects.toMatchObject({ code: "auth_not_ready" });
    await Promise.resolve();
    f.service.dispose();
    f.emit("SIGNED_IN", INITIAL);
    verification.resolve({ data: { user: INITIAL.user }, error: null });
    await rejected;
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.auth.stopAutoRefresh).toHaveBeenCalledOnce();
  });
});
