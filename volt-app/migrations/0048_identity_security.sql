-- 0048: identity security for both kinds of user (ACCESS_CONTROL.md section 12).
--
--   * verified email and mobile number, with a verified change-of-email flow
--   * two-step sign-in: authenticator app (TOTP), emailed code, SMS code,
--     one-time backup codes
--   * an account policy that makes two-step sign-in compulsory for admin users
--   * refresh tokens remember how their session was authenticated, so that
--     policy also applies to sessions that were open when it was switched on
--
-- Admin users keep the TOTP columns platform staff already use
-- (users.mfa_secret_ref + users.mfa_enabled), so one authenticator entry covers
-- both the client console and System Admin.

-- ---- admin users ---------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS phone               TEXT,
    ADD COLUMN IF NOT EXISTS phone_verified_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS mfa_email_enabled   BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS mfa_sms_enabled     BOOLEAN NOT NULL DEFAULT false;

-- ---- public users (viewers) --------------------------------------------------------
ALTER TABLE viewers
    ADD COLUMN IF NOT EXISTS phone               TEXT,
    ADD COLUMN IF NOT EXISTS phone_verified_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS mfa_email_enabled   BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS mfa_sms_enabled     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS totp_secret         TEXT,          -- sealed (enc:v1:...), never plain
    ADD COLUMN IF NOT EXISTS totp_enabled        BOOLEAN NOT NULL DEFAULT false;

-- ---- account policy ----------------------------------------------------------------
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS require_admin_mfa   BOOLEAN NOT NULL DEFAULT false;

-- ---- how a session was authenticated (RFC 8176 amr values) ----------------------------
ALTER TABLE refresh_tokens
    ADD COLUMN IF NOT EXISTS amr TEXT[] NOT NULL DEFAULT '{pwd}';
ALTER TABLE viewer_refresh_tokens
    ADD COLUMN IF NOT EXISTS amr TEXT[] NOT NULL DEFAULT '{pwd}';

-- ---- one-time codes (email change, phone verification, sign-in, enrolment) -----------
-- Only a keyed hash of the code is stored. A code is single use, expires in
-- minutes and allows a handful of guesses.
CREATE TABLE IF NOT EXISTS security_codes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_kind  TEXT NOT NULL CHECK (principal_kind IN ('user', 'viewer')),
    principal_id    UUID NOT NULL,
    purpose         TEXT NOT NULL,      -- email_change | email_verify | phone_verify | mfa_login | mfa_enrol_email | mfa_enrol_sms
    channel         TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
    target          TEXT NOT NULL,      -- the address or number the code went to
    code_hash       TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_codes_open
    ON security_codes (principal_kind, principal_id, purpose) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS security_codes_expiry ON security_codes (expires_at);

-- ---- backup codes ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_kind  TEXT NOT NULL CHECK (principal_kind IN ('user', 'viewer')),
    principal_id    UUID NOT NULL,
    code_hash       TEXT NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_backup_codes_principal ON mfa_backup_codes (principal_kind, principal_id) WHERE used_at IS NULL;

-- ---- channel groups: names are unique within an account, so a rename cannot
--      leave two groups an operator cannot tell apart. Existing duplicates are
--      renamed "<name> (2)", "<name> (3)" (oldest keeps its name) first.
WITH d AS (
  SELECT id, name, row_number() OVER (PARTITION BY account_id, lower(name) ORDER BY created_at, id) AS n
    FROM groups
)
UPDATE groups g SET name = d.name || ' (' || d.n || ')' FROM d WHERE d.id = g.id AND d.n > 1;
CREATE UNIQUE INDEX IF NOT EXISTS groups_account_name ON groups (account_id, lower(name));

-- An email change or a 2FA change on a viewer must end their stateless access
-- tokens too: the 0047 trigger fires on password_changed_at, which the API bumps.
