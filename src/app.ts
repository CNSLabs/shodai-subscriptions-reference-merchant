import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { AgreementsApiError } from '@shodai-network/agreements-api-client';
import { formatUnits, getAddress, isAddress } from 'viem';
import { coversNow, hasAccess, Merchant, type SubscriptionView } from './merchant.js';
import { siwxExtension, verifyWalletProof } from './wallet-proof.js';

async function sendRequired(response: Response, origin: string, merchant: Merchant, wallet?: string): Promise<void> {
  const resource = origin + '/subscriber-resource';
  const statusEndpoint = origin + '/subscriptions/status';
  const plan = await merchant.offerPlan(wallet);
  if (plan && !/^eip155:[1-9]\d*$/.test(plan.network)) throw new Error('Unsupported Plan payment network');
  const required = {
    x402Version: 2 as const,
    resource: { url: resource, description: 'Merchant subscriber resource', mimeType: 'application/json' },
    accepts: plan ? [{
      scheme: 'shodai-subscription', network: plan.network as `eip155:${string}`, asset: plan.asset, amount: plan.amount,
      payTo: plan.recipient, maxTimeoutSeconds: 600,
      extra: { version: '1', planId: plan.id, periodDuration: plan.periodSeconds,
        token: { symbol: 'ETH', decimals: 18, formattedAmount: formatUnits(BigInt(plan.amount), 18) },
        agentWalletSetup: { endpoint: origin + '/subscriptions/agent-wallet/setup' }, statusEndpoint,
        cancellationPolicy: 'Cancel stops future renewals; paid access remains until expiry.',
        assetTransferMethod: 'default', paymentFlow: 'upfront' },
    }] : [],
    extensions: { ...siwxExtension(resource), 'shodai-subscription': { version: '1', statusEndpoint } },
  };
  response.set('PAYMENT-REQUIRED', encodePaymentRequiredHeader(required));
  response.status(402).json({ message: 'Subscription required for this resource' });
}

function unavailable(response: Response): void {
  response.status(503).json({ code: 'subscription_service_unavailable' });
}

function sendResource(response: Response, wallet: string, view: SubscriptionView): void {
  response.json({ resource: 'Protected merchant subscriber resource', wallet, paidThrough: view.paidThrough });
}

