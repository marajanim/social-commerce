-- Identity and access (docs/specs/schema.md, Identity and access).
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          citext NOT NULL UNIQUE,
  timezone      text NOT NULL DEFAULT 'Asia/Dhaka',
  currency      char(3) NOT NULL DEFAULT 'BDT',
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','restricted','suspended','deleted')),
  settings      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- Global: one login can belong to many workspaces.
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  name              text NOT NULL,
  phone_e164        text,
  locale            text NOT NULL DEFAULT 'bn',
  email_verified_at timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Secrets live in a separate schema that only the auth module's database role can read (M0-9).
CREATE SCHEMA auth;
CREATE TABLE auth.user_credentials (
  user_id                 uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  password_hash           text,
  totp_secret_encrypted   bytea,
  failed_attempts         int NOT NULL DEFAULT 0,
  locked_until            timestamptz,
  password_changed_at     timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  key          text PRIMARY KEY,
  module       text NOT NULL,
  description  text NOT NULL
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, id)
);

CREATE TABLE role_permissions (
  tenant_id       uuid NOT NULL,
  role_id         uuid NOT NULL,
  permission_key  text NOT NULL REFERENCES permissions(key),
  scope           text NOT NULL DEFAULT 'all' CHECK (scope IN ('own','team','all')),
  PRIMARY KEY (tenant_id, role_id, permission_key),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE memberships (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','deactivated')),
  invited_by  uuid REFERENCES users(id),
  joined_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE teams (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               text NOT NULL,
  routing_method     text NOT NULL DEFAULT 'round_robin'
                     CHECK (routing_method IN ('manual','round_robin','least_busy')),
  default_capacity   int  NOT NULL DEFAULT 15 CHECK (default_capacity > 0),
  queue_sla_seconds  int  NOT NULL DEFAULT 300,
  business_hours     jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE team_members (
  tenant_id          uuid NOT NULL,
  team_id            uuid NOT NULL,
  user_id            uuid NOT NULL,
  capacity_override  int CHECK (capacity_override > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id, user_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX team_members_user_idx ON team_members (tenant_id, user_id);

SELECT add_updated_at_trigger('tenants');
SELECT add_updated_at_trigger('users');
SELECT add_updated_at_trigger('auth.user_credentials');
SELECT add_updated_at_trigger('roles');
SELECT add_updated_at_trigger('memberships');
SELECT add_updated_at_trigger('teams');
