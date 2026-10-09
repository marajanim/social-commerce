import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, writeOutbox, type Database } from '@sc/db';
import {
  ConversationNotFoundError,
  SendBlockedError,
  conversationEligibility,
  createOutboundMessage,
} from '@sc/inbox';
import type {
  ChannelKeyName,
  ConversationPage,
  ConversationSummary,
  MessageDto,
  MessagePage,
  SendEligibilityDto,
} from '@sc/shared';
import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../../common/decorators';
import { DATABASE } from '../../db/db.module';
import { OUTBOUND_QUEUE, type OutboundQueue } from '../../queues/inbox-queues';

type ListRow = {
  id: string;
  status: ConversationSummary['status'];
  // Raw SQL results: drizzle returns timestamps as strings here.
  last_message_at: string | null;
  last_message_preview: string | null;
  last_seq: string;
  window_expires_at: string | null;
  contact_id: string;
  contact_name: string;
  avatar_url: string | null;
  account_id: string;
  channel_key: ChannelKeyName;
  account_name: string;
  unread: number;
};

const iso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);

const toSummary = (r: ListRow): ConversationSummary => ({
  id: r.id,
  status: r.status,
  contact: { id: r.contact_id, name: r.contact_name, avatarUrl: r.avatar_url },
  channel: { accountId: r.account_id, key: r.channel_key, accountName: r.account_name },
  lastMessageAt: iso(r.last_message_at),
  preview: r.last_message_preview,
  unreadCount: r.unread,
  lastSeq: r.last_seq,
  windowExpiresAt: iso(r.window_expires_at),
});

const encodeCursor = (at: string | null, id: string) =>
  Buffer.from(JSON.stringify({ t: iso(at), id })).toString('base64url');

function decodeCursor(cursor: string): { t: string | null; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t: string | null; id: string };
    if (typeof v.id !== 'string' || (v.t !== null && Number.isNaN(Date.parse(v.t)))) throw new Error('bad');
    return v;
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

export function toMessageDto(m: typeof schema.messages.$inferSelect): MessageDto {
  const payload = (m.payload ?? {}) as { attachments?: { type: string; url?: string }[]; source?: string };
  return {
    id: m.id,
    conversationId: m.conversationId,
    seq: m.seq.toString(),
    direction: m.direction as MessageDto['direction'],
    senderType: m.senderType as MessageDto['senderType'],
    senderUserId: m.senderUserId,
    contentType: m.contentType,
    body: m.body,
    attachments: payload.attachments ?? [],
    status: m.status as MessageDto['status'],
    failureCode: m.failureCode,
    failureReason: m.failureReason,
    messageTag: m.messageTag,
    fromExternalApp: payload.source === 'external_app',
    createdAt: m.createdAt.toISOString(),
    sentAt: m.sentAt?.toISOString() ?? null,
    deliveredAt: m.deliveredAt?.toISOString() ?? null,
    readAt: m.readAt?.toISOString() ?? null,
  };
}

