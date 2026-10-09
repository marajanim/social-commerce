import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, writeAudit, writeOutbox, type Database } from '@sc/db';
import type {
  ChannelAccountDto,
  ChannelKeyName,
  ChannelSetupDto,
  MetaPendingPagesDto,
  connectMessengerBody,
} from '@sc/shared';
import { decryptSecret, encryptSecret } from '@sc/shared/crypto';
import { and, eq, lt } from 'drizzle-orm';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import type { AuthContext } from '../../common/decorators';
import { CONFIG, type Config } from '../../config';
import { DATABASE } from '../../db/db.module';
import { META_GRAPH, buildLoginUrl, type MetaGraph } from './meta-graph';

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
};

const PENDING_TTL_MS = 10 * 60 * 1000;

export type OAuthResult =
  | { kind: 'connected'; accountId: string }
  | { kind: 'pick'; sessionId: string }
  | { kind: 'error'; code: 'state' | 'denied' | 'exchange' | 'no_pages' | 'taken' | 'not_configured' | 'subscribe' };

interface StoredPage {
  id: string;
  name: string;
  token: string; // base64 ciphertext
  keyVersion: number;
}

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(META_GRAPH) private readonly graph: MetaGraph,
  ) {}

  private ctx(auth: AuthContext) {
    return this.db.tenantDb({ tenantId: auth.tenantId, userId: auth.userId });
  }

  private toDto(a: typeof schema.channelAccounts.$inferSelect, channelName: string): ChannelAccountDto {
    return {
      id: a.id,
      channelKey: a.channelKey as ChannelKeyName,
      channelName,
      externalId: a.externalId,
      displayName: a.displayName,
      status: a.status as ChannelAccountDto['status'],
      connectedAt: a.connectedAt?.toISOString() ?? null,
      lastEventAt: a.lastEventAt?.toISOString() ?? null,
    };
  }

  get redirectUri(): string {
    return `${this.config.WEB_ORIGIN}/api/channels/meta/callback`;
  }

  get oauthConfigured(): boolean {
    return Boolean(this.config.META_APP_ID && this.config.META_APP_SECRET && this.config.keyRing);
  }

  async list(auth: AuthContext): Promise<ChannelAccountDto[]> {
    const rows = await this.ctx(auth).transaction((tx) =>
      tx
        .select({ account: schema.channelAccounts, channelName: schema.channels.name })
        .from(schema.channelAccounts)
        .innerJoin(schema.channels, eq(schema.channels.key, schema.channelAccounts.channelKey))
        .where(eq(schema.channelAccounts.tenantId, auth.tenantId))
        .orderBy(schema.channelAccounts.createdAt),
    );
    return rows.map((r) => this.toDto(r.account, r.channelName));
  }

  setup(): ChannelSetupDto {
    const base = this.config.PUBLIC_WEBHOOK_URL?.replace(/\/$/, '') ?? null;
    return {
      webhookUrl: base ? `${base}/webhooks/meta` : null,
      verifyToken: this.config.META_VERIFY_TOKEN ?? null,
      simulatorEnabled: this.config.simulatorEnabled,
      encryptionConfigured: this.config.keyRing !== null,
      oauthConfigured: this.oauthConfigured,
      oauthRedirectUri: this.redirectUri,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Connect by pasting a Page token (advanced)
  // ---------------------------------------------------------------------------------------------

  async connectMessenger(auth: AuthContext, body: z.infer<typeof connectMessengerBody>): Promise<ChannelAccountDto> {
    if (!this.config.keyRing) {
      throw new BadRequestException('Channel token encryption is not configured on the server (CHANNEL_KEY_V1)');
    }
    const identity = await this.graph.getPageIdentity(body.accessToken);
    if (!identity) throw new BadRequestException('Facebook rejected this access token');
    if (identity.id !== body.pageId) throw new BadRequestException('This token belongs to a different Page');
    try {
      return await this.createMessengerAccount(auth, {
        pageId: body.pageId,
        name: body.displayName ?? identity.name,
        token: body.accessToken,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('This Page is already connected to a workspace');
      throw err;
    }
  }

  /** Stores the Page and its encrypted token, then subscribes the Page to our webhook. */
  private async createMessengerAccount(
    auth: AuthContext,
    page: { pageId: string; name: string; token: string },
  ): Promise<ChannelAccountDto> {
    const ring = this.config.keyRing;
    if (!ring) throw new BadRequestException('Channel token encryption is not configured on the server (CHANNEL_KEY_V1)');
    const { ciphertext, keyVersion } = encryptSecret(page.token, ring);
    const account = await this.ctx(auth).transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.channelAccounts)
        .values({
          tenantId: auth.tenantId,
          channelKey: 'messenger',
          externalId: page.pageId,
          displayName: page.name,
          status: 'connected',
          connectedBy: auth.userId,
          connectedAt: new Date(),
        })
        .returning();
      if (!row) throw new Error('insert returned nothing');
      await tx.insert(schema.channelCredentials).values({
        tenantId: auth.tenantId,
        channelAccountId: row.id,
        encryptedToken: ciphertext,
        keyVersion,
        tokenType: 'page',
      });
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorType: 'user',
        actorId: auth.userId,
        action: 'channel.connected',
        targetType: 'channel_account',
        targetId: row.id,
        after: { channel: 'messenger', externalId: page.pageId },
      });
      await writeOutbox(tx, {
        tenantId: auth.tenantId,
        eventType: 'channels.account.connected',
        aggregateType: 'channel_account',
        aggregateId: row.id,
        payload: { channelAccountId: row.id },
      });
      return row;
    });

    // After the commit (an outside call must not hold a transaction open). Without the subscription
    // Facebook sends us nothing, so a refusal is surfaced as "needs attention".
    const subscribed = await this.graph.subscribePage(page.pageId, page.token);
    if (!subscribed) {
      await this.ctx(auth).transaction((tx) =>
        tx
          .update(schema.channelAccounts)
          .set({ status: 'needs_attention' })
          .where(and(eq(schema.channelAccounts.tenantId, auth.tenantId), eq(schema.channelAccounts.id, account.id))),
      );
      return this.toDto({ ...account, status: 'needs_attention' }, 'Facebook Messenger');
    }
    return this.toDto(account, 'Facebook Messenger');
  }

  // ---------------------------------------------------------------------------------------------
  // "Continue with Facebook"
  // ---------------------------------------------------------------------------------------------

  /** A fresh anti-CSRF state and the Facebook URL to send the browser to. */
  beginOAuth(): { url: string; state: string } {
    const appId = this.config.META_APP_ID;
    if (!appId || !this.oauthConfigured) throw new BadRequestException('Facebook login is not configured on the server');
    const state = randomBytes(24).toString('base64url');
    return { state, url: buildLoginUrl({ appId, redirectUri: this.redirectUri, state, configId: this.config.META_LOGIN_CONFIG_ID }) };
  }

  /**
   * Finishes the login: checks the state against the cookie set when it started, exchanges the code,
   * and either connects the only Page the user manages or stores the list for them to choose from.
   */
  async completeOAuth(
    auth: AuthContext,
    input: { code?: string; state?: string; error?: string; cookieState?: string },
  ): Promise<OAuthResult> {
    const { META_APP_ID: appId, META_APP_SECRET: appSecret, keyRing } = this.config;
    if (!appId || !appSecret || !keyRing) return { kind: 'error', code: 'not_configured' };
    if (!sameSecret(input.state, input.cookieState)) return { kind: 'error', code: 'state' };
    if (input.error || !input.code) return { kind: 'error', code: 'denied' };

    const userToken = await this.graph.exchangeCode({ code: input.code, redirectUri: this.redirectUri, appId, appSecret });
    if (!userToken) return { kind: 'error', code: 'exchange' };
    const pages = await this.graph.listPages(userToken);
    if (!pages) return { kind: 'error', code: 'exchange' };
    if (pages.length === 0) return { kind: 'error', code: 'no_pages' };

    if (pages.length === 1) {
      const only = pages[0];
      if (!only) return { kind: 'error', code: 'no_pages' };
      return this.connectResult(auth, { pageId: only.id, name: only.name, token: only.accessToken });
    }

    const stored: StoredPage[] = pages.map((p) => {
      const enc = encryptSecret(p.accessToken, keyRing);
      return { id: p.id, name: p.name, token: enc.ciphertext.toString('base64'), keyVersion: enc.keyVersion };
    });
    const sessionId = randomUUID();
    await this.ctx(auth).transaction(async (tx) => {
      await tx.delete(schema.channelOauthSessions).where(lt(schema.channelOauthSessions.expiresAt, new Date()));
      await tx.insert(schema.channelOauthSessions).values({
        id: sessionId,
        tenantId: auth.tenantId,
        userId: auth.userId,
        pages: stored,
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      });
    });
    return { kind: 'pick', sessionId };
  }

  private async connectResult(auth: AuthContext, page: { pageId: string; name: string; token: string }): Promise<OAuthResult> {
    try {
      const account = await this.createMessengerAccount(auth, page);
      return account.status === 'connected' ? { kind: 'connected', accountId: account.id } : { kind: 'error', code: 'subscribe' };
    } catch (err) {
      if (isUniqueViolation(err)) return { kind: 'error', code: 'taken' };
      throw err;
    }
  }

  private async loadPending(auth: AuthContext, id: string): Promise<StoredPage[]> {
    const row = await this.ctx(auth).transaction(async (tx) =>
      (
        await tx
          .select()
          .from(schema.channelOauthSessions)
          .where(and(eq(schema.channelOauthSessions.tenantId, auth.tenantId), eq(schema.channelOauthSessions.id, id)))
      )[0],
    );
    // Only the person who logged in with Facebook can finish it, and only for a few minutes.
    if (!row || row.userId !== auth.userId || row.expiresAt.getTime() < Date.now()) {
      throw new NotFoundException('This Facebook login has expired. Start again.');
    }
    return row.pages as StoredPage[];
  }

  async pendingPages(auth: AuthContext, id: string): Promise<MetaPendingPagesDto> {
    const pages = await this.loadPending(auth, id);
    const connected = new Set((await this.list(auth)).filter((a) => a.status !== 'disconnected').map((a) => a.externalId));
    return { id, pages: pages.filter((p) => !connected.has(p.id)).map((p) => ({ id: p.id, name: p.name })) };
  }

  async connectPending(auth: AuthContext, id: string, pageId: string): Promise<ChannelAccountDto> {
    const ring = this.config.keyRing;
    if (!ring) throw new BadRequestException('Channel token encryption is not configured on the server (CHANNEL_KEY_V1)');
    const page = (await this.loadPending(auth, id)).find((p) => p.id === pageId);
    if (!page) throw new NotFoundException('That Page is not in your Facebook login');
    const token = decryptSecret(Buffer.from(page.token, 'base64'), page.keyVersion, ring);
    let account: ChannelAccountDto;
    try {
      account = await this.createMessengerAccount(auth, { pageId: page.id, name: page.name, token });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('This Page is already connected to a workspace');
      throw err;
    }
    await this.ctx(auth).transaction((tx) =>
      tx
        .delete(schema.channelOauthSessions)
        .where(and(eq(schema.channelOauthSessions.tenantId, auth.tenantId), eq(schema.channelOauthSessions.id, id))),
    );
    return account;
  }

  // ---------------------------------------------------------------------------------------------

  /** A website-chat channel that needs no outside account: lets you try the whole inbox. */
  async ensureDemoChannel(auth: AuthContext): Promise<ChannelAccountDto> {
    return this.ctx(auth).transaction(async (tx) => {
      const existing = (
        await tx
          .select()
          .from(schema.channelAccounts)
          .where(and(eq(schema.channelAccounts.tenantId, auth.tenantId), eq(schema.channelAccounts.channelKey, 'webchat')))
      )[0];
      if (existing) {
        if (existing.status !== 'connected') {
          await tx.update(schema.channelAccounts).set({ status: 'connected' }).where(eq(schema.channelAccounts.id, existing.id));
        }
        return this.toDto({ ...existing, status: 'connected' }, 'Website chat');
      }
      const [row] = await tx
        .insert(schema.channelAccounts)
        .values({
          tenantId: auth.tenantId,
          channelKey: 'webchat',
          externalId: `demo-${randomUUID().slice(0, 12)}`,
          displayName: 'Website chat (demo)',
          status: 'connected',
          connectedBy: auth.userId,
          connectedAt: new Date(),
        })
        .returning();
      if (!row) throw new Error('insert returned nothing');
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorType: 'user',
        actorId: auth.userId,
        action: 'channel.connected',
        targetType: 'channel_account',
        targetId: row.id,
        after: { channel: 'webchat', demo: true },
      });
      return this.toDto(row, 'Website chat');
    });
  }

  async disconnect(auth: AuthContext, id: string): Promise<void> {
    // Stop Facebook sending events for this Page before the token is deleted (best effort).
    const toUnsubscribe = await this.ctx(auth).transaction(async (tx) => {
      const account = (
        await tx
          .select()
          .from(schema.channelAccounts)
          .where(and(eq(schema.channelAccounts.tenantId, auth.tenantId), eq(schema.channelAccounts.id, id)))
      )[0];
      if (!account) throw new NotFoundException('Channel not found');
      const cred = (
        await tx
          .select()
          .from(schema.channelCredentials)
          .where(and(eq(schema.channelCredentials.tenantId, auth.tenantId), eq(schema.channelCredentials.channelAccountId, id)))
      )[0];
      return account.channelKey === 'messenger' && cred && this.config.keyRing
        ? { pageId: account.externalId, token: decryptSecret(cred.encryptedToken, cred.keyVersion, this.config.keyRing) }
        : null;
    });
    if (toUnsubscribe) await this.graph.unsubscribePage(toUnsubscribe.pageId, toUnsubscribe.token).catch(() => undefined);

    await this.ctx(auth).transaction(async (tx) => {
      await tx
        .update(schema.channelAccounts)
        .set({ status: 'disconnected' })
        .where(and(eq(schema.channelAccounts.tenantId, auth.tenantId), eq(schema.channelAccounts.id, id)));
      await tx
        .delete(schema.channelCredentials)
        .where(and(eq(schema.channelCredentials.tenantId, auth.tenantId), eq(schema.channelCredentials.channelAccountId, id)));
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorType: 'user',
        actorId: auth.userId,
        action: 'channel.disconnected',
        targetType: 'channel_account',
        targetId: id,
      });
    });
  }
}

function sameSecret(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
