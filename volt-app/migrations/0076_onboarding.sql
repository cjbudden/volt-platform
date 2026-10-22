-- ============================================================================
--  0076 ONBOARDING: admin invitations, password reset links, self-service signup
--  (docs/ONBOARDING.md)
--
--  user_access_links  one row per emailed link. Only a SHA-256 of the token is
--                     kept, so a database read does not hand out working links.
--                     A link is step one of three: open the link, enter the
--                     code emailed when asked, then set a password. The link
--                     alone never sets a password.
--  saas_signups       registrations from the promo site: a waitlist lead, a
--                     trial account (open signup) or a paid one (Stripe Checkout).
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_access_links (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         TEXT NOT NULL CHECK (kind IN ('invite', 'password_reset')),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    verified_at  TIMESTAMPTZ,          -- the emailed code was entered
    consumed_at  TIMESTAMPTZ,          -- the password was set
    revoked_at   TIMESTAMPTZ,          -- replaced by a newer link, or withdrawn by an admin
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_access_links_open
    ON user_access_links (user_id, kind) WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_access_links_expiry ON user_access_links (expires_at);

CREATE TABLE IF NOT EXISTS saas_signups (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                CITEXT NOT NULL,
    name                 TEXT,
    company              TEXT,
    plan_key             TEXT,
    mode                 TEXT NOT NULL CHECK (mode IN ('waitlist', 'open', 'paid')),
    -- lead: on the waitlist | invited: account made, welcome email sent
    -- checkout: waiting for payment | active: paid and invited | cancelled
    status               TEXT NOT NULL DEFAULT 'lead' CHECK (status IN ('lead', 'invited', 'checkout', 'active', 'cancelled')),
    account_id           UUID REFERENCES accounts(id) ON DELETE SET NULL,
    user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
    checkout_session_id  TEXT,
    stripe_customer_id   TEXT,
    stripe_subscription_id TEXT,
    source               JSONB NOT NULL DEFAULT '{}'::jsonb,   -- utm_*, referrer
    ip                   TEXT,
    user_agent           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS saas_signups_email ON saas_signups (email);
CREATE INDEX IF NOT EXISTS saas_signups_status ON saas_signups (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS saas_signups_checkout ON saas_signups (checkout_session_id) WHERE checkout_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS saas_signups_subscription ON saas_signups (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
