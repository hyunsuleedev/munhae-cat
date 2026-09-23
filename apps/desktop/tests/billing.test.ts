import { describe, expect, it, vi } from "vitest";
import type { AuthChangeEvent, Session, SupabaseClient } from "@supabase/supabase-js";
import { BillingService, stripeBillingUrl } from "../src/main/billing";
import { AuthenticatedClientAccess } from "../src/main/authenticated-client";
import type { AccountState, BillingStatus } from "../src/shared/munhae-api";

const status: BillingStatus = { plan: "premium", status: "active", currentPeriodEnd: "2026-10-22T12:00:00Z", cancelAtPeriodEnd: false, configured: true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const token = (sessionId: string) => `header.${Buffer.from(JSON.stringify({ sub: "account-a", session_id: sessionId })).toString("base64url")}.test`;
  const initial = { access_token: token("session-a"), user: { id: "account-a" } } as Session;
  let active: Session | null = initial;
  let listener = (_event: AuthChangeEvent, _session: Session | null) => undefined as void;
  const readState = (): AccountState => ({ status: active ? "signed_in" : "signed_out", persistence: "memory", user: active ? { id: active.user.id, email: "reader@example.invalid", displayName: "Reader", providers: ["email"], emailConfirmedAt: null } : null });
  const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(JSON.stringify(status), { headers: { "Content-Type": "application/json" } }));
  const access = new AuthenticatedClientAccess({ getState: async () => readState() }, {
    getSession: async () => ({ data: { session: active }, error: null }),
    onAuthStateChange: (callback: typeof listener) => { listener = callback; return { data: { subscription: { unsubscribe() {} } } }; },
  } as unknown as SupabaseClient["auth"], { url: "https://project.example.invalid", publishableKey: "sb_publishable_test", fetch: fetcher });
  const open = vi.fn(async (_url: string) => undefined);
  const service = new BillingService(action => access.run(action), id => access.assertAuthenticatedUser(id), open);
  return { service, access, fetcher, open, changeAccount() { active = null; listener("SIGNED_OUT", null); }, newSession() { active = { ...initial, access_token: token("session-b") }; listener("SIGNED_IN", active); } };
}

describe("Stripe hosted page boundary", () => {
  it("accepts only the exact action's HTTPS Stripe hostname", () => {
    expect(stripeBillingUrl("https://checkout.stripe.com/c/pay/cs_test_123#fragment", "checkout")).toBe("https://checkout.stripe.com/c/pay/cs_test_123#fragment");
    expect(stripeBillingUrl("https://billing.stripe.com/p/session/test", "portal")).toBe("https://billing.stripe.com/p/session/test");
    for (const value of [
      "http://checkout.stripe.com/pay", "https://checkout.stripe.com.evil.invalid/pay",
      "https://checkout.stripe.com@evil.invalid/pay", "https://user:pass@checkout.stripe.com/pay",
      "https://checkout.stripe.com:443/pay", "https://checkout.stripe.com:8443/pay",
      "https://checkout.stripe.com./pay", "https://checkout%2estripe.com/pay",
      "https://checkout.stripe.com\\@evil.invalid/pay", " https://checkout.stripe.com/pay",
      "https://checkout.stripe.com/\npath", "https://billing.stripe.com/p/session/test", null,
    ]) expect(() => stripeBillingUrl(value, "checkout")).toThrow();
  });
});

describe("main process billing", () => {
  it("invokes billing with the fixed current-user credential and returns only the status contract", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...status, stripeCustomerId: "cus_secret" }), { headers: { "Content-Type": "application/json" } }));
    try {
      expect(await f.service.getStatus()).toEqual(status);
      const [url, init] = f.fetcher.mock.calls[0]!;
      expect(String(url)).toBe("https://project.example.invalid/functions/v1/billing");
      expect(JSON.parse(String(init?.body))).toEqual({ action: "status" });
      expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Bearer header\./);
      expect(f.open).not.toHaveBeenCalled();
    } finally { f.access.dispose(); }
  });

  it("opens the checkout in main without returning its sensitive URL to the renderer", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/test" }), { headers: { "Content-Type": "application/json" } }));
    try {
      expect(await f.service.open("checkout")).toBeUndefined();
      expect(f.open).toHaveBeenCalledExactlyOnceWith("https://checkout.stripe.com/c/pay/test");
    } finally { f.access.dispose(); }
  });

  it.each(["logout", "same-account new session"])("never opens an old response after %s", async change => {
    const f = fixture();
    const response = deferred<Response>();
    const started = deferred<void>();
    f.fetcher.mockImplementationOnce(async () => { started.resolve(); return response.promise; });
    const pending = f.service.open("checkout");
    const rejected = expect(pending).rejects.toMatchObject({ code: "auth_request_superseded" });
    await started.promise;
    if (change === "logout") f.changeAccount(); else f.newSession();
    response.resolve(new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/old-session" }), { headers: { "Content-Type": "application/json" } }));
    try { await rejected; expect(f.open).not.toHaveBeenCalled(); }
    finally { f.access.dispose(); }
  });

  it("rejects malformed status and provider failures without leaking their response", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ plan: "premium" }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response("sk_secret_provider_failure", { status: 500 }));
    try {
      await expect(f.service.getStatus()).rejects.toMatchObject({ code: "billing_unavailable" });
      await expect(f.service.open("portal")).rejects.toMatchObject({ code: "billing_unavailable", message: "결제 정보를 확인하지 못했습니다. 잠시 후 다시 시도하세요." });
      expect(f.open).not.toHaveBeenCalled();
    } finally { f.access.dispose(); }
  });

  it("exposes only allowlisted actionable server error codes", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: "SUBSCRIPTION_EXISTS", message: "provider-secret" }), { status: 409, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "provider-secret", message: "sensitive detail" }), { status: 503, headers: { "Content-Type": "application/json" } }));
    try {
      await expect(f.service.open("checkout")).rejects.toMatchObject({ code: "SUBSCRIPTION_EXISTS", message: "이미 구독이 있습니다. 새로고침하거나 구독 관리를 열어 주세요." });
      await expect(f.service.open("checkout")).rejects.toMatchObject({ code: "billing_unavailable", message: "결제 정보를 확인하지 못했습니다. 잠시 후 다시 시도하세요." });
      expect(f.open).not.toHaveBeenCalled();
    } finally { f.access.dispose(); }
  });
});
