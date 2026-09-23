import Stripe from 'stripe';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  assertPrice, BillingError, isBlockingSubscription, readBillingConfig, statusFromRows, stripeId,
  type BillingConfig, type BillingStatus, type SubscriptionProjection,
} from './billing-domain.ts';

export { Stripe };
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

export type CustomerRow = {
  user_id: string;
  stripe_customer_id: string | null;
  customer_operation_id: string;
  customer_started_at: string | null;
  checkout_attempt_id: string | null;
  checkout_attempt_created_at: string | null;
  checkout_session_id: string | null;
};

export function createServices(env: (key: string) => string | undefined) {
  const config = readBillingConfig(env);
  const url = env('SUPABASE_URL');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new BillingError('BILLING_UNAVAILABLE');
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const stripe = config ? new Stripe(config.secretKey, {
    apiVersion: STRIPE_API_VERSION, httpClient: Stripe.createFetchHttpClient(), timeout: 15_000, maxNetworkRetries: 1,
  }) : null;
  return { config, db, stripe };
}

export class BillingService {
  constructor(public db: SupabaseClient, public stripe: Stripe, public config: BillingConfig) {}

  async validateConfiguration(action: 'checkout' | 'portal' | 'status' | 'webhook' = 'checkout') {
    const [account, price] = await Promise.all([
      this.stripe.accounts.retrieve(null), this.stripe.prices.retrieve(this.config.priceId),
    ]);
    if (account.id !== this.config.accountId) throw new BillingError('BILLING_ACCOUNT_MISMATCH');
    assertPrice(price, this.config, action === 'checkout');
    // Portal changes or an archived Price must not stop existing subscriptions'
    // cancellation/payment events from being projected.
    if (action === 'webhook' || action === 'status') return;
    const portal = await this.stripe.billingPortal.configurations.retrieve(this.config.portalConfigurationId);
    if (!portal.active || portal.livemode !== this.config.livemode || portal.metadata?.application !== 'munhae' ||
        !portal.features.subscription_cancel.enabled || portal.features.subscription_cancel.mode !== 'at_period_end' ||
        !portal.features.payment_method_update.enabled || !portal.features.invoice_history.enabled ||
        portal.features.subscription_update.enabled) throw new BillingError('BILLING_PORTAL_INVALID');
  }

  async status(userId: string): Promise<BillingStatus> {
    const { data, error } = await this.db.from('billing_subscriptions').select('*')
      .eq('user_id', userId).eq('stripe_account_id', this.config.accountId).eq('livemode', this.config.livemode)
      .eq('stripe_price_id', this.config.priceId);
    if (error) throw new BillingError('BILLING_STORAGE_UNAVAILABLE');
    return statusFromRows(data as SubscriptionProjection[], true);
  }

  private scope(userId: string, token: string) {
    return { p_user_id: userId, p_account_id: this.config.accountId, p_livemode: this.config.livemode, p_lease_token: token };
  }

  async withCustomer<T>(userId: string, operation: (row: CustomerRow, token: string) => Promise<T>): Promise<T> {
    const token = crypto.randomUUID();
    const { data, error } = await this.db.rpc('acquire_billing_customer', this.scope(userId, token));
    if (error) throw new BillingError('BILLING_STORAGE_UNAVAILABLE');
    if (!data) throw new BillingError('BILLING_BUSY', 409);
    try { return await operation(data as CustomerRow, token); }
    finally {
      // On release failure the lease expires; never hide the successful operation.
      const { error: releaseError } = await this.db.rpc('release_billing_customer', this.scope(userId, token));
      if (releaseError) console.error('billing: lease release failed');
    }
  }

  private async patchCustomer(userId: string, token: string, patch: Record<string, unknown>): Promise<CustomerRow> {
    const { data, error } = await this.db.from('billing_customers').update({ ...patch, updated_at: new Date().toISOString() })
      .eq('user_id', userId).eq('stripe_account_id', this.config.accountId).eq('livemode', this.config.livemode)
      .eq('lease_token', token).gt('lease_expires_at', new Date().toISOString()).select('*').single();
    if (error || !data) throw new BillingError('BILLING_LEASE_LOST');
    return data as CustomerRow;
  }

