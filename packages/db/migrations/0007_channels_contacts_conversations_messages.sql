-- Omnichannel inbox core (docs/specs/schema.md: Channels, Contacts, Conversations and messages).
-- Reduced to what the unified inbox needs now; tags, templates, assignments history, notes and
-- attachments tables arrive with the tasks that use them.

-- ===== Channels =====
-- Global catalog: adding a channel = one row + one adapter, no schema change.
CREATE TABLE channels (
  key                       text PRIMARY KEY,
  name                      text NOT NULL,
  standard_window_hours     int,
  human_agent_window_hours  int,
  supports_templates        boolean NOT NULL DEFAULT false,
  supports_read_receipts    boolean NOT NULL DEFAULT true,
  active                    boolean NOT NULL DEFAULT true
);
INSERT INTO channels (key, name, standard_window_hours, human_agent_window_hours, supports_templates, supports_read_receipts) VALUES
  ('messenger', 'Facebook Messenger', 24, 168, false, true),
  ('instagram', 'Instagram', 24, 168, false, true),
  ('whatsapp',  'WhatsApp', 24, NULL, true, true),
  ('webchat',   'Website chat', NULL, NULL, false, false);
REVOKE INSERT, UPDATE, DELETE ON channels FROM app_user;   -- read-only for the app

CREATE TABLE channel_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_key       text NOT NULL REFERENCES channels(key),
  external_id       text NOT NULL,
  display_name      text NOT NULL,
  status            text NOT NULL DEFAULT 'connected'
                    CHECK (status IN ('connecting','connected','needs_attention','disconnected')),
  scopes            text[] NOT NULL DEFAULT '{}',
  settings          jsonb NOT NULL DEFAULT '{}',
  connected_by      uuid REFERENCES users(id),
  connected_at      timestamptz,
  last_event_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_key, external_id),     -- one Page / number belongs to one workspace, globally
  UNIQUE (tenant_id, id)
);
CREATE INDEX channel_accounts_tenant_idx ON channel_accounts (tenant_id, channel_key);

CREATE TABLE channel_credentials (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  encrypted_token    bytea NOT NULL,       -- AES-256-GCM; the key lives outside the database
  key_version        int   NOT NULL,
  token_type         text  NOT NULL,
  expires_at         timestamptz,
  rotated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts (tenant_id, id) ON DELETE CASCADE
);

-- Raw inbound events, stored before processing. The tenant is unknown until resolved, so this
-- table is outside tenant RLS and only the webhook/worker role can touch it (see 0008).
CREATE TABLE webhook_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL,
  event_key           text NOT NULL UNIQUE,
  tenant_id           uuid REFERENCES tenants(id),
  channel_account_id  uuid REFERENCES channel_accounts(id),
  payload             jsonb NOT NULL,
  signature_valid     boolean NOT NULL,
  status              text NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received','processing','processed','failed','quarantined')),
  attempts            int NOT NULL DEFAULT 0,
  error               text,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz
);
CREATE INDEX webhook_events_pending_idx ON webhook_events (received_at) WHERE status IN ('received','failed');

-- ===== Contacts =====
CREATE TABLE contacts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name          text,
  avatar_url            text,
  language              text,
  attributes            jsonb NOT NULL DEFAULT '{}',
  lifetime_orders       int    NOT NULL DEFAULT 0,
  lifetime_value_minor  bigint NOT NULL DEFAULT 0,
  delivered_count       int    NOT NULL DEFAULT 0,
  returned_count        int    NOT NULL DEFAULT 0,
  risk_flag             boolean NOT NULL DEFAULT false,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  merged_into_id        uuid,
  merged_at             timestamptz,
  anonymized_at         timestamptz,
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, merged_into_id) REFERENCES contacts (tenant_id, id),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);
CREATE INDEX contacts_active_recent_idx ON contacts (tenant_id, last_seen_at DESC)
  WHERE merged_into_id IS NULL AND deleted_at IS NULL;
CREATE INDEX contacts_name_trgm_idx ON contacts USING gin (display_name gin_trgm_ops);

-- One channel account of a person: PSID, IGSID, wa_id or widget visitor ID.
CREATE TABLE contact_identities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  contact_id          uuid NOT NULL,
  channel_account_id  uuid NOT NULL,
  external_user_id    text NOT NULL,
  profile_name        text,
  profile_pic_url     text,
  last_inbound_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel_account_id, external_user_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts (tenant_id, id)
);
CREATE INDEX contact_identities_contact_idx ON contact_identities (tenant_id, contact_id);

