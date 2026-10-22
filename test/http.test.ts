import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { ApiClient, type Subscription, type SubscriptionPayment, type SubscriptionPlan, type SubscriptionSetupRecord } from '@shodai-network/agreements-api-client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createSIWxPayload, encodeSIWxHeader, type SIWxExtension } from '@x402/extensions/sign-in-with-x';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../src/app.js';
import { coversNow, hasAccess, Merchant, type SubscriptionView } from '../src/merchant.js';
import { connectStore, type Store } from '../src/store.js';

const wallet = privateKeyToAccount(generatePrivateKey());
const recipient = '0x3333333333333333333333333333333333333333';
const payer = '0x4444444444444444444444444444444444444444';
const address = '0x5555555555555555555555555555555555555555';
const hash = '0x' + 'ab'.repeat(32);
const terms = { network: 'eip155:84532', asset: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', recipient, amount: '1000000000', periodSeconds: 60 };
const plan = (id: string, acceptingNewSubscriptions: boolean): SubscriptionPlan => ({ ...terms, id, acceptingNewSubscriptions, createdAt: new Date().toISOString() });
const plans = new Map<string, SubscriptionPlan>();
const subscriptions: Subscription[] = [];
const setupRecords = new Map<string, SubscriptionSetupRecord | null>();
const payments = new Map<string, SubscriptionPayment[]>();
const reusable = new Set<string>();
let mode: 'success' | 'pending' | 'failed' | 'unavailable' | 'old-success' | 'conflict' = 'success';
let readFailure = false, secondPageFailure = false, pageSize = 100, paymentCalls = 0;
let lastForwarded: unknown;
let server: ReturnType<typeof createServer>, mongo: MongoMemoryServer;
let store: Store, client: Awaited<ReturnType<typeof connectStore>>['client'];
let merchant: Merchant, origin: string;

const envelope = (data: unknown, status = 200) => Response.json({ data, meta: { apiVersion: 'v0', requestId: 'fixture' } }, { status });
const failure = (status: number, message: string) => Response.json({ error: { code: 'fixture_error', message } }, { status });
function period(offset = 0) {
  return { startsAt: new Date(Date.now() + offset).toISOString(), endsAt: new Date(Date.now() + offset + 60_000).toISOString() };
}
function seed(id: string, paid = false, createdAt = new Date().toISOString()) {
  const subscription: Subscription = { id, planId: 'P', subscriberWallet: wallet.address.toLowerCase(), currentPeriod: paid ? period() : null,
    renewalEnabled: true, canceledAt: null, createdAt, updatedAt: createdAt };
  subscriptions.unshift(subscription);
  setupRecords.set(id, { id, planId: 'P', subscriber: wallet.address, payer, merchant: recipient, agreement: address, adapter: address, manager: address, enforcer: address });
  payments.set(id, []); reusable.add(id);
  return subscription;
}

const sdk = new ApiClient({ apiKey: 'fixture-key', baseUrl: 'https://shodai.fixture', fetch: async (input, init) => {
  assert.equal((init?.headers as Record<string, string>)['X-API-Key'], 'fixture-key');
  const url = new URL(String(input));
  assert.ok(url.pathname.startsWith('/v0/subscription'));
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  if (readFailure && init?.method === 'GET') return failure(503, 'Read unavailable');
  if (url.pathname.startsWith('/v0/subscription-plans/')) {
    const value = plans.get(decodeURIComponent(url.pathname.split('/').at(-1)!));
    return value ? envelope(value) : failure(404, 'Plan not found');
  }
  if (url.pathname === '/v0/subscriptions' && init?.method === 'GET') {
    const cursor = Number(url.searchParams.get('cursor') || 0);
    if (secondPageFailure && cursor) return failure(503, 'Later page unavailable');
    const records = subscriptions.filter(subscription => subscription.subscriberWallet.toLowerCase() === url.searchParams.get('subscriberWallet')!.toLowerCase() &&
      (!url.searchParams.has('reusableSetup') || reusable.has(subscription.id)));
    const limit = Math.min(Number(url.searchParams.get('limit') || 25), pageSize);
    return Response.json({ data: records.slice(cursor, cursor + limit), pageInfo: { limit, nextCursor: records.length > cursor + limit ? String(cursor + limit) : null } });
  }
  if (url.pathname === '/v0/subscriptions' && init?.method === 'POST') {
    let value = subscriptions.find(subscription => subscription.planId === body.planId && subscription.subscriberWallet.toLowerCase() === body.subscriberWallet.toLowerCase() && reusable.has(subscription.id));
    const status = value ? 200 : 201;
    if (!value) {
      if (!plans.get(body.planId)?.acceptingNewSubscriptions) return failure(409, 'Plan is closed');
      value = seed('S-' + subscriptions.length);
      value.planId = body.planId; value.subscriberWallet = body.subscriberWallet.toLowerCase();
      setupRecords.set(value.id, { ...setupRecords.get(value.id)!, planId: body.planId, subscriber: body.subscriberWallet });
    }
    return envelope({ record: setupRecords.get(value.id), permission: { startTime: Math.floor(Date.now() / 1000), expiry: Math.floor(Date.now() / 1000) + 86400 } }, status);
  }
  const match = /^\/v0\/subscriptions\/([^/]+)\/(setup|payments)$/.exec(url.pathname);
  assert.ok(match, 'Unexpected SDK operation');
  const id = decodeURIComponent(match[1]);
  const subscription = subscriptions.find(record => record.id === id);
  if (!subscription) return failure(404, 'Subscription not found');
  if (match[2] === 'setup') return envelope({ record: setupRecords.get(id) ?? null });
  if (init?.method === 'GET') {
    const cursor = Number(url.searchParams.get('cursor') || 0);
    const records = payments.get(id) ?? [], limit = Number(url.searchParams.get('limit') || 25);
    return Response.json({ data: records.slice(cursor, cursor + limit), pageInfo: { limit, nextCursor: records.length > cursor + limit ? String(cursor + limit) : null } });
  }
  paymentCalls++; lastForwarded = body;
  if (mode === 'unavailable') return failure(503, 'Submission response unavailable');
  if (mode === 'conflict') { subscription.currentPeriod = period(); return failure(409, 'Existing coverage'); }
  const accepted = plans.get(subscription.planId)!;
  const payment: SubscriptionPayment = { id: 'payment-' + paymentCalls, subscriptionId: id, kind: 'initial',
    status: mode === 'pending' ? 'pending' : mode === 'failed' ? 'failed' : 'succeeded',
    attemptedAt: new Date().toISOString(), resolvedAt: mode === 'pending' ? null : new Date().toISOString(),
    amount: accepted.amount, asset: accepted.asset, recipient: accepted.recipient,
    coveredPeriod: mode === 'success' ? period() : mode === 'old-success' ? period(-120_000) : null,
    transactionHash: hash, failureReason: mode === 'failed' ? 'Collection failed' : null };
  payments.get(id)!.unshift(payment);
  if (mode === 'success') subscription.currentPeriod = payment.coveredPeriod;
  return envelope(payment, 201);
} });

before(async () => {
  process.env.OPERATOR_PASSWORD = 'test-operator-password-with-enough-length';
  mongo = await MongoMemoryServer.create();
  ({ store, client } = await connectStore(mongo.getUri(), 'thin-merchant-fixture'));
  merchant = new Merchant(store, { apiKey: 'fixture-key', apiBaseUrl: 'https://shodai.fixture', planIds: ['P', 'Q'] }, sdk);
  const outer = express(); server = createServer(outer);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  outer.use(createApp(merchant, origin));
});
beforeEach(async () => {
  plans.clear(); plans.set('P', plan('P', true)); plans.set('Q', plan('Q', false));
  subscriptions.length = 0; setupRecords.clear(); payments.clear(); reusable.clear();
  mode = 'success'; readFailure = false; secondPageFailure = false; pageSize = 100; paymentCalls = 0; lastForwarded = undefined;
  await store.customers.deleteMany({});
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await mongo.stop(); });

async function proof() {
  const response = await fetch(origin + '/subscriber-resource');
  assert.equal(response.status, 402);
  const required = decodePaymentRequiredHeader(response.headers.get('payment-required')!);
  const extension = required.extensions!['sign-in-with-x'] as SIWxExtension;
  const payload = await createSIWxPayload({ ...extension.info, ...extension.supportedChains[0] },
    { address: wallet.address, signMessage: ({ message }: { message: string }) => wallet.signMessage({ message }) }, origin + '/subscriber-resource');
  return { header: encodeSIWxHeader(payload), required };
}
async function setup(header: string, planId = 'P') {
  return fetch(origin + '/subscriptions/agent-wallet/setup', { method: 'POST',
    headers: { 'content-type': 'application/json', 'SIGN-IN-WITH-X': header }, body: JSON.stringify({ planId, agentWallet: wallet.address }) });
}
function paymentHeader(id: string, required: Awaited<ReturnType<typeof proof>>['required']) {
  return encodePaymentSignatureHeader({ x402Version: 2, resource: required.resource, accepted: required.accepts[0],
    payload: { recordId: id, planId: 'P', subscriber: wallet.address, payer, resource: origin + '/subscriber-resource',
      nonce: '0x' + 'ab'.repeat(32), deadline: Math.floor(Date.now() / 1000) + 600, signature: '0xab' } });
}
async function requestPayment(header: string, id: string, required: Awaited<ReturnType<typeof proof>>['required']) {
  return fetch(origin + '/subscriber-resource', { headers: { 'SIGN-IN-WITH-X': header, 'PAYMENT-SIGNATURE': paymentHeader(id, required) } });
}

test('access uses a fixed renewal grace without extending confirmed coverage', () => {
  const startsAt = Date.parse('2026-10-21T12:00:00Z');
  const endsAt = startsAt + 60_000;
  const currentPeriod = { startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() };
  for (const [renewalEnabled, at, expected] of [
    [true, startsAt - 1, false], [true, startsAt, true], [true, endsAt - 1, true],
    [true, endsAt, true], [true, endsAt + 59_999, true], [true, endsAt + 60_000, false],
    [false, endsAt - 1, true], [false, endsAt, false], [null, endsAt, false],
  ] as const) {
    assert.equal(hasAccess({ currentPeriod, renewalEnabled }, at), expected, `${renewalEnabled} at ${at - endsAt}ms from expiry`);
  }
  assert.equal(hasAccess({ currentPeriod: null, renewalEnabled: true }, endsAt), false);
  assert.equal(coversNow({ currentPeriod }, endsAt), false);
  assert.equal(currentPeriod.endsAt, new Date(endsAt).toISOString());
});

test('renewal grace is shared by resource, status and operator views without collecting', async t => {
  const now = Date.now();
  const authorization = 'Basic ' + Buffer.from('operator:' + process.env.OPERATOR_PASSWORD).toString('base64');
  t.mock.timers.enable({ apis: ['Date'], now });
  const subscription = seed('renewing');
  subscription.currentPeriod = period(-90_000);
  const endsAt = Date.parse(subscription.currentPeriod.endsAt);
  const { header, required } = await proof();
  for (const outcome of [null, 'pending', 'failed'] as const) {
    payments.set(subscription.id, outcome ? [{
      id: 'renewal', subscriptionId: subscription.id, kind: 'renewal', status: outcome,
      attemptedAt: new Date(endsAt).toISOString(), resolvedAt: outcome === 'failed' ? new Date(now).toISOString() : null,
      amount: terms.amount, asset: terms.asset, recipient, coveredPeriod: null, transactionHash: null,
      failureReason: outcome === 'failed' ? 'Insufficient funds' : null,
    }] : []);
    const response = await requestPayment(header, subscription.id, required);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('payment-response'), null);
    const status = await (await fetch(origin + '/subscriptions/status?subscriber=' + wallet.address)).json();
    const list = await (await fetch(origin + '/admin/customers', { headers: { authorization } })).json();
    const detail = await (await fetch(origin + '/admin/customers/' + wallet.address, { headers: { authorization } })).json();
    for (const view of [status, list.customers[0], detail]) {
      assert.equal(view.accessPaid, true);
      assert.equal(view.paidThrough, String(Math.floor(endsAt / 1000)));
    }
    assert.equal(list.customers[0].latestCollection?.outcome ?? null, outcome);
    assert.equal(paymentCalls, 0);
  }
  subscription.renewalEnabled = false;
  assert.equal((await fetch(origin + '/subscriber-resource', { headers: { 'SIGN-IN-WITH-X': header } })).status, 402);
  subscription.renewalEnabled = true;
  t.mock.timers.setTime(endsAt + 60_000);
  assert.equal((await fetch(origin + '/subscriber-resource', { headers: { 'SIGN-IN-WITH-X': header } })).status, 402);
  assert.equal((await (await fetch(origin + '/subscriptions/status?subscriber=' + wallet.address)).json()).accessPaid, false);
  assert.equal((await (await fetch(origin + '/admin/customers', { headers: { authorization } })).json()).customers[0].accessPaid, false);
  assert.equal((await (await fetch(origin + '/admin/customers/' + wallet.address, { headers: { authorization } })).json()).accessPaid, false);
  assert.equal(paymentCalls, 0);
});

