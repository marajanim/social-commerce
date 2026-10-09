import type { InboundMessageEvent } from '@sc/channels';
import { schema, writeOutbox, type Tx } from '@sc/db';
import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';

const REOPEN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AccountRef {
  id: string;
  channelKey: string;
}

export interface IngestResult {
  duplicate: boolean;
  conversationId?: string;
  messageId?: string;
  seq?: bigint;
  newConversation?: boolean;
}

export function previewOf(body: string | null, contentType: string): string {
  if (body && body.trim()) return body.trim().slice(0, 140);
  const labels: Record<string, string> = {
    image: 'Photo',
    video: 'Video',
    audio: 'Voice message',
    file: 'File',
    sticker: 'Sticker',
    location: 'Location',
  };
  return labels[contentType] ?? 'Message';
}

/**
 * Stores one inbound (or echoed) message, inside the caller's tenant transaction, exactly once:
 *   1. skip if this provider message ID was already stored,
 *   2. find or create contact, identity and the open conversation (reopening a recently resolved one),
 *   3. take the next `seq` from the row-locked conversation counter,
 *   4. insert the message and its dedupe key, 5. write the outbox event.
 * Concurrent first messages from one customer are serialised with an advisory lock, so they cannot
 * create two contacts or two open conversations.
 */
export async function ingestInboundMessage(
  tx: Tx,
  input: {
    tenantId: string;
    account: AccountRef;
    event: InboundMessageEvent;
    /** Looked up by the caller (an external call, so never inside this transaction's caller path). */
    profile?: { name: string | null; picUrl: string | null } | null;
  },
): Promise<IngestResult> {
  const { tenantId, account, event } = input;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${account.id}:${event.externalUserId}`}, 0))`,
  );

  const seen = await tx
    .select({ id: schema.messageKeys.messageId })
    .from(schema.messageKeys)
    .where(
      and(
        eq(schema.messageKeys.tenantId, tenantId),
        eq(schema.messageKeys.kind, 'provider'),
        eq(schema.messageKeys.scopeId, account.id),
        eq(schema.messageKeys.key, event.providerMessageId),
      ),
    );
  if (seen.length > 0) return { duplicate: true };

  // Contact + identity
  let identity = (
    await tx
      .select()
      .from(schema.contactIdentities)
      .where(
        and(
          eq(schema.contactIdentities.tenantId, tenantId),
          eq(schema.contactIdentities.channelAccountId, account.id),
          eq(schema.contactIdentities.externalUserId, event.externalUserId),
        ),
      )
  )[0];
  if (!identity) {
    const displayName = input.profile?.name ?? null;
    const [contact] = await tx
      .insert(schema.contacts)
      .values({ tenantId, displayName, avatarUrl: input.profile?.picUrl ?? null })
      .returning({ id: schema.contacts.id });
    if (!contact) throw new Error('contact insert returned nothing');
    [identity] = await tx
      .insert(schema.contactIdentities)
      .values({
        tenantId,
        contactId: contact.id,
        channelAccountId: account.id,
        externalUserId: event.externalUserId,
        profileName: displayName,
        profilePicUrl: input.profile?.picUrl ?? null,
      })
      .returning();
  }
  if (!identity) throw new Error('identity missing');

  // Enrich a contact created by an echo or a failed earlier profile lookup.
  // Preserve any name/photo already entered by a teammate.
  if (input.profile?.name && !identity.profileName?.trim()) {
    await tx.update(schema.contactIdentities)
      .set({ profileName: input.profile.name, profilePicUrl: input.profile.picUrl ?? identity.profilePicUrl })
      .where(and(eq(schema.contactIdentities.tenantId, tenantId), eq(schema.contactIdentities.id, identity.id)));
    await tx.update(schema.contacts)
      .set({
        displayName: sql`COALESCE(NULLIF(BTRIM(${schema.contacts.displayName}), ''), ${input.profile.name})`,
        avatarUrl: sql`COALESCE(${schema.contacts.avatarUrl}, ${input.profile.picUrl})`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.contacts.tenantId, tenantId), eq(schema.contacts.id, identity.contactId)));
  }

  // Conversation: the open one, else reopen a recently resolved one, else start a new one.
  const now = new Date();
  let conversation = (
    await tx
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.tenantId, tenantId),
          eq(schema.conversations.contactIdentityId, identity.id),
          ne(schema.conversations.status, 'resolved'),
        ),
      )
  )[0];
  let newConversation = false;
  if (!conversation) {
    const recent = (
      await tx
        .select()
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.tenantId, tenantId),
            eq(schema.conversations.contactIdentityId, identity.id),
            gt(schema.conversations.resolvedAt, new Date(now.getTime() - REOPEN_WINDOW_MS)),
          ),
        )
        .orderBy(desc(schema.conversations.resolvedAt))
        .limit(1)
    )[0];
    if (recent) {
      [conversation] = await tx
        .update(schema.conversations)
        .set({ status: 'open', resolvedAt: null })
        .where(and(eq(schema.conversations.tenantId, tenantId), eq(schema.conversations.id, recent.id)))
        .returning();
    } else {
      [conversation] = await tx
        .insert(schema.conversations)
        .values({
          tenantId,
          contactId: identity.contactId,
          contactIdentityId: identity.id,
          channelAccountId: account.id,
        })
        .returning();
      newConversation = true;
    }
  }
  if (!conversation) throw new Error('conversation missing');

  const inbound = !event.isEcho;
  const preview = previewOf(event.body, event.contentType);

  // Next seq: this UPDATE row-locks the conversation, so concurrent messages queue up here.
  const [bumped] = await tx
    .update(schema.conversations)
    .set({
      lastSeq: sql`${schema.conversations.lastSeq} + 1`,
      lastMessageAt: event.timestamp,
      lastMessagePreview: preview,
      ...(inbound
        ? { lastInboundAt: event.timestamp, windowExpiresAt: new Date(event.timestamp.getTime() + STANDARD_WINDOW_MS) }
        : { firstResponseAt: conversation.firstResponseAt ?? event.timestamp }),
    })
    .where(and(eq(schema.conversations.tenantId, tenantId), eq(schema.conversations.id, conversation.id)))
    .returning({ seq: schema.conversations.lastSeq });
  if (!bumped) throw new Error('seq bump returned nothing');

  const [message] = await tx
    .insert(schema.messages)
    .values({
      tenantId,
      conversationId: conversation.id,
      seq: bumped.seq,
      direction: inbound ? 'inbound' : 'outbound',
      // A reply typed in Business Suite or another app has no user in our system.
      senderType: inbound ? 'customer' : 'system',
      contentType: event.contentType,
      body: event.body,
      payload: { attachments: event.attachments, ...(event.extra ?? {}), ...(inbound ? {} : { source: 'external_app' }) },
      status: inbound ? 'received' : 'sent',
      // Set explicitly: Postgres keeps microseconds, a JS Date only milliseconds, and message_keys
      // references (created_at, id). A value that came from JS round-trips exactly.
      createdAt: now,
      providerMessageId: event.providerMessageId,
      providerTimestamp: event.timestamp,
      sentAt: inbound ? null : event.timestamp,
    })
    .returning({ id: schema.messages.id, createdAt: schema.messages.createdAt });
  if (!message) throw new Error('message insert returned nothing');

  await tx.insert(schema.messageKeys).values({
    tenantId,
    kind: 'provider',
    scopeId: account.id,
    key: event.providerMessageId,
    messageId: message.id,
    messageCreatedAt: message.createdAt,
  });

  await tx
    .update(schema.contacts)
    .set({ lastSeenAt: now })
    .where(and(eq(schema.contacts.tenantId, tenantId), eq(schema.contacts.id, identity.contactId)));
  if (inbound) {
    await tx
      .update(schema.contactIdentities)
      .set({ lastInboundAt: event.timestamp })
      .where(and(eq(schema.contactIdentities.tenantId, tenantId), eq(schema.contactIdentities.id, identity.id)));
  }
  await tx
    .update(schema.channelAccounts)
    .set({ lastEventAt: now })
    .where(and(eq(schema.channelAccounts.tenantId, tenantId), eq(schema.channelAccounts.id, account.id)));

  await writeOutbox(tx, {
    tenantId,
    eventType: inbound ? 'inbox.message.received' : 'inbox.message.sent',
    aggregateType: 'conversation',
    aggregateId: conversation.id,
    payload: { conversationId: conversation.id, messageId: message.id, seq: bumped.seq.toString(), newConversation },
  });

  return {
    duplicate: false,
    conversationId: conversation.id,
    messageId: message.id,
    seq: bumped.seq,
    newConversation,
  };
}

