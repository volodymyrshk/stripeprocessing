import express from 'express';
import Stripe from 'stripe';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';
import { FixtureSource, fixturePayment, signedFixture } from '../src/fixtures';
import { createMockCrm } from '../src/mock-crm/server';
import { HttpCrmSink } from '../src/services/crm-integration';
import { SyncStore, LeaseLost } from '../src/store';
import { SyncWorker } from '../src/worker';
import { DeliveryError } from '../src/domain';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('Integration tests require an explicit TEST_DATABASE_URL; no database is selected by default');
const parsedTestUrl = new URL(testUrl);
if (!decodeURIComponent(parsedTestUrl.pathname).endsWith('_test')) {
  throw new Error('TEST_DATABASE_URL must name a disposable database ending in _test');
}
if (process.env.DATABASE_URL) {
  const applicationUrl = new URL(process.env.DATABASE_URL);
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const host = (url: URL) => localHosts.has(url.hostname) ? 'loopback' : url.hostname;
  if (host(applicationUrl) === host(parsedTestUrl) &&
      (applicationUrl.port || '5432') === (parsedTestUrl.port || '5432') &&
      decodeURIComponent(applicationUrl.pathname) === decodeURIComponent(parsedTestUrl.pathname)) {
    throw new Error('TEST_DATABASE_URL must be a separate database from DATABASE_URL');
  }
}
const prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
const secret = 'whsec_integration_only';
const token = 'integration-admin-token-at-least-24';
const crmKey = 'integration-crm-key';
const options = { leaseMs: 60_000, maxAttempts: 3, retryBaseMs: 1000 };
const past = new Date(0);

