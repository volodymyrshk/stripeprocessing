import express, { ErrorRequestHandler } from 'express';
import { timingSafeEqual } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PaymentSource } from './domain';
import { SyncStore } from './store';
import { verifyReceipt } from './services/stripe-webhook';
import { reconcile, validateWindow } from './reconcile';
import { assertReady } from './readiness';

export interface AppDependencies {
  store: SyncStore;
  source: PaymentSource;
  prisma: PrismaClient;
  webhookSecret: string;
  adminToken: string;
}
export function createApp(deps: AppDependencies) {
  if (!deps.webhookSecret || deps.adminToken.length < 24) throw new Error('Signing secret and admin token (24+ chars) are required');
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    let receipt;
    try {
      const signature = req.get('stripe-signature');
      if (!signature || !Buffer.isBuffer(req.body)) throw new Error('Missing signature or raw body');
      receipt = verifyReceipt(req.body, signature, deps.webhookSecret);
    } catch {
      res.status(400).json({ error: 'Invalid sandbox webhook' });
      return;
    }
    try {
      const result = await deps.store.receive(receipt);
      res.status(200).json({ received: true, ...result });
    } catch {
      // Do not acknowledge data that was not durably committed. Stripe can retry.
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'Receipt unavailable; retry delivery' });
    }
  });
  app.get('/health', async (_req, res) => {
    try { await assertReady(deps.prisma); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use('/api', (req, res, next) => {
    const provided = Buffer.from(req.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${deps.adminToken}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'Unauthorized' }); return;
    }
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.get('/api/operations', async (_req, res, next) => {
    try { res.json(await deps.store.summary()); } catch (e) { next(e); }
  });
  app.post('/api/replay/:queue/:id', async (req, res, next) => {
    const { queue, id } = req.params;
    if ((queue !== 'inbox' && queue !== 'outbox') || id.length > 255) {
      res.status(400).json({ error: 'Invalid queue or ID' }); return;
    }
    try {
      const replayed = await deps.store.replay(queue, id);
      res.status(replayed ? 200 : 409).json({ replayed });
    } catch (e) { next(e); }
  });
  let reconciling = false;
  app.post('/api/reconcile', async (req, res, next) => {
    let window;
    try { window = validateWindow(req.body?.since, req.body?.until); }
    catch { res.status(400).json({ error: 'Use a past Unix-seconds window of at most 31 days' }); return; }
    if (reconciling) { res.status(409).json({ error: 'A scan is already running in this process' }); return; }
    reconciling = true;
    try { res.json(await reconcile(deps.store, deps.source, window.since, window.until)); }
    catch (e) { next(e); }
    finally { reconciling = false; }
  });
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = err?.type === 'entity.too.large' ? 413 : err instanceof SyntaxError ? 400 : 503;
    res.status(status).json({ error: status === 503 ? 'Operation unavailable; retry later' : 'Invalid request body' });
  };
  app.use(errors);
  return app;
}
