-- Auth module access (the slice of M0-9 that login needs; the remaining roles follow in M0-9).
--   auth_user  : the only role that reads password hashes, sessions and one-time tokens
--   sys_owner  : owns SECURITY DEFINER functions, reachable only through them
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_user') THEN
    CREATE ROLE auth_user NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sys_owner') THEN
    CREATE ROLE sys_owner NOLOGIN BYPASSRLS;
  END IF;
END $$;

-- Server-side sessions. The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE auth.sessions (
  id            bytea PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tenant_id     uuid REFERENCES public.tenants(id) ON DELETE CASCADE,   -- the active workspace
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON auth.sessions (user_id) WHERE revoked_at IS NULL;

-- One-time tokens for password reset and email verification (only the hash is stored).
CREATE TABLE auth.auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('password_reset','email_verify')),
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth.auth_tokens (user_id, purpose);

GRANT USAGE ON SCHEMA auth TO auth_user;
GRANT SELECT, INSERT, UPDATE ON auth.user_credentials TO auth_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.sessions TO auth_user;
GRANT SELECT, INSERT, UPDATE ON auth.auth_tokens TO auth_user;

-- The auth role finds users by email before any tenant is chosen, and records login and
-- verification. It cannot read any tenant table.
GRANT USAGE ON SCHEMA public TO auth_user;
GRANT SELECT ON users TO auth_user;
GRANT UPDATE (last_login_at, email_verified_at) ON users TO auth_user;
CREATE POLICY users_auth ON users TO auth_user USING (true) WITH CHECK (true);

-- ===== sys: narrow cross-tenant lookups =====
CREATE SCHEMA sys AUTHORIZATION sys_owner;
GRANT USAGE ON SCHEMA sys TO app_user;
GRANT USAGE ON SCHEMA public TO sys_owner;
GRANT SELECT ON tenants, memberships, roles TO sys_owner;
GRANT EXECUTE ON FUNCTION app_user_id() TO sys_owner;

-- Login: the workspaces of the signed-in user (app.user_id), before a tenant is chosen.
CREATE FUNCTION sys.user_workspaces()
RETURNS TABLE (tenant_id uuid, tenant_name text, role_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, r.key
  FROM memberships m
  JOIN tenants t ON t.id = m.tenant_id AND t.deleted_at IS NULL
  JOIN roles r   ON r.tenant_id = m.tenant_id AND r.id = m.role_id
  WHERE m.user_id = app_user_id() AND m.status = 'active'
$$;
ALTER FUNCTION sys.user_workspaces() OWNER TO sys_owner;
REVOKE ALL ON FUNCTION sys.user_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sys.user_workspaces() TO app_user;