test('Plan offer, buyer proof, setup bridge and confirmed access use the public SDK', async () => {
  const { header, required } = await proof();
  assert.equal(required.accepts[0].amount, terms.amount);
  assert.equal(required.accepts[0].extra?.planId, 'P');
  assert.equal((required.accepts[0].extra?.token as { formattedAmount: string }).formattedAmount, '0.000000001');
  assert.equal((required.extensions!['shodai-subscription'] as any).statusEndpoint, origin + '/subscriptions/status');
  assert.equal((await fetch(origin + '/subscriber-resource', { headers: { 'SIGN-IN-WITH-X': 'bad-proof' } })).status, 401);
  const first = await setup(header), second = await setup(header);
  assert.equal(first.status, 201); assert.equal(second.status, 200);
  const details = await first.json();
  assert.deepEqual((await second.json()).record, details.record);
  assert.equal(details.record.status, undefined);
  const response = await requestPayment(header, details.record.id, required);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('payment-response'));
  assert.equal(paymentCalls, 1);
  const forwarded = lastForwarded as any;
  assert.equal(forwarded.subscriberWallet, wallet.address.toLowerCase());
  assert.equal(forwarded.resourceUrl, origin + '/subscriber-resource');
  assert.equal(forwarded.payment.payload.recordId, details.record.id);
  assert.equal((await requestPayment(header, details.record.id, required)).status, 200);
  assert.equal(paymentCalls, 1);
  assert.deepEqual((await store.db.listCollections().toArray()).map(collection => collection.name), ['customers']);
  assert.equal('renewDue' in merchant, false); assert.equal('publicClient' in merchant, false);
  assert.equal('walletClient' in merchant, false); assert.equal('setups' in store, false);
});

