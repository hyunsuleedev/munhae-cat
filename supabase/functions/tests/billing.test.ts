import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertPrice, corsHeaders, parseAction, readBillingConfig, statusFromRows, type SubscriptionProjection } from '../_shared/billing-domain.ts';
import { BillingService, Stripe, type CustomerRow } from '../_shared/billing-service.ts';
import { handleBilling } from '../billing/index.ts';
import { handleStripeWebhook } from '../stripe-webhook/index.ts';

const config = readBillingConfig((key) => ({
  STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_MODE: 'test',
  STRIPE_ACCOUNT_ID: 'acct_munhae', STRIPE_PREMIUM_PRICE_ID: 'price_premium', STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_munhae',
})[key])!;
const userId = '00000000-0000-4000-8000-000000000001';
const validPrice = { id: 'price_premium', active: true, livemode: false, currency: 'krw', unit_amount: 19000,
  type: 'recurring', billing_scheme: 'per_unit', tax_behavior: 'inclusive', metadata: { application: 'munhae' },
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } };
const projection: SubscriptionProjection = { stripe_subscription_id: 'sub_munhae', stripe_customer_id: 'cus_munhae',
  stripe_price_id: 'price_premium', status: 'active', current_period_end: '2030-01-01T00:00:00Z', cancel_at_period_end: false };

Deno.test('server configuration is closed until every required value is configured', () => {
  assert.equal(readBillingConfig(() => undefined), null);
  assert.equal(config.livemode, false);
  assert.equal(config.siteUrl, 'https://munhaestudio.com');
});

Deno.test('client cannot select user/customer/price/return URL or forge plan', () => {
  assert.equal(parseAction({ action: 'checkout' }), 'checkout');
  for (const key of ['userId', 'customer', 'priceId', 'returnUrl', 'plan']) {
    assert.throws(() => parseAction({ action: 'checkout', [key]: 'forged' }), /INVALID_REQUEST/);
  }
  assert.throws(() => parseAction({ action: 'setPremium' }), /INVALID_ACTION/);
});

Deno.test('CORS accepts exact website/no-origin Electron and rejects opaque or attacker origins', () => {
  assert.equal(corsHeaders(new Request('https://edge/billing'), config.allowedOrigins)['Access-Control-Allow-Origin'], undefined);
  assert.equal(corsHeaders(new Request('https://edge/billing', { headers: { origin: config.siteUrl } }), config.allowedOrigins)['Access-Control-Allow-Origin'], config.siteUrl);
  for (const origin of ['null', 'https://munhaestudio.com.evil.test', 'https://evil.test']) {
    assert.throws(() => corsHeaders(new Request('https://edge/billing', { headers: { origin } }), config.allowedOrigins), /ORIGIN_NOT_ALLOWED/);
  }
});

Deno.test('Price validates amount/currency/period/mode/application/tax exactly', () => {
  assertPrice(validPrice, config);
  for (const patch of [{ unit_amount: 1900 }, { currency: 'usd' }, { livemode: true }, { active: false },
    { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } },
    { metadata: { application: 'coukey' } }, { tax_behavior: 'exclusive' }]) {
    assert.throws(() => assertPrice({ ...validPrice, ...patch }, config), /BILLING_PRICE_INVALID/);
  }
  assertPrice({ ...validPrice, active: false }, config, false);
});

Deno.test('Premium derives from active/trialing and unexpired server projection only', () => {
  assert.equal(statusFromRows([projection], true).plan, 'premium');
  assert.equal(statusFromRows([{ ...projection, cancel_at_period_end: true }], true).plan, 'premium');
  for (const status of ['past_due', 'unpaid', 'canceled', 'incomplete', 'paused']) {
    assert.equal(statusFromRows([{ ...projection, status }], true).plan, 'free');
  }
  assert.equal(statusFromRows([{ ...projection, current_period_end: '2020-01-01' }], true).plan, 'free');
  assert.equal(statusFromRows([{ ...projection, current_period_end: null }], true).plan, 'free');
});