@Injectable()
export class InboxService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOUND_QUEUE) private readonly outbound: OutboundQueue,
  ) {}

  private ctx(auth: AuthContext) {
    return this.db.tenantDb({ tenantId: auth.tenantId, userId: auth.userId });
  }

  /** The inbox list query. `where` is applied to the joined rows; unread is computed per viewer. */
  private async query(auth: AuthContext, where: SQL[], opts: { unreadOnly?: boolean; limit: number; after?: { t: string | null; id: string } }) {
    const conds = [sql`c.tenant_id = ${auth.tenantId}`, ...where];
    if (opts.after) {
      const t = opts.after.t;
      conds.push(
        t === null
          ? sql`(c.last_message_at IS NULL AND c.id < ${opts.after.id}::uuid)`
          : sql`(c.last_message_at < ${t}::timestamptz OR c.last_message_at IS NULL OR (c.last_message_at = ${t}::timestamptz AND c.id < ${opts.after.id}::uuid))`,
      );
    }
    return this.ctx(auth).transaction(async (tx) => {
      const res = await tx.execute<ListRow>(sql`
        SELECT * FROM (
          SELECT c.id::text AS id, c.status, c.last_message_at, c.last_message_preview, c.last_seq::text AS last_seq,
                 c.window_expires_at, ct.id::text AS contact_id,
                 coalesce(ct.display_name, ci.profile_name, 'Unknown customer') AS contact_name, ct.avatar_url,
                 ca.id::text AS account_id, ca.channel_key, ca.display_name AS account_name,
                 (SELECT count(*)::int FROM messages m
                   WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND m.direction = 'inbound'
                     AND m.seq > coalesce(r.last_read_seq, 0)) AS unread
          FROM conversations c
          JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
          JOIN contact_identities ci ON ci.tenant_id = c.tenant_id AND ci.id = c.contact_identity_id
          JOIN channel_accounts ca ON ca.tenant_id = c.tenant_id AND ca.id = c.channel_account_id
          LEFT JOIN conversation_reads r
            ON r.tenant_id = c.tenant_id AND r.conversation_id = c.id AND r.user_id = ${auth.userId}::uuid
          WHERE ${sql.join(conds, sql` AND `)}
        ) t
        ${opts.unreadOnly ? sql`WHERE t.unread > 0` : sql``}
        ORDER BY t.last_message_at DESC NULLS LAST, t.id DESC
        LIMIT ${opts.limit}`);
      return res.rows;
    });
  }

  async list(
    auth: AuthContext,
    q: { cursor?: string; limit: number; status: 'open' | 'resolved' | 'all'; channelAccountId?: string; unread?: 'true' | 'false'; q?: string },
  ): Promise<ConversationPage> {
    const where: SQL[] = [];
    if (q.status === 'open') where.push(sql`c.status <> 'resolved'`);
    if (q.status === 'resolved') where.push(sql`c.status = 'resolved'`);
    if (q.channelAccountId) where.push(sql`c.channel_account_id = ${q.channelAccountId}::uuid`);
    if (q.q) where.push(sql`coalesce(ct.display_name, ci.profile_name, '') ILIKE ${`%${q.q.replace(/[\\%_]/g, '\\$&')}%`}`);
    const rows = await this.query(auth, where, {
      unreadOnly: q.unread === 'true',
      limit: q.limit + 1,
      after: q.cursor ? decodeCursor(q.cursor) : undefined,
    });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toSummary),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.last_message_at, last.id) : null,
    };
  }

  async get(auth: AuthContext, id: string): Promise<ConversationSummary> {
    const rows = await this.query(auth, [sql`c.id = ${id}::uuid`], { limit: 1 });
    const row = rows[0];
    if (!row) throw new NotFoundException('Conversation not found');
    return toSummary(row);
  }

  async messages(auth: AuthContext, id: string, q: { beforeSeq?: string; limit: number }): Promise<MessagePage> {
    await this.get(auth, id);
    const rows = await this.ctx(auth).transaction((tx) =>
      tx
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.tenantId, auth.tenantId),
            eq(schema.messages.conversationId, id),
            q.beforeSeq ? lt(schema.messages.seq, BigInt(q.beforeSeq)) : undefined,
          ),
        )
        .orderBy(desc(schema.messages.seq))
        .limit(q.limit + 1),
    );
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit).reverse();
    return { items: page.map(toMessageDto), olderCursor: hasMore && page[0] ? page[0].seq.toString() : null };
  }

  async eligibility(auth: AuthContext, id: string): Promise<SendEligibilityDto> {
    try {
      const v = await this.ctx(auth).transaction((tx) => conversationEligibility(tx, auth.tenantId, id));
      return {
        allowed: v.allowed,
        reason: v.allowed ? null : v.reason,
        messageTag: v.allowed ? v.messageTag : null,
        windowExpiresAt: v.windowExpiresAt?.toISOString() ?? null,
      };
    } catch (err) {
      if (err instanceof ConversationNotFoundError) throw new NotFoundException('Conversation not found');
      throw err;
    }
  }

  async send(auth: AuthContext, id: string, body: string, idempotencyKey: string): Promise<MessageDto> {
    let created;
    try {
      created = await this.ctx(auth).transaction((tx) =>
        createOutboundMessage(tx, {
          tenantId: auth.tenantId,
          userId: auth.userId,
          conversationId: id,
          body,
          idempotencyKey,
        }),
      );
    } catch (err) {
      if (err instanceof ConversationNotFoundError) throw new NotFoundException('Conversation not found');
      if (err instanceof SendBlockedError) {
        throw new ConflictException({ message: 'This conversation cannot be replied to right now', code: err.reason });
      }
      throw err;
    }
    // After commit: a crash here leaves a pending row, which the worker's sweeper picks up.
    if (!created.duplicate) {
      await this.outbound.enqueue({ tenantId: auth.tenantId, messageId: created.messageId }).catch(() => undefined);
    }
    const row = await this.ctx(auth).transaction((tx) =>
      tx.select().from(schema.messages).where(and(eq(schema.messages.tenantId, auth.tenantId), eq(schema.messages.id, created.messageId))),
    );
    const message = row[0];
    if (!message) throw new NotFoundException('Message not found');
    return toMessageDto(message);
  }

  async markRead(auth: AuthContext, id: string): Promise<{ lastReadSeq: string }> {
    return this.ctx(auth).transaction(async (tx) => {
      const conv = (
        await tx
          .select({ lastSeq: schema.conversations.lastSeq })
          .from(schema.conversations)
          .where(and(eq(schema.conversations.tenantId, auth.tenantId), eq(schema.conversations.id, id)))
      )[0];
      if (!conv) throw new NotFoundException('Conversation not found');
      await tx
        .insert(schema.conversationReads)
        .values({ tenantId: auth.tenantId, conversationId: id, userId: auth.userId, lastReadSeq: conv.lastSeq })
        .onConflictDoUpdate({
          target: [schema.conversationReads.tenantId, schema.conversationReads.conversationId, schema.conversationReads.userId],
          set: { lastReadSeq: conv.lastSeq, updatedAt: new Date() },
        });
      await writeOutbox(tx, {
        tenantId: auth.tenantId,
        eventType: 'inbox.conversation.read',
        aggregateType: 'conversation',
        aggregateId: id,
        payload: { conversationId: id, userId: auth.userId },
      });
      return { lastReadSeq: conv.lastSeq.toString() };
    });
  }
}