test('closed Plans preserve paid access, status and admitted unpaid continuation', async () => {
  const { header } = await proof();
  const completed = await (await setup(header)).json();
  plans.get('P')!.acceptingNewSubscriptions = false;
  const unauthenticated = await fetch(origin + '/subscriber-resource');
  const noOffer = decodePaymentRequiredHeader(unauthenticated.headers.get('payment-required')!);
  assert.equal(noOffer.accepts.length, 0);
  assert.ok(noOffer.extensions!['sign-in-with-x']);
  const authenticated = await fetch(origin + '/subscriber-resource', { headers: { 'SIGN-IN-WITH-X': header } });
  const continuation = decodePaymentRequiredHeader(authenticated.headers.get('payment-required')!);
  assert.equal(continuation.accepts[0].extra?.planId, 'P');
  assert.equal((await setup(header)).status, 200);
  subscriptions[0].currentPeriod = period(); subscriptions[0].renewalEnabled = false;
  assert.equal((await fetch(origin + '/subscriber-resource', { headers: { 'SIGN-IN-WITH-X': header } })).status, 200);
  const status = await (await fetch(origin + '/subscriptions/status?subscriber=' + wallet.address)).json();
  assert.equal(status.subscription.id, completed.record.id);
  assert.equal(status.subscription.planId, 'P');
  assert.equal(status.subscription.network, 'eip155:84532');
  assert.equal(status.renewalEnabled, false);
  assert.equal(status.accessPaid, true);
});

