import Stripe from 'stripe';
import { fixturePayment, signedFixture } from '../src/fixtures';
import { verifyReceipt } from '../src/services/stripe-webhook';
import { snapshotOf, StripeSource } from '../src/services/stripe-source';
import { validateWindow } from '../src/reconcile';

const secret = 'whsec_unit_only';
const signed = (event: unknown) => {
  const payload = JSON.stringify(event);
  return { payload: Buffer.from(payload), signature: Stripe.webhooks.generateTestHeaderString({ payload, secret }) };
};
test('signature verification preserves only allowed identifiers', () => {
  const event = signedFixture(secret, 'evt_signed', 'pi_valid');
  expect(verifyReceipt(Buffer.from(event.payload), event.signature, secret)).toEqual({
    id: 'evt_signed', type: 'payment_intent.succeeded', paymentId: 'pi_valid',
  });
  expect(() => verifyReceipt(Buffer.from(event.payload + ' '), event.signature, secret)).toThrow();
});
test('unsupported events are recorded as ignored; live and Connect events are rejected', () => {
  const base = { id: 'evt_other', type: 'customer.created', livemode: false, data: { object: { id: 'cus_test', object: 'customer', email: 'never-store@example.test' } } };
  const event = signed(base);
  expect(verifyReceipt(event.payload, event.signature, secret).paymentId).toBeNull();
  for (const restricted of [{ ...base, livemode: true }, { ...base, account: 'acct_other' }]) {
    const invalid = signed(restricted);
    expect(() => verifyReceipt(invalid.payload, invalid.signature, secret)).toThrow();
  }
});
test('charge refund event identifies its PaymentIntent', () => {
  const event = signedFixture(secret, 'evt_refund', 'pi_refund', 'charge.refunded');
  expect(verifyReceipt(Buffer.from(event.payload), event.signature, secret).paymentId).toBe('pi_refund');
});
test('projects exact minor units and cumulative partial refund without secrets or invented customer', () => {
  const intent = { id: 'pi_project', status: 'succeeded', amount: 500, amount_received: 500,
    currency: 'jpy', customer: null, livemode: false, latest_charge: { amount_refunded: 100 },
    client_secret: 'must_not_store', metadata: { private: 'no' } } as unknown as Stripe.PaymentIntent;
  expect(snapshotOf(intent)).toEqual({ ...fixturePayment('pi_project'), amount: 500,
    amountReceived: 500, amountRefunded: 100, currency: 'jpy' });
  expect(() => snapshotOf({ ...intent, livemode: true })).toThrow();
  expect(() => snapshotOf({ ...intent, latest_charge: 'ch_unexpanded' })).toThrow();
});
test('read-only Stripe source refuses live keys', () => {
  expect(() => new StripeSource('sk_live_do_not_use')).toThrow();
  expect(() => new StripeSource('rk_test_example')).not.toThrow();
});
test('reconciliation requires an explicit bounded past creation window', () => {
  const now = Math.floor(Date.now() / 1000);
  expect(validateWindow(now - 86400, now)).toEqual({ since: now - 86400, until: now });
  for (const args of [[now, now - 1], [0, now], [0, now + 1], ['0', 1], [0.1, 1]]) {
    expect(() => validateWindow(args[0], args[1])).toThrow();
  }
});
