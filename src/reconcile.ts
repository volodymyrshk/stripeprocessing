import { randomUUID } from 'crypto';
import { PaymentSource } from './domain';
import { SyncStore } from './store';

export function validateWindow(since: unknown, until: unknown): { since: number; until: number } {
  if (typeof since !== 'number' || typeof until !== 'number' || !Number.isSafeInteger(since)
    || !Number.isSafeInteger(until) || since < 0 || until < since || until - since > 31 * 86400
    || until > Math.floor(Date.now() / 1000)) {
    throw new Error('Use integer Unix seconds, a past window of at most 31 days, and since <= until');
  }
  return { since, until };
}
export async function reconcile(store: SyncStore, source: PaymentSource, since: number, until: number) {
  validateWindow(since, until);
  const runId = randomUUID();
  let enqueued = 0;
  for await (const id of source.list(since, until)) {
    if (enqueued === 1000) return { runId, enqueued, truncated: true };
    await store.enqueueReconciliation(id, runId);
    enqueued++;
  }
  return { runId, enqueued, truncated: false };
}
