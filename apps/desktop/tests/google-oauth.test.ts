import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GoogleOAuth } from "../src/main/google-oauth";
import { MUNHAE_SUPABASE_URL } from "../src/main/auth-config";
import type { AccountState } from "../src/shared/munhae-api";
import { get } from "node:http";

const flows: GoogleOAuth[] = [];
afterEach(() => flows.splice(0).forEach((flow) => flow.dispose()));
const state: AccountState = { status: "signed_in", persistence: "encrypted", user: { id: "reader", email: "reader@example.com", displayName: "Reader", emailConfirmedAt: "2026-09-05", providers: ["google"] } };
function fixture(options: { timeoutMs?: number; url?: string; exchange?: () => Promise<unknown>; openError?: boolean } = {}) {
  let ready: (url: string) => void = () => undefined;
  const opened = new Promise<string>((resolve) => { ready = resolve; });
  let redirect = "";
  const auth = {
    signInWithOAuth: vi.fn(async (input) => {
      redirect = input.options.redirectTo;
      return { data: { url: options.url ?? `${MUNHAE_SUPABASE_URL}/auth/v1/authorize?provider=google` }, error: null };
    }),
    exchangeCodeForSession: vi.fn(options.exchange ?? (async () => ({ data: { session: { access_token: "supabase-access", refresh_token: "supabase-refresh", provider_token: "private-google-token" } }, error: null }))),
  };
  const acceptSession = vi.fn(async () => state);
  const onComplete = vi.fn();
  const openBrowser = vi.fn(async () => { if (options.openError) throw new Error("browser-failed"); ready(redirect); });
  const flow = new GoogleOAuth({
    createAuth: () => auth as unknown as SupabaseClient["auth"],
    openBrowser, acceptSession, onComplete, timeoutMs: options.timeoutMs ?? 5_000,
  });
  flows.push(flow);
  return { flow, auth, acceptSession, onComplete, openBrowser, opened };
}

describe("Google sign-in browser callback", () => {
  it("binds to a random loopback address and retains only the Supabase session after exchange", async () => {
    const f = fixture(); const result = f.flow.start(); const redirect = await f.opened;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/google\/callback\/[a-f0-9]{64}$/);
    expect(f.auth.signInWithOAuth).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: redirect, skipBrowserRedirect: true, scopes: "openid email profile", queryParams: { prompt: "select_account" } } });
    const response = await fetch(`${redirect}?code=one-time-code`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("로그인되었습니다");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await result).toEqual(state);
    expect(f.auth.exchangeCodeForSession).toHaveBeenCalledWith("one-time-code");
    expect(f.acceptSession).toHaveBeenCalledWith({ access_token: "supabase-access", refresh_token: "supabase-refresh" });
    expect(f.onComplete).toHaveBeenCalledOnce();
  });
  it("rejects a different path, Host, HTTP method and repeated codes without consuming the attempt", async () => {
    const f = fixture(); const result = f.flow.start(); const redirect = await f.opened;
    expect((await fetch(new URL("/auth/google/callback/wrong-state?code=one-time-code", redirect))).status).toBe(404);
    const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${redirect}?code=one-time-code`, { headers: { Host: "untrusted.invalid" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    expect(wrongHostStatus).toBe(404);
    expect((await fetch(`${redirect}?code=one-time-code`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${redirect}?code=one-time-code&code=second-code`)).status).toBe(400);
    expect(f.auth.exchangeCodeForSession).not.toHaveBeenCalled();
    await fetch(`${redirect}?code=one-time-code`); await result;
    expect(f.auth.exchangeCodeForSession).toHaveBeenCalledOnce();
  });
  it("supports denial and never reflects provider-controlled errors into HTML", async () => {
    const f = fixture(); const outcome = f.flow.start().catch((error) => error); const redirect = await f.opened;
    const response = await fetch(`${redirect}?error=access_denied&error_description=%3Cscript%3Eprivate%3C/script%3E`);
    expect(await response.text()).not.toContain("private");
    expect(await outcome).toMatchObject({ code: "oauth_cancelled" });
    expect(f.acceptSession).not.toHaveBeenCalled();
  });
  it("handles fragment-only errors without forwarding tokens from the browser", async () => {
    const f = fixture(); const outcome = f.flow.start().catch((error) => error); const redirect = await f.opened;
    const response = await fetch(redirect); const body = await response.text();
    expect(response.headers.get("content-security-policy")).toContain("script-src 'sha256-");
    expect(body).toContain("location.hash");
    expect(body).not.toContain("access_token");
    await fetch(`${redirect}?error=invalid_callback`);
    expect(await outcome).toMatchObject({ code: "oauth_failed" });
  });
  it("cancels and closes the listener, then allows a fresh attempt", async () => {
    const f = fixture(); const outcome = f.flow.start().catch((error) => error); const redirect = await f.opened;
    await expect(f.flow.start()).rejects.toMatchObject({ code: "oauth_in_progress" });
    expect(f.flow.cancel()).toBe(true);
    expect(await outcome).toMatchObject({ code: "oauth_cancelled" });
    await expect(fetch(`${redirect}?code=one-time-code`)).rejects.toThrow();
    expect(f.flow.cancel()).toBe(false);
    const next = f.flow.start().catch((error) => error);
    expect(f.flow.cancel()).toBe(true);
    expect(await next).toMatchObject({ code: "oauth_cancelled" });
    expect(f.acceptSession).not.toHaveBeenCalled();
  });
  it("expires an abandoned browser login", async () => {
    const f = fixture({ timeoutMs: 25 });
    await expect(f.flow.start()).rejects.toMatchObject({ code: "oauth_timeout" });
    expect(f.acceptSession).not.toHaveBeenCalled();
  });
  it("rejects an unexpected authorization origin before opening a browser", async () => {
    const f = fixture({ url: "https://attacker.invalid/auth/v1/authorize?provider=google" });
    await expect(f.flow.start()).rejects.toMatchObject({ code: "oauth_invalid_url" });
    expect(f.openBrowser).not.toHaveBeenCalled();
  });
  it("cleans up when the browser cannot open", async () => {
    const f = fixture({ openError: true });
    await expect(f.flow.start()).rejects.toThrow("browser-failed");
    expect(f.flow.cancel()).toBe(false);
  });
  it("does not accept an exchange that finishes after app shutdown", async () => {
    let resolveExchange: (data: unknown) => void = () => undefined;
    const exchange = new Promise((resolve) => { resolveExchange = resolve; });
    const f = fixture({ exchange: () => exchange });
    const outcome = f.flow.start().catch((error) => error); const redirect = await f.opened;
    const response = fetch(`${redirect}?code=one-time-code`);
    await vi.waitFor(() => expect(f.auth.exchangeCodeForSession).toHaveBeenCalledOnce());
    expect(() => f.flow.cancel()).toThrow("로그인을 완료하고 있습니다");
    f.flow.dispose();
    resolveExchange({ data: { session: { access_token: "discard", refresh_token: "discard" } }, error: null });
    expect((await response).status).toBe(410);
    expect(await outcome).toMatchObject({ code: "oauth_cancelled" });
    expect(f.acceptSession).not.toHaveBeenCalled();
  });
});
