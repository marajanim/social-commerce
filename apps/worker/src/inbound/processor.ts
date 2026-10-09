import { fetchMessengerProfile, normalizeMessengerItem, type MessengerItem } from '@sc/channels';
import { schema, type WorkerDatabase } from '@sc/db';
import { applyStatusEvent, ingestInboundMessage } from '@sc/inbox';
import { decryptSecret, type KeyRing } from '@sc/shared/crypto';
import { and, eq } from 'drizzle-orm';

export interface InboundDeps {
  db: Pick<WorkerDatabase, 'tenantDb' | 'system'>;
  keyRing: KeyRing | null;
  /** Our Meta app id: echoes carrying it are our own sends and are not new messages. */
  ownAppId?: string;
  fetchProfile?: typeof fetchMessengerProfile;
}

export type InboundOutcome = 'processed' | 'ignored' | 'quarantined' | 'skipped';

/**
 * Turns one stored webhook event into inbox rows. The tenant comes from the Page the event
 * belongs to (resolved through sys.resolve_channel_account), never from the payload. An event for
 * an account we do not know is quarantined and never assigned to a tenant. Safe to run twice for
 * the same event: it is claimed first and message IDs are deduplicated.
 */
export async function processWebhookEvent(deps: InboundDeps, webhookEventId: string): Promise<InboundOutcome> {
  const { system } = deps.db;
  const row = await system.claimWebhookEvent(webhookEventId);
  if (!row) return 'skipped';

  try {
    const event = normalizeMessengerItem(row.payload as MessengerItem);
    if (event.kind === 'unsupported') {
      await system.finishWebhookEvent(row.id, { status: 'processed' });
      return 'ignored';
    }

    const resolved = await system.resolveChannelAccount('messenger', event.externalAccountId);
    if (!resolved || resolved.status === 'disconnected') {
      await system.finishWebhookEvent(row.id, { status: 'quarantined', error: 'unknown or disconnected channel account' });
      return 'quarantined';
    }
    const { tenantId, channelAccountId } = resolved;
    const done = { status: 'processed' as const, tenantId, channelAccountId };
    const db = deps.db.tenantDb({ tenantId });

    if (event.kind === 'status') {
      await db.transaction((tx) =>
        applyStatusEvent(tx, {
          tenantId,
          accountId: channelAccountId,
          externalUserId: event.externalUserId,
          status: event.status,
          watermark: event.watermark,
        }),
      );
      await system.finishWebhookEvent(row.id, done);
      return 'processed';
    }

    if (event.isEcho && deps.ownAppId && event.echoAppId === deps.ownAppId) {
      // Our own send coming back: the outbound worker already stored it.
      await system.finishWebhookEvent(row.id, done);
      return 'ignored';
    }

    // Echoes can create a contact before its first inbound message. Retry missing profiles too.
    let profile: { name: string | null; picUrl: string | null } | null = null;
    if (!event.isEcho && deps.keyRing) {
      const hasProfile = await db.transaction(async (tx) => {
        const rows = await tx
          .select({ name: schema.contactIdentities.profileName })
          .from(schema.contactIdentities)
          .where(
            and(
              eq(schema.contactIdentities.tenantId, tenantId),
              eq(schema.contactIdentities.channelAccountId, channelAccountId),
              eq(schema.contactIdentities.externalUserId, event.externalUserId),
            ),
          );
        return Boolean(rows[0]?.name?.trim());
      });
      if (!hasProfile) {
        const cred = await db.transaction(
          async (tx) =>
            (
              await tx
                .select()
                .from(schema.channelCredentials)
                .where(
                  and(
                    eq(schema.channelCredentials.tenantId, tenantId),
                    eq(schema.channelCredentials.channelAccountId, channelAccountId),
                  ),
                )
            )[0],
        );
        if (cred) {
          const token = decryptSecret(cred.encryptedToken, cred.keyVersion, deps.keyRing);
          profile = await (deps.fetchProfile ?? fetchMessengerProfile)(token, event.externalUserId);
        }
      }
    }

    await db.transaction((tx) =>
      ingestInboundMessage(tx, { tenantId, account: { id: channelAccountId, channelKey: 'messenger' }, event, profile }),
    );
    await system.finishWebhookEvent(row.id, done);
    return 'processed';
  } catch (err) {
    await system.finishWebhookEvent(row.id, {
      status: 'failed',
      error: err instanceof Error ? err.message : 'unknown error',
    });
    throw err; // lets the queue retry with backoff
  }
}
