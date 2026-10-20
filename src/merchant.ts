import { ApiClient, type CreateSubscriptionPaymentRequest, type Subscription, type SubscriptionPayment, type SubscriptionPlan, type SubscriptionSetupRecord } from '@shodai-network/agreements-api-client';
import { getAddress } from 'viem';
import { merchantConfig, type MerchantConfig } from './config.js';
import { Store } from './store.js';

export type SubscriptionView = {
  subscription: Subscription;
  plan: SubscriptionPlan;
  record: SubscriptionSetupRecord | null;
  paidThrough: string | null;
  renewalEnabled: boolean | null;
  accessPaid: boolean | null;
  latest: SubscriptionPayment | null;
};

export function coversNow(subscription: Pick<Subscription, 'currentPeriod'>, at = Date.now()): boolean {
  return !!subscription.currentPeriod && Date.parse(subscription.currentPeriod.startsAt) <= at && at < Date.parse(subscription.currentPeriod.endsAt);
}

export function unixSeconds(value: string): string {
  return String(Math.floor(Date.parse(value) / 1000));
}

export class Merchant {
  constructor(readonly store: Store, readonly config: MerchantConfig = merchantConfig(), readonly api = new ApiClient({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey })) {}

  applicable(planId: string): boolean { return this.config.planIds.includes(planId); }

  async subscriptions(wallet: string, reusableSetup?: true): Promise<Subscription[]> {
    const records: Subscription[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.api.listSubscriptions({ subscriberWallet: wallet, ...(reusableSetup ? { reusableSetup } : {}), limit: 100, ...(cursor ? { cursor } : {}) });
      records.push(...page.data.filter(subscription => this.applicable(subscription.planId)));
      cursor = page.pageInfo.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error('Subscription pagination did not advance');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return records;
  }

  async offerPlan(wallet?: string): Promise<SubscriptionPlan | null> {
    if (wallet) {
      const reusable = await this.subscriptions(wallet, true);
      if (reusable.length) return this.api.getSubscriptionPlan(reusable[0].planId);
    }
    for (const id of this.config.planIds) {
      const plan = await this.api.getSubscriptionPlan(id);
      if (plan.acceptingNewSubscriptions) return plan;
    }
    return null;
  }

  async view(subscription: Subscription): Promise<SubscriptionView> {
    const plan = await this.api.getSubscriptionPlan(subscription.planId);
    const { record } = await this.api.getSubscriptionSetup(subscription.id);
    const latest = (await this.api.listSubscriptionPayments(subscription.id, { limit: 1 })).data[0] ?? null;
    return { subscription, plan, record, latest, renewalEnabled: subscription.renewalEnabled,
      paidThrough: record ? subscription.currentPeriod ? unixSeconds(subscription.currentPeriod.endsAt) : '0' : null,
      accessPaid: record ? coversNow(subscription) : null };
  }

  async currentView(wallet: string): Promise<SubscriptionView | null> {
    const records = await this.subscriptions(wallet);
    const selected = records.find(subscription => coversNow(subscription)) ?? records[0];
    return selected ? this.view(selected) : null;
  }

  setup(wallet: string, planId: string) {
    if (!this.applicable(planId)) throw new Error('Plan does not apply to this resource');
    return this.api.createOrResumeSubscription({ planId, subscriberWallet: wallet });
  }

  collect(subscriptionId: string, subscriberWallet: string, resourceUrl: string, payment: CreateSubscriptionPaymentRequest['payment']) {
    return this.api.createOrRecoverSubscriptionPayment(subscriptionId, { subscriberWallet, resourceUrl, payment });
  }

  async payments(subscriptionId: string): Promise<SubscriptionPayment[]> {
    const records: SubscriptionPayment[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.api.listSubscriptionPayments(subscriptionId, { limit: 100, ...(cursor ? { cursor } : {}) });
      records.push(...page.data);
      cursor = page.pageInfo.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error('Payment pagination did not advance');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return records;
  }

  async status(wallet: string) {
    const view = await this.currentView(wallet);
    if (!view) return { subscription: null, renewalEnabled: null, accessPaid: null, paidThrough: null, latestCollection: null, renewalError: null };
    const { subscription, record, plan, latest } = view;
    return {
      subscription: { id: subscription.id, planId: plan.id, network: plan.network, subscriber: getAddress(subscription.subscriberWallet), merchant: plan.recipient,
        payer: record?.payer ?? null, agreement: record?.agreement ?? null, adapter: record?.adapter ?? null },
      renewalEnabled: view.renewalEnabled, accessPaid: view.accessPaid, paidThrough: view.paidThrough,
      latestCollection: latest ? { recordId: subscription.id, kind: latest.kind === 'renewal' ? 'automatic' : 'initial', attemptedAt: latest.attemptedAt,
        outcome: latest.status === 'succeeded' ? 'success' : latest.status, transaction: latest.transactionHash,
        paidThrough: latest.coveredPeriod ? unixSeconds(latest.coveredPeriod.endsAt) : null, error: latest.failureReason } : null,
      renewalError: latest?.kind === 'renewal' && latest.status === 'failed' ? latest.failureReason : null,
    };
  }
}
