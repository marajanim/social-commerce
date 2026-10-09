import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { schema, type AuthDb } from '@sc/db';
import type { EmailJob } from '@sc/shared';
import { hashPassword, verifyPassword } from '@sc/shared/password';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { CONFIG, type Config } from '../../config';
import { AUTH_DB } from '../../db/db.module';
import { EMAIL_QUEUE, type EmailQueue } from '../../queues/email-queue';
import { RateLimiter } from './rate-limiter';
import { SessionService } from './session.service';
import { hashToken, newToken } from './tokens';
import { WorkspacesService } from './workspaces.service';

const MIN = 60 * 1000;
const MAX_FAILED = 5;
const LOCK_MS = 15 * MIN;
const RESET_TTL_MS = 60 * MIN;
const VERIFY_TTL_MS = 24 * 60 * MIN;
const INVALID_LOGIN = 'Invalid email or password';

export interface RequestMeta {
  ip: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(AUTH_DB) private readonly authDb: AuthDb,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(EMAIL_QUEUE) private readonly emails: EmailQueue,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  async login(email: string, password: string, meta: RequestMeta) {
    this.limiter.hit(`login:ip:${meta.ip}`, 30, 15 * MIN);
    this.limiter.hit(`login:email:${email}`, 10, 15 * MIN);

    const found = await this.authDb.transaction((tx) =>
      tx
        .select({
          id: schema.users.id,
          hash: schema.userCredentials.passwordHash,
          lockedUntil: schema.userCredentials.lockedUntil,
          failed: schema.userCredentials.failedAttempts,
        })
        .from(schema.users)
        .innerJoin(schema.userCredentials, eq(schema.userCredentials.userId, schema.users.id))
        .where(eq(schema.users.email, email)),
    );
    const user = found[0];

    if (!user?.hash) {
      // Same work as a real check, so timing does not reveal whether the email exists.
      await verifyPassword(await this.getDummyHash(), password);
      throw new UnauthorizedException(INVALID_LOGIN);
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    if (!(await verifyPassword(user.hash, password))) {
      const failed = user.failed + 1;
      await this.authDb.transaction((tx) =>
        tx
          .update(schema.userCredentials)
          .set(
            failed >= MAX_FAILED
              ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }
              : { failedAttempts: failed },
          )
          .where(eq(schema.userCredentials.userId, user.id)),
      );
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    const workspaces = await this.workspaces.listFor(user.id);
    const first = workspaces[0];
    if (!first) throw new ForbiddenException('This account does not belong to any workspace');

    await this.authDb.transaction(async (tx) => {
      await tx
        .update(schema.userCredentials)
        .set({ failedAttempts: 0, lockedUntil: null })
        .where(eq(schema.userCredentials.userId, user.id));
      await tx.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
    });
    return this.sessions.create(user.id, first.tenantId, meta);
  }

  async switchWorkspace(userId: string, sessionId: Buffer, tenantId: string): Promise<void> {
    const mine = await this.workspaces.listFor(userId);
    // 404, not 403: do not reveal that a workspace with this ID exists.
    if (!mine.some((w) => w.tenantId === tenantId)) throw new NotFoundException('Workspace not found');
    await this.sessions.setTenant(sessionId, tenantId);
  }

  async requestPasswordReset(email: string, ip: string): Promise<void> {
    this.limiter.hit(`reset:ip:${ip}`, 10, 60 * MIN);
    this.limiter.hit(`reset:email:${email}`, 3, 60 * MIN);
    const user = await this.findUser(email);
    // Always behave the same, so the response never reveals whether the email has an account.
    if (!user) return;
    const link = await this.issueToken(user.id, 'password_reset', RESET_TTL_MS, '/reset-password');
    await this.emails.enqueue({ to: user.email, template: 'password-reset', link, locale: asLocale(user.locale) });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const hash = await hashPassword(newPassword);
    const userId = await this.authDb.transaction(async (tx) => {
      const rows = await tx
        .update(schema.authTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(schema.authTokens.tokenHash, hashToken(token)),
            eq(schema.authTokens.purpose, 'password_reset'),
            isNull(schema.authTokens.usedAt),
            gt(schema.authTokens.expiresAt, new Date()),
          ),
        )
        .returning({ userId: schema.authTokens.userId });
      const id = rows[0]?.userId;
      if (!id) return null;
      await tx
        .update(schema.userCredentials)
        .set({ passwordHash: hash, passwordChangedAt: new Date(), failedAttempts: 0, lockedUntil: null })
        .where(eq(schema.userCredentials.userId, id));
      return id;
    });
    if (!userId) throw new BadRequestException('This link is invalid or has expired');
    await this.sessions.revokeAllForUser(userId);
  }

  async sendVerification(userId: string): Promise<void> {
    this.limiter.hit(`verify:user:${userId}`, 5, 60 * MIN);
    const rows = await this.authDb.transaction((tx) =>
      tx.select().from(schema.users).where(eq(schema.users.id, userId)),
    );
    const user = rows[0];
    if (!user || user.emailVerifiedAt) return;
    const link = await this.issueToken(user.id, 'email_verify', VERIFY_TTL_MS, '/verify-email');
    await this.emails.enqueue({ to: user.email, template: 'verify-email', link, locale: asLocale(user.locale) });
  }

  async verifyEmail(token: string): Promise<void> {
    const ok = await this.authDb.transaction(async (tx) => {
      const rows = await tx
        .update(schema.authTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(schema.authTokens.tokenHash, hashToken(token)),
            eq(schema.authTokens.purpose, 'email_verify'),
            isNull(schema.authTokens.usedAt),
            gt(schema.authTokens.expiresAt, new Date()),
          ),
        )
        .returning({ userId: schema.authTokens.userId });
      const id = rows[0]?.userId;
      if (!id) return false;
      await tx.update(schema.users).set({ emailVerifiedAt: sql`now()` }).where(eq(schema.users.id, id));
      return true;
    });
    if (!ok) throw new BadRequestException('This link is invalid or has expired');
  }

  private async findUser(email: string) {
    const rows = await this.authDb.transaction((tx) =>
      tx
        .select({ id: schema.users.id, email: schema.users.email, locale: schema.users.locale })
        .from(schema.users)
        .innerJoin(schema.userCredentials, eq(schema.userCredentials.userId, schema.users.id))
        .where(eq(schema.users.email, email)),
    );
    return rows[0] ?? null;
  }

  private async issueToken(
    userId: string,
    purpose: 'password_reset' | 'email_verify',
    ttlMs: number,
    path: string,
  ): Promise<string> {
    const token = newToken();
    await this.authDb.transaction((tx) =>
      tx.insert(schema.authTokens).values({
        userId,
        purpose,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + ttlMs),
      }),
    );
    return `${this.config.WEB_ORIGIN}${path}?token=${token}`;
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword('not-a-real-password');
    return this.dummyHash;
  }
}

function asLocale(locale: string): EmailJob['locale'] {
  return locale === 'bn' ? 'bn' : 'en';
}
