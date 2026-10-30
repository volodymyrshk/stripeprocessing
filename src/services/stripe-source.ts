import Stripe from 'stripe';
import { DeliveryError, PaymentSnapshot, PaymentSource } from '../domain';

export function snapshotOf(intent: Stripe.PaymentIntent): PaymentSnapshot {
  if (intent.livemode) throw new DeliveryError('Live mode is outside this sandbox reference', false);
  const charge = intent.latest_charge;
  if (typeof charge === 'string') throw new DeliveryError('Latest charge must be expanded', true);
  return {
    id: intent.id, status: intent.status, amount: intent.amount,
    amountReceived: intent.amount_received,
    amountRefunded: charge?.amount_refunded ?? 0,
    currency: intent.currency,
    customerId: typeof intent.customer === 'string' ? intent.customer : intent.customer?.id ?? null,
  };
}

/** Read-only adapter. No payment creation, capture, refund or card-data operations. */
export class StripeSource implements PaymentSource {
  private readonly stripe: Stripe;
  constructor(key: string) {
    if (!/^(sk|rk)_test_/.test(key)) throw new Error('A Stripe sandbox secret/restricted key is required');
    this.stripe = new Stripe(key, { apiVersion: '2023-10-16', timeout: 8000, maxNetworkRetries: 0 });
  }
  async retrieve(id: string): Promise<PaymentSnapshot> {
    try {
      const intent = await this.stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] });
      return snapshotOf(intent);
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      if (error instanceof Stripe.errors.StripeError) {
        const status = error.statusCode;
        throw new DeliveryError(`Stripe read failed (${status ?? 'network'})`,
          status === undefined || status === 408 || status === 429 || status >= 500);
      }
      throw error;
    }
  }
  async *list(since: number, until: number): AsyncIterable<string> {
    // API auto-pagination follows starting_after; bounded by creation time, not update time.
    for await (const intent of this.stripe.paymentIntents.list({
      created: { gte: since, lte: until }, limit: 100,
    })) {
      if (intent.livemode) throw new DeliveryError('Unexpected live-mode result', false);
      yield intent.id;
    }
  }
}
