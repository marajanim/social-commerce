import { getAdapter, type SendResult } from '@sc/channels';
import { schema, writeOutbox, type TenantDb, type Tx } from '@sc/db';
import { and, eq, sql } from 'drizzle-orm';
import { evaluateSend, type BlockReason } from './eligibility';
import { previewOf } from './ingest';

export class SendBlockedError extends Error {
  constructor(public readonly reason: BlockReason) {
    super(`send blocked: ${reason}`);
  }
}

export class ConversationNotFoundError extends Error {
  constructor() {
    super('conversation not found');
  }
}

export interface CreatedOutbound {
  messageId: string;
  createdAt: Date;
  seq: bigint;
  conversationId: string;
  /** True when this Idempotency-Key was already used: the original message is returned, nothing new sent. */
  duplicate: boolean;
}

/** Loads the facts the eligibility rules need for one conversation, under the caller's tenant context. */
export async function loadSendFacts(tx: Tx, tenantId: string, conversationId: string) {
  const row = (
    await tx
      .select({
        conversation: schema.conversations,
        accountStatus: schema.channelAccounts.status,
        channelKey: schema.channelAccounts.channelKey,
        standardWindowHours: schema.channels.standardWindowHours,
        humanAgentWindowHours: schema.channels.humanAgentWindowHours,
      })
      .from(schema.conversations)
      .innerJoin(
        schema.channelAccounts,
        and(
          eq(schema.channelAccounts.tenantId, schema.conversations.tenantId),
          eq(schema.channelAccounts.id, schema.conversations.channelAccountId),
        ),
      )
      .innerJoin(schema.channels, eq(schema.channels.key, schema.channelAccounts.channelKey))
      .where(and(eq(schema.conversations.tenantId, tenantId), eq(schema.conversations.id, conversationId)))
  )[0];
  if (!row) throw new ConversationNotFoundError();
  return row;
}

/** Eligibility for the composer ("window closes in ...") and for sending. */
export async function conversationEligibility(tx: Tx, tenantId: string, conversationId: string, now = new Date()) {
  const f = await loadSendFacts(tx, tenantId, conversationId);
  return evaluateSend({
    channelStatus: f.accountStatus as 'connected',
    standardWindowHours: f.standardWindowHours,
    humanAgentWindowHours: f.humanAgentWindowHours,
    lastInboundAt: f.conversation.lastInboundAt,
    now,
    sender: 'user',
  });
}

/**
 * An agent's reply: checks eligibility, stores a `pending` message in the next seq slot and writes
 * the outbox event, all in the caller's transaction. Delivery happens afterwards in the worker;
 * nothing external is called here. Same Idempotency-Key twice returns the first message.
 */
