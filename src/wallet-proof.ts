import { randomBytes } from 'node:crypto';
import { buildSIWxSchema, parseSIWxHeader, validateSIWxMessage, verifySIWxSignature } from '@x402/extensions/sign-in-with-x';
import { getAddress } from 'viem';

export const NETWORK = 'eip155:84532';

export function siwxExtension(resource: string) {
  const now = Date.now();
  return {
    'sign-in-with-x': {
      info: {
        domain: new URL(resource).host,
        uri: resource,
        statement: 'Authenticate to the merchant subscription resource.',
        version: '1',
        nonce: randomBytes(16).toString('hex'),
        issuedAt: new Date(now).toISOString(),
        expirationTime: new Date(now + 600_000).toISOString(),
      },
      supportedChains: [{ chainId: NETWORK, type: 'eip191' }],
      schema: buildSIWxSchema(),
    },
  };
}

export async function verifyWalletProof(header: string, resource: string): Promise<string> {
  try {
    const proof = parseSIWxHeader(header);
    const issued = Date.parse(proof.issuedAt);
    const expiry = Date.parse(proof.expirationTime || '');
    if (proof.chainId !== NETWORK || proof.type !== 'eip191' || proof.version !== '1' || proof.uri !== resource ||
        !Number.isFinite(issued) || !Number.isFinite(expiry) || issued > Date.now() + 30_000 ||
        expiry <= Date.now() || expiry - issued > 600_000) throw new Error('Unsupported SIWx proof');
    const message = await validateSIWxMessage(proof, new URL(resource), { maxAge: 600_000 });
    const signature = await verifySIWxSignature(proof);
    if (!message.isValid || !signature.isValid || !signature.payer ||
        getAddress(signature.payer) !== getAddress(proof.address)) throw new Error('Invalid SIWx signature');
    return getAddress(proof.address).toLowerCase();
  } catch {
    throw new Error('Invalid or expired SIGN-IN-WITH-X proof');
  }
}
