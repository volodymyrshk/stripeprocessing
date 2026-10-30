import { PrismaClient } from '@prisma/client';

/** Validate the queue schema as well as the connection; no table scans or payloads. */
export async function assertReady(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRaw`
    SELECT i."id", i."state", i."attempts", i."availableAt", i."ownerToken", i."leaseUntil",
      p."snapshot", p."version", o."state", o."paymentId", o."version", o."snapshot"
    FROM "SyncInbox" i CROSS JOIN "PaymentProjection" p CROSS JOIN "CrmOutbox" o LIMIT 0`;
}
