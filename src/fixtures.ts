import Stripe from 'stripe';
import { DeliveryError, PaymentSnapshot, PaymentSource } from './domain';

export class FixtureSource implements PaymentSource {
  readonly payments = new Map<string, PaymentSnapshot>();
  unavailable = false;
  put(payment: PaymentSnapshot): void { this.payments.set(payment.id, { ...payment }); }
  async retrieve(id: string): Promise<PaymentSnapshot> {
    if (this.unavailable) throw new DeliveryError('Fixture Stripe unavailable', true);
    const payment = this.payments.get(id);
    if (!payment) throw new DeliveryError('Fixture PaymentIntent not found', false);
    return { ...payment };
  }
  async *list(_since: number, _until: number): AsyncIterable<string> {
    // Fixture objects are all considered within the requested demo window.
    yield* this.payments.keys();
  }
}
export function fixturePayment(id = 'pi_demo'): PaymentSnapshot {
  return { id, status: 'succeeded', amount: 12500, amountReceived: 12500,
    amountRefunded: 0, currency: 'usd', customerId: null };
}
export function signedFixture(secret: string, id: string, paymentId: string, type = 'payment_intent.succeeded') {
  const payload = JSON.stringify({ id, object: 'event', type, livemode: false,
    created: Math.floor(Date.now() / 1000), data: { object: type === 'charge.refunded'
      ? { object: 'charge', id: 'ch_demo', payment_intent: paymentId }
      : { object: 'payment_intent', id: paymentId } } });
  return { payload, signature: Stripe.webhooks.generateTestHeaderString({ payload, secret }) };
}