export function createApp(merchant: Merchant, origin: string): Express {
  const url = new URL(origin);
  if (url.pathname !== '/' || url.username || url.password || url.hash || url.search ||
      (url.protocol !== 'https:' && !(['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:'))) {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin or loopback development URL');
  }
  origin = url.origin;
  const resource = origin + '/subscriber-resource';
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/subscriber-resource', async (request, response) => {
    try {
      const proof = request.header('SIGN-IN-WITH-X');
      if (!proof) return await sendRequired(response, origin, merchant);
      const wallet = await verifyWalletProof(proof, resource);
      await merchant.store.customer(wallet);
      const view = await merchant.currentView(wallet);
      if (view?.accessPaid) return sendResource(response, wallet, view);
      if (view && hasAccess(view.subscription)) return response.status(403).json({ message: 'Product access is not available' });
      const header = request.header('PAYMENT-SIGNATURE');
      if (!header) return await sendRequired(response, origin, merchant, wallet);
      let payment: ReturnType<typeof decodePaymentSignatureHeader>;
      try { payment = decodePaymentSignatureHeader(header); }
      catch { return response.status(400).json({ message: 'Invalid payment message' }); }
      const recordId = payment.payload?.recordId;
      const planId = payment.payload?.planId;
      if (typeof recordId !== 'string' || !recordId || typeof planId !== 'string' || !merchant.applicable(planId)) {
        return response.status(400).json({ message: 'Payment does not identify a Subscription applicable to this resource' });
      }
      let result;
      try { result = (await merchant.collect(recordId, wallet, resource, payment)).data; }
      catch (error) {
        if (error instanceof AgreementsApiError && error.status === 409) {
          const current = await merchant.currentView(wallet);
          if (current?.accessPaid) return sendResource(response, wallet, current);
          if (current && hasAccess(current.subscription)) return response.status(403).json({ message: 'Product access is not available' });
          return await sendRequired(response, origin, merchant, wallet);
        }
        if (error instanceof AgreementsApiError && error.status === 400) return response.status(400).json({ message: error.message });
        throw error;
      }
      if (result.status === 'pending') return response.status(503).json({ code: 'subscription_payment_pending', subscriptionId: recordId, paymentId: result.id });
      if (result.status === 'failed') return response.status(503).json({ code: 'subscription_payment_failed', subscriptionId: recordId, paymentId: result.id, message: result.failureReason });
      const after = await merchant.currentView(wallet);
      if (after?.accessPaid) {
        if (result.transactionHash && coversNow({ currentPeriod: result.coveredPeriod })) {
          response.set('PAYMENT-RESPONSE', encodePaymentResponseHeader({ success: true, transaction: result.transactionHash, network: payment.accepted.network, payer: wallet }));
        }
        return sendResource(response, wallet, after);
      }
      if (after && hasAccess(after.subscription)) return response.status(403).json({ message: 'Product access is not available' });
      return await sendRequired(response, origin, merchant, wallet);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid or expired SIGN-IN-WITH-X')) return response.status(401).json({ message: error.message });
      return unavailable(response);
    }
  });

  app.post('/subscriptions/agent-wallet/setup', async (request: Request, response: Response) => {
    const proof = request.header('SIGN-IN-WITH-X');
    if (!proof) return response.status(401).json({ message: 'SIGN-IN-WITH-X is required' });
    try {
      const wallet = await verifyWalletProof(proof, resource);
      await merchant.store.customer(wallet);
      if (!request.body || Object.keys(request.body).length !== 2 || typeof request.body.planId !== 'string' ||
          !merchant.applicable(request.body.planId) || !isAddress(request.body.agentWallet) ||
          getAddress(request.body.agentWallet).toLowerCase() !== wallet) {
        return response.status(400).json({ message: 'Setup Plan or wallet does not match this resource and proof' });
      }
      const result = await merchant.setup(wallet, request.body.planId);
      return response.status(result.status).json(result.data);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid or expired SIGN-IN-WITH-X')) return response.status(401).json({ message: error.message });
      if (error instanceof AgreementsApiError && [400, 404, 409].includes(error.status)) return response.status(error.status).json({ message: error.message });
      return unavailable(response);
    }
  });

  app.get('/subscriptions/status', async (request, response) => {
    const subscriber = request.query.subscriber;
    if (typeof subscriber !== 'string' || !isAddress(subscriber)) return response.status(400).json({ message: 'Invalid subscriber address' });
    try { return response.json(await merchant.status(getAddress(subscriber).toLowerCase())); }
    catch { return unavailable(response); }
  });

  const password = process.env.OPERATOR_PASSWORD || readFileSync(
    process.env.OPERATOR_PASSWORD_FILE || join(homedir(), '.config', 'shodai', 'customer-stack-operator-password'), 'utf8',
  ).trim();
  if (password.length < 24) throw new Error('Operator password must have at least 24 characters');
  const operatorAuth = (request: Request, response: Response, next: () => void) => {
    const header = request.header('authorization');
    const encoded = header?.startsWith('Basic ') ? header.slice(6) : '';
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const supplied = colon >= 0 && decoded.slice(0, colon) === 'operator' ? decoded.slice(colon + 1) : '';
    const expectedBytes = Buffer.from(password);
    const suppliedBytes = Buffer.from(supplied);
    if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
      response.set('WWW-Authenticate', 'Basic realm="Merchant operator"');
      response.status(401).json({ message: 'Operator credential required' });
      return;
    }
    next();
  };
  app.use('/admin', operatorAuth);
  app.use('/dashboard', operatorAuth);
  app.use('/admin', (request, response, next) => {
    if (request.method === 'PATCH' && request.header('origin') && request.header('origin') !== origin) {
      response.status(403).json({ message: 'Cross-origin edits are not allowed' });
      return;
    }
    next();
  });

  app.get('/admin/customers', async (request, response) => {
    const query = typeof request.query.search === 'string' ? request.query.search.trim().toLowerCase() : '';
    if (query.length > 80) return response.status(400).json({ message: 'Search is too long' });
    try {
      const customers = await merchant.store.customers.find(query ? { _id: { $regex: query.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&') } } : {})
        .sort({ createdAt: -1 }).limit(200).toArray();
      const rows = [];
      for (const customer of customers) {
        const view = await merchant.currentView(customer._id);
        rows.push({ wallet: customer._id, createdAt: customer.createdAt.toISOString(),
          accessPaid: view ? view.accessPaid : false, renewalEnabled: view?.renewalEnabled ?? null,
          paidThrough: view?.paidThrough ?? null,
          latestCollection: view?.latest ? { outcome: view.latest.status, attemptedAt: view.latest.attemptedAt } : null });
      }
      return response.json({ customers: rows });
    } catch { return unavailable(response); }
  });

  app.get('/admin/customers/:wallet', async (request, response) => {
    if (!isAddress(request.params.wallet)) return response.status(400).json({ message: 'Invalid wallet' });
    const wallet = getAddress(request.params.wallet).toLowerCase();
    try {
      const customer = await merchant.store.customers.findOne({ _id: wallet });
      if (!customer) return response.status(404).json({ message: 'Customer not found' });
      const records = await merchant.subscriptions(wallet);
      const view = await merchant.currentView(wallet);
      const subscriptions = [];
      const payments = [];
      for (const subscription of records) {
        const details = await merchant.api.getSubscriptionSetup(subscription.id);
        subscriptions.push({ ...subscription, setup: details.record });
        payments.push(...await merchant.payments(subscription.id));
      }
      return response.json({ wallet, createdAt: customer.createdAt.toISOString(), note: customer.note,
        accessPaid: view ? view.accessPaid : false, renewalEnabled: view?.renewalEnabled ?? null,
        paidThrough: view?.paidThrough ?? null, subscriptions, payments });
    } catch { return unavailable(response); }
  });

  app.patch('/admin/customers/:wallet', async (request, response) => {
    if (!isAddress(request.params.wallet)) return response.status(400).json({ message: 'Invalid wallet' });
    if (!request.body || Object.keys(request.body).length !== 1 || typeof request.body.note !== 'string' || request.body.note.length > 2000) {
      return response.status(400).json({ message: 'Only a note of at most 2000 characters may be edited' });
    }
    const wallet = getAddress(request.params.wallet).toLowerCase();
    const result = await merchant.store.customers.findOneAndUpdate({ _id: wallet }, { $set: { note: request.body.note } }, { returnDocument: 'after' });
    return result ? response.json({ wallet, note: result.note }) : response.status(404).json({ message: 'Customer not found' });
  });

  app.use('/dashboard', express.static(fileURLToPath(new URL('../public', import.meta.url)), { index: 'index.html' }));

  return app;
}
