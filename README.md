# Payment Automation System

[![CI](https://github.com/volodymyrshk/stripeprocessing/actions/workflows/ci.yml/badge.svg)](https://github.com/volodymyrshk/stripeprocessing/actions/workflows/ci.yml)

Automated payment sync between Stripe, PostgreSQL, and CRM - adapted from a client project

## About

Adapted from a project I built for a real-estate client. Removed proprietary code, replaced their CRM with a mock API, stripped identifying info. Core architecture, retry logic, and webhook handling are the same approach I used in production. Client asked me not to share original code publicly.

## The Problem

Client manually copied payment data between Stripe, database, and CRM. 10-15 hrs/week, constant errors.

## The Solution

Event-driven automation:
- Stripe webhook → verify → check Redis (idempotency) → store in PostgreSQL → sync to CRM (with retry)
- Background job retries failures every 5 minutes

**Results:** Eliminated hours of manual work each week, cut down errors.

**Stack:** Node.js, TypeScript, Express, PostgreSQL, Redis, Prisma, Docker

---

## Quick Start

```bash
# Install and configure
npm install
cp .env.example .env
# Edit .env with Stripe test keys

# Start
docker-compose up -d
npm run prisma:generate && npm run prisma:migrate

# Test
npm run simulate-webhook
curl http://localhost:3000/api/stats
```

---

## Key Features

**Idempotency:**
```typescript
const isProcessed = await redisClient.isEventProcessed(event.id);
if (isProcessed) return;
```

**Retry with exponential backoff:**
```typescript
await retryHandler.execute(
  async () => crmApi.syncPayment(data),
  'CRM Sync',
  { maxAttempts: 3, exponentialBackoff: true }
);
```

**Distributed locks:**
```typescript
const lock = await redisClient.acquireLock(`payment:${id}`, 30000);
try { /* process */ } finally { await redisClient.releaseLock(`payment:${id}`, lock); }
```

---

## API Endpoints

**Main (3000):**
- `GET /health` - Health check
- `GET /api/stats` - Stats
- `POST /webhooks/stripe` - Webhook receiver

**Mock CRM (3001):**
- `POST /api/customers` - Sync customer
- `POST /api/payments` - Sync payment

---

## Dev

```bash
docker-compose up postgres redis
npm run dev
docker-compose logs -f app
npm test
```