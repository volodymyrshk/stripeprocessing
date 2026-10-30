import { CrmSink, PaymentSnapshot, PaymentSource } from './domain';
import { QueueOptions, SyncStore } from './store';

export class SyncWorker {
  readonly options: QueueOptions;
  constructor(
    private readonly store: SyncStore,
    private readonly source: PaymentSource,
    private readonly crm: CrmSink,
    options: Partial<QueueOptions> = {},
  ) {
    this.options = { leaseMs: 60_000, maxAttempts: 5, retryBaseMs: 1_000, ...options };
    if (!Number.isSafeInteger(this.options.leaseMs) || this.options.leaseMs <= 0 ||
        !Number.isSafeInteger(this.options.maxAttempts) || this.options.maxAttempts <= 0 ||
        !Number.isSafeInteger(this.options.retryBaseMs) || this.options.retryBaseMs < 0) {
      throw new Error('Invalid queue options');
    }
  }

  async tickInbox(): Promise<boolean> {
    const job = await this.store.claimInbox(this.options);
    if (!job) return false;
    try { await this.store.project(job, this.source); }
    catch (error) { await this.store.fail('inbox', job, error, this.options); }
    return true;
  }

  async tickOutbox(): Promise<boolean> {
    const job = await this.store.claimOutbox(this.options);
    if (!job) return false;
    try {
      await this.crm.deliver({ paymentId: job.paymentId, version: job.version,
        snapshot: job.snapshot as unknown as PaymentSnapshot });
      await this.store.completeOutbox(job);
    } catch (error) { await this.store.fail('outbox', job, error, this.options); }
    return true;
  }
}