function fixture() {
  let row: CustomerRow = { user_id: userId, stripe_customer_id: 'cus_munhae', customer_operation_id: 'op_fixture',
    customer_started_at: null, checkout_attempt_id: null, checkout_attempt_created_at: null, checkout_session_id: null };
  let eventRecorded = false, tracked = false, busy = false, commitError = false;
  const calls: { name: string; args: unknown[] }[] = [];
  const subscriptions: Record<string, unknown>[] = [];
  const subscription = { id: 'sub_munhae', customer: 'cus_munhae', livemode: false, status: 'active', cancel_at_period_end: false, cancel_at: null as number | null,
    metadata: { application: 'munhae', supabase_user_id: userId },
    items: { has_more: false, data: [{ price: { id: 'price_premium' }, quantity: 1, current_period_end: 1893456000 }] } };
  const session = { id: 'cs_fixture', url: 'https://checkout.stripe.com/c/pay/fixture', status: 'open', customer: 'cus_munhae',
    livemode: false, mode: 'subscription', client_reference_id: userId, metadata: { application: 'munhae', supabase_user_id: userId },
    subscription: 'sub_munhae', line_items: { has_more: false, data: [{ price: { id: 'price_premium' }, quantity: 1 }] } };
  const stripe = new Stripe('sk_test_fixture');
  stripe.accounts.retrieve = (() => Promise.resolve({ id: 'acct_munhae' })) as unknown as typeof stripe.accounts.retrieve;
  stripe.prices.retrieve = (() => Promise.resolve(validPrice)) as unknown as typeof stripe.prices.retrieve;
  stripe.billingPortal.configurations.retrieve = (() => Promise.resolve({ active: true, livemode: false,
    metadata: { application: 'munhae' }, features: { subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: { enabled: false }, payment_method_update: { enabled: true }, invoice_history: { enabled: true } },
  })) as unknown as typeof stripe.billingPortal.configurations.retrieve;
  stripe.customers.retrieve = (() => Promise.resolve({ id: 'cus_munhae', livemode: false,
    metadata: { application: 'munhae', supabase_user_id: userId } })) as unknown as typeof stripe.customers.retrieve;
  stripe.subscriptions.list = (() => ({ async *[Symbol.asyncIterator]() { for (const entry of subscriptions) yield entry; } })) as unknown as typeof stripe.subscriptions.list;
  stripe.subscriptions.retrieve = (() => { calls.push({ name: 'retrieveSubscription', args: [] }); return Promise.resolve(subscription); }) as unknown as typeof stripe.subscriptions.retrieve;
  stripe.checkout.sessions.retrieve = (() => Promise.resolve(session)) as unknown as typeof stripe.checkout.sessions.retrieve;
  stripe.checkout.sessions.create = ((...args: unknown[]) => { calls.push({ name: 'createCheckout', args }); return Promise.resolve(session); }) as unknown as typeof stripe.checkout.sessions.create;
  stripe.billingPortal.sessions.create = ((...args: unknown[]) => { calls.push({ name: 'createPortal', args }); return Promise.resolve({ url: 'https://billing.stripe.com/p/session/fixture' }); }) as unknown as typeof stripe.billingPortal.sessions.create;
  const db = {
    auth: { getUser: (token: string) => Promise.resolve(token === 'valid' ? { data: { user: { id: userId } }, error: null } : { data: {}, error: 'invalid' }) },
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args: [args] });
      if (name === 'acquire_billing_customer') return Promise.resolve({ data: busy ? null : row, error: null });
      if (name === 'commit_billing_webhook') {
        if (commitError) return Promise.resolve({ error: 'database unavailable' });
        eventRecorded = true;
      }
      return Promise.resolve({ data: true, error: null });
    },
    from: (table: string) => {
      let patch: Record<string, unknown> | null = null;
      const query = {
        select: () => query, eq: () => query, gt: () => query,
        update: (value: Record<string, unknown>) => { patch = value; return query; },
        single: () => { row = { ...row, ...patch }; return Promise.resolve({ data: row, error: null }); },
        maybeSingle: () => Promise.resolve({ data: table === 'billing_webhook_events' ? eventRecorded ? { stripe_event_id: 'evt_fixture' } : null
          : table === 'billing_customers' ? row : tracked ? { stripe_subscription_id: 'sub_munhae' } : null, error: null }),
        then: (resolve: (result: unknown) => void) => resolve({ data: [projection], error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { db, stripe, config, calls, subscriptions, subscription, session, service: new BillingService(db, stripe, config),
    get row() { return row; }, set row(value: CustomerRow) { row = value; },
    set busy(value: boolean) { busy = value; }, set tracked(value: boolean) { tracked = value; }, set commitError(value: boolean) { commitError = value; } };
}

function request(action: string, token = 'valid') {
  return new Request('https://edge/billing', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
}
const event = { id: 'evt_fixture', type: 'customer.subscription.updated', created: 1700000000, livemode: false,
  data: { object: { id: 'sub_munhae', customer: 'cus_munhae', status: 'canceled' } } } as unknown as Stripe.Event;

Deno.test('billing rejects invalid JWT and validates authenticated unconfigured status', async () => {
  const f = fixture();
  assert.equal((await handleBilling(request('checkout', 'invalid'), () => f)).status, 401);
  const response = await handleBilling(request('status'), () => ({ ...f, config: null, stripe: null }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), statusFromRows([], false));
  assert.equal(f.calls.length, 0);
});

Deno.test('checkout rejects concurrent request, existing subscription and another price Munhae subscription', async () => {
  const f = fixture();
  f.busy = true;
  await assert.rejects(f.service.checkout(userId), /BILLING_BUSY/);
  f.busy = false;
  f.subscriptions.push({ ...f.subscription, items: { data: [{ price: { id: 'price_old' } }] } });
  await assert.rejects(f.service.checkout(userId), /SUBSCRIPTION_EXISTS/);
  assert.equal(f.calls.filter((call) => call.name === 'createCheckout').length, 0);
});

Deno.test('checkout fixes price/quantity/flexible billing/URLs and reuses open session', async () => {
  const f = fixture();
  const first = await f.service.checkout(userId);
  const second = await f.service.checkout(userId);
  assert.deepEqual(first, second);
  const creates = f.calls.filter((call) => call.name === 'createCheckout');
  assert.equal(creates.length, 1);
  const params = creates[0].args[0] as Stripe.Checkout.SessionCreateParams;
  assert.deepEqual(params.line_items, [{ price: 'price_premium', quantity: 1 }]);
  assert.equal(params.subscription_data?.billing_mode?.type, 'flexible');
  assert.deepEqual(params.managed_payments, { enabled: false });
  assert.deepEqual(params.adaptive_pricing, { enabled: false });
  assert.equal(params.success_url, 'https://munhaestudio.com/billing/?checkout=success');
  assert.equal(params.cancel_url, 'https://munhaestudio.com/billing/?checkout=cancelled');
  assert.equal(params.subscription_data?.trial_period_days, undefined);
  assert.ok((creates[0].args[1] as { idempotencyKey: string }).idempotencyKey);
});

Deno.test('cancelled complete session allows resubscription; unsafe session price is rejected', async () => {
  const f = fixture();
  f.row = { ...f.row, checkout_session_id: 'cs_old', checkout_attempt_id: 'old', checkout_attempt_created_at: '2020-01-01' };
  f.session.status = 'complete'; f.subscription.status = 'canceled';
  await f.service.checkout(userId);
  assert.notEqual(f.row.checkout_attempt_id, 'old');
  assert.equal(f.calls.filter((call) => call.name === 'createCheckout').length, 1);
  f.session.status = 'open'; f.session.line_items.data[0].price.id = 'price_other';
  await assert.rejects(f.service.checkout(userId), /BILLING_SESSION_MISMATCH/);
});

Deno.test('portal always selects explicit Munhae configuration and verified customer', async () => {
  const f = fixture();
  await f.service.portal(userId);
  assert.deepEqual(f.calls.find((call) => call.name === 'createPortal')?.args[0], {
    customer: 'cus_munhae', configuration: 'bpc_munhae', return_url: 'https://munhaestudio.com/billing/',
  });
});

Deno.test('webhook projects latest Stripe state under lease, not old event body, and deduplicates', async () => {
  const f = fixture();
  await f.service.webhook(event);
  const commit = f.calls.find((call) => call.name === 'commit_billing_webhook')?.args[0] as Record<string, unknown>;
  assert.equal((commit.p_projection as SubscriptionProjection).status, 'active');
  assert.ok(f.calls.findIndex((call) => call.name === 'acquire_billing_customer') < f.calls.findIndex((call) => call.name === 'retrieveSubscription'));
  await f.service.webhook(event);
  assert.equal(f.calls.filter((call) => call.name === 'commit_billing_webhook').length, 1);
});

Deno.test('flexible portal scheduled cancellation and reactivation project correct access end', async () => {
  for (const cancelAt of [1893456000, 1893369600, null]) {
    const f = fixture();
    f.subscription.cancel_at = cancelAt;
    await f.service.webhook(event);
    const commit = f.calls.find((call) => call.name === 'commit_billing_webhook')?.args[0] as Record<string, unknown>;
    const projection = commit.p_projection as SubscriptionProjection;
    assert.equal(projection.cancel_at_period_end, cancelAt !== null);
    assert.equal(projection.current_period_end, new Date((cancelAt ?? 1893456000) * 1000).toISOString());
    assert.equal(projection.status, 'active');
  }
});

Deno.test('webhook isolates live/test/account and ignores other prices unless revoking tracked entitlement', async () => {
  const f = fixture();
  await assert.rejects(f.service.webhook({ ...event, livemode: true }), /BILLING_EVENT_SCOPE_MISMATCH/);
  await assert.rejects(f.service.webhook({ ...event, account: 'acct_other' }), /BILLING_EVENT_SCOPE_MISMATCH/);
  f.subscription.items.data[0].price.id = 'price_other';
  await f.service.webhook(event);
  assert.equal(f.calls.filter((call) => call.name === 'commit_billing_webhook').length, 0);
  f.tracked = true;
  await f.service.webhook(event);
  const commit = f.calls.find((call) => call.name === 'commit_billing_webhook')?.args[0] as Record<string, unknown>;
  assert.deepEqual(commit.p_projection, { revoke_subscription_id: 'sub_munhae', stripe_customer_id: 'cus_munhae' });
});

Deno.test('failed database projection does not acknowledge or mark webhook receipt', async () => {
  const f = fixture(); f.commitError = true;
  await assert.rejects(f.service.webhook(event), /BILLING_STORAGE_UNAVAILABLE/);
  f.commitError = false;
  await f.service.webhook(event);
  assert.equal(f.calls.filter((call) => call.name === 'commit_billing_webhook').length, 2);
});

Deno.test('HTTP webhook verifies raw-body signature and retries transient failures', async () => {
  const f = fixture();
  const body = JSON.stringify(event);
  const signature = await f.stripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret: config.webhookSecret,
    cryptoProvider: Stripe.createSubtleCryptoProvider() });
  const signed = (payload = body) => new Request('https://edge/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': signature }, body: payload });
  assert.equal((await handleStripeWebhook(signed(body + ' '), () => f)).status, 400);
  assert.equal(f.calls.length, 0);
  f.busy = true;
  assert.equal((await handleStripeWebhook(signed(), () => f)).status, 503);
  f.busy = false;
  assert.equal((await handleStripeWebhook(signed(), () => f)).status, 200);
});
