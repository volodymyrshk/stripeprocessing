# Stripe → PostgreSQL → CRM

A TypeScript payment-sync sample: verify Stripe webhooks, record payment state in PostgreSQL and sync it to a mock CRM, with Redis duplicate checks, payment locks and retries.

**Node.js · TypeScript · Express · Prisma · PostgreSQL · Redis · Docker**

This is a public sample illustrating payment-integration patterns. It contains a mock CRM and is not the confidential production implementation or evidence of client revenue, adoption or measured time savings.

## Read the system

```text
Stripe event → raw-body signature verification → event record
             → payment processing → PostgreSQL → mock CRM
                                      ↑            │
                                      └─ retry ────┘
```

| Question | Code |
| --- | --- |
| How is the original payload verified? | [HTTP receiver](src/index.ts), [Stripe handler](src/services/stripe-webhook.ts) |
| How are events and payment records represented? | [Prisma schema](prisma/schema.prisma) |
| How are duplicate checks and payment locks handled? | [Redis client](src/utils/redis-client.ts), [payment processor](src/services/payment-processor.ts) |
| What happens when the CRM fails? | [CRM adapter](src/services/crm-integration.ts), [retry handler](src/utils/retry-handler.ts) |
| What is covered by tests? | [Redis and retry tests](tests/webhook.test.ts) |

## Local setup

Use a current Node release with `--env-file` support, Docker Compose and Stripe **test-mode** credentials. The Dockerfiles retain an older Node base; the host workflow below lets you use your current runtime.

```bash
git clone https://github.com/volodymyrshk/stripeprocessing.git
cd stripeprocessing
npm ci
cp .env.example .env
# Set Stripe test credentials and the signing secret in .env.
docker compose up -d postgres redis
npm run prisma:generate
npx prisma db push
npm run build
```

Run the mock CRM in one terminal:

```bash
node --env-file=.env dist/mock-crm/server.js
```

Run the application in another:

```bash
node --env-file=.env dist/index.js
```

Use a Stripe CLI test-mode listener to forward signed events to `http://localhost:3000/webhooks/stripe`; put its signing secret in `.env` before starting the app. `/health` checks the database, Redis and mock CRM; `/api/stats` reports stored payment and sync state.

`npm run simulate-webhook` is an older fixture sender with a placeholder signature. It is **not** a successful signed-webhook demo; the receiver correctly rejects that signature.

## Validation and scope

`npm run build` was checked on 21 October 2026. `npm test -- --runInBand` needs a dedicated local Redis instance. The current tests cover Redis helpers and retry behavior; they do not establish end-to-end payment correctness.

This sample acknowledges webhooks before asynchronous processing completes and uses time-limited Redis checks. That is not a durable delivery guarantee. It also does not establish ordering of payment-state transitions or exactly-once CRM effects. The admin/statistics endpoints are for a local demonstration and have no authentication layer.

For a focused, dependency-free demonstration of **uncertain writes, crash recovery, tenant isolation and human approval**, start with [agent-reconciliation-harness](https://github.com/volodymyrshk/agent-reconciliation-harness). That reference makes the failure model and tested guarantees explicit.

[Volodymyr Shkarban](https://volodymyr.space) · [GitHub](https://github.com/volodymyrshk)
