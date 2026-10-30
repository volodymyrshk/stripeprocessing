import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app';
import { FixtureSource, fixturePayment, signedFixture } from '../fixtures';
import { SyncStore, LeaseLost } from '../store';
import { SyncWorker } from '../worker';
import { createMockCrm } from '../mock-crm/server';
import { HttpCrmSink } from '../services/crm-integration';
import { reconcile } from '../reconcile';

async function listen(app: ReturnType<typeof createApp>): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}
const url = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function close(server?: Server) {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL and run npm run prisma:migrate first');
  const run = randomUUID().replace(/-/g, '');
  // Every run gets a schema: demo workers must never claim the caller's queued work.
  const schema = `demo_${run}`;
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.searchParams.set('schema', schema);
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl.toString() }, stdio: 'pipe',
  });
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
  const prefix = `pi_demo_${run}`;
  const store = new SyncStore(prisma);
  const source = new FixtureSource();
  const crm = createMockCrm(`demo_crm_${run}`);
  const secret = `whsec_demo_${run}`;
  const adminToken = `demo_admin_${run}`;
  const checks: string[] = [];
  let crmServer: Server | undefined;
  let appServer: Server | undefined;
  const pass = (message: string) => { checks.push(message); console.log(`PASS  ${message}`); };
  try {
    await prisma.$connect();
    crmServer = await listen(crm.app);
    const sink = new HttpCrmSink(url(crmServer), `demo_crm_${run}`);
    const worker = new SyncWorker(store, source, sink, { retryBaseMs: 0, maxAttempts: 2 });
    appServer = await listen(createApp({ store, source, prisma, webhookSecret: secret, adminToken }));
    const send = async (id: string, paymentId: string, type?: string) => {
      const event = signedFixture(secret, id, paymentId, type);
      return fetch(`${url(appServer!)}/webhooks/stripe`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': event.signature }, body: event.payload });
    };
    const drainInbox = async () => { for (let i = 0; i < 100 && await worker.tickInbox(); i++) { /* bounded */ } };
    const drainOutbox = async () => { for (let i = 0; i < 100 && await worker.tickOutbox(); i++) { /* bounded */ } };

    const payment = fixturePayment(prefix);
    source.put(payment);
    const receiptId = `evt_demo_${run}`;
    const receipts = await Promise.all(Array.from({ length: 8 }, () => send(receiptId, prefix)));
    assert(receipts.every(response => response.status === 200));
    assert.equal(await prisma.syncInbox.count({ where: { id: receiptId } }), 1);
    pass('8 concurrent signed deliveries produce 1 committed receipt');

    await drainInbox();
    crm.faults.unavailable = true;
    await drainOutbox();
    let outbox = await prisma.crmOutbox.findFirstOrThrow({ where: { paymentId: prefix } });
    assert.equal(outbox.state, 'dead');
    assert.equal(crm.payments.size, 0);
    pass('CRM outage exhausts the attempt budget without losing the payment');

    crm.faults.unavailable = false;
    assert(await store.replay('outbox', outbox.id));
    crm.faults.loseResponseOnce = true;
    await drainOutbox();
    assert.equal(crm.payments.size, 1);
    outbox = await prisma.crmOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
    assert.equal(outbox.state, 'done');
    assert.equal(outbox.attempts, 2);
    pass('Replay survives a remote commit with a lost HTTP response; 1 CRM record');

    source.put({ ...payment, amountRefunded: 2500 });
    assert.equal((await send(`evt_refund_${run}`, prefix, 'charge.refunded')).status, 200);
    await drainInbox(); await drainOutbox();
    assert.equal(crm.payments.get(prefix)?.snapshot.amountRefunded, 2500);
    assert.equal(crm.payments.get(prefix)?.snapshot.status, 'succeeded');
    assert.equal((await send(`evt_stale_${run}`, prefix, 'payment_intent.payment_failed')).status, 200);
    await drainInbox(); await drainOutbox();
    assert.equal(crm.payments.get(prefix)?.version, 2);
    pass('Partial refund is preserved; a late failed event cannot overwrite current Stripe state');

    const missed = `${prefix}_missed`;
    source.put(fixturePayment(missed));
    const now = Math.floor(Date.now() / 1000);
    const scan = await reconcile(store, source, now - 3600, now);
    assert.equal(scan.truncated, false);
    await drainInbox(); await drainOutbox();
    assert.equal(crm.payments.get(missed)?.version, 1);
    pass('Reconciliation repairs a payment whose webhook never arrived');

    const crashed = `${prefix}_crashed`;
    source.put(fixturePayment(crashed));
    await store.receive({ id: `evt_crash_${run}`, type: 'payment_intent.succeeded', paymentId: crashed });
    const abandoned = await store.claimInbox(worker.options);
    assert(abandoned);
    await prisma.syncInbox.update({ where: { id: abandoned.id }, data: { leaseUntil: new Date(0) } });
    await worker.tickInbox();
    await assert.rejects(() => store.project(abandoned, source), LeaseLost);
    await drainOutbox();
    assert.equal(crm.payments.get(crashed)?.version, 1);
    pass('Expired worker lease is reclaimed; stale owner is fenced from committing');

    const operations = await fetch(`${url(appServer)}/api/operations`, { headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(operations.status, 200);
    const report = { run, schema, generatedAt: new Date().toISOString(), checks, final: await operations.json(),
      crmPayments: [...crm.payments.values()], note: 'Fixture Stripe source; real PostgreSQL and HTTP. No live Stripe calls.' };
    await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/demo.json', JSON.stringify(report, null, 2) + '\n');
    console.log(`\nEvidence saved to artifacts/demo.json. Isolated schema: ${schema}`);

  } finally {
    await close(appServer); await close(crmServer); await prisma.$disconnect();
  }
}
main().catch(() => { console.error('Demo failed. Check DATABASE_URL, apply migrations, then rerun. No Stripe credentials are needed.'); process.exitCode = 1; });
