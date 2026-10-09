-- Extensions and shared helpers (docs/specs/schema.md, Conventions).
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email, tag names
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy search for Bangla / Banglish
CREATE EXTENSION IF NOT EXISTS btree_gin;  -- tenant-leading GIN indexes for search

-- Current tenant / user come from transaction-local settings written by tenantDb().
-- NULL when unset, so RLS policies match no rows instead of erroring.
CREATE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Every tenant-owned table calls this right after CREATE TABLE (also for new partitions):
-- forced RLS plus the standard tenant_isolation policy.
CREATE FUNCTION enable_tenant_rls(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
    p_table);
END $$;

-- Tables get an updated_at trigger through this helper.
CREATE FUNCTION add_updated_at_trigger(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
    replace(p_table::text, '.', '_') || '_updated_at', p_table);
END $$;
