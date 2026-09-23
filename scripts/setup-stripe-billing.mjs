#!/usr/bin/env node
// Uses the authenticated Stripe CLI. Defaults to read-only test inspection.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  account: { type: 'string' }, profile: { type: 'string', default: 'default' },
  live: { type: 'boolean', default: false }, apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });
if (values.help || !/^acct_[A-Za-z0-9]+$/.test(values.account ?? '')) {
  console.log('Usage: node scripts/setup-stripe-billing.mjs --account acct_... [--profile name] [--live] [--apply]\nDefaults to read-only TEST mode. --live explicitly selects LIVE resources. Never creates a customer, subscription, or charge.');
  process.exit(values.help ? 0 : 1);
}

function stripe(method, path, params = {}, idempotency) {
  const args = [method, path, '--project-name', values.profile, ...(values.live ? ['--live'] : [])];
  for (const [key, value] of Object.entries(params)) args.push('-d', `${key}=${value}`);
  if (idempotency) args.push('--idempotency', idempotency);
  const result = spawnSync('stripe', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  let body;
  try { body = JSON.parse(result.stdout); } catch { throw new Error('Stripe CLI request failed. Verify the selected CLI profile with stripe login.'); }
  if (result.status !== 0 || body.error) throw new Error(`Stripe request failed (${body.error?.code ?? body.error?.type ?? result.status}).`);
  return body;
}

try {
  // Do not allow an inherited environment key to silently change CLI mode/account.
  if (process.env.STRIPE_API_KEY) throw new Error('Unset STRIPE_API_KEY; this script uses the explicit Stripe CLI profile and explicitly selected mode.');
  const account = stripe('get', '/v1/account');
  if (account.id !== values.account) throw new Error(`Account mismatch: profile belongs to ${account.id}. No changes made.`);
  const balance = stripe('get', '/v1/balance');
  if (balance.livemode !== values.live) throw new Error('Stripe mode does not match the explicitly selected mode. No changes made.');
  if (values.live && !account.charges_enabled) throw new Error('Live charges are not enabled for this account. No changes made.');
  const lookup = 'munhae_premium_krw_monthly_19000_v1';
  const productId = 'munhae_premium';
  const prices = stripe('get', '/v1/prices', { 'lookup_keys[]': lookup, limit: 10 });
  let price = prices.data?.[0];
  if (price && (price.livemode !== values.live || !price.active || price.currency !== 'krw' || price.unit_amount !== 19000
    || price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1 || price.product !== productId
    || price.metadata?.application !== 'munhae' || price.tax_behavior !== 'inclusive')) {
    throw new Error('Existing price does not match the expected Munhae price. No changes made.');
  }
  console.log(JSON.stringify({ account: account.id, mode: values.live ? 'live' : 'test', amount: 19000, currency: 'krw', interval: 'month', existingPrice: price?.id ?? null, apply: values.apply }));
  if (!values.apply) process.exit(0);
  if (!price) {
    const products = stripe('get', '/v1/products', { 'ids[]': productId });
    const product = products.data?.[0];
    if (product && (product.livemode !== values.live || !product.active || product.metadata?.application !== 'munhae')) {
      throw new Error('Existing product ID is not the expected active Munhae product.');
    }
    if (!product) stripe('post', '/v1/products', {
      id: productId, name: '문해 Premium', description: '문해 프리미엄 월 구독',
      url: 'https://munhaestudio.com', 'metadata[application]': 'munhae',
    }, `munhae-product-v1-${account.id}`);
    price = stripe('post', '/v1/prices', {
      product: productId, currency: 'krw', unit_amount: 19000,
      'recurring[interval]': 'month', 'recurring[interval_count]': 1,
      lookup_key: lookup, tax_behavior: 'inclusive', 'metadata[application]': 'munhae',
    }, `munhae-price-v1-${account.id}`);
    if (price.livemode !== values.live) throw new Error('Unexpected resource mode; stop setup and inspect CLI configuration.');
  }
  // A dedicated configuration avoids changing another product's default Portal.
  const configurations = stripe('get', '/v1/billing_portal/configurations', { limit: 100 });
  let portal = configurations.data?.find(item => item.active && item.livemode === values.live && item.metadata?.application === 'munhae');
  if (portal && (portal.features?.subscription_cancel?.mode !== 'at_period_end'
    || !portal.features?.subscription_cancel?.enabled || !portal.features?.invoice_history?.enabled
    || !portal.features?.payment_method_update?.enabled || portal.features?.subscription_update?.enabled)) {
    throw new Error('Existing Munhae portal configuration differs from the expected cancellation/invoice settings.');
  }
  if (!portal) portal = stripe('post', '/v1/billing_portal/configurations', {
    'business_profile[headline]': '문해 구독 관리', default_return_url: 'https://munhaestudio.com/billing/',
    'features[invoice_history][enabled]': true, 'features[payment_method_update][enabled]': true,
    'features[subscription_cancel][enabled]': true, 'features[subscription_cancel][mode]': 'at_period_end',
    'features[subscription_cancel][proration_behavior]': 'none',
    'features[subscription_update][enabled]': false, 'metadata[application]': 'munhae',
  }, `munhae-portal-v1-${account.id}`);
  console.log(JSON.stringify({ STRIPE_ACCOUNT_ID: account.id, STRIPE_MODE: values.live ? 'live' : 'test',
    STRIPE_PREMIUM_PRICE_ID: price.id, STRIPE_PORTAL_CONFIGURATION_ID: portal.id,
    BILLING_SITE_URL: 'https://munhaestudio.com',
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
