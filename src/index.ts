import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { SyncStore } from './store';
import { SyncWorker } from './worker';
import { StripeSource } from './services/stripe-source';
import { HttpCrmSink } from './services/crm-integration';
import { assertReady } from './readiness';

export async function start() {
  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ADMIN_TOKEN, CRM_URL, CRM_API_KEY } = process.env;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !ADMIN_TOKEN || !CRM_URL || !CRM_API_KEY) {
    throw new Error('Configure Stripe sandbox, CRM, DATABASE_URL and ADMIN_TOKEN settings');
  }
  const source = new StripeSource(STRIPE_SECRET_KEY);
  const crm = new HttpCrmSink(CRM_URL, CRM_API_KEY);
  const prisma = new PrismaClient();
  const store = new SyncStore(prisma);
  const worker = new SyncWorker(store, source, crm);
  const app = createApp({ store, source, prisma, webhookSecret: STRIPE_WEBHOOK_SECRET, adminToken: ADMIN_TOKEN });
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  try { await prisma.$connect(); await assertReady(prisma); }
  catch (error) { await prisma.$disconnect(); throw error; }
  const server = app.listen(port, process.env.HOST ?? '127.0.0.1', () => {
    console.log(`Payment Sync listening on port ${port}; sandbox reads only`);
  });
  let stopping = false;
  async function run() {
    while (!stopping) {
      try {
        const [inbox, outbox] = await Promise.all([worker.tickInbox(), worker.tickOutbox()]);
        if (inbox || outbox) continue;
      } catch { console.error('Worker cycle unavailable; durable jobs remain in PostgreSQL'); }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  const running = run();
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await running;
    await prisma.$disconnect();
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  return { server, shutdown };
}
if (require.main === module) {
  start().catch(() => { console.error('Startup failed. Check required configuration and database migrations.'); process.exitCode = 1; });
}
