import { BillingError } from '../_shared/billing-domain.ts';
import { BillingService, createServices, Stripe } from '../_shared/billing-service.ts';

export async function handleStripeWebhook(request: Request, services = () => createServices((key) => Deno.env.get(key))): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  try {
    const { config, db, stripe } = services();
    if (!config || !stripe) throw new BillingError('BILLING_NOT_CONFIGURED');
    const signature = request.headers.get('stripe-signature');
    if (!signature) throw new BillingError('INVALID_SIGNATURE', 400);
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(await request.text(), signature, config.webhookSecret,
        undefined, Stripe.createSubtleCryptoProvider());
    } catch { throw new BillingError('INVALID_SIGNATURE', 400); }
    const service = new BillingService(db, stripe, config);
    await service.validateConfiguration('webhook');
    await service.webhook(event);
    return Response.json({ received: true });
  } catch (error) {
    const known = error instanceof BillingError;
    console.error('stripe-webhook:', known ? error.code : 'BILLING_UNAVAILABLE');
    // Retry all transient/lease errors. A receipt is saved only with its projection.
    return Response.json({ error: known ? error.code : 'BILLING_UNAVAILABLE' },
      { status: known && error.httpStatus === 400 ? 400 : 503 });
  }
}

if (import.meta.main) Deno.serve((request) => handleStripeWebhook(request));
