-- ===========================================================================
--  ACCESS RULES, VIEWERS, PRODUCTS, PURCHASES, ENTITLEMENTS.
--
--  Christian, 5 Sep: the rules engine he built before (FOR content / IF the
--  viewer is located in / THEN access is free, members only, or premium for
--  a user group under TERMS of length + price + currency + tax) is the most
--  flexible standard model for controlling access, and it stays. Payments are
--  taken by App Store, Google Play, Stripe and the like; the SYSTEM controls
--  the price, the method of access and the period through the availability
--  rules; once a purchase is verified we store which content the viewer may
--  reach, based on the rule and the package bought.
--
--  The rules themselves live in publishing_rules.settings.accessRules (and an
--  asset's availability_override), because they ride the same ladder as every
--  other availability field. What needs tables is the audience and the money:
--
--    viewers        the client's audience identities, as its apps know them
--    payment_providers  which providers the client has connected
--    products       a purchasable TERM (one month for 9.99 AUD) and what it grants
--    purchases      one verified payment from a provider
--    entitlements   what a viewer may reach, and until when
-- ===========================================================================
CREATE TABLE IF NOT EXISTS viewers (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    external_id  TEXT NOT NULL,                 -- the client app's user id
    email        TEXT,
    groups       TEXT[] NOT NULL DEFAULT '{}',  -- 'site-users', 'members', client-defined
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ,
    UNIQUE (account_id, external_id)
);

CREATE TABLE IF NOT EXISTS payment_providers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL CHECK (provider IN ('stripe', 'appstore', 'googleplay', 'manual')),
    -- PUBLIC configuration only (publishable key, bundle id, package name,
    -- webhook path). Secrets go to the secrets store; this holds a reference.
    config      JSONB NOT NULL DEFAULT '{}'::jsonb,
    secret_ref  TEXT,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, provider)
);

CREATE TABLE IF NOT EXISTS products (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    key          TEXT NOT NULL,                  -- stable, from the rule's term
    name         TEXT NOT NULL,
    -- {kind:'period', count, unit:'day'|'week'|'month'|'year', priceCents, currency, taxPct}
    -- {kind:'published_dates', priceCents, currency, taxPct}   (the item's own window)
    term         JSONB NOT NULL,
    -- what a purchase grants: the FOR of the rule it came from
    -- {scopes:['this'|'live'|'ondemand'], ownerIds:[], schemaIds:[], assetIds:[]}
    grants       JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- the same product at each provider: {stripe:'price_..', appstore:'com.x.y', googleplay:'sku'}
    provider_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_rule  TEXT,                           -- publishing_rules.id or vod asset id the term lives on
    enabled      BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, key)
);

CREATE TABLE IF NOT EXISTS purchases (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    viewer_id        UUID NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
    product_id       UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    provider         TEXT NOT NULL,
    provider_txn_id  TEXT NOT NULL,              -- idempotency: one row per provider transaction
    status           TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'refunded', 'expired', 'cancelled')),
    amount_cents     INT,
    currency         TEXT,
    purchased_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    period_start     TIMESTAMPTZ,
    period_end       TIMESTAMPTZ,
    raw              JSONB,                      -- the provider's event, for audit
    UNIQUE (account_id, provider, provider_txn_id)
);

CREATE TABLE IF NOT EXISTS entitlements (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    viewer_id    UUID NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
    purchase_id  UUID REFERENCES purchases(id) ON DELETE SET NULL,
    product_id   UUID REFERENCES products(id) ON DELETE SET NULL,
    grants       JSONB NOT NULL,                 -- copied from the product at purchase time
    valid_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until  TIMESTAMPTZ,                    -- NULL = until revoked
    revoked_at   TIMESTAMPTZ,
    note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_entitlements_viewer ON entitlements (viewer_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_purchases_viewer ON purchases (viewer_id, purchased_at DESC);
