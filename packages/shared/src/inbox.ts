import { z } from 'zod';

// Shapes exchanged between the inbox API and the web app.

export const CHANNEL_KEYS = ['messenger', 'instagram', 'whatsapp', 'webchat'] as const;
export type ChannelKeyName = (typeof CHANNEL_KEYS)[number];

export interface ChannelAccountDto {
  id: string;
  channelKey: ChannelKeyName;
  channelName: string;
  externalId: string;
  displayName: string;
  status: 'connecting' | 'connected' | 'needs_attention' | 'disconnected';
  connectedAt: string | null;
  lastEventAt: string | null;
}

export interface ConversationSummary {
  id: string;
  status: 'open' | 'pending' | 'snoozed' | 'resolved';
  contact: { id: string; name: string; avatarUrl: string | null };
  channel: { accountId: string; key: ChannelKeyName; accountName: string };
  lastMessageAt: string | null;
  preview: string | null;
  unreadCount: number;
  lastSeq: string;
  windowExpiresAt: string | null;
}

export interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  seq: string;
  direction: 'inbound' | 'outbound';
  senderType: 'customer' | 'user' | 'ai' | 'bot' | 'system';
  senderUserId: string | null;
  contentType: string;
  body: string | null;
  attachments: { type: string; url?: string }[];
  status: 'received' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';
  failureCode: string | null;
  failureReason: string | null;
  messageTag: string | null;
  /** True when a human replied from outside this app (Business Suite, another tool). */
  fromExternalApp: boolean;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface MessagePage {
  items: MessageDto[];
  /** seq to pass as `beforeSeq` for older messages, or null when this is the start of the thread. */
  olderCursor: string | null;
}

export interface SendEligibilityDto {
  allowed: boolean;
  reason: 'channel_unavailable' | 'no_inbound' | 'window_closed' | 'ai_outside_window' | null;
  messageTag: 'HUMAN_AGENT' | null;
  windowExpiresAt: string | null;
}

export interface ChannelSetupDto {
  webhookUrl: string | null;
  verifyToken: string | null;
  simulatorEnabled: boolean;
  encryptionConfigured: boolean;
  /** "Continue with Facebook" is available (META_APP_ID and META_APP_SECRET are set). */
  oauthConfigured: boolean;
  /** The address to add under Valid OAuth Redirect URIs in the Meta app. */
  oauthRedirectUri: string;
}

/** Pages the signed-in Facebook user may connect. Tokens never leave the server. */
export interface MetaPendingPagesDto {
  id: string;
  pages: { id: string; name: string }[];
}

export const listConversationsQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  channelAccountId: z.string().uuid().optional(),
  unread: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(100).optional(),
});

export const listMessagesQuery = z.object({
  beforeSeq: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const sendMessageBody = z.object({ body: z.string().trim().min(1).max(2000) });

export const connectMessengerBody = z.object({
  pageId: z.string().trim().regex(/^\d{5,25}$/, 'Page ID is a number'),
  displayName: z.string().trim().min(1).max(120).optional(),
  accessToken: z.string().trim().min(20).max(1000),
});

export const simulateMessageBody = z.object({
  channelAccountId: z.string().uuid(),
  customerName: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(2000),
});

export const connectPendingPageBody = z.object({ pageId: z.string().trim().regex(/^\d{5,25}$/) });
