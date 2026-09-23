import { BillingError, corsHeaders, parseAction, statusFromRows } from '../_shared/billing-domain.ts';
import { BillingService, createServices } from '../_shared/billing-service.ts';

export async function handleBilling(request: Request, services = () => createServices((key) => Deno.env.get(key))): Promise<Response> {
  let headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  try {
    const { config, db, stripe } = services();
    headers = corsHeaders(request, config?.allowedOrigins ?? new Set(['https://munhaestudio.com']));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') throw new BillingError('METHOD_NOT_ALLOWED', 405);
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1];
    if (!token) throw new BillingError('AUTH_REQUIRED', 401);
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user || data.user.is_anonymous) throw new BillingError('AUTH_REQUIRED', 401);
    let body: unknown;
    try { body = await request.json(); } catch { throw new BillingError('INVALID_REQUEST', 400); }
    const action = parseAction(body);
    if (!config || !stripe) {
      if (action === 'status') return Response.json(statusFromRows([], false), { headers });
      throw new BillingError('BILLING_NOT_CONFIGURED');
    }
    const service = new BillingService(db, stripe, config);
    await service.validateConfiguration(action);
    const response = action === 'status' ? await service.status(data.user.id)
      : action === 'checkout' ? await service.checkout(data.user.id) : await service.portal(data.user.id);
    return Response.json(response, { headers });
  } catch (error) {
    const known = error instanceof BillingError;
    // Never log raw provider errors, request bodies, tokens or customer details.
    console.error('billing:', known ? error.code : 'BILLING_UNAVAILABLE');
    return Response.json({ error: known ? error.code : 'BILLING_UNAVAILABLE' }, { status: known ? error.httpStatus : 503, headers });
  }
}

if (import.meta.main) Deno.serve((request) => handleBilling(request));
