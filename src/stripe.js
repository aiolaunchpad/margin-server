/**
 * Stripe webhook verification without the SDK (scheme v1: HMAC-SHA256 of `${t}.${rawBody}`).
 * The route is inert (404) unless STRIPE_WEBHOOK_SECRET is set. No charges are ever created here.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!header || !secret) return false;
  const parts = Object.create(null);
  const v1 = [];
  for (const kv of String(header).split(',')) {
    const [k, v] = kv.split('=');
    if (k === 'v1') v1.push(v); else if (k && v) parts[k.trim()] = v.trim();
  }
  const t = Number(parts.t);
  if (!t || !v1.length) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expect = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return v1.some((sig) => {
    const got = Buffer.from(String(sig || ''), 'hex');
    return got.length === expect.length && timingSafeEqual(got, expect);
  });
}

export function signStripePayload(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

/** Apply a verified event to the store. Returns a short description for logs. */
export async function applyStripeEvent(event, store) {
  const obj = event?.data?.object || {};
  switch (event?.type) {
    case 'checkout.session.completed': {
      const iid = obj.client_reference_id;
      if (!iid) return 'ignored: no client_reference_id';
      await store.setPlan(iid, 'pro', { stripeCustomerId: obj.customer || undefined, stripeSubscriptionId: obj.subscription || undefined });
      return `pro: ${iid.slice(0, 6)}…`;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const iid = (await store.findInstallBySubscription(obj.id)) || obj.metadata?.install_id;
      if (!iid) return 'ignored: unknown subscription';
      const active = event.type === 'customer.subscription.updated' && ['active', 'trialing', 'past_due'].includes(obj.status);
      await store.setPlan(iid, active ? 'pro' : 'free', { stripeSubscriptionId: obj.id });
      return `${active ? 'pro' : 'free'}: ${iid.slice(0, 6)}…`;
    }
    default:
      return `ignored: ${event?.type}`;
  }
}
