import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { addMember, createWorkspaceWithOwner } from '@sc/db';
import { createTestDatabase, type TestDatabase } from '@sc/db/test-support';
import type { EmailJob, MeResponse } from '@sc/shared';
import { hashPassword } from '@sc/shared/password';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { RequirePermission } from '../src/common/decorators';
import { testConfig } from './helpers';
import { RateLimiter } from '../src/modules/auth/rate-limiter';
import { EMAIL_QUEUE } from '../src/queues/email-queue';

const PASSWORD = 'correct-horse-battery';
const ORIGIN = 'http://localhost:3000';

// Stand-in for an Admin-only endpoint (the real ones arrive with M0-7).
@Controller('probe')
class ProbeController {
  @RequirePermission('members.manage')
  @Get('admin-only')
  adminOnly() {
    return { ok: true };
  }
}
@Controller('undeclared')
class UndeclaredController {
  @Get()
  get() {
    return { ok: true };
  }
}

let db: TestDatabase;
let app: NestFastifyApplication;
const sent: EmailJob[] = [];
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const passwordHash = await hashPassword(PASSWORD);
  const a = await createWorkspaceWithOwner(db.owner, {
    name: 'Shop A',
    slug: 'shop-a',
    owner: { email: 'owner-a@example.test', name: 'Owner A', passwordHash },
  });
  const b = await createWorkspaceWithOwner(db.owner, {
    name: 'Shop B',
    slug: 'shop-b',
    owner: { email: 'owner-b@example.test', name: 'Owner B', passwordHash },
  });
  tenantA = a.tenantId;
  tenantB = b.tenantId;
  await addMember(db.owner, a.tenantId, 'agent', { email: 'agent@example.test', name: 'Agent', passwordHash });
  // One person in both workspaces.
  await addMember(db.owner, b.tenantId, 'admin', { email: 'owner-a@example.test', name: 'Owner A', passwordHash });

  const config = testConfig(db.urls);
  const mod = await Test.createTestingModule({
    imports: [buildAppModule(config, [ProbeController, UndeclaredController])],
  })
    .overrideProvider(EMAIL_QUEUE)
    .useValue({ enqueue: async (job: EmailJob) => void sent.push(job) })
    .compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await setupApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await db?.stop();
});

// Counters are per email/IP in memory; each test starts clean (the rate-limit test fills its own).
beforeEach(() => app.get(RateLimiter).reset());

let ipCounter = 0;
const nextIp = () => `10.0.0.${++ipCounter}`;

async function post(url: string, payload: unknown, opts: { sid?: string; ip?: string; origin?: string } = {}) {
  return app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    remoteAddress: opts.ip ?? nextIp(),
    headers: opts.origin ? { origin: opts.origin } : {},
    cookies: opts.sid ? { sid: opts.sid } : {},
  });
}
async function login(email: string, password = PASSWORD): Promise<string> {
  const res = await post('/auth/login', { email, password });
  expect(res.statusCode).toBe(200);
  return res.cookies.find((c) => c.name === 'sid')?.value ?? '';
}
const get = (url: string, sid?: string) => app.inject({ method: 'GET', url, cookies: sid ? { sid } : {} });

