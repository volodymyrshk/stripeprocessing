export interface PaymentSnapshot {
  id: string;
  status: string;
  amount: number;
  amountReceived: number;
  amountRefunded: number;
  currency: string;
  customerId: string | null;
}
export interface PaymentSource {
  retrieve(id: string): Promise<PaymentSnapshot>;
  list(since: number, until: number): AsyncIterable<string>;
}
export interface CrmDelivery {
  paymentId: string;
  version: number;
  snapshot: PaymentSnapshot;
}
export interface CrmSink { deliver(delivery: CrmDelivery): Promise<void>; }
export interface Receipt {
  id: string;
  type: string;
  paymentId: string | null;
}
export class DeliveryError extends Error {
  constructor(message: string, public readonly retryable: boolean) { super(message); }
}