export async function createOutboundMessage(
  tx: Tx,
  input: { tenantId: string; userId: string; conversationId: string; body: string; idempotencyKey: string; now?: Date },
): Promise<CreatedOutbound> {
  const { tenantId, conversationId } = input;
  const now = input.now ?? new Date();

  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${conversationId}:${input.idempotencyKey}`}, 1))`);
  const existing = (
    await tx
      .select()
      .from(schema.messageKeys)
      .where(
        and(
          eq(schema.messageKeys.tenantId, tenantId),
          eq(schema.messageKeys.kind, 'idempotency'),
          eq(schema.messageKeys.scopeId, conversationId),
          eq(schema.messageKeys.key, input.idempotencyKey),
        ),
      )
  )[0];
  if (existing) {
    const msg = (
      await tx
        .select({ seq: schema.messages.seq })
        .from(schema.messages)
        .where(and(eq(schema.messages.tenantId, tenantId), eq(schema.messages.id, existing.messageId)))
    )[0];
    return {
      messageId: existing.messageId,
      createdAt: existing.messageCreatedAt,
      seq: msg?.seq ?? 0n,
      conversationId,
      duplicate: true,
    };
  }

  const facts = await loadSendFacts(tx, tenantId, conversationId);
  const verdict = evaluateSend({
    channelStatus: facts.accountStatus as 'connected',
    standardWindowHours: facts.standardWindowHours,
    humanAgentWindowHours: facts.humanAgentWindowHours,
    lastInboundAt: facts.conversation.lastInboundAt,
    now,
    sender: 'user',
  });
  if (!verdict.allowed) throw new SendBlockedError(verdict.reason);

  const [bumped] = await tx
    .update(schema.conversations)
    .set({
      lastSeq: sql`${schema.conversations.lastSeq} + 1`,
      lastMessageAt: now,
      lastMessagePreview: previewOf(input.body, 'text'),
      firstResponseAt: facts.conversation.firstResponseAt ?? now,
    })
    .where(and(eq(schema.conversations.tenantId, tenantId), eq(schema.conversations.id, conversationId)))
    .returning({ seq: schema.conversations.lastSeq });
  if (!bumped) throw new ConversationNotFoundError();

  const [message] = await tx
    .insert(schema.messages)
    .values({
      tenantId,
      conversationId,
      seq: bumped.seq,
      direction: 'outbound',
      senderType: 'user',
      senderUserId: input.userId,
      contentType: 'text',
      body: input.body,
      messageTag: verdict.messageTag,
      status: 'pending',
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(), // millisecond precision on purpose, see ingest.ts
    })
    .returning({ id: schema.messages.id, createdAt: schema.messages.createdAt });
  if (!message) throw new Error('message insert returned nothing');

  await tx.insert(schema.messageKeys).values({
    tenantId,
    kind: 'idempotency',
    scopeId: conversationId,
    key: input.idempotencyKey,
    messageId: message.id,
    messageCreatedAt: message.createdAt,
  });
  // Marks the reader as caught up with their own reply.
  await tx
    .insert(schema.conversationReads)
    .values({ tenantId, conversationId, userId: input.userId, lastReadSeq: bumped.seq })
    .onConflictDoUpdate({
      target: [schema.conversationReads.tenantId, schema.conversationReads.conversationId, schema.conversationReads.userId],
      set: { lastReadSeq: bumped.seq, updatedAt: now },
    });

  await writeOutbox(tx, {
    tenantId,
    eventType: 'inbox.message.created',
    aggregateType: 'conversation',
    aggregateId: conversationId,
    payload: { conversationId, messageId: message.id, seq: bumped.seq.toString() },
  });
  return { messageId: message.id, createdAt: message.createdAt, seq: bumped.seq, conversationId, duplicate: false };
}

// ---------------------------------------------------------------------------------------------
// Delivery (worker)
// ---------------------------------------------------------------------------------------------

export type DeliveryOutcome = 'sent' | 'failed' | 'skipped' | 'retry';

export interface DeliveryDeps {
  tenantDb: (ctx: { tenantId: string }) => TenantDb;
  /** Decrypts the stored channel token. Held in memory only for the send. */
  decryptToken: (encrypted: Buffer, keyVersion: number) => string;
  send?: (channelKey: string, req: Parameters<NonNullable<ReturnType<typeof getAdapter>>['send']>[0]) => Promise<SendResult>;
  now?: () => Date;
}

/**
 * Sends one pending message through its channel adapter and records the result. Idempotent: a
 * message that is no longer `pending` is skipped. Retryable provider errors return 'retry' (or fail
 * for good on the last attempt); a rejected token marks the channel as needing attention.
 */
