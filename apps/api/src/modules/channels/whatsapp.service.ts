import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { GRAPH_VERSION } from '@sc/channels';
import { schema, writeAudit, type Database } from '@sc/db';
import type { ChannelAccountDto, connectWhatsAppBody, completeWhatsAppBody } from '@sc/shared';
import { decryptSecret, encryptSecret } from '@sc/shared/crypto';
import { and, eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import type { AuthContext } from '../../common/decorators';
import { CONFIG, type Config } from '../../config';
import { DATABASE } from '../../db/db.module';

export const WHATSAPP_GRAPH = Symbol('WHATSAPP_GRAPH');
interface Phone { id: string; display_phone_number?: string; verified_name?: string; status?: string }
export interface WhatsAppGraph {
  exchange(code: string, appId: string, appSecret: string): Promise<string | null>;
  phone(token: string, wabaId: string, phoneId: string): Promise<Phone | null>;
  subscribe(token: string, wabaId: string): Promise<boolean>;
}
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
async function json<T>(path: string, init: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}/${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.json() as T : null;
  } catch { return null; }
}
export class HttpWhatsAppGraph implements WhatsAppGraph {
  async exchange(code: string, appId: string, appSecret: string): Promise<string | null> {
    const data = await json<{ access_token?: string }>('oauth/access_token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: appId, client_secret: appSecret, code }).toString(),
    });
    return data?.access_token ?? null;
  }
  async phone(token: string, wabaId: string, phoneId: string): Promise<Phone | null> {
    // Verify membership on the server: never trust the IDs reported by the signup popup.
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ fields: 'id,display_phone_number,verified_name,status', limit: '100', ...(after ? { after } : {}) });
      const data = await json<{ data?: Phone[]; paging?: { next?: string; cursors?: { after?: string } } }>(`${wabaId}/phone_numbers?${q}`, { headers: { authorization: `Bearer ${token}` } });
      if (!data?.data) return null;
      const phone = data.data.find(p => p.id === phoneId);
      if (phone) return phone;
      after = data.paging?.next ? data.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return null;
  }
  async subscribe(token: string, wabaId: string): Promise<boolean> {
    return (await json<{ success?: boolean }>(`${wabaId}/subscribed_apps`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }))?.success === true;
  }
}

