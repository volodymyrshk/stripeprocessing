import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, SyncInbox, CrmOutbox } from '@prisma/client';
import { DeliveryError, PaymentSnapshot, PaymentSource, Receipt } from './domain';

export interface QueueOptions { leaseMs: number; maxAttempts: number; retryBaseMs: number; }
export type QueueName = 'inbox' | 'outbox';
export class LeaseLost extends Error { constructor() { super('Lease no longer owned'); } }

// Only these literal identifiers enter raw SQL; queue names never become user-supplied SQL.
function table(queue: QueueName): Prisma.Sql {
  return queue === 'inbox' ? Prisma.sql`"SyncInbox"` : Prisma.sql`"CrmOutbox"`;
}

function canonical(snapshot: PaymentSnapshot): PaymentSnapshot {
  return {
    id: snapshot.id, status: snapshot.status, amount: snapshot.amount,
    amountReceived: snapshot.amountReceived, amountRefunded: snapshot.amountRefunded,
    currency: snapshot.currency, customerId: snapshot.customerId,
  };
}
function validate(snapshot: PaymentSnapshot, paymentId: string): PaymentSnapshot {
  const statuses = ['requires_payment_method', 'requires_confirmation', 'requires_action',
    'processing', 'requires_capture', 'canceled', 'succeeded'];
  if (snapshot.id !== paymentId || !statuses.includes(snapshot.status) ||
      !/^[a-z]{3}$/.test(snapshot.currency) ||
      ![snapshot.amount, snapshot.amountReceived, snapshot.amountRefunded].every(
        value => Number.isSafeInteger(value) && value >= 0) ||
      snapshot.amountRefunded > snapshot.amountReceived ||
      !(snapshot.customerId === null || (typeof snapshot.customerId === 'string' && snapshot.customerId.length > 0))) {
    throw new DeliveryError('Invalid payment projection', false);
  }
  return canonical(snapshot);
}

// These adapters own their error messages. Translate only an explicit allowlist;
// unknown DeliveryError messages are not safe to retain verbatim.
function failureCode(error: unknown, permanent: boolean): string {
  if (error instanceof DeliveryError) {
    const crmStatus = /^CRM HTTP (\d{3})$/.exec(error.message);
    if (crmStatus) return `crm_http_${crmStatus[1]}`;
    const stripeStatus = /^Stripe read failed \((\d{3}|network)\)$/.exec(error.message);
    if (stripeStatus) return `stripe_read_${stripeStatus[1]}`;
    const known: Record<string, string> = {
      'CRM network failure or timeout': 'crm_network_or_timeout',
      'CRM acknowledgement is not JSON': 'crm_invalid_acknowledgement',
      'CRM acknowledgement violates the version contract': 'crm_version_contract_violation',
      'Invalid payment projection': 'invalid_payment_projection',
      'Missing payment ID': 'missing_payment_id',
      'Latest charge must be expanded': 'stripe_charge_not_expanded',
      'Live mode is outside this sandbox reference': 'stripe_live_mode_rejected',
    };
    if (Object.hasOwn(known, error.message)) return known[error.message];
  }
  return permanent ? 'permanent_delivery_failure' : 'transient_processing_failure';
}

export class SyncStore {
  constructor(public readonly prisma: PrismaClient) {}

  async receive(receipt: Receipt): Promise<{ duplicate: boolean }> {
    // createMany(skipDuplicates) is an INSERT ON CONFLICT, so competing deliveries
    // never turn an expected duplicate into an aborted transaction.
    const inserted = await this.prisma.syncInbox.createMany({
      data: [{ id: receipt.id, type: receipt.type, paymentId: receipt.paymentId,
        state: receipt.paymentId === null ? 'ignored' : 'pending' }],
      skipDuplicates: true,
    });
    return { duplicate: inserted.count === 0 };
  }

  async enqueueReconciliation(paymentId: string, runId: string): Promise<void> {
    await this.receive({ id: `reconcile:${runId}:${paymentId}`, type: 'reconciliation', paymentId });
  }

