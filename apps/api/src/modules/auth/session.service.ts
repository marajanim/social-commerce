import { Inject, Injectable } from '@nestjs/common';
import { schema, type AuthDb } from '@sc/db';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { CONFIG, type Config } from '../../config';
import { AUTH_DB } from '../../db/db.module';
import { hashToken, newToken } from './tokens';

export const SESSION_COOKIE = 'sid';
const TOUCH_AFTER_MS = 5 * 60 * 1000;

export interface SessionInfo {
  sessionId: Buffer;
  userId: string;
  tenantId: string | null;
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(AUTH_DB) private readonly authDb: AuthDb,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  get ttlMs(): number {
    return this.config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  async create(
    userId: string,
    tenantId: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = newToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await this.authDb.transaction((tx) =>
      tx.insert(schema.authSessions).values({
        id: hashToken(token),
        userId,
        tenantId,
        expiresAt,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      }),
    );
    return { token, expiresAt };
  }

  async validate(token: string): Promise<SessionInfo | null> {
    const id = hashToken(token);
    const rows = await this.authDb.transaction((tx) =>
      tx
        .select()
        .from(schema.authSessions)
        .where(
          and(
            eq(schema.authSessions.id, id),
            isNull(schema.authSessions.revokedAt),
            gt(schema.authSessions.expiresAt, new Date()),
          ),
        ),
    );
    const s = rows[0];
    if (!s) return null;
    if (Date.now() - s.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
      await this.authDb.transaction((tx) =>
        tx.update(schema.authSessions).set({ lastSeenAt: new Date() }).where(eq(schema.authSessions.id, id)),
      );
    }
    return { sessionId: id, userId: s.userId, tenantId: s.tenantId };
  }

  revoke(sessionId: Buffer): Promise<unknown> {
    return this.authDb.transaction((tx) =>
      tx.update(schema.authSessions).set({ revokedAt: new Date() }).where(eq(schema.authSessions.id, sessionId)),
    );
  }

  /** Used after a password reset: every device signs in again. `except` keeps the caller's session. */
  revokeAllForUser(userId: string, except?: Buffer): Promise<unknown> {
    return this.authDb.transaction((tx) =>
      tx
        .update(schema.authSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.authSessions.userId, userId),
            isNull(schema.authSessions.revokedAt),
            except ? ne(schema.authSessions.id, except) : undefined,
          ),
        ),
    );
  }

  setTenant(sessionId: Buffer, tenantId: string): Promise<unknown> {
    return this.authDb.transaction((tx) =>
      tx.update(schema.authSessions).set({ tenantId }).where(eq(schema.authSessions.id, sessionId)),
    );
  }
}
