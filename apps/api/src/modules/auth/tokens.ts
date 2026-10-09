import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token for cookies and emailed links. Only its hash is ever stored. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
