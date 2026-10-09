-- Pages a person is allowed to connect after "Continue with Facebook", kept for a few minutes while
-- they choose one. Page tokens are stored encrypted (same key ring as channel_credentials) and are
-- deleted as soon as one Page is connected or the session expires.
CREATE TABLE channel_oauth_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  provider    text NOT NULL DEFAULT 'meta',
  pages       jsonb NOT NULL,            -- [{ id, name, token: base64(ciphertext), keyVersion }]
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX channel_oauth_sessions_expiry_idx ON channel_oauth_sessions (expires_at);
SELECT enable_tenant_rls('channel_oauth_sessions');
