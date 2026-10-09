-- The API's database role, grants and Row-Level Security for everything created so far.
-- The other roles (worker_user, auth_user, outbox_publisher, audit_chainer, sys_owner) and the
-- sys functions arrive in M0-9. Real logins are created per environment and granted app_user.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
GRANT EXECUTE ON FUNCTION app_tenant_id(), app_user_id() TO app_user;
-- Tables added by later migrations get the same grants; each one then revokes what it must.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO app_user;

REVOKE INSERT, UPDATE, DELETE ON permissions FROM app_user;   -- global catalog: read-only
REVOKE DELETE ON users FROM app_user;
-- Only seeds and the signup path create workspaces, never a request handler.
REVOKE INSERT, DELETE ON tenants FROM app_user;

-- History is never changed by the app. Partitions are revoked too, because a partition can be
-- queried directly. New partitions must repeat this and call enable_tenant_rls().
REVOKE UPDATE, DELETE ON audit_logs, audit_logs_2026_10, audit_logs_default FROM app_user;

-- auth.* is not granted to app_user at all (auth_user arrives in M0-9).

-- Tenant RLS on every table that has tenant_id, partitions included.
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  LOOP
    PERFORM enable_tenant_rls(t);
  END LOOP;
END $$;

-- tenants: a session sees only its own tenant row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());

-- users has no tenant_id: visible only as yourself or as a member of the current tenant.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT
  USING (id = app_user_id() OR id IN (SELECT user_id FROM memberships));
CREATE POLICY users_create ON users FOR INSERT WITH CHECK (true);
CREATE POLICY users_update_self ON users FOR UPDATE USING (id = app_user_id()) WITH CHECK (id = app_user_id());
