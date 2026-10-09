import { createHash } from 'node:crypto';
import type { ContentType, InboundAttachment, NormalizedEvent } from '../types';

// Facebook Messenger webhook payloads (object: "page"). One POST can carry several entries and
// several `messaging` items; each item is one event, so we split before storing.

interface MessagingItem {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    app_id?: number | string;
    attachments?: { type?: string; payload?: { url?: string; coordinates?: unknown } }[];
    quick_reply?: { payload?: string };
    reply_to?: { mid?: string };
    sticker_id?: number;
  };
  delivery?: { mids?: string[]; watermark?: number };
  read?: { watermark?: number };
  postback?: { mid?: string; title?: string; payload?: string };
}

interface PagePayload {
  object?: string;
  entry?: { id?: string; time?: number; messaging?: MessagingItem[] }[];
}

/** One stored unit: a single messaging item with the Page it arrived for. */
export interface MessengerItem {
  pageId: string;
  item: MessagingItem;
}

export function splitMessengerPayload(payload: unknown): MessengerItem[] {
  const p = payload as PagePayload;
  if (p?.object !== 'page' || !Array.isArray(p.entry)) return [];
  const out: MessengerItem[] = [];
  for (const entry of p.entry) {
    for (const item of entry.messaging ?? []) out.push({ pageId: String(entry.id ?? ''), item });
  }
  return out;
}

/** Stable key so a redelivered event is stored once (Meta retries on any non-200). */
export function messengerEventKey({ pageId, item }: MessengerItem): string {
  const id =
    item.message?.mid ??
    item.postback?.mid ??
    (item.delivery ? `delivery:${item.delivery.watermark}:${item.delivery.mids?.join(',') ?? ''}` : undefined) ??
    (item.read ? `read:${item.read.watermark}` : undefined) ??
    createHash('sha256').update(JSON.stringify(item)).digest('hex');
  return `messenger:${pageId}:${item.sender?.id ?? ''}:${id}`;
}

const ATTACHMENT_TYPES: Record<string, InboundAttachment['type']> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'file',
  location: 'location',
};

/** Turns one stored messaging item into a normalized event. Unknown shapes become `unsupported`. */
export function normalizeMessengerItem({ pageId, item }: MessengerItem): NormalizedEvent {
  const senderId = item.sender?.id;
  const recipientId = item.recipient?.id;
  if (!senderId || !recipientId) return { kind: 'unsupported', externalAccountId: pageId || null, reason: 'missing sender or recipient' };
  const timestamp = new Date(item.timestamp ?? Date.now());

  const m = item.message;
  if (m?.mid) {
    const isEcho = m.is_echo === true;
    // For an echo the Page is the sender and the customer is the recipient.
    const externalUserId = isEcho ? recipientId : senderId;
    const attachments: InboundAttachment[] = (m.attachments ?? []).map((a) => ({
      type: ATTACHMENT_TYPES[a.type ?? ''] ?? 'unknown',
      url: a.payload?.url,
    }));
    const stickerLike = m.sticker_id !== undefined;
    let contentType: ContentType = 'text';
    if (stickerLike) contentType = 'sticker';
    else if (attachments.length > 0 && !m.text) {
      const first = attachments[0]?.type;
      contentType = first && first !== 'unknown' ? first : 'unsupported';
    } else if (!m.text) contentType = 'unsupported';
    return {
      kind: 'message',
      externalAccountId: pageId,
      externalUserId,
      providerMessageId: m.mid,
      timestamp,
      contentType,
      body: m.text ?? null,
      attachments,
      isEcho,
      echoAppId: m.app_id !== undefined ? String(m.app_id) : undefined,
      extra: {
        ...(m.quick_reply?.payload ? { quickReply: m.quick_reply.payload } : {}),
        ...(m.reply_to?.mid ? { replyToProviderMessageId: m.reply_to.mid } : {}),
      },
    };
  }

  if (item.postback) {
    return {
      kind: 'message',
      externalAccountId: pageId,
      externalUserId: senderId,
      providerMessageId: item.postback.mid ?? `postback:${senderId}:${item.timestamp ?? ''}`,
      timestamp,
      contentType: 'text',
      body: item.postback.title ?? item.postback.payload ?? null,
      attachments: [],
      isEcho: false,
      extra: { postbackPayload: item.postback.payload },
    };
  }

  if (item.delivery?.watermark) {
    return {
      kind: 'status',
      externalAccountId: pageId,
      externalUserId: senderId,
      status: 'delivered',
      watermark: new Date(item.delivery.watermark),
      providerMessageIds: item.delivery.mids ?? [],
    };
  }
  if (item.read?.watermark) {
    return {
      kind: 'status',
      externalAccountId: pageId,
      externalUserId: senderId,
      status: 'read',
      watermark: new Date(item.read.watermark),
      providerMessageIds: [],
    };
  }
  return { kind: 'unsupported', externalAccountId: pageId, reason: 'unhandled messaging event' };
}