export async function deliverOutboundMessage(
  deps: DeliveryDeps,
  job: { tenantId: string; messageId: string; isLastAttempt: boolean },
): Promise<DeliveryOutcome> {
  const { tenantId } = job;
  const now = deps.now ?? (() => new Date());
  const db = deps.tenantDb({ tenantId });

  const prepared = await db.transaction(async (tx) => {
    const msg = (
      await tx
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.tenantId, tenantId), eq(schema.messages.id, job.messageId)))
    )[0];
    if (!msg || msg.status !== 'pending' || msg.direction !== 'outbound') return { skip: true as const };

    const facts = await loadSendFacts(tx, tenantId, msg.conversationId);
    const identity = (
      await tx
        .select({ externalUserId: schema.contactIdentities.externalUserId })
        .from(schema.contactIdentities)
        .where(
          and(
            eq(schema.contactIdentities.tenantId, tenantId),
            eq(schema.contactIdentities.id, facts.conversation.contactIdentityId),
          ),
        )
    )[0];
    const account = (
      await tx
        .select()
        .from(schema.channelAccounts)
        .where(and(eq(schema.channelAccounts.tenantId, tenantId), eq(schema.channelAccounts.id, facts.conversation.channelAccountId)))
    )[0];
    const cred = (
      await tx
        .select()
        .from(schema.channelCredentials)
        .where(and(eq(schema.channelCredentials.tenantId, tenantId), eq(schema.channelCredentials.channelAccountId, facts.conversation.channelAccountId)))
    )[0];

    // Re-check right before sending: the window or the channel may have changed since the reply was queued.
    const verdict = evaluateSend({
      channelStatus: facts.accountStatus as 'connected',
      standardWindowHours: facts.standardWindowHours,
      humanAgentWindowHours: facts.humanAgentWindowHours,
      lastInboundAt: facts.conversation.lastInboundAt,
      now: now(),
      sender: 'user',
    });
    return { skip: false as const, msg, facts, identity, account, cred, verdict };
  });

  if (prepared.skip) return 'skipped';
  const { msg, identity, account, cred, verdict } = prepared;
  if (!identity || !account) {
    await recordFailure(deps, tenantId, msg.id, msg.conversationId, 'missing_recipient', 'Recipient or channel account not found');
    return 'failed';
  }
  if (!verdict.allowed) {
    await recordFailure(deps, tenantId, msg.id, msg.conversationId, verdict.reason, `Not allowed to send: ${verdict.reason}`);
    return 'failed';
  }

  let result: SendResult;
  const needsToken = account.channelKey !== 'webchat';
  if (needsToken && !cred) {
    result = { ok: false, kind: 'auth', code: 'no_token', reason: 'No access token stored for this channel' };
  } else {
    const token = cred ? deps.decryptToken(cred.encryptedToken, cred.keyVersion) : '';
    const request = {
      token,
      externalAccountId: account.externalId,
      recipientId: identity.externalUserId,
      body: msg.body ?? '',
      ...(msg.messageTag === 'HUMAN_AGENT' ? { messageTag: 'HUMAN_AGENT' as const } : {}),
    };
    const adapter = getAdapter(account.channelKey);
    result = deps.send
      ? await deps.send(account.channelKey, request)
      : adapter
        ? await adapter.send(request)
        : { ok: false, kind: 'permanent', code: 'no_adapter', reason: `No adapter for ${account.channelKey}` };
  }

  if (result.ok) {
    await db.transaction(async (tx) => {
      const sentAt = now();
      await tx
        .update(schema.messages)
        .set({ status: 'sent', providerMessageId: result.providerMessageId, sentAt })
        .where(and(eq(schema.messages.tenantId, tenantId), eq(schema.messages.id, msg.id), eq(schema.messages.status, 'pending')));
      await tx
        .insert(schema.messageKeys)
        .values({
          tenantId,
          kind: 'provider',
          scopeId: account.id,
          key: result.providerMessageId,
          messageId: msg.id,
          messageCreatedAt: msg.createdAt,
        })
        .onConflictDoNothing();
      await writeOutbox(tx, {
        tenantId,
        eventType: 'inbox.message.updated',
        aggregateType: 'conversation',
        aggregateId: msg.conversationId,
        payload: { conversationId: msg.conversationId, status: 'sent', messageIds: [msg.id] },
      });
    });
    return 'sent';
  }

  if (result.kind === 'retryable' && !job.isLastAttempt) return 'retry';

  await db.transaction(async (tx) => {
    if (result.kind === 'auth') {
      await tx
        .update(schema.channelAccounts)
        .set({ status: 'needs_attention' })
        .where(and(eq(schema.channelAccounts.tenantId, tenantId), eq(schema.channelAccounts.id, account.id)));
    }
  });
  await recordFailure(deps, tenantId, msg.id, msg.conversationId, result.code, result.reason);
  return 'failed';
}

async function recordFailure(
  deps: DeliveryDeps,
  tenantId: string,
  messageId: string,
  conversationId: string,
  code: string,
  reason: string,
): Promise<void> {
  await deps.tenantDb({ tenantId }).transaction(async (tx) => {
    await tx
      .update(schema.messages)
      .set({ status: 'failed', failureCode: code.slice(0, 60), failureReason: reason.slice(0, 300) })
      .where(and(eq(schema.messages.tenantId, tenantId), eq(schema.messages.id, messageId), eq(schema.messages.status, 'pending')));
    await writeOutbox(tx, {
      tenantId,
      eventType: 'inbox.message.updated',
      aggregateType: 'conversation',
      aggregateId: conversationId,
      payload: { conversationId, status: 'failed', messageIds: [messageId], failureCode: code },
    });
  });
}
