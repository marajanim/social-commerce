import { hash, verify } from '@node-rs/argon2';

// Argon2id, OWASP-recommended minimum parameters. Exposed as '@sc/shared/password' (not from
// the package index) so the web bundle never pulls in the native module.
const OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
