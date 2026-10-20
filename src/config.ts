import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type MerchantConfig = { apiKey: string; apiBaseUrl: string; planIds: string[] };

export function merchantConfig(): MerchantConfig {
  const planIds = [...new Set((process.env.SUBSCRIPTION_PLAN_IDS || '').split(',').map(value => value.trim()).filter(Boolean))];
  if (!planIds.length) throw new Error('SUBSCRIPTION_PLAN_IDS must name the Plans applicable to the protected resource');
  return {
    apiKey: process.env.SHODAI_API_KEY?.trim() || readFileSync(process.env.SHODAI_API_KEY_FILE || join(homedir(), '.config', 'shodai', 'customer-stack-api-key'), 'utf8').trim(),
    apiBaseUrl: process.env.SHODAI_API_BASE_URL || 'https://dev.cnslabs.cloud',
    planIds,
  };
}
