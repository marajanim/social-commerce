-- worker_user: everything app_user can (under RLS), plus the webhook inbox and the system lookup
-- that resolves a Page to its tenant (the slice of M0-9 the inbox needs; the rest follows there).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'worker_user') THEN
    CREATE ROLE worker_user NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT app_user TO worker_user;

-- Webhook inbox: workers and the webhook receiver only. The app role never sees raw payloads.
REVOKE ALL ON webhook_events FROM app_user;
GRANT SELECT, INSERT, UPDATE ON webhook_events TO worker_user;

GRANT USAGE ON SCHEMA sys TO worker_user;
GRANT SELECT ON channel_accounts TO sys_owner;

-- Webhook worker: which tenant and account does this Page / number belong to?
CREATE FUNCTION sys.resolve_channel_account(p_channel_key text, p_external_id text)
RETURNS TABLE (tenant_id uuid, channel_account_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ca.tenant_id, ca.id, ca.status
  FROM channel_accounts ca
  WHERE ca.channel_key = p_channel_key AND ca.external_id = p_external_id
$$;
ALTER FUNCTION sys.resolve_channel_account(text, text) OWNER TO sys_owner;
REVOKE ALL ON FUNCTION sys.resolve_channel_account(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sys.resolve_channel_account(text, text) TO worker_user;

-- Schedulers: (tenant_id, id) pairs of work that is due. The job then sets tenant context and loads
-- the rows normally under RLS. More kinds are added as the features that need them are built.
GRANT SELECT ON messages TO sys_owner;
CREATE FUNCTION sys.due_work(p_kind text, p_limit int DEFAULT 500)
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 5000 THEN RAISE EXCEPTION 'limit out of range'; END IF;
  CASE p_kind
    -- Replies stored as pending that no worker has delivered (queue was down, worker crashed).
    WHEN 'outbound_pending' THEN RETURN QUERY
      SELECT m.tenant_id, m.id FROM messages m
      WHERE m.status = 'pending' AND m.direction = 'outbound' AND m.created_at < now() - interval '30 seconds'
        AND m.created_at > now() - interval '2 days'
      ORDER BY m.created_at LIMIT p_limit;
    ELSE
      RAISE EXCEPTION 'unknown work kind: %', p_kind;
  END CASE;
END $$;
ALTER FUNCTION sys.due_work(text, int) OWNER TO sys_owner;
REVOKE ALL ON FUNCTION sys.due_work(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sys.due_work(text, int) TO worker_user;
