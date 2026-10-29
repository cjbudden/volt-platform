-- ============================================================================
--  0095: SINGLE SIGN-ON FOR ADMIN USERS, OIDC AND SAML (ACCESS_CONTROL.md section 14).
--
--    sso_connections   an account's identity providers: protocol, the provider's
--                      details, how claims map to Volt users and roles, whether
--                      new users are created on first sign-in, whether SSO is
--                      compulsory for the connection's domains
--    sso_domains       email domains a connection answers for. A domain is
--                      VERIFIED by a DNS TXT record before Volt links or creates
--                      users from it, and one domain belongs to one connection
--    sso_requests      sign-ins in flight (OIDC state, nonce and PKCE verifier;
--                      SAML request IDs), single use, ten minutes
--    sso_handoffs      the one-time code the console exchanges for a session
--                      after the provider sends the person back (never tokens in a URL)
--    user_identities   which provider subject is which Volt user
-- ============================================================================

CREATE TABLE IF NOT EXISTS sso_connections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  protocol            TEXT NOT NULL CHECK (protocol IN ('oidc','saml')),
  name                TEXT NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  -- OIDC
  oidc_issuer         TEXT,
  oidc_client_id      TEXT,
  oidc_client_secret  TEXT,                    -- sealed (enc:v1:...), never plain
  oidc_scopes         TEXT NOT NULL DEFAULT 'openid email profile',
  -- SAML
  saml_idp_entity_id  TEXT,
  saml_idp_sso_url    TEXT,
  saml_idp_certs      TEXT[] NOT NULL DEFAULT '{}',
  saml_metadata_url   TEXT,
  -- users and roles
  claim_email         TEXT,                    -- null = the usual ones (email, mail, upn, NameID)
  claim_name          TEXT,
  claim_groups        TEXT,                    -- null = groups / memberOf / the Entra groups claim
  jit                 BOOLEAN NOT NULL DEFAULT true,
  default_tier        TEXT NOT NULL DEFAULT 'operator' CHECK (default_tier IN ('viewer','operator','admin')),
  default_group_id    UUID REFERENCES user_groups(id) ON DELETE SET NULL,
  group_map           JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ value, groupId }]
  sync_groups         BOOLEAN NOT NULL DEFAULT false,       -- roles follow the provider's groups at every sign-in
  enforce             BOOLEAN NOT NULL DEFAULT false,       -- SSO only for the verified domains (owners keep a password)
  trust_idp_mfa       BOOLEAN NOT NULL DEFAULT true,        -- the provider's two-step sign-in counts as Volt's
  last_used_at        TIMESTAMPTZ,
  last_error          TEXT,
  last_error_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sso_connections_account ON sso_connections (account_id);

CREATE TABLE IF NOT EXISTS sso_domains (
  domain         CITEXT PRIMARY KEY,
  connection_id  UUID NOT NULL REFERENCES sso_connections(id) ON DELETE CASCADE,
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  verify_token   TEXT NOT NULL,
  verified_at    TIMESTAMPTZ,
  checked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sso_domains_connection ON sso_domains (connection_id);

CREATE TABLE IF NOT EXISTS sso_requests (
  state       TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  connection_id UUID REFERENCES sso_connections(id) ON DELETE CASCADE,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sso_requests_expires ON sso_requests (expires_at);

CREATE TABLE IF NOT EXISTS sso_handoffs (
  code_hash   TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES sso_connections(id) ON DELETE SET NULL,
  amr         TEXT[] NOT NULL DEFAULT '{ext}',
  return_to   TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_identities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id  UUID NOT NULL REFERENCES sso_connections(id) ON DELETE CASCADE,
  subject        TEXT NOT NULL,
  email          CITEXT,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, subject)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities (user_id);
