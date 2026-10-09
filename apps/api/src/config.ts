import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  /** app_login: tenant data under RLS. Never an owner or superuser. */
  APP_DATABASE_URL: z.string().url(),
  /** auth_login: password hashes, sessions, one-time tokens. Auth module only. */
  AUTH_DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** Public origin of the web app: used in emailed links and for the Origin check. */
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: bool,
});

export type Config = z.infer<typeof schema> & { cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment: ${fields}`);
  }
  const cfg = parsed.data;
  return { ...cfg, cookieSecure: cfg.COOKIE_SECURE ?? cfg.NODE_ENV !== 'development' };
}

export const CONFIG = Symbol('CONFIG');
