import { loadKeyRing, type KeyRing } from '@sc/shared/crypto';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  WEBHOOK_PORT: z.coerce.number().int().default(4002),
  REALTIME_PORT: z.coerce.number().int().default(4003),
  /** app_login: tenant data under RLS. Never an owner or superuser. */
  APP_DATABASE_URL: z.string().url(),
  /** auth_login: password hashes, sessions, one-time tokens. Auth module only. */
  AUTH_DATABASE_URL: z.string().url(),
  /** worker_login: the webhook receiver stores raw events through this. Webhook entrypoint only. */
  WORKER_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),
  /** Public origin of the web app: used in emailed links and for the Origin check. */
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: bool,
  /** Meta app credentials. The secret verifies webhook signatures. */
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  /** Public base URL of the webhook receiver (a tunnel in dev), shown on the channels page. */
  PUBLIC_WEBHOOK_URL: z.string().url().optional(),
  /** Lets owners inject fake customer messages to try the inbox. Never enable in production. */
  ENABLE_DEV_SIMULATOR: bool,
});

export type Config = z.infer<typeof schema> & {
  cookieSecure: boolean;
  simulatorEnabled: boolean;
  /** Channel-token encryption keys (CHANNEL_KEY_V<n>), or null when none are configured. */
  keyRing: KeyRing | null;
};

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  // A blank value in .env (KEY=) means "not set".
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment: ${fields}`);
  }
  const cfg = parsed.data;
  let keyRing: KeyRing | null = null;
  try {
    keyRing = loadKeyRing(env);
  } catch (err) {
    // A malformed key is a deployment mistake worth failing on; a missing key just disables connecting channels.
    if (err instanceof Error && !err.message.startsWith('No CHANNEL_KEY')) throw err;
  }
  return {
    ...cfg,
    cookieSecure: cfg.COOKIE_SECURE ?? cfg.NODE_ENV !== 'development',
    simulatorEnabled: cfg.NODE_ENV !== 'production' && (cfg.ENABLE_DEV_SIMULATOR ?? false),
    keyRing,
  };
}

export const CONFIG = Symbol('CONFIG');