  private async ensureStripeCustomer(row: CustomerRow, token: string): Promise<CustomerRow> {
    if (row.stripe_customer_id) {
      const customer = await this.stripe.customers.retrieve(row.stripe_customer_id);
      if (customer.deleted || customer.livemode !== this.config.livemode ||
          customer.metadata.application !== 'munhae' || customer.metadata.supabase_user_id !== row.user_id) {
        throw new BillingError('BILLING_CUSTOMER_REVIEW_REQUIRED');
      }
      return row;
    }
    if (!row.customer_started_at) {
      row = await this.patchCustomer(row.user_id, token, { customer_started_at: new Date().toISOString() });
    }
    // Stripe idempotency keys are retained for at least 24h. If the database lost
    // an earlier successful response, require reconciliation instead of creating
    // a second customer after that guarantee expires.
    if (Date.now() - Date.parse(row.customer_started_at!) > 23 * 60 * 60 * 1000) {
      throw new BillingError('BILLING_CUSTOMER_REVIEW_REQUIRED');
    }
    const customer = await this.stripe.customers.create({
      metadata: { application: 'munhae', supabase_user_id: row.user_id },
    }, { idempotencyKey: `munhae-customer-${this.config.accountId}-${this.config.livemode}-${row.customer_operation_id}` });
    if (customer.livemode !== this.config.livemode) throw new BillingError('BILLING_MODE_MISMATCH');
    return this.patchCustomer(row.user_id, token, { stripe_customer_id: customer.id });
  }

  async checkout(userId: string): Promise<{ url: string }> {
    return this.withCustomer(userId, async (initialRow, token) => {
      let row = await this.ensureStripeCustomer(initialRow, token);
      for await (const subscription of this.stripe.subscriptions.list({ customer: row.stripe_customer_id!, status: 'all', limit: 100 })) {
        if ((subscription.metadata.application === 'munhae' || subscription.items.data.some((item) => item.price.id === this.config.priceId)) && isBlockingSubscription(subscription.status)) {
          throw new BillingError('SUBSCRIPTION_EXISTS', 409);
        }
      }
      if (row.checkout_session_id) {
        const session = await this.stripe.checkout.sessions.retrieve(row.checkout_session_id, { expand: ['line_items'] });
        if (stripeId(session.customer) !== row.stripe_customer_id || session.livemode !== this.config.livemode ||
            session.mode !== 'subscription' || session.metadata?.application !== 'munhae' ||
            session.metadata.supabase_user_id !== userId || session.client_reference_id !== userId) throw new BillingError('BILLING_SESSION_MISMATCH');
        if (session.status === 'open' && (session.line_items?.has_more || session.line_items?.data.length !== 1 ||
            session.line_items.data[0].price?.id !== this.config.priceId || session.line_items.data[0].quantity !== 1)) {
          throw new BillingError('BILLING_SESSION_MISMATCH');
        }
        if (session.status === 'open' && session.url) return { url: session.url };
        if (session.status === 'complete') {
          const subscriptionId = stripeId(session.subscription);
          if (!subscriptionId) throw new BillingError('SUBSCRIPTION_PENDING', 409);
          const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
          if (isBlockingSubscription(subscription.status)) throw new BillingError('SUBSCRIPTION_EXISTS', 409);
        }
        row = await this.patchCustomer(userId, token, { checkout_attempt_id: null, checkout_attempt_created_at: null, checkout_session_id: null });
      }
      if (!row.checkout_attempt_id) {
        row = await this.patchCustomer(userId, token, { checkout_attempt_id: crypto.randomUUID(), checkout_attempt_created_at: new Date().toISOString() });
      }
      // An unknown result is retried with identical parameters and the same key.
      // After 23h, manual reconciliation is safer than silently double charging.
      const started = Math.floor(Date.parse(row.checkout_attempt_created_at!) / 1000);
      if (Date.now() / 1000 - started > 23 * 60 * 60) throw new BillingError('BILLING_CHECKOUT_REVIEW_REQUIRED');
      const session = await this.stripe.checkout.sessions.create({
        mode: 'subscription', customer: row.stripe_customer_id!,
        line_items: [{ price: this.config.priceId, quantity: 1 }],
        client_reference_id: userId,
        metadata: { application: 'munhae', supabase_user_id: userId },
        subscription_data: { billing_mode: { type: 'flexible' }, metadata: { application: 'munhae', supabase_user_id: userId } },
        success_url: `${this.config.siteUrl}/billing/?checkout=success`,
        cancel_url: `${this.config.siteUrl}/billing/?checkout=cancelled`,
        expires_at: started + 60 * 60,
        // Keep direct Billing and fixed KRW pricing even if the account defaults
        // new Checkout Sessions to Managed Payments (which requires FX pricing).
        managed_payments: { enabled: false },
        adaptive_pricing: { enabled: false },
        locale: 'ko',
      }, { idempotencyKey: `munhae-checkout-${this.config.accountId}-${this.config.livemode}-${row.checkout_attempt_id}` });
      await this.patchCustomer(userId, token, { checkout_session_id: session.id });
      if (!session.url) throw new BillingError('BILLING_SESSION_UNAVAILABLE');
      return { url: session.url };
    });
  }

