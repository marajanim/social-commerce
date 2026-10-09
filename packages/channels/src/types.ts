// The contract between a channel and the rest of the system. Adapters translate: they parse,
// normalise, send and classify errors. They never touch the database or apply business rules.

export type ChannelKey = 'messenger' | 'instagram' | 'whatsapp' | 'webchat';

export type ContentType = 'text' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location' | 'unsupported';

export interface InboundAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location' | 'unknown';
  url?: string;
}

/** A customer (or, for echoes, a human on another app) wrote a message. */
export interface InboundMessageEvent {
  kind: 'message';
  /** The Page / account the message belongs to. */
  externalAccountId: string;
  /** The customer on that channel (PSID, IGSID, wa_id, visitor ID). */
  externalUserId: string;
  providerMessageId: string;
  timestamp: Date;
  contentType: ContentType;
  body: string | null;
  attachments: InboundAttachment[];
  /** True when the Page itself sent it (from Business Suite, another app, or our own send). */
  isEcho: boolean;
  /** For echoes: the app that sent it, so our own sends can be told apart from human replies. */
  echoAppId?: string;
  /** Provider-specific extras kept verbatim (postback payload, reply-to, ...). */
  extra?: Record<string, unknown>;
}

/** Delivery or read receipt, as a watermark: everything we sent before this time is delivered / read. */
export interface InboundStatusEvent {
  kind: 'status';
  externalAccountId: string;
  externalUserId: string;
  status: 'delivered' | 'read';
  watermark: Date;
  providerMessageIds: string[];
}

/** Anything we recognise as an event but do not handle yet. Never throws. */
export interface UnsupportedEvent {
  kind: 'unsupported';
  externalAccountId: string | null;
  reason: string;
}

export type NormalizedEvent = InboundMessageEvent | InboundStatusEvent | UnsupportedEvent;

export interface SendRequest {
  /** Decrypted channel token, held only for the duration of the call. */
  token: string;
  externalAccountId: string;
  recipientId: string;
  body: string;
  /** Set only for a human reply outside the 24 h window (Messenger HUMAN_AGENT). */
  messageTag?: 'HUMAN_AGENT';
}

export type SendFailureKind =
  | 'retryable' // timeouts, 5xx, rate limits: try again with backoff
  | 'auth' // token invalid or expired: the channel needs attention
  | 'user_fixable' // outside the window, missing permission
  | 'permanent'; // blocked by the user, invalid recipient

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; kind: SendFailureKind; code: string; reason: string };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ChannelAdapter {
  key: ChannelKey;
  send(request: SendRequest, fetchImpl?: FetchLike): Promise<SendResult>;
}