test('paid coverage wins over grace, grace wins over unpaid setup, and pagination completes', async () => {
  const paid = seed('old-paid', true, new Date(Date.now() - 60_000).toISOString());
  const grace = seed('newer-grace');
  grace.currentPeriod = period(-90_000);
  seed('new-unpaid', false);
  pageSize = 1;
  const { header } = await proof();
  const status = await (await fetch(origin + '/subscriptions/status?subscriber=' + wallet.address)).json();
  assert.equal(status.subscription.id, 'old-paid');
  assert.equal((await fetch(origin + '/subscriber-resource', { headers: { 'SIGN-IN-WITH-X': header } })).status, 200);
  paid.currentPeriod = period(-180_000);
  assert.equal((await (await fetch(origin + '/subscriptions/status?subscriber=' + wallet.address)).json()).subscription.id, 'newer-grace');
  assert.equal((await fetch(origin + '/subscriber-resource', { headers: { 'SIGN-IN-WITH-X': header } })).status, 200);
  secondPageFailure = true;
  assert.equal((await fetch(origin + '/subscriptions/status?subscriber=' + wallet.address)).status, 503);
  assert.equal((await fetch(origin + '/subscriber-resource', { headers: { 'SIGN-IN-WITH-X': header } })).status, 503);
  assert.equal(paymentCalls, 0);
});