@Injectable()
export class WhatsAppService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(WHATSAPP_GRAPH) private readonly graph: WhatsAppGraph,
  ) {}
  async complete(auth: AuthContext, body: z.infer<typeof completeWhatsAppBody>, cookie?: string): Promise<ChannelAccountDto> {
    const a = Buffer.from(body.state); const b = Buffer.from(cookie ?? '');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadRequestException('WhatsApp login expired. Start again.');
    const { META_APP_ID, META_APP_SECRET, META_WHATSAPP_CONFIG_ID } = this.config;
    if (!META_APP_ID || !META_APP_SECRET || !META_WHATSAPP_CONFIG_ID) throw new BadRequestException('WhatsApp Embedded Signup is not configured');
    const token = await this.graph.exchange(body.code, META_APP_ID, META_APP_SECRET);
    if (!token) throw new BadRequestException('Meta could not complete WhatsApp authorization. Start again.');
    return this.connect(auth, { ...body, accessToken: token });
  }
  async connect(auth: AuthContext, body: z.infer<typeof connectWhatsAppBody>): Promise<ChannelAccountDto> {
    if (!this.config.keyRing) throw new BadRequestException('Channel token encryption is not configured');
    const phone = await this.graph.phone(body.accessToken, body.wabaId, body.phoneNumberId);
    if (!phone) throw new BadRequestException('Meta could not verify this phone number in the WhatsApp Business account. Check the IDs and token permissions.');
    const ctx = this.db.tenantDb({ tenantId: auth.tenantId, userId: auth.userId });
    const enc = encryptSecret(body.accessToken, this.config.keyRing);
    let account: typeof schema.channelAccounts.$inferSelect;
    try {
      account = await ctx.transaction(async tx => {
        const existing = (await tx.select().from(schema.channelAccounts).where(and(eq(schema.channelAccounts.tenantId, auth.tenantId), eq(schema.channelAccounts.channelKey, 'whatsapp'), eq(schema.channelAccounts.externalId, phone.id))))[0];
        const values = {
          tenantId: auth.tenantId, channelKey: 'whatsapp', externalId: phone.id,
          displayName: [phone.verified_name, phone.display_phone_number].filter(Boolean).join(' · ') || `WhatsApp ${phone.id}`,
          status: 'needs_attention', settings: { wabaId: body.wabaId }, connectedBy: auth.userId, connectedAt: new Date(),
        };
        const [row] = existing
          ? await tx.update(schema.channelAccounts).set({ ...values, updatedAt: new Date() }).where(and(eq(schema.channelAccounts.tenantId, auth.tenantId), eq(schema.channelAccounts.id, existing.id))).returning()
          : await tx.insert(schema.channelAccounts).values(values).returning();
        if (!row) throw new Error('insert returned nothing');
        await tx.insert(schema.channelCredentials).values({ tenantId: auth.tenantId, channelAccountId: row.id, encryptedToken: enc.ciphertext, keyVersion: enc.keyVersion, tokenType: 'whatsapp_business' })
          .onConflictDoUpdate({ target: [schema.channelCredentials.tenantId, schema.channelCredentials.channelAccountId], set: { encryptedToken: enc.ciphertext, keyVersion: enc.keyVersion, rotatedAt: new Date() } });
        await writeAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'channel.connected', targetType: 'channel_account', targetId: row.id, after: { channel: 'whatsapp', externalId: phone.id } });
        return row;
      });
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string } };
      if (e.code === '23505' || e.cause?.code === '23505') throw new ConflictException('This WhatsApp number is already connected to a workspace');
      throw err;
    }
    const subscribed = await this.graph.subscribe(body.accessToken, body.wabaId);
    const status = subscribed && phone.status === 'CONNECTED' ? 'connected' : 'needs_attention';
    await ctx.transaction(tx => tx.update(schema.channelAccounts).set({ status }).where(and(eq(schema.channelAccounts.tenantId, auth.tenantId), eq(schema.channelAccounts.id, account.id))));
    return { id: account.id, channelKey: 'whatsapp', channelName: 'WhatsApp Business', externalId: account.externalId, displayName: account.displayName, status, connectedAt: account.connectedAt?.toISOString() ?? null, lastEventAt: null };
  }
  async retry(auth: AuthContext, id: string): Promise<ChannelAccountDto> {
    if (!this.config.keyRing) throw new BadRequestException('Channel token encryption is not configured');
    const ctx = this.db.tenantDb({ tenantId: auth.tenantId, userId: auth.userId });
    const found = await ctx.transaction(async tx => {
      const account = (await tx.select().from(schema.channelAccounts).where(and(eq(schema.channelAccounts.tenantId, auth.tenantId), eq(schema.channelAccounts.id, id), eq(schema.channelAccounts.channelKey, 'whatsapp'))))[0];
      const cred = (await tx.select().from(schema.channelCredentials).where(and(eq(schema.channelCredentials.tenantId, auth.tenantId), eq(schema.channelCredentials.channelAccountId, id))))[0];
      return { account, cred };
    });
    if (!found.account || found.account.status === 'disconnected') throw new NotFoundException('WhatsApp channel not found');
    if (!found.cred) throw new BadRequestException('Reconnect this number with an authorized token');
    const wabaId = (found.account.settings as { wabaId?: string }).wabaId;
    if (!wabaId) throw new BadRequestException('Reconnect this number to set its WhatsApp Business account');
    const token = decryptSecret(found.cred.encryptedToken, found.cred.keyVersion, this.config.keyRing);
    const phone = await this.graph.phone(token, wabaId, found.account.externalId);
    const status = await this.graph.subscribe(token, wabaId) && phone?.status === 'CONNECTED' ? 'connected' : 'needs_attention';
    await ctx.transaction(tx => tx.update(schema.channelAccounts).set({ status }).where(and(eq(schema.channelAccounts.tenantId, auth.tenantId), eq(schema.channelAccounts.id, id))));
    return { id, channelKey: 'whatsapp', channelName: 'WhatsApp Business', externalId: found.account.externalId, displayName: found.account.displayName, status, connectedAt: found.account.connectedAt?.toISOString() ?? null, lastEventAt: found.account.lastEventAt?.toISOString() ?? null };
  }
}