-- ===== Conversations =====
CREATE TABLE conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  contact_id           uuid NOT NULL,
  contact_identity_id  uuid NOT NULL,
  channel_account_id   uuid NOT NULL,
  source               text NOT NULL DEFAULT 'dm'
                       CHECK (source IN ('dm','comment','widget','broadcast_reply','ad')),
  status               text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','pending','snoozed','resolved')),
  owner_type           text NOT NULL DEFAULT 'none' CHECK (owner_type IN ('none','ai','user')),
  owner_user_id        uuid,
  team_id              uuid,
  priority             smallint NOT NULL DEFAULT 0,
  last_seq             bigint NOT NULL DEFAULT 0,
  last_message_at      timestamptz,
  last_message_preview text,
  last_inbound_at      timestamptz,
  window_expires_at    timestamptz,
  snoozed_until        timestamptz,
  first_response_at    timestamptz,
  sla_due_at           timestamptz,
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)          REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_identity_id) REFERENCES contact_identities (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_account_id)  REFERENCES channel_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id)       REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, team_id)             REFERENCES teams (tenant_id, id),
  CHECK ((owner_type = 'user') = (owner_user_id IS NOT NULL)),
  CHECK (status <> 'snoozed' OR snoozed_until IS NOT NULL)
);
CREATE UNIQUE INDEX conversations_one_open_per_identity
  ON conversations (tenant_id, contact_identity_id) WHERE status <> 'resolved';
CREATE INDEX conversations_inbox_idx   ON conversations (tenant_id, status, last_message_at DESC);
CREATE INDEX conversations_recent_idx  ON conversations (tenant_id, last_message_at DESC, id DESC);
CREATE INDEX conversations_mine_idx    ON conversations (tenant_id, owner_user_id, status, last_message_at DESC)
  WHERE owner_type = 'user';
CREATE INDEX conversations_contact_idx ON conversations (tenant_id, contact_id, created_at DESC);

-- Per-user read position: unread = last_seq > last_read_seq.
CREATE TABLE conversation_reads (
  tenant_id        uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  user_id          uuid NOT NULL,
  last_read_seq    bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id, user_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);

-- ===== Messages (partitioned by month) =====
CREATE TABLE messages (
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  conversation_id       uuid NOT NULL,
  seq                   bigint NOT NULL,
  direction             text NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_type           text NOT NULL CHECK (sender_type IN ('customer','user','ai','bot','system')),
  sender_user_id        uuid,
  content_type          text NOT NULL CHECK (content_type IN
                        ('text','image','video','audio','file','template','product_card',
                         'order_preview','location','sticker','reaction','unsupported')),
  body                  text,
  payload               jsonb NOT NULL DEFAULT '{}',
  message_tag           text,
  status                text NOT NULL CHECK (status IN
                        ('received','pending','sent','delivered','read','failed','deleted')),
  failure_code          text,
  failure_reason        text,
  provider_message_id   text,
  idempotency_key       text,
  provider_timestamp    timestamptz,
  sent_at               timestamptz,
  delivered_at          timestamptz,
  read_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id),
  UNIQUE (tenant_id, created_at, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  CHECK ((sender_type = 'user') = (sender_user_id IS NOT NULL) OR sender_type = 'system'),
  CHECK (message_tag IS NULL OR sender_type = 'user')
) PARTITION BY RANGE (created_at);
CREATE INDEX messages_thread_idx ON messages (tenant_id, conversation_id, seq DESC);
CREATE INDEX messages_body_search_idx ON messages USING gin (tenant_id, body gin_trgm_ops);
CREATE INDEX messages_pending_idx ON messages (tenant_id, status) WHERE status IN ('pending','failed');

CREATE TABLE messages_2026_10 PARTITION OF messages FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE messages_2026_11 PARTITION OF messages FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE messages_2026_12 PARTITION OF messages FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE messages_default PARTITION OF messages DEFAULT;

-- Dedupe inbound by provider ID, outbound by idempotency key, and find a message's partition.
CREATE TABLE message_keys (
  tenant_id           uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('provider','idempotency')),
  scope_id            uuid NOT NULL,
  key                 text NOT NULL,
  message_id          uuid NOT NULL,
  message_created_at  timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, scope_id, key),
  FOREIGN KEY (tenant_id, message_created_at, message_id)
    REFERENCES messages (tenant_id, created_at, id) ON DELETE CASCADE
);

-- ===== updated_at triggers, tenant RLS =====
SELECT add_updated_at_trigger('channel_accounts');
SELECT add_updated_at_trigger('contacts');
SELECT add_updated_at_trigger('conversations');

SELECT enable_tenant_rls('channel_accounts');
SELECT enable_tenant_rls('channel_credentials');
SELECT enable_tenant_rls('contacts');
SELECT enable_tenant_rls('contact_identities');
SELECT enable_tenant_rls('conversations');
SELECT enable_tenant_rls('conversation_reads');
SELECT enable_tenant_rls('messages');
SELECT enable_tenant_rls('messages_2026_10');
SELECT enable_tenant_rls('messages_2026_11');
SELECT enable_tenant_rls('messages_2026_12');
SELECT enable_tenant_rls('messages_default');
SELECT enable_tenant_rls('message_keys');
-- webhook_events has no policy on purpose (tenant unknown on arrival): access is by grants only.
