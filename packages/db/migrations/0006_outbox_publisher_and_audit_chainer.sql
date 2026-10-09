-- Narrow cross-tenant roles for the two background jobs of M0-8 (docs/specs/schema.md, Roles and RLS).
--   outbox_publisher : reads unpublished events and marks them published; nothing else
--   audit_chainer    : reads audit rows and fills the hash columns; nothing else
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'outbox_publisher') THEN
    CREATE ROLE outbox_publisher NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_chainer') THEN
    CREATE ROLE audit_chainer NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO outbox_publisher, audit_chainer;

GRANT SELECT, UPDATE (published_at) ON outbox_events TO outbox_publisher;
GRANT SELECT, UPDATE (prev_hash, hash, chained_at) ON audit_logs TO audit_chainer;

-- Policies combine with tenant_isolation using OR: these two roles see all tenants' rows of
-- exactly these tables, and the column grants above limit what they can change.
CREATE POLICY outbox_publish ON outbox_events TO outbox_publisher USING (true) WITH CHECK (true);
CREATE POLICY audit_chain ON audit_logs TO audit_chainer USING (true) WITH CHECK (true);

-- The API only appends events; publishing state belongs to the publisher.
REVOKE UPDATE, DELETE ON outbox_events FROM app_user;
