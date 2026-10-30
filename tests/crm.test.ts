import express from 'express';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { CrmDelivery } from '../src/domain';
import { createMockCrm } from '../src/mock-crm/server';
import { HttpCrmSink } from '../src/services/crm-integration';

const key = 'test-crm-key';
const delivery = (version = 1): CrmDelivery => ({
  paymentId: 'pi_example', version,
  snapshot: {
    id: 'pi_example', status: 'succeeded', amount: 2500,
    amountReceived: 2500, amountRefunded: version > 1 ? 500 : 0,
    currency: 'usd', customerId: null,
  },
});
async function listen(app: express.Express) {
  const server = await new Promise<Server>(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe('versioned CRM contract over HTTP', () => {
  let crm: ReturnType<typeof createMockCrm>;
  let server: Server;
  let url: string;
  let sink: HttpCrmSink;
  beforeEach(async () => {
    crm = createMockCrm(key);
    ({ server, url } = await listen(crm.app));
    sink = new HttpCrmSink(url, key);
  });
  afterEach(async () => { await close(server); });

  test('authenticates both reads and writes', async () => {
    expect((await fetch(`${url}/api/payments`)).status).toBe(401);
    await expect(new HttpCrmSink(url, 'wrong').deliver(delivery())).rejects.toMatchObject({ retryable: false });
    expect(crm.payments.size).toBe(0);
  });
  test('repeated and reordered versions converge to one latest resource', async () => {
    await sink.deliver(delivery(2));
    await sink.deliver(delivery(1));
    await sink.deliver(delivery(2));
    expect(crm.payments.size).toBe(1);
    expect(crm.payments.get('pi_example')).toEqual(delivery(2));
    const response = await fetch(`${url}/api/payments/pi_example`, { headers: { 'x-api-key': key } });
    expect(await response.json()).toEqual(delivery(2));
  });
  test('reusing a version with changed content is terminal', async () => {
    await sink.deliver(delivery());
    const changed = delivery(); changed.snapshot.amountRefunded = 100;
    await expect(sink.deliver(changed)).rejects.toMatchObject({ retryable: false, message: 'CRM HTTP 409' });
  });
  test('invalid amounts are rejected before committing', async () => {
    const invalid = delivery(); invalid.snapshot.amountRefunded = 2501;
    await expect(sink.deliver(invalid)).rejects.toMatchObject({ retryable: false });
    expect(crm.payments.size).toBe(0);
  });
  test('remote commit with lost response is safe to retry', async () => {
    crm.faults.loseResponseOnce = true;
    await expect(sink.deliver(delivery())).rejects.toMatchObject({ retryable: true });
    expect(crm.payments.get('pi_example')).toEqual(delivery());
    await sink.deliver(delivery());
    expect(crm.payments.size).toBe(1);
  });
  test('outage is retryable and recovery succeeds', async () => {
    crm.faults.unavailable = true;
    await expect(sink.deliver(delivery())).rejects.toMatchObject({ retryable: true });
    expect(crm.payments.size).toBe(0);
    crm.faults.unavailable = false;
    await sink.deliver(delivery());
    expect(crm.payments.size).toBe(1);
  });
});

describe('adapter acknowledgement and HTTP failure classification', () => {
  test.each([408, 429, 500, 503, 400, 401, 404, 409])('classifies HTTP %i', async status => {
    const app = express(); app.put('/api/payments/:id', (_req, res) => { res.sendStatus(status); });
    const { server, url } = await listen(app);
    try {
      await expect(new HttpCrmSink(url, key).deliver(delivery())).rejects.toMatchObject({
        retryable: status === 408 || status === 429 || status >= 500,
      });
    } finally { await close(server); }
  });
  test('a truncated successful acknowledgement remains retryable after headers arrive', async () => {
    const app = express();
    app.put('/api/payments/:id', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.flushHeaders();
      res.write('{"paymentId":');
      setImmediate(() => res.destroy());
    });
    const { server, url } = await listen(app);
    try {
      await expect(new HttpCrmSink(url, key).deliver(delivery())).rejects.toMatchObject({ retryable: true });
    } finally { await close(server); }
  });
  test('a fully received malformed acknowledgement is a terminal contract failure', async () => {
    const app = express();
    app.put('/api/payments/:id', (_req, res) => { res.type('json').send('{malformed'); });
    const { server, url } = await listen(app);
    try {
      await expect(new HttpCrmSink(url, key).deliver(delivery())).rejects.toMatchObject({
        retryable: false, message: 'CRM acknowledgement is not JSON',
      });
    } finally { await close(server); }
  });
  test.each([
    { paymentId: 'pi_wrong', version: 1 },
    { paymentId: 'pi_example', version: 0 },
    { paymentId: 'pi_example', version: '1' },
    {},
  ])('rejects an unconfirmed successful response: %j', async acknowledgement => {
    const app = express(); app.put('/api/payments/:id', (_req, res) => { res.json(acknowledgement); });
    const { server, url } = await listen(app);
    try {
      await expect(new HttpCrmSink(url, key).deliver(delivery())).rejects.toMatchObject({ retryable: false });
    } finally { await close(server); }
  });
});
