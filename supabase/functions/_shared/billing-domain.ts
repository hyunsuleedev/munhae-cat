export type BillingStatus = {
  plan: 'free' | 'premium';
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  configured: boolean;
};

export class BillingError extends Error {
  constructor(public code: string, public httpStatus = 503) { super(code); }
}

export type BillingConfig = {
  secretKey: string;
  webhookSecret: string;
  accountId: string;
  livemode: boolean;
  priceId: string;
  portalConfigurationId: string;
  siteUrl: string;
  allowedOrigins: Set<string>;
};

export function readBillingConfig(env: (key: string) => string | undefined): BillingConfig | null {
  const secretKey = env('STRIPE_SECRET_KEY');
  const webhookSecret = env('STRIPE_WEBHOOK_SECRET');
  const accountId = env('STRIPE_ACCOUNT_ID');
  const mode = env('STRIPE_MODE');
  const priceId = env('STRIPE_PREMIUM_PRICE_ID');
  const portalConfigurationId = env('STRIPE_PORTAL_CONFIGURATION_ID');
  if (!secretKey || !webhookSecret || !accountId || !mode || !priceId || !portalConfigurationId) return null;
  if (!['test', 'live'].includes(mode) || !accountId.startsWith('acct_') ||
      !priceId.startsWith('price_') || !portalConfigurationId.startsWith('bpc_') ||
      !secretKey.startsWith(mode === 'live' ? 'sk_live_' : 'sk_test_')) {
    throw new BillingError('BILLING_CONFIGURATION_INVALID');
  }
  const site = new URL(env('BILLING_SITE_URL') || 'https://munhaestudio.com');
  if (site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/' || site.search || site.hash) {
    throw new BillingError('BILLING_CONFIGURATION_INVALID');
  }
  const allowedOrigins = new Set([site.origin]);
  for (const origin of (env('BILLING_ALLOWED_ORIGINS') || '').split(',').filter(Boolean)) {
    const url = new URL(origin.trim());
    const localTest = mode === 'test' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((!localTest && url.protocol !== 'https:') || url.origin !== origin.trim()) throw new BillingError('BILLING_CONFIGURATION_INVALID');
    allowedOrigins.add(url.origin);
  }
  return { secretKey, webhookSecret, accountId, livemode: mode === 'live', priceId, portalConfigurationId, siteUrl: site.origin, allowedOrigins };
}

export function corsHeaders(request: Request, allowedOrigins: Set<string>): Record<string, string> {
  const origin = request.headers.get('origin');
  // Electron's authenticated main-process fetch has no Origin. Opaque browser origins are rejected.
  if (origin && !allowedOrigins.has(origin)) throw new BillingError('ORIGIN_NOT_ALLOWED', 403);
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

export function parseAction(body: unknown): 'status' | 'checkout' | 'portal' {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'action')) throw new BillingError('INVALID_REQUEST', 400);
  const action = (body as { action?: unknown }).action;
  if (action !== 'status' && action !== 'checkout' && action !== 'portal') throw new BillingError('INVALID_ACTION', 400);
  return action;
}

export function assertPrice(price: {
  id: string; active: boolean; livemode: boolean; currency: string; unit_amount: number | null;
  type: string; billing_scheme: string; tax_behavior?: string | null; metadata: Record<string, string>;
  recurring: { interval: string; interval_count: number; usage_type: string } | null;
}, config: BillingConfig, requireActive = true): void {
  if (price.id !== config.priceId || (requireActive && !price.active) || price.livemode !== config.livemode ||
      price.currency !== 'krw' || price.unit_amount !== 19000 || price.type !== 'recurring' ||
      price.billing_scheme !== 'per_unit' || price.tax_behavior !== 'inclusive' || price.metadata.application !== 'munhae' ||
      price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed') {
    throw new BillingError('BILLING_PRICE_INVALID');
  }
}

export type SubscriptionProjection = {
  stripe_subscription_id: string;
  stripe_customer_id: string;
  stripe_price_id: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export function statusFromRows(rows: SubscriptionProjection[], configured: boolean, now = Date.now()): BillingStatus {
  const active = rows.filter((row) => ['active', 'trialing'].includes(row.status) &&
    row.current_period_end && Date.parse(row.current_period_end) > now);
  const sorted = [...(active.length ? active : rows)].sort((a, b) =>
    Date.parse(b.current_period_end || '1970-01-01') - Date.parse(a.current_period_end || '1970-01-01'));
  const row = sorted[0];
  return { plan: active.length ? 'premium' : 'free', status: row?.status ?? null,
    currentPeriodEnd: row?.current_period_end ?? null, cancelAtPeriodEnd: row?.cancel_at_period_end ?? false, configured };
}

export function isBlockingSubscription(status: string): boolean {
  return !['canceled', 'incomplete_expired'].includes(status);
}

export function stripeId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value.id;
  return null;
}