async function listen(app: express.Express) {
  const server = await new Promise<Server>(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function receipt(id = 'evt_first', paymentId = 'pi_example') {
  return { id, type: 'payment_intent.succeeded', paymentId };
}

describe('durable payment sync on PostgreSQL and real HTTP', () => {
  let store: SyncStore;
  let source: FixtureSource;
  let worker: SyncWorker;
  let crm: ReturnType<typeof createMockCrm>;
  let crmServer: Server;
  let appServer: Server;
  let appUrl: string;
  let crmUrl: string;
  let sink: HttpCrmSink;

  beforeAll(async () => {
    // Missing database/migrations are hard failures, never a silently skipped suite.
    await prisma.$connect();
    await prisma.syncInbox.count();
  });
  beforeEach(async () => {
    await prisma.crmOutbox.deleteMany();
    await prisma.paymentProjection.deleteMany();
    await prisma.syncInbox.deleteMany();
    store = new SyncStore(prisma);
    source = new FixtureSource();
    source.put(fixturePayment('pi_example'));
    crm = createMockCrm(crmKey);
    const crmListener = await listen(crm.app);
    crmServer = crmListener.server; crmUrl = crmListener.url;
    sink = new HttpCrmSink(crmUrl, crmKey);
    worker = new SyncWorker(store, source, sink, options);
    const appListener = await listen(createApp({ store, source, prisma, webhookSecret: secret, adminToken: token }));
    appServer = appListener.server; appUrl = appListener.url;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (appServer) await close(appServer);
    if (crmServer) await close(crmServer);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function postEvent(id: string, type = 'payment_intent.succeeded', paymentId = 'pi_example') {
    const signed = signedFixture(secret, id, paymentId, type);
    return fetch(`${appUrl}/webhooks/stripe`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signed.signature },
      body: signed.payload,
    });
  }
  async function allowInboxRetry() { await prisma.syncInbox.updateMany({ where: { state: 'pending' }, data: { availableAt: past } }); }
  async function allowOutboxRetry() { await prisma.crmOutbox.updateMany({ where: { state: 'pending' }, data: { availableAt: past } }); }

  test('concurrent signed duplicates acknowledge exactly one durable job', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => postEvent('evt_duplicate')));
    expect(responses.map(response => response.status)).toEqual(Array(12).fill(200));
    const bodies = await Promise.all(responses.map(async response => await response.json() as { duplicate: boolean }));
    expect(bodies.filter(body => !body.duplicate)).toHaveLength(1);
    expect(await prisma.syncInbox.count()).toBe(1);
    expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id: 'evt_duplicate' } })).toMatchObject({ state: 'pending', attempts: 0 });
    await worker.tickInbox(); await worker.tickOutbox();
    expect(crm.payments.size).toBe(1);
    expect(await prisma.crmOutbox.count()).toBe(1);
  });

  test('invalid signatures cannot create a receipt', async () => {
    const response = await fetch(`${appUrl}/webhooks/stripe`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'invalid' }, body: '{}',
    });
    expect(response.status).toBe(400);
    expect(await prisma.syncInbox.count()).toBe(0);
  });

  test('database receipt failure returns 503 and a later delivery can succeed', async () => {
    jest.spyOn(store, 'receive').mockRejectedValueOnce(new Error('database unavailable'));
    expect((await postEvent('evt_retry_receipt')).status).toBe(503);
    expect(await prisma.syncInbox.count()).toBe(0);
    expect((await postEvent('evt_retry_receipt')).status).toBe(200);
    expect(await prisma.syncInbox.count()).toBe(1);
  });

  test('operations require authorization and report durable counts', async () => {
    expect((await fetch(`${appUrl}/api/operations`)).status).toBe(401);
    expect((await fetch(`${appUrl}/api/reconcile`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${appUrl}/api/replay/inbox/evt_first`, { method: 'POST' })).status).toBe(401);
    await store.receive(receipt());
    const response = await fetch(`${appUrl}/api/operations`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inbox: { pending: 1 } });
  });

  test('readiness returns unavailable when the queue schema probe fails', async () => {
    expect((await fetch(`${appUrl}/health`)).status).toBe(200);
    jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('missing queue column'));
    const unavailable = await fetch(`${appUrl}/health`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: 'unavailable' });
  });

  test('new receipts and replayed jobs are immediately claimable without timer sleeps', async () => {
    for (let i = 0; i < 12; i++) {
      const id = `evt_immediate_${i}`;
      await store.receive(receipt(id));
      const job = await store.claimInbox(options);
      expect(job?.id).toBe(id);
      await store.fail('inbox', job!, new DeliveryError('test permanent fault', false), options);
      expect(await store.replay('inbox', id)).toBe(true);
      expect(await worker.tickInbox()).toBe(true);
      expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'done' });
    }
  });

  test('unsupported events are durably ignored without retaining raw secrets', async () => {
    const payload = JSON.stringify({ id: 'evt_ignored', object: 'event', type: 'customer.updated', livemode: false,
      data: { object: { object: 'customer', id: 'cus_example', email: 'private@example.com', client_secret: 'secret_never_persist' } } });
    const response = await fetch(`${appUrl}/webhooks/stripe`, {
      method: 'POST', body: payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }) },
    });
    expect(response.status).toBe(200);
    const row = await prisma.syncInbox.findUniqueOrThrow({ where: { id: 'evt_ignored' } });
    expect(row).toMatchObject({ state: 'ignored', paymentId: null });
    expect(JSON.stringify(row)).not.toContain('secret_never_persist');
    expect(JSON.stringify(row)).not.toContain('private@example.com');
    expect(await worker.tickInbox()).toBe(false);
  });

  test('stale event types re-read authoritative state and partial refunds stay partial', async () => {
    await postEvent('evt_succeeded');
    await worker.tickInbox(); await worker.tickOutbox();
    source.put({ ...fixturePayment('pi_example'), amountRefunded: 2500 });
    await postEvent('evt_refund', 'charge.refunded');
    await worker.tickInbox(); await worker.tickOutbox();
    // This event's failure type is older information; its current source remains succeeded.
    await postEvent('evt_old_failure', 'payment_intent.payment_failed');
    await worker.tickInbox();
    const payment = await prisma.paymentProjection.findUniqueOrThrow({ where: { id: 'pi_example' } });
    expect(payment.version).toBe(2);
    expect(payment.snapshot).toMatchObject({ status: 'succeeded', amountReceived: 12500, amountRefunded: 2500, customerId: null });
    expect(await prisma.crmOutbox.count()).toBe(2);
    expect(crm.payments.get('pi_example')).toMatchObject({ version: 2, snapshot: { amountRefunded: 2500, status: 'succeeded' } });
  });

  test('two workers for the same payment produce only one initial version', async () => {
    await store.receive(receipt('evt_race_one'));
    await store.receive(receipt('evt_race_two'));
    const otherWorker = new SyncWorker(new SyncStore(prisma), source, sink, options);
    expect(await Promise.all([worker.tickInbox(), otherWorker.tickInbox()])).toEqual([true, true]);
    expect(await prisma.syncInbox.count({ where: { state: 'done' } })).toBe(2);
    expect(await prisma.paymentProjection.findUniqueOrThrow({ where: { id: 'pi_example' } })).toMatchObject({ version: 1 });
    expect(await prisma.crmOutbox.count()).toBe(1);
  });

  test('expired inbox leases can be reclaimed and stale owners are fenced', async () => {
    await store.receive(receipt());
    const oldJob = (await store.claimInbox(options))!;
    expect(oldJob).not.toBeNull();
    let releaseRetrieve!: () => void;
    let notifyRetrieve!: () => void;
    const entered = new Promise<void>(resolve => { notifyRetrieve = resolve; });
    const blocked = new Promise<void>(resolve => { releaseRetrieve = resolve; });
    const oldProject = store.project(oldJob, {
      retrieve: async id => { notifyRetrieve(); await blocked; return source.retrieve(id); },
      list: source.list.bind(source),
    });
    // Attach the rejection handler before allowing the old transaction to continue.
    const oldRejected = expect(oldProject).rejects.toBeInstanceOf(LeaseLost);
    await entered;
    await prisma.syncInbox.update({ where: { id: oldJob.id }, data: { leaseUntil: past } });
    const newJob = (await store.claimInbox(options))!;
    expect(newJob.ownerToken).not.toBe(oldJob.ownerToken);
    expect(newJob.attempts).toBe(2);
    releaseRetrieve();
    await oldRejected;
    expect(await prisma.paymentProjection.count()).toBe(0);
    await store.project(newJob, source);
    expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id: oldJob.id } })).toMatchObject({ state: 'done', attempts: 2 });
    expect(await prisma.crmOutbox.count()).toBe(1);
  });

  test('a crash on the final inbox attempt becomes dead rather than stuck processing', async () => {
    const lastAttempt = { ...options, maxAttempts: 1 };
    await store.receive(receipt());
    const abandoned = (await store.claimInbox(lastAttempt))!;
    await prisma.syncInbox.update({ where: { id: abandoned.id }, data: { leaseUntil: past } });
    expect(await new SyncWorker(store, source, sink, lastAttempt).tickInbox()).toBe(false);
    expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id: abandoned.id } })).toMatchObject({ state: 'dead', lastError: 'attempt_budget_exhausted' });
  });

  test('projection, inbox completion and outbox insertion roll back together', async () => {
    source.put(fixturePayment('pi_atomic'));
    await store.receive(receipt('evt_atomic', 'pi_atomic'));
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_sync_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."paymentId" = 'pi_atomic' THEN RAISE EXCEPTION 'injected outbox write failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_sync_atomic_outbox BEFORE INSERT ON "CrmOutbox" FOR EACH ROW EXECUTE FUNCTION test_sync_reject_outbox()`);
    try {
      await worker.tickInbox();
      expect(await prisma.paymentProjection.count()).toBe(0);
      expect(await prisma.crmOutbox.count()).toBe(0);
      expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id: 'evt_atomic' } })).toMatchObject({ state: 'pending', attempts: 1, completedAt: null });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_sync_atomic_outbox ON "CrmOutbox"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_sync_reject_outbox()`);
    }
    await allowInboxRetry();
    await worker.tickInbox();
    expect(await prisma.paymentProjection.count()).toBe(1);
    expect(await prisma.crmOutbox.count()).toBe(1);
    expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id: 'evt_atomic' } })).toMatchObject({ state: 'done', attempts: 2 });
  });

  test('transient Stripe failure remains durable and succeeds after recovery', async () => {
    await store.receive(receipt()); source.unavailable = true;
    await worker.tickInbox();
    expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id: 'evt_first' } })).toMatchObject({ state: 'pending', attempts: 1 });
    expect(await prisma.paymentProjection.count()).toBe(0);
    source.unavailable = false; await allowInboxRetry();
    await worker.tickInbox();
    expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id: 'evt_first' } })).toMatchObject({ state: 'done', attempts: 2 });
  });

  test('permanent source failure stops early, then explicit replay repairs it', async () => {
    await store.receive(receipt('evt_missing', 'pi_missing'));
    await worker.tickInbox();
    expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id: 'evt_missing' } })).toMatchObject({ state: 'dead', attempts: 1, lastError: 'permanent_delivery_failure' });
    expect(await worker.tickInbox()).toBe(false);
    source.put(fixturePayment('pi_missing'));
    const response = await fetch(`${appUrl}/api/replay/inbox/evt_missing`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    await worker.tickInbox();
    expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id: 'evt_missing' } })).toMatchObject({ state: 'done', attempts: 1 });
    expect(await store.replay('inbox', 'evt_missing')).toBe(false);
  });

  test('repeated transient failure exhausts its finite attempt budget', async () => {
    await store.receive(receipt()); source.unavailable = true;
    for (let i = 0; i < options.maxAttempts; i++) { await allowInboxRetry(); await worker.tickInbox(); }
    expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id: 'evt_first' } })).toMatchObject({ state: 'dead', attempts: options.maxAttempts });
    expect(await worker.tickInbox()).toBe(false);
  });

  test('a CRM outage does not lose committed payment state or acknowledged work', async () => {
    await postEvent('evt_crm_outage'); await worker.tickInbox();
    crm.faults.unavailable = true; await worker.tickOutbox();
    expect(await prisma.syncInbox.findUniqueOrThrow({ where: { id: 'evt_crm_outage' } })).toMatchObject({ state: 'done' });
    expect(await prisma.paymentProjection.count()).toBe(1);
    expect(await prisma.crmOutbox.findFirstOrThrow()).toMatchObject({ state: 'pending', attempts: 1 });
    expect(crm.payments.size).toBe(0);
    crm.faults.unavailable = false; await allowOutboxRetry(); await worker.tickOutbox();
    expect(await prisma.crmOutbox.findFirstOrThrow()).toMatchObject({ state: 'done', attempts: 2 });
    expect(crm.payments.size).toBe(1);
  });

  test('CRM commit with a lost response retries without a duplicate remote resource', async () => {
    await store.receive(receipt()); await worker.tickInbox();
    crm.faults.loseResponseOnce = true; await worker.tickOutbox();
    expect(crm.payments.size).toBe(1);
    expect(await prisma.crmOutbox.findFirstOrThrow()).toMatchObject({ state: 'pending', attempts: 1 });
    await allowOutboxRetry(); await worker.tickOutbox();
    expect(crm.payments.size).toBe(1);
    expect(await prisma.crmOutbox.findFirstOrThrow()).toMatchObject({ state: 'done', attempts: 2 });
  });

  test('stale outbox ownership cannot complete a reclaimed delivery', async () => {
    await store.receive(receipt()); await worker.tickInbox();
    const oldJob = (await store.claimOutbox(options))!;
    await prisma.crmOutbox.update({ where: { id: oldJob.id }, data: { leaseUntil: past } });
    const current = (await store.claimOutbox(options))!;
    await sink.deliver({ paymentId: oldJob.paymentId, version: oldJob.version, snapshot: fixturePayment('pi_example') });
    await expect(store.completeOutbox(oldJob)).rejects.toBeInstanceOf(LeaseLost);
    await sink.deliver({ paymentId: current.paymentId, version: current.version, snapshot: fixturePayment('pi_example') });
    await store.completeOutbox(current);
    expect(crm.payments.size).toBe(1);
    expect(await prisma.crmOutbox.findFirstOrThrow()).toMatchObject({ state: 'done', attempts: 2 });
  });

  test('reordered durable outbox versions cannot regress the CRM projection', async () => {
    await store.receive(receipt('evt_version_one')); await allowInboxRetry(); await worker.tickInbox();
    source.put({ ...fixturePayment('pi_example'), amountRefunded: 500 });
    await store.receive(receipt('evt_version_two')); await allowInboxRetry(); await worker.tickInbox();
    await allowOutboxRetry();
    const first = (await store.claimOutbox(options))!;
    const second = (await store.claimOutbox(options))!;
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    const jobs = [first, second].sort((a, b) => b.version - a.version);
    for (const job of jobs) {
      await sink.deliver({ paymentId: job.paymentId, version: job.version,
        snapshot: job.snapshot as unknown as ReturnType<typeof fixturePayment> });
      await store.completeOutbox(job);
    }
    expect(crm.payments.size).toBe(1);
    expect(crm.payments.get('pi_example')).toMatchObject({ version: 2, snapshot: { amountRefunded: 500 } });
    expect(await prisma.crmOutbox.count({ where: { state: 'done' } })).toBe(2);
  });

  test('a crash on the final outbox attempt becomes replayable dead work', async () => {
    await store.receive(receipt()); await worker.tickInbox();
    const lastAttempt = { ...options, maxAttempts: 1 };
    const abandoned = (await store.claimOutbox(lastAttempt))!;
    await prisma.crmOutbox.update({ where: { id: abandoned.id }, data: { leaseUntil: past } });
    expect(await new SyncWorker(store, source, sink, lastAttempt).tickOutbox()).toBe(false);
    expect(await prisma.crmOutbox.findFirstOrThrow()).toMatchObject({ state: 'dead', lastError: 'attempt_budget_exhausted' });
    expect(await store.replay('outbox', abandoned.id)).toBe(true);
    expect(await worker.tickOutbox()).toBe(true);
    expect(await prisma.crmOutbox.findFirstOrThrow()).toMatchObject({ state: 'done', attempts: 1 });
  });

  test('permanent CRM failures become dead and can be replayed after fixing configuration', async () => {
    await store.receive(receipt()); await worker.tickInbox();
    await new SyncWorker(store, source, new HttpCrmSink(crmUrl, 'wrong-key'), options).tickOutbox();
    const failed = await prisma.crmOutbox.findFirstOrThrow();
    expect(failed).toMatchObject({ state: 'dead', attempts: 1, lastError: 'crm_http_401' });
    expect(await store.replay('outbox', failed.id)).toBe(true);
    expect(await worker.tickOutbox()).toBe(true);
    expect(await prisma.crmOutbox.findFirstOrThrow()).toMatchObject({ state: 'done' });
    expect(crm.payments.size).toBe(1);
  });

  test('bounded reconciliation repairs a missing notification and unchanged reruns add no version', async () => {
    const now = Math.floor(Date.now() / 1000);
    const scan = () => fetch(`${appUrl}/api/reconcile`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ since: now - 3600, until: now }),
    });
    expect(await prisma.syncInbox.count()).toBe(0);
    const response = await scan();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enqueued: 1, truncated: false });
    await worker.tickInbox(); await worker.tickOutbox();
    expect(crm.payments.get('pi_example')).toMatchObject({ version: 1 });
    expect((await scan()).status).toBe(200); await worker.tickInbox();
    expect(await prisma.syncInbox.count({ where: { state: 'done' } })).toBe(2);
    expect(await prisma.crmOutbox.count()).toBe(1);
    expect(await prisma.paymentProjection.findUniqueOrThrow({ where: { id: 'pi_example' } })).toMatchObject({ version: 1 });
  });
});