test('read failure is unavailable, not missing coverage', async () => {
  seed('paid', true);
  const { header } = await proof();
  readFailure = true;
  const response = await fetch(origin + '/subscriber-resource', { headers: { 'SIGN-IN-WITH-X': header } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'subscription_service_unavailable' });
  assert.equal((await fetch(origin + '/subscriptions/status?subscriber=' + wallet.address)).status, 503);
});

test('pending, failed and unavailable collection have distinct responses and no payment confirmation', async () => {
  const { header, required } = await proof();
  const completed = await (await setup(header)).json();
  for (const [value, code] of [['pending', 'subscription_payment_pending'], ['failed', 'subscription_payment_failed'], ['unavailable', 'subscription_service_unavailable']] as const) {
    mode = value;
    const response = await requestPayment(header, completed.record.id, required);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('payment-response'), null);
    assert.equal((await response.json()).code, code);
  }
});

test('recovered old success does not grant current access or manufacture another paid period', async () => {
  const { header, required } = await proof();
  const completed = await (await setup(header)).json();
  mode = 'old-success';
  const response = await requestPayment(header, completed.record.id, required);
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('payment-response'), null);
  assert.equal(subscriptions[0].currentPeriod, null);
  assert.equal(paymentCalls, 1);
});

test('collection conflict rereads confirmed coverage', async () => {
  const { header, required } = await proof();
  const completed = await (await setup(header)).json();
  mode = 'conflict';
  const response = await requestPayment(header, completed.record.id, required);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('payment-response'), null);
});

test('product denial during paid coverage or grace does not request another payment', async () => {
  const subscription = seed('paid', true);
  const { header } = await proof();
  const original = merchant.currentView.bind(merchant);
  merchant.currentView = async address => ({ ...await original(address), accessPaid: false }) as SubscriptionView;
  try {
    for (const offset of [0, -90_000]) {
      subscription.currentPeriod = period(offset);
      const response = await fetch(origin + '/subscriber-resource', { headers: { 'SIGN-IN-WITH-X': header } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('payment-required'), null);
      assert.equal(paymentCalls, 0);
    }
  } finally { merchant.currentView = original; }
});

test('operator views expose public records and retain notes-only editing and authentication', async () => {
  const { header, required } = await proof();
  const completed = await (await setup(header)).json();
  await requestPayment(header, completed.record.id, required);
  subscriptions[0].renewalEnabled = false; subscriptions[0].canceledAt = new Date().toISOString();
  assert.equal((await fetch(origin + '/admin/customers')).status, 401);
  assert.equal((await fetch(origin + '/dashboard')).status, 401);
  const authorization = 'Basic ' + Buffer.from('operator:' + process.env.OPERATOR_PASSWORD).toString('base64');
  const rows = await (await fetch(origin + '/admin/customers', { headers: { authorization } })).json();
  assert.equal(rows.customers.length, 1);
  assert.equal(rows.customers[0].latestCollection.outcome, 'succeeded');
  const response = await fetch(origin + '/admin/customers/' + wallet.address, { headers: { authorization } });
  const detail = await response.json();
  assert.equal(detail.subscriptions[0].id, completed.record.id);
  assert.equal(detail.subscriptions[0].renewalEnabled, false);
  assert.equal(detail.payments[0].status, 'succeeded');
  assert.equal(detail.agreements, undefined); assert.equal(detail.attempts, undefined);
  const path = origin + '/admin/customers/' + wallet.address;
  assert.equal((await fetch(path, { method: 'PATCH', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ currentPeriod: period() }) })).status, 400);
  assert.equal((await fetch(path, { method: 'PATCH', headers: { authorization, origin: 'https://other.fixture', 'content-type': 'application/json' }, body: JSON.stringify({ note: 'Wrong origin' }) })).status, 403);
  assert.equal((await fetch(path, { method: 'PATCH', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ note: 'Follow up' }) })).status, 200);
  assert.equal((await store.customers.findOne({ _id: wallet.address.toLowerCase() }))?.note, 'Follow up');
});