  async portal(userId: string): Promise<{ url: string }> {
    const { data, error } = await this.db.from('billing_customers').select('stripe_customer_id')
      .eq('user_id', userId).eq('stripe_account_id', this.config.accountId).eq('livemode', this.config.livemode).maybeSingle();
    if (error) throw new BillingError('BILLING_STORAGE_UNAVAILABLE');
    if (!data?.stripe_customer_id) throw new BillingError('BILLING_CUSTOMER_NOT_FOUND', 409);
    const customer = await this.stripe.customers.retrieve(data.stripe_customer_id);
    if (customer.deleted || customer.livemode !== this.config.livemode ||
        customer.metadata.application !== 'munhae' || customer.metadata.supabase_user_id !== userId) throw new BillingError('BILLING_CUSTOMER_REVIEW_REQUIRED');
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customer.id, configuration: this.config.portalConfigurationId, return_url: `${this.config.siteUrl}/billing/`,
    });
    return { url: session.url };
  }

  async webhook(event: Stripe.Event): Promise<void> {
    if (event.livemode !== this.config.livemode || (event.account && event.account !== this.config.accountId)) {
      throw new BillingError('BILLING_EVENT_SCOPE_MISMATCH', 400);
    }
    const object = event.data.object as unknown as Record<string, unknown>;
    let subscriptionId: string | null = null;
    if (event.type.startsWith('customer.subscription.')) subscriptionId = stripeId(object);
    else if (['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type)) {
      subscriptionId = stripeId(object.subscription);
    } else if (['invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.marked_uncollectible', 'invoice.voided', 'invoice.finalized'].includes(event.type)) {
      // Invoice parent is the current API shape; the fallback accepts old signed
      // snapshot versions during a webhook endpoint upgrade.
      const parent = object.parent as { subscription_details?: { subscription?: unknown } } | null;
      subscriptionId = stripeId(parent?.subscription_details?.subscription) || stripeId(object.subscription);
    }
    if (!subscriptionId) return;
    const customerId = stripeId(object.customer);
    if (!customerId) throw new BillingError('BILLING_EVENT_CUSTOMER_MISSING', 400);
    const { data: existing, error: receiptError } = await this.db.from('billing_webhook_events').select('stripe_event_id')
      .eq('stripe_account_id', this.config.accountId).eq('livemode', this.config.livemode).eq('stripe_event_id', event.id).maybeSingle();
    if (receiptError) throw new BillingError('BILLING_STORAGE_UNAVAILABLE');
    if (existing) return;
    const { data: customer, error } = await this.db.from('billing_customers').select('user_id')
      .eq('stripe_account_id', this.config.accountId).eq('livemode', this.config.livemode).eq('stripe_customer_id', customerId).maybeSingle();
    if (error) throw new BillingError('BILLING_STORAGE_UNAVAILABLE');
    if (!customer) return; // Other products/accounts' customers do not belong to Munhae.
    await this.withCustomer(customer.user_id, async (row, token) => {
      const latest = await this.stripe.subscriptions.retrieve(subscriptionId!);
      if (stripeId(latest.customer) !== row.stripe_customer_id || latest.livemode !== this.config.livemode) throw new BillingError('BILLING_SUBSCRIPTION_MISMATCH');
      const item = latest.items.data.find((entry) => entry.price.id === this.config.priceId);
      const eligible = item && latest.items.data.length === 1 && !latest.items.has_more && item.quantity === 1 &&
        latest.metadata.application === 'munhae' && latest.metadata.supabase_user_id === row.user_id;
      let projection: SubscriptionProjection | { revoke_subscription_id: string; stripe_customer_id: string };
      if (!eligible) {
        const { data: tracked, error: trackedError } = await this.db.from('billing_subscriptions').select('stripe_subscription_id')
          .eq('user_id', row.user_id).eq('stripe_account_id', this.config.accountId).eq('livemode', this.config.livemode)
          .eq('stripe_subscription_id', latest.id).maybeSingle();
        if (trackedError) throw new BillingError('BILLING_STORAGE_UNAVAILABLE');
        if (!tracked) return;
        // A previously valid subscription can be moved to another product in the
        // Dashboard. Revoke its old entitlement in the same receipt transaction.
        projection = { revoke_subscription_id: latest.id, stripe_customer_id: row.stripe_customer_id! };
      } else projection = {
        stripe_subscription_id: latest.id, stripe_customer_id: row.stripe_customer_id!, stripe_price_id: item.price.id,
        status: latest.status,
        current_period_end: item.current_period_end
          ? new Date(Math.min(item.current_period_end, latest.cancel_at ?? item.current_period_end) * 1000).toISOString() : null,
        // Flexible Billing's portal sets cancel_at instead of cancel_at_period_end.
        // Normalize a cancellation within this paid period for the app contract.
        cancel_at_period_end: latest.cancel_at_period_end || Boolean(latest.cancel_at && latest.cancel_at <= item.current_period_end),
      };
      const { error: commitError } = await this.db.rpc('commit_billing_webhook', {
        ...this.scope(row.user_id, token), p_event_id: event.id, p_event_type: event.type,
        p_event_created_at: new Date(event.created * 1000).toISOString(), p_projection: projection,
      });
      if (commitError) throw new BillingError('BILLING_STORAGE_UNAVAILABLE');
    });
  }
}
