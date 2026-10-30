-- Additive: do not delete any tables from earlier versions of this sample.
-- The legacy tables are not inputs to the new sync projection.
CREATE TABLE "SyncInbox" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL,
  "paymentId" TEXT,
  "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','processing','done','dead','ignored')),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  "leaseUntil" TIMESTAMPTZ(3),
  "ownerToken" TEXT,
  "lastError" TEXT,
  "completedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SyncInbox_state_availableAt_idx" ON "SyncInbox" ("state", "availableAt");
CREATE INDEX "SyncInbox_state_leaseUntil_idx" ON "SyncInbox" ("state", "leaseUntil");
CREATE TABLE "PaymentProjection" (
  "id" TEXT PRIMARY KEY,
  "snapshot" JSONB NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "CrmOutbox" (
  "id" TEXT PRIMARY KEY,
  "paymentId" TEXT NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "snapshot" JSONB NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','processing','done','dead')),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  "leaseUntil" TIMESTAMPTZ(3),
  "ownerToken" TEXT,
  "lastError" TEXT,
  "completedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CrmOutbox_paymentId_version_key" ON "CrmOutbox" ("paymentId", "version");
CREATE INDEX "CrmOutbox_state_availableAt_idx" ON "CrmOutbox" ("state", "availableAt");
CREATE INDEX "CrmOutbox_state_leaseUntil_idx" ON "CrmOutbox" ("state", "leaseUntil");