  private async claim(queue: QueueName, options: QueueOptions): Promise<SyncInbox | CrmOutbox | null> {
    const relation = table(queue);
    // A worker that dies on its final attempt must not leave a permanent processing row.
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE ${relation} SET "state" = 'dead', "ownerToken" = NULL, "leaseUntil" = NULL,
        "lastError" = 'attempt_budget_exhausted', "updatedAt" = clock_timestamp()
      WHERE "attempts" >= ${options.maxAttempts} AND (
        ("state" = 'processing' AND "leaseUntil" <= clock_timestamp()) OR "state" = 'pending')`);
    const token = randomUUID();
    const rows = await this.prisma.$queryRaw<Array<SyncInbox | CrmOutbox>>(Prisma.sql`
      UPDATE ${relation} AS job SET "state" = 'processing', "attempts" = job."attempts" + 1,
        "ownerToken" = ${token}, "leaseUntil" = clock_timestamp() + ${options.leaseMs} * interval '1 millisecond',
        "updatedAt" = clock_timestamp()
      WHERE job."id" = (
        SELECT candidate."id" FROM ${relation} AS candidate
        WHERE candidate."attempts" < ${options.maxAttempts} AND (
          (candidate."state" = 'pending' AND candidate."availableAt" <= clock_timestamp()) OR
          (candidate."state" = 'processing' AND candidate."leaseUntil" <= clock_timestamp()))
        ORDER BY candidate."createdAt", candidate."id"
        FOR UPDATE SKIP LOCKED LIMIT 1
      ) RETURNING job.*`);
    return rows[0] ?? null;
  }

  async claimInbox(options: QueueOptions): Promise<SyncInbox | null> {
    return await this.claim('inbox', options) as SyncInbox | null;
  }
  async claimOutbox(options: QueueOptions): Promise<CrmOutbox | null> {
    return await this.claim('outbox', options) as CrmOutbox | null;
  }

  async project(job: SyncInbox, source: PaymentSource): Promise<void> {
    if (job.paymentId === null) throw new DeliveryError('Missing payment ID', false);
    const paymentId = job.paymentId;
    await this.prisma.$transaction(async tx => {
      // Serialize the authoritative READ as well as the write. Serializing only
      // the write could commit an older fetched snapshot after a newer one.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${paymentId}, 0))`;
      const owned = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "SyncInbox" WHERE "id" = ${job.id} AND "state" = 'processing'
        AND "ownerToken" = ${job.ownerToken} AND "leaseUntil" > clock_timestamp()`;
      if (owned.length === 0) throw new LeaseLost();
      const snapshot = validate(await source.retrieve(paymentId), paymentId);
      // Fence again after the network read. This conditional update also locks
      // the inbox row until the projection + outbox transaction commits.
      const completed = await tx.$executeRaw`
        UPDATE "SyncInbox" SET "state" = 'done', "completedAt" = clock_timestamp(),
          "ownerToken" = NULL, "leaseUntil" = NULL, "lastError" = NULL, "updatedAt" = clock_timestamp()
        WHERE "id" = ${job.id} AND "state" = 'processing' AND "ownerToken" = ${job.ownerToken}
          AND "leaseUntil" > clock_timestamp()`;
      if (completed !== 1) throw new LeaseLost();
      const existing = await tx.paymentProjection.findUnique({ where: { id: paymentId } });
      if (existing && JSON.stringify(canonical(existing.snapshot as unknown as PaymentSnapshot)) === JSON.stringify(snapshot)) return;
      const version = (existing?.version ?? 0) + 1;
      const json = snapshot as unknown as Prisma.InputJsonValue;
      await tx.paymentProjection.upsert({
        where: { id: paymentId }, create: { id: paymentId, snapshot: json, version },
        update: { snapshot: json, version },
      });
      await tx.crmOutbox.create({ data: { paymentId, version, snapshot: json } });
    }, { timeout: 30_000, maxWait: 5_000 });
  }

  async completeOutbox(job: CrmOutbox): Promise<void> {
    const completed = await this.prisma.$executeRaw`
      UPDATE "CrmOutbox" SET "state" = 'done', "completedAt" = clock_timestamp(),
        "ownerToken" = NULL, "leaseUntil" = NULL, "lastError" = NULL, "updatedAt" = clock_timestamp()
      WHERE "id" = ${job.id} AND "state" = 'processing' AND "ownerToken" = ${job.ownerToken}
        AND "leaseUntil" > clock_timestamp()`;
    if (completed !== 1) throw new LeaseLost();
  }

  async fail(queue: QueueName, job: SyncInbox | CrmOutbox, error: unknown, options: QueueOptions): Promise<void> {
    if (error instanceof LeaseLost) return;
    const permanent = error instanceof DeliveryError && !error.retryable;
    const dead = permanent || job.attempts >= options.maxAttempts;
    const delay = Math.min(3_600_000, options.retryBaseMs * 2 ** Math.min(job.attempts - 1, 20));
    // Persist a classification, never a Stripe/HTTP error body, token or stack.
    const reason = failureCode(error, permanent);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE ${table(queue)} SET "state" = ${dead ? 'dead' : 'pending'}, "ownerToken" = NULL,
        "leaseUntil" = NULL, "lastError" = ${reason}, "updatedAt" = clock_timestamp(),
        "availableAt" = date_trunc('milliseconds', clock_timestamp() + ${delay} * interval '1 millisecond')
      WHERE "id" = ${job.id} AND "state" = 'processing' AND "ownerToken" = ${job.ownerToken}
        AND "leaseUntil" > clock_timestamp()`);
  }

  async replay(queue: QueueName, id: string): Promise<boolean> {
    const count = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE ${table(queue)} SET "state" = 'pending', "attempts" = 0,
        "availableAt" = date_trunc('milliseconds', clock_timestamp()), "ownerToken" = NULL, "leaseUntil" = NULL,
        "lastError" = NULL, "completedAt" = NULL, "updatedAt" = clock_timestamp()
      WHERE "id" = ${id} AND "state" = 'dead'`);
    return count === 1;
  }

  async summary(): Promise<object> {
    const [inbox, outbox, payments, deadInbox, deadOutbox] = await Promise.all([
      this.prisma.syncInbox.groupBy({ by: ['state'], _count: { _all: true } }),
      this.prisma.crmOutbox.groupBy({ by: ['state'], _count: { _all: true } }),
      this.prisma.paymentProjection.findMany({ orderBy: { updatedAt: 'desc' }, take: 20 }),
      this.prisma.syncInbox.findMany({ where: { state: 'dead' }, orderBy: { updatedAt: 'desc' }, take: 20 }),
      this.prisma.crmOutbox.findMany({ where: { state: 'dead' }, orderBy: { updatedAt: 'desc' }, take: 20,
        select: { id: true, paymentId: true, version: true, attempts: true, lastError: true, updatedAt: true } }),
    ]);
    const counts = (rows: Array<{ state: string; _count: { _all: number } }>) =>
      Object.fromEntries(rows.map(row => [row.state, row._count._all]));
    return {
      inbox: counts(inbox), outbox: counts(outbox), payments,
      deadLetters: [
        ...deadInbox.map(row => ({ queue: 'inbox', id: row.id, paymentId: row.paymentId, attempts: row.attempts, lastError: row.lastError, updatedAt: row.updatedAt })),
        ...deadOutbox.map(row => ({ queue: 'outbox', ...row })),
      ],
    };
  }
}
