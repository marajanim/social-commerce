-- Audit log and transactional outbox (docs/specs/schema.md, Audit logs, outbox and RLS).

-- Append-only, partitioned by month. Rows are written without a hash; the audit_chainer
-- job (M0-8/M0-9) chains them per tenant in (created_at, id) order.
CREATE TABLE audit_logs (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid,                      -- NULL for platform-level events
  actor_type      text NOT NULL CHECK (actor_type IN ('user','platform_admin','system','ai','api_key')),
  actor_id        uuid,
  action          text NOT NULL,
  target_type     text NOT NULL,
  target_id       uuid,
  before          jsonb,
  after           jsonb,
  ip              inet,
  user_agent      text,
  correlation_id  text,
  prev_hash       bytea,
  hash            bytea,
  chained_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);
CREATE INDEX audit_logs_tenant_idx ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX audit_logs_unchained_idx ON audit_logs (created_at) WHERE chained_at IS NULL;
CREATE INDEX audit_logs_target_idx ON audit_logs (tenant_id, target_type, target_id);
CREATE TABLE audit_logs_2026_10 PARTITION OF audit_logs FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

-- Written in the same transaction as the change, published to Redis by a worker.
CREATE TABLE outbox_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  event_type      text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;