describe('login and session', () => {
  it('sets an HttpOnly, Secure, SameSite=Lax session cookie and /me reflects the account', async () => {
    const res = await post('/auth/login', { email: 'OWNER-A@example.test', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'sid');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

    const me = (await get('/me', cookie?.value)).json<MeResponse>();
    expect(me.user.email).toBe('owner-a@example.test');
    expect(me.user.emailVerified).toBe(true);
    expect(me.workspace.roleKey).toBe('owner');
    expect(me.permissions['billing.manage']).toBe('all');
    expect(me.workspaces.map((w) => w.name).sort()).toEqual(['Shop A', 'Shop B']);
  });

  it('stores only a hash of the session token', async () => {
    const sid = await login('owner-a@example.test');
    const { rows } = await db.owner.query<{ id: Buffer }>('SELECT id FROM auth.sessions');
    expect(rows.every((r) => r.id.toString('base64url') !== sid)).toBe(true);
    expect(rows.every((r) => r.id.length === 32)).toBe(true);
  });

  it('rejects a wrong password and an unknown email with the same message', async () => {
    const wrong = await post('/auth/login', { email: 'owner-a@example.test', password: 'nope-nope-nope' });
    const unknown = await post('/auth/login', { email: 'nobody@example.test', password: PASSWORD });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().message).toBe(unknown.json().message);
    expect(wrong.cookies).toHaveLength(0);
  });

  it('locks the account after 5 wrong passwords, even for the right one', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post('/auth/login', { email: 'agent@example.test', password: 'bad-password-1' })).statusCode).toBe(401);
    }
    const right = await post('/auth/login', { email: 'agent@example.test', password: PASSWORD });
    expect(right.statusCode).toBe(401);
    await db.owner.query(
      `UPDATE auth.user_credentials SET locked_until = NULL, failed_attempts = 0
       WHERE user_id = (SELECT id FROM users WHERE email = 'agent@example.test')`,
    );
    expect((await post('/auth/login', { email: 'agent@example.test', password: PASSWORD })).statusCode).toBe(200);
  });

  it('rate-limits login attempts per email with 429', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await post('/auth/login', { email: 'ratelimit@example.test', password: 'whatever-123' })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('validates the body', async () => {
    expect((await post('/auth/login', { email: 'not-an-email', password: 'x' })).statusCode).toBe(400);
    expect((await post('/auth/login', {})).statusCode).toBe(400);
  });

  it('logout revokes the session', async () => {
    const sid = await login('owner-a@example.test');
    expect((await get('/me', sid)).statusCode).toBe(200);
    expect((await post('/auth/logout', {}, { sid })).statusCode).toBe(200);
    expect((await get('/me', sid)).statusCode).toBe(401);
  });

  it('refuses expired and unknown sessions', async () => {
    const sid = await login('owner-a@example.test');
    expect((await get('/me', 'not-a-real-token')).statusCode).toBe(401);
    await db.owner.query(`UPDATE auth.sessions SET expires_at = now() - interval '1 minute'`);
    expect((await get('/me', sid)).statusCode).toBe(401);
  });
});

