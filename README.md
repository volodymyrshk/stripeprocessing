# Stripe payment sync

Receives Stripe webhooks, stores current PaymentIntent state in PostgreSQL, and sends changes to a CRM. Includes a local CRM server and a failure demo that needs no Stripe credentials.

## Local demo

Requires Node 22+ and PostgreSQL 15+. Docker Compose can start the database if you don't already have one.

```sh
npm ci
npm run prisma:generate
cp .env.example .env
docker compose up -d postgres
npm run demo
```

Set `DATABASE_URL` in `.env` if you're using your own PostgreSQL instance. The demo creates its own schema, so it won't consume existing jobs. The database user needs permission to create schemas.

The demo checks duplicate deliveries, a CRM outage, retrying after a lost HTTP response, partial refunds, missed webhooks, and worker recovery. It exits on a failed check. Results go to `artifacts/demo.json`; the temporary schema name is included there. The schema is left behind for inspection.

## Run with Stripe sandbox

Configure `.env`: a sandbox Stripe key, webhook signing secret, `ADMIN_TOKEN` (at least 24 characters), and the CRM URL/key. Use a fresh database schema for this version.

```sh
npm run prisma:migrate
npm run build
npm run mock-crm  # separate terminal
npm start
```

Forward sandbox events with the Stripe CLI:

```sh
stripe listen --forward-to http://127.0.0.1:3000/webhooks/stripe
```

Use the signing secret printed by the listener in `.env`, then restart the app. The supported event types are listed in `src/services/stripe-webhook.ts`. A local signed notification can also be sent with `npm run simulate-webhook -- pi_YOUR_SANDBOX_ID`; that PaymentIntent must already exist in the configured sandbox.

The app binds to `127.0.0.1:3000`. To run it in containers, apply the migration first, then use `docker compose --profile sandbox up --build`.

## Processing

The webhook route verifies the raw body and inserts a unique inbox record before responding. If the insert fails, it returns 503. Duplicate event IDs reuse the existing receipt. Only identifiers are retained from the event.

Workers claim jobs in PostgreSQL using `FOR UPDATE SKIP LOCKED`, an expiring lease and an ownership token. The worker reads the current PaymentIntent from Stripe rather than applying the event's snapshot. A transaction advisory lock serializes reads and writes for the same payment. Projection changes, inbox completion and a versioned CRM outbox entry commit together.

CRM delivery uses `PUT /api/payments/:id` with a payment/version idempotency key. The receiver must ignore older versions and accept repeated identical versions. The included CRM implements that contract. A different CRM needs an adapter with equivalent behavior; the sender can deliver a request more than once.

Defaults are a 60-second lease and five attempts, with exponential backoff starting at one second. Permanent failures and exhausted attempts become dead letters. A crashed worker's expired lease can be reclaimed, including after its final attempt.

## Operations

`GET /health` checks the database and queue schema. It stays healthy during a CRM outage because incoming events can still be saved.

The following routes require `Authorization: Bearer <ADMIN_TOKEN>`:

| Route | Purpose |
| --- | --- |
| `GET /api/operations` | Queue counts, recent payments and dead letters |
| `POST /api/replay/inbox/:id` | Retry a dead inbox job after fixing its cause |
| `POST /api/replay/outbox/:id` | Retry a dead CRM delivery |
| `POST /api/reconcile` | Queue current-state reads for a creation-time window |

Reconciliation takes `{ "since": <Unix seconds>, "until": <Unix seconds> }`. Windows must be in the past and no longer than 31 days. A scan stops at 1,000 payments and reports `truncated: true`; use a narrower window when that happens. This scans payment **creation** time, so a recent refund on an old payment needs the old payment's creation window. Scans are manual.

## Tests

Use a separate disposable database whose name ends in `_test`. The integration suite clears its three sync tables between tests and refuses to run against `DATABASE_URL`.

```sh
docker compose exec postgres createdb -U postgres payment_sync_test
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/payment_sync_test npm run prisma:migrate
npm run build
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/payment_sync_test npm test
```

`npm run test:unit` runs without PostgreSQL. Integration tests use real PostgreSQL and HTTP, including transaction rollback, concurrent workers, stale leases and interrupted CRM responses. CI runs the build, tests and demo, then builds the container image.

## Limits

One direct Stripe sandbox account; no live payments or Connect. The adapter only reads payments. Amounts stay in integer minor units with their currency. Refunds use the latest charge's cumulative refunded amount; disputes, multi-charge aggregation and settlement accounting aren't modeled.

The mock CRM is in memory. Restarting it clears its records; reconciliation repairs missed Stripe notifications, not lost CRM storage. A real receiver must persist payment IDs and version watermarks. Queue retention and automatic reconciliation aren't included.

This version replaces the earlier sample's schema and endpoints. The migration creates three new tables without converting or deleting old data. Use a fresh schema; don't use `prisma db push` or a database reset to upgrade an existing installation.
