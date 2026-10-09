import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Channel tokens are encrypted at rest with AES-256-GCM. Keys are versioned and come from the
// environment (CHANNEL_KEY_V1, CHANNEL_KEY_V2, ... each 32 bytes, base64), never the database,
// so rotating means adding a new version and re-encrypting. Layout: iv(12) | tag(16) | ciphertext.
// Exposed as '@sc/shared/crypto' so the web bundle never imports node:crypto.

export interface KeyRing {
  keys: ReadonlyMap<number, Buffer>;
  current: number;
}

export function loadKeyRing(env: Record<string, string | undefined> = process.env): KeyRing {
  const keys = new Map<number, Buffer>();
  for (const [name, value] of Object.entries(env)) {
    const m = /^CHANNEL_KEY_V(\d+)$/.exec(name);
    if (!m || !value) continue;
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded`);
    keys.set(Number(m[1]), key);
  }
  if (keys.size === 0) throw new Error('No CHANNEL_KEY_V<n> configured');
  return { keys, current: Math.max(...keys.keys()) };
}

export function encryptSecret(plain: string, ring: KeyRing): { ciphertext: Buffer; keyVersion: number } {
  const key = ring.keys.get(ring.current);
  if (!key) throw new Error('current key missing');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]), keyVersion: ring.current };
}

export function decryptSecret(ciphertext: Buffer, keyVersion: number, ring: KeyRing): string {
  const key = ring.keys.get(keyVersion);
  if (!key) throw new Error(`key version ${keyVersion} is not configured`);
  const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12));
  decipher.setAuthTag(ciphertext.subarray(12, 28));
  return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]).toString('utf8');
}