describe('guards', () => {
  it('serves /health without a session and /me needs one', async () => {
    expect((await get('/health')).statusCode).toBe(200);
    expect((await get('/me')).statusCode).toBe(401);
  });

  it('gives an Agent 403 on an Admin-only endpoint and the Owner 200', async () => {
    const agent = await login('agent@example.test');
    const owner = await login('owner-a@example.test');
    expect((await get('/probe/admin-only', agent)).statusCode).toBe(403);
    expect((await get('/probe/admin-only', owner)).statusCode).toBe(200);
  });

  it('refuses a route that declares neither @Public nor @RequirePermission', async () => {
    const owner = await login('owner-a@example.test');
    expect((await get('/undeclared', owner)).statusCode).toBe(403);
    expect((await get('/undeclared')).statusCode).toBe(403);
  });

  it('refuses a state-changing request from another origin', async () => {
    const res = await post('/auth/login', { email: 'owner-a@example.test', password: PASSWORD }, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    const ok = await post('/auth/login', { email: 'owner-a@example.test', password: PASSWORD }, { origin: ORIGIN });
    expect(ok.statusCode).toBe(200);
  });

  it('drops a session whose membership was deactivated', async () => {
    const sid = await login('agent@example.test');
    await db.owner.query(
      `UPDATE memberships SET status = 'deactivated' WHERE user_id = (SELECT id FROM users WHERE email = 'agent@example.test')`,
    );
    expect((await get('/me', sid)).statusCode).toBe(401);
    await db.owner.query(`UPDATE memberships SET status = 'active' WHERE status = 'deactivated'`);
  });
});

describe('workspaces', () => {
  it('switches between the user’s own workspaces', async () => {
    const sid = await login('owner-a@example.test');
    const before = (await get('/me', sid)).json<MeResponse>();
    const other = before.workspaces.find((w) => w.tenantId !== before.workspace.tenantId);
    expect(other).toBeDefined();
    expect((await post('/auth/switch-workspace', { tenantId: other?.tenantId }, { sid })).statusCode).toBe(200);
    const after = (await get('/me', sid)).json<MeResponse>();
    expect(after.workspace.tenantId).toBe(other?.tenantId);
    expect(after.workspace.roleKey).not.toBe(before.workspace.roleKey);
  });

  it('rejects a workspace the user is not a member of with 404', async () => {
    const sid = await login('agent@example.test'); // member of A only
    const res = await post('/auth/switch-workspace', { tenantId: tenantB }, { sid });
    expect(res.statusCode).toBe(404);
    expect((await get('/me', sid)).json<MeResponse>().workspace.tenantId).toBe(tenantA);
  });

  it('does not reveal another tenant’s data through /me', async () => {
    const sid = await login('agent@example.test');
    const me = (await get('/me', sid)).json<MeResponse>();
    expect(JSON.stringify(me)).not.toContain('Shop B');
    expect(JSON.stringify(me)).not.toContain('owner-b@example.test');
  });
});

describe('password reset', () => {
  it('answers 202 for unknown emails and sends nothing', async () => {
    const before = sent.length;
    expect((await post('/auth/forgot-password', { email: 'ghost@example.test' })).statusCode).toBe(202);
    expect(sent.length).toBe(before);
  });

  it('emails a single-use link; resetting changes the password and signs out other devices', async () => {
    const oldSid = await login('owner-b@example.test');
    const before = sent.length;
    expect((await post('/auth/forgot-password', { email: 'owner-b@example.test' })).statusCode).toBe(202);
    expect(sent.length).toBe(before + 1);
    const job = sent[sent.length - 1] as EmailJob;
    expect(job).toMatchObject({ to: 'owner-b@example.test', template: 'password-reset' });
    const token = new URL(job.link).searchParams.get('token') ?? '';
    expect(job.link.startsWith(`${ORIGIN}/reset-password?token=`)).toBe(true);

    const bad = await post('/auth/reset-password', { token, password: 'short' });
    expect(bad.statusCode).toBe(400);

    expect((await post('/auth/reset-password', { token, password: 'a-brand-new-password' })).statusCode).toBe(200);
    expect((await post('/auth/reset-password', { token, password: 'another-new-password' })).statusCode).toBe(400);
    expect((await get('/me', oldSid)).statusCode).toBe(401);
    expect((await post('/auth/login', { email: 'owner-b@example.test', password: PASSWORD })).statusCode).toBe(401);
    expect((await post('/auth/login', { email: 'owner-b@example.test', password: 'a-brand-new-password' })).statusCode).toBe(200);
  });

  it('rejects an expired link and a made-up token', async () => {
    await post('/auth/forgot-password', { email: 'owner-b@example.test' });
    const job = sent[sent.length - 1] as EmailJob;
    const token = new URL(job.link).searchParams.get('token') ?? '';
    await db.owner.query(`UPDATE auth.auth_tokens SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    expect((await post('/auth/reset-password', { token, password: 'yet-another-password' })).statusCode).toBe(400);
    expect((await post('/auth/reset-password', { token: 'x'.repeat(43), password: 'yet-another-password' })).statusCode).toBe(400);
  });
});

describe('email verification', () => {
  it('verifies the address through the emailed link, once', async () => {
    await db.owner.query(`UPDATE users SET email_verified_at = NULL WHERE email = 'agent@example.test'`);
    const sid = await login('agent@example.test');
    expect((await get('/me', sid)).json<MeResponse>().user.emailVerified).toBe(false);

    expect((await post('/auth/send-verification', {}, { sid })).statusCode).toBe(202);
    const job = sent[sent.length - 1] as EmailJob;
    expect(job).toMatchObject({ to: 'agent@example.test', template: 'verify-email' });
    const token = new URL(job.link).searchParams.get('token') ?? '';

    expect((await post('/auth/verify-email', { token })).statusCode).toBe(200);
    expect((await get('/me', sid)).json<MeResponse>().user.emailVerified).toBe(true);
    expect((await post('/auth/verify-email', { token })).statusCode).toBe(400);
  });
});
