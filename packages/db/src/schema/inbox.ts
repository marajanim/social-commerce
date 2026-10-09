// Drizzle mirror of migration 0007 (channels, contacts, conversations, messages).
import { bigint, boolean, customType, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const channels = pgTable('channels', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  standardWindowHours: integer('standard_window_hours'),
  humanAgentWindowHours: integer('human_agent_window_hours'),
  supportsTemplates: boolean('supports_templates').notNull().default(false),
  supportsReadReceipts: boolean('supports_read_receipts').notNull().default(true),
  active: boolean('active').notNull().default(true),
});

export const channelAccounts = pgTable('channel_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  channelKey: text('channel_key').notNull(),
  externalId: text('external_id').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull().default('connected'),
  scopes: text('scopes').array().notNull().default([]),
  settings: jsonb('settings').notNull().default({}),
  connectedBy: uuid('connected_by'),
  connectedAt: ts('connected_at'),
  lastEventAt: ts('last_event_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const channelCredentials = pgTable('channel_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  encryptedToken: bytea('encrypted_token').notNull(),
  keyVersion: integer('key_version').notNull(),
  tokenType: text('token_type').notNull(),
  expiresAt: ts('expires_at'),
  rotatedAt: ts('rotated_at').notNull().defaultNow(),
});

export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  eventKey: text('event_key').notNull().unique(),
  tenantId: uuid('tenant_id'),
  channelAccountId: uuid('channel_account_id'),
  payload: jsonb('payload').notNull(),
  signatureValid: boolean('signature_valid').notNull(),
  status: text('status').notNull().default('received'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
});

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  language: text('language'),
  attributes: jsonb('attributes').notNull().default({}),
  lifetimeOrders: integer('lifetime_orders').notNull().default(0),
  lifetimeValueMinor: bigint('lifetime_value_minor', { mode: 'bigint' }).notNull().default(0n),
  deliveredCount: integer('delivered_count').notNull().default(0),
  returnedCount: integer('returned_count').notNull().default(0),
  riskFlag: boolean('risk_flag').notNull().default(false),
  firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  mergedIntoId: uuid('merged_into_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const contactIdentities = pgTable('contact_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  externalUserId: text('external_user_id').notNull(),
  profileName: text('profile_name'),
  profilePicUrl: text('profile_pic_url'),
  lastInboundAt: ts('last_inbound_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  contactIdentityId: uuid('contact_identity_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  source: text('source').notNull().default('dm'),
  status: text('status').notNull().default('open'),
  ownerType: text('owner_type').notNull().default('none'),
  ownerUserId: uuid('owner_user_id'),
  teamId: uuid('team_id'),
  priority: smallint('priority').notNull().default(0),
  lastSeq: bigint('last_seq', { mode: 'bigint' }).notNull().default(0n),
  lastMessageAt: ts('last_message_at'),
  lastMessagePreview: text('last_message_preview'),
  lastInboundAt: ts('last_inbound_at'),
  windowExpiresAt: ts('window_expires_at'),
  snoozedUntil: ts('snoozed_until'),
  firstResponseAt: ts('first_response_at'),
  slaDueAt: ts('sla_due_at'),
  resolvedAt: ts('resolved_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const conversationReads = pgTable(
  'conversation_reads',
  {
    tenantId: uuid('tenant_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    userId: uuid('user_id').notNull(),
    lastReadSeq: bigint('last_read_seq', { mode: 'bigint' }).notNull().default(0n),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.conversationId, t.userId] })],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    direction: text('direction').notNull(),
    senderType: text('sender_type').notNull(),
    senderUserId: uuid('sender_user_id'),
    contentType: text('content_type').notNull(),
    body: text('body'),
    payload: jsonb('payload').notNull().default({}),
    messageTag: text('message_tag'),
    status: text('status').notNull(),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    providerMessageId: text('provider_message_id'),
    idempotencyKey: text('idempotency_key'),
    providerTimestamp: ts('provider_timestamp'),
    sentAt: ts('sent_at'),
    deliveredAt: ts('delivered_at'),
    readAt: ts('read_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.createdAt, t.id] })],
);

export const messageKeys = pgTable(
  'message_keys',
  {
    tenantId: uuid('tenant_id').notNull(),
    kind: text('kind').notNull(),
    scopeId: uuid('scope_id').notNull(),
    key: text('key').notNull(),
    messageId: uuid('message_id').notNull(),
    messageCreatedAt: ts('message_created_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.kind, t.scopeId, t.key] })],
);
