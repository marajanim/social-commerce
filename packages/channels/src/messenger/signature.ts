import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies Meta's X-Hub-Signature-256 over the RAW request body (never a re-serialised JSON).
 * Constant-time comparison; returns false for a missing or malformed header.
 */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signMetaPayload(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
