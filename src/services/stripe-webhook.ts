import Stripe from 'stripe';
import { Receipt } from '../domain';

const types = new Set([
  'payment_intent.created', 'payment_intent.processing', 'payment_intent.succeeded',
  'payment_intent.payment_failed', 'payment_intent.canceled',
  'payment_intent.amount_capturable_updated', 'payment_intent.requires_action',
]);

export function verifyReceipt(raw: Buffer, signature: string, secret: string): Receipt {
  const event = Stripe.webhooks.constructEvent(raw, signature, secret);
  if (event.livemode !== false || event.account) throw new Error('Only direct sandbox account events are supported');
  if (typeof event.id !== 'string' || !event.id.startsWith('evt_') || event.id.length > 255) {
    throw new Error('Invalid event ID');
  }
  const object = event.data.object as Stripe.PaymentIntent | Stripe.Charge;
  let paymentId: string | null = null;
  if (types.has(event.type)) {
    if (object.object !== 'payment_intent') throw new Error('Expected PaymentIntent');
    paymentId = object.id;
  } else if (event.type === 'charge.refunded') {
    if (object.object !== 'charge') throw new Error('Expected charge');
    paymentId = typeof object.payment_intent === 'string'
      ? object.payment_intent : object.payment_intent?.id ?? null;
  }
  if (paymentId !== null && (!/^pi_[A-Za-z0-9_]+$/.test(paymentId) || paymentId.length > 255)) {
    throw new Error('Invalid PaymentIntent ID');
  }
  // Persist identifiers only: never a client_secret, card details, address, email or metadata.
  return { id: event.id, type: event.type, paymentId };
}
