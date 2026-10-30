import { CrmDelivery, CrmSink, DeliveryError } from '../domain';

/** Durable retries live in the outbox, never inside the HTTP adapter. */
export class HttpCrmSink implements CrmSink {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly apiKey: string) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('CRM_URL must be an HTTP(S) URL without credentials, query or fragment');
    }
    if (!apiKey) throw new Error('CRM_API_KEY is required');
    this.baseUrl = url.toString().replace(/\/$/, '');
  }

  async deliver(delivery: CrmDelivery): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/payments/${encodeURIComponent(delivery.paymentId)}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'idempotency-key': `${delivery.paymentId}:${delivery.version}`,
        },
        body: JSON.stringify(delivery),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
    } catch {
      // Avoid persisting arbitrary network error text, URLs or response bodies.
      throw new DeliveryError('CRM network failure or timeout', true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new DeliveryError(`CRM HTTP ${response.status}`, retryable);
    }
    let body: string;
    try {
      body = await response.text();
    } catch {
      // Headers may arrive after the CRM commits, followed by a truncated body
      // or a deadline. The outbox must retry the same version in this case.
      throw new DeliveryError('CRM network failure or timeout', true);
    }
    let confirmation: unknown;
    try {
      confirmation = JSON.parse(body);
    } catch {
      throw new DeliveryError('CRM acknowledgement is not JSON', false);
    }
    const result = confirmation as Partial<CrmDelivery> | null;
    if (!result || result.paymentId !== delivery.paymentId ||
        !Number.isSafeInteger(result.version) || result.version! < delivery.version) {
      throw new DeliveryError('CRM acknowledgement violates the version contract', false);
    }
  }
}
