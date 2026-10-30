import 'dotenv/config';
import express from 'express';
import { CrmDelivery, PaymentSnapshot } from '../domain';

const statuses = new Set([
  'requires_payment_method', 'requires_confirmation', 'requires_action',
  'processing', 'requires_capture', 'canceled', 'succeeded',
]);
const isMoney = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function parseDelivery(body: unknown, paymentId: string): CrmDelivery | null {
  if (!body || typeof body !== 'object') return null;
  const delivery = body as Partial<CrmDelivery>;
  const snapshot = delivery.snapshot as Partial<PaymentSnapshot> | undefined;
  if (!/^pi_[A-Za-z0-9_]+$/.test(paymentId) || delivery.paymentId !== paymentId ||
      !Number.isSafeInteger(delivery.version) || delivery.version! <= 0 ||
      !snapshot || snapshot.id !== paymentId || !statuses.has(snapshot.status!) ||
      !isMoney(snapshot.amount) || !isMoney(snapshot.amountReceived) ||
      !isMoney(snapshot.amountRefunded) || snapshot.amountRefunded > snapshot.amountReceived ||
      typeof snapshot.currency !== 'string' || !/^[a-z]{3}$/.test(snapshot.currency) ||
      !(snapshot.customerId === null || (typeof snapshot.customerId === 'string' && /^cus_[A-Za-z0-9_]+$/.test(snapshot.customerId)))) {
    return null;
  }
  // Project the contract explicitly: never store arbitrary supplied fields.
  return {
    paymentId, version: delivery.version!,
    snapshot: {
      id: paymentId, status: snapshot.status!, amount: snapshot.amount,
      amountReceived: snapshot.amountReceived, amountRefunded: snapshot.amountRefunded,
      currency: snapshot.currency, customerId: snapshot.customerId,
    },
  };
}

/** Local reference adapter. State is deliberately in-memory, not a production CRM. */
export function createMockCrm(apiKey: string) {
  if (!apiKey) throw new Error('CRM_API_KEY is required');
  const app = express();
  const payments = new Map<string, CrmDelivery>();
  const faults = { unavailable: false, loseResponseOnce: false };
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/api', (req, res, next) => {
    if (req.header('x-api-key') !== apiKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.put('/api/payments/:id', (req, res) => {
    if (faults.unavailable) {
      res.status(503).json({ error: 'Simulated CRM outage' });
      return;
    }
    const delivery = parseDelivery(req.body, req.params.id);
    if (!delivery || req.header('idempotency-key') !== `${delivery.paymentId}:${delivery.version}`) {
      res.status(400).json({ error: 'Invalid delivery contract' });
      return;
    }
    const previous = payments.get(delivery.paymentId);
    if (previous && previous.version === delivery.version &&
        JSON.stringify(previous.snapshot) !== JSON.stringify(delivery.snapshot)) {
      res.status(409).json({ error: 'Version reused with different content' });
      return;
    }
    if (!previous || delivery.version > previous.version) payments.set(delivery.paymentId, delivery);
    if (faults.loseResponseOnce) {
      faults.loseResponseOnce = false;
      // Simulate a successful remote commit followed by a broken connection.
      req.socket.destroy();
      return;
    }
    const stored = payments.get(delivery.paymentId)!;
    res.json({ paymentId: stored.paymentId, version: stored.version });
  });
  app.get('/api/payments', (_req, res) => { res.json({ payments: [...payments.values()] }); });
  app.get('/api/payments/:id', (req, res) => {
    const payment = payments.get(req.params.id);
    if (!payment) { res.status(404).json({ error: 'Payment not found' }); return; }
    res.json(payment);
  });
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: 'Invalid JSON request' });
  });
  return { app, payments, faults };
}

if (require.main === module) {
  const key = process.env.CRM_API_KEY;
  if (!key) throw new Error('CRM_API_KEY is required');
  const { app } = createMockCrm(key);
  const port = Number(process.env.PORT || 3001);
  app.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`Reference CRM listening on port ${port}`);
  });
}
