-- ============================================================================
--  0127: HYBRID SITES 1: sites, hosts and enrolment (build queue H1,
--  HYBRID_SITES.md).
--
--  A SITE is a customer location enrolled with Volt; a HOST is a server or VM
--  there running the site agent. The control plane stays in the cloud and
--  stays the only place that decides; a site only ever calls out over HTTPS.
--
--  LICENSED, OFF BY DEFAULT. accounts.licences holds the add-ons an account is
--  licensed for ('hybrid_sites' here, 'mirror_archive' later). It is set only
--  by the system admin. With 'hybrid_sites' absent nothing below is reachable
--  and every existing behaviour is unchanged.
--
--  SECRETS ARE NEVER STORED. Enrolment tokens and host credentials are kept as
--  SHA-256 hashes; the clear value is shown once, to whoever created it.
--
--  Add only (RELEASING.md "Schema: add only"): one column with a default and
--  four new tables.
-- ============================================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS licences text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN accounts.licences IS
  'Licensed add-ons (hybrid_sites, mirror_archive). Set by the system admin only; empty by default (build queue H1).';

CREATE TABLE IF NOT EXISTS sites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  -- disabled: the site's agents are refused until it is enabled again.
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Bumped on every change an agent should pick up; the agent pulls config
  -- only when the number it holds is behind.
  config_version integer NOT NULL DEFAULT 1,
  version     integer NOT NULL DEFAULT 1,
  created_by  uuid,
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS site_enrolment_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  -- The first characters, so the console can tell tokens apart.
  prefix      text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  used_by_host uuid,
  revoked_at  timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_enrolment_tokens_site ON site_enrolment_tokens (site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS site_hosts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hostname      text NOT NULL,
  -- pending: registered, waiting for approval; takes no work.
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  cpu_cores     integer,
  memory_bytes  bigint,
  -- [{ name, vendor, memoryBytes, encodeSessions }]
  gpus          jsonb NOT NULL DEFAULT '[]',
  disk_free_bytes  bigint,
  disk_total_bytes bigint,
  os            text,
  arch          text,
  agent_version text,
  encoder_version text,
  -- What the agent last reported, as sent, for support.
  facts         jsonb NOT NULL DEFAULT '{}',
  last_heartbeat_at timestamptz,
  last_config_version integer,
  decided_at    timestamptz,
  decided_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_hosts_site ON site_hosts (site_id);

CREATE TABLE IF NOT EXISTS site_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  host_id     uuid NOT NULL REFERENCES site_hosts(id) ON DELETE CASCADE,
  secret_hash text NOT NULL UNIQUE,
  prefix      text NOT NULL,
  -- A rotated credential is handed to the agent on its next heartbeat
  -- (delivered_at) and replaces the old one the first time it is used
  -- (activated_at). Until then the old one keeps working, so a rotation never
  -- strands an agent that missed the answer.
  delivered_at timestamptz,
  activated_at timestamptz,
  revoked_at  timestamptz,
  last_used_at timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_credentials_host ON site_credentials (host_id) WHERE revoked_at IS NULL;
