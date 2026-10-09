import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, writeAudit, writeOutbox, type Database } from '@sc/db';
import type { ChannelAccountDto, ChannelKeyName, ChannelSetupDto, connectMessengerBody } from '@sc/shared';
import { encryptSecret } from '@sc/shared/crypto';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { AuthContext } from '../../common/decorators';
import { CONFIG, type Config } from '../../config';
import { DATABASE } from '../../db/db.module';
import { META_GRAPH, type MetaGraph } from './meta-graph';

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
};

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
    };
  }

  async connectMessenger(auth: AuthContext, body: z.infer<typeof connectMessengerBody>): Promise<ChannelAccountDto> {
    if (!this.config.keyRing) {
      throw new BadRequestException('Channel token encryption is not configured on the server (CHANNEL_KEY_V1)');
    }
    const identity = await this.graph.getPageIdentity(body.accessToken);
    if (!identity) throw new BadRequestException('Facebook rejected this access token');
    if (identity.id !== body.pageId) throw new BadRequestException('This token belongs to a different Page');

    const { ciphertext, keyVersion } = encryptSecret(body.accessToken, this.config.keyRing);
    const now = new Date();
    try {
      const account = await this.ctx(auth).transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.channelAccounts)
          .values({
            tenantId: auth.tenantId,
            channelKey: 'messenger',
            externalId: body.pageId,
            displayName: body.displayName ?? identity.name,
            status: 'connected',
            connectedBy: auth.userId,
            connectedAt: now,
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
          after: { channel: 'messenger', externalId: body.pageId },
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
      return this.toDto(account, 'Facebook Messenger');
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('This Page is already connected to a workspace');
      }
      throw err;
    }
  }

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
    await this.ctx(auth).transaction(async (tx) => {
      const rows = await tx
        .update(schema.channelAccounts)
        .set({ status: 'disconnected' })
        .where(and(eq(schema.channelAccounts.tenantId, auth.tenantId), eq(schema.channelAccounts.id, id)))
        .returning({ id: schema.channelAccounts.id });
      if (rows.length === 0) throw new NotFoundException('Channel not found');
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