/**
 * Delivered / read receipts arrive as watermarks: every outbound message of that conversation
 * sent before it is delivered / read. Returns the conversation IDs that changed.
 */
export async function applyStatusEvent(
  tx: Tx,
  input: {
    tenantId: string;
    accountId: string;
    externalUserId: string;
    status: 'delivered' | 'read';
    watermark: Date;
    /** WhatsApp receipts target exact messages; Messenger uses a conversation watermark. */
    providerMessageIds?: string[];
  },
): Promise<string[]> {
  const { tenantId } = input;
  const identity = (
    await tx
      .select({ id: schema.contactIdentities.id })
      .from(schema.contactIdentities)
      .where(
        and(
          eq(schema.contactIdentities.tenantId, tenantId),
          eq(schema.contactIdentities.channelAccountId, input.accountId),
          eq(schema.contactIdentities.externalUserId, input.externalUserId),
        ),
      )
  )[0];
  if (!identity) return [];
  const conv = await tx
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.tenantId, tenantId), eq(schema.conversations.contactIdentityId, identity.id)));
  const changed: string[] = [];
  for (const c of conv) {
    // 'read' implies delivered; never move a status backwards (a late 'delivered' after 'read' is ignored).
    const from = input.status === 'delivered' ? sql`('sent')` : sql`('sent','delivered')`;
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE messages SET status = ${input.status},
        delivered_at = COALESCE(delivered_at, ${input.watermark}),
        read_at = ${input.status === 'read' ? sql`COALESCE(read_at, ${input.watermark})` : sql`read_at`}
      WHERE tenant_id = ${tenantId} AND conversation_id = ${c.id} AND direction = 'outbound'
        AND status IN ${from} AND sent_at IS NOT NULL
        ${input.providerMessageIds ? sql`` : sql`AND sent_at <= ${input.watermark}`}
        ${input.providerMessageIds ? sql`AND ${inArray(schema.messages.providerMessageId, input.providerMessageIds)}` : sql``}
      RETURNING id::text AS id`);
    if (rows.rows.length > 0) {
      changed.push(c.id);
      await writeOutbox(tx, {
        tenantId,
        eventType: 'inbox.message.updated',
        aggregateType: 'conversation',
        aggregateId: c.id,
        payload: { conversationId: c.id, status: input.status, messageIds: rows.rows.map((r) => r.id) },
      });
    }
  }
  return changed;
}
