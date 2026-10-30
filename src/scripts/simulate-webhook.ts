import 'dotenv/config';
import { signedFixture } from '../fixtures';

async function main() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const paymentId = process.argv[2];
  if (!secret || !paymentId || !/^pi_[A-Za-z0-9_]+$/.test(paymentId)) {
    throw new Error('Usage: npm run simulate-webhook -- pi_SANDBOX_ID (set STRIPE_WEBHOOK_SECRET)');
  }
  const { payload, signature } = signedFixture(secret, `evt_local_${Date.now()}`, paymentId);
  const response = await fetch(process.env.WEBHOOK_URL ?? 'http://127.0.0.1:3000/webhooks/stripe', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload,
  });
  console.log(response.status, await response.text());
  if (!response.ok) process.exitCode = 1;
}
main().catch(() => { console.error('Simulation failed. Check configuration, PaymentIntent ID and endpoint.'); process.exitCode = 1; });
